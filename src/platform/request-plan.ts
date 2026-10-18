import type { Db } from "../db/client.js";
import { HttpError, badRequest } from "../lib/util.js";
import { createOrder, priceCheckout } from "./billing.js";
import { currentPlans } from "./catalog.js";
import type { ServiceRequest } from "./requests.js";

/**
 * Paying for the monthly plan that a paid add-on request needs. The order is the ordinary subscription order (same checkout, webhook and
 * receipt as any plan); this only ties it to the request, so the 24-hour window can start when the provider confirms the payment.
 */
export async function payForRequest(db: Db, tenantId: string, userId: string, requestId: string, provider?: string) {
  const r = (await db.tenant(tenantId, (c) => c.query<ServiceRequest>(`SELECT * FROM service_requests WHERE id=$1`, [requestId]))).rows[0];
  if (!r) throw new HttpError(404, "Request not found", "not_found");
  if (!["received", "in_build", "ready"].includes(r.status)) throw badRequest("This request is already closed.");
  if (r.category !== "paid" || !r.plan_code) throw badRequest("This request has no plan to pay for.");
  if (r.quote_note) throw badRequest("This request is already paid for or covered by your current plan.");
  const o = await createOrder(db, tenantId, userId, r.plan_code, provider);
  await db.tenant(tenantId, (c) => c.query(`UPDATE service_requests SET order_id=$2, updated_at=now() WHERE id=$1 AND quote_note IS NULL`, [requestId, o.orderId]));
  return o;
}

/** The checkout price for the plan a request needs, as the client would see it at payment. */
export async function planPrice(db: Db, tenantId: string, planCode: string) {
  return db.system(async (c) => {
    const plan = (await currentPlans(c)).find((p) => p.plan_code === planCode);
    if (!plan) throw badRequest("Unknown plan");
    return { plan, price: await priceCheckout(c, tenantId, plan) };
  });
}
