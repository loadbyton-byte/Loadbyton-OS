import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { resetThrottle } from "../src/platform/auth.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });

/** Each page added for providers, carriers, RF, certificates and air waybills must render its own heading for a manager and refuse a signed-out visitor. */
const groups: { sectors: string[]; pages: Record<string, RegExp> }[] = [
  { sectors: ["ecommerce-fulfilment"], pages: { "/app/fulfilment/carrier-labels": /Carrier labels/, "/app/fulfilment/order-pulls": /Order pulls/, "/app/fulfilment/connectors": /Storefront connectors/ } },
  { sectors: ["contract-warehouse-3pl"], pages: { "/app/warehouse/rf-pins": /RF terminal PINs/ } },
  { sectors: ["cold-chain"], pages: { "/app/devices/certificates": /Device certificates/ } },
  { sectors: ["freight-forwarding"], pages: { "/app/freight/air-waybills": /Air waybills/ } },
];
describe("pages for providers, carriers, RF, certificates and air waybills", () => {
  for (const g of groups) it(`render for the owner of ${g.sectors.join(", ")} and redirect a signed-out visitor`, async () => {
    resetThrottle();
    const t = await newTenant(db, undefined, g.sectors);
    const email = (await db.system((c) => c.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId]))).rows[0].email;
    const jar = new Map<string, string>();
    const send = async (path: string, init: RequestInit = {}) => {
      const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
      for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
      return res;
    };
    for (const p of Object.keys(g.pages)) expect([302, 303, 401]).toContain((await app.request(p, { redirect: "manual" })).status);
    await send("/login");
    const body = new URLSearchParams({ _csrf: jar.get("lbt_csrf")!, email, password: "correct horse battery" });
    expect((await send("/login", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(302);
    for (const [p, re] of Object.entries(g.pages)) { const r = await send(p); expect([p, r.status]).toEqual([p, 200]); const html = await r.text(); if (!re.test(html)) console.log("PAGE", p, (html.match(/<h1[^>]*>[^<]*/) ?? [])[0]); expect([p, re.test(html)]).toEqual([p, true]); }
  });
});
