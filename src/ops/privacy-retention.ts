import type { Conn, Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, forbidden } from "../lib/util.js";
import { must, recordId, reqStr } from "./common.js";

/** Subjects whose personal data can be minimised by schedule. Financial documents, stock ledgers and audit records are never touched. */
export const RETENTION_SUBJECTS = {
  fulfil_recipient: "Fulfilment recipient name, phone and address on shipped or cancelled orders",
  delivery_consignee: "Delivery consignee name, phone, address and received-by on completed parcels",
  driver_positions: "Driver GPS positions recorded during trips (deleted, not anonymised)",
} as const;
export type RetentionSubject = keyof typeof RETENTION_SUBJECTS;

const HOLD = (party: string) => `NOT EXISTS (SELECT 1 FROM privacy_legal_holds h WHERE h.released_at IS NULL AND (h.party_id IS NULL OR h.party_id=${party}))`;
const SQL = {
  fulfil_recipient: {
    count: `SELECT count(*)::int n FROM fulfil_orders o WHERE o.anonymised_at IS NULL AND o.status IN ('shipped','cancelled') AND coalesce(o.shipped_at,o.cancelled_at) < now() - make_interval(days => $1)
      AND NOT EXISTS (SELECT 1 FROM fulfil_returns r WHERE r.order_id=o.id AND r.status IN ('expected','received')) AND ${HOLD("o.party_id")}`,
    run: `UPDATE fulfil_orders SET ship_to_name='Anonymised', ship_to_phone=NULL, ship_to_address='Anonymised', ship_to_city=NULL, anonymised_at=now()
      WHERE id IN (SELECT o.id FROM fulfil_orders o WHERE o.anonymised_at IS NULL AND o.status IN ('shipped','cancelled') AND coalesce(o.shipped_at,o.cancelled_at) < now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM fulfil_returns r WHERE r.order_id=o.id AND r.status IN ('expected','received')) AND ${HOLD("o.party_id")} ORDER BY o.created_at, o.id LIMIT $2) RETURNING 1`,
  },
  delivery_consignee: {
    count: `SELECT count(*)::int n FROM dlv_shipments s WHERE s.anonymised_at IS NULL AND s.status IN ('delivered','return_to_sender','returned','cancelled') AND coalesce(s.delivered_at,s.returned_at,s.created_at) < now() - make_interval(days => $1)
      AND NOT EXISTS (SELECT 1 FROM dlv_collections k WHERE k.shipment_id=s.id AND k.remittance_id IS NULL) AND ${HOLD("s.merchant_id")}`,
    run: `UPDATE dlv_shipments SET consignee_name='Anonymised', consignee_phone=NULL, address='Anonymised', delivered_to=NULL, anonymised_at=now()
      WHERE id IN (SELECT s.id FROM dlv_shipments s WHERE s.anonymised_at IS NULL AND s.status IN ('delivered','return_to_sender','returned','cancelled') AND coalesce(s.delivered_at,s.returned_at,s.created_at) < now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM dlv_collections k WHERE k.shipment_id=s.id AND k.remittance_id IS NULL) AND ${HOLD("s.merchant_id")} ORDER BY s.created_at, s.id LIMIT $2) RETURNING 1`,
  },
} as Record<RetentionSubject, { count: string; run: string }>;

SQL.driver_positions = {
  count: `SELECT count(*)::int n FROM trip_positions p WHERE p.effective_time < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM privacy_legal_holds h WHERE h.released_at IS NULL AND h.party_id IS NULL)`,
  run: `DELETE FROM trip_positions WHERE id IN (SELECT p.id FROM trip_positions p WHERE p.effective_time < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM privacy_legal_holds h WHERE h.released_at IS NULL AND h.party_id IS NULL) ORDER BY p.effective_time, p.id LIMIT $2) RETURNING 1`,
};

const owner = (ctx: Ctx) => { require(ctx, "settings.manage"); if (!ctx.roles.includes("owner")) throw forbidden("Retention and legal-hold decisions are made by the workspace owner."); };

export async function setRetentionPolicy(c: Conn, ctx: Ctx, f: Record<string, any>) {
  owner(ctx);
  const subject = String(f.subject) as RetentionSubject;
  if (!(subject in RETENTION_SUBJECTS)) throw badRequest("Choose what to minimise.");
  const days = Number(f.retain_days);
  if (!Number.isInteger(days) || days < 30 || days > 3650) throw badRequest("Retention is 30 to 3650 days after the record is completed.");
  const why = reqStr(f.reason, "Basis for this retention period (contract, regulation or policy reference)", 1000);
  const r = await c.query<{ id: string }>(
    `INSERT INTO privacy_retention_policies(tenant_id,subject,retain_days,reason,approved_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id,subject) DO UPDATE SET retain_days=$3, reason=$4, approved_by=$5, status='active', updated_at=now() RETURNING id`, [ctx.tenantId, subject, days, why, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "privacy.retention_set", "retention_policy", r.rows[0].id, { subject, days });
  return r.rows[0].id;
}
export async function setRetentionStatus(c: Conn, ctx: Ctx, id: string, active: boolean) {
  owner(ctx);
  await must(c.query(`UPDATE privacy_retention_policies SET status=$2, updated_at=now() WHERE id=$1 RETURNING id`, [recordId(id), active ? "active" : "paused"]), "Policy");
  await audit(c, ctx.tenantId, actorOf(ctx), active ? "privacy.retention_resumed" : "privacy.retention_paused", "retention_policy", id);
}

export async function placeLegalHold(c: Conn, ctx: Ctx, f: Record<string, any>) {
  owner(ctx);
  const party = f.party_id ? (await must(c.query<any>(`SELECT id FROM parties WHERE id=$1`, [f.party_id]), "Party")).id as string : null;
  const why = reqStr(f.reason, "Reason and matter reference for the hold", 1000);
  const id = (await c.query<{ id: string }>(`INSERT INTO privacy_legal_holds(tenant_id,party_id,reason,placed_by) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.tenantId, party, why, ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "privacy.hold_placed", "legal_hold", id, { scope: party ? "party" : "workspace" });
  return id;
}
export async function releaseLegalHold(c: Conn, ctx: Ctx, id: string, reason: string) {
  owner(ctx);
  const h = await must(c.query<any>(`SELECT * FROM privacy_legal_holds WHERE id=$1 FOR UPDATE`, [recordId(id)]), "Hold");
  if (h.released_at) throw badRequest("This hold is already released.");
  await c.query(`UPDATE privacy_legal_holds SET released_by=$2, released_at=now(), release_reason=$3 WHERE id=$1`, [id, ctx.userId, reqStr(reason, "Release reason", 1000)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "privacy.hold_released", "legal_hold", id);
}

/** Owner preview: how many records each active policy would minimise on its next run. */
export async function retentionWorkspace(c: Conn, ctx: Ctx) {
  require(ctx, "settings.manage");
  const policies = (await c.query<any>(`SELECT * FROM privacy_retention_policies ORDER BY subject`)).rows;
  for (const p of policies) p.eligible = (await c.query<any>(SQL[p.subject as RetentionSubject].count, [p.retain_days])).rows[0].n;
  return {
    policies,
    holds: (await c.query<any>(`SELECT h.*, p.name AS party_name FROM privacy_legal_holds h LEFT JOIN parties p ON p.id=h.party_id ORDER BY h.placed_at DESC LIMIT 100`)).rows,
    runs: (await c.query<any>(`SELECT * FROM privacy_minimisation_runs ORDER BY created_at DESC LIMIT 50`)).rows,
    parties: (await c.query<any>(`SELECT id, name FROM parties ORDER BY name LIMIT 500`)).rows,
  };
}

/**
 * Scheduled worker: for every active policy of an active tenant, anonymise at most `limit` eligible records. Held, returning or
 * cash-unsettled records are skipped. Only counts are recorded; nothing is deleted and no financial record is touched.
 */
export async function processDataMinimisation(db: Db, limit = 200) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw badRequest("Minimisation batch size is 1–1000.");
  const due = (await db.query<any>(`SELECT p.* FROM privacy_retention_policies p JOIN tenants t ON t.id=p.tenant_id AND t.status='active' WHERE p.status='active' ORDER BY p.tenant_id, p.subject`)).rows;
  let anonymised = 0, failed = 0;
  for (const p of due) {
    try {
      anonymised += await db.tenant(p.tenant_id, async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${p.tenant_id}:privacy`]);
        const live = (await c.query<any>(`SELECT status FROM privacy_retention_policies WHERE id=$1`, [p.id])).rows[0];
        if (live?.status !== "active") return 0;
        const n = (await c.query(SQL[p.subject as RetentionSubject].run, [p.retain_days, limit])).rows.length;
        if (n) {
          await c.query(`INSERT INTO privacy_minimisation_runs(tenant_id,policy_id,subject,retain_days,rows_anonymised) VALUES ($1,$2,$3,$4,$5)`, [p.tenant_id, p.id, p.subject, p.retain_days, n]);
          await audit(c, p.tenant_id, { kind: "system" }, "privacy.minimised", "retention_policy", p.id, { subject: p.subject, rows: n });
        }
        return n;
      });
    } catch { failed++; }
  }
  return { policies: due.length, anonymised, failed };
}

// ───────── reviewed tenant erasure (platform staff, two people)
const ERASURE_STEPS = [
  ["fulfil_orders", `SELECT count(*)::int n FROM fulfil_orders WHERE anonymised_at IS NULL`, `UPDATE fulfil_orders SET ship_to_name='Anonymised', ship_to_phone=NULL, ship_to_address='Anonymised', ship_to_city=NULL, anonymised_at=now() WHERE anonymised_at IS NULL`],
  ["dlv_shipments", `SELECT count(*)::int n FROM dlv_shipments WHERE anonymised_at IS NULL`, `UPDATE dlv_shipments SET consignee_name='Anonymised', consignee_phone=NULL, address='Anonymised', delivered_to=NULL, anonymised_at=now() WHERE anonymised_at IS NULL`],
  ["trip_positions", `SELECT count(*)::int n FROM trip_positions`, `DELETE FROM trip_positions`],
  ["parties", `SELECT count(*)::int n FROM parties WHERE email IS NOT NULL OR phone IS NOT NULL`, `UPDATE parties SET email=NULL, phone=NULL, consent_marketing=false WHERE email IS NOT NULL OR phone IS NOT NULL`],
] as const;
const RETAINED = [
  "Issued invoices, receipts, credit notes and the legal-entity names and tax IDs on them (statutory financial retention).",
  "Audit log entries (counts and identifiers only).",
  "Conversation message evidence and generated/issued documents (immutable evidence; export or destroy through the storage retention runbook).",
  "Workspace staff accounts are global identities; close them through account closure, not tenant erasure.",
];

const OPEN_WORK = [
  ["open fulfilment orders", `SELECT count(*)::int n FROM fulfil_orders WHERE status NOT IN ('shipped','cancelled')`],
  ["open fulfilment returns", `SELECT count(*)::int n FROM fulfil_returns WHERE status IN ('expected','received')`],
  ["parcels not yet completed", `SELECT count(*)::int n FROM dlv_shipments WHERE status IN ('new','assigned','out_for_delivery','undelivered')`],
  ["cash collected but not remitted", `SELECT count(*)::int n FROM dlv_collections WHERE remittance_id IS NULL`],
  ["unpaid issued invoices", `SELECT count(*)::int n FROM invoices WHERE status IN ('issued','part_paid')`],
  ["trips still live", `SELECT count(*)::int n FROM trips WHERE status IN ('dispatched','in_progress')`],
  ["open legal holds", `SELECT count(*)::int n FROM privacy_legal_holds WHERE released_at IS NULL`],
] as const;

export async function prepareErasurePlan(db: Db, staffId: string, requestId: string) {
  const req = (await db.query<any>(`SELECT * FROM data_requests WHERE id=$1`, [recordId(requestId)])).rows[0];
  if (!req) throw new HttpError(404, "Request not found");
  if (req.kind !== "deletion" || req.status !== "approved") throw badRequest("An approved deletion request is required.");
  const plan = await db.tenant(req.tenant_id, async (c) => {
    const blockers: string[] = [];
    for (const [label, sql] of OPEN_WORK) { const n = (await c.query<any>(sql)).rows[0].n; if (n) blockers.push(`${n} ${label}`); }
    const steps: Record<string, number> = {};
    for (const [t, count] of ERASURE_STEPS) steps[t] = (await c.query<any>(count)).rows[0].n;
    return { blockers, steps, retained: RETAINED };
  });
  return db.system(async (c) => {
    const id = (await c.query<any>(
      `INSERT INTO privacy_erasure_plans(request_id,tenant_id,plan,prepared_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (request_id) DO UPDATE SET plan=$3, prepared_by=$4, prepared_at=now(), approved_by=NULL, approved_at=NULL WHERE privacy_erasure_plans.executed_at IS NULL RETURNING id`,
      [req.id, req.tenant_id, JSON.stringify(plan), staffId])).rows[0]?.id;
    if (!id) throw badRequest("This erasure was already executed.");
    await audit(c, req.tenant_id, { kind: "platform_staff", userId: staffId }, "privacy.erasure_planned", "data_request", req.id, { steps: plan.steps, blockers: plan.blockers.length });
    return { id, ...plan };
  });
}
export async function approveErasurePlan(db: Db, staffId: string, requestId: string) {
  return db.system(async (c) => {
    const p = (await c.query<any>(`SELECT * FROM privacy_erasure_plans WHERE request_id=$1 FOR UPDATE`, [recordId(requestId)])).rows[0];
    if (!p) throw new HttpError(404, "Prepare a plan first");
    if (p.executed_at) throw badRequest("Already executed.");
    if (p.prepared_by === staffId) throw forbidden("A second person must approve the erasure plan.");
    if (p.plan.blockers.length) throw badRequest(`Resolve before approval: ${p.plan.blockers.join("; ")}.`);
    await c.query(`UPDATE privacy_erasure_plans SET approved_by=$2, approved_at=now() WHERE id=$1`, [p.id, staffId]);
    await audit(c, p.tenant_id, { kind: "platform_staff", userId: staffId }, "privacy.erasure_approved", "data_request", p.request_id);
  });
}
/** Re-checks blockers at execution time, anonymises in one tenant transaction, then completes the request. */
export async function executeErasure(db: Db, staffId: string, requestId: string) {
  const p = (await db.query<any>(`SELECT * FROM privacy_erasure_plans WHERE request_id=$1`, [recordId(requestId)])).rows[0];
  if (!p?.approved_by) throw badRequest("The plan needs a second person's approval first.");
  if (p.executed_at) throw badRequest("Already executed.");
  if (p.approved_by === staffId && p.prepared_by === staffId) throw forbidden("Separation of duties violated.");
  const result = await db.tenant(p.tenant_id, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${p.tenant_id}:privacy`]);
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${p.tenant_id}:stock`]);
    const blockers: string[] = [];
    for (const [label, sql] of OPEN_WORK) { const n = (await c.query<any>(sql)).rows[0].n; if (n) blockers.push(`${n} ${label}`); }
    if (blockers.length) throw badRequest(`Work appeared after approval: ${blockers.join("; ")}. Prepare and approve a new plan.`);
    const done: Record<string, number> = {};
    for (const [t, , run] of ERASURE_STEPS) done[t] = (await c.query(run)).rowCount ?? 0;
    return done;
  });
  await db.system(async (c) => {
    await c.query(`UPDATE privacy_erasure_plans SET executed_at=now(), result=$2 WHERE id=$1`, [p.id, JSON.stringify(result)]);
    await c.query(`UPDATE data_requests SET status='completed', completed_at=now(), decision_by=$2, decision_reason=coalesce(decision_reason,'')||' | Erasure executed under a two-person reviewed plan.' WHERE id=$1`, [p.request_id, staffId]);
    await audit(c, p.tenant_id, { kind: "platform_staff", userId: staffId }, "privacy.erasure_executed", "data_request", p.request_id, { result });
  });
  return result;
}
