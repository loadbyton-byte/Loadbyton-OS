import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Db } from "../db/client.js";
import { config } from "../config.js";
import type { Ctx } from "../lib/perms.js";
import { HttpError, hmac, randomToken, safeEqual } from "../lib/util.js";
import { loadSession, resolveCtx, type Session } from "../platform/auth.js";
import { tenantForHost } from "../platform/admin.js";
import type { ApiPrincipal } from "../ops/delivery-notify.js";

export type Env = {
  Variables: {
    db: Db; session: Session | null; ctx: Ctx | null; csrf: string; hostSlug: string | null;
    tenant: { name: string; slug: string; sectors: string[]; plan: string; planCode: string; subStatus: string } | null;
    memberships: { tenant_id: string; name: string }[];
    apiKey?: ApiPrincipal;
    apiAuth?: Awaited<ReturnType<typeof import('../platform/api.js').apiContext>>;
    traceId?: string;
  };
};
export type C = Context<Env>;

export const SESSION_COOKIE = "lbt_session";
const CSRF_COOKIE = "lbt_csrf";
const cookieOpts = { httpOnly: true, sameSite: "Lax" as const, secure: config.isProd, path: "/" };

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (config.isProd) c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  if (!c.res.headers.has("Cache-Control") && !c.req.path.startsWith("/assets") && !c.req.path.startsWith("/brand")) c.header("Cache-Control", "no-store");
};

export const dbMw = (db: Db): MiddlewareHandler<Env> => async (c, next) => { c.set("db", db); await next(); };

/** Signed double-submit CSRF token (cookie + hidden field), on top of SameSite=Lax. */
export const csrfMw: MiddlewareHandler<Env> = async (c, next) => {
  let tok = getCookie(c, CSRF_COOKIE);
  const valid = (t?: string) => !!t && t.includes(".") && [config.sessionSecret, config.previousSessionSecret].filter(Boolean).some((k) => safeEqual(t.split(".")[1], hmac(k, `csrf:${t.split(".")[0]}`)));
  if (!valid(tok)) {
    const r = randomToken(16);
    tok = `${r}.${hmac(config.sessionSecret, `csrf:${r}`)}`;
    setCookie(c, CSRF_COOKIE, tok, cookieOpts);
  }
  c.set("csrf", tok!);
  if (c.req.method === "POST" && c.req.path === "/app/driver/sync") {
    // JSON batch from the offline queue: signed double-submit token in a header (cookie is HttpOnly=false-equivalent via JS read)
    const h = c.req.header("x-csrf-token") ?? "";
    if (!(c.req.header("content-type") ?? "").includes("application/json")) throw new HttpError(415, "Unsupported content type");
    if (!valid(h) || !safeEqual(h, tok!)) throw new HttpError(403, "Invalid CSRF token", "csrf");
  } else if (c.req.method === "POST" && !c.req.path.startsWith("/webhooks/") && !c.req.path.startsWith("/api/")) {   // /api/ is bearer-token authenticated and never reads cookies
    const ct = c.req.header("content-type") ?? "";
    if (!/form/.test(ct)) throw new HttpError(415, "Unsupported content type");
    const body = await c.req.parseBody({ all: true });
    const sent = String(body._csrf ?? "");
    if (!valid(sent) || !safeEqual(sent, tok!)) throw new HttpError(403, "Your session form expired. Go back, refresh the page and try again.", "csrf");
    // cache parsed body so handlers can reuse it
    (c as any).set("_body", body);
  }
  await next();
};

export async function formBody(c: C): Promise<Record<string, any>> {
  const cached = (c as any).get("_body");
  return cached ?? (await c.req.parseBody({ all: true }));
}
export const arr = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
export const str = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? "") : String(v ?? ""));

export const sessionMw: MiddlewareHandler<Env> = async (c, next) => {
  const db = c.get("db");
  const s = await loadSession(db, getCookie(c, SESSION_COOKIE));
  c.set("session", s);
  const host = (c.req.header("host") ?? "").split(":")[0].toLowerCase();
  let hostSlug: string | null = null;
  if (host && host !== "localhost" && !/^[\d.]+$/.test(host)) hostSlug = await tenantForHost(db, host);
  c.set("hostSlug", hostSlug);
  c.set("ctx", null);
  c.set("tenant", null);
  c.set("memberships", []);
  await next();
};

export function setSessionCookie(c: C, token: string) {
  setCookie(c, SESSION_COOKIE, token, { ...cookieOpts, maxAge: 12 * 3600 });
}
export function clearSessionCookie(c: C) { deleteCookie(c, SESSION_COOKIE, { path: "/" }); }

/** Gate for the company application: authenticated membership (or support grant) decides tenant context. */
export const requireCtx: MiddlewareHandler<Env> = async (c, next) => {
  const s = c.get("session");
  if (!s) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
  const ctx = await resolveCtx(c.get("db"), s, c.get("hostSlug"));
  if (!ctx) {
    if (s.isStaff && !s.tenantId) return c.redirect("/admin");
    throw new HttpError(403, "You do not have access to a workspace. Ask an owner to invite you.", "forbidden");
  }
  c.set("ctx", ctx);
  const mfa=(await c.get('db').query<any>(`SELECT enabled FROM user_mfa WHERE user_id=$1`,[s.userId])).rows[0]?.enabled;
  const sensitive=ctx.roles.some(r=>['owner','finance','hr','customs','specialist','pricing','coordinator'].includes(r));
  if(!s.companyMfaOk && !ctx.supportStaffId && (mfa||(config.companyMfaRequired&&sensitive)))return c.redirect('/account/security');
  await next();
};

export const requireStaff: MiddlewareHandler<Env> = async (c, next) => {
  const s = c.get("session");
  if (!s) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
  if (!s.isStaff) throw new HttpError(403, "Platform staff only.", "forbidden");
  if (!s.mfaOk) return c.redirect("/admin/mfa");
  await next();
};

export function safeNext(n: string | undefined | null, fallback: string) {
  return n && /^\/[A-Za-z0-9\-._~\/%?=&]*$/.test(n) && !n.startsWith("//") ? n : fallback;
}

/** The caller's address, taken only from the header the deployment says it controls (Cloudflare / a trusted proxy); otherwise unknown. */
export function clientIp(c: C): string {
  if (config.trustProxy === "cloudflare") return (c.req.header("cf-connecting-ip") ?? "").trim();
  if (config.trustProxy === "xff") return (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim();
  return "";
}
