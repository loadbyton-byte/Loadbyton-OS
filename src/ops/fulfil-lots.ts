import { z } from "zod";
import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest } from "../lib/util.js";
import { must, reqStr } from "./common.js";

/** Dubai calendar day (UTC+4, no DST) — the cut-off every expiry comparison uses. */
export const dubaiDay = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
const day = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : null);

export interface SkuMode { tracking: "none" | "lot" | "serial"; rotation: "fifo" | "fefo"; min_shelf_days: number; tracked: boolean }
export async function skuMode(c: Conn, skuId: string): Promise<SkuMode> {
  const s = await must(c.query<any>(`SELECT tracking, rotation, min_shelf_days FROM skus WHERE id=$1`, [skuId]), "SKU");
  return { ...s, tracked: s.tracking !== "none" || s.rotation === "fefo" };
}

/**
 * Register (or re-find) the lot an inbound unit belongs to. Identity is bound to issued, non-held evidence and can never be
 * re-pointed: a second receipt of the same lot must repeat the same expiry, serial and evidence.
 */
export async function ensureLot(c: Conn, ctx: Ctx, skuId: string, f: Record<string, any>) {
  const mode = await skuMode(c, skuId);
  if (!mode.tracked) throw badRequest("This SKU is not lot, serial or expiry tracked.");
  const lot = reqStr(f.lot ?? f.serial_ref, "Lot / serial", 60).toUpperCase();
  const serial = mode.tracking === "serial" ? lot : null;
  const expires = f.expires_at ? String(f.expires_at) : null;
  if (expires && !z.iso.date().safeParse(expires).success) throw badRequest("Use a valid expiry date.");
  if (mode.rotation === "fefo" && !expires) throw badRequest("FEFO stock needs an expiry date.");
  const doc = await must(c.query<any>(`SELECT id FROM documents WHERE id=$1 AND status='issued' AND NOT hold`, [f.document_id]), "Issued source evidence for the lot");
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${ctx.tenantId}:fulfil-lot`]);
  const old = (await c.query<any>(`SELECT * FROM fulfil_lots WHERE sku_id=$1 AND lot=$2`, [skuId, lot])).rows[0];
  if (old) {
    if (day(old.expires_at) !== expires || (old.serial_ref ?? null) !== serial || old.document_id !== doc.id) throw new HttpError(409, "That lot already exists with different expiry or source evidence.", "conflict");
    return old;
  }
  const r = await c.query<any>(
    `INSERT INTO fulfil_lots(tenant_id,sku_id,lot,expires_at,serial_ref,document_id,hold,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [ctx.tenantId, skuId, lot, expires, serial, doc.id, !!expires && expires <= dubaiDay(), ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_lot.registered", "fulfil_lot", r.rows[0].id, { lot, expires, serial });
  return r.rows[0];
}

/** Resolve an existing lot by lot code or serial. */
export async function findLot(c: Conn, skuId: string, code: unknown) {
  const v = reqStr(code, "Lot / serial", 60).toUpperCase();
  return must(c.query<any>(`SELECT * FROM fulfil_lots WHERE sku_id=$1 AND (lot=$2 OR serial_ref=$2)`, [skuId, v]), "Lot");
}

export const lotBlocked = (l: { hold: boolean; expires_at: unknown }) => l.hold || (!!l.expires_at && day(l.expires_at)! <= dubaiDay());

/** Lot-level mirror of a stock_levels change. `fromReserved` consumes the same units from the reservation. */
export async function applyLotMove(c: Conn, ctx: Ctx, skuId: string, locationId: string, lotId: string, delta: number, fromReserved = false) {
  if (delta > 0) {
    await c.query(
      `INSERT INTO stock_lot_levels(tenant_id,sku_id,location_id,lot_id,on_hand) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id,sku_id,location_id,lot_id) DO UPDATE SET on_hand = stock_lot_levels.on_hand + $5`, [ctx.tenantId, skuId, locationId, lotId, delta]);
    return;
  }
  const q = -delta;
  const r = await c.query(
    `UPDATE stock_lot_levels SET on_hand = on_hand - $5, reserved = reserved - $6
     WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND lot_id=$4 AND on_hand - $5 >= reserved - $6 AND reserved >= $6 RETURNING on_hand`,
    [ctx.tenantId, skuId, locationId, lotId, q, fromReserved ? q : 0]);
  if (!r.rows.length) throw badRequest("Not enough unreserved stock of that lot at the location.");
}

export async function reserveLot(c: Conn, tenantId: string, skuId: string, locationId: string, lotId: string, qty: number) {
  const r = await c.query(
    `UPDATE stock_lot_levels SET reserved = reserved + $5 WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND lot_id=$4 AND on_hand - reserved >= $5 RETURNING reserved`,
    [tenantId, skuId, locationId, lotId, qty]);
  if (!r.rows.length) throw new HttpError(409, "Stock changed while allocating; please try again.", "conflict");
}
export const releaseLot = (c: Conn, tenantId: string, skuId: string, locationId: string, lotId: string, qty: number) =>
  c.query(`UPDATE stock_lot_levels SET reserved = reserved - $5 WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND lot_id=$4 AND reserved >= $5`, [tenantId, skuId, locationId, lotId, qty]);

export interface LotBin { location_id: string; lot_id: string; avail: number }
/** Strict rotation: units come from the first lot in (FEFO expiry / FIFO receipt) order — no best-fit shortcuts across lots. */
export function planLots(bins: LotBin[], need: number) {
  const picks: { location_id: string; lot_id: string; qty: number }[] = [];
  let left = need;
  for (const b of bins) {
    if (left <= 0) break;
    const q = Math.min(b.avail, left);
    picks.push({ location_id: b.location_id, lot_id: b.lot_id, qty: q });
    left -= q;
  }
  return { picks, total: need - left };
}
export async function allocatableLots(c: Conn, skuId: string, mode: SkuMode, siteId: string | null = null): Promise<LotBin[]> {
  const order = mode.rotation === "fefo" ? "lot.expires_at NULLS LAST, lot.created_at, loc.code" : "lot.created_at, loc.code";
  return (await c.query<any>(
    `SELECT sl.location_id, sl.lot_id, (sl.on_hand - sl.reserved)::int AS avail FROM stock_lot_levels sl
       JOIN fulfil_lots lot ON lot.id=sl.lot_id JOIN wh_locations loc ON loc.id=sl.location_id
     WHERE sl.sku_id=$1 AND loc.kind='bin' AND loc.active AND sl.on_hand - sl.reserved > 0 AND NOT lot.hold
       AND (lot.expires_at IS NULL OR lot.expires_at > ($2::date + $3::int)) AND ($4::uuid IS NULL OR loc.site_id=$4) ORDER BY ${order}`, [skuId, dubaiDay(), mode.min_shelf_days, siteId])).rows;
}

export async function lotWorkspace(c: Conn, partyId?: string | null) {
  const today = dubaiDay();
  return (await c.query<any>(
    `SELECT l.*, s.code AS sku_code, s.name AS sku_name, s.party_id, s.tracking, s.rotation,
       coalesce((SELECT sum(on_hand) FROM stock_lot_levels v WHERE v.lot_id=l.id),0)::int AS on_hand,
       coalesce((SELECT sum(reserved) FROM stock_lot_levels v WHERE v.lot_id=l.id),0)::int AS reserved,
       CASE WHEN l.expires_at IS NULL THEN NULL ELSE (l.expires_at - $2::date) END AS days_left
     FROM fulfil_lots l JOIN skus s ON s.id=l.sku_id WHERE ($1::uuid IS NULL OR s.party_id=$1)
     ORDER BY l.expires_at NULLS LAST, s.code, l.lot LIMIT 500`, [partyId ?? null, today])).rows;
}

/** Recall trace: where the lot sits now and every order/shipment/recipient that received units. */
export async function traceLot(c: Conn, ctx: Ctx, lotId: string) {
  require(ctx, "read");
  const lot = await must(c.query<any>(`SELECT l.*, s.code AS sku_code, s.name AS sku_name FROM fulfil_lots l JOIN skus s ON s.id=l.sku_id WHERE l.id=$1`, [lotId]), "Lot");
  const where = (await c.query<any>(`SELECT loc.code, v.on_hand, v.reserved FROM stock_lot_levels v JOIN wh_locations loc ON loc.id=v.location_id WHERE v.lot_id=$1 AND v.on_hand>0 ORDER BY loc.code`, [lotId])).rows;
  const orders = (await c.query<any>(
    `SELECT o.id, o.no, o.status, o.shipped_at, a.picked_qty AS units, sh.carrier, sh.tracking_no, o.ship_to_name, o.ship_to_city
     FROM stock_allocations a JOIN fulfil_order_lines l ON l.id=a.line_id JOIN fulfil_orders o ON o.id=l.order_id
     LEFT JOIN fulfil_shipments sh ON sh.order_id=o.id WHERE a.lot_id=$1 AND a.picked_qty>0 ORDER BY o.created_at`, [lotId])).rows;
  const decisions = (await c.query<any>(`SELECT hold, reason, decided_at FROM fulfil_lot_decisions WHERE lot_id=$1 ORDER BY decided_at`, [lotId])).rows;
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_lot.traced", "fulfil_lot", lotId, { orders: orders.length });
  return { lot, where, orders, decisions };
}

export async function recordDecision(c: Conn, ctx: Ctx, lotId: string, hold: boolean, reason: unknown) {
  const why = reqStr(reason, "Quality decision evidence", 2000);
  await c.query(`INSERT INTO fulfil_lot_decisions(tenant_id,lot_id,hold,reason,decided_by) VALUES ($1,$2,$3,$4,$5)`, [ctx.tenantId, lotId, hold, why, ctx.userId]);
  await c.query(`UPDATE fulfil_lots SET hold=$2 WHERE id=$1`, [lotId, hold]);
  await audit(c, ctx.tenantId, actorOf(ctx), hold ? "fulfil_lot.held" : "fulfil_lot.release_approved", "fulfil_lot", lotId, { reason: why });
}

/** Issued, non-held documents that can stand as lot source evidence. */
export const issuedEvidence = (c: Conn) => c.query<any>(`SELECT id, title, issuer FROM documents WHERE status='issued' AND NOT hold ORDER BY created_at DESC LIMIT 200`).then((r) => r.rows);
