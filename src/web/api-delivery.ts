import { Hono, type Context } from "hono";
import { z } from "zod";
import { HttpError, baseUrl } from "../lib/util.js";
import { permsFor, type Ctx } from "../lib/perms.js";
import { rateLimit } from "../lib/ratelimit.js";
import { PUBLIC_STEP, cancelShipment, ensureShipment, listRemittances } from "../ops/delivery.js";
import { authenticateApiKey } from "../ops/delivery-notify.js";
import type { Env } from "./mw.js";

/**
 * Merchant API v1 (server-to-server, bearer key). A key belongs to ONE merchant of ONE company: every query is filtered by that merchant,
 * so a key can never read or create another merchant's parcels. Cookies and sessions are never consulted.
 */
export const deliveryApi = new Hono<Env>();
const fail = (c: Context, status: number, code: string, message: string, headers: Record<string, string> = {}) => c.json({ error: { code, message } }, status as any, headers);

deliveryApi.use("/api/v1/*", async (c, next) => {
  const raw = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const p = raw ? await authenticateApiKey(c.get("db"), raw) : null;
  if (!p) return fail(c, 401, "unauthorized", "Missing, invalid or revoked API key.", { "www-authenticate": 'Bearer realm="LOADBYTON"' });
  try { await rateLimit(`api:${p.keyId}`, 120, 60); }
  catch { return fail(c, 429, "rate_limited", "Too many requests: 120 per minute per key.", { "retry-after": "30" }); }
  c.set("apiKey", p);
  c.header("cache-control", "no-store");
  await next();
});

async function ctxFor(c: Context<Env>): Promise<Ctx> {
  const p = c.get("apiKey")!;
  const ok = (await c.get("db").query<any>(`SELECT 1 FROM tenant_sectors WHERE tenant_id=$1 AND sector='courier-last-mile'`, [p.tenantId])).rows.length;
  if (!ok) throw new HttpError(403, "This company has not enabled the courier module.", "forbidden");
  let userId = p.createdBy;
  if (!userId) userId = (await c.get("db").query<any>(`SELECT user_id FROM memberships WHERE tenant_id=$1 AND active AND 'owner'=ANY(roles) ORDER BY created_at LIMIT 1`, [p.tenantId])).rows[0]?.user_id;
  return { userId: userId!, tenantId: p.tenantId, roles: ["api"], perms: permsFor([]).add("read").add("dlv.write"), partyId: p.merchantId, driverId: null, readOnly: false, supportStaffId: null };
}
const handle = (fn: (c: Context<Env>, ctx: Ctx, merchantId: string) => Promise<Response>) => async (c: Context<Env>) => {
  try { return await fn(c, await ctxFor(c), c.get("apiKey")!.merchantId); }
  catch (e) {
    if (e instanceof z.ZodError) return fail(c, 400, "invalid_request", e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    if (e instanceof HttpError && e.status < 500) return fail(c, e.status, e.code === "error" ? "invalid_request" : e.code, e.message);
    console.error("[api]", c.req.method, c.req.path, e);
    return fail(c, 500, "server_error", "Something went wrong on our side. Retry; the request is safe to repeat.");
  }
};

const present = (s: any, steps: { at: string; event: string }[] = []) => ({
  waybill: s.no, reference: s.external_ref, status: s.status, emirate: s.emirate, cod: { amount: Number(s.cod_minor) / 100, currency: "AED" },
  attempts: s.attempts, max_attempts: s.max_attempts, last_failure: s.last_failure, delivered_at: s.delivered_at ? new Date(s.delivered_at).toISOString() : null,
  received_by: s.delivered_to, delivery_code: s.require_code ? s.delivery_code : null, tracking_url: `${baseUrl()}/t/${s.track_token}`, created_at: new Date(s.created_at).toISOString(), history: steps,
});
const Create = z.object({
  reference: z.string().trim().min(1).max(80), consignee_name: z.string().trim().min(1).max(150), consignee_phone: z.string().max(40).optional(),
  address: z.string().trim().min(1).max(400), emirate: z.string().min(1), origin_emirate: z.string().optional(),
  cod: z.union([z.number().min(0).max(50000), z.string().regex(/^\d+(\.\d{1,2})?$/)]).optional(), pieces: z.number().int().min(1).max(999).optional(),
  weight_kg: z.number().min(0).max(100000).optional(), description: z.string().max(300).optional(), require_code: z.boolean().optional(),
  deliver_by: z.string().max(40).optional(), max_attempts: z.number().int().min(1).max(10).optional(),
}).strict();

deliveryApi.post("/api/v1/parcels", handle(async (c, ctx, merchantId) => {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return fail(c, 400, "invalid_json", "The body must be JSON."); }
  const b = Create.parse(raw);
  const r = await c.get("db").tenant(ctx.tenantId, (cn) => ensureShipment(cn, ctx, {
    merchant_id: merchantId, external_ref: b.reference, consignee_name: b.consignee_name, consignee_phone: b.consignee_phone, address: b.address, emirate: b.emirate,
    origin_emirate: b.origin_emirate, cod: b.cod === undefined ? undefined : String(b.cod), pieces: b.pieces, weight_kg: b.weight_kg, description: b.description,
    require_code: b.require_code, deliver_by: b.deliver_by, max_attempts: b.max_attempts,
  }));
  const s = (await c.get("db").tenant(ctx.tenantId, (cn) => cn.query<any>(`SELECT * FROM dlv_shipments WHERE id=$1`, [r.id]))).rows[0];
  return c.json({ ...present(s), created: r.created }, r.created ? 201 : 200);          // a repeated reference returns the same parcel (idempotent)
}));

deliveryApi.get("/api/v1/parcels", handle(async (c, ctx, merchantId) => {
  const q = z.object({ status: z.enum(["new", "assigned", "out_for_delivery", "delivered", "undelivered", "return_to_sender", "returned", "cancelled"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), before: z.string().max(40).optional() }).parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const rows = (await c.get("db").tenant(ctx.tenantId, (cn) => cn.query<any>(
    `SELECT * FROM dlv_shipments s WHERE s.merchant_id=$1 AND ($2::text IS NULL OR s.status=$2)
       AND ($3::text IS NULL OR (s.created_at, s.no) < (SELECT created_at, no FROM dlv_shipments WHERE merchant_id=$1 AND no=$3))
     ORDER BY s.created_at DESC, s.no DESC LIMIT $4`, [merchantId, q.status ?? null, q.before ?? null, q.limit]))).rows;
  return c.json({ data: rows.map((s) => present(s)), next_before: rows.length === q.limit ? rows[rows.length - 1].no : null });
}));

deliveryApi.get("/api/v1/parcels/:id", handle(async (c, ctx, merchantId) => {
  const id = c.req.param("id");
  const d = await c.get("db").tenant(ctx.tenantId, async (cn) => {
    const s = (await cn.query<any>(`SELECT * FROM dlv_shipments WHERE merchant_id=$1 AND (no=$2 OR external_ref=$2)`, [merchantId, id])).rows[0];
    if (!s) return null;
    const ev = (await cn.query<any>(`SELECT kind, effective_time FROM dlv_events WHERE shipment_id=$1 AND applied AND kind <> 'note' ORDER BY effective_time, server_time`, [s.id])).rows;
    return { s, steps: ev.filter((e) => PUBLIC_STEP[e.kind]).map((e) => ({ at: new Date(e.effective_time).toISOString(), event: PUBLIC_STEP[e.kind] })) };
  });
  return d ? c.json(present(d.s, d.steps)) : fail(c, 404, "not_found", "No parcel with that waybill or reference for this key.");
}));

deliveryApi.post("/api/v1/parcels/:id/cancel", handle(async (c, ctx, merchantId) => {
  const id = c.req.param("id");
  const found = (await c.get("db").tenant(ctx.tenantId, (cn) => cn.query<any>(`SELECT id FROM dlv_shipments WHERE merchant_id=$1 AND (no=$2 OR external_ref=$2)`, [merchantId, id]))).rows[0];
  if (!found) return fail(c, 404, "not_found", "No parcel with that waybill or reference for this key.");
  await c.get("db").tenant(ctx.tenantId, (cn) => cancelShipment(cn, ctx, found.id));
  const s = (await c.get("db").tenant(ctx.tenantId, (cn) => cn.query<any>(`SELECT * FROM dlv_shipments WHERE id=$1`, [found.id]))).rows[0];
  return c.json(present(s));
}));

deliveryApi.get("/api/v1/remittances", handle(async (c, ctx, merchantId) => {
  const rows = await c.get("db").tenant(ctx.tenantId, (cn) => listRemittances(cn, merchantId));
  return c.json({ data: rows.map((r) => ({ statement: r.no, status: r.status === "pending_payment" ? "being_prepared" : r.status, parcels: r.parcels, cod_collected: Number(r.gross_minor) / 100, fees: Number(r.fees_minor) / 100, paid_to_you: Number(r.net_minor) / 100, currency: "AED", bank_reference: r.pay_reference ?? null, paid_at: r.paid_at ? new Date(r.paid_at).toISOString() : null })) });
}));

deliveryApi.all("/api/*", (c) => fail(c, 404, "not_found", "Unknown endpoint."));
