import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest, forbidden } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, nextNumber, optStr } from "./common.js";
import { lotBlocked } from "./fulfil-lots.js";
import { lockStock, pickAllocation, refreshStatus, systemLocation } from "./fulfilment.js";

export const STRATEGIES = {
  wave: "Wave — one consolidated walk-ordered list across the selected orders",
  zone: "Zone — one task per zone, each picker works their zone only",
  batch: "Batch — pick the combined quantity once, then split it across orders",
} as const;
type Strategy = keyof typeof STRATEGIES;

const OPEN_ALLOC = `SELECT a.*, l.order_id, o.no AS order_no, o.ship_by, o.created_at AS order_created, o.created_by AS order_creator,
    loc.code AS loc_code, coalesce(loc.zone,'UNZONED') AS zone, s.code AS sku_code, s.name AS sku_name, s.barcode,
    lot.lot AS lot_code, lot.hold AS lot_hold, lot.expires_at AS lot_expires
  FROM fulfil_wave_orders w JOIN fulfil_order_lines l ON l.order_id=w.order_id JOIN stock_allocations a ON a.line_id=l.id AND a.qty > a.picked_qty
  JOIN fulfil_orders o ON o.id=l.order_id JOIN wh_locations loc ON loc.id=a.location_id JOIN skus s ON s.id=a.sku_id LEFT JOIN fulfil_lots lot ON lot.id=a.lot_id
  WHERE w.wave_id=$1 AND w.active AND o.status IN ('allocated','picking')`;

/** Release a pick wave over allocated orders. Orders can sit in only one active wave. */
export async function createWave(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const strategy = String(f.strategy) as Strategy;
  if (!(strategy in STRATEGIES)) throw badRequest("Choose wave, zone or batch picking.");
  const max = Math.min(200, Math.max(1, Number(f.max_orders) || 50));
  let ids: string[];
  if (Array.isArray(f.order_ids) && f.order_ids.length) {
    ids = f.order_ids.map(String);
    if (ids.length > 200) throw badRequest("A wave holds at most 200 orders.");
  } else {
    ids = (await c.query<any>(
      `SELECT o.id FROM fulfil_orders o WHERE o.status IN ('allocated','picking') AND ($1::uuid IS NULL OR o.site_id=$1) AND ($2::timestamptz IS NULL OR o.ship_by <= $2)
         AND NOT EXISTS (SELECT 1 FROM fulfil_wave_orders w WHERE w.order_id=o.id AND w.active)
         AND EXISTS (SELECT 1 FROM stock_allocations a JOIN fulfil_order_lines l ON l.id=a.line_id WHERE l.order_id=o.id AND a.qty > a.picked_qty)
       ORDER BY o.ship_by NULLS LAST, o.created_at, o.id LIMIT $3`, [f.site_id || null, f.ship_by_before || null, max])).rows.map((r) => r.id);
  }
  if (!ids.length) throw badRequest("No allocated orders are waiting to be picked.");
  for (const id of ids) {
    const o = await must(c.query<any>(`SELECT id, no, status FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [id]), "Order");
    if (!["allocated", "picking"].includes(o.status)) throw badRequest(`${o.no} is ${o.status}; only allocated orders join a wave.`);
    if ((await c.query(`SELECT 1 FROM fulfil_wave_orders WHERE order_id=$1 AND active`, [id])).rows.length) throw badRequest(`${o.no} is already in an active wave.`);
  }
  const no = await nextNumber(c, ctx.tenantId, "pick_wave", "WAV");
  const wave = (await c.query<{ id: string }>(`INSERT INTO fulfil_waves(tenant_id,no,strategy,note,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.tenantId, no, strategy, optStr(f.note, 300), ctx.userId])).rows[0].id;
  for (const id of ids) await c.query(`INSERT INTO fulfil_wave_orders(tenant_id,wave_id,order_id) VALUES ($1,$2,$3)`, [ctx.tenantId, wave, id]);
  const zones = strategy === "zone" ? (await c.query<any>(`SELECT DISTINCT zone FROM (${OPEN_ALLOC}) x ORDER BY zone`, [wave])).rows.map((r) => r.zone as string) : ["*"];
  if (!zones.length) throw badRequest("Nothing to pick in the selected orders.");
  for (const z of zones) await c.query(`INSERT INTO fulfil_pick_tasks(tenant_id,wave_id,zone) VALUES ($1,$2,$3)`, [ctx.tenantId, wave, z]);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_wave.released", "fulfil_wave", wave, { no, strategy, orders: ids.length, tasks: zones.length });
  return { id: wave, no, orders: ids.length, tasks: zones.length };
}

export async function claimPickTask(c: Conn, ctx: Ctx, taskId: string) {
  require(ctx, "wh.floor");
  const t = await must(c.query<any>(`SELECT * FROM fulfil_pick_tasks WHERE id=$1 FOR UPDATE`, [taskId]), "Pick task");
  if (t.status === "done") throw badRequest("This task is done.");
  if (t.status === "claimed" && t.assigned_to !== ctx.userId && !ctx.perms.has("wh.approve")) throw forbidden("Another picker has this task.");
  await c.query(`UPDATE fulfil_pick_tasks SET status='claimed', assigned_to=$2, claimed_at=now() WHERE id=$1`, [taskId, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_task.claimed", "fulfil_pick_task", taskId);
}

/** What the picker walks: per-allocation rows (wave / zone) or combined (location, SKU, lot) rows (batch). */
export async function taskLines(c: Conn, taskId: string) {
  const t = await must(c.query<any>(`SELECT t.*, w.strategy, w.no AS wave_no FROM fulfil_pick_tasks t JOIN fulfil_waves w ON w.id=t.wave_id WHERE t.id=$1`, [taskId]), "Pick task");
  const rows = (await c.query<any>(`SELECT * FROM (${OPEN_ALLOC}) x WHERE ($2::text='*' OR zone=$2) ORDER BY loc_code, sku_code, lot_code NULLS FIRST, ship_by NULLS LAST, order_created, id`, [t.wave_id, t.zone])).rows;
  if (t.strategy !== "batch") return { task: t, lines: rows.map((r) => ({ key: r.id, location: r.loc_code, zone: r.zone, sku: r.sku_code, name: r.sku_name, barcode: r.barcode, lot: r.lot_code, remaining: r.qty - r.picked_qty, orders: [r.order_no] })) };
  const by = new Map<string, any>();
  for (const r of rows) {
    const k = `${r.location_id}|${r.sku_id}|${r.lot_id ?? ""}`, e = by.get(k) ?? { key: k, location: r.loc_code, zone: r.zone, sku: r.sku_code, name: r.sku_name, barcode: r.barcode, lot: r.lot_code, remaining: 0, orders: [] as string[] };
    e.remaining += r.qty - r.picked_qty; if (!e.orders.includes(r.order_no)) e.orders.push(r.order_no); by.set(k, e);
  }
  return { task: t, lines: [...by.values()] };
}

/**
 * Confirm what was found. `entries` maps a line key (allocation id, or the batch key) to the quantity found.
 * Batch quantities are split to orders by earliest ship-by then order age; any shortfall lands on the latest orders and raises count tasks.
 */
export async function pickWaveTask(c: Conn, ctx: Ctx, taskId: string, entries: Record<string, number>) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const t = await must(c.query<any>(`SELECT t.*, w.strategy, w.status AS wave_status FROM fulfil_pick_tasks t JOIN fulfil_waves w ON w.id=t.wave_id WHERE t.id=$1 FOR UPDATE OF t`, [taskId]), "Pick task");
  if (t.wave_status !== "released") throw badRequest("This wave is closed.");
  if (t.status === "done") throw badRequest("This task is done.");
  if (t.status === "claimed" && t.assigned_to !== ctx.userId && !ctx.roles.includes("owner")) throw forbidden("Another picker has this task.");
  if (t.status === "open") await c.query(`UPDATE fulfil_pick_tasks SET status='claimed', assigned_to=$2, claimed_at=now() WHERE id=$1`, [taskId, ctx.userId]);
  const rows = (await c.query<any>(`SELECT * FROM (${OPEN_ALLOC}) x WHERE ($2::text='*' OR zone=$2) ORDER BY ship_by NULLS LAST, order_created, id`, [t.wave_id, t.zone])).rows;
  const stage = await systemLocation(c, ctx.tenantId, "staging");
  const plan = new Map<string, number>();   // allocation id -> units found
  if (t.strategy === "batch") {
    const left = new Map<string, number>(Object.entries(entries));
    for (const r of rows) {
      const k = `${r.location_id}|${r.sku_id}|${r.lot_id ?? ""}`;
      if (!left.has(k)) continue;
      const have = left.get(k)!, need = r.qty - r.picked_qty, give = Math.min(have, need);
      plan.set(r.id, give); left.set(k, have - give);
    }
    for (const [k, v] of left) if (v > 0) throw badRequest(`More units than needed were reported for ${k.split("|")[2] ? "a lot" : "a line"}; found quantities cannot exceed the combined need.`);
  } else for (const r of rows) if (entries[r.id] !== undefined) plan.set(r.id, entries[r.id]);
  const touched = new Set<string>();
  let picked = 0, shorts = 0;
  for (const r of rows) {
    if (!plan.has(r.id)) continue;
    const blocked = !!r.lot_id && lotBlocked({ hold: r.lot_hold, expires_at: r.lot_expires });
    const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [r.order_id]), "Order");
    const a = (await c.query<any>(`SELECT a.* FROM stock_allocations a WHERE a.id=$1 FOR UPDATE`, [r.id])).rows[0];
    if (!a) continue;
    const res = await pickAllocation(c, ctx, o, stage, { ...a, loc_code: r.loc_code, sku_code: r.sku_code, lot_code: r.lot_code }, blocked ? 0 : plan.get(r.id)!, blocked);
    picked += res.picked; shorts += res.short ? 1 : 0; touched.add(r.order_id);
  }
  for (const id of touched) await refreshStatus(c, id);
  const openLeft = (await c.query<any>(`SELECT count(*)::int n FROM (${OPEN_ALLOC}) x WHERE ($2::text='*' OR zone=$2)`, [t.wave_id, t.zone])).rows[0].n;
  if (!openLeft) {
    await c.query(`UPDATE fulfil_pick_tasks SET status='done', done_at=now() WHERE id=$1`, [taskId]);
    const pending = (await c.query<any>(`SELECT count(*)::int n FROM fulfil_pick_tasks WHERE wave_id=$1 AND status<>'done'`, [t.wave_id])).rows[0].n;
    if (!pending) { await c.query(`UPDATE fulfil_waves SET status='completed', closed_at=now() WHERE id=$1`, [t.wave_id]); await c.query(`UPDATE fulfil_wave_orders SET active=false WHERE wave_id=$1`, [t.wave_id]); }
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_task.picked", "fulfil_pick_task", taskId, { units: picked, shorts, done: !openLeft });
  return { picked, shorts, done: !openLeft };
}

export async function cancelWave(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  const w = await must(c.query<any>(`SELECT * FROM fulfil_waves WHERE id=$1 FOR UPDATE`, [id]), "Wave");
  if (w.status !== "released") throw badRequest(`This wave is ${w.status}.`);
  await c.query(`UPDATE fulfil_waves SET status='cancelled', closed_at=now() WHERE id=$1`, [id]);
  await c.query(`UPDATE fulfil_wave_orders SET active=false WHERE wave_id=$1`, [id]);
  await c.query(`UPDATE fulfil_pick_tasks SET status='done', done_at=now() WHERE wave_id=$1 AND status<>'done'`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_wave.cancelled", "fulfil_wave", id);
}

export async function setLocationZone(c: Conn, ctx: Ctx, locationId: string, zone: unknown) {
  require(ctx, "wh.write");
  const z = String(zone ?? "").trim().toUpperCase();
  if (z && !/^[A-Z0-9_-]{1,20}$/.test(z)) throw badRequest("A zone is 1–20 letters, digits, - or _.");
  await must(c.query(`UPDATE wh_locations SET zone=$2 WHERE id=$1 AND kind='bin' RETURNING id`, [locationId, z || null]), "Bin");
  await audit(c, ctx.tenantId, actorOf(ctx), "location.zone_set", "location", locationId, { zone: z || null });
}

export const listWaves = (c: Conn) => c.query<any>(
  `SELECT w.*, (SELECT count(*)::int FROM fulfil_wave_orders o WHERE o.wave_id=w.id) AS orders,
     (SELECT count(*)::int FROM fulfil_pick_tasks t WHERE t.wave_id=w.id AND t.status='done') AS tasks_done,
     (SELECT count(*)::int FROM fulfil_pick_tasks t WHERE t.wave_id=w.id) AS tasks FROM fulfil_waves w ORDER BY w.created_at DESC LIMIT 100`).then((r) => r.rows);
export async function getWave(c: Conn, id: string) {
  const wave = await must(c.query<any>(`SELECT * FROM fulfil_waves WHERE id=$1`, [id]), "Wave");
  const tasks = (await c.query<any>(`SELECT t.*, u.name AS picker FROM fulfil_pick_tasks t LEFT JOIN team_members u ON u.user_id=t.assigned_to WHERE t.wave_id=$1 ORDER BY t.zone`, [id])).rows;
  const orders = (await c.query<any>(`SELECT o.id, o.no, o.status FROM fulfil_wave_orders w JOIN fulfil_orders o ON o.id=w.order_id WHERE w.wave_id=$1 ORDER BY o.no`, [id])).rows;
  return { wave, tasks, orders };
}
