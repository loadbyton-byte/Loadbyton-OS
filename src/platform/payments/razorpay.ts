import crypto from "node:crypto";
import { config } from "../../config.js";
import { safeEqual } from "../../lib/util.js";
import { ProviderError, WebhookSignatureError, type CheckoutOrder, type CheckoutSession, type CheckoutUrls, type Fetch, type HeaderGetter, type PaymentAdapter, type PaymentEvent } from "./types.js";

export interface RazorpayConfig { keyId: string; keySecret: string; webhookSecret: string; apiBase: string }

/** X-Razorpay-Signature = hex HMAC-SHA256 of the RAW body with the webhook secret. Razorpay sends no timestamp, so replay safety is the event-id uniqueness. */
export const signRazorpayPayload = (raw: string, secret: string) => crypto.createHmac("sha256", secret).update(raw).digest("hex");
export function verifyRazorpaySignature(raw: string, header: string | undefined, secret: string) {
  if (!header || !secret) return false;
  return safeEqual(header.trim(), signRazorpayPayload(raw, secret));
}

/**
 * Hosted Payment Links (UPI incl. Google Pay, cards, netbanking, wallets as enabled on the account): no browser script is needed, which keeps
 * our strict Content-Security-Policy intact. Currency is the order's currency; the account needs international payments enabled for AED.
 */
export function razorpayAdapter(cfg: RazorpayConfig = config.razorpay, fetchImpl: Fetch = fetch): PaymentAdapter {
  return {
    name: "razorpay",
    label: "Pay with UPI, Google Pay or card (Razorpay)",

    async createCheckout(o: CheckoutOrder, urls: CheckoutUrls): Promise<CheckoutSession> {
      const body = {
        amount: o.total_minor, currency: o.currency.toUpperCase(), accept_partial: false, reference_id: o.reference,
        description: `LOAD|BY|TON ${o.planName} · ${o.reference}`.slice(0, 2048),
        ...(o.payerEmail ? { customer: { email: o.payerEmail } } : {}),
        notify: { sms: false, email: false }, reminder_enable: false,
        callback_url: urls.success, callback_method: "get",
        expire_by: Math.floor(Date.now() / 1000) + 24 * 3600 - 60,
        notes: { order_id: o.id, reference: o.reference },
      };
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.apiBase}/v1/payment_links`, {
          method: "POST",
          headers: { authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64")}`, "content-type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
        });
      } catch { throw new ProviderError("The payment service could not be reached. Nothing was charged; please try again."); }
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out.id || !out.short_url) {
        console.error("[razorpay] payment link failed", res.status, out?.error?.code, out?.error?.description);
        throw new ProviderError("The payment service refused to start this checkout. Nothing was charged; please try again or contact support.");
      }
      return { providerSession: String(out.id), url: String(out.short_url) };
    },

    parseWebhook(raw: string, header: HeaderGetter) {
      if (!verifyRazorpaySignature(raw, header("x-razorpay-signature"), cfg.webhookSecret)) throw new WebhookSignatureError("invalid signature");
      let ev: any;
      try { ev = JSON.parse(raw); } catch { throw new WebhookSignatureError("invalid payload"); }
      // Razorpay may redeliver with the same X-Razorpay-Event-Id; without the header, the body hash is a stable identity for the same payload
      const event_id = header("x-razorpay-event-id") || `body_${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;
      const link = ev?.payload?.payment_link?.entity, pay = ev?.payload?.payment?.entity, refund = ev?.payload?.refund?.entity;
      const fromLink = (type: PaymentEvent["type"], amount: number): PaymentEvent => ({
        event_id, type, order_id: String(link?.notes?.order_id ?? ""), reference: String(link?.reference_id ?? link?.notes?.reference ?? ""),
        amount_minor: amount, currency: String(link?.currency ?? "").toUpperCase(), provider_ref: pay?.id ? String(pay.id) : undefined,
      });
      switch (ev.event) {
        case "payment_link.paid": return { event: fromLink("payment.succeeded", Number(link?.amount_paid ?? link?.amount ?? 0)) };
        case "payment_link.cancelled":
        case "payment_link.expired": return { event: fromLink("payment.failed", Number(link?.amount ?? 0)) };
        case "refund.processed":
          if (!refund || !pay || Number(refund.amount) !== Number(pay.amount)) return { event: null, ignored: "partial refund: staff decide the treatment" };
          return { event: { event_id, type: "payment.refunded", order_id: "", reference: "", amount_minor: Number(pay.amount), currency: String(pay.currency ?? "").toUpperCase(), provider_ref: String(pay.id) } };
        default: return { event: null, ignored: `event ${ev.event} is not used` };   // payment.failed does NOT fail the order: the link stays payable
      }
    },
  };
}
