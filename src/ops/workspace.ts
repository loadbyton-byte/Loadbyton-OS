import type {Conn} from '../db/client.js';
import {actorOf,require,type Ctx} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,HttpError,sha256} from '../lib/util.js';
import {consumeQuota,assertWritable} from '../platform/entitlements.js';
import {must,recordId,reqStr} from './common.js';
import {importParties,parseCsv} from './importer.js';
import {fetchDocumentFile} from './documents.js';
export interface Calendar {weekdays:number[];start_hour:number;end_hour:number;holidays:string[]}
export const DEFAULT_CALENDAR:Calendar={weekdays:[1,2,3,4,5],start_hour:9,end_hour:18,holidays:[]};
/** Business minutes in Asia/Dubai (UTC+4, no DST); calendar explicitly configured per company. */
export function businessDeadline(start:Date,minutes:number,calendar:Calendar) {
 if(!Number.isInteger(minutes)||minutes<1||minutes>10000)throw badRequest('SLA is 1–10,000 business minutes');
 const local=new Date(Math.ceil(start.getTime()/60000)*60000+4*3600000);
 for(let i=0;i<366*1440;i++) {
  if(calendar.weekdays.includes(local.getUTCDay())&&!calendar.holidays.includes(local.toISOString().slice(0,10))&&local.getUTCHours()>=calendar.start_hour&&local.getUTCHours()<calendar.end_hour&&--minutes===0)return new Date(local.getTime()-4*3600000+60000);
  local.setUTCMinutes(local.getUTCMinutes()+1);
 }throw badRequest('Business calendar does not provide enough working time');
}
export async function saveCalendar(c:Conn,ctx:Ctx,calendar:Calendar) {
 require(ctx,'settings.manage');await assertWritable(c,ctx.tenantId);
 if(!calendar.weekdays.length||calendar.weekdays.some(d=>!Number.isInteger(d)||d<0||d>6)||!Number.isInteger(calendar.start_hour)||!Number.isInteger(calendar.end_hour)||calendar.start_hour<0||calendar.end_hour>24||calendar.start_hour>=calendar.end_hour||calendar.holidays.length>100||calendar.holidays.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(new Date(d).getTime())))throw badRequest('Choose valid working days, hours and holiday dates');
 await c.query(`INSERT INTO business_calendars(tenant_id,weekdays,start_hour,end_hour,holidays) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET weekdays=$2,start_hour=$3,end_hour=$4,holidays=$5`,[ctx.tenantId,calendar.weekdays,calendar.start_hour,calendar.end_hour,calendar.holidays]);
 await audit(c,ctx.tenantId,actorOf(ctx),'calendar.updated','tenant',ctx.tenantId,calendar);
}
export async function captureConversation(c:Conn,ctx:Ctx,f:Record<string,any>) {
 require(ctx,'inbox.write');await assertWritable(c,ctx.tenantId);
 const party=recordId(f.party_id),source=reqStr(f.source,'Source',40),ref=reqStr(f.external_ref,'External reference',120),subject=reqStr(f.subject,'Subject',200),body=reqStr(f.body,'Captured message',8000);
 await must(c.query(`SELECT id FROM parties WHERE id=$1`,[party]),'Party');if(f.job_id)await must(c.query(`SELECT id FROM jobs WHERE id=$1`,[recordId(f.job_id)]),'Job');
 await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:inbox:${source}:${ref}`]);
 const old=(await c.query<any>(`SELECT v.*,m.body FROM conversations v JOIN conversation_messages m ON m.conversation_id=v.id AND m.reference='initial' WHERE v.source=$1 AND v.external_ref=$2`,[source,ref])).rows[0];
 if(old){if(old.subject!==subject||old.body!==body||old.party_id!==party||old.job_id!==(f.job_id||null))throw new HttpError(409,'Conversation reference was used for different evidence');return old.id;}
 const calendar=(await c.query<Calendar>(`SELECT * FROM business_calendars`)).rows[0]??DEFAULT_CALENDAR;
 const priority=['urgent','high','normal','low'].includes(f.priority)?f.priority:'normal',due=businessDeadline(new Date(),Number(f.sla_minutes??240),calendar);
 const id=(await c.query<any>(`INSERT INTO conversations(tenant_id,party_id,job_id,subject,source,external_ref,owner_id,accepted_at,priority,due_at,email_consent,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$7) RETURNING id`,[ctx.tenantId,party,f.job_id||null,subject,source,ref,ctx.userId,priority,due,f.email_consent==='on'||f.email_consent===true])).rows[0].id;
 await c.query(`INSERT INTO conversation_messages(tenant_id,conversation_id,direction,body,reference,status,created_by) VALUES($1,$2,'inbound',$3,'initial','captured',$4)`,[ctx.tenantId,id,body,ctx.userId]);
 await audit(c,ctx.tenantId,actorOf(ctx),'inbox.captured','conversation',id,{source,priority,due});return id;
}
export async function assignConversation(c:Conn,ctx:Ctx,id:string,ownerId:string,reason:string) {
 require(ctx,'inbox.write');await assertWritable(c,ctx.tenantId);const row=await must(c.query<any>(`SELECT * FROM conversations WHERE id=$1 FOR UPDATE`,[recordId(id)]),'Conversation');
 const owner=recordId(ownerId);await must(c.query(`SELECT user_id FROM memberships WHERE user_id=$1 AND active AND roles&&ARRAY['owner','sales','coordinator','specialist']::text[] AND NOT('portal'=ANY(roles)) AND NOT('driver'=ANY(roles))`,[owner]),'Active staff member');
 if(row.status!=='open')throw badRequest('Reopen conversation before handover');
 await c.query(`UPDATE conversations SET owner_id=$2,accepted_at=NULL WHERE id=$1`,[id,owner]);
 await audit(c,ctx.tenantId,actorOf(ctx),'inbox.handed_over','conversation',id,{ownerId:owner,reason:reqStr(reason,'Handover reason',1000)});
}
export async function acceptConversation(c:Conn,ctx:Ctx,id:string) {
 require(ctx,'inbox.write');await assertWritable(c,ctx.tenantId);const row=await must(c.query<any>(`UPDATE conversations SET accepted_at=now() WHERE id=$1 AND owner_id=$2 AND status='open' RETURNING id`,[recordId(id),ctx.userId]),'Assigned open conversation');await audit(c,ctx.tenantId,actorOf(ctx),'inbox.accepted','conversation',row.id);
}
export async function draftReply(c:Conn,ctx:Ctx,id:string,body:string,ref:string) {
 require(ctx,'inbox.write');await assertWritable(c,ctx.tenantId);const row=await must(c.query<any>(`SELECT * FROM conversations WHERE id=$1 FOR UPDATE`,[recordId(id)]),'Conversation');
 if(row.status!=='open'||!row.accepted_at||row.owner_id!==ctx.userId)throw badRequest('Accept the assigned conversation before drafting a reply');
 const text=reqStr(body,'Draft response',8000),reference=reqStr(ref,'Draft reference',120),old=(await c.query<any>(`SELECT * FROM conversation_messages WHERE conversation_id=$1 AND reference=$2`,[id,reference])).rows[0];
 if(old){if(old.direction!=='outbound'||old.body!==text)throw new HttpError(409,'Draft reference already used');return old.id;}
 const message=(await c.query<any>(`INSERT INTO conversation_messages(tenant_id,conversation_id,direction,body,reference,status,created_by) VALUES($1,$2,'outbound',$3,$4,'draft',$5) RETURNING id`,[ctx.tenantId,id,text,reference,ctx.userId])).rows[0].id;
 await audit(c,ctx.tenantId,actorOf(ctx),'inbox.reply_drafted','message',message);return message;
}
export async function approveReply(c:Conn,ctx:Ctx,id:string) {
 require(ctx,'inbox.approve');await assertWritable(c,ctx.tenantId);
 const row=await must(c.query<any>(`SELECT m.*,v.email_consent,v.status AS conversation_status,p.email FROM conversation_messages m JOIN conversations v ON v.id=m.conversation_id JOIN parties p ON p.id=v.party_id WHERE m.id=$1 FOR UPDATE OF m`,[recordId(id)]),'Draft reply');
 if(['approved','sent'].includes(row.status))return;
 if(row.direction!=='outbound'||row.status!=='draft'||row.conversation_status!=='open'||!row.email_consent||!row.email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))throw badRequest('Outbound email requires an open conversation, valid recipient, consent and a reviewed draft');
 await consumeQuota(c,ctx.tenantId,'messages_per_month',`message:${id}`);
 await c.query(`UPDATE conversation_messages SET status='approved',approved_by=$2,approved_recipient=$3 WHERE id=$1`,[id,ctx.userId,row.email]);
 await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES($1,'inbox.reply',$2,$3) ON CONFLICT(key) DO NOTHING`,[ctx.tenantId,`inbox:${id}`,JSON.stringify({messageId:id})]);
 await audit(c,ctx.tenantId,actorOf(ctx),'inbox.reply_approved','message',id);
}
export async function closeConversation(c:Conn,ctx:Ctx,id:string,reason:string) {
 require(ctx,'inbox.write');await assertWritable(c,ctx.tenantId);await must(c.query<any>(`UPDATE conversations SET status='closed' WHERE id=$1 AND owner_id=$2 RETURNING id`,[recordId(id),ctx.userId]),'Owned conversation');await audit(c,ctx.tenantId,actorOf(ctx),'inbox.closed','conversation',id,{reason:reqStr(reason,'Outcome',1000)});
}
export async function reviewReplyDelivery(c:Conn,ctx:Ctx,id:string,outcome:string,evidence:string) {
 require(ctx,'inbox.approve');await assertWritable(c,ctx.tenantId);const message=await must(c.query<any>(`SELECT * FROM conversation_messages WHERE id=$1 FOR UPDATE`,[recordId(id)]),'Message');
 if(message.status!=='delivery_review'||!['confirmed_sent','retry','cancel'].includes(outcome))throw badRequest('Choose a reviewed delivery outcome');
 const why=reqStr(evidence,'SMTP delivery evidence and decision',2000),box=await must(c.query<any>(`SELECT * FROM outbox WHERE key=$1 FOR UPDATE`,[`inbox:${id}`]),'Delivery event');
 if(box.lease_until&&new Date(box.lease_until).getTime()>Date.now())throw badRequest('Delivery worker is still finalising the attempt; retry this decision shortly');
 const status=outcome==='confirmed_sent'?'sent':outcome==='retry'?'approved':'cancelled';
 await c.query(`UPDATE conversation_messages SET status=$2,sent_at=CASE WHEN $2='sent' THEN now() ELSE sent_at END,external_id=CASE WHEN $2='sent' THEN $3 ELSE external_id END WHERE id=$1`,[id,status,outcome==='confirmed_sent'?why:null]);
 await c.query(`UPDATE outbox SET status=$2,attempts=0,next_at=now(),last_error=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1`,[box.id,outcome==='retry'?'pending':'sent']);
 await audit(c,ctx.tenantId,actorOf(ctx),'inbox.delivery_reviewed','message',id,{outcome,evidence:why});
}
/** Source import remains evidence until owner review; no unverified opening balances are posted. */
async function migrationSource(c:Conn,id:string) {
 const doc=await must(c.query<any>(`SELECT * FROM documents WHERE id=$1 AND status='issued' AND NOT hold`,[recordId(id)]),'Issued source file');
 if(doc.mime!=='text/csv')throw badRequest('Use an issued CSV source file');
 return {doc,csv:(await fetchDocumentFile(doc.storage_key,doc.tenant_id,doc.sha256)).toString('utf8')};
}
export async function stagePartyMigration(c:Conn,ctx:Ctx,documentId:string,purpose:string) {
 require(ctx,'settings.manage');await assertWritable(c,ctx.tenantId);const {doc,csv}=await migrationSource(c,documentId),report=await importParties(c,ctx,csv,true);
 const id=(await c.query<any>(`INSERT INTO migration_batches(tenant_id,source_document_id,purpose,source_hash,mapping,report,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[ctx.tenantId,doc.id,reqStr(purpose,'Source inventory and cutover scope',2000),sha256(csv),JSON.stringify({columns:parseCsv(csv)[0],system_of_record:'New customer/supplier records only; financial opening balances remain in approved accounting system'}),JSON.stringify(report),ctx.userId])).rows[0].id;
 await audit(c,ctx.tenantId,actorOf(ctx),'migration.validated','migration_batch',id,{report});return id;
}
export async function applyPartyMigration(c:Conn,ctx:Ctx,id:string,evidence:string) {
 require(ctx,'settings.manage');await assertWritable(c,ctx.tenantId);
 await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:party-import`]);
 const batch=await must(c.query<any>(`SELECT * FROM migration_batches WHERE id=$1 FOR UPDATE`,[recordId(id)]),'Migration batch');if(batch.status==='applied')return batch.report;if(batch.status==='rolled_back')throw badRequest('Create a new reviewed batch after rollback');
 const {csv}=await migrationSource(c,batch.source_document_id);if(sha256(csv)!==batch.source_hash)throw badRequest('Source evidence changed; repeat validation');
 const dry=await importParties(c,ctx,csv,true);if(dry.rejected.length)throw badRequest('Correct rejected source rows before cutover');
 const before=(await c.query<any>(`SELECT id FROM parties`)).rows.map(p=>p.id),report=await importParties(c,ctx,csv),ids=(await c.query<any>(`SELECT id FROM parties WHERE NOT(id=ANY($1::uuid[]))`,[before])).rows.map(p=>p.id);
 await c.query(`UPDATE migration_batches SET status='applied',approved_by=$2,evidence=$3,report=$4,created_ids=$5,applied_at=now() WHERE id=$1`,[id,ctx.userId,reqStr(evidence,'Customer validation, reconciliation, change freeze and fallback evidence',3000),JSON.stringify(report),ids]);
 await audit(c,ctx.tenantId,actorOf(ctx),'migration.applied','migration_batch',id,{report,ids});return report;
}

/** Only unused imported parties can be removed; foreign-key references block rollback atomically. */
export async function rollbackPartyMigration(c:Conn,ctx:Ctx,id:string,reason:string) {
 require(ctx,'settings.manage');await assertWritable(c,ctx.tenantId);
 await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:party-import`]);
 const batch=await must(c.query<any>(`SELECT * FROM migration_batches WHERE id=$1 FOR UPDATE`,[recordId(id)]),'Migration batch');if(batch.status==='rolled_back')return;if(batch.status!=='applied')throw badRequest('Only an applied batch can be rolled back');
 try{await c.query(`DELETE FROM parties WHERE id=ANY($1::uuid[])`,[batch.created_ids]);}catch(e:any){if(e.code==='23503')throw badRequest('Imported records are in use. Preserve them and use a reviewed compensating migration');throw e;}
 await c.query(`UPDATE migration_batches SET status='rolled_back' WHERE id=$1`,[id]);await audit(c,ctx.tenantId,actorOf(ctx),'migration.rolled_back','migration_batch',id,{reason:reqStr(reason,'Rollback reason',2000),removedIds:batch.created_ids});
}
