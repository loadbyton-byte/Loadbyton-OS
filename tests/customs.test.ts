import {beforeAll,describe,it,expect} from 'vitest';
import type {Db} from '../src/db/client.js';
import {freshDb,newTenant,ctxFor} from './helpers.js';
import {createParty} from '../src/ops/crm.js';
import {uploadDocument} from '../src/ops/documents.js';
import {createCase,invoiceCase,attachEvidence,transitionCase,recordDeposit,getCase} from '../src/ops/customs.js';
import {recordReceipt,voidInvoice} from '../src/ops/finance.js';
import {verifyInvariants} from '../src/platform/invariants.js';
import {buildApp} from '../src/app.js';
import {newSession} from '../src/platform/auth.js';
import {SESSION_COOKIE} from '../src/web/mw.js';
let db:Db;
beforeAll(async()=>{db=await freshDb();});
async function setup(){const t=await newTenant(db,undefined,['customs-brokerage']);const party=await db.tenant(t.tenantId,c=>createParty(c,t.ctx,{kind:'customer',name:'Importer'}));const p=await db.tenant(t.tenantId,c=>createCase(c,t.ctx,{party_id:party,external_ref:'Shipment-1',declaration_type:'import'}));return {t,party,p};}
describe('Customs evidence handover',()=>{
 it('requires complete evidence, a handover reference and clearance evidence; never skips state transitions',async()=>{
  const {t,p}=await setup();const run=<T>(fn:(c:any)=>Promise<T>)=>db.tenant(t.tenantId,fn);
  await expect(run(c=>transitionCase(c,t.ctx,p.id,'cleared','Shortcut'))).rejects.toThrow(/transition/);
  await expect(run(c=>transitionCase(c,t.ctx,p.id,'ready','Reviewed'))).rejects.toThrow(/Attach invoice/);
  for(const kind of ['commercial_invoice','packing_list','transport_document']){const doc=await run(c=>uploadDocument(c,t.ctx,{kind,title:kind,issuer:'External issuer',filename:'evidence.pdf',data:Buffer.from('%PDF-1.4 authentic test evidence')}));await run(c=>attachEvidence(c,t.ctx,p.id,doc,kind));await run(c=>attachEvidence(c,t.ctx,p.id,doc,kind));}
  await run(c=>transitionCase(c,t.ctx,p.id,'ready','All relevant permits and goods reviewed'));
  await expect(run(c=>transitionCase(c,t.ctx,p.id,'handed_over','Sent'))).rejects.toThrow(/reference/);
  await run(c=>transitionCase(c,t.ctx,p.id,'handed_over','Handed to authorised broker','BROKER-1'));
  await run(c=>transitionCase(c,t.ctx,p.id,'inspection','Authority requested inspection'));
  await expect(run(c=>transitionCase(c,t.ctx,p.id,'cleared','Verbal approval'))).rejects.toThrow(/clearance evidence/);
  const doc=await run(c=>uploadDocument(c,t.ctx,{kind:'other',title:'Authority release',issuer:'Authority',filename:'release.pdf',data:Buffer.from('%PDF-1.4 release')}));
  await run(c=>attachEvidence(c,t.ctx,p.id,doc,'clearance'));await run(c=>transitionCase(c,t.ctx,p.id,'cleared','Official release verified'));
  const result=await run(c=>getCase(c,p.id));expect(result.p.status).toBe('cleared');expect(result.evidence).toHaveLength(4);expect(result.events).toHaveLength(4);
 });
 it('receives and refunds deposits once, never over-refunds or refunds an open case',async()=>{
  const {t,p}=await setup(),run=<T>(fn:(c:any)=>Promise<T>)=>db.tenant(t.tenantId,fn);
  await run(c=>recordDeposit(c,t.ctx,p.id,'received','200','BANK-RECEIPT'));
  await run(c=>recordDeposit(c,t.ctx,p.id,'received','200','BANK-RECEIPT'));
  await expect(run(c=>recordDeposit(c,t.ctx,p.id,'refunded','200','REFUND'))).rejects.toThrow(/clearance or cancellation/);
  await run(c=>transitionCase(c,t.ctx,p.id,'cancelled','Customer cancelled'));
  await expect(run(c=>recordDeposit(c,t.ctx,p.id,'refunded','201','OVER'))).rejects.toThrow(/exceeds/);
  await Promise.all([run(c=>recordDeposit(c,t.ctx,p.id,'refunded','200','REFUND')),run(c=>recordDeposit(c,t.ctx,p.id,'refunded','200','REFUND'))]);
  await expect(run(c=>recordDeposit(c,t.ctx,p.id,'refunded','0.01','EXTRA'))).rejects.toThrow(/exceeds/);
  expect((await run(c=>getCase(c,p.id))).deposits).toHaveLength(2);
 });
 it('gates roles, sector selection, quotas and cross-tenant evidence; validates HTTP pages',async()=>{
  const {t,p,party}=await setup(),other=await newTenant(db),run=<T>(fn:(c:any)=>Promise<T>)=>db.tenant(t.tenantId,fn);
  await expect(db.tenant(other.tenantId,c=>createCase(c,other.ctx,{party_id:'invalid'}))).rejects.toThrow(/not selected/);
  await expect(run(c=>createCase(c,ctxFor(t.userId,t.tenantId,['sales']),{}))).rejects.toThrow(/role/);
  const foreign=await db.tenant(other.tenantId,c=>uploadDocument(c,other.ctx,{kind:'other',title:'Foreign',filename:'secret.pdf',data:Buffer.from('%PDF-1.4 secret')}));
  await expect(run(c=>attachEvidence(c,t.ctx,p.id,foreign,'commercial_invoice'))).rejects.toThrow(/not found/);
  await db.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES ($1,'customs_cases_per_month',1,'test')`,[t.tenantId]);
  await expect(run(c=>createCase(c,t.ctx,{party_id:party,external_ref:'new',declaration_type:'import'}))).rejects.toThrow(/allowance|limit/);
  const session=await newSession(db,t.userId,t.tenantId),app=buildApp(db),headers={cookie:`${SESSION_COOKIE}=${session.token}`};
  expect((await app.request('/app/customs',{headers})).status).toBe(200);expect((await app.request(`/app/customs/${p.id}`,{headers})).status).toBe(200);
  const otherSession=await newSession(db,other.userId,other.tenantId);expect(await (await app.request('/app/customs',{headers:{cookie:`${SESSION_COOKIE}=${otherSession.token}`}})).text()).toContain('Customs brokerage is not selected');
  await expect(db.query(`UPDATE customs_deposit_entries SET amount_minor=0`)).rejects.toThrow(/immutable/);
 });
 it('preserves restore invariants',async()=>{expect(await verifyInvariants(db)).toEqual([]);});
 it('requires issued permits and invoices only service revenue, independently of deposits',async()=>{
  const {t,party}=await setup(),run=<T>(fn:(c:any)=>Promise<T>)=>db.tenant(t.tenantId,fn),p=await run(c=>createCase(c,t.ctx,{party_id:party,external_ref:'FEE-CASE',declaration_type:'import',fee:'100',permit_required:true}));
  for(const kind of ['commercial_invoice','packing_list','transport_document','clearance']){const doc=await run(c=>uploadDocument(c,t.ctx,{kind:'other',title:kind,issuer:'Authorised external issuer',filename:'evidence.pdf',data:Buffer.from('%PDF-1.4 evidence')}));await run(c=>attachEvidence(c,t.ctx,p.id,doc,kind));}
  await expect(run(c=>transitionCase(c,t.ctx,p.id,'ready','Reviewed'))).rejects.toThrow(/permit/);
  const doc=await run(c=>uploadDocument(c,t.ctx,{kind:'other',title:'Permit',issuer:'Authority',filename:'permit.pdf',data:Buffer.from('%PDF-1.4 permit')}));await run(c=>attachEvidence(c,t.ctx,p.id,doc,'permit'));
  await run(c=>recordDeposit(c,t.ctx,p.id,'received','500','DEPOSIT-FEE'));await run(c=>transitionCase(c,t.ctx,p.id,'ready','Goods-specific review completed'));await run(c=>transitionCase(c,t.ctx,p.id,'handed_over','External broker','AGENT-FEE'));await run(c=>transitionCase(c,t.ctx,p.id,'cleared','Authentic release verified'));
  const first=await run(c=>invoiceCase(c,t.ctx,p.id));expect((await run(c=>invoiceCase(c,t.ctx,p.id))).id).toBe(first.id);await run(c=>voidInvoice(c,t.ctx,first.id,'Corrected document'));const inv=await run(c=>invoiceCase(c,t.ctx,p.id));
  expect(Number((await db.query<any>(`SELECT total_minor FROM invoices WHERE id=$1`,[inv.id])).rows[0].total_minor)).toBe(10500);await run(c=>recordReceipt(c,t.ctx,inv.id,{amount:'105',method:'bank transfer',reference:'FEE-RECEIPT'}));expect((await run(c=>getCase(c,p.id))).p.financial_status).toBe('collected');
  const session=await newSession(db,t.userId,t.tenantId),app=buildApp(db),response=await app.request(`/app/invoices/${inv.id}?lang=ar`,{headers:{cookie:`${SESSION_COOKIE}=${session.token}`}});expect(response.status).toBe(200);expect(await response.text()).toContain('dir="rtl"');expect(await verifyInvariants(db)).toEqual([]);
 });
});
