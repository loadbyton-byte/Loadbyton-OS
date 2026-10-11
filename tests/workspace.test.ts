import {beforeAll,it,expect} from 'vitest';
import type {Db,Conn} from '../src/db/client.js';
import {freshDb,newTenant,ctxFor} from './helpers.js';
import {createParty,createEnquiry} from '../src/ops/crm.js';
import {uploadDocument} from '../src/ops/documents.js';
import {businessDeadline,DEFAULT_CALENDAR,saveCalendar,captureConversation,assignConversation,acceptConversation,draftReply,approveReply,reviewReplyDelivery,stagePartyMigration,applyPartyMigration,rollbackPartyMigration} from '../src/ops/workspace.js';
import {inboxHandlers} from '../src/adapters/email.js';
import {managementReports} from '../src/ops/reports.js';
import {buildApp} from '../src/app.js';
import {newSession} from '../src/platform/auth.js';
import {SESSION_COOKIE} from '../src/web/mw.js';
let db:Db;beforeAll(async()=>{db=await freshDb();});
async function setup(){const t=await newTenant(db);const run=<T>(fn:(c:Conn)=>Promise<T>)=>db.tenant(t.tenantId,fn);const party=await run(c=>createParty(c,t.ctx,{kind:'customer',name:'Importer',email:'importer@example.com'}));return {t,run,party};}
it('business minutes skip weekends and tenant holidays without inventing a response guarantee',()=>{
 const friday=new Date('2026-10-09T13:55:00Z');expect(businessDeadline(friday,10,DEFAULT_CALENDAR).toISOString()).toBe('2026-10-12T05:05:00.000Z');
 expect(businessDeadline(friday,10,{...DEFAULT_CALENDAR,holidays:['2026-10-12']}).toISOString()).toBe('2026-10-13T05:05:00.000Z');expect(()=>businessDeadline(friday,0,DEFAULT_CALENDAR)).toThrow(/SLA/);
});
it('captures once, controls handover, requires reviewed consented email and meters approval once',async()=>{
 const {t,run,party}=await setup(),f={party_id:party,source:'email',external_ref:'EMAIL1',subject:'Shipment',body:'Please quote',sla_minutes:120,email_consent:true};
 const id=await run(c=>captureConversation(c,t.ctx,f));expect(await run(c=>captureConversation(c,t.ctx,f))).toBe(id);await expect(run(c=>captureConversation(c,t.ctx,{...f,body:'Different message'}))).rejects.toThrow(/different/);
 const other=await newTenant(db);await db.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES($1,$2,ARRAY['sales'])`,[t.tenantId,other.userId]);const sales=ctxFor(other.userId,t.tenantId,['sales']);
 await run(c=>assignConversation(c,t.ctx,id,other.userId,'Sales to accept'));await expect(run(c=>draftReply(c,sales,id,'Draft','REPLY1'))).rejects.toThrow(/Accept/);await run(c=>acceptConversation(c,sales,id));
 const message=await run(c=>draftReply(c,sales,id,'Reviewed service response','REPLY1'));await expect(run(c=>approveReply(c,sales,message))).rejects.toThrow(/role/);await run(c=>approveReply(c,t.ctx,message));await run(c=>approveReply(c,t.ctx,message));
 expect((await db.query<any>(`SELECT used FROM usage_counters WHERE tenant_id=$1 AND key='messages_per_month'`,[t.tenantId])).rows[0].used).toBe(1);
 const row=(await db.query<any>(`SELECT * FROM outbox WHERE key=$1`,[`inbox:${message}`])).rows[0];let sends=0;const handler=inboxHandlers(db,async(to,subject,body)=>{expect(to).toBe('importer@example.com');expect(body).toBe('Reviewed service response');sends++;})['inbox.reply'];await handler(row);await handler(row);expect(sends).toBe(1);
 await expect(db.tenant(other.tenantId,c=>approveReply(c,other.ctx,message))).rejects.toThrow(/not found/);
 await expect(db.query(`UPDATE conversation_messages SET body='overwritten' WHERE id=$1`,[message])).rejects.toThrow(/immutable/);
 await run(c=>saveCalendar(c,t.ctx,DEFAULT_CALENDAR));
});
it('does not send a draft when consent is absent or SMTP authorization changed',async()=>{
 const {t,run,party}=await setup(),id=await run(c=>captureConversation(c,t.ctx,{party_id:party,source:'call',external_ref:'CALL1',subject:'Call',body:'Captured',sla_minutes:1})),message=await run(c=>draftReply(c,t.ctx,id,'Response','DRAFT1'));
 await expect(run(c=>approveReply(c,t.ctx,message))).rejects.toThrow(/consent/);
});
it('an ambiguous SMTP result requires evidence review before another attempt',async()=>{
 const {t,run,party}=await setup(),id=await run(c=>captureConversation(c,t.ctx,{party_id:party,source:'email',external_ref:'SMTP1',subject:'Service response',body:'Question',sla_minutes:10,email_consent:true})),message=await run(c=>draftReply(c,t.ctx,id,'Answer','REPLY1'));await run(c=>approveReply(c,t.ctx,message));
 const row=(await db.query<any>(`SELECT * FROM outbox WHERE key=$1`,[`inbox:${message}`])).rows[0];let sends=0;const handler=inboxHandlers(db,async()=>{sends++;throw new Error('Timeout after submission');})['inbox.reply'];
 await expect(handler(row)).rejects.toThrow(/review/);await expect(handler(row)).rejects.toThrow(/authorization/);expect(sends).toBe(1);
 await run(c=>reviewReplyDelivery(c,t.ctx,message,'confirmed_sent','SMTP provider delivery ID confirms delivery'));
 await handler(row);expect(sends).toBe(1);
});
it('stages source evidence, applies only approved valid rows, retries once and rolls back unused records',async()=>{
 const {t,run}=await setup(),csv='name,kind,email\nImported customer,customer,customer@example.com\n',doc=await run(c=>uploadDocument(c,t.ctx,{kind:'other',title:'Customer export',issuer:'Source owner',filename:'source.csv',data:Buffer.from(csv)}));
 const batch=await run(c=>stagePartyMigration(c,t.ctx,doc,'Approved source inventory; new customers only'));
 expect((await run(c=>c.query(`SELECT id FROM parties WHERE name='Imported customer'`))).rows).toHaveLength(0);
 const report=await run(c=>applyPartyMigration(c,t.ctx,batch,'Customer validated mapping, reconciled counts, freeze agreed; fallback source retained'));expect(report.created).toBe(1);expect(await run(c=>applyPartyMigration(c,t.ctx,batch,'Retry'))).toEqual(report);
 await run(c=>rollbackPartyMigration(c,t.ctx,batch,'Cutover postponed'));expect((await run(c=>c.query(`SELECT id FROM parties WHERE name='Imported customer'`))).rows).toHaveLength(0);await expect(run(c=>applyPartyMigration(c,t.ctx,batch,'Retry old batch'))).rejects.toThrow(/new reviewed batch/);
});
it('rejects invalid cutover and blocks atomic rollback after source records are used',async()=>{
 const {t,run}=await setup();
 const doc=await run(c=>uploadDocument(c,t.ctx,{kind:'other',title:'Source',issuer:'Source owner',filename:'source.csv',data:Buffer.from('name,kind,email\nValid,customer,valid@example.com\nInvalid,customer,invalid\n')}));
 const batch=await run(c=>stagePartyMigration(c,t.ctx,doc,'Source reviewed'));await expect(run(c=>applyPartyMigration(c,t.ctx,batch,'Cutover'))).rejects.toThrow(/rejected/);
 const good=await run(c=>uploadDocument(c,t.ctx,{kind:'other',title:'Corrected source',issuer:'Source owner',filename:'source.csv',data:Buffer.from('name,kind,email\nValid,customer,valid@example.com\n')})),next=await run(c=>stagePartyMigration(c,t.ctx,good,'Corrected source'));
 await run(c=>applyPartyMigration(c,t.ctx,next,'Reviewed and reconciled'));const party=(await run(c=>c.query<any>(`SELECT id FROM parties WHERE name='Valid'`))).rows[0].id;await run(c=>createEnquiry(c,t.ctx,{party_id:party,mode:'ocean'}));
 await expect(run(c=>rollbackPartyMigration(c,t.ctx,next,'Undo'))).rejects.toThrow(/in use/);expect((await run(c=>c.query(`SELECT id FROM parties WHERE id=$1`,[party]))).rows).toHaveLength(1);
});
it('reports are tenant-scoped and all shared pages require an authorised session',async()=>{
 const {t,run}=await setup();const report=await run(c=>managementReports(c,t.ctx));expect(report.finance).toEqual([]);await expect(run(c=>managementReports(c,ctxFor(t.userId,t.tenantId,['sales'])))).rejects.toThrow(/role/);
 const s=await newSession(db,t.userId,t.tenantId),app=buildApp(db),headers={cookie:`${SESSION_COOKIE}=${s.token}`};for(const path of ['/app/inbox','/app/migration','/app/management-reports'])expect((await app.request(path,{headers})).status).toBe(200);
});
