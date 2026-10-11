import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { config } from "../src/config.js";
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

describe("ledger and statement-feed screens", () => {
  it("enables the ledger, posts a manual entry through two people, and manages a statement feed", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const b = new Browser();
    expect((await b.login(email, "correct horse battery")).status).toBe(302);
    expect((await b.page("/app/finance/ledger")).html).toContain("Enable the ledger");
    expect(flash((await b.post("/app/finance/ledger/enable", { start_date: "2999-01-01" })).headers.get("location"))).toMatch(/future/);
    expect(flash((await b.post("/app/finance/ledger/enable", { start_date: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) })).headers.get("location"))).toMatch(/enabled/);
    const page = await b.page("/app/finance/ledger");
    expect(page.status).toBe(200); expect(page.html).toContain("Trial balance"); expect(page.html).toContain("balanced");
    const accts = (await db.query<any>(`SELECT id, code FROM gl_accounts WHERE tenant_id=$1`, [t.tenantId])).rows;
    const id = (code: string) => accts.find((a: any) => a.code === code).id;
    const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    expect(flash((await b.post("/app/finance/ledger/entries", { entry_date: day, memo: "Opening cash", account_1: id("1000"), debit_1: "250", account_2: id("3000"), credit_2: "250" })).headers.get("location"))).toMatch(/proposed/);
    const e = (await db.query<any>(`SELECT id FROM gl_manual_entries WHERE tenant_id=$1`, [t.tenantId])).rows[0].id;
    expect(flash((await b.post(`/app/finance/ledger/entries/${e}/approve`, {})).headers.get("location"))).toMatch(/approved and posted/);      // the workspace owner may approve
    const acct = await b.page(`/app/finance/ledger/accounts/${id("1000")}`);
    expect(acct.status).toBe(200); expect(acct.html).toContain("250.00");
    const j = (await db.query<any>(`SELECT id FROM gl_journals WHERE tenant_id=$1`, [t.tenantId])).rows[0].id;
    expect((await b.page(`/app/finance/ledger/journals/${j}`)).html).toContain("Opening cash");

    expect((await b.page("/app/settings/feeds")).html).toContain("Live feeds are not enabled");
    const saved = config.liveFeeds.allowedHosts; config.liveFeeds.allowedHosts = ["bank.example.test"];
    try {
      expect((await b.page("/app/settings/feeds")).html).toContain("Add a feed");
      expect(flash((await b.post("/app/settings/feeds", { label: "Bad", kind: "bank", url: "https://evil.example.test/x", secret: "s", auth_scheme: "bearer" })).headers.get("location"))).toMatch(/not a permitted/);
      expect(flash((await b.post("/app/settings/feeds", { label: "Main", kind: "bank", url: "https://bank.example.test/v1", secret: "tok", auth_scheme: "bearer", amount_unit: "major" })).headers.get("location"))).toMatch(/Feed saved/);
      const html = (await b.page("/app/settings/feeds")).html;
      expect(html).toContain("Main"); expect(html).not.toContain("tok<");
    } finally { config.liveFeeds.allowedHosts = saved; }
    expect(await verifyInvariants(db)).toEqual([]);
  });
});
