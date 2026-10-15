import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createInbound, createLocation, createOrder, createSku, getFulfilOrder, getInbound, packScan, pickOrder, receiveInbound, shipOrder } from "../src/ops/fulfilment.js";
import { mapStatus, openShipments, parseStatusMap, registerCarrierFeed, setCarrierFeedStatus, shipmentTracking } from "../src/ops/carrier-tracking.js";
import { resetThrottle } from "../src/platform/auth.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });
const SECRET = "carrier-secret-123";
const sig = (raw: string, enc: "hex" | "base64" = "hex", secret = SECRET) => crypto.createHmac("sha256", secret).update(raw).digest(enc);

async function shipped(trackingNo: string) {
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const run = <T,>(fn: (c: any) => Promise<T>) => db.tenant(t.tenantId, fn);
  const f = await run(async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Desert Threads" });
    const loc = await createLocation(c, t.ctx, { code: "a-01" });
    await createSku(c, t.ctx, { party_id: merchant, code: "TEE", name: "Tee", barcode: "6291000000011" });
    const inb = await createInbound(c, t.ctx, { party_id: merchant, lines: "TEE, 5" });
    const d = await getInbound(c, inb.id);
    await receiveInbound(c, t.ctx, inb.id, { line_id: d.lines[0].id, good: 5, damaged: 0, location_id: loc, token: `tok-${crypto.randomUUID()}` });
    const o = await createOrder(c, t.ctx, { party_id: merchant, external_ref: "R-1", ship_to_name: "Aisha", ship_to_address: "Marina 1", ship_to_city: "Dubai", lines: "TEE, 1" });
    await pickOrder(c, t.ctx, o.id); await packScan(c, t.ctx, o.id, { code: "TEE" });
    await shipOrder(c, t.ctx, o.id, { carrier: "Aramex", tracking_no: trackingNo });
    return { orderId: o.id as string };
  });
  return { t, run, ...f };
}
const spec = { label: "Aramex push", carrier: "aramex", secret: SECRET, signature_header: "X-Signature", signature_encoding: "hex", events_path: "events", tracking_path: "awb", status_path: "state", time_path: "at", location_path: "place", status_map: "Shipment Received = in_transit\nHanded to Consignee = delivered" };

describe("carrier tracking feeds", () => {
  it("maps carrier words to our statuses, defaulting to common wording and never guessing 'delivered'", () => {
    const map = parseStatusMap("Shipment Received = in_transit\nhanded to consignee = delivered");
    expect(mapStatus("SHIPMENT RECEIVED", map)).toBe("in_transit"); expect(mapStatus("Handed to Consignee", map)).toBe("delivered");
    expect(mapStatus("Out for delivery", {})).toBe("out_for_delivery"); expect(mapStatus("Delivery attempt failed", {})).toBe("exception");
    expect(mapStatus("Return to sender", {})).toBe("returned"); expect(mapStatus("Shipment created", {})).toBe("info_received");
    expect(mapStatus("Something new", {})).toBe("other");
    expect(() => parseStatusMap("no equals sign")).toThrow(/needs the form/); expect(() => parseStatusMap("x = shipped")).toThrow(/not one of/);
  });

  it("stores signed events once, attaches them to the shipment by carrier and tracking number, and lists what is still in transit", async () => {
    resetThrottle();
    const s = await shipped("AWB-1001");
    const feed = await s.run((c) => registerCarrierFeed(c, s.t.ctx, spec));
    const path = new URL(feed.url).pathname;
    const post = (body: object | string, enc: "hex" | "base64" = "hex", secret?: string) => { const raw = typeof body === "string" ? body : JSON.stringify(body); return app.request(path, { method: "POST", body: raw, headers: { "x-signature": sig(raw, enc, secret) } }); };
    expect((await post({ events: [] }, "hex", "wrong")).status).toBe(401);
    expect((await app.request(path, { method: "GET" })).status).toBe(404);
    expect((await post("not json")).status).toBe(400);
    expect((await post({ events: [] })).status).toBe(400);

    const t0 = new Date(Date.now() - 3 * 3600_000).toISOString(), t1 = new Date(Date.now() - 2 * 3600_000).toISOString();
    let r = await (await post({ events: [{ awb: "AWB-1001", state: "Shipment Received", at: t0, place: "Dubai hub" }, { awb: "AWB-9999", state: "Shipment Received", at: t0 }, { awb: "", state: "x", at: t0 }] })).json() as any;
    expect(r).toMatchObject({ received: 3, stored: 2, rejected: 1 });
    r = await (await post({ events: [{ awb: "AWB-1001", state: "Shipment Received", at: t0, place: "Dubai hub" }] })).json() as any;
    expect(r).toMatchObject({ stored: 0, duplicates: 1 });                                   // redelivery adds nothing

    expect((await s.run((c) => openShipments(c)))[0]).toMatchObject({ no: expect.any(String), carrier_status: "in_transit", location: "Dubai hub" });
    await post({ events: [{ awb: "AWB-1001", state: "Handed to Consignee", at: t1, place: "Marina" }] });
    const tr = await s.run((c) => shipmentTracking(c, "Aramex", "AWB-1001"));                   // carrier name matches case-insensitively
    expect(tr.events.map((e: any) => e.status)).toEqual(["in_transit", "delivered"]); expect(tr.latest.status).toBe("delivered");
    expect(await s.run((c) => openShipments(c))).toHaveLength(0);                                // delivered shipments leave the open list
    expect((await s.run((c) => getFulfilOrder(c, s.orderId))).order.status).toBe("shipped");   // the order itself is never changed by a carrier event
    await expect(db.system((c) => c.query(`UPDATE carrier_events SET raw_status='x'`))).rejects.toThrow();
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("holds an event that arrives before the dispatch and shows it once the shipment exists; supports base64 signatures and pausing", async () => {
    resetThrottle();
    const s = await shipped("AWB-2002");
    const feed = await s.run((c) => registerCarrierFeed(c, s.t.ctx, { ...spec, label: "b64", signature_encoding: "base64", signature_header: "x-hmac", events_path: "", time_path: "" }));
    const path = new URL(feed.url).pathname;
    const raw = JSON.stringify({ awb: "AWB-LATE", state: "Out for delivery" });
    const post = (body = raw, secret = SECRET) => app.request(path, { method: "POST", body, headers: { "x-hmac": sig(body, "base64", secret) } });
    expect((await post()).status).toBe(200);
    expect((await s.run((c) => shipmentTracking(c, "Aramex", "AWB-LATE"))).latest.status).toBe("out_for_delivery");
    await s.run((c) => setCarrierFeedStatus(c, s.t.ctx, feed.id, "paused"));
    expect((await post()).status).toBe(503);
    await s.run((c) => setCarrierFeedStatus(c, s.t.ctx, feed.id, "retired"));
    expect((await post()).status).toBe(404);
    await expect(s.run((c) => setCarrierFeedStatus(c, s.t.ctx, feed.id, "active"))).rejects.toThrow(/retired/);
  });

  it("is limited to the fulfilment sector and validates its set-up", async () => {
    const other = await newTenant(db, undefined, ["freight-forwarding"]);
    await expect(db.tenant(other.tenantId, (c) => registerCarrierFeed(c, other.ctx, spec))).rejects.toThrow(/not selected/);
    const s = await shipped("AWB-3003");
    await expect(s.run((c) => registerCarrierFeed(c, s.t.ctx, { ...spec, label: "x1", signature_header: "bad header!" }))).rejects.toThrow(/letters, digits and hyphens/);
    await expect(s.run((c) => registerCarrierFeed(c, s.t.ctx, { ...spec, label: "x2", tracking_path: "a b" }))).rejects.toThrow(/field name/);
    await expect(s.run((c) => registerCarrierFeed(c, s.t.ctx, { ...spec, label: "x3", secret: "short" }))).rejects.toThrow(/at least 8/);
    await s.run((c) => registerCarrierFeed(c, s.t.ctx, spec));
    await expect(s.run((c) => registerCarrierFeed(c, s.t.ctx, spec))).rejects.toThrow(/already exists/);
  });
});
