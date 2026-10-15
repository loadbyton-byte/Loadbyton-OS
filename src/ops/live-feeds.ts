import crypto from "node:crypto";
import type { Conn, Db } from "../db/client.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx, type Perm } from "../lib/perms.js";
import { getJson, postJson, validateWebhookUrl, type PostOptions, type PostResult } from "../lib/safe-http.js";
import { CLIENT_ASSERTION_TYPE, SIGN_ALGS, checkKeyForAlg, clientAssertion, detachedJws, httpSignature, type SignAlg } from "../lib/message-signing.js";
import { parseCsv } from "./importer.js";
import { seal, unseal } from "../lib/seal.js";
import { badRequest, randomToken, sha256 } from "../lib/util.js";
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

export const pick = (obj: any, path: string): unknown => (path ? path.split(".") : []).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const csvCell = (v: unknown) => { const s = String(v ?? "").replace(/[\r\n]+/g, " "); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function allowedHost(url: string) {
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
  if (!["bearer", "header", "oauth2_client", "oauth2_authcode"].includes(scheme)) throw badRequest("Authentication is a bearer token, a named header, OAuth2 client credentials or account-holder consent.");
  let tokenUrl: string | null = null, authorizeUrl: string | null = null;
  if (scheme === "oauth2_authcode") { try { authorizeUrl = allowedHost(String(f.authorize_url ?? "")).toString(); } catch (e: any) { throw badRequest(`Consent address: ${e.message}`); } }
  if (scheme === "oauth2_client" || scheme === "oauth2_authcode") {
    try { tokenUrl = allowedHost(String(f.token_url ?? "")).toString(); } catch (e: any) { throw badRequest(`Token address: ${e.message}`); }
    const pk = String(f.client_auth) === "private_key_jwt";
    if (pk ? !/^[^:\s]{1,200}$/.test(String(f.secret ?? "")) : !/^[^:\s]{1,200}:.{1,400}$/.test(String(f.secret ?? ""))) throw badRequest(pk ? "With a signed client assertion the credential is the client_id only." : "For OAuth2 the credential is entered as client_id:client_secret.");
  }
  const format = f.response_format === "csv" ? "csv" : "json";
  const pageMode = ["none", "cursor", "page", "link"].includes(String(f.page_mode)) ? String(f.page_mode) : "none";
  const pageParam = String(f.page_param ?? "").trim() || (pageMode === "page" ? "page" : pageMode === "cursor" ? "cursor" : "");
  const nextPath = String(f.next_path ?? "").trim();
  if ((pageParam && !/^[A-Za-z0-9_.-]{1,40}$/.test(pageParam)) || (nextPath && !/^[A-Za-z0-9_.-]{1,80}$/.test(nextPath))) throw badRequest("The paging field names may contain letters, digits, dots, hyphens and underscores.");
  if (pageMode === "cursor" && !nextPath) throw badRequest("Cursor paging needs the field that holds the next cursor.");
  if (pageMode !== "none" && format === "csv" && pageMode !== "page") throw badRequest("A CSV answer can be paged by page number only.");
  const maxPages = Math.min(50, Math.max(1, Number(f.max_pages ?? 10) || 10));
  const sec = parseSecurity(f);
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
    `INSERT INTO feed_connections(tenant_id,kind,label,url,auth_scheme,auth_header,secret_sealed,items_path,since_param,field_map,created_by,token_url,token_scope,response_format,page_mode,page_param,next_path,max_pages,authorize_url,tls_cert_sealed,tls_key_sealed,tls_ca,sign_mode,sign_alg,sign_kid,sign_key_sealed,sign_header,client_auth) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING id`,
    [ctx.tenantId, kind, reqStr(f.label, "Name", 80), String(f.url).trim(), scheme, header, seal(secret), String(f.items_path ?? "").trim().slice(0, 80), since, JSON.stringify(map), ctx.userId,
      tokenUrl, String(f.token_scope ?? "").trim().slice(0, 200) || null, format, pageMode, pageParam || null, nextPath || null, maxPages, authorizeUrl, sec.tlsCert, sec.tlsKey, sec.tlsCa, sec.signMode, sec.signAlg, sec.signKid, sec.signKey, sec.signHeader, sec.clientAuth]).catch((e) => {
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
export const listFeeds = (c: Conn) => c.query<any>(`SELECT id,kind,label,url,active,cursor,last_pull_at,last_status,last_error,last_added,field_map,auth_scheme,(token_sealed IS NOT NULL) AS consented,consent_expires_at FROM feed_connections ORDER BY created_at DESC`).then((r) => r.rows);

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

export interface FeedSecurity { tlsCert: string | null; tlsKey: string | null; tlsCa: string | null; signMode: string; signAlg: string | null; signKid: string | null; signKey: string | null; signHeader: string; clientAuth: string }
/** Validates and seals the mutual-TLS and message-signing settings of a feed. Certificates and keys are checked to parse, to match each other, and to suit the algorithm. */
export function parseSecurity(f: Record<string, any>): FeedSecurity {
  const pem = (v: unknown) => String(v ?? "").trim();
  const cert = pem(f.tls_cert), key = pem(f.tls_key), ca = pem(f.tls_ca);
  let tlsCert: string | null = null, tlsKey: string | null = null;
  if (cert || key) {
    if (!cert || !key) throw badRequest("Mutual TLS needs both the client certificate and its private key.");
    let x: crypto.X509Certificate;
    try { x = new crypto.X509Certificate(cert); } catch { throw badRequest("The client certificate is not a valid PEM certificate."); }
    let k: crypto.KeyObject;
    try { k = crypto.createPrivateKey(key); } catch { throw badRequest("The client key is not a valid unencrypted PEM private key."); }
    if (!x.checkPrivateKey(k)) throw badRequest("The client key does not belong to the client certificate.");
    if (new Date(x.validTo).getTime() < Date.now()) throw badRequest("The client certificate has expired.");
    tlsCert = seal(cert); tlsKey = seal(key);
  }
  if (ca) { try { new crypto.X509Certificate(ca); } catch { throw badRequest("The pinned server CA is not a valid PEM certificate."); } }
  const mode = ["jws", "http_signature"].includes(String(f.sign_mode)) ? String(f.sign_mode) : "none";
  const clientAuth = String(f.client_auth) === "private_key_jwt" ? "private_key_jwt" : "secret";
  let signAlg: string | null = null, signKid: string | null = null, signKey: string | null = null;
  if (mode !== "none" || clientAuth === "private_key_jwt") {
    signAlg = String(f.sign_alg || "PS256");
    if (!(SIGN_ALGS as string[]).includes(signAlg)) throw badRequest(`The signing algorithm is one of ${SIGN_ALGS.join(", ")}.`);
    signKid = String(f.sign_kid ?? "").trim();
    if (!/^[A-Za-z0-9._:@/=-]{1,200}$/.test(signKid)) throw badRequest("Enter the key identifier (kid / keyId) the bank registered for your signing key.");
    const sk = pem(f.sign_key);
    if (!sk) throw badRequest("Enter the signing private key.");
    try { checkKeyForAlg(signAlg as SignAlg, sk); } catch (e: any) { throw badRequest(e.message); }
    signKey = seal(sk);
  }
  const header = String(f.sign_header || "x-jws-signature").toLowerCase();
  if (!/^[a-z0-9-]{1,60}$/.test(header)) throw badRequest("The signature header may contain letters, digits and hyphens.");
  return { tlsCert, tlsKey, tlsCa: ca || null, signMode: mode, signAlg, signKid, signKey, signHeader: header, clientAuth };
}
export const tlsOf = (f: any) => (f.tls_cert_sealed && f.tls_key_sealed ? { cert: unseal(f.tls_cert_sealed), key: unseal(f.tls_key_sealed), ...(f.tls_ca ? { ca: f.tls_ca } : {}) } : undefined);
/** Signature headers for one request, per the feed's profile. */
export function signHeaders(f: any, method: string, url: string, body = ""): Record<string, string> {
  if (!f.sign_mode || f.sign_mode === "none") return {};
  const key = unseal(f.sign_key_sealed);
  if (f.sign_mode === "jws") return { [f.sign_header || "x-jws-signature"]: detachedJws(body, { alg: f.sign_alg, kid: f.sign_kid, key, extra: { iat: Math.floor(Date.now() / 1000) }, crit: ["iat"] }) };
  return httpSignature({ method, url, body, keyId: f.sign_kid, key, alg: f.sign_alg });
}
/** Client authentication fields for a token request: the shared secret, or a freshly signed assertion. */
export function clientAuthForm(f: any, clientId: string, clientSecret: string): Record<string, string> {
  if (f.client_auth === "private_key_jwt") return { client_id: clientId, client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: clientAssertion({ clientId, audience: f.token_url, alg: f.sign_alg, kid: f.sign_kid, key: unseal(f.sign_key_sealed) }) };
  return { client_id: clientId, client_secret: clientSecret };
}

/** Header(s) that authenticate a pull. OAuth2 client credentials exchange the sealed id:secret for a short-lived token on every pull; nothing is cached. */
export async function authHeaders(f: any, deps: PullDeps, db?: Db): Promise<Record<string, string>> {
  const secret = unseal(f.secret_sealed);
  if (f.auth_scheme === "oauth2_authcode") return { authorization: `Bearer ${await consentToken(db!, f, secret, deps)}` };
  if (f.auth_scheme === "oauth2_refresh") {
    // Refresh-token sign-in (for example Amazon's Login with Amazon): the sealed credential is JSON {client_id, client_secret, refresh_token}; a short-lived access token is fetched on every pull.
    allowedHost(f.token_url);
    let cred: any; try { cred = JSON.parse(secret); } catch { throw Object.assign(new Error("bad credential"), { permanentMessage: "The stored sign-in credential is unreadable. Re-enter it." }); }
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: cred.refresh_token, client_id: cred.client_id, client_secret: cred.client_secret }).toString();
    const res = await (deps.post ?? postJson)(f.token_url, form, { accept: "application/json" }, { ...deps.postOptions, contentType: "application/x-www-form-urlencoded", maxBodyBytes: 20_000 });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw Object.assign(new Error("refused"), { permanentMessage: "The provider refused the refresh token. Re-authorise the connection." });
    if (res.status < 200 || res.status >= 300) throw new Error(`token request answered HTTP ${res.status}`);
    let token = ""; try { token = String(JSON.parse(res.body).access_token ?? ""); } catch { /* below */ }
    if (!token) throw Object.assign(new Error("no token"), { permanentMessage: "The provider's sign-in answer had no access token." });
    return f.token_header ? { [f.token_header]: token } : { authorization: `Bearer ${token}` };
  }
  if (f.auth_scheme === "bearer") return { authorization: `Bearer ${secret}` };
  if (f.auth_scheme === "header") return { [f.auth_header]: secret };
  allowedHost(f.token_url);
  const pk = f.client_auth === "private_key_jwt";
  const i = secret.indexOf(":"), id = pk ? secret : secret.slice(0, i), sec = pk ? "" : secret.slice(i + 1);
  const form = new URLSearchParams({ grant_type: "client_credentials", ...(f.token_scope ? { scope: f.token_scope } : {}), ...(pk ? clientAuthForm(f, id, "") : {}) }).toString();
  const res = await (deps.post ?? postJson)(f.token_url, form, { ...(pk ? {} : { authorization: `Basic ${Buffer.from(`${id}:${sec}`).toString("base64")}` }), accept: "application/json" }, { ...deps.postOptions, contentType: "application/x-www-form-urlencoded", tls: tlsOf(f) });
  if (res.status === 400 || res.status === 401 || res.status === 403) throw Object.assign(new Error("refused"), { permanentMessage: "The provider refused the client credentials." });
  if (res.status < 200 || res.status >= 300) throw new Error(`token request answered HTTP ${res.status}`);
  let token = "";
  try { token = String(JSON.parse(res.body).access_token ?? ""); } catch { /* handled below */ }
  if (!token) throw Object.assign(new Error("no token"), { permanentMessage: "The provider's sign-in answer had no access token." });
  return { authorization: `Bearer ${token}` };
}
/** One page of an answer: its rows, and where the next page is (a cursor in the body, or a rel="next" Link header). */
export function parsePage(f: any, res: PostResult): { items: unknown[]; cursor?: string; link?: string } {
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
    const get = deps.get ?? ((u: string, h: Record<string, string>, o?: PostOptions) => getJson(u, h, { ...o, returnHeaders: true }));
    const headers = await authHeaders(f, deps, db), tls = tlsOf(f);
    let next: URL | null = u0, page = 1;
    for (let n = 0; next && n < f.max_pages; n++) {
      allowedHost(next.toString());                                                              // a paged "next" address is checked like the first
      const res = await get(next.toString(), { ...headers, ...signHeaders(f, "GET", next.toString()) }, tls ? { ...deps.postOptions, tls } : deps.postOptions);
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


// ───────── account-holder consent (OAuth2 authorization code with PKCE)
export const consentRedirectUri = () => `${config.baseUrl.replace(/\/$/, "")}/app/settings/feeds/callback`;
const b64url = (b: Buffer) => b.toString("base64url");
const CONSENT_DAYS = 90, STATE_MINUTES = 15;

/** Begins consent: returns the provider address to send the account holder to. One consent attempt at a time per feed; the state and PKCE verifier are single-use. */
export async function startConsent(c: Conn, ctx: Ctx, id: string): Promise<string> {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  const f = await must(c.query<any>(`SELECT * FROM feed_connections WHERE id=$1 AND auth_scheme='oauth2_authcode' FOR UPDATE`, [recordId(id, "Feed")]), "Feed that uses account-holder consent");
  allowedHost(f.authorize_url);
  const state = randomToken(24), verifier = randomToken(48), challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  await c.query(`UPDATE feed_connections SET consent_state_hash=$2, consent_verifier_sealed=$3, consent_started_at=now() WHERE id=$1`, [f.id, sha256(state), seal(verifier)]);
  const u = new URL(f.authorize_url);
  const clientId = unseal(f.secret_sealed).split(":")[0];
  for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: consentRedirectUri(), state, code_challenge: challenge, code_challenge_method: "S256", ...(f.token_scope ? { scope: f.token_scope } : {}) })) u.searchParams.set(k, v);
  await audit(c, ctx.tenantId, actorOf(ctx), "feed.consent_started", "feed_connection", f.id);
  return u.toString();
}
const tokenRequest = async (f: any, form: Record<string, string>, deps: PullDeps) => {
  allowedHost(f.token_url);
  const res = await (deps.post ?? postJson)(f.token_url, new URLSearchParams(form).toString(), { accept: "application/json" }, { ...deps.postOptions, contentType: "application/x-www-form-urlencoded", maxBodyBytes: 20_000, tls: tlsOf(f) });
  let body: any = {}; try { body = JSON.parse(res.body); } catch { /* handled by caller */ }
  return { status: res.status, body };
};
/** Finishes consent from the provider's redirect. The state must match a recent attempt of this workspace; the code is exchanged once. */
export async function completeConsent(c: Conn, ctx: Ctx, q: { code?: string; state?: string; error?: string }, deps: PullDeps = {}): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  require(ctx, "settings.manage");
  const state = String(q.state ?? "");
  const f = (await c.query<any>(`SELECT * FROM feed_connections WHERE consent_state_hash=$1 AND consent_started_at > now() - ($2 || ' minutes')::interval FOR UPDATE`, [sha256(state), String(STATE_MINUTES)])).rows[0];
  if (!state || !f) throw badRequest("This consent link has expired or was not started here. Start again from the feed.");
  const clear = () => c.query(`UPDATE feed_connections SET consent_state_hash=NULL, consent_verifier_sealed=NULL, consent_started_at=NULL WHERE id=$1`, [f.id]);
  if (q.error || !q.code) { await clear(); await c.query(`UPDATE feed_connections SET last_status='error', last_error=$2 WHERE id=$1`, [f.id, "The account holder did not give consent."]); return { ok: false, message: "Consent was not given at the provider." }; }
  const [clientId, ...rest] = unseal(f.secret_sealed).split(":");
  let r: Awaited<ReturnType<typeof tokenRequest>>;
  try { r = await tokenRequest(f, { grant_type: "authorization_code", code: String(q.code), redirect_uri: consentRedirectUri(), ...clientAuthForm(f, clientId, rest.join(":")), code_verifier: unseal(f.consent_verifier_sealed) }, deps); }
  catch { await clear(); return { ok: false, message: "The provider could not be reached to complete consent. Start again." }; }
  await clear();                                                    // the state and verifier are single-use whatever the outcome
  if (r.status < 200 || r.status >= 300 || !r.body?.access_token) return { ok: false, message: "The provider did not accept the consent. Start again." };
  const days = Number(r.body.refresh_token_expires_in) > 0 ? Number(r.body.refresh_token_expires_in) / 86400 : CONSENT_DAYS;
  const tokens = { access_token: String(r.body.access_token), refresh_token: r.body.refresh_token ? String(r.body.refresh_token) : null, expires_at: Date.now() + (Number(r.body.expires_in) || 300) * 1000 };
  await c.query(`UPDATE feed_connections SET token_sealed=$2, consented_at=now(), consent_expires_at=now() + ($3 || ' days')::interval, last_status='ok', last_error=NULL WHERE id=$1`, [f.id, seal(JSON.stringify(tokens)), String(Math.min(days, 365))]);
  await audit(c, ctx.tenantId, actorOf(ctx), "feed.consent_given", "feed_connection", f.id);
  return { ok: true, id: f.id as string };
}
export async function withdrawConsent(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "settings.manage");
  await must(c.query(`UPDATE feed_connections SET token_sealed=NULL, consented_at=NULL, consent_expires_at=NULL, consent_state_hash=NULL, consent_verifier_sealed=NULL, active=false WHERE id=$1 AND auth_scheme='oauth2_authcode' RETURNING id`, [recordId(id, "Feed")]), "Feed that uses account-holder consent");
  await audit(c, ctx.tenantId, actorOf(ctx), "feed.consent_withdrawn", "feed_connection", id);
}
/** A usable access token: the stored one while it is fresh, otherwise a refreshed one (stored back). Expired or withdrawn consent is a clear, non-retried failure. */
async function consentToken(db: Db, f: any, secret: string, deps: PullDeps): Promise<string> {
  const gone = (why: string) => Object.assign(new Error(why), { permanentMessage: `${why} Connect the account again.` });
  if (!f.token_sealed) throw gone("Consent has not been given, or has been withdrawn.");
  if (f.consent_expires_at && new Date(f.consent_expires_at).getTime() < Date.now()) throw gone("The account holder's consent has expired.");
  const t = JSON.parse(unseal(f.token_sealed));
  if (t.expires_at - 60_000 > Date.now()) return t.access_token;
  if (!t.refresh_token) throw gone("The access token expired and the provider issued no refresh token.");
  const [clientId, ...rest] = secret.split(":");
  const r = await tokenRequest(f, { grant_type: "refresh_token", refresh_token: t.refresh_token, ...clientAuthForm(f, clientId, rest.join(":")) }, deps);
  if (r.status === 400 || r.status === 401) { await db.tenant(f.tenant_id, (c) => c.query(`UPDATE feed_connections SET token_sealed=NULL WHERE id=$1`, [f.id])); throw gone("The provider no longer accepts this consent."); }
  if (r.status < 200 || r.status >= 300 || !r.body?.access_token) throw new Error(`token refresh answered HTTP ${r.status}`);
  const next = { access_token: String(r.body.access_token), refresh_token: r.body.refresh_token ? String(r.body.refresh_token) : t.refresh_token, expires_at: Date.now() + (Number(r.body.expires_in) || 300) * 1000 };
  await db.tenant(f.tenant_id, (c) => c.query(`UPDATE feed_connections SET token_sealed=$2 WHERE id=$1`, [f.id, seal(JSON.stringify(next))]));
  return next.access_token;
}
