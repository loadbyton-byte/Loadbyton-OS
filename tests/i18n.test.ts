import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { convertedJob } from "./helpers.js";
import { invoiceJob } from "../src/ops/finance.js";
import { coverage, localisePage, translateHtml } from "../src/lib/i18n.js";
import { AR } from "../src/lib/i18n-ar.js";
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

const SECTORS = ["freight-forwarding", "road-transport", "ecommerce-fulfilment", "contract-warehouse-3pl", "courier-last-mile", "customs-brokerage"];
const PAGES = ["/app", "/app/enquiries", "/app/enquiries/new", "/app/quotes", "/app/quotes/new", "/app/parties", "/app/rates", "/app/jobs", "/app/invoices", "/app/documents", "/app/tasks", "/app/reports",
  "/app/team", "/app/billing", "/app/settings", "/app/connections", "/app/privacy", "/app/api-keys", "/app/inbox", "/app/inbox-channels", "/app/inbox-unmatched", "/app/assistant", "/app/document-drafts",
  "/app/document-drafts/versions", "/app/extractions", "/app/einvoice", "/app/finance/credit-notes", "/app/finance/payables", "/app/finance/fx", "/app/freight/opportunities", "/app/freight/contracts",
  "/app/freight/masters", "/app/freight/weight", "/app/management-reports", "/app/transport", "/app/transport/orders", "/app/transport/trips", "/app/transport/fleet", "/app/fulfilment", "/app/fulfilment/orders",
  "/app/fulfilment/stock", "/app/fulfilment/catalog", "/app/warehouse", "/app/warehouse/inbound", "/app/warehouse/stock", "/app/delivery", "/app/delivery/shipments", "/app/customs", "/app/customs/cases"];

describe("Arabic interface layer", () => {
  it("keeps the dictionary clean: every entry has Arabic text, no stray markup and no lost punctuation", () => {
    for (const [en, ar] of Object.entries(AR)) {
      expect(ar.trim(), en).not.toBe("");
      expect(/[<>{}]/.test(ar), en).toBe(false);
      const arabic = /[\u0600-\u06FF]/.test(ar);
      const technical = /^[A-Za-z0-9 .\/&+\-:()_·→,%]*$/.test(ar);
      expect(arabic || technical, `${en} → ${ar}`).toBe(true);
      if (en.endsWith(":")) expect(ar.endsWith(":"), en).toBe(true);
    }
    expect(Object.keys(AR).length).toBeGreaterThan(700);
  });

  it("translates whole text nodes and user-facing attributes, and leaves data, code and documents alone", () => {
    const html = `<html lang="en"><head><title>Invoices</title></head><body><nav><a href="/x" aria-label="Settings">Settings</a></nav>
      <p>  Save  </p><p>Acme Logistics LLC</p><button type="submit">Approve</button><input placeholder="Search" value="Approve"><input type="submit" value="Save"><code>Settings</code><pre>Save</pre>
      <script>var a="Save";</script><div class="print-doc"><h2>Invoice</h2><p>Total</p><div>nested</div></div><p>Total</p><span data-notranslate>Save</span></body></html>`;
    const out = translateHtml(html);
    expect(out).toContain(`aria-label="${AR["Settings"]}">${AR["Settings"]}</a>`);
    expect(out).toContain(`<p>  ${AR["Save"]}  </p>`);
    expect(out).toContain("<p>Acme Logistics LLC</p>");                                  // customer data is never a dictionary key
    expect(out).toContain(`<button type="submit">${AR["Approve"]}</button>`);
    expect(out).toContain(`placeholder="${AR["Search"]}" value="Approve"`);               // only visible labels, never typed values
    expect(out).toContain(`type="submit" value="${AR["Save"]}"`);
    expect(out).toContain("<code>Settings</code>"); expect(out).toContain("<pre>Save</pre>"); expect(out).toContain('var a="Save";');
    expect(out).toContain('<div class="print-doc"><h2>Invoice</h2><p>Total</p><div>nested</div></div>');   // customer-facing documents keep their own language
    expect(out).toContain(`</div><p>${AR["Total"]}</p>`); expect(out).toContain("<span data-notranslate>Save</span>");
    const page = localisePage(html);
    expect(page).toContain('<html lang="ar" dir="rtl">'); expect(page).toContain("/assets/rtl.css");
    expect(translateHtml(out)).toBe(out);                                                   // idempotent
  });

  it("switches language by cookie, serves right-to-left pages across the application, and reports its own coverage", async () => {
    resetThrottle();
    const t = await newTenant(db, undefined, SECTORS);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const j = await convertedJob(db, t, 100000, 60000);
    await db.tenant(t.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]); await invoiceJob(c, t.ctx, j.jobId); });
    const b = new Browser();
    expect((await b.login(email, "correct horse battery")).status).toBe(302);
    const en = await b.page("/app/enquiries");
    expect(en.html).toContain('lang="en"'); expect(en.html).not.toContain("rtl.css");
    expect((await b.get("/lang/xx")).status).toBe(404);
    const sw = await b.get("/lang/ar?next=/app/enquiries");
    expect(sw.status).toBe(302); expect(sw.headers.get("location")).toBe("/app/enquiries");
    expect((await b.get("/lang/ar?next=//evil.example")).headers.get("location")).toBe("/");               // no open redirect
    const ar = await b.page("/app/enquiries");
    expect(ar.html).toContain('<html lang="ar" dir="rtl"'); expect(ar.html).toContain("/assets/rtl.css");
    expect(ar.html).toContain(AR["Enquiries"]); expect(ar.html).toContain(AR["Sign out"]);
    expect(ar.html).toContain("English");                                                                  // the switcher stays usable
    const css = await b.get("/assets/rtl.css"); expect(css.status).toBe(200);

    let total = 0, translated = 0;
    const missing = new Map<string, number>();
    for (const p of PAGES) {
      const r = await b.get(p);
      if (r.status !== 200) continue;
      const html = await r.text();
      expect(html, p).toContain('dir="rtl"');
      expect(html, p).not.toMatch(/<html[^>]*lang="en"/);
      // coverage is measured on the English source of the same page
      await b.get("/lang/en?next=/");
      const en2 = await (await b.get(p)).text();
      await b.get("/lang/ar?next=/");
      const cv = coverage(en2);
      total += cv.total; translated += cv.translated;
      for (const [k, v] of cv.missing) missing.set(k, (missing.get(k) ?? 0) + v);
    }
    const percent = Math.round((translated / total) * 1000) / 10;
    if (process.env.I18N_REPORT) (await import("node:fs")).writeFileSync("/tmp/i18n-report.txt", `COVERAGE ${percent}% (${translated}/${total})\n` + [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.I18N_REPORT)).map(([k, v]) => `${v}\t${k}`).join("\n"));
    expect(percent).toBeGreaterThanOrEqual(Number(process.env.I18N_MIN ?? 88));
  });
});
