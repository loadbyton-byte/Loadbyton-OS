import type { Conn, Db } from "../db/client.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { seal } from "../lib/seal.js";
import { validateWebhookUrl } from "../lib/safe-http.js";
import { badRequest, baseUrl, randomToken, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, optStr, reqStr } from "./common.js";

// ───────────────────────── API keys (one merchant per key; the key is shown once and only its hash is stored)
export const API_KEY_PREFIX = "lbtk_";

export async function createApiKey(c: Conn, ctx: Ctx, f: { merchant_id: string; name: string }) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.merchant_id]), "Merchant");
  const name = reqStr(f.name, "Key name", 80);
  const live = Number((await c.query<any>(`SELECT count(*) n FROM dlv_api_keys WHERE merchant_id=$1 AND revoked_at IS NULL`, [f.merchant_id])).rows[0].n);
  if (live >= 5) throw badRequest("A merchant can have at most 5 active keys. Revoke one first.");
  const key = `${API_KEY_PREFIX}${randomToken(30)}`;
  const r = await c.query<{ id: string }>(
    `INSERT INTO dlv_api_keys(tenant_id,merchant_id,name,prefix,key_hash,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, f.merchant_id, name, key.slice(0, 12), sha256(key), ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_api_key.created", "dlv_api_key", r.rows[0].id, { merchant: f.merchant_id, name });
  return { id: r.rows[0].id, key };            // the only time the key exists in the clear
}
export async function revokeApiKey(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "settings.manage");
  await must(c.query(`UPDATE dlv_api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id`, [id]), "Active key");
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_api_key.revoked", "dlv_api_key", id);
}
export const listApiKeys = (c: Conn) => c.query<any>(
  `SELECT k.id, k.name, k.prefix, k.last_used_at, k.revoked_at, k.created_at, p.name AS merchant_name FROM dlv_api_keys k JOIN parties p ON p.id=k.merchant_id ORDER BY k.created_at DESC`).then((r) => r.rows);

export interface ApiPrincipal { keyId: string; tenantId: string; merchantId: string; createdBy: string | null }
/** Cross-tenant lookup by hash (the tenant is not known yet); revoked keys and keys of inactive tenants are refused. */
export async function authenticateApiKey(db: Db, raw: string): Promise<ApiPrincipal | null> {
  if (!raw.startsWith(API_KEY_PREFIX) || raw.length < 30 || raw.length > 100) return null;
  return db.system(async (c) => {
    const k = (await c.query<any>(
      `SELECT k.id, k.tenant_id, k.merchant_id, k.created_by, k.last_used_at FROM dlv_api_keys k JOIN tenants t ON t.id=k.tenant_id
       WHERE k.key_hash=$1 AND k.revoked_at IS NULL AND t.status='active'`, [sha256(raw)])).rows[0];
    if (!k) return null;
    if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 5 * 60_000) await c.query(`UPDATE dlv_api_keys SET last_used_at=now() WHERE id=$1`, [k.id]);
    return { keyId: k.id, tenantId: k.tenant_id, merchantId: k.merchant_id, createdBy: k.created_by };
  });
}

// ───────────────────────── per-merchant webhook endpoint and SMS opt-in
export const listMerchantSettings = (c: Conn) => c.query<any>(
  `SELECT p.id AS merchant_id, p.name, coalesce(s.webhook_url,'') AS webhook_url, coalesce(s.webhook_active,false) AS webhook_active, coalesce(s.notify_sms,false) AS notify_sms, coalesce(s.notify_whatsapp,false) AS notify_whatsapp
   FROM parties p LEFT JOIN dlv_merchant_settings s ON s.merchant_id=p.id WHERE p.kind='customer' ORDER BY p.name`).then((r) => r.rows);

/** Set (or replace) the endpoint. A new secret is generated the first time and whenever `rotate` is set; it is returned once and stored sealed. */
export async function setWebhook(c: Conn, ctx: Ctx, f: { merchant_id: string; url: string; active: boolean; rotate?: boolean }) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.merchant_id]), "Merchant");
  const url = String(f.url ?? "").trim();
  if (!url && f.active) throw badRequest("Enter the https address that should receive events.");
  if (url) { try { validateWebhookUrl(url); } catch (e) { throw badRequest((e as Error).message); } }
  const have = (await c.query<any>(`SELECT webhook_secret_sealed FROM dlv_merchant_settings WHERE merchant_id=$1`, [f.merchant_id])).rows[0];
  const fresh = !have?.webhook_secret_sealed || f.rotate;
  const secret = fresh ? `whsec_${randomToken(24)}` : null;
  await c.query(
    `INSERT INTO dlv_merchant_settings(tenant_id,merchant_id,webhook_url,webhook_secret_sealed,webhook_active) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id,merchant_id) DO UPDATE SET webhook_url=EXCLUDED.webhook_url, webhook_active=EXCLUDED.webhook_active, updated_at=now(),
       webhook_secret_sealed=coalesce($6, dlv_merchant_settings.webhook_secret_sealed)`,
    [ctx.tenantId, f.merchant_id, url || null, secret ? seal(secret) : have?.webhook_secret_sealed ?? null, !!f.active && !!url, secret ? seal(secret) : null]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_webhook.set", "party", f.merchant_id, { active: !!f.active, rotated: !!secret });
  return { secret };
}
export async function setNotifySms(c: Conn, ctx: Ctx, merchantId: string, on: boolean) {
  require(ctx, "settings.manage");
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [merchantId]), "Merchant");
  await c.query(`INSERT INTO dlv_merchant_settings(tenant_id,merchant_id,notify_sms) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,merchant_id) DO UPDATE SET notify_sms=$3, updated_at=now()`, [ctx.tenantId, merchantId, on]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_sms.set", "party", merchantId, { on });
}
export async function setNotifyWhatsApp(c: Conn, ctx: Ctx, merchantId: string, on: boolean) {
  require(ctx, "settings.manage");
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [merchantId]), "Merchant");
  if (on && (config.whatsapp.provider !== "cloud")) throw badRequest("WhatsApp is not connected on this installation. Set the WhatsApp provider credentials and approved templates first.");
  await c.query(`INSERT INTO dlv_merchant_settings(tenant_id,merchant_id,notify_whatsapp) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,merchant_id) DO UPDATE SET notify_whatsapp=$3, updated_at=now()`, [ctx.tenantId, merchantId, on]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_whatsapp.set", "party", merchantId, { on });
}
export async function sendTestWebhook(c: Conn, ctx: Ctx, merchantId: string) {
  require(ctx, "settings.manage");
  const s = (await c.query<any>(`SELECT webhook_active FROM dlv_merchant_settings WHERE merchant_id=$1`, [merchantId])).rows[0];
  if (!s?.webhook_active) throw badRequest("Save and enable the webhook address first.");
  await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'merchant.webhook',$2,$3)`,
    [ctx.tenantId, `mwh:ping:${merchantId}:${randomToken(6)}`, JSON.stringify({ merchant_id: merchantId, type: "ping", data: { message: "Test event from LOAD|BY|TON" } })]);
}

// ───────────────────────── emitting events (transactional outbox: the event exists exactly when the state change does)
/** UAE mobile numbers only: +9715x…, 009715x…, 05x… → +9715xxxxxxxx. Anything else is not texted. */
export function normalizeUaeMobile(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/[\s().-]/g, "");
  const m = d.match(/^(?:\+971|00971|971|0)(5\d{8})$/);
  return m ? `+971${m[1]}` : null;
}

export interface EventShipment { id: string; no: string; external_ref: string | null; merchant_id: string; attempts: number; track_token: string; cod_minor: number | string; require_code: boolean; delivery_code: string; consignee_phone: string | null }
export const PARCEL_EVENTS = ["parcel.out_for_delivery", "parcel.delivered", "parcel.attempt_failed", "parcel.return_to_sender", "parcel.returned", "parcel.cancelled", "remittance.paid"] as const;
const SMS_EVENTS = new Set(["parcel.out_for_delivery", "parcel.attempt_failed"]);

export async function emitParcelEvent(c: Conn, tenantId: string, s: EventShipment, type: (typeof PARCEL_EVENTS)[number], status: string, data: Record<string, unknown> = {}) {
  const set = (await c.query<any>(`SELECT webhook_active, notify_sms, notify_whatsapp FROM dlv_merchant_settings WHERE merchant_id=$1`, [s.merchant_id])).rows[0];
  if (!set) return;
  const uniq = `${s.id}:${type}:${s.attempts}:${status}`;
  if (set.webhook_active) {
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'merchant.webhook',$2,$3) ON CONFLICT (key) DO NOTHING`,
      [tenantId, `mwh:${uniq}`, JSON.stringify({ merchant_id: s.merchant_id, type, data: { waybill: s.no, reference: s.external_ref, status, attempts: s.attempts, ...data } })]);
  }
  const to = set.notify_sms && SMS_EVENTS.has(type) ? normalizeUaeMobile(s.consignee_phone) : null;
  if (to) {
    const names = (await c.query<any>(`SELECT (SELECT name FROM tenants WHERE id=$1) AS company, (SELECT name FROM parties WHERE id=$2) AS merchant`, [tenantId, s.merchant_id])).rows[0];
    const link = `${baseUrl()}/t/${s.track_token}`, cod = Number(s.cod_minor);
    const body = type === "parcel.out_for_delivery"
      ? `${names.company}: your parcel ${s.no} from ${names.merchant} is out for delivery today.${cod ? ` Please have AED ${(cod / 100).toFixed(2)} ready (cash on delivery).` : ""}${s.require_code ? ` Delivery code: ${s.delivery_code}.` : ""} Track: ${link}`
      : `${names.company}: we could not deliver parcel ${s.no} from ${names.merchant}. We will contact you to arrange another attempt. Track: ${link}`;
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'sms',$2,$3) ON CONFLICT (key) DO NOTHING`, [tenantId, `sms:${uniq}`, JSON.stringify({ to, body })]);
  }
  const wa = set.notify_whatsapp && SMS_EVENTS.has(type) && config.whatsapp.provider === "cloud" ? normalizeUaeMobile(s.consignee_phone) : null;
  if (wa) {
    const names = (await c.query<any>(`SELECT (SELECT name FROM tenants WHERE id=$1) AS company, (SELECT name FROM parties WHERE id=$2) AS merchant`, [tenantId, s.merchant_id])).rows[0];
    const link = `${baseUrl()}/t/${s.track_token}`, cod = Number(s.cod_minor);
    // template variables, in order — the approved template body must use exactly these: out for delivery {{1}} company {{2}} waybill {{3}} merchant {{4}} cash due {{5}} delivery code {{6}} tracking link; attempt failed {{1}} company {{2}} waybill {{3}} merchant {{4}} tracking link
    const out = type === "parcel.out_for_delivery";
    const params = out ? [names.company, s.no, names.merchant, cod ? `AED ${(cod / 100).toFixed(2)}` : "none", s.require_code ? String(s.delivery_code) : "not required", link] : [names.company, s.no, names.merchant, link];
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'whatsapp',$2,$3) ON CONFLICT (key) DO NOTHING`,
      [tenantId, `wa:${uniq}`, JSON.stringify({ to: wa, template: out ? config.whatsapp.templateOutForDelivery : config.whatsapp.templateAttemptFailed, language: config.whatsapp.templateLanguage, params })]);
  }
}
void optStr;
