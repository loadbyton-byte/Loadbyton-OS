import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { uploadDocument } from "../src/ops/documents.js";
import { createInbound, createLocation, createOrder, createSku, getInbound, getFulfilOrder, packScan, pickOrder, receiveInbound, shipOrder, allocateOrder } from "../src/ops/fulfilment.js";
import { buildKits, defineKit, retireKit } from "../src/ops/fulfil-kits.js";
import { autoCartonise, createCartonType, orderCartons, planCartons, saveOrderCartons, setSkuDimensions, suggestCartons } from "../src/ops/fulfil-cartons.js";
import { cancelWave, claimPickTask, createWave, getWave, pickWaveTask, setLocationZone, taskLines } from "../src/ops/fulfil-waves.js";
import { traceLot } from "../src/ops/fulfil-lots.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
const uid = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`;
const future = (d: number) => new Date(Date.now() + 4 * 3600000 + d * 86400000).toISOString().slice(0, 10);
async function staff(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`fp-${role}-${uid()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
async function shop() {
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const f = await db.tenant(t.tenantId, async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Kit Shop" });
    const A = await createLocation(c, t.ctx, { code: "a-01" }), B = await createLocation(c, t.ctx, { code: "b-01" });
    await setLocationZone(c, t.ctx, A, "fast"); await setLocationZone(c, t.ctx, B, "bulk");
    const doc = await uploadDocument(c, t.ctx, { kind: "other", title: "Lot source", issuer: "Supplier", filename: "s.pdf", data: Buffer.from("%PDF-1.4 x") });
    const skus: Record<string, string> = {};
    for (const [code, extra] of [["cream", { tracking: "lot", rotation: "fefo" }], ["brush", {}], ["gift", {}], ["bundle", {}], ["mug", {}]] as const)
      skus[code] = await createSku(c, t.ctx, { party_id: merchant, code, name: code, ...extra });
    return { merchant, A, B, doc, skus };
  });
  return { t, ...f };
}
type Shop = Awaited<ReturnType<typeof shop>>;
const T = (s: Shop) => <R>(fn: (c: any, ctx: typeof s.t.ctx) => Promise<R>) => db.tenant(s.t.tenantId, (c) => fn(c, s.t.ctx));
async function receive(s: Shop, code: string, qty: number, loc: string, extra: Record<string, any> = {}) {
  return T(s)(async (c, ctx) => {
    const inb = await createInbound(c, ctx, { party_id: s.merchant, lines: `${code}, ${qty}` });
    return receiveInbound(c, ctx, inb.id, { line_id: (await getInbound(c, inb.id)).lines[0].id, good: qty, damaged: 0, location_id: loc, token: `tok-${uid()}`, document_id: s.doc, ...extra });
  });
}
const order = (s: Shop, lines: string, over: Record<string, any> = {}) => T(s)((c, ctx) => createOrder(c, ctx, { party_id: s.merchant, external_ref: `O-${uid()}`, ship_to_name: "A", ship_to_address: "x", lines, ...over }));
const q = (s: Shop, sql: string, p: any[] = []) => db.tenant(s.t.tenantId, (c) => c.query<any>(sql, p)).then((r) => r.rows);
const clean = async () => expect(await verifyInvariants(db)).toEqual([]);

describe("kits", () => {
  it("assembles a kit from components (FEFO lots), traces component lots to the build, and refuses shortages", async () => {
    const s = await shop();
    await receive(s, "BRUSH", 10, s.A);
    await receive(s, "CREAM", 3, s.A, { lot: "late", expires_at: future(90) });
    await receive(s, "CREAM", 3, s.A, { lot: "soon", expires_at: future(30) });
    await T(s)((c, ctx) => defineKit(c, ctx, { sku_code: "GIFT", mode: "assemble", components: [{ sku_code: "BRUSH", qty: 1 }, { sku_code: "CREAM", qty: 2 }] }));
    await expect(T(s)((c, ctx) => defineKit(c, ctx, { sku_code: "GIFT", mode: "assemble", components: [{ sku_code: "BRUSH", qty: 1 }] }))).rejects.toThrow(/already has an active/);
    await expect(T(s)((c, ctx) => buildKits(c, ctx, { sku_code: "GIFT", qty: 4, location_id: s.A, token: `b-${uid()}` }))).rejects.toThrow(/more unit/);   // needs 8 cream, 6 exist
    const tok = `b-${uid()}`;
    await T(s)((c, ctx) => buildKits(c, ctx, { sku_code: "GIFT", qty: 2, location_id: s.A, token: tok }));
    expect((await T(s)((c, ctx) => buildKits(c, ctx, { sku_code: "GIFT", qty: 2, location_id: s.A, token: tok }))).duplicate).toBe(true);
    const used = await q(s, `SELECT lot.lot, sum(b.qty)::int n FROM fulfil_kit_build_lots b JOIN fulfil_lots lot ON lot.id=b.lot_id GROUP BY lot.lot`);
    const m = Object.fromEntries(used.map((r: any) => [r.lot, r.n]));
    expect(m).toEqual({ SOON: 3, LATE: 1 });
    const soon = (await q(s, `SELECT id FROM fulfil_lots WHERE lot='SOON'`))[0].id;
    const trace = await T(s)((c, ctx) => traceLot(c, ctx, soon));
    expect(trace.kits.length).toBe(1);
    const gift = (await q(s, `SELECT on_hand FROM stock_levels WHERE sku_id=$1`, [s.skus.gift]))[0];
    expect(gift.on_hand).toBe(2);
    await clean();
  });

  it("virtual bundles expand into component lines at order time and keep the kit line for display", async () => {
    const s = await shop();
    await receive(s, "BRUSH", 5, s.A); await receive(s, "MUG", 5, s.B);
    await T(s)((c, ctx) => defineKit(c, ctx, { sku_code: "BUNDLE", mode: "virtual", components: [{ sku_code: "BRUSH", qty: 1 }, { sku_code: "MUG", qty: 2 }] }));
    const o = await order(s, "BUNDLE, 2\nMUG, 1");
    const d = await T(s)((c, ctx) => getFulfilOrder(c, o.id, ctx));
    expect(d.lines.map((l: any) => [l.code, l.qty]).sort()).toEqual([["BRUSH", 2], ["MUG", 5]]);
    expect(await q(s, `SELECT qty FROM fulfil_order_kit_lines WHERE order_id=$1`, [o.id])).toEqual([{ qty: 2 }]);
    const kitId = (await q(s, `SELECT id FROM fulfil_kits WHERE active`))[0].id;
    await T(s)((c, ctx) => retireKit(c, ctx, kitId));
    await expect(db.query(`UPDATE fulfil_kits SET mode='assemble' WHERE id=$1`, [kitId])).rejects.toThrow(/immutable/);
    await clean();
  });
});

describe("cartonisation", () => {
  it("plans by volume, weight and dimensions, downsizes cartons, and records cartons that must match the pick", async () => {
    const types = [
      { id: "S", code: "S", l: 200, w: 150, h: 100, max_g: 2000, tare_g: 100 },
      { id: "M", code: "M", l: 400, w: 300, h: 200, max_g: 10000, tare_g: 300 },
    ];
    const item = (c: string, l: number, w: number, h: number, g: number) => ({ sku_id: c, code: c, l, w, h, g });
    const small = planCartons([item("a", 100, 80, 50, 300), item("a", 100, 80, 50, 300)], types);
    expect(small.cartons.map((k) => [k.type.code, k.weight_g])).toEqual([["S", 700]]);
    const split = planCartons(Array.from({ length: 6 }, () => item("b", 200, 150, 100, 1800)), types);   // heavy: weight forces several cartons
    expect(split.cartons.length).toBeGreaterThan(1);
    expect(planCartons([item("long", 900, 10, 10, 100)], types).unplaceable).toEqual(["long"]);

    const s = await shop();
    await receive(s, "MUG", 3, s.A);
    await T(s)(async (c, ctx) => { await createCartonType(c, ctx, { code: "box-s", l: 200, w: 200, h: 150, max_weight_g: 3000, tare_g: 50 }); });
    const o = await order(s, "MUG, 3");
    await T(s)(async (c, ctx) => { await allocateOrder(c, ctx, o.id); await pickOrder(c, ctx, o.id); });
    await expect(T(s)((c, ctx) => suggestCartons(c, ctx, o.id))).rejects.toThrow(/dimensions/);
    await T(s)((c, ctx) => setSkuDimensions(c, ctx, { sku_code: "MUG", length_mm: 90, width_mm: 90, height_mm: 100, unit_weight_g: 350 }));
    const plan = await T(s)((c, ctx) => autoCartonise(c, ctx, o.id));
    expect(plan.cartons.length).toBe(1);
    const stored = await T(s)((c) => orderCartons(c, o.id));
    expect(stored[0].items).toEqual([{ code: "MUG", qty: 3 }]);
    await expect(T(s)((c, ctx) => saveOrderCartons(c, ctx, o.id, [{ carton_type_id: stored[0].carton_type_id, items: [{ sku_id: s.skus.mug, qty: 2 }] }]))).rejects.toThrow(/equal the picked/);
    await T(s)(async (c, ctx) => { await packScan(c, ctx, o.id, { code: "MUG", qty: 3 }); await shipOrder(c, ctx, o.id, { carrier: "Aramex", tracking_no: `T${uid()}` }); });
    const sh = (await q(s, `SELECT cartons, weight_g FROM fulfil_shipments WHERE order_id=$1`, [o.id]))[0];
    expect(sh).toEqual({ cartons: 1, weight_g: 3 * 350 + 50 });
    await clean();
  });
});

describe("zones, waves and batch picking", () => {
  async function ready() {
    const s = await shop();
    await receive(s, "MUG", 10, s.A); await receive(s, "BRUSH", 10, s.B);
    const o1 = await order(s, "MUG, 2\nBRUSH, 1", { ship_by: `${future(1)}T10:00` }), o2 = await order(s, "MUG, 3", { ship_by: `${future(3)}T10:00` });
    return { s, o1, o2 };
  }
  it("a zone wave gives each zone its own task; picking all tasks completes the wave and the orders can pack", async () => {
    const { s, o1, o2 } = await ready();
    const w = await T(s)((c, ctx) => createWave(c, ctx, { strategy: "zone", order_ids: [o1.id, o2.id] }));
    expect(w.tasks).toBe(2);
    await expect(T(s)((c, ctx) => createWave(c, ctx, { strategy: "wave", order_ids: [o1.id] }))).rejects.toThrow(/already in an active wave/);
    const d = await T(s)((c) => getWave(c, w.id));
    const bulk = d.tasks.find((t: any) => t.zone === "BULK"), fast = d.tasks.find((t: any) => t.zone === "FAST");
    const picker = await staff(s.t.tenantId, "warehouse"), other = await staff(s.t.tenantId, "warehouse");
    await db.tenant(s.t.tenantId, (c) => claimPickTask(c, picker, fast.id));
    await expect(db.tenant(s.t.tenantId, (c) => claimPickTask(c, other, fast.id))).rejects.toThrow(/Another picker/);
    const fl = await T(s)((c) => taskLines(c, fast.id));
    expect(fl.lines.every((l: any) => l.sku === "MUG")).toBe(true);
    const r1 = await db.tenant(s.t.tenantId, (c) => pickWaveTask(c, picker, fast.id, Object.fromEntries(fl.lines.map((l: any) => [l.key, l.remaining]))));
    expect(r1.done).toBe(true);
    const bl = await T(s)((c) => taskLines(c, bulk.id));
    const r2 = await db.tenant(s.t.tenantId, (c) => pickWaveTask(c, other, bulk.id, Object.fromEntries(bl.lines.map((l: any) => [l.key, l.remaining]))));
    expect(r2.done).toBe(true);
    expect((await T(s)((c) => getWave(c, w.id))).wave.status).toBe("completed");
    expect((await q(s, `SELECT status FROM fulfil_orders`)).every((r) => r.status === "picked" || r.status === "packed")).toBe(true);
    await clean();
  });

  it("batch picking takes the combined quantity once and splits a shortfall onto the latest-due order", async () => {
    const { s, o1, o2 } = await ready();
    const w = await T(s)((c, ctx) => createWave(c, ctx, { strategy: "batch", order_ids: [o1.id, o2.id] }));
    const task = (await T(s)((c) => getWave(c, w.id))).tasks[0];
    const tl = await T(s)((c) => taskLines(c, task.id));
    const mug = tl.lines.find((l: any) => l.sku === "MUG");
    expect(mug.remaining).toBe(5); expect(mug.orders.length).toBe(2);
    const found = Object.fromEntries(tl.lines.map((l: any) => [l.key, l.sku === "MUG" ? 4 : l.remaining]));   // one mug missing
    const r = await T(s)((c, ctx) => pickWaveTask(c, ctx, task.id, found));
    expect(r.shorts).toBe(1);
    const rows = await q(s, `SELECT o.no, l.picked_qty, l.allocated_qty FROM fulfil_order_lines l JOIN fulfil_orders o ON o.id=l.order_id JOIN skus s ON s.id=l.sku_id WHERE s.code='MUG' ORDER BY o.ship_by`);
    expect(rows.map((x) => [x.picked_qty, x.allocated_qty])).toEqual([[2, 2], [2, 2]]);   // 4 found: order 1 keeps its 2, order 2 gets 2 of 3 and the shortfall is released
    await clean();
  });

  it("cancelling a wave releases its orders for another wave", async () => {
    const { s, o1 } = await ready();
    const w = await T(s)((c, ctx) => createWave(c, ctx, { strategy: "wave", order_ids: [o1.id] }));
    await T(s)((c, ctx) => cancelWave(c, ctx, w.id));
    await expect(T(s)((c, ctx) => createWave(c, ctx, { strategy: "wave", order_ids: [o1.id] }))).resolves.toBeTruthy();
  });
});
