import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createLocation, createSku } from "../src/ops/fulfilment.js";
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

const F = "/app/fulfilment";
const flash = (loc: string | null) => decodeURIComponent(new URL(loc!, "http://x").searchParams.get("ok") ?? new URL(loc!, "http://x").searchParams.get("err") ?? "");
async function owner() {
  resetThrottle();
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
  const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
  const ids = await db.tenant(t.tenantId, async (c) => {
    const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Desert Threads" });
    const A = await createLocation(c, t.ctx, { code: "A-01" });
    const tee = await createSku(c, t.ctx, { party_id: merchant, code: "TEE-M", name: "T-shirt M", barcode: "6291000000011" });
    return { merchant, A, tee };
  });
  const b = new Browser();
  expect((await b.login(email, "correct horse battery")).status).toBe(302);
  return { t, b, email, ...ids };
}


describe("new fulfilment screens over HTTP", () => {
  it("render, and the form posts for sites, kits, cartons, zones and waves work end to end", async () => {
    const o = await owner();
    for (const p of ["lots", "sites", "sites/transfers/new", "waves", "kits", "cartons", "locations", "catalog", "stock", "adjustments", "pick", "daily-storage"])
      expect((await o.b.page(`${F}/${p}`)).status, p).toBe(200);
    expect((await o.b.post(`${F}/sites`, { code: "DXB", name: "Dubai" })).status).toBe(302);
    expect((await o.b.page(`${F}/sites`)).html).toContain("DXB");
    expect((await o.b.post(`${F}/location-zone`, { location_code: "a-01", zone: "fast" })).status).toBe(302);
    expect(flash((await o.b.post(`${F}/cartons`, { code: "bx", l: "300", w: "200", h: "150", max_weight_g: "5000" })).headers.get("location"))).toMatch(/Carton type saved/);
    expect((await o.b.page(`${F}/cartons`)).html).toContain("BX");
    await db.tenant(o.t.tenantId, async (c) => { await createSku(c, o.t.ctx, { party_id: o.merchant, code: "PART", name: "Part" }); });
    const kit = await o.b.post(`${F}/kits`, { sku_code: "TEE-M", mode: "virtual", components: "PART, 2" });
    expect(flash(kit.headers.get("location"))).toMatch(/Kit saved/);
    expect((await o.b.page(`${F}/kits`)).html).toContain("Virtual bundle");
    expect(flash((await o.b.post(`${F}/waves`, { strategy: "zone" })).headers.get("location"))).toMatch(/No allocated orders/);
    expect((await o.b.page(`${F}/catalog?q=tee`)).html).toContain("TEE-M");
    expect(await verifyInvariants(db)).toEqual([]);
  });
});
