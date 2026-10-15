import crypto from "node:crypto";
import type { Conn, Db } from "../db/client.js";
import { rateLimit } from "../adapters/rate-limit.js";
import { audit } from "../lib/audit.js";
import { decryptSecret, encryptSecret } from "../lib/encryption.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest, forbidden, randomToken, safeEqual, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";
import { channelUrl } from "./inbound.js";

/**
 * Carrier tracking feeds for e-commerce fulfilment. A carrier or tracking aggregator pushes status events, signed with an HMAC of the raw body in a header the workspace
 * names. The field names in the payload and the carrier's own status words are mapped by the workspace, so no carrier is hard-wired. Every event is kept; one for a tracking
 * number we have not dispatched yet is stored and attaches to the shipment when it is read after the dispatch is entered. Nothing here prints a carrier's label.
 */
export const TRACKING_STATUSES = ["info_received", "in_transit", "out_for_delivery", "delivered", "exception", "returned", "other"] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];
const DEFAULT_WORDS: [RegExp, TrackingStatus][] = [
  [/deliver(ed|y complete)/i, "delivered"], [/out for delivery|with courier|on vehicle/i, "out_for_delivery"], [/return/i, "returned"],
  [/exception|fail|undeliver|attempt|held|damag|lost|refus/i, "exception"], [/transit|picked up|collected|departed|arrived|hub|customs|dispatch/i, "in_transit"], [/label|created|info|booked|pending|manifest/i, "info_received"],
];
export const trackingUrl = (token: string) => channelUrl(token).replace("/webhooks/inbound/", "/webhooks/carrier/");
const pick = (obj: any, path: string): unknown => (path ? path.split(".") : []).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const PATH = /^[A-Za-z0-9_.-]{1,80}$/;

/** "RAW WORD = status" per line. Unmapped words fall back to common wording, then to "other" (never guessed as delivered). */
export function parseStatusMap(text: string): Record<string, TrackingStatus> {
  const out: Record<string, TrackingStatus> = {};
  for (const line of String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const i = line.lastIndexOf("="); if (i < 1) throw badRequest(`“${line.slice(0, 40)}” needs the form  carrier word = status.`);
    const raw = line.slice(0, i).trim().toLowerCase(), st = line.slice(i + 1).trim().toLowerCase();
    if (!raw || raw.length > 80) throw badRequest("A carrier status word is 1–80 characters.");
    if (!(TRACKING_STATUSES as readonly string[]).includes(st)) throw badRequest(`Status “${st}” is not one of ${TRACKING_STATUSES.join(", ")}.`);
    out[raw] = st as TrackingStatus;
  }
  if (Object.keys(out).length > 100) throw badRequest("At most 100 status mappings.");
  return out;
}
export function mapStatus(raw: string, map: Record<string, string>): TrackingStatus {
  const k = raw.trim().toLowerCase();
  if (map[k]) return map[k] as TrackingStatus;
  for (const [re, st] of DEFAULT_WORDS) if (re.test(k)) return st;
  return "other";
}

async function gate(c: Conn, ctx: Ctx) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  if (!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='ecommerce-fulfilment'`)).rows.length) throw forbidden("The e-commerce fulfilment sector is not selected.");
}
export async function registerCarrierFeed(c: Conn, ctx: Ctx, f: Record<string, any>) {
  await gate(c, ctx);
  const secret = reqStr(f.secret, "Signing secret", 200);
  if (secret.length < 8) throw badRequest("The signing secret must be at least 8 characters.");
  const header = reqStr(f.signature_header, "Signature header", 60).toLowerCase();
  if (!/^[a-z0-9-]{1,60}$/.test(header)) throw badRequest("The signature header may contain letters, digits and hyphens.");
  const enc = f.signature_encoding === "base64" ? "base64" : "hex";
  const paths = { events: String(f.events_path ?? "").trim(), tracking: reqStr(f.tracking_path, "Tracking number field", 80), status: reqStr(f.status_path, "Status field", 80), time: String(f.time_path ?? "").trim(), location: String(f.location_path ?? "").trim() };
  for (const [k, v] of Object.entries(paths)) if (v && !PATH.test(v)) throw badRequest(`The ${k} field name may contain letters, digits, dots, hyphens and underscores.`);
  const map = parseStatusMap(f.status_map);
  const token = randomToken(24);
  const row = (await c.query<any>(`INSERT INTO carrier_feeds(tenant_id,carrier,label,token_hash,secret_enc,signature_header,signature_encoding,events_path,tracking_path,status_path,time_path,location_path,status_map,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ctx.tenantId, reqStr(f.carrier, "Carrier name (as typed at dispatch)", 60), reqStr(f.label, "Name", 80), sha256(token), encryptSecret(secret), header, enc, paths.events, paths.tracking, paths.status, paths.time, paths.location, JSON.stringify(map), ctx.userId]).catch((e) => {
    if (/unique/i.test(String(e.message))) throw badRequest("A feed with that name already exists."); throw e;
  })).rows[0];
  await audit(c, ctx.tenantId, actorOf(ctx), "carrier_feed.registered", "carrier_feed", row.id, { carrier: f.carrier });
  return { id: row.id as string, url: trackingUrl(token) };        // shown once
}
export async function setCarrierFeedStatus(c: Conn, ctx: Ctx, id: string, status: "active" | "paused" | "retired") {
  await gate(c, ctx);
  const cur = await must(c.query<any>(`SELECT status FROM carrier_feeds WHERE id=$1 FOR UPDATE`, [recordId(id, "Feed")]), "Feed");
  if (cur.status === "retired") throw badRequest("A retired feed cannot be changed.");
  await c.query(`UPDATE carrier_feeds SET status=$2 WHERE id=$1`, [id, status]);
  await audit(c, ctx.tenantId, actorOf(ctx), `carrier_feed.${status}`, "carrier_feed", id);
}
export const listCarrierFeeds = (c: Conn) => c.query<any>(`SELECT f.*, (SELECT count(*) FROM carrier_events e WHERE e.feed_id=f.id)::int AS events FROM carrier_feeds f ORDER BY created_at DESC`).then((r) => r.rows);

export interface HookRequest { method: string; raw: string; header: (n: string) => string | undefined }
export async function handleCarrierFeed(db: Db, token: string, req: HookRequest): Promise<{ status: number; body: unknown }> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token) || req.method !== "POST") return { status: 404, body: { error: "not found" } };
  const feed = (await db.system((c) => c.query<any>(`SELECT * FROM carrier_feeds WHERE token_hash=$1`, [sha256(token)]))).rows[0];
  if (!feed || feed.status === "retired") return { status: 404, body: { error: "not found" } };
  await rateLimit(`carrier:${feed.id}`, 600, 60);
  if (req.raw.length > 1_000_000) return { status: 400, body: { error: "payload too large" } };
  const want = crypto.createHmac("sha256", decryptSecret(feed.secret_enc)).update(req.raw).digest(feed.signature_encoding);
  const given = (req.header(feed.signature_header) ?? "").replace(/^sha256=/i, "");
  if (!given || !safeEqual(given, want)) return { status: 401, body: { error: "invalid signature" } };
  if (feed.status === "paused") return { status: 503, body: { error: "feed paused" } };
  let body: any;
  try { body = JSON.parse(req.raw); } catch { return { status: 400, body: { error: "send JSON" } }; }
  const list = feed.events_path ? pick(body, feed.events_path) : Array.isArray(body) ? body : [body];
  if (!Array.isArray(list) || !list.length || list.length > 500) return { status: 400, body: { error: "send 1–500 events" } };
  let stored = 0, duplicates = 0; const rejected: string[] = [];
  await db.tenant(feed.tenant_id, async (c) => {
    for (const [i, ev] of list.entries()) {
      const tracking = String(pick(ev, feed.tracking_path) ?? "").trim().slice(0, 80), raw = String(pick(ev, feed.status_path) ?? "").trim().slice(0, 120);
      const when = feed.time_path ? new Date(String(pick(ev, feed.time_path) ?? "")) : new Date();
      if (!tracking || !raw || Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 86_400_000) { rejected.push(`event ${i + 1}: needs a tracking number, a status and a valid time`); continue; }
      const r = await c.query(`INSERT INTO carrier_events(tenant_id,feed_id,carrier,tracking_no,raw_status,status,occurred_at,location) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (feed_id,tracking_no,raw_status,occurred_at) DO NOTHING RETURNING id`,
        [feed.tenant_id, feed.id, feed.carrier, tracking, raw, mapStatus(raw, feed.status_map), when.toISOString(), feed.location_path ? String(pick(ev, feed.location_path) ?? "").slice(0, 120) || null : null]);
      if (r.rows.length) stored++; else duplicates++;
    }
    await c.query(`UPDATE carrier_feeds SET last_seen=now() WHERE id=$1`, [feed.id]);
  });
  return { status: 200, body: { received: list.length, stored, duplicates, rejected: rejected.length, rejections: rejected.slice(0, 10) } };
}

/** The carrier's events for a dispatched shipment, oldest first, with the latest status. Events for the same carrier name and tracking number from any feed. */
export async function shipmentTracking(c: Conn, carrier: string, trackingNo: string) {
  const events = (await c.query<any>(`SELECT raw_status, status, occurred_at, location FROM carrier_events WHERE lower(carrier)=lower($1) AND tracking_no=$2 ORDER BY occurred_at, id`, [carrier, trackingNo])).rows;
  return { events, latest: events.length ? events[events.length - 1] : null };
}
/** Dispatched orders the carrier has not confirmed delivered, with their latest known carrier status: the "where is it" list. */
export async function openShipments(c: Conn, limit = 200) {
  return (await c.query<any>(
    `SELECT o.id, o.no, o.external_ref, sh.carrier, sh.tracking_no, sh.shipped_at AS shipped_at, le.status AS carrier_status, le.occurred_at AS carrier_time, le.location
       FROM fulfil_shipments sh JOIN fulfil_orders o ON o.id=sh.order_id
       LEFT JOIN LATERAL (SELECT status, occurred_at, location FROM carrier_events e WHERE lower(e.carrier)=lower(sh.carrier) AND e.tracking_no=sh.tracking_no ORDER BY occurred_at DESC, id DESC LIMIT 1) le ON true
      WHERE o.status='shipped' AND COALESCE(le.status,'') <> 'delivered' ORDER BY sh.shipped_at DESC LIMIT $1`, [limit])).rows;
}
