import type { Db } from '../db/client.js';
import type { OutboxHandlers } from '../platform/outbox.js';
import { sha256 } from '../lib/util.js';
import { config } from '../config.js';
import { defaultMailer, type Mailer } from './mail.js';

/** Plain-text send through the configured mail provider (main's Resend/log mailer). */
export async function sendEmail(to: string, subject: string, text: string, _messageId: string, mailer: Mailer = defaultMailer()) {
  await mailer.send({ to, subject, text, html: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))}</pre>` });
}

export function inboxHandlers(db: Db, send = sendEmail): OutboxHandlers {
 return {'inbox.reply': async row => {
  const message=(await db.query<any>(`SELECT m.*,v.subject,v.email_consent,v.status AS conversation_status,p.email FROM conversation_messages m JOIN conversations v ON v.id=m.conversation_id JOIN parties p ON p.id=v.party_id WHERE m.id=$1`,[row.payload.messageId])).rows[0];
  if(!message||message.tenant_id!==row.tenant_id)throw new Error('Reply tenant mismatch');
  if(message.status==='sent')return {externalId:message.external_id};
  if(!['approved','failed'].includes(message.status)||!message.approved_by||!message.approved_recipient||message.approved_recipient!==message.email||!message.email_consent||message.conversation_status!=='open')throw new Error('Reply authorization, recipient or consent changed; delivery stopped');
  const messageId=`<${sha256(row.key)}@${new URL(config.baseUrl).hostname}>`;
  try{await send(message.email,`Re: ${message.subject}`,message.body,messageId);await db.query(`UPDATE conversation_messages SET status='sent',sent_at=now(),external_id=$2 WHERE id=$1`,[message.id,messageId]);return {externalId:messageId};}
  catch{await db.system(async c=>{
    await c.query(`UPDATE conversation_messages SET status='delivery_review' WHERE id=$1`,[message.id]);
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES($1,'staff.review',$2,$3) ON CONFLICT(key) DO NOTHING`,[row.tenant_id,`inbox-review:${message.id}`,JSON.stringify({messageId:message.id,reason:'Mail provider result is uncertain; check provider delivery evidence before any retry'})]);
   });throw new Error('Reply delivery requires review of the mail provider delivery record before retrying');}
 }};
}
