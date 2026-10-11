import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { convertedJob, future } from "./helpers.js";
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
const idFrom = (loc: string | null) => loc!.split("/").pop()!.split("?")[0];

describe("Finance bridge screens", () => {
  it("credit notes, receipt reversal, exchange rates, supplier bills and the payables report work over HTTP", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const j = await convertedJob(db, t, 100000, 60000);
    const inv = await db.tenant(t.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]); return invoiceJob(c, t.ctx, j.jobId); });
    const b = new Browser();
    expect((await b.login(email, "correct horse battery")).status).toBe(302);
    for (const p of ["/app/finance/credit-notes", "/app/finance/payables", "/app/finance/payables/report", "/app/finance/fx", `/app/invoices/${inv.id}`, `/app/invoices/${inv.id}/credit`, "/app/connections"]) expect((await b.page(p)).status, p).toBe(200);

    // credit a part of the invoice, then issue it
    let r = await b.post("/app/finance/credit-notes", { invoice_id: inv.id, mode: "full", reason: "Order cancelled" });
    expect(flash(r.headers.get("location"))).toMatch(/Draft saved/);
    const cnId = idFrom(r.headers.get("location"));
    expect((await b.page(`/app/finance/credit-notes/${cnId}`)).html).toContain("Issue credit note");
    r = await b.post(`/app/finance/credit-notes/${cnId}/issue`, {});
    expect(flash(r.headers.get("location"))).toMatch(/Issued as CN-/);
    const page = await b.page(`/app/invoices/${inv.id}`);
    expect(page.html).toContain("Credited");
    expect(page.html).not.toContain("Credit this invoice");
    expect(flash((await b.post("/app/finance/credit-notes", { invoice_id: inv.id, mode: "full", reason: "again" })).headers.get("location"))).toMatch(/credited/);

    // a second invoice: receipt then reversal
    const j2 = await convertedJob(db, t, 50000, 30000);
    const inv2 = await db.tenant(t.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j2.jobId]); return invoiceJob(c, t.ctx, j2.jobId); });
    expect(flash((await b.post(`/app/invoices/${inv2.id}/receipt`, { amount: "100.00", method: "bank transfer", reference: "HTTP-R1" })).headers.get("location"))).toMatch(/Receipt recorded/);
    const rid = (await db.query<any>(`SELECT id FROM receipts WHERE reference='HTTP-R1'`)).rows[0].id;
    expect((await b.page(`/app/invoices/${inv2.id}`)).html).toContain("Reverse");
    expect(flash((await b.post(`/app/invoices/${inv2.id}/receipt/${rid}/reverse`, { reason: "Wrong customer" })).headers.get("location"))).toMatch(/reversed/);
    expect((await b.page(`/app/invoices/${inv2.id}`)).html).toContain("Wrong customer");

    // FX rate, supplier bill with evidence, approval, payment, report
    expect(flash((await b.post("/app/finance/fx", { from_ccy: "USD", rate: "3.6725", as_of: future(-5), source: "Bank confirmation" })).headers.get("location"))).toMatch(/Proposed/);
    const fxId = (await db.query<any>(`SELECT id FROM fx_rates WHERE tenant_id=$1`, [t.tenantId])).rows[0].id;
    expect(flash((await b.post(`/app/finance/fx/${fxId}`, { decision: "approve" })).headers.get("location"))).toMatch(/Decision recorded/);
    r = await b.post("/app/finance/payables", { supplier_id: j.supplierId, supplier_ref: "HTTP-B1", currency: "USD", bill_date: future(-3), due_date: future(25), description: "Freight", net: "100.00", tax_code: "ZR0", job_cost_id: "" });
    expect(flash(r.headers.get("location"))).toMatch(/saved as a draft/);
    const billId = idFrom(r.headers.get("location"));
    expect(flash((await b.post(`/app/finance/payables/${billId}/approve`, {})).headers.get("location"))).toMatch(/Attach the supplier/);
    const doc = await db.tenant(t.tenantId, async (c) => (await import("../src/ops/documents.js")).uploadDocument(c, t.ctx, { kind: "other", title: "Supplier invoice", issuer: "Supplier", filename: "s.pdf", data: Buffer.from("%PDF-1.4 sup") }));
    expect(flash((await b.post(`/app/finance/payables/${billId}/document`, { document_id: doc })).headers.get("location"))).toMatch(/Evidence attached/);
    expect(flash((await b.post(`/app/finance/payables/${billId}/approve`, {})).headers.get("location"))).toMatch(/Bill approved/);
    expect(flash((await b.post(`/app/finance/payables/${billId}/pay`, { amount: "40.00", paid_on: future(-1), method: "wire", reference: "W" })).headers.get("location"))).toMatch(/Payment recorded/);
    const rep = await b.page("/app/finance/payables/report");
    expect(rep.html).toContain("VB-");
    expect(rep.html).toContain("Stored balances agree");
    // receipt posting toggle needs a connection first
    expect(flash((await b.post("/app/connections/receipts", { enabled: "1" })).headers.get("location"))).toMatch(/Connect the accounting system first/);
    expect(await verifyInvariants(db)).toEqual([]);
  });
});
