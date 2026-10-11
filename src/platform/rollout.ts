import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { badRequest } from "../lib/util.js";
import { must, recordId, reqStr } from "../ops/common.js";
import type { Staff } from "./partners.js";

/**
 * Staged rollout: a flag is off, on for named cohorts of tenants, or on for everyone. Code asks `isReleased(db, key, tenantId)`;
 * an unknown flag is OFF, so a typo can never release a feature early.
 */
export async function isReleased(c: Conn, key: string, tenantId: string): Promise<boolean> {
  const f = (await c.query<any>(`SELECT audience FROM rollout_flags WHERE key=$1`, [key])).rows[0];
  if (!f || f.audience === "off") return false;
  if (f.audience === "all") return true;
  const hit = await c.query(`SELECT 1 FROM rollout_flag_cohorts fc JOIN rollout_cohort_tenants ct ON ct.cohort_id=fc.cohort_id WHERE fc.key=$1 AND ct.tenant_id=$2 LIMIT 1`, [key, tenantId]);
  return hit.rows.length > 0;
}

export async function createCohort(c: Conn, s: Staff, name: string, description?: string) {
  const id = (await c.query<any>(`INSERT INTO rollout_cohorts(name,description,created_by) VALUES ($1,$2,$3) RETURNING id`, [reqStr(name, "Cohort name", 80), description ? reqStr(description, "Description", 500) : null, s.userId]).catch((e: any) => {
    if (/rollout_cohorts_name_unique/.test(String(e.message))) throw badRequest("A cohort with that name exists.");
    throw e;
  })).rows[0].id;
  await audit(c, null, { kind: "platform_staff", userId: s.userId }, "rollout.cohort_created", "cohort", id);
  return id as string;
}
export async function addToCohort(c: Conn, s: Staff, cohortId: string, tenantId: string) {
  await must(c.query<any>(`SELECT id FROM rollout_cohorts WHERE id=$1`, [recordId(cohortId, "Cohort")]), "Cohort");
  await must(c.query<any>(`SELECT id FROM tenants WHERE id=$1`, [recordId(tenantId, "Tenant")]), "Tenant");
  await c.query(`INSERT INTO rollout_cohort_tenants(cohort_id,tenant_id,added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [cohortId, tenantId, s.userId]);
  await audit(c, tenantId, { kind: "platform_staff", userId: s.userId }, "rollout.cohort_member_added", "cohort", cohortId);
}
export async function removeFromCohort(c: Conn, s: Staff, cohortId: string, tenantId: string) {
  await c.query(`DELETE FROM rollout_cohort_tenants WHERE cohort_id=$1 AND tenant_id=$2`, [recordId(cohortId, "Cohort"), recordId(tenantId, "Tenant")]);
  await audit(c, tenantId, { kind: "platform_staff", userId: s.userId }, "rollout.cohort_member_removed", "cohort", cohortId);
}
export async function setFlag(c: Conn, s: Staff, key: string, audience: "off" | "cohorts" | "all", cohortIds: string[], note?: string) {
  if (!["off", "cohorts", "all"].includes(audience)) throw badRequest("Choose off, cohorts or all.");
  if (audience === "cohorts" && !cohortIds.length) throw badRequest("Pick at least one cohort, or release to everyone.");
  await c.query(
    `INSERT INTO rollout_flags(key,audience,note,updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (key) DO UPDATE SET audience=$2, note=$3, updated_by=$4, updated_at=now()`, [key, audience, note ?? null, s.userId]).catch((e: any) => {
    if (/rollout_flags_key_check/.test(String(e.message))) throw badRequest("Flag keys are lower-case letters, digits, dots, dashes and underscores (3–61 characters).");
    throw e;
  });
  await c.query(`DELETE FROM rollout_flag_cohorts WHERE key=$1`, [key]);
  if (audience === "cohorts") for (const id of cohortIds) await c.query(`INSERT INTO rollout_flag_cohorts(key,cohort_id) VALUES ($1,$2)`, [key, recordId(id, "Cohort")]);
  await audit(c, null, { kind: "platform_staff", userId: s.userId }, "rollout.flag_set", "flag", undefined, { key, audience, cohortIds });
}
export async function rolloutOverview(c: Conn) {
  const cohorts = (await c.query<any>(`SELECT c.*, (SELECT count(*) FROM rollout_cohort_tenants t WHERE t.cohort_id=c.id)::int AS members FROM rollout_cohorts c ORDER BY lower(c.name)`)).rows;
  const flags = (await c.query<any>(`SELECT f.*, coalesce((SELECT array_agg(c.name ORDER BY c.name) FROM rollout_flag_cohorts fc JOIN rollout_cohorts c ON c.id=fc.cohort_id WHERE fc.key=f.key),'{}') AS cohorts FROM rollout_flags f ORDER BY f.key`)).rows;
  return { cohorts, flags };
}
