import { beforeAll, afterEach, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Db, Conn } from "../src/db/client.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { uploadDocument } from "../src/ops/documents.js";
import { createSku, createLocation, createInbound, getInbound, receiveInbound } from "../src/ops/fulfilment.js";
import { approveStorageContract, accrueStorageDay, amendStorageContract, setLocationPallets, setSkuCbm } from "../src/ops/fulfil-storage.js";
import { invoiceMerchant } from "../src/ops/fulfil-billing.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterEach(() => { vi.useRealTimers(); });
const add = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const advanceTo = (day: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(`${day}T12:00:00+04:00`)); };

async function fixture(basis: string) {
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const run = <T>(work: (c: Conn) => Promise<T>) => db.tenant(t.tenantId, work);
  const d = await run(async (c) => {
    const party = await createParty(c, t.ctx, { kind: "customer", name: "Bases merchant" });
    const a = await createLocation(c, t.ctx, { code: "A-01" }), b = await createLocation(c, t.ctx, { code: "B-01" }), x = await createLocation(c, t.ctx, { code: "X-01" });
    const sku = await createSku(c, t.ctx, { party_id: party, code: "SKU1", name: "Fixture" });
    const doc = await uploadDocument(c, t.ctx, { kind: "other", title: "Storage terms", issuer: "Merchant", filename: "c.pdf", data: Buffer.from("%PDF-1.4 terms") });
    for (const [qty, loc] of [[6, a], [4, b]] as const) {
      const i = await createInbound(c, t.ctx, { party_id: party, lines: `SKU1, ${qty}` });
      await receiveInbound(c, t.ctx, i.id, { line_id: (await getInbound(c, i.id)).lines[0].id, good: qty, damaged: 0, location_id: loc, token: randomUUID() });
    }
    return { party, a, b, x, sku, doc };
  });
  const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1, 1);
  const first = next.toISOString().slice(0, 10);
  const f = { party_id: d.party, document_id: d.doc, valid_from: first, valid_until: add(first, 70), basis, currency: "AED", amount: "2.00", tax_code: "ZR0", reference: randomUUID(), reviewer: "Reviewer", scope: "Agreed scope, bin/receiving/quarantine, Dubai cutoff" };
  return { t, run, f, first, ...d };
}
const clean = async () => expect(await verifyInvariants(db)).toEqual([]);

it("bills closing pallet positions and fails closed until every occupied location declares them", async () => {
  const s = await fixture("closing_occupied_pallet");
  const id = await s.run((c) => approveStorageContract(c, s.t.ctx, s.f));
  advanceTo(add(s.first, 2));
  await expect(s.run((c) => accrueStorageDay(c, s.t.ctx, id, s.first))).rejects.toThrow(/pallet-position count/);
  await s.run((c) => setLocationPallets(c, s.t.ctx, s.a, "2.5"));
  await s.run((c) => setLocationPallets(c, s.t.ctx, s.b, 1));
  const day = await s.run((c) => accrueStorageDay(c, s.t.ctx, id, s.first));
  expect(Number(day.measure_qty)).toBe(3.5);
  const ch = (await db.query<any>(`SELECT code, qty, unit_minor FROM fulfil_charges WHERE tenant_id=$1`, [s.t.tenantId])).rows[0];
  expect({ code: ch.code, qty: Number(ch.qty), unit: Number(ch.unit_minor) }).toEqual({ code: "storage_pallet_day", qty: 3.5, unit: 200 });
  vi.useRealTimers();
  await s.run((c) => invoiceMerchant(c, s.t.ctx, s.party));
  await clean();
});

it("bills closing stock cbm from SKU volumes", async () => {
  const s = await fixture("closing_stock_cbm");
  const id = await s.run((c) => approveStorageContract(c, s.t.ctx, s.f));
  advanceTo(add(s.first, 2));
  await expect(s.run((c) => accrueStorageDay(c, s.t.ctx, id, s.first))).rejects.toThrow(/unit cbm/);
  await s.run((c) => setSkuCbm(c, s.t.ctx, s.sku, "0.0125"));
  const day = await s.run((c) => accrueStorageDay(c, s.t.ctx, id, s.first));
  expect(Number(day.measure_qty)).toBe(0.125);   // 10 units × 0.0125 cbm
  await expect(s.run((c) => setSkuCbm(c, s.t.ctx, s.sku, "0.0000001"))).rejects.toThrow(/six decimals/);
  await clean();
});

it("peak occupancy captures a mid-day high that the closing snapshot misses", async () => {
  const s = await fixture("peak_occupied_location");
  const id = await s.run((c) => approveStorageContract(c, s.t.ctx, s.f));
  // Day 1: 2 locations at open; a third is used 10:00–14:00 then emptied; putaway A→B in one transaction never double counts.
  await db.system(async (c) => {
    const mv = async (loc: string, delta: number, kind: string, at: string) => {
      await c.query(`INSERT INTO stock_movements(tenant_id,sku_id,location_id,delta,kind,ref_type,ref_id,created_by,created_at) VALUES($1,$2,$3,$4,$5,'t',$6,$7,$8)`, [s.t.tenantId, s.sku, loc, delta, kind, randomUUID(), s.t.userId, `${s.first}T${at}+04:00`]);
      if (delta < 0) await c.query(`UPDATE stock_levels SET on_hand=on_hand+$3 WHERE sku_id=$1 AND location_id=$2`, [s.sku, loc, delta]);
      else await c.query(`INSERT INTO stock_levels(tenant_id,sku_id,location_id,on_hand) VALUES($1,$2,$3,$4) ON CONFLICT (tenant_id,sku_id,location_id) DO UPDATE SET on_hand=stock_levels.on_hand+$4`, [s.t.tenantId, s.sku, loc, delta]);
    };
    await mv(s.b, -4, "transfer_out", "10:00:00"); await mv(s.x, 4, "transfer_in", "10:00:00");   // same instant: B empties, X fills
    await mv(s.x, -1, "transfer_out", "11:00:00"); await mv(s.b, 1, "transfer_in", "11:00:00");     // X and B both occupied (peak 3)
    await mv(s.x, -3, "transfer_out", "14:00:00"); await mv(s.b, 3, "transfer_in", "14:00:00");     // back to 2
  });
  advanceTo(add(s.first, 2));
  const day = await s.run((c) => accrueStorageDay(c, s.t.ctx, id, s.first));
  expect(Number(day.measure_qty)).toBe(3);
  expect(new Date(day.peak_at).toISOString()).toBe(`${s.first}T07:00:00.000Z`);   // 11:00 Dubai
  expect(day.occupied_locations).toBe(2);
  await clean();
});

it("amendments are future month-boundary, evidence-backed, ordered and applied only from their effective date", async () => {
  const s = await fixture("closing_occupied_location");
  const id = await s.run((c) => approveStorageContract(c, s.t.ctx, s.f));
  const eff = (() => { const d = new Date(`${s.first}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 1); return d.toISOString().slice(0, 10); })();
  const am = { contract_id: id, effective_from: eff, basis: "closing_occupied_pallet", amount: "5.00", tax_code: "SR5", document_id: s.doc, reference: randomUUID(), reviewer: "Amendment reviewer", scope: "Move to pallet pricing from the new month" };
  await expect(s.run((c) => amendStorageContract(c, s.t.ctx, { ...am, effective_from: add(eff, 1) }))).rejects.toThrow(/month boundary/);
  await expect(s.run((c) => amendStorageContract(c, s.t.ctx, { ...am, effective_from: s.first }))).rejects.toThrow(/after its first day/);
  const amId = await s.run((c) => amendStorageContract(c, s.t.ctx, am));
  expect(await s.run((c) => amendStorageContract(c, s.t.ctx, am))).toBe(amId);
  await expect(s.run((c) => amendStorageContract(c, s.t.ctx, { ...am, amount: "6.00" }))).rejects.toThrow(/different terms/);
  await expect(s.run((c) => amendStorageContract(c, s.t.ctx, { ...am, reference: randomUUID(), amount: "6.00" }))).rejects.toThrow(/later amendment/);
  await expect(db.query(`UPDATE fulfil_storage_amendments SET unit_minor=1 WHERE id=$1`, [amId])).rejects.toThrow(/immutable/);
  await s.run((c) => setLocationPallets(c, s.t.ctx, s.a, 2));
  await s.run((c) => setLocationPallets(c, s.t.ctx, s.b, 1));
  advanceTo(add(eff, 2));
  const before = await s.run((c) => accrueStorageDay(c, s.t.ctx, id, add(eff, -1)));
  const after = await s.run((c) => accrueStorageDay(c, s.t.ctx, id, eff));
  expect([before.amendment_id, Number(before.measure_qty)]).toEqual([null, 2]);          // old basis: 2 occupied locations
  expect([after.amendment_id, Number(after.measure_qty)]).toEqual([amId, 3]);            // new basis: 3 pallet positions
  const codes = (await db.query<any>(`SELECT code, unit_minor FROM fulfil_charges WHERE tenant_id=$1 ORDER BY source_key`, [s.t.tenantId])).rows.map((r) => [r.code, Number(r.unit_minor)]);
  expect(codes).toEqual([["storage_location_day", 200], ["storage_pallet_day", 500]]);
  await clean();
});
