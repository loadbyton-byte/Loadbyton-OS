import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createStaff } from "../src/platform/admin.js";
import { totp } from "../src/lib/util.js";
import { cancelOwnRequest, clockOf, createRequest, listRequests, requestDetail, staffUpdateRequest } from "../src/platform/requests.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { config.brochureMode = true; db = await freshDb(); app = buildApp(db); });
afterAll(() => { config.brochureMode = false; });

const good = { category: "free", sectors: ["freight-forwarding"], title: "Freight pack with our layout", requirements: "Our quotation layout and AED/USD invoices", demoReviewed: true };

class Browser {
  jar = new Map<string, string>();
  private cookies() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(path: string, init: RequestInit = {}) {
    const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie: this.cookies() } });
    for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  }
  get(path: string) { return this.req(path); }
  async post(path: string, fields: Record<string, string | string[]>) {
    await this.get("/login");
    const body = new URLSearchParams({ _csrf: this.jar.get("lbt_csrf")! });
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return this.req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
}

describe("request rules", () => {
  it("starts a delivery clock, and a free request covers one built sector", async () => {
    const t = await newTenant(db);
    const now = new Date("2026-10-17T08:00:00Z");
    const r = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, good, now));
    expect(new Date(r.due_at).toISOString()).toBe("2026-10-18T08:00:00.000Z");
    expect(clockOf(r, new Date("2026-10-17T20:00:00Z"))).toMatchObject({ open: true, late: false });
    expect(clockOf(r, new Date("2026-10-18T09:00:00Z"))).toMatchObject({ open: true, late: true });
    const bad = (over: object) => db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, { ...good, ...over } as any));
    await expect(bad({ sectors: ["freight-forwarding", "road-transport"] })).rejects.toThrow(/one sector/);
    await expect(bad({ sectors: ["cold-chain"] })).rejects.toThrow(/bespoke/i);
    await expect(bad({ sectors: [] })).rejects.toThrow(/at least one sector/i);
    await expect(bad({ category: "enterprise" })).rejects.toThrow(/Free or Paid/);
    await expect(bad({ demoReviewed: false })).rejects.toThrow(/seen the demo/);
    await expect(bad({ requirements: "short" })).rejects.toThrow(/Describe/);
    // paid may combine sectors and bespoke packs
    const paid = await bad({ category: "paid", sectors: ["freight-forwarding", "cold-chain"] });
    expect(paid.category).toBe("paid");
  });

  it("keeps each client's requests private", async () => {
    const a = await newTenant(db), b = await newTenant(db);
    const ra = await db.tenant(a.tenantId, (c) => createRequest(c, a.tenantId, a.userId, good));
    expect(await db.tenant(b.tenantId, (c) => listRequests(c))).toEqual([]);
    await expect(db.tenant(b.tenantId, (c) => requestDetail(c, ra.id))).rejects.toThrow(/not found/i);
  });

  it("lets the client cancel until it is ready, then not", async () => {
    const t = await newTenant(db), staff = await createStaff(db, `s-${Date.now()}@lbt.test`, "Ops", "a-very-long-staff-password", "engineer");
    const r = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, good));
    await db.tenant(t.tenantId, (c) => cancelOwnRequest(c, t.tenantId, t.userId, r.id));
    await expect(db.tenant(t.tenantId, (c) => cancelOwnRequest(c, t.tenantId, t.userId, r.id))).rejects.toThrow(/not yet ready/);
    const r2 = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, good));
    await staffUpdateRequest(db, { userId: staff.userId, role: "engineer" }, r2.id, { status: "ready" });
    await expect(db.tenant(t.tenantId, (c) => cancelOwnRequest(c, t.tenantId, t.userId, r2.id))).rejects.toThrow(/not yet ready/);
  });
});

describe("staff delivery", () => {
  it("needs a quote for paid work and a hand-off for delivery, and closes the request", async () => {
    const t = await newTenant(db);
    const eng = { userId: (await createStaff(db, `e-${Date.now()}@lbt.test`, "Eng", "a-very-long-staff-password", "engineer")).userId, role: "engineer" };
    const paid = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, { ...good, category: "paid", sectors: ["freight-forwarding", "road-transport"] }));
    await expect(staffUpdateRequest(db, { userId: eng.userId, role: "viewer" }, paid.id, { status: "in_build" })).rejects.toThrow(/needs one of/);
    await expect(staffUpdateRequest(db, eng, paid.id, { status: "in_build" })).rejects.toThrow(/quote/i);
    await staffUpdateRequest(db, eng, paid.id, { status: "in_build", quoteNote: "AED 4,500 one-off, agreed by email" });
    await expect(staffUpdateRequest(db, eng, paid.id, { status: "delivered" })).rejects.toThrow(/hand-off/i);
    await expect(staffUpdateRequest(db, eng, paid.id, { status: "delivered", deliveryUrl: "http://insecure.example/x" })).rejects.toThrow(/https/);
    await staffUpdateRequest(db, eng, paid.id, { status: "delivered", deliveryUrl: "https://files.example/pack.zip", deliveryNotes: "Run migrations first." });
    const { request, events } = await db.tenant(t.tenantId, (c) => requestDetail(c, paid.id));
    expect(request).toMatchObject({ status: "delivered", delivery_url: "https://files.example/pack.zip" });
    expect(request.delivered_at).toBeTruthy();
    expect(events.map((e: any) => e.status)).toEqual(["received", "in_build", "delivered"]);
    expect(clockOf(request)).toMatchObject({ open: false, late: false });
    await expect(staffUpdateRequest(db, eng, paid.id, { status: "in_build" })).rejects.toThrow(/already delivered/);
  });

  it("starts the paid delivery window when the quote is agreed, not at submission", async () => {
    const t = await newTenant(db);
    const eng = { userId: (await createStaff(db, `p-${Date.now()}@lbt.test`, "Eng", "a-very-long-staff-password", "engineer")).userId, role: "engineer" };
    const old = new Date(Date.now() - 3 * 86400_000);
    const paid = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, { ...good, category: "paid" }, old));
    expect(clockOf(paid)).toMatchObject({ open: true, awaitingQuote: true, late: false });   // submitted 3 days ago, still not late
    await staffUpdateRequest(db, eng, paid.id, { status: "in_build", quoteNote: "AED 3,000 agreed" });
    const after = (await db.tenant(t.tenantId, (c) => requestDetail(c, paid.id))).request;
    const left = new Date(after.due_at).getTime() - Date.now();
    expect(clockOf(after)).toMatchObject({ awaitingQuote: false, late: false });
    expect(left).toBeGreaterThan((config.deliveryHours - 1) * 3600_000);
    expect(left).toBeLessThanOrEqual(config.deliveryHours * 3600_000);
    // a later edit does not restart the window
    await staffUpdateRequest(db, eng, paid.id, { status: "ready", quoteNote: "AED 3,500 revised" });
    expect(new Date((await db.tenant(t.tenantId, (c) => requestDetail(c, paid.id))).request.due_at).getTime()).toBe(new Date(after.due_at).getTime());
  });

  it("makes the event history immutable", async () => {
    const t = await newTenant(db);
    const r = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, good));
    await expect(db.system((c) => c.query(`UPDATE service_request_events SET note='x' WHERE request_id=$1`, [r.id]))).rejects.toThrow();
  });
});

describe("brochure site", () => {
  it("shows the brochure pages and the free/paid categories", async () => {
    const b = new Browser();
    for (const p of ["/demo", "/pricing", "/start", "/sectors"]) expect((await b.get(p)).status).toBe(200);
    const pricing = await (await b.get("/pricing")).text();
    expect(pricing).toContain("Free build");
    expect(pricing).toContain("do not host your system");
    expect(pricing).not.toMatch(/jobs \/ month|Compare plans/i);
  });

  it("registers an account and a request in one step, then shows the tracker", async () => {
    const b = new Browser();
    const email = `brochure-${Date.now()}@example.com`;
    const res = await b.post("/start", { company: "Brochure Logistics", contact: "Bea", email, password: "correct horse battery", category: "free", sector: "freight-forwarding", title: "Freight pack", requirements: "Branding plus our own quote layout.", backend_notes: "Node + Postgres on our VPS", demo_reviewed: "yes" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/app\/requests\/[0-9a-f-]{36}\?ok=/);
    const dash = await (await b.get("/app")).text();
    expect(dash).toContain("Your requests");
    expect(dash).toContain("Freight pack");
    expect(dash).toMatch(/\dh \d\dm left/);
    expect(dash).not.toMatch(/Plan &amp; billing|Owner dashboard/);
    const detail = await (await b.get(res.headers.get("location")!.split("?")[0])).text();
    expect(detail).toContain("Node + Postgres on our VPS");
    // a second request from the dashboard
    const again = await b.post("/app/requests", { category: "paid", sector: ["freight-forwarding", "road-transport"], title: "Two packs", requirements: "Freight and transport together.", demo_reviewed: "yes" });
    expect(again.headers.get("location")).toMatch(/^\/app\/requests\//);
  });

  it("rejects an incomplete registration without creating an account", async () => {
    const b = new Browser();
    const email = `incomplete-${Date.now()}@example.com`;
    const res = await b.post("/start", { company: "No Demo Ltd", contact: "Ned", email, password: "correct horse battery", category: "free", sector: "freight-forwarding", title: "Pack", requirements: "Something specific to change." });
    expect(res.headers.get("location")).toContain("/start?err=");
    expect((await db.query(`SELECT 1 FROM users WHERE email=$1`, [email])).rows).toHaveLength(0);
  });

  it("keeps operating, billing and usage pages out of the client's reach", async () => {
    const b = new Browser();
    await b.post("/start", { company: "Fenced Co", contact: "Finn", email: `fenced-${Date.now()}@example.com`, password: "correct horse battery", category: "free", sector: "road-transport", title: "Transport pack", requirements: "Our dispatch board fields.", demo_reviewed: "yes" });
    for (const p of ["/app/billing", "/app/jobs", "/app/transport", "/app/reports", "/app/settings", "/app/invoices", "/app/export.json"]) {
      const r = await b.get(p);
      expect([p, r.status, r.headers.get("location")]).toEqual([p, 302, "/app"]);
    }
  });

  it("shows staff a deadline-ordered delivery queue and delivers to the client", async () => {
    const client = new Browser();
    await client.post("/start", { company: "Queue Co", contact: "Quin", email: `queue-${Date.now()}@example.com`, password: "correct horse battery", category: "free", sector: "freight-forwarding", title: "Queue pack", requirements: "Our own status names." , demo_reviewed: "yes" });
    const staffEmail = `queue-staff-${Date.now()}@lbt.test`;
    const st = await createStaff(db, staffEmail, "Ops", "a-very-long-staff-password", "engineer");
    const ops = new Browser();
    await ops.post("/login", { email: staffEmail, password: "a-very-long-staff-password" });
    await ops.post("/admin/mfa", { code: totp(st.totpSecret) });
    const queue = await (await ops.get("/admin/requests")).text();
    expect(queue).toContain("Queue pack");
    const id = (await db.query<any>(`SELECT id FROM service_requests WHERE title='Queue pack'`)).rows[0].id;
    const done = await ops.post(`/admin/requests/${id}`, { status: "delivered", delivery_url: "https://files.example/queue.zip", delivery_notes: "Unzip and run." });
    expect(done.headers.get("location")).toContain("ok=");
    expect(await (await client.get(`/app/requests/${id}`)).text()).toContain("https://files.example/queue.zip");
    // a client can never reach the staff queue
    expect((await client.get("/admin/requests")).status).toBeGreaterThanOrEqual(300);
  });
});
