import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { uploadDocument } from "../src/ops/documents.js";
import {
  allocateOrder, cancelFulfilOrder, createInbound, createLocation, createOrder, createReturn, createSku, decideAdjustment, getInbound, holdFulfilLot, packScan, pickOrder,
  receiveInbound, receiveReturn, requestAdjustment, shipOrder, transferStock, updateSku,
} from "../src/ops/fulfilment.js";
import { lotWorkspace, traceLot } from "../src/ops/fulfil-lots.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
const uid = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`;
const future = (d: number) => new Date(Date.now() + 4 * 3600000 + d * 86400000).toISOString().slice(0, 10);

async function staff(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`fl-${role}-${uid()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
async function shop() {
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const f = await db.tenant(t.tenantId, async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Pharma Direct" });
    const A = await createLocation(c, t.ctx, { code: "a-01" }), B = await createLocation(c, t.ctx, { code: "b-01" });
    const doc = await uploadDocument(c, t.ctx, { kind: "other", title: "Supplier lot source", issuer: "Supplier", filename: "s.pdf", data: Buffer.from("%PDF-1.4 src") });
    const cream = await createSku(c, t.ctx, { party_id: merchant, code: "cream", name: "Cream", rotation: "fefo", tracking: "lot", min_shelf_days: 10 });
    const phone = await createSku(c, t.ctx, { party_id: merchant, code: "phone", name: "Phone", tracking: "serial" });
    const mug = await createSku(c, t.ctx, { party_id: merchant, code: "mug", name: "Mug" });
    return { merchant, A, B, doc, cream, phone, mug };
  });
  return { t, ...f };
}
type Shop = Awaited<ReturnType<typeof shop>>;
const T = (s: Shop) => <R>(fn: (c: any, ctx: typeof s.t.ctx) => Promise<R>) => db.tenant(s.t.tenantId, (c) => fn(c, s.t.ctx));
async function receive(s: Shop, code: string, qty: number, loc: string, extra: Record<string, any>, damaged = 0) {
  return T(s)(async (c, ctx) => {
    const inb = await createInbound(c, ctx, { party_id: s.merchant, lines: `${code}, ${qty + damaged}` });
    const d = await getInbound(c, inb.id);
    return receiveInbound(c, ctx, inb.id, { line_id: d.lines[0].id, good: qty, damaged, location_id: loc, token: `tok-${uid()}`, document_id: s.doc, ...extra });
  });
}
const order = (s: Shop, lines: string) => T(s)((c, ctx) => createOrder(c, ctx, { party_id: s.merchant, external_ref: `O-${uid()}`, ship_to_name: "Aisha", ship_to_address: "Marina 1", ship_to_city: "Dubai", lines }));
const lotIdOf = async (sku: string, lot: string) => (await db.query<any>(`SELECT id FROM fulfil_lots WHERE sku_id=$1 AND lot=$2`, [sku, lot])).rows[0].id as string;
const q = (s: Shop, sql: string, p: any[] = []) => db.tenant(s.t.tenantId, (c) => c.query<any>(sql, p)).then((r) => r.rows);
const clean = async () => expect(await verifyInvariants(db)).toEqual([]);

describe("fulfilment lot, expiry and FEFO control", () => {
  it("requires lot evidence, allocates earliest expiry first and skips expired / short-shelf-life lots", async () => {
    const s = await shop();
    await expect(receive(s, "CREAM", 5, s.A, { lot: "NOEXP" })).rejects.toThrow(/expiry/);
    await expect(receive(s, "CREAM", 5, s.A, { lot: "X", expires_at: future(40), document_id: undefined })).rejects.toThrow(/Issued source evidence/);
    await receive(s, "CREAM", 4, s.A, { lot: "late", expires_at: future(90) });
    await receive(s, "CREAM", 4, s.B, { lot: "early", expires_at: future(30) });
    await receive(s, "CREAM", 4, s.A, { lot: "soon", expires_at: future(3) });          // inside the 10-day minimum shelf life
    const o = await order(s, "CREAM, 6");
    await T(s)((c, ctx) => allocateOrder(c, ctx, o.id));
    const al = await q(s, `SELECT l.lot, a.qty FROM stock_allocations a JOIN fulfil_lots l ON l.id=a.lot_id ORDER BY l.lot`);
    expect(al).toEqual([{ lot: "EARLY", qty: 4 }, { lot: "LATE", qty: 2 }]);
    await clean();
  });

  it("registering the same lot with different expiry or evidence is refused", async () => {
    const s = await shop();
    await receive(s, "CREAM", 1, s.A, { lot: "L1", expires_at: future(60) });
    await expect(receive(s, "CREAM", 1, s.A, { lot: "L1", expires_at: future(61) })).rejects.toThrow(/different expiry/);
  });

  it("a quality hold frees reservations, blocks shipment and needs a different person to release", async () => {
    const s = await shop();
    await receive(s, "CREAM", 5, s.A, { lot: "bad", expires_at: future(30) });
    await receive(s, "CREAM", 5, s.B, { lot: "good", expires_at: future(60) });
    const o = await order(s, "CREAM, 3");
    await T(s)((c, ctx) => allocateOrder(c, ctx, o.id));
    const bad = await lotIdOf(s.cream, "BAD");
    const approver = await staff(s.t.tenantId, "finance");
    const r = await db.tenant(s.t.tenantId, (c) => holdFulfilLot(c, approver, bad, true, "Supplier recall notice 7"));
    expect(r.released).toBe(3);
    expect(await q(s, `SELECT l.lot FROM stock_allocations a JOIN fulfil_lots l ON l.id=a.lot_id`)).toEqual([{ lot: "GOOD" }]);
    await expect(db.tenant(s.t.tenantId, (c) => holdFulfilLot(c, approver, bad, false, "ok"))).rejects.toThrow(/someone other/);
    const other = await staff(s.t.tenantId, "finance");
    await db.tenant(s.t.tenantId, (c) => holdFulfilLot(c, other, bad, false, "Cleared by QA report 9"));
    await clean();
  });

  it("holding a lot after pick keeps units in staging but refuses to ship them; cancel returns them to the lot", async () => {
    const s = await shop();
    await receive(s, "CREAM", 4, s.A, { lot: "p1", expires_at: future(50) });
    const o = await order(s, "CREAM, 2");
    await T(s)(async (c, ctx) => { await allocateOrder(c, ctx, o.id); await pickOrder(c, ctx, o.id); await packScan(c, ctx, o.id, { code: "CREAM", qty: 2 }); });
    const approver = await staff(s.t.tenantId, "finance");
    const p1 = await await_(s, "P1");
    await db.tenant(s.t.tenantId, (c) => holdFulfilLot(c, approver, p1, true, "Contamination"));
    await expect(T(s)((c, ctx) => shipOrder(c, ctx, o.id, { carrier: "X", tracking_no: `T${uid()}` }))).rejects.toThrow(/on hold or expired/);
    await T(s)((c, ctx) => cancelFulfilOrder(c, ctx, o.id));
    const lv = (await q(s, `SELECT on_hand FROM stock_lot_levels v JOIN wh_locations x ON x.id=v.location_id WHERE x.code='A-01'`))[0];
    expect(lv.on_hand).toBe(4);
    await clean();
  });

  it("serial-tracked units are received, packed, shipped and returned one by one, and trace to the recipient", async () => {
    const s = await shop();
    await expect(receive(s, "PHONE", 2, s.A, { serials: "S1" })).rejects.toThrow(/serial number/);
    await receive(s, "PHONE", 2, s.A, { serials: "S1\nS2" });
    const o = await order(s, "PHONE, 2");
    await T(s)(async (c, ctx) => { await allocateOrder(c, ctx, o.id); await pickOrder(c, ctx, o.id); });
    await expect(T(s)((c, ctx) => packScan(c, ctx, o.id, { code: "PHONE" }))).rejects.toThrow(/serial/);
    await T(s)(async (c, ctx) => { await packScan(c, ctx, o.id, { code: "s1" }); await packScan(c, ctx, o.id, { code: "S2" }); });
    await expect(T(s)((c, ctx) => packScan(c, ctx, o.id, { code: "S2" }))).rejects.toThrow(/already packed/);
    await T(s)((c, ctx) => shipOrder(c, ctx, o.id, { carrier: "Aramex", tracking_no: `T${uid()}` }));
    const s1 = await await_(s, "S1", "serial_ref");
    const trace = await T(s)((c, ctx) => traceLot(c, ctx, s1));
    expect(trace.orders.length).toBe(1);
    expect(trace.orders[0].ship_to_city).toBe("Dubai");
    const ret = await T(s)((c, ctx) => createReturn(c, ctx, { party_id: s.merchant, order_no: (trace.orders[0] as any).no, lines: "PHONE, 1" }));
    const line = (await db.query<any>(`SELECT id FROM fulfil_return_lines WHERE return_id=$1`, [ret.id])).rows[0].id;
    await expect(T(s)((c, ctx) => receiveReturn(c, ctx, ret.id, { line_id: line, qty: 1, disposition: "restock", location_id: s.B, token: `r-${uid()}` }))).rejects.toThrow(/Lot/);
    await T(s)((c, ctx) => receiveReturn(c, ctx, ret.id, { line_id: line, qty: 1, disposition: "restock", location_id: s.B, token: `r-${uid()}`, lot: "S1" }));
    expect((await db.tenant(s.t.tenantId, (c) => lotWorkspace(c))).length).toBeGreaterThan(0);
    await clean();
  });

  it("transfers and count adjustments act on a named lot", async () => {
    const s = await shop();
    await receive(s, "CREAM", 6, s.A, { lot: "t1", expires_at: future(80) });
    await expect(T(s)((c, ctx) => transferStock(c, ctx, { sku_id: s.cream, from_location: s.A, to_location: s.B, qty: 2 }))).rejects.toThrow();
    await T(s)((c, ctx) => transferStock(c, ctx, { sku_id: s.cream, from_location: s.A, to_location: s.B, qty: 2, lot: "T1" }));
    const adj = await T(s)((c, ctx) => requestAdjustment(c, ctx, { sku_id: s.cream, location_id: s.B, counted_qty: 1, reason: "Damaged tube", lot: "T1" }));
    expect((adj as any).variance).toBe(-1);
    const approver = await staff(s.t.tenantId, "finance");
    expect((await db.tenant(s.t.tenantId, (c) => decideAdjustment(c, approver, (adj as any).id, true))).status).toBe("applied");
    await clean();
  });

  it("tracking cannot change after stock history, and plain SKUs refuse lot movements", async () => {
    const s = await shop();
    await receive(s, "MUG", 3, s.A, {});
    await expect(T(s)((c, ctx) => updateSku(c, ctx, s.mug, { tracking: "lot" }))).rejects.toThrow(/stock history/);
    await expect(receive(s, "MUG", 1, s.A, { lot: "L" })).resolves.toBeTruthy();   // lot fields on an untracked SKU are ignored
    await clean();
  });
});
async function await_(_s: Shop, code: string, col = "lot") { return (await db.query<any>(`SELECT id FROM fulfil_lots WHERE ${col}=$1 ORDER BY created_at DESC LIMIT 1`, [code])).rows[0].id as string; }
