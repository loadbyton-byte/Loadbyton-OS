import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { convertedJob } from "./helpers.js";
import { invoiceJob } from "../src/ops/finance.js";
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

describe("UAE readiness screens", () => {
  it("collects business and customer details, generates and submits a sandbox e-invoice, and prints Arabic names", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const j = await convertedJob(db, t, 100000, 60000);
    const b = new Browser();
    expect((await b.login(email, "correct horse battery")).status).toBe(302);
    for (const p of ["/app/einvoice", `/app/parties/${j.customerId}/details`]) expect((await b.page(p)).status, p).toBe(200);
    expect((await b.page("/app/einvoice")).html).toContain("Not a tax invoice yet.");

    expect(flash((await b.post("/app/einvoice/entity", { tax_id: "12345", country: "AE" })).headers.get("location"))).toMatch(/15 digits/);
    expect(flash((await b.post("/app/einvoice/entity", { tax_id: "100234567890003", legal_name_ar: "شركة العرض", address_line: "Office 1", city: "Dubai", emirate: "Dubai", country: "AE", einvoice_scheme: "S", einvoice_endpoint: "E1" })).headers.get("location"))).toMatch(/saved/);
    expect(flash((await b.post(`/app/parties/${j.customerId}/details`, { tax_id: "100987654321003", name_ar: "عميل الشاشة", address_line: "Yard 5", city: "Dubai", emirate: "Dubai", country: "AE" })).headers.get("location"))).toMatch(/saved/);
    expect(flash((await b.post("/app/einvoice/settings", { mode: "live", provider: "unknown-asp" })).headers.get("location"))).toMatch(/No adapter is installed/);
    expect(flash((await b.post("/app/einvoice/settings", { mode: "sandbox", customization_id: "C1", profile_id: "P1" })).headers.get("location"))).toMatch(/Settings saved/);

    const inv = await db.tenant(t.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]); await c.query(`UPDATE entities SET legal_name='Screen Logistics LLC'`); return invoiceJob(c, t.ctx, j.jobId); });
    const g = await b.post("/app/einvoice/generate", { invoice_id: inv.id });
    expect(flash(g.headers.get("location"))).toMatch(/Document generated/);
    const id = g.headers.get("location")!.split("/").pop()!.split("?")[0];
    const xml = await b.get(`/app/einvoice/${id}/xml`);
    expect(xml.status).toBe(200); expect(xml.headers.get("content-type")).toContain("application/xml");
    expect(await xml.text()).toContain("<cbc:CompanyID>100234567890003</cbc:CompanyID>");
    expect(flash((await b.post(`/app/einvoice/${id}/submit`, {})).headers.get("location"))).toMatch(/accepted/);
    const detail = await b.page(`/app/einvoice/${id}`);
    expect(detail.html).toContain("sandbox result");

    // the Arabic invoice shows the Arabic legal and customer names
    const ar = await b.page(`/app/invoices/${inv.id}?lang=ar`);
    expect(ar.html).toContain("شركة العرض"); expect(ar.html).toContain("عميل الشاشة");
    expect((await b.page(`/app/invoices/${inv.id}`)).html).toContain("Screen Logistics LLC");
    expect(await verifyInvariants(db)).toEqual([]);
  });
});
