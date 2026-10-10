export interface PaymentEvent {
  event_id: string; type: "payment.succeeded" | "payment.failed" | "payment.refunded";
  /** Empty for a refund the provider reports without our metadata; resolved from `provider_ref` when the event is processed. */
  order_id: string; reference: string; amount_minor: number; currency: string;
  /** The provider's own payment handle (Stripe PaymentIntent, Razorpay payment id): lets a later refund find its order. */
  provider_ref?: string;
}

export interface CheckoutOrder {
  id: string; reference: string; total_minor: number; currency: string; planName: string;
  lines: { label: string; amount_minor: number }[];       // itemised; sums to total_minor (tax is a line)
  payerEmail?: string;
}
export interface CheckoutUrls { success: string; cancel: string }
export interface CheckoutSession { providerSession: string; url: string }

export class WebhookSignatureError extends Error {}
export class ProviderError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type HeaderGetter = (name: string) => string | undefined;

export interface PaymentAdapter {
  name: string;
  /** Human label for the checkout button. */
  label: string;
  createCheckout(o: CheckoutOrder, urls: CheckoutUrls): Promise<CheckoutSession>;
  /** Verify the signature over the RAW body and translate the provider's event into zero or one internal event. Throws WebhookSignatureError. */
  parseWebhook(raw: string, header: HeaderGetter, now?: number): { event: PaymentEvent | null; ignored?: string };
}
