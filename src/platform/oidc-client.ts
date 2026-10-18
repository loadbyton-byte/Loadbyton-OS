import crypto from "node:crypto";
import { config } from "../config.js";
import { HttpError, hmac, randomToken, safeEqual } from "../lib/util.js";

/**
 * "Continue with Loadbyton": relying-party side of the loadbyton.com OpenID
 * Connect issuer. Authorization code flow with PKCE (S256), state and nonce;
 * the code is exchanged server to server with the client secret; the ID token
 * is verified (RS256 signature against the issuer's JWKS, issuer, audience,
 * expiry, nonce). Nothing sensitive is placed in a URL except the one-time
 * code, and the browser holds only a signed, short-lived flow cookie.
 */

/** Replaced in tests; production uses the platform fetch. */
export const oidcHttp = { fetch: ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch };

export const oidcConfigured = () => !!(config.ecosystem.oidcClientId && config.ecosystem.oidcClientSecret && config.ecosystem.oidcIssuer);

export interface LoadbytonClaims {
  sub: string; email: string; email_verified: boolean; name: string;
  org_sub: string; org_name: string; org_role: string; org_verified: boolean;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

// ───────────── signed cookies ─────────────
export function seal(data: Record<string, unknown>, ttlSeconds: number, now = Date.now()): string {
  const payload = b64u(JSON.stringify({ ...data, exp: Math.floor(now / 1000) + ttlSeconds }));
  return `${payload}.${hmac(config.sessionSecret, `oidc:${payload}`)}`;
}
export function unseal<T = Record<string, any>>(value: string | undefined, now = Date.now()): T | null {
  if (!value || !value.includes(".")) return null;
  const [payload, sig] = value.split(".");
  const ok = [config.sessionSecret, config.previousSessionSecret].filter(Boolean).some((k) => safeEqual(sig ?? "", hmac(k, `oidc:${payload}`)));
  if (!ok) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.exp * 1000 > now ? data : null;
  } catch { return null; }
}

// ───────────── discovery and keys ─────────────
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
let discoveryCache: { at: number; value: Discovery } | null = null;
let jwksCache: { at: number; keys: any[] } | null = null;
const TTL_MS = 10 * 60 * 1000;
export function resetOidcCache() { discoveryCache = null; jwksCache = null; }

async function getJson(url: string, init?: RequestInit) {
  const res = await oidcHttp.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new HttpError(502, "Sign-in with Loadbyton is temporarily unavailable.", "upstream");
  return res.json() as Promise<any>;
}

async function discovery(): Promise<Discovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < TTL_MS) return discoveryCache.value;
  const issuer = config.ecosystem.oidcIssuer;
  const d = await getJson(`${issuer}/.well-known/openid-configuration`);
  if (d.issuer !== issuer) throw new HttpError(502, "Sign-in with Loadbyton is misconfigured (issuer mismatch).", "upstream");
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (typeof d[k] !== "string" || (config.isProd && !String(d[k]).startsWith("https://"))) throw new HttpError(502, "Sign-in with Loadbyton is misconfigured.", "upstream");
  }
  discoveryCache = { at: Date.now(), value: d };
  return d;
}

async function keyFor(kid: string, jwksUri: string) {
  const find = () => jwksCache?.keys.find((k) => k.kid === kid);
  if (!jwksCache || Date.now() - jwksCache.at > TTL_MS || !find()) {
    jwksCache = { at: Date.now(), keys: (await getJson(jwksUri)).keys ?? [] };
  }
  const jwk = find();
  if (!jwk) throw new HttpError(502, "Sign-in with Loadbyton could not verify the response.", "upstream");
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

// ───────────── flow ─────────────
export const callbackUrl = () => `${config.baseUrl.replace(/\/$/, "")}/auth/loadbyton/callback`;

export async function beginLogin(next: string) {
  const d = await discovery();
  const verifier = randomToken(32), state = randomToken(16), nonce = randomToken(16);
  const url = new URL(d.authorization_endpoint);
  const q: Record<string, string> = {
    response_type: "code", client_id: config.ecosystem.oidcClientId, redirect_uri: callbackUrl(), scope: "openid email profile organisation",
    state, nonce, code_challenge: b64u(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  };
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  return { url: url.toString(), cookie: seal({ state, nonce, verifier, next }, 600) };
}

/** Verifies the return from loadbyton.com and returns the proven claims. */
export async function completeLogin(params: { code?: string; state?: string; iss?: string }, flowCookie: string | undefined): Promise<{ claims: LoadbytonClaims; next: string }> {
  const flow = unseal<{ state: string; nonce: string; verifier: string; next: string }>(flowCookie);
  if (!flow || !params.state || !safeEqual(params.state, flow.state)) throw new HttpError(400, "Your sign-in attempt expired. Try again.", "oidc_state");
  if (params.iss && params.iss !== config.ecosystem.oidcIssuer) throw new HttpError(400, "Sign-in response came from an unexpected issuer.", "oidc_iss");
  if (!params.code) throw new HttpError(400, "Sign-in was not completed.", "oidc_code");
  const d = await discovery();
  const body = new URLSearchParams({
    grant_type: "authorization_code", code: params.code, redirect_uri: callbackUrl(), code_verifier: flow.verifier,
    client_id: config.ecosystem.oidcClientId, client_secret: config.ecosystem.oidcClientSecret,
  });
  const tok = await getJson(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const claims = await verifyIdToken(String(tok.id_token ?? ""), flow.nonce, d);
  return { claims, next: flow.next };
}

export async function verifyIdToken(token: string, nonce: string, d?: Discovery, now = Date.now()): Promise<LoadbytonClaims> {
  const disc = d ?? await discovery();
  const parts = token.split(".");
  const bad = () => new HttpError(401, "Sign-in with Loadbyton could not be verified.", "oidc_token");
  if (parts.length !== 3) throw bad();
  let header: any, p: any;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString()); p = JSON.parse(Buffer.from(parts[1], "base64url").toString()); } catch { throw bad(); }
  if (header.alg !== "RS256" || !header.kid) throw bad();
  const key = await keyFor(header.kid, disc.jwks_uri);
  if (!crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))) throw bad();
  if (p.iss !== config.ecosystem.oidcIssuer || p.aud !== config.ecosystem.oidcClientId || !(p.exp * 1000 > now) || p.nonce !== nonce) throw bad();
  
  for (const k of ["sub", "email", "org_sub", "org_name", "org_role"]) if (typeof p[k] !== "string" || !p[k]) throw bad();
  return {
    sub: p.sub, email: String(p.email).toLowerCase(), email_verified: !!p.email_verified, name: String(p.name || p.org_name),
    org_sub: p.org_sub, org_name: p.org_name, org_role: p.org_role, org_verified: !!p.org_verified,
  };
}
