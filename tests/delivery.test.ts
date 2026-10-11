import { beforeAll, describe, it, expect } from 'vitest';
import type { Db } from '../src/db/client.js';
import type { Ctx } from '../src/lib/perms.js';
import { freshDb,newTenant,ctxFor } from './helpers.js';
import { createParty } from '../src/ops/crm.js';
import { createDriver } from '../src/ops/transport.js';
import { createParcel,dispatchParcel,recordAttempt,receiveCash,reconcileCod,remitCod,invoiceParcel,getParcel,deliveryMoney,listParcels } from '../src/ops/delivery.js';
import { voidInvoice,getInvoice } from '../src/ops/finance.js';
import { verifyInvariants } from '../src/platform/invariants.js';
import { exportTenantData } from '../src/ops/exporter.js';
import { buildApp } from '../src/app.js';
import { newSession } from '../src/platform/auth.js';
let db:Db,n=0;
beforeAll(async()=>{db=await freshDb();});
async function staff(tenantId:string,roles:string[],driverId:string|null=null) {
 const id=(await db.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'Staff','x') RETURNING id`,[`delivery-${++n}@example.com`])).rows[0].id;
 await db.query(`INSERT INTO memberships(tenant_id,user_id,roles,driver_id) VALUES ($1,$2,$3,$4)`,[tenantId,id,roles,driverId]);
 return {...ctxFor(id,tenantId,roles),driverId};
}
async function setup() {
 const t=await newTenant(db,undefined,['courier-last-mile']);
 const {merchant,driver}=await db.tenant(t.tenantId,async c=>({merchant:await createParty(c,t.ctx,{name:'Merchant',kind:'customer'}),driver:await createDriver(c,t.ctx,{name:'Courier'})}));
 const courier=await staff(t.tenantId,['driver'],driver),finance=await staff(t.tenantId,['finance']),approver=await staff(t.tenantId,['finance']);
 const input={party_id:merchant,external_ref:`M-${++n}`,recipient_name:'Recipient',recipient_phone:'0501234567',address:'Dubai',fee:'15',cod:'100',tax_code:'SR5'};
 const p=await db.tenant(t.tenantId,c=>createParcel(c,t.ctx,input));
 const run=<T>(ctx:Ctx,fn:(c:any)=>Promise<T>)=>db.tenant(t.tenantId,fn);
 return {t,merchant,driver,courier,finance,approver,p,input,run};
}
describe('Delivery and COD',()=>{
 it('rejects rounded, negative and unsafe money',()=>{
  for(const v of ['1.001','-1','NaN','Infinity','','1e3','100000000000000']) expect(()=>deliveryMoney(v)).toThrow();
  expect(deliveryMoney('123.45')).toBe(12345);
 });
 it('creates once concurrently, rejects conflicting retries and meters once',async()=>{
  const s=await setup();
  const results=await Promise.all([s.run(s.t.ctx,c=>createParcel(c,s.t.ctx,s.input)),s.run(s.t.ctx,c=>createParcel(c,s.t.ctx,s.input))]);
  expect(results.every(p=>p.id===s.p.id && p.duplicate)).toBe(true);
  await expect(s.run(s.t.ctx,c=>createParcel(c,s.t.ctx,{...s.input,address:'different'}))).rejects.toThrow(/reference/);
  expect((await db.query<any>(`SELECT count(*)::int n FROM usage_events WHERE tenant_id=$1 AND key='delivery_parcels_per_month'`,[s.t.tenantId])).rows[0].n).toBe(1);
 });
 it('requires POD, retries failed attempts and preserves replay-safe evidence',async()=>{
  const s=await setup();await s.run(s.t.ctx,c=>dispatchParcel(c,s.t.ctx,s.p.id,s.driver,'DXB-1'));
  await expect(s.run(s.courier,c=>recordAttempt(c,s.courier,s.p.id,{outcome:'delivered',collected:'100',client_ref:'no-pod'}))).rejects.toThrow(/proof/);
  const fail={outcome:'failed',reason:'Recipient absent',collected:'0',client_ref:`fail-${n}`};
  await s.run(s.courier,c=>recordAttempt(c,s.courier,s.p.id,fail));
  await s.run(s.t.ctx,c=>dispatchParcel(c,s.t.ctx,s.p.id,s.driver,'DXB-2'));
  const ok={outcome:'delivered',pod_name:'Amira',collected:'100',client_ref:`ok-${n}`};
  await s.run(s.courier,c=>recordAttempt(c,s.courier,s.p.id,ok));
  expect((await s.run(s.courier,c=>recordAttempt(c,s.courier,s.p.id,ok))).duplicate).toBe(true);
  await expect(s.run(s.courier,c=>recordAttempt(c,s.courier,s.p.id,{...ok,collected:'90'}))).rejects.toThrow(/reference/);
  await expect(s.run(s.courier,c=>recordAttempt(c,s.courier,s.p.id,{...ok,client_ref:'new-success'}))).rejects.toThrow(/current state/);
  await expect(db.query(`UPDATE delivery_attempts SET cod_collected_minor=0 WHERE parcel_id=$1`,[s.p.id])).rejects.toThrow(/immutable/);
 });
 it('flags COD collection/handover mismatch and needs an independent finance decision before bounded remittance',async()=>{
  const s=await setup();await s.run(s.t.ctx,c=>dispatchParcel(c,s.t.ctx,s.p.id,s.driver,'DXB'));
  await s.run(s.courier,c=>recordAttempt(c,s.courier,s.p.id,{outcome:'delivered',pod_name:'Customer',collected:'90',client_ref:`mismatch-${n}`}));
  await expect(s.run(s.finance,c=>remitCod(c,s.finance,s.p.id,'80','before-review'))).rejects.toThrow(/reconciliation/);
  await s.run(s.finance,c=>receiveCash(c,s.finance,s.p.id,'80',`cash-${n}`));
  await expect(s.run(s.finance,c=>reconcileCod(c,s.finance,s.p.id,'Accept variance'))).rejects.toThrow(/different finance/);
  await s.run(s.approver,c=>reconcileCod(c,s.approver,s.p.id,'Merchant notified: AED 10 collection shortage; AED 10 courier shortage under investigation.'));
  await expect(s.run(s.approver,c=>remitCod(c,s.approver,s.p.id,'81',`too-much-${n}`))).rejects.toThrow(/exceeds/);
  const ref=`bank-${n}`;
  await Promise.all([s.run(s.finance,c=>remitCod(c,s.finance,s.p.id,'80',ref)),s.run(s.finance,c=>remitCod(c,s.finance,s.p.id,'80',ref))]);
  await expect(s.run(s.finance,c=>remitCod(c,s.finance,s.p.id,'0.01','overpay'))).rejects.toThrow(/exceeds/);
  const d=await s.run(s.finance,c=>getParcel(c,s.p.id));expect(d.remittances).toHaveLength(1);expect(Number(d.decision.expected_minor)).toBe(10000);expect(Number(d.decision.collected_minor)).toBe(9000);expect(Number(d.decision.received_minor)).toBe(8000);
 });
 it('invoices only the service fee, retries once and releases it on authorised void',async()=>{
  const s=await setup();await s.run(s.t.ctx,c=>dispatchParcel(c,s.t.ctx,s.p.id,s.driver,'DXB'));
  await s.run(s.courier,c=>recordAttempt(c,s.courier,s.p.id,{outcome:'delivered',pod_name:'Customer',collected:'100',client_ref:`invoice-${n}`}));
  const i=await s.run(s.finance,c=>invoiceParcel(c,s.finance,s.p.id));
  expect((await s.run(s.finance,c=>invoiceParcel(c,s.finance,s.p.id))).id).toBe(i.id);
  expect(Number((await s.run(s.finance,c=>getInvoice(c,i.id))).inv.subtotal_minor)).toBe(1500);
  await s.run(s.t.ctx,c=>voidInvoice(c,s.t.ctx,i.id,'Wrong service fee invoice'));
  expect((await s.run(s.finance,c=>invoiceParcel(c,s.finance,s.p.id))).id).not.toBe(i.id);
  const exported=await s.run(s.t.ctx,c=>exportTenantData(c,s.t.ctx));expect(JSON.stringify(exported)).toContain(s.p.id);
 });
 it('enforces sector, quota, subscription, support and role gates; prevents cross-tenant foreign keys',async()=>{
  const s=await setup(),other=await newTenant(db);
  await expect(db.tenant(other.tenantId,c=>createParcel(c,other.ctx,s.input))).rejects.toThrow(/not selected/);
  await expect(s.run(s.courier,c=>createParcel(c,s.courier,s.input))).rejects.toThrow(/role/);
  await expect(s.run(s.t.ctx,c=>createParcel(c,{...s.t.ctx,readOnly:true},s.input))).rejects.toThrow(/read-only/);
  expect(await db.tenant(other.tenantId,c=>listParcels(c))).toHaveLength(0);
  const foreignParty=await db.tenant(other.tenantId,c=>createParty(c,other.ctx,{name:"Foreign",kind:"customer"}));
  await expect(db.query(`UPDATE delivery_parcels SET party_id=$1 WHERE id=$2`,[foreignParty,s.p.id])).rejects.toThrow(/foreign key/);
  await db.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source,effective_from) VALUES ($1,'delivery_parcels_per_month',1,'test',now()-interval '1 second')`,[s.t.tenantId]);
  await expect(s.run(s.t.ctx,c=>createParcel(c,s.t.ctx,{...s.input,external_ref:'overquota'}))).rejects.toThrow(/allowance|limit/);
  await db.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`,[s.t.tenantId]);
  await expect(s.run(s.t.ctx,c=>dispatchParcel(c,s.t.ctx,s.p.id,s.driver,'DXB'))).rejects.toThrow(/read-only/);
 });
 it('HTTP fences couriers to their own parcels, checks CSRF and exposes the working staff pages',async()=>{
  const s=await setup(),other=await setup(),app=buildApp(db);
  await s.run(s.t.ctx,c=>dispatchParcel(c,s.t.ctx,s.p.id,s.driver,'DXB'));
  const session=await newSession(db,s.courier.userId,s.t.tenantId);
  // Cookie name is taken from the public middleware contract.
  const { SESSION_COOKIE }=await import('../src/web/mw.js');
  const headers={cookie:`${SESSION_COOKIE}=${session.token}`};
  expect((await app.request(`/app/driver/deliveries/${s.p.id}`,{headers})).status).toBe(200);
  expect((await app.request(`/app/driver/deliveries/${other.p.id}`,{headers})).status).toBe(404);
  expect((await app.request(`/app/driver/deliveries/${s.p.id}/attempt`,{method:'POST',headers,body:new URLSearchParams({outcome:'delivered'})})).status).toBe(403);
  expect((await app.request('/app/driver/deliveries/not-an-id',{headers})).status).toBe(400);
  const owner=await newSession(db,s.t.userId,s.t.tenantId);
  for(const path of ['/app/delivery','/app/delivery/new','/app/delivery/couriers',`/app/delivery/parcels/${s.p.id}`]) expect((await app.request(path,{headers:{cookie:`${SESSION_COOKIE}=${owner.token}`}})).status,path).toBe(200);
 });
 it('passes database-wide invariants after delivery, mismatches, remittances and invoice reversals',async()=>{expect(await verifyInvariants(db)).toEqual([]);});
});
