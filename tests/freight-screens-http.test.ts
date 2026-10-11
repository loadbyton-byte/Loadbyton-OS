import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { createStaff } from "../src/platform/admin.js";
import { totp } from "../src/lib/util.js";
import { createRate } from "../src/ops/crm.js";
import { future } from "./helpers.js";
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

const flash = (loc: string | null) => decodeURIComponent(new URL(loc!, "http://x").searchParams.get("ok") ?? new URL(loc!, "http://x").searchParams.get("err") ?? "");
const idFrom = (loc: string | null) => loc!.split("/").pop()!.split("?")[0];

describe("Freight commercial and service-console screens", () => {
  it("opportunities, rate breaks, contracts and masters work end to end for a freight owner", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const { cust, sup, rate } = await db.tenant(t.tenantId, async (c) => {
      const cust = await createParty(c, t.ctx, { kind: "customer", name: "Screen Customer" });
      const sup = await createParty(c, t.ctx, { kind: "supplier", name: "Screen Carrier" });
      const rate = await createRate(c, t.ctx, { supplier_id: sup, mode: "air", origin: "DXB", destination: "LHR", charge_name: "Air", basis: "per_kg", unit_cost: "10", valid_from: future(-1), valid_to: future(300) });
      return { cust, sup, rate };
    });
    const b = new Browser();
    expect((await b.login(email, "correct horse battery")).status).toBe(302);
    for (const p of ["/app/freight/opportunities", "/app/freight/contracts", "/app/freight/masters", "/app/rates", `/app/rates/${rate}`, "/app/migration/stock"]) expect((await b.page(p)).status, p).toBe(200);

    let r = await b.post("/app/freight/opportunities", { kind: "tender", party_id: cust, title: "Gov tender", est_value: "5000", win_pct: "40", submission_by: future(7) });
    expect(flash(r.headers.get("location"))).toMatch(/recorded/);
    const oid = idFrom(r.headers.get("location"));
    expect((await b.post(`/app/freight/opportunities/${oid}/lane`, { mode: "ocean", origin: "Shanghai", destination: "Jebel Ali", volume: "50", unit: "teu" })).headers.get("location")).toContain("ok=");
    const page = await b.page(`/app/freight/opportunities/${oid}`);
    expect(page.html).toContain("Gov tender");
    expect(page.html).toContain("Shanghai");
    r = await b.post(`/app/freight/opportunities/${oid}/move`, { to: "no_bid", note: "" });
    expect(flash(r.headers.get("location"))).toMatch(/rationale/i);                       // rationale required, shown as a flash rather than an error page

    r = await b.post(`/app/rates/${rate}/tiers`, { tiers: "0, 10\n100, 8\n500, 6.50" });
    expect(flash(r.headers.get("location"))).toMatch(/saved/);
    expect((await b.page(`/app/rates/${rate}?qty=600`)).html).toContain("AED 3900.00");
    expect(flash((await b.post(`/app/rates/${rate}/tiers`, { tiers: "0, 10\n50, 9" })).headers.get("location"))).toMatch(/fixed/);

    r = await b.post("/app/freight/contracts", { supplier_id: sup, reference: "CT-77", valid_from: future(-1), valid_to: future(200), modes: "air", origins: "Dubai", destinations: "London", max_cost: "500" });
    expect(flash(r.headers.get("location"))).toMatch(/recorded/);
    expect((await b.page("/app/freight/contracts")).html).toContain("CT-77");
    expect(flash((await b.post("/app/freight/contracts/policy", { supplier_id: sup, blocked: "1", blocked_reason: "" })).headers.get("location"))).toMatch(/Reason for blocking/);

    r = await b.post("/app/freight/masters", { mode: "air", master_ref: "176-12345676", origin: "DXB", destination: "LHR" });
    expect(flash(r.headers.get("location"))).toMatch(/check digit/);
    r = await b.post("/app/freight/masters", { mode: "air", master_ref: "176-12345675", origin: "DXB", destination: "LHR", carrier: "Test Air" });
    expect(flash(r.headers.get("location"))).toMatch(/MST-/);
    const mid = idFrom(r.headers.get("location"));
    expect((await b.page(`/app/freight/masters/${mid}`)).html).toContain("176-12345675");
    const csv = await b.get(`/app/freight/masters/${mid}/manifest.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(flash((await b.post(`/app/freight/masters/${mid}/close`, {})).headers.get("location"))).toMatch(/no house shipments/);
    expect(flash((await b.post(`/app/freight/masters/${mid}/cancel`, {})).headers.get("location"))).toMatch(/cancelled/);
    expect(await verifyInvariants(db)).toEqual([]);

    // a tenant without freight sees no freight pages
    const f = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
    const fe = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [f.userId])).rows[0].email;
    const fb = new Browser();
    await fb.login(fe, "correct horse battery");
    expect(flash((await fb.post("/app/freight/masters", { mode: "ocean", master_ref: "X1", origin: "a", destination: "b" })).headers.get("location"))).toMatch(/Freight forwarding is not selected/);
  });

  it("platform staff reach partners, rollout and reports only after TOTP, and role rules apply", async () => {
    resetThrottle();
    const admin = await createStaff(db, `cs-${Date.now()}@loadbyton.test`, "Commercial", "a-very-long-staff-password", "commercial_admin");
    const aud = await createStaff(db, `au-${Date.now()}@loadbyton.test`, "Auditor", "a-very-long-staff-password", "auditor");
    const anon = new Browser();
    for (const p of ["/admin/partners", "/admin/rollout", "/admin/reports"]) expect((await anon.get(p)).headers.get("location"), p).toContain("/login");
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [admin.userId])).rows[0].email;
    const b = new Browser();
    await b.login(email, "a-very-long-staff-password");
    expect((await b.get("/admin/partners")).headers.get("location")).toBe("/admin/mfa");
    await b.post("/admin/mfa", { code: totp(admin.totpSecret) });
    for (const p of ["/admin/partners", "/admin/rollout", "/admin/reports"]) expect((await b.page(p)).status, p).toBe(200);
    expect(flash((await b.post("/admin/partners", { name: "Screen Partner", commission_bps: "1000", commission_months: "12", agreement_ref: "AGR-S" })).headers.get("location"))).toMatch(/created/);
    expect((await b.page("/admin/partners")).html).toContain("Screen Partner");
    expect(flash((await b.post("/admin/rollout/cohort", { name: "Pilot screen", description: "x" })).headers.get("location"))).toMatch(/created/);
    expect(flash((await b.post("/admin/rollout/flag", { key: "Bad Key", audience: "all" })).headers.get("location"))).toMatch(/Flag keys/);
    expect(flash((await b.post("/admin/rollout/flag", { key: "screen.flag", audience: "all", note: "ok" })).headers.get("location"))).toMatch(/saved/);
    expect((await b.page("/admin/rollout")).html).toContain("screen.flag");
    // an auditor can read but not change commercial settings
    const ab = new Browser();
    await ab.login((await db.query<any>(`SELECT email FROM users WHERE id=$1`, [aud.userId])).rows[0].email, "a-very-long-staff-password");
    await ab.post("/admin/mfa", { code: totp(aud.totpSecret) });
    expect((await ab.page("/admin/reports")).status).toBe(200);
    expect((await ab.post("/admin/partners", { name: "Nope", commission_bps: "1", commission_months: "1", agreement_ref: "x" })).status).toBe(403);
  });
});
