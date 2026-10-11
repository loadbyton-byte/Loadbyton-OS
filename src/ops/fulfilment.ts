import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, forbidden } from "../lib/util.js";
import { assertWritable, consumeQuota } from "../platform/entitlements.js";
import { must, nextNumber, optStr, reqStr } from "./common.js";
import { charge } from "./fulfil-billing.js";
import { allocatableLots, applyLotMove, ensureLot, findLot, lotBlocked, planLots, recordDecision, releaseLot, reserveLot, skuMode } from "./fulfil-lots.js";
import { parseCsv, type ImportReport } from "./importer.js";
import { dubaiToIso } from "./transport.js";
import {canReadFulfilmentRecipient,redactFulfilmentRecipient,listPage} from '../lib/data-policy.js';

/**
 * E-commerce fulfilment (blueprint §15, merchant-order slice).
 *
 * Stock model: a location holds `on_hand` and `reserved` of a merchant's SKU. Every change to on_hand writes one immutable
 * `stock_movements` row; allocation reserves bins for an order line; picking moves stock bin → STAGE (still physically in the
 * building, no longer allocatable); shipping removes it from STAGE. All stock-mutating operations take one per-tenant advisory
 * lock, so concurrent receives/allocations/picks serialise instead of racing — correctness over throughput for the pilot.
 */

const posInt = (v: unknown, label: string, max = 1_000_000) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > max) throw badRequest(`${label} must be a whole number above zero.`);
  return n;
};
const nonNegInt = (v: unknown, label: string, max = 1_000_000) => {
  if (v === undefined || v === null || String(v).trim() === "") return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${label} must be a whole number, zero or more.`);
  return n;
};
const tokenOf = (v: unknown) => {
  const t = String(v ?? "");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(t)) throw badRequest("This form has expired. Reload the page and try again.");
  return t;
};
const oneOf = (v: unknown, allowed: string[], dflt: string, label: string) => {
  const t = v === undefined || v === null || String(v) === "" ? dflt : String(v);
  if (!allowed.includes(t)) throw badRequest(`${label} must be one of ${allowed.join(", ")}.`);
  return t;
};
export const lockStock = (c: Conn, tenantId: string) => c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${tenantId}:stock`]);

// ───────────────────────── locations
export const SYSTEM_LOCATIONS = { receiving: "RECV", staging: "STAGE", quarantine: "QUAR", transit: "TRANSIT" } as const;
const RESERVED_CODES = new Set(Object.values(SYSTEM_LOCATIONS));

export async function systemLocation(c: Conn, tenantId: string, kind: keyof typeof SYSTEM_LOCATIONS): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO wh_locations(tenant_id,code,kind,note) VALUES ($1,$2,$3,'System location') ON CONFLICT (tenant_id, code) DO UPDATE SET code=EXCLUDED.code RETURNING id`,
    [tenantId, SYSTEM_LOCATIONS[kind], kind]);
  return r.rows[0].id;
}

export async function createLocation(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const code = reqStr(f.code, "Location code", 30).toUpperCase().replace(/\s+/g, "-");
  if (RESERVED_CODES.has(code as any)) throw badRequest(`${code} is a system location (created automatically).`);
  try {
    const r = await c.query<{ id: string }>(`INSERT INTO wh_locations(tenant_id,code,kind,note,site_id) VALUES ($1,$2,'bin',$3,$4) RETURNING id`,
      [ctx.tenantId, code, optStr(f.note, 200), f.site_id ? (await must(c.query<any>(`SELECT id FROM fulfil_sites WHERE id=$1 AND active`, [f.site_id]), "Site")).id : null]);
    await audit(c, ctx.tenantId, actorOf(ctx), "location.created", "location", r.rows[0].id, { code });
    return r.rows[0].id;
  } catch (e: any) {
    if (String(e.message).includes("wh_locations_tenant_id_code_key")) throw new HttpError(409, `Location ${code} already exists.`, "conflict");
    throw e;
  }
}

export async function setLocationActive(c: Conn, ctx: Ctx, id: string, active: boolean) {
  require(ctx, "wh.write");
  const loc = await must(c.query<any>(`SELECT * FROM wh_locations WHERE id=$1 FOR UPDATE`, [id]), "Location");
  if (loc.kind !== "bin") throw badRequest("System locations cannot be switched off.");
  if (!active) {
    const stock = await c.query(`SELECT 1 FROM stock_levels WHERE location_id=$1 AND on_hand > 0`, [id]);
    if (stock.rows.length) throw badRequest(`${loc.code} still holds stock. Transfer it out first.`);
  }
  await c.query(`UPDATE wh_locations SET active=$2 WHERE id=$1`, [id, active]);
  await audit(c, ctx.tenantId, actorOf(ctx), active ? "location.enabled" : "location.disabled", "location", id);
}

export const listLocations = (c: Conn) => c.query<any>(
  `SELECT loc.*, coalesce(sum(l.on_hand),0)::int AS units, count(l.sku_id) FILTER (WHERE l.on_hand > 0)::int AS skus
   FROM wh_locations loc LEFT JOIN stock_levels l ON l.location_id=loc.id GROUP BY loc.id
   ORDER BY (loc.kind <> 'bin'), loc.code`).then((r) => r.rows);

// ───────────────────────── SKUs
export async function createSku(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.party_id]), "Merchant");
  const code = reqStr(f.code, "SKU code", 60).toUpperCase();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO skus(tenant_id,party_id,code,name,barcode,unit_weight_g,reorder_point,tracking,rotation,min_shelf_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [ctx.tenantId, f.party_id, code, reqStr(f.name, "Product name", 200), optStr(f.barcode, 60), f.unit_weight_g ? posInt(f.unit_weight_g, "Unit weight (g)", 500_000) : null, nonNegInt(f.reorder_point, "Reorder point"),
       oneOf(f.tracking, ["none", "lot", "serial"], "none", "Tracking"), oneOf(f.rotation, ["fifo", "fefo"], "fifo", "Rotation"), nonNegInt(f.min_shelf_days, "Minimum shelf days", 3650)]);
    await audit(c, ctx.tenantId, actorOf(ctx), "sku.created", "sku", r.rows[0].id, { code });
    return r.rows[0].id;
  } catch (e: any) {
    if (String(e.message).includes("skus_tenant_id_party_id_code_key")) throw new HttpError(409, `This merchant already has a SKU ${code}.`, "conflict");
    if (String(e.message).includes("skus_barcode_unique")) throw new HttpError(409, "Another SKU of this merchant already uses that barcode.", "conflict");
    throw e;
  }
}

export async function updateSku(c: Conn, ctx: Ctx, id: string, f: Record<string, any>) {
  require(ctx, "wh.write");
  const s = await must(c.query<any>(`SELECT * FROM skus WHERE id=$1 FOR UPDATE`, [id]), "SKU");
  const active = f.active === undefined ? s.active : f.active === "1" || f.active === true;
  if (!active && s.active) {
    const demand = await c.query(`SELECT 1 FROM fulfil_order_lines l JOIN fulfil_orders o ON o.id=l.order_id WHERE l.sku_id=$1 AND o.status NOT IN ('shipped','cancelled') LIMIT 1`, [id]);
    if (demand.rows.length) throw badRequest("Open orders still use this SKU. Ship or cancel them first.");
  }
  const tracking = oneOf(f.tracking, ["none", "lot", "serial"], s.tracking, "Tracking"), rotation = oneOf(f.rotation, ["fifo", "fefo"], s.rotation, "Rotation");
  if ((tracking !== s.tracking || rotation !== s.rotation) && (await c.query(`SELECT 1 FROM stock_movements WHERE sku_id=$1 LIMIT 1`, [id])).rows.length)
    throw badRequest("Tracking and rotation cannot change once the SKU has stock history.");
  await c.query(`UPDATE skus SET name=$2, reorder_point=$3, active=$4, tracking=$5, rotation=$6, min_shelf_days=$7 WHERE id=$1`,
    [id, f.name !== undefined ? reqStr(f.name, "Product name", 200) : s.name, f.reorder_point !== undefined ? nonNegInt(f.reorder_point, "Reorder point") : s.reorder_point, active,
     tracking, rotation, f.min_shelf_days !== undefined ? nonNegInt(f.min_shelf_days, "Minimum shelf days", 3650) : s.min_shelf_days]);
  await audit(c, ctx.tenantId, actorOf(ctx), "sku.updated", "sku", id);
}

export async function importSkus(c: Conn, ctx: Ctx, partyId: string, csv: string, dryRun = false): Promise<ImportReport> {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [partyId]), "Merchant");
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest("The file needs a header row and at least one data row.");
  if (rows.length > 5001) throw badRequest("Import is limited to 5,000 rows per file.");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (n: string) => head.indexOf(n);
  if (idx("code") < 0 || idx("name") < 0) throw badRequest("“code” and “name” columns are required (optional: barcode, unit_weight_g, reorder_point).");
  const rep: ImportReport = { created: 0, duplicates: [], rejected: [] };
  const seen = new Set<string>(), seenBarcode = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], get = (n: string) => (idx(n) >= 0 ? (r[idx(n)] ?? "").trim() : "");
    const code = get("code").toUpperCase(), name = get("name"), barcode = get("barcode");
    if (!code || !name) { rep.rejected.push({ line: i + 1, reason: "code and name are required" }); continue; }
    if (code.length > 60 || name.length > 200) { rep.rejected.push({ line: i + 1, reason: "code or name is too long" }); continue; }
    const w = get("unit_weight_g"), rp = get("reorder_point");
    if ((w && !/^\d+$/.test(w)) || (rp && !/^\d+$/.test(rp))) { rep.rejected.push({ line: i + 1, reason: "unit_weight_g and reorder_point must be whole numbers" }); continue; }
    if (seen.has(code)) { rep.duplicates.push(code); continue; }
    seen.add(code);
    const dup = await c.query(`SELECT 1 FROM skus WHERE party_id=$1 AND (code=$2 OR ($3::text IS NOT NULL AND barcode=$3))`, [partyId, code, barcode || null]);
    if (dup.rows.length || (barcode && seenBarcode.has(barcode))) { rep.duplicates.push(code); continue; }
    if (barcode) seenBarcode.add(barcode);
    if (!dryRun) await c.query(`INSERT INTO skus(tenant_id,party_id,code,name,barcode,unit_weight_g,reorder_point) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, partyId, code, name, barcode || null, w ? Number(w) : null, rp ? Number(rp) : 0]);
    rep.created++;
  }
  if (!dryRun) await audit(c, ctx.tenantId, actorOf(ctx), "sku.imported", "party", partyId, { created: rep.created, duplicates: rep.duplicates.length, rejected: rep.rejected.length });
  return rep;
}

export const listSkus = (c: Conn, partyId?: string | null) => c.query<any>(
  `SELECT s.*, p.name AS party_name FROM skus s JOIN parties p ON p.id=s.party_id WHERE ($1::uuid IS NULL OR s.party_id=$1) ORDER BY p.name, s.code`, [partyId ?? null]).then((r) => r.rows);

/** "CODE, qty" per line. Quantities for the same code are added together. */
export function parseQtyLines(text: string, label = "line"): { code: string; qty: number }[] {
  const out = new Map<string, number>();
  for (const [i, raw] of String(text ?? "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.+?)[\s,;\t]+(\d{1,7})$/.exec(line);
    if (!m || Number(m[2]) <= 0) throw badRequest(`Check ${label} ${i + 1}: write “SKU-CODE, quantity” (for example “TSHIRT-BLK-M, 12”).`);
    const code = m[1].trim().toUpperCase();
    out.set(code, (out.get(code) ?? 0) + Number(m[2]));
  }
  if (!out.size) throw badRequest("Add at least one line: “SKU-CODE, quantity”.");
  if (out.size > 500) throw badRequest("Too many different SKUs in one go (limit 500). Split it or use a CSV import.");
  return [...out].map(([code, qty]) => ({ code, qty }));
}

async function resolveSkus(c: Conn, partyId: string, lines: { code: string; qty: number }[]) {
  const found = (await c.query<any>(`SELECT id, code, active FROM skus WHERE party_id=$1 AND code = ANY($2::text[])`, [partyId, lines.map((l) => l.code)])).rows;
  const missing = lines.filter((l) => !found.find((s) => s.code === l.code)).map((l) => l.code);
  if (missing.length) throw badRequest(`Unknown SKU for this merchant: ${missing.join(", ")}. Add it in Catalogue first.`);
  const off = found.filter((s) => !s.active).map((s) => s.code);
  if (off.length) throw badRequest(`Inactive SKU: ${off.join(", ")}.`);
  return lines.map((l) => ({ sku_id: found.find((s) => s.code === l.code)!.id as string, qty: l.qty, code: l.code }));
}

// ───────────────────────── stock engine
interface Move { skuId: string; locationId: string; delta: number; kind: string; refType?: string; refId?: string; note?: string; fromReserved?: boolean; lotId?: string | null }

/** The only code path that changes on_hand: guarded update + one immutable ledger row. */
export async function moveStock(c: Conn, ctx: Ctx, m: Move) {
  if (!m.delta) return;
  const mode = await skuMode(c, m.skuId);
  if (mode.tracked && !m.lotId) throw badRequest("This SKU is lot, serial or expiry tracked: name the lot for every stock movement.");
  if (!mode.tracked && m.lotId) throw badRequest("This SKU is not lot tracked.");
  if (mode.tracking === "serial" && Math.abs(m.delta) !== 1) throw badRequest("Serial-tracked movements contain exactly one unit.");
  if (m.delta > 0) {
    await c.query(
      `INSERT INTO stock_levels(tenant_id,sku_id,location_id,on_hand) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id,sku_id,location_id) DO UPDATE SET on_hand = stock_levels.on_hand + $4`,
      [ctx.tenantId, m.skuId, m.locationId, m.delta]);
  } else {
    const q = -m.delta;
    const r = await c.query(
      `UPDATE stock_levels SET on_hand = on_hand - $4, reserved = reserved - $5
       WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND on_hand - $4 >= reserved - $5 AND reserved >= $5 RETURNING on_hand`,
      [ctx.tenantId, m.skuId, m.locationId, q, m.fromReserved ? q : 0]);
    if (!r.rows.length) throw badRequest("Not enough unreserved stock at that location for this movement.");
  }
  if (m.lotId) {
    await applyLotMove(c, ctx, m.skuId, m.locationId, m.lotId, m.delta, !!m.fromReserved);
    if (mode.tracking === "serial") {
      const held = Number((await c.query<any>(`SELECT coalesce(sum(on_hand),0) n FROM stock_lot_levels WHERE lot_id=$1`, [m.lotId])).rows[0].n);
      if (held > 1) throw badRequest("That serial number is already in custody.");
    }
  }
  await c.query(
    `INSERT INTO stock_movements(tenant_id,sku_id,location_id,delta,kind,ref_type,ref_id,note,created_by,lot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.tenantId, m.skuId, m.locationId, m.delta, m.kind, m.refType ?? null, m.refId ?? null, m.note ?? null, ctx.userId, m.lotId ?? null]);
}

/** Free `qty` reserved units at a bin (and its lot, when the allocation named one). */
async function releaseReserved(c: Conn, tenantId: string, skuId: string, locationId: string, lotId: string | null, qty: number) {
  await c.query(`UPDATE stock_levels SET reserved = reserved - $4 WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND reserved >= $4`, [tenantId, skuId, locationId, qty]);
  if (lotId) await releaseLot(c, tenantId, skuId, locationId, lotId, qty);
}

/** Best fit: one bin that covers the need (smallest sufficient); otherwise greedy from the fullest bins. */
export function planBins(bins: { location_id: string; avail: number }[], need: number) {
  const fit = bins.filter((b) => b.avail >= need).sort((a, b) => a.avail - b.avail)[0];
  if (fit) return { picks: [{ location_id: fit.location_id, qty: need }], total: need };
  const picks: { location_id: string; qty: number }[] = [];
  let left = need;
  for (const b of [...bins].sort((a, b) => b.avail - a.avail)) {
    if (left <= 0) break;
    const q = Math.min(b.avail, left);
    picks.push({ location_id: b.location_id, qty: q });
    left -= q;
  }
  return { picks, total: need - left };
}

const LIVE = ["new", "backordered", "allocated", "picking", "picked", "packed"];

/** Derive the order status from its quantities so it can never drift from the lines/allocations. */
async function refreshStatus(c: Conn, orderId: string) {
  const o = (await c.query<any>(`SELECT status FROM fulfil_orders WHERE id=$1`, [orderId])).rows[0];
  if (!o || !LIVE.includes(o.status)) return o?.status;
  const t = (await c.query<any>(`SELECT coalesce(sum(allocated_qty),0)::int alloc, coalesce(sum(picked_qty),0)::int picked, coalesce(sum(packed_qty),0)::int packed FROM fulfil_order_lines WHERE order_id=$1`, [orderId])).rows[0];
  const openAlloc = Number((await c.query<any>(`SELECT coalesce(sum(a.qty - a.picked_qty),0) n FROM stock_allocations a JOIN fulfil_order_lines l ON l.id=a.line_id WHERE l.order_id=$1`, [orderId])).rows[0].n);
  let st: string;
  if (t.alloc === 0) st = o.status === "new" ? "new" : "backordered";
  else if (t.picked === 0) st = "allocated";
  else if (openAlloc > 0) st = "picking";
  else if (t.packed < t.picked) st = "picked";
  else st = "packed";
  if (st !== o.status) await c.query(`UPDATE fulfil_orders SET status=$2 WHERE id=$1`, [orderId, st]);
  return st;
}

async function allocateInternal(c: Conn, ctx: Ctx, orderId: string) {
  const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [orderId]), "Order");
  if (!LIVE.includes(o.status)) throw badRequest(`Order is ${o.status}.`);
  const lines = (await c.query<any>(
    `SELECT l.*, s.code FROM fulfil_order_lines l JOIN skus s ON s.id=l.sku_id WHERE l.order_id=$1 ORDER BY s.code`, [orderId])).rows;
  const plans: { l: any; need: number; picks: { location_id: string; qty: number; lot_id?: string }[]; total: number }[] = [];
  let short = false, outstanding = 0;
  for (const l of lines) {
    const need = l.qty - l.closed_qty - l.allocated_qty;
    if (need <= 0) continue;
    const mode = await skuMode(c, l.sku_id);
    let p: { picks: { location_id: string; qty: number; lot_id?: string }[]; total: number };
    if (mode.tracked) p = planLots(await allocatableLots(c, l.sku_id, mode, o.site_id), need);
    else {
      const bins = (await c.query<any>(
        `SELECT sl.location_id, (sl.on_hand - sl.reserved)::int AS avail FROM stock_levels sl JOIN wh_locations loc ON loc.id=sl.location_id
         WHERE sl.sku_id=$1 AND loc.kind='bin' AND loc.active AND sl.on_hand - sl.reserved > 0 AND ($2::uuid IS NULL OR loc.site_id=$2) ORDER BY loc.code`, [l.sku_id, o.site_id])).rows;
      p = planBins(bins, need);
    }
    plans.push({ l, need, ...p });
    outstanding += need;
    if (p.total < need) short = true;
  }
  if (!plans.length) return { allocated: 0, outstanding: 0, blocked: false };
  // all-or-nothing unless the merchant allows partial shipments: never strand stock on an order that cannot complete
  if (short && !o.allow_partial) {
    await c.query(`UPDATE fulfil_orders SET status='backordered' WHERE id=$1 AND status='new'`, [orderId]);
    await refreshStatus(c, orderId);
    return { allocated: 0, outstanding, blocked: true };
  }
  let allocated = 0;
  for (const p of plans) {
    for (const pick of p.picks) {
      const r = await c.query(
        `UPDATE stock_levels SET reserved = reserved + $4 WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND on_hand - reserved >= $4 RETURNING reserved`,
        [ctx.tenantId, p.l.sku_id, pick.location_id, pick.qty]);
      if (!r.rows.length) throw new HttpError(409, "Stock changed while allocating; please try again.", "conflict");
      if (pick.lot_id) await reserveLot(c, ctx.tenantId, p.l.sku_id, pick.location_id, pick.lot_id, pick.qty);
      await c.query(`INSERT INTO stock_allocations(tenant_id,line_id,sku_id,location_id,qty,lot_id) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, p.l.id, p.l.sku_id, pick.location_id, pick.qty, pick.lot_id ?? null]);
      allocated += pick.qty;
    }
    const got = p.picks.reduce((a, x) => a + x.qty, 0);
    if (got) await c.query(`UPDATE fulfil_order_lines SET allocated_qty = allocated_qty + $2 WHERE id=$1`, [p.l.id, got]);
  }
  if (!allocated) await c.query(`UPDATE fulfil_orders SET status='backordered' WHERE id=$1 AND status='new'`, [orderId]);
  await refreshStatus(c, orderId);
  if (allocated) await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_order.allocated", "fulfil_order", orderId, { units: allocated });
  return { allocated, outstanding, blocked: false };
}

export async function allocateOrder(c: Conn, ctx: Ctx, orderId: string) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  return allocateInternal(c, ctx, orderId);
}

/** Oldest orders first, so freshly received/returned/found stock goes to whoever has waited longest. */
export async function allocateWaitingInternal(c: Conn, ctx: Ctx) {
  const ids = (await c.query<any>(
    `SELECT o.id FROM fulfil_orders o WHERE o.status IN ('new','backordered','allocated','picking','picked','packed')
       AND EXISTS (SELECT 1 FROM fulfil_order_lines l WHERE l.order_id=o.id AND l.qty - l.closed_qty - l.allocated_qty > 0
         AND EXISTS (SELECT 1 FROM stock_levels sl JOIN wh_locations loc ON loc.id=sl.location_id    -- skip orders no free unit could serve
                     WHERE sl.sku_id=l.sku_id AND loc.kind='bin' AND loc.active AND sl.on_hand - sl.reserved > 0))
     ORDER BY o.ordered_at, o.created_at`)).rows;
  let orders = 0, units = 0;
  for (const r of ids) {
    const a = await allocateInternal(c, ctx, r.id);
    if (a.allocated) { orders++; units += a.allocated; }
  }
  return { orders, units };
}
export async function allocateWaiting(c: Conn, ctx: Ctx) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  return allocateWaitingInternal(c, ctx);
}

// ───────────────────────── orders
export interface OrderInput {
  party_id: string; external_ref: string; channel?: string; ship_to_name: string; ship_to_phone?: string; ship_to_address: string;
  ship_to_city?: string; ship_to_country?: string; ship_by?: string; allow_partial?: boolean | string; site_id?: string; lines: { code: string; qty: number }[];
}

/** Idempotent on (merchant, external_ref): a retried API call or re-imported CSV row never creates a second order. */
async function placeOrder(c: Conn, ctx: Ctx, f: OrderInput): Promise<{ id: string; no: string; created: boolean }> {
  await lockStock(c, ctx.tenantId);
  const ref = reqStr(f.external_ref, "Order reference", 80);
  const existing = (await c.query<any>(`SELECT id, no FROM fulfil_orders WHERE party_id=$1 AND external_ref=$2`, [f.party_id, ref])).rows[0];
  if (existing) return { id: existing.id, no: existing.no, created: false };
  const lines = await resolveSkus(c, f.party_id, f.lines);
  const shipBy = f.ship_by ? dubaiToIso(String(f.ship_by)) : null;
  if (shipBy && Number.isNaN(Date.parse(shipBy))) throw badRequest("Ship-by time is not valid.");
  // validate every field BEFORE taking a number: an import skips bad orders and must not leave gaps in the numbering
  const v = {
    channel: optStr(f.channel, 40) ?? "manual", name: reqStr(f.ship_to_name, "Recipient name", 150), phone: optStr(f.ship_to_phone, 40),
    address: reqStr(f.ship_to_address, "Delivery address", 400), city: optStr(f.ship_to_city, 80), country: (optStr(f.ship_to_country, 2) ?? "AE").toUpperCase(),
  };
  const siteId = f.site_id ? (await must(c.query<any>(`SELECT id FROM fulfil_sites WHERE id=$1 AND active`, [f.site_id]), "Site")).id as string : null;
  const no = await nextNumber(c, ctx.tenantId, "fulfil_order", "FUL");
  const o = await c.query<{ id: string }>(
    `INSERT INTO fulfil_orders(tenant_id,no,party_id,channel,external_ref,ship_to_name,ship_to_phone,ship_to_address,ship_to_city,ship_to_country,ship_by,allow_partial,created_by,site_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ctx.tenantId, no, f.party_id, v.channel, ref, v.name, v.phone, v.address, v.city, v.country, shipBy, f.allow_partial === true || f.allow_partial === "1", ctx.userId, siteId]);
  const id = o.rows[0].id;
  // billing unit for this sector is the fulfilment order; the reference makes a retried request idempotent
  await consumeQuota(c, ctx.tenantId, "fulfilment_orders_per_month", `fulorder:${id}`);
  for (const l of lines) await c.query(`INSERT INTO fulfil_order_lines(tenant_id,order_id,sku_id,qty) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, id, l.sku_id, l.qty]);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_order.created", "fulfil_order", id, { no, channel: f.channel ?? "manual", lines: lines.length });
  return { id, no, created: true };
}

/** Manual order entry. The order reserves stock immediately, or is backordered (nothing partially stranded). */
export async function createOrder(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.party_id]), "Merchant");
  const r = await placeOrder(c, ctx, { ...f, party_id: f.party_id, lines: parseQtyLines(f.lines, "line") } as OrderInput);
  if (!r.created) throw new HttpError(409, `That order reference already exists as ${r.no}.`, "conflict");
  const a = await allocateInternal(c, ctx, r.id);
  return { ...r, allocated: a.allocated, blocked: a.blocked };
}

/**
 * CSV import (one row per order line). Columns: external_ref, sku, qty, ship_to_name, ship_to_address
 * (optional: channel, ship_to_phone, ship_to_city, ship_to_country, ship_by). Orders are all-or-nothing; known references are skipped.
 */
export async function importOrders(c: Conn, ctx: Ctx, partyId: string, csv: string, dryRun = false): Promise<ImportReport> {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [partyId]), "Merchant");
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest("The file needs a header row and at least one data row.");
  if (rows.length > 2001) throw badRequest("Import is limited to 2,000 rows per file.");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  for (const need of ["external_ref", "sku", "qty", "ship_to_name", "ship_to_address"]) if (col(need) < 0) throw badRequest(`A “${need}” column is required.`);
  const rep: ImportReport = { created: 0, duplicates: [], rejected: [] };
  const groups = new Map<string, { first: number; rows: { line: number; get: (n: string) => string }[] }>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], get = (n: string) => (col(n) >= 0 ? (r[col(n)] ?? "").trim() : "");
    const ref = get("external_ref");
    if (!ref) { rep.rejected.push({ line: i + 1, reason: "external_ref is empty" }); continue; }
    const g = groups.get(ref) ?? { first: i + 1, rows: [] };
    g.rows.push({ line: i + 1, get }); groups.set(ref, g);
  }
  for (const [ref, g] of groups) {
    const first = g.rows[0].get;
    const bad = (reason: string) => { for (const r of g.rows) rep.rejected.push({ line: r.line, reason: `${ref}: ${reason}` }); };
    try {
      const lines = parseQtyLines(g.rows.map((r) => `${r.get("sku")}, ${r.get("qty")}`).join("\n"), "row");
      if (!first("ship_to_name") || !first("ship_to_address")) { bad("recipient name and address are required"); continue; }
      const seen = (await c.query(`SELECT 1 FROM fulfil_orders WHERE party_id=$1 AND external_ref=$2`, [partyId, ref])).rows.length;
      if (seen) { rep.duplicates.push(ref); continue; }
      await resolveSkus(c, partyId, lines);
      if (dryRun) { rep.created++; continue; }
      const r = await placeOrder(c, ctx, {
        party_id: partyId, external_ref: ref, channel: first("channel") || "import", ship_to_name: first("ship_to_name"), ship_to_phone: first("ship_to_phone"),
        ship_to_address: first("ship_to_address"), ship_to_city: first("ship_to_city"), ship_to_country: first("ship_to_country") || "AE", ship_by: first("ship_by"), lines,
      });
      if (r.created) { await allocateInternal(c, ctx, r.id); rep.created++; } else rep.duplicates.push(ref);
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) bad(e.message); else throw e;   // quota / restricted: abort the whole import
    }
  }
  if (!dryRun) await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_order.imported", "party", partyId, { created: rep.created, duplicates: rep.duplicates.length, rejected: rep.rejected.length });
  return rep;
}

export async function pickList(c: Conn) {
  return (await c.query<any>(
    `SELECT a.id, loc.code AS location, s.code AS sku, s.name AS sku_name, s.barcode, (a.qty - a.picked_qty)::int AS remaining, o.id AS order_id, o.no AS order_no, o.ship_by, o.status
     FROM stock_allocations a JOIN wh_locations loc ON loc.id=a.location_id JOIN skus s ON s.id=a.sku_id
     JOIN fulfil_order_lines l ON l.id=a.line_id JOIN fulfil_orders o ON o.id=l.order_id
     WHERE a.qty > a.picked_qty AND o.status IN ('allocated','picking') ORDER BY loc.code, s.code, o.ship_by NULLS LAST, o.no`)).rows;
}

/**
 * Confirm picks. `entries` = {allocation_id → quantity found}; omit it to confirm every open allocation as listed.
 * A quantity below the allocation is a short pick: the missing units are released, the order is flagged, and a task is raised
 * to count that bin — the system never pretends the stock is there.
 */
export async function pickOrder(c: Conn, ctx: Ctx, orderId: string, entries?: Record<string, number>) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [orderId]), "Order");
  if (!["allocated", "picking"].includes(o.status)) throw badRequest(`Order is ${o.status}; only allocated orders can be picked.`);
  const stage = await systemLocation(c, ctx.tenantId, "staging");
  const open = (await c.query<any>(
    `SELECT a.*, l.id AS line_id2, loc.code AS loc_code, s.code AS sku_code, lot.lot AS lot_code, lot.hold AS lot_hold, lot.expires_at AS lot_expires
     FROM stock_allocations a JOIN fulfil_order_lines l ON l.id=a.line_id
     JOIN wh_locations loc ON loc.id=a.location_id JOIN skus s ON s.id=a.sku_id LEFT JOIN fulfil_lots lot ON lot.id=a.lot_id
     WHERE l.order_id=$1 AND a.qty > a.picked_qty ORDER BY loc.code, s.code, lot.lot FOR UPDATE OF a`, [orderId])).rows;
  let picked = 0, shorts = 0;
  for (const a of open) {
    const remaining = a.qty - a.picked_qty;
    const blocked = !!a.lot_id && lotBlocked({ hold: a.lot_hold, expires_at: a.lot_expires });
    const q = blocked ? 0 : entries ? entries[a.id] : remaining;   // held / expired lots are never picked: the reservation is released
    if (q === undefined) continue;
    if (!Number.isInteger(q) || q < 0 || q > remaining) throw badRequest(`Picked quantity for ${a.sku_code} at ${a.loc_code} must be between 0 and ${remaining}.`);
    if (q > 0) {
      await moveStock(c, ctx, { skuId: a.sku_id, locationId: a.location_id, delta: -q, kind: "pick_out", refType: "fulfil_order", refId: orderId, fromReserved: true, lotId: a.lot_id });
      await moveStock(c, ctx, { skuId: a.sku_id, locationId: stage, delta: q, kind: "stage_in", refType: "fulfil_order", refId: orderId, lotId: a.lot_id });
      await c.query(`UPDATE stock_allocations SET picked_qty = picked_qty + $2 WHERE id=$1`, [a.id, q]);
      await c.query(`UPDATE fulfil_order_lines SET picked_qty = picked_qty + $2 WHERE id=$1`, [a.line_id, q]);
      picked += q;
    }
    if (q < remaining) {
      const s = remaining - q;
      await releaseReserved(c, ctx.tenantId, a.sku_id, a.location_id, a.lot_id, s);
      if (a.qty - s === 0) await c.query(`DELETE FROM stock_allocations WHERE id=$1`, [a.id]); else await c.query(`UPDATE stock_allocations SET qty = qty - $2 WHERE id=$1`, [a.id, s]);
      await c.query(`UPDATE fulfil_order_lines SET allocated_qty = allocated_qty - $2 WHERE id=$1`, [a.line_id, s]);
      await c.query(`INSERT INTO job_exceptions(tenant_id,title,detail,owner_id,due_at) VALUES ($1,$2,$3,$4, now() + interval '4 hours')`,
        [ctx.tenantId, `Short pick ${o.no}: ${a.sku_code} at ${a.loc_code}`, blocked ? `Lot ${a.lot_code} at ${a.loc_code} is on hold or expired; ${s} unit(s) were released for re-allocation from another lot.` : `Expected ${remaining}, found ${q}. Count ${a.loc_code}${a.lot_code ? ` (lot ${a.lot_code})` : ""} and raise an adjustment; the order was released for re-allocation.`, o.created_by]);
      shorts++;
    }
  }
  const st = await refreshStatus(c, orderId);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_order.picked", "fulfil_order", orderId, { units: picked, shorts });
  return { picked, shorts, status: st };
}

/** Pack by scanning: the code must be a SKU on THIS order and cannot exceed what was picked. */
export async function packScan(c: Conn, ctx: Ctx, orderId: string, f: { code: string; qty?: string | number }) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [orderId]), "Order");
  if (!["picking", "picked", "packed"].includes(o.status)) throw badRequest(`Order is ${o.status}; nothing has been picked to pack yet.`);
  const code = reqStr(f.code, "Scanned code", 80);
  const qty = f.qty === undefined || f.qty === "" ? 1 : posInt(f.qty, "Quantity", 10_000);
  const serialHit = (await c.query<any>(
    `SELECT l.*, s.code, lot.id AS lot_id FROM fulfil_order_lines l JOIN skus s ON s.id=l.sku_id
       JOIN stock_allocations a ON a.line_id=l.id AND a.picked_qty>0 JOIN fulfil_lots lot ON lot.id=a.lot_id AND lot.serial_ref IS NOT NULL
     WHERE l.order_id=$1 AND upper(lot.serial_ref)=upper($2) FOR UPDATE OF l`, [orderId, code])).rows[0];
  if (serialHit) {
    if (qty !== 1) throw badRequest("Scan each serial number once.");
    const dup = await c.query(`SELECT 1 FROM fulfil_pack_serials WHERE line_id=$1 AND lot_id=$2`, [serialHit.id, serialHit.lot_id]);
    if (dup.rows.length) throw badRequest(`Serial ${code.toUpperCase()} is already packed on this order.`);
    await c.query(`INSERT INTO fulfil_pack_serials(tenant_id,line_id,lot_id,scanned_by) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, serialHit.id, serialHit.lot_id, ctx.userId]);
  }
  const l = serialHit ?? (await c.query<any>(
    `SELECT l.*, s.code, s.tracking FROM fulfil_order_lines l JOIN skus s ON s.id=l.sku_id WHERE l.order_id=$1 AND (s.barcode=$2 OR upper(s.code)=upper($2)) FOR UPDATE OF l`, [orderId, code])).rows[0];
  if (!l) throw badRequest(`“${code}” is not on this order. Wrong item — put it back.`);
  if (!serialHit && (await skuMode(c, l.sku_id)).tracking === "serial") throw badRequest(`${l.code} is serial tracked: scan each unit's serial number.`);
  if (l.packed_qty + qty > l.picked_qty) throw badRequest(`${l.code}: ${l.picked_qty} picked, ${l.packed_qty} already packed — cannot pack ${qty} more.`);
  await c.query(`UPDATE fulfil_order_lines SET packed_qty = packed_qty + $2 WHERE id=$1`, [l.id, qty]);
  const st = await refreshStatus(c, orderId);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_order.pack_scan", "fulfil_order", orderId, { sku: l.code, qty });
  return { sku: l.code, packed: l.packed_qty + qty, picked: l.picked_qty, status: st };
}

export async function resetPacking(c: Conn, ctx: Ctx, orderId: string) {
  require(ctx, "wh.floor");
  const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [orderId]), "Order");
  if (!["picking", "picked", "packed"].includes(o.status)) throw badRequest(`Order is ${o.status}.`);
  await c.query(`DELETE FROM fulfil_pack_serials WHERE line_id IN (SELECT id FROM fulfil_order_lines WHERE order_id=$1)`, [orderId]);
  await c.query(`UPDATE fulfil_order_lines SET packed_qty=0 WHERE order_id=$1`, [orderId]);
  await refreshStatus(c, orderId);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_order.pack_reset", "fulfil_order", orderId);
}

/** Dispatch: removes the packed units from staging, records carrier + tracking, and bills pick/pack activity once. */
export async function shipOrder(c: Conn, ctx: Ctx, orderId: string, f: Record<string, any>) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [orderId]), "Order");
  if (o.status !== "packed") throw badRequest(`Order is ${o.status}; it must be fully packed before it ships.`);
  const lines = (await c.query<any>(`SELECT l.*, s.code FROM fulfil_order_lines l JOIN skus s ON s.id=l.sku_id WHERE l.order_id=$1 ORDER BY s.code FOR UPDATE OF l`, [orderId])).rows;
  const waiting = lines.filter((l) => l.qty - l.closed_qty - l.allocated_qty > 0);
  if (waiting.length) throw badRequest(`Not complete: ${waiting.map((l) => `${l.code} (${l.qty - l.closed_qty - l.allocated_qty} unit(s) not allocated)`).join(", ")}. Allocate again when stock arrives, or close the order short.`);
  const units = lines.reduce((a, l) => a + l.packed_qty, 0);
  if (units <= 0) throw badRequest("Nothing is packed.");
  const carrier = reqStr(f.carrier, "Carrier", 60), tracking = reqStr(f.tracking_no, "Tracking number", 80);
  const dup = await c.query(`SELECT o.no FROM fulfil_shipments sh JOIN fulfil_orders o ON o.id=sh.order_id WHERE sh.carrier=$1 AND sh.tracking_no=$2`, [carrier, tracking]);
  if (dup.rows.length) throw new HttpError(409, `Tracking number ${tracking} is already used on ${dup.rows[0].no}.`, "conflict");
  const stage = await systemLocation(c, ctx.tenantId, "staging");
  for (const l of lines) if (l.packed_qty > 0) {
    const lots = (await c.query<any>(
      `SELECT a.lot_id, sum(a.picked_qty)::int AS qty, lot.lot, lot.hold, lot.expires_at FROM stock_allocations a JOIN fulfil_lots lot ON lot.id=a.lot_id
       WHERE a.line_id=$1 AND a.picked_qty>0 GROUP BY a.lot_id, lot.lot, lot.hold, lot.expires_at ORDER BY lot.lot`, [l.id])).rows;
    if (lots.length) {
      const bad = lots.find((x) => lotBlocked(x));
      if (bad) throw badRequest(`${l.code}: lot ${bad.lot} is on hold or expired and cannot ship. Cancel the order to return the units to stock, then re-allocate.`);
      for (const x of lots) await moveStock(c, ctx, { skuId: l.sku_id, locationId: stage, delta: -x.qty, kind: "ship", refType: "fulfil_order", refId: orderId, lotId: x.lot_id });
    } else await moveStock(c, ctx, { skuId: l.sku_id, locationId: stage, delta: -l.packed_qty, kind: "ship", refType: "fulfil_order", refId: orderId });
    await c.query(`UPDATE fulfil_order_lines SET shipped_qty = packed_qty WHERE id=$1`, [l.id]);
  }
  await c.query(`INSERT INTO fulfil_shipments(tenant_id,order_id,carrier,tracking_no,cartons,weight_g,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.tenantId, orderId, carrier, tracking, f.cartons ? posInt(f.cartons, "Cartons", 1000) : 1, f.weight_g ? posInt(f.weight_g, "Weight (g)", 5_000_000) : null, ctx.userId]);
  await c.query(`UPDATE fulfil_orders SET status='shipped', shipped_at=now() WHERE id=$1`, [orderId]);
  await charge(c, ctx, { partyId: o.party_id, code: "pick_order", qty: 1, sourceKey: `ship:${orderId}:pick_order`, orderId, detail: o.no });
  await charge(c, ctx, { partyId: o.party_id, code: "pick_unit", qty: units, sourceKey: `ship:${orderId}:pick_unit`, orderId, detail: o.no });
  await charge(c, ctx, { partyId: o.party_id, code: "pack_order", qty: 1, sourceKey: `ship:${orderId}:pack_order`, orderId, detail: o.no });
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_order.shipped", "fulfil_order", orderId, { carrier, tracking, units });
  return { units };
}

/** Give up the units that cannot be supplied (explicitly, with a reason) so the rest of the order can ship. */
export async function closeShort(c: Conn, ctx: Ctx, orderId: string, reason: string) {
  require(ctx, "wh.write");
  const why = reqStr(reason, "Reason", 300);
  await lockStock(c, ctx.tenantId);
  const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [orderId]), "Order");
  if (!["allocated", "picking", "picked", "packed"].includes(o.status)) throw badRequest(o.status === "backordered" || o.status === "new" ? "Nothing is allocated yet — cancel the order instead." : `Order is ${o.status}.`);
  const r = await c.query(`UPDATE fulfil_order_lines SET closed_qty = closed_qty + (qty - closed_qty - allocated_qty) WHERE order_id=$1 AND qty - closed_qty - allocated_qty > 0 RETURNING id`, [orderId]);
  if (!r.rows.length) throw badRequest("Every unit is already allocated; nothing to close.");
  await refreshStatus(c, orderId);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_order.closed_short", "fulfil_order", orderId, { reason: why, lines: r.rows.length });
}

/** Cancel before dispatch: reservations are released and anything already picked goes back to the bin it came from. */
export async function cancelFulfilOrder(c: Conn, ctx: Ctx, orderId: string) {
  require(ctx, "wh.write");
  await lockStock(c, ctx.tenantId);
  const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [orderId]), "Order");
  if (!LIVE.includes(o.status)) throw badRequest(`A ${o.status} order cannot be cancelled.`);
  const stage = await systemLocation(c, ctx.tenantId, "staging");
  const allocs = (await c.query<any>(`SELECT a.* FROM stock_allocations a JOIN fulfil_order_lines l ON l.id=a.line_id WHERE l.order_id=$1 FOR UPDATE OF a`, [orderId])).rows;
  for (const a of allocs) {
    const rem = a.qty - a.picked_qty;
    if (rem > 0) await releaseReserved(c, ctx.tenantId, a.sku_id, a.location_id, a.lot_id, rem);
    if (a.picked_qty > 0) {
      await moveStock(c, ctx, { skuId: a.sku_id, locationId: stage, delta: -a.picked_qty, kind: "cancel_out", refType: "fulfil_order", refId: orderId, lotId: a.lot_id });
      await moveStock(c, ctx, { skuId: a.sku_id, locationId: a.location_id, delta: a.picked_qty, kind: "cancel_return", refType: "fulfil_order", refId: orderId, lotId: a.lot_id });
    }
  }
  await c.query(`DELETE FROM fulfil_pack_serials WHERE line_id IN (SELECT id FROM fulfil_order_lines WHERE order_id=$1)`, [orderId]);
  await c.query(`DELETE FROM stock_allocations WHERE id = ANY($1::uuid[])`, [allocs.map((a) => a.id)]);
  await c.query(`UPDATE fulfil_order_lines SET allocated_qty=0, picked_qty=0, packed_qty=0, closed_qty=qty WHERE order_id=$1`, [orderId]);
  await c.query(`UPDATE fulfil_orders SET status='cancelled', cancelled_at=now() WHERE id=$1`, [orderId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_order.cancelled", "fulfil_order", orderId);
  await allocateWaitingInternal(c, ctx);
}

// ───────────────────────── inbound
export async function createInbound(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.party_id]), "Merchant");
  const lines = await resolveSkus(c, f.party_id, parseQtyLines(f.lines, "line"));
  const no = await nextNumber(c, ctx.tenantId, "inbound", "INB");
  const exp = f.expected_at ? dubaiToIso(String(f.expected_at)) : null;
  const r = await c.query<{ id: string }>(`INSERT INTO inbound_shipments(tenant_id,no,party_id,reference,expected_at,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, no, f.party_id, optStr(f.reference, 100), exp, optStr(f.notes, 500), ctx.userId]);
  for (const l of lines) await c.query(`INSERT INTO inbound_lines(tenant_id,inbound_id,sku_id,expected_qty) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, r.rows[0].id, l.sku_id, l.qty]);
  await audit(c, ctx.tenantId, actorOf(ctx), "inbound.created", "inbound", r.rows[0].id, { no, lines: lines.length });
  return { id: r.rows[0].id, no };
}

export async function receiveInbound(c: Conn, ctx: Ctx, inboundId: string, f: Record<string, any>) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const token = tokenOf(f.token);
  // a retried submit is a no-op: decide that BEFORE validating against state the first submit already changed
  if ((await c.query(`SELECT 1 FROM inbound_receipts WHERE token=$1`, [token])).rows.length) return { duplicate: true as const };
  const good = nonNegInt(f.good, "Good quantity"), damaged = nonNegInt(f.damaged, "Damaged quantity");
  if (good + damaged <= 0) throw badRequest("Enter how many units arrived (good and/or damaged).");
  const inb = await must(c.query<any>(`SELECT * FROM inbound_shipments WHERE id=$1 FOR UPDATE`, [inboundId]), "Inbound");
  if (!["expected", "receiving"].includes(inb.status)) throw badRequest(`This inbound is ${inb.status}.`);
  const line = await must(c.query<any>(`SELECT l.*, s.code FROM inbound_lines l JOIN skus s ON s.id=l.sku_id WHERE l.id=$1 AND l.inbound_id=$2 FOR UPDATE OF l`, [f.line_id, inboundId]), "Inbound line");
  const loc = await must(c.query<any>(`SELECT * FROM wh_locations WHERE id=$1`, [f.location_id]), "Location");
  if (good > 0 && !(loc.active && ["bin", "receiving"].includes(loc.kind))) throw badRequest("Good stock is received into a bin or the receiving area.");
  const total = line.received_qty + line.damaged_qty + good + damaged;
  if (total > line.expected_qty && f.accept_over !== "1") throw badRequest(`This brings ${line.code} to ${total} against ${line.expected_qty} expected. Tick “accept over-receipt” only if the extra units really arrived.`);
  const mode = await skuMode(c, line.sku_id);
  // tracked SKUs: one lot per receipt, or one serial per unit (good serials, then damaged serials)
  const serialsOf = (v: unknown) => String(v ?? "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  let goodLots: { id: string; qty: number }[] = [], damagedLots: { id: string; qty: number }[] = [], receiptLot: string | null = null;
  if (mode.tracked) {
    if (mode.tracking === "serial") {
      const gs = serialsOf(f.serials), ds = serialsOf(f.damaged_serials);
      if (gs.length !== good || ds.length !== damaged) throw badRequest(`Enter exactly ${good} good and ${damaged} damaged serial number(s), one per unit.`);
      if (new Set([...gs, ...ds].map((x) => x.toUpperCase())).size !== gs.length + ds.length) throw badRequest("A serial number appears twice in this receipt.");
      for (const sn of gs) goodLots.push({ id: (await ensureLot(c, ctx, line.sku_id, { ...f, lot: sn })).id, qty: 1 });
      for (const sn of ds) damagedLots.push({ id: (await ensureLot(c, ctx, line.sku_id, { ...f, lot: sn })).id, qty: 1 });
    } else {
      const lot = await ensureLot(c, ctx, line.sku_id, f);
      receiptLot = lot.id;
      if (good) goodLots = [{ id: lot.id, qty: good }];
      if (damaged) damagedLots = [{ id: lot.id, qty: damaged }];
    }
  }
  const rec = await c.query<{ id: string }>(`INSERT INTO inbound_receipts(tenant_id,line_id,good_qty,damaged_qty,location_id,token,created_by,lot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, line.id, good, damaged, f.location_id, token, ctx.userId, receiptLot]);
  if (good) {
    if (!mode.tracked) await moveStock(c, ctx, { skuId: line.sku_id, locationId: f.location_id, delta: good, kind: "receive", refType: "inbound", refId: inboundId });
    else for (const x of goodLots) await moveStock(c, ctx, { skuId: line.sku_id, locationId: f.location_id, delta: x.qty, kind: "receive", refType: "inbound", refId: inboundId, lotId: x.id });
  }
  if (damaged) {
    const q = await systemLocation(c, ctx.tenantId, "quarantine");
    if (!mode.tracked) await moveStock(c, ctx, { skuId: line.sku_id, locationId: q, delta: damaged, kind: "receive_damaged", refType: "inbound", refId: inboundId, note: "Damaged on arrival" });
    else for (const x of damagedLots) await moveStock(c, ctx, { skuId: line.sku_id, locationId: q, delta: x.qty, kind: "receive_damaged", refType: "inbound", refId: inboundId, note: "Damaged on arrival", lotId: x.id });
  }
  await c.query(`UPDATE inbound_lines SET received_qty = received_qty + $2, damaged_qty = damaged_qty + $3 WHERE id=$1`, [line.id, good, damaged]);
  const open = (await c.query<any>(`SELECT count(*)::int n FROM inbound_lines WHERE inbound_id=$1 AND received_qty + damaged_qty < expected_qty`, [inboundId])).rows[0].n;
  await c.query(`UPDATE inbound_shipments SET status=$2 WHERE id=$1`, [inboundId, open ? "receiving" : "received"]);
  await charge(c, ctx, { partyId: inb.party_id, code: "receive_unit", qty: good + damaged, sourceKey: `recv:${rec.rows[0].id}`, detail: `${inb.no} · ${line.code}` });
  await audit(c, ctx.tenantId, actorOf(ctx), "inbound.received", "inbound", inboundId, { sku: line.code, good, damaged });
  const alloc = good > 0 ? await allocateWaitingInternal(c, ctx) : { orders: 0, units: 0 };
  return { duplicate: false as const, good, damaged, allocated: alloc };
}

/** Closing accepts any shortage; the variance stays visible on the record and in the audit trail. */
export async function closeInbound(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  const inb = await must(c.query<any>(`SELECT * FROM inbound_shipments WHERE id=$1 FOR UPDATE`, [id]), "Inbound");
  if (!["expected", "receiving", "received"].includes(inb.status)) throw badRequest(`This inbound is ${inb.status}.`);
  const v = (await c.query<any>(`SELECT coalesce(sum(expected_qty),0)::int e, coalesce(sum(received_qty + damaged_qty),0)::int r FROM inbound_lines WHERE inbound_id=$1`, [id])).rows[0];
  if (v.r === 0) throw badRequest("Nothing was received. Cancel the inbound instead.");
  await c.query(`UPDATE inbound_shipments SET status='closed', closed_at=now() WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "inbound.closed", "inbound", id, { expected: v.e, received: v.r });
}

export async function cancelInbound(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  const inb = await must(c.query<any>(`SELECT * FROM inbound_shipments WHERE id=$1 FOR UPDATE`, [id]), "Inbound");
  if (inb.status !== "expected") throw badRequest("Goods have already been received against this inbound; close it instead.");
  await c.query(`UPDATE inbound_shipments SET status='cancelled', closed_at=now() WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "inbound.cancelled", "inbound", id);
}

export const listInbound = (c: Conn, partyId?: string | null,page=1) => c.query<any>(
  `SELECT i.*, p.name AS party_name, (SELECT coalesce(sum(expected_qty),0)::int FROM inbound_lines l WHERE l.inbound_id=i.id) AS expected,
     (SELECT coalesce(sum(received_qty + damaged_qty),0)::int FROM inbound_lines l WHERE l.inbound_id=i.id) AS received
   FROM inbound_shipments i JOIN parties p ON p.id=i.party_id WHERE ($1::uuid IS NULL OR i.party_id=$1) ORDER BY i.created_at DESC,i.id LIMIT 51 OFFSET $2`, [partyId ?? null,(listPage(page)-1)*50]).then((r) => r.rows);

export async function getInbound(c: Conn, id: string) {
  const inb = await must(c.query<any>(`SELECT i.*, p.name AS party_name FROM inbound_shipments i JOIN parties p ON p.id=i.party_id WHERE i.id=$1`, [id]), "Inbound");
  const lines = (await c.query<any>(`SELECT l.*, s.code, s.name, s.tracking, s.rotation FROM inbound_lines l JOIN skus s ON s.id=l.sku_id WHERE l.inbound_id=$1 ORDER BY s.code`, [id])).rows;
  const receipts = (await c.query<any>(
    `SELECT r.*, s.code, loc.code AS location, u.name AS who FROM inbound_receipts r JOIN inbound_lines l ON l.id=r.line_id JOIN skus s ON s.id=l.sku_id
     JOIN wh_locations loc ON loc.id=r.location_id LEFT JOIN team_members u ON u.user_id=r.created_by WHERE l.inbound_id=$1 ORDER BY r.created_at`, [id])).rows;
  return { inb, lines, receipts };
}

// ───────────────────────── moves, counts, adjustments
/** Putaway / replenishment / quarantine release. Reserved units stay where their orders expect them. */
export async function transferStock(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const qty = posInt(f.qty, "Quantity");
  if (f.from_location === f.to_location) throw badRequest("Choose two different locations.");
  const from = await must(c.query<any>(`SELECT * FROM wh_locations WHERE id=$1`, [f.from_location]), "From location");
  const to = await must(c.query<any>(`SELECT * FROM wh_locations WHERE id=$1`, [f.to_location]), "To location");
  if (from.kind === "staging" || to.kind === "staging") throw badRequest("Staging is managed by picking and shipping.");
  if (!to.active) throw badRequest(`${to.code} is switched off.`);
  const sku = await must(c.query<any>(`SELECT id, code FROM skus WHERE id=$1`, [f.sku_id]), "SKU");
  const tmode = await skuMode(c, sku.id);
  const tlot = tmode.tracked ? (await findLot(c, sku.id, f.lot)).id : null;
  await moveStock(c, ctx, { skuId: sku.id, locationId: from.id, delta: -qty, kind: "transfer_out", note: `to ${to.code}`, lotId: tlot });
  await moveStock(c, ctx, { skuId: sku.id, locationId: to.id, delta: qty, kind: "transfer_in", note: `from ${from.code}`, lotId: tlot });
  await audit(c, ctx.tenantId, actorOf(ctx), "stock.transferred", "sku", sku.id, { from: from.code, to: to.code, qty });
  const alloc = to.kind === "bin" ? await allocateWaitingInternal(c, ctx) : { orders: 0, units: 0 };
  return { allocated: alloc };
}

/** A count that disagrees with the system raises an adjustment; nothing moves until someone else approves it. */
export async function requestAdjustment(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const counted = nonNegInt(f.counted_qty, "Counted quantity");
  if (f.counted_qty === undefined || String(f.counted_qty).trim() === "") throw badRequest("Enter the counted quantity.");
  const sku = await must(c.query<any>(`SELECT id, code FROM skus WHERE id=$1`, [f.sku_id]), "SKU");
  const loc = await must(c.query<any>(`SELECT * FROM wh_locations WHERE id=$1`, [f.location_id]), "Location");
  if (loc.kind === "staging") throw badRequest("Staging stock belongs to open orders; count it by finishing or cancelling those orders.");
  const amode = await skuMode(c, sku.id);
  const alot = amode.tracked ? (await findLot(c, sku.id, f.lot)).id : null;
  const sys = Number((await c.query<any>(alot ? `SELECT on_hand FROM stock_lot_levels WHERE sku_id=$1 AND location_id=$2 AND lot_id=$3` : `SELECT on_hand FROM stock_levels WHERE sku_id=$1 AND location_id=$2 AND $3::uuid IS NULL`, [sku.id, loc.id, alot])).rows[0]?.on_hand ?? 0);
  if (counted === sys) {
    await audit(c, ctx.tenantId, actorOf(ctx), "stock.count_verified", "sku", sku.id, { location: loc.code, qty: sys });
    return { verified: true as const };
  }
  const dupe = await c.query(`SELECT 1 FROM stock_adjustments WHERE sku_id=$1 AND location_id=$2 AND status='pending' AND lot_id IS NOT DISTINCT FROM $3::uuid`, [sku.id, loc.id, alot]);
  if (dupe.rows.length) throw badRequest("An adjustment for this SKU and location is already waiting for approval.");
  const r = await c.query<{ id: string }>(
    `INSERT INTO stock_adjustments(tenant_id,sku_id,location_id,system_qty,counted_qty,reason,requested_by,lot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, sku.id, loc.id, sys, counted, reqStr(f.reason, "Reason for the difference", 300), ctx.userId, alot]);
  await audit(c, ctx.tenantId, actorOf(ctx), "stock.adjustment_requested", "sku", sku.id, { location: loc.code, system: sys, counted });
  return { verified: false as const, id: r.rows[0].id, variance: counted - sys };
}

export async function decideAdjustment(c: Conn, ctx: Ctx, id: string, approve: boolean, note?: string) {
  require(ctx, "wh.approve");
  await lockStock(c, ctx.tenantId);
  const a = await must(c.query<any>(`SELECT a.*, s.code AS sku_code, loc.code AS loc_code FROM stock_adjustments a JOIN skus s ON s.id=a.sku_id JOIN wh_locations loc ON loc.id=a.location_id WHERE a.id=$1 FOR UPDATE OF a`, [id]), "Adjustment");
  if (a.status !== "pending") throw badRequest(`This adjustment is already ${a.status}; decisions are final.`);
  if (!approve) {
    await c.query(`UPDATE stock_adjustments SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [id, ctx.userId, optStr(note, 300)]);
    await audit(c, ctx.tenantId, actorOf(ctx), "stock.adjustment_rejected", "sku", a.sku_id, { location: a.loc_code });
    return { status: "rejected" as const };
  }
  if (a.requested_by === ctx.userId && !ctx.roles.includes("owner")) throw forbidden("A count adjustment cannot be approved by the person who counted.");
  await c.query(`SELECT 1 FROM stock_levels WHERE sku_id=$1 AND location_id=$2 FOR UPDATE`, [a.sku_id, a.location_id]);
  const cur = (await c.query<any>(a.lot_id ? `SELECT on_hand, reserved FROM stock_lot_levels WHERE sku_id=$1 AND location_id=$2 AND lot_id=$3 FOR UPDATE` : `SELECT on_hand, reserved FROM stock_levels WHERE sku_id=$1 AND location_id=$2 AND $3::uuid IS NULL FOR UPDATE`, [a.sku_id, a.location_id, a.lot_id])).rows[0];
  const onHand = Number(cur?.on_hand ?? 0);
  if (onHand !== a.system_qty) {
    // stock moved since the count: applying the old delta would be wrong, so the count is voided and must be repeated
    await c.query(`UPDATE stock_adjustments SET status='stale', decided_by=$2, decided_at=now(), decision_note='Stock moved since the count was taken; recount.' WHERE id=$1`, [id, ctx.userId]);
    await audit(c, ctx.tenantId, actorOf(ctx), "stock.adjustment_stale", "sku", a.sku_id, { location: a.loc_code });
    return { status: "stale" as const };
  }
  let released = 0;
  if (cur && a.counted_qty < Number(cur.reserved)) {
    // fewer units than reserved: free the newest reservations at this bin; those orders re-allocate or wait
    const need = Number(cur.reserved) - a.counted_qty;
    const allocs = (await c.query<any>(
      `SELECT a.*, l.order_id FROM stock_allocations a JOIN fulfil_order_lines l ON l.id=a.line_id WHERE a.sku_id=$1 AND a.location_id=$2 AND a.lot_id IS NOT DISTINCT FROM $3::uuid AND a.qty > a.picked_qty ORDER BY a.created_at DESC, a.id FOR UPDATE OF a`, [a.sku_id, a.location_id, a.lot_id])).rows;
    const touched = new Set<string>();
    for (const al of allocs) {
      if (released >= need) break;
      const take = Math.min(al.qty - al.picked_qty, need - released);
      await releaseReserved(c, ctx.tenantId, a.sku_id, a.location_id, a.lot_id, take);
      if (al.qty - take === 0) await c.query(`DELETE FROM stock_allocations WHERE id=$1`, [al.id]); else await c.query(`UPDATE stock_allocations SET qty = qty - $2 WHERE id=$1`, [al.id, take]);
      await c.query(`UPDATE fulfil_order_lines SET allocated_qty = allocated_qty - $2 WHERE id=$1`, [al.line_id, take]);
      touched.add(al.order_id); released += take;
    }
    for (const oid of touched) await refreshStatus(c, oid);
  }
  await moveStock(c, ctx, { skuId: a.sku_id, locationId: a.location_id, delta: a.counted_qty - onHand, kind: "adjust", refType: "adjustment", refId: id, note: a.reason, lotId: a.lot_id });
  await c.query(`UPDATE stock_adjustments SET status='applied', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [id, ctx.userId, optStr(note, 300)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "stock.adjustment_applied", "sku", a.sku_id, { location: a.loc_code, from: onHand, to: a.counted_qty, reservationsReleased: released });
  const alloc = await allocateWaitingInternal(c, ctx);
  return { status: "applied" as const, released, reallocated: alloc };
}

export const listAdjustments = (c: Conn, status?: string) => c.query<any>(
  `SELECT a.*, s.code AS sku_code, s.name AS sku_name, loc.code AS loc_code, p.name AS party_name, ru.name AS requester, du.name AS decider
   FROM stock_adjustments a JOIN skus s ON s.id=a.sku_id JOIN parties p ON p.id=s.party_id JOIN wh_locations loc ON loc.id=a.location_id
   LEFT JOIN team_members ru ON ru.user_id=a.requested_by LEFT JOIN team_members du ON du.user_id=a.decided_by
   WHERE ($1::text IS NULL OR a.status=$1) ORDER BY a.requested_at DESC LIMIT 200`, [status ?? null]).then((r) => r.rows);

// ───────────────────────── returns
export async function createReturn(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.party_id]), "Merchant");
  let orderId: string | null = null;
  const lines = await resolveSkus(c, f.party_id, parseQtyLines(f.lines, "line"));
  if (String(f.order_no ?? "").trim()) {
    const o = await must(c.query<any>(`SELECT id, status, party_id FROM fulfil_orders WHERE no=$1 AND party_id=$2`, [String(f.order_no).trim().toUpperCase(), f.party_id]), "Order for this merchant");
    if (o.status !== "shipped") throw badRequest("Only shipped orders can be returned.");
    orderId = o.id;
    for (const l of lines) {
      const ol = (await c.query<any>(`SELECT shipped_qty FROM fulfil_order_lines WHERE order_id=$1 AND sku_id=$2`, [orderId, l.sku_id])).rows[0];
      if (!ol) throw badRequest(`${l.code} was not on order ${f.order_no}.`);
      const already = Number((await c.query<any>(
        `SELECT coalesce(sum(rl.expected_qty),0) n FROM fulfil_return_lines rl JOIN fulfil_returns r ON r.id=rl.return_id WHERE r.order_id=$1 AND rl.sku_id=$2 AND r.status<>'cancelled'`, [orderId, l.sku_id])).rows[0].n);
      if (already + l.qty > ol.shipped_qty) throw badRequest(`${l.code}: only ${ol.shipped_qty} shipped and ${already} already on returns — cannot return ${l.qty} more.`);
    }
  }
  const no = await nextNumber(c, ctx.tenantId, "return", "RMA");
  const r = await c.query<{ id: string }>(`INSERT INTO fulfil_returns(tenant_id,no,party_id,order_id,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, no, f.party_id, orderId, optStr(f.reason, 300), ctx.userId]);
  for (const l of lines) await c.query(`INSERT INTO fulfil_return_lines(tenant_id,return_id,sku_id,expected_qty) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, r.rows[0].id, l.sku_id, l.qty]);
  await audit(c, ctx.tenantId, actorOf(ctx), "return.created", "return", r.rows[0].id, { no, order: orderId });
  return { id: r.rows[0].id, no };
}

export async function receiveReturn(c: Conn, ctx: Ctx, returnId: string, f: Record<string, any>) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const token = tokenOf(f.token);
  if ((await c.query(`SELECT 1 FROM fulfil_return_receipts WHERE token=$1`, [token])).rows.length) return { duplicate: true as const };
  const qty = posInt(f.qty, "Quantity", 100_000);
  const disposition = String(f.disposition);
  if (!["restock", "quarantine", "dispose"].includes(disposition)) throw badRequest("Choose what happens to these units.");
  const ret = await must(c.query<any>(`SELECT * FROM fulfil_returns WHERE id=$1 FOR UPDATE`, [returnId]), "Return");
  if (!["expected", "received"].includes(ret.status)) throw badRequest(`This return is ${ret.status}.`);
  const line = await must(c.query<any>(`SELECT l.*, s.code FROM fulfil_return_lines l JOIN skus s ON s.id=l.sku_id WHERE l.id=$1 AND l.return_id=$2 FOR UPDATE OF l`, [f.line_id, returnId]), "Return line");
  const left = line.expected_qty - line.restocked_qty - line.quarantined_qty - line.disposed_qty;
  if (qty > left) throw badRequest(`${line.code}: only ${left} unit(s) still expected on this return.`);
  let locId: string | null = null;
  // tracked SKUs: the returned unit must be identified, and a returned lot must really have shipped on the linked order
  const rmode = await skuMode(c, line.sku_id);
  let rlot: any = null;
  if (rmode.tracked) {
    rlot = await findLot(c, line.sku_id, f.lot);
    if (rmode.tracking === "serial" && qty !== 1) throw badRequest("Return serial-tracked units one at a time.");
    if (ret.order_id) {
      const shipped = Number((await c.query<any>(`SELECT coalesce(sum(a.picked_qty),0) n FROM stock_allocations a JOIN fulfil_order_lines l ON l.id=a.line_id WHERE l.order_id=$1 AND a.lot_id=$2`, [ret.order_id, rlot.id])).rows[0].n);
      const back = Number((await c.query<any>(`SELECT coalesce(sum(r.qty),0) n FROM fulfil_return_receipts r JOIN fulfil_return_lines rl ON rl.id=r.line_id JOIN fulfil_returns x ON x.id=rl.return_id WHERE x.order_id=$1 AND r.lot_id=$2`, [ret.order_id, rlot.id])).rows[0].n);
      if (back + qty > shipped) throw badRequest(`Lot ${rlot.lot} shipped ${shipped} unit(s) on this order and ${back} already came back.`);
    }
    if (disposition === "restock" && lotBlocked(rlot)) throw badRequest(`Lot ${rlot.lot} is on hold or expired: quarantine or dispose of the units.`);
  }
  if (disposition === "restock") {
    const loc = await must(c.query<any>(`SELECT * FROM wh_locations WHERE id=$1`, [f.location_id]), "Location");
    if (!(loc.active && ["bin", "receiving"].includes(loc.kind))) throw badRequest("Restock into a bin or the receiving area.");
    locId = loc.id;
  } else if (disposition === "quarantine") locId = await systemLocation(c, ctx.tenantId, "quarantine");
  const rec = await c.query<{ id: string }>(`INSERT INTO fulfil_return_receipts(tenant_id,line_id,qty,disposition,location_id,token,created_by,lot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, line.id, qty, disposition, locId, token, ctx.userId, rlot?.id ?? null]);
  if (disposition === "restock") await moveStock(c, ctx, { skuId: line.sku_id, locationId: locId!, delta: qty, kind: "return_restock", refType: "return", refId: returnId, lotId: rlot?.id });
  if (disposition === "quarantine") await moveStock(c, ctx, { skuId: line.sku_id, locationId: locId!, delta: qty, kind: "return_quarantine", refType: "return", refId: returnId, lotId: rlot?.id });
  const col = disposition === "restock" ? "restocked_qty" : disposition === "quarantine" ? "quarantined_qty" : "disposed_qty";
  await c.query(`UPDATE fulfil_return_lines SET ${col} = ${col} + $2 WHERE id=$1`, [line.id, qty]);
  const open = (await c.query<any>(`SELECT count(*)::int n FROM fulfil_return_lines WHERE return_id=$1 AND restocked_qty + quarantined_qty + disposed_qty < expected_qty`, [returnId])).rows[0].n;
  await c.query(`UPDATE fulfil_returns SET status=$2 WHERE id=$1`, [returnId, open ? "expected" : "received"]);
  await charge(c, ctx, { partyId: ret.party_id, code: "return_unit", qty, sourceKey: `ret:${rec.rows[0].id}`, detail: `${ret.no} · ${line.code}` });
  await audit(c, ctx.tenantId, actorOf(ctx), "return.received", "return", returnId, { sku: line.code, qty, disposition });
  const alloc = disposition === "restock" ? await allocateWaitingInternal(c, ctx) : { orders: 0, units: 0 };
  return { duplicate: false as const, allocated: alloc };
}

export async function closeReturn(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  const r = await must(c.query<any>(`SELECT * FROM fulfil_returns WHERE id=$1 FOR UPDATE`, [id]), "Return");
  if (!["expected", "received"].includes(r.status)) throw badRequest(`This return is ${r.status}.`);
  await c.query(`UPDATE fulfil_returns SET status='closed', closed_at=now() WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "return.closed", "return", id);
}

export async function cancelReturn(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  const r = await must(c.query<any>(`SELECT * FROM fulfil_returns WHERE id=$1 FOR UPDATE`, [id]), "Return");
  const got = await c.query(`SELECT 1 FROM fulfil_return_lines WHERE return_id=$1 AND restocked_qty + quarantined_qty + disposed_qty > 0`, [id]);
  if (r.status !== "expected" || got.rows.length) throw badRequest("Units were already received; close the return instead.");
  await c.query(`UPDATE fulfil_returns SET status='cancelled', closed_at=now() WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "return.cancelled", "return", id);
}

export const listReturns = (c: Conn, partyId?: string | null,page=1) => c.query<any>(
  `SELECT r.*, p.name AS party_name, o.no AS order_no,
     (SELECT coalesce(sum(expected_qty),0)::int FROM fulfil_return_lines l WHERE l.return_id=r.id) AS expected,
     (SELECT coalesce(sum(restocked_qty + quarantined_qty + disposed_qty),0)::int FROM fulfil_return_lines l WHERE l.return_id=r.id) AS handled
   FROM fulfil_returns r JOIN parties p ON p.id=r.party_id LEFT JOIN fulfil_orders o ON o.id=r.order_id
   WHERE ($1::uuid IS NULL OR r.party_id=$1) ORDER BY r.created_at DESC,r.id LIMIT 51 OFFSET $2`, [partyId ?? null,(listPage(page)-1)*50]).then((r) => r.rows);

export async function getReturn(c: Conn, id: string) {
  const ret = await must(c.query<any>(`SELECT r.*, p.name AS party_name, o.no AS order_no FROM fulfil_returns r JOIN parties p ON p.id=r.party_id LEFT JOIN fulfil_orders o ON o.id=r.order_id WHERE r.id=$1`, [id]), "Return");
  const lines = (await c.query<any>(`SELECT l.*, s.code, s.name, s.tracking, s.rotation FROM fulfil_return_lines l JOIN skus s ON s.id=l.sku_id WHERE l.return_id=$1 ORDER BY s.code`, [id])).rows;
  const receipts = (await c.query<any>(
    `SELECT r.*, s.code, loc.code AS location FROM fulfil_return_receipts r JOIN fulfil_return_lines l ON l.id=r.line_id JOIN skus s ON s.id=l.sku_id
     LEFT JOIN wh_locations loc ON loc.id=r.location_id WHERE l.return_id=$1 ORDER BY r.created_at`, [id])).rows;
  return { ret, lines, receipts };
}

// ───────────────────────── reading
export const listFulfilOrders = (c: Conn, opts: { partyId?: string | null; status?: string | null; q?: string | null; page?:number; ctx?:Ctx } = {}) => {
 if(opts.ctx&&!(opts.ctx.roles.length===1&&opts.ctx.roles[0]==='portal'&&opts.ctx.partyId))require(opts.ctx,'read');
 return c.query<any>(
  `SELECT o.*, p.name AS party_name, (SELECT coalesce(sum(qty - closed_qty),0)::int FROM fulfil_order_lines l WHERE l.order_id=o.id) AS units,
     (SELECT coalesce(sum(shipped_qty),0)::int FROM fulfil_order_lines l WHERE l.order_id=o.id) AS shipped_units,
     (o.ship_by IS NOT NULL AND o.ship_by < now() AND o.status NOT IN ('shipped','cancelled')) AS late, sh.carrier, sh.tracking_no
   FROM fulfil_orders o JOIN parties p ON p.id=o.party_id LEFT JOIN fulfil_shipments sh ON sh.order_id=o.id
   WHERE ($1::uuid IS NULL OR o.party_id=$1) AND ($2::text IS NULL OR o.status=$2)
     AND ($3::text IS NULL OR o.external_ref ILIKE '%'||$3||'%' OR o.no ILIKE '%'||$3||'%' OR ($4 AND o.ship_to_name ILIKE '%'||$3||'%') OR sh.tracking_no ILIKE '%'||$3||'%')
   ORDER BY o.created_at DESC,o.id LIMIT 51 OFFSET $5`, [opts.ctx?.partyId??opts.partyId??null, opts.status || null, opts.q?.trim() || null,opts.ctx?canReadFulfilmentRecipient(opts.ctx):true,(listPage(opts.page??1)-1)*50]).then((r) => opts.ctx?r.rows.map(row=>redactFulfilmentRecipient(row,opts.ctx!)):r.rows);
};

export async function getFulfilOrder(c: Conn, id: string, ctx?:Ctx) {
  if(ctx&&!(ctx.roles.length===1&&ctx.roles[0]==='portal'&&ctx.partyId))require(ctx,'read');
  const order = await must(c.query<any>(`SELECT o.*, p.name AS party_name FROM fulfil_orders o JOIN parties p ON p.id=o.party_id WHERE o.id=$1`, [id]), "Order");
  if(ctx?.partyId&&order.party_id!==ctx.partyId)throw new HttpError(404,'Order not found.');
  const [lines, allocs, shipment, charges, returns] = await Promise.all([
    c.query<any>(`SELECT l.*, s.code, s.name, s.barcode, (l.qty - l.closed_qty - l.allocated_qty)::int AS waiting FROM fulfil_order_lines l JOIN skus s ON s.id=l.sku_id WHERE l.order_id=$1 ORDER BY s.code`, [id]),
    c.query<any>(`SELECT a.*, loc.code AS location, s.code AS sku_code, (a.qty - a.picked_qty)::int AS remaining FROM stock_allocations a JOIN fulfil_order_lines l ON l.id=a.line_id JOIN wh_locations loc ON loc.id=a.location_id JOIN skus s ON s.id=a.sku_id WHERE l.order_id=$1 ORDER BY loc.code, s.code`, [id]),
    c.query<any>(`SELECT * FROM fulfil_shipments WHERE order_id=$1`, [id]),
    c.query<any>(`SELECT *, qty::float8 AS qty FROM fulfil_charges WHERE order_id=$1 ORDER BY created_at`, [id]),
    c.query<any>(`SELECT * FROM fulfil_returns WHERE order_id=$1 ORDER BY created_at`, [id]),
  ]);
  return { order:ctx?redactFulfilmentRecipient(order,ctx):order, lines: lines.rows, allocs: allocs.rows, shipment: shipment.rows[0] ?? null, charges: charges.rows, returns: returns.rows };
}

/** One row per SKU: where its units are and how many can still be promised to new orders. */
export const stockOverview = (c: Conn, partyId?: string | null) => c.query<any>(
  `SELECT s.id, s.code, s.name, s.barcode, s.reorder_point, s.active, s.party_id, s.tracking, s.rotation, p.name AS party_name,
     coalesce(sum(l.on_hand) FILTER (WHERE loc.kind='bin'),0)::int AS in_bins,
     coalesce(sum(l.reserved) FILTER (WHERE loc.kind='bin'),0)::int AS reserved,
     coalesce(sum(l.on_hand) FILTER (WHERE loc.kind='receiving'),0)::int AS receiving,
     coalesce(sum(l.on_hand) FILTER (WHERE loc.kind='staging'),0)::int AS staged,
     coalesce(sum(l.on_hand) FILTER (WHERE loc.kind='quarantine'),0)::int AS quarantine,
     coalesce(sum(l.on_hand - l.reserved) FILTER (WHERE loc.kind='bin' AND loc.active),0)::int AS available,
     (SELECT coalesce(sum(il.expected_qty - il.received_qty - il.damaged_qty),0)::int FROM inbound_lines il JOIN inbound_shipments ib ON ib.id=il.inbound_id
        WHERE il.sku_id=s.id AND ib.status IN ('expected','receiving')) AS incoming,
     (SELECT coalesce(sum(ol.qty - ol.closed_qty - ol.allocated_qty),0)::int FROM fulfil_order_lines ol JOIN fulfil_orders o ON o.id=ol.order_id
        WHERE ol.sku_id=s.id AND o.status IN ('new','backordered','allocated','picking','picked','packed')) AS backordered
   FROM skus s JOIN parties p ON p.id=s.party_id LEFT JOIN stock_levels l ON l.sku_id=s.id LEFT JOIN wh_locations loc ON loc.id=l.location_id
   WHERE ($1::uuid IS NULL OR s.party_id=$1) GROUP BY s.id, p.name ORDER BY p.name, s.code`, [partyId ?? null]).then((r) => r.rows);

export const stockByLocation = (c: Conn, skuId: string) => c.query<any>(
  `SELECT loc.code, loc.kind, l.on_hand, l.reserved, (l.on_hand - l.reserved) AS available FROM stock_levels l JOIN wh_locations loc ON loc.id=l.location_id
   WHERE l.sku_id=$1 AND (l.on_hand > 0 OR l.reserved > 0) ORDER BY loc.code`, [skuId]).then((r) => r.rows);

export const skuLedger = (c: Conn, skuId: string, limit = 100) => c.query<any>(
  `SELECT m.*, loc.code AS location, u.name AS who FROM stock_movements m JOIN wh_locations loc ON loc.id=m.location_id LEFT JOIN team_members u ON u.user_id=m.created_by
   WHERE m.sku_id=$1 ORDER BY m.created_at DESC, m.id LIMIT $2`, [skuId, limit]).then((r) => r.rows);

/** Fulfilment board: what is waiting at each stage, and what is late. */
export async function fulfilmentOverview(c: Conn) {
  const n = async (sql: string) => Number((await c.query<any>(sql)).rows[0].n);
  const stock = await stockOverview(c);
  const low = stock.filter((s: any) => s.active && s.reorder_point > 0 && s.available <= s.reorder_point);
  return {
    byStatus: Object.fromEntries((await c.query<any>(`SELECT status, count(*)::int n FROM fulfil_orders GROUP BY status`)).rows.map((r) => [r.status, r.n])) as Record<string, number>,
    late: (await c.query<any>(`SELECT o.id, o.no, o.status, o.ship_by, p.name AS party FROM fulfil_orders o JOIN parties p ON p.id=o.party_id WHERE o.ship_by < now() AND o.status IN ('new','backordered','allocated','picking','picked','packed') ORDER BY o.ship_by LIMIT 10`)).rows,
    backordered: (await c.query<any>(`SELECT o.id, o.no, p.name AS party, o.ordered_at FROM fulfil_orders o JOIN parties p ON p.id=o.party_id WHERE o.status='backordered' ORDER BY o.ordered_at LIMIT 10`)).rows,
    toPack: await n(`SELECT count(*) n FROM fulfil_orders WHERE status IN ('picking','picked') AND EXISTS (SELECT 1 FROM fulfil_order_lines l WHERE l.order_id=fulfil_orders.id AND l.packed_qty < l.picked_qty)`),
    inbound: (await c.query<any>(`SELECT i.id, i.no, i.status, i.expected_at, p.name AS party FROM inbound_shipments i JOIN parties p ON p.id=i.party_id WHERE i.status IN ('expected','receiving') ORDER BY i.expected_at NULLS LAST LIMIT 10`)).rows,
    pendingAdjustments: await n(`SELECT count(*) n FROM stock_adjustments WHERE status='pending'`),
    returnsOpen: await n(`SELECT count(*) n FROM fulfil_returns WHERE status IN ('expected','received')`),
    quarantineUnits: await n(`SELECT coalesce(sum(l.on_hand),0) n FROM stock_levels l JOIN wh_locations loc ON loc.id=l.location_id WHERE loc.kind='quarantine'`),
    openExceptions: await n(`SELECT count(*) n FROM job_exceptions WHERE status='open' AND title LIKE 'Short pick%'`),
    unbilled: await n(`SELECT coalesce(sum(qty*unit_minor),0) n FROM fulfil_charges WHERE invoice_id IS NULL`),
    low,
  };
}

/**
 * Quality hold or release of a lot. A hold frees every open reservation of the lot (orders re-allocate from other lots or wait);
 * units already picked to staging stay put but cannot ship. Releasing needs a second person unless an owner decides.
 */
export async function holdFulfilLot(c: Conn, ctx: Ctx, lotId: string, hold: boolean, reason: string) {
  require(ctx, "wh.approve");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const lot = await must(c.query<any>(`SELECT * FROM fulfil_lots WHERE id=$1 FOR UPDATE`, [lotId]), "Lot");
  if (lot.hold === hold) throw badRequest(hold ? "This lot is already on hold." : "This lot is not on hold.");
  if (!hold) {
    const last = (await c.query<any>(`SELECT decided_by FROM fulfil_lot_decisions WHERE lot_id=$1 AND hold ORDER BY decided_at DESC LIMIT 1`, [lotId])).rows[0];
    if (last?.decided_by === ctx.userId && !ctx.roles.includes("owner")) throw forbidden("A lot hold must be released by someone other than the person who placed it.");
    if (lot.expires_at && new Date(lot.expires_at).toISOString().slice(0, 10) <= new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10)) throw badRequest("An expired lot cannot be released.");
  }
  await recordDecision(c, ctx, lotId, hold, reason);
  let released = 0;
  if (hold) {
    const allocs = (await c.query<any>(`SELECT a.*, l.order_id FROM stock_allocations a JOIN fulfil_order_lines l ON l.id=a.line_id WHERE a.lot_id=$1 AND a.qty > a.picked_qty FOR UPDATE OF a`, [lotId])).rows;
    const touched = new Set<string>();
    for (const al of allocs) {
      const take = al.qty - al.picked_qty;
      await releaseReserved(c, ctx.tenantId, al.sku_id, al.location_id, lotId, take);
      if (al.qty - take === 0) await c.query(`DELETE FROM stock_allocations WHERE id=$1`, [al.id]); else await c.query(`UPDATE stock_allocations SET qty = qty - $2 WHERE id=$1`, [al.id, take]);
      await c.query(`UPDATE fulfil_order_lines SET allocated_qty = allocated_qty - $2 WHERE id=$1`, [al.line_id, take]);
      touched.add(al.order_id); released += take;
    }
    for (const oid of touched) await refreshStatus(c, oid);
  }
  const alloc = await allocateWaitingInternal(c, ctx);
  return { released, reallocated: alloc };
}
