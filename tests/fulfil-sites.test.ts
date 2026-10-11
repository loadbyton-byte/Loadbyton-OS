import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { allocateOrder, createInbound, createLocation, createOrder, createSku, getInbound, receiveInbound, requestAdjustment, decideAdjustment } from "../src/ops/fulfilment.js";
import { assignLocationSite, cancelSiteTransfer, closeSiteTransferShort, createSite, dispatchSiteTransfer, getSiteTransfer, listSites, receiveSiteTransferLine, requestSiteTransfer, setSiteActive } from "../src/ops/fulfil-sites.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
const uid = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`;
async function staff(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`fs-${role}-${uid()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
async function setup() {
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const f = await db.tenant(t.tenantId, async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Multi Shop" });
    const dxb = await createSite(c, t.ctx, { code: "dxb", name: "Dubai" }), auh = await createSite(c, t.ctx, { code: "auh", name: "Abu Dhabi" });
    const D1 = await createLocation(c, t.ctx, { code: "d-1", site_id: dxb }), A1 = await createLocation(c, t.ctx, { code: "a-1", site_id: auh });
    const sku = await createSku(c, t.ctx, { party_id: merchant, code: "tee", name: "Tee" });
    const inb = await createInbound(c, t.ctx, { party_id: merchant, lines: "TEE, 10" });
    await receiveInbound(c, t.ctx, inb.id, { line_id: (await getInbound(c, inb.id)).lines[0].id, good: 10, damaged: 0, location_id: D1, token: `tok-${uid()}` });
    return { merchant, dxb, auh, D1, A1, sku };
  });
  return { t, ...f };
}
const T = (s: Awaited<ReturnType<typeof setup>>) => <R>(fn: (c: any, ctx: typeof s.t.ctx) => Promise<R>) => db.tenant(s.t.tenantId, (c) => fn(c, s.t.ctx));
const clean = async () => expect(await verifyInvariants(db)).toEqual([]);
const level = (s: any, loc: string) => db.tenant(s.t.tenantId, (c) => c.query<any>(`SELECT on_hand FROM stock_levels WHERE location_id=$1`, [loc])).then((r) => r.rows[0]?.on_hand ?? 0);

describe("multi-site fulfilment", () => {
  it("moves stock between sites through TRANSIT, two steps, and then orders pinned to the new site can allocate", async () => {
    const s = await setup();
    const x = await T(s)((c, ctx) => requestSiteTransfer(c, ctx, { from_site: s.dxb, to_site: s.auh, lines: [{ sku_id: s.sku, location_id: s.D1, qty: 6 }] }));
    expect(await level(s, s.D1)).toBe(10);                              // nothing moves on request
    await T(s)((c, ctx) => dispatchSiteTransfer(c, ctx, x.id));
    expect(await level(s, s.D1)).toBe(4);
    const line = (await T(s)((c) => getSiteTransfer(c, x.id))).lines[0];
    await expect(T(s)((c, ctx) => receiveSiteTransferLine(c, ctx, x.id, { line_id: line.id, qty: 4, location_id: s.D1 }))).rejects.toThrow(/destination/);
    await T(s)((c, ctx) => receiveSiteTransferLine(c, ctx, x.id, { line_id: line.id, qty: 4, location_id: s.A1 }));
    await expect(T(s)((c, ctx) => receiveSiteTransferLine(c, ctx, x.id, { line_id: line.id, qty: 3, location_id: s.A1 }))).rejects.toThrow(/still in transit/);
    const r = await T(s)((c, ctx) => receiveSiteTransferLine(c, ctx, x.id, { line_id: line.id, qty: 2, location_id: s.A1 }));
    expect(r.complete).toBe(true);
    expect(await level(s, s.A1)).toBe(6);
    const o = await T(s)((c, ctx) => createOrder(c, ctx, { party_id: s.merchant, external_ref: `O-${uid()}`, ship_to_name: "A", ship_to_address: "x", lines: "TEE, 5", site_id: s.auh }));
    expect((await db.tenant(s.t.tenantId, (c) => c.query<any>(`SELECT status FROM fulfil_orders WHERE id=$1`, [o.id]))).rows[0].status).toBe("allocated");
    const o2 = await T(s)((c, ctx) => createOrder(c, ctx, { party_id: s.merchant, external_ref: `O-${uid()}`, ship_to_name: "A", ship_to_address: "x", lines: "TEE, 3", site_id: s.auh }));
    expect((await db.tenant(s.t.tenantId, (c) => c.query<any>(`SELECT status FROM fulfil_orders WHERE id=$1`, [o2.id]))).rows[0].status).toBe("backordered");  // Dubai stock is not eligible
    await clean();
  });

  it("a shortfall needs a different approver, stays in TRANSIT, and is written off by a normal count adjustment", async () => {
    const s = await setup();
    const x = await T(s)((c, ctx) => requestSiteTransfer(c, ctx, { from_site: s.dxb, to_site: s.auh, lines: [{ sku_id: s.sku, location_id: s.D1, qty: 5 }] }));
    await T(s)((c, ctx) => dispatchSiteTransfer(c, ctx, x.id));
    const line = (await T(s)((c) => getSiteTransfer(c, x.id))).lines[0];
    await T(s)((c, ctx) => receiveSiteTransferLine(c, ctx, x.id, { line_id: line.id, qty: 3, location_id: s.A1 }));
    const fin1 = await staff(s.t.tenantId, "finance");
    await expect(db.tenant(s.t.tenantId, (c) => closeSiteTransferShort(c, fin1, x.id, "Two cartons lost by carrier"))).resolves.toEqual({ short: 2 });
    expect((await T(s)((c) => getSiteTransfer(c, x.id))).t.variance).toBe(true);
    const transit = (await db.tenant(s.t.tenantId, (c) => c.query<any>(`SELECT id,on_hand FROM stock_levels l JOIN wh_locations x ON x.id=l.location_id WHERE x.code='TRANSIT'`))).rows[0];
    expect(transit.on_hand).toBe(2);
    const adj = await T(s)((c, ctx) => requestAdjustment(c, ctx, { sku_id: s.sku, location_id: transit.id, counted_qty: 0, reason: "Carrier claim filed" }));
    const fin2 = await staff(s.t.tenantId, "finance");
    await db.tenant(s.t.tenantId, (c) => decideAdjustment(c, fin2, (adj as any).id, true));
    await clean();
  });

  it("cancel only before dispatch; sites with stock or open transfers cannot be disabled; bins holding stock cannot change site", async () => {
    const s = await setup();
    const x = await T(s)((c, ctx) => requestSiteTransfer(c, ctx, { from_site: s.dxb, to_site: s.auh, lines: [{ sku_id: s.sku, location_id: s.D1, qty: 1 }] }));
    await expect(T(s)((c, ctx) => setSiteActive(c, ctx, s.auh, false))).rejects.toThrow(/open transfers/);
    await T(s)((c, ctx) => cancelSiteTransfer(c, ctx, x.id));
    await expect(T(s)((c, ctx) => setSiteActive(c, ctx, s.dxb, false))).rejects.toThrow(/holds stock/);
    await expect(T(s)((c, ctx) => assignLocationSite(c, ctx, s.D1, s.auh))).rejects.toThrow(/holds stock/);
    await T(s)((c, ctx) => setSiteActive(c, ctx, s.auh, false));
    expect((await T(s)((c) => listSites(c))).length).toBe(2);
    await expect(T(s)((c, ctx) => requestSiteTransfer(c, ctx, { from_site: s.dxb, to_site: s.dxb, lines: [] }))).rejects.toThrow(/different sites/);
  });
});
