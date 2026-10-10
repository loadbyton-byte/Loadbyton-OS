import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { TAX_CODES, badRequest, forbidden, toMinor } from "../lib/util.js";
import { assertWritable, consumeQuota } from "../platform/entitlements.js";
import { must, nextNumber, optStr, reqStr } from "./common.js";
import { issueInvoice } from "./finance.js";

/**
 * Contract warehouse / 3PL (blueprint §15). The unit of truth is the immutable movement ledger; `wh_stock` is a
 * maintained balance that `npm run verify` reconciles against it. Stock is owner-separated by composite foreign keys:
 * a SKU belongs to one customer and a stock row can only reference its own owner's SKU.
 */

// ───────────────────────── helpers
/** Company calendar day (UAE is UTC+4 all year, no DST). */
export const dubaiDay = (d = new Date()) => new Date(d.getTime() + 4 * 3600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const MAX_QTY = 1_000_000_000;

function qtyOf(v: unknown, label: string, allowZero = false): number {
  const s = String(v ?? "").trim();
  const n = Number(s);
  if (s === "" || !Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw badRequest(`${label} must be ${allowZero ? "zero or more" : "above zero"}.`);
  if (n > MAX_QTY) throw badRequest(`${label} is too large.`);
  if (r3(n) !== n) throw badRequest(`${label} can have at most 3 decimal places.`);
  return n;
}
const lotOf = (v: unknown) => (optStr(v, 60) ?? "").toUpperCase();
const refOf = (v: unknown) => {
  const s = optStr(v, 80);
  if (s && !/^[A-Za-z0-9_.:-]{6,80}$/.test(s)) throw badRequest("Scan/retry reference must be 6–80 letters, digits or . _ : -");
  return s;
};

export const CHARGE_LABEL: Record<string, string> = {
  storage_unit_day: "Storage (unit-days)", handling_in_unit: "Handling in (units)",
  handling_out_unit: "Handling out (units)", outbound_order: "Outbound order fee",
};

// ───────────────────────── setup: warehouses, locations, SKUs
export async function createWarehouse(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  try {
    const r = await c.query<{ id: string }>(`INSERT INTO warehouses(tenant_id,code,name,address) VALUES ($1,$2,$3,$4) RETURNING id`,
      [ctx.tenantId, reqStr(f.code, "Code", 20).toUpperCase(), reqStr(f.name, "Name", 120), optStr(f.address, 300)]);
    await audit(c, ctx.tenantId, actorOf(ctx), "warehouse.created", "warehouse", r.rows[0].id);
    return r.rows[0].id;
  } catch (e: any) {
    if (String(e.message).includes("warehouses_tenant_id_code_key")) throw badRequest("A warehouse with that code already exists.");
    throw e;
  }
}

export async function createLocation(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM warehouses WHERE id=$1 AND active`, [f.warehouse_id]), "Warehouse");
  const kind = ["receiving", "storage", "quarantine"].includes(f.kind) ? f.kind : "storage";
  const cap = String(f.capacity_units ?? "").trim() === "" ? null : qtyOf(f.capacity_units, "Capacity");
  try {
    const r = await c.query<{ id: string }>(`INSERT INTO wh_locations(tenant_id,warehouse_id,code,kind,capacity_units) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.tenantId, f.warehouse_id, reqStr(f.code, "Location code", 30).toUpperCase(), kind, cap]);
    await audit(c, ctx.tenantId, actorOf(ctx), "wh_location.created", "wh_location", r.rows[0].id, { kind });
    return r.rows[0].id;
  } catch (e: any) {
    if (String(e.message).includes("wh_locations_tenant_id_warehouse_id_code_key")) throw badRequest("That location code already exists in this warehouse.");
    throw e;
  }
}

export async function createSku(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const owner = await must(c.query<any>(`SELECT kind FROM parties WHERE id=$1`, [f.owner_id]), "Owner");
  if (owner.kind !== "customer") throw badRequest("Stock is held for a customer; choose a customer as the owner.");
  try {
    const r = await c.query<{ id: string }>(`INSERT INTO wh_skus(tenant_id,owner_id,code,description,uom) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.tenantId, f.owner_id, reqStr(f.code, "SKU code", 60).toUpperCase(), reqStr(f.description, "Description", 200), optStr(f.uom, 20) ?? "unit"]);
    await audit(c, ctx.tenantId, actorOf(ctx), "wh_sku.created", "wh_sku", r.rows[0].id);
    return r.rows[0].id;
  } catch (e: any) {
    if (String(e.message).includes("wh_skus_tenant_id_owner_id_code_key")) throw badRequest("That owner already has a SKU with this code.");
    throw e;
  }
}

export const listWarehouses = (c: Conn) => c.query<any>(`SELECT * FROM warehouses WHERE active ORDER BY code`).then((r) => r.rows);
export const listLocations = (c: Conn, warehouseId?: string | null) => c.query<any>(
  `SELECT l.*, w.code AS warehouse_code,
     (SELECT coalesce(sum(qty_on_hand),0) FROM wh_stock s WHERE s.location_id=l.id) AS units
   FROM wh_locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE l.active AND ($1::uuid IS NULL OR l.warehouse_id=$1)
   ORDER BY w.code, l.code`, [warehouseId ?? null]).then((r) => r.rows);
export const listSkus = (c: Conn, ownerId?: string | null) => c.query<any>(
  `SELECT s.*, p.name AS owner_name FROM wh_skus s JOIN parties p ON p.id=s.owner_id WHERE s.active AND ($1::uuid IS NULL OR s.owner_id=$1) ORDER BY p.name, s.code`,
  [ownerId ?? null]).then((r) => r.rows);

// ───────────────────────── the one place stock changes
type MoveKind = "receipt" | "dispatch" | "transfer_out" | "transfer_in" | "adjust";
interface Post {
  ownerId: string; skuId: string; locationId: string; lot: string; delta: number; kind: MoveKind;
  groupId?: string | null; refType?: string; refId?: string; reason?: string | null; clientRef?: string | null; ageFrom?: string | null;
}

/**
 * Has this scan/retry reference already posted? Checked *before* business rules, so a retry of a receipt that completed its
 * line is reported as a repeat — not rejected as an over-receipt. The advisory lock serialises concurrent repeats.
 */
async function alreadyPosted(c: Conn, ctx: Ctx, clientRef: string | null): Promise<boolean> {
  if (!clientRef) return false;
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${ctx.tenantId}:wh:${clientRef}`]);
  return (await c.query(`SELECT 1 FROM wh_movements WHERE client_ref=$1`, [clientRef])).rows.length > 0;
}

/**
 * Apply one ledger movement and its balance change atomically. Guarantees:
 *  - a client reference posts at most once (serialised by an advisory lock; a repeat is reported, never re-applied);
 *  - stock cannot go negative, and cannot drop below what is reserved for outbound orders;
 *  - a location with a capacity cannot be overfilled;
 *  - the movement row is immutable, so every balance can be explained from the ledger.
 */
async function post(c: Conn, ctx: Ctx, p: Post): Promise<{ id: string; duplicate: boolean }> {
  if (p.clientRef) {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${ctx.tenantId}:wh:${p.clientRef}`]);
    const dup = await c.query<any>(`SELECT id FROM wh_movements WHERE client_ref=$1`, [p.clientRef]);
    if (dup.rows.length) return { id: dup.rows[0].id, duplicate: true };
  }
  await c.query(
    `INSERT INTO wh_stock(tenant_id,owner_id,sku_id,location_id,lot,qty_on_hand,first_received_at)
     VALUES ($1,$2,$3,$4,$5,0,coalesce($6::timestamptz, now())) ON CONFLICT (tenant_id,owner_id,sku_id,location_id,lot) DO NOTHING`,
    [ctx.tenantId, p.ownerId, p.skuId, p.locationId, p.lot, p.ageFrom ?? null]);
  const st = (await c.query<any>(
    `SELECT s.*, l.code AS loc_code, l.capacity_units FROM wh_stock s JOIN wh_locations l ON l.id=s.location_id
     WHERE s.owner_id=$1 AND s.sku_id=$2 AND s.location_id=$3 AND s.lot=$4 FOR UPDATE OF s`, [p.ownerId, p.skuId, p.locationId, p.lot])).rows[0];
  const onHand = Number(st.qty_on_hand), reserved = Number(st.qty_reserved), next = r3(onHand + p.delta);
  if (next < 0) throw badRequest(`Only ${onHand} on hand at ${st.loc_code}; cannot remove ${-p.delta}.`);
  if (next < reserved) throw badRequest(`${reserved} at ${st.loc_code} is reserved for outbound orders; only ${r3(onHand - reserved)} is free.`);
  if (p.delta > 0 && st.capacity_units != null) {
    const used = Number((await c.query<any>(`SELECT coalesce(sum(qty_on_hand),0) n FROM wh_stock WHERE location_id=$1`, [p.locationId])).rows[0].n);
    if (r3(used + p.delta) > Number(st.capacity_units)) throw badRequest(`${st.loc_code} would exceed its capacity of ${Number(st.capacity_units)} units (${used} already in place).`);
  }
  await c.query(
    `UPDATE wh_stock SET qty_on_hand = qty_on_hand + $2,
       first_received_at = CASE WHEN $3::boolean THEN (CASE WHEN qty_on_hand = 0 THEN coalesce($4::timestamptz, now()) ELSE least(first_received_at, coalesce($4::timestamptz, first_received_at)) END) ELSE first_received_at END
     WHERE id=$1`, [st.id, p.delta, p.delta > 0, p.ageFrom ?? null]);
  const m = await c.query<{ id: string }>(
    `INSERT INTO wh_movements(tenant_id,owner_id,sku_id,location_id,lot,qty_delta,kind,group_id,ref_type,ref_id,reason,client_ref,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [ctx.tenantId, p.ownerId, p.skuId, p.locationId, p.lot, p.delta, p.kind, p.groupId ?? null, p.refType ?? null, p.refId ?? null, p.reason ?? null, p.clientRef ?? null, ctx.userId]);
  return { id: m.rows[0].id, duplicate: false };
}

// ───────────────────────── billing accrual (shared by receive/dispatch/storage)
const rateFor = async (c: Conn, ownerId: string, type: string, onDay: string) =>
  (await c.query<any>(`SELECT unit_minor, tax_code FROM wh_rates WHERE owner_id=$1 AND charge_type=$2 AND effective_from <= $3 ORDER BY effective_from DESC LIMIT 1`, [ownerId, type, onDay])).rows[0] ?? null;

/** One charge per source event. No rate card yet → kept as *unrated* (priced when a rate arrives), never dropped. */
async function accrue(c: Conn, tenantId: string, a: { ownerId: string; type: string; qty: number; onDay: string; ref: string; description: string }) {
  if (!(a.qty > 0)) return;
  const rate = await rateFor(c, a.ownerId, a.type, a.onDay);
  await c.query(
    `INSERT INTO wh_charges(tenant_id,owner_id,charge_type,description,qty,unit_minor,tax_code,occurred_on,source_ref,unrated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id, source_ref) DO NOTHING`,
    [tenantId, a.ownerId, a.type, a.description, a.qty, rate ? rate.unit_minor : 0, rate?.tax_code ?? "SR5", a.onDay, a.ref, !rate]);
}

// ───────────────────────── inbound
export interface InboundInput { owner_id: string; warehouse_id: string; customer_ref?: string; expected_on?: string; notes?: string; lines: { sku_id: string; qty: string | number }[] }

export async function createInbound(c: Conn, ctx: Ctx, f: InboundInput) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const owner = await must(c.query<any>(`SELECT kind FROM parties WHERE id=$1`, [f.owner_id]), "Owner");
  if (owner.kind !== "customer") throw badRequest("Goods are received for a customer.");
  await must(c.query(`SELECT id FROM warehouses WHERE id=$1 AND active`, [f.warehouse_id]), "Warehouse");
  const lines = (f.lines ?? []).filter((l) => l.sku_id);
  if (!lines.length) throw badRequest("Add at least one expected SKU.");
  if (new Set(lines.map((l) => l.sku_id)).size !== lines.length) throw badRequest("Each SKU can appear once on a notice; add the quantities together.");
  for (const l of lines) {
    const s = await must(c.query<any>(`SELECT owner_id, active FROM wh_skus WHERE id=$1`, [l.sku_id]), "SKU");
    if (s.owner_id !== f.owner_id) throw badRequest("A SKU on the notice belongs to a different owner.");
    if (!s.active) throw badRequest("A SKU on the notice is inactive.");
  }
  const expectedOn = optStr(f.expected_on, 10);
  if (expectedOn && (!/^\d{4}-\d{2}-\d{2}$/.test(expectedOn) || Number.isNaN(Date.parse(expectedOn)))) throw badRequest("Expected date is not valid.");
  const no = await nextNumber(c, ctx.tenantId, "wh_inbound", "INB");
  const r = await c.query<{ id: string }>(
    `INSERT INTO wh_inbound(tenant_id,no,owner_id,warehouse_id,customer_ref,expected_on,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, no, f.owner_id, f.warehouse_id, optStr(f.customer_ref, 80), expectedOn, optStr(f.notes, 500), ctx.userId]);
  const id = r.rows[0].id;
  // billing unit: one warehouse order; the reference makes a retry idempotent
  await consumeQuota(c, ctx.tenantId, "wh_orders_per_month", `wh_in:${id}`);
  for (const l of lines) {
    await c.query(`INSERT INTO wh_inbound_lines(tenant_id,inbound_id,owner_id,sku_id,qty_expected) VALUES ($1,$2,$3,$4,$5)`,
      [ctx.tenantId, id, f.owner_id, l.sku_id, qtyOf(l.qty, "Expected quantity")]);
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_inbound.created", "wh_inbound", id, { no, lines: lines.length });
  return { id, no };
}

/** Receive some or all of a line. Damaged goods go to quarantine; over-receipt needs an explicit acceptance. */
export async function receiveLine(c: Conn, ctx: Ctx, lineId: string, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const clientRef = refOf(f.client_ref);
  if (await alreadyPosted(c, ctx, clientRef)) return { duplicate: true as const };
  const line = await must(c.query<any>(
    `SELECT l.*, i.status AS inbound_status, i.warehouse_id, i.no AS inbound_no FROM wh_inbound_lines l JOIN wh_inbound i ON i.id=l.inbound_id WHERE l.id=$1 FOR UPDATE OF l`, [lineId]), "Notice line");
  if (!["expected", "receiving"].includes(line.inbound_status)) throw badRequest(`Notice ${line.inbound_no} is ${line.inbound_status}; it no longer accepts receipts.`);
  const loc = await must(c.query<any>(`SELECT * FROM wh_locations WHERE id=$1`, [f.location_id]), "Location");
  if (!loc.active) throw badRequest(`Location ${loc.code} is inactive.`);
  if (loc.warehouse_id !== line.warehouse_id) throw badRequest("That location is in a different warehouse than the notice.");
  const damaged = f.condition === "damaged";
  if (damaged && loc.kind !== "quarantine") throw badRequest("Damaged goods must be received into a quarantine location.");
  if (!damaged && loc.kind === "quarantine") throw badRequest("Good-condition goods are not received into quarantine; mark them damaged or choose another location.");
  const qty = qtyOf(f.qty, "Quantity received");
  const sofar = r3(Number(line.qty_received) + Number(line.qty_damaged));
  const over = r3(sofar + qty) > Number(line.qty_expected);
  if (over && f.accept_over !== "1") throw badRequest(`Receiving ${qty} would exceed the ${Number(line.qty_expected)} expected (${sofar} already received). Tick "accept over-receipt" if the extra goods are really here.`);
  const m = await post(c, ctx, { ownerId: line.owner_id, skuId: line.sku_id, locationId: loc.id, lot: lotOf(f.lot), delta: qty, kind: "receipt",
    refType: "wh_inbound", refId: line.inbound_id, reason: damaged ? "damaged on receipt" : null, clientRef });
  if (m.duplicate) return { duplicate: true as const };
  await c.query(`UPDATE wh_inbound_lines SET ${damaged ? "qty_damaged" : "qty_received"} = ${damaged ? "qty_damaged" : "qty_received"} + $2 WHERE id=$1`, [lineId, qty]);
  await c.query(`UPDATE wh_inbound SET status='receiving' WHERE id=$1 AND status='expected'`, [line.inbound_id]);
  await accrue(c, ctx.tenantId, { ownerId: line.owner_id, type: "handling_in_unit", qty, onDay: dubaiDay(), ref: `mv:${m.id}`, description: `Handling in ${line.inbound_no}` });
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_inbound.received", "wh_inbound", line.inbound_id, { lineId, qty, damaged, over });
  return { duplicate: false as const, movementId: m.id };
}

export async function closeInbound(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  const i = await must(c.query<any>(`SELECT * FROM wh_inbound WHERE id=$1 FOR UPDATE`, [id]), "Notice");
  if (i.status === "expected") throw badRequest("Nothing has been received. Cancel the notice instead.");
  if (i.status !== "receiving") throw badRequest(`Notice is ${i.status}.`);
  const lines = (await c.query<any>(`SELECT l.*, s.code FROM wh_inbound_lines l JOIN wh_skus s ON s.id=l.sku_id WHERE l.inbound_id=$1`, [id])).rows;
  const variances = lines.map((l) => ({ sku: l.code, expected: Number(l.qty_expected), received: r3(Number(l.qty_received) + Number(l.qty_damaged)), damaged: Number(l.qty_damaged) }))
    .filter((v) => v.received !== v.expected || v.damaged > 0);
  await c.query(`UPDATE wh_inbound SET status='received', closed_at=now() WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_inbound.closed", "wh_inbound", id, { variances });
  return { variances };
}

export async function cancelInbound(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  await must(c.query(`UPDATE wh_inbound SET status='cancelled', closed_at=now() WHERE id=$1 AND status='expected' RETURNING id`, [id]), "Notice that has not started receiving");
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_inbound.cancelled", "wh_inbound", id);
}

// ───────────────────────── moves / put-away / quarantine
/** Move free stock to another location in the same warehouse: two ledger legs sharing a group id. */
export async function moveStock(c: Conn, ctx: Ctx, f: { stock_id: string; to_location_id: string; qty: string | number; client_ref?: string }) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const base = refOf(f.client_ref);
  if (await alreadyPosted(c, ctx, base ? `${base}:out` : null)) return { duplicate: true as const };
  const st = await must(c.query<any>(
    `SELECT s.*, l.kind AS from_kind, l.warehouse_id, l.code AS from_code FROM wh_stock s JOIN wh_locations l ON l.id=s.location_id WHERE s.id=$1 FOR UPDATE OF s`, [f.stock_id]), "Stock");
  const to = await must(c.query<any>(`SELECT * FROM wh_locations WHERE id=$1`, [f.to_location_id]), "Destination");
  if (!to.active) throw badRequest(`Location ${to.code} is inactive.`);
  if (to.id === st.location_id) throw badRequest("The destination is the same location.");
  if (to.warehouse_id !== st.warehouse_id) throw badRequest("Moves stay inside one warehouse.");
  const qty = qtyOf(f.qty, "Quantity");
  const free = r3(Number(st.qty_on_hand) - Number(st.qty_reserved));
  if (qty > free) throw badRequest(`Only ${free} is free to move (${Number(st.qty_reserved)} is reserved for outbound orders).`);
  // leaving quarantine is a release decision, not a routine move
  if (st.from_kind === "quarantine" && to.kind !== "quarantine") require(ctx, "wh.approve");
  const gid = (await c.query<any>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
  const out = await post(c, ctx, { ownerId: st.owner_id, skuId: st.sku_id, locationId: st.location_id, lot: st.lot, delta: -qty, kind: "transfer_out", groupId: gid, refType: "move", reason: `to ${to.code}`, clientRef: base ? `${base}:out` : null });
  if (out.duplicate) return { duplicate: true as const };
  await post(c, ctx, { ownerId: st.owner_id, skuId: st.sku_id, locationId: to.id, lot: st.lot, delta: qty, kind: "transfer_in", groupId: gid, refType: "move", reason: `from ${st.from_code}`, clientRef: base ? `${base}:in` : null, ageFrom: st.first_received_at });
  await audit(c, ctx.tenantId, actorOf(ctx), st.from_kind === "quarantine" && to.kind !== "quarantine" ? "wh_stock.released_from_quarantine" : "wh_stock.moved", "wh_stock", st.id, { qty, from: st.from_code, to: to.code });
  return { duplicate: false as const };
}

// ───────────────────────── outbound
export interface OutboundInput { owner_id: string; warehouse_id: string; ship_to: string; customer_ref?: string; required_by?: string; lines: { sku_id: string; qty: string | number }[] }

export async function createOutbound(c: Conn, ctx: Ctx, f: OutboundInput) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const owner = await must(c.query<any>(`SELECT kind FROM parties WHERE id=$1`, [f.owner_id]), "Owner");
  if (owner.kind !== "customer") throw badRequest("Goods are dispatched for a customer.");
  await must(c.query(`SELECT id FROM warehouses WHERE id=$1 AND active`, [f.warehouse_id]), "Warehouse");
  const lines = (f.lines ?? []).filter((l) => l.sku_id);
  if (!lines.length) throw badRequest("Add at least one SKU to dispatch.");
  if (new Set(lines.map((l) => l.sku_id)).size !== lines.length) throw badRequest("Each SKU can appear once on an order; add the quantities together.");
  for (const l of lines) {
    const s = await must(c.query<any>(`SELECT owner_id, active FROM wh_skus WHERE id=$1`, [l.sku_id]), "SKU");
    if (s.owner_id !== f.owner_id) throw badRequest("A SKU on the order belongs to a different owner.");
    if (!s.active) throw badRequest("A SKU on the order is inactive.");
  }
  const no = await nextNumber(c, ctx.tenantId, "wh_outbound", "OUT");
  const req = f.required_by ? (/[zZ]|[+-]\d\d:?\d\d$/.test(f.required_by) ? f.required_by : `${f.required_by.length === 16 ? f.required_by + ":00" : f.required_by}+04:00`) : null;
  if (req && Number.isNaN(Date.parse(req))) throw badRequest("Required-by date is not valid.");
  const r = await c.query<{ id: string }>(
    `INSERT INTO wh_outbound(tenant_id,no,owner_id,warehouse_id,ship_to,customer_ref,required_by,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, no, f.owner_id, f.warehouse_id, reqStr(f.ship_to, "Ship-to address", 300), optStr(f.customer_ref, 80), req, ctx.userId]);
  const id = r.rows[0].id;
  await consumeQuota(c, ctx.tenantId, "wh_orders_per_month", `wh_out:${id}`);
  for (const l of lines) {
    await c.query(`INSERT INTO wh_outbound_lines(tenant_id,outbound_id,owner_id,sku_id,qty_ordered) VALUES ($1,$2,$3,$4,$5)`,
      [ctx.tenantId, id, f.owner_id, l.sku_id, qtyOf(l.qty, "Quantity")]);
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_outbound.created", "wh_outbound", id, { no, lines: lines.length });
  return { id, no };
}

/**
 * Reserve free stock, oldest first (FIFO), from storage locations of the order's warehouse. Quarantine and receiving
 * stock is never allocated. All-or-nothing unless the operator accepts a partial shipment; a failure reserves nothing.
 */
export async function allocateOutbound(c: Conn, ctx: Ctx, id: string, opts: { allowPartial?: boolean } = {}) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const o = await must(c.query<any>(`SELECT * FROM wh_outbound WHERE id=$1 FOR UPDATE`, [id]), "Order");
  if (o.status !== "new") throw badRequest(`Order is ${o.status}.`);
  const lines = (await c.query<any>(`SELECT l.*, s.code FROM wh_outbound_lines l JOIN wh_skus s ON s.id=l.sku_id WHERE l.outbound_id=$1 ORDER BY s.code`, [id])).rows;
  const plan: { lineId: string; stockId: string; qty: number }[] = [], shorts: string[] = [];
  const got = new Map<string, number>();
  for (const l of lines) {
    let need = Number(l.qty_ordered), have = 0;
    const cand = (await c.query<any>(
      `SELECT s.id, s.qty_on_hand, s.qty_reserved FROM wh_stock s JOIN wh_locations loc ON loc.id=s.location_id
       WHERE s.owner_id=$1 AND s.sku_id=$2 AND loc.warehouse_id=$3 AND loc.kind='storage' AND loc.active AND s.qty_on_hand > s.qty_reserved
       ORDER BY s.first_received_at, loc.code, s.id FOR UPDATE OF s`, [o.owner_id, l.sku_id, o.warehouse_id])).rows;
    for (const s of cand) {
      if (need <= 0) break;
      const take = Math.min(need, r3(Number(s.qty_on_hand) - Number(s.qty_reserved)));
      if (take > 0) { plan.push({ lineId: l.id, stockId: s.id, qty: take }); need = r3(need - take); have = r3(have + take); }
    }
    got.set(l.id, have);
    if (need > 0) shorts.push(`${l.code} short by ${need}`);
  }
  if (shorts.length && !opts.allowPartial) throw badRequest(`Not enough free stock: ${shorts.join(", ")}. Nothing was reserved. Allocate a partial shipment, or receive more stock first.`);
  if (!plan.length) throw badRequest("There is no free stock for any line of this order.");
  for (const p of plan) {
    await c.query(`UPDATE wh_stock SET qty_reserved = qty_reserved + $2 WHERE id=$1`, [p.stockId, p.qty]);
    await c.query(`INSERT INTO wh_allocations(tenant_id,line_id,stock_id,qty) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, p.lineId, p.stockId, p.qty]);
  }
  for (const [lineId, qty] of got) await c.query(`UPDATE wh_outbound_lines SET qty_allocated=$2 WHERE id=$1`, [lineId, qty]);
  await c.query(`UPDATE wh_outbound SET status='allocated' WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_outbound.allocated", "wh_outbound", id, { short: shorts });
  return { short: shorts };
}

/** Confirm what was physically picked. A short pick releases the difference at once and is the trigger for a count. */
export async function confirmPick(c: Conn, ctx: Ctx, id: string, picked: Record<string, string | number>) {
  require(ctx, "wh.write");
  const o = await must(c.query<any>(`SELECT * FROM wh_outbound WHERE id=$1 FOR UPDATE`, [id]), "Order");
  if (o.status !== "allocated") throw badRequest(`Order is ${o.status}; picking applies to allocated orders.`);
  const allocs = (await c.query<any>(
    `SELECT a.*, l.outbound_id FROM wh_allocations a JOIN wh_outbound_lines l ON l.id=a.line_id WHERE l.outbound_id=$1 AND a.status='reserved' FOR UPDATE OF a`, [id])).rows;
  let total = 0, shortAny = false;
  const perLine = new Map<string, number>();
  for (const a of allocs) {
    const want = Number(a.qty);
    const got = picked[a.id] === undefined || String(picked[a.id]).trim() === "" ? want : qtyOf(picked[a.id], "Picked quantity", true);
    if (got > want) throw badRequest(`Cannot pick more than the ${want} reserved.`);
    if (got < want) { shortAny = true; await c.query(`UPDATE wh_stock SET qty_reserved = qty_reserved - $2 WHERE id=$1`, [a.stock_id, r3(want - got)]); }
    await c.query(`UPDATE wh_allocations SET qty=$2, status=$3, picked_by=$4, picked_at=now() WHERE id=$1`, [a.id, got, got > 0 ? "picked" : "released", ctx.userId]);
    perLine.set(a.line_id, r3((perLine.get(a.line_id) ?? 0) + got));
    total = r3(total + got);
  }
  if (total <= 0) throw badRequest("Nothing was picked. Cancel the order if the stock cannot be found, then raise a count.");
  for (const [lineId, qty] of perLine) await c.query(`UPDATE wh_outbound_lines SET qty_picked=$2 WHERE id=$1`, [lineId, qty]);
  await c.query(`UPDATE wh_outbound SET status='picked' WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_outbound.picked", "wh_outbound", id, { total, short: shortAny });
  return { short: shortAny };
}

/** Dispatch ships exactly what was picked and posts the ledger movements; the unshipped remainder is closed (no backorders yet). */
export async function dispatchOutbound(c: Conn, ctx: Ctx, id: string, f: { carrier_ref?: string } = {}) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const o = await must(c.query<any>(`SELECT * FROM wh_outbound WHERE id=$1 FOR UPDATE`, [id]), "Order");
  if (o.status !== "picked") throw badRequest(`Order is ${o.status}; only picked orders can be dispatched.`);
  const allocs = (await c.query<any>(
    `SELECT a.*, s.owner_id, s.sku_id, s.location_id, s.lot, l.id AS line_id FROM wh_allocations a
     JOIN wh_stock s ON s.id=a.stock_id JOIN wh_outbound_lines l ON l.id=a.line_id
     WHERE l.outbound_id=$1 AND a.status='picked' ORDER BY a.id`, [id])).rows;
  const shipped = new Map<string, number>();
  for (const a of allocs) {
    const qty = Number(a.qty);
    await c.query(`UPDATE wh_stock SET qty_reserved = qty_reserved - $2 WHERE id=$1`, [a.stock_id, qty]);   // release the reservation, then take the stock
    await post(c, ctx, { ownerId: a.owner_id, skuId: a.sku_id, locationId: a.location_id, lot: a.lot, delta: -qty, kind: "dispatch", refType: "wh_outbound", refId: id, clientRef: null });
    await c.query(`UPDATE wh_allocations SET status='shipped' WHERE id=$1`, [a.id]);
    shipped.set(a.line_id, r3((shipped.get(a.line_id) ?? 0) + qty));
  }
  const day = dubaiDay();
  for (const [lineId, qty] of shipped) {
    await c.query(`UPDATE wh_outbound_lines SET qty_dispatched=$2 WHERE id=$1`, [lineId, qty]);
    await accrue(c, ctx.tenantId, { ownerId: o.owner_id, type: "handling_out_unit", qty, onDay: day, ref: `out-line:${lineId}`, description: `Handling out ${o.no}` });
  }
  await accrue(c, ctx.tenantId, { ownerId: o.owner_id, type: "outbound_order", qty: 1, onDay: day, ref: `out-order:${id}`, description: `Outbound order ${o.no}` });
  await c.query(`UPDATE wh_outbound SET status='dispatched', dispatched_at=now(), carrier_ref=$2 WHERE id=$1`, [id, optStr(f.carrier_ref, 80)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_outbound.dispatched", "wh_outbound", id);
}

export async function cancelOutbound(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  const o = await must(c.query<any>(`SELECT * FROM wh_outbound WHERE id=$1 FOR UPDATE`, [id]), "Order");
  if (!["new", "allocated", "picked"].includes(o.status)) throw badRequest(`A ${o.status} order cannot be cancelled.`);
  const allocs = (await c.query<any>(
    `SELECT a.* FROM wh_allocations a JOIN wh_outbound_lines l ON l.id=a.line_id WHERE l.outbound_id=$1 AND a.status IN ('reserved','picked') FOR UPDATE OF a`, [id])).rows;
  for (const a of allocs) {
    await c.query(`UPDATE wh_stock SET qty_reserved = qty_reserved - $2 WHERE id=$1`, [a.stock_id, Number(a.qty)]);
    await c.query(`UPDATE wh_allocations SET status='released' WHERE id=$1`, [a.id]);
  }
  await c.query(`UPDATE wh_outbound SET status='cancelled' WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_outbound.cancelled", "wh_outbound", id, { released: allocs.length });
}

// ───────────────────────── cycle counts
/**
 * Cut a count sheet: a snapshot of system quantity per stock row. Counters do not see the system quantity (blind count);
 * variances are decided by someone else, and only if the stock has not moved since the snapshot.
 */
export async function startCount(c: Conn, ctx: Ctx, f: { warehouse_id: string; location_id?: string }) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM warehouses WHERE id=$1 AND active`, [f.warehouse_id]), "Warehouse");
  const loc = f.location_id ? String(f.location_id) : null;
  if (loc) {
    const l = await must(c.query<any>(`SELECT warehouse_id FROM wh_locations WHERE id=$1`, [loc]), "Location");
    if (l.warehouse_id !== f.warehouse_id) throw badRequest("That location is in a different warehouse.");
  }
  const clash = await c.query(`SELECT no FROM wh_counts WHERE warehouse_id=$1 AND status IN ('open','submitted') AND (location_id IS NULL OR $2::uuid IS NULL OR location_id=$2)`, [f.warehouse_id, loc]);
  if (clash.rows.length) throw badRequest(`Count ${clash.rows[0].no} is already open for this area. Finish it first.`);
  const stock = (await c.query<any>(
    `SELECT s.* FROM wh_stock s JOIN wh_locations l ON l.id=s.location_id WHERE l.warehouse_id=$1 AND ($2::uuid IS NULL OR s.location_id=$2) AND s.qty_on_hand > 0 ORDER BY l.code, s.sku_id, s.lot`, [f.warehouse_id, loc])).rows;
  if (!stock.length && !loc) throw badRequest("There is no stock in this warehouse to count. Count a location to record stock found there.");
  const no = await nextNumber(c, ctx.tenantId, "wh_count", "CNT");
  const r = await c.query<{ id: string }>(`INSERT INTO wh_counts(tenant_id,no,warehouse_id,location_id,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.tenantId, no, f.warehouse_id, loc, ctx.userId]);
  for (const s of stock) {
    await c.query(`INSERT INTO wh_count_lines(tenant_id,count_id,owner_id,sku_id,location_id,lot,system_qty) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, r.rows[0].id, s.owner_id, s.sku_id, s.location_id, s.lot, Number(s.qty_on_hand)]);
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_count.started", "wh_count", r.rows[0].id, { no, lines: stock.length });
  return { id: r.rows[0].id, no };
}

export async function recordCount(c: Conn, ctx: Ctx, lineId: string, qty: string | number) {
  require(ctx, "wh.write");
  const l = await must(c.query<any>(`SELECT l.*, k.status AS count_status FROM wh_count_lines l JOIN wh_counts k ON k.id=l.count_id WHERE l.id=$1 FOR UPDATE OF l`, [lineId]), "Count line");
  if (l.count_status !== "open") throw badRequest(`The count is ${l.count_status}; lines can no longer be changed.`);
  if (!["pending", "counted"].includes(l.status)) throw badRequest("This line is already decided.");
  await c.query(`UPDATE wh_count_lines SET counted_qty=$2, status='counted', counted_by=$3 WHERE id=$1`, [lineId, qtyOf(qty, "Counted quantity", true), ctx.userId]);
}

/** Stock found where the system expected none (or a SKU/lot that was not on the sheet). */
export async function addFoundLine(c: Conn, ctx: Ctx, countId: string, f: Record<string, any>) {
  require(ctx, "wh.write");
  const k = await must(c.query<any>(`SELECT * FROM wh_counts WHERE id=$1 FOR UPDATE`, [countId]), "Count");
  if (k.status !== "open") throw badRequest(`The count is ${k.status}.`);
  const loc = await must(c.query<any>(`SELECT * FROM wh_locations WHERE id=$1`, [f.location_id]), "Location");
  if (loc.warehouse_id !== k.warehouse_id || (k.location_id && k.location_id !== loc.id)) throw badRequest("That location is outside this count.");
  const sku = await must(c.query<any>(`SELECT * FROM wh_skus WHERE id=$1`, [f.sku_id]), "SKU");
  const lot = lotOf(f.lot);
  const have = await c.query(`SELECT 1 FROM wh_count_lines WHERE count_id=$1 AND sku_id=$2 AND location_id=$3 AND lot=$4`, [countId, sku.id, loc.id, lot]);
  if (have.rows.length) throw badRequest("That SKU/lot is already on the sheet for this location; enter its quantity there.");
  const cur = (await c.query<any>(`SELECT qty_on_hand FROM wh_stock WHERE owner_id=$1 AND sku_id=$2 AND location_id=$3 AND lot=$4`, [sku.owner_id, sku.id, loc.id, lot])).rows[0];
  await c.query(`INSERT INTO wh_count_lines(tenant_id,count_id,owner_id,sku_id,location_id,lot,system_qty,counted_qty,status,counted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'counted',$9)`,
    [ctx.tenantId, countId, sku.owner_id, sku.id, loc.id, lot, cur ? Number(cur.qty_on_hand) : 0, qtyOf(f.qty, "Found quantity"), ctx.userId]);
}

export async function submitCount(c: Conn, ctx: Ctx, countId: string) {
  require(ctx, "wh.write");
  const k = await must(c.query<any>(`SELECT * FROM wh_counts WHERE id=$1 FOR UPDATE`, [countId]), "Count");
  if (k.status !== "open") throw badRequest(`The count is ${k.status}.`);
  const pending = Number((await c.query<any>(`SELECT count(*) n FROM wh_count_lines WHERE count_id=$1 AND status='pending'`, [countId])).rows[0].n);
  if (pending) throw badRequest(`${pending} line(s) have not been counted. Count them (enter 0 if nothing is there) before submitting.`);
  // lines that match the system *now* and at the snapshot need no decision
  await c.query(
    `UPDATE wh_count_lines l SET status='approved', decided_at=now()
     WHERE l.count_id=$1 AND l.status='counted' AND l.counted_qty = l.system_qty
       AND l.system_qty = coalesce((SELECT s.qty_on_hand FROM wh_stock s WHERE s.owner_id=l.owner_id AND s.sku_id=l.sku_id AND s.location_id=l.location_id AND s.lot=l.lot), 0)`, [countId]);
  await c.query(`UPDATE wh_counts SET status='submitted', submitted_by=$2 WHERE id=$1`, [countId, ctx.userId]);
  await settleCount(c, countId);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_count.submitted", "wh_count", countId);
}

export async function cancelCount(c: Conn, ctx: Ctx, countId: string) {
  require(ctx, "wh.write");
  await must(c.query(`UPDATE wh_counts SET status='cancelled', closed_at=now() WHERE id=$1 AND status='open' RETURNING id`, [countId]), "Open count");
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_count.cancelled", "wh_count", countId);
}

/** After decisions: close when nothing awaits a decision; stale lines go back to the counters with a fresh snapshot. */
async function settleCount(c: Conn, countId: string) {
  const awaiting = Number((await c.query<any>(`SELECT count(*) n FROM wh_count_lines WHERE count_id=$1 AND status='counted'`, [countId])).rows[0].n);
  if (awaiting) return "submitted";
  const stale = (await c.query<any>(`SELECT id FROM wh_count_lines WHERE count_id=$1 AND status='stale'`, [countId])).rows;
  if (stale.length) {
    await c.query(
      `UPDATE wh_count_lines l SET status='pending', counted_qty=NULL, counted_by=NULL,
         system_qty = coalesce((SELECT s.qty_on_hand FROM wh_stock s WHERE s.owner_id=l.owner_id AND s.sku_id=l.sku_id AND s.location_id=l.location_id AND s.lot=l.lot), 0)
       WHERE l.count_id=$1 AND l.status='stale'`, [countId]);
    await c.query(`UPDATE wh_counts SET status='open', submitted_by=NULL WHERE id=$1`, [countId]);
    return "reopened";
  }
  await c.query(`UPDATE wh_counts SET status='closed', closed_at=now() WHERE id=$1`, [countId]);
  return "closed";
}

export type CountDecision = "approved" | "rejected" | "stale";

/**
 * Approve or reject one variance. The approver must not be the counter (owners excepted, and audited). If the stock moved
 * after the snapshot the count is no longer evidence of the current balance, so the line is sent back for a recount.
 */
export async function decideCountLine(c: Conn, ctx: Ctx, lineId: string, approve: boolean): Promise<{ outcome: CountDecision; delta?: number }> {
  require(ctx, "wh.approve");
  const l = await must(c.query<any>(
    `SELECT l.*, k.status AS count_status, k.no AS count_no FROM wh_count_lines l JOIN wh_counts k ON k.id=l.count_id WHERE l.id=$1 FOR UPDATE OF l`, [lineId]), "Count line");
  if (l.count_status !== "submitted") throw badRequest(`The count is ${l.count_status}; decisions apply to submitted counts.`);
  if (l.status !== "counted") throw badRequest(`This line is already ${l.status}; decisions are final.`);
  if (l.counted_by === ctx.userId && !ctx.roles.includes("owner")) throw forbidden("Count variances cannot be approved by the person who counted them.");
  let outcome: CountDecision, delta: number | undefined;
  if (!approve) {
    await c.query(`UPDATE wh_count_lines SET status='rejected', decided_by=$2, decided_at=now() WHERE id=$1`, [lineId, ctx.userId]);
    outcome = "rejected";
  } else {
    const cur = (await c.query<any>(
      `SELECT qty_on_hand FROM wh_stock WHERE owner_id=$1 AND sku_id=$2 AND location_id=$3 AND lot=$4 FOR UPDATE`, [l.owner_id, l.sku_id, l.location_id, l.lot])).rows[0];
    const now = cur ? Number(cur.qty_on_hand) : 0;
    if (r3(now) !== r3(Number(l.system_qty))) {
      await c.query(`UPDATE wh_count_lines SET status='stale', decided_by=$2, decided_at=now() WHERE id=$1`, [lineId, ctx.userId]);
      outcome = "stale";
    } else {
      delta = r3(Number(l.counted_qty) - now);
      let movementId: string | null = null;
      if (delta !== 0) {
        const m = await post(c, ctx, { ownerId: l.owner_id, skuId: l.sku_id, locationId: l.location_id, lot: l.lot, delta, kind: "adjust", refType: "wh_count", refId: l.count_id, reason: `Count ${l.count_no}` });
        movementId = m.id;
      }
      await c.query(`UPDATE wh_count_lines SET status='approved', decided_by=$2, decided_at=now(), movement_id=$3 WHERE id=$1`, [lineId, ctx.userId, movementId]);
      outcome = "approved";
    }
  }
  await audit(c, ctx.tenantId, actorOf(ctx), `wh_count.line_${outcome}`, "wh_count", l.count_id, { lineId, delta });
  await settleCount(c, l.count_id);
  return { outcome, delta };
}

// ───────────────────────── rates, storage accrual, invoicing
export async function setRate(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.bill");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.owner_id]), "Customer");
  if (!CHARGE_LABEL[f.charge_type]) throw badRequest("Choose a charge type.");
  const amount = toMinor(f.amount ?? "0");
  if (amount < 0) throw badRequest("A rate cannot be negative.");
  const from = String(f.effective_from || dubaiDay());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from))) throw badRequest("Effective date is not valid.");
  const have = (await c.query<any>(`SELECT id FROM wh_rates WHERE owner_id=$1 AND charge_type=$2 AND effective_from=$3`, [f.owner_id, f.charge_type, from])).rows[0];
  if (have && from < dubaiDay()) throw badRequest("A rate already in effect for that date cannot be edited. Add a new rate from a later date.");
  const tax = TAX_CODES[f.tax_code] ? f.tax_code : "SR5";
  await c.query(
    `INSERT INTO wh_rates(tenant_id,owner_id,charge_type,unit_minor,tax_code,effective_from,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id,owner_id,charge_type,effective_from) DO UPDATE SET unit_minor=EXCLUDED.unit_minor, tax_code=EXCLUDED.tax_code, created_by=EXCLUDED.created_by`,
    [ctx.tenantId, f.owner_id, f.charge_type, amount, tax, from, ctx.userId]);
  const priced = await repriceUnrated(c, ctx.tenantId, f.owner_id);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_rate.set", "party", f.owner_id, { type: f.charge_type, amount, from, priced });
  return { priced };
}

/** Price activity that happened before its rate card existed, using the rate effective on the day it happened. */
async function repriceUnrated(c: Conn, tenantId: string, ownerId: string) {
  const rows = (await c.query<any>(`SELECT id, charge_type, occurred_on FROM wh_charges WHERE owner_id=$1 AND unrated AND invoice_id IS NULL`, [ownerId])).rows;
  let n = 0;
  for (const g of rows) {
    const rate = await rateFor(c, ownerId, g.charge_type, String(g.occurred_on).slice(0, 10));
    if (!rate) continue;
    await c.query(`UPDATE wh_charges SET unit_minor=$2, tax_code=$3, unrated=false WHERE id=$1`, [g.id, rate.unit_minor, rate.tax_code]);
    n++;
  }
  return n;
}

/**
 * Daily storage: end-of-day units on hand per owner × the storage rate, for each *completed* company day not yet accrued.
 * Computed from the ledger so a backfill is exact, and idempotent per (owner, day). `now` is injectable for tests.
 */
export async function accrueStorage(c: Conn, ctx: Ctx, opts: { through?: string; now?: Date } = {}) {
  require(ctx, "wh.bill");
  await assertWritable(c, ctx.tenantId);
  const lastComplete = dubaiDay(new Date((opts.now ?? new Date()).getTime() - 86400_000));
  const through = opts.through && opts.through < lastComplete ? opts.through : lastComplete;
  const owners = (await c.query<any>(`SELECT owner_id, min(created_at) AS first FROM wh_movements GROUP BY owner_id`)).rows;
  let days = 0;
  for (const o of owners) {
    const lastAcc = (await c.query<any>(`SELECT max(occurred_on) AS d FROM wh_charges WHERE owner_id=$1 AND charge_type='storage_unit_day'`, [o.owner_id])).rows[0].d;
    const start = lastAcc ? addDays(String(lastAcc).slice(0, 10), 1) : dubaiDay(new Date(o.first));
    if (start > through) continue;
    const end = addDays(start, 92) < through ? addDays(start, 92) : through;     // at most ~3 months per run
    const rows = (await c.query<any>(
      `SELECT d::date::text AS day,
         (SELECT coalesce(sum(qty_delta),0) FROM wh_movements m WHERE m.owner_id=$1 AND m.created_at < (((d::date + 1)::timestamp - interval '4 hours') AT TIME ZONE 'UTC')) AS units
       FROM generate_series($2::timestamp, $3::timestamp, interval '1 day') d ORDER BY 1`, [o.owner_id, start, end])).rows;
    for (const r of rows) {
      const units = Number(r.units);
      if (units > 0) { await accrue(c, ctx.tenantId, { ownerId: o.owner_id, type: "storage_unit_day", qty: units, onDay: r.day, ref: `storage:${o.owner_id}:${r.day}`, description: `Storage ${r.day}` }); days++; }
    }
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_storage.accrued", "tenant", ctx.tenantId, { through, days });
  return { through, days };
}

/** Invoice one owner's rated, unbilled activity. Lines are grouped by charge type/rate/tax so storage is not 30 lines a month. */
export async function invoiceOwner(c: Conn, ctx: Ctx, ownerId: string, f: { through?: string } = {}, termsDays = 30) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1`, [ownerId]), "Customer");
  const through = f.through || dubaiDay();
  const charges = (await c.query<any>(
    `SELECT * FROM wh_charges WHERE owner_id=$1 AND invoice_id IS NULL AND NOT unrated AND occurred_on <= $2 ORDER BY occurred_on, id FOR UPDATE`, [ownerId, through])).rows;
  if (!charges.length) throw badRequest("No rated, unbilled warehouse activity for this customer up to that date.");
  const unrated = Number((await c.query<any>(`SELECT count(*) n FROM wh_charges WHERE owner_id=$1 AND unrated AND invoice_id IS NULL AND occurred_on <= $2`, [ownerId, through])).rows[0].n);
  type Group = { id: string; type: string; unit: number; tax: string; qty: number; ids: string[]; from: string; to: string };
  const groups = new Map<string, Group>();
  for (const g of charges) {
    const key = `${g.charge_type}|${g.unit_minor}|${g.tax_code}`, day = String(g.occurred_on).slice(0, 10);
    const x: Group = groups.get(key) ?? { id: key, type: g.charge_type, unit: Number(g.unit_minor), tax: g.tax_code, qty: 0, ids: [], from: day, to: day };
    x.qty = r3(x.qty + Number(g.qty)); x.ids.push(g.id); if (day < x.from) x.from = day; if (day > x.to) x.to = day;
    groups.set(key, x);
  }
  const ent = (await c.query<any>(`SELECT id FROM entities ORDER BY created_at LIMIT 1`)).rows[0];
  const run = (await c.query<{ id: string }>(`INSERT INTO wh_billing_runs(tenant_id,owner_id,through_on,created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.tenantId, ownerId, through, ctx.userId])).rows[0].id;
  const inv = await issueInvoice(c, ctx, {
    entityId: ent.id, partyId: ownerId, whRunId: run,
    lines: [...groups.values()].map((x) => ({ id: x.id, description: `${CHARGE_LABEL[x.type]}${x.from === x.to ? ` ${x.from}` : ` ${x.from} → ${x.to}`}`, qty: x.qty, unit_minor: x.unit, tax_code: x.tax })),
    markCharge: async (lineKey, invoiceId) => { await c.query(`UPDATE wh_charges SET invoice_id=$2 WHERE id = ANY($1::uuid[])`, [groups.get(lineKey)!.ids, invoiceId]); },
  }, termsDays);
  await c.query(`UPDATE wh_billing_runs SET invoice_id=$2 WHERE id=$1`, [run, inv.id]);
  return { ...inv, charges: charges.length, warnings: unrated ? [`${unrated} unrated activity line(s) were left out; set the missing rates to bill them.`] : [] };
}

// ───────────────────────── reading
export const listStock = (c: Conn, o: { ownerId?: string | null; warehouseId?: string | null; includeEmpty?: boolean } = {}) => c.query<any>(
  `SELECT s.*, p.name AS owner_name, k.code AS sku_code, k.description AS sku_desc, k.uom, l.code AS loc_code, l.kind AS loc_kind, w.code AS warehouse_code,
     (s.qty_on_hand - s.qty_reserved) AS qty_free
   FROM wh_stock s JOIN parties p ON p.id=s.owner_id JOIN wh_skus k ON k.id=s.sku_id JOIN wh_locations l ON l.id=s.location_id JOIN warehouses w ON w.id=l.warehouse_id
   WHERE ($1::uuid IS NULL OR s.owner_id=$1) AND ($2::uuid IS NULL OR l.warehouse_id=$2) AND ($3 OR s.qty_on_hand > 0)
   ORDER BY p.name, k.code, w.code, l.code, s.lot`, [o.ownerId ?? null, o.warehouseId ?? null, !!o.includeEmpty]).then((r) => r.rows);

export const listMovements = (c: Conn, o: { ownerId?: string | null; skuId?: string | null; limit?: number } = {}) => c.query<any>(
  `SELECT m.*, p.name AS owner_name, k.code AS sku_code, l.code AS loc_code, u.name AS by_name
   FROM wh_movements m JOIN parties p ON p.id=m.owner_id JOIN wh_skus k ON k.id=m.sku_id JOIN wh_locations l ON l.id=m.location_id LEFT JOIN team_members u ON u.user_id=m.created_by
   WHERE ($1::uuid IS NULL OR m.owner_id=$1) AND ($2::uuid IS NULL OR m.sku_id=$2) ORDER BY m.created_at DESC, m.id LIMIT $3`,
  [o.ownerId ?? null, o.skuId ?? null, Math.min(o.limit ?? 100, 500)]).then((r) => r.rows);

export const listInbound = (c: Conn) => c.query<any>(
  `SELECT i.*, p.name AS owner_name, w.code AS warehouse_code,
     (SELECT coalesce(sum(qty_expected),0) FROM wh_inbound_lines l WHERE l.inbound_id=i.id) AS expected,
     (SELECT coalesce(sum(qty_received+qty_damaged),0) FROM wh_inbound_lines l WHERE l.inbound_id=i.id) AS received
   FROM wh_inbound i JOIN parties p ON p.id=i.owner_id JOIN warehouses w ON w.id=i.warehouse_id ORDER BY i.created_at DESC`).then((r) => r.rows);

export async function getInbound(c: Conn, id: string) {
  const inbound = await must(c.query<any>(`SELECT i.*, p.name AS owner_name, w.code AS warehouse_code FROM wh_inbound i JOIN parties p ON p.id=i.owner_id JOIN warehouses w ON w.id=i.warehouse_id WHERE i.id=$1`, [id]), "Notice");
  const lines = (await c.query<any>(`SELECT l.*, s.code AS sku_code, s.description AS sku_desc, s.uom FROM wh_inbound_lines l JOIN wh_skus s ON s.id=l.sku_id WHERE l.inbound_id=$1 ORDER BY s.code`, [id])).rows;
  const moves = (await c.query<any>(`SELECT m.*, s.code AS sku_code, l.code AS loc_code FROM wh_movements m JOIN wh_skus s ON s.id=m.sku_id JOIN wh_locations l ON l.id=m.location_id WHERE m.ref_type='wh_inbound' AND m.ref_id=$1 ORDER BY m.created_at`, [id])).rows;
  const locations = (await c.query<any>(`SELECT * FROM wh_locations WHERE warehouse_id=$1 AND active ORDER BY kind, code`, [inbound.warehouse_id])).rows;
  return { inbound, lines, moves, locations };
}

export const listOutbound = (c: Conn) => c.query<any>(
  `SELECT o.*, p.name AS owner_name, w.code AS warehouse_code, (o.status IN ('new','allocated','picked') AND o.required_by < now()) AS late,
     (SELECT coalesce(sum(qty_ordered),0) FROM wh_outbound_lines l WHERE l.outbound_id=o.id) AS ordered,
     (SELECT coalesce(sum(qty_dispatched),0) FROM wh_outbound_lines l WHERE l.outbound_id=o.id) AS dispatched
   FROM wh_outbound o JOIN parties p ON p.id=o.owner_id JOIN warehouses w ON w.id=o.warehouse_id ORDER BY o.created_at DESC`).then((r) => r.rows);

export async function getOutbound(c: Conn, id: string) {
  const order = await must(c.query<any>(`SELECT o.*, p.name AS owner_name, w.code AS warehouse_code FROM wh_outbound o JOIN parties p ON p.id=o.owner_id JOIN warehouses w ON w.id=o.warehouse_id WHERE o.id=$1`, [id]), "Order");
  const lines = (await c.query<any>(`SELECT l.*, s.code AS sku_code, s.description AS sku_desc, s.uom FROM wh_outbound_lines l JOIN wh_skus s ON s.id=l.sku_id WHERE l.outbound_id=$1 ORDER BY s.code`, [id])).rows;
  const allocations = (await c.query<any>(
    `SELECT a.*, k.code AS sku_code, loc.code AS loc_code, s.lot FROM wh_allocations a JOIN wh_outbound_lines l ON l.id=a.line_id JOIN wh_skus k ON k.id=l.sku_id
     JOIN wh_stock s ON s.id=a.stock_id JOIN wh_locations loc ON loc.id=s.location_id WHERE l.outbound_id=$1 ORDER BY k.code, loc.code`, [id])).rows;
  return { order, lines, allocations };
}

export const listCounts = (c: Conn) => c.query<any>(
  `SELECT k.*, w.code AS warehouse_code, l.code AS loc_code,
     (SELECT count(*)::int FROM wh_count_lines x WHERE x.count_id=k.id) AS lines,
     (SELECT count(*)::int FROM wh_count_lines x WHERE x.count_id=k.id AND x.status='counted' AND x.counted_qty <> x.system_qty) AS variances
   FROM wh_counts k JOIN warehouses w ON w.id=k.warehouse_id LEFT JOIN wh_locations l ON l.id=k.location_id ORDER BY k.created_at DESC`).then((r) => r.rows);

export async function getCount(c: Conn, id: string) {
  const count = await must(c.query<any>(`SELECT k.*, w.code AS warehouse_code, l.code AS loc_code FROM wh_counts k JOIN warehouses w ON w.id=k.warehouse_id LEFT JOIN wh_locations l ON l.id=k.location_id WHERE k.id=$1`, [id]), "Count");
  const lines = (await c.query<any>(
    `SELECT x.*, p.name AS owner_name, s.code AS sku_code, s.description AS sku_desc, loc.code AS loc_code, cb.name AS counted_by_name
     FROM wh_count_lines x JOIN parties p ON p.id=x.owner_id JOIN wh_skus s ON s.id=x.sku_id JOIN wh_locations loc ON loc.id=x.location_id LEFT JOIN team_members cb ON cb.user_id=x.counted_by
     WHERE x.count_id=$1 ORDER BY loc.code, s.code, x.lot`, [id])).rows;
  return { count, lines };
}

export const listRates = (c: Conn, ownerId?: string | null) => c.query<any>(
  `SELECT r.*, p.name AS owner_name FROM wh_rates r JOIN parties p ON p.id=r.owner_id WHERE ($1::uuid IS NULL OR r.owner_id=$1) ORDER BY p.name, r.charge_type, r.effective_from DESC`, [ownerId ?? null]).then((r) => r.rows);

/** Unbilled activity per customer: rated (invoiceable), unrated (needs a rate card). */
export const billingSummary = (c: Conn) => c.query<any>(
  `SELECT p.id, p.name,
     coalesce(sum(CASE WHEN NOT g.unrated THEN round(g.qty*g.unit_minor) END),0)::bigint AS rated_minor,
     count(*) FILTER (WHERE NOT g.unrated)::int AS rated_lines,
     count(*) FILTER (WHERE g.unrated)::int AS unrated_lines
   FROM wh_charges g JOIN parties p ON p.id=g.owner_id WHERE g.invoice_id IS NULL GROUP BY p.id, p.name ORDER BY p.name`).then((r) => r.rows);

/** What a customer-portal user may see of their own stock. */
export const portalStock = (c: Conn, partyId: string) => c.query<any>(
  `SELECT k.code AS sku_code, k.description AS sku_desc, k.uom, sum(s.qty_on_hand) AS on_hand, sum(s.qty_reserved) AS reserved,
     sum(CASE WHEN l.kind='quarantine' THEN s.qty_on_hand ELSE 0 END) AS quarantined
   FROM wh_stock s JOIN wh_skus k ON k.id=s.sku_id JOIN wh_locations l ON l.id=s.location_id
   WHERE s.owner_id=$1 AND s.qty_on_hand > 0 GROUP BY k.code, k.description, k.uom ORDER BY k.code`, [partyId]).then((r) => r.rows);

/** Board data: what to receive, what to ship, what is held, what is unbilled. */
export async function warehouseOverview(c: Conn) {
  const n = async (sql: string) => Number((await c.query<any>(sql)).rows[0].n);
  return {
    unitsOnHand: await n(`SELECT coalesce(sum(qty_on_hand),0) n FROM wh_stock`),
    quarantined: await n(`SELECT coalesce(sum(s.qty_on_hand),0) n FROM wh_stock s JOIN wh_locations l ON l.id=s.location_id WHERE l.kind='quarantine'`),
    inboundOpen: await n(`SELECT count(*) n FROM wh_inbound WHERE status IN ('expected','receiving')`),
    outboundOpen: await n(`SELECT count(*) n FROM wh_outbound WHERE status IN ('new','allocated','picked')`),
    outboundLate: await n(`SELECT count(*) n FROM wh_outbound WHERE status IN ('new','allocated','picked') AND required_by < now()`),
    countsOpen: await n(`SELECT count(*) n FROM wh_counts WHERE status IN ('open','submitted')`),
    toDecide: await n(`SELECT count(*) n FROM wh_count_lines WHERE status='counted' AND count_id IN (SELECT id FROM wh_counts WHERE status='submitted')`),
    unrated: await n(`SELECT count(*) n FROM wh_charges WHERE unrated AND invoice_id IS NULL`),
    unbilledMinor: await n(`SELECT coalesce(sum(round(qty*unit_minor)),0) n FROM wh_charges WHERE invoice_id IS NULL AND NOT unrated`),
    inbound: (await c.query<any>(`SELECT i.id,i.no,i.expected_on,i.status,p.name AS owner FROM wh_inbound i JOIN parties p ON p.id=i.owner_id WHERE i.status IN ('expected','receiving') ORDER BY i.expected_on NULLS LAST, i.created_at LIMIT 8`)).rows,
    outbound: (await c.query<any>(`SELECT o.id,o.no,o.required_by,o.status,p.name AS owner,(o.required_by < now()) AS late FROM wh_outbound o JOIN parties p ON p.id=o.owner_id WHERE o.status IN ('new','allocated','picked') ORDER BY o.required_by NULLS LAST, o.created_at LIMIT 8`)).rows,
    held: (await c.query<any>(`SELECT p.name AS owner, k.code AS sku_code, l.code AS loc_code, s.qty_on_hand FROM wh_stock s JOIN parties p ON p.id=s.owner_id JOIN wh_skus k ON k.id=s.sku_id JOIN wh_locations l ON l.id=s.location_id WHERE l.kind='quarantine' AND s.qty_on_hand > 0 ORDER BY p.name, k.code LIMIT 8`)).rows,
    owners: (await c.query<any>(`SELECT p.name, sum(s.qty_on_hand) AS units FROM wh_stock s JOIN parties p ON p.id=s.owner_id WHERE s.qty_on_hand > 0 GROUP BY p.name ORDER BY 2 DESC LIMIT 8`)).rows,
  };
}
