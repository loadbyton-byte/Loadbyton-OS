import crypto from "node:crypto";
import { config } from "../../config.js";
import { safeEqual } from "../../lib/util.js";
import { ProviderError, WebhookSignatureError, type CheckoutOrder, type CheckoutSession, type CheckoutUrls, type Fetch, type HeaderGetter, type PaymentAdapter, type PaymentEvent } from "./types.js";

export interface StripeConfig { secretKey: string; webhookSecret: string; apiBase: string; paymentMethods: string[] }
const TOLERANCE_S = 300;

/** Stripe-Signature: `t=<unix>,v1=<hex>[,v1=<hex>…]`; v1 = HMAC-SHA256(`${t}.${rawBody}`, endpoint secret). Any listed v1 may match (secret rotation). */
export function verifyStripeSignature(raw: string, header: string | undefined, secret: string, now = Date.now()) {
  if (!header || !secret) return false;
  let t = 0; const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("="); if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v); else if (k === "v1") sigs.push(v);
  }
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > TOLERANCE_S) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return sigs.some((s) => safeEqual(s, expected));
}
/** For tests and tooling that need to post a correctly signed event. */
export const signStripePayload = (raw: string, secret: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

const form = (pairs: [string, string][]) => new URLSearchParams(pairs).toString();

export function stripeAdapter(cfg: StripeConfig = config.stripe, fetchImpl: Fetch = fetch): PaymentAdapter {
  return {
    name: "stripe",
    label: "Pay by card, Google Pay or Apple Pay (Stripe)",

    async createCheckout(o: CheckoutOrder, urls: CheckoutUrls): Promise<CheckoutSession> {
      const p: [string, string][] = [
        ["mode", "payment"], ["client_reference_id", o.id], ["success_url", urls.success], ["cancel_url", urls.cancel],
        ["metadata[order_id]", o.id], ["metadata[reference]", o.reference],
        ["payment_intent_data[metadata][order_id]", o.id], ["payment_intent_data[metadata][reference]", o.reference],
        ["payment_intent_data[description]", `LOAD|BY|TON ${o.planName} · ${o.reference}`],
      ];
      if (o.payerEmail) p.push(["customer_email", o.payerEmail]);
      cfg.paymentMethods.forEach((m, i) => p.push([`payment_method_types[${i}]`, m]));
      o.lines.filter((l) => l.amount_minor > 0).forEach((l, i) => {
        p.push([`line_items[${i}][quantity]`, "1"], [`line_items[${i}][price_data][currency]`, o.currency.toLowerCase()],
          [`line_items[${i}][price_data][unit_amount]`, String(l.amount_minor)], [`line_items[${i}][price_data][product_data][name]`, l.label.slice(0, 250)]);
      });
      const sum = o.lines.reduce((a, l) => a + l.amount_minor, 0);
      if (sum !== o.total_minor) throw new ProviderError(`order lines (${sum}) do not add up to the total (${o.total_minor})`, 500);
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.apiBase}/v1/checkout/sessions`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": `lbt-checkout-${o.id}` },
          body: form(p), signal: AbortSignal.timeout(15_000),
        });
      } catch { throw new ProviderError("The card payment service could not be reached. Nothing was charged; please try again."); }
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || !body.id || !body.url) {
        console.error("[stripe] checkout failed", res.status, body?.error?.type, body?.error?.code, body?.error?.message);
        throw new ProviderError("The card payment service refused to start this checkout. Nothing was charged; please try again or contact support.");
      }
      return { providerSession: String(body.id), url: String(body.url) };
    },

    parseWebhook(raw: string, header: HeaderGetter, now = Date.now()) {
      if (!verifyStripeSignature(raw, header("stripe-signature"), cfg.webhookSecret, now)) throw new WebhookSignatureError("invalid signature");
      let ev: any;
      try { ev = JSON.parse(raw); } catch { throw new WebhookSignatureError("invalid payload"); }
      const obj = ev?.data?.object ?? {};
      const base = { event_id: String(ev.id) };
      const fromSession = (type: PaymentEvent["type"]): PaymentEvent => ({
        ...base, type, order_id: String(obj.metadata?.order_id ?? obj.client_reference_id ?? ""), reference: String(obj.metadata?.reference ?? ""),
        amount_minor: Number(obj.amount_total ?? 0), currency: String(obj.currency ?? "").toUpperCase(),
        provider_ref: typeof obj.payment_intent === "string" ? obj.payment_intent : undefined,
      });
      switch (ev.type) {
        case "checkout.session.completed":
          // asynchronous methods complete the session before the money arrives: wait for async_payment_succeeded
          return obj.payment_status === "paid" ? { event: fromSession("payment.succeeded") } : { event: null, ignored: `payment_status=${obj.payment_status}` };
        case "checkout.session.async_payment_succeeded": return { event: fromSession("payment.succeeded") };
        case "checkout.session.async_payment_failed":
        case "checkout.session.expired": return { event: fromSession("payment.failed") };
        case "charge.refunded":
          if (obj.refunded !== true) return { event: null, ignored: "partial refund: staff decide the treatment" };
          return { event: { ...base, type: "payment.refunded", order_id: String(obj.metadata?.order_id ?? ""), reference: String(obj.metadata?.reference ?? ""),
            amount_minor: Number(obj.amount ?? 0), currency: String(obj.currency ?? "").toUpperCase(), provider_ref: typeof obj.payment_intent === "string" ? obj.payment_intent : undefined } };
        default: return { event: null, ignored: `event type ${ev.type} is not used` };
      }
    },
  };
}
