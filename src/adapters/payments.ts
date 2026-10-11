import { config } from '../config.js';
import { badRequest, hmac, safeEqual,HttpError } from '../lib/util.js';
import type { PaymentEvent } from '../platform/billing.js';
import { providerJson, type Fetcher } from './http.js';

export interface ProviderOrder { id: string; reference: string; total_minor: number; currency: string; payment_currency?:string;payment_total_minor?:number; provider_session?: string; checkout_url?: string }
const amount=(o:ProviderOrder)=>Number(o.payment_total_minor??o.total_minor);
const currency=(o:ProviderOrder)=>o.payment_currency??o.currency;
export interface CheckoutSession { id: string; url: string }
export interface PaymentAdapter {
  create(order: ProviderOrder): Promise<CheckoutSession>;
  decode(raw: string, signature: string, eventId?: string): Promise<PaymentEvent | null>;
  reconcile(order: ProviderOrder): Promise<PaymentEvent | null>;
}
const metadata = (o: ProviderOrder) => ({ lbt_order_id: o.id, lbt_reference: o.reference });
const verifiedUrl = (url: string, allowed: string[]) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !allowed.includes(u.hostname)) throw new Error('Unexpected checkout URL from provider');
  return url;
};
const normal = (eventId: string, type: PaymentEvent['type'], meta: any, amount: number, currency: string, session?: string): PaymentEvent => {
  if (!meta?.lbt_order_id || !meta?.lbt_reference || !Number.isSafeInteger(amount) || amount < 0 || !/^[a-z]{3}$/i.test(currency)) throw badRequest('Incomplete provider payment metadata');
  return { event_id: eventId, type, order_id: meta.lbt_order_id, reference: meta.lbt_reference, amount_minor: amount, currency: currency.toUpperCase(), provider_session: session };
};

export function stripeAdapter(settings = config.stripe, fetcher: Fetcher = fetch): PaymentAdapter {
  const api = (path: string, init: RequestInit = {}) => providerJson('Stripe', `https://api.stripe.com/v1/${path}`, {
    ...init, headers: { Authorization: `Bearer ${settings.key}`, 'Stripe-Version': '2025-02-24.acacia', ...init.headers },
  }, fetcher);
  return {
    async create(o) {
      if (!settings.key) throw badRequest('Stripe is not configured');
      const b = new URLSearchParams({ mode: 'payment', client_reference_id: o.reference,
        success_url: `${config.baseUrl}/app/billing?ok=Payment+submitted.+Awaiting+server+verification.`, cancel_url: `${config.baseUrl}/app/billing`,
        'line_items[0][price_data][currency]': currency(o).toLowerCase(), 'line_items[0][price_data][unit_amount]': String(amount(o)),
        'line_items[0][price_data][product_data][name]': `LOAD|BY|TON service ${o.reference}`, 'line_items[0][quantity]': '1',
      });
      for (const [k, v] of Object.entries(metadata(o))) { b.set(`metadata[${k}]`, v); b.set(`payment_intent_data[metadata][${k}]`, v); }
      // Hosted Checkout presents enabled card/wallet methods, including Google Pay when eligible.
      const s = await api('checkout/sessions', { method: 'POST', body: b, headers: { 'Idempotency-Key': `lbt-checkout-${o.id}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (s.amount_total !== amount(o) || s.currency?.toUpperCase() !== currency(o)) throw new Error('Stripe checkout amount mismatch');
      return { id: s.id, url: verifiedUrl(s.url, ['checkout.stripe.com']) };
    },
    async decode(raw, signature) {
      const fields = signature.split(',').map(x => x.split('='));
      const t = Number(fields.find(([k]) => k === 't')?.[1]);
      if (!settings.webhookSecret || !Number.isSafeInteger(t) || Math.abs(Date.now() / 1000 - t) > 300 || !fields.some(([k,v]) => k === 'v1' && safeEqual(v ?? '', hmac(settings.webhookSecret, `${t}.${raw}`)))) throw new HttpError(401,'Invalid Stripe signature');
      const ev = JSON.parse(raw), o = ev.data?.object;
      if (!ev.id || !o) throw badRequest('Invalid Stripe event');
      if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(ev.type)) {
        if (o.payment_status !== 'paid') return null;
        return normal(ev.id, 'payment.succeeded', o.metadata, o.amount_total, o.currency, o.id);
      }
      if (ev.type === 'checkout.session.async_payment_failed') return normal(ev.id, 'payment.failed', o.metadata, o.amount_total, o.currency, o.id);
      if (ev.type === 'charge.refunded') return normal(ev.id, o.refunded && o.amount_refunded === o.amount ? 'payment.refunded' : 'payment.review', o.metadata, o.amount, o.currency);
      if (ev.type?.startsWith('charge.dispute.')) {
        const pi = await api(`payment_intents/${encodeURIComponent(o.payment_intent)}`);
        return normal(ev.id, 'payment.review', pi.metadata, pi.amount, pi.currency);
      }
      return null;
    },
    async reconcile(o) {
      if (!o.provider_session) return null;
      const s = await api(`checkout/sessions/${encodeURIComponent(o.provider_session)}`);
      return s.payment_status === 'paid' ? normal(`reconcile:${s.id}`, 'payment.succeeded', s.metadata, s.amount_total, s.currency, s.id) : null;
    },
  };
}

export function razorpayAdapter(settings = config.razorpay, fetcher: Fetcher = fetch): PaymentAdapter {
  const api = (path: string, init: RequestInit = {}) => providerJson('Razorpay', `https://api.razorpay.com/v1/${path}`, {
    ...init, headers: { Authorization: `Basic ${Buffer.from(`${settings.keyId}:${settings.keySecret}`).toString('base64')}`, 'Content-Type': 'application/json', ...init.headers },
  }, fetcher);
  const paid = (id: string, link: any) => normal(id, 'payment.succeeded', link.notes, link.amount_paid, link.currency, link.id);
  return {
    async create(o) {
      if (!settings.keyId || !settings.keySecret) throw badRequest('Razorpay is not configured');
      // reference_id is unique at Razorpay. Discover the original link after an ambiguous timeout.
      const existing = await api(`payment_links?reference_id=${encodeURIComponent(o.reference)}`);
      let link = existing.payment_links?.find((l: any) => l.reference_id === o.reference);
      if (!link) link = await api('payment_links', { method: 'POST', body: JSON.stringify({ amount: amount(o), currency: currency(o),
        accept_partial: false, reference_id: o.reference, description: `LOAD|BY|TON service ${o.reference}`, notes: metadata(o),
        notify: { sms: false, email: false }, reminder_enable: false, callback_url: `${config.baseUrl}/app/billing`, callback_method: 'get',
      }) });
      if (link.amount !== amount(o) || link.currency !== currency(o) || link.notes?.lbt_order_id !== o.id) throw new Error('Razorpay checkout amount/reference mismatch');
      return { id: link.id, url: verifiedUrl(link.short_url, ['rzp.io','razorpay.com']) };
    },
    async decode(raw, signature, eventId) {
      if (!settings.webhookSecret || !safeEqual(signature, hmac(settings.webhookSecret, raw))) throw new HttpError(401,'Invalid Razorpay signature');
      const ev = JSON.parse(raw);
      // Razorpay retries are not timestamp-resigned. Persisted unique event IDs supply replay protection.
      if (!eventId || eventId.length > 120) throw badRequest('Missing Razorpay event ID');
      if (ev.event === 'payment_link.paid') return paid(eventId, ev.payload.payment_link.entity);
      if (ev.event === 'payment.failed') {
        const p = ev.payload.payment.entity;
        if (!p.notes?.lbt_order_id) return null;
        return normal(eventId, 'payment.failed', p.notes, p.amount, p.currency);
      }
      if (ev.event === 'refund.processed' || ev.event?.startsWith('payment.dispute.')) {
        const r = ev.payload.refund?.entity ?? ev.payload.dispute?.entity;
        const p = await api(`payments/${encodeURIComponent(r.payment_id)}`);
        const type = ev.event === 'refund.processed' && p.amount_refunded === p.amount ? 'payment.refunded' : 'payment.review';
        // Some payment-link payments carry notes only on the link: reconciliation staff handles unmapped events.
        if (!p.notes?.lbt_order_id) throw badRequest('Payment lacks LOADBYTON metadata; reconcile manually');
        return normal(eventId, type, p.notes, p.amount, p.currency);
      }
      return null;
    },
    async reconcile(o) {
      if (!o.provider_session) return null;
      const link = await api(`payment_links/${encodeURIComponent(o.provider_session)}`);
      return link.status === 'paid' ? paid(`reconcile:${link.id}`, link) : null;
    },
  };
}

export const paymentAdapter = (name: string): PaymentAdapter => {
  if (name === 'stripe') return stripeAdapter();
  if (name === 'razorpay') return razorpayAdapter();
  throw badRequest('Unknown payment provider');
};
