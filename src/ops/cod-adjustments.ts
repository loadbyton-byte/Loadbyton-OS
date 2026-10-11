import type {Conn} from '../db/client.js';
import {require,actorOf,type Ctx} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,forbidden,HttpError} from '../lib/util.js';
import {assertWritable} from '../platform/entitlements.js';
import {must,recordId,reqStr} from './common.js';
import {deliveryMoney} from './delivery.js';
import {storeDocument} from './documents.js';
export const COD_ADJUSTMENT_KINDS=['recovery','refund','correction_in','correction_out'] as const;
async function gate(c:Conn,ctx:Ctx,parcelId:string){
 require(ctx,'delivery.finance');await assertWritable(c,ctx.tenantId);if(ctx.supportStaffId||ctx.partyId)throw forbidden('COD adjustments require a finance company session.');
 if(!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='courier-last-mile'`)).rows.length)throw forbidden('Courier / last mile is not selected.');
 await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:delivery`]);
 const p=await must(c.query<any>(`SELECT p.id,p.status,p.cod_expected_minor FROM delivery_parcels p JOIN delivery_cod_decisions d ON d.parcel_id=p.id WHERE p.id=$1 FOR UPDATE OF p`,[recordId(parcelId,'Parcel')]),'Reconciled COD parcel');if(p.status!=='delivered'||Number(p.cod_expected_minor)<=0)throw badRequest('Adjustments require a delivered reconciled COD parcel.');return p;
}
/** Recording actual cash is distinct from approving merchant liability/write-offs or making a bank payment. */
export async function codBalance(c:Conn,parcelId:string){
 const d=await must(c.query<any>(`SELECT * FROM delivery_cod_decisions WHERE parcel_id=$1`,[recordId(parcelId)]),'COD reconciliation');
 const adjustments=(await c.query<any>(`SELECT coalesce(sum(CASE WHEN a.kind IN ('recovery','correction_in') THEN a.amount_minor ELSE -a.amount_minor END),0) delta,coalesce(sum(CASE WHEN a.kind='recovery' THEN a.amount_minor ELSE 0 END),0) recovered FROM delivery_cash_adjustments a JOIN delivery_cash_adjustment_decisions x ON x.adjustment_id=a.id AND x.approved WHERE a.parcel_id=$1`,[parcelId])).rows[0],delta=Number(adjustments.delta),paid=Number((await c.query<any>(`SELECT coalesce(sum(amount_minor),0) n FROM delivery_remittances WHERE parcel_id=$1`,[parcelId])).rows[0].n);
 // Refund/correction changes cash custody, never the original customer collection or merchant entitlement.
 // Only an evidenced new recovery can cover an original collection shortage.
 const received=Number(d.received_minor)+delta,collected=Number(d.collected_minor)+Number(adjustments.recovered),expected=Number(d.expected_minor),available=Math.max(0,Math.min(expected,collected,received));
 return {original:d,delta,received,collected,expected,paid,available,remittable:Math.max(0,available-paid),merchantOutstanding:Math.max(0,expected-paid),shortage:Math.max(0,expected-Math.min(collected,received)),surplus:Math.max(0,received-expected)};
}
export async function uploadCodEvidence(c:Conn,ctx:Ctx,parcelId:string,file:{filename:string;data:Buffer;issuer:string}){
 await gate(c,ctx,parcelId);return storeDocument(c,ctx,{delivery_parcel_id:parcelId,kind:'other',title:'COD adjustment source evidence',issuer:reqStr(file.issuer,'Actual external evidence issuer',200),filename:file.filename,data:file.data});
}
export async function proposeCodAdjustment(c:Conn,ctx:Ctx,parcelId:string,f:Record<string,unknown>){
 await gate(c,ctx,parcelId);const reference=recordId(f.reference,'Adjustment reference'),kind=String(f.kind);if(!COD_ADJUSTMENT_KINDS.includes(kind as any))throw badRequest('Choose recovery, refund or a cash correction direction.');
 const amount=deliveryMoney(f.amount);if(amount<=0)throw badRequest('Adjustment amount must be above zero.');const doc=recordId(f.document_id,'Issued cash evidence'),reason=reqStr(f.reason,'Cash explanation and external reference',1000),old=(await c.query<any>(`SELECT * FROM delivery_cash_adjustments WHERE reference=$1`,[reference])).rows[0];if(old){if(old.parcel_id!==parcelId||old.kind!==kind||Number(old.amount_minor)!==amount||old.document_id!==doc||old.reason!==reason)throw new HttpError(409,'Adjustment reference belongs to different cash details.');return old.id;}
 await must(c.query(`SELECT id FROM documents WHERE id=$1 AND delivery_parcel_id=$2 AND status='issued' AND NOT hold`,[doc,parcelId]),'Issued cash evidence for this parcel');
 if((await c.query(`SELECT 1 FROM delivery_cash_adjustments WHERE document_id=$1`,[doc])).rows.length)throw new HttpError(409,'This cash evidence already belongs to another adjustment. Supply a new issued event or corrected evidence version.');
 if(Number((await c.query<any>(`SELECT count(*) n FROM delivery_cash_adjustments WHERE parcel_id=$1`,[parcelId])).rows[0].n)>=500)throw badRequest('Review the adjustment history before creating more records for this parcel.');
 const id=(await c.query<any>(`INSERT INTO delivery_cash_adjustments(tenant_id,parcel_id,reference,kind,amount_minor,document_id,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[ctx.tenantId,parcelId,reference,kind,amount,doc,reason,ctx.userId])).rows[0].id;await audit(c,ctx.tenantId,actorOf(ctx),'delivery.cash_adjustment_proposed','delivery_cash_adjustment',id,{parcel_id:parcelId,kind,amount_minor:amount,document_id:doc});return id;
}
export async function decideCodAdjustment(c:Conn,ctx:Ctx,id:string,approved:boolean,reason:string){
 const row=await must(c.query<any>(`SELECT * FROM delivery_cash_adjustments WHERE id=$1`,[recordId(id)]),'COD adjustment');await gate(c,ctx,row.parcel_id);const why=reqStr(reason,'Independent review explanation',1000);
 if(row.requested_by===ctx.userId)throw forbidden('A second person must decide this COD cash adjustment, including owners.');
 const old=(await c.query<any>(`SELECT * FROM delivery_cash_adjustment_decisions WHERE adjustment_id=$1`,[id])).rows[0];if(old){if(old.approved!==approved||old.decided_by!==ctx.userId||old.reason!==why)throw new HttpError(409,'The immutable adjustment decision is already recorded.');return old.id;}
 if(approved){await must(c.query(`SELECT id FROM documents WHERE id=$1 AND delivery_parcel_id=$2 AND status='issued' AND NOT hold FOR SHARE`,[row.document_id,row.parcel_id]),'Current issued cash evidence');const balance=await codBalance(c,row.parcel_id),delta=['recovery','correction_in'].includes(row.kind)?Number(row.amount_minor):-Number(row.amount_minor),recovery=row.kind==='recovery'?Number(row.amount_minor):0,available=Math.min(balance.expected,balance.collected+recovery,balance.received+delta);if(balance.received+delta<0||available<balance.paid)throw badRequest('Adjustment would reverse cash already remitted or create a negative cash balance. Record actual returned cash with evidence first.');}
 const decision=(await c.query<any>(`INSERT INTO delivery_cash_adjustment_decisions(tenant_id,adjustment_id,approved,reason,decided_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,[ctx.tenantId,id,approved,why,ctx.userId])).rows[0].id;await audit(c,ctx.tenantId,actorOf(ctx),approved?'delivery.cash_adjustment_approved':'delivery.cash_adjustment_rejected','delivery_cash_adjustment',id,{parcel_id:row.parcel_id,decision_id:decision});return decision;
}
export async function listCodAdjustments(c:Conn,parcelId:string){return (await c.query<any>(`SELECT a.*,d.id AS decision_id,d.approved,d.reason AS review_reason,d.decided_by,f.status AS evidence_status,f.hold AS evidence_hold FROM delivery_cash_adjustments a LEFT JOIN delivery_cash_adjustment_decisions d ON d.adjustment_id=a.id JOIN documents f ON f.id=a.document_id WHERE a.parcel_id=$1 ORDER BY a.created_at,a.id LIMIT 500`,[recordId(parcelId)])).rows;}
