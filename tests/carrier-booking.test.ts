import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createInbound, createLocation, createOrder, createSku, getFulfilOrder, getInbound, packScan, pickOrder, receiveInbound } from "../src/ops/fulfilment.js";
import { bookAndDispatch, carrierLabel, clearUnknownBooking, createCarrierAccount, listCarrierAccounts, packedOrders, type Booker } from "../src/ops/carrier-booking.js";
import { CarrierError, bookDhl, dhlShipmentBody } from "../src/adapters/carrier-dhl.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const PDF = Buffer.from("%PDF-1.4 test label");
const ok: Booker = async () => ({ trackingNo: "1234567890", label: { format: "pdf", data: PDF } });
const acct = { carrier: "dhl_express", label: "DHL test", environment: "test", account_number: "123456789", username: "api-user", password: "api-pass", company: "Desert Threads", contact: "Omar", phone: "0501234567", address1: "Warehouse 4", city: "Dubai", country: "AE" };

async function shop(country = "AE") {
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const run = <T,>(fn: (c: any) => Promise<T>) => db.tenant(t.tenantId, fn);
  const f = await run(async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Desert Threads" });
    const loc = await createLocation(c, t.ctx, { code: "a-01" });
    await createSku(c, t.ctx, { party_id: merchant, code: "TEE", name: "Tee", barcode: "6291000000011" });
    const inb = await createInbound(c, t.ctx, { party_id: merchant, lines: "TEE, 5" });
    const d = await getInbound(c, inb.id);
    await receiveInbound(c, t.ctx, inb.id, { line_id: d.lines[0].id, good: 5, damaged: 0, location_id: loc, token: `tok-${crypto.randomUUID()}` });
    const o = await createOrder(c, t.ctx, { party_id: merchant, external_ref: "R-1", ship_to_name: "Aisha", ship_to_address: "Marina 1", ship_to_city: "Dubai", ship_to_country: country, lines: "TEE, 1" });
    await pickOrder(c, t.ctx, o.id); await packScan(c, t.ctx, o.id, { code: "TEE" });
    const accountId = await createCarrierAccount(c, t.ctx, acct);
    return { orderId: o.id as string, accountId };
  });
  return { t, run, ...f };
}

describe("carrier booking", () => {
  it("books once, stores the label, dispatches the order with the tracking number, and a repeat does not book again", async () => {
    const s = await shop(); let calls = 0;
    const booker: Booker = async (a, r) => { calls++; expect(a).toMatchObject({ environment: "test", username: "api-user", password: "api-pass" }); expect(r.reference).toMatch(/\S/); return ok(a, r); };
    const r = await bookAndDispatch(db, s.t.ctx, s.orderId, { account_id: s.accountId, weight_kg: "1.2" }, booker);
    expect(r).toMatchObject({ booked: true, dispatched: true, tracking_no: "1234567890" });
    const o = await s.run((c) => getFulfilOrder(c, s.orderId));
    expect(o.order.status).toBe("shipped"); expect(JSON.stringify(o)).toContain("1234567890");
    const label = await s.run((c) => carrierLabel(c, s.orderId));
    expect(label.data.equals(PDF)).toBe(true); expect(label.tracking).toBe("1234567890");
    const again = await bookAndDispatch(db, s.t.ctx, s.orderId, { account_id: s.accountId, weight_kg: 1 }, booker).catch((e) => e);
    expect(calls).toBe(1); expect(again).toBeInstanceOf(Error);
    expect((await verifyInvariants(db)).length).toBe(0);
  });

  it("keeps credentials sealed and never shows them in the account list", async () => {
    const s = await shop();
    const raw = await s.run((c) => c.query(`SELECT credentials_sealed FROM carrier_accounts`).then((r: any) => r.rows[0].credentials_sealed));
    expect(String(raw)).not.toContain("api-pass");
    expect(JSON.stringify(await s.run((c) => listCarrierAccounts(c)))).not.toContain("api-pass");
  });

  it("blocks another booking when the outcome is unknown, until a manager clears it", async () => {
    const s = await shop(); let calls = 0;
    const down: Booker = async () => { calls++; throw new CarrierError("DHL could not be reached", false); };
    await expect(bookAndDispatch(db, s.t.ctx, s.orderId, { account_id: s.accountId, weight_kg: 1 }, down)).rejects.toMatchObject({ status: 502 });
    await expect(bookAndDispatch(db, s.t.ctx, s.orderId, { account_id: s.accountId, weight_kg: 1 }, ok)).rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(1);
    expect((await s.run((c) => packedOrders(c)))[0].booking).toBe("requested");
    await expect(s.run((c) => clearUnknownBooking(c, s.t.ctx, s.orderId, "x"))).rejects.toThrow();
    await s.run((c) => clearUnknownBooking(c, s.t.ctx, s.orderId, "Checked in DHL portal, none exists"));
    expect(await bookAndDispatch(db, s.t.ctx, s.orderId, { account_id: s.accountId, weight_kg: 1 }, ok)).toMatchObject({ booked: true, dispatched: true });
  });

  it("marks a definite carrier refusal as failed so the order can be retried", async () => {
    const s = await shop();
    const refuse: Booker = async () => { throw new CarrierError("DHL rejected the shipment: bad postcode"); };
    await expect(bookAndDispatch(db, s.t.ctx, s.orderId, { account_id: s.accountId, weight_kg: 1 }, refuse)).rejects.toMatchObject({ status: 400 });
    expect(await bookAndDispatch(db, s.t.ctx, s.orderId, { account_id: s.accountId, weight_kg: 1 }, ok)).toMatchObject({ booked: true });
  });

  it("rejects bad weight and keeps tenants apart", async () => {
    const s = await shop(), other = await shop();
    await expect(bookAndDispatch(db, s.t.ctx, s.orderId, { account_id: s.accountId, weight_kg: 0 }, ok)).rejects.toThrow(/weight/);
    await expect(bookAndDispatch(db, other.t.ctx, s.orderId, { account_id: other.accountId, weight_kg: 1 }, ok)).rejects.toThrow();
    await expect(bookAndDispatch(db, other.t.ctx, other.orderId, { account_id: s.accountId, weight_kg: 1 }, ok)).rejects.toThrow();
  });
});

describe("DHL adapter", () => {
  const party = { name: "A", phone: "050", address1: "x", city: "Dubai", country: "AE" };
  const req = { reference: "O1", shipper: party, receiver: party, weightKg: 1, description: "Goods", productCode: "N", accountNumber: "123456789", shipDate: new Date("2026-10-15T08:00:00Z") };
  it("refuses cross-border shipments", () => { expect(() => dhlShipmentBody({ ...req, receiver: { ...party, country: "SA" } })).toThrow(/Cross-border/); });
  it("maps statuses and checks the label is a PDF", async () => {
    const acc = { environment: "test" as const, username: "u", password: "p" };
    const good = JSON.stringify({ shipmentTrackingNumber: "T1", documents: [{ typeCode: "label", content: PDF.toString("base64") }] });
    expect((await bookDhl(acc, req, async () => ({ status: 201, body: good }) as any)).trackingNo).toBe("T1");
    await expect(bookDhl(acc, req, async () => ({ status: 401, body: "{}" }) as any)).rejects.toMatchObject({ permanent: true });
    await expect(bookDhl(acc, req, async () => ({ status: 503, body: "{}" }) as any)).rejects.toMatchObject({ permanent: false });
    await expect(bookDhl(acc, req, async () => { throw new Error("net"); })).rejects.toMatchObject({ permanent: false });
    const bad = JSON.stringify({ shipmentTrackingNumber: "T1", documents: [{ typeCode: "label", content: Buffer.from("nope").toString("base64") }] });
    await expect(bookDhl(acc, req, async () => ({ status: 200, body: bad }) as any)).rejects.toMatchObject({ permanent: false });
  });
});
