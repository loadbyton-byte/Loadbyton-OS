import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createInbound, createLocation, createSku, getInbound, receiveInbound } from "../src/ops/fulfilment.js";
import { mapShopify, mapWoo, registerStorefront, setStorefrontStatus } from "../src/ops/storefront.js";
import { verifyInvariants } from "../src/platform/invariants.js";
import { resetThrottle } from "../src/platform/auth.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });
const SECRET = "shpss_test_secret_123";
const sig = (raw: string, secret = SECRET) => crypto.createHmac("sha256", secret).update(raw).digest("base64");

async function store(platform: "shopify" | "woocommerce" = "shopify") {
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const run = <T>(fn: (c: any) => Promise<T>) => db.tenant(t.tenantId, fn);
  const f = await run(async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Desert Threads" });
    const loc = await createLocation(c, t.ctx, { code: "a-01" });
    const tee = await createSku(c, t.ctx, { party_id: merchant, code: "TEE-M", name: "T-shirt M", barcode: "6291000000011" });
    const inb = await createInbound(c, t.ctx, { party_id: merchant, lines: "TEE-M, 10" });
    const d = await getInbound(c, inb.id);
    await receiveInbound(c, t.ctx, inb.id, { line_id: d.lines[0].id, good: 10, damaged: 0, location_id: loc, token: `tok-${crypto.randomUUID()}` });
    return { merchant, tee };
  });
  const conn = await run((c) => registerStorefront(c, t.ctx, { platform, party_id: f.merchant, label: "Main store", secret: SECRET }));
  return { t, run, ...f, conn, path: new URL(conn.url).pathname };
}
const shopifyOrder = (over: Record<string, any> = {}) => ({
  id: 9001, name: "#1001", financial_status: "paid",
  shipping_address: { name: "Aisha Khan", phone: "+971500000000", address1: "Marina Walk 12", address2: "Apt 4", city: "Dubai", province: "Dubai", country_code: "AE" },
  line_items: [{ sku: "TEE-M", quantity: 2, requires_shipping: true }], ...over,
});
const post = (path: string, topic: string, body: object | string, over: { secret?: string; header?: string } = {}) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return app.request(path, { method: "POST", body: raw, headers: { [over.header ?? "x-shopify-hmac-sha256"]: sig(raw, over.secret), "x-shopify-topic": topic, "x-wc-webhook-topic": topic } });
};

describe("storefront connectors", () => {
  it("maps Shopify and WooCommerce payloads, refusing what cannot ship", () => {
    expect(mapShopify("orders/create", shopifyOrder())).toMatchObject({ kind: "order", ref: "#1001", order: { ship_to_address: "Marina Walk 12, Apt 4, Dubai", lines: [{ code: "TEE-M", qty: 2 }], channel: "shopify" } });
    expect(mapShopify("orders/create", shopifyOrder({ line_items: [{ sku: "TEE-M", quantity: 1 }, { sku: "TEE-M", quantity: 2 }] }))).toMatchObject({ order: { lines: [{ code: "TEE-M", qty: 3 }] } });
    expect(mapShopify("orders/create", shopifyOrder({ line_items: [{ sku: "", quantity: 1 }] }))).toMatchObject({ kind: "invalid" });
    expect(mapShopify("orders/create", shopifyOrder({ line_items: [{ sku: "GIFT", quantity: 1, requires_shipping: false }] }))).toMatchObject({ kind: "invalid", reason: /needs shipping/ });
    expect(mapShopify("orders/create", shopifyOrder({ shipping_address: null }))).toMatchObject({ kind: "invalid", reason: /shipping address/ });
    expect(mapShopify("orders/create", shopifyOrder({ financial_status: "refunded" }))).toMatchObject({ kind: "ignore" });
    expect(mapShopify("orders/cancelled", shopifyOrder())).toMatchObject({ kind: "cancel", ref: "#1001" });
    expect(mapShopify("products/update", {})).toMatchObject({ kind: "ignore" });
    const woo = { number: "W-55", status: "processing", shipping: { first_name: "Omar", last_name: "Ali", address_1: "Al Wasl 5", city: "Dubai", country: "AE" }, billing: { phone: "0501234567" }, line_items: [{ sku: "TEE-M", quantity: 1 }] };
    expect(mapWoo("order.created", woo)).toMatchObject({ kind: "order", order: { ship_to_name: "Omar Ali", ship_to_phone: "0501234567", channel: "woocommerce" } });
    expect(mapWoo("order.updated", { ...woo, status: "cancelled" })).toMatchObject({ kind: "cancel" });
    expect(mapWoo("order.updated", { ...woo, status: "pending" })).toMatchObject({ kind: "ignore" });
    expect(mapWoo("order.deleted", woo)).toMatchObject({ kind: "ignore" });
  });

  it("creates each order once, reserves stock, rejects bad signatures, and cancels before shipment", async () => {
    resetThrottle();
    const s = await store();
    expect((await post(s.path, "orders/create", shopifyOrder(), { secret: "wrong" })).status).toBe(401);
    expect((await app.request(s.path.slice(0, -1) + "x", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request(s.path, { method: "GET" })).status).toBe(404);

    let r = await post(s.path, "orders/create", shopifyOrder());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: "ingested" });
    const orders: any[] = await s.run((c) => c.query("SELECT id, status, channel, external_ref, party_id FROM fulfil_orders").then((x: any) => x.rows));
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: "allocated", channel: "shopify", external_ref: "#1001", party_id: s.merchant });

    // the store redelivers: still one order
    r = await post(s.path, "orders/paid", shopifyOrder());
    expect(await r.json()).toMatchObject({ outcome: "duplicate" });
    expect(await s.run((c) => c.query("SELECT count(*)::int n FROM fulfil_orders").then((x: any) => x.rows[0].n))).toBe(1);
    expect((await s.run((c) => c.query("SELECT reserved FROM stock_levels WHERE sku_id=$1", [s.tee]).then((x: any) => x.rows[0].reserved)))).toBe(2);

    r = await post(s.path, "orders/cancelled", shopifyOrder());
    expect(await r.json()).toMatchObject({ outcome: "cancelled" });
    expect((await s.run((c) => c.query("SELECT status FROM fulfil_orders").then((x: any) => x.rows[0].status)))).toBe("cancelled");
    expect((await s.run((c) => c.query("SELECT reserved FROM stock_levels WHERE sku_id=$1", [s.tee]).then((x: any) => x.rows[0].reserved)))).toBe(0);

    const events = await s.run((c) => c.query("SELECT outcome FROM storefront_events ORDER BY id").then((x: any) => x.rows.map((e: any) => e.outcome)));
    expect(events).toEqual(["ingested", "cancelled"]);
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("refuses an unknown SKU as redeliverable, then accepts the redelivery once the SKU exists; paused connections ask for redelivery", async () => {
    resetThrottle();
    const s = await store();
    const body = shopifyOrder({ id: 9002, name: "#1002", line_items: [{ sku: "NEW-SKU", quantity: 1 }] });
    let r = await post(s.path, "orders/create", body);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/Unknown SKU/) });
    await s.run((c) => createSku(c, s.t.ctx, { party_id: s.merchant, code: "NEW-SKU", name: "New", barcode: "6291000000028" }));
    r = await post(s.path, "orders/create", body);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: "ingested" });
    const attempts = await s.run((c) => c.query("SELECT outcome, attempt, recoverable FROM storefront_events ORDER BY id").then((x: any) => x.rows));
    expect(attempts).toEqual([{ outcome: "rejected", attempt: 1, recoverable: true }, { outcome: "ingested", attempt: 2, recoverable: false }]);

    await s.run((c) => setStorefrontStatus(c, s.t.ctx, s.conn.id, "paused"));
    expect((await post(s.path, "orders/create", shopifyOrder({ name: "#1003" }))).status).toBe(503);
    await s.run((c) => setStorefrontStatus(c, s.t.ctx, s.conn.id, "retired"));
    expect((await post(s.path, "orders/create", shopifyOrder({ name: "#1003" }))).status).toBe(404);
    await expect(s.run((c) => setStorefrontStatus(c, s.t.ctx, s.conn.id, "active"))).rejects.toThrow(/retired/);
  });

  it("keeps events immutable, answers permanent refusals normally, and takes WooCommerce orders and its setup ping", async () => {
    resetThrottle();
    const s = await store("woocommerce");
    const woo = { number: "W-77", status: "processing", shipping: { first_name: "Omar", last_name: "Ali", address_1: "Al Wasl 5", city: "Dubai", country: "AE" }, line_items: [{ sku: "TEE-M", quantity: 3 }] };
    const h = { header: "x-wc-webhook-signature" };
    expect((await post(s.path, "order.created", "webhook_id=12", h)).status).toBe(200);
    let r = await post(s.path, "order.created", woo, h);
    expect(await r.json()).toMatchObject({ outcome: "ingested" });
    r = await post(s.path, "order.updated", { ...woo, line_items: [] , number: "W-78"}, h);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: "rejected" });
    r = await post(s.path, "order.updated", { ...woo, status: "completed" }, h);
    expect(await r.json()).toMatchObject({ ignored: expect.any(String) });
    // an order that already shipped needs a person
    await s.run((c) => c.query("UPDATE fulfil_orders SET status='shipped'"));
    r = await post(s.path, "order.updated", { ...woo, status: "cancelled" }, h);
    expect(await r.json()).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/already shipped/) });
    await expect(db.system((c) => c.query("UPDATE storefront_events SET reason='x'"))).rejects.toThrow();
    // a Shopify connection never accepts a Woo signature header
    expect((await post(s.path, "order.created", woo, { header: "x-shopify-hmac-sha256" })).status).toBe(401);
  });

  it("is limited to the sector, to managers, and to the merchant's own catalogue", async () => {
    const other = await newTenant(db, undefined, ["freight-forwarding"]);
    const party = await db.tenant(other.tenantId, (c) => createParty(c, other.ctx, { kind: "customer", name: "X" }));
    await expect(db.tenant(other.tenantId, (c) => registerStorefront(c, other.ctx, { platform: "shopify", party_id: party, label: "s", secret: "12345678" }))).rejects.toThrow(/not selected/);
    const s = await store();
    await expect(s.run((c) => registerStorefront(c, s.t.ctx, { platform: "magento", party_id: s.merchant, label: "m", secret: "12345678" }))).rejects.toThrow(/Shopify or WooCommerce/);
    await expect(s.run((c) => registerStorefront(c, s.t.ctx, { platform: "shopify", party_id: s.merchant, label: "m", secret: "short" }))).rejects.toThrow(/at least 8/);
    await expect(s.run((c) => registerStorefront(c, s.t.ctx, { platform: "shopify", party_id: s.merchant, label: "Main store", secret: "12345678" }))).rejects.toThrow(/already exists/);
    const warehouse = { ...s.t.ctx, perms: new Set(["read", "wh.write"]) as any };
    await expect(s.run((c) => registerStorefront(c, warehouse, { platform: "shopify", party_id: s.merchant, label: "z", secret: "12345678" }))).rejects.toThrow();
  });
});
