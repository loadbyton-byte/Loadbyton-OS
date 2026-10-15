import type { Conn, Db } from "../db/client.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx, type Perm } from "../lib/perms.js";
import { getJson, postJson, validateWebhookUrl, type PostOptions, type PostResult } from "../lib/safe-http.js";
import { parseCsv } from "./importer.js";
import { seal, unseal } from "../lib/seal.js";
import { badRequest } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";
import { importBankStatement } from "./delivery-finance.js";
import { importFeed } from "./transport-live.js";

/**
 * Live statement feeds. A workspace points a feed at its own bank / card-settlement / fuel-card / Salik API and supplies its own credential (sealed at rest).
 * Each pull is turned into the same CSV the manual upload takes and goes through the same importer, so matching, duplicate protection, immutability and
 * approval work exactly as they do for a file. Nothing is posted to the books by a pull: bank lines still wait for matching, and fuel/Salik lines become
 * trip expenses only through the normal receipt-evidence approval. A provider transaction id is remembered, so overlapping pulls add nothing twice.
 */
export type FeedKind = "bank" | "fuel" | "salik";
const FIELDS = ["id", "date", "amount", "reference", "description", "plate", "litres", "direction"] as const;
type Field = (typeof FIELDS)[number];
export interface FeedMap { amount_unit?: "major" | "minor"; debit_values?: string[]; [k: string]: unknown }
const DEFAULT_PATH: Record<Field, string> = { id: "id", date: "date", amount: "amount", reference: "reference", description: "description", plate: "plate", litres: "litres", direction: "direction" };

const pick = (obj: any, path: string): unknown => (path ? path.split(".") : []).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const csvCell = (v: unknown) => { const s = String(v ?? "").replace(/[\r\n]+/g, " "); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function allowedHost(url: string) {
  const u = validateWebhookUrl(url);
  if (!config.liveFeeds.allowedHosts.length) throw badRequest("Live feeds are not enabled on this installation: the administrator must list the permitted provider hosts (FEED_ALLOWED_HOSTS).");
  const h = u.hostname.toLowerCase();
  if (!config.liveFeeds.allowedHosts.some((a) => h === a || h.endsWith(`.${a}`))) throw badRequest(`${h} is not a permitted statement provider host on this installation.`);
  return u;
}

export async function createFeedConnection(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  const kind = String(f.kind) as FeedKind;
  if (!["bank", "fuel", "salik"].includes(kind)) throw badRequest("Choose bank or card settlement, fuel card or Salik.");
  try { allowedHost(String(f.url ?? "")); } catch (e: any) { throw badRequest(e.message); }
  const scheme = String(f.auth_scheme ?? "bearer");
  if (!["bearer", "header", "oauth2_client"].includes(scheme)) throw badRequest("Authentication is a bearer token, a named header or OAuth2 client credentials.");
  let tokenUrl: string | null = null;
  if (scheme === "oauth2_client") {
    try { tokenUrl = allowedHost(String(f.token_url ?? "")).toString(); } catch (e: any) { throw badRequest(`Token address: ${e.message}`); }
    if (!/^[^:\s]{1,200}:.{1,400}$/.test(String(f.secret ?? ""))) throw badRequest("For OAuth2 the credential is entered as client_id:client_secret.");
  }
  const format = f.response_format === "csv" ? "csv" : "json";
  const pageMode = ["none", "cursor", "page", "link"].includes(String(f.page_mode)) ? String(f.page_mode) : "none";
  const pageParam = String(f.page_param ?? "").trim() || (pageMode === "page" ? "page" : pageMode === "cursor" ? "cursor" : "");
  const nextPath = String(f.next_path ?? "").trim();
  if ((pageParam && !/^[A-Za-z0-9_.-]{1,40}$/.test(pageParam)) || (nextPath && !/^[A-Za-z0-9_.-]{1,80}$/.test(nextPath))) throw badRequest("The paging field names may contain letters, digits, dots, hyphens and underscores.");
  if (pageMode === "cursor" && !nextPath) throw badRequest("Cursor paging needs the field that holds the next cursor.");
  if (pageMode !== "none" && format === "csv" && pageMode !== "page") throw badRequest("A CSV answer can be paged by page number only.");
  const maxPages = Math.min(50, Math.max(1, Number(f.max_pages ?? 10) || 10));
  const header = scheme === "header" ? reqStr(f.auth_header, "Header name", 60) : null;
  if (header && !/^[A-Za-z0-9-]{1,60}$/.test(header)) throw badRequest("The header name may contain letters, digits and hyphens.");
  const secret = reqStr(f.secret, "Credential", 2000);
  const map: FeedMap = {};
  for (const k of FIELDS) { const v = String(f[`map_${k}`] ?? "").trim(); if (v) { if (!/^[A-Za-z0-9_.-]{1,80}$/.test(v)) throw badRequest(`The ${k} field path is not valid.`); map[k] = v; } }
  map.amount_unit = f.amount_unit === "minor" ? "minor" : "major";
  if (String(f.debit_values ?? "").trim()) map.debit_values = String(f.debit_values).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 10);
  const since = String(f.since_param ?? "since").trim() || "since";
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(since)) throw badRequest("The date parameter name is not valid.");
  const row = (await c.query<any>(
    `INSERT INTO feed_connections(tenant_id,kind,label,url,auth_scheme,auth_header,secret_sealed,items_path,since_param,field_map,created_by,token_url,token_scope,response_format,page_mode,page_param,next_path,max_pages) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [ctx.tenantId, kind, reqStr(f.label, "Name", 80), String(f.url).trim(), scheme, header, seal(secret), String(f.items_path ?? "").trim().slice(0, 80), since, JSON.stringify(map), ctx.userId,
      tokenUrl, String(f.token_scope ?? "").trim().slice(0, 200) || null, format, pageMode, pageParam || null, nextPath || null, maxPages]).catch((e) => {
      if (/unique/i.test(String(e.message))) throw badRequest("A feed with that name already exists."); throw e;
    })).rows[0];
  await audit(c, ctx.tenantId, actorOf(ctx), "feed.created", "feed_connection", row.id, { kind });
  return row.id as string;
}
export async function setFeedActive(c: Conn, ctx: Ctx, id: string, active: boolean) {
  require(ctx, "settings.manage");
  await must(c.query(`UPDATE feed_connections SET active=$2 WHERE id=$1 RETURNING id`, [recordId(id, "Feed"), active]), "Feed");
  await audit(c, ctx.tenantId, actorOf(ctx), "feed.active", "feed_connection", id, { active });
}
export const listFeeds = (c: Conn) => c.query<any>(`SELECT id,kind,label,url,active,cursor,last_pull_at,last_status,last_error,last_added,field_map FROM feed_connections ORDER BY created_at DESC`).then((r) => r.rows);

/** Turn provider JSON into the CSV the existing importer takes. Items without an id/date/amount are reported, not guessed at. */
export function toCsv(kind: FeedKind, items: unknown[], map: FeedMap): { csv: string; ids: string[]; latest: string | null; skipped: string[] } {
  const path = (k: Field) => String(map[k] ?? DEFAULT_PATH[k]);
  const header = kind === "bank" ? ["date", "amount", "reference", "description"] : ["reference", "date", "plate", "amount", "litres", "description"];
  const out: string[] = [header.join(",")], ids: string[] = [], skipped: string[] = []; let latest: string | null = null;
  for (const [i, it] of items.entries()) {
    const id = String(pick(it, path("id")) ?? "").trim(), date = String(pick(it, path("date")) ?? "").trim();
    const raw = Number(String(pick(it, path("amount")) ?? "").replace(/,/g, ""));
    if (!id || !date || !Number.isFinite(raw) || raw === 0) { skipped.push(`item ${i + 1}: needs an id, date and non-zero amount`); continue; }
    let amount = map.amount_unit === "minor" ? raw / 100 : raw;
    const dir = String(pick(it, path("direction")) ?? "").toLowerCase();
    if (kind === "bank") {
      if (dir && (map.debit_values ?? ["debit", "dbit", "d", "out"]).includes(dir)) amount = -Math.abs(amount); else if (dir) amount = Math.abs(amount);
      out.push([date, amount.toFixed(2), id, [pick(it, path("reference")), pick(it, path("description"))].filter(Boolean).join(" ")].map(csvCell).join(","));
    } else {
      const plate = String(pick(it, path("plate")) ?? "").trim();
      if (!plate) { skipped.push(`item ${i + 1}: no vehicle plate`); continue; }
      out.push([id, date, plate, Math.abs(amount).toFixed(2), pick(it, path("litres")) ?? "", pick(it, path("description")) ?? ""].map(csvCell).join(","));
    }
    ids.push(id);
    const day = new Date(date); if (!Number.isNaN(day.getTime())) { const d = day.toISOString().slice(0, 10); if (!latest || d > latest) latest = d; }
  }
  return { csv: out.join("\n"), ids, latest, skipped };
}

export interface PullDeps { get?: (url: string, headers: Record<string, string>, o?: PostOptions) => Promise<PostResult>; post?: (url: string, body: string, headers: Record<string, string>, o?: PostOptions) => Promise<PostResult>; postOptions?: PostOptions }
const SERVICE_PERMS: Perm[] = ["read", "dlv.cash", "transport.expense"];
async function serviceCtx(db: Db, tenantId: string): Promise<Ctx> {
  const email = `feed-puller-${tenantId}@service.invalid`;
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'Statement feed','!') ON CONFLICT (email) DO UPDATE SET name=users.name RETURNING id`, [email]))).rows[0].id;
  return { userId: id, tenantId, roles: ["service"], perms: new Set<Perm>(SERVICE_PERMS), partyId: null, driverId: null, readOnly: false, supportStaffId: null };
}

/** Header(s) that authenticate a pull. OAuth2 client credentials exchange the sealed id:secret for a short-lived token on every pull; nothing is cached. */
async function authHeaders(f: any, deps: PullDeps): Promise<Record<string, string>> {
  const secret = unseal(f.secret_sealed);
  if (f.auth_scheme === "bearer") return { authorization: `Bearer ${secret}` };
  if (f.auth_scheme === "header") return { [f.auth_header]: secret };
  allowedHost(f.token_url);
  const i = secret.indexOf(":"), id = secret.slice(0, i), sec = secret.slice(i + 1);
  const form = new URLSearchParams({ grant_type: "client_credentials", ...(f.token_scope ? { scope: f.token_scope } : {}) }).toString();
  const res = await (deps.post ?? postJson)(f.token_url, form, { authorization: `Basic ${Buffer.from(`${id}:${sec}`).toString("base64")}`, accept: "application/json" }, { ...deps.postOptions, contentType: "application/x-www-form-urlencoded" });
  if (res.status === 400 || res.status === 401 || res.status === 403) throw Object.assign(new Error("refused"), { permanentMessage: "The provider refused the client credentials." });
  if (res.status < 200 || res.status >= 300) throw new Error(`token request answered HTTP ${res.status}`);
  let token = "";
  try { token = String(JSON.parse(res.body).access_token ?? ""); } catch { /* handled below */ }
  if (!token) throw Object.assign(new Error("no token"), { permanentMessage: "The provider's sign-in answer had no access token." });
  return { authorization: `Bearer ${token}` };
}
/** One page of an answer: its rows, and where the next page is (a cursor in the body, or a rel="next" Link header). */
function parsePage(f: any, res: PostResult): { items: unknown[]; cursor?: string; link?: string } {
  if (f.response_format === "csv") {
    const rows = parseCsv(res.body).filter((r) => r.some((x) => x.trim()));
    if (rows.length < 2) return { items: [] };
    const head = rows[0].map((h) => h.trim());
    return { items: rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()]))) };
  }
  let body: any;
  try { body = JSON.parse(res.body); } catch { throw Object.assign(new Error("not JSON"), { permanentMessage: "The provider's answer was not the expected list of transactions." }); }
  const list = f.items_path ? pick(body, f.items_path) : body;
  if (!Array.isArray(list)) throw Object.assign(new Error("not a list"), { permanentMessage: "The provider's answer was not the expected list of transactions." });
  const cursor = f.next_path ? pick(body, f.next_path) : undefined;
  const link = String(Array.isArray(res.headers?.link) ? res.headers!.link.join(",") : res.headers?.link ?? "").match(/<([^>]+)>\s*;\s*rel="?next"?/i)?.[1];
  return { items: list, cursor: cursor ? String(cursor) : undefined, link };
}

/** One pull of one feed. Failures are recorded on the connection (and returned), never thrown past the scheduler. */
export async function pullFeed(db: Db, tenantId: string, id: string, deps: PullDeps = {}): Promise<{ added: number; skipped: string[]; error?: string }> {
  const fail = async (msg: string) => { await db.tenant(tenantId, (c) => c.query(`UPDATE feed_connections SET last_pull_at=now(), last_status='error', last_error=$2 WHERE id=$1`, [id, msg.slice(0, 300)])); return { added: 0, skipped: [], error: msg }; };
  const f = (await db.tenant(tenantId, (c) => c.query<any>(`SELECT * FROM feed_connections WHERE id=$1 AND active`, [id]))).rows[0];
  if (!f) return { added: 0, skipped: [], error: "Feed not found or switched off." };
  let items: unknown[] = [];
  try {
    allowedHost(f.url);                                                                          // the allow-list is re-checked on every pull, not only at set-up
    const u0 = new URL(f.url);
    if (f.cursor) { const from = new Date(f.cursor); from.setUTCDate(from.getUTCDate() - 3); u0.searchParams.set(f.since_param, from.toISOString().slice(0, 10)); }   // a small overlap; remembered ids make it harmless
    const get = deps.get ?? getJson;
    const headers = await authHeaders(f, deps);
    let next: URL | null = u0, page = 1;
    for (let n = 0; next && n < f.max_pages; n++) {
      allowedHost(next.toString());                                                              // a paged "next" address is checked like the first
      const res = await get(next.toString(), headers, deps.postOptions);
      if (res.status === 401 || res.status === 403) return fail("The provider refused the credential.");
      if (res.status < 200 || res.status >= 300) return fail(`The provider answered HTTP ${res.status}.`);
      const got = parsePage(f, res);
      items.push(...got.items);
      if (items.length > 2000) break;
      next = null;
      if (!got.items.length) break;
      if (f.page_mode === "page") { page++; next = new URL(u0); next.searchParams.set(f.page_param || "page", String(page)); }
      else if (f.page_mode === "cursor" && got.cursor) { next = new URL(u0); next.searchParams.set(f.page_param || "cursor", got.cursor); }
      else if (f.page_mode === "link" && got.link) next = new URL(got.link, u0);
    }
  } catch (e: any) { return fail(e.permanentMessage ?? `The provider could not be reached or answered unexpectedly: ${e.message}`); }
  if (items.length > 2000) return fail("The provider returned more than 2,000 transactions; narrow the window or lower the pull interval.");
  const seen = new Set((await db.tenant(tenantId, (c) => c.query<any>(`SELECT external_id FROM feed_seen WHERE connection_id=$1`, [id]))).rows.map((r: any) => r.external_id));
  const fresh = toCsv(f.kind, items.filter((_, i) => { const idv = String(pick(items[i], String(f.field_map?.id ?? "id")) ?? "").trim(); return idv && !seen.has(idv); }), f.field_map);
  if (!fresh.ids.length) { await db.tenant(tenantId, (c) => c.query(`UPDATE feed_connections SET last_pull_at=now(), last_status='ok', last_error=NULL, last_added=0 WHERE id=$1`, [id])); return { added: 0, skipped: fresh.skipped }; }
  const ctx = await serviceCtx(db, tenantId);
  try {
    await db.tenant(tenantId, async (c) => {
      const label = `${f.label} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      if (f.kind === "bank") await importBankStatement(c, ctx, label, fresh.csv); else await importFeed(c, ctx, f.kind, label, fresh.csv);
      for (const ext of fresh.ids) await c.query(`INSERT INTO feed_seen(tenant_id,connection_id,external_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, id, ext]);
      await c.query(`UPDATE feed_connections SET last_pull_at=now(), last_status='ok', last_error=NULL, last_added=$2, cursor=greatest(coalesce(cursor,'epoch'::date), coalesce($3::date,'epoch'::date)) WHERE id=$1`, [id, fresh.ids.length, fresh.latest]);
      await audit(c, tenantId, { kind: "system" }, "feed.pulled", "feed_connection", id, { added: fresh.ids.length });
    });
  } catch (e: any) { return fail(`The statement could not be imported: ${String(e.message).slice(0, 200)}`); }
  return { added: fresh.ids.length, skipped: fresh.skipped };
}

/** Scheduler entry: every active feed that has not been pulled within the configured interval. */
export async function pullDueFeeds(db: Db, deps: PullDeps = {}) {
  const due = (await db.system((c) => c.query<any>(`SELECT id, tenant_id FROM feed_connections f WHERE active AND (last_pull_at IS NULL OR last_pull_at < now() - ($1 || ' minutes')::interval) AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=f.tenant_id AND t.status='active') ORDER BY last_pull_at NULLS FIRST LIMIT 50`, [String(config.liveFeeds.intervalMinutes)]))).rows;
  let failed = 0;
  for (const d of due) { const r = await pullFeed(db, d.tenant_id, d.id, deps); if (r.error) failed++; }
  return { pulled: due.length, failed };
}
