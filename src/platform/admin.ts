import {config} from '../config.js';
import {verifyCloudflareCustomDomain} from '../adapters/cloudflare.js';
import type { Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { HttpError, badRequest, hashPassword, newTotpSecret, randomToken, sha256 } from "../lib/util.js";
import { currentPlans, type PlanSeed } from "./catalog.js";

export async function createStaff(db: Db, email: string, name: string, password: string, role: string) {
  return db.system(async (c) => {
    const e = email.toLowerCase();
    let u = (await c.query<any>(`SELECT id FROM users WHERE email=$1`, [e])).rows[0];
    if (!u) u = (await c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING id`, [e, name, await hashPassword(password)])).rows[0];
    const secret = newTotpSecret();
    await c.query(`INSERT INTO platform_staff(user_id,role,totp_secret) VALUES ($1,$2,$3)
      ON CONFLICT (user_id) DO UPDATE SET role=EXCLUDED.role, totp_secret=EXCLUDED.totp_secret, active=true`, [u.id, role, secret]);
    await audit(c, null, { kind: "system" }, "staff.created", "user", u.id, { role });
    return { userId: u.id, totpSecret: secret, otpauth: `otpauth://totp/LOADBYTON:${e}?secret=${secret}&issuer=LOADBYTON` };
  });
}

export async function overview(db: Db) {
  const n = async (sql: string) => Number((await db.query<any>(sql)).rows[0].n);
  return {
    tenants: await n(`SELECT count(*) n FROM tenants`),
    paid: await n(`SELECT count(*) n FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id WHERE p.monthly_minor>0 AND s.status='active'`),
    mrrMinor: await n(`SELECT coalesce(sum(p.monthly_minor),0) n FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id WHERE s.status='active'`),
    pendingOrders: await n(`SELECT count(*) n FROM orders WHERE status='pending'`),
    rejectedEvents: await n(`SELECT count(*) n FROM payment_events WHERE outcome='rejected'`),
    deadOutbox: await n(`SELECT count(*) n FROM outbox WHERE status='dead'`),
    staffReview: await n(`SELECT count(*) n FROM outbox WHERE topic='staff.review' AND status='pending'`),
    openLeads: await n(`SELECT count(*) n FROM platform_leads`),
  };
}

export const listTenants = (db: Db) => db.query<any>(
  `SELECT t.*, p.name AS plan, p.plan_code, s.status AS sub_status, s.period_end,
     (SELECT count(*) FROM memberships m WHERE m.tenant_id=t.id AND m.active)::int AS users,
     (SELECT count(*) FROM jobs j WHERE j.tenant_id=t.id)::int AS jobs,
     (SELECT count(*) FROM service_requests r WHERE r.tenant_id=t.id AND r.status IN ('received','in_build','ready'))::int AS open_requests
   FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id=t.id LEFT JOIN plan_versions p ON p.id=s.plan_version_id ORDER BY t.created_at DESC`).then((r) => r.rows);

export async function tenantDetail(db: Db, id: string) {
  const t = (await db.query<any>(`SELECT * FROM tenants WHERE id=$1`, [id])).rows[0];
  if (!t) throw new HttpError(404, "Tenant not found");
  const [sub, ents, usage, orders, jobs, audit_, grants, domains, reqs] = await Promise.all([
    db.query<any>(`SELECT s.*, p.name AS plan FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id WHERE tenant_id=$1`, [id]),
    db.query<any>(`SELECT DISTINCT ON (key) key,int_limit,source,effective_from FROM entitlements WHERE tenant_id=$1 AND effective_from<=now() ORDER BY key,effective_from DESC,id DESC`, [id]),
    db.query<any>(`SELECT key,period,used FROM usage_counters WHERE tenant_id=$1 ORDER BY period DESC`, [id]),
    db.query<any>(`SELECT * FROM orders WHERE tenant_id=$1 ORDER BY created_at DESC`, [id]),
    db.query<any>(`SELECT * FROM provision_jobs WHERE tenant_id=$1 ORDER BY queued_at DESC`, [id]),
    db.query<any>(`SELECT * FROM audit_log WHERE tenant_id=$1 ORDER BY id DESC LIMIT 50`, [id]),
    db.query<any>(`SELECT g.*, u.name AS staff FROM support_grants g JOIN users u ON u.id=g.staff_user_id WHERE tenant_id=$1 ORDER BY requested_at DESC`, [id]),
    db.query<any>(`SELECT * FROM domain_mappings WHERE tenant_id=$1 ORDER BY created_at`, [id]),
    db.query<any>(`SELECT id,category,sectors,title,status,quote_note,due_at,delivered_at,created_at FROM service_requests WHERE tenant_id=$1 ORDER BY created_at DESC`, [id]),
  ]);
  return { tenant: t, sub: sub.rows[0], entitlements: ents.rows, usage: usage.rows, orders: orders.rows, provisioning: jobs.rows, audit: audit_.rows, grants: grants.rows, domains: domains.rows, requests: reqs.rows };
}

export const listOrders = (db: Db) => db.query<any>(
  `SELECT o.*, t.name AS tenant_name, t.slug,
    (SELECT json_agg(json_build_object('event_id',e.event_id,'type',e.type,'outcome',e.outcome,'at',e.received_at) ORDER BY e.received_at) FROM payment_events e WHERE e.order_id=o.id) AS events
   FROM orders o JOIN tenants t ON t.id=o.tenant_id ORDER BY o.created_at DESC LIMIT 200`).then((r) => r.rows);

export const listRejectedEvents = (db: Db) => db.query<any>(`SELECT * FROM payment_events WHERE outcome IN ('rejected','ignored') ORDER BY received_at DESC LIMIT 100`).then((r) => r.rows);
export const listProvisioning = (db: Db) => db.query<any>(
  `SELECT j.*, t.name AS tenant_name, o.reference,
     (SELECT count(*) FROM provision_steps s WHERE s.job_id=j.id)::int AS steps_done
   FROM provision_jobs j JOIN tenants t ON t.id=j.tenant_id JOIN orders o ON o.id=j.order_id ORDER BY j.queued_at DESC LIMIT 200`).then((r) => r.rows);
export const listStaffReview = (db: Db) => db.query<any>(`SELECT * FROM outbox WHERE topic='staff.review' AND status='pending' ORDER BY created_at`).then((r) => r.rows);
export const listDeadOutbox = (db: Db) => db.query<any>(`SELECT * FROM outbox WHERE status='dead' ORDER BY created_at DESC LIMIT 100`).then((r) => r.rows);

export async function acknowledgeReview(db: Db, id: string, staffId: string) {
  await db.system(async (c) => {
    await c.query(`UPDATE outbox SET status='sent' WHERE id=$1 AND topic='staff.review'`, [id]);
    await audit(c, null, { kind: "platform_staff", userId: staffId }, "staff.review_acknowledged", "outbox", id);
  });
}

/** Publish a new immutable version of a plan (existing subscriptions keep the version they bought). */
export async function publishPlanVersion(db: Db, staffId: string, planCode: string, f: { monthly: number; setup: number; limits?: Partial<PlanSeed["limits"]> }) {
  return db.system(async (c) => {
    const cur = (await currentPlans(c)).find((p) => p.plan_code === planCode);
    if (!cur) throw badRequest("Unknown plan");
    if (!(f.monthly >= 0) || !(f.setup >= 0)) throw badRequest("Prices must be zero or more.");
    const limits = { ...cur.limits, ...(f.limits ?? {}) };
    await c.query(
      `INSERT INTO plan_versions(plan_code,version,name,monthly_minor,setup_minor,limits,contact_sales) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [planCode, cur.version + 1, cur.name, Math.round(f.monthly), Math.round(f.setup), JSON.stringify(limits), cur.contact_sales]);
    await audit(c, null, { kind: "platform_staff", userId: staffId }, "catalog.plan_published", "plan", planCode, { version: cur.version + 1, ...f });
    return cur.version + 1;
  });
}

// ── support grants: staff request, tenant owner approves, time-limited, audited
export async function requestGrant(db: Db, staffId: string, tenantId: string, reason: string) {
  if (reason.trim().length < 10) throw badRequest("Give a reason (min 10 characters).");
  await db.system(async (c) => {
    await c.query(`INSERT INTO support_grants(tenant_id,staff_user_id,reason,status) VALUES ($1,$2,$3,'requested')`, [tenantId, staffId, reason.trim()]);
    await audit(c, tenantId, { kind: "platform_staff", userId: staffId }, "support.grant_requested", "tenant", tenantId, { reason });
  });
}
export async function decideGrant(db: Db, tenantId: string, ownerId: string, grantId: string, approve: boolean, hours = 4) {
  await db.system(async (c) => {
    const r = await c.query(
      `UPDATE support_grants SET status=$3, decided_by=$4, decided_at=now(), expires_at = CASE WHEN $3='approved' THEN now() + ($5 || ' hours')::interval END
       WHERE id=$1 AND tenant_id=$2 AND status='requested' RETURNING id`,
      [grantId, tenantId, approve ? "approved" : "denied", ownerId, String(Math.min(Math.max(hours, 1), 24))]);
    if (!r.rows.length) throw new HttpError(404, "Grant not found");
    await audit(c, tenantId, { kind: "user", userId: ownerId }, approve ? "support.grant_approved" : "support.grant_denied", "support_grant", grantId);
  });
}
export async function startSupportView(db: Db, token: string, staffId: string, tenantId: string) {
  const g = (await db.query<any>(`SELECT id FROM support_grants WHERE tenant_id=$1 AND staff_user_id=$2 AND status='approved' AND expires_at>now()`, [tenantId, staffId])).rows[0];
  if (!g) throw new HttpError(403, "No approved, unexpired customer grant for this workspace.", "forbidden");
  await db.query(`UPDATE sessions SET support_tenant_id=$2 WHERE token_hash=$1`, [sha256(token), tenantId]);
  await db.system((c) => audit(c, tenantId, { kind: "support_grant", userId: staffId }, "support.view_started", "support_grant", g.id));
}

// ── domains: ownership must be verified; a hostname maps to exactly one tenant
export async function requestCustomDomain(db: Db, tenantId: string, userId: string, hostname: string) {
  const h = hostname.trim().toLowerCase();
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h)) throw badRequest("Enter a valid hostname.");
  return db.system(async (c) => {
    const taken = await c.query(`SELECT tenant_id FROM domain_mappings WHERE hostname=$1 AND status<>'removed'`, [h]);
    if (taken.rows.length) throw new HttpError(409, "That hostname is already mapped.", "conflict");
    const token = `lbt-verify-${randomToken(12)}`;
    await c.query(`INSERT INTO domain_mappings(tenant_id,hostname,kind,status,verify_token) VALUES ($1,$2,'custom','pending_verification',$3)`, [tenantId, h, token]);
    await audit(c, tenantId, { kind: "user", userId }, "domain.requested", "domain", h);
    return token;
  });
}
export type DnsLookup = (hostname: string) => Promise<string[]>;
/** Verification = the owner publishes the token as a TXT record at _loadbyton.<hostname>. */
export async function verifyCustomDomain(db: Db, tenantId: string, id: string, lookup: DnsLookup) {
  const d = (await db.query<any>(`SELECT * FROM domain_mappings WHERE id=$1 AND tenant_id=$2 AND status='pending_verification'`, [id, tenantId])).rows[0];
  if (!d) throw new HttpError(404, "Pending domain not found");
  const txt = await lookup(`_loadbyton.${d.hostname}`);
  if (!txt.includes(d.verify_token)) throw badRequest("Verification record not found yet. DNS changes can take time.");
  if(config.isProd)await verifyCloudflareCustomDomain(d.hostname);
  await db.system(async c=>{
    const updated=await c.query(`UPDATE domain_mappings SET status='verified', verified_at=now() WHERE id=$1 AND tenant_id=$2 AND status='pending_verification' AND verify_token=$3 RETURNING id`,[id,tenantId,d.verify_token]);
    if(!updated.rows.length)throw badRequest('Domain verification changed; retry ownership verification');
    await audit(c,tenantId,{kind:'system'},'domain.verified','domain',id);
  });
}
export async function removeDomain(db: Db, tenantId: string, userId: string, id: string) {
  await db.system(async (c) => {
    await c.query(`UPDATE domain_mappings SET status='removed' WHERE id=$1 AND tenant_id=$2 AND kind='custom'`, [id, tenantId]);
    await audit(c, tenantId, { kind: "user", userId }, "domain.removed", "domain", id);
  });
}
/** Hostname → tenant slug hint. Only verified, live mappings resolve; access still requires membership. */
export async function tenantForHost(db: Db, host: string): Promise<string | null> {
  const r = await db.query<any>(`SELECT t.slug FROM domain_mappings d JOIN tenants t ON t.id=d.tenant_id WHERE d.hostname=$1 AND d.status='verified'`, [host.toLowerCase()]);
  return r.rows[0]?.slug ?? null;
}
