import {z} from 'zod';
import type {Conn,Db} from '../db/client.js';
import {actorOf,require,type Ctx} from '../lib/perms.js';
import {audit,type Actor} from '../lib/audit.js';
import {badRequest,forbidden,HttpError,TAX_CODES,toMinor} from '../lib/util.js';
import {assertWritable} from '../platform/entitlements.js';
import {must,recordId,reqStr} from './common.js';
import {dubaiDay} from './warehouse.js';
const day=(v:any)=>typeof v==='string'?v.slice(0,10):new Date(v).toISOString().slice(0,10);
const lock=(c:Conn,tenantId:string)=>c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`${tenantId}:stock`]);
async function gate(c:Conn,ctx:Ctx,write=false){require(ctx,write?'wh.rates':'read');if(write)await assertWritable(c,ctx.tenantId);if(!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='ecommerce-fulfilment'`)).rows.length)throw forbidden('E-commerce fulfilment is not selected.');}
export async function approveStorageContract(c:Conn,ctx:Ctx,f:Record<string,unknown>){
 await gate(c,ctx,true);await lock(c,ctx.tenantId);
 const parsed=z.object({valid_from:z.iso.date(),valid_until:z.iso.date(),basis:z.literal('closing_occupied_location'),currency:z.literal('AED')}).safeParse(f);if(!parsed.success)throw badRequest('Choose an explicit AED closing-occupied-location contract and valid dates.');const v=parsed.data;
 if(v.valid_from<=dubaiDay()||!v.valid_from.endsWith('-01')||v.valid_until<v.valid_from)throw badRequest('A new daily contract starts on a future month boundary and must cover its start. Historical terms cannot be invented.');
 const amount=reqStr(f.amount,'Explicit daily AED rate, including zero',30);if(!/^\d{1,7}(\.\d{1,2})?$/.test(amount))throw badRequest('The daily rate must be an exact non-negative AED amount with two decimal places.');const unit=toMinor(amount);if(unit>100000000)throw badRequest('The daily rate is outside the supported range.');
 const tax=String(f.tax_code);if(!TAX_CODES[tax])throw badRequest('Select the reviewed tax code.');const party=recordId(f.party_id,'Merchant'),doc=recordId(f.document_id,'Executed contract evidence'),ref=recordId(f.reference,'Contract reference'),reviewer=reqStr(f.reviewer,'Contract reviewer',200),scope=reqStr(f.scope,'Agreed storage scope, location inclusions, cutoff and tax treatment',2000);
 await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`,[party]),'Merchant');await must(c.query(`SELECT id FROM documents WHERE id=$1 AND status='issued' AND NOT hold`,[doc]),'Issued agreed storage contract');
 const entity=await must(c.query<any>(`SELECT id,currency FROM entities ORDER BY created_at,id LIMIT 1`),'Billing entity');if(entity.currency!=='AED')throw badRequest('This daily storage contract requires an AED billing entity.');
 const old=(await c.query<any>(`SELECT * FROM fulfil_storage_contracts WHERE reference=$1`,[ref])).rows[0];if(old){if(old.party_id!==party||old.entity_id!==entity.id||old.document_id!==doc||day(old.valid_from)!==v.valid_from||day(old.valid_until)!==v.valid_until||Number(old.unit_minor)!==unit||old.tax_code!==tax||old.reviewer!==reviewer||old.scope!==scope)throw new HttpError(409,'The storage reference belongs to different contract terms.');return old.id;}
 if((await c.query(`SELECT 1 FROM fulfil_storage_contracts WHERE party_id=$1 AND valid_from<=$3::date AND valid_until>=$2::date`,[party,v.valid_from,v.valid_until])).rows.length)throw badRequest('An agreed daily storage contract already covers this period. Append non-overlapping future terms.');
 if((await c.query(`SELECT 1 FROM fulfil_charges WHERE party_id=$1 AND code='storage_location_month' AND source_key BETWEEN $2 AND $3`,[party,`storage:${party}:${v.valid_from.slice(0,7)}`,`storage:${party}:${v.valid_until.slice(0,7)}`])).rows.length)throw badRequest('Monthly storage has already been charged for part of this contract period.');
 const id=(await c.query<any>(`INSERT INTO fulfil_storage_contracts(tenant_id,reference,party_id,entity_id,document_id,valid_from,valid_until,basis,unit_minor,currency,tax_code,scope,reviewer,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,[ctx.tenantId,ref,party,entity.id,doc,v.valid_from,v.valid_until,v.basis,unit,v.currency,tax,scope,reviewer,ctx.userId])).rows[0].id;
 await audit(c,ctx.tenantId,actorOf(ctx),'fulfil.storage_contract_approved','fulfil_storage_contract',id,{party_id:party,valid_from:v.valid_from,valid_until:v.valid_until,unit_minor:unit,document_id:doc});return id;
}
/** Accrue a CLOSED Dubai day from immutable movement history, never today's stock cache. Closing
 * occupied-location pricing is one explicit contract basis; pallet/cbm/peak-occupancy pricing is separate. */
export async function accrueStorageDay(c:Conn,ctx:Ctx,contractId:string,forDay:string){
 await gate(c,ctx,true);return accrueStorageCore(c,ctx.tenantId,actorOf(ctx),ctx.userId,contractId,forDay);
}
async function accrueStorageCore(c:Conn,tenantId:string,actor:Actor,userId:string|null,contractId:string,forDay:string){
 await assertWritable(c,tenantId);await lock(c,tenantId);const id=recordId(contractId,'Storage contract');if(!z.iso.date().safeParse(forDay).success||forDay>=dubaiDay())throw badRequest('Only a closed Dubai day can accrue storage.');
 const p=await must(c.query<any>(`SELECT p.*,d.status AS document_status,d.hold,e.currency AS entity_currency FROM fulfil_storage_contracts p JOIN documents d ON d.id=p.document_id JOIN entities e ON e.id=p.entity_id WHERE p.id=$1`,[id]),'Storage contract');
 if(forDay<day(p.valid_from)||forDay>day(p.valid_until))throw badRequest('The day is outside the agreed storage contract.');
 const old=(await c.query<any>(`SELECT * FROM fulfil_storage_days WHERE party_id=$1 AND day=$2`,[p.party_id,forDay])).rows[0];if(old){if(old.contract_id!==id)throw new HttpError(409,'This merchant day was accrued under different contract terms.');return {...old,duplicate:true};}
 if(p.hold||p.document_status!=='issued'||p.entity_currency!=='AED')throw badRequest('Current issued contract evidence and its AED entity are required.');
 if((await c.query(`SELECT 1 FROM fulfil_charges WHERE source_key=$1`,[`storage:${p.party_id}:${forDay.slice(0,7)}`])).rows.length)throw badRequest('Monthly storage was already charged for this merchant and month.');
 const next=new Date(`${forDay}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);const cutoff=`${next.toISOString().slice(0,10)}T00:00:00+04:00`;
 const occupancy=(await c.query<any>(`SELECT m.location_id,m.sku_id,sum(m.delta)::int AS closing_units FROM stock_movements m JOIN skus s ON s.id=m.sku_id JOIN wh_locations l ON l.id=m.location_id WHERE s.party_id=$1 AND m.created_at<$2::timestamptz AND l.kind IN ('bin','receiving','quarantine') GROUP BY m.location_id,m.sku_id HAVING sum(m.delta)>0 ORDER BY m.location_id,m.sku_id`,[p.party_id,cutoff])).rows;
 const quantity=new Set(occupancy.map(x=>x.location_id)).size;let chargeId:string|null=null;
 if(quantity&&Number(p.unit_minor)>0){chargeId=(await c.query<any>(`INSERT INTO fulfil_charges(tenant_id,party_id,entity_id,code,description,qty,unit_minor,tax_code,source_key) VALUES($1,$2,$3,'storage_location_day',$4,$5,$6,$7,$8) RETURNING id`,[tenantId,p.party_id,p.entity_id,`Storage closing occupied locations · Dubai ${forDay} · contract ${p.reference}`,quantity,p.unit_minor,p.tax_code,`storage-day:${p.party_id}:${forDay}`])).rows[0].id;}
 const row=(await c.query<any>(`INSERT INTO fulfil_storage_days(tenant_id,contract_id,party_id,day,cutoff_at,occupied_locations,occupancy,charge_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[tenantId,id,p.party_id,forDay,cutoff,quantity,JSON.stringify(occupancy),chargeId,userId])).rows[0];await audit(c,tenantId,actor,'fulfil.storage_day_accrued','fulfil_storage_day',row.id,{contract_id:id,day:forDay,occupied_locations:quantity,charge_id:chargeId});return {...row,duplicate:false};
}
export async function storageWorkspace(c:Conn,ctx:Ctx,page=1){await gate(c,ctx);return {contracts:(await c.query<any>(`SELECT p.*,a.enabled AS automatic,a.approved_by AS automation_approver,m.active AS automation_authority_active,m.roles AS automation_authority_roles,s.name AS merchant,d.title AS document_title,d.status AS document_status,d.hold FROM fulfil_storage_contracts p LEFT JOIN fulfil_storage_automation a ON a.contract_id=p.id LEFT JOIN memberships m ON m.user_id=a.approved_by JOIN parties s ON s.id=p.party_id JOIN documents d ON d.id=p.document_id ORDER BY p.valid_from DESC,p.id LIMIT 300`)).rows,days:(await c.query<any>(`SELECT a.*,p.unit_minor,p.tax_code,s.name AS merchant,ch.invoice_id FROM fulfil_storage_days a JOIN fulfil_storage_contracts p ON p.id=a.contract_id JOIN parties s ON s.id=a.party_id LEFT JOIN fulfil_charges ch ON ch.id=a.charge_id ORDER BY a.day DESC,a.id LIMIT 51 OFFSET $1`,[(Math.min(100000,Math.max(1,page))-1)*50])).rows,documents:(await c.query<any>(`SELECT id,title FROM documents WHERE status='issued' AND NOT hold ORDER BY created_at DESC LIMIT 300`)).rows,merchants:(await c.query<any>(`SELECT id,name FROM parties WHERE kind='customer' ORDER BY name`)).rows};}

/** A separate, audited control enables/pauses accrual without rewriting the agreed contract. */
export async function setStorageAutomation(c:Conn,ctx:Ctx,contractId:string,enabled:boolean,reason:string){
 await gate(c,ctx,true);await lock(c,ctx.tenantId);const id=recordId(contractId,'Storage contract'),why=reqStr(reason,'Automation approval/pause evidence',1000);
 await must(c.query(`SELECT 1 FROM memberships WHERE user_id=$1 AND active AND roles&&ARRAY['owner','finance']::text[]`,[ctx.userId]),'Current finance authority');
 const p=await must(c.query<any>(`SELECT p.id,d.status,d.hold,e.currency FROM fulfil_storage_contracts p JOIN documents d ON d.id=p.document_id JOIN entities e ON e.id=p.entity_id WHERE p.id=$1`,[id]),'Storage contract');
 if(enabled&&(p.status!=='issued'||p.hold||p.currency!=='AED'))throw badRequest('Current issued terms and the agreed AED entity are required to enable automatic accrual.');
 await c.query(`INSERT INTO fulfil_storage_automation(tenant_id,contract_id,enabled,approved_by,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(contract_id) DO UPDATE SET enabled=$3,approved_by=$4,reason=$5,updated_at=now()`,[ctx.tenantId,id,enabled,ctx.userId,why]);
 await audit(c,ctx.tenantId,actorOf(ctx),enabled?'fulfil.storage_automation_enabled':'fulfil.storage_automation_paused','fulfil_storage_contract',id,{reason:why});
}
/** System worker: one earliest missing closed day per approved contract, at most 25 contracts/tick.
 * Transactions use the same stock lock as manual accrual/pause; duplicates never create a second fee.
 * No invoice, collection or external supplier/customer action is executed. */
export async function processAutomaticStorage(db:Db,limit=25){
 if(!Number.isInteger(limit)||limit<1||limit>100)throw badRequest('Automatic storage batch size is 1–100.');const today=dubaiDay();
 const due=(await db.query<any>(`SELECT p.id,p.tenant_id,due.day FROM fulfil_storage_contracts p
 JOIN fulfil_storage_automation a ON a.contract_id=p.id AND a.enabled
 JOIN memberships m ON m.tenant_id=p.tenant_id AND m.user_id=a.approved_by AND m.active AND m.roles&&ARRAY['owner','finance']::text[]
 JOIN tenants t ON t.id=p.tenant_id AND t.status='active' JOIN subscriptions sub ON sub.tenant_id=p.tenant_id AND sub.status NOT IN ('restricted','cancelled')
 JOIN documents doc ON doc.id=p.document_id AND doc.status='issued' AND NOT doc.hold JOIN entities e ON e.id=p.entity_id AND e.currency='AED'
 JOIN LATERAL(SELECT candidate.day FROM (SELECT p.valid_from AS day UNION SELECT recorded.day+1 FROM fulfil_storage_days recorded WHERE recorded.contract_id=p.id) candidate
 WHERE candidate.day<=least(p.valid_until,$1::date-1) AND NOT EXISTS(SELECT 1 FROM fulfil_storage_days existing WHERE existing.contract_id=p.id AND existing.day=candidate.day) ORDER BY candidate.day LIMIT 1) due ON true
 WHERE EXISTS(SELECT 1 FROM tenant_sectors ts WHERE ts.tenant_id=p.tenant_id AND ts.sector='ecommerce-fulfilment')
 ORDER BY due.day,p.tenant_id,p.id LIMIT $2`,[today,limit])).rows;
 let created=0,skipped=0,failed=0;
 for(const item of due){try{const result=await db.tenant(item.tenant_id,async c=>{
  await lock(c,item.tenant_id);
  if(!(await c.query(`SELECT 1 FROM fulfil_storage_automation a JOIN memberships m ON m.user_id=a.approved_by AND m.active AND m.roles&&ARRAY['owner','finance']::text[] JOIN tenants t ON t.id=a.tenant_id AND t.status='active' WHERE a.contract_id=$1 AND a.enabled`,[item.id])).rows.length)return null;
  if(!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='ecommerce-fulfilment'`)).rows.length)return null;
  return accrueStorageCore(c,item.tenant_id,{kind:'system'},null,item.id,day(item.day));
 });if(result&&!result.duplicate)created++;else skipped++;}catch{failed++;}}
 return {created,skipped,failed};
}
