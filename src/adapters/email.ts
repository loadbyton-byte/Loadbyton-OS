import nodemailer from 'nodemailer';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import type { OutboxHandlers } from '../platform/outbox.js';
import { sha256 } from '../lib/util.js';
import {decryptSecret} from '../lib/encryption.js';

export async function sendEmail(to:string,subject:string,text:string,messageId:string) {
 if(!config.smtp.url||!config.smtp.from)throw new Error('SMTP delivery is not configured');
 const url=new URL(config.smtp.url);if(!['smtp:','smtps:'].includes(url.protocol))throw new Error('Invalid SMTP transport');
 const transport=nodemailer.createTransport({host:url.hostname,port:Number(url.port||(url.protocol==='smtps:'?465:587)),secure:url.protocol==='smtps:',requireTLS:true,auth:{user:decodeURIComponent(url.username),pass:decodeURIComponent(url.password)},connectionTimeout:10000,socketTimeout:15000,tls:{rejectUnauthorized:true}});
 try{await transport.sendMail({from:config.smtp.from,to,subject,text,messageId});}finally{transport.close();}
}

export function inboxHandlers(db:Db,send=sendEmail):OutboxHandlers {
 return {'inbox.reply':async row=>{
  const message=(await db.query<any>(`SELECT m.*,v.subject,v.email_consent,v.status AS conversation_status,p.email FROM conversation_messages m JOIN conversations v ON v.id=m.conversation_id JOIN parties p ON p.id=v.party_id WHERE m.id=$1`,[row.payload.messageId])).rows[0];
  if(!message||message.tenant_id!==row.tenant_id)throw new Error('Reply tenant mismatch');
  if(message.status==='sent')return {externalId:message.external_id};
  if(!['approved','failed'].includes(message.status)||!message.approved_by||!message.approved_recipient||message.approved_recipient!==message.email||!message.email_consent||message.conversation_status!=='open')throw new Error('Reply authorization, recipient or consent changed; delivery stopped');
  const messageId=`<${sha256(row.key)}@${new URL(config.baseUrl).hostname}>`;
  try{await send(message.email,`Re: ${message.subject}`,message.body,messageId);await db.query(`UPDATE conversation_messages SET status='sent',sent_at=now(),external_id=$2 WHERE id=$1`,[message.id,messageId]);return {externalId:messageId};}
  catch{await db.system(async c=>{
    await c.query(`UPDATE conversation_messages SET status='delivery_review' WHERE id=$1`,[message.id]);
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES($1,'staff.review',$2,$3) ON CONFLICT(key) DO NOTHING`,[row.tenant_id,`inbox-review:${message.id}`,JSON.stringify({messageId:message.id,reason:'SMTP result is uncertain; check provider delivery evidence before any retry'})]);
   });throw new Error('Reply delivery requires review of the SMTP delivery record before retrying');}
 }};
}

export function emailHandlers(db:Db): OutboxHandlers {
 return {async email(row) {
  if(!config.smtp.url||!config.smtp.from) {
   if(config.isProd)throw new Error('Notification email is not configured');
   return;
  }
  const url=new URL(config.smtp.url);
  if(!['smtp:','smtps:'].includes(url.protocol))throw new Error('Invalid SMTP transport');
  const transport=nodemailer.createTransport({host:url.hostname,port:Number(url.port||(url.protocol==='smtps:'?465:587)),secure:url.protocol==='smtps:',requireTLS:true,
   auth:{user:decodeURIComponent(url.username),pass:decodeURIComponent(url.password)},connectionTimeout:10000,socketTimeout:15000,tls:{rejectUnauthorized:true}});
  const owners=(await db.query<any>(`SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.active AND 'owner'=ANY(m.roles)`,[row.tenant_id])).rows.map(x=>x.email);
  const template=row.payload.template;
  const to=template==='invitation'?[row.payload.email]:owners;
  if(!to.length)throw new Error('Notification has no recipient');
  if(template==='invitation'&&!row.payload.tokenEncrypted)throw new Error('Legacy invitation requires an owner to revoke and reissue a secure link');
  const text=template==='invitation'?`Your company invited you to LOAD|BY|TON. Accept at ${config.baseUrl}/invite/${row.payload.tokenEncrypted?decryptSecret(row.payload.tokenEncrypted):''}. This private link expires in seven days. Existing accounts must authenticate with their password.`:template==='workspace_ready'?`Your upgraded workspace is ready. Sign in at ${config.baseUrl}/app. No password is included in this message.`:template==='payment_received'?`Payment verified for ${row.payload.reference}. View your order and activation progress at ${config.baseUrl}/app/billing.`:null;
  if(!text)throw new Error('Unsupported email template');
  const messageId=`<${sha256(row.key)}@${new URL(config.baseUrl).hostname}>`;
  await transport.sendMail({from:config.smtp.from,to,subject:template==='invitation'?'Your workspace invitation':template==='workspace_ready'?'Your workspace is ready':'Payment verified',text,messageId});
  return {externalId:messageId};
 }};
}
