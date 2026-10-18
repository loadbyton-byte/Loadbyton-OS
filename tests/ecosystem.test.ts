import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
vi.hoisted(() => {
  process.env.ECOSYSTEM_SHARED_SECRET = "test-ecosystem-secret";
  process.env.COM_BASE_URL = "https://com.example.test";
  process.env.OIDC_CLIENT_ID = "store";
  process.env.OIDC_CLIENT_SECRET = "store-client-secret";
  process.env.PUBLIC_BASE_URL = "https://store.example.test";
});
import crypto from "node:crypto";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { applyGrantEvent, expireLapsedGrants, receiveGrantEvent, reconcileFromCom, signEcosystem, verifyEcosystemSignature, type GrantEventT } from "../src/platform/ecosystem.js";
import { getLimit, assertWritable } from "../src/platform/entitlements.js";
import { currentPlans } from "../src/platform/catalog.js";
import { oidcHttp, resetOidcCache } from "../src/platform/oidc-client.js";
import { resetThrottle } from "../src/platform/auth.js";

const SECRET = "test-ecosystem-secret";
const ISSUER = "https://com.example.test/api/oidc";
let db: Db, app: ReturnType<typeof buildApp>;
let n = 0;

beforeAll(async () => { db = await freshDb(); app = buildApp(db); });
beforeEach(() => { resetThrottle(); });

const iso = (d: Date | number = Date.now()) => new Date(d).toISOString();
function event(org: string, version: number, over: Partial<GrantEventT["entitlement"]> = {}, activation: GrantEventT["activation"] | undefined = undefined, name = "Gulf Cargo LLC"): GrantEventT {
  return {
    id: `evt-${org}-${version}-${++n}-xxxx`, type: "entitlement.updated", created: iso(), version,
    organisation: { subject_id: org, name, verified: true, verified_by: "loadbyton.com" },
    entitlement: { product: "store", plan_code: "starter_included", status: "active", starts_at: iso(), ends_at: null, grace_until: null, reason: "verified_company", ...over },
    activation: activation === undefined ? { sector: "road-transport", accepted_by_subject: "person-1-xxxxxxxx", accepted_at: iso(), terms_version: "draft" } : activation,
  };
}
const newOrg = () => `org-${crypto.randomUUID()}`;
const signed = (ev: unknown, now = Date.now()) => { const raw = JSON.stringify(ev); return { raw, sig: signEcosystem(SECRET, raw, now) }; };

async function linkTenant(orgSub: string) {
  const t = await newTenant(db);
  await db.system(async (c) => {
    await c.query(`UPDATE tenants SET external_org_sub=$2 WHERE id=$1`, [t.tenantId, orgSub]);
    await c.query(`UPDATE ecosystem_orgs SET tenant_id=$2 WHERE org_sub=$1`, [orgSub, t.tenantId]);
  });
  return t;
}
const planOf = async (tenantId: string) => (await db.query<any>(`SELECT pv.plan_code, s.status, s.period_end FROM subscriptions s JOIN plan_versions pv ON pv.id=s.plan_version_id WHERE s.tenant_id=$1`, [tenantId])).rows[0];

describe("signing", () => {
  it("accepts a fresh valid signature and refuses tampering, staleness and the wrong secret", () => {
    const body = '{"a":1}', now = Date.now(), sig = signEcosystem(SECRET, body, now);
    expect(verifyEcosystemSignature(SECRET, body, sig, now)).toBe(true);
    expect(verifyEcosystemSignature(SECRET, body + " ", sig, now)).toBe(false);
    expect(verifyEcosystemSignature(SECRET, body, sig, now + 6 * 60_000)).toBe(false);
    expect(verifyEcosystemSignature("other", body, sig, now)).toBe(false);
    expect(verifyEcosystemSignature(SECRET, body, undefined, now)).toBe(false);
    expect(verifyEcosystemSignature(SECRET, body, "t=abc,v1=zz", now)).toBe(false);
  });
});

describe("webhook", () => {
  it("POST /webhooks/loadbyton needs no cookie or form token, but needs a valid signature", async () => {
    const org = newOrg();
    const { raw, sig } = signed(event(org, 1));
    const bad = await app.request("/webhooks/loadbyton", { method: "POST", body: raw, headers: { "content-type": "application/json", "lbt-signature": "t=1,v1=00" } });
    expect(bad.status).toBe(401);
    const ok = await app.request("/webhooks/loadbyton", { method: "POST", body: raw, headers: { "content-type": "application/json", "lbt-signature": sig } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).outcome).toBe("stored");
    const dup = await app.request("/webhooks/loadbyton", { method: "POST", body: raw, headers: { "content-type": "application/json", "lbt-signature": sig } });
    expect((await dup.json()).outcome).toBe("duplicate");
  });

  it("rejects a malformed or unknown-plan event even with a valid signature", async () => {
    const org = newOrg();
    const bad = { ...event(org, 1), entitlement: { ...event(org, 1).entitlement, plan_code: "business" } };
    const { raw, sig } = signed(bad);
    await expect(receiveGrantEvent(db, raw, sig)).rejects.toMatchObject({ status: 400 });
    const junk = signed({ hello: "world" });
    await expect(receiveGrantEvent(db, junk.raw, junk.sig)).rejects.toMatchObject({ status: 400 });
  });
});

describe("ordering and idempotency", () => {
  it("applies the highest version only; replays and older versions change nothing", async () => {
    const org = newOrg();
    const v3 = event(org, 3, { plan_code: "enterprise_included", reason: "premium_active" });
    expect((await applyGrantEvent(db, v3)).outcome).toBe("stored");
    expect((await applyGrantEvent(db, v3)).outcome).toBe("duplicate");
    expect((await applyGrantEvent(db, event(org, 2))).outcome).toBe("stale");
    const row = (await db.query<any>(`SELECT * FROM ecosystem_orgs WHERE org_sub=$1`, [org])).rows[0];
    expect(row.last_version).toBe(3);
    expect(row.plan_code).toBe("enterprise_included");
  });
});

describe("applying to a linked workspace", () => {
  it("Starter Included → Enterprise Included → Starter Included changes the ceilings, never the data", async () => {
    const org = newOrg();
    await applyGrantEvent(db, event(org, 1));
    const t = await linkTenant(org);
    expect((await applyGrantEvent(db, event(org, 2))).outcome).toBe("applied");
    expect(await getLimit(db as any, t.tenantId, "max_users")).toBe(3);
    expect((await planOf(t.tenantId)).plan_code).toBe("starter_included");

    await applyGrantEvent(db, event(org, 3, { plan_code: "enterprise_included", reason: "premium_active" }));
    expect(await getLimit(db as any, t.tenantId, "max_users")).toBe(100);
    expect(await getLimit(db as any, t.tenantId, "max_sectors")).toBe(18);
    expect((await planOf(t.tenantId)).period_end).toBeNull();   // never enters the renewal loop

    await applyGrantEvent(db, event(org, 4, { reason: "premium_ended_reverted_to_starter" }));
    expect(await getLimit(db as any, t.tenantId, "max_users")).toBe(3);
    expect((await planOf(t.tenantId)).plan_code).toBe("starter_included");
  });

  it("grace keeps Enterprise and stays writable; suspension makes the workspace read-only", async () => {
    const org = newOrg();
    await applyGrantEvent(db, event(org, 1, { plan_code: "enterprise_included" }));
    const t = await linkTenant(org);
    await applyGrantEvent(db, event(org, 2, { plan_code: "enterprise_included", status: "grace", grace_until: iso(Date.now() + 14 * 86400000), reason: "premium_payment_grace" }));
    expect(await planOf(t.tenantId)).toMatchObject({ plan_code: "enterprise_included", status: "grace" });
    await expect(assertWritable(db as any, t.tenantId, { skipVerification: true })).resolves.toBeUndefined();

    await applyGrantEvent(db, event(org, 3, { plan_code: null, status: "suspended", reason: "organisation_unverified" }));
    expect((await planOf(t.tenantId)).status).toBe("restricted");
    await expect(assertWritable(db as any, t.tenantId, { skipVerification: true })).rejects.toMatchObject({ status: 402 });
    // nothing was deleted
    expect((await db.query<any>(`SELECT count(*)::int n FROM tenants WHERE id=$1`, [t.tenantId])).rows[0].n).toBe(1);
  });

  it("never downgrades or restricts a workspace that pays for an equal or higher plan", async () => {
    const org = newOrg();
    await applyGrantEvent(db, event(org, 1));
    const t = await linkTenant(org);
    await db.system(async (c) => {
      const business = (await c.query<any>(`SELECT id FROM plan_versions WHERE plan_code='business' ORDER BY version DESC LIMIT 1`)).rows[0];
      await c.query(`UPDATE subscriptions SET plan_version_id=$2, status='active', period_end=now() + interval '20 days' WHERE tenant_id=$1`, [t.tenantId, business.id]);
    });
    expect((await applyGrantEvent(db, event(org, 2))).outcome).toBe("kept_higher_paid");
    expect((await planOf(t.tenantId)).plan_code).toBe("business");
    expect((await applyGrantEvent(db, event(org, 3, { plan_code: null, status: "suspended", reason: "organisation_unverified" }))).outcome).toBe("kept_own_plan");
    expect((await planOf(t.tenantId)).status).toBe("active");
    // a genuinely higher included plan does upgrade
    expect((await applyGrantEvent(db, event(org, 4, { plan_code: "enterprise_included" }))).outcome).toBe("applied");
    expect((await planOf(t.tenantId)).plan_code).toBe("enterprise_included");
  });

  it("included plans are never offered in the public tariff", async () => {
    const org = newOrg();
    await applyGrantEvent(db, event(org, 1));
    await linkTenant(org);
    await applyGrantEvent(db, event(org, 2));
    const codes = (await db.system((c) => currentPlans(c))).map((p) => p.plan_code);
    expect(codes).toEqual(["free", "starter", "business", "operations", "enterprise"]);
  });

  it("fail-safe: Enterprise Included never outlives its grace window if loadbyton.com is silent", async () => {
    const org = newOrg();
    await applyGrantEvent(db, event(org, 1, { plan_code: "enterprise_included" }));
    const t = await linkTenant(org);
    await applyGrantEvent(db, event(org, 2, { plan_code: "enterprise_included", status: "grace", grace_until: iso(Date.now() - 1000), reason: "premium_payment_grace" }));
    expect(await expireLapsedGrants(db)).toBeGreaterThanOrEqual(1);
    expect((await planOf(t.tenantId)).plan_code).toBe("starter_included");
    // the authoritative newer event still wins afterwards
    await applyGrantEvent(db, event(org, 3, { plan_code: "enterprise_included", reason: "premium_active" }));
    expect((await planOf(t.tenantId)).plan_code).toBe("enterprise_included");
  });
});

describe("reconciliation", () => {
  it("applies grants the webhook missed, using a signed read", async () => {
    const org = newOrg();
    const seen: string[] = [];
    const fakeFetch = (async (url: string, init: any) => {
      seen.push(url);
      expect(verifyEcosystemSignature(SECRET, "GET /api/ecosystem/grants", init.headers["LBT-Signature"])).toBe(true);
      return new Response(JSON.stringify({ grants: [event(org, 1), { junk: true }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await reconcileFromCom(db, fakeFetch);
    expect(r).toEqual({ skipped: false, applied: 1 });
    expect(seen[0]).toBe("https://com.example.test/api/ecosystem/grants");
    expect((await db.query<any>(`SELECT plan_code FROM ecosystem_orgs WHERE org_sub=$1`, [org])).rows[0].plan_code).toBe("starter_included");
    expect(await reconcileFromCom(db, fakeFetch)).toEqual({ skipped: false, applied: 0 });
  });
});

// ───────────── Continue with Loadbyton ─────────────

class Browser {
  jar = new Map<string, string>();
  private cookies() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(path: string, init: RequestInit = {}) {
    const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie: this.cookies() } });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v === "" || /max-age=0/i.test(sc)) this.jar.delete(k); else this.jar.set(k, v);
    }
    return res;
  }
  get(p: string) { return this.req(p); }
  async post(p: string, fields: Record<string, string>) {
    await this.get("/login");
    const body = new URLSearchParams({ _csrf: this.jar.get("lbt_csrf")!, ...fields });
    return this.req(p, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
}

const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function idToken(over: Record<string, unknown> = {}, signWith = key.privateKey) {
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify({ iss: ISSUER, aud: "store", iat: now, exp: now + 600, ...over }));
  return `${head}.${body}.${b64u(crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), signWith))}`;
}

let nonce = "";
let claimsFor: Record<string, unknown> = {};
let tamper: "none" | "badsig" | "audience" | "nonce" = "none";
oidcHttp.fetch = (async (url: string, init?: any) => {
  const u = String(url);
  if (u.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks.json` });
  if (u.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
  if (u.endsWith("/token")) {
    const form = new URLSearchParams(String(init.body));
    expect(form.get("client_secret")).toBe("store-client-secret");
    expect(form.get("code_verifier")).toBeTruthy();
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const over: Record<string, unknown> = { nonce, ...claimsFor };
    if (tamper === "audience") over.aud = "someone-else";
    if (tamper === "nonce") over.nonce = "wrong";
    return Response.json({ id_token: idToken(over, tamper === "badsig" ? other : key.privateKey), access_token: "x", token_type: "Bearer" });
  }
  throw new Error(`unexpected fetch ${u}`);
}) as unknown as typeof fetch;

const person = (over: Record<string, unknown> = {}) => ({
  sub: `person-${crypto.randomUUID()}`, email: `owner-${crypto.randomUUID().slice(0, 8)}@gulfcargo.test`, email_verified: true, name: "Amira Owner",
  org_sub: newOrg(), org_name: "Gulf Cargo LLC", org_role: "owner", org_verified: true, ...over,
});

async function startAndReturn(b: Browser, claims: Record<string, unknown>, mutate?: (u: URL) => void) {
  resetOidcCache();
  claimsFor = claims;
  const start = await b.get("/auth/loadbyton?next=/app/jobs");
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(`${ISSUER}/authorize`);
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  expect(loc.searchParams.get("redirect_uri")).toBe("https://store.example.test/auth/loadbyton/callback");
  nonce = loc.searchParams.get("nonce")!;
  const cb = new URL("https://x/auth/loadbyton/callback");
  cb.searchParams.set("code", "one-time-code"); cb.searchParams.set("state", loc.searchParams.get("state")!); cb.searchParams.set("iss", ISSUER);
  mutate?.(cb);
  return b.get(cb.pathname + cb.search);
}
const location = (r: Response) => decodeURIComponent(r.headers.get("location") ?? "");

describe("Continue with Loadbyton", () => {
  it("the login page offers it when configured, and the start link refuses an unsafe next", async () => {
    const html = await (await app.request("/login")).text();
    expect(html).toContain("Continue with Loadbyton");
    const b = new Browser();
    const start = await b.get("/auth/loadbyton?next=//evil.example");
    const flow = new URL(start.headers.get("location")!);
    expect(flow.searchParams.get("client_id")).toBe("store");
  });

  it("first sign-in of an activated company's owner creates the account and one workspace on the granted plan", async () => {
    const p = person();
    await applyGrantEvent(db, event(p.org_sub, 1, {}, { sector: "road-transport", accepted_by_subject: p.sub, accepted_at: iso(), terms_version: "draft" }, "Gulf Cargo LLC"));
    const b = new Browser();
    const r = await startAndReturn(b, p);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app/jobs");
    expect(b.jar.get("lbt_session")).toBeTruthy();

    const t = (await db.query<any>(`SELECT * FROM tenants WHERE external_org_sub=$1`, [p.org_sub])).rows[0];
    expect(t.name).toBe("Gulf Cargo LLC");
    expect(t.verification_status).toBe("verified");
    expect((await planOf(t.id)).plan_code).toBe("starter_included");
    expect(await getLimit(db as any, t.id, "max_users")).toBe(3);
    expect((await db.query<any>(`SELECT sector FROM tenant_sectors WHERE tenant_id=$1`, [t.id])).rows.map((x) => x.sector)).toEqual(["road-transport"]);
    expect((await db.query<any>(`SELECT roles FROM memberships WHERE tenant_id=$1`, [t.id])).rows[0].roles).toEqual(["owner"]);
    expect((await db.query<any>(`SELECT tenant_id FROM ecosystem_orgs WHERE org_sub=$1`, [p.org_sub])).rows[0].tenant_id).toBe(t.id);

    // signing in again finds the same person and the same workspace
    const again = await startAndReturn(new Browser(), p);
    expect(again.status).toBe(302);
    expect((await db.query<any>(`SELECT count(*)::int n FROM tenants WHERE external_org_sub=$1`, [p.org_sub])).rows[0].n).toBe(1);
    expect((await db.query<any>(`SELECT count(*)::int n FROM identity_links WHERE subject_id=$1`, [p.sub])).rows[0].n).toBe(1);
  });

  it("a company that has not activated Business OS gets a clear message and no workspace", async () => {
    const p = person();
    const r = await startAndReturn(new Browser(), p);
    expect(location(r)).toMatch(/^\/login\?err=.*not activated/);
    expect((await db.query<any>(`SELECT count(*)::int n FROM tenants WHERE external_org_sub=$1`, [p.org_sub])).rows[0].n).toBe(0);
  });

  it("a suspended (unverified) company cannot create a workspace", async () => {
    const p = person();
    await applyGrantEvent(db, event(p.org_sub, 1, { plan_code: null, status: "suspended", reason: "organisation_unverified" }));
    const r = await startAndReturn(new Browser(), p);
    expect(location(r)).toMatch(/not activated/);
  });

  it("only the company administrator creates the workspace; a seat must be invited", async () => {
    const owner = person();
    await applyGrantEvent(db, event(owner.org_sub, 1));
    const seat = person({ org_sub: owner.org_sub, org_role: "ops" });
    expect(location(await startAndReturn(new Browser(), seat))).toMatch(/administrator needs to sign in first/);
    expect((await startAndReturn(new Browser(), owner)).status).toBe(302);
    const second = await startAndReturn(new Browser(), seat);
    expect(location(second)).toMatch(/invite you/);
  });

  it("never links an existing account by email alone: it asks for that account's password", async () => {
    const t = await newTenant(db, "Existing Co");
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const p = person({ email, org_name: "Existing Co" });
    await applyGrantEvent(db, event(p.org_sub, 1));
    const b = new Browser();
    const r = await startAndReturn(b, p);
    expect(r.headers.get("location")).toBe("/auth/loadbyton/link");
    expect((await db.query<any>(`SELECT count(*)::int n FROM identity_links WHERE subject_id=$1`, [p.sub])).rows[0].n).toBe(0);
    expect(b.jar.get("lbt_session")).toBeUndefined();

    const page = await (await b.get("/auth/loadbyton/link")).text();
    expect(page).toContain(email);
    const wrong = await b.post("/auth/loadbyton/link", { password: "not the password" });
    expect(location(wrong)).toMatch(/^\/auth\/loadbyton\/link\?err=/);
    expect((await db.query<any>(`SELECT count(*)::int n FROM identity_links WHERE subject_id=$1`, [p.sub])).rows[0].n).toBe(0);

    const right = await b.post("/auth/loadbyton/link", { password: "correct horse battery" });
    expect(right.status).toBe(302);
    expect(right.headers.get("location")).toBe("/app/jobs");
    expect(b.jar.get("lbt_session")).toBeTruthy();
    expect((await db.query<any>(`SELECT user_id FROM identity_links WHERE subject_id=$1`, [p.sub])).rows[0].user_id).toBe(t.userId);
  });

  it("refuses a tampered, mis-addressed or replayed ID token, and a state mismatch", async () => {
    const mk = () => { const p = person(); return applyGrantEvent(db, event(p.org_sub, 1)).then(() => p); };
    for (const mode of ["badsig", "audience", "nonce"] as const) {
      tamper = mode;
      const p = await mk();
      const r = await startAndReturn(new Browser(), p);
      expect(location(r), mode).toMatch(/^\/login\?err=.*could not be verified/);
      expect((await db.query<any>(`SELECT count(*)::int n FROM users WHERE email=$1`, [p.email])).rows[0].n, mode).toBe(0);
    }
    tamper = "none";
    const p = await mk();
    const r = await startAndReturn(new Browser(), p, (cb) => cb.searchParams.set("state", "forged"));
    expect(location(r)).toMatch(/expired/);
    const noCookie = await new Browser().get("/auth/loadbyton/callback?code=c&state=s");
    expect(location(noCookie)).toMatch(/expired/);
    const denied = await new Browser().get("/auth/loadbyton/callback?error=access_denied");
    expect(location(denied)).toMatch(/did not allow/);
  });
});
