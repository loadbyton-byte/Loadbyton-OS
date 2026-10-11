import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest, forbidden, HttpError, TAX_CODES } from "../lib/util.js";
import { assertWritable, consumeQuota } from "../platform/entitlements.js";
import { must, nextNumber, recordId, reqStr } from "./common.js";
import { issueInvoice } from "./finance.js";
import {codBalance} from './cod-adjustments.js';

// Exact minor-unit input: do not silently round COD or accept unsafe integer amounts.
export function deliveryMoney(value: unknown): number {
  const s = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) throw badRequest("Enter an amount with at most two decimal places.");
  const [whole, fraction = ""] = s.split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(n) || n > 1_000_000_000) throw badRequest("Amount is too large.");
  return n;
}
async function gate(c: Conn, ctx: Ctx, perm: "delivery.write" | "delivery.finance" | "driver.act") {
  require(ctx, perm);
  await assertWritable(c, ctx.tenantId);
  if (!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='courier-last-mile'`)).rows.length) throw forbidden("Courier / last mile is not selected.");
  // Serialize idempotency checks and ledger balance checks across processes, including new rows.
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${ctx.tenantId}:delivery`]);
}
const parcel = (c: Conn, id: string) => must(c.query<any>(`SELECT * FROM delivery_parcels WHERE id=$1 FOR UPDATE`, [recordId(id,"Parcel")]), "Parcel");
const conflict = () => new HttpError(409, "This reference was already used for different details.");

export async function createParcel(c: Conn, ctx: Ctx, f: Record<string, any>) {
  await gate(c, ctx, "delivery.write");
  const customer = await must(c.query<any>(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [recordId(f.party_id,"Customer")]), "Customer");
  const ent = await must(c.query<any>(`SELECT id,currency FROM entities ORDER BY created_at LIMIT 1`), "Entity");
  if (ent.currency !== "AED") throw badRequest("Delivery COD currently supports AED entities only.");
  const fields = {
    external_ref: reqStr(f.external_ref, "Merchant reference", 100),
    recipient_name: reqStr(f.recipient_name, "Recipient", 120), recipient_phone: reqStr(f.recipient_phone, "Phone", 40),
    address: reqStr(f.address, "Address", 1000), fee_minor: deliveryMoney(f.fee), cod_expected_minor: deliveryMoney(f.cod ?? "0"),
    tax_code: reqStr(f.tax_code ?? "SR5", "Tax code", 20),
  };
  if (!Object.hasOwn(TAX_CODES, fields.tax_code)) throw badRequest("Choose a valid tax code.");
  const previous = (await c.query<any>(`SELECT * FROM delivery_parcels WHERE party_id=$1 AND external_ref=$2`, [customer.id, fields.external_ref])).rows[0];
  if (previous) {
    if (Object.entries(fields).some(([k,v]) => String(previous[k]) !== String(v))) throw conflict();
    return { id: previous.id, no: previous.no, duplicate: true };
  }
  const no = await nextNumber(c, ctx.tenantId, "delivery_parcel", "PAR");
  const r = await c.query<any>(`INSERT INTO delivery_parcels(tenant_id,party_id,entity_id,no,external_ref,recipient_name,recipient_phone,address,fee_minor,cod_expected_minor,tax_code,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ctx.tenantId,customer.id,ent.id,no,fields.external_ref,fields.recipient_name,fields.recipient_phone,fields.address,fields.fee_minor,fields.cod_expected_minor,fields.tax_code,ctx.userId]);
  await consumeQuota(c,ctx.tenantId,"delivery_parcels_per_month",`parcel:${r.rows[0].id}`);
  await audit(c,ctx.tenantId,actorOf(ctx),"delivery.created","delivery_parcel",r.rows[0].id,{no});
  return {id:r.rows[0].id,no,duplicate:false};
}
export async function dispatchParcel(c: Conn, ctx: Ctx, id: string, driverId: string, route: string) {
  await gate(c,ctx,"delivery.write");
  const p = await parcel(c,id), routeRef = reqStr(route,"Route reference",80);
  if (p.status==='out_for_delivery' && p.driver_id===driverId && p.route_ref===routeRef) return;
  if (!['ready','failed'].includes(p.status)) throw badRequest("Only ready or failed parcels can be dispatched.");
  await must(c.query(`SELECT d.id FROM drivers d JOIN team_members m ON m.driver_id=d.id AND m.active AND 'driver'=ANY(m.roles)
    WHERE d.id=$1 AND d.active`,[recordId(driverId,"Courier")]),"Active courier with a driver login");
  if ((await c.query(`SELECT 1 FROM compliance_items WHERE subject_type='driver' AND subject_id=$1 AND blocking AND expires_on < current_date`,[driverId])).rows.length) throw badRequest("Courier compliance has expired.");
  await c.query(`UPDATE delivery_parcels SET status='out_for_delivery',driver_id=$2,route_ref=$3 WHERE id=$1`,[id,driverId,routeRef]);
  await audit(c,ctx.tenantId,actorOf(ctx),"delivery.dispatched","delivery_parcel",id,{driverId,route:routeRef});
}
export async function recordAttempt(c: Conn, ctx: Ctx, id: string, f: Record<string, any>) {
  await gate(c,ctx,ctx.perms.has("delivery.write") ? "delivery.write" : "driver.act");
  const p = await parcel(c,id);
  if (!ctx.perms.has("delivery.write") && (!ctx.driverId || p.driver_id!==ctx.driverId)) throw forbidden("This parcel is not assigned to you.");
  const outcome = reqStr(f.outcome,"Outcome",20), ref = reqStr(f.client_ref,"Attempt reference",100);
  if (!['delivered','failed','returned'].includes(outcome)) throw badRequest("Choose delivered, failed or returned.");
  const reason = outcome==='delivered' ? null : reqStr(f.reason,"Reason",300);
  const pod = outcome==='delivered' ? reqStr(f.pod_name,"Recipient proof of delivery",120) : null;
  const amount = deliveryMoney(f.collected ?? '0');
  if (outcome!=='delivered' && amount!==0) throw badRequest("COD is collected only on successful delivery.");
  if (p.cod_expected_minor===0 && amount!==0) throw badRequest("This parcel is not COD.");
  const prior = (await c.query<any>(`SELECT * FROM delivery_attempts WHERE client_ref=$1`,[ref])).rows[0];
  if (prior) {
    if (prior.parcel_id!==id || prior.outcome!==outcome || prior.pod_name!==pod || prior.reason!==reason || Number(prior.cod_collected_minor)!==amount) throw conflict();
    return {duplicate:true};
  }
  if (outcome==='returned' ? !['failed','ready'].includes(p.status) : p.status!=='out_for_delivery') throw badRequest("This outcome is not allowed in the parcel's current state.");
  await c.query(`INSERT INTO delivery_attempts(tenant_id,parcel_id,client_ref,outcome,reason,pod_name,cod_collected_minor,recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[ctx.tenantId,id,ref,outcome,reason,pod,amount,ctx.userId]);
  await c.query(`UPDATE delivery_parcels SET status=$2 WHERE id=$1`,[id,outcome]);
  await audit(c,ctx.tenantId,actorOf(ctx),`delivery.${outcome}`,"delivery_parcel",id,{collectedMinor:amount,mismatch:outcome==='delivered' && amount!==Number(p.cod_expected_minor)});
  return {duplicate:false};
}
export async function cancelParcel(c: Conn, ctx: Ctx, id: string, reason: string) {
  await gate(c,ctx,"delivery.write");
  const p=await parcel(c,id);
  if (p.status!=='ready') throw badRequest("Only an undispatched parcel can be cancelled.");
  const why=reqStr(reason,"Reason",300);
  await c.query(`UPDATE delivery_parcels SET status='cancelled' WHERE id=$1`,[id]);
  await audit(c,ctx.tenantId,actorOf(ctx),"delivery.cancelled","delivery_parcel",id,{reason:why});
}
export async function receiveCash(c: Conn, ctx: Ctx, id: string, amount: unknown, reference: string) {
  await gate(c,ctx,"delivery.finance");
  const p=await parcel(c,id), n=deliveryMoney(amount), ref=reqStr(reference,"Cash receipt reference",100);
  if (p.status!=='delivered' || Number(p.cod_expected_minor)===0) throw badRequest("Receive cash only for delivered COD parcels.");
  const previous=(await c.query<any>(`SELECT * FROM delivery_cash_receipts WHERE parcel_id=$1 OR reference=$2`,[id,ref])).rows[0];
  if (previous) {
    if (previous.parcel_id!==id || previous.reference!==ref || Number(previous.amount_minor)!==n) throw conflict();
    return;
  }
  await c.query(`INSERT INTO delivery_cash_receipts(tenant_id,parcel_id,amount_minor,reference,recorded_by) VALUES ($1,$2,$3,$4,$5)`,[ctx.tenantId,id,n,ref,ctx.userId]);
  await audit(c,ctx.tenantId,actorOf(ctx),"delivery.cash_received","delivery_parcel",id,{amountMinor:n});
}
export async function reconcileCod(c: Conn, ctx: Ctx, id: string, reason: string) {
  await gate(c,ctx,"delivery.finance");
  const p=await parcel(c,id);
  const attempt=await must(c.query<any>(`SELECT * FROM delivery_attempts WHERE parcel_id=$1 AND outcome='delivered'`,[id]),"Delivered collection");
  const cash=await must(c.query<any>(`SELECT * FROM delivery_cash_receipts WHERE parcel_id=$1`,[id]),"Cash handover");
  const why=reqStr(reason,"Reconciliation explanation",500);
  // No owner exception: an independent person must explain any financial variance.
  const mismatch=Number(p.cod_expected_minor)!==Number(attempt.cod_collected_minor) || Number(attempt.cod_collected_minor)!==Number(cash.amount_minor);
  if (mismatch && (attempt.recorded_by===ctx.userId || cash.recorded_by===ctx.userId)) throw forbidden("A different finance approver must decide a COD mismatch.");
  if ((await c.query(`SELECT 1 FROM delivery_cod_decisions WHERE parcel_id=$1`,[id])).rows.length) throw badRequest("COD has already been reconciled; the recorded decision is immutable.");
  await c.query(`INSERT INTO delivery_cod_decisions(tenant_id,parcel_id,reason,expected_minor,collected_minor,received_minor,decided_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,[ctx.tenantId,id,why,p.cod_expected_minor,attempt.cod_collected_minor,cash.amount_minor,ctx.userId]);
  await audit(c,ctx.tenantId,actorOf(ctx),"delivery.cod_reconciled","delivery_parcel",id,{mismatch,reason:why});
}
export async function remitCod(c: Conn, ctx: Ctx, id: string, amount: unknown, reference: string) {
  await gate(c,ctx,"delivery.finance");
  await parcel(c,id);
  const n=deliveryMoney(amount), ref=reqStr(reference,"Bank/payment reference",100);
  if (n<=0) throw badRequest("Remittance must be above zero.");
  const previous=(await c.query<any>(`SELECT * FROM delivery_remittances WHERE reference=$1`,[ref])).rows[0];
  if (previous) {
    if (previous.parcel_id!==id || Number(previous.amount_minor)!==n) throw conflict();
    return;
  }
  const balance=await codBalance(c,id);
  // Only independently approved, evidenced cash changes affect available cash. Original entitlement remains visible.
  if (n>balance.remittable) throw badRequest("Remittance exceeds reconciled cash available for this merchant.");
  await c.query(`INSERT INTO delivery_remittances(tenant_id,parcel_id,amount_minor,reference,recorded_by) VALUES ($1,$2,$3,$4,$5)`,[ctx.tenantId,id,n,ref,ctx.userId]);
  await audit(c,ctx.tenantId,actorOf(ctx),"delivery.cod_remitted","delivery_parcel",id,{amountMinor:n});
}
export async function invoiceParcel(c: Conn, ctx: Ctx, id: string) {
  require(ctx,"finance.write");
  await gate(c,ctx,"delivery.finance");
  const p=await parcel(c,id);
  if (!['delivered','returned'].includes(p.status)) throw badRequest("Invoice the service fee after delivery or return.");
  if (p.invoice_id) return {id:p.invoice_id};
  if (Number(p.fee_minor)<=0) throw badRequest("This parcel has no service fee to invoice.");
  return issueInvoice(c,ctx,{entityId:p.entity_id,partyId:p.party_id,deliveryParcelId:id,
    lines:[{id,description:`Parcel ${p.no} delivery service`,qty:1,unit_minor:p.fee_minor,tax_code:p.tax_code}],
    markCharge:async(_,invoiceId)=>{await c.query(`UPDATE delivery_parcels SET invoice_id=$2 WHERE id=$1`,[id,invoiceId]);}});
}
export async function listParcels(c: Conn, opts: {page?:number; driverId?:string; partyId?:string; status?:string}={}) {
  const page=Math.max(1,Math.floor(opts.page || 1));
  return (await c.query<any>(`SELECT p.id,p.no,p.external_ref,p.status,p.route_ref,p.driver_id,p.party_id,p.recipient_name,p.cod_expected_minor,
    p.fee_minor,m.name AS merchant,d.name AS courier,
    a.cod_collected_minor,cr.amount_minor AS received_minor,coalesce(adj.delta,0) AS cash_change_minor,
    CASE WHEN cr.id IS NULL THEN NULL ELSE cr.amount_minor+coalesce(adj.delta,0) END AS adjusted_cash_minor,dc.id AS decision_id,
    coalesce((SELECT sum(r.amount_minor) FROM delivery_remittances r WHERE r.parcel_id=p.id),0) AS remitted_minor
    FROM delivery_parcels p JOIN parties m ON m.id=p.party_id LEFT JOIN drivers d ON d.id=p.driver_id
    LEFT JOIN delivery_attempts a ON a.parcel_id=p.id AND a.outcome='delivered'
    LEFT JOIN delivery_cash_receipts cr ON cr.parcel_id=p.id LEFT JOIN delivery_cod_decisions dc ON dc.parcel_id=p.id
    LEFT JOIN LATERAL(SELECT sum(CASE WHEN x.kind IN ('recovery','correction_in') THEN x.amount_minor ELSE -x.amount_minor END) AS delta FROM delivery_cash_adjustments x JOIN delivery_cash_adjustment_decisions z ON z.adjustment_id=x.id AND z.approved WHERE x.parcel_id=p.id) adj ON true
    WHERE ($1::uuid IS NULL OR p.driver_id=$1) AND ($2::uuid IS NULL OR p.party_id=$2) AND ($3::text IS NULL OR p.status=$3)
    ORDER BY p.created_at DESC,p.id LIMIT 51 OFFSET $4`,[opts.driverId ?? null,opts.partyId ?? null,opts.status || null,(page-1)*50])).rows;
}
export async function getParcel(c: Conn, id: string) {
  const p=await must(c.query<any>(`SELECT p.*,m.name AS merchant,s.order_id AS fulfilment_order_id,s.tracking_no AS fulfilment_tracking FROM delivery_parcels p JOIN parties m ON m.id=p.party_id LEFT JOIN fulfil_shipments s ON s.delivery_parcel_id=p.id WHERE p.id=$1`,[recordId(id,"Parcel")]),"Parcel");
  return {p,attempts:(await c.query<any>(`SELECT * FROM delivery_attempts WHERE parcel_id=$1 ORDER BY occurred_at,id`,[id])).rows,
    cash:(await c.query<any>(`SELECT * FROM delivery_cash_receipts WHERE parcel_id=$1`,[id])).rows[0],
    decision:(await c.query<any>(`SELECT * FROM delivery_cod_decisions WHERE parcel_id=$1`,[id])).rows[0],
    remittances:(await c.query<any>(`SELECT * FROM delivery_remittances WHERE parcel_id=$1 ORDER BY paid_at,id`,[id])).rows};
}
