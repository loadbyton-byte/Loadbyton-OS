import crypto from "node:crypto";
import type { Conn, Db } from "../db/client.js";
import { rateLimit } from "../adapters/rate-limit.js";
import { audit } from "../lib/audit.js";
import { decryptSecret, encryptSecret } from "../lib/encryption.js";
import { actorOf, require, type Ctx, type Perm } from "../lib/perms.js";
import { HttpError, badRequest, forbidden, randomToken, safeEqual, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";
import { cancelFulfilOrder, ingestChannelOrder, type OrderInput } from "./fulfilment.js";
import { channelUrl } from "./inbound.js";

/**
 * Storefront connectors for e-commerce fulfilment. A merchant's Shopify or WooCommerce store sends signed order webhooks to a per-connection secret URL.
 * Every delivery is kept as an immutable event with the outcome. A paid (or cash-on-delivery) order becomes a fulfilment order for that one merchant,
 * idempotently on the store's order number; a cancellation cancels the order only while it can still be cancelled. A delivery refused for a fixable
 * reason (an unknown SKU) is answered so that the platform redelivers it; one refused for a permanent reason is kept and answered normally.
 * Stock levels are not pushed back to the store: that needs the store's own app credentials and is a separate acceptance step.
 */
export type Platform = "shopify" | "woocommerce";
export const PLATFORMS: Record<Platform, { name: string; signature: string; hint: string }> = {
  shopify: { name: "Shopify", signature: "x-shopify-hmac-sha256", hint: "Settings → Notifications → Webhooks: events Order creation, Order payment and Order cancellation, format JSON; paste the signing secret Shopify shows." },
  woocommerce: { name: "WooCommerce", signature: "x-wc-webhook-signature", hint: "WooCommerce → Settings → Advanced → Webhooks: topics Order created and Order updated, status Active; enter your own secret." },
};
export const storefrontUrl = (token: string) => channelUrl(token).replace("/webhooks/inbound/", "/webhooks/storefront/");
const isPlatform = (v: unknown): v is Platform => typeof v === "string" && v in PLATFORMS;

async function gate(c: Conn, ctx: Ctx) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  if (!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='ecommerce-fulfilment'`)).rows.length) throw forbidden("The e-commerce fulfilment sector is not selected.");
}

export async function registerStorefront(c: Conn, ctx: Ctx, f: Record<string, any>) {
  await gate(c, ctx);
  if (!isPlatform(f.platform)) throw badRequest("Choose Shopify or WooCommerce.");
  const secret = reqStr(f.secret, "Signing secret", 200);
  if (secret.length < 8) throw badRequest("The signing secret must be at least 8 characters.");
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [recordId(f.party_id, "Merchant")]), "Merchant");
  const token = randomToken(24);
  const row = (await c.query<any>(`INSERT INTO storefront_connections(tenant_id,party_id,platform,label,token_hash,secret_enc,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, f.party_id, f.platform, reqStr(f.label, "Name", 80), sha256(token), encryptSecret(secret), ctx.userId]).catch((e) => {
    if (/unique/i.test(String(e.message))) throw badRequest("A connection with that name already exists."); throw e;
  })).rows[0];
  await audit(c, ctx.tenantId, actorOf(ctx), "storefront.registered", "storefront_connection", row.id, { platform: f.platform });
  return { id: row.id as string, url: storefrontUrl(token) };       // shown once
}
export async function setStorefrontStatus(c: Conn, ctx: Ctx, id: string, status: "active" | "paused" | "retired") {
  await gate(c, ctx);
  const cur = await must(c.query<any>(`SELECT status FROM storefront_connections WHERE id=$1 FOR UPDATE`, [recordId(id, "Connection")]), "Connection");
  if (cur.status === "retired") throw badRequest("A retired connection cannot be changed.");
  await c.query(`UPDATE storefront_connections SET status=$2 WHERE id=$1`, [id, status]);
  await audit(c, ctx.tenantId, actorOf(ctx), `storefront.${status}`, "storefront_connection", id);
}
export const listStorefronts = (c: Conn) => c.query<any>(
  `SELECT s.*, p.name AS party_name,
     (SELECT count(*) FROM storefront_events e WHERE e.connection_id=s.id AND e.outcome='ingested')::int AS ingested,
     (SELECT count(*) FROM storefront_events e WHERE e.connection_id=s.id AND e.outcome='rejected')::int AS rejected
   FROM storefront_connections s JOIN parties p ON p.id=s.party_id ORDER BY s.created_at DESC`).then((r) => r.rows);
export const recentStorefrontEvents = (c: Conn, limit = 50) => c.query<any>(
  `SELECT e.*, s.label FROM storefront_events e JOIN storefront_connections s ON s.id=e.connection_id ORDER BY e.id DESC LIMIT $1`, [limit]).then((r) => r.rows);

// ───────── payload mapping (pure)
type Mapped =
  | { kind: "order"; ref: string; order: Omit<OrderInput, "party_id"> }
  | { kind: "cancel"; ref: string }
  | { kind: "ignore"; why: string }
  | { kind: "invalid"; ref: string; reason: string };
const text = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function mergeLines(raw: { sku: unknown; qty: unknown }[]): { code: string; qty: number }[] | string {
  const by = new Map<string, number>();
  for (const l of raw) {
    const sku = text(l.sku, 80), qty = Number(l.qty);
    if (!sku) return "A line has no SKU, so it cannot be matched to stock.";
    if (!Number.isInteger(qty) || qty <= 0 || qty > 100_000) return `Line ${sku} has an invalid quantity.`;
    by.set(sku, (by.get(sku) ?? 0) + qty);
  }
  return [...by].map(([code, qty]) => ({ code, qty }));
}
export function mapShopify(topic: string, p: any): Mapped {
  if (!["orders/create", "orders/paid", "orders/cancelled"].includes(topic)) return { kind: "ignore", why: `Topic ${topic} is not used.` };
  const ref = text(p?.name ?? p?.id, 80);
  if (!ref) return { kind: "invalid", ref: "", reason: "The order has no number." };
  if (topic === "orders/cancelled") return { kind: "cancel", ref };
  if (!["paid", "pending", "authorized", "partially_paid"].includes(String(p?.financial_status ?? "pending"))) return { kind: "ignore", why: `Order is ${p?.financial_status}.` };
  const ship = (p.line_items ?? []).filter((l: any) => l?.requires_shipping !== false);
  if (!ship.length) return { kind: "invalid", ref, reason: "Nothing in the order needs shipping." };
  const lines = mergeLines(ship.map((l: any) => ({ sku: l.sku, qty: l.quantity })));
  if (typeof lines === "string") return { kind: "invalid", ref, reason: lines };
  const a = p.shipping_address;
  if (!a || !text(a.address1, 200)) return { kind: "invalid", ref, reason: "The order has no shipping address." };
  return { kind: "order", ref, order: {
    external_ref: ref, channel: "shopify", ship_to_name: text(a.name || `${a.first_name ?? ""} ${a.last_name ?? ""}`, 150) || text(p.customer?.first_name, 150), ship_to_phone: text(a.phone || p.phone || p.customer?.phone, 40),
    ship_to_address: [a.address1, a.address2, a.province].map((x) => text(x, 150)).filter(Boolean).join(", ").slice(0, 400), ship_to_city: text(a.city, 80), ship_to_country: text(a.country_code, 2) || "AE", lines } };
}
export function mapWoo(topic: string, p: any): Mapped {
  if (!["order.created", "order.updated"].includes(topic)) return { kind: "ignore", why: `Topic ${topic} is not used.` };
  const ref = text(p?.number ?? p?.id, 80);
  if (!ref) return { kind: "invalid", ref: "", reason: "The order has no number." };
  const status = String(p?.status ?? "");
  if (["cancelled", "refunded", "failed"].includes(status)) return { kind: "cancel", ref };
  if (!["processing", "on-hold"].includes(status)) return { kind: "ignore", why: `Order is ${status || "unknown"}.` };
  const lines = mergeLines((p.line_items ?? []).map((l: any) => ({ sku: l.sku, qty: l.quantity })));
  if (typeof lines === "string") return { kind: "invalid", ref, reason: lines };
  if (!lines.length) return { kind: "invalid", ref, reason: "The order has no lines." };
  const s = p.shipping?.address_1 ? p.shipping : p.billing ?? {};
  if (!text(s.address_1, 200)) return { kind: "invalid", ref, reason: "The order has no shipping address." };
  return { kind: "order", ref, order: {
    external_ref: ref, channel: "woocommerce", ship_to_name: text(`${s.first_name ?? ""} ${s.last_name ?? ""}`, 150), ship_to_phone: text(s.phone || p.billing?.phone, 40),
    ship_to_address: [s.address_1, s.address_2, s.state].map((x) => text(x, 150)).filter(Boolean).join(", ").slice(0, 400), ship_to_city: text(s.city, 80), ship_to_country: text(s.country, 2) || "AE", lines } };
}

// ───────── delivery handling
const feedCtx = (tenantId: string, userId: string): Ctx => ({ userId, tenantId, roles: ["warehouse"], perms: new Set<Perm>(["read", "wh.write"]), partyId: null, driverId: null, readOnly: false, supportStaffId: null });
async function serviceUser(db: Db, tenantId: string): Promise<string> {
  const email = `storefront-${tenantId}@service.invalid`;
  return (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'Storefront connector','!') ON CONFLICT (email) DO UPDATE SET name=users.name RETURNING id`, [email]))).rows[0].id;
}
const sign = (secret: string, raw: string) => crypto.createHmac("sha256", secret).update(raw).digest("base64");

export interface HookRequest { method: string; raw: string; header: (n: string) => string | undefined }
export async function handleStorefront(db: Db, token: string, req: HookRequest): Promise<{ status: number; body: unknown }> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token) || req.method !== "POST") return { status: 404, body: { error: "not found" } };
  const conn = (await db.system((c) => c.query<any>(`SELECT * FROM storefront_connections WHERE token_hash=$1`, [sha256(token)]))).rows[0];
  if (!conn || conn.status === "retired") return { status: 404, body: { error: "not found" } };
  await rateLimit(`storefront:${conn.id}`, 300, 60);
  if (req.raw.length > 1_000_000) return { status: 400, body: { error: "payload too large" } };
  const given = req.header(PLATFORMS[conn.platform as Platform].signature) ?? "";
  if (!given || !safeEqual(given, sign(decryptSecret(conn.secret_enc), req.raw))) return { status: 401, body: { error: "invalid signature" } };
  // WooCommerce sends a form-encoded ping when a webhook is saved; it is signed like any other delivery
  if (conn.platform === "woocommerce" && /^webhook_id=\d+/.test(req.raw)) return { status: 200, body: { ok: true, ping: true } };
  const topic = text(conn.platform === "shopify" ? req.header("x-shopify-topic") : req.header("x-wc-webhook-topic"), 60);
  let payload: any;
  try { payload = JSON.parse(req.raw); } catch { return { status: 400, body: { error: "send JSON" } }; }
  if (conn.status === "paused") return { status: 503, body: { error: "connection paused" } };      // the platform redelivers once resumed
  const m = conn.platform === "shopify" ? mapShopify(topic, payload) : mapWoo(topic, payload);
  if (m.kind === "ignore") return { status: 200, body: { ignored: m.why } };
  const svc = feedCtx(conn.tenant_id, await serviceUser(db, conn.tenant_id));
  const r = await db.tenant(conn.tenant_id, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${conn.tenant_id}:storefront:${conn.id}`]);
    await c.query(`UPDATE storefront_connections SET last_seen=now() WHERE id=$1`, [conn.id]);
    return recordEvent(c, conn, svc, topic, m);
  });
  const status = r.outcome === "rejected" && r.recoverable && conn.platform === "shopify" ? 503 : 200;
  return { status, body: { outcome: r.outcome, reason: r.reason, order: r.no } };
}

interface EventResult { outcome: "ingested" | "rejected" | "cancelled" | "duplicate"; reason?: string; recoverable?: boolean; no?: string }
async function recordEvent(c: Conn, conn: any, svc: Ctx, topic: string, m: Exclude<Mapped, { kind: "ignore" }>): Promise<EventResult> {
  const ref = `${m.kind === "cancel" ? "cancel" : "order"}:${m.ref}`.slice(0, 120);
  const prior = (await c.query<any>(`SELECT outcome, recoverable, attempt FROM storefront_events WHERE connection_id=$1 AND event_ref=$2 ORDER BY attempt DESC LIMIT 1`, [conn.id, ref])).rows[0];
  if (prior && (prior.outcome !== "rejected" || !prior.recoverable)) return { outcome: "duplicate" };
  const attempt = prior ? prior.attempt + 1 : 1;
  const log = async (outcome: "ingested" | "rejected" | "cancelled", reason: string | null, orderId: string | null, recoverable = false, no?: string): Promise<EventResult> => {
    await c.query(`INSERT INTO storefront_events(tenant_id,connection_id,event_ref,topic,outcome,reason,order_id,attempt,recoverable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [conn.tenant_id, conn.id, ref, topic, outcome, reason, orderId, attempt, recoverable]);
    return { outcome, reason: reason ?? undefined, recoverable, no };
  };
  if (m.kind === "invalid") return log("rejected", m.reason, null);
  await c.query("SAVEPOINT storefront");
  try {
    if (m.kind === "cancel") {
      const o = (await c.query<any>(`SELECT id, no, status FROM fulfil_orders WHERE party_id=$1 AND external_ref=$2`, [conn.party_id, m.ref])).rows[0];
      if (!o) { await c.query("RELEASE SAVEPOINT storefront"); return log("rejected", "The store cancelled an order that was never received.", null); }
      if (o.status === "cancelled") { await c.query("RELEASE SAVEPOINT storefront"); return log("cancelled", null, o.id, false, o.no); }
      if (!["new", "backordered", "allocated", "picking", "picked"].includes(o.status)) { await c.query("RELEASE SAVEPOINT storefront"); return log("rejected", `The order is already ${o.status}; a person must handle the cancellation.`, o.id);}
      await cancelFulfilOrder(c, svc, o.id);
      await c.query("RELEASE SAVEPOINT storefront");
      return log("cancelled", null, o.id, false, o.no);
    }
    const placed = await ingestChannelOrder(c, svc, { ...m.order, party_id: conn.party_id });
    await c.query("RELEASE SAVEPOINT storefront");
    return log("ingested", null, placed.id, false, placed.no);
  } catch (e: any) {
    await c.query("ROLLBACK TO SAVEPOINT storefront");
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    // an unknown SKU or a quota that resets can be fixed and the delivery redelivered; a malformed order cannot
    return log("rejected", e.message.slice(0, 300), null, /sku|quota|allowance|limit|not found/i.test(e.message));
  }
}
