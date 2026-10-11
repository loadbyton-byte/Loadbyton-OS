import { badRequest } from "./util.js";

/** Exact minor-unit input: do not silently round money or accept unsafe integer amounts. */
export function deliveryMoney(value: unknown): number {
  const s = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) throw badRequest("Enter an amount with at most two decimal places.");
  const [whole, fraction = ""] = s.split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(n) || n > 1_000_000_000) throw badRequest("Amount is too large.");
  return n;
}
