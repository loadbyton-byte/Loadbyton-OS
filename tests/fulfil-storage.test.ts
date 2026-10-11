import {beforeAll,afterEach,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Db,Conn} from '../src/db/client.js';
import {freshDb,newTenant,ctxFor} from './helpers.js';
import {createParty} from '../src/ops/crm.js';
import {uploadDocument} from '../src/ops/documents.js';
import {createSku,createLocation,createInbound,getInbound,receiveInbound} from '../src/ops/fulfilment.js';
import {approveStorageContract,accrueStorageDay,storageWorkspace,setStorageAutomation,processAutomaticStorage} from '../src/ops/fulfil-storage.js';
import {invoiceMerchant,runStorageCharges,setRate} from '../src/ops/fulfil-billing.js';
import {voidInvoice} from '../src/ops/finance.js';
import {verifyInvariants} from '../src/platform/invariants.js';
import {buildApp} from '../src/app.js';
import {newSession} from '../src/platform/auth.js';
import {SESSION_COOKIE} from '../src/web/mw.js';
let db:Db;beforeAll(async()=>{db=await freshDb();});afterEach(async()=>{vi.useRealTimers();if(db)await db.query(`UPDATE fulfil_storage_automation SET enabled=false`);});
const add=(day:string,n:number)=>{const d=new Date(`${day}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const advance=(day:string,n=3)=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(`${add(day,n)}T12:00:00+04:00`));};
async function fixture(){
 const t=await newTenant(db,undefined,['ecommerce-fulfilment']),run=<T>(work:(c:Conn)=>Promise<T>)=>db.tenant(t.tenantId,work),d=await run(async c=>{
  const party=await createParty(c,t.ctx,{kind:'customer',name:'Daily storage fixture merchant'}),a=await createLocation(c,t.ctx,{code:'A-01'}),b=await createLocation(c,t.ctx,{code:'B-01'}),sku=await createSku(c,t.ctx,{party_id:party,code:'SKU1',name:'Fixture inventory'}),doc=await uploadDocument(c,t.ctx,{kind:'other',title:'Agreed closing-location storage terms',issuer:'Fixture merchant signed contract',filename:'contract.pdf',data:Buffer.from('%PDF-1.4 storage contract fixture')});
  for(const [qty,location] of [[6,a],[4,b]] as const){const i=await createInbound(c,t.ctx,{party_id:party,lines:`SKU1, ${qty}`}),line=(await getInbound(c,i.id)).lines[0];await receiveInbound(c,t.ctx,i.id,{line_id:line.id,good:qty,damaged:0,location_id:location,token:randomUUID()});}
  return {party,a,b,sku,doc};
 });const next=new Date();next.setUTCMonth(next.getUTCMonth()+1,1);const first=next.toISOString().slice(0,10),f={party_id:d.party,document_id:d.doc,valid_from:first,valid_until:add(first,27),basis:'closing_occupied_location',currency:'AED',amount:'2.50',tax_code:'ZR0',reference:randomUUID(),reviewer:'Fixture contract reviewer',scope:'Agreed bin/receiving/quarantine occupied locations at Dubai closing midnight; staging excluded; reviewed zero-rated tax treatment'};
 return {t,run,f,...d};
}
it('accrues historical closed-day occupancy rather than the current balance and retries once under concurrency',async()=>{
 const s=await fixture(),id=await s.run(c=>approveStorageContract(c,s.t.ctx,s.f));expect(await s.run(c=>approveStorageContract(c,s.t.ctx,s.f))).toBe(id);
 // Fixture movement occurs exactly at the NEXT day's Dubai midnight, excluded from the first closing snapshot.
 await db.system(async c=>{const ref=randomUUID(),stamp=`${add(s.f.valid_from,1)}T00:00:00+04:00`;for(const [loc,delta,kind]of [[s.b,-4,'transfer_out'],[s.a,4,'transfer_in']]as const){await c.query(`INSERT INTO stock_movements(tenant_id,sku_id,location_id,delta,kind,ref_type,ref_id,created_by,created_at) VALUES($1,$2,$3,$4,$5,'transfer',$6,$7,$8)`,[s.t.tenantId,s.sku,loc,delta,kind,ref,s.t.userId,stamp]);await c.query(`UPDATE stock_levels SET on_hand=on_hand+$3 WHERE sku_id=$1 AND location_id=$2`,[s.sku,loc,delta]);}});
 advance(s.f.valid_from);const runs=await Promise.all([1,2,3].map(()=>s.run(c=>accrueStorageDay(c,s.t.ctx,id,s.f.valid_from))));expect(new Set(runs.map(r=>r.id)).size).toBe(1);expect(runs[0].occupied_locations).toBe(2);expect(new Date(runs[0].cutoff_at).toISOString()).toBe(`${s.f.valid_from}T20:00:00.000Z`);
 const second=await s.run(c=>accrueStorageDay(c,s.t.ctx,id,add(s.f.valid_from,1)));expect(second.occupied_locations).toBe(1);expect((await db.query<any>(`SELECT qty,unit_minor FROM fulfil_charges WHERE tenant_id=$1 ORDER BY qty DESC`,[s.t.tenantId])).rows.map(x=>({qty:x.qty,unit_minor:Number(x.unit_minor)}))).toEqual([{qty:2,unit_minor:250},{qty:1,unit_minor:250}]);expect(await verifyInvariants(db)).toEqual([]);
});
it('requires future month-boundary terms, exact pricing, issued evidence, explicit tax and non-overlapping contract versions',async()=>{
 const s=await fixture();await expect(s.run(c=>approveStorageContract(c,s.t.ctx,{...s.f,valid_from:add(s.f.valid_from,1)}))).rejects.toThrow(/month boundary/);
 for(const patch of [{amount:'1.009'},{amount:'1000001'},{tax_code:''},{currency:'INR'},{basis:'pallet_day'}])await expect(s.run(c=>approveStorageContract(c,s.t.ctx,{...s.f,...patch}))).rejects.toThrow();
 await db.query(`UPDATE documents SET hold=true WHERE id=$1`,[s.doc]);await expect(s.run(c=>approveStorageContract(c,s.t.ctx,s.f))).rejects.toThrow(/not found/);await db.query(`UPDATE documents SET hold=false WHERE id=$1`,[s.doc]);const id=await s.run(c=>approveStorageContract(c,s.t.ctx,s.f));
 await expect(s.run(c=>approveStorageContract(c,s.t.ctx,{...s.f,reference:randomUUID(),amount:'3.00'}))).rejects.toThrow(/already covers/);await expect(s.run(c=>approveStorageContract(c,s.t.ctx,{...s.f,amount:'3.00'}))).rejects.toThrow(/different contract/);
 await expect(db.query(`UPDATE fulfil_storage_contracts SET unit_minor=1 WHERE id=$1`,[id])).rejects.toThrow(/immutable/);await expect(s.run(c=>setRate(c,s.t.ctx,{party_id:s.party,code:'storage_location_day',amount:'1'}))).rejects.toThrow(/reviewed contract/);
});
it('keeps daily and monthly storage mutually exclusive and retains immutable financial evidence through invoice void/reissue',async()=>{
 const s=await fixture(),id=await s.run(c=>approveStorageContract(c,s.t.ctx,s.f));await s.run(c=>setRate(c,s.t.ctx,{party_id:s.party,code:'storage_location_month',amount:'90',tax_code:'ZR0'}));advance(s.f.valid_from);
 expect((await s.run(c=>runStorageCharges(c,s.t.ctx,s.f.valid_from.slice(0,7)))).dailyContracts).toBe(1);const accrual=await s.run(c=>accrueStorageDay(c,s.t.ctx,id,s.f.valid_from));const first=await s.run(c=>invoiceMerchant(c,s.t.ctx,s.party));
 expect(Number((await db.query<any>(`SELECT total_minor FROM invoices WHERE id=$1`,[first.id])).rows[0].total_minor)).toBe(500);await expect(db.query(`UPDATE fulfil_charges SET unit_minor=1 WHERE id=$1`,[accrual.charge_id])).rejects.toThrow(/immutable/);await expect(db.query(`DELETE FROM fulfil_charges WHERE id=$1`,[accrual.charge_id])).rejects.toThrow(/immutable/);
 await s.run(c=>voidInvoice(c,s.t.ctx,first.id,'Fixture controller corrected invoice'));const second=await s.run(c=>invoiceMerchant(c,s.t.ctx,s.party));expect(second.id).not.toBe(first.id);expect((await s.run(c=>accrueStorageDay(c,s.t.ctx,id,s.f.valid_from))).duplicate).toBe(true);expect(await verifyInvariants(db)).toEqual([]);
});
it('records an explicitly free contract without charges, and refuses open/out-of-period or currently held evidence',async()=>{
 const s=await fixture(),id=await s.run(c=>approveStorageContract(c,s.t.ctx,{...s.f,amount:'0'}));await expect(s.run(c=>accrueStorageDay(c,s.t.ctx,id,s.f.valid_from))).rejects.toThrow(/closed Dubai day/);advance(s.f.valid_from);
 await expect(s.run(c=>accrueStorageDay(c,s.t.ctx,id,add(s.f.valid_from,-1)))).rejects.toThrow(/outside/);await db.query(`UPDATE documents SET hold=true WHERE id=$1`,[s.doc]);await expect(s.run(c=>accrueStorageDay(c,s.t.ctx,id,s.f.valid_from))).rejects.toThrow(/issued contract/);await db.query(`UPDATE documents SET hold=false WHERE id=$1`,[s.doc]);
 const d=await s.run(c=>accrueStorageDay(c,s.t.ctx,id,s.f.valid_from));expect(d.occupied_locations).toBe(2);expect(d.charge_id).toBeNull();expect((await db.query(`SELECT id FROM fulfil_charges WHERE tenant_id=$1`,[s.t.tenantId])).rows).toHaveLength(0);await expect(db.query(`DELETE FROM fulfil_storage_days WHERE id=$1`,[d.id])).rejects.toThrow(/immutable/);
});
it('enforces tenant, sector, role and subscription boundaries and retains source-linked read access',async()=>{
 const s=await fixture(),other=await newTenant(db,undefined,['ecommerce-fulfilment']),freight=await newTenant(db),id=await s.run(c=>approveStorageContract(c,s.t.ctx,s.f));
 await expect(s.run(c=>approveStorageContract(c,ctxFor(s.t.userId,s.t.tenantId,['warehouse']),s.f))).rejects.toThrow(/wh.rates/);await expect(db.tenant(freight.tenantId,c=>storageWorkspace(c,freight.ctx))).rejects.toThrow(/not selected/);advance(s.f.valid_from);
 await expect(db.tenant(other.tenantId,c=>accrueStorageDay(c,other.ctx,id,s.f.valid_from))).rejects.toThrow(/not found/);await expect(s.run(c=>accrueStorageDay(c,{...s.t.ctx,readOnly:true},id,s.f.valid_from))).rejects.toThrow(/read-only/);
 await db.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`,[s.t.tenantId]);await expect(s.run(c=>accrueStorageDay(c,s.t.ctx,id,s.f.valid_from))).rejects.toThrow(/read-only/);
 const app=buildApp(db),session=await newSession(db,s.t.userId,s.t.tenantId),response=await app.request('/app/fulfilment/daily-storage',{headers:{cookie:`${SESSION_COOKIE}=${session.token}`}});expect(response.status).toBe(200);expect(await response.text()).toContain(`/app/documents/${s.doc}/download`);
});
it('refuses currency changes that would relabel AED charges as another currency',async()=>{
 const s=await fixture(),id=await s.run(c=>approveStorageContract(c,s.t.ctx,s.f));advance(s.f.valid_from);await s.run(c=>accrueStorageDay(c,s.t.ctx,id,s.f.valid_from));await db.query(`UPDATE entities SET currency='INR' WHERE tenant_id=$1`,[s.t.tenantId]);await expect(s.run(c=>invoiceMerchant(c,s.t.ctx,s.party))).rejects.toThrow(/agreed AED billing entity/);await expect(s.run(c=>accrueStorageDay(c,s.t.ctx,id,add(s.f.valid_from,1)))).rejects.toThrow(/AED entity/);
});
it('runs bounded automatic closed-day accrual with a system audit actor, catches gaps and never issues an invoice',async()=>{
 const s=await fixture(),id=await s.run(c=>approveStorageContract(c,s.t.ctx,s.f));await s.run(c=>setStorageAutomation(c,s.t.ctx,id,true,'Fixture finance approves daily accrual under these signed terms'));advance(s.f.valid_from);
 let ready=0,release!:()=>void;const allSelected=new Promise<void>(resolve=>{release=resolve;});
 const simultaneous:Db={...db,query:async(sql,params)=>{const rows=await db.query(sql,params);if(sql.startsWith('SELECT p.id,p.tenant_id,due.day')){if(++ready===3)release();await allSelected;}return rows;}};
 const runs=await Promise.all([1,2,3].map(()=>processAutomaticStorage(simultaneous,1)));expect(runs.reduce((n,r)=>n+r.created,0)).toBe(1);
 const first=(await db.query<any>(`SELECT * FROM fulfil_storage_days WHERE contract_id=$1`,[id])).rows[0];expect(first.created_by).toBeNull();expect(new Date(first.day).toISOString().slice(0,10)).toBe(s.f.valid_from);expect((await db.query(`SELECT id FROM invoices WHERE tenant_id=$1`,[s.t.tenantId])).rows).toHaveLength(0);
 expect((await db.query<any>(`SELECT actor_kind,actor_user_id FROM audit_log WHERE entity_id=$1 AND action='fulfil.storage_day_accrued'`,[first.id])).rows[0]).toEqual({actor_kind:'system',actor_user_id:null});
 // A manual later day leaves a gap; the worker fills the earliest missing day instead of skipping it.
 await s.run(c=>accrueStorageDay(c,s.t.ctx,id,add(s.f.valid_from,2)));expect((await processAutomaticStorage(db,1)).created).toBe(1);expect((await processAutomaticStorage(db,1)).created).toBe(0);expect((await db.query(`SELECT id FROM fulfil_storage_days WHERE contract_id=$1`,[id])).rows).toHaveLength(3);
 await expect(processAutomaticStorage(db,101)).rejects.toThrow(/batch size/);expect(await verifyInvariants(db)).toEqual([]);
});
it('pauses automatic work when consent, current finance authority, subscription, tenant or source is unavailable',async()=>{
 const s=await fixture(),id=await s.run(c=>approveStorageContract(c,s.t.ctx,s.f));advance(s.f.valid_from);expect((await processAutomaticStorage(db)).created).toBe(0);
 await expect(s.run(c=>setStorageAutomation(c,ctxFor(s.t.userId,s.t.tenantId,['warehouse']),id,true,'unauthorized'))).rejects.toThrow(/wh.rates/);await expect(s.run(c=>setStorageAutomation(c,s.t.ctx,id,true,''))).rejects.toThrow(/evidence/);
 await s.run(c=>setStorageAutomation(c,s.t.ctx,id,true,'Fixture approved unattended accrual only, never invoicing'));
 await db.query(`UPDATE documents SET hold=true WHERE id=$1`,[s.doc]);expect((await processAutomaticStorage(db)).created).toBe(0);await db.query(`UPDATE documents SET hold=false WHERE id=$1`,[s.doc]);
 await db.query(`UPDATE memberships SET roles=ARRAY['auditor'] WHERE tenant_id=$1 AND user_id=$2`,[s.t.tenantId,s.t.userId]);expect((await processAutomaticStorage(db)).created).toBe(0);await db.query(`UPDATE memberships SET roles=ARRAY['owner'] WHERE tenant_id=$1 AND user_id=$2`,[s.t.tenantId,s.t.userId]);
 await db.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`,[s.t.tenantId]);expect((await processAutomaticStorage(db)).created).toBe(0);await db.query(`UPDATE subscriptions SET status='active' WHERE tenant_id=$1`,[s.t.tenantId]);
 await db.query(`UPDATE tenants SET status='suspended' WHERE id=$1`,[s.t.tenantId]);expect((await processAutomaticStorage(db)).created).toBe(0);await db.query(`UPDATE tenants SET status='active' WHERE id=$1`,[s.t.tenantId]);
 await s.run(c=>setStorageAutomation(c,s.t.ctx,id,false,'Fixture contract control paused'));expect((await processAutomaticStorage(db)).created).toBe(0);await s.run(c=>setStorageAutomation(c,s.t.ctx,id,true,'Fixture finance reapproves catch-up'));expect((await processAutomaticStorage(db)).created).toBe(1);await s.run(c=>setStorageAutomation(c,s.t.ctx,id,false,'Stop fixture automation after acceptance'));
});
