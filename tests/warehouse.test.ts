import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import type { Ctx } from "../src/lib/perms.js";
import { createParty } from "../src/ops/crm.js";
import {
  accrueStorage, addFoundLine, allocateOutbound, billingSummary, cancelOutbound, closeInbound, confirmPick, createInbound, createLocation, createOutbound,
  createSku, createWarehouse, decideCountLine, dispatchOutbound, dubaiDay, getCount, getInbound, getOutbound, invoiceOwner, listMovements, listStock,
  moveStock, receiveLine, recordCount, setRate, startCount, submitCount, warehouseOverview,
} from "../src/ops/warehouse.js";
import { getInvoice, voidInvoice } from "../src/ops/finance.js";
import { verifyInvariants } from "../src/platform/invariants.js";
import { currentPlans } from "../src/platform/catalog.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

let n = 0;
/** A real user + membership in the tenant, so created_by / counted_by foreign keys are honest. */
async function staff(tenantId: string, role: string): Promise<Ctx> {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`wh-${role}-${++n}-${Date.now()}@example.com`, `${role} ${n}`]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}

async function site() {
  const t = await newTenant(db, undefined, ["contract-warehouse-3pl"]);
  const r = await db.tenant(t.tenantId, async (c) => {
    const acme = await createParty(c, t.ctx, { kind: "customer", name: "Acme Foods" });
    const zed = await createParty(c, t.ctx, { kind: "customer", name: "Zed Retail" });
    const wh = await createWarehouse(c, t.ctx, { code: "JA1", name: "Jebel Ali 1" });
    const wh2 = await createWarehouse(c, t.ctx, { code: "SH2", name: "Sharjah 2" });
    const loc = (code: string, kind = "storage", cap?: number, w = wh) => createLocation(c, t.ctx, { warehouse_id: w, code, kind, capacity_units: cap });
    const L = { rec: await loc("REC", "receiving"), a1: await loc("A-01"), a2: await loc("A-02"), small: await loc("S-01", "storage", 10), qrn: await loc("QRN", "quarantine"), other: await loc("X-01", "storage", undefined, wh2) };
    const S = {
      rice: await createSku(c, t.ctx, { owner_id: acme, code: "rice-5", description: "Rice 5kg", uom: "carton" }),
      oil: await createSku(c, t.ctx, { owner_id: acme, code: "OIL-1", description: "Oil 1L" }),
      tee: await createSku(c, t.ctx, { owner_id: zed, code: "TEE-M", description: "T-shirt M" }),
    };
    return { acme, zed, wh, wh2, L, S };
  });
  return { t, ...r };
}
type Site = Awaited<ReturnType<typeof site>>;
const run = <T>(s: Site, fn: (c: any) => Promise<T>) => db.tenant(s.t.tenantId, fn);

/** Expect a delivery of one SKU and receive it in full into a location. */
async function stockIn(s: Site, owner: string, sku: string, qty: number, location: string, extra: Record<string, any> = {}) {
  return run(s, async (c) => {
    const i = await createInbound(c, s.t.ctx, { owner_id: owner, warehouse_id: s.wh, lines: [{ sku_id: sku, qty }] });
    const line = (await getInbound(c, i.id)).lines[0];
    await receiveLine(c, s.t.ctx, line.id, { qty, location_id: location, ...extra });
    await closeInbound(c, s.t.ctx, i.id);
    return i;
  });
}
const free = async (s: Site, sku: string) => (await run(s, (c) => listStock(c, {}))).filter((r: any) => r.sku_id === sku).map((r: any) => ({ loc: r.loc_code, on: Number(r.qty_on_hand), res: Number(r.qty_reserved) }));
const onHand = async (s: Site, sku: string, loc: string) => (await free(s, sku)).find((r) => r.loc === loc)?.on ?? 0;
const noViolations = async () => expect(await verifyInvariants(db)).toEqual([]);

describe("owner-separated custody", () => {
  it("keeps every customer's stock apart in code and in the database", async () => {
    const s = await site();
    await expect(run(s, (c) => createInbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, lines: [{ sku_id: s.S.tee, qty: 5 }] }))).rejects.toThrow(/different owner/);
    await expect(run(s, (c) => createSku(c, s.t.ctx, { owner_id: s.acme, code: "RICE-5", description: "dup" }))).rejects.toThrow(/already has a SKU/);
    // even a buggy caller cannot put Zed's SKU into Acme's stock: composite foreign key
    await expect(db.system((c) => c.query(`INSERT INTO wh_stock(tenant_id,owner_id,sku_id,location_id) VALUES ($1,$2,$3,$4)`, [s.t.tenantId, s.acme, s.S.tee, s.L.a1]))).rejects.toThrow(/foreign key|violates/i);
    await stockIn(s, s.acme, s.S.rice, 10, s.L.a1);
    await stockIn(s, s.zed, s.S.tee, 7, s.L.a1);                       // same location, different owners
    const rows = await run(s, (c) => listStock(c, {}));
    expect(rows.map((r: any) => `${r.owner_name}:${r.sku_code}:${Number(r.qty_on_hand)}`).sort()).toEqual(["Acme Foods:RICE-5:10", "Zed Retail:TEE-M:7"]);
    expect((await run(s, (c) => listStock(c, { ownerId: s.zed }))).length).toBe(1);
    // another tenant sees nothing of it
    const other = await site();
    expect((await run(other, (c) => listStock(c, {}))).length).toBe(0);
    expect((await db.tenant(other.t.tenantId, (c) => c.query<any>(`SELECT * FROM wh_movements`))).rows.length).toBe(0);
    await noViolations();
  });
});

describe("receiving", () => {
  it("guards over-receipt, damaged goods, locations and closed notices; records variances", async () => {
    const s = await site();
    const i = await run(s, (c) => createInbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, customer_ref: "PO-7", lines: [{ sku_id: s.S.rice, qty: 10 }, { sku_id: s.S.oil, qty: 4 }] }));
    const d = await run(s, (c) => getInbound(c, i.id));
    const rice = d.lines.find((l: any) => l.sku_code === "RICE-5"), oil = d.lines.find((l: any) => l.sku_code === "OIL-1");
    const rcv = (line: string, f: Record<string, any>) => run(s, (c) => receiveLine(c, s.t.ctx, line, f));

    await expect(rcv(rice.id, { qty: 0, location_id: s.L.rec })).rejects.toThrow(/above zero/);
    await expect(rcv(rice.id, { qty: 11, location_id: s.L.rec })).rejects.toThrow(/exceed the 10 expected/);
    await expect(rcv(rice.id, { qty: 2, location_id: s.L.other })).rejects.toThrow(/different warehouse/);
    await expect(rcv(rice.id, { qty: 2, location_id: s.L.rec, condition: "damaged" })).rejects.toThrow(/quarantine location/);
    await expect(rcv(rice.id, { qty: 2, location_id: s.L.qrn })).rejects.toThrow(/not received into quarantine/);
    await expect(rcv(rice.id, { qty: 1.2345, location_id: s.L.rec })).rejects.toThrow(/3 decimal/);
    await expect(run(s, (c) => closeInbound(c, s.t.ctx, i.id))).rejects.toThrow(/Nothing has been received/);

    await rcv(rice.id, { qty: 6, location_id: s.L.rec, lot: "l-001" });
    await rcv(rice.id, { qty: 2, location_id: s.L.qrn, condition: "damaged" });
    await rcv(rice.id, { qty: 3, location_id: s.L.rec, lot: "l-001", accept_over: "1" });          // 11 vs 10, explicitly accepted
    await rcv(oil.id, { qty: 3, location_id: s.L.rec });
    const closed = await run(s, (c) => closeInbound(c, s.t.ctx, i.id));
    expect(closed.variances).toEqual(expect.arrayContaining([
      { sku: "RICE-5", expected: 10, received: 11, damaged: 2 }, { sku: "OIL-1", expected: 4, received: 3, damaged: 0 }]));
    await expect(rcv(oil.id, { qty: 1, location_id: s.L.rec })).rejects.toThrow(/no longer accepts receipts/);

    const st = await run(s, (c) => listStock(c, { ownerId: s.acme }));
    const at = (loc: string, sku: string) => Number(st.find((r: any) => r.loc_code === loc && r.sku_code === sku)?.qty_on_hand ?? 0);
    expect(at("REC", "RICE-5")).toBe(9); expect(at("QRN", "RICE-5")).toBe(2); expect(at("REC", "OIL-1")).toBe(3);
    expect(st.find((r: any) => r.lot === "L-001").qty_on_hand).toBeDefined();                          // lots are normalised
    await noViolations();
  });

  it("a scanner retry or double-submit posts exactly once, even concurrently", async () => {
    const s = await site();
    const i = await run(s, (c) => createInbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, lines: [{ sku_id: s.S.rice, qty: 100 }] }));
    const line = (await run(s, (c) => getInbound(c, i.id))).lines[0];
    const once = () => run(s, (c) => receiveLine(c, s.t.ctx, line.id, { qty: 5, location_id: s.L.rec, client_ref: "scan-0001-abcd" }));
    const out = await Promise.all([once(), once(), once()]);
    expect(out.filter((r) => r.duplicate).length).toBe(2);
    expect(await onHand(s, s.S.rice, "REC")).toBe(5);
    expect(Number((await run(s, (c) => getInbound(c, i.id))).lines[0].qty_received)).toBe(5);
    await expect(run(s, (c) => receiveLine(c, s.t.ctx, line.id, { qty: 5, location_id: s.L.rec, client_ref: "no" }))).rejects.toThrow(/reference must be/);
    expect((await db.tenant(s.t.tenantId, (c) => c.query<any>(`SELECT count(*)::int n FROM wh_charges`))).rows[0].n).toBe(1);   // billed once too

    // the retry that matters most: a receipt that completed its line, sent again, is a repeat — not an "over-receipt" error
    const i2 = await run(s, (c) => createInbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, lines: [{ sku_id: s.S.oil, qty: 5 }] }));
    const l2 = (await run(s, (c) => getInbound(c, i2.id))).lines[0];
    const full = () => run(s, (c) => receiveLine(c, s.t.ctx, l2.id, { qty: 5, location_id: s.L.rec, client_ref: "scan-full-0001" }));
    expect((await full()).duplicate).toBe(false);
    expect((await full()).duplicate).toBe(true);
    expect(await onHand(s, s.S.oil, "REC")).toBe(5);
    // …but a *different* scan of the same size is a genuine over-receipt
    await expect(run(s, (c) => receiveLine(c, s.t.ctx, l2.id, { qty: 5, location_id: s.L.rec, client_ref: "scan-full-0002" }))).rejects.toThrow(/exceed the 5 expected/);

    // a moved-twice scan likewise moves once
    const st = (await run(s, (c) => listStock(c, {}))).find((r: any) => r.sku_code === "OIL-1");
    const mv = () => run(s, (c) => moveStock(c, s.t.ctx, { stock_id: st.id, to_location_id: s.L.a1, qty: 5, client_ref: "move-all-0001" }));
    expect((await mv()).duplicate).toBe(false);
    expect((await mv()).duplicate).toBe(true);
    expect([await onHand(s, s.S.oil, "REC"), await onHand(s, s.S.oil, "A-01")]).toEqual([0, 5]);
    await noViolations();
  });

  it("enforces location capacity and moves; leaving quarantine needs release authority", async () => {
    const s = await site();
    await stockIn(s, s.acme, s.S.rice, 8, s.L.small);
    await expect(stockIn(s, s.acme, s.S.oil, 5, s.L.small)).rejects.toThrow(/exceed its capacity of 10 units \(8 already/);
    await stockIn(s, s.acme, s.S.rice, 6, s.L.qrn, { condition: "damaged" });
    const rows = await run(s, (c) => listStock(c, {}));
    const small = rows.find((r: any) => r.loc_code === "S-01"), q = rows.find((r: any) => r.loc_code === "QRN");

    await run(s, (c) => moveStock(c, s.t.ctx, { stock_id: small.id, to_location_id: s.L.a1, qty: 3 }));
    expect([await onHand(s, s.S.rice, "S-01"), await onHand(s, s.S.rice, "A-01")]).toEqual([5, 3]);
    await expect(run(s, (c) => moveStock(c, s.t.ctx, { stock_id: small.id, to_location_id: s.L.other, qty: 1 }))).rejects.toThrow(/inside one warehouse/);
    await expect(run(s, (c) => moveStock(c, s.t.ctx, { stock_id: small.id, to_location_id: s.L.a1, qty: 99 }))).rejects.toThrow(/Only 5 is free/);

    const operator = await staff(s.t.tenantId, "warehouse");
    await expect(run(s, (c) => moveStock(c, operator, { stock_id: q.id, to_location_id: s.L.a2, qty: 2 }))).rejects.toThrow(/does not allow this action \(wh\.approve\)/);
    await run(s, (c) => moveStock(c, s.t.ctx, { stock_id: q.id, to_location_id: s.L.a2, qty: 2 }));      // owner holds release authority
    expect(await onHand(s, s.S.rice, "A-02")).toBe(2);
    // the two legs of every transfer cancel out; FIFO age travels with the stock
    const mv = await run(s, (c) => listMovements(c, { ownerId: s.acme }));
    const groups = new Map<string, number>();
    for (const m of mv.filter((x: any) => x.group_id)) groups.set(m.group_id, (groups.get(m.group_id) ?? 0) + Number(m.qty_delta));
    expect(groups.size).toBe(2); expect([...groups.values()].every((v) => v === 0)).toBe(true);
    await noViolations();
  });
});

describe("dispatch: allocate (FIFO) → pick → dispatch", () => {
  it("allocates oldest first, all-or-nothing, protects reservations and ships exactly what was picked", async () => {
    const s = await site();
    await stockIn(s, s.acme, s.S.rice, 10, s.L.a1);                    // older
    await stockIn(s, s.acme, s.S.rice, 10, s.L.a2);                    // newer
    await stockIn(s, s.acme, s.S.rice, 4, s.L.qrn, { condition: "damaged" });   // never allocated
    await stockIn(s, s.acme, s.S.rice, 9, s.L.rec);                    // receiving dock: not pickable until put away
    const mk = (qty: number, o: Record<string, any> = {}) => run(s, (c) => createOutbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, ship_to: "Dubai Marina", lines: [{ sku_id: s.S.rice, qty }], ...o }));

    const o1 = await mk(12);
    const a = await run(s, (c) => allocateOutbound(c, s.t.ctx, o1.id));
    expect(a.short).toEqual([]);
    expect(await free(s, s.S.rice)).toEqual(expect.arrayContaining([{ loc: "A-01", on: 10, res: 10 }, { loc: "A-02", on: 10, res: 2 }, { loc: "QRN", on: 4, res: 0 }]));

    const o2 = await mk(10);                                            // only 8 free in storage
    await expect(run(s, (c) => allocateOutbound(c, s.t.ctx, o2.id))).rejects.toThrow(/short by 2\. Nothing was reserved/);
    expect((await free(s, s.S.rice)).find((r) => r.loc === "A-02")!.res).toBe(2);
    const part = await run(s, (c) => allocateOutbound(c, s.t.ctx, o2.id, { allowPartial: true }));
    expect(part.short).toEqual(["RICE-5 short by 2"]);

    // reserved stock can neither be moved nor adjusted away
    const a2row = (await run(s, (c) => listStock(c, {}))).find((r: any) => r.loc_code === "A-02");
    await expect(run(s, (c) => moveStock(c, s.t.ctx, { stock_id: a2row.id, to_location_id: s.L.a1, qty: 1 }))).rejects.toThrow(/Only 0 is free/);

    // short pick: 1 of the 8 units reserved on A-02 for o2 is not on the shelf
    const det = await run(s, (c) => getOutbound(c, o2.id));
    const picks = Object.fromEntries(det.allocations.map((x: any) => [x.id, x.qty]));
    const shortAlloc = det.allocations.find((x: any) => x.loc_code === "A-02")!;
    await expect(run(s, (c) => confirmPick(c, s.t.ctx, o2.id, { ...picks, [shortAlloc.id]: 99 }))).rejects.toThrow(/Cannot pick more than/);
    const pr = await run(s, (c) => confirmPick(c, s.t.ctx, o2.id, { ...picks, [shortAlloc.id]: 7 }));
    expect(pr.short).toBe(true);
    expect((await free(s, s.S.rice)).find((r) => r.loc === "A-02")!.res).toBe(2 + 7);     // o1's 2 + o2's 7; the missing unit is released at once
    await expect(run(s, (c) => dispatchOutbound(c, s.t.ctx, o1.id))).rejects.toThrow(/only picked orders/);
    await run(s, (c) => dispatchOutbound(c, s.t.ctx, o2.id, { carrier_ref: "DN-1001" }));
    await expect(run(s, (c) => dispatchOutbound(c, s.t.ctx, o2.id))).rejects.toThrow(/only picked orders/);
    expect(await onHand(s, s.S.rice, "A-01")).toBe(10);                // o1's reservation still protects the oldest row
    expect(await onHand(s, s.S.rice, "A-02")).toBe(3);                 // 10 − 7 shipped
    const d2 = await run(s, (c) => getOutbound(c, o2.id));
    expect(d2.order.status).toBe("dispatched");
    expect(d2.lines[0]).toMatchObject({ qty_ordered: "10.000", qty_allocated: "8.000" });
    expect(Number(d2.lines[0].qty_picked)).toBe(7); expect(Number(d2.lines[0].qty_dispatched)).toBe(7);
    expect((await run(s, (c) => listMovements(c, { ownerId: s.acme }))).filter((m: any) => m.kind === "dispatch").map((m: any) => Number(m.qty_delta))).toEqual([-7]);
    await noViolations();

    // cancelling releases what it reserved; a shipped order cannot be cancelled
    await run(s, (c) => cancelOutbound(c, s.t.ctx, o1.id));
    expect((await free(s, s.S.rice)).every((r) => r.res === 0)).toBe(true);
    await expect(run(s, (c) => cancelOutbound(c, s.t.ctx, o2.id))).rejects.toThrow(/cannot be cancelled/);
    await noViolations();
  });

  it("will not allocate another customer's stock", async () => {
    const s = await site();
    await stockIn(s, s.zed, s.S.tee, 50, s.L.a1);
    const o = await run(s, (c) => createOutbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, ship_to: "X", lines: [{ sku_id: s.S.rice, qty: 1 }] }));
    await expect(run(s, (c) => allocateOutbound(c, s.t.ctx, o.id))).rejects.toThrow(/RICE-5 short by 1\. Nothing was reserved/);   // Zed's 50 units are invisible to Acme's order
    await expect(run(s, (c) => createOutbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, ship_to: "X", lines: [{ sku_id: s.S.tee, qty: 1 }] }))).rejects.toThrow(/different owner/);
  });
});

describe("cycle counts (§30 warehouse count adjustment)", () => {
  it("blind count → independent approval → ledger adjustment; counters cannot approve themselves", async () => {
    const s = await site();
    await stockIn(s, s.acme, s.S.rice, 10, s.L.a1);
    const counter = await staff(s.t.tenantId, "coordinator");           // may count AND approve → independence rule must bite
    const operator = await staff(s.t.tenantId, "warehouse");
    const approver = await staff(s.t.tenantId, "finance");
    const k = await run(s, (c) => startCount(c, operator, { warehouse_id: s.wh, location_id: s.L.a1 }));
    await expect(run(s, (c) => startCount(c, operator, { warehouse_id: s.wh }))).rejects.toThrow(/already open/);
    const line = (await run(s, (c) => getCount(c, k.id))).lines[0];
    await expect(run(s, (c) => submitCount(c, operator, k.id))).rejects.toThrow(/have not been counted/);
    await run(s, (c) => recordCount(c, counter, line.id, 7));
    await run(s, (c) => submitCount(c, counter, k.id));
    expect((await run(s, (c) => getCount(c, k.id))).count.status).toBe("submitted");
    await expect(run(s, (c) => recordCount(c, counter, line.id, 8))).rejects.toThrow(/can no longer be changed/);

    await expect(run(s, (c) => decideCountLine(c, operator, line.id, true))).rejects.toThrow(/wh\.approve/);          // role cannot decide
    await expect(run(s, (c) => decideCountLine(c, counter, line.id, true))).rejects.toThrow(/person who counted/);     // nor can the counter
    expect(await onHand(s, s.S.rice, "A-01")).toBe(10);
    const r = await run(s, (c) => decideCountLine(c, approver, line.id, true));
    expect(r).toEqual({ outcome: "approved", delta: -3 });
    expect(await onHand(s, s.S.rice, "A-01")).toBe(7);
    expect((await run(s, (c) => getCount(c, k.id))).count.status).toBe("closed");
    await expect(run(s, (c) => decideCountLine(c, approver, line.id, true))).rejects.toThrow(/not submitted|decisions apply/);
    const adj = (await run(s, (c) => listMovements(c, { ownerId: s.acme }))).find((m: any) => m.kind === "adjust");
    expect(Number(adj.qty_delta)).toBe(-3); expect(adj.reason).toMatch(/Count CNT-/);
    await noViolations();
  });

  it("matching lines need no decision; rejecting leaves stock; found stock is added; adjustments cannot breach reservations", async () => {
    const s = await site();
    await stockIn(s, s.acme, s.S.rice, 10, s.L.a1);
    const op = await staff(s.t.tenantId, "warehouse"), approver = await staff(s.t.tenantId, "finance");

    const exact = await run(s, (c) => startCount(c, op, { warehouse_id: s.wh, location_id: s.L.a1 }));
    const l1 = (await run(s, (c) => getCount(c, exact.id))).lines[0];
    await run(s, (c) => recordCount(c, op, l1.id, 10));
    await run(s, (c) => submitCount(c, op, exact.id));
    expect((await run(s, (c) => getCount(c, exact.id))).count.status).toBe("closed");     // nothing to approve

    const rej = await run(s, (c) => startCount(c, op, { warehouse_id: s.wh, location_id: s.L.a1 }));
    const l2 = (await run(s, (c) => getCount(c, rej.id))).lines[0];
    await run(s, (c) => recordCount(c, op, l2.id, 4));
    await run(s, (c) => submitCount(c, op, rej.id));
    expect((await run(s, (c) => decideCountLine(c, approver, l2.id, false))).outcome).toBe("rejected");
    expect(await onHand(s, s.S.rice, "A-01")).toBe(10);

    // five units are promised to a dispatch order; a count of 3 cannot make that promise impossible
    const o = await run(s, (c) => createOutbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, ship_to: "X", lines: [{ sku_id: s.S.rice, qty: 5 }] }));
    await run(s, (c) => allocateOutbound(c, s.t.ctx, o.id));
    const low = await run(s, (c) => startCount(c, op, { warehouse_id: s.wh, location_id: s.L.a1 }));
    const l3 = (await run(s, (c) => getCount(c, low.id))).lines[0];
    await run(s, (c) => recordCount(c, op, l3.id, 3));
    await run(s, (c) => submitCount(c, op, low.id));
    await expect(run(s, (c) => decideCountLine(c, approver, l3.id, true))).rejects.toThrow(/reserved for outbound orders/);
    expect(await onHand(s, s.S.rice, "A-01")).toBe(10);
    await run(s, (c) => cancelOutbound(c, s.t.ctx, o.id));
    expect((await run(s, (c) => decideCountLine(c, approver, l3.id, true))).delta).toBe(-7);

    // stock found where the system had none
    const fnd = await run(s, (c) => startCount(c, op, { warehouse_id: s.wh, location_id: s.L.a2 }));     // empty location is allowed
    await run(s, (c) => addFoundLine(c, op, fnd.id, { sku_id: s.S.oil, location_id: s.L.a2, qty: 4, lot: "x9" }));
    await expect(run(s, (c) => addFoundLine(c, op, fnd.id, { sku_id: s.S.oil, location_id: s.L.a1, qty: 1 }))).rejects.toThrow(/outside this count/);
    await run(s, (c) => submitCount(c, op, fnd.id));
    const fl = (await run(s, (c) => getCount(c, fnd.id))).lines[0];
    expect((await run(s, (c) => decideCountLine(c, approver, fl.id, true))).delta).toBe(4);
    expect(await onHand(s, s.S.oil, "A-02")).toBe(4);
    await noViolations();
  });

  it("a count is not evidence if the stock moved after the sheet was cut: the line goes back for a recount", async () => {
    const s = await site();
    await stockIn(s, s.acme, s.S.rice, 10, s.L.a1);
    const op = await staff(s.t.tenantId, "warehouse"), approver = await staff(s.t.tenantId, "finance");
    const k = await run(s, (c) => startCount(c, op, { warehouse_id: s.wh, location_id: s.L.a1 }));
    const line = (await run(s, (c) => getCount(c, k.id))).lines[0];
    await run(s, (c) => recordCount(c, op, line.id, 9));
    // while the count is open, 4 units are shipped
    const o = await run(s, (c) => createOutbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, ship_to: "X", lines: [{ sku_id: s.S.rice, qty: 4 }] }));
    await run(s, (c) => allocateOutbound(c, s.t.ctx, o.id)); await run(s, (c) => confirmPick(c, s.t.ctx, o.id, {})); await run(s, (c) => dispatchOutbound(c, s.t.ctx, o.id));
    await run(s, (c) => submitCount(c, op, k.id));
    const r = await run(s, (c) => decideCountLine(c, approver, line.id, true));
    expect(r.outcome).toBe("stale");
    expect(await onHand(s, s.S.rice, "A-01")).toBe(6);                                     // nothing was adjusted
    const after = await run(s, (c) => getCount(c, k.id));
    expect(after.count.status).toBe("open");                                               // back with the counters
    expect(after.lines[0]).toMatchObject({ status: "pending", counted_qty: null }); expect(Number(after.lines[0].system_qty)).toBe(6);
    await run(s, (c) => recordCount(c, op, line.id, 6));
    await run(s, (c) => submitCount(c, op, k.id));
    expect((await run(s, (c) => getCount(c, k.id))).count.status).toBe("closed");
    await noViolations();
  });
});

describe("activity billing", () => {
  it("accrues once per event, prices unrated activity later, groups the invoice and releases charges on void", async () => {
    const s = await site();
    const fin = await staff(s.t.tenantId, "finance");
    await stockIn(s, s.acme, s.S.rice, 10, s.L.a1);                                       // 10 units in, no rate card yet
    await stockIn(s, s.zed, s.S.tee, 3, s.L.a1);
    const o = await run(s, (c) => createOutbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, ship_to: "X", lines: [{ sku_id: s.S.rice, qty: 4 }] }));
    await run(s, (c) => allocateOutbound(c, s.t.ctx, o.id)); await run(s, (c) => confirmPick(c, s.t.ctx, o.id, {})); await run(s, (c) => dispatchOutbound(c, s.t.ctx, o.id));

    const sum0 = await run(s, (c) => billingSummary(c));
    expect(sum0.find((r: any) => r.name === "Acme Foods")).toMatchObject({ rated_lines: 0, unrated_lines: 3 });   // in, out, order fee
    await expect(run(s, (c) => invoiceOwner(c, fin, s.acme))).rejects.toThrow(/No rated, unbilled/);
    const operator = await staff(s.t.tenantId, "warehouse");
    await expect(run(s, (c) => setRate(c, operator, { owner_id: s.acme, charge_type: "handling_in_unit", amount: "2" }))).rejects.toThrow(/wh\.bill/);
    await expect(run(s, (c) => invoiceOwner(c, operator, s.acme))).rejects.toThrow(/finance\.write/);

    const today = dubaiDay();
    expect((await run(s, (c) => setRate(c, fin, { owner_id: s.acme, charge_type: "handling_in_unit", amount: "2.00", effective_from: today }))).priced).toBe(1);
    await run(s, (c) => setRate(c, fin, { owner_id: s.acme, charge_type: "handling_out_unit", amount: "3.00" }));
    await run(s, (c) => setRate(c, fin, { owner_id: s.acme, charge_type: "outbound_order", amount: "25.00" }));
    await run(s, (c) => setRate(c, fin, { owner_id: s.acme, charge_type: "storage_unit_day", amount: "0.50" }));
    await expect(run(s, (c) => setRate(c, fin, { owner_id: s.acme, charge_type: "storage_unit_day", amount: "0.60", effective_from: "2020-01-01" }))).resolves.toBeDefined();   // new historic row is allowed…
    await expect(run(s, (c) => setRate(c, fin, { owner_id: s.acme, charge_type: "storage_unit_day", amount: "0.70", effective_from: "2020-01-01" }))).rejects.toThrow(/already in effect/);   // …editing it is not

    // storage for completed days, from the ledger: clock injected (today and tomorrow are complete two days from now)
    const later = new Date(Date.now() + 2 * 86400_000);
    const acc = await run(s, (c) => accrueStorage(c, fin, { now: later }));
    expect(acc.days).toBe(4);                                                              // 2 days × (Acme + Zed)
    expect((await run(s, (c) => accrueStorage(c, fin, { now: later }))).days).toBe(0);     // idempotent
    const tomorrow = dubaiDay(new Date(Date.now() + 86400_000));

    const inv = await run(s, (c) => invoiceOwner(c, fin, s.acme, { through: tomorrow }));
    const g = await run(s, (c) => getInvoice(c, inv.id));
    // in 10×2.00 + out 4×3.00 + order 25.00 + storage (6 units × 2 days = 12 × 0.50)
    expect(Number(g.inv.subtotal_minor)).toBe(2000 + 1200 + 2500 + 600);
    expect(Number(g.inv.tax_minor)).toBe(315); expect(g.inv.job_no).toBe("Warehouse activity");
    expect(g.lines.length).toBe(4);                                                        // grouped: not one line per day
    expect(g.lines.find((l: any) => /Storage/.test(l.description)).description).toMatch(/→/);
    await expect(run(s, (c) => invoiceOwner(c, fin, s.acme, { through: tomorrow }))).rejects.toThrow(/No rated, unbilled/);
    const zedSum = (await run(s, (c) => billingSummary(c))).find((r: any) => r.name === "Zed Retail");
    expect(zedSum.unrated_lines).toBeGreaterThan(0);                                       // Zed has no rates; nothing leaked into Acme's invoice
    await noViolations();

    await run(s, (c) => voidInvoice(c, s.t.ctx, inv.id, "wrong period"));
    const again = await run(s, (c) => invoiceOwner(c, fin, s.acme, { through: tomorrow }));
    expect(Number((await run(s, (c) => getInvoice(c, again.id))).inv.subtotal_minor)).toBe(6300);
    await noViolations();
  });

  it("warehouse orders are their own metered unit, idempotent per order", async () => {
    const s = await site();
    await db.system((c) => c.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES ($1,'wh_orders_per_month',2,'test')`, [s.t.tenantId]));
    await run(s, (c) => createInbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, lines: [{ sku_id: s.S.rice, qty: 1 }] }));
    await run(s, (c) => createOutbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, ship_to: "X", lines: [{ sku_id: s.S.rice, qty: 1 }] }));
    await expect(run(s, (c) => createInbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, lines: [{ sku_id: s.S.rice, qty: 1 }] }))).rejects.toThrow(/limit reached for wh_orders_per_month/);
    expect((await db.query<any>(`SELECT count(*)::int n FROM usage_counters WHERE tenant_id=$1 AND key='jobs_per_month'`, [s.t.tenantId])).rows[0].n).toBe(0);
    const plans = await db.system((c) => currentPlans(c));
    expect(plans.find((p) => p.plan_code === "starter")!.limits.wh_orders_per_month).toBe(150);
    expect((await db.query<any>(`SELECT version FROM plan_versions WHERE plan_code='starter' ORDER BY version`)).rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("authorisation and entitlement state", () => {
  it("a legacy plan version without the warehouse unit falls back to its jobs allowance (published versions are immutable)", async () => {
    const s = await site();
    await db.system((c) => c.query(`DELETE FROM entitlements WHERE tenant_id=$1 AND key='wh_orders_per_month'`, [s.t.tenantId]));   // as if bought on plan v2
    const { getLimit } = await import("../src/platform/entitlements.js");
    expect(await db.tenant(s.t.tenantId, (c) => getLimit(c, s.t.tenantId, "wh_orders_per_month"))).toBe(25);   // Free plan jobs_per_month
    await run(s, (c) => createInbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, lines: [{ sku_id: s.S.rice, qty: 1 }] }));   // still works
  });

  it("roles are enforced; restricted workspaces are read-only; the board reads", async () => {
    const s = await site();
    const sales = await staff(s.t.tenantId, "sales"), auditor = await staff(s.t.tenantId, "auditor");
    await expect(run(s, (c) => createInbound(c, sales, { owner_id: s.acme, warehouse_id: s.wh, lines: [{ sku_id: s.S.rice, qty: 1 }] }))).rejects.toThrow(/wh\.write/);
    await expect(run(s, (c) => createWarehouse(c, auditor, { code: "Z", name: "Z" }))).rejects.toThrow(/wh\.write/);
    await expect(run(s, (c) => createSku(c, s.t.ctx, { owner_id: s.wh, code: "BAD", description: "not a customer" }))).rejects.toThrow();
    await stockIn(s, s.acme, s.S.rice, 5, s.L.a1);
    const board = await run(s, (c) => warehouseOverview(c));
    expect(board).toMatchObject({ unitsOnHand: 5, inboundOpen: 0, outboundOpen: 0, quarantined: 0 });
    await db.system((c) => c.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`, [s.t.tenantId]));
    await expect(run(s, (c) => createOutbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, ship_to: "X", lines: [{ sku_id: s.S.rice, qty: 1 }] }))).rejects.toThrow(/read-only/);
    expect((await run(s, (c) => listStock(c, {}))).length).toBe(1);                      // still readable
  });

  it("the ledger is immutable", async () => {
    const s = await site();
    await stockIn(s, s.acme, s.S.rice, 5, s.L.a1);
    await expect(db.system((c) => c.query(`UPDATE wh_movements SET qty_delta=99`))).rejects.toThrow(/immutable|not allowed|cannot/i);
    await expect(db.system((c) => c.query(`DELETE FROM wh_movements`))).rejects.toThrow(/immutable|not allowed|cannot/i);
    // and a tampered balance is caught by the verifier
    await db.system((c) => c.query(`UPDATE wh_stock SET qty_on_hand = qty_on_hand + 1 WHERE tenant_id=$1`, [s.t.tenantId]));
    expect((await verifyInvariants(db)).map((v) => v.check)).toContain("stock balance = sum of its ledger movements");
    await db.system((c) => c.query(`UPDATE wh_stock SET qty_on_hand = qty_on_hand - 1 WHERE tenant_id=$1`, [s.t.tenantId]));
    await noViolations();
  });
});
