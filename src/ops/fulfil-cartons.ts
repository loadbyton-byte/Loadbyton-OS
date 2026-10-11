import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, reqStr } from "./common.js";
import { resolveSku } from "./fulfilment.js";

export interface CartonType { id: string; code: string; l: number; w: number; h: number; max_g: number; tare_g: number }
export interface PackItem { sku_id: string; code: string; l: number; w: number; h: number; g: number }
export interface PlannedCarton { type: CartonType; items: { sku_id: string; code: string; qty: number }[]; weight_g: number; fill_pct: number }

const FILL = 0.85;   // usable share of inner volume: protective packing is not perfectly dense
const vol = (a: { l: number; w: number; h: number }) => a.l * a.w * a.h;
const sorted = (a: { l: number; w: number; h: number }) => [a.l, a.w, a.h].sort((x, y) => y - x);
const fitsDims = (it: PackItem, t: CartonType) => { const i = sorted(it), c = sorted({ l: t.l, w: t.w, h: t.h }); return i[0] <= c[0] && i[1] <= c[1] && i[2] <= c[2]; };

/**
 * Heuristic cartonisation: first-fit-decreasing by volume with per-unit dimension and weight checks, then each carton is
 * downsized to the smallest type that still holds its contents. It is a suggestion the packer confirms, not a 3-D packing proof.
 */
export function planCartons(items: PackItem[], types: CartonType[]): { cartons: PlannedCarton[]; unplaceable: string[] } {
  const ts = [...types].sort((a, b) => vol(a) - vol(b));
  const units = items.flatMap((i) => [i]).sort((a, b) => vol(b) - vol(a) || b.g - a.g);
  type Open = { type: CartonType; units: PackItem[]; v: number; g: number };
  const open: Open[] = [], unplaceable: string[] = [];
  const hold = (o: Open, t: CartonType) => o.units.every((u) => fitsDims(u, t)) && o.v <= vol(t) * FILL && o.g + t.tare_g <= t.max_g;
  for (const u of units) {
    const target = open.find((o) => { const v = o.v + vol(u), g = o.g + u.g; return fitsDims(u, o.type) && v <= vol(o.type) * FILL && g + o.type.tare_g <= o.type.max_g; });
    if (target) { target.units.push(u); target.v += vol(u); target.g += u.g; continue; }
    // a fresh carton: the largest type, so later units can join it, downsized at the end
    const big = [...ts].reverse().find((t) => fitsDims(u, t) && vol(u) <= vol(t) * FILL && u.g + t.tare_g <= t.max_g);
    if (!big) { unplaceable.push(u.code); continue; }
    open.push({ type: big, units: [u], v: vol(u), g: u.g });
  }
  const cartons = open.map((o) => {
    const type = ts.find((t) => hold(o, t)) ?? o.type;
    const by = new Map<string, { sku_id: string; code: string; qty: number }>();
    for (const u of o.units) { const e = by.get(u.sku_id) ?? { sku_id: u.sku_id, code: u.code, qty: 0 }; e.qty++; by.set(u.sku_id, e); }
    return { type, items: [...by.values()], weight_g: o.g + type.tare_g, fill_pct: Math.round((o.v / vol(type)) * 100) };
  });
  return { cartons, unplaceable: [...new Set(unplaceable)] };
}

export async function createCartonType(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const n = (v: unknown, label: string, max: number) => { const x = Number(v); if (!Number.isInteger(x) || x <= 0 || x > max) throw badRequest(`${label} must be a whole number above zero.`); return x; };
  const code = reqStr(f.code, "Carton code", 30).toUpperCase().replace(/\s+/g, "-");
  try {
    const r = await c.query<{ id: string }>(`INSERT INTO fulfil_carton_types(tenant_id,code,name,inner_l_mm,inner_w_mm,inner_h_mm,max_weight_g,tare_g) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ctx.tenantId, code, reqStr(f.name ?? code, "Carton name", 100), n(f.l, "Length (mm)", 20000), n(f.w, "Width (mm)", 20000), n(f.h, "Height (mm)", 20000), n(f.max_weight_g, "Max weight (g)", 2_000_000), f.tare_g ? n(f.tare_g, "Tare (g)", 100_000) : 0]);
    await audit(c, ctx.tenantId, actorOf(ctx), "carton_type.created", "carton_type", r.rows[0].id, { code });
    return r.rows[0].id;
  } catch (e: any) {
    if (String(e.message).includes("fulfil_carton_types_tenant_id_code_key")) throw new HttpError(409, `Carton ${code} already exists.`, "conflict");
    throw e;
  }
}
export async function setCartonActive(c: Conn, ctx: Ctx, id: string, active: boolean) {
  require(ctx, "wh.write");
  await must(c.query(`UPDATE fulfil_carton_types SET active=$2 WHERE id=$1 RETURNING id`, [id, active]), "Carton type");
  await audit(c, ctx.tenantId, actorOf(ctx), active ? "carton_type.enabled" : "carton_type.disabled", "carton_type", id);
}
export const listCartonTypes = (c: Conn) => c.query<any>(`SELECT * FROM fulfil_carton_types ORDER BY active DESC, inner_l_mm*inner_w_mm*inner_h_mm`).then((r) => r.rows);

/** Physical data of a SKU used by cartonisation (unit weight is the existing unit_weight_g column). */
export async function setSkuDimensions(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  const sku = await resolveSku(c, f);
  const d = (v: unknown, label: string) => { const x = Number(v); if (!Number.isInteger(x) || x <= 0 || x > 20000) throw badRequest(`${label} must be whole millimetres above zero.`); return x; };
  const g = Number(f.unit_weight_g);
  if (!Number.isInteger(g) || g <= 0 || g > 500_000) throw badRequest("Unit weight (g) must be a whole number above zero.");
  await c.query(`UPDATE skus SET length_mm=$2,width_mm=$3,height_mm=$4,unit_weight_g=$5 WHERE id=$1`, [sku.id, d(f.length_mm, "Length"), d(f.width_mm, "Width"), d(f.height_mm, "Height"), g]);
  await audit(c, ctx.tenantId, actorOf(ctx), "sku.dimensions_set", "sku", sku.id, { code: sku.code });
}

async function orderUnits(c: Conn, orderId: string) {
  const rows = (await c.query<any>(
    `SELECT l.sku_id, s.code, s.length_mm, s.width_mm, s.height_mm, s.unit_weight_g, l.picked_qty FROM fulfil_order_lines l JOIN skus s ON s.id=l.sku_id WHERE l.order_id=$1 AND l.picked_qty>0`, [orderId])).rows;
  const missing = rows.filter((r) => !r.length_mm || !r.width_mm || !r.height_mm || !r.unit_weight_g).map((r) => r.code);
  if (missing.length) throw badRequest(`Add dimensions and unit weight for: ${missing.join(", ")}.`);
  return rows.flatMap((r) => Array.from({ length: r.picked_qty }, () => ({ sku_id: r.sku_id, code: r.code, l: r.length_mm, w: r.width_mm, h: r.height_mm, g: r.unit_weight_g } as PackItem)));
}
const typesOf = async (c: Conn): Promise<CartonType[]> => (await c.query<any>(`SELECT id, code, inner_l_mm l, inner_w_mm w, inner_h_mm h, max_weight_g max_g, tare_g FROM fulfil_carton_types WHERE active`)).rows;

export async function suggestCartons(c: Conn, ctx: Ctx, orderId: string) {
  require(ctx, "wh.floor");
  const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1`, [orderId]), "Order");
  if (!["picking", "picked", "packed"].includes(o.status)) throw badRequest(`Order is ${o.status}; pick first.`);
  const types = await typesOf(c);
  if (!types.length) throw badRequest("Define at least one carton type first.");
  return planCartons(await orderUnits(c, orderId), types);
}

/** Record the cartons actually used. Contents must equal the picked quantities exactly; replaces an earlier plan until the order ships. */
export async function saveOrderCartons(c: Conn, ctx: Ctx, orderId: string, cartons: { carton_type_id: string; weight_g?: number | null; items: { sku_id: string; qty: number }[] }[]) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  const o = await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`, [orderId]), "Order");
  if (!["picking", "picked", "packed"].includes(o.status)) throw badRequest(`Order is ${o.status}; cartons are recorded before dispatch.`);
  if (!cartons.length || cartons.length > 200) throw badRequest("Record between 1 and 200 cartons.");
  const picked = new Map((await c.query<any>(`SELECT sku_id, picked_qty FROM fulfil_order_lines WHERE order_id=$1 AND picked_qty>0`, [orderId])).rows.map((r) => [r.sku_id, r.picked_qty as number]));
  const used = new Map<string, number>();
  for (const k of cartons) for (const it of k.items) used.set(it.sku_id, (used.get(it.sku_id) ?? 0) + it.qty);
  for (const [sku, q] of picked) if ((used.get(sku) ?? 0) !== q) throw badRequest("Carton contents must equal the picked quantities exactly.");
  for (const sku of used.keys()) if (!picked.has(sku)) throw badRequest("A carton holds an item that is not on this order.");
  await c.query(`DELETE FROM fulfil_order_carton_lines WHERE carton_id IN (SELECT id FROM fulfil_order_cartons WHERE order_id=$1)`, [orderId]);
  await c.query(`DELETE FROM fulfil_order_cartons WHERE order_id=$1`, [orderId]);
  let seq = 0;
  for (const k of cartons) {
    await must(c.query(`SELECT id FROM fulfil_carton_types WHERE id=$1 AND active`, [k.carton_type_id]), "Carton type");
    const w = k.weight_g == null ? null : Number(k.weight_g);
    if (w !== null && (!Number.isInteger(w) || w <= 0)) throw badRequest("Carton weight must be whole grams.");
    const id = (await c.query<{ id: string }>(`INSERT INTO fulfil_order_cartons(tenant_id,order_id,seq,carton_type_id,weight_g,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.tenantId, orderId, ++seq, k.carton_type_id, w, ctx.userId])).rows[0].id;
    for (const it of k.items) if (it.qty > 0) await c.query(`INSERT INTO fulfil_order_carton_lines(tenant_id,carton_id,sku_id,qty) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, id, it.sku_id, it.qty]);
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_order.cartonised", "fulfil_order", orderId, { cartons: cartons.length });
}
export async function autoCartonise(c: Conn, ctx: Ctx, orderId: string) {
  const plan = await suggestCartons(c, ctx, orderId);
  if (plan.unplaceable.length) throw badRequest(`No active carton fits: ${plan.unplaceable.join(", ")}.`);
  await saveOrderCartons(c, ctx, orderId, plan.cartons.map((k) => ({ carton_type_id: k.type.id, weight_g: k.weight_g, items: k.items })));
  return plan;
}
export async function orderCartons(c: Conn, orderId: string) {
  const cartons = (await c.query<any>(`SELECT k.*, t.code AS type_code FROM fulfil_order_cartons k JOIN fulfil_carton_types t ON t.id=k.carton_type_id WHERE k.order_id=$1 ORDER BY k.seq`, [orderId])).rows;
  for (const k of cartons) k.items = (await c.query<any>(`SELECT s.code, l.qty FROM fulfil_order_carton_lines l JOIN skus s ON s.id=l.sku_id WHERE l.carton_id=$1 ORDER BY s.code`, [k.id])).rows;
  return cartons;
}
