import type { Conn } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { actorOf,require,type Ctx } from '../lib/perms.js';
import { badRequest,forbidden,HttpError,TAX_CODES } from '../lib/util.js';
import { assertWritable,consumeQuota } from '../platform/entitlements.js';
import { must,nextNumber,recordId,reqStr } from './common.js';
import { deliveryMoney } from './delivery.js';
import {issueInvoice} from './finance.js';

async function gate(c:Conn,ctx:Ctx,finance=false) {
 require(ctx,finance?'finance.write':'customs.write');await assertWritable(c,ctx.tenantId);
 if (!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='customs-brokerage'`)).rows.length) throw forbidden('Customs brokerage is not selected.');
 await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:customs`]);
}
const locked=(c:Conn,id:string)=>must(c.query<any>(`SELECT * FROM customs_cases WHERE id=$1 FOR UPDATE`,[recordId(id,"Customs case")]),'Customs case');
export async function createCase(c:Conn,ctx:Ctx,f:Record<string,any>) {
 await gate(c,ctx);
 await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`,[recordId(f.party_id,"Customer")]),'Customer');
 const ref=reqStr(f.external_ref,'Customer reference',100),type=reqStr(f.declaration_type,'Declaration type',20);
 if (!['import','export','transit'].includes(type)) throw badRequest('Choose import, export or transit.');
 const entity=await must(c.query<any>(`SELECT id,currency FROM entities ORDER BY created_at LIMIT 1`),'Entity'),fee=deliveryMoney(f.fee??0),tax=String(f.tax_code??'SR5'),permit=f.permit_required===true||f.permit_required==='on';
 if(entity.currency!=='AED'||!TAX_CODES[tax])throw badRequest('Choose a valid tax code; customs pilot fees use AED');
 const prior=(await c.query<any>(`SELECT * FROM customs_cases WHERE party_id=$1 AND external_ref=$2`,[f.party_id,ref])).rows[0];
 if(prior){if(prior.declaration_type!==type||Number(prior.fee_minor)!==fee||prior.tax_code!==tax||prior.permit_required!==permit)throw new HttpError(409,'This reference was used for different case or fee details.');return {id:prior.id,no:prior.no};}
 const no=await nextNumber(c,ctx.tenantId,'customs_case','CUS');
 const result=await c.query<any>(`INSERT INTO customs_cases(tenant_id,party_id,no,external_ref,declaration_type,created_by,entity_id,fee_minor,tax_code,permit_required) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[ctx.tenantId,f.party_id,no,ref,type,ctx.userId,entity.id,fee,tax,permit]);
 const id=result.rows[0].id;await consumeQuota(c,ctx.tenantId,'customs_cases_per_month',`customs:${id}`);
 await audit(c,ctx.tenantId,actorOf(ctx),'customs.created','customs_case',id,{no});return {id,no};
}
export async function attachEvidence(c:Conn,ctx:Ctx,id:string,documentId:string,kind:string) {
 await gate(c,ctx);const p=await locked(c,id);
 if(['cancelled','cleared'].includes(p.status))throw badRequest('This case is closed.');
 if(!['commercial_invoice','packing_list','transport_document','permit','clearance','inspection'].includes(kind))throw badRequest('Choose a valid evidence type.');
 await must(c.query(`SELECT id FROM documents WHERE id=$1`,[recordId(documentId,"Document")]),'Document');
 const result=await c.query(`INSERT INTO customs_evidence(tenant_id,case_id,document_id,kind,recorded_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,[ctx.tenantId,id,documentId,kind,ctx.userId]);
 if(result.rows.length)await audit(c,ctx.tenantId,actorOf(ctx),'customs.evidence_attached','customs_case',id,{documentId,kind});
}
export async function transitionCase(c:Conn,ctx:Ctx,id:string,next:string,reason:string,officialRef?:string) {
 await gate(c,ctx);const p=await locked(c,id),why=reqStr(reason,'Decision / authority evidence explanation',500);
 const allowed:Record<string,string[]>={draft:['ready','cancelled'],ready:['handed_over','draft','cancelled'],handed_over:['inspection','cleared'],inspection:['cleared']};
 if(!(allowed[p.status]??[]).includes(next))throw badRequest('This transition is not allowed.');
 const evidence=(await c.query<any>(`SELECT kind FROM customs_evidence WHERE case_id=$1`,[id])).rows.map(x=>x.kind);
 if(next==='ready' && ['commercial_invoice','packing_list','transport_document'].some(x=>!evidence.includes(x)))throw badRequest('Attach invoice, packing list and transport document before marking ready. Confirm any required permits separately.');
 if(['ready','handed_over','cleared'].includes(next)){
  if((await c.query(`SELECT 1 FROM customs_evidence e JOIN documents d ON d.id=e.document_id WHERE e.case_id=$1 AND (d.status<>'issued' OR d.hold)`,[id])).rows.length)throw badRequest('Customs release requires issued evidence that is not on hold');
  if(p.permit_required&&!evidence.includes('permit'))throw badRequest('Attach the goods-specific permit required by the reviewed case');
 }
 const ref=next==='handed_over'?reqStr(officialRef,'Official / authorised-agent handover reference',120):p.official_ref;
 if(next==='cleared' && !evidence.includes('clearance'))throw badRequest('Attach official clearance evidence before recording clearance.');
 if(['ready','handed_over','cleared'].includes(next))require(ctx,'customs.approve');
 await c.query(`UPDATE customs_cases SET status=$2,official_ref=$3 WHERE id=$1`,[id,next,ref]);
 await c.query(`INSERT INTO customs_events(tenant_id,case_id,status,reason,recorded_by) VALUES ($1,$2,$3,$4,$5)`,[ctx.tenantId,id,next,why,ctx.userId]);
 await audit(c,ctx.tenantId,actorOf(ctx),`customs.${next}`,'customs_case',id,{reason:why});
}
export async function invoiceCase(c:Conn,ctx:Ctx,id:string) {
 await gate(c,ctx,true);const row=await locked(c,id);
 if(row.status!=='cleared'||Number(row.fee_minor)<=0||!row.entity_id)throw badRequest('Invoice a cleared case with an agreed service fee');
 if(row.invoice_id)return {id:row.invoice_id};
 return issueInvoice(c,ctx,{entityId:row.entity_id,partyId:row.party_id,customsCaseId:id,lines:[{id,description:`${row.no} customs service fee`,qty:1,unit_minor:row.fee_minor,tax_code:row.tax_code}],markCharge:async(_,invoiceId)=>{await c.query(`UPDATE customs_cases SET invoice_id=$2,financial_status='invoiced' WHERE id=$1`,[id,invoiceId]);}});
}
export async function recordDeposit(c:Conn,ctx:Ctx,id:string,kind:string,amount:unknown,reference:string) {
 await gate(c,ctx,true);const p=await locked(c,id),n=deliveryMoney(amount),ref=reqStr(reference,'Payment reference',100);
 if(!['received','refunded'].includes(kind)||n<=0)throw badRequest('Choose receipt/refund and enter an amount above zero.');
 const entity=await must(c.query<any>(`SELECT currency FROM entities ORDER BY created_at LIMIT 1`),'Entity');
 if(entity.currency!=='AED')throw badRequest('Customs deposits currently support AED entities only.');
 const previous=(await c.query<any>(`SELECT * FROM customs_deposit_entries WHERE reference=$1`,[ref])).rows[0];
 if(previous){if(previous.case_id!==id||previous.kind!==kind||Number(previous.amount_minor)!==n)throw new HttpError(409,'Payment reference was already used for different details.');return;}
 if(kind==='received' && ['cleared','cancelled'].includes(p.status))throw badRequest('This case is closed to new deposits.');
 if(kind==='refunded'){
  if(!['cleared','cancelled'].includes(p.status))throw badRequest('Refund deposits after case clearance or cancellation.');
  const balance=Number((await c.query<any>(`SELECT coalesce(sum(CASE WHEN kind='received' THEN amount_minor ELSE -amount_minor END),0) n FROM customs_deposit_entries WHERE case_id=$1`,[id])).rows[0].n);
  if(n>balance)throw badRequest('Refund exceeds the deposit balance.');
 }
 await c.query(`INSERT INTO customs_deposit_entries(tenant_id,case_id,kind,amount_minor,reference,recorded_by) VALUES ($1,$2,$3,$4,$5,$6)`,[ctx.tenantId,id,kind,n,ref,ctx.userId]);
 await audit(c,ctx.tenantId,actorOf(ctx),`customs.deposit_${kind}`,'customs_case',id,{amountMinor:n});
}
export const listCases=async(c:Conn,page=1)=>(await c.query<any>(`SELECT x.*,p.name AS customer FROM customs_cases x JOIN parties p ON p.id=x.party_id ORDER BY x.created_at DESC,x.id LIMIT 51 OFFSET $1`,[(Math.max(1,page)-1)*50])).rows;
export async function getCase(c:Conn,id:string){return {p:await must(c.query<any>(`SELECT x.*,p.name AS customer FROM customs_cases x JOIN parties p ON p.id=x.party_id WHERE x.id=$1`,[recordId(id,"Customs case")]),'Customs case'),
 evidence:(await c.query<any>(`SELECT e.*,d.title FROM customs_evidence e JOIN documents d ON d.id=e.document_id WHERE case_id=$1 ORDER BY e.created_at,e.id`,[id])).rows,
 events:(await c.query<any>(`SELECT * FROM customs_events WHERE case_id=$1 ORDER BY created_at,id`,[id])).rows,
 deposits:(await c.query<any>(`SELECT * FROM customs_deposit_entries WHERE case_id=$1 ORDER BY created_at,id`,[id])).rows};}
