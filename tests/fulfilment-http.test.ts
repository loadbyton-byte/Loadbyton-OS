import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { createInbound, createLocation, createOrder, createSku, getInbound, getFulfilOrder, packScan, pickOrder, receiveInbound, shipOrder } from "../src/ops/fulfilment.js";
import { setRate } from "../src/ops/fulfil-billing.js";
import { resetThrottle } from "../src/platform/auth.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });

class Browser {
  jar = new Map<string, string>();
  private cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(path: string, init: RequestInit = {}) {
    const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie: this.cookieHeader() } });
    for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  }
  get(path: string) { return this.req(path); }
  async csrf() { await this.get("/login"); return this.jar.get("lbt_csrf")!; }
  async post(path: string, fields: Record<string, string | string[]>, withCsrf = true) {
    const body = new URLSearchParams();
    if (withCsrf) body.set("_csrf", await this.csrf());
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return this.req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  async upload(path: string, fields: Record<string, string>, file: { name: string; text: string }) {
    const fd = new FormData();
    fd.set("_csrf", await this.csrf());
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("file", new File([file.text], file.name, { type: "text/csv" }));
    return this.req(path, { method: "POST", body: fd });
  }
  async login(email: string, password: string) { return this.post("/login", { email, password }); }
  async page(path: string) { const r = await this.get(path); return { status: r.status, html: await r.text(), location: r.headers.get("location") }; }
}

const F = "/app/fulfilment";
const flash = (loc: string | null) => decodeURIComponent(new URL(loc!, "http://x").searchParams.get("ok") ?? new URL(loc!, "http://x").searchParams.get("err") ?? "");

async function owner() {
  resetThrottle();
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
  const ids = await db.tenant(t.tenantId, async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Desert Threads" });
    const A = await createLocation(c, t.ctx, { code: "A-01" });
    const tee = await createSku(c, t.ctx, { party_id: merchant, code: "TEE-M", name: "T-shirt M", barcode: "6291000000011" });
    return { merchant, A, tee };
  });
  const b = new Browser();
  expect((await b.login(email, "correct horse battery")).status).toBe(302);
  return { t, b, email, ...ids };
}

describe("Fulfilment over HTTP", () => {
  it("is fenced to the E-commerce fulfilment sector and every page renders for staff", async () => {
    const o = await owner();
    for (const p of ["", "/orders", "/orders/new", "/orders/import", "/pick", "/inbound", "/inbound/new", "/stock", "/adjustments", "/returns", "/returns/new", "/catalog", "/locations", "/billing"]) {
      const r = await o.b.page(F + p);
      expect(r.status, p).toBe(200);
    }
    expect((await o.b.page(F)).html).toContain("Fulfilment board");
    const home = (await o.b.page("/app")).html;                                                  // checklist matches the sector, not freight
    expect(home).toContain("Add a storage bin"); expect(home).not.toContain("Prepare a quotation");
    expect((await o.b.page("/app/billing")).html).toContain("Fulfilment orders this month");     // the billing unit is visible
    const other = new Browser();
    const email = `fwd-${Date.now()}@example.com`;
    await other.post("/start", { company: "Fwd Co", contact: "F", email, password: "correct horse battery", sector: "freight-forwarding", country: "AE", emirate: "Dubai", goal: "Just exploring" });
    const gated = await other.page(`${F}/orders`);
    expect(gated.html).toContain("E-commerce fulfilment is not selected");
    expect((await other.page(F)).html).not.toContain("Fulfilment board");
  });

  it("runs inbound → order → pick → pack → ship through the forms; a double-submitted receive adds stock once", async () => {
    const o = await owner(), b = o.b;
    // expect a delivery
    const created = await b.post(`${F}/inbound`, { party_id: o.merchant, reference: "PO-1", lines: "TEE-M, 5" });
    expect(created.status).toBe(302);
    const inboundUrl = created.headers.get("location")!.split("?")[0];
    const inb = await b.page(inboundUrl);
    const lineId = /name="line_id" value="([^"]+)"/.exec(inb.html)![1], token = /name="token" value="([^"]+)"/.exec(inb.html)![1];
    const recv = { line_id: lineId, token, good: "5", damaged: "", location_id: o.A };
    const first = await b.post(`${inboundUrl}/receive`, recv);
    expect(flash(first.headers.get("location"))).toMatch(/Received 5 good/);
    const second = await b.post(`${inboundUrl}/receive`, recv);                      // double click / browser retry
    expect(flash(second.headers.get("location"))).toMatch(/Already recorded/);
    expect((await db.query<any>(`SELECT on_hand FROM stock_levels WHERE sku_id=$1 AND location_id=$2`, [o.tee, o.A])).rows[0].on_hand).toBe(5);

    // order reserves immediately
    const ord = await b.post(`${F}/orders`, { party_id: o.merchant, external_ref: "SHOP-1001", channel: "shopify", lines: "TEE-M, 2", ship_to_name: "Aisha", ship_to_address: "Marina Walk 12", ship_to_city: "Dubai" });
    expect(flash(ord.headers.get("location"))).toMatch(/2 unit\(s\) reserved/);
    const orderUrl = ord.headers.get("location")!.split("?")[0];
    const dup = await b.post(`${F}/orders`, { party_id: o.merchant, external_ref: "SHOP-1001", lines: "TEE-M, 1", ship_to_name: "x", ship_to_address: "y" });
    expect(flash(dup.headers.get("location"))).toMatch(/already exists as FUL-/);

    // pick form posts the quantities the picker typed
    let page = await b.page(orderUrl);
    expect(page.html).toContain("ready to pick");
    const qField = /name="(q_[^"]+)"/.exec(page.html)![1];
    const short = await b.post(`${orderUrl}/pick`, { [qField]: "5" });
    expect(flash(short.headers.get("location"))).toMatch(/between 0 and 2/);
    expect(flash((await b.post(`${orderUrl}/pick`, { [qField]: "2" })).headers.get("location"))).toMatch(/Picked 2 unit/);

    expect(flash((await b.post(`${orderUrl}/pack`, { code: "WRONG-ITEM", qty: "1" })).headers.get("location"))).toMatch(/not on this order/);
    expect(flash((await b.post(`${orderUrl}/pack`, { code: "6291000000011", qty: "2" })).headers.get("location"))).toMatch(/TEE-M: 2 of 2 packed/);
    page = await b.page(orderUrl);
    expect(page.html).toContain("Dispatch");
    expect(flash((await b.post(`${orderUrl}/ship`, { carrier: "Aramex", tracking_no: "AX-9", cartons: "1" })).headers.get("location"))).toMatch(/Dispatched 2 unit/);
    page = await b.page(orderUrl);
    expect(page.html).toContain("AX-9");
    const slip = await b.page(`${orderUrl}/slip`);
    expect(slip.status).toBe(200); expect(slip.html).toContain("Marina Walk 12");
    expect((await b.page(`${F}/stock`)).html).toContain("TEE-M");
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("CSRF is required, uploads import safely, and another tenant gets a 404 for the same URL", async () => {
    const o = await owner(), b = o.b;
    const noCsrf = await b.post(`${F}/inbound`, { party_id: o.merchant, lines: "TEE-M, 1" }, false);
    expect(noCsrf.status).toBe(403);

    const csv = "external_ref,sku,qty,ship_to_name,ship_to_address\nCSV-1,tee-m,1,Omar,JLT\nCSV-2,nope,1,Sara,Al Barsha\n";
    const dry = await b.upload(`${F}/orders/import`, { party_id: o.merchant, dry_run: "on" }, { name: "o.csv", text: csv });
    expect(flash(dry.headers.get("location"))).toMatch(/Would create 1.*1 row\(s\) rejected/);
    expect((await b.page(`${F}/orders`)).html).not.toContain("CSV-1");
    const real = await b.upload(`${F}/orders/import`, { party_id: o.merchant }, { name: "o.csv", text: csv });
    expect(flash(real.headers.get("location"))).toMatch(/Created 1/);
    const list = await b.page(`${F}/orders`);
    expect(list.html).toContain("CSV-1");
    const href = /href="(\/app\/fulfilment\/orders\/[0-9a-f-]{36})"/.exec(list.html)![1];

    const stranger = await owner();                                                     // a different company, fully signed in
    expect((await stranger.b.page(href)).status).toBe(404);
    expect((await stranger.b.page(`${F}/orders`)).html).not.toContain("CSV-1");
    expect((await stranger.b.post(`${href}/cancel`, {})).status).toBe(302);              // refused politely: redirect with an error, not a state change
    expect((await db.query<any>(`SELECT status FROM fulfil_orders WHERE external_ref='CSV-1'`)).rows[0].status).not.toBe("cancelled");
  });

  it("portal and driver seats cannot reach fulfilment", async () => {
    const o = await owner();
    const email = `portal-${Date.now()}@merchant.test`;
    const token = await db.tenant(o.t.tenantId, (c) => invite(c, o.t.ctx, { email, roles: ["portal"], party_id: o.merchant }));
    await acceptInvite(db, token, { name: "Merchant", password: "portal-password-1" });
    const p = new Browser();
    await p.login(email, "portal-password-1");
    expect((await p.get(F)).headers.get("location")).toBe("/app/portal");
    expect((await p.get(`${F}/stock`)).headers.get("location")).toBe("/app/portal");
  });
});

describe("Shared finance and task modules are reachable from every sector", () => {
  it("a fulfilment company can invoice a merchant, then open, receipt and void that invoice in the UI", async () => {
    const o = await owner(), b = o.b;
    await db.tenant(o.t.tenantId, async (c) => {
      for (const [code, amount] of [["receive_unit", "1"], ["pick_order", "3"], ["pack_order", "2"]]) await setRate(c, o.t.ctx, { party_id: o.merchant, code, amount, tax_code: "SR5" });
      const inb = await createInbound(c, o.t.ctx, { party_id: o.merchant, lines: "TEE-M, 4" });
      await receiveInbound(c, o.t.ctx, inb.id, { line_id: (await getInbound(c, inb.id)).lines[0].id, good: 4, damaged: 0, location_id: o.A, token: `tok-${Date.now()}-http` });
      const ord = await createOrder(c, o.t.ctx, { party_id: o.merchant, external_ref: "INV-1", lines: "TEE-M, 1", ship_to_name: "A", ship_to_address: "B" });
      await pickOrder(c, o.t.ctx, ord.id); await packScan(c, o.t.ctx, ord.id, { code: "TEE-M" });
      await shipOrder(c, o.t.ctx, ord.id, { carrier: "DHL", tracking_no: "INV-T1" });
    });
    const billing = await b.page(`${F}/billing`);
    expect(billing.html).toContain("Desert Threads");
    const issued = await b.post(`${F}/billing/invoice`, { party_id: o.merchant });
    const invUrl = issued.headers.get("location")!.split("?")[0];
    expect(invUrl).toMatch(/^\/app\/invoices\/[0-9a-f-]{36}$/);
    const page = await b.page(invUrl);
    expect(page.status).toBe(200);                                         // previously: "Freight forwarding is not selected"
    expect(page.html).not.toContain("is not selected");
    expect(page.html).toContain("Receiving, per unit"); expect(page.html).toContain("Record receipt");
    expect((await b.page("/app/invoices")).html).toContain("Desert Threads");
    expect((await b.page("/app")).html).toContain("Invoices &amp; collections");   // and the nav says so
    // collect part, then a full payment; a paid invoice cannot be voided
    const part = await b.post(`${invUrl}/receipt`, { amount: "1.00", method: "bank transfer" });
    expect(flash(part.headers.get("location"))).toMatch(/Receipt recorded/);
    const noVoid = await b.post(`${invUrl}/void`, { reason: "mistake" });
    expect(flash(noVoid.headers.get("location"))).toMatch(/Reverse receipts first/);
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("an unpaid merchant invoice can be voided and its activity is billable again", async () => {
    const o = await owner(), b = o.b;
    await db.tenant(o.t.tenantId, async (c) => {
      await setRate(c, o.t.ctx, { party_id: o.merchant, code: "receive_unit", amount: "2", tax_code: "SR5" });
      const inb = await createInbound(c, o.t.ctx, { party_id: o.merchant, lines: "TEE-M, 3" });
      await receiveInbound(c, o.t.ctx, inb.id, { line_id: (await getInbound(c, inb.id)).lines[0].id, good: 3, damaged: 0, location_id: o.A, token: `tok-${Date.now()}-void` });
    });
    const invUrl = (await b.post(`${F}/billing/invoice`, { party_id: o.merchant })).headers.get("location")!.split("?")[0];
    expect((await b.page(`${F}/billing`)).html).toContain("Nothing waiting to be invoiced");
    expect(flash((await b.post(`${invUrl}/void`, { reason: "wrong rate" })).headers.get("location"))).toMatch(/Invoice voided/);
    const again = await b.page(`${F}/billing`);
    expect(again.html).toContain("Receiving, per unit"); expect(again.html).not.toContain("Nothing waiting to be invoiced");
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("transport-only companies reach their invoices and tasks too (they were walled off as freight-only)", async () => {
    resetThrottle();
    const t = await newTenant(db, undefined, ["road-transport"]);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const b = new Browser(); await b.login(email, "correct horse battery");
    for (const p of ["/app/invoices", "/app/tasks"]) { const r = await b.page(p); expect(r.status, p).toBe(200); expect(r.html, p).not.toContain("is not selected"); }
    expect((await b.page("/app")).html).not.toContain("Owner dashboard");           // the job-margin dashboard stays freight-only, and is no longer a dead link
    expect((await b.page("/app/reports")).html).toContain("Freight forwarding is not selected");
  });

  it("warehouse staff can close the short-pick tasks they raise", async () => {
    const o = await owner(), b = o.b;
    const email = `wh-${Date.now()}@floor.test`;
    const token = await db.tenant(o.t.tenantId, (c) => invite(c, o.t.ctx, { email, roles: ["warehouse"] }));
    await acceptInvite(db, token, { name: "Floor", password: "warehouse-pass-1" });
    await db.tenant(o.t.tenantId, async (c) => {
      const inb = await createInbound(c, o.t.ctx, { party_id: o.merchant, lines: "TEE-M, 2" });
      await receiveInbound(c, o.t.ctx, inb.id, { line_id: (await getInbound(c, inb.id)).lines[0].id, good: 2, damaged: 0, location_id: o.A, token: `tok-${Date.now()}-short` });
      const ord = await createOrder(c, o.t.ctx, { party_id: o.merchant, external_ref: "SHORT-1", lines: "TEE-M, 2", ship_to_name: "A", ship_to_address: "B" });
      const alloc = (await getFulfilOrder(c, ord.id)).allocs[0];
      await pickOrder(c, o.t.ctx, ord.id, { [alloc.id]: 1 });
    });
    const w = new Browser(); await w.login(email, "warehouse-pass-1");
    const tasks = await w.page("/app/tasks");
    expect(tasks.html).toContain("Short pick FUL-");
    const id = /\/app\/exceptions\/([0-9a-f-]{36})\/resolve/.exec(tasks.html)![1];
    expect(flash((await w.post(`/app/exceptions/${id}/resolve`, {})).headers.get("location"))).toMatch(/Resolved/);
    expect((await db.query<any>(`SELECT status FROM job_exceptions WHERE id=$1`, [id])).rows[0].status).toBe("resolved");
  });
});

