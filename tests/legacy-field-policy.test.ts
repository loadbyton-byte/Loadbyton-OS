import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createDriver } from "../src/ops/transport.js";
import { createShipment } from "../src/ops/delivery.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { resetThrottle } from "../src/platform/auth.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });

class Browser {
  jar = new Map<string, string>();
  private ch() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(path: string, init: RequestInit = {}) {
    const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie: this.ch() } });
    for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  }
  async login(email: string, password: string) {
    await this.req("/login");
    const body = new URLSearchParams({ _csrf: this.jar.get("lbt_csrf")!, email, password });
    return this.req("/login", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  async html(path: string) { const r = await this.req(path); return { status: r.status, html: await r.text() }; }
}

describe("per-field policy on legacy list screens", () => {
  it("shows consignee, rider and customer contact details to operators and withholds them from roles without the permission", async () => {
    resetThrottle();
    const t = await newTenant(db, undefined, ["courier-last-mile"]);
    const ownerEmail = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const finEmail = `fin-${Date.now()}@example.com`;
    const ids = await db.tenant(t.tenantId, async (c) => {
      const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Desert Threads", email: "merchant-secret@example.com", phone: "0509998888" });
      const rider = await createDriver(c, t.ctx, { name: "Rashid", phone: "0507776666" });
      const s = await createShipment(c, t.ctx, { merchant_id: merchant, external_ref: "P-1", consignee_name: "Aisha Khan", consignee_phone: "0501112222", address: "Marina Walk 12", emirate: "Dubai", origin_emirate: "Dubai" });
      const tok = await invite(c, t.ctx, { email: finEmail, roles: ["finance"] });
      return { merchant, rider, shipment: s.id as string, tok };
    });
    await acceptInvite(db, ids.tok, { name: "Fin", password: "finance-password-1" });
    const owner = new Browser(), fin = new Browser();
    expect((await owner.login(ownerEmail, "correct horse battery")).status).toBe(302);
    expect((await fin.login(finEmail, "finance-password-1")).status).toBe(302);

    for (const p of ["/app/delivery/shipments", `/app/delivery/shipments/${ids.shipment}`, "/app/delivery/riders", "/app/parties"]) {
      const r = await owner.html(p);
      expect(r.status, p).toBe(200);
    }
    expect((await owner.html("/app/delivery/shipments")).html).toContain("Aisha Khan");
    expect((await owner.html("/app/delivery/riders")).html).toContain("0507776666");
    expect((await owner.html("/app/parties")).html).toContain("merchant-secret@example.com");

    // finance can read parties' contact details (party/finance permission) but not consignee or rider contact data
    const list = await fin.html("/app/delivery/shipments");
    expect(list.status).toBe(200);
    if (list.status === 200) { expect(list.html).not.toContain("Aisha Khan"); expect(list.html).not.toContain("0501112222"); }
    const detail = await fin.html(`/app/delivery/shipments/${ids.shipment}`);
    if (detail.status === 200) { expect(detail.html).not.toContain("0501112222"); expect(detail.html).not.toContain("Marina Walk 12"); }
    const riders = await fin.html("/app/delivery/riders");
    if (riders.status === 200) expect(riders.html).not.toContain("0507776666");
    expect((await fin.html("/app/parties")).html).toContain("merchant-secret@example.com");
  });
});
