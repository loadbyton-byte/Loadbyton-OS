import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
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
  async post(path: string, fields: Record<string, string>) {
    const body = new URLSearchParams({ _csrf: await this.csrf(), ...fields });
    return this.req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  async upload(path: string, fields: Record<string, string>, file: { name: string; text: string }) {
    const fd = new FormData();
    fd.set("_csrf", await this.csrf());
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("file", new File([file.text], file.name, { type: "application/pdf" }));
    return this.req(path, { method: "POST", body: fd });
  }
  async login(email: string, password: string) { return this.post("/login", { email, password }); }
  async page(path: string) { const r = await this.get(path); return { status: r.status, html: await r.text(), location: r.headers.get("location") }; }
}
const K = "/app/customs";
const flash = (loc: string | null) => decodeURIComponent(new URL(loc!, "http://x").searchParams.get("ok") ?? new URL(loc!, "http://x").searchParams.get("err") ?? "");

async function company(sectors = ["customs-brokerage"]) {
  resetThrottle();
  const t = await newTenant(db, undefined, sectors);
  const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
  const party = await db.tenant(t.tenantId, (c) => createParty(c, t.ctx, { kind: "customer", name: "Acme Imports LLC" }));
  const office = new Browser();
  expect((await office.login(email, "correct horse battery")).status).toBe(302);
  return { t, office, party };
}

describe("Customs over HTTP", () => {
  it("is fenced to the Customs sector and every page renders", async () => {
    const o = await company();
    for (const p of ["", "/cases", "/cases/new", "/deposits"]) expect((await o.office.page(K + p)).status, p).toBe(200);
    expect((await o.office.page("/app")).html).toContain("Create the first customs case");
    const other = await company(["freight-forwarding"]);
    expect((await other.office.page(K)).html).toContain("Customs brokerage is not selected");
  });

  it("runs a case from creation to handover with evidence and a printable pack", async () => {
    const o = await company();
    const cr = await o.office.post(`${K}/cases`, { party_id: o.party, direction: "import", mode: "sea", currency: "USD", fx_rate: "3.6725", freight: "400", transport_ref: "MAEU1", customs_office: "Jebel Ali", origin_country: "CN", destination_country: "AE" });
    const id = cr.headers.get("location")!.split("/").pop()!.split("?")[0];
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const ln = await o.office.post(`${K}/cases/${id}/lines`, { description: "Laptops", hs_code: "8471.30.10", qty: "10", value: "1000", duty_pct: "5", vat_pct: "5" });
    expect(flash(ln.headers.get("location"))).toContain("Line added");
    let page = (await o.office.page(`${K}/cases/${id}`)).html;
    expect(page).toContain("8471.30.10"); expect(page).toContain("Before this can go for approval");
    // bad HS code is refused with a message, not a crash
    const bad = await o.office.post(`${K}/cases/${id}/lines`, { description: "X", hs_code: "12", qty: "1", value: "10" });
    expect(flash(bad.headers.get("location"))).not.toBe("");
    // cannot go to review without evidence
    const early = await o.office.post(`${K}/cases/${id}/review`, {});
    expect(flash(early.headers.get("location"))).toMatch(/missing|evidence|document/i);
    // upload every mandatory item
    const items = (await db.tenant(o.t.tenantId, (c) => c.query<any>(`SELECT id,kind FROM cus_checklist WHERE case_id=$1 AND mandatory AND status='missing'`, [id]))).rows;
    for (const it of items) {
      const up = await o.office.upload(`${K}/cases/${id}/evidence`, { item_id: it.id, kind: it.kind, title: it.kind }, { name: `${it.kind}.pdf`, text: `%PDF-1.4 ${it.id}` });
      expect(flash(up.headers.get("location")), it.kind).toContain("stored");
    }
    expect(flash((await o.office.post(`${K}/cases/${id}/review`, {})).headers.get("location"))).toContain("approval");
    expect(flash((await o.office.post(`${K}/cases/${id}/approve`, {})).headers.get("location"))).toContain("Approved");
    const pack = await o.office.page(`${K}/cases/${id}/pack`);
    expect(pack.status).toBe(200); expect(pack.html).toContain("Not a customs declaration"); expect(pack.html).toContain("Laptops");
    const csv = await o.office.get(`${K}/cases/${id}/lines.csv`);
    expect(csv.headers.get("content-type")).toContain("text/csv"); expect(await csv.text()).toContain("84713010");
    const sub = await o.office.post(`${K}/cases/${id}/submit`, { channel: "dubai_trade", declaration_no: "DT-100" });
    expect(flash(sub.headers.get("location"))).toContain("Submission recorded");
    expect((await o.office.page(`${K}/cases`)).html).toContain("DT-100");
    expect((await o.office.page(K)).status).toBe(200);
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("refuses writes without a CSRF token and records deposits", async () => {
    const o = await company();
    const noCsrf = await o.office.req(`${K}/cases`, { method: "POST", body: new URLSearchParams({ party_id: o.party }), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(noCsrf.status).toBe(403);
    const d = await o.office.post(`${K}/deposits`, { party_id: o.party, kind: "cash_deposit", amount: "5000", reference: "DEP-1" });
    expect(flash(d.headers.get("location"))).toBe("Recorded.");
    expect((await o.office.page(`${K}/deposits`)).html).toContain("DEP-1");
  });
});
