import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Db, Conn } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { allocateOutbound, confirmPick, createInbound, createLocation, createOutbound, createSku, createWarehouse, dispatchOutbound, getInbound, listStock, receiveLine } from "../src/ops/warehouse.js";
import { approveOwnerTerms, exposureReport, setLocationBonded, setOwnerPolicy, setSkuDeclaredValue } from "../src/ops/wh-terms.js";
import { closeWhReturn, createWhReturn, getWhReturn, receiveReturnLine, resolveReturnReceipt } from "../src/ops/wh-returns.js";
import { resolveScan, rfMove, zpl } from "../src/ops/wh-labels.js";
import { uploadDocument } from "../src/ops/documents.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
async function staff(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`cp-${role}-${++n}-${Date.now()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
async function site() {
  const t = await newTenant(db, undefined, ["contract-warehouse-3pl"]);
  const r = await db.tenant(t.tenantId, async (c) => {
    const acme = await createParty(c, t.ctx, { kind: "customer", name: "Acme Foods" });
    const wh = await createWarehouse(c, t.ctx, { code: "JA1", name: "Jebel Ali 1" });
    const loc = (code: string, kind = "storage") => createLocation(c, t.ctx, { warehouse_id: wh, code, kind });
    const L = { rec: await loc("REC", "receiving"), a1: await loc("A-01"), a2: await loc("A-02"), q: await loc("QRN", "quarantine"), b1: await loc("BND-1"), bq: await loc("BND-Q", "quarantine") };
    const rice = await createSku(c, t.ctx, { owner_id: acme, code: "RICE", description: "Rice 5kg" });
    const doc = await uploadDocument(c, t.ctx, { kind: "other", title: "Executed terms", issuer: "Customer", filename: "t.pdf", data: Buffer.from("%PDF-1.4 terms") });
    return { acme, wh, L, rice, doc };
  });
  return { t, ...r };
}
type S = Awaited<ReturnType<typeof site>>;
const run = <T>(s: S, fn: (c: Conn) => Promise<T>) => db.tenant(s.t.tenantId, fn);
async function stockIn(s: S, qty: number, loc: string, extra: Record<string, any> = {}) {
  return run(s, async (c) => {
    const i = await createInbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, lines: [{ sku_id: s.rice, qty }] });
    const line = (await getInbound(c, i.id)).lines[0];
    return receiveLine(c, s.t.ctx, line.id, { qty, location_id: loc, ...extra });
  });
}
const onHand = async (s: S, loc: string) => (await run(s, (c) => listStock(c, {}))).filter((r: any) => r.location_id === loc).reduce((a: number, r: any) => a + Number(r.qty_on_hand), 0);
const order = (s: S, qty: number) => run(s, (c) => createOutbound(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, ship_to: "Dubai", lines: [{ sku_id: s.rice, qty }] }));
const clean = async () => expect(await verifyInvariants(db)).toEqual([]);

describe("backorder policy", () => {
  it("closes the remainder by default, or carries it on a child order that reserves itself when stock arrives", async () => {
    const s = await site();
    await stockIn(s, 3, s.L.a1);
    const o1 = await order(s, 5);
    await run(s, async (c) => { await allocateOutbound(c, s.t.ctx, o1.id, { allowPartial: true }); await confirmPick(c, s.t.ctx, o1.id, {}); });
    expect((await run(s, (c) => dispatchOutbound(c, s.t.ctx, o1.id))).backorder).toBeNull();
    await run(s, (c) => setOwnerPolicy(c, s.t.ctx, s.acme, { backorder_policy: "backorder" }));
    await stockIn(s, 3, s.L.a1);
    const o2 = await order(s, 5);
    await run(s, async (c) => { await allocateOutbound(c, s.t.ctx, o2.id, { allowPartial: true }); await confirmPick(c, s.t.ctx, o2.id, {}); });
    const d = await run(s, (c) => dispatchOutbound(c, s.t.ctx, o2.id));
    expect(d.backorder).toBeTruthy();
    const bo = (await run(s, (c) => c.query<any>(`SELECT o.status, o.parent_id, l.qty_ordered FROM wh_outbound o JOIN wh_outbound_lines l ON l.outbound_id=o.id WHERE o.id=$1`, [d.backorder!.id]))).rows[0];
    expect(bo).toMatchObject({ status: "new", parent_id: o2.id });
    expect(Number(bo.qty_ordered)).toBe(2);
    expect((await stockIn(s, 1, s.L.a1)).backordersAllocated).toBe(0);         // 1 unit is not enough: all-or-nothing
    expect((await stockIn(s, 5, s.L.a1)).backordersAllocated).toBe(1);
    expect((await run(s, (c) => c.query<any>(`SELECT status FROM wh_outbound WHERE id=$1`, [d.backorder!.id]))).rows[0].status).toBe("allocated");
    await clean();
  });
});

describe("customer returns", () => {
  it("are refused without policy, land in quarantine, and are restocked or disposed only by an approver", async () => {
    const s = await site();
    const approver = await staff(s.t.tenantId, "coordinator"), clerk = await staff(s.t.tenantId, "warehouse");
    await stockIn(s, 10, s.L.a1);
    const o = await order(s, 4);
    await run(s, async (c) => { await allocateOutbound(c, s.t.ctx, o.id); await confirmPick(c, s.t.ctx, o.id, {}); await dispatchOutbound(c, s.t.ctx, o.id); });
    await expect(run(s, (c) => createWhReturn(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, outbound_id: o.id, lines: [{ sku_id: s.rice, qty: 2 }] }))).rejects.toThrow(/does not accept returns/);
    await run(s, (c) => setOwnerPolicy(c, s.t.ctx, s.acme, { returns_policy: "quarantine_inspect" }));
    await expect(run(s, (c) => createWhReturn(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, outbound_id: o.id, lines: [{ sku_id: s.rice, qty: 5 }] }))).rejects.toThrow(/4 dispatched/);
    const r = await run(s, (c) => createWhReturn(c, s.t.ctx, { owner_id: s.acme, warehouse_id: s.wh, outbound_id: o.id, lines: [{ sku_id: s.rice, qty: 3 }] }));
    const line = (await run(s, (c) => getWhReturn(c, r.id))).lines[0];
    await expect(run(s, (c) => receiveReturnLine(c, clerk, line.id, { qty: 3, location_id: s.L.a1 }))).rejects.toThrow(/quarantine/);
    await run(s, (c) => receiveReturnLine(c, clerk, line.id, { qty: 3, location_id: s.L.q }));
    expect(await onHand(s, s.L.q)).toBe(3);
    await expect(run(s, (c) => closeWhReturn(c, s.t.ctx, r.id))).rejects.toThrow(/awaiting an inspection/);
    const rc = (await run(s, (c) => getWhReturn(c, r.id))).receipts[0];
    await expect(run(s, (c) => resolveReturnReceipt(c, clerk, rc.id, { action: "restock", qty: 2, to_location_id: s.L.a2 }))).rejects.toThrow();     // clerks cannot release quarantine
    await run(s, (c) => resolveReturnReceipt(c, approver, rc.id, { action: "restock", qty: 2, to_location_id: s.L.a2 }));
    await expect(run(s, (c) => resolveReturnReceipt(c, approver, rc.id, { action: "dispose", qty: 1 }))).rejects.toThrow(/Reason/);
    await run(s, (c) => resolveReturnReceipt(c, approver, rc.id, { action: "dispose", qty: 1, reason: "Water damaged" }));
    expect(await onHand(s, s.L.a2)).toBe(2);
    expect(await onHand(s, s.L.q)).toBe(0);
    await run(s, (c) => closeWhReturn(c, s.t.ctx, r.id));
    await clean();
  });
});

describe("bonded and liability terms", () => {
  const terms = (s: S, over: Record<string, any> = {}) => ({ owner_id: s.acme, valid_from: "2020-01-01", valid_until: "2099-12-31", bonded: true, liability_cap: "1000", document_id: s.doc, reference: randomUUID(), reviewer: "Counsel", scope: "Bonded bay BND-1/BND-Q; cover with Insurer X", ...over });
  it("keeps bonded goods in bonded locations, enforces the declared-value cap and demands release evidence", async () => {
    const s = await site();
    await run(s, async (c) => { await setLocationBonded(c, s.t.ctx, s.L.b1, true); await setLocationBonded(c, s.t.ctx, s.L.bq, true); });
    await expect(stockIn(s, 1, s.L.b1)).rejects.toThrow(/no approved bonded-storage terms/);
    const t = terms(s);
    await expect(run(s, (c) => approveOwnerTerms(c, ctxFor(s.t.userId, s.t.tenantId, ["warehouse"]), t))).rejects.toThrow();
    const id = await run(s, (c) => approveOwnerTerms(c, s.t.ctx, t));
    expect(await run(s, (c) => approveOwnerTerms(c, s.t.ctx, t))).toBe(id);
    await expect(run(s, (c) => approveOwnerTerms(c, s.t.ctx, { ...t, liability_cap: "2000" }))).rejects.toThrow(/different terms/);
    await expect(run(s, (c) => approveOwnerTerms(c, s.t.ctx, terms(s)))).rejects.toThrow(/already cover/);
    await expect(db.query(`UPDATE wh_owner_terms SET liability_cap_minor=1 WHERE id=$1`, [id])).rejects.toThrow(/immutable/);
    await expect(stockIn(s, 1, s.L.a1)).rejects.toThrow(/must stay in bonded/);
    await expect(stockIn(s, 1, s.L.b1)).rejects.toThrow(/declared unit value/);
    await run(s, (c) => setSkuDeclaredValue(c, s.t.ctx, s.rice, "40"));                      // AED 40 per unit, cap AED 1,000 → 25 units
    await stockIn(s, 20, s.L.b1);
    await expect(stockIn(s, 6, s.L.b1)).rejects.toThrow(/liability cap/);
    await stockIn(s, 5, s.L.b1);
    const exp = (await run(s, (c) => exposureReport(c)))[0];
    expect(exp).toMatchObject({ declared_minor: 100000, cap_minor: 100000, bonded: true, used_pct: 100 });
    const o = await order(s, 5);
    await run(s, async (c) => { await allocateOutbound(c, s.t.ctx, o.id); await confirmPick(c, s.t.ctx, o.id, {}); });
    await expect(run(s, (c) => dispatchOutbound(c, s.t.ctx, o.id))).rejects.toThrow(/release document/);
    await run(s, (c) => dispatchOutbound(c, s.t.ctx, o.id, { release_document_id: s.doc }));
    await expect(run(s, (c) => setLocationBonded(c, s.t.ctx, s.L.b1, false))).rejects.toThrow(/holds stock/);
    await clean();
  });
});

describe("scanner, label and handheld support", () => {
  it("builds safe ZPL, resolves scanned codes without guessing and runs a handheld move idempotently", async () => {
    const s = await site();
    await stockIn(s, 6, s.L.a1);
    const z = zpl({ code: "A-01", title: "Bin ^XZ A-01", subtitle: "Aisle~1" }, 3);
    expect(z).toContain("^PQ3");
    expect(z).toContain("^BCN");
    expect(z.match(/\^XZ/g)!.length).toBe(1);                                  // injected control sequences are stripped
    expect(() => zpl({ code: "^~", title: "x" })).toThrow(/needs a code/);
    const hits = await run(s, (c) => resolveScan(c, s.t.ctx, "rice"));
    expect(hits.map((h) => h.kind)).toEqual(["sku"]);
    expect((await run(s, (c) => resolveScan(c, s.t.ctx, "a-01")))[0]).toMatchObject({ kind: "location", code: "A-01" });
    expect(await run(s, (c) => resolveScan(c, s.t.ctx, "NOPE"))).toEqual([]);
    const ref = `rf-${randomUUID()}`;
    await run(s, (c) => rfMove(c, s.t.ctx, { from_code: "a-01", item: "rice", qty: "2", to_code: "A-02", client_ref: ref }));
    expect((await run(s, (c) => rfMove(c, s.t.ctx, { from_code: "a-01", item: "rice", qty: "2", to_code: "A-02", client_ref: ref }))).duplicate).toBe(true);
    expect(await onHand(s, s.L.a2)).toBe(2);
    await expect(run(s, (c) => rfMove(c, s.t.ctx, { from_code: "A-01", item: "ghost", qty: "1", to_code: "A-02" }))).rejects.toThrow(/No GHOST/);
    await expect(run(s, (c) => rfMove(c, s.t.ctx, { from_code: "ZZZ", item: "rice", qty: "1", to_code: "A-02" }))).rejects.toThrow(/Unknown source/);
    await clean();
  });
});
