import type {Conn} from '../db/client.js';
import {actorOf,require,type Ctx} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,forbidden,HttpError,TAX_CODES,sha256} from '../lib/util.js';
import {assertWritable,consumeQuota} from '../platform/entitlements.js';
import {SPECIALIST_PROFILES,parseFields} from './specialist-profiles.js';
import {must,nextNumber,recordId,reqStr,today} from './common.js';
import {deliveryMoney} from './delivery.js';
import {issueInvoice} from './finance.js';

export const specialistProfile=(sector:string)=>{const p=SPECIALIST_PROFILES[sector];if(!p)throw badRequest('Unknown specialist profile');return p;};
async function gate(c:Conn,ctx:Ctx,sector:string) {
 require(ctx,'specialist.write');await assertWritable(c,ctx.tenantId);specialistProfile(sector);
 if(!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector=$1`,[sector])).rows.length)throw forbidden('This specialist sector is not selected');
 await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:specialist:${sector}`]);
}
const caseRow=(c:Conn,id:string)=>must(c.query<any>(`SELECT * FROM specialist_cases WHERE id=$1 FOR UPDATE`,[recordId(id)]),'Specialist case');
const events=async(c:Conn,id:string)=>(await c.query<any>(`SELECT * FROM specialist_events WHERE case_id=$1 ORDER BY created_at,id`,[id])).rows;
const total=(items:any[],field:string)=>items.reduce((sum,x)=>sum+Number(x.attributes[field]??0),0);
function quantity(n:unknown) {if(!Number.isSafeInteger(n)||Number(n)<=0)throw badRequest('Quantity must be a positive whole number');return Number(n);}
function parsed(fields:Parameters<typeof parseFields>[0],input:Record<string,any>) {
 try{return parseFields(fields,input);}catch(e){if(e instanceof HttpError)throw e;throw badRequest('Complete the profile fields with valid numbers, dates and references');}
}
async function issuedDocument(c:Conn,id:string) {
 const d=await must(c.query<any>(`SELECT id,status,hold FROM documents WHERE id=$1`,[recordId(id,'Document')]),'Document');
 if(d.status!=='issued'||d.hold)throw badRequest('Use issued evidence that is not on hold');return d.id;
}
export async function approveSpecialistReview(c:Conn,ctx:Ctx,sector:string,reviewer:string,documentId:string,validUntil:string) {
 require(ctx,'settings.manage');specialistProfile(sector);
 const valid=/^\d{4}-\d{2}-\d{2}$/.test(validUntil)&&validUntil>=today();if(!valid)throw badRequest('Choose a current review validity date');
 const document=await issuedDocument(c,documentId);
 await c.query(`INSERT INTO specialist_reviews(tenant_id,sector,reviewer,document_id,valid_until,approved_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,sector) DO UPDATE SET reviewer=$3,document_id=$4,valid_until=$5,approved_by=$6,approved_at=now()`,[ctx.tenantId,sector,reqStr(reviewer,'Subject-matter reviewer',200),document,validUntil,ctx.userId]);
 await audit(c,ctx.tenantId,actorOf(ctx),'specialist.review_recorded','sector',sector,{reviewer,documentId:document,validUntil});
}
export async function createSpecialistCase(c:Conn,ctx:Ctx,sector:string,f:Record<string,any>) {
 await gate(c,ctx,sector);const profile=specialistProfile(sector);
 if(!(await c.query(`SELECT 1 FROM specialist_reviews r JOIN documents d ON d.id=r.document_id WHERE r.sector=$1 AND r.valid_until>=current_date AND d.status='issued' AND NOT d.hold`,[sector])).rows.length)throw badRequest('Record a current subject-matter readiness review before creating cases');
 const party=recordId(f.party_id,'Customer');await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`,[party]),'Customer');
 const entity=await must(c.query<any>(`SELECT id,currency FROM entities ORDER BY created_at LIMIT 1`),'Entity');if(entity.currency!=='AED')throw badRequest('These manual specialist pilots currently use AED');
 const attributes=parsed(profile.fields,f),ref=reqStr(f.external_ref,'Customer reference',100),subject=reqStr(f.subject_ref,'Equipment / case subject',100),fee=deliveryMoney(f.fee??0),tax=String(f.tax_code??'SR5');
 if(!TAX_CODES[tax])throw badRequest('Choose a valid per-transaction tax code');
 if(sector==='cold-chain'&&(attributes.minimum_c>=attributes.maximum_c||attributes.minimum_c< -100||attributes.maximum_c>100))throw badRequest('Choose a valid minimum/maximum operating range');
 if(sector==='automotive-logistics'&&(!/^[A-HJ-NPR-Z0-9]{17}$/.test(attributes.vin)||subject!==attributes.vin))throw badRequest('Use the same valid 17-character VIN as the subject reference');
 if(sector==='container-depot'&&(!/^[A-Z]{4}\d{7}$/.test(attributes.container_ref)||subject!==attributes.container_ref))throw badRequest('Use the same four-letter/seven-digit container identifier as the subject');
 if(sector==='dangerous-cargo'&&(!/^UN\d{4}$/.test(attributes.un_number)||!/^([1-9])(\.[1-6])?$/.test(attributes.hazard_class)))throw badRequest('Enter UN followed by four digits and a valid hazard-class reference');
 const old=(await c.query<any>(`SELECT * FROM specialist_cases WHERE sector=$1 AND party_id=$2 AND external_ref=$3`,[sector,party,ref])).rows[0];
 if(old){if(old.subject_ref!==subject||Number(old.fee_minor)!==fee||old.tax_code!==tax||JSON.stringify(old.attributes)!==JSON.stringify(attributes)) {
   // jsonb normalizes key order; compare hashes on a stable key order.
   const stable=(v:any)=>JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))));
   if(old.subject_ref!==subject||Number(old.fee_minor)!==fee||old.tax_code!==tax||stable(old.attributes)!==stable(attributes))throw new HttpError(409,'Customer reference was used for different case details');
  }return {id:old.id,no:old.no};}
 if(['automotive-logistics','container-depot'].includes(sector)&&(await c.query(`SELECT 1 FROM specialist_cases WHERE sector=$1 AND subject_ref=$2 AND status NOT IN ('closed','cancelled')`,[sector,subject])).rows.length)throw new HttpError(409,'This asset already has an open custody case');
 const no=await nextNumber(c,ctx.tenantId,'specialist_case','SPC');
 const id=(await c.query<any>(`INSERT INTO specialist_cases(tenant_id,entity_id,party_id,sector,no,external_ref,subject_ref,attributes,fee_minor,tax_code,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[ctx.tenantId,entity.id,party,sector,no,ref,subject,JSON.stringify(attributes),fee,tax,ctx.userId])).rows[0].id;
 await consumeQuota(c,ctx.tenantId,'specialist_cases_per_month',`specialist:${id}`);
 await audit(c,ctx.tenantId,actorOf(ctx),'specialist.created','specialist_case',id,{sector,no});return {id,no};
}
export async function recordSpecialistEvent(c:Conn,ctx:Ctx,id:string,kind:string,f:Record<string,any>,note:string,clientRef:string,documentId?:string) {
 const row=await caseRow(c,id);await gate(c,ctx,row.sector);
 const spec=specialistProfile(row.sector).events[kind];if(!spec)throw badRequest('Unsupported profile event');
 const attributes=parsed(spec.fields,f),ref=reqStr(clientRef,'Client reference',120),why=reqStr(note,'Evidence / explanation',1000);
 const document=documentId?await issuedDocument(c,documentId):null;
 if(spec.evidence&&!document)throw badRequest('Attach issued evidence for this event');if(spec.approval)require(ctx,'specialist.approve');
 const all=await events(c,id),old=all.find(x=>x.client_ref===ref);
 const stable=(v:any)=>JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))));
 if(old){if(old.kind!==kind||old.document_id!==document||stable(old.attributes)!==stable(attributes)||old.note!==why)throw new HttpError(409,'Event reference was used for different evidence');return old.id;}
 if(['completed','closed','cancelled'].includes(row.status))throw badRequest('This case is closed to operational events');
 if(['cost','settlement','disbursement','landed_cost','collection','guarantee'].includes(kind)&&attributes.reference&&all.some(e=>e.kind===kind&&e.attributes.reference===attributes.reference))throw new HttpError(409,'Financial reference already recorded');
 if('amount_minor' in attributes&&attributes.amount_minor<=0)throw badRequest('Financial entries must be above zero');
 let hold=false;
 const selected=(k:string)=>all.filter(e=>e.kind===k);
 if(kind==='cost'&&attributes.actual_minor>attributes.estimated_minor&&row.sector==='project-heavy-cargo')require(ctx,'specialist.approve');
 switch(row.sector) {
  case 'consolidation-nvocc':
   if(kind==='house'){
    if(attributes.basis_qty<=0||attributes.allocated_minor<0)throw badRequest('Use positive allocation units');
    if(selected('house').some(e=>e.attributes.house_ref===attributes.house_ref))throw badRequest('House reference already allocated');
    if(total(selected('house'),'allocated_minor')+attributes.allocated_minor>row.attributes.master_cost_minor)throw badRequest('House allocations exceed the master cost');
   }
   if(kind==='settlement'&&total(selected('settlement'),'amount_minor')+attributes.amount_minor>row.attributes.master_cost_minor)throw badRequest('Agent settlements exceed the master cost');
   break;
  case 'cold-chain':
   if(kind==='calibration'&&attributes.valid_until<today())throw badRequest('Calibration is expired');
   if(kind==='temperature'){
    if(!selected('calibration').some(e=>e.attributes.valid_until>=today()))throw badRequest('Record current calibration evidence before temperature readings');
    if(new Date(attributes.observed_at).getTime()>Date.now()+300000)throw badRequest('Reading time is in the future');
    hold=attributes.celsius<row.attributes.minimum_c||attributes.celsius>row.attributes.maximum_c;
   }
   if(kind==='excursion_resolution') {
    const source=all.find(e=>e.client_ref===attributes.event_ref&&e.kind==='temperature'&&(e.attributes.celsius<row.attributes.minimum_c||e.attributes.celsius>row.attributes.maximum_c));
    if(!source)throw badRequest('Excursion event not found');if(source.recorded_by===ctx.userId)throw forbidden('Another qualified approver must decide the excursion');
    if(selected(kind).some(e=>e.attributes.event_ref===attributes.event_ref))throw badRequest('Excursion already has a disposition');
   }
   break;
  case 'project-heavy-cargo':
   if(kind==='cost'&&total(selected('cost'),'actual_minor')+attributes.actual_minor>row.attributes.budget_minor)throw badRequest('Actual costs exceed the approved project budget; obtain a revised contract');
   if(kind==='stage'){
    const sequence=['survey','loading','movement','unloading'],index=sequence.indexOf(attributes.stage);
    if(index>0&&!selected('stage').some(e=>e.attributes.stage===sequence[index-1]))throw badRequest('Approve the preceding project stage first');
    if(selected('stage').some(e=>e.attributes.stage===attributes.stage))throw badRequest('Stage already approved');
   }
   break;
  case 'automotive-logistics':
   hold=kind==='condition'&&attributes.condition==='damaged';
   if(kind==='damage_resolution'){
    const source=all.find(e=>e.client_ref===attributes.event_ref&&e.kind==='condition'&&e.attributes.condition==='damaged');if(!source)throw badRequest('Damage inspection not found');if(source.recorded_by===ctx.userId)throw forbidden('Another approver must authorize damage disposition');
   }
   break;
  case 'marine-agency':
   if(kind==='final_account'&&attributes.total_minor!==total(selected('disbursement'),'amount_minor'))throw badRequest('Final account must reconcile actual disbursements');
   if(kind==='disbursement'&&selected('final_account').length)throw badRequest('Final account was already recorded; use a reviewed correction outside this pilot');
   break;
  case 'aviation-logistics':
   if(kind==='milestone'){
    const sequence=['booked','departed','arrived','released'],index=sequence.indexOf(attributes.stage);
    if(index>0&&!selected('milestone').some(e=>e.attributes.stage===sequence[index-1]))throw badRequest('Record the preceding air milestone first');
    if(selected('milestone').some(e=>e.attributes.stage===attributes.stage))throw badRequest('Milestone was already recorded');
   }
   break;
  case 'moving-relocation':
   if(kind==='item'){quantity(attributes.qty);if(selected('item').some(e=>e.attributes.item_ref===attributes.item_ref))throw badRequest('Inventory item already exists');}
   if(['packed','claim'].includes(kind)) {
    const item=selected('item').find(e=>e.attributes.item_ref===attributes.item_ref);if(!item)throw badRequest('Inventory item not found');
    if(kind==='packed'&&(quantity(attributes.qty)+total(selected('packed').filter(e=>e.attributes.item_ref===attributes.item_ref),'qty')>item.attributes.qty))throw badRequest('Packed quantity exceeds surveyed inventory');
   }
   if(kind==='claim_resolution'&&!selected('claim').some(e=>e.attributes.claim_ref===attributes.claim_ref))throw badRequest('Claim not found');
   break;
  case 'import-export-trading':
   if(kind==='stock'){
    quantity(attributes.qty);const stock=selected('stock').filter(e=>e.attributes.sku===attributes.sku),received=total(stock.filter(e=>e.attributes.direction==='receipt'),'qty'),dispatched=total(stock.filter(e=>e.attributes.direction==='dispatch'),'qty'),returned=total(stock.filter(e=>e.attributes.direction==='return'),'qty');
    if(attributes.direction==='dispatch'&&attributes.qty>received+returned-dispatched)throw badRequest('Dispatch exceeds available trading stock');
    if(attributes.direction==='return'&&attributes.qty>dispatched-returned)throw badRequest('Return exceeds dispatched quantity');
   }
   break;
  case 'distribution': {
   if(['allocation','dispatch','returned'].includes(kind)) {
    quantity(attributes.qty);const allocated=total(selected('allocation').filter(e=>e.attributes.sku===attributes.sku),'qty'),dispatched=total(selected('dispatch').filter(e=>e.attributes.sku===attributes.sku),'qty'),returned=total(selected('returned').filter(e=>e.attributes.sku===attributes.sku),'qty');
    if(kind==='dispatch'&&attributes.qty>allocated-dispatched)throw badRequest('Dispatch exceeds the evidence-backed allocation');if(kind==='returned'&&attributes.qty>dispatched-returned)throw badRequest('Return exceeds dispatch');
   }break;
  }
  case 'container-depot':
   if(kind==='gate') {
    const prior=selected('gate');if(attributes.direction==='in'&&prior.length)throw badRequest('Container already gated in');
    if(attributes.direction==='out'&&(!prior.some(e=>e.attributes.direction==='in')||prior.some(e=>e.attributes.direction==='out')||row.status!=='active'))throw badRequest('Gate-out requires an active released custody case');
    if(attributes.direction==='out'&&selected('repair').some(e=>e.attributes.state==='opened'&&!selected('repair').some(r=>r.attributes.repair_ref===e.attributes.repair_ref&&r.attributes.state==='completed')))throw badRequest('Complete open repairs before gate-out');
    hold=attributes.condition==='damaged';
   }
   if(kind==='repair_release') {
    const source=all.find(e=>e.client_ref===attributes.event_ref&&e.kind==='gate'&&e.attributes.condition==='damaged');if(!source)throw badRequest('Damage gate event not found');if(source.recorded_by===ctx.userId)throw forbidden('Another approver must authorize damage release');
   }
   if(kind==='repair'&&attributes.state==='completed'&&!selected('repair').some(e=>e.attributes.repair_ref===attributes.repair_ref&&e.attributes.state==='opened'))throw badRequest('Open the repair before recording completion');
   break;
  case 'dangerous-cargo':
   hold=kind==='incident';
   if(kind==='trained_approval'&&attributes.valid_until<today())throw badRequest('Training evidence is expired');
   if(kind==='incident_resolution') {
    const source=selected('incident').find(e=>e.attributes.incident_ref===attributes.incident_ref);if(!source)throw badRequest('Incident not found');if(source.recorded_by===ctx.userId)throw forbidden('Another trained approver must decide the incident');
   }
   break;
  case 'cross-border-transit':
   if(kind==='leg') {
    const expected=attributes.direction==='entry'?row.attributes.entry_border:row.attributes.exit_border;if(attributes.border!==expected)throw badRequest('Border differs from the approved transit route');
    if(attributes.direction==='exit'&&!selected('leg').some(e=>e.attributes.direction==='entry'))throw badRequest('Record transit entry before exit');
    if(selected('leg').some(e=>e.attributes.direction===attributes.direction))throw badRequest('Border leg already recorded');
   }
   if(kind==='guarantee'){
    const balance=selected('guarantee').reduce((n,e)=>n+(e.attributes.direction==='received'?1:-1)*e.attributes.amount_minor,0);
    if(attributes.direction==='received'&&balance+attributes.amount_minor>row.attributes.guarantee_minor)throw badRequest('Guarantee receipts exceed the agreed amount');
    if(attributes.direction==='released'&&(!selected('leg').some(e=>e.attributes.direction==='exit')||!selected('evidence').some(e=>e.attributes.evidence_kind==='transit_closure')||attributes.amount_minor>balance))throw badRequest('Guarantee release requires recorded exit, closure evidence and cannot exceed the held balance');
   }
 }
 const eventId=(await c.query<any>(`INSERT INTO specialist_events(tenant_id,case_id,kind,attributes,note,document_id,client_ref,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[ctx.tenantId,id,kind,JSON.stringify(attributes),why,document,ref,ctx.userId])).rows[0].id;
 if(hold){await c.query(`UPDATE specialist_cases SET status='hold' WHERE id=$1`,[id]);await c.query(`INSERT INTO job_exceptions(tenant_id,title,detail,owner_id,due_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')`,[ctx.tenantId,`Specialist hold ${row.no}`,`Case ${id}, event ${ref}: ${why}`,ctx.userId]);}
 await audit(c,ctx.tenantId,actorOf(ctx),'specialist.event_recorded','specialist_case',id,{kind,eventId,hold});return eventId;
}

export async function transitionSpecialistCase(c:Conn,ctx:Ctx,id:string,next:string,reason:string) {
 const row=await caseRow(c,id);await gate(c,ctx,row.sector);const all=await events(c,id),profile=specialistProfile(row.sector),why=reqStr(reason,'Decision evidence',1000);
 const permitted:Record<string,string[]>={draft:['ready','cancelled'],ready:['active','cancelled'],active:['hold','completed'],hold:['ready','active'],completed:['closed']};
 if(!permitted[row.status]?.includes(next))throw badRequest('Invalid case transition');
 if(next!=='hold'&&next!=='cancelled')require(ctx,'specialist.approve');
 const evidence=all.filter(e=>e.kind==='evidence').map(e=>e.attributes.evidence_kind);
 if(['ready','active','completed'].includes(next)){
  if(profile.readyEvidence.some(k=>!evidence.includes(k)))throw badRequest(`Readiness requires issued evidence: ${profile.readyEvidence.join(', ')}`);
  for(const event of all)if(event.document_id)await issuedDocument(c,event.document_id);
  const review=(await c.query<any>(`SELECT 1 FROM specialist_reviews r JOIN documents d ON d.id=r.document_id WHERE r.sector=$1 AND r.valid_until>=current_date AND d.status='issued' AND NOT d.hold`,[row.sector])).rows.length;if(!review)throw badRequest('Renew the subject-matter review first');
 }
 const has=(kind:string,predicate:(a:any)=>boolean=()=>true)=>all.some(e=>e.kind===kind&&predicate(e.attributes));
 const unresolved=(kind:string,key:string,resolution:string,resolutionKey=key,predicate:(a:any)=>boolean=()=>true)=>all.filter(e=>e.kind===kind&&predicate(e.attributes)&&!all.some(r=>r.kind===resolution&&r.attributes[resolutionKey]===(key==='client_ref'?e.client_ref:e.attributes[key])));
 if(['ready','active','completed'].includes(next)){
  if(row.sector==='cold-chain'&&unresolved('temperature','client_ref','excursion_resolution','event_ref',a=>a.celsius<row.attributes.minimum_c||a.celsius>row.attributes.maximum_c).length)throw badRequest('Decide every temperature excursion before release');
  if(row.sector==='automotive-logistics'&&unresolved('condition','client_ref','damage_resolution','event_ref',a=>a.condition==='damaged').length)throw badRequest('Decide every damage inspection before release');
  if(row.sector==='dangerous-cargo'&&unresolved('incident','incident_ref','incident_resolution').length)throw badRequest('Resolve incidents before releasing regulated cargo');
  if(row.sector==='container-depot'&&unresolved('gate','client_ref','repair_release','event_ref',a=>a.condition==='damaged').length)throw badRequest('Approve damage release before gate-out');
 }
 if(next==='active'||next==='completed'){
  if(row.sector==='cold-chain'&&!has('calibration',a=>a.valid_until>=today()))throw badRequest('Current calibration is required');
  if(row.sector==='dangerous-cargo'&&!has('trained_approval',a=>a.valid_until>=today()))throw badRequest('Current trained-person approval is required');
  if(row.sector==='consolidation-nvocc'&&total(all.filter(e=>e.kind==='house'),'allocated_minor')!==row.attributes.master_cost_minor)throw badRequest('House allocations must reconcile the master cost');
  if(next==='active'&&row.sector==='cross-border-transit'&&all.filter(e=>e.kind==='guarantee').reduce((n,e)=>n+(e.attributes.direction==='received'?1:-1)*e.attributes.amount_minor,0)!==row.attributes.guarantee_minor)throw badRequest('Record the agreed guarantee before activating transit');
 }
 if(next==='completed'){
  if(profile.completionEvidence.some(k=>!evidence.includes(k)))throw badRequest(`Completion requires evidence: ${profile.completionEvidence.join(', ')}`);
  const kinds=all.filter(e=>e.kind!=='evidence');
  if(row.sector==='cold-chain'&&!has('temperature'))throw badRequest('Record actual temperature evidence');
  if(row.sector==='project-heavy-cargo'&&!has('stage',a=>a.stage==='unloading'))throw badRequest('Complete approved project stages');
  if(row.sector==='automotive-logistics'&&(!has('condition')||!has('yard')))throw badRequest('Record condition and custody location');
  if(row.sector==='marine-agency'&&!has('final_account'))throw badRequest('Record a reconciled final disbursement account');
  if(row.sector==='aviation-logistics'&&!has('milestone',a=>a.stage==='released'))throw badRequest('Complete the carrier/agent milestones');
  if(row.sector==='moving-relocation'){
   const items=all.filter(e=>e.kind==='item');if(!items.length||items.some(e=>e.attributes.qty!==total(all.filter(p=>p.kind==='packed'&&p.attributes.item_ref===e.attributes.item_ref),'qty')))throw badRequest('Reconcile packing to the surveyed inventory');
   if(unresolved('claim','claim_ref','claim_resolution').length)throw badRequest('Resolve damage claims');
  }
  if(row.sector==='import-export-trading'){
   if(!has('stock',a=>a.direction==='dispatch'))throw badRequest('Record trade dispatch');
   const stock=all.filter(e=>e.kind==='stock');if(stock.reduce((n,e)=>n+(e.attributes.direction==='dispatch'?-1:1)*e.attributes.qty,0)!==0)throw badRequest('Trading stock remains in custody; transfer or sell it before closing this case');
  }
  if(row.sector==='distribution'){
   if(!has('dispatch'))throw badRequest('Record order dispatch');
   for(const sku of new Set(all.filter(e=>e.kind==='allocation').map(e=>e.attributes.sku)))if(total(all.filter(e=>e.kind==='allocation'&&e.attributes.sku===sku),'qty')!==total(all.filter(e=>e.kind==='dispatch'&&e.attributes.sku===sku),'qty'))throw badRequest('Complete all allocated distribution quantities before closure');
  }
  if(row.sector==='container-depot'){
   if(!has('gate',a=>a.direction==='out'))throw badRequest('Record gate-out');
   if(all.some(e=>e.kind==='repair'&&e.attributes.state==='opened'&&!has('repair',a=>a.repair_ref===e.attributes.repair_ref&&a.state==='completed')))throw badRequest('Complete open repairs');
  }
  if(row.sector==='cross-border-transit') {
   if(!has('leg',a=>a.direction==='exit'))throw badRequest('Record transit exit');
   const balance=all.filter(e=>e.kind==='guarantee').reduce((n,e)=>n+(e.attributes.direction==='received'?1:-1)*e.attributes.amount_minor,0);if(balance!==0)throw badRequest('Reconcile outstanding transit guarantee');
  }
 }
 if(next==='closed'&&row.sector==='consolidation-nvocc'&&total(all.filter(e=>e.kind==='settlement'),'amount_minor')!==row.attributes.master_cost_minor)throw badRequest('Reconcile destination-agent settlements before financial closure');
 if(next==='closed'&&Number(row.fee_minor)>0){if(!row.invoice_id)throw badRequest('Invoice the approved service fee before financial closure');const inv=await must(c.query<any>(`SELECT status FROM invoices WHERE id=$1`,[row.invoice_id]),'Invoice');if(inv.status!=='paid')throw badRequest('Collect the service invoice before financial closure');}
 await c.query(`UPDATE specialist_cases SET status=$2 WHERE id=$1`,[id,next]);
 await c.query(`INSERT INTO specialist_events(tenant_id,case_id,kind,attributes,note,client_ref,recorded_by) VALUES($1,$2,'transition',$3,$4,$5,$6)`,[ctx.tenantId,id,JSON.stringify({from:row.status,to:next}),why,`transition:${all.length}:${next}`,ctx.userId]);
 await audit(c,ctx.tenantId,actorOf(ctx),`specialist.${next}`,'specialist_case',id,{reason:why});
}
export async function invoiceSpecialistCase(c:Conn,ctx:Ctx,id:string) {
 require(ctx,'finance.write');await assertWritable(c,ctx.tenantId);const row=await caseRow(c,id);
 if(!['completed','closed'].includes(row.status)||Number(row.fee_minor)<=0)throw badRequest('Invoice an operationally completed case with a service fee');
 if(row.invoice_id)return {id:row.invoice_id};
 const result=await issueInvoice(c,ctx,{entityId:row.entity_id,partyId:row.party_id,specialistCaseId:id,lines:[{id,description:`${row.no} service fee`,qty:1,unit_minor:row.fee_minor,tax_code:row.tax_code}],markCharge:async(_,invoiceId)=>{await c.query(`UPDATE specialist_cases SET invoice_id=$2 WHERE id=$1`,[id,invoiceId]);}});
 return result;
}
export const listSpecialistCases=async(c:Conn,sector:string,page=1)=>(await c.query<any>(`SELECT s.*,p.name AS customer FROM specialist_cases s JOIN parties p ON p.id=s.party_id WHERE sector=$1 ORDER BY s.created_at DESC,s.id LIMIT 51 OFFSET $2`,[sector,(Math.max(1,page)-1)*50])).rows;
export async function getSpecialistCase(c:Conn,id:string){return {row:await caseRow(c,id),events:await events(c,id)};}
