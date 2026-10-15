import type { Conn, Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx, type Perm } from "../lib/perms.js";
import { getJson, type PostOptions } from "../lib/safe-http.js";
import { seal } from "../lib/seal.js";
import { HttpError, badRequest, forbidden } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";
import { cancelFulfilOrder, ingestChannelOrder } from "./fulfilment.js";
import { allowedHost, authHeaders, parsePage, pick, type PullDeps } from "./live-feeds.js";

/**
 * Order pulls for marketplaces and shops that expose a REST list of orders (Noon, Amazon through a gateway, Magento, a custom shop). The workspace maps the answer's field
 * names; each order becomes a fulfilment order for one merchant, idempotently on the marketplace's order reference. Orders in a "cancel" status cancel the fulfilment order
 * only while it can still be cancelled. Unknown SKUs are reported and retried on the next pull. The provider host must be on the installation's allow-list (FEED_ALLOWED_HOSTS).
 */
const KEYS = ["ref", "name", "phone", "address", "city", "country", "lines_path", "sku", "qty", "status", "time"] as const;
const PATH = /^[A-Za-z0-9_.-]{1,80}$/;
const csv = (v: unknown) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const listVals = (v: unknown) => csv(v).map((x) => x.toLowerCase()).slice(0, 20);

export async function createOrderPull(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  if (!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='ecommerce-fulfilment'`)).rows.length) throw forbidden("The e-commerce fulfilment sector is not selected.");
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [recordId(f.party_id, "Merchant")]), "Merchant");
  let url: string, tokenUrl: string | null = null;
  try { url = allowedHost(String(f.url ?? "")).toString(); } catch (e: any) { throw badRequest(e.message); }
  const scheme = String(f.auth_scheme ?? "bearer");
  if (!["bearer", "header", "oauth2_client"].includes(scheme)) throw badRequest("Authentication is a bearer token, a named header or OAuth2 client credentials.");
  const secret = reqStr(f.secret, "Credential", 2000);
  if (scheme === "oauth2_client") {
    try { tokenUrl = allowedHost(String(f.token_url ?? "")).toString(); } catch (e: any) { throw badRequest(`Token address: ${e.message}`); }
    if (!/^[^:\s]{1,200}:.{1,400}$/.test(secret)) throw badRequest("For OAuth2 the credential is entered as client_id:client_secret.");
  }
  const header = scheme === "header" ? reqStr(f.auth_header, "Header name", 60) : null;
  if (header && !/^[A-Za-z0-9-]{1,60}$/.test(header)) throw badRequest("The header name may contain letters, digits and hyphens.");
  const map: Record<string, any> = {};
  for (const k of KEYS) { const v = String(f[`map_${k}`] ?? "").trim(); if (v) { if (!csv(v).every((p) => PATH.test(p))) throw badRequest(`The ${k} field path is not valid.`); map[k] = v; } }
  for (const need of ["ref", "name", "address", "lines_path", "sku", "qty"]) if (!map[need]) throw badRequest(`Map the ${need} field.`);
  map.accept_values = listVals(f.accept_values); map.cancel_values = listVals(f.cancel_values);
  if ((map.accept_values.length || map.cancel_values.length) && !map.status) throw badRequest("Status values need the status field mapped.");
  const format = f.response_format === "csv" ? "csv" : "json";
  const pageMode = ["none", "cursor", "page", "link"].includes(String(f.page_mode)) ? String(f.page_mode) : "none";
  const pageParam = String(f.page_param ?? "").trim() || (pageMode === "page" ? "page" : pageMode === "cursor" ? "cursor" : "");
  const nextPath = String(f.next_path ?? "").trim();
  if (pageMode === "cursor" && !nextPath) throw badRequest("Cursor paging needs the field that holds the next cursor.");
  if (format === "csv") throw badRequest("Order lists with nested lines are read as JSON.");
  const id = (await c.query<any>(
    `INSERT INTO order_pulls(tenant_id,party_id,label,url,auth_scheme,auth_header,secret_sealed,token_url,token_scope,items_path,since_param,page_mode,page_param,next_path,max_pages,field_map,channel,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [ctx.tenantId, f.party_id, reqStr(f.label, "Name", 80), url, scheme, header, seal(secret), tokenUrl, String(f.token_scope ?? "").trim().slice(0, 200) || null, String(f.items_path ?? "").trim().slice(0, 80),
      String(f.since_param ?? "").trim() || "since", pageMode, pageParam || null, nextPath || null, Math.min(50, Math.max(1, Number(f.max_pages ?? 10) || 10)), JSON.stringify(map), reqStr(f.channel || "marketplace", "Channel name", 40).toLowerCase(), ctx.userId])
    .catch((e) => { if (/unique/i.test(String(e.message))) throw badRequest("A pull with that name already exists."); throw e; })).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "order_pull.created", "order_pull", id);
  return id as string;
}
export async function setOrderPullActive(c: Conn, ctx: Ctx, id: string, active: boolean) {
  require(ctx, "settings.manage");
  await must(c.query(`UPDATE order_pulls SET active=$2 WHERE id=$1 RETURNING id`, [recordId(id, "Pull"), active]), "Pull");
  await audit(c, ctx.tenantId, actorOf(ctx), "order_pull.active", "order_pull", id, { active });
}
export const listOrderPulls = (c: Conn) => c.query<any>(`SELECT o.id,o.label,o.url,o.channel,o.active,o.last_pull_at,o.last_status,o.last_error,o.last_added,p.name AS party_name FROM order_pulls o JOIN parties p ON p.id=o.party_id ORDER BY o.created_at DESC`).then((r) => r.rows);
export const recentPullEvents = (c: Conn, limit = 40) => c.query<any>(`SELECT e.*, o.label FROM order_pull_events e JOIN order_pulls o ON o.id=e.pull_id ORDER BY e.id DESC LIMIT $1`, [limit]).then((r) => r.rows);

const SERVICE_PERMS: Perm[] = ["read", "wh.write"];
async function serviceCtx(db: Db, tenantId: string): Promise<Ctx> {
  const email = `order-puller-${tenantId}@service.invalid`;
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'Order pull','!') ON CONFLICT (email) DO UPDATE SET name=users.name RETURNING id`, [email]))).rows[0].id;
  return { userId: id, tenantId, roles: ["warehouse"], perms: new Set<Perm>(SERVICE_PERMS), partyId: null, driverId: null, readOnly: false, supportStaffId: null };
}
const text = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const joined = (o: any, paths: string, sep: string, max: number) => csv(paths).map((p) => text(pick(o, p), max)).filter(Boolean).join(sep).slice(0, max);

/** An order from the provider's answer, mapped, or the reason it cannot be used. Pure, so the mapping can be tested without a database. */
export function mapPulledOrder(o: any, m: Record<string, any>): { kind: "order"; ref: string; order: any } | { kind: "cancel"; ref: string } | { kind: "skip" } | { kind: "invalid"; ref: string; reason: string } {
  const ref = text(pick(o, m.ref), 80);
  if (!ref) return { kind: "invalid", ref: "", reason: "The order has no reference." };
  const status = m.status ? text(pick(o, m.status), 60).toLowerCase() : "";
  if (status && (m.cancel_values ?? []).includes(status)) return { kind: "cancel", ref };
  if (m.accept_values?.length ? !m.accept_values.includes(status) : false) return { kind: "skip" };
  const raw = pick(o, m.lines_path);
  if (!Array.isArray(raw) || !raw.length) return { kind: "invalid", ref, reason: "The order has no lines." };
  const by = new Map<string, number>();
  for (const l of raw) {
    const sku = text(pick(l, m.sku), 80), qty = Number(pick(l, m.qty));
    if (!sku) return { kind: "invalid", ref, reason: "A line has no SKU." };
    if (!Number.isInteger(qty) || qty <= 0 || qty > 100_000) return { kind: "invalid", ref, reason: `Line ${sku} has an invalid quantity.` };
    by.set(sku, (by.get(sku) ?? 0) + qty);
  }
  const name = joined(o, m.name, " ", 150), address = joined(o, m.address, ", ", 400);
  if (!name || !address) return { kind: "invalid", ref, reason: "The order has no recipient name or delivery address." };
  return { kind: "order", ref, order: { external_ref: ref, ship_to_name: name, ship_to_phone: m.phone ? joined(o, m.phone, " ", 40) : "", ship_to_address: address, ship_to_city: m.city ? joined(o, m.city, " ", 80) : "", ship_to_country: (m.country ? text(pick(o, m.country), 2) : "") || "AE",
    lines: [...by].map(([code, qty]) => ({ code, qty })) } };
}

/** One pull. Failures are recorded on the connection and returned, never thrown past the scheduler. */
export async function pullOrders(db: Db, tenantId: string, id: string, deps: PullDeps = {}): Promise<{ added: number; cancelled: number; rejected: number; error?: string }> {
  const fail = async (msg: string) => { await db.tenant(tenantId, (c) => c.query(`UPDATE order_pulls SET last_pull_at=now(), last_status='error', last_error=$2 WHERE id=$1`, [id, msg.slice(0, 300)])); return { added: 0, cancelled: 0, rejected: 0, error: msg }; };
  const f = (await db.tenant(tenantId, (c) => c.query<any>(`SELECT * FROM order_pulls WHERE id=$1 AND active`, [id]))).rows[0];
  if (!f) return { added: 0, cancelled: 0, rejected: 0, error: "Pull not found or switched off." };
  f.response_format = "json";
  const items: unknown[] = [];
  try {
    allowedHost(f.url);
    const u0 = new URL(f.url);
    if (f.cursor) { const from = new Date(f.cursor); from.setUTCDate(from.getUTCDate() - 1); u0.searchParams.set(f.since_param, from.toISOString()); }
    const get = deps.get ?? ((u: string, h: Record<string, string>, o?: PostOptions) => getJson(u, h, { ...o, returnHeaders: true }));
    const headers = await authHeaders(f, deps, db);
    let next: URL | null = u0, page = 1;
    for (let n = 0; next && n < f.max_pages; n++) {
      allowedHost(next.toString());
      const res = await get(next.toString(), headers, deps.postOptions);
      if (res.status === 401 || res.status === 403) return fail("The provider refused the credential.");
      if (res.status < 200 || res.status >= 300) return fail(`The provider answered HTTP ${res.status}.`);
      const got = parsePage(f, res);
      items.push(...got.items);
      if (items.length > 2000) return fail("The provider returned more than 2,000 orders; pull more often or narrow the window.");
      next = null;
      if (!got.items.length) break;
      if (f.page_mode === "page") { page++; next = new URL(u0); next.searchParams.set(f.page_param || "page", String(page)); }
      else if (f.page_mode === "cursor" && got.cursor) { next = new URL(u0); next.searchParams.set(f.page_param || "cursor", got.cursor); }
      else if (f.page_mode === "link" && got.link) next = new URL(got.link, u0);
    }
  } catch (e: any) { return fail(e.permanentMessage ?? `The provider could not be reached or answered unexpectedly: ${e.message}`); }
  const svc = await serviceCtx(db, tenantId);
  const out = { added: 0, cancelled: 0, rejected: 0 };
  let latest: number | null = null;
  await db.tenant(tenantId, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${tenantId}:orderpull:${id}`]);
    const log = async (ref: string, outcome: string, reason: string | null, orderId: string | null) => {
      if (outcome === "rejected" && (await c.query(`SELECT 1 FROM order_pull_events WHERE pull_id=$1 AND order_ref=$2 AND outcome='rejected' AND reason IS NOT DISTINCT FROM $3`, [id, ref, reason])).rows.length) return;   // do not repeat the same refusal every pull
      await c.query(`INSERT INTO order_pull_events(tenant_id,pull_id,order_ref,outcome,reason,order_id) VALUES ($1,$2,$3,$4,$5,$6)`, [tenantId, id, ref.slice(0, 80), outcome, reason, orderId]);
    };
    for (const it of items) {
      if (f.field_map.time) { const t = Date.parse(String(pick(it, f.field_map.time) ?? "")); if (Number.isFinite(t) && (latest === null || t > latest)) latest = t; }
      const m = mapPulledOrder(it, f.field_map);
      if (m.kind === "skip") continue;
      if (m.kind === "invalid") { out.rejected++; await log(m.ref || "(no reference)", "rejected", m.reason, null); continue; }
      await c.query("SAVEPOINT pull_order");
      try {
        if (m.kind === "cancel") {
          const o = (await c.query<any>(`SELECT id, status FROM fulfil_orders WHERE party_id=$1 AND external_ref=$2`, [f.party_id, m.ref])).rows[0];
          if (!o || o.status === "cancelled") { await c.query("RELEASE SAVEPOINT pull_order"); continue; }
          if (!["new", "backordered", "allocated", "picking", "picked"].includes(o.status)) { await c.query("RELEASE SAVEPOINT pull_order"); out.rejected++; await log(m.ref, "rejected", `The order is already ${o.status}; a person must handle the cancellation.`, o.id); continue; }
          await cancelFulfilOrder(c, svc, o.id);
          await c.query("RELEASE SAVEPOINT pull_order"); out.cancelled++; await log(m.ref, "cancelled", null, o.id);
        } else {
          const r = await ingestChannelOrder(c, svc, { ...m.order, channel: f.channel, party_id: f.party_id });
          await c.query("RELEASE SAVEPOINT pull_order");
          if (r.created) { out.added++; await log(m.ref, "ingested", null, r.id); }
        }
      } catch (e: any) {
        await c.query("ROLLBACK TO SAVEPOINT pull_order");
        if (!(e instanceof HttpError) || e.status >= 500) throw e;
        out.rejected++; await log(m.ref, "rejected", e.message.slice(0, 300), null);
      }
    }
    await c.query(`UPDATE order_pulls SET last_pull_at=now(), last_status=$2, last_error=$3, last_added=$4, cursor=CASE WHEN $5::timestamptz IS NULL THEN cursor ELSE greatest(coalesce(cursor,'epoch'::timestamptz), $5::timestamptz) END WHERE id=$1`,
      [id, out.rejected ? "attention" : "ok", out.rejected ? `${out.rejected} order(s) need attention; see recent deliveries.` : null, out.added, latest === null ? null : new Date(latest).toISOString()]);
  });
  return out;
}
/** Scheduler entry: every active pull not pulled in the last 15 minutes. */
export async function pullDueOrders(db: Db, deps: PullDeps = {}) {
  const due = (await db.system((c) => c.query<any>(`SELECT id, tenant_id FROM order_pulls o WHERE active AND (last_pull_at IS NULL OR last_pull_at < now() - interval '15 minutes') AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=o.tenant_id AND t.status='active') ORDER BY last_pull_at NULLS FIRST LIMIT 100`))).rows;
  let failed = 0;
  for (const d of due) { const r = await pullOrders(db, d.tenant_id, d.id, deps); if (r.error) failed++; }
  return { pulled: due.length, failed };
}
