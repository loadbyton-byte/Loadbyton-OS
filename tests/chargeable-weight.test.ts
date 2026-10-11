import {beforeAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Db,Conn} from '../src/db/client.js';
import {freshDb,newTenant,ctxFor,future} from './helpers.js';
import {createEnquiry} from '../src/ops/crm.js';
import {uploadDocument} from '../src/ops/documents.js';
import {calculateChargeable,createWeightRule,assessEnquiryWeight,weightWorkspace} from '../src/ops/chargeable-weight.js';
import {exportTenantData} from '../src/ops/exporter.js';
import {buildApp} from '../src/app.js';
import {newSession} from '../src/platform/auth.js';
import {SESSION_COOKIE} from '../src/web/mw.js';
let db:Db;beforeAll(async()=>{db=await freshDb();});
async function setup(mode='air'){
 const t=await newTenant(db),run=<T>(fn:(c:Conn)=>Promise<T>)=>db.tenant(t.tenantId,fn);
 const doc=await run(c=>uploadDocument(c,t.ctx,{kind:'other',title:'Issued provider weight tariff',issuer:'Provider tariff officer',filename:'tariff.pdf',data:Buffer.from('%PDF-1.4\nreviewed fixture\n%%EOF')}));
 const enquiry=await run(c=>createEnquiry(c,t.ctx,{mode,origin:'Dubai',destination:'Mumbai',cargo_desc:'Dry cargo',weight_kg:100,volume_cbm:1}));
 const rule={provider:'Fixture airline tariff',mode,formula:mode==='ocean'?'weight_measure':'volumetric_kg',coefficient:mode==='ocean'?1000:6000,increment:0.5,minimum:0,valid_from:new Date().toISOString().slice(0,10),valid_until:future(),document_id:doc,reviewer:'Tariff specialist',scope:'General cargo only, reviewed Dubai–Mumbai service; exclude dangerous goods'};
 return {t,run,doc,enquiry,rule};
}
it('uses explicit air/road divisors and ocean weight/measure with provider rounding and minima',()=>{
 const air={mode:'air',formula:'volumetric_kg',coefficient:6000,increment:0.5,minimum:0};
 expect(calculateChargeable(air,100,1).chargeable).toBe(167);expect(calculateChargeable(air,250,1).chargeable).toBe(250);
 expect(calculateChargeable({...air,mode:'road',coefficient:5000},100,1).chargeable).toBe(200);
 expect(calculateChargeable({...air,coefficient:5000,increment:0.1},0.3,0.0015).chargeable).toBe(0.3);
 expect(calculateChargeable({...air,coefficient:5000,increment:0.1},0.300001,0.0015).chargeable).toBe(0.4);
 const sea={mode:'ocean',formula:'weight_measure',coefficient:1000,increment:0.1,minimum:1};
 expect(calculateChargeable(sea,1600,1.2)).toMatchObject({chargeable:1.6,unit:'revenue_tonne'});expect(calculateChargeable(sea,100,0.2).chargeable).toBe(1);
 for(const value of [NaN,Infinity,-1,0])expect(()=>calculateChargeable(air,value,1)).toThrow();
 expect(()=>calculateChargeable({...air,mode:'ocean'},100,1)).toThrow(/ocean/);expect(()=>calculateChargeable({...sea,mode:'air'},100,1)).toThrow(/ocean/);
});
it('requires issued current provider evidence and approval permission, preserving immutable rules and assessment provenance',async()=>{
 const {t,run,doc,enquiry,rule}=await setup();
 await expect(run(c=>createWeightRule(c,ctxFor(t.userId,t.tenantId,['sales']),rule))).rejects.toThrow(/role/);
 await expect(run(c=>createWeightRule(c,t.ctx,{...rule,increment:0.1234567}))).rejects.toThrow(/six decimal/);
 const id=await run(c=>createWeightRule(c,t.ctx,rule)),ref=randomUUID();
 await expect(run(c=>assessEnquiryWeight(c,t.ctx,enquiry.id,id,randomUUID()))).rejects.toThrow(/Confirm/);
 const calculation=await run(c=>assessEnquiryWeight(c,t.ctx,enquiry.id,id,ref,true));expect(await run(c=>assessEnquiryWeight(c,t.ctx,enquiry.id,id,ref,true))).toBe(calculation);
 const row=(await run(c=>c.query<any>(`SELECT * FROM weight_assessments WHERE id=$1`,[calculation]))).rows[0];
 expect(Number(row.chargeable)).toBe(167);expect(row.explanation).toMatchObject({source_document_id:doc,provider:rule.provider,reviewer:rule.reviewer,scope:rule.scope,coefficient:6000});
 await expect(db.query(`UPDATE weight_rules SET coefficient=5000 WHERE id=$1`,[id])).rejects.toThrow(/immutable/);await expect(db.query(`DELETE FROM weight_assessments WHERE id=$1`,[calculation])).rejects.toThrow(/immutable/);
 const exported=await run(c=>exportTenantData(c,t.ctx));expect((exported.weight_assessments as any[]).length).toBe(1);
});
it('rejects held/draft evidence, mismatched modes, incomplete cargo and expired rules',async()=>{
 const {t,run,doc,enquiry,rule}=await setup();
 await db.query(`UPDATE documents SET status='draft' WHERE id=$1`,[doc]);await expect(run(c=>createWeightRule(c,t.ctx,rule))).rejects.toThrow(/not found/);await db.query(`UPDATE documents SET status='issued' WHERE id=$1`,[doc]);
 const id=await run(c=>createWeightRule(c,t.ctx,rule));await db.query(`UPDATE documents SET hold=true WHERE id=$1`,[doc]);await expect(run(c=>assessEnquiryWeight(c,t.ctx,enquiry.id,id,randomUUID(),true))).rejects.toThrow(/not found/);await db.query(`UPDATE documents SET hold=false WHERE id=$1`,[doc]);
 const road=await run(c=>createEnquiry(c,t.ctx,{mode:'road',weight_kg:10,volume_cbm:1}));await expect(run(c=>assessEnquiryWeight(c,t.ctx,road.id,id,randomUUID(),true))).rejects.toThrow(/mode/);
 const missing=await run(c=>createEnquiry(c,t.ctx,{mode:'air',weight_kg:10}));await expect(run(c=>assessEnquiryWeight(c,t.ctx,missing.id,id,randomUUID(),true))).rejects.toThrow(/positive/);
 await expect(run(c=>createWeightRule(c,t.ctx,{...rule,valid_until:'2000-01-01',valid_from:'1999-01-01'}))).rejects.toThrow(/validity/);
 const futureRule=await run(c=>createWeightRule(c,t.ctx,{...rule,valid_from:future(1)}));await expect(run(c=>assessEnquiryWeight(c,t.ctx,enquiry.id,futureRule,randomUUID(),true))).rejects.toThrow(/not found/);
});
it('fences sectors, tenants, restricted and read-only sessions; concurrent retries preserve one assessment',async()=>{
 const {t,run,enquiry,rule}=await setup(),id=await run(c=>createWeightRule(c,t.ctx,rule)),ref=randomUUID();
 const results=await Promise.all([1,2,3].map(()=>run(c=>assessEnquiryWeight(c,t.ctx,enquiry.id,id,ref,true))));expect(new Set(results).size).toBe(1);
 const other=await newTenant(db);await expect(db.tenant(other.tenantId,c=>assessEnquiryWeight(c,other.ctx,enquiry.id,id,randomUUID(),true))).rejects.toThrow(/not found/);
 const road=await newTenant(db,'Road only',['road-transport']);await expect(db.tenant(road.tenantId,c=>weightWorkspace(c,road.ctx))).rejects.toThrow(/not selected/);
 await expect(run(c=>assessEnquiryWeight(c,{...t.ctx,readOnly:true},enquiry.id,id,randomUUID(),true))).rejects.toThrow(/read-only/);
 const next=await run(c=>createWeightRule(c,t.ctx,{...rule,provider:'Another carrier'}));await expect(run(c=>assessEnquiryWeight(c,t.ctx,enquiry.id,next,ref,true))).rejects.toThrow(/different/);
 await db.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`,[t.tenantId]);await expect(run(c=>assessEnquiryWeight(c,t.ctx,enquiry.id,id,randomUUID(),true))).rejects.toThrow(/read-only/);expect((await run(c=>weightWorkspace(c,t.ctx))).assessments).toHaveLength(1);
});
it('renders the source-linked calculation workspace and enforces HTTP sector access',async()=>{
 const {t,run,enquiry,rule}=await setup('ocean'),id=await run(c=>createWeightRule(c,t.ctx,rule));await run(c=>assessEnquiryWeight(c,t.ctx,enquiry.id,id,randomUUID(),true));
 const app=buildApp(db),s=await newSession(db,t.userId,t.tenantId),response=await app.request('/app/freight/weight',{headers:{cookie:`${SESSION_COOKIE}=${s.token}`}});expect(response.status).toBe(200);const html=await response.text();expect(html).toContain('Why this quantity?');expect(html).toContain('revenue tonnes');expect(html).toContain(rule.scope);
 const other=await newTenant(db,'Courier only',['courier-last-mile']),otherSession=await newSession(db,other.userId,other.tenantId);expect((await app.request('/app/freight/weight',{headers:{cookie:`${SESSION_COOKIE}=${otherSession.token}`}})).status).toBe(403);
});
