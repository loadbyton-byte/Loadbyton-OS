import type { Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { applyPlanEntitlements } from "./entitlements.js";
import { standardHostname } from "./tenants.js";
import { randomToken } from "../lib/util.js";
import type { PlanVersion } from "./catalog.js";

/**
 * Infrastructure adapters. The defaults are SIMULATED (wildcard routing + TLS assumed): production must
 * replace them with real DNS/proxy/certificate integrations before the 24-hour activation target is advertised.
 */
export interface ProvisionAdapters {
  attachRouting(hostname: string): Promise<void>;
  verifyTls(hostname: string): Promise<void>;
}
export const simulatedAdapters: ProvisionAdapters = {
  async attachRouting() {},
  async verifyTls() {},
};

export const STEPS = [
  "reserve_slug", "apply_entitlement_version", "load_configuration", "attach_routing", "verify_tls",
  "validate_owner_access", "health_isolation_checks", "send_readiness_notice", "create_onboarding_work",
] as const;
type Step = (typeof STEPS)[number];
const STATE_AFTER: Partial<Record<Step, string>> = {
  verify_tls: "validation", send_readiness_notice: "ready", create_onboarding_work: "onboarding",
};
const MAX_ATTEMPTS = 5;

/** Promote an information_pending job once the owner supplied the minimum setup information. */
export async function releaseInformationPending(db: Db, tenantId: string) {
  await db.system(async (c) => {
    const ent = (await c.query<any>(`SELECT legal_name FROM entities WHERE tenant_id=$1 ORDER BY created_at LIMIT 1`, [tenantId])).rows[0];
    if (!ent?.legal_name) return;
    await c.query(
      `UPDATE provision_jobs SET state='queued', owner_action=NULL, queued_at=now(), updated_at=now()
       WHERE tenant_id=$1 AND state='information_pending'`, [tenantId]);
  });
}

async function doStep(db: Db, adapters: ProvisionAdapters, job: any, step: Step) {
  const t = job.tenant_id as string;
  switch (step) {
    case "reserve_slug":
      await db.system(async (c) => {
        const tn = (await c.query<any>(`SELECT slug FROM tenants WHERE id=$1`, [t])).rows[0];
        await c.query(
          `INSERT INTO domain_mappings(tenant_id,hostname,kind,status,verify_token,verified_at) VALUES ($1,$2,'standard','verified',$3,now())
           ON CONFLICT DO NOTHING`, [t, standardHostname(tn.slug), randomToken(12)]);
      });
      break;
    case "apply_entitlement_version":
      await db.system(async (c) => {
        const o = (await c.query<any>(`SELECT plan_version_id, id FROM orders WHERE id=$1`, [job.order_id])).rows[0];
        const plan = (await c.query<PlanVersion>(`SELECT * FROM plan_versions WHERE id=$1`, [o.plan_version_id])).rows[0];
        await applyPlanEntitlements(c, t, plan, `order:${o.id}`);
      });
      break;
    case "load_configuration":
      await db.system(async (c) => {
        for (const n of ["enquiry", "quote", "job", "invoice"]) {
          await c.query(`INSERT INTO counters(tenant_id,name,value) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [t, n]);
        }
      });
      break;
    case "attach_routing":
    case "verify_tls": {
      const host = await db.system(async (c) =>
        (await c.query<any>(`SELECT hostname FROM domain_mappings WHERE tenant_id=$1 AND kind='standard' AND status='verified' LIMIT 1`, [t])).rows[0]?.hostname);
      if (!host) throw new Error("no verified standard hostname");
      if (step === "attach_routing") await adapters.attachRouting(host); else await adapters.verifyTls(host);
      break;
    }
    case "validate_owner_access":
      await db.system(async (c) => {
        const r = await c.query(`SELECT 1 FROM memberships WHERE tenant_id=$1 AND active AND 'owner' = ANY(roles)`, [t]);
        if (!r.rows.length) throw new Error("tenant has no active owner");
      });
      break;
    case "health_isolation_checks":
      // proves the runtime role sees only this tenant
      await db.tenant(t, async (c) => {
        const foreign = await c.query(`SELECT count(*)::int n FROM tenants WHERE id <> $1`, [t]);
        if (foreign.rows[0].n !== 0) throw new Error("isolation check failed: foreign tenant rows visible");
        const own = await c.query(`SELECT count(*)::int n FROM entities`);
        if (own.rows[0].n < 1) throw new Error("tenant has no legal entity");
      });
      break;
    case "send_readiness_notice":
      await db.system(async (c) => {
        await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email',$2,$3) ON CONFLICT (key) DO NOTHING`,
          [t, `ready:${job.id}`, JSON.stringify({ template: "workspace_ready", jobId: job.id })]);
      });
      break;
    case "create_onboarding_work":
      await db.system(async (c) => {
        const have = await c.query(`SELECT 1 FROM job_exceptions WHERE tenant_id=$1 AND title='Complete onboarding checklist' AND job_id IS NULL`, [t]);
        if (!have.rows.length) {
          await c.query(
            `INSERT INTO job_exceptions(tenant_id,title,detail,due_at) VALUES ($1,'Complete onboarding checklist',
             'Import customers, add suppliers and rates, invite your team, run one real enquiry → invoice.', now() + interval '7 days')`, [t]);
        }
      });
      break;
  }
}

/** Run (or resume) one provisioning job. Completed steps are skipped; every step is idempotent. */
export async function runProvisioningJob(db: Db, jobId: string, adapters: ProvisionAdapters = simulatedAdapters) {
  const job = (await db.query<any>(`SELECT * FROM provision_jobs WHERE id=$1`, [jobId])).rows[0];
  if (!job || ["information_pending", "failed", "cancelled", "onboarding"].includes(job.state)) return job?.state;
  await db.system(async (c) => {
    await c.query(`UPDATE provision_jobs SET state=CASE WHEN state='queued' THEN 'provisioning' ELSE state END,
      started_at=coalesce(started_at,now()), attempts=attempts+1, updated_at=now() WHERE id=$1`, [jobId]);
  });
  try {
    for (const step of STEPS) {
      const key = `${jobId}:${step}`;
      const done = await db.query(`SELECT 1 FROM provision_steps WHERE idempotency_key=$1 AND status='done'`, [key]);
      if (done.rows.length) continue;
      await doStep(db, adapters, job, step);
      await db.system(async (c) => {
        await c.query(`INSERT INTO provision_steps(job_id,step,idempotency_key,status) VALUES ($1,$2,$3,'done') ON CONFLICT (idempotency_key) DO NOTHING`, [jobId, step, key]);
        const st = STATE_AFTER[step];
        if (st) {
          await c.query(`UPDATE provision_jobs SET state=$2, ready_at = CASE WHEN $2='ready' THEN now() ELSE ready_at END, updated_at=now() WHERE id=$1`, [jobId, st]);
        }
      });
    }
    await db.system((c) => audit(c, job.tenant_id, { kind: "system" }, "provisioning.completed", "provision_job", jobId));
    return "onboarding";
  } catch (e: any) {
    await db.system(async (c) => {
      const j = (await c.query<any>(`SELECT attempts FROM provision_jobs WHERE id=$1`, [jobId])).rows[0];
      const dead = j.attempts >= MAX_ATTEMPTS;
      await c.query(
        `UPDATE provision_jobs SET failure_reason=$2, state=CASE WHEN $3 THEN 'failed' ELSE state END,
           owner_action=CASE WHEN $3 THEN 'Activation is delayed. Our team has been alerted and will contact you.' ELSE owner_action END,
           updated_at=now() WHERE id=$1`, [jobId, String(e?.message ?? e), dead]);
      if (dead) {
        await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'staff.review',$2,$3) ON CONFLICT (key) DO NOTHING`,
          [job.tenant_id, `provision-failed:${jobId}`, JSON.stringify({ jobId, error: String(e?.message ?? e) })]);
      }
    });
    return "retry";
  }
}

export async function processProvisioningQueue(db: Db, adapters: ProvisionAdapters = simulatedAdapters) {
  const jobs = await db.query<{ id: string }>(
    `SELECT id FROM provision_jobs WHERE state IN ('queued','provisioning','validation','ready') ORDER BY queued_at LIMIT 20`);
  for (const j of jobs.rows) await runProvisioningJob(db, j.id, adapters);
  return jobs.rows.length;
}

export async function retryProvisioning(db: Db, jobId: string, staffId: string) {
  await db.system(async (c) => {
    await c.query(`UPDATE provision_jobs SET state='queued', attempts=0, failure_reason=NULL, owner_action=NULL, updated_at=now() WHERE id=$1 AND state='failed'`, [jobId]);
    await audit(c, null, { kind: "platform_staff", userId: staffId }, "provisioning.retry", "provision_job", jobId);
  });
}

/** p50/p95 queue-to-ready duration (minutes) and aged queue for the control console. */
export async function provisioningStats(db: Db) {
  const d = await db.query<any>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ready_at-queued_at)/60) p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM ready_at-queued_at)/60) p95, count(*) n
     FROM provision_jobs WHERE ready_at IS NOT NULL`);
  const aged = await db.query<any>(`SELECT count(*)::int n FROM provision_jobs WHERE state IN ('queued','provisioning','validation','ready') AND queued_at < now() - interval '4 hours'`);
  const failed = await db.query<any>(`SELECT count(*)::int n FROM provision_jobs WHERE state='failed'`);
  return { p50: d.rows[0].p50 == null ? null : Number(d.rows[0].p50), p95: d.rows[0].p95 == null ? null : Number(d.rows[0].p95),
    completed: Number(d.rows[0].n), aged: aged.rows[0].n, failed: failed.rows[0].n };
}
