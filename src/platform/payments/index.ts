import { config } from "../../config.js";
import { stripeAdapter } from "./stripe.js";
import { razorpayAdapter } from "./razorpay.js";
import type { PaymentAdapter } from "./types.js";

export * from "./types.js";
export { stripeAdapter, razorpayAdapter };

/** Real providers only; "mock" is handled by the simulated checkout and its own signed webhook. */
export function getAdapter(name: string): PaymentAdapter | null {
  if (name === "stripe" && config.paymentProviders.includes("stripe")) return stripeAdapter();
  if (name === "razorpay" && config.paymentProviders.includes("razorpay")) return razorpayAdapter();
  return null;
}
export const enabledProviders = () => config.paymentProviders.filter((p) => p === "mock" || !!getAdapter(p));
