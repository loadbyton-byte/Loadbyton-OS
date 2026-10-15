import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { config } from "../src/config.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createInbound, createLocation, createSku, getInbound, receiveInbound } from "../src/ops/fulfilment.js";
import { createOrderPull, listOrderPulls, mapPulledOrder, pullDueOrders, pullOrders, recentPullEvents, setOrderPullActive } from "../src/ops/order-pull.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, body: JSON.stringify(body), headers });
const withHosts = async <T,>(fn: () => Promise<T>) => { const s = config.liveFeeds.allowedHosts; config.liveFeeds.allowedHosts = ["shop.example.test"]; try { return await fn(); } finally { config.liveFeeds.allowedHosts = s; } };
const map = { map_ref: "order_no", map_name: "ship.first,ship.last", map_phone: "ship.tel", map_address: "ship.line1,ship.line2", map_city: "ship.city", map_country: "ship.cc", map_lines_path: "items", map_sku: "sku", map_qty: "qty", map_status: "state", accept_values: "paid, ready", cancel_values: "Cancelled", map_time: "updated" };
const order = (ref: string, over: Record<string, any> = {}) => ({ order_no: ref, state: "paid", updated: "2026-10-05T10:00:00Z", ship: { first: "Aisha", last: "Khan", tel: "0501112222", line1: "Marina Walk 1", line2: "Apt 4", city: "Dubai", cc: "AE" }, items: [{ sku: "TEE", qty: 2 }], ...over });

async function shop() {
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const run = <T,>(fn: (c: any) => Promise<T>) => db.tenant(t.tenantId, fn);
  const f = await run(async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Noon Seller" });
    const loc = await createLocation(c, t.ctx, { code: "a-01" });
    await createSku(c, t.ctx, { party_id: merchant, code: "TEE", name: "Tee", barcode: "6291000000011" });
    const inb = await createInbound(c, t.ctx, { party_id: merchant, lines: "TEE, 10" });
    const d = await getInbound(c, inb.id);
    await receiveInbound(c, t.ctx, inb.id, { line_id: d.lines[0].id, good: 10, damaged: 0, location_id: loc, token: `tok-${crypto.randomUUID()}` });
    return { merchant };
  });
  return { t, run, ...f };
}
const spec = (merchant: string, over: Record<string, any> = {}) => ({ label: "Noon", party_id: merchant, channel: "noon", url: "https://shop.example.test/v1/orders", secret: "tok", items_path: "data", ...map, ...over });

describe("order pulls", () => {
  it("maps nested fields, joins parts, and decides ship / skip / cancel / invalid by status", () => {
    const m: any = { ref: "order_no", name: "ship.first,ship.last", address: "ship.line1,ship.line2", lines_path: "items", sku: "sku", qty: "qty", status: "state", accept_values: ["paid"], cancel_values: ["cancelled"], city: "ship.city" };
    expect(mapPulledOrder(order("N1"), m)).toMatchObject({ kind: "order", ref: "N1", order: { ship_to_name: "Aisha Khan", ship_to_address: "Marina Walk 1, Apt 4", ship_to_city: "Dubai", lines: [{ code: "TEE", qty: 2 }] } });
    expect(mapPulledOrder(order("N1", { state: "pending" }), m)).toEqual({ kind: "skip" });
    expect(mapPulledOrder(order("N1", { state: "Cancelled" }), m)).toEqual({ kind: "cancel", ref: "N1" });
    expect(mapPulledOrder(order("N1", { items: [{ sku: "", qty: 1 }] }), m)).toMatchObject({ kind: "invalid", reason: /no SKU/ });
    expect(mapPulledOrder(order("N1", { items: [{ sku: "TEE", qty: 1.5 }] }), m)).toMatchObject({ kind: "invalid", reason: /invalid quantity/ });
    expect(mapPulledOrder(order("N1", { items: [] }), m)).toMatchObject({ kind: "invalid", reason: /no lines/ });
    expect(mapPulledOrder(order("", {}), m)).toMatchObject({ kind: "invalid" });
    expect(mapPulledOrder(order("N1", { ship: {} }), m)).toMatchObject({ kind: "invalid", reason: /recipient name or delivery address/ });
    expect(mapPulledOrder(order("N1", { items: [{ sku: "TEE", qty: 1 }, { sku: "TEE", qty: 2 }] }), m)).toMatchObject({ order: { lines: [{ code: "TEE", qty: 3 }] } });
  });

  it("creates each order once, reserves stock, cancels before shipment, reports unknown SKUs once, and remembers where it stopped", async () => {
    await withHosts(async () => {
      const s = await shop();
      const id = await s.run((c) => createOrderPull(c, s.t.ctx, spec(s.merchant)));
      const urls: string[] = [];
      let payload: any = { data: [order("N1"), order("N2", { state: "pending" }), order("N3", { items: [{ sku: "NOPE", qty: 1 }] })] };
      const deps = { get: async (u: string) => { urls.push(u); return reply(200, payload); } };
      let r = await pullOrders(db, s.t.tenantId, id, deps);
      expect(r).toMatchObject({ added: 1, rejected: 1 });
      expect((await s.run((c) => c.query("SELECT external_ref, channel, status, party_id FROM fulfil_orders").then((x: any) => x.rows)))).toEqual([{ external_ref: "N1", channel: "noon", status: "allocated", party_id: s.merchant }]);
      // same answer again: nothing new, and the same refusal is not logged twice
      r = await pullOrders(db, s.t.tenantId, id, deps);
      expect(r).toMatchObject({ added: 0, rejected: 1 });
      expect((await s.run((c) => recentPullEvents(c))).filter((e: any) => e.outcome === "rejected")).toHaveLength(1);
      expect(new URL(urls[1]).searchParams.get("since")).toBeNull(); // do not move the cursor past a refused order
      // the SKU is added, the order is taken on the next pull; the marketplace cancels N1
      await s.run((c) => createSku(c, s.t.ctx, { party_id: s.merchant, code: "NOPE", name: "Nope", barcode: "6291000000028" }));
      payload = { data: [order("N3", { items: [{ sku: "NOPE", qty: 1 }] }), order("N1", { state: "Cancelled" })] };
      r = await pullOrders(db, s.t.tenantId, id, deps);
      expect(r).toMatchObject({ added: 1, cancelled: 1, rejected: 0 });
      expect((await s.run((c) => c.query("SELECT external_ref, status FROM fulfil_orders ORDER BY external_ref").then((x: any) => x.rows)))).toEqual([{ external_ref: "N1", status: "cancelled" }, { external_ref: "N3", status: "backordered" }]);
      expect(await verifyInvariants(db)).toEqual([]);
      // an order that already shipped needs a person
      await s.run((c) => c.query("UPDATE fulfil_orders SET status='shipped' WHERE external_ref='N3'"));
      payload = { data: [order("N3", { state: "Cancelled" })] };
      expect(await pullOrders(db, s.t.tenantId, id, deps)).toMatchObject({ cancelled: 0, rejected: 1 });
      expect((await s.run((c) => recentPullEvents(c)))[0].reason).toMatch(/already shipped/);
      expect((await s.run((c) => listOrderPulls(c)))[0]).toMatchObject({ last_status: "attention", party_name: "Noon Seller" });
    });
  });

  it("records provider failures, stops when switched off, and re-checks the allowed host list", async () => {
    await withHosts(async () => {
      const s = await shop();
      const id = await s.run((c) => createOrderPull(c, s.t.ctx, spec(s.merchant, { label: "Fail" })));
      expect((await pullOrders(db, s.t.tenantId, id, { get: async () => reply(401, {}) })).error).toMatch(/refused the credential/);
      expect((await pullOrders(db, s.t.tenantId, id, { get: async () => reply(503, {}) })).error).toMatch(/HTTP 503/);
      expect((await pullOrders(db, s.t.tenantId, id, { get: async () => reply(200, { nope: 1 }) })).error).toMatch(/expected list/);
      await s.run((c) => setOrderPullActive(c, s.t.ctx, id, false));
      expect((await pullOrders(db, s.t.tenantId, id, { get: async () => reply(200, { data: [] }) })).error).toMatch(/switched off/);
      await s.run((c) => setOrderPullActive(c, s.t.ctx, id, true));
      expect((await pullDueOrders(db, { get: async () => reply(200, { data: [] }) })).pulled).toBe(0);      // pulled moments ago
      await db.system((c) => c.query(`UPDATE order_pulls SET last_pull_at = now() - interval '1 hour' WHERE id=$1`, [id]));
      const due = await pullDueOrders(db, { get: async () => reply(200, { data: [] }) });
      expect(due.pulled).toBeGreaterThanOrEqual(1);
    });
    const t = await shop();
    await expect(t.run((c) => createOrderPull(c, t.t.ctx, spec(t.merchant)))).rejects.toThrow(/not enabled|not a permitted/);
  });

  it("validates its set-up and is limited to the fulfilment sector", async () => {
    await withHosts(async () => {
      const s = await shop();
      const mk = (over: Record<string, any>) => s.run((c) => createOrderPull(c, s.t.ctx, spec(s.merchant, { label: `x${Math.random()}`, ...over })));
      await expect(mk({ map_ref: "" })).rejects.toThrow(/Map the ref/);
      await expect(mk({ map_sku: "a b" })).rejects.toThrow(/not valid/);
      await expect(mk({ cancel_values: "x", map_status: "" })).rejects.toThrow(/status field/);
      await expect(mk({ auth_scheme: "oauth2_client", token_url: "https://shop.example.test/t", secret: "nocolon" })).rejects.toThrow(/client_id:client_secret/);
      await expect(mk({ page_mode: "cursor" })).rejects.toThrow(/next cursor/);
      await expect(mk({ url: "https://evil.example.test/o" })).rejects.toThrow(/not a permitted/);
      const other = await newTenant(db, undefined, ["freight-forwarding"]);
      const party = await db.tenant(other.tenantId, (c) => createParty(c, other.ctx, { kind: "customer", name: "X" }));
      await expect(db.tenant(other.tenantId, (c) => createOrderPull(c, other.ctx, spec(party)))).rejects.toThrow(/not selected/);
    });
  });
});

describe("marketplace profiles", () => {
  const magentoOrder = (ref: string, over: Record<string, any> = {}) => ({
    increment_id: ref, status: "processing", updated_at: "2026-10-05 10:00:00",
    items: [{ sku: "TEE", qty_ordered: 2, product_type: "configurable" }, { sku: "TEE", qty_ordered: 2, parent_item_id: 11 }],
    extension_attributes: { shipping_assignments: [{ shipping: { address: { firstname: "Aisha", lastname: "Khan", street: ["Marina Walk 1", "Apt 4"], city: "Dubai", country_id: "AE", telephone: "0501112222" } } }] }, ...over,
  });
  it("Magento: sends Magento's searchCriteria, reads nested addresses, counts configurable products once and pages by page number", async () => {
    await withHosts(async () => {
      const s = await shop();
      const id = await s.run((c) => createOrderPull(c, s.t.ctx, { label: "Magento", profile: "magento", party_id: s.merchant, url: "https://shop.example.test/rest/V1/orders", secret: "int-token" }));
      const urls: string[] = [], auth: string[] = [];
      const deps = { get: async (u: string, h: Record<string, string>) => { urls.push(u); auth.push(h.authorization); const page = new URL(u).searchParams.get("searchCriteria[currentPage]"); return reply(200, { items: page === "1" ? [magentoOrder("100000001"), magentoOrder("100000002", { status: "closed" }), magentoOrder("100000003", { status: "complete" })] : [], total_count: 3 }); } };
      const r = await pullOrders(db, s.t.tenantId, id, deps);
      expect(r).toMatchObject({ added: 1, rejected: 0 });
      const q = new URL(urls[0]).searchParams;
      expect(q.get("searchCriteria[filter_groups][0][filters][0][field]")).toBe("updated_at"); expect(q.get("searchCriteria[filter_groups][0][filters][0][condition_type]")).toBe("gt");
      expect(q.get("searchCriteria[pageSize]")).toBe("100"); expect(q.get("searchCriteria[currentPage]")).toBe("1"); expect(urls).toHaveLength(2);
      expect(q.get("searchCriteria[filter_groups][0][filters][0][value]")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);        // first pull: last 7 days, in Magento's format
      expect(Date.now() - Date.parse(q.get("searchCriteria[filter_groups][0][filters][0][value]")!.replace(" ", "T") + "Z")).toBeGreaterThan(6.9 * 86400_000);
      expect(auth[0]).toBe("Bearer int-token");
      const o = (await db.query<any>(`SELECT o.external_ref, o.ship_to_name, o.ship_to_address, l.qty FROM fulfil_orders o JOIN fulfil_order_lines l ON l.order_id=o.id WHERE o.tenant_id=$1`, [s.t.tenantId])).rows;
      expect(o).toEqual([{ external_ref: "100000001", ship_to_name: "Aisha Khan", ship_to_address: "Marina Walk 1, Apt 4", qty: 2 }]);       // the child line was skipped: quantity is 2, not 4
      // the next pull resumes from the newest order
      await pullOrders(db, s.t.tenantId, id, deps);
      expect(new URL(urls[2]).searchParams.get("searchCriteria[filter_groups][0][filters][0][value]")).toBe("2026-10-04 10:00:00");
    });
  });

  it("Amazon: signs in with a refresh token, exchanges for a restricted-data token, fetches lines per new order, follows NextToken alone", async () => {
    await withHosts(async () => {
      const s = await shop();
      const prev = config.liveFeeds.allowedHosts; config.liveFeeds.allowedHosts = ["shop.example.test", "api.amazon.test"];
      try {
        const id = await s.run((c) => createOrderPull(c, s.t.ctx, { label: "Amazon", profile: "amazon", party_id: s.merchant, url: "https://api.amazon.test/orders/v0/orders", token_url: "https://api.amazon.test/auth/o2/token", exchange_url: "https://api.amazon.test/tokens/2021-03-01/restrictedDataToken", detail_url: "https://api.amazon.test/orders/v0/orders/{ref}/orderItems", secret: JSON.stringify({ client_id: "amzn1.app", client_secret: "cs", refresh_token: "Atzr|abc" }) }));
        const posts: { url: string; body: string }[] = [], gets: { url: string; token: string }[] = [];
        const listOrder = (ref: string, over: Record<string, any> = {}) => ({ AmazonOrderId: ref, OrderStatus: "Unshipped", LastUpdateDate: "2026-10-06T08:00:00Z", ShippingAddress: { Name: "Noura Ali", AddressLine1: "Al Wasl 5", City: "Dubai", CountryCode: "AE", Phone: "0509998888" }, ...over });
        const deps = {
          post: async (url: string, body: string, h: Record<string, string>) => { posts.push({ url, body }); return url.includes("auth/o2") ? reply(200, { access_token: "LWA-AT", expires_in: 3600 }) : (h["x-amz-access-token"] === "LWA-AT" ? reply(200, { restrictedDataToken: "RDT-1" }) : reply(403, {})); },
          get: async (url: string, h: Record<string, string>) => {
            gets.push({ url, token: h["x-amz-access-token"] });
            if (url.includes("/orderItems")) return reply(200, { payload: { OrderItems: [{ SellerSKU: "TEE", QuantityOrdered: 3 }] } });
            return new URL(url).searchParams.get("NextToken") ? reply(200, { payload: { Orders: [listOrder("AMZ-2")] } }) : reply(200, { payload: { Orders: [listOrder("AMZ-1"), listOrder("AMZ-9", { OrderStatus: "Shipped" })], NextToken: "NT-1" } });
          },
        };
        const r = await pullOrders(db, s.t.tenantId, id, deps);
        expect(r).toMatchObject({ added: 2, rejected: 0 });
        expect(posts[0].body).toContain("grant_type=refresh_token"); expect(posts[0].body).toContain("refresh_token=Atzr%7Cabc");
        expect(posts[1].url).toContain("restrictedDataToken"); expect(JSON.parse(posts[1].body).restrictedResources[0].dataElements).toContain("shippingAddress");
        const lists = gets.filter((g) => !g.url.includes("/orderItems"));
        expect(lists[0].token).toBe("RDT-1");                                                              // the restricted-data token replaces the access token
        expect(new URL(lists[0].url).searchParams.get("MarketplaceIds")).toBe("A2VIGQ35RCS4UG"); expect(new URL(lists[0].url).searchParams.has("LastUpdatedAfter")).toBe(true);
        expect([...new URL(lists[1].url).searchParams.keys()]).toEqual(["NextToken"]);                      // NextToken travels alone
        expect(gets.filter((g) => g.url.includes("/orderItems"))).toHaveLength(2);                          // lines only for the two unshipped orders
        const o = (await db.query<any>(`SELECT o.external_ref, o.channel, l.qty FROM fulfil_orders o JOIN fulfil_order_lines l ON l.order_id=o.id WHERE o.tenant_id=$1 ORDER BY 1`, [s.t.tenantId])).rows;
        expect(o).toEqual([{ external_ref: "AMZ-1", channel: "amazon", qty: 3 }, { external_ref: "AMZ-2", channel: "amazon", qty: 3 }]);
        // already-received orders cost no detail call on the next pull
        gets.length = 0; await pullOrders(db, s.t.tenantId, id, deps);
        expect(gets.filter((g) => g.url.includes("/orderItems"))).toHaveLength(0);
        // a refused exchange (no PII role) is reported plainly
        const bad = await pullOrders(db, s.t.tenantId, id, { ...deps, post: async (url: string) => (url.includes("auth/o2") ? reply(200, { access_token: "x" }) : reply(403, {})) });
        expect(bad.error).toMatch(/restricted-data token/);
        const ref = await pullOrders(db, s.t.tenantId, id, { ...deps, post: async () => reply(400, { error: "invalid_grant" }) });
        expect(ref.error).toMatch(/refused the refresh token/);
      } finally { config.liveFeeds.allowedHosts = prev; }
    });
  });

  it("an unknown profile is refused and typed settings override a profile", async () => {
    await withHosts(async () => {
      const s = await shop();
      await expect(s.run((c) => createOrderPull(c, s.t.ctx, { label: "x", profile: "noon", party_id: s.merchant, url: "https://shop.example.test/o", secret: "t" }))).rejects.toThrow(/Unknown marketplace profile/);
      const id = await s.run((c) => createOrderPull(c, s.t.ctx, { label: "m", profile: "magento", party_id: s.merchant, url: "https://shop.example.test/rest/V1/orders", secret: "t", channel: "mystore", accept_values: "processing" }));
      expect((await db.query<any>(`SELECT channel, profile, field_map FROM order_pulls WHERE id=$1`, [id])).rows[0]).toMatchObject({ channel: "mystore", profile: "magento", field_map: { accept_values: ["processing"] } });
    });
  });
});
