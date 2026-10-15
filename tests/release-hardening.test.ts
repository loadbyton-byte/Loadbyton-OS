import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { freshDb, newTenant, ctxFor, convertedJob, payFor } from './helpers.js';
import { mapStatus } from '../src/ops/carrier-tracking.js';
import { invite, setRoles, acceptInvite } from '../src/ops/team.js';
import { RfSession, setRfPin } from '../src/ops/rf-terminal.js';
import { getInvoice, invoiceJob, recordReceipt } from '../src/ops/finance.js';
import { draftCreditNote, issueCreditNote } from '../src/ops/finance-bridge.js';
import { getJob, recordMilestone } from '../src/ops/jobs.js';
import { uploadDocument, setHold } from '../src/ops/documents.js';
import { exportTenantData } from '../src/ops/exporter.js';
import { enableLedger, listAccounts, proposeManualEntry, decideManualEntry } from '../src/ops/ledger.js';
import { ownerDashboard } from '../src/ops/dashboard.js';
import { buildApp } from '../src/app.js';
import { GATES, seedGates, readinessSummary } from '../src/platform/readiness.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
async function member(tenantId: string, role: string) {
 const user = (await db.system(c => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'Reviewer','x') RETURNING id`, [`review-${crypto.randomUUID()}@example.test`]))).rows[0].id;
 await db.system(c => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId,user,[role]]));
 return ctxFor(user,tenantId,[role]);
}
describe('release hardening regressions', () => {
 it.each(['undelivered','not delivered','delivery failed','delivery incomplete','attempted delivery'])('never treats %s as successful delivery', raw => {
  expect(mapStatus(raw,{})).toBe('exception');
  expect(mapStatus('delivered',{})).toBe('delivered');
 });
 it('blocks HR self-escalation, elevated invitations, and acceptance after the issuer loses authority', async () => {
  const t=await newTenant(db);await payFor(db,t);const hr=await member(t.tenantId,'hr');
  await expect(db.tenant(t.tenantId,c=>setRoles(c,hr,hr.userId,['hr','finance']))).rejects.toMatchObject({status:403});
  await expect(db.tenant(t.tenantId,c=>invite(c,hr,{email:'finance-escalation@example.test',roles:['pricing']}))).rejects.toMatchObject({status:403});
  const token=await db.tenant(t.tenantId,c=>invite(c,t.ctx,{email:`pending-${crypto.randomUUID()}@example.test`,roles:['finance']}));
  const other=await member(t.tenantId,'owner');
  await db.tenant(t.tenantId,c=>setRoles(c,other,t.userId,['hr']));
  await expect(acceptInvite(db,token,{name:'Pending user',password:'fixture-password-123'})).rejects.toMatchObject({status:403});
 });
 it('revokes already connected RF sessions when membership is deactivated',async()=>{
  const t=await newTenant(db,undefined,['contract-warehouse-3pl']);
  const row=(await db.system(c=>c.query<any>(`SELECT t.slug,u.email FROM tenants t JOIN users u ON u.id=$2 WHERE t.id=$1`,[t.tenantId,t.userId]))).rows[0];
  await db.tenant(t.tenantId,c=>setRfPin(c,t.ctx,t.userId,'593817'));
  const session=new RfSession(db,40);await session.feed(row.slug);await session.feed(row.email);await session.feed('593817');
  await db.system(c=>c.query(`UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2`,[t.tenantId,t.userId]));
  expect((await session.feed('1')).join(' ')).toMatch(/Access revoked/);expect(session.closed).toBe(true);
 });
 it('freezes seller/customer identity and reconciles freight margin after partial and full credits',async()=>{
  const t=await newTenant(db),j=await convertedJob(db,t,100000,60000),fin=await member(t.tenantId,'finance');
  const inv=await db.tenant(t.tenantId,async c=>{await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`,[j.jobId]);await c.query(`UPDATE job_costs SET actual_minor=estimated_minor WHERE job_id=$1`,[j.jobId]);return invoiceJob(c,t.ctx,j.jobId);});
  const original=await db.tenant(t.tenantId,c=>getInvoice(c,inv.id));
  await db.tenant(t.tenantId,async c=>{await c.query(`UPDATE entities SET legal_name='Changed seller'`);await c.query(`UPDATE parties SET name='Changed customer' WHERE id=$1`,[j.customerId]);});
  const after=await db.tenant(t.tenantId,c=>getInvoice(c,inv.id));expect(after.inv.party_name).toBe(original.inv.party_name);expect(after.inv.legal_name).toBe(original.inv.legal_name);
  await expect(db.tenant(t.tenantId,c=>c.query(`UPDATE invoices SET buyer_snapshot='{}' WHERE id=$1`,[inv.id]))).rejects.toThrow(/immutable/);
  const credit=async(unit:number)=>db.tenant(t.tenantId,async c=>{const id=await draftCreditNote(c,fin,inv.id,{reason:'Service credit',lines:[{description:'Credit',qty:1,unit,tax_code:'SR5'}]});await issueCreditNote(c,t.ctx,id);});
  await credit(20000);let job=await db.tenant(t.tenantId,c=>getJob(c,j.jobId));expect(job.margin.actual?.sell).toBe(80000);expect(job.margin.expected.sell).toBe(80000);const dash=await db.tenant(t.tenantId,c=>ownerDashboard(c,t.tenantId));expect(dash.margin.actSell).toBe(80000);
  await credit(80000);job=await db.tenant(t.tenantId,c=>getJob(c,j.jobId));expect(job.margin.actual?.sell).toBe(0);
 });
 it('requires issued unheld POD evidence for the exact job',async()=>{
  const t=await newTenant(db),j=await convertedJob(db,t);
  const milestone=(await db.tenant(t.tenantId,c=>c.query<any>(`SELECT id FROM job_milestones WHERE job_id=$1 AND code='delivered'`,[j.jobId]))).rows[0].id;
  await db.tenant(t.tenantId,c=>uploadDocument(c,t.ctx,{job_id:j.jobId,kind:'pod',title:'Draft POD',filename:'proof.pdf',data:Buffer.from('%PDF-1.4 fixture')}));
  await expect(db.tenant(t.tenantId,c=>recordMilestone(c,t.ctx,milestone))).rejects.toThrow(/issued, unheld/);
  const doc=await db.tenant(t.tenantId,c=>uploadDocument(c,t.ctx,{job_id:j.jobId,kind:'pod',title:'Issued POD',issuer:'Receiver',filename:'proof.pdf',data:Buffer.from('%PDF-1.4 issued fixture')}));
  await db.tenant(t.tenantId,c=>setHold(c,t.ctx,doc,true));await expect(db.tenant(t.tenantId,c=>recordMilestone(c,t.ctx,milestone))).rejects.toThrow(/issued, unheld/);
  await db.tenant(t.tenantId,c=>setHold(c,t.ctx,doc,false));await db.tenant(t.tenantId,c=>recordMilestone(c,t.ctx,milestone));
 });
 it('exports ledger history, redacts conversation bodies for support, and forbids owner self-approval',async()=>{
  const t=await newTenant(db),j=await convertedJob(db,t);
  await db.tenant(t.tenantId,c=>enableLedger(c,t.ctx,new Date().toISOString().slice(0,10)));
  const accounts=await db.tenant(t.tenantId,c=>listAccounts(c));
  const entry=await db.tenant(t.tenantId,c=>proposeManualEntry(c,t.ctx,{entry_date:new Date().toISOString().slice(0,10),memo:'Opening balance',lines:[{account_id:accounts.find(a=>a.code==='1000').id,debit:'10'},{account_id:accounts.find(a=>a.code==='3000').id,credit:'10'}]}));
  await expect(db.tenant(t.tenantId,c=>decideManualEntry(c,t.ctx,entry,true))).rejects.toThrow(/someone other/);
  const approver=await member(t.tenantId,'owner');await db.tenant(t.tenantId,c=>decideManualEntry(c,approver,entry,true));
  await db.tenant(t.tenantId,async c=>{const convo=(await c.query<any>(`INSERT INTO conversations(tenant_id,party_id,subject,source,external_ref,priority,due_at,created_by) VALUES ($1,$2,'Private subject','email','fixture','normal',now(),$3) RETURNING id`,[t.tenantId,j.customerId,t.userId])).rows[0].id;await c.query(`INSERT INTO conversation_messages(tenant_id,conversation_id,direction,body,reference,status,created_by) VALUES ($1,$2,'inbound','PRIVATE MESSAGE BODY','fixture','captured',$3)`,[t.tenantId,convo,t.userId]);});
  const support={...ctxFor(t.userId,t.tenantId,['auditor']),supportStaffId:t.userId,readOnly:true};
  const data=await db.tenant(t.tenantId,c=>exportTenantData(c,support));expect(JSON.stringify(data)).not.toContain('PRIVATE MESSAGE BODY');expect((data.gl_journals as any[])).toHaveLength(1);expect((data.gl_lines as any[])).toHaveLength(2);
 });
 it('keeps restricted subscriptions readable while refusing direct service mutations',async()=>{
  const t=await newTenant(db),j=await convertedJob(db,t);
  const inv=await db.tenant(t.tenantId,async c=>{await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`,[j.jobId]);return invoiceJob(c,t.ctx,j.jobId);});
  await db.system(c=>c.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`,[t.tenantId]));
  await expect(db.tenant(t.tenantId,c=>recordReceipt(c,t.ctx,inv.id,{amount:'1',method:'cash'}))).rejects.toMatchObject({status:402});
  await expect(db.tenant(t.tenantId,c=>setRoles(c,t.ctx,t.userId,['owner']))).rejects.toMatchObject({status:402});
  expect((await db.tenant(t.tenantId,c=>getInvoice(c,inv.id))).inv.id).toBe(inv.id);
 });
 it('enables geolocation only for same-origin driver pages and makes every sector gate blocking',async()=>{
  const app=buildApp(db);expect((await app.request('/')).headers.get('permissions-policy')).toContain('geolocation=()');expect((await app.request('/app/driver/')).headers.get('permissions-policy')).toContain('geolocation=(self)');
  await seedGates(db);const summary=await readinessSummary(db);expect(GATES.filter(g=>g.key.startsWith('sector_') && g.key !== 'sector_release')).toHaveLength(18);expect(summary.blockers.filter(g=>g.key.startsWith('sector_') && g.key !== 'sector_release')).toHaveLength(18);
 });
});
