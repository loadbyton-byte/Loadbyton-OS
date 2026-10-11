import {beforeAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Db,Conn} from '../src/db/client.js';
import {freshDb,newTenant,ctxFor,future} from './helpers.js';
import {createParty} from '../src/ops/crm.js';
import {uploadDocument} from '../src/ops/documents.js';
import {createWarehouse,createLocation,createSku,createInbound,getInbound,receiveLine,startCount,cancelCount,getCount,recordCount,submitCount,decideCountLine,dubaiDay} from '../src/ops/warehouse.js';
import {createCountSchedule,startScheduledCount,disableCountSchedule,countSchedules} from '../src/ops/count-schedules.js';
import {verifyInvariants} from '../src/platform/invariants.js';
import {buildApp} from '../src/app.js';
import {newSession} from '../src/platform/auth.js';
import {SESSION_COOKIE} from '../src/web/mw.js';
import {RuntimeMetrics} from '../src/platform/runtime-metrics.js';
import {collectQueueMetrics} from '../src/platform/health.js';
let db:Db;beforeAll(async()=>{db=await freshDb();});
async function fixture(){
 const t=await newTenant(db,undefined,['contract-warehouse-3pl']),run=<T>(fn:(c:Conn)=>Promise<T>)=>db.tenant(t.tenantId,fn),person=await newTenant(db);
 await db.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES($1,$2,ARRAY['warehouse'])`,[t.tenantId,person.userId]);const counter=ctxFor(person.userId,t.tenantId,['warehouse']);
 const d=await run(async c=>{
  const owner=await createParty(c,t.ctx,{kind:'customer',name:'Fixture goods owner'}),wh=await createWarehouse(c,t.ctx,{code:'JA1',name:'Jebel Ali warehouse'}),loc=await createLocation(c,t.ctx,{warehouse_id:wh,code:'A-01'}),sku=await createSku(c,t.ctx,{owner_id:owner,code:'VALUED-1',description:'Fixture custody goods'});
  const inbound=await createInbound(c,t.ctx,{owner_id:owner,warehouse_id:wh,lines:[{sku_id:sku,qty:6}]}),line=(await getInbound(c,inbound.id)).lines[0];await receiveLine(c,t.ctx,line.id,{qty:6,location_id:loc});
  const doc=await uploadDocument(c,t.ctx,{kind:'other',title:'Reviewed count valuation/risk policy',issuer:'Fixture insurance/warehouse policy reviewer',filename:'policy.pdf',data:Buffer.from('%PDF-1.4 count policy fixture')});return {wh,loc,sku,doc};
 });const f={warehouse_id:d.wh,location_id:d.loc,tier:'high_value',interval_days:7,next_due:dubaiDay(),valid_until:future(60),counter_id:counter.userId,document_id:d.doc,reviewer:'Fixture risk reviewer',scope:'Reviewed declared-value tier and weekly physical count coverage for A-01',reference:randomUUID()};
 return {t,run,counter,f,...d};
}
it('preserves a reviewed schedule and creates one blind count for a due day under concurrent retries',async()=>{
 const {t,run,counter,f}=await fixture(),id=await run(c=>createCountSchedule(c,t.ctx,f));expect(await run(c=>createCountSchedule(c,t.ctx,f))).toBe(id);
 await expect(run(c=>createCountSchedule(c,t.ctx,{...f,interval_days:1}))).rejects.toThrow(/different/);
 const metrics=new RuntimeMetrics();await collectQueueMetrics(db,metrics);expect(metrics.render()).toMatch(/lbt_warehouse_counts_due [1-9]/);
 const counts=await Promise.all([1,2,3].map(()=>run(c=>startScheduledCount(c,counter,id,f.next_due))));expect(new Set(counts.map(x=>x.id)).size).toBe(1);
 const p=(await run(c=>countSchedules(c,t.ctx))).policies[0],date=new Date(`${f.next_due}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+7);expect(new Date(p.next_due).toISOString().slice(0,10)).toBe(date.toISOString().slice(0,10));
 expect((await run(c=>getCount(c,counts[0].id))).count.assigned_to).toBe(counter.userId);
 expect((await run(c=>c.query<any>(`SELECT qty_on_hand FROM wh_stock`))).rows[0].qty_on_hand).toBe('6.000');
 await expect(db.query(`UPDATE wh_count_schedules SET interval_days=1 WHERE id=$1`,[id])).rejects.toThrow(/immutable/);await expect(db.query(`DELETE FROM wh_count_schedule_runs WHERE schedule_id=$1`,[id])).rejects.toThrow(/immutable/);
 expect(await verifyInvariants(db)).toEqual([]);
});
it('requires qualified issued policy evidence, an active operator, matching warehouse scope and approval permission',async()=>{
 const {t,run,counter,doc,f}=await fixture();await expect(run(c=>createCountSchedule(c,counter,f))).rejects.toThrow(/role/);
 await db.query(`UPDATE documents SET status='draft' WHERE id=$1`,[doc]);await expect(run(c=>createCountSchedule(c,t.ctx,f))).rejects.toThrow(/not found/);await db.query(`UPDATE documents SET status='issued' WHERE id=$1`,[doc]);
 await expect(run(c=>createCountSchedule(c,t.ctx,{...f,interval_days:0}))).rejects.toThrow(/interval/);await expect(run(c=>createCountSchedule(c,t.ctx,{...f,valid_until:'2000-01-01'}))).rejects.toThrow(/valid/);
 const wh=await run(c=>createWarehouse(c,t.ctx,{code:'OTHER',name:'Other warehouse'}));await expect(run(c=>createCountSchedule(c,t.ctx,{...f,warehouse_id:wh}))).rejects.toThrow(/not found/);
 const id=await run(c=>createCountSchedule(c,t.ctx,f));await db.query(`UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2`,[t.tenantId,counter.userId]);await expect(run(c=>startScheduledCount(c,t.ctx,id,f.next_due))).rejects.toThrow(/operator/);
 await db.query(`UPDATE memberships SET active=true WHERE tenant_id=$1 AND user_id=$2`,[t.tenantId,counter.userId]);await db.query(`UPDATE documents SET hold=true WHERE id=$1`,[doc]);await expect(run(c=>startScheduledCount(c,t.ctx,id,f.next_due))).rejects.toThrow(/not found/);
});
it('does not overlap a manual count or start early; disabled policies retain prior evidence',async()=>{
 const {t,run,wh,loc,f}=await fixture(),id=await run(c=>createCountSchedule(c,t.ctx,f)),manual=await run(c=>startCount(c,t.ctx,{warehouse_id:wh,location_id:loc}));
 await expect(run(c=>startScheduledCount(c,t.ctx,id,f.next_due))).rejects.toThrow(/already open/);expect((await run(c=>countSchedules(c,t.ctx))).runs).toHaveLength(0);
 await run(c=>cancelCount(c,t.ctx,manual.id));await run(c=>startScheduledCount(c,t.ctx,id,f.next_due));await run(c=>disableCountSchedule(c,t.ctx,id,'Replace reviewed policy after this count'));
 expect((await run(c=>startScheduledCount(c,t.ctx,id,f.next_due))).duplicate).toBe(true);
 await expect(db.query(`UPDATE wh_count_schedules SET active=true WHERE id=$1`,[id])).rejects.toThrow(/immutable/);
 const next=await run(c=>createCountSchedule(c,t.ctx,{...f,reference:randomUUID(),next_due:future(3),tier:'standard',interval_days:30}));await expect(run(c=>startScheduledCount(c,t.ctx,next,future(3)))).rejects.toThrow(/not due/);
});
it('retains independent variance approval after scheduled generation and cannot adjust stock by starting a count',async()=>{
 const {t,run,counter,f}=await fixture(),id=await run(c=>createCountSchedule(c,t.ctx,f)),count=await run(c=>startScheduledCount(c,counter,id,f.next_due)),line=(await run(c=>getCount(c,count.id))).lines[0];
 await run(c=>recordCount(c,counter,line.id,5));await run(c=>submitCount(c,counter,count.id));await expect(run(c=>decideCountLine(c,{...counter,perms:t.ctx.perms},line.id,true))).rejects.toThrow(/different|counted|own/);
 await run(c=>decideCountLine(c,t.ctx,line.id,true));expect(Number((await run(c=>c.query<any>(`SELECT qty_on_hand FROM wh_stock`))).rows[0].qty_on_hand)).toBe(5);expect((await run(c=>getCount(c,count.id))).count.status).toBe('closed');expect(await verifyInvariants(db)).toEqual([]);
});
it('requires a second person even when the counter is the company owner',async()=>{
 const {t,run,f}=await fixture(),person=await newTenant(db);await db.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES($1,$2,ARRAY['finance'])`,[t.tenantId,person.userId]);const approver=ctxFor(person.userId,t.tenantId,['finance']);
 const id=await run(c=>createCountSchedule(c,t.ctx,{...f,counter_id:t.userId})),count=await run(c=>startScheduledCount(c,t.ctx,id,f.next_due)),line=(await run(c=>getCount(c,count.id))).lines[0];
 await run(c=>recordCount(c,t.ctx,line.id,4));await run(c=>submitCount(c,t.ctx,count.id));await expect(run(c=>decideCountLine(c,t.ctx,line.id,true))).rejects.toThrow(/person who counted/);
 expect(Number((await run(c=>c.query<any>(`SELECT qty_on_hand FROM wh_stock`))).rows[0].qty_on_hand)).toBe(6);await run(c=>decideCountLine(c,approver,line.id,true));expect(Number((await run(c=>c.query<any>(`SELECT qty_on_hand FROM wh_stock`))).rows[0].qty_on_hand)).toBe(4);
});
it('fences tenant/sector/restricted sessions and shows source policy and assigned operator without revealing a blind balance',async()=>{
 const {t,run,counter,f}=await fixture(),id=await run(c=>createCountSchedule(c,t.ctx,f)),other=await newTenant(db,undefined,['contract-warehouse-3pl']);await expect(db.tenant(other.tenantId,c=>startScheduledCount(c,other.ctx,id,f.next_due))).rejects.toThrow(/not found/);
 const freight=await newTenant(db);await expect(db.tenant(freight.tenantId,c=>countSchedules(c,freight.ctx))).rejects.toThrow(/not selected/);
 await expect(run(c=>startScheduledCount(c,{...counter,readOnly:true},id,f.next_due))).rejects.toThrow(/read-only/);
 const app=buildApp(db),s=await newSession(db,t.userId,t.tenantId),headers={cookie:`${SESSION_COOKIE}=${s.token}`},page=await app.request('/app/warehouse/count-schedules',{headers});expect(page.status).toBe(200);expect(await page.text()).toContain(f.scope);
 const count=await run(c=>startScheduledCount(c,counter,id,f.next_due)),counterSession=await newSession(db,counter.userId,t.tenantId),sheet=await app.request(`/app/warehouse/counts/${count.id}`,{headers:{cookie:`${SESSION_COOKIE}=${counterSession.token}`}});expect(sheet.status).toBe(200);const html=await sheet.text();expect(html).toContain('Assigned counter');expect(html).not.toContain('<th class="num">System</th>');
 await db.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`,[t.tenantId]);await expect(run(c=>createCountSchedule(c,t.ctx,{...f,reference:randomUUID()}))).rejects.toThrow(/read-only/);
});
it('serializes concurrent manual sheets for the same area alongside schedule-generated sheets',async()=>{
 const {t,run,wh,loc}=await fixture();const attempts=await Promise.allSettled([1,2,3].map(()=>run(c=>startCount(c,t.ctx,{warehouse_id:wh,location_id:loc}))));expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(attempts.filter(x=>x.status==='rejected')).toHaveLength(2);
});
