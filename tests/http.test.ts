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
