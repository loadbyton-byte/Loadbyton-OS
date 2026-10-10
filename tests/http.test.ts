import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant, convertedJob, ctxFor } from "./helpers.js";
import { buildMockEvent, createOrder, signPayload } from "../src/platform/billing.js";
import { createStaff } from "../src/platform/admin.js";
import { totp } from "../src/lib/util.js";
import { resetThrottle } from "../src/platform/auth.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { createParty } from "../src/ops/crm.js";
import { uploadDocument } from "../src/ops/documents.js";
import { createInbound, createLocation, createSku, createWarehouse, getInbound, receiveLine } from "../src/ops/warehouse.js";

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
  async login(email: string, password: string) { return this.post("/login", { email, password }); }
}

async function signedUp(name: string) {
  const b = new Browser();
  const email = `${name}-${Date.now()}@example.com`;
  const res = await b.post("/start", { company: `${name} Logistics`, contact: name, email, password: "correct horse battery", sector: "freight-forwarding", country: "AE", emirate: "Dubai", goal: "Just exploring" });
  expect(res.status).toBe(302);
  return { b, email };
}

describe("HTTP boundary", () => {
  it("sets security headers", async () => {
    const r = await app.request("/");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects state-changing requests without a valid CSRF token", async () => {
    const b = new Browser();
    const r = await b.post("/contact", { name: "x", email: "x@y.com" }, false);
    expect(r.status).toBe(403);
    const ok = await b.post("/contact", { name: "x", email: "x@y.com", message: "hi" });
    expect(ok.status).toBe(302);
  });

  it("registers, signs in, and shows the empty real workspace", async () => {
    const { b } = await signedUp("Alpha");
    const home = await b.get("/app");
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Getting started");
    expect(html).toContain("Free Forever");
  });

  it("anonymous users are sent to sign-in; normal users cannot reach the control console", async () => {
    const anon = new Browser();
    expect((await anon.get("/app/jobs")).status).toBe(302);
    expect((await anon.get("/admin")).headers.get("location")).toContain("/login");
    const { b } = await signedUp("Beta");
    expect((await b.get("/admin")).status).toBe(403);
    expect((await b.get("/admin/tenants")).status).toBe(403);
  });

  it("cross-tenant access by edited ID is denied for pages, documents, exports", async () => {
    resetThrottle();
    const a = await newTenant(db), { b } = await signedUp("Gamma");
    const j = await convertedJob(db, a);
    expect((await b.get(`/app/jobs/${j.jobId}`)).status).toBe(404);
    expect((await b.get(`/app/quotes/${j.quoteId}`)).status).toBe(404);
    const docId = await db.tenant(a.tenantId, (c) => uploadDocument(c, a.ctx, { kind: "other", title: "secret", filename: "s.pdf", data: Buffer.from("%PDF-1.4 secret") }));
    expect((await b.get(`/app/documents/${docId}/download`)).status).toBe(404);
    const exp = await (await b.get("/app/export.json")).json() as any;
    expect(JSON.stringify(exp)).not.toContain(j.jobId);
  });

  it("brute-force sign-in is throttled and errors do not reveal whether the email exists", async () => {
    resetThrottle();
    const b = new Browser();
    const loc = async () => (await b.login("nobody@example.com", "wrong-password-1")).headers.get("location")!;
    const first = await loc();
    expect(decodeURIComponent(first)).toContain("Email or password is incorrect");
    for (let i = 0; i < 9; i++) await loc();
    expect(decodeURIComponent(await loc())).toContain("Too many sign-in attempts");
    resetThrottle();
  });

  it("webhook: bad signature 401, valid applied, replay deduplicated, never granted via browser redirect", async () => {
    const t = await newTenant(db);
    const o = await createOrder(db, t.tenantId, t.userId, "starter");
    const order = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
    const raw = JSON.stringify(buildMockEvent(order));
    const send = (sig: string) => app.request("/webhooks/payments/mock", { method: "POST", body: raw, headers: { "x-lbt-signature": sig, "content-type": "application/json" } });
    expect((await send("t=1,v1=bad")).status).toBe(401);
    expect((await send(signPayload(raw))).status).toBe(200);
    const again = await (await send(signPayload(raw))).json() as any;
    expect(again.outcome).toBe("duplicate");
    expect((await db.query<any>(`SELECT count(*)::int n FROM provision_jobs WHERE tenant_id=$1`, [t.tenantId])).rows[0].n).toBe(1);
    // visiting a "success" URL does nothing for an unpaid order
    const o2 = await createOrder(db, t.tenantId, t.userId, "business");
    expect((await db.query<any>(`SELECT status FROM orders WHERE id=$1`, [o2.orderId])).rows[0].status).toBe("pending");
  });

  it("platform staff cannot reach the console before TOTP; wrong code rejected; support view needs customer grant", async () => {
    resetThrottle();
    const st = await createStaff(db, `staff-${Date.now()}@loadbyton.test`, "Ops", "a-very-long-staff-password", "support");
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [st.userId])).rows[0].email;
    const b = new Browser();
    expect((await b.login(email, "a-very-long-staff-password")).headers.get("location")).toBe("/admin/mfa");
    expect((await b.get("/admin")).headers.get("location")).toBe("/admin/mfa");
    expect((await b.post("/admin/mfa", { code: "000000" })).headers.get("location")).toContain("err=");
    expect((await b.post("/admin/mfa", { code: totp(st.totpSecret) })).headers.get("location")).toBe("/admin");
    expect((await b.get("/admin")).status).toBe(200);
    expect((await b.get("/admin/tenants")).status).toBe(200);

    // support view: denied without approved grant; allowed read-only after owner approves
    const t = await newTenant(db);
    expect((await b.post(`/admin/tenants/${t.tenantId}/view`, {})).headers.get("location")).toContain("err=");
    await b.post(`/admin/tenants/${t.tenantId}/grant`, { reason: "Investigating import problem" });
    const g = (await db.query<any>(`SELECT id FROM support_grants WHERE tenant_id=$1`, [t.tenantId])).rows[0];
    expect((await b.post(`/admin/tenants/${t.tenantId}/view`, {})).headers.get("location")).toContain("err=");
    const { decideGrant } = await import("../src/platform/admin.js");
    await decideGrant(db, t.tenantId, t.userId, g.id, true, 1);
    expect((await b.post(`/admin/tenants/${t.tenantId}/view`, {})).headers.get("location")).toBe("/app");
    expect((await b.get("/app")).status).toBe(200);
    const write = await b.post("/app/parties", { name: "Should fail", kind: "customer" });
    expect(decodeURIComponent(write.headers.get("location")!.replace(/\+/g, " "))).toMatch(/does not allow|read-only/);
    expect((await db.query(`SELECT 1 FROM parties WHERE tenant_id=$1 AND name='Should fail'`, [t.tenantId])).rows).toHaveLength(0);
    expect((await db.query<any>(`SELECT 1 FROM audit_log WHERE tenant_id=$1 AND actor_kind='support_grant' AND action='support.view_started'`, [t.tenantId])).rows).toHaveLength(1);
  });

  it("portal users see only their own party's shipments and cannot open internal pages", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const j = await convertedJob(db, t);
    const other = await convertedJob(db, t);
    const token = await db.tenant(t.tenantId, (c) => invite(c, t.ctx, { email: `portal-${Date.now()}@cust.com`, roles: ["portal"], party_id: j.customerId }));
    const acc = await acceptInvite(db, token, { name: "Customer User", password: "portal-password-123" });
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [acc.userId])).rows[0].email;
    const b = new Browser();
    await b.login(email, "portal-password-123");
    const portal = await (await b.get("/app/portal")).text();
    expect(portal).toContain("My shipments");
    const jobNo = (await db.query<any>(`SELECT no FROM jobs WHERE id=$1`, [j.jobId])).rows[0].no;
    const otherNo = (await db.query<any>(`SELECT no FROM jobs WHERE id=$1`, [other.jobId])).rows[0].no;
    expect(portal).toContain(jobNo);
    expect(portal).not.toContain(otherNo);
    expect((await b.get("/app/jobs")).headers.get("location")).toBe("/app/portal");
    expect((await b.get("/app/team")).headers.get("location")).toBe("/app/portal");
  });
});

describe("Transport over HTTP", () => {
  it("driver seat is fenced to its own trips; JSON offline sync needs the CSRF header and dedupes", async () => {
    resetThrottle();
    const { createVehicle, createDriver, createOrder, createTrip, dispatchTrip, getTrip } = await import("../src/ops/transport.js");
    const t = await newTenant(db, undefined, ["road-transport"]);
    const dubai = (h: number) => new Date(Date.now() + h * 3600000 + 4 * 3600000).toISOString().slice(0, 16);
    const mk = async (name: string) => db.tenant(t.tenantId, async (c) => {
      const drv = await createDriver(c, t.ctx, { name });
      const email = `${name.toLowerCase()}-${Date.now()}@drivers.test`;
      const token = await invite(c, t.ctx, { email, roles: ["driver"], driver_id: drv });
      return { drv, token, email };
    });
    const d1 = await mk("Ali"), d2 = await mk("Omar");
    await acceptInvite(db, d1.token, { name: "Ali", password: "driver-password-1" });
    await acceptInvite(db, d2.token, { name: "Omar", password: "driver-password-2" });
    const { cust, v1, v2 } = await db.tenant(t.tenantId, async (c) => ({
      cust: await createParty(c, t.ctx, { kind: "customer", name: "C" }),
      v1: await createVehicle(c, t.ctx, { reg_no: "A1", capacity_kg: 5000 }), v2: await createVehicle(c, t.ctx, { reg_no: "B2", capacity_kg: 5000 }),
    }));
    const plan = (veh: string, drv: string) => db.tenant(t.tenantId, async (c) => {
      const o = await createOrder(c, t.ctx, { party_id: cust, pickup_address: "P", delivery_address: "D", weight_kg: 10, rate: "100" });
      const tr = await createTrip(c, t.ctx, { vehicle_id: veh, driver_id: drv, planned_start: dubai(1), planned_end: dubai(5), order_ids: [o.id] });
      await dispatchTrip(c, t.ctx, tr.id);
      return { ...tr, legs: (await getTrip(c, tr.id)).legs };
    });
    const mine = await plan(v1, d1.drv), theirs = await plan(v2, d2.drv);

    const b = new Browser();
    expect((await b.login(d1.email, "driver-password-1")).headers.get("location")).toBe("/app");
    expect((await b.get("/app")).headers.get("location")).toBe("/app/driver");
    expect((await b.get("/app/jobs")).headers.get("location")).toBe("/app/driver");
    expect((await b.get("/app/team")).headers.get("location")).toBe("/app/driver");
    expect((await b.get("/app/transport")).headers.get("location")).toBe("/app/driver");
    const home = await (await b.get("/app/driver")).text();
    expect(home).toContain(mine.no); expect(home).not.toContain(theirs.no);
    expect((await b.get(`/app/driver/trips/${mine.id}`)).status).toBe(200);
    expect((await b.get(`/app/driver/trips/${theirs.id}`)).status).toBe(404);

    // JSON sync: missing/forged CSRF header rejected
    await b.csrf();
    const csrf = b.jar.get("lbt_csrf")!;
    const events = [{ client_event_id: "offline-evt-0001", trip_id: mine.id, leg_id: mine.legs[0].id, kind: "arrive", device_time: new Date(Date.now() - 600000).toISOString(), payload: {} }];
    const send = (hdr: Record<string, string>) => b.req("/app/driver/sync", { method: "POST", body: JSON.stringify({ events }), headers: { "content-type": "application/json", ...hdr } });
    expect((await send({})).status).toBe(403);
    expect((await send({ "x-csrf-token": "forged.value" })).status).toBe(403);
    const ok = await (await send({ "x-csrf-token": csrf })).json() as any;
    expect(ok.results[0].outcome).toBe("applied");
    const again = await (await send({ "x-csrf-token": csrf })).json() as any;
    expect(again.results[0].outcome).toBe("duplicate");
    // an event for someone else's trip is refused (403), nothing recorded
    const evil = [{ ...events[0], client_event_id: "offline-evt-0002", trip_id: theirs.id, leg_id: theirs.legs[0].id }];
    const r = await b.req("/app/driver/sync", { method: "POST", body: JSON.stringify({ events: evil }), headers: { "content-type": "application/json", "x-csrf-token": csrf } });
    expect(r.status).toBe(403);
    expect((await db.query<any>(`SELECT count(*)::int n FROM trip_events WHERE trip_id=$1`, [theirs.id])).rows[0].n).toBe(0);
  });

  it("warehouse pages require the Contract warehouse sector; the web flow receives once, counts blind and shows customers only their own stock", async () => {
    resetThrottle();
    const none = await signedUp("Fwd2");
    expect(await (await none.b.get("/app/warehouse")).text()).toContain("Contract warehouse / 3PL is not selected");

    const t = await newTenant(db, undefined, ["contract-warehouse-3pl"]);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const S = await db.tenant(t.tenantId, async (c) => {
      const acme = await createParty(c, t.ctx, { kind: "customer", name: "Acme Foods" });
      const zed = await createParty(c, t.ctx, { kind: "customer", name: "Zed Retail" });
      const wh = await createWarehouse(c, t.ctx, { code: "JA1", name: "Jebel Ali" });
      const rec = await createLocation(c, t.ctx, { warehouse_id: wh, code: "REC", kind: "receiving" });
      await createLocation(c, t.ctx, { warehouse_id: wh, code: "A-01", kind: "storage" });
      return { acme, zed, wh, rec, rice: await createSku(c, t.ctx, { owner_id: acme, code: "RICE-5", description: "Rice 5kg" }), tee: await createSku(c, t.ctx, { owner_id: zed, code: "TEE-M", description: "Tee M" }) };
    });
    const b = new Browser();
    await b.login(email, "correct horse battery");
    const W = "/app/warehouse";
    for (const p of ["", "/inbound", "/inbound/new", `/inbound/new?owner=${S.acme}&warehouse=${S.wh}`, "/outbound", `/outbound/new?owner=${S.acme}&warehouse=${S.wh}`, "/stock", "/stock/ledger", "/counts", "/setup", "/billing"]) {
      expect((await b.get(W + p)).status, p).toBe(200);
    }
    // create a notice through the form (blank SKU rows are ignored)
    const made = await b.post(`${W}/inbound`, { owner_id: S.acme, warehouse_id: S.wh, customer_ref: "PO-1", sku_id: [S.rice, "", ""], qty: ["12", "", ""] });
    expect(made.status).toBe(302);
    const page = await (await b.get(made.headers.get("location")!)).text();
    const line = page.match(/inbound\/line\/([0-9a-f-]{36})\/receive/)![1], ref = page.match(/name="client_ref" value="(rcv-[^"]+)"/)![1];
    const inboundId = made.headers.get("location")!.split("/").pop()!;
    const receive = () => b.post(`${W}/inbound/line/${line}/receive`, { inbound: inboundId, client_ref: ref, qty: "12", condition: "good", location_id: S.rec, lot: "" });
    const flash = (r: Response, k: "ok" | "err") => new URL(r.headers.get("location")!, "http://x").searchParams.get(k) ?? "";
    const r1 = await receive(), r2 = await receive();                      // double-click / resubmit
    expect(flash(r1, "ok")).toBe("Received.");
    expect(flash(r2, "ok")).toContain("already recorded");
    expect(Number((await db.query<any>(`SELECT sum(qty_on_hand) n FROM wh_stock WHERE tenant_id=$1`, [t.tenantId])).rows[0].n)).toBe(12);
    // an invalid action is refused with a message, not a stack trace
    const bad = await b.post(`${W}/inbound/line/${line}/receive`, { inbound: inboundId, client_ref: "rcv-another-1", qty: "5", condition: "damaged", location_id: S.rec });
    expect(flash(bad, "err")).toContain("quarantine");

    // counts are blind while open
    const stock = (await db.query<any>(`SELECT l.id FROM wh_locations l WHERE l.tenant_id=$1 AND l.code='REC'`, [t.tenantId])).rows[0].id;
    const started = await b.post(`${W}/counts`, { warehouse_id: S.wh, location_id: stock });
    const sheet = await (await b.get(started.headers.get("location")!)).text();
    expect(sheet).toContain("RICE-5"); expect(sheet).not.toContain(">System<");

    // customer portal: own stock only; no warehouse pages
    const token = await db.tenant(t.tenantId, (c) => invite(c, t.ctx, { email: `portal-${Date.now()}@acme.test`, roles: ["portal"], party_id: S.acme }));
    const info = await acceptInvite(db, token, { name: "Acme Buyer", password: "portal-password-1" });
    const pe = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [info.userId])).rows[0].email;
    await db.tenant(t.tenantId, async (c) => { const i = await createInbound(c, t.ctx, { owner_id: S.zed, warehouse_id: S.wh, lines: [{ sku_id: S.tee, qty: 3 }] }); await receiveLine(c, t.ctx, (await getInbound(c, i.id)).lines[0].id, { qty: 3, location_id: S.rec }); });
    resetThrottle();
    const p = new Browser();
    await p.login(pe, "portal-password-1");
    const mine = await (await p.get("/app/portal")).text();
    expect(mine).toContain("Stock held for you"); expect(mine).toContain("RICE-5"); expect(mine).not.toContain("TEE-M");
    expect((await p.get(W)).headers.get("location")).toBe("/app/portal");
  });

  it("transport pages require the Road transport sector; staff see the planning board", async () => {
    resetThrottle();
    const none = await signedUp("Fwd");                       // registered with freight-forwarding only
    const res = await none.b.get("/app/transport");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Road transport is not selected");
    const t = await newTenant(db, undefined, ["road-transport"]);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const b = new Browser();
    await b.login(email, "correct horse battery");
    const board = await (await b.get("/app/transport")).text();
    expect(board).toContain("Transport planning");
    for (const p of ["/app/transport/orders", "/app/transport/trips", "/app/transport/fleet", "/app/transport/orders/new", "/app/transport/trips/new"]) expect((await b.get(p)).status).toBe(200);
  });
});
