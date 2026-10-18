import crypto from "node:crypto";
import { z } from "zod";
import type { Conn, Db } from "../db/client.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { HttpError, badRequest, safeEqual } from "../lib/util.js";
import { applyPlanEntitlements, previewPlanChange } from "./entitlements.js";
import { PLAN_SEEDS, type PlanVersion } from "./catalog.js";

/**
 * Link with loadbyton.com (master plan §3, §9).
 *
 * loadbyton.com decides who is eligible and sends the decision as a signed,
 * versioned event. This module only applies it: it never decides eligibility
 * itself, never charges for an included plan, and never deletes data.
 *
 *   starter_included     verified company that activated Business OS
 *   enterprise_included  the same company while its premium membership is active
 *
 * Statuses: active · grace (payment grace, plan unchanged) · suspended
 * (company no longer verified; workspace is read-only) · ended.
 */

export const INCLUDED_PLAN_CODES = ["starter_included", "enterprise_included"] as const;
export type IncludedPlan = (typeof INCLUDED_PLAN_CODES)[number];
export const isIncludedPlan = (code: string | null | undefined): code is IncludedPlan => !!code && (INCLUDED_PLAN_CODES as readonly string[]).includes(code);

/** Included plans reuse the published ceilings of Starter and Enterprise with no price. */
const BASE_OF: Record<IncludedPlan, string> = { starter_included: "starter", enterprise_included: "enterprise" };
const NAME_OF: Record<IncludedPlan, string> = { starter_included: "Starter Included", enterprise_included: "Enterprise Included" };

/** Ranking used to avoid silently downgrading a workspace that already pays for a higher plan. */
const RANK: Record<string, number> = { free: 0, starter: 1, starter_included: 1, business: 2, operations: 3, enterprise: 4, enterprise_included: 4 };

export async function ensureIncludedPlans(c: Conn) {
  for (const code of INCLUDED_PLAN_CODES) {
    const base = PLAN_SEEDS.find((p) => p.code === BASE_OF[code])!;
    await c.query(
      `INSERT INTO plan_versions(plan_code, version, name, monthly_minor, setup_minor, limits, contact_sales)
       VALUES ($1,1,$2,0,0,$3,false) ON CONFLICT (plan_code, version) DO NOTHING`,
      [code, NAME_OF[code], JSON.stringify(base.limits)]);
  }
}

async function includedPlan(c: Conn, code: IncludedPlan): Promise<PlanVersion> {
  await ensureIncludedPlans(c);
  return (await c.query<PlanVersion>(`SELECT * FROM plan_versions WHERE plan_code=$1 ORDER BY version DESC LIMIT 1`, [code])).rows[0];
}

// ───────────── signing ─────────────

const TOLERANCE_SECONDS = 300;

export function signEcosystem(secret: string, payload: string, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

export function verifyEcosystemSignature(secret: string, payload: string, header: string | undefined, now = Date.now()): boolean {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  if (!/^\d+$/.test(parts.t ?? "") || !/^[0-9a-f]+$/.test(parts.v1 ?? "")) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(parts.t)) > TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${payload}`).digest("hex");
  return safeEqual(expected, parts.v1);
}

// ───────────── events ─────────────

const GrantEvent = z.object({
  id: z.string().min(8).max(100),
  type: z.literal("entitlement.updated"),
  created: z.string().max(40),
  version: z.number().int().positive(),
  organisation: z.object({
    subject_id: z.string().min(8).max(100), name: z.string().min(1).max(200), verified: z.boolean(), verified_by: z.string().max(60),
  }),
  entitlement: z.object({
    product: z.literal("store"),
    plan_code: z.enum(INCLUDED_PLAN_CODES).nullable(),
    status: z.enum(["active", "grace", "suspended", "ended"]),
    starts_at: z.string().max(40), ends_at: z.string().max(40).nullable(), grace_until: z.string().max(40).nullable(),
    reason: z.string().max(100),
  }),
  activation: z.object({
    sector: z.string().max(60), accepted_by_subject: z.string().max(100).nullable(), accepted_at: z.string().max(40), terms_version: z.string().max(80),
  }).nullable(),
});
export type GrantEventT = z.infer<typeof GrantEvent>;

export type EventOutcome = "duplicate" | "stale" | "stored" | "applied" | "restricted" | "kept_higher_paid" | "kept_own_plan";

export interface ApplyResult { outcome: EventOutcome; note?: string }

/**
 * Applies the organisation's entitlement to its linked workspace.
 * Never touches a workspace that pays for an equal or higher plan, and never
 * restricts one that was not on an included plan.
 */
export async function applyGrantToTenant(
  c: Conn, tenantId: string,
  g: { plan_code: IncludedPlan | null; status: "active" | "grace" | "suspended" | "ended"; grace_until: string | null },
  source: string, now = new Date(),
): Promise<ApplyResult> {
  const cur = (await c.query<any>(
    `SELECT s.id, s.status, s.period_end, pv.plan_code FROM subscriptions s JOIN plan_versions pv ON pv.id=s.plan_version_id WHERE s.tenant_id=$1`, [tenantId])).rows[0];

  if (!g.plan_code || g.status === "suspended" || g.status === "ended") {
    if (cur && isIncludedPlan(cur.plan_code)) {
      await c.query(`UPDATE subscriptions SET status='restricted', updated_at=now() WHERE tenant_id=$1`, [tenantId]);
      await audit(c, tenantId, { kind: "system" }, "ecosystem.restricted", "subscription", cur.id, { source, status: g.status });
      return { outcome: "restricted" };
    }
    return { outcome: "kept_own_plan" };
  }

  const paidNow = cur && !isIncludedPlan(cur.plan_code) && cur.plan_code !== "free" && ["active", "grace"].includes(cur.status)
    && cur.period_end && new Date(cur.period_end) > now;
  if (paidNow && (RANK[cur.plan_code] ?? 0) >= RANK[g.plan_code]) {
    await audit(c, tenantId, { kind: "system" }, "ecosystem.kept_paid_plan", "subscription", cur.id, { source, paid: cur.plan_code, granted: g.plan_code });
    return { outcome: "kept_higher_paid", note: `workspace already pays for ${cur.plan_code}` };
  }

  const plan = await includedPlan(c, g.plan_code);
  const status = g.status === "grace" ? "grace" : "active";
  // period_end stays null: included plans never enter the billing renewal loop. loadbyton.com sends the change at period end.
  if (cur) {
    await c.query(
      `UPDATE subscriptions SET plan_version_id=$2, status=$3, period_start=now(), period_end=NULL, cancel_at_period_end=false,
              scheduled_plan_version_id=NULL, grace_until=$4, updated_at=now() WHERE tenant_id=$1`,
      [tenantId, plan.id, status, status === "grace" ? g.grace_until : null]);
  } else {
    await c.query(
      `INSERT INTO subscriptions(tenant_id, plan_version_id, status, period_end, grace_until) VALUES ($1,$2,$3,NULL,$4)`,
      [tenantId, plan.id, status, status === "grace" ? g.grace_until : null]);
  }
  await applyPlanEntitlements(c, tenantId, plan, source);
  // Over-limit records stay readable and exportable; only new records of the affected type are blocked.
  const preview = await previewPlanChange(c, tenantId, plan);
  await audit(c, tenantId, { kind: "system" }, "ecosystem.plan_applied", "subscription", cur?.id ?? tenantId, { source, plan: plan.plan_code, status, over_limit: preview.issues });
  return { outcome: "applied", note: preview.issues.length ? preview.note : undefined };
}

/** Receives one signed event: verify, de-duplicate, order by version, store, and apply to the linked workspace if there is one. */
export async function receiveGrantEvent(db: Db, raw: string, signature: string | undefined, now = new Date()): Promise<ApplyResult> {
  if (!config.ecosystem.sharedSecret) throw new HttpError(503, "The loadbyton.com link is not configured.", "not_configured");
  if (!verifyEcosystemSignature(config.ecosystem.sharedSecret, raw, signature, now.getTime())) throw new HttpError(401, "Invalid signature.", "unauthorized");
  let parsed: GrantEventT;
  try { parsed = GrantEvent.parse(JSON.parse(raw)); } catch { throw badRequest("Malformed event."); }
  return applyGrantEvent(db, parsed, now);
}

export async function applyGrantEvent(db: Db, ev: GrantEventT, now = new Date()): Promise<ApplyResult> {
  return db.system(async (c) => {
    const fresh = await c.query(
      `INSERT INTO ecosystem_inbox(event_id, org_sub, version, outcome, payload) VALUES ($1,$2,$3,'received',$4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [ev.id, ev.organisation.subject_id, ev.version, JSON.stringify(ev)]);
    if (!fresh.rows.length) return { outcome: "duplicate" as const };

    const org = ev.organisation, ent = ev.entitlement;
    const existing = (await c.query<any>(`SELECT * FROM ecosystem_orgs WHERE org_sub=$1 FOR UPDATE`, [org.subject_id])).rows[0];
    if (existing && ev.version <= existing.last_version) {
      await c.query(`UPDATE ecosystem_inbox SET outcome='stale' WHERE event_id=$1`, [ev.id]);
      return { outcome: "stale" as const };
    }
    const values = [
      org.subject_id, org.name, org.verified, org.verified_by, ev.version, ent.plan_code, ent.status, ent.starts_at, ent.ends_at, ent.grace_until,
      ent.reason, ev.activation?.sector ?? null, ev.activation?.accepted_by_subject ?? null, ev.activation?.accepted_at ?? null, ev.activation?.terms_version ?? null,
    ];
    if (existing) {
      await c.query(
        `UPDATE ecosystem_orgs SET name=$2, verified=$3, verified_by=$4, last_version=$5, plan_code=$6, status=$7, starts_at=$8, ends_at=$9, grace_until=$10,
                reason=$11, sector=COALESCE($12, sector), accepted_by_sub=COALESCE($13, accepted_by_sub), accepted_at=COALESCE($14, accepted_at),
                terms_version=COALESCE($15, terms_version), applied_note=NULL, updated_at=now() WHERE org_sub=$1`, values);
    } else {
      await c.query(
        `INSERT INTO ecosystem_orgs(org_sub, name, verified, verified_by, last_version, plan_code, status, starts_at, ends_at, grace_until, reason, sector, accepted_by_sub, accepted_at, terms_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, values);
    }
    let result: ApplyResult = { outcome: "stored" };
    const tenantId: string | null = existing?.tenant_id ?? null;
    if (tenantId) {
      result = await applyGrantToTenant(c, tenantId, { plan_code: ent.plan_code, status: ent.status, grace_until: ent.grace_until }, `ecosystem:${ev.id}`, now);
      if (result.note) await c.query(`UPDATE ecosystem_orgs SET applied_note=$2 WHERE org_sub=$1`, [org.subject_id, result.note]);
    }
    await c.query(`UPDATE ecosystem_inbox SET outcome=$2 WHERE event_id=$1`, [ev.id, result.outcome]);
    return result;
  });
}

/**
 * Fail-safe if loadbyton.com is unreachable at a boundary: Enterprise Included
 * never outlives its own end date or grace window. The authoritative event
 * from loadbyton.com still wins when it arrives (it carries a higher version).
 */
export async function expireLapsedGrants(db: Db, now = new Date()) {
  return db.system(async (c) => {
    const rows = (await c.query<any>(
      `SELECT * FROM ecosystem_orgs WHERE tenant_id IS NOT NULL AND plan_code='enterprise_included'
         AND ((status='active' AND ends_at IS NOT NULL AND ends_at <= $1) OR (status='grace' AND grace_until IS NOT NULL AND grace_until <= $1))`, [now])).rows;
    for (const o of rows) {
      await applyGrantToTenant(c, o.tenant_id, { plan_code: "starter_included", status: "active", grace_until: null }, `ecosystem:expiry:${o.org_sub}:${o.last_version}`, now);
      await c.query(`UPDATE ecosystem_orgs SET applied_note='Enterprise Included lapsed locally; waiting for loadbyton.com confirmation', updated_at=now() WHERE org_sub=$1`, [o.org_sub]);
    }
    return rows.length;
  });
}

/** Reads loadbyton.com's current grants (signed request) and applies any this service has not seen. Repairs missed webhooks. */
export async function reconcileFromCom(db: Db, fetchImpl: typeof fetch = fetch, now = new Date()) {
  const { comBaseUrl, sharedSecret } = config.ecosystem;
  if (!comBaseUrl || !sharedSecret) return { skipped: true, applied: 0 };
  const path = "/api/ecosystem/grants";
  const res = await fetchImpl(`${comBaseUrl}${path}`, { headers: { "LBT-Signature": signEcosystem(sharedSecret, `GET ${path}`, now.getTime()) }, redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`loadbyton.com answered ${res.status}`);
  const body = (await res.json()) as { grants?: unknown[] };
  let applied = 0;
  for (const g of body.grants ?? []) {
    const parsed = GrantEvent.safeParse(g);
    if (!parsed.success) continue;
    const r = await applyGrantEvent(db, parsed.data, now);
    if (r.outcome !== "duplicate" && r.outcome !== "stale") applied += 1;
  }
  return { skipped: false, applied };
}

// ───────────── sign in with Loadbyton ─────────────

import { hashPassword, randomToken as token } from "../lib/util.js";
import { reserveSlug, standardHostname } from "./tenants.js";
import { sectorBySlug } from "./catalog.js";
import { newSession } from "./auth.js";
import type { LoadbytonClaims } from "./oidc-client.js";

export type SignInResult =
  | { kind: "session"; token: string; tenantId: string }
  | { kind: "needs_link" }
  | { kind: "message"; message: string };

const NOT_ACTIVATED = "Business OS is not activated for this company yet. Activate it from your benefits page on loadbyton.com, then sign in again.";
const NOT_INVITED = "Your company already has a Business OS workspace. Ask your company administrator to invite you.";

/** Creates the workspace for a company on its first sign-in. Serialised on the ecosystem_orgs row so two concurrent logins create one workspace. */
async function ensureWorkspace(c: Conn, org: any, user: { id: string }, now: Date): Promise<string> {
  const locked = (await c.query<any>(`SELECT * FROM ecosystem_orgs WHERE org_sub=$1 FOR UPDATE`, [org.org_sub])).rows[0];
  if (locked.tenant_id) return locked.tenant_id;
  const slug = await reserveSlug(c, locked.name);
  const t = (await c.query<{ id: string }>(
    `INSERT INTO tenants(slug, name, country, goal, external_org_sub) VALUES ($1,$2,'AE',$3,$4) RETURNING id`,
    [slug, locked.name, "Business OS through loadbyton.com", locked.org_sub])).rows[0].id;
  await c.query(`INSERT INTO entities(tenant_id, name) VALUES ($1,$2)`, [t, locked.name]);
  await c.query(`INSERT INTO memberships(tenant_id, user_id, roles) VALUES ($1,$2,$3)`, [t, user.id, ["owner"]]);
  await c.query(
    `INSERT INTO domain_mappings(tenant_id, hostname, kind, status, verify_token, verified_at) VALUES ($1,$2,'standard','verified',$3,now())`,
    [t, standardHostname(slug), token(12)]);
  if (locked.sector && sectorBySlug(locked.sector)) await c.query(`INSERT INTO tenant_sectors(tenant_id, sector) VALUES ($1,$2)`, [t, locked.sector]);
  await c.query(`UPDATE ecosystem_orgs SET tenant_id=$2, updated_at=now() WHERE org_sub=$1`, [locked.org_sub, t]);
  const r = await applyGrantToTenant(c, t, { plan_code: locked.plan_code, status: locked.status, grace_until: locked.grace_until }, `ecosystem:workspace:${locked.org_sub}`, now);
  await audit(c, t, { kind: "user", userId: user.id }, "ecosystem.workspace_created", "tenant", t, { org_sub: locked.org_sub, sector: locked.sector, plan: locked.plan_code, applied: r.outcome });
  return t;
}

export async function signInWithLoadbyton(db: Db, claims: LoadbytonClaims, opts: { reconcile?: () => Promise<unknown>; now?: Date } = {}): Promise<SignInResult> {
  const now = opts.now ?? new Date();
  const userId = await db.system(async (c) => {
    const link = (await c.query<any>(`SELECT user_id FROM identity_links WHERE subject_id=$1`, [claims.sub])).rows[0];
    if (link) return link.user_id as string;
    // Never join accounts by email string alone: an existing account must prove control first.
    const same = (await c.query<any>(`SELECT id FROM users WHERE email=$1`, [claims.email])).rows[0];
    if (same) return null;
    const created = (await c.query<{ id: string }>(
      `INSERT INTO users(email, name, password_hash, email_verified_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [claims.email, claims.name, await hashPassword(token(32)), claims.email_verified ? now : null])).rows[0];
    await c.query(`INSERT INTO identity_links(subject_id, user_id, org_sub) VALUES ($1,$2,$3)`, [claims.sub, created.id, claims.org_sub]);
    await audit(c, null, { kind: "user", userId: created.id }, "ecosystem.account_created", "user", created.id, { org_sub: claims.org_sub });
    return created.id;
  });
  if (!userId) return { kind: "needs_link" };
  return finishSignIn(db, userId, claims, opts.reconcile, now);
}

export async function finishSignIn(db: Db, userId: string, claims: LoadbytonClaims, reconcile?: () => Promise<unknown>, now = new Date()): Promise<SignInResult> {
  const staff = await db.query<any>(`SELECT 1 FROM platform_staff WHERE user_id=$1 AND active`, [userId]);
  if (staff.rows.length) return { kind: "message", message: "Platform staff sign in with their password and authenticator code." };
  let org = (await db.query<any>(`SELECT * FROM ecosystem_orgs WHERE org_sub=$1`, [claims.org_sub])).rows[0];
  if (!org && reconcile) { try { await reconcile(); } catch { /* the event may simply not have arrived; the message below says what to do */ } org = (await db.query<any>(`SELECT * FROM ecosystem_orgs WHERE org_sub=$1`, [claims.org_sub])).rows[0]; }
  const live = org && org.plan_code && ["active", "grace"].includes(org.status) && org.verified;
  type Resolved = { tenantId: string; error?: undefined } | { error: string; tenantId?: undefined };
  const resolved: Resolved = await db.system<Resolved>(async (c) => {
    await c.query(`UPDATE identity_links SET org_sub=$2 WHERE user_id=$1`, [userId, claims.org_sub]);
    if (!org) return { error: NOT_ACTIVATED };
    if (org.tenant_id) {
      const member = (await c.query<any>(`SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active`, [org.tenant_id, userId])).rows.length > 0;
      if (member) return { tenantId: org.tenant_id as string };
      if (claims.org_role !== "owner" || !claims.org_verified) return { error: NOT_INVITED };
      await c.query(`INSERT INTO memberships(tenant_id, user_id, roles) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET active=true`, [org.tenant_id, userId, ["owner"]]);
      await audit(c, org.tenant_id, { kind: "user", userId }, "ecosystem.owner_joined", "tenant", org.tenant_id, { org_sub: claims.org_sub });
      return { tenantId: org.tenant_id as string };
    }
    if (!live) return { error: NOT_ACTIVATED };
    if (claims.org_role !== "owner") return { error: "Your company administrator needs to sign in first to create the Business OS workspace." };
    return { tenantId: await ensureWorkspace(c, org, { id: userId }, now) };
  });
  if (resolved.error !== undefined) return { kind: "message", message: resolved.error };
  const s = await newSession(db, userId, resolved.tenantId, false);
  return { kind: "session", token: s.token, tenantId: resolved.tenantId };
}

/** Links an existing local account after the person proved control of it with its password. */
export async function linkExistingAccount(db: Db, userId: string, claims: LoadbytonClaims) {
  await db.system(async (c) => {
    await c.query(`INSERT INTO identity_links(subject_id, user_id, org_sub) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [claims.sub, userId, claims.org_sub]);
    await audit(c, null, { kind: "user", userId }, "ecosystem.account_linked", "user", userId, { org_sub: claims.org_sub });
  });
}
