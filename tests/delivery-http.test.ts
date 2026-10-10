import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createDriver } from "../src/ops/transport.js";
import { invite } from "../src/ops/team.js";
import { resetThrottle } from "../src/platform/auth.js";
import { config } from "../src/config.js";
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
  async json(path: string, body: unknown, withCsrf = true) {
    return this.req(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(withCsrf ? { "x-csrf-token": await this.csrf() } : {}) } });
  }
  async login(email: string, password: string) { return this.post("/login", { email, password }); }
  async page(path: string) { const r = await this.get(path); return { status: r.status, html: await r.text(), location: r.headers.get("location") }; }
}

const D = "/app/delivery";
const flash = (loc: string | null) => decodeURIComponent(new URL(loc!, "http://x").searchParams.get("ok") ?? new URL(loc!, "http://x").searchParams.get("err") ?? "");

async function company() {
  resetThrottle();
  const t = await newTenant(db, undefined, ["courier-last-mile"]);
  const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
  const ids = await db.tenant(t.tenantId, async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Desert Threads" });
    const rider = await createDriver(c, t.ctx, { name: "Rashid" });
    const tok = await invite(c, t.ctx, { email: `rider-${Date.now()}-${Math.random()}@example.com`, roles: ["driver"], driver_id: rider });
    return { merchant, rider, tok };
  });
  const office = new Browser();
  expect((await office.login(email, "correct horse battery")).status).toBe(302);
  // the rider accepts the invitation on their own phone
  const phone = new Browser();
  const acc = await phone.post(`/invite/${ids.tok}`, { name: "Rashid", password: "rider-password-1" });
  expect(acc.status).toBe(302);
  return { t, office, phone, ...ids };
}

describe("Delivery over HTTP", () => {
  it("is fenced to the Courier sector, every office page renders, and the checklist matches the sector", async () => {
    const o = await company();
    for (const p of ["", "/shipments", "/shipments/new", "/shipments/import", "/runs", "/runs/new", "/riders", "/cash", "/billing"]) {
      expect((await o.office.page(D + p)).status, p).toBe(200);
    }
    const home = (await o.office.page("/app")).html;
    expect(home).toContain("Add a rider"); expect(home).not.toContain("Prepare a quotation");
    expect((await o.office.page("/app/billing")).html).toContain("Parcels this month");
    const other = new Browser();
    await other.post("/start", { company: "Fwd Co", contact: "F", email: `fwd-${Date.now()}@example.com`, password: "correct horse battery", sector: "freight-forwarding", country: "AE", emirate: "Dubai", goal: "Just exploring" });
    expect((await other.page(D)).html).toContain("Courier / last mile is not selected");
  });

  it("parcel → run → rider delivers on the phone → cash desk → payout, end to end through the forms and the offline sync endpoint", async () => {
    const o = await company(), b = o.office;
    // parcels: one by form, one by CSV
    const created = await b.post(`${D}/shipments`, { merchant_id: o.merchant, external_ref: "SHOP-1", consignee_name: "Aisha", consignee_phone: "0501112222", address: "Marina Walk 12", emirate: "Dubai", origin_emirate: "Dubai", cod: "120.00", require_code: "1" });
    expect(created.status).toBe(302);
    const parcelUrl = created.headers.get("location")!.split("?")[0];
    expect(flash(created.headers.get("location"))).toMatch(/Parcel DLV-\d{4}-00001 saved/);
    const dup = await b.post(`${D}/shipments`, { merchant_id: o.merchant, external_ref: "SHOP-1", consignee_name: "x", address: "y", emirate: "Dubai" });
    expect(flash(dup.headers.get("location"))).toMatch(/already exists as DLV-/);
    const imp = await b.upload(`${D}/shipments/import`, { merchant_id: o.merchant }, { name: "p.csv", text: "external_ref,consignee_name,address,emirate,cod\nSHOP-2,Noura,Majaz,Sharjah,75\nSHOP-3,Bad,Nowhere,Gotham,1\n" });
    expect(flash(imp.headers.get("location"))).toMatch(/Created 1.*1 row\(s\) rejected/);
    const list = await b.page(`${D}/shipments`);
    expect(list.html).toContain("SHOP-1"); expect(list.html).toContain("SHOP-2");
    expect((await b.page(`${D}/shipments?q=Noura`)).html).not.toContain("SHOP-1");

    // run
    const ids = (await db.query<any>(`SELECT id, external_ref FROM dlv_shipments ORDER BY created_at`)).rows;
    const s1 = ids.find((x) => x.external_ref === "SHOP-1").id, s2 = ids.find((x) => x.external_ref === "SHOP-2").id;
    const run = await b.post(`${D}/runs`, { driver_id: o.rider, shipment_ids: [s1, s2] });
    const runUrl = run.headers.get("location")!.split("?")[0];
    expect(flash(run.headers.get("location"))).toMatch(/Run RUN-/);
    const planned = await o.phone.page(`/app/driver/runs/${runUrl.split("/").pop()}`);               // visible, but no consignee data or cash until sent out
    expect(planned.html).toContain("not started yet"); expect(planned.html).not.toContain("Marina Walk"); expect(planned.html).not.toContain("0501112222");
    expect(flash((await b.post(`${runUrl}/start`, {})).headers.get("location"))).toMatch(/rider can now see/);

    // the rider's phone
    const home = await o.phone.page("/app/driver");
    expect(home.html).toContain("Open run");
    const riderRun = `/app/driver/runs/${runUrl.split("/").pop()}`;
    const rp = await o.phone.page(riderRun);
    expect(rp.status).toBe(200);
    expect(rp.html).toContain("Collect AED 120.00 in cash"); expect(rp.html).toContain("Delivery code");
    expect(rp.html).not.toContain("Desert Threads");
    // a rider has no office access
    expect((await o.phone.get(`${D}`)).headers.get("location")).toBe("/app/driver");
    expect((await o.phone.get(`/app/delivery/cash`)).headers.get("location")).toBe("/app/driver");

    const code = (await db.query<any>(`SELECT delivery_code FROM dlv_shipments WHERE id=$1`, [s1])).rows[0].delivery_code;
    // plain form path: wrong cash is explained, right cash without the code is refused
    const evid = () => `ev-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const f = (extra: Record<string, string>) => ({ kind: "deliver", client_event_id: evid(), device_time: new Date().toISOString(), p_name: "Aisha", ...extra });
    expect(flash((await o.phone.post(`/app/driver/parcels/${s1}/event`, f({ p_cash: "100", p_code: code }))).headers.get("location"))).toMatch(/collect exactly AED 120\.00/);
    expect(flash((await o.phone.post(`/app/driver/parcels/${s1}/event`, f({ p_cash: "120" }))).headers.get("location"))).toMatch(/code is missing or wrong/);
    expect(flash((await o.phone.post(`/app/driver/parcels/${s1}/event`, f({ p_cash: "120", p_code: code }))).headers.get("location"))).toBe("Saved.");

    // offline queue path: JSON batch, replayed twice
    const batch = { events: [{ client_event_id: evid(), shipment_id: s2, kind: "deliver", device_time: new Date().toISOString(), payload: { name: "Noura", cash: "75" } }] };
    const r1 = await (await o.phone.json("/app/driver/sync", batch)).json() as any;
    const r2 = await (await o.phone.json("/app/driver/sync", batch)).json() as any;
    expect(r1.results[0].outcome).toBe("applied"); expect(r2.results[0].outcome).toBe("duplicate");
    expect((await o.phone.json("/app/driver/sync", batch, false)).status).toBe(403);               // CSRF header required
    expect((await o.phone.page("/app/driver")).html).toContain("Cash on you: AED 195.00");

    // close the run, count the cash
    expect(flash((await b.post(`${runUrl}/close`, {})).headers.get("location"))).toMatch(/Run closed/);
    const cash = await b.page(`${D}/cash`);
    expect(cash.html).toContain("Rashid"); expect(cash.html).toContain("195.00");
    const short = await b.post(`${D}/cash/settle`, { driver_id: o.rider, counted: "190", note: "" });
    expect(flash(short.headers.get("location"))).toMatch(/note explaining the difference/);
    expect(flash((await b.post(`${D}/cash/settle`, { driver_id: o.rider, counted: "195.00" })).headers.get("location"))).toMatch(/counted in, no difference/);

    // set a rate, pay the merchant with fees netted
    expect(flash((await b.post(`${D}/billing/rate`, { merchant_id: o.merchant, delivery: "10", cod_fee_pct: "2", tax_code: "SR5" })).headers.get("location"))).toMatch(/Rate saved; 5 earlier line/);
    const rem = await b.post(`${D}/cash/remit`, { merchant_id: o.merchant, net_fees: "1" });
    expect(flash(rem.headers.get("location"))).toMatch(/pay the merchant AED 169\.\d\d/);
    const remUrl = rem.headers.get("location")!.split("?")[0];
    const stmt = await b.page(remUrl);
    expect(stmt.status).toBe(200); expect(stmt.html).toContain("Desert Threads"); expect(stmt.html).toContain("DLV-");
    // the owner prepared it, and the owner may confirm it (single-user tenant)
    const remId = remUrl.split("/").pop()!;
    expect(flash((await b.post(`${D}/cash/remittances/${remId}/pay`, { reference: "" })).headers.get("location"))).toMatch(/reference is required/);
    expect(flash((await b.post(`${D}/cash/remittances/${remId}/pay`, { reference: "FAB-1" })).headers.get("location"))).toMatch(/Payout recorded/);
    expect((await b.page(parcelUrl)).html).toContain("paid out in REM-");
    expect((await b.page(`/app/invoices`)).html).toContain("Delivery activity");
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("the public tracking page needs no login and reveals no personal data", async () => {
    const o = await company();
    await o.office.post(`${D}/shipments`, { merchant_id: o.merchant, consignee_name: "Private Person", consignee_phone: "0509876543", address: "Hidden Villa 9", emirate: "Ajman", cod: "33" });
    const token = (await db.query<any>(`SELECT track_token FROM dlv_shipments ORDER BY created_at DESC LIMIT 1`)).rows[0].track_token;
    const anon = new Browser();
    const r = await anon.page(`/t/${token}`);
    expect(r.status).toBe(200);
    expect(r.html).toContain("Desert Threads"); expect(r.html).toContain("AED 33.00"); expect(r.html).toContain("Order received by the courier");
    for (const secret of ["Private Person", "0509876543", "Hidden Villa"]) expect(r.html).not.toContain(secret);
    expect((await anon.page("/t/not-a-real-token-123")).status).toBe(404);
    expect((await anon.page("/t/x")).status).toBe(404);
  });

  it("tracking lookups are rate limited per client address (taken only from the header the deployment trusts)", async () => {
    resetThrottle();
    const o = await company();
    await o.office.post(`${D}/shipments`, { merchant_id: o.merchant, consignee_name: "x", address: "y", emirate: "Dubai" });
    const token = (await db.query<any>(`SELECT track_token FROM dlv_shipments ORDER BY created_at DESC LIMIT 1`)).rows[0].track_token;
    const saved = config.trustProxy;
    config.trustProxy = "cloudflare";
    try {
      const hit = (ip: string) => app.request(`/t/${token}`, { headers: { "cf-connecting-ip": ip } });
      for (let i = 0; i < 60; i++) expect((await hit("203.0.113.9")).status).toBe(200);
      expect((await hit("203.0.113.9")).status).toBe(429);
      expect((await hit("203.0.113.10")).status).toBe(200);                                  // another address is unaffected
      config.trustProxy = "";
      expect((await app.request(`/t/${token}`, { headers: { "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "203.0.113.9" } })).status).toBe(200);   // spoofable headers are ignored
    } finally { config.trustProxy = saved; resetThrottle(); }
  });

  it("CSRF is required, roles are fenced, and another tenant gets a 404 for the same URL", async () => {
    const o = await company(), b = o.office;
    expect((await b.post(`${D}/shipments`, { merchant_id: o.merchant, consignee_name: "x", address: "y", emirate: "Dubai" }, false)).status).toBe(403);
    const made = await b.post(`${D}/shipments`, { merchant_id: o.merchant, consignee_name: "x", address: "y", emirate: "Dubai" });
    const url = made.headers.get("location")!.split("?")[0];
    const p2 = await company();
    expect((await p2.office.page(url)).status).toBe(404);
    const foreign = await p2.office.post(`${url}/cancel`, {});
    expect(flash(foreign.headers.get("location"))).toMatch(/not found/i);
    expect((await db.query<any>(`SELECT status FROM dlv_shipments WHERE id=$1`, [url.split("/").pop()])).rows[0].status).toBe("new");
  });
});
