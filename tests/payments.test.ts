import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { pgConnection } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { config, validateConfig } from "../src/config.js";
import { freshDb, newTenant } from "./helpers.js";
import { createOrder, startCheckout } from "../src/platform/billing.js";
import { processProvisioningQueue } from "../src/platform/provisioning.js";
import { razorpayAdapter, signRazorpayPayload, verifyRazorpaySignature } from "../src/platform/payments/razorpay.js";
import { signStripePayload, stripeAdapter, verifyStripeSignature } from "../src/platform/payments/stripe.js";
import { ProviderError, WebhookSignatureError } from "../src/platform/payments/types.js";
import { memoryLimiter, upstashLimiter } from "../src/lib/ratelimit.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });

const STRIPE = { secretKey: "sk_test_abc123", webhookSecret: "whsec_testsecret", apiBase: "https://api.stripe.test", paymentMethods: [] as string[] };
const RZP = { keyId: "rzp_test_key", keySecret: "rzp_secret", webhookSecret: "rzp_whsec_123", apiBase: "https://api.razorpay.test" };
const order = { id: "11111111-1111-4111-8111-111111111111", reference: "LBT-ABC-123", total_minor: 47145, currency: "AED", planName: "Starter",
  lines: [{ label: "Starter setup (one-off)", amount_minor: 19900 }, { label: "Starter subscription — first month", amount_minor: 14900 }, { label: "VAT", amount_minor: 1740 }, { label: "Adj", amount_minor: 10605 }] };
const fakeFetch = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => { calls.push({ url, init: init! }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); };
  return { f: f as any, calls };
};
const hdr = (h: Record<string, string>) => (n: string) => h[n.toLowerCase()];

describe("configuration", () => {
  const base = { ...config, paymentProviders: ["stripe"], stripe: { ...STRIPE }, razorpay: { keyId: "", keySecret: "", webhookSecret: "", apiBase: "" }, baseUrl: "https://app.example.com", databaseSsl: "require", upstash: { url: "", token: "" } };
  it("accepts a complete production setup and refuses every half-configured one", () => {
    expect(() => validateConfig({ ...base, stripe: { ...STRIPE, secretKey: "sk_live_xyz" } } as any, true)).not.toThrow();
    expect(() => validateConfig({ ...base } as any, true)).toThrow(/test key but NODE_ENV=production/);
    expect(() => validateConfig({ ...base, allowTestPaymentKeys: true } as any, true)).not.toThrow();                // explicit smoke-test override
    expect(() => validateConfig({ ...base, stripe: { ...STRIPE, secretKey: "" } } as any, false)).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => validateConfig({ ...base, stripe: { ...STRIPE, webhookSecret: "x" } } as any, false)).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() => validateConfig({ ...base, paymentProviders: ["mock"] } as any, true)).toThrow(/mock is not permitted/);
    expect(() => validateConfig({ ...base, paymentProviders: ["paypal"] } as any, false)).toThrow(/unknown payment provider/);
    expect(() => validateConfig({ ...base, paymentProviders: ["razorpay"] } as any, false)).toThrow(/RAZORPAY_KEY_ID/);
    expect(() => validateConfig({ ...base, baseUrl: "http://x.com", stripe: { ...STRIPE, secretKey: "sk_live_x" } } as any, true)).toThrow(/https/);
    expect(() => validateConfig({ ...base, databaseSsl: "no-verify", stripe: { ...STRIPE, secretKey: "sk_live_x" } } as any, true)).toThrow(/no-verify/);
    expect(() => validateConfig({ ...base, upstash: { url: "https://x", token: "" } } as any, false)).toThrow(/both UPSTASH/);
    expect(() => validateConfig({ ...base, vatBps: 99999 } as any, false)).toThrow(/CHECKOUT_VAT_BPS/);
    expect(() => validateConfig({ ...base, paymentProviders: ["stripe", "razorpay"], razorpay: { keyId: "rzp_live_1", keySecret: "s", webhookSecret: "12345678", apiBase: "" }, stripe: { ...STRIPE, secretKey: "sk_live_x" } } as any, true)).not.toThrow();
  });
  it("maps managed-Postgres URLs to a verified TLS connection", () => {
    const c = { ...config, databaseSsl: "", databaseCa: "" };
    expect(pgConnection("postgres://u:p@ep-1.neon.tech/db?sslmode=require", c)).toEqual({ connectionString: "postgres://u:p@ep-1.neon.tech/db", ssl: { rejectUnauthorized: true } });
    expect(pgConnection("postgres://u:p@db.x.supabase.co:5432/postgres", c)).toEqual({ connectionString: "postgres://u:p@db.x.supabase.co:5432/postgres" });
    expect(pgConnection("postgres://u:p@h/db", { ...c, databaseSsl: "require" }).ssl).toEqual({ rejectUnauthorized: true });
    expect(pgConnection("postgres://u:p@h/db", { ...c, databaseSsl: "no-verify" }).ssl).toEqual({ rejectUnauthorized: false });
    expect(pgConnection("postgres://u:p@h/db?sslmode=disable", c).ssl).toBeUndefined();
    expect(pgConnection("postgres://u:p@h/db", { ...c, databaseSsl: "require", databaseCa: "-----BEGIN\\nXYZ" }).ssl).toEqual({ rejectUnauthorized: true, ca: "-----BEGIN\nXYZ" });
    expect(() => pgConnection("postgres://u:p@h/db", { ...c, databaseSsl: "bogus" })).toThrow(/DATABASE_SSL/);
  });
});

describe("Stripe adapter", () => {
  it("verifies the signature over the raw body, with tolerance, rotation and tamper detection", () => {
    const raw = '{"id":"evt_1"}', now = Date.now();
    const good = signStripePayload(raw, STRIPE.webhookSecret, Math.floor(now / 1000));
    expect(verifyStripeSignature(raw, good, STRIPE.webhookSecret, now)).toBe(true);
    expect(verifyStripeSignature(raw + " ", good, STRIPE.webhookSecret, now)).toBe(false);                      // body changed
    expect(verifyStripeSignature(raw, good, "whsec_other", now)).toBe(false);
    expect(verifyStripeSignature(raw, signStripePayload(raw, STRIPE.webhookSecret, Math.floor(now / 1000) - 301), STRIPE.webhookSecret, now)).toBe(false);   // replay
    expect(verifyStripeSignature(raw, signStripePayload(raw, STRIPE.webhookSecret, Math.floor(now / 1000) + 301), STRIPE.webhookSecret, now)).toBe(false);
    expect(verifyStripeSignature(raw, `t=${Math.floor(now / 1000)},v1=${"0".repeat(64)},v1=${good.split("v1=")[1]}`, STRIPE.webhookSecret, now)).toBe(true);   // rotation: any v1
    for (const bad of [undefined, "", "garbage", "t=abc,v1=zz", `v1=${good.split("v1=")[1]}`]) expect(verifyStripeSignature(raw, bad, STRIPE.webhookSecret, now)).toBe(false);
    expect(verifyStripeSignature(raw, good, "", now)).toBe(false);
  });

  it("creates an itemised Checkout Session with idempotency, metadata and no secret in the body", async () => {
    const { f, calls } = fakeFetch(200, { id: "cs_test_1", url: "https://checkout.stripe.test/c/pay/cs_test_1" });
    const out = await stripeAdapter(STRIPE, f).createCheckout(order, { success: "https://app/ok", cancel: "https://app/no" });
    expect(out).toEqual({ providerSession: "cs_test_1", url: "https://checkout.stripe.test/c/pay/cs_test_1" });
    expect(calls[0].url).toBe("https://api.stripe.test/v1/checkout/sessions");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer sk_test_abc123"); expect(h["idempotency-key"]).toBe(`lbt-checkout-${order.id}`);
    const b = new URLSearchParams(String(calls[0].init.body));
    expect(b.get("mode")).toBe("payment"); expect(b.get("client_reference_id")).toBe(order.id);
    expect(b.get("metadata[order_id]")).toBe(order.id); expect(b.get("payment_intent_data[metadata][reference]")).toBe(order.reference);
    expect(b.get("line_items[0][price_data][currency]")).toBe("aed");
    const total = [0, 1, 2, 3].reduce((a, i) => a + Number(b.get(`line_items[${i}][price_data][unit_amount]`)), 0);
    expect(total).toBe(order.total_minor);                                                  // what Stripe charges is exactly what we priced
    expect(b.get("payment_method_types[0]")).toBeNull();                                    // dynamic methods: cards, Google Pay, Apple Pay… as enabled in the dashboard
    expect(String(calls[0].init.body)).not.toContain("sk_test");
    const card = new URLSearchParams(String((await (async () => { const x = fakeFetch(200, { id: "cs", url: "u" }); await stripeAdapter({ ...STRIPE, paymentMethods: ["card"] }, x.f).createCheckout(order, { success: "s", cancel: "c" }); return x.calls[0].init.body; })())));
    expect(card.get("payment_method_types[0]")).toBe("card");
  });

  it("refuses to start a checkout whose lines do not add up, and turns provider failures into a safe message", async () => {
    await expect(stripeAdapter(STRIPE, fakeFetch(200, {}).f).createCheckout({ ...order, total_minor: 1 }, { success: "s", cancel: "c" })).rejects.toThrow(/do not add up/);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const e1 = await stripeAdapter(STRIPE, fakeFetch(401, { error: { type: "invalid_request_error", message: "Invalid API Key sk_test_abc123" } }).f).createCheckout(order, { success: "s", cancel: "c" }).catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderError); expect(e1.message).not.toContain("sk_test"); expect(e1.message).toMatch(/Nothing was charged/);
    const e2 = await stripeAdapter(STRIPE, (async () => { throw new Error("ECONNRESET"); }) as any).createCheckout(order, { success: "s", cancel: "c" }).catch((e) => e);
    expect(e2).toBeInstanceOf(ProviderError); expect(e2.message).toMatch(/could not be reached/);
    err.mockRestore();
  });

  it("translates provider events: paid, unpaid-yet, async success/failure, expiry, full vs partial refund; rejects bad signatures", () => {
    const a = stripeAdapter(STRIPE);
    const send = (type: string, object: Record<string, unknown>, id = "evt_" + Math.random().toString(36).slice(2)) => {
      const raw = JSON.stringify({ id, type, data: { object } });
      return a.parseWebhook(raw, hdr({ "stripe-signature": signStripePayload(raw, STRIPE.webhookSecret) }));
    };
    const session = { id: "cs_1", client_reference_id: order.id, metadata: { order_id: order.id, reference: order.reference }, amount_total: 47145, currency: "aed", payment_intent: "pi_1", payment_status: "paid" };
    expect(send("checkout.session.completed", session).event).toMatchObject({ type: "payment.succeeded", order_id: order.id, reference: order.reference, amount_minor: 47145, currency: "AED", provider_ref: "pi_1" });
    expect(send("checkout.session.completed", { ...session, payment_status: "unpaid" })).toMatchObject({ event: null });
    expect(send("checkout.session.async_payment_succeeded", session).event?.type).toBe("payment.succeeded");
    expect(send("checkout.session.async_payment_failed", session).event?.type).toBe("payment.failed");
    expect(send("checkout.session.expired", session).event?.type).toBe("payment.failed");
    expect(send("charge.refunded", { amount: 47145, currency: "aed", refunded: true, payment_intent: "pi_1", metadata: {} }).event).toMatchObject({ type: "payment.refunded", order_id: "", provider_ref: "pi_1", amount_minor: 47145 });
    expect(send("charge.refunded", { amount: 47145, refunded: false, amount_refunded: 100 }).event).toBeNull();
    expect(send("customer.created", {}).event).toBeNull();
    const raw = '{"id":"evt_x","type":"checkout.session.completed","data":{"object":{}}}';
    expect(() => a.parseWebhook(raw, hdr({ "stripe-signature": "t=1,v1=00" }))).toThrow(WebhookSignatureError);
    expect(() => a.parseWebhook(raw, hdr({}))).toThrow(WebhookSignatureError);
  });
});

describe("Razorpay adapter", () => {
  it("verifies the body signature", () => {
    const raw = '{"event":"payment_link.paid"}', sig = signRazorpayPayload(raw, RZP.webhookSecret);
    expect(verifyRazorpaySignature(raw, sig, RZP.webhookSecret)).toBe(true);
    expect(verifyRazorpaySignature(raw + "x", sig, RZP.webhookSecret)).toBe(false);
    expect(verifyRazorpaySignature(raw, sig, "other")).toBe(false);
    expect(verifyRazorpaySignature(raw, undefined, RZP.webhookSecret)).toBe(false);
  });

  it("creates a hosted payment link (UPI / Google Pay / cards) with basic auth and our order in the notes", async () => {
    const { f, calls } = fakeFetch(200, { id: "plink_1", short_url: "https://rzp.io/i/abc" });
    const out = await razorpayAdapter(RZP, f).createCheckout({ ...order, payerEmail: "a@b.co" }, { success: "https://app/ok", cancel: "https://app/no" });
    expect(out).toEqual({ providerSession: "plink_1", url: "https://rzp.io/i/abc" });
    expect(calls[0].url).toBe("https://api.razorpay.test/v1/payment_links");
    expect((calls[0].init.headers as any).authorization).toBe(`Basic ${Buffer.from("rzp_test_key:rzp_secret").toString("base64")}`);
    const b = JSON.parse(String(calls[0].init.body));
    expect(b).toMatchObject({ amount: 47145, currency: "AED", reference_id: "LBT-ABC-123", accept_partial: false, callback_url: "https://app/ok", notes: { order_id: order.id, reference: order.reference }, customer: { email: "a@b.co" } });
    expect(b.expire_by).toBeGreaterThan(Date.now() / 1000);
    expect(String(calls[0].init.body)).not.toContain("rzp_secret");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(razorpayAdapter(RZP, fakeFetch(400, { error: { code: "BAD_REQUEST_ERROR", description: "Currency not supported" } }).f).createCheckout(order, { success: "s", cancel: "c" })).rejects.toThrow(/Nothing was charged/);
    err.mockRestore();
  });

  it("translates events: paid, cancelled/expired, full refund, ignores payment.failed (the link stays payable) and partial refunds", () => {
    const a = razorpayAdapter(RZP);
    const send = (event: string, payload: unknown, id = "evt-" + Math.random()) => {
      const raw = JSON.stringify({ event, payload });
      return a.parseWebhook(raw, hdr({ "x-razorpay-signature": signRazorpayPayload(raw, RZP.webhookSecret), "x-razorpay-event-id": id }));
    };
    const link = { entity: { id: "plink_1", reference_id: order.reference, amount: 47145, amount_paid: 47145, currency: "AED", notes: { order_id: order.id, reference: order.reference } } };
    expect(send("payment_link.paid", { payment_link: link, payment: { entity: { id: "pay_1" } } }, "evt-A").event).toMatchObject({ event_id: "evt-A", type: "payment.succeeded", order_id: order.id, reference: order.reference, amount_minor: 47145, currency: "AED", provider_ref: "pay_1" });
    expect(send("payment_link.expired", { payment_link: link }).event?.type).toBe("payment.failed");
    expect(send("payment_link.cancelled", { payment_link: link }).event?.type).toBe("payment.failed");
    expect(send("payment.failed", { payment: { entity: { id: "pay_x" } } }).event).toBeNull();
    expect(send("refund.processed", { refund: { entity: { amount: 47145 } }, payment: { entity: { id: "pay_1", amount: 47145, currency: "AED" } } }).event).toMatchObject({ type: "payment.refunded", provider_ref: "pay_1", order_id: "" });
    expect(send("refund.processed", { refund: { entity: { amount: 100 } }, payment: { entity: { id: "pay_1", amount: 47145 } } }).event).toBeNull();
    expect(() => a.parseWebhook('{"event":"x"}', hdr({ "x-razorpay-signature": "00" }))).toThrow(WebhookSignatureError);
  });
});

describe("end to end through the real webhook route", () => {
  const saved = { providers: [...config.paymentProviders], stripe: { ...config.stripe }, razorpay: { ...config.razorpay } };
  afterEach(() => { vi.unstubAllGlobals(); config.paymentProviders = saved.providers; Object.assign(config.stripe, saved.stripe); Object.assign(config.razorpay, saved.razorpay); });
  const enable = () => { config.paymentProviders = ["stripe", "razorpay", "mock"]; Object.assign(config.stripe, STRIPE); Object.assign(config.razorpay, RZP); };
  const hook = (provider: string, raw: string, headers: Record<string, string>) => app.request(`/webhooks/payments/${provider}`, { method: "POST", body: raw, headers: { "content-type": "application/json", ...headers } });
  const stripeEvent = (type: string, object: Record<string, unknown>, id = `evt_${Math.random().toString(36).slice(2)}`) => {
    const raw = JSON.stringify({ id, type, data: { object } });
    return { raw, id, headers: { "stripe-signature": signStripePayload(raw, STRIPE.webhookSecret) } };
  };
  async function pending(provider = "stripe") {
    const t = await newTenant(db);
    const o = await createOrder(db, t.tenantId, t.userId, "starter", provider);
    const row = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
    return { t, o, row };
  }
  const paidSession = (row: any, over: Record<string, unknown> = {}) => ({ id: "cs_1", client_reference_id: row.id, metadata: { order_id: row.id, reference: row.reference }, amount_total: Number(row.total_minor), currency: "aed", payment_intent: `pi_${row.id.slice(0, 8)}`, payment_status: "paid", ...over });

  it("checkout opens a hosted session once, is resumable, and a failing provider closes the order instead of leaving it half-open", async () => {
    enable();
    const { t, o } = await pending();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "cs_test_9", url: "https://checkout.stripe.test/pay/cs_test_9" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const urls = { success: "https://app/ok", cancel: "https://app/no" };
    const r1 = await startCheckout(db, o.orderId, t.tenantId, urls);
    const r2 = await startCheckout(db, o.orderId, t.tenantId, urls);                   // resume: no second provider session
    expect(r1.url).toBe(r2.url); expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = new URLSearchParams(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(sent.get("customer_email")).toMatch(/@example\.com$/);
    expect((await db.query<any>(`SELECT status, provider_session, checkout_url FROM orders WHERE id=$1`, [o.orderId])).rows[0]).toMatchObject({ status: "pending", provider_session: "cs_test_9" });

    const bad = await pending();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await expect(startCheckout(db, bad.o.orderId, bad.t.tenantId, urls)).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/Nothing was charged/) });
    err.mockRestore();
    expect((await db.query<any>(`SELECT status FROM orders WHERE id=$1`, [bad.o.orderId])).rows[0].status).toBe("failed");
    await expect(createOrder(db, t.tenantId, t.userId, "business", "paypal")).rejects.toThrow(/not available/);
  });

  it("a verified Stripe payment activates the plan exactly once; replays, forgeries and wrong amounts do not", async () => {
    enable();
    const { t, row } = await pending();
    const ev = stripeEvent("checkout.session.completed", paidSession(row));
    expect((await hook("stripe", ev.raw, { "stripe-signature": "t=1,v1=00" })).status).toBe(400);                     // forged
    expect((await db.query<any>(`SELECT status FROM orders WHERE id=$1`, [row.id])).rows[0].status).toBe("pending");
    const ok = await hook("stripe", ev.raw, ev.headers);
    expect(ok.status).toBe(200); expect(await ok.json()).toMatchObject({ outcome: "applied" });
    await processProvisioningQueue(db);
    expect((await db.query<any>(`SELECT status FROM orders WHERE id=$1`, [row.id])).rows[0].status).toBe("paid");
    expect((await db.query<any>(`SELECT p.plan_code FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id WHERE s.tenant_id=$1`, [t.tenantId])).rows[0].plan_code).toBe("starter");
    expect(await (await hook("stripe", ev.raw, ev.headers)).json()).toMatchObject({ outcome: "duplicate" });         // same event id
    const again = stripeEvent("checkout.session.completed", paidSession(row));                                          // provider replay under a new event id
    expect(await (await hook("stripe", again.raw, again.headers)).json()).toMatchObject({ outcome: "ignored" });
    expect((await db.query<any>(`SELECT count(*)::int n FROM provision_jobs WHERE tenant_id=$1`, [t.tenantId])).rows[0].n).toBe(1);

    const other = await pending();
    const wrong = stripeEvent("checkout.session.completed", paidSession(other.row, { amount_total: 100 }));
    expect(await (await hook("stripe", wrong.raw, wrong.headers)).json()).toMatchObject({ outcome: "rejected", reason: "amount/currency mismatch" });
    expect((await db.query<any>(`SELECT status FROM orders WHERE id=$1`, [other.row.id])).rows[0].status).toBe("pending");
    const review = (await db.query<any>(`SELECT payload FROM outbox WHERE topic='staff.review' AND key LIKE 'payment-rejected:%'`)).rows;
    expect(review.length).toBeGreaterThan(0);                                                                            // money that could not be applied reaches a human
    const junk = stripeEvent("checkout.session.completed", { metadata: { order_id: "not-a-uuid", reference: "x" }, amount_total: 1, currency: "aed", payment_status: "paid" });
    expect(await (await hook("stripe", junk.raw, junk.headers)).json()).toMatchObject({ outcome: "rejected", reason: "unknown order" });
    const noise = stripeEvent("customer.created", {});
    expect(await (await hook("stripe", noise.raw, noise.headers)).json()).toMatchObject({ outcome: "ignored" });
    expect((await hook("paypal", "{}", {})).status).toBe(404);
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("a refund that carries no order metadata finds its order through the provider payment id", async () => {
    enable();
    const { row } = await pending();
    const paid = stripeEvent("checkout.session.completed", paidSession(row));
    await hook("stripe", paid.raw, paid.headers);
    const refund = stripeEvent("charge.refunded", { amount: Number(row.total_minor), currency: "aed", refunded: true, payment_intent: `pi_${row.id.slice(0, 8)}`, metadata: {} });
    expect(await (await hook("stripe", refund.raw, refund.headers)).json()).toMatchObject({ outcome: "applied" });
    expect((await db.query<any>(`SELECT status FROM orders WHERE id=$1`, [row.id])).rows[0].status).toBe("refunded");
    const stranger = stripeEvent("charge.refunded", { amount: 5, currency: "aed", refunded: true, payment_intent: "pi_unknown", metadata: {} });
    expect(await (await hook("stripe", stranger.raw, stranger.headers)).json()).toMatchObject({ outcome: "rejected" });
  });

  it("a Razorpay payment link payment activates the plan; its redelivery is a duplicate; an unpaid link does not", async () => {
    enable();
    const { row } = await pending("razorpay");
    const raw = JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_1", reference_id: row.reference, amount: Number(row.total_minor), amount_paid: Number(row.total_minor), currency: "AED", notes: { order_id: row.id, reference: row.reference } } }, payment: { entity: { id: "pay_77" } } } });
    const headers = { "x-razorpay-signature": signRazorpayPayload(raw, RZP.webhookSecret), "x-razorpay-event-id": "evt_rzp_1" };
    expect((await hook("razorpay", raw, { ...headers, "x-razorpay-signature": "00" })).status).toBe(400);
    expect(await (await hook("razorpay", raw, headers)).json()).toMatchObject({ outcome: "applied" });
    expect((await db.query<any>(`SELECT status, provider FROM orders WHERE id=$1`, [row.id])).rows[0]).toEqual({ status: "paid", provider: "razorpay" });
    expect(await (await hook("razorpay", raw, headers)).json()).toMatchObject({ outcome: "duplicate" });
    const failed = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: "pay_1" } } } });
    expect(await (await hook("razorpay", failed, { "x-razorpay-signature": signRazorpayPayload(failed, RZP.webhookSecret) })).json()).toMatchObject({ outcome: "ignored" });
  });

  it("the billing page offers each enabled method and the pay page hands off with a link and meta refresh (never a form redirect)", async () => {
    enable();
    const t = await newTenant(db);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const jar = new Map<string, string>();
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
      for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
      return res;
    };
    const post = async (path: string, f: Record<string, string>) => { await call("/login"); const b = new URLSearchParams({ _csrf: jar.get("lbt_csrf")!, ...f }); return call(path, { method: "POST", body: b, headers: { "content-type": "application/x-www-form-urlencoded" } }); };
    expect((await post("/login", { email, password: "correct horse battery" })).status).toBe(302);
    const page = await (await call("/app/billing")).text();
    expect(page).toContain("Google Pay"); expect(page).toContain("(Stripe)"); expect(page).toContain("(Razorpay)");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "cs_t", url: "https://checkout.stripe.test/pay/cs_t" }), { status: 200 })));
    const go = await post("/app/billing/checkout", { plan: "starter", provider: "stripe" });
    expect(go.status).toBe(302);
    const payUrl = go.headers.get("location")!;
    expect(payUrl).toMatch(/^\/app\/billing\/pay\//);
    const pay = await (await call(payUrl)).text();
    expect(pay).toContain('http-equiv="refresh"'); expect(pay).toContain("https://checkout.stripe.test/pay/cs_t"); expect(pay).toContain("only when the provider confirms");
    expect((await db.query<any>(`SELECT status FROM orders WHERE tenant_id=$1`, [t.tenantId])).rows[0].status).toBe("pending");   // visiting is not paying
    const orderId = payUrl.split("/").pop()!;
    expect((await call(`/app/billing/orders/${orderId}/receipt`)).status).toBe(404);                                   // no receipt until it is paid
    Object.assign(config.seller, { legalName: "Test Freelancer", gstin: "29ABCDE1234F1Z5", address: "Bengaluru, India", sac: "998314", supplyNote: "Export of services; place of supply outside India." });
    const row = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [orderId])).rows[0];
    const evt = stripeEvent("checkout.session.completed", paidSession(row));
    expect((await hook("stripe", evt.raw, evt.headers)).status).toBe(200);
    const receipt = await (await call(`/app/billing/orders/${orderId}/receipt`)).text();
    expect(receipt).toContain("Tax invoice"); expect(receipt).toContain("Test Freelancer"); expect(receipt).toContain("GSTIN: 29ABCDE1234F1Z5");
    expect(receipt).toContain("SAC 998314"); expect(receipt).toContain("Export of services"); expect(receipt).toContain("your accountant");
    expect(await (await call("/pricing")).text()).toContain("Operated by Test Freelancer");                             // site footer
    Object.assign(config.seller, { legalName: "", gstin: "", address: "", sac: "", supplyNote: "" });
    const sim = await post(payUrl, { outcome: "success" });                                                            // the simulator cannot pay a real-provider order
    expect(sim.status).toBe(404);
  });
});

describe("rate limiting", () => {
  it("counts per window in memory", async () => {
    let now = 1_000_000; const l = memoryLimiter(() => now);
    expect((await l.hit("k", 2, 60)).ok).toBe(true); expect((await l.hit("k", 2, 60)).ok).toBe(true);
    const third = await l.hit("k", 2, 60);
    expect(third.ok).toBe(false); expect(third.retryAfter).toBeGreaterThan(0);
    expect((await l.hit("other", 2, 60)).ok).toBe(true);
    now += 61_000; expect((await l.hit("k", 2, 60)).ok).toBe(true);
  });
  it("uses Upstash when reachable (INCR + EXPIRE NX in one pipeline) and degrades to the local counter when not", async () => {
    const seen: any[] = []; let n = 0;
    const up = upstashLimiter("https://x.upstash.io", "tok", memoryLimiter(), (async (url: string, init: any) => {
      seen.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify([{ result: ++n }, { result: 1 }, { result: 55 }]), { status: 200 });
    }) as any);
    expect(await up.hit("login:a", 2, 60)).toMatchObject({ ok: true, count: 1, retryAfter: 55 });
    await up.hit("login:a", 2, 60);
    expect((await up.hit("login:a", 2, 60)).ok).toBe(false);
    expect(seen[0]).toMatchObject({ url: "https://x.upstash.io/pipeline", auth: "Bearer tok" });
    expect(seen[0].body).toEqual([["INCR", "lbt:rl:login:a"], ["EXPIRE", "lbt:rl:login:a", "60", "NX"], ["TTL", "lbt:rl:login:a"]]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = upstashLimiter("https://x.upstash.io", "tok", memoryLimiter(), (async () => { throw new Error("offline"); }) as any);
    expect((await down.hit("k", 1, 60)).ok).toBe(true); expect((await down.hit("k", 1, 60)).ok).toBe(false);      // still protected, per instance
    err.mockRestore();
  });
});
