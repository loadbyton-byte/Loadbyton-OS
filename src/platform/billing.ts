import type { Db, Conn } from "../db/client.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { HttpError, badRequest, hmac, randomToken, safeEqual } from "../lib/util.js";
import { ProviderError, enabledProviders, getAdapter, type PaymentEvent } from "./payments/index.js";
import { applyPlanEntitlements, previewPlanChange } from "./entitlements.js";
import { currentPlans, type PlanVersion } from "./catalog.js";
import { accrueCommission, reverseCommission } from "./partners.js";
import { onOrderPaid } from "./requests.js";

export interface OrderLine { label: string; amount_minor: number; kind: "setup" | "subscription" }
export function paymentQuote(total:number,currency:string,provider:string) {
 if(provider!=='razorpay'||config.razorpayPresentment.currency===currency)return {currency,total,rate:1,note:''};
 if(currency!=='AED'||config.razorpayPresentment.currency!=='INR')throw badRequest('Unsupported payment currency conversion');
 const rate=config.razorpayPresentment.aedToInr,converted=Math.round(total*rate);
 if(!Number.isFinite(rate)||rate<=0||!config.razorpayPresentment.note||!Number.isSafeInteger(converted)||converted<=0)throw badRequest('A reviewed INR checkout quote is required');
 return {currency:'INR',total:converted,rate,note:config.razorpayPresentment.note};
}

/**
 * Net incremental pricing: setup already paid at a lower tier is credited; shared Finance/CRM is priced once
 * because pricing is per plan, not per module. No proration in the pilot (decision §32 pending).
 */
export async function priceCheckout(c: Conn, tenantId: string, plan: PlanVersion) {
  if (plan.contact_sales) throw badRequest("Enterprise is scoped with our team. Contact sales.");
  if (plan.monthly_minor === 0) throw badRequest("The Free plan needs no checkout.");
  const paidSetup = await c.query<{ s: string | number }>(
    `SELECT coalesce(sum((l->>'amount_minor')::bigint),0) s FROM orders o, jsonb_array_elements(o.lines) l
     WHERE o.tenant_id=$1 AND o.status='paid' AND l->>'kind'='setup'`, [tenantId]);
  const credit = Number(paidSetup.rows[0].s);
  const setup = Math.max(0, plan.setup_minor - credit);
  const lines: OrderLine[] = [];
  if (setup > 0) lines.push({ label: `${plan.name} setup (one-off)`, amount_minor: setup, kind: "setup" });
  lines.push({ label: `${plan.name} subscription — first month`, amount_minor: plan.monthly_minor, kind: "subscription" });
  const subtotal = lines.reduce((a, l) => a + l.amount_minor, 0);
  const tax = Math.round((subtotal * config.vatBps) / 10_000);
  return {
    lines, subtotal, tax, total: subtotal + tax, currency: plan.currency,
    taxNote: config.checkoutTaxNote || `VAT at ${(config.vatBps / 100).toFixed(2)}% shown for this checkout. Final tax treatment depends on your registration and the transaction.`,
    setupCredit: credit,
  };
}

export async function createOrder(db: Db, tenantId: string, userId: string, planCode: string, provider: string = config.paymentProvider) {
  if (!enabledProviders().includes(provider)) throw badRequest("That payment method is not available.");
  return db.system(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`checkout:${tenantId}`]);
    const plan = (await currentPlans(c)).find((p) => p.plan_code === planCode);
    if (!plan) throw badRequest("Unknown plan");
    const sub = (await c.query<any>(`SELECT * FROM subscriptions WHERE tenant_id=$1`, [tenantId])).rows[0];
    if (sub?.plan_version_id === plan.id && sub.status === 'active' && new Date(sub.period_end).getTime() > Date.now() + 7 * 86400000) throw badRequest("Renewal checkout opens seven days before the paid period ends.");
    const existing = (await c.query<any>(`SELECT id, reference FROM orders WHERE tenant_id=$1 AND plan_version_id=$2 AND provider=$3 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [tenantId,plan.id,provider])).rows[0];
    if (existing) return { orderId: existing.id, reference: existing.reference };
    const p = await priceCheckout(c, tenantId, plan);
    const payment=paymentQuote(p.total,p.currency,provider);
    const reference = `LBT-${Date.now().toString(36).toUpperCase()}-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
    const o = (await c.query<{ id: string }>(
      `INSERT INTO orders(tenant_id,plan_version_id,lines,currency,subtotal_minor,tax_minor,total_minor,tax_note,reference,provider,created_by,merchant_snapshot,payment_currency,payment_total_minor,fx_rate,fx_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [tenantId, plan.id, JSON.stringify(p.lines), p.currency, p.subtotal, p.tax, p.total, p.taxNote, reference, provider, userId, JSON.stringify(config.seller), payment.currency, payment.total, payment.rate, payment.note])).rows[0];
    if (provider === "mock") await c.query(`UPDATE orders SET provider_session=$2 WHERE id=$1`, [o.id, `sess_${randomToken(10)}`]);
    await audit(c, tenantId, { kind: "user", userId }, "order.created", "order", o.id, { plan: plan.plan_code, total: p.total });
    return { orderId: o.id, reference };
  });
}

/**
 * Open the provider-hosted checkout for a pending order. The browser is only ever *sent* there; access is granted solely by the
 * server-verified webhook. If the provider cannot be reached the order is closed as failed, so nothing is left half-open.
 */
export async function startCheckout(db: Db, orderId: string, tenantId: string, urls: { success: string; cancel: string }) {
  const o = (await db.query<any>(
    `SELECT o.*, p.name AS plan_name, u.email AS payer_email FROM orders o JOIN plan_versions p ON p.id=o.plan_version_id LEFT JOIN users u ON u.id=o.created_by
     WHERE o.id=$1 AND o.tenant_id=$2`, [orderId, tenantId])).rows[0];
  if (!o) throw new HttpError(404, "Order not found");
  if (o.status !== "pending") throw badRequest(`This order is ${o.status}.`);
  if (o.checkout_url) return { url: o.checkout_url as string };                       // resume: never create a second provider session
  const adapter = getAdapter(o.provider);
  if (!adapter) throw badRequest("That payment method is not available.");
  const lines = (o.lines as { label: string; amount_minor: number }[]).map((l) => ({ label: l.label, amount_minor: Number(l.amount_minor) }));
  if (Number(o.tax_minor) > 0) lines.push({ label: "VAT", amount_minor: Number(o.tax_minor) });
  if (o.payment_currency && o.payment_currency !== o.currency) {   // presentment in another currency (reviewed FX quote stored on the order): one itemised line at the quoted total
    lines.splice(0, lines.length, { label: `${o.plan_name} (${o.currency} ${(Number(o.total_minor) / 100).toFixed(2)} at ${o.fx_rate})`, amount_minor: Number(o.payment_total_minor) });
  }
  try {
    const s = await adapter.createCheckout({ id: o.id, reference: o.reference, total_minor: Number(o.payment_total_minor ?? o.total_minor), currency: o.payment_currency ?? o.currency, planName: o.plan_name, lines, payerEmail: o.payer_email ?? undefined }, urls);
    await db.system((c) => c.query(`UPDATE orders SET provider_session=$2, checkout_url=$3 WHERE id=$1 AND status='pending'`, [o.id, s.providerSession, s.url]));
    return { url: s.url };
  } catch (e) {
    await db.system(async (c) => {
      await c.query(`UPDATE orders SET status='failed' WHERE id=$1 AND status='pending'`, [o.id]);
      await audit(c, tenantId, { kind: "system" }, "order.checkout_failed", "order", o.id, { provider: o.provider });
    });
    if (e instanceof ProviderError) throw new HttpError(e.status === 500 ? 500 : 502, e.message, "provider_error");
    throw e;
  }
}

// ── webhook authentication: header "t=<unix>,v1=<hex hmac(secret, `${t}.${rawBody}`)>", 5 minute tolerance
export function signPayload(rawBody: string, secret = config.webhookSecret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${hmac(secret, `${t}.${rawBody}`)}`;
}
export function verifySignature(rawBody: string, header: string | undefined | null, secret = config.webhookSecret, now = Date.now()) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > 300) return false;            // replay window
  return safeEqual(parts.v1, hmac(secret, `${t}.${rawBody}`));
}

export type { PaymentEvent } from "./payments/index.js";
export type PaymentOutcome = "applied" | "duplicate" | "ignored" | "rejected";

/**
 * Idempotent server-side payment processing. Never driven by a browser redirect.
 * One provider event → at most one applied business transition (unique (provider,event_id)),
 * and one order → at most one provisioning job (unique order_id).
 */
export async function processPaymentEvent(db: Db, provider: string, ev: PaymentEvent): Promise<{ outcome: PaymentOutcome; reason?: string }> {
  return db.system(async (c) => {
    const ins = await c.query(
      `INSERT INTO payment_events(provider,event_id,type,order_id,payload,outcome) VALUES ($1,$2,$3,NULL,$4,'applied')
       ON CONFLICT (provider,event_id) DO NOTHING RETURNING id`,
      [provider, ev.event_id, ev.type, JSON.stringify(ev)]);
    if (!ins.rows.length) return { outcome: "duplicate" as const };
    const eventRowId = ins.rows[0].id;
    const finish = async (outcome: PaymentOutcome, reason?: string, orderId?: string) => {
      await c.query(`UPDATE payment_events SET outcome=$2, order_id=$3 WHERE id=$1`, [eventRowId, outcome, orderId ?? null]);
      // a payment we could not match to an order is money that arrived without a customer: a person must look at it
      if (outcome === "rejected" && ev.type === "payment.succeeded") {
        await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES (NULL,'staff.review',$1,$2) ON CONFLICT (key) DO NOTHING`,
          [`payment-rejected:${eventRowId}`, JSON.stringify({ provider, event_id: ev.event_id, reason, note: "A successful payment could not be applied — check the provider dashboard and reconcile manually." })]);
      }
      return { outcome, reason };
    };

    // a refund may arrive without our metadata: find the order through the provider's own payment handle
    let resolvedByRef = false;
    if (!ev.order_id && ev.provider_ref) {
      const hit = (await c.query<any>(
        `SELECT order_id FROM payment_events WHERE provider=$1 AND type='payment.succeeded' AND outcome='applied' AND order_id IS NOT NULL AND payload->>'provider_ref'=$2 LIMIT 1`, [provider, ev.provider_ref])).rows[0];
      if (hit) { ev = { ...ev, order_id: hit.order_id }; resolvedByRef = true; }
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ev.order_id)) return finish("rejected", "unknown order");
    const o = (await c.query<any>(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [ev.order_id])).rows[0];
    if (!o) return finish("rejected", "unknown order");
    if (o.provider !== provider) return finish("rejected", "provider mismatch", o.id);
    if (resolvedByRef && !ev.reference) ev = { ...ev, reference: o.reference };
    if (o.reference !== ev.reference) return finish("rejected", "reference mismatch", o.id);
    if (Number(o.payment_total_minor??o.total_minor) !== ev.amount_minor || (o.payment_currency??o.currency) !== ev.currency) return finish("rejected", "amount/currency mismatch", o.id);
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`billing:${o.tenant_id}`]);
    if (ev.type === "payment.failed") {
      if (o.status === "pending") await c.query(`UPDATE orders SET status='failed' WHERE id=$1`, [o.id]);
      return finish(o.status === "pending" ? "applied" : "ignored", o.status === "pending" ? undefined : `order already ${o.status}`, o.id);
    }
    if (ev.type === "payment.refunded") {
      if (['refunded','cancelled'].includes(o.status)) return finish("ignored", `order is ${o.status}`, o.id);
      await c.query(`UPDATE orders SET status='refunded' WHERE id=$1`, [o.id]);
      await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'staff.review',$2,$3) ON CONFLICT (key) DO NOTHING`,
        [o.tenant_id, `refund:${o.id}`, JSON.stringify({ orderId: o.id, note: "Refund received — decide entitlement treatment." })]);
      await audit(c, o.tenant_id, { kind: "system" }, "order.refunded", "order", o.id);
      await reverseCommission(c, o.id);
      return finish("applied", undefined, o.id);
    }

    // payment.succeeded
    if (o.status === "paid") return finish("ignored", "order already paid", o.id);
    if (o.status === "cancelled" || o.status === "refunded") return finish("rejected", `order is ${o.status}`, o.id);
    const newer = await c.query(`SELECT 1 FROM orders WHERE tenant_id=$1 AND status='paid' AND created_at>$2 AND id<>$3`,[o.tenant_id,o.created_at,o.id]);
    if(newer.rows.length) {
      await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'staff.review',$2,$3) ON CONFLICT(key) DO NOTHING`,[o.tenant_id,`stale-payment:${o.id}`,JSON.stringify({orderId:o.id,note:'Delayed payment after a newer paid order. Review/refund without overwriting current entitlements.'})]);
      await c.query(`UPDATE orders SET status='paid',paid_at=now() WHERE id=$1`,[o.id]);
      return finish('ignored','newer paid order exists',o.id);
    }
    await c.query(`UPDATE orders SET status='paid', paid_at=now() WHERE id=$1`, [o.id]);

    const plan = (await c.query<PlanVersion>(`SELECT * FROM plan_versions WHERE id=$1`, [o.plan_version_id])).rows[0];
    await c.query(
      `UPDATE subscriptions SET status='active', period_start=now(), period_end=CASE WHEN plan_version_id=$2 THEN greatest(now(),period_end) ELSE now() END + interval '1 month', plan_version_id=$2,
         scheduled_plan_version_id=NULL, cancel_at_period_end=false, grace_until=NULL, updated_at=now()
       WHERE tenant_id=$1`, [o.tenant_id, plan.id]);
    await applyPlanEntitlements(c, o.tenant_id, plan, `order:${o.id}`);
    await onOrderPaid(c, { id: o.id, reference: o.reference }, plan.name);   // add-on requests waiting on this payment can now start their delivery window

    // minimum setup information: a legal entity name. Clock for the activation target starts when this is met.
    const ent = (await c.query<any>(`SELECT legal_name FROM entities WHERE tenant_id=$1 ORDER BY created_at LIMIT 1`, [o.tenant_id])).rows[0];
    const needInfo = !ent?.legal_name;
    await c.query(
      `INSERT INTO provision_jobs(order_id,tenant_id,state,owner_action,queued_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (order_id) DO NOTHING`,
      [o.id, o.tenant_id, needInfo ? "information_pending" : "queued", needInfo ? "Add your legal entity name in Settings to start activation." : null]);
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email',$2,$3) ON CONFLICT (key) DO NOTHING`,
      [o.tenant_id, `payment-received:${o.id}`, JSON.stringify({ template: "payment_received", orderId: o.id, reference: o.reference })]);
    await audit(c, o.tenant_id, { kind: "system" }, "order.paid", "order", o.id, { plan: plan.plan_code, event: ev.event_id });
    await accrueCommission(c, o);
    return finish("applied", undefined, o.id);
  });
}

/** Simulated provider used in development/test only: posts a correctly signed event through the real webhook path. */
export function buildMockEvent(o: { id: string; reference: string; total_minor: number; currency: string }, type: PaymentEvent["type"] = "payment.succeeded"): PaymentEvent {
  return { event_id: `evt_${randomToken(10)}`, type, order_id: o.id, reference: o.reference, amount_minor: Number(o.total_minor), currency: o.currency };
}

// ── Plan lifecycle
export async function scheduleDowngrade(db: Db, tenantId: string, userId: string, planCode: string) {
  return db.system(async (c) => {
    const plan = (await currentPlans(c)).find((p) => p.plan_code === planCode);
    if (!plan) throw badRequest("Unknown plan");
    const current=(await c.query<any>(`SELECT p.monthly_minor FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id WHERE s.tenant_id=$1`,[tenantId])).rows[0];
    if(plan.contact_sales||plan.monthly_minor>Number(current?.monthly_minor??0))throw badRequest('Use verified checkout for upgrades. This action schedules a downgrade only.');
    const preview = await previewPlanChange(c, tenantId, plan);
    await c.query(`UPDATE subscriptions SET scheduled_plan_version_id=$2, updated_at=now() WHERE tenant_id=$1`, [tenantId, plan.id]);
    await audit(c, tenantId, { kind: "user", userId }, "subscription.downgrade_scheduled", "subscription", tenantId, { plan: planCode, issues: preview.issues });
    return preview;
  });
}

export async function cancelAtPeriodEnd(db: Db, tenantId: string, userId: string) {
  await db.system(async (c) => {
    await c.query(`UPDATE subscriptions SET cancel_at_period_end=true, updated_at=now() WHERE tenant_id=$1`, [tenantId]);
    await audit(c, tenantId, { kind: "user", userId }, "subscription.cancel_scheduled", "subscription", tenantId);
  });
}

/**
 * Renewal housekeeping: apply scheduled downgrades/cancellations at period end, start grace for lapsed paid periods.
 * Reduced entitlements block *new* excess records only; nothing is deleted and everything stays exportable.
 */
export async function applyDueSubscriptionChanges(db: Db, now = new Date(), graceDays = 7) {
  return db.system(async (c) => {
    const free = (await currentPlans(c)).find((p) => p.plan_code === "free")!;
    const due = await c.query<any>(`SELECT * FROM subscriptions WHERE period_end IS NOT NULL AND period_end <= $1`, [now]);
    const changed: string[] = [];
    for (const s of due.rows) {
      if (s.scheduled_plan_version_id || s.cancel_at_period_end) {
        const target = s.scheduled_plan_version_id
          ? (await c.query<PlanVersion>(`SELECT * FROM plan_versions WHERE id=$1`, [s.scheduled_plan_version_id])).rows[0]
          : free;
        const isFree = target.monthly_minor === 0;
        await c.query(
          `UPDATE subscriptions SET plan_version_id=$2, status='active', period_start=$3,
             period_end = CASE WHEN $4 THEN NULL ELSE $3::timestamptz END,
             scheduled_plan_version_id=NULL, cancel_at_period_end=false, updated_at=now() WHERE id=$1`,
          [s.id, target.id, now, isFree]);
        await applyPlanEntitlements(c, s.tenant_id, target, `renewal:${now.toISOString().slice(0, 10)}`);
        await audit(c, s.tenant_id, { kind: "system" }, "subscription.plan_applied", "subscription", s.id, { plan: target.plan_code });
        changed.push(s.tenant_id);
      } else if (s.status === "active") {
        // unpaid lapse: published grace period precedes restriction
        await c.query(`UPDATE subscriptions SET status='grace', grace_until=$2::timestamptz + ($3 || ' days')::interval, updated_at=now() WHERE id=$1`, [s.id, now, String(graceDays)]);
        changed.push(s.tenant_id);
      } else if (s.status === "grace" && s.grace_until && new Date(s.grace_until) <= now) {
        await c.query(`UPDATE subscriptions SET status='restricted', updated_at=now() WHERE id=$1`, [s.id]);
        changed.push(s.tenant_id);
      }
    }
    return changed;
  });
}

export function requireProvider(name: string) {
  if (name !== config.paymentProvider) throw new HttpError(404, "Unknown payment provider");
}
