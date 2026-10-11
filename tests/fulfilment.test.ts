import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { recordReceipt, voidInvoice } from "../src/ops/finance.js";
import {
  allocateOrder, allocateWaiting, cancelFulfilOrder, cancelInbound, cancelReturn, closeInbound, closeReturn, closeShort, createInbound, createLocation, createOrder,
  createReturn, createSku, decideAdjustment, fulfilmentOverview, getFulfilOrder, getInbound, getReturn, importOrders, importSkus, listAdjustments, listLocations, listFulfilOrders,
  packScan, pickList, pickOrder, receiveInbound, receiveReturn, requestAdjustment, resetPacking, setLocationActive, shipOrder, stockOverview, transferStock, updateSku,
} from "../src/ops/fulfilment.js";
import { billingSummary, invoiceMerchant, runStorageCharges, setRate } from "../src/ops/fulfil-billing.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

let n = 0;
const uid = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`;

async function shop(opts: { rates?: boolean } = {}) {
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const f = await db.tenant(t.tenantId, async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Desert Threads" });
    const A = await createLocation(c, t.ctx, { code: "a-01" }), B = await createLocation(c, t.ctx, { code: "b-01" });
    const tee = await createSku(c, t.ctx, { party_id: merchant, code: "tee-m", name: "T-shirt M", barcode: "6291000000011", reorder_point: 2 });
    const mug = await createSku(c, t.ctx, { party_id: merchant, code: "mug", name: "Mug", barcode: "6291000000028" });
    if (opts.rates) {
      for (const [code, amount] of [["receive_unit", "0.50"], ["pick_order", "2.00"], ["pick_unit", "0.30"], ["pack_order", "1.50"], ["return_unit", "1.00"], ["storage_location_month", "10"]])
        await setRate(c, t.ctx, { party_id: merchant, code, amount, tax_code: "SR5" });
    }
    return { merchant, A, B, tee, mug };
  });
  return { t, ...f };
}
type Shop = Awaited<ReturnType<typeof shop>>;

/** Expect + receive in one go. */
async function stockIn(s: Shop, code: string, qty: number, loc: string, extra: Record<string, any> = {}) {
  return db.tenant(s.t.tenantId, async (c) => {
    const inb = await createInbound(c, s.t.ctx, { party_id: s.merchant, lines: `${code}, ${qty}` });
    const d = await getInbound(c, inb.id);
    const r = await receiveInbound(c, s.t.ctx, inb.id, { line_id: d.lines[0].id, good: qty, damaged: 0, location_id: loc, token: `tok-${uid()}`, ...extra });
    return { inb, r };
  });
}
const place = (s: Shop, lines: string, over: Record<string, any> = {}) =>
  db.tenant(s.t.tenantId, (c) => createOrder(c, s.t.ctx, { party_id: s.merchant, external_ref: `ORD-${uid()}`, ship_to_name: "Aisha", ship_to_address: "Marina Walk 12, Dubai", ship_to_city: "Dubai", lines, ...over }));
const statusOf = async (id: string) => (await db.query<any>(`SELECT status FROM fulfil_orders WHERE id=$1`, [id])).rows[0].status;
const level = async (sku: string, loc: string) => (await db.query<any>(`SELECT on_hand, reserved FROM stock_levels WHERE sku_id=$1 AND location_id=$2`, [sku, loc])).rows[0] ?? { on_hand: 0, reserved: 0 };
const stage = async (s: Shop) => (await db.query<any>(`SELECT id FROM wh_locations WHERE tenant_id=$1 AND code='STAGE'`, [s.t.tenantId])).rows[0]?.id as string | undefined;
const T = (s: Shop) => <R>(fn: (c: any, ctx: typeof s.t.ctx) => Promise<R>) => db.tenant(s.t.tenantId, (c) => fn(c, s.t.ctx));
const clean = async () => expect(await verifyInvariants(db)).toEqual([]);

describe("stock reservation", () => {
  it("receiving writes the ledger; orders never oversell and wait all-or-nothing, oldest first", async () => {
    const s = await shop();
    await stockIn(s, "TEE-M", 10, s.A);
    expect(await level(s.tee, s.A)).toEqual({ on_hand: 10, reserved: 0 });

    const o1 = await place(s, "TEE-M, 6"), o2 = await place(s, "TEE-M, 6\nMUG, 1"), o3 = await place(s, "TEE-M, 3");
    expect(await statusOf(o1.id)).toBe("allocated");
    expect(await statusOf(o2.id)).toBe("backordered");                    // 4 free < 6: nothing is half-reserved
    expect(await statusOf(o3.id)).toBe("allocated");                      // a later, smaller order may jump a waiting one
    expect(await level(s.tee, s.A)).toEqual({ on_hand: 10, reserved: 9 });
    expect((await db.query<any>(`SELECT count(*)::int n FROM stock_allocations WHERE line_id IN (SELECT id FROM fulfil_order_lines WHERE order_id=$1)`, [o2.id])).rows[0].n).toBe(0);

    await stockIn(s, "TEE-M", 20, s.B);                                    // arrives → waiting order is served automatically
    expect(await statusOf(o2.id)).toBe("backordered");                    // the mug is still missing, so still all-or-nothing
    await stockIn(s, "MUG", 5, s.B);
    expect(await statusOf(o2.id)).toBe("allocated");

    // ledger reconciles to levels; nothing is negative
    const mv = (await db.query<any>(`SELECT sum(delta)::int n FROM stock_movements WHERE sku_id=$1`, [s.tee])).rows[0].n;
    expect(mv).toBe(30);
    await expect(db.system((c) => c.query(`UPDATE stock_levels SET reserved = on_hand + 1 WHERE sku_id=$1`, [s.tee]))).rejects.toThrow();
    await expect(db.system((c) => c.query(`UPDATE stock_movements SET delta = 1`))).rejects.toThrow(/immutable/);
    await clean();
  });

  it("partial orders reserve what exists, and cannot ship incomplete until the rest arrives or is closed short", async () => {
    const s = await shop(), t = T(s);
    await stockIn(s, "TEE-M", 2, s.A);
    const o = await place(s, "TEE-M, 5", { allow_partial: "1" });
    let d = await t((c) => getFulfilOrder(c, o.id));
    expect(d.lines[0]).toMatchObject({ allocated_qty: 2, waiting: 3 });
    await t((c, x) => pickOrder(c, x, o.id));
    await t((c, x) => packScan(c, x, o.id, { code: "TEE-M", qty: 2 }));
    await expect(t((c, x) => shipOrder(c, x, o.id, { carrier: "Aramex", tracking_no: "P1" }))).rejects.toThrow(/3 unit\(s\) not allocated/);
    await expect(t((c, x) => closeShort(c, x, o.id, ""))).rejects.toThrow(/Reason is required/);
    await t((c, x) => closeShort(c, x, o.id, "Merchant confirmed 3 units discontinued"));
    await t((c, x) => shipOrder(c, x, o.id, { carrier: "Aramex", tracking_no: "P1" }));
    d = await t((c) => getFulfilOrder(c, o.id));
    expect(d.lines[0]).toMatchObject({ shipped_qty: 2, closed_qty: 3 });
    await clean();
  });

  it("two orders racing for the last unit: exactly one gets it", async () => {
    const s = await shop();
    await stockIn(s, "MUG", 1, s.A);
    const [x, y] = await Promise.all([place(s, "MUG, 1"), place(s, "MUG, 1")]);
    expect([await statusOf(x.id), await statusOf(y.id)].sort()).toEqual(["allocated", "backordered"]);
    expect(await level(s.mug, s.A)).toEqual({ on_hand: 1, reserved: 1 });
    await clean();
  });

  it("reserved units cannot be moved away; free units can, and moving into a bin serves waiting orders", async () => {
    const s = await shop(), t = T(s);
    await stockIn(s, "TEE-M", 5, s.A);
    await place(s, "TEE-M, 4");
    await expect(t((c, x) => transferStock(c, x, { sku_id: s.tee, from_location: s.A, to_location: s.B, qty: 3 }))).rejects.toThrow(/Not enough unreserved/);
    await t((c, x) => transferStock(c, x, { sku_id: s.tee, from_location: s.A, to_location: s.B, qty: 1 }));
    expect(await level(s.tee, s.B)).toEqual({ on_hand: 1, reserved: 0 });
    await expect(t((c, x) => transferStock(c, x, { sku_id: s.tee, from_location: s.A, to_location: s.A, qty: 1 }))).rejects.toThrow(/two different/);
    const waiting = await place(s, "TEE-M, 1");
    expect(await statusOf(waiting.id)).toBe("allocated");                  // the unit in B is free
    await clean();
  });
});

describe("pick, pack, ship", () => {
  it("full lifecycle: pick → scan-verified pack → ship; staging empties; tracking is unique; activity bills once", async () => {
    const s = await shop({ rates: true }), t = T(s);
    await stockIn(s, "TEE-M", 10, s.A);
    const o = await place(s, "TEE-M, 2");
    expect((await t((c) => pickList(c))).find((r: any) => r.order_id === o.id)).toMatchObject({ location: "A-01", sku: "TEE-M", remaining: 2 });

    await expect(t((c, x) => packScan(c, x, o.id, { code: "TEE-M", qty: 1 }))).rejects.toThrow(/nothing has been picked/);
    const alloc = (await t((c) => getFulfilOrder(c, o.id))).allocs[0];
    await expect(t((c, x) => pickOrder(c, x, o.id, { [alloc.id]: 3 }))).rejects.toThrow(/between 0 and 2/);
    const pk = await t((c, x) => pickOrder(c, x, o.id));
    expect(pk).toMatchObject({ picked: 2, shorts: 0, status: "picked" });
    expect(await level(s.tee, s.A)).toEqual({ on_hand: 8, reserved: 0 });
    expect((await level(s.tee, (await stage(s))!)).on_hand).toBe(2);

    await expect(t((c, x) => packScan(c, x, o.id, { code: "MUG" }))).rejects.toThrow(/not on this order/);
    await expect(t((c, x) => packScan(c, x, o.id, { code: "6291000000011", qty: 3 }))).rejects.toThrow(/cannot pack 3 more/);
    await t((c, x) => packScan(c, x, o.id, { code: "6291000000011", qty: 1 }));        // by barcode
    expect(await statusOf(o.id)).toBe("picked");
    await t((c, x) => resetPacking(c, x, o.id));
    await t((c, x) => packScan(c, x, o.id, { code: "tee-m", qty: 2 }));                // by SKU, case-insensitive
    expect(await statusOf(o.id)).toBe("packed");

    await expect(t((c, x) => shipOrder(c, x, o.id, { carrier: "Aramex", tracking_no: "" }))).rejects.toThrow(/Tracking number is required/);
    await t((c, x) => shipOrder(c, x, o.id, { carrier: "Aramex", tracking_no: "AX-100", cartons: 1, weight_g: 600 }));
    expect(await statusOf(o.id)).toBe("shipped");
    expect((await level(s.tee, (await stage(s))!)).on_hand).toBe(0);
    await expect(t((c, x) => shipOrder(c, x, o.id, { carrier: "Aramex", tracking_no: "AX-101" }))).rejects.toThrow(/fully packed/);
    await expect(t((c, x) => cancelFulfilOrder(c, x, o.id))).rejects.toThrow(/shipped order cannot be cancelled/);

    // tracking numbers are unique per carrier
    await stockIn(s, "MUG", 3, s.A);
    const o2 = await place(s, "MUG, 1");
    await t((c, x) => pickOrder(c, x, o2.id)); await t((c, x) => packScan(c, x, o2.id, { code: "MUG" }));
    await expect(t((c, x) => shipOrder(c, x, o2.id, { carrier: "Aramex", tracking_no: "AX-100" }))).rejects.toThrow(/already used on FUL-/);
    await t((c, x) => shipOrder(c, x, o2.id, { carrier: "DHL", tracking_no: "AX-100" }));

    // activity: receive 10+3 units (0.50), per-order, per-unit, pack — each billed once
    const sum = (await t((c) => billingSummary(c)))[0];
    const by = Object.fromEntries(sum.lines.map((l: any) => [l.code, l.qty]));
    expect(by).toEqual({ receive_unit: 13, pick_order: 2, pick_unit: 3, pack_order: 2 });
    const inv = await t((c, x) => invoiceMerchant(c, x, s.merchant));
    const row = (await db.query<any>(`SELECT subtotal_minor, tax_minor, total_minor FROM invoices WHERE id=$1`, [inv.id])).rows[0];
    expect(Number(row.subtotal_minor)).toBe(13 * 50 + 2 * 200 + 3 * 30 + 2 * 150);
    expect((await db.query<any>(`SELECT count(*)::int n FROM invoice_lines WHERE invoice_id=$1`, [inv.id])).rows[0].n).toBe(4);
    await expect(t((c, x) => invoiceMerchant(c, x, s.merchant))).rejects.toThrow(/No uninvoiced/);
    await clean();

    // a void returns the activity to the unbilled pool and it can be invoiced again — never twice
    await t((c, x) => voidInvoice(c, x, inv.id, "wrong rate card"));
    expect((await t((c) => billingSummary(c)))[0].total).toBe(13 * 50 + 2 * 200 + 3 * 30 + 2 * 150);
    const inv2 = await t((c, x) => invoiceMerchant(c, x, s.merchant));
    expect(inv2.id).not.toBe(inv.id);
    await t((c, x) => recordReceipt(c, x, inv2.id, { amount: "5", method: "bank" }));
    await clean();
  });

  it("short pick: shortfall is released, a count task is raised, and the order re-allocates from another bin", async () => {
    const s = await shop(), t = T(s);
    await stockIn(s, "TEE-M", 3, s.A); await stockIn(s, "TEE-M", 5, s.B);
    const o = await place(s, "TEE-M, 4");
    const a0 = (await t((c) => getFulfilOrder(c, o.id))).allocs[0];
    expect(a0).toMatchObject({ location: "B-01", qty: 4 });                          // best fit: one bin that covers the order
    const r = await t((c, x) => pickOrder(c, x, o.id, { [a0.id]: 2 }));
    expect(r).toMatchObject({ picked: 2, shorts: 1 });
    expect((await db.query<any>(`SELECT title FROM job_exceptions WHERE tenant_id=$1`, [s.t.tenantId])).rows[0].title).toMatch(/Short pick FUL-.*TEE-M at B-01/);
    expect((await t((c) => fulfilmentOverview(c))).openExceptions).toBe(1);
    let d = await t((c) => getFulfilOrder(c, o.id));
    expect(d.lines[0]).toMatchObject({ allocated_qty: 2, picked_qty: 2, waiting: 2 });
    expect(await level(s.tee, s.B)).toEqual({ on_hand: 3, reserved: 0 });
    await clean();

    await t((c, x) => allocateOrder(c, x, o.id));                                    // the remaining 2 come from elsewhere
    d = await t((c) => getFulfilOrder(c, o.id));
    expect(d.lines[0]).toMatchObject({ allocated_qty: 4, waiting: 0 });
    expect(await statusOf(o.id)).toBe("picking");
    await t((c, x) => pickOrder(c, x, o.id));
    await t((c, x) => packScan(c, x, o.id, { code: "TEE-M", qty: 4 }));
    await t((c, x) => shipOrder(c, x, o.id, { carrier: "SMSA", tracking_no: "S-1" }));
    await clean();
  });

  it("cancel after picking puts stock back in the bin it came from and serves the next waiting order", async () => {
    const s = await shop(), t = T(s);
    await stockIn(s, "TEE-M", 3, s.A);
    const o = await place(s, "TEE-M, 3");
    const waiting = await place(s, "TEE-M, 2");
    expect(await statusOf(waiting.id)).toBe("backordered");
    await t((c, x) => pickOrder(c, x, o.id));
    expect((await level(s.tee, (await stage(s))!)).on_hand).toBe(3);
    await t((c, x) => cancelFulfilOrder(c, x, o.id));
    expect(await statusOf(o.id)).toBe("cancelled");
    expect((await level(s.tee, (await stage(s))!)).on_hand).toBe(0);
    expect(await level(s.tee, s.A)).toEqual({ on_hand: 3, reserved: 2 });           // 2 now reserved by the order that was waiting
    expect(await statusOf(waiting.id)).toBe("allocated");
    await expect(t((c, x) => pickOrder(c, x, o.id))).rejects.toThrow(/only allocated orders/);
    await clean();
  });

  it("a SKU with open orders cannot be deactivated; a bin with stock cannot be switched off", async () => {
    const s = await shop(), t = T(s);
    await stockIn(s, "MUG", 2, s.A);
    await place(s, "MUG, 1");
    await expect(t((c, x) => updateSku(c, x, s.mug, { active: "0" }))).rejects.toThrow(/Open orders still use/);
    await expect(t((c, x) => setLocationActive(c, x, s.A, false))).rejects.toThrow(/still holds stock/);
    await t((c, x) => setLocationActive(c, x, s.B, false));
    await expect(t((c, x) => transferStock(c, x, { sku_id: s.mug, from_location: s.A, to_location: s.B, qty: 1 }))).rejects.toThrow(/switched off/);
  });
});

describe("inbound receiving", () => {
  it("is idempotent per submit token, quarantines damage, flags over-receipt and locks after close", async () => {
    const s = await shop(), t = T(s);
    const inb = await t((c, x) => createInbound(c, x, { party_id: s.merchant, reference: "PO-7", lines: "TEE-M, 10\nMUG, 4" }));
    const d = await t((c) => getInbound(c, inb.id));
    const lineTee = d.lines.find((l: any) => l.code === "TEE-M").id;
    const quar = (await t((c) => listLocations(c))).find((l: any) => l.kind === "quarantine");
    expect(quar).toBeUndefined();                                                     // system areas appear when first needed

    const f = { line_id: lineTee, good: 8, damaged: 1, location_id: s.A, token: "token-aaaa-0001" };
    expect((await t((c, x) => receiveInbound(c, x, inb.id, f)))).toMatchObject({ duplicate: false, good: 8, damaged: 1 });
    expect((await t((c, x) => receiveInbound(c, x, inb.id, f)))).toEqual({ duplicate: true });   // double click / retry
    expect(await level(s.tee, s.A)).toEqual({ on_hand: 8, reserved: 0 });
    const q = (await t((c) => listLocations(c))).find((l: any) => l.kind === "quarantine");
    expect(await level(s.tee, q.id)).toEqual({ on_hand: 1, reserved: 0 });

    const nine = await place(s, "TEE-M, 9");
    expect(await statusOf(nine.id)).toBe("backordered");                              // quarantined unit is not sellable

    await expect(t((c, x) => receiveInbound(c, x, inb.id, { ...f, good: 5, damaged: 0, token: "token-aaaa-0002" }))).rejects.toThrow(/accept over-receipt/);
    await t((c, x) => receiveInbound(c, x, inb.id, { ...f, good: 5, damaged: 0, token: "token-aaaa-0002", accept_over: "1" }));
    expect(await statusOf(nine.id)).toBe("allocated");                                // 13 good units now cover it
    await expect(t((c, x) => receiveInbound(c, x, inb.id, { ...f, good: 1, token: "token-aaaa-0003", location_id: q.id }))).rejects.toThrow(/bin or the receiving/);
    await expect(t((c, x) => receiveInbound(c, x, inb.id, { ...f, good: 1, token: "bad" }))).rejects.toThrow(/expired/);

    let after = await t((c) => getInbound(c, inb.id));
    expect(after.lines.find((l: any) => l.code === "TEE-M")).toMatchObject({ received_qty: 13, damaged_qty: 1 });
    expect(after.inb.status).toBe("receiving");                                       // the mug line is still open
    await t((c, x) => closeInbound(c, x, inb.id));
    await expect(t((c, x) => receiveInbound(c, x, inb.id, { ...f, good: 1, token: "token-aaaa-0004" }))).rejects.toThrow(/inbound is closed/);
    await expect(t((c, x) => cancelInbound(c, x, inb.id))).rejects.toThrow(/already been received/);
    after = await t((c) => getInbound(c, inb.id));
    expect(after.receipts).toHaveLength(2);
    await clean();
  });

  it("rejects unknown SKUs and another merchant's SKU codes; SKU/barcode uniqueness is per merchant", async () => {
    const s = await shop(), t = T(s);
    await expect(t((c, x) => createInbound(c, x, { party_id: s.merchant, lines: "NOPE, 1" }))).rejects.toThrow(/Unknown SKU for this merchant: NOPE/);
    await expect(t((c, x) => createInbound(c, x, { party_id: s.merchant, lines: "TEE-M" }))).rejects.toThrow(/SKU-CODE, quantity/);
    await expect(t((c, x) => createInbound(c, x, { party_id: s.merchant, lines: Array.from({ length: 501 }, (_, i) => `S${i}, 1`).join("\n") }))).rejects.toThrow(/Too many different SKUs/);
    await expect(t((c, x) => createSku(c, x, { party_id: s.merchant, code: "tee-m", name: "dup" }))).rejects.toThrow(/already has a SKU TEE-M/);
    await expect(t((c, x) => createSku(c, x, { party_id: s.merchant, code: "new", name: "dup barcode", barcode: "6291000000011" }))).rejects.toThrow(/barcode/);
    const other = await t((c, x) => createParty(c, x, { kind: "customer", name: "Other Merchant" }));
    await t((c, x) => createSku(c, x, { party_id: other, code: "tee-m", name: "Other's tee", barcode: "6291000000011" }));   // same code/barcode is fine for another merchant
    await expect(place(s, "TEE-M, 1", { party_id: other })).resolves.toBeDefined();                               // resolves to the other merchant's own SKU
    await clean();
  });
});

describe("count adjustments (independent approval)", () => {
  it("needs a different approver; shrinking below reserved releases orders; a stale count is voided", async () => {
    const s = await shop(), t = T(s);
    await db.system((c) => c.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES ($1,'max_users',10,'test')`, [s.t.tenantId]));
    const staff = async (...roles: string[]) => {
      const email = `${roles.join("-")}-${uid()}@wh.test`;
      const token = await t((c, x) => invite(c, x, { email, roles }));
      const acc = await acceptInvite(db, token, { name: roles.join("+"), password: "warehouse-pass-1" });
      return ctxFor(acc.userId, s.t.tenantId, roles);
    };
    const op = await staff("warehouse"), fin = await staff("finance"), both = await staff("warehouse", "finance");
    const as = <R>(ctx: any, fn: (c: any) => Promise<R>) => db.tenant(s.t.tenantId, (c) => fn(c));

    await stockIn(s, "TEE-M", 10, s.A);
    const o = await place(s, "TEE-M, 8");
    expect(await level(s.tee, s.A)).toEqual({ on_hand: 10, reserved: 8 });

    expect(await as(op, (c) => requestAdjustment(c, op, { sku_id: s.tee, location_id: s.A, counted_qty: 10, reason: "x" }))).toEqual({ verified: true });
    await expect(as(op, (c) => requestAdjustment(c, op, { sku_id: s.tee, location_id: s.A, counted_qty: "", reason: "x" }))).rejects.toThrow(/Enter the counted/);
    const adj = await as(op, (c) => requestAdjustment(c, op, { sku_id: s.tee, location_id: s.A, counted_qty: 5, reason: "Water damage found" })) as any;
    expect(adj.variance).toBe(-5);
    await expect(as(op, (c) => requestAdjustment(c, op, { sku_id: s.tee, location_id: s.A, counted_qty: 4, reason: "again" }))).rejects.toThrow(/already waiting/);
    expect(await level(s.tee, s.A)).toEqual({ on_hand: 10, reserved: 8 });            // nothing moves before approval

    await expect(as(op, (c) => decideAdjustment(c, op, adj.id, true))).rejects.toThrow(/does not allow/);   // floor staff cannot approve
    const res = await as(fin, (c) => decideAdjustment(c, fin, adj.id, true)) as any;
    expect(res).toMatchObject({ status: "applied", released: 3 });                    // 8 reserved > 5 on hand: 3 reservations freed
    expect(await level(s.tee, s.A)).toEqual({ on_hand: 5, reserved: 5 });
    const d = await t((c) => getFulfilOrder(c, o.id));
    expect(d.lines[0]).toMatchObject({ allocated_qty: 5, waiting: 3 });
    await expect(as(fin, (c) => decideAdjustment(c, fin, adj.id, true))).rejects.toThrow(/already applied/);
    await clean();

    // the person who counted cannot approve their own count (finance has the permission to approve, not to self-approve)
    const own = await as(both, (c) => requestAdjustment(c, both, { sku_id: s.tee, location_id: s.A, counted_qty: 6, reason: "found extra" })) as any;
    await expect(as(both, (c) => decideAdjustment(c, both, own.id, true))).rejects.toThrow(/person who counted/);
    // …and the count is voided if stock moved in between
    await stockIn(s, "TEE-M", 10, s.A);
    const stale = await as(s.t.ctx, (c) => decideAdjustment(c, s.t.ctx, own.id, true)) as any;
    expect(stale.status).toBe("stale");
    expect(await level(s.tee, s.A)).toMatchObject({ on_hand: 15 });
    const rej = await as(op, (c) => requestAdjustment(c, op, { sku_id: s.tee, location_id: s.B, counted_qty: 3, reason: "unknown stock in B" })) as any;
    expect((await as(fin, (c) => decideAdjustment(c, fin, rej.id, false, "recount first"))).status).toBe("rejected");
    expect((await t((c) => listAdjustments(c))).map((a: any) => a.status).sort()).toEqual(["applied", "rejected", "stale"]);
    await clean();
  });

  it("staging stock is counted by finishing orders, not by adjustment", async () => {
    const s = await shop(), t = T(s);
    await stockIn(s, "MUG", 2, s.A);
    const o = await place(s, "MUG, 1");
    await t((c, x) => pickOrder(c, x, o.id));
    const st = (await stage(s))!;
    await expect(t((c, x) => requestAdjustment(c, x, { sku_id: s.mug, location_id: st, counted_qty: 0, reason: "lost" }))).rejects.toThrow(/Staging stock belongs to open orders/);
    await expect(t((c, x) => transferStock(c, x, { sku_id: s.mug, from_location: st, to_location: s.A, qty: 1 }))).rejects.toThrow(/Staging is managed/);
  });
});

describe("returns", () => {
  it("cannot exceed what shipped; restock / quarantine / dispose each do the right thing; receipts are idempotent", async () => {
    const s = await shop({ rates: true }), t = T(s);
    await stockIn(s, "TEE-M", 5, s.A);
    const o = await place(s, "TEE-M, 3");
    await t((c, x) => pickOrder(c, x, o.id)); await t((c, x) => packScan(c, x, o.id, { code: "TEE-M", qty: 3 }));
    const no = (await t((c) => getFulfilOrder(c, o.id))).order.no as string;
    await expect(t((c, x) => createReturn(c, x, { party_id: s.merchant, order_no: no, lines: "TEE-M, 1" }))).rejects.toThrow(/Only shipped orders/);
    await t((c, x) => shipOrder(c, x, o.id, { carrier: "Aramex", tracking_no: "R-1" }));
    await expect(t((c, x) => createReturn(c, x, { party_id: s.merchant, order_no: no, lines: "TEE-M, 4" }))).rejects.toThrow(/only 3 shipped/);
    await expect(t((c, x) => createReturn(c, x, { party_id: s.merchant, order_no: no, lines: "MUG, 1" }))).rejects.toThrow(/was not on order/);

    const ret = await t((c, x) => createReturn(c, x, { party_id: s.merchant, order_no: no, reason: "Wrong size", lines: "TEE-M, 2" }));
    await expect(t((c, x) => createReturn(c, x, { party_id: s.merchant, order_no: no, lines: "TEE-M, 2" }))).rejects.toThrow(/already on returns/);
    const line = (await t((c) => getReturn(c, ret.id))).lines[0].id;
    const base = { line_id: line, qty: 1 };
    expect(await t((c, x) => receiveReturn(c, x, ret.id, { ...base, disposition: "restock", location_id: s.B, token: "rt-token-0001" }))).toMatchObject({ duplicate: false });
    expect(await t((c, x) => receiveReturn(c, x, ret.id, { ...base, disposition: "restock", location_id: s.B, token: "rt-token-0001" }))).toEqual({ duplicate: true });
    expect(await level(s.tee, s.B)).toEqual({ on_hand: 1, reserved: 0 });
    await expect(t((c, x) => receiveReturn(c, x, ret.id, { ...base, qty: 2, disposition: "dispose", token: "rt-token-0002" }))).rejects.toThrow(/only 1 unit/);
    await t((c, x) => receiveReturn(c, x, ret.id, { ...base, disposition: "quarantine", token: "rt-token-0003" }));
    let d = await t((c) => getReturn(c, ret.id));
    expect(d.ret.status).toBe("received");
    expect(d.lines[0]).toMatchObject({ restocked_qty: 1, quarantined_qty: 1, disposed_qty: 0 });
    const q = (await t((c) => listLocations(c))).find((l: any) => l.kind === "quarantine");
    expect(await level(s.tee, q.id)).toEqual({ on_hand: 1, reserved: 0 });
    await t((c, x) => closeReturn(c, x, ret.id));
    await expect(t((c, x) => cancelReturn(c, x, ret.id))).rejects.toThrow(/already received|Units were already/);

    const by = Object.fromEntries((await t((c) => billingSummary(c)))[0].lines.map((l: any) => [l.code, l.qty]));
    expect(by.return_unit).toBe(2);
    const r2 = await t((c, x) => createReturn(c, x, { party_id: s.merchant, lines: "MUG, 2" }));          // a return without an order
    await t((c, x) => cancelReturn(c, x, r2.id));
    await clean();
  });
});

describe("billing activity", () => {
  it("storage is a once-per-month snapshot; no rate = no charge; rate changes never rewrite history", async () => {
    const s = await shop({ rates: true }), t = T(s);
    await stockIn(s, "TEE-M", 2, s.A); await stockIn(s, "MUG", 2, s.B); await stockIn(s, "MUG", 1, s.A);
    const month = new Date().toISOString().slice(0, 7);
    expect(await t((c, x) => runStorageCharges(c, x, month))).toEqual({ created: 1, already: 0, noRate: 0, dailyContracts: 0 });
    expect(await t((c, x) => runStorageCharges(c, x, month))).toEqual({ created: 0, already: 1, noRate: 0, dailyContracts: 0 });
    await expect(t((c, x) => runStorageCharges(c, x, "2999-01"))).rejects.toThrow(/future month/);
    const storage = (await db.query<any>(`SELECT qty, unit_minor FROM fulfil_charges WHERE code='storage_location_month' AND tenant_id=$1`, [s.t.tenantId])).rows[0];
    expect({ qty: storage.qty, unit: Number(storage.unit_minor) }).toEqual({ qty: 2, unit: 1000 });

    await t((c, x) => setRate(c, x, { party_id: s.merchant, code: "receive_unit", amount: "9.99", tax_code: "SR5" }));
    const old = (await db.query<any>(`SELECT unit_minor FROM fulfil_charges WHERE code='receive_unit' AND tenant_id=$1 LIMIT 1`, [s.t.tenantId])).rows[0];
    expect(Number(old.unit_minor)).toBe(50);                                                // history keeps the rate at the time
    await t((c, x) => setRate(c, x, { party_id: s.merchant, code: "receive_unit", amount: "0", tax_code: "SR5" }));
    await stockIn(s, "MUG", 4, s.A);                                                   // zero rate → no new receive charge
    expect((await db.query<any>(`SELECT count(*)::int n FROM fulfil_charges WHERE code='receive_unit' AND qty=4 AND tenant_id=$1`, [s.t.tenantId])).rows[0].n).toBe(0);

    const bare = await shop();                                                          // no rate card at all
    await stockIn(bare, "TEE-M", 1, bare.A);
    expect(await T(bare)((c, x) => runStorageCharges(c, x, month))).toEqual({ created: 0, already: 0, noRate: 1, dailyContracts: 0 });
    expect(await T(bare)((c) => billingSummary(c))).toEqual([]);
    await clean();
  });
});

describe("imports, quotas and isolation", () => {
  it("CSV order import is idempotent, previews safely, and rejects a whole order with any bad row", async () => {
    const s = await shop(), t = T(s);
    await stockIn(s, "TEE-M", 10, s.A); await stockIn(s, "MUG", 10, s.A);
    const csv = [
      "external_ref,sku,qty,ship_to_name,ship_to_address,channel,ship_to_city",
      "SH-1,tee-m,2,Aisha,Marina Walk 12,shopify,Dubai",
      "SH-1,mug,1,Aisha,Marina Walk 12,shopify,Dubai",
      "SH-2,tee-m,1,Omar,JLT Cluster D,shopify,Dubai",
      "SH-2,GHOST,1,Omar,JLT Cluster D,shopify,Dubai",
      "SH-3,tee-m,x,Sara,Al Barsha,shopify,Dubai",
      ",tee-m,1,Nobody,Nowhere,,",
    ].join("\n");
    const dry = await t((c, x) => importOrders(c, x, s.merchant, csv, true));
    expect(dry.created).toBe(1);
    expect(dry.rejected.map((r) => r.reason.split(":")[0]).sort()).toEqual(["SH-2", "SH-2", "SH-3", "external_ref is empty"].sort());
    expect((await t((c) => listFulfilOrders(c))).length).toBe(0);                      // dry run wrote nothing

    const real = await t((c, x) => importOrders(c, x, s.merchant, csv));
    expect(real.created).toBe(1);
    const again = await t((c, x) => importOrders(c, x, s.merchant, csv));
    expect(again.created).toBe(0); expect(again.duplicates).toEqual(["SH-1"]);         // re-upload is safe
    const rows = await t((c) => listFulfilOrders(c));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "allocated", units: 3, channel: "shopify" });
    await expect(t((c, x) => importOrders(c, x, s.merchant, "a,b\n1,2"))).rejects.toThrow(/“external_ref” column is required/);

    // an order rejected on a field rule must not burn a number: numbering stays gap-free
    const csv2 = ["external_ref,sku,qty,ship_to_name,ship_to_address,ship_to_country",
      "GAP-A,mug,1,Aisha,Marina,AE", "GAP-B,mug,1,Omar,JLT,UAE", "GAP-C,mug,1,Sara,Barsha,AE"].join("\n");
    const r2 = await t((c, x) => importOrders(c, x, s.merchant, csv2));
    expect(r2.created).toBe(2); expect(r2.rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/^GAP-B: .*too long/)]);
    const nos = (await t((c) => listFulfilOrders(c))).map((o: any) => o.no).sort();
    expect(nos).toEqual(["FUL-" + new Date().getUTCFullYear() + "-00001", "FUL-" + new Date().getUTCFullYear() + "-00002", "FUL-" + new Date().getUTCFullYear() + "-00003"]);

    const sk = await t((c, x) => importSkus(c, x, s.merchant, "code,name,barcode\nCAP,Cap,6291000000099\nCAP,Cap again,\nmug,Mug dup,\nBAD,,\n"));
    expect(sk).toMatchObject({ created: 1 }); expect(sk.duplicates.sort()).toEqual(["CAP", "MUG"]); expect(sk.rejected).toHaveLength(1);
    await clean();
  });

  it("enforces the monthly fulfilment-order allowance (and a duplicate reference is not a second order)", async () => {
    const s = await shop();
    await stockIn(s, "MUG", 20, s.A);
    await db.system((c) => c.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES ($1,'fulfilment_orders_per_month',2,'test')`, [s.t.tenantId]));
    await place(s, "MUG, 1", { external_ref: "same" });
    await expect(place(s, "MUG, 1", { external_ref: "same" })).rejects.toThrow(/already exists as FUL-/);
    await place(s, "MUG, 1");
    await expect(place(s, "MUG, 1")).rejects.toThrow(/limit reached for fulfilment_orders_per_month/);
    expect((await T(s)((c) => listFulfilOrders(c))).length).toBe(2);                    // the refused order left nothing behind
    await clean();
  });

  it("tenants cannot see or act on each other's stock and orders; roles are enforced", async () => {
    const a = await shop(), b = await shop();
    await stockIn(a, "TEE-M", 3, a.A);
    const o = await place(a, "TEE-M, 1");
    await expect(T(b)((c) => getFulfilOrder(c, o.id))).rejects.toThrow(/not found/i);
    await expect(T(b)((c, x) => pickOrder(c, x, o.id))).rejects.toThrow(/not found/i);
    await expect(T(b)((c, x) => transferStock(c, x, { sku_id: a.tee, from_location: a.A, to_location: b.A, qty: 1 }))).rejects.toThrow();
    expect(await T(b)((c) => stockOverview(c))).toHaveLength(2);                        // only its own two SKUs
    expect((await T(b)((c) => listFulfilOrders(c)))).toHaveLength(0);

    const sales = ctxFor(a.t.userId, a.t.tenantId, ["sales"]);
    await expect(db.tenant(a.t.tenantId, (c) => pickOrder(c, sales, o.id))).rejects.toThrow(/does not allow/);
    await expect(db.tenant(a.t.tenantId, (c) => createInbound(c, sales, { party_id: a.merchant, lines: "MUG, 1" }))).rejects.toThrow(/does not allow/);
    const ro = { ...a.t.ctx, readOnly: true };
    await expect(db.tenant(a.t.tenantId, (c) => allocateWaiting(c, ro))).rejects.toThrow(/read-only/);
    await expect(db.tenant(a.t.tenantId, (c) => receiveInbound(c, ro, "00000000-0000-0000-0000-000000000000", {}))).rejects.toThrow(/read-only/);
    await clean();
  });

  it("a restricted subscription is read-only for fulfilment too", async () => {
    const s = await shop();
    await db.system((c) => c.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`, [s.t.tenantId]));
    await expect(place(s, "MUG, 1")).rejects.toThrow(/read-only/);
    await expect(T(s)((c, x) => createInbound(c, x, { party_id: s.merchant, lines: "MUG, 1" }))).rejects.toThrow(/read-only/);
    expect(await T(s)((c) => stockOverview(c))).toHaveLength(2);                        // reading still works
  });
});
