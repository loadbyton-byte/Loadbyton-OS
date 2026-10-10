import { describe, it, expect, beforeAll } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import type { Db, Conn } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { permsFor, type Ctx } from "../src/lib/perms.js";
import { createParty } from "../src/ops/crm.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { addToRun, applyRiderEvent, cancelShipment, closeRun, confirmReturned, createRemittance, createRider, createRun, createShipment, payRemittance, returnToSender, settleRider, startRun } from "../src/ops/delivery.js";
import { authenticateApiKey, createApiKey, normalizeUaeMobile, revokeApiKey, setNotifySms, setWebhook } from "../src/ops/delivery-notify.js";
import { deliveryNotifyHandlers, signWebhook, twilioSms, type SmsSender } from "../src/adapters/delivery-notify.js";
import { drainOutbox } from "../src/platform/outbox.js";
import { isPrivateAddress, postJson, validateWebhookUrl } from "../src/lib/safe-http.js";
import { seal, unseal } from "../src/lib/seal.js";
import { resetThrottle } from "../src/platform/auth.js";
import { resetRateLimits } from "../src/lib/ratelimit.js";
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
  async csrf() { await this.req("/login"); return this.jar.get("lbt_csrf")!; }
  async post(path: string, fields: Record<string, string | string[]>) {
    const body = new URLSearchParams({ _csrf: await this.csrf() });
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return this.req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  async page(path: string) { const r = await this.req(path); return { status: r.status, html: await r.text(), location: r.headers.get("location") }; }
}

let n = 0;
async function company() {
  resetThrottle(); resetRateLimits();
  const t = await newTenant(db, undefined, ["courier-last-mile"]);
  const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
  const ids = await db.tenant(t.tenantId, async (c) => {
    const shop = await createParty(c, t.ctx, { kind: "customer", name: "Souq Shop" });
    const other = await createParty(c, t.ctx, { kind: "customer", name: "Other Merchant" });
    const rider = await createRider(c, t.ctx, { name: "Rashid" });
    const tok = await invite(c, t.ctx, { email: `rider-${Date.now()}-${++n}@x.com`, roles: ["driver"], driver_id: rider });
    return { shop, other, rider, tok };
  });
  const acc = await acceptInvite(db, ids.tok, { name: "Rider", password: "rider-password-1" });
  const riderCtx: Ctx = { userId: acc.userId, tenantId: t.tenantId, roles: ["driver"], perms: permsFor(["driver"]), partyId: null, driverId: ids.rider, readOnly: false, supportStaffId: null };
  const run = <T>(fn: (c: Conn) => Promise<T>) => db.tenant(t.tenantId, fn);
  const key = async (merchant = ids.shop, name = "k") => (await run((c) => createApiKey(c, t.ctx, { merchant_id: merchant, name }))).key;
  return { t, email, ...ids, riderCtx, run, key };
}
type Co = Awaited<ReturnType<typeof company>>;
const api = (key: string | null, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const parcel = { reference: "ORD-1", consignee_name: "Aisha", consignee_phone: "050 123 4567", address: "Villa 4, Al Barsha", emirate: "Dubai", cod: 249.5 };

describe("merchant API", () => {
  it("authenticates by hashed key, shows the key once, and refuses missing, wrong and revoked keys", async () => {
    const co = await company();
    const key = await co.key();
    expect(key).toMatch(/^lbtk_[A-Za-z0-9_-]{40}$/);
    const stored = (await db.query<any>(`SELECT * FROM dlv_api_keys WHERE tenant_id=$1`, [co.t.tenantId])).rows[0];
    expect(JSON.stringify(stored)).not.toContain(key);                                              // only a hash and a short prefix are kept
    expect(stored.prefix).toBe(key.slice(0, 12)); expect(stored.key_hash).toBe(crypto.createHash("sha256").update(key).digest("hex"));
    expect((await api(key, "GET", "/parcels")).status).toBe(200);
    for (const bad of [null, "lbtk_" + "x".repeat(40), "Bearer", "not-a-key"]) {
      const r = await api(bad, "GET", "/parcels");
      expect(r.status).toBe(401); expect(r.headers.get("www-authenticate")).toContain("Bearer"); expect(await r.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
    const id = stored.id;
    await co.run((c) => revokeApiKey(c, co.t.ctx, id));
    expect((await api(key, "GET", "/parcels")).status).toBe(401);
    expect(await authenticateApiKey(db, key)).toBeNull();
    for (let i = 0; i < 5; i++) await co.key(co.shop, `k${i}`);
    await expect(co.key(co.shop, "sixth")).rejects.toThrow(/at most 5 active keys/);
  });

  it("creates parcels idempotently on the merchant reference, validates input with JSON errors, and ignores cookies and CSRF", async () => {
    const co = await company(), key = await co.key();
    const a = await api(key, "POST", "/parcels", parcel);
    expect(a.status).toBe(201);
    const A = await a.json() as any;
    expect(A).toMatchObject({ reference: "ORD-1", status: "new", emirate: "Dubai", cod: { amount: 249.5, currency: "AED" }, created: true, delivery_code: null });
    expect(A.waybill).toMatch(/^DLV-\d{4}-00001$/); expect(A.tracking_url).toMatch(/\/t\/[A-Za-z0-9_-]{12,}$/);
    const b = await api(key, "POST", "/parcels", parcel);
    expect(b.status).toBe(200); expect(await b.json()).toMatchObject({ waybill: A.waybill, created: false });
    expect((await db.query<any>(`SELECT count(*)::int n FROM dlv_shipments WHERE tenant_id=$1`, [co.t.tenantId])).rows[0].n).toBe(1);
    const bad = async (body: unknown, msg: RegExp, status = 400) => { const r = await api(key, "POST", "/parcels", body); expect(r.status).toBe(status); expect(((await r.json()) as any).error.message).toMatch(msg); };
    await bad({ ...parcel, reference: "X", emirate: "Gotham" }, /Emirate must be one of/);
    await bad({ ...parcel, reference: "Y", cod: 60000 }, /cod/);
    await bad({ ...parcel, reference: "Z", surprise: 1 }, /Unrecognized key|surprise/);
    await bad({ reference: "Q" }, /consignee_name/);
    const notJson = await app.request("/api/v1/parcels", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{oops" });
    expect(notJson.status).toBe(400); expect(await notJson.json()).toMatchObject({ error: { code: "invalid_json" } });
    expect((await app.request("/api/v1/nope", { headers: { authorization: `Bearer ${key}` } })).status).toBe(404);
    const withRequireCode = await (await api(key, "POST", "/parcels", { ...parcel, reference: "ORD-2", cod: "10.50", require_code: true })).json() as any;
    expect(withRequireCode.delivery_code).toMatch(/^\d{4}$/);                                       // the merchant must be able to tell its customer
    await expect(co.run((c) => createShipment(c, { ...co.t.ctx, readOnly: true }, { merchant_id: co.shop, consignee_name: "x", address: "y", emirate: "Dubai" }))).rejects.toThrow();
  });

  it("a key sees and touches only its own merchant's parcels; list pages; get by waybill or reference; cancel only before dispatch", async () => {
    const co = await company();
    const kShop = await co.key(co.shop), kOther = await co.key(co.other);
    for (let i = 1; i <= 3; i++) await api(kShop, "POST", "/parcels", { ...parcel, reference: `S-${i}`, cod: undefined });
    const mine = await (await api(kOther, "POST", "/parcels", { ...parcel, reference: "S-1" })).json() as any;      // same reference, other merchant: a different parcel
    expect(mine.created).toBe(true);
    const list = await (await api(kShop, "GET", "/parcels?limit=2")).json() as any;
    expect(list.data.map((p: any) => p.reference)).toEqual(["S-3", "S-2"]);
    const next = await (await api(kShop, "GET", `/parcels?limit=2&before=${list.next_before}`)).json() as any;
    expect(next.data.map((p: any) => p.reference)).toEqual(["S-1"]); expect(next.next_before).toBeNull();
    expect((await (await api(kOther, "GET", "/parcels")).json() as any).data).toHaveLength(1);
    expect((await api(kShop, "GET", "/parcels?status=bogus")).status).toBe(400);
    const one = await (await api(kShop, "GET", "/parcels/S-2")).json() as any;
    expect((await (await api(kShop, "GET", `/parcels/${one.waybill}`)).json() as any).reference).toBe("S-2");
    expect(one.history.map((h: any) => h.event)).toEqual(["Order received by the courier"]);
    expect((await api(kOther, "GET", `/parcels/${one.waybill}`)).status).toBe(404);                // another merchant's waybill is simply not found
    expect((await api(kOther, "POST", `/parcels/${one.waybill}/cancel`)).status).toBe(404);
    expect((await (await api(kShop, "POST", `/parcels/${one.waybill}/cancel`)).json() as any).status).toBe("cancelled");
    const out = await co.run(async (c) => { const p = await createShipment(c, co.t.ctx, { merchant_id: co.shop, consignee_name: "x", address: "y", emirate: "Dubai" }); const r = await createRun(c, co.t.ctx, { driver_id: co.rider, shipment_ids: [p.id] }); await startRun(c, co.t.ctx, r.id); return p; });
    const c2 = await api(kShop, "POST", `/parcels/${out.no}/cancel`);
    expect(c2.status).toBe(400); expect(((await c2.json()) as any).error.message).toMatch(/cannot be cancelled/);
  });

  it("rate limits per key (120/min), reports a tenant without the module, and a cancelled subscription is read-only", async () => {
    const co = await company(), key = await co.key();
    let last = 200;
    for (let i = 0; i < 121; i++) last = (await api(key, "GET", "/parcels?limit=1")).status;
    expect(last).toBe(429);
    const other = await company(); const k2 = await other.key();
    expect((await api(k2, "GET", "/parcels?limit=1")).status).toBe(200);                              // another key is unaffected
    await db.system((c) => c.query(`DELETE FROM tenant_sectors WHERE tenant_id=$1`, [other.t.tenantId]));
    const r = await api(k2, "GET", "/parcels"); expect(r.status).toBe(403); expect(((await r.json()) as any).error.message).toMatch(/not enabled the courier module/);
    const third = await company(), k3 = await third.key();
    await db.system((c) => c.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`, [third.t.tenantId]));
    expect((await api(k3, "GET", "/parcels")).status).toBe(200);
    expect((await api(k3, "POST", "/parcels", parcel)).status).toBe(402);                          // read-only workspace: can read, cannot create
    await db.system((c) => c.query(`UPDATE tenants SET status='suspended' WHERE id=$1`, [third.t.tenantId]));
    expect((await api(k3, "GET", "/parcels")).status).toBe(401);
    resetRateLimits();
  });

  it("lists the merchant's COD payouts", async () => {
    const co = await company(), key = await co.key();
    await co.run(async (c) => {
      const p = await createShipment(c, co.t.ctx, { merchant_id: co.shop, consignee_name: "x", address: "y", emirate: "Dubai", cod: "100" });
      const r = await createRun(c, co.t.ctx, { driver_id: co.rider, shipment_ids: [p.id] }); await startRun(c, co.t.ctx, r.id);
      await applyRiderEvent(c, co.riderCtx, { client_event_id: `ev-${crypto.randomUUID()}`, shipment_id: p.id, kind: "deliver", device_time: new Date().toISOString(), payload: { name: "Aisha", cash: "100" } });
      await settleRider(c, co.t.ctx, co.rider, { counted: "100" });
      await createRemittance(c, co.t.ctx, co.shop);
    });
    const r = await (await api(key, "GET", "/remittances")).json() as any;
    expect(r.data).toEqual([expect.objectContaining({ status: "being_prepared", parcels: 1, cod_collected: 100, paid_to_you: 100, currency: "AED", bank_reference: null })]);
  });
});

describe("merchant webhooks", () => {
  const body = (calls: any[]) => JSON.parse(calls[calls.length - 1].body);
  async function hooked(co: Co) {
    const r = await co.run((c) => setWebhook(c, co.t.ctx, { merchant_id: co.shop, url: "https://merchant.example.com/hooks/lbt", active: true }));
    return r.secret!;
  }
  const drain = async (post: (u: string, b: string, h: Record<string, string>) => Promise<{ status: number; body: string }>) => {
    await db.query(`UPDATE outbox SET next_at=now() WHERE status='pending'`);
    return drainOutbox(db, deliveryNotifyHandlers(db, { post: post as any }));
  };
  const ok = (calls: any[]) => async (url: string, b: string, h: Record<string, string>) => { calls.push({ url, body: b, headers: h }); return { status: 200, body: "ok" }; };

  it("validates the address, shows the secret once and stores it sealed; rotating replaces it", async () => {
    const co = await company();
    for (const [url, why] of [["http://merchant.example.com/h", /https/], ["https://127.0.0.1/h", /public host name/], ["https://localhost/h", /public host name/], ["https://10.0.0.5/h", /public host name/],
      ["https://user:pw@merchant.example.com/h", /credentials/], ["https://merchant.example.com:22/h", /port/], ["https://printer.local/h", /public host name/], ["https://intranet/h", /public host name/], ["ftp://x.com", /https/]] as const) {
      await expect(co.run((c) => setWebhook(c, co.t.ctx, { merchant_id: co.shop, url, active: true }))).rejects.toThrow(why);
    }
    await expect(co.run((c) => setWebhook(c, co.t.ctx, { merchant_id: co.shop, url: "", active: true }))).rejects.toThrow(/Enter the https address/);
    const first = await co.run((c) => setWebhook(c, co.t.ctx, { merchant_id: co.shop, url: "https://merchant.example.com/h", active: true }));
    expect(first.secret).toMatch(/^whsec_/);
    const row = (await db.query<any>(`SELECT * FROM dlv_merchant_settings WHERE merchant_id=$1`, [co.shop])).rows[0];
    expect(row.webhook_secret_sealed).not.toContain(first.secret!); expect(unseal(row.webhook_secret_sealed)).toBe(first.secret);
    expect((await co.run((c) => setWebhook(c, co.t.ctx, { merchant_id: co.shop, url: "https://merchant.example.com/h2", active: true }))).secret).toBeNull();   // same secret kept
    const rotated = await co.run((c) => setWebhook(c, co.t.ctx, { merchant_id: co.shop, url: "https://merchant.example.com/h2", active: true, rotate: true }));
    expect(rotated.secret).not.toBe(first.secret);
    { const [v, iv, tag, ct] = seal("a webhook secret").split("."); expect(() => unseal([v, iv, tag, (ct[0] === "A" ? "B" : "A") + ct.slice(1)].join("."))).toThrow(); }                                   // tampered ciphertext is refused
    const sales = { ...co.t.ctx, roles: ["sales"], perms: permsFor(["sales"]) };
    await expect(co.run((c) => setWebhook(c, sales, { merchant_id: co.shop, url: "https://m.example.com/h", active: true }))).rejects.toThrow(/does not allow/);
  });

  it("queues one signed event per lifecycle step, atomically, and delivers it with a verifiable signature; replays are harmless", async () => {
    const co = await company();
    const secret = await hooked(co);
    const calls: any[] = [];
    await co.run(async (c) => {
      const p = await createShipment(c, co.t.ctx, { merchant_id: co.shop, external_ref: "W-1", consignee_name: "Aisha", consignee_phone: "0501112222", address: "Secret Villa", emirate: "Dubai", cod: "50", max_attempts: "2" });
      const r = await createRun(c, co.t.ctx, { driver_id: co.rider, shipment_ids: [p.id] });
      await startRun(c, co.t.ctx, r.id);
      const ev = (kind: any, payload: any) => applyRiderEvent(c, co.riderCtx, { client_event_id: `ev-${crypto.randomUUID()}`, shipment_id: p.id, kind, device_time: new Date().toISOString(), payload });
      await ev("fail", { reason: "not_home" });
      await closeRun(c, co.t.ctx, r.id);
    });
    expect(await drain(ok(calls))).toBeGreaterThanOrEqual(2);
    const types = calls.map((x) => JSON.parse(x.body).type);
    expect(types).toEqual(["parcel.out_for_delivery", "parcel.attempt_failed"]);
    const first = calls[0], parsed = JSON.parse(first.body);
    const [t, v1] = first.headers["lbt-signature"].match(/^t=(\d+),v1=([0-9a-f]{64})$/)!.slice(1);
    expect(v1).toBe(crypto.createHmac("sha256", secret).update(`${t}.${first.body}`).digest("hex"));
    expect(first.headers["lbt-event-id"]).toBe(parsed.id); expect(first.url).toBe("https://merchant.example.com/hooks/lbt");
    expect(parsed.data).toMatchObject({ reference: "W-1", status: "out_for_delivery", attempts: 0 });
    const failed = JSON.parse(calls[1].body).data;
    expect(failed).toMatchObject({ status: "undelivered", attempt: 1, max_attempts: 2, will_return: false, reason: "Consignee not available" });
    for (const c of calls) for (const pii of ["Secret Villa", "0501112222", "Aisha"]) expect(c.body).not.toContain(pii);   // consignee personal data never leaves in an event
    expect(await drain(ok(calls))).toBe(0);                                                          // each event is delivered once
    expect((await db.query<any>(`SELECT count(*)::int n FROM outbox WHERE topic='merchant.webhook'`)).rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it("covers delivered, return, cancel and payout events, with delivery attempts counted in the key so a retry never collides", async () => {
    const co = await company();
    await hooked(co);
    const calls: any[] = [];
    await co.run(async (c) => {
      const mk = (ref: string, cod?: string) => createShipment(c, co.t.ctx, { merchant_id: co.shop, external_ref: ref, consignee_name: "x", address: "y", emirate: "Sharjah", cod, max_attempts: "1" });
      const a = await mk("A", "30"), b = await mk("B"), d = await mk("D");
      const r = await createRun(c, co.t.ctx, { driver_id: co.rider, shipment_ids: [a.id, b.id] });
      await startRun(c, co.t.ctx, r.id);
      const ev = (id: string, kind: any, payload: any) => applyRiderEvent(c, co.riderCtx, { client_event_id: `ev-${crypto.randomUUID()}`, shipment_id: id, kind, device_time: new Date().toISOString(), payload });
      await ev(a.id, "deliver", { name: "Aisha", cash: "30" });
      await ev(b.id, "fail", { reason: "refused" });                                                // 1 attempt allowed: straight to return-to-sender
      await confirmReturned(c, co.t.ctx, b.id);
      await cancelShipment(c, co.t.ctx, d.id);
      await settleRider(c, co.t.ctx, co.rider, { counted: "30" });
      const rem = await createRemittance(c, co.t.ctx, co.shop);
      await payRemittance(c, co.t.ctx, rem.id, { reference: "FAB-1" });
    });
    await drain(ok(calls));
    const types = calls.map((x) => JSON.parse(x.body).type);
    expect(types).toEqual(expect.arrayContaining(["parcel.out_for_delivery", "parcel.delivered", "parcel.attempt_failed", "parcel.return_to_sender", "parcel.returned", "parcel.cancelled", "remittance.paid"]));
    expect(JSON.parse(calls.find((x) => JSON.parse(x.body).type === "parcel.delivered").body).data).toMatchObject({ status: "delivered", received_by: "Aisha", cod_collected_minor: 3000 });
    expect(JSON.parse(calls.find((x) => JSON.parse(x.body).type === "remittance.paid").body).data).toMatchObject({ paid_to_merchant_minor: 3000, bank_reference: "FAB-1" });
    expect(JSON.parse(calls.find((x) => JSON.parse(x.body).type === "parcel.attempt_failed").body).data.will_return).toBe(true);
    await expect(verifyInvariants(db)).resolves.toEqual([]);
  });

  it("retries a failing endpoint with back-off, dead-letters a permanent refusal, stops when switched off, and never calls a private address", async () => {
    const co = await company();
    await hooked(co);
    await co.run(async (c) => { const p = await createShipment(c, co.t.ctx, { merchant_id: co.shop, consignee_name: "x", address: "y", emirate: "Dubai" }); const r = await createRun(c, co.t.ctx, { driver_id: co.rider, shipment_ids: [p.id] }); await startRun(c, co.t.ctx, r.id); });
    const st = async () => (await db.query<any>(`SELECT status, attempts, last_error FROM outbox WHERE topic='merchant.webhook' AND tenant_id=$1`, [co.t.tenantId])).rows[0];
    await drain(async () => ({ status: 503, body: "" }));
    expect(await st()).toMatchObject({ status: "pending", attempts: 1, last_error: expect.stringContaining("answered 503") });
    await drain(async () => { throw new Error("socket hang up"); });
    expect(await st()).toMatchObject({ status: "pending", attempts: 2 });
    await drain(async () => ({ status: 410, body: "" }));
    expect(await st()).toMatchObject({ status: "dead", last_error: expect.stringContaining("410 Gone") });
    // a switched-off endpoint is not called at all
    await co.run(async (c) => { await c.query(`UPDATE outbox SET status='pending', attempts=0 WHERE topic='merchant.webhook'`); await setWebhook(c, co.t.ctx, { merchant_id: co.shop, url: "https://merchant.example.com/h", active: false }); });
    const calls: any[] = [];
    await drain(ok(calls));
    expect(calls).toHaveLength(0); expect((await st()).status).toBe("sent");
    // a permanent address refusal (e.g. resolves to a private network) goes straight to the dead queue
    await co.run(async (c) => { await setWebhook(c, co.t.ctx, { merchant_id: co.shop, url: "https://merchant.example.com/h", active: true }); await c.query(`UPDATE outbox SET status='pending', attempts=0`); });
    await drain(async () => { throw Object.assign(new Error("that address resolves to a private network"), { permanent: true }); });
    expect(await st()).toMatchObject({ status: "dead", attempts: 1, last_error: expect.stringContaining("private network") });
  });
});

describe("outbound HTTP safety", () => {
  it("classifies private, loopback, link-local, metadata, CGNAT, mapped and ULA addresses as private, and public ones as public", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "2001:db8::1", "64:ff9b::1", "not-an-ip"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.255.255", "185.199.108.153", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(validateWebhookUrl("https://merchant.example.com/a?b=1").hostname).toBe("merchant.example.com");
    expect(() => validateWebhookUrl("https://[::1]/h")).toThrow(); expect(() => validateWebhookUrl("nonsense")).toThrow();
  });

  it("refuses names that resolve (even partly) to a private network — checked inside the connection, so DNS rebinding cannot slip through", async () => {
    const lookupTo = (addrs: { address: string; family: number }[]) => ((_h: string, _o: any, cb: any) => cb(null, addrs)) as any;
    await expect(postJson("https://merchant.example.com/h", "{}", {}, { lookup: lookupTo([{ address: "10.0.0.8", family: 4 }]) })).rejects.toMatchObject({ permanent: true, message: expect.stringContaining("private network") });
    await expect(postJson("https://merchant.example.com/h", "{}", {}, { lookup: lookupTo([{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }]) })).rejects.toMatchObject({ permanent: true });
    await expect(postJson("https://127.0.0.1/h", "{}", {})).rejects.toMatchObject({ permanent: true });
  });

  it("really posts (signature header, JSON body), never follows a redirect, caps the response and times out", async () => {
    const seen: any[] = [];
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
        seen.push({ url: req.url, headers: req.headers, body: b });
        if (req.url === "/redirect") { res.writeHead(302, { location: "http://169.254.169.254/latest" }); return res.end(); }
        if (req.url === "/slow") return;                                                              // never answers
        if (req.url === "/big") return res.end("x".repeat(100_000));
        res.writeHead(200).end("fine");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const o = { allowHttp: true, allowPrivate: true };
    try {
      const ok = await postJson(`${base}/hook`, '{"a":1}', { "lbt-signature": "t=1,v1=ab" }, o);
      expect(ok).toEqual({ status: 200, body: "fine" });
      expect(seen[0].headers["lbt-signature"]).toBe("t=1,v1=ab"); expect(seen[0].headers["content-type"]).toBe("application/json"); expect(seen[0].body).toBe('{"a":1}');
      expect((await postJson(`${base}/redirect`, "{}", {}, o)).status).toBe(302);                    // reported as a failure by the caller; never followed
      expect(seen.filter((s) => s.url === "/latest")).toHaveLength(0);
      expect((await postJson(`${base}/big`, "{}", {}, { ...o, maxBodyBytes: 100 })).body.length).toBeLessThanOrEqual(100);   // a hostile endpoint cannot make us buffer a huge reply
      await expect(postJson(`${base}/slow`, "{}", {}, { ...o, timeoutMs: 150 })).rejects.toThrow(/did not answer in time/);
    } finally { srv.close(); }
  });
});

describe("SMS to consignees", () => {
  it("normalises UAE mobile numbers and refuses everything else", () => {
    for (const [raw, out] of [["050 123 4567", "+971501234567"], ["+971 50 123 4567", "+971501234567"], ["00971501234567", "+971501234567"], ["971501234567", "+971501234567"], ["(050)-123-4567", "+971501234567"]] as const) expect(normalizeUaeMobile(raw)).toBe(out);
    for (const raw of ["04 123 4567", "+44 7700 900123", "12345", "", null, undefined, "050123456", "0501234567890"]) expect(normalizeUaeMobile(raw as any)).toBeNull();
  });

  it("texts only opted-in merchants' consignees, only for out-for-delivery and failed attempts, includes the code only when required, and scrubs number and text after sending", async () => {
    const co = await company();
    const sent: { to: string; body: string }[] = [];
    const sms: SmsSender = { async send(to, body) { sent.push({ to, body }); return { id: `SM${sent.length}` }; } };
    const go = async () => { await db.query(`UPDATE outbox SET next_at=now() WHERE status='pending'`); await drainOutbox(db, deliveryNotifyHandlers(db, { sms })); };
    const mk = (c: Conn, f: any) => createShipment(c, co.t.ctx, { merchant_id: co.shop, consignee_name: "x", address: "y", emirate: "Dubai", ...f });
    await co.run((c) => setNotifySms(c, co.t.ctx, co.shop, true));
    const ids = await co.run(async (c) => {
      const a = await mk(c, { consignee_phone: "050 111 2222", cod: "75", require_code: "1", external_ref: "S1" });
      const b = await mk(c, { consignee_phone: "+44 7700 900123", external_ref: "S2" });              // not a UAE mobile: never texted
      const d = await mk(c, { consignee_phone: "0503334444", external_ref: "S3" });
      const n = await createShipment(c, co.t.ctx, { merchant_id: co.other, consignee_name: "x", address: "y", emirate: "Dubai", consignee_phone: "0509998888" });   // another merchant that has NOT opted in
      return { a, b, d, n };
    });
    const runId = await co.run(async (c) => { const r = await createRun(c, co.t.ctx, { driver_id: co.rider, shipment_ids: [ids.a.id, ids.b.id, ids.d.id, ids.n.id] }); await startRun(c, co.t.ctx, r.id); return r.id; });
    await go();
    expect(sent.map((s) => s.to).sort()).toEqual(["+971501112222", "+971503334444"]);                 // not the foreign number, and not the non-opted-in merchant's consignee
    const withCode = sent.find((s) => s.to === "+971501112222")!.body;
    const code = (await db.query<any>(`SELECT delivery_code FROM dlv_shipments WHERE id=$1`, [ids.a.id])).rows[0].delivery_code;
    expect(withCode).toContain("out for delivery today"); expect(withCode).toContain("AED 75.00"); expect(withCode).toContain(`Delivery code: ${code}`); expect(withCode).toMatch(/Track: .*\/t\/[A-Za-z0-9_-]+/);
    expect(sent.find((s) => s.to === "+971503334444")!.body).not.toContain("Delivery code");
    const ev = (id: string, kind: any, payload: any) => co.run((c) => applyRiderEvent(c, co.riderCtx, { client_event_id: `ev-${crypto.randomUUID()}`, shipment_id: id, kind, device_time: new Date().toISOString(), payload }));
    await ev(ids.d.id, "fail", { reason: "not_home" });
    await ev(ids.a.id, "deliver", { name: "Aisha", cash: "75", code });                              // delivered: no SMS
    await go();
    expect(sent).toHaveLength(3); expect(sent[2].body).toContain("could not deliver parcel");
    const rows = (await db.query<any>(`SELECT payload, status FROM outbox WHERE topic='sms' AND tenant_id=$1`, [co.t.tenantId])).rows;
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect(JSON.stringify(rows.map((r) => r.payload))).not.toMatch(/\+971|Delivery code|Track:/);      // number, code and link are gone once sent
    void runId;
  });

  it("the Twilio adapter posts a form with basic auth and classifies failures (5xx/429 retry; other 4xx permanent)", async () => {
    const calls: any[] = [];
    const mk = (status: number, body: unknown) => twilioSms({ provider: "twilio", accountSid: "AC" + "0".repeat(32), authToken: "tok", from: "LBTCOURIER", apiBase: "https://api.twilio.test" }, (async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); }) as any);
    expect(await mk(201, { sid: "SM123" }).send("+971501234567", "Hello")).toEqual({ id: "SM123" });
    expect(calls[0].url).toBe(`https://api.twilio.test/2010-04-01/Accounts/AC${"0".repeat(32)}/Messages.json`);
    expect(calls[0].init.headers.authorization).toBe(`Basic ${Buffer.from(`AC${"0".repeat(32)}:tok`).toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body))).toEqual({ To: "+971501234567", From: "LBTCOURIER", Body: "Hello" });
    await expect(mk(503, {}).send("+971501234567", "x")).rejects.not.toMatchObject({ permanent: true });
    await expect(mk(429, {}).send("+971501234567", "x")).rejects.not.toMatchObject({ permanent: true });
    await expect(mk(400, { code: 21211 }).send("+971501234567", "x")).rejects.toMatchObject({ permanent: true, message: expect.stringContaining("21211") });
    expect(signWebhook("s", "{}", 1700000000)).toBe(`t=1700000000,v1=${crypto.createHmac("sha256", "s").update("1700000000.{}").digest("hex")}`);
  });
});

describe("labels and the integrations screen", () => {
  it("prints labels with a scannable barcode of the waybill, for one parcel, a run, or everything awaiting dispatch — and never for another company", async () => {
    const co = await company(), other = await company();
    const b = new Browser();
    expect((await b.post("/login", { email: co.email, password: "correct horse battery" })).status).toBe(302);
    const ids = await co.run(async (c) => {
      const p = await createShipment(c, co.t.ctx, { merchant_id: co.shop, external_ref: "L-1", consignee_name: "Label Person", consignee_phone: "0501112222", address: "1 Label Street", emirate: "Ajman", cod: "99.90", require_code: "1" });
      const q = await createShipment(c, co.t.ctx, { merchant_id: co.shop, consignee_name: "Prepaid Person", address: "2 Label Street", emirate: "Dubai" });
      return { p, q };
    });
    const one = await b.page(`/app/delivery/labels?ids=${ids.p.id}`);
    expect(one.status).toBe(200);
    expect(one.html).toContain(ids.p.no); expect(one.html).toContain("<svg"); expect(one.html).toContain(`aria-label="Barcode ${ids.p.no}"`);
    expect(one.html).toContain("COD  AED 99.90"); expect(one.html).toContain("Label Person"); expect(one.html).toContain("CODE REQUIRED"); expect(one.html).toContain("Souq Shop");
    const fresh = await b.page(`/app/delivery/labels?status=new`);
    expect(fresh.html).toContain(ids.p.no); expect(fresh.html).toContain(ids.q.no); expect(fresh.html).toContain("PREPAID");
    const runId = await co.run(async (c) => (await createRun(c, co.t.ctx, { driver_id: co.rider, shipment_ids: [ids.q.id] })).id);
    const byRun = await b.page(`/app/delivery/labels?run=${runId}`);
    expect(byRun.html).toContain(ids.q.no); expect(byRun.html).not.toContain(ids.p.no);
    expect((await b.page(`/app/delivery/labels?ids=${ids.q.id}`)).html).toContain("2 Label Street");
    expect((await b.page(`/app/delivery/labels?ids=not-a-uuid`)).html).toContain("No labels to print");
    const o = new Browser();
    expect((await o.post("/login", { email: other.email, password: "correct horse battery" })).status).toBe(302);
    expect((await o.page(`/app/delivery/labels?ids=${ids.p.id}`)).status).toBe(404);              // another company's parcel id
    expect((await o.page(`/app/delivery/labels?run=${runId}`)).status).toBe(404);
    expect((await o.page(`/app/delivery/labels?status=new`)).html).not.toContain(ids.p.no);
  });

  it("owner manages keys and webhooks: the key and the secret appear once, in the response, never in a URL or on the next visit", async () => {
    const co = await company();
    const b = new Browser();
    await b.post("/login", { email: co.email, password: "correct horse battery" });
    const page = await b.page("/app/delivery/integrations");
    expect(page.status).toBe(200); expect(page.html).toContain("API quick start"); expect(page.html).toContain("HMAC-SHA256");
    const made = await b.post("/app/delivery/integrations/keys", { merchant_id: co.shop, name: "Shopify sync" });
    expect(made.status).toBe(200);
    const html = await made.text();
    const key = /lbtk_[A-Za-z0-9_-]{40}/.exec(html)![0];
    expect(html).toContain("shown once");
    expect(await authenticateApiKey(db, key)).toMatchObject({ merchantId: co.shop, tenantId: co.t.tenantId });
    const again = await b.page("/app/delivery/integrations");
    expect(again.html).not.toContain(key); expect(again.html).toContain(key.slice(0, 12));
    const hook = await b.post("/app/delivery/integrations/webhook", { merchant_id: co.shop, url: "https://merchant.example.com/h", active: "1" });
    expect(hook.status).toBe(200);
    expect(await hook.text()).toMatch(/whsec_[A-Za-z0-9_-]{20,}/);
    const bad = await b.post("/app/delivery/integrations/webhook", { merchant_id: co.shop, url: "http://merchant.example.com/h", active: "1" });
    expect(bad.status).toBe(302); expect(decodeURIComponent(bad.headers.get("location")!)).toMatch(/must use https/);
    const test = await b.post("/app/delivery/integrations/webhook-test", { merchant_id: co.shop });
    expect(new URL(test.headers.get("location")!, "http://x").searchParams.get("ok")).toMatch(/Test event queued/);
    expect((await db.query<any>(`SELECT count(*)::int n FROM outbox WHERE topic='merchant.webhook' AND payload->>'type'='ping'`)).rows[0].n).toBe(1);
    const kid = (await db.query<any>(`SELECT id FROM dlv_api_keys WHERE tenant_id=$1`, [co.t.tenantId])).rows[0].id;
    expect((await b.post(`/app/delivery/integrations/keys/${kid}/revoke`, {})).status).toBe(302);
    expect(await authenticateApiKey(db, key)).toBeNull();
  });
});
