import {beforeAll,it,expect} from 'vitest';
import type {Db,Conn} from '../src/db/client.js';
import {freshDb,newTenant,ctxFor,future} from './helpers.js';
import {createParty} from '../src/ops/crm.js';
import {uploadDocument} from '../src/ops/documents.js';
import {SPECIALIST_PROFILES} from '../src/ops/specialist-profiles.js';
import {approveSpecialistReview,createSpecialistCase,getSpecialistCase,recordSpecialistEvent,transitionSpecialistCase,invoiceSpecialistCase} from '../src/ops/specialists.js';
import {recordReceipt,voidInvoice} from '../src/ops/finance.js';
import {verifyInvariants} from '../src/platform/invariants.js';
import {buildApp} from '../src/app.js';
import {newSession} from '../src/platform/auth.js';
import {SESSION_COOKIE} from '../src/web/mw.js';
import {exportTenantData} from '../src/ops/exporter.js';
import {createApiKey} from '../src/platform/api.js';
let db:Db;beforeAll(async()=>{db=await freshDb();});
const now=()=>new Date().toISOString();
const inputs:Record<string,Record<string,any>>={
 'consolidation-nvocc':{master_ref:'M1',container_ref:'MSCU1234567',basis:'weight',master_cost_minor:'100'},
 'cold-chain':{sensor_ref:'LOGGER-1',minimum_c:2,maximum_c:8},
 'project-heavy-cargo':{project_ref:'PROJECT-1',equipment:'Crane',budget_minor:'1000'},
 'automotive-logistics':{vin:'1HGCM82633A004352',initial_yard:'Yard A'},
 'marine-agency':{vessel_ref:'IMO-1',port:'Jebel Ali',eta:now(),estimate_minor:'100'},
 'aviation-logistics':{airwaybill:'AWB1',flight:'FL1',agent:'Agent'},
 'moving-relocation':{survey_ref:'SUR1',crew:'Crew A',appointment:now(),storage_location:'Destination'},
 'import-export-trading':{purchase_order:'PO1',sales_order:'SO1',stock_owner:'Trading company'},
 'distribution':{customer_order:'ORDER1',route:'Route A'},
 'container-depot':{container_ref:'MSCU1234567',yard:'Yard A'},
 'dangerous-cargo':{un_number:'UN1203',hazard_class:'3',restrictions:'Reviewed handling instructions'},
 'cross-border-transit':{entry_border:'Entry',exit_border:'Exit',guarantee_minor:'100'}
};
async function setup(s:string,fee='0'){
 const t=await newTenant(db,undefined,[s]);const run=<T>(fn:(c:Conn)=>Promise<T>)=>db.tenant(t.tenantId,fn);
 const party=await run(c=>createParty(c,t.ctx,{kind:'customer',name:'Customer'}));
 const doc=await run(c=>uploadDocument(c,t.ctx,{kind:'other',title:'Reviewed evidence',issuer:'Qualified external reviewer',filename:'evidence.pdf',data:Buffer.from('%PDF-1.4 fixture evidence')}));
 const f={party_id:party,external_ref:'CASE-1',subject_ref:inputs[s].vin??inputs[s].container_ref??'SUBJECT-1',fee,tax_code:'SR5',...inputs[s]};
 await expect(run(c=>createSpecialistCase(c,t.ctx,s,f))).rejects.toThrow(/review/);
 await run(c=>approveSpecialistReview(c,t.ctx,s,'Qualified reviewer',doc,future()));
 const p=await run(c=>createSpecialistCase(c,t.ctx,s,f));let n=0;
 const event=(kind:string,a:Record<string,any>,ref=`event-${++n}`,ctx=t.ctx)=>run(c=>recordSpecialistEvent(c,ctx,p.id,kind,a,'Verified evidence',ref,doc));
 const transition=(status:string)=>run(c=>transitionSpecialistCase(c,t.ctx,p.id,status,'Approved by responsible operator'));
 return {s,t,run,party,doc,f,p,event,transition};
}
for(const s of Object.keys(SPECIALIST_PROFILES))it(`${s}: readiness → operational completion → financial closure`,async()=>{
 const x=await setup(s,s==='consolidation-nvocc'?'20':'0'),{t,run,p,event,transition}=x;
 expect(await run(c=>createSpecialistCase(c,t.ctx,s,x.f))).toEqual(p);
 await expect(transition('ready')).rejects.toThrow(/evidence/);
 for(const kind of [...SPECIALIST_PROFILES[s].readyEvidence,...SPECIALIST_PROFILES[s].completionEvidence])await event('evidence',{evidence_kind:kind});
 if(s==='cold-chain')await event('calibration',{valid_until:future(),reference:'CAL1'});
 if(s==='dangerous-cargo')await event('trained_approval',{reviewer:'Trained reviewer',valid_until:future(),decision:'Approved'});
 if(s==='consolidation-nvocc'){
  await expect(event('house',{house_ref:'BAD',basis_qty:1,allocated_minor:'101',destination_agent:'Agent'})).rejects.toThrow(/exceed/);
  await event('house',{house_ref:'H1',basis_qty:100,allocated_minor:'100',destination_agent:'Agent'});
  await event('settlement',{reference:'AGENT-BANK1',amount_minor:'100'});
 }
 if(s==='cross-border-transit')await event('guarantee',{direction:'received',amount_minor:'100',reference:'G1'});
 await transition('ready');await transition('active');
 switch(s){
  case 'cold-chain':await event('temperature',{celsius:5,observed_at:now()});break;
  case 'project-heavy-cargo':
   await expect(event('stage',{stage:'unloading',decision:'Shortcut'})).rejects.toThrow(/preceding/);
   for(const stage of ['survey','loading','movement','unloading'])await event('stage',{stage,decision:'Approved'});break;
  case 'automotive-logistics':await event('condition',{condition:'good',detail:'No damage'});await event('yard',{location:'Release zone',reference:'YARD1'});break;
  case 'marine-agency':await event('disbursement',{reference:'BANK1',amount_minor:'100'});await expect(event('final_account',{reference:'FINAL1',total_minor:'99'})).rejects.toThrow(/reconcile/);await event('final_account',{reference:'FINAL1',total_minor:'100'});break;
  case 'aviation-logistics':for(const stage of ['booked','departed','arrived','released'])await event('milestone',{stage,observed_at:now(),reference:stage});break;
  case 'moving-relocation':await event('item',{item_ref:'ITEM1',description:'Furniture',qty:2});await expect(event('packed',{item_ref:'ITEM1',qty:3})).rejects.toThrow(/exceed/);await event('packed',{item_ref:'ITEM1',qty:2});break;
  case 'import-export-trading':await expect(event('stock',{sku:'SKU1',direction:'dispatch',qty:1,unit_cost_minor:'10'})).rejects.toThrow(/available/);await event('stock',{sku:'SKU1',direction:'receipt',qty:2,unit_cost_minor:'10'});await event('stock',{sku:'SKU1',direction:'dispatch',qty:2,unit_cost_minor:'10'});break;
  case 'distribution':await event('allocation',{sku:'SKU1',qty:2,source_ref:'STOCK1'});await expect(event('dispatch',{sku:'SKU1',qty:3})).rejects.toThrow(/exceed/);await event('dispatch',{sku:'SKU1',qty:2});break;
  case 'container-depot':await event('gate',{direction:'in',condition:'good',observed_at:now()});await event('repair',{repair_ref:'REPAIR1',state:'opened',amount_minor:'10'});await expect(event('gate',{direction:'out',condition:'good',observed_at:now()})).rejects.toThrow(/repairs/);await event('repair',{repair_ref:'REPAIR1',state:'completed',amount_minor:'10'});await event('gate',{direction:'out',condition:'good',observed_at:now()});break;
  case 'cross-border-transit':await event('leg',{direction:'entry',border:'Entry',official_ref:'ENTRY1'});await event('leg',{direction:'exit',border:'Exit',official_ref:'EXIT1'});await expect(transition('completed')).rejects.toThrow(/guarantee/);await event('guarantee',{direction:'released',amount_minor:'100',reference:'G2'});break;
 }
 await transition('completed');
 if(s==='consolidation-nvocc'){
  await expect(transition('closed')).rejects.toThrow(/Invoice/);const inv=await run(c=>invoiceSpecialistCase(c,t.ctx,p.id));
  expect((await run(c=>invoiceSpecialistCase(c,t.ctx,p.id))).id).toBe(inv.id);
  await run(c=>voidInvoice(c,t.ctx,inv.id,'Wrong invoice'));const replacement=await run(c=>invoiceSpecialistCase(c,t.ctx,p.id));expect(replacement.id).not.toBe(inv.id);
  await expect(transition('closed')).rejects.toThrow(/Collect/);await run(c=>recordReceipt(c,t.ctx,replacement.id,{amount:'21',reference:'BANK2',method:'bank transfer'}));
 }
 await transition('closed');expect((await run(c=>getSpecialistCase(c,p.id))).row.status).toBe('closed');
 const session=await newSession(db,t.userId,t.tenantId),app=buildApp(db),headers={cookie:`${SESSION_COOKIE}=${session.token}`};
 expect((await app.request(`/app/specialists/${s}`,{headers})).status).toBe(200);expect((await app.request(`/app/specialists/${s}/${p.id}`,{headers})).status).toBe(200);
 expect((await run(c=>exportTenantData(c,t.ctx))).specialist_cases).toHaveLength(1);
});
it('excursion release needs another approver; replay, tenant fences, role gates and quota checks preserve evidence',async()=>{
 const x=await setup('cold-chain'),{t,p,event,run,transition}=x;
 await event('evidence',{evidence_kind:'handling_protocol'});await event('calibration',{valid_until:future(),reference:'CAL1'});await transition('ready');await transition('active');
 const reading={celsius:12,observed_at:now()};const id=await event('temperature',reading,'TEMP1');expect(await event('temperature',reading,'TEMP1')).toBe(id);
 await expect(event('temperature',{...reading,celsius:13},'TEMP1')).rejects.toThrow(/different/);
 expect((await run(c=>getSpecialistCase(c,p.id))).row.status).toBe('hold');await expect(transition('active')).rejects.toThrow(/excursion/);
 await expect(event('excursion_resolution',{event_ref:'TEMP1',decision:'Reviewed'},'DECISION1')).rejects.toThrow(/Another/);
 const other=await newTenant(db);await db.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES($1,$2,ARRAY['specialist'])`,[t.tenantId,other.userId]);
 await event('excursion_resolution',{event_ref:'TEMP1',decision:'Qualified disposition'},'DECISION1',ctxFor(other.userId,t.tenantId,['specialist']));await transition('active');
 await expect(run(c=>createSpecialistCase(c,ctxFor(t.userId,t.tenantId,['sales']),x.s,x.f))).rejects.toThrow(/role/);
 await expect(db.tenant(other.tenantId,c=>getSpecialistCase(c,p.id))).rejects.toThrow(/not found/);
 await db.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES($1,'specialist_cases_per_month',1,'test')`,[t.tenantId]);
 await expect(run(c=>createSpecialistCase(c,t.ctx,x.s,{...x.f,external_ref:'CASE-2'}))).rejects.toThrow(/limit/);
 await expect(db.query(`UPDATE specialist_events SET note='changed' WHERE id=$1`,[id])).rejects.toThrow(/immutable/);
 await db.query(`UPDATE documents SET hold=true WHERE id=$1`,[x.doc]);await expect(transition('completed')).rejects.toThrow(/hold/);
});
it('preserves specialist and shared restore invariants',async()=>{expect(await verifyInvariants(db)).toEqual([]);});
it('specialist API enforces bearer scope, domain validation and idempotency',async()=>{
 const x=await setup('distribution'),key=await x.run(c=>createApiKey(c,x.t.ctx,'Specialist integration',['specialists:read','specialists:write'],30)),app=buildApp(db),headers={authorization:`Bearer ${key.token}`,'content-type':'application/json','idempotency-key':'case-two'};
 const body=JSON.stringify({...x.f,external_ref:'CASE-2',tenant_id:'ignored-client-supplied-id'});
 const first=await app.request('/api/v1/specialists/distribution',{method:'POST',headers,body});expect(first.status).toBe(201);const result=await first.json() as any;
 expect((await (await app.request('/api/v1/specialists/distribution',{method:'POST',headers,body})).json() as any).data.id).toBe(result.data.id);
 expect((await app.request('/api/v1/specialists/distribution',{method:'POST',headers,body:JSON.stringify({...x.f,external_ref:'DIFFERENT'})})).status).toBe(409);
 expect((await app.request('/api/v1/specialists/distribution',{headers})).status).toBe(200);
 expect((await app.request('/api/v1/specialists/cold-chain',{headers})).status).toBe(403);
 expect((await app.request('/api/v1/specialists/distribution')).status).toBe(401);
});
