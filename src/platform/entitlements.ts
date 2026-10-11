import type { Conn } from "../db/client.js";
import { quotaExceeded, HttpError } from "../lib/util.js";
import type { PlanVersion } from "./catalog.js";

export type LimitKey = "max_users" | "max_branches" | "jobs_per_month" | "trips_per_month" | "fulfilment_orders_per_month" | "wh_orders_per_month" | "delivery_parcels_per_month" | "customs_cases_per_month" | "specialist_cases_per_month" | "ai_drafts_per_month" | "messages_per_month" | "storage_mb" | "max_sectors" | "max_entities";
const KEYS: LimitKey[] = ["max_users", "max_branches", "jobs_per_month", "trips_per_month", "fulfilment_orders_per_month", "wh_orders_per_month", "delivery_parcels_per_month", "customs_cases_per_month", "specialist_cases_per_month", "ai_drafts_per_month", "messages_per_month", "storage_mb", "max_sectors", "max_entities"];

/** Append entitlement rows for a plan version. Idempotent per (tenant, plan version, source). */
export async function applyPlanEntitlements(c: Conn, tenantId: string, plan: PlanVersion, source: string) {
  const have = await c.query(`SELECT 1 FROM entitlements WHERE tenant_id=$1 AND plan_version_id=$2 AND source=$3 LIMIT 1`, [tenantId, plan.id, source]);
  if (have.rows.length) return;
  for (const k of KEYS) {
    if (plan.limits[k] == null) continue;   // key not part of this (older) plan version
    await c.query(
      `INSERT INTO entitlements(tenant_id,key,int_limit,plan_version_id,source) VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, k, plan.limits[k], plan.id, source],
    );
  }
}

export async function getLimit(c: Conn, tenantId: string, key: LimitKey): Promise<number> {
  const r = await c.query<{ int_limit: number }>(
    `SELECT int_limit FROM entitlements WHERE tenant_id=$1 AND key=$2 AND effective_from <= now()
     ORDER BY effective_from DESC, id DESC LIMIT 1`, [tenantId, key]);
  if (r.rows[0]) return Number(r.rows[0].int_limit);
  // legacy plan versions predate the trip / fulfilment-order units: they get the same number as jobs
  return key === "trips_per_month" || key === "fulfilment_orders_per_month" || key === "wh_orders_per_month" || key === "delivery_parcels_per_month" || key === "customs_cases_per_month" ? getLimit(c, tenantId, "jobs_per_month") : 0;
}

export async function getLimits(c: Conn, tenantId: string): Promise<Record<LimitKey, number>> {
  const out = {} as Record<LimitKey, number>;
  for (const k of KEYS) out[k] = await getLimit(c, tenantId, k);
  return out;
}

export async function subscriptionStatus(c: Conn, tenantId: string) {
  const r = await c.query<{ status: string }>(`SELECT status FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
  return r.rows[0]?.status ?? "cancelled";
}

/** Restricted/cancelled subscriptions keep read + export access but cannot create new billable records. */
export async function assertWritable(c: Conn, tenantId: string) {
  const s = await subscriptionStatus(c, tenantId);
  if (s === "restricted" || s === "cancelled") {
    throw new HttpError(402, "This workspace is read-only until the subscription is restored. You can still read and export all data.", "restricted");
  }
}

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * Transactional quota consumption: the guarded upsert makes concurrent requests unable to exceed the limit,
 * and usage_events(tenant,key,ref) makes a retried request idempotent (one immutable usage event per ref).
 */
export async function consumeQuota(c: Conn, tenantId: string, key: Extract<LimitKey, "jobs_per_month" | "trips_per_month" | "fulfilment_orders_per_month" | "wh_orders_per_month" | "delivery_parcels_per_month" | "customs_cases_per_month" | "specialist_cases_per_month" | "messages_per_month" | "ai_drafts_per_month">, ref: string, qty = 1) {
  if(!Number.isSafeInteger(qty)||qty<=0)throw new HttpError(400,'Quota usage must be a positive integer');
  await assertWritable(c, tenantId);
  const limit = await getLimit(c, tenantId, key);
  const ev = await c.query(
    `INSERT INTO usage_events(tenant_id,key,qty,ref) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
    [tenantId, key, qty, ref]);
  if (!ev.rows.length) return { duplicate: true };
  if (qty > limit) throw quotaExceeded(key, limit);
  const r = await c.query(
    `INSERT INTO usage_counters(tenant_id,key,period,used) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id,key,period) DO UPDATE SET used = usage_counters.used + $4
       WHERE usage_counters.used + $4 <= $5
     RETURNING used`,
    [tenantId, key, monthKey(), qty, limit]);
  if (!r.rows.length) throw quotaExceeded(key, limit);
  return { duplicate: false, used: Number(r.rows[0].used) };
}

export async function usedThisMonth(c: Conn, tenantId: string, key: LimitKey) {
  const r = await c.query<{ used: number }>(`SELECT used FROM usage_counters WHERE tenant_id=$1 AND key=$2 AND period=$3`, [tenantId, key, monthKey()]);
  return r.rows[0] ? Number(r.rows[0].used) : 0;
}

/** Count-based capacities (users, branches, sectors, storage) are checked against live state. */
export async function assertCapacity(c: Conn, tenantId: string, key: Exclude<LimitKey, "jobs_per_month" | "trips_per_month" | "fulfilment_orders_per_month" | "wh_orders_per_month" | "delivery_parcels_per_month" | "customs_cases_per_month" | "specialist_cases_per_month" | "messages_per_month" | "ai_drafts_per_month">, adding = 1) {
  await assertWritable(c, tenantId);
  const limit = await getLimit(c, tenantId, key);
  const used = await currentUsage(c, tenantId, key);
  if (used + adding > limit) throw quotaExceeded(key, limit);
}

export async function currentUsage(c: Conn, tenantId: string, key: LimitKey): Promise<number> {
  const q: Record<string, string> = {
    max_users: `SELECT count(*) n FROM memberships WHERE tenant_id=$1 AND active AND NOT ('portal' = ANY(roles)) AND NOT ('driver' = ANY(roles))`,
    max_branches: `SELECT count(*) n FROM branches WHERE tenant_id=$1`,
    max_sectors: `SELECT count(*) n FROM tenant_sectors WHERE tenant_id=$1`,
    max_entities: `SELECT count(*) n FROM entities WHERE tenant_id=$1`,
    storage_mb: `SELECT ((SELECT coalesce(sum(size_bytes),0) FROM documents WHERE tenant_id=$1)+(SELECT coalesce(sum(size_bytes),0) FROM generated_documents WHERE tenant_id=$1))/1048576.0 n`,
  };
  if (key === "ai_drafts_per_month" || key === "messages_per_month" || key === "specialist_cases_per_month" || key === "jobs_per_month" || key === "trips_per_month" || key === "fulfilment_orders_per_month" || key === "wh_orders_per_month" || key === "delivery_parcels_per_month" || key === "customs_cases_per_month") return usedThisMonth(c, tenantId, key);
  const r = await c.query<{ n: string | number }>(q[key], [tenantId]);
  return Math.ceil(Number(r.rows[0].n));
}

/** Preview consequences of moving to a plan: which limits would be exceeded by current data. */
export async function previewPlanChange(c: Conn, tenantId: string, target: PlanVersion) {
  const issues: string[] = [];
  for (const k of KEYS) {
    const used = await currentUsage(c, tenantId, k);
    if (target.limits[k] != null && used > target.limits[k]) issues.push(`${k.replace(/_/g, " ")}: using ${used}, ${target.name} allows ${target.limits[k]}`);
  }
  return {
    issues,
    note: issues.length
      ? "Existing records stay readable and exportable. New records of the affected type are blocked until usage is within the plan."
      : "Current usage fits this plan.",
  };
}
