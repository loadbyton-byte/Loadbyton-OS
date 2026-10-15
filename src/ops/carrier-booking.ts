import crypto from "node:crypto";
import type { Conn, Db } from "../db/client.js";
import { bookDhl, CarrierError, type BookRequest, type CarrierParty } from "../adapters/carrier-dhl.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { seal, unseal } from "../lib/seal.js";
import { storage } from "../lib/storage.js";
import { HttpError, badRequest, forbidden, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";
import { shipOrder } from "./fulfilment.js";
import { normalizePhone } from "../platform/kyc.js";

/**
 * Carrier booking and labels. A booking is committed as 'requested' BEFORE the carrier is called, so a crash or a timeout can never lead to a second booking: an outcome that is not known stays
 * 'requested' and blocks another attempt until a person has checked with the carrier and cleared it. A booked shipment keeps the carrier's label (PDF) and tracking number, and the order is
 * then dispatched with that tracking number. Currently DHL Express, domestic parcels only; see adapters/carrier-dhl.ts for what has and has not been verified.
 */
export type Booker = (account: { environment: "test" | "live"; username: string; password: string }, r: BookRequest) => ReturnType<typeof bookDhl>;

export async function createCarrierAccount(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  if (!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='ecommerce-fulfilment'`)).rows.length) throw forbidden("The e-commerce fulfilment sector is not selected.");
  if (f.carrier !== "dhl_express") throw badRequest("The carrier is DHL Express.");
  const env = f.environment === "live" ? "live" : "test";
  const account = reqStr(f.account_number, "DHL account number", 20).replace(/\s/g, "");
  if (!/^\d{9,10}$/.test(account)) throw badRequest("A DHL account number has 9 or 10 digits.");
  const shipper = { company: reqStr(f.company, "Company name", 60), name: reqStr(f.contact, "Contact name", 45), phone: normalizePhone(String(f.phone ?? "")), email: String(f.email ?? "").trim().slice(0, 80) || undefined,
    address1: reqStr(f.address1, "Pickup address", 45), address2: String(f.address2 ?? "").trim().slice(0, 45) || undefined, city: reqStr(f.city, "City", 45), country: String(f.country ?? "AE").trim().toUpperCase(), postal: String(f.postal ?? "").trim().slice(0, 12) || undefined, account };
  if (!/^[A-Z]{2}$/.test(shipper.country)) throw badRequest("The country is two letters, for example AE.");
  const product = String(f.product_domestic ?? "N").trim().toUpperCase();
  if (!/^[A-Z0-9]$/.test(product)) throw badRequest("The DHL product code is one letter or digit (for example N for domestic express).");
  const cred = { username: reqStr(f.username, "DHL API username", 80), password: reqStr(f.password, "DHL API password", 120) };
  const id = (await c.query<any>(`INSERT INTO carrier_accounts(tenant_id,carrier,label,environment,credentials_sealed,shipper,product_domestic,created_by) VALUES ($1,'dhl_express',$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, reqStr(f.label, "Name", 80), env, seal(JSON.stringify(cred)), JSON.stringify(shipper), product, ctx.userId]).catch((e) => { if (/unique/i.test(String(e.message))) throw badRequest("An account with that name already exists."); throw e; })).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "carrier_account.created", "carrier_account", id, { environment: env });
  return id as string;
}
export async function retireCarrierAccount(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "settings.manage");
  await must(c.query(`UPDATE carrier_accounts SET status='retired' WHERE id=$1 RETURNING id`, [recordId(id, "Account")]), "Account");
}
export const listCarrierAccounts = (c: Conn) => c.query<any>(`SELECT id,label,environment,status,shipper->>'company' AS company,shipper->>'city' AS city,created_at FROM carrier_accounts ORDER BY created_at DESC`).then((r) => r.rows);
export const packedOrders = (c: Conn) => c.query<any>(
  `SELECT o.id,o.no,o.external_ref,o.ship_to_city,o.ship_to_country,p.name AS party_name,
     (SELECT cs.status FROM carrier_shipments cs WHERE cs.order_id=o.id AND cs.status IN ('requested','booked') LIMIT 1) AS booking, (SELECT cs.tracking_no FROM carrier_shipments cs WHERE cs.order_id=o.id AND cs.status='booked' LIMIT 1) AS tracking_no
   FROM fulfil_orders o JOIN parties p ON p.id=o.party_id WHERE o.status='packed' ORDER BY o.created_at LIMIT 100`).then((r) => r.rows);

export interface BookingInput { account_id: string; weight_kg: unknown; length_cm?: unknown; width_cm?: unknown; height_cm?: unknown; description?: string }
export async function bookAndDispatch(db: Db, ctx: Ctx, orderId: string, f: BookingInput, booker: Booker = (a, r) => bookDhl(a, r)) {
  require(ctx, "wh.floor");
  const weight = Number(f.weight_kg);
  if (!(weight > 0 && weight <= 70)) throw badRequest("Enter the parcel weight in kilograms (up to 70).");
  const dim = [f.length_cm, f.width_cm, f.height_cm].map((v) => (v === undefined || v === "" ? null : Number(v)));
  if (dim.some((v) => v !== null) && (dim.some((v) => v === null) || dim.some((v) => !(v! > 0 && v! <= 300)))) throw badRequest("Give all three dimensions in centimetres (up to 300), or none.");
  // phase 1 — commit the intention
  const plan = await db.tenant(ctx.tenantId, async (c) => {
    await assertWritable(c, ctx.tenantId);
    const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [recordId(orderId, "Order")]), "Order");
    if (o.status !== "packed") throw badRequest(`Order is ${o.status}; it must be fully packed before a label is booked.`);
    const a = await must(c.query<any>(`SELECT * FROM carrier_accounts WHERE id=$1 AND status='active'`, [recordId(f.account_id, "Account")]), "Carrier account");
    const live = (await c.query<any>(`SELECT status, tracking_no FROM carrier_shipments WHERE order_id=$1 AND status IN ('requested','booked')`, [o.id])).rows[0];
    if (live?.status === "booked") return { existing: live.tracking_no as string, orderNo: o.no as string };
    if (live) throw new HttpError(409, "A booking for this order was started but its outcome is not known. Check with the carrier whether a shipment exists, then ask a manager to clear the booking.", "conflict");
    if (!o.ship_to_city) throw badRequest("The order has no city; the carrier needs one.");
    const id = (await c.query<any>(`INSERT INTO carrier_shipments(tenant_id,order_id,account_id,created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.tenantId, o.id, a.id, ctx.userId])).rows[0].id as string;
    const lines = (await c.query<any>(`SELECT s.name FROM fulfil_order_lines l JOIN skus s ON s.id=l.sku_id WHERE l.order_id=$1 ORDER BY s.name LIMIT 3`, [o.id])).rows.map((r) => r.name).join(", ");
    return { id, orderNo: o.no as string, a, o, lines };
  });
  if ("existing" in plan) return { booked: true, dispatched: false, tracking_no: plan.existing, message: `A label for ${plan.orderNo} is already booked (${plan.existing}).` };
  // phase 2 — the carrier
  const cred = JSON.parse(unseal(plan.a.credentials_sealed));
  const shipper = plan.a.shipper as CarrierParty & { account: string };
  const receiver: CarrierParty = { name: plan.o.ship_to_name, phone: plan.o.ship_to_phone || shipper.phone, address1: String(plan.o.ship_to_address).slice(0, 45), address2: String(plan.o.ship_to_address).slice(45, 90) || undefined, city: plan.o.ship_to_city, country: plan.o.ship_to_country || "AE" };
  let result: Awaited<ReturnType<Booker>>;
  try {
    result = await booker({ environment: plan.a.environment, username: cred.username, password: cred.password }, { reference: plan.orderNo, shipper, receiver, weightKg: weight, ...(dim[0] ? { dimensionsCm: { length: dim[0]!, width: dim[1]!, height: dim[2]! } } : {}), description: f.description?.trim() || plan.lines || "Goods", productCode: plan.a.product_domestic, accountNumber: shipper.account, shipDate: new Date() });
  } catch (e: any) {
    const known = e instanceof CarrierError && e.permanent;
    await db.tenant(ctx.tenantId, (c) => known ? c.query(`UPDATE carrier_shipments SET status='failed', error=$2 WHERE id=$1`, [plan.id, e.message.slice(0, 300)]) : c.query(`UPDATE carrier_shipments SET error=$2 WHERE id=$1`, [plan.id, String(e?.message ?? "unknown").slice(0, 300)]));
    throw new HttpError(known ? 400 : 502, e instanceof CarrierError ? e.message : "The carrier could not be reached. It is not known whether the shipment was booked. Check the carrier before trying again.", known ? "bad_request" : "bad_gateway");
  }
  // phase 3 — keep what we got
  const key = `${ctx.tenantId}/carrier-labels/${crypto.randomUUID()}`;
  await storage.put(key, result.label.data);
  await db.tenant(ctx.tenantId, async (c) => {
    await c.query(`UPDATE carrier_shipments SET status='booked', tracking_no=$2, label_format=$3, label_key=$4, label_sha256=$5, booked_at=now(), error=NULL WHERE id=$1`, [plan.id, result.trackingNo, result.label.format, key, sha256(result.label.data)]);
    await audit(c, ctx.tenantId, actorOf(ctx), "carrier_shipment.booked", "fulfil_order", orderId, { carrier: "dhl_express", tracking: result.trackingNo });
  });
  // phase 4 — dispatch the order with that tracking number; a failure here leaves a valid booking behind
  try {
    await db.tenant(ctx.tenantId, (c) => shipOrder(c, ctx, orderId, { carrier: "DHL", tracking_no: result.trackingNo, weight_g: Math.round(weight * 1000) }));
    return { booked: true, dispatched: true, tracking_no: result.trackingNo, message: `Booked ${result.trackingNo} and dispatched ${plan.orderNo}.` };
  } catch (e: any) {
    return { booked: true, dispatched: false, tracking_no: result.trackingNo, message: `Booked ${result.trackingNo}, but the order could not be dispatched: ${e.message} Dispatch it by hand with this tracking number.` };
  }
}
export async function clearUnknownBooking(c: Conn, ctx: Ctx, orderId: string, note: string) {
  require(ctx, "settings.manage");
  const why = String(note ?? "").trim();
  if (why.length < 5) throw badRequest("Say what you checked with the carrier (at least 5 characters).");
  await must(c.query(`UPDATE carrier_shipments SET status='failed', error=$2 WHERE order_id=$1 AND status='requested' RETURNING id`, [recordId(orderId, "Order"), `Cleared by a manager after checking with the carrier: ${why}`.slice(0, 300)]), "Booking awaiting an outcome");
  await audit(c, ctx.tenantId, actorOf(ctx), "carrier_shipment.cleared", "fulfil_order", orderId);
}
export async function carrierLabel(c: Conn, orderId: string): Promise<{ data: Buffer; format: string; tracking: string }> {
  const r = await must(c.query<any>(`SELECT label_key, label_sha256, label_format, tracking_no FROM carrier_shipments WHERE order_id=$1 AND status='booked'`, [recordId(orderId, "Order")]), "Booked label");
  const data = await storage.get(r.label_key);
  if (sha256(data) !== r.label_sha256) throw new Error("Stored label integrity check failed");
  return { data, format: r.label_format, tracking: r.tracking_no };
}
