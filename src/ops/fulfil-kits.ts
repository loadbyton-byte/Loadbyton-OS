import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must } from "./common.js";
import { lotBlocked, skuMode } from "./fulfil-lots.js";
import { allocateWaitingInternal, lockStock, moveStock, resolveLocation, resolveSku } from "./fulfilment.js";

const posInt = (v: unknown, label: string, max = 10_000) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > max) throw badRequest(`${label} must be a whole number above zero.`);
  return n;
};

/**
 * Define a kit. `assemble` kits are built from component stock into a normal stocked SKU; `virtual` kits are never stocked and
 * expand into their components when an order is placed. Definitions are immutable: retire the kit and define a new one.
 */
export async function defineKit(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const kitSku = await resolveSku(c, f, "sku_id", "sku_code");
  const mode = f.mode === "virtual" ? "virtual" : f.mode === "assemble" ? "assemble" : null;
  if (!mode) throw badRequest("Choose assemble-to-stock or virtual bundle.");
  const km = await skuMode(c, kitSku.id);
  if (km.tracked) throw badRequest("A kit SKU cannot be lot, serial or expiry tracked; its components keep their own traceability.");
  const comps: { code?: string; sku_code?: string; qty: number }[] = Array.isArray(f.components) ? f.components : [];
  if (!comps.length || comps.length > 50) throw badRequest("A kit needs between 1 and 50 components.");
  if ((await c.query(`SELECT 1 FROM fulfil_kits WHERE sku_id=$1 AND active`, [kitSku.id])).rows.length) throw badRequest("This SKU already has an active kit definition; retire it first.");
  if ((await c.query(`SELECT 1 FROM fulfil_kit_components kc JOIN fulfil_kits k ON k.id=kc.kit_id WHERE kc.sku_id=$1 AND k.active`, [kitSku.id])).rows.length) throw badRequest("This SKU is a component of another kit and cannot itself be a kit.");
  if (mode === "virtual") {
    if ((await c.query(`SELECT 1 FROM stock_levels WHERE sku_id=$1 AND (on_hand>0 OR reserved>0)`, [kitSku.id])).rows.length) throw badRequest("A virtual bundle SKU must hold no stock.");
    if ((await c.query(`SELECT 1 FROM fulfil_order_lines l JOIN fulfil_orders o ON o.id=l.order_id WHERE l.sku_id=$1 AND o.status NOT IN ('shipped','cancelled') LIMIT 1`, [kitSku.id])).rows.length) throw badRequest("Open orders already use this SKU as a plain item.");
  }
  const seen = new Set<string>(), rows: { id: string; qty: number }[] = [];
  for (const cp of comps) {
    const s = await resolveSku(c, { sku_code: cp.sku_code ?? cp.code, party_id: kitSku.party_id });
    if (s.id === kitSku.id) throw badRequest("A kit cannot contain itself.");
    if (s.party_id !== kitSku.party_id) throw badRequest("Components must belong to the same merchant as the kit.");
    if (seen.has(s.id)) throw badRequest(`${s.code} appears twice.`);
    if ((await c.query(`SELECT 1 FROM fulfil_kits WHERE sku_id=$1 AND active`, [s.id])).rows.length) throw badRequest(`${s.code} is itself a kit; nesting is not supported.`);
    seen.add(s.id); rows.push({ id: s.id, qty: posInt(cp.qty, `Quantity of ${s.code}`) });
  }
  const id = (await c.query<{ id: string }>(`INSERT INTO fulfil_kits(tenant_id,sku_id,mode,created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.tenantId, kitSku.id, mode, ctx.userId])).rows[0].id;
  for (const r of rows) await c.query(`INSERT INTO fulfil_kit_components(tenant_id,kit_id,sku_id,qty) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, id, r.id, r.qty]);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_kit.defined", "fulfil_kit", id, { sku: kitSku.code, mode, components: rows.length });
  return id;
}

export async function retireKit(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  const k = await must(c.query<any>(`SELECT * FROM fulfil_kits WHERE id=$1 FOR UPDATE`, [id]), "Kit");
  if (!k.active) throw badRequest("This kit is already retired.");
  await c.query(`UPDATE fulfil_kits SET active=false WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_kit.retired", "fulfil_kit", id);
}

export const listKits = (c: Conn) => c.query<any>(
  `SELECT k.*, s.code AS sku_code, s.name AS sku_name, p.name AS party_name,
     (SELECT string_agg(cs.code || ' ×' || kc.qty, ', ' ORDER BY cs.code) FROM fulfil_kit_components kc JOIN skus cs ON cs.id=kc.sku_id WHERE kc.kit_id=k.id) AS components
   FROM fulfil_kits k JOIN skus s ON s.id=k.sku_id JOIN parties p ON p.id=s.party_id ORDER BY k.active DESC, p.name, s.code LIMIT 200`).then((r) => r.rows);

/** Order entry: replace each virtual-kit line by its components (merged with plain lines) and report what was expanded. */
export async function expandVirtualKits(c: Conn, lines: { sku_id: string; qty: number; code: string }[]) {
  const out = new Map<string, { sku_id: string; qty: number; code: string }>(), kitLines: { kit_sku_id: string; qty: number }[] = [];
  const add = (x: { sku_id: string; qty: number; code: string }) => { const e = out.get(x.sku_id); if (e) e.qty += x.qty; else out.set(x.sku_id, { ...x }); };
  for (const l of lines) {
    const kit = (await c.query<any>(`SELECT id FROM fulfil_kits WHERE sku_id=$1 AND active AND mode='virtual'`, [l.sku_id])).rows[0];
    if (!kit) { add(l); continue; }
    kitLines.push({ kit_sku_id: l.sku_id, qty: l.qty });
    const comps = (await c.query<any>(`SELECT kc.sku_id, kc.qty, s.code, s.active FROM fulfil_kit_components kc JOIN skus s ON s.id=kc.sku_id WHERE kc.kit_id=$1`, [kit.id])).rows;
    for (const cp of comps) {
      if (!cp.active) throw badRequest(`Component ${cp.code} of ${l.code} is inactive.`);
      add({ sku_id: cp.sku_id, qty: cp.qty * l.qty, code: cp.code });
    }
  }
  return { lines: [...out.values()], kitLines };
}

/** Consume components from one location (tracked ones in rotation order, never held/expired lots) and add kit units there. */
export async function buildKits(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const token = String(f.token ?? "");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(token)) throw badRequest("This form has expired. Reload the page and try again.");
  if ((await c.query(`SELECT 1 FROM fulfil_kit_builds WHERE token=$1`, [token])).rows.length) return { duplicate: true as const };
  const qty = posInt(f.qty, "Quantity", 100_000);
  const kitSku = await resolveSku(c, f);
  const kit = await must(c.query<any>(`SELECT * FROM fulfil_kits WHERE sku_id=$1 AND active AND mode='assemble'`, [kitSku.id]), "Assemble-to-stock kit for this SKU");
  const loc = await resolveLocation(c, f);
  if (!(loc.active && ["bin", "receiving"].includes(loc.kind))) throw badRequest("Build kits in a bin or the receiving area.");
  const buildId = (await c.query<{ id: string }>(`INSERT INTO fulfil_kit_builds(tenant_id,kit_id,location_id,qty,token,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.tenantId, kit.id, loc.id, qty, token, ctx.userId])).rows[0].id;
  const comps = (await c.query<any>(`SELECT kc.sku_id, kc.qty, s.code FROM fulfil_kit_components kc JOIN skus s ON s.id=kc.sku_id WHERE kc.kit_id=$1 ORDER BY s.code`, [kit.id])).rows;
  for (const cp of comps) {
    const need = cp.qty * qty, mode = await skuMode(c, cp.sku_id);
    if (!mode.tracked) {
      await moveStock(c, ctx, { skuId: cp.sku_id, locationId: loc.id, delta: -need, kind: "kit_consume", refType: "kit_build", refId: buildId });
      await c.query(`INSERT INTO fulfil_kit_build_lots(tenant_id,build_id,sku_id,lot_id,qty) VALUES ($1,$2,$3,NULL,$4)`, [ctx.tenantId, buildId, cp.sku_id, need]);
      continue;
    }
    const order = mode.rotation === "fefo" ? "lot.expires_at NULLS LAST, lot.created_at" : "lot.created_at";
    const lots = (await c.query<any>(
      `SELECT v.lot_id, (v.on_hand - v.reserved)::int AS free, lot.hold, lot.expires_at FROM stock_lot_levels v JOIN fulfil_lots lot ON lot.id=v.lot_id
       WHERE v.sku_id=$1 AND v.location_id=$2 AND v.on_hand - v.reserved > 0 ORDER BY ${order}`, [cp.sku_id, loc.id])).rows.filter((x) => !lotBlocked(x));
    let left = need;
    for (const l of lots) {
      if (left <= 0) break;
      const take = mode.tracking === "serial" ? 1 : Math.min(l.free, left);
      await moveStock(c, ctx, { skuId: cp.sku_id, locationId: loc.id, delta: -take, kind: "kit_consume", refType: "kit_build", refId: buildId, lotId: l.lot_id });
      await c.query(`INSERT INTO fulfil_kit_build_lots(tenant_id,build_id,sku_id,lot_id,qty) VALUES ($1,$2,$3,$4,$5)`, [ctx.tenantId, buildId, cp.sku_id, l.lot_id, take]);
      left -= take;
    }
    if (left > 0) throw badRequest(`${cp.code}: ${left} more unit(s) of usable, unreserved stock are needed at ${loc.code}.`);
  }
  await moveStock(c, ctx, { skuId: kitSku.id, locationId: loc.id, delta: qty, kind: "kit_build", refType: "kit_build", refId: buildId });
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_kit.built", "fulfil_kit_build", buildId, { sku: kitSku.code, qty, location: loc.code });
  const alloc = await allocateWaitingInternal(c, ctx);
  return { duplicate: false as const, id: buildId, allocated: alloc };
}
