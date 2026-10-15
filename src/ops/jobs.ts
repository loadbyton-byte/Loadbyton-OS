import { assertWritable } from "../platform/entitlements.js";
import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest, lineNet, toMinor } from "../lib/util.js";
import { consumeQuota } from "../platform/entitlements.js";
import { must, nextNumber, optStr, reqStr } from "./common.js";
import { marginBps } from "./quotes.js";
import { supplierProblems } from "./freight-commercial.js";

const MILESTONES: Record<string, [string, string][]> = {
  air: [["booked", "Booking confirmed"], ["received", "Cargo received"], ["departed", "Departed"], ["arrived", "Arrived"], ["cleared", "Customs cleared"], ["delivered", "Delivered"]],
  ocean: [["booked", "Booking confirmed"], ["gate_in", "Gate-in at origin"], ["departed", "Vessel departed"], ["arrived", "Vessel arrived"], ["cleared", "Customs cleared"], ["delivered", "Delivered"]],
  road: [["booked", "Booking confirmed"], ["loaded", "Loaded"], ["departed", "Departed"], ["border", "Border crossed"], ["arrived", "Arrived"], ["delivered", "Delivered"]],
};

/** Convert an accepted quote into a job. Billable quota is consumed under a ref so a retry cannot double-count. */
export async function createJobFromQuote(c: Conn, ctx: Ctx, quoteId: string): Promise<string> {
  const q = await must(c.query<any>(`SELECT * FROM quotes WHERE id=$1`, [quoteId]), "Quote");
  await consumeQuota(c, ctx.tenantId, "jobs_per_month", `job-from-quote:${quoteId}`);
  const v = (await c.query<any>(`SELECT * FROM quote_versions WHERE quote_id=$1 AND version=$2`, [quoteId, q.current_version])).rows[0];
  const lines = (await c.query<any>(`SELECT * FROM quote_lines WHERE version_id=$1 ORDER BY position`, [v.id])).rows;
  const enq = q.enquiry_id ? (await c.query<any>(`SELECT * FROM enquiries WHERE id=$1`, [q.enquiry_id])).rows[0] : null;
  const entity = (await c.query<any>(`SELECT id FROM entities ORDER BY created_at LIMIT 1`)).rows[0];
  const no = await nextNumber(c, ctx.tenantId, "job", "JOB");
  const mode = enq?.mode ?? "ocean";
  const j = await c.query<{ id: string }>(
    `INSERT INTO jobs(tenant_id,entity_id,no,quote_id,quote_version_id,party_id,mode,incoterm,origin,destination,pieces,weight_kg,volume_cbm,assigned_to,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`,
    [ctx.tenantId, entity.id, no, quoteId, v.id, q.party_id, mode, enq?.incoterm ?? null, enq?.origin ?? null, enq?.destination ?? null,
      enq?.pieces ?? null, enq?.weight_kg ?? null, enq?.volume_cbm ?? null, ctx.userId]);
  const jobId = j.rows[0].id;
  for (const l of lines) {
    await c.query(`INSERT INTO job_charges(tenant_id,job_id,description,qty,unit_minor,tax_code) VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.tenantId, jobId, l.description, l.qty, l.unit_sell_minor, l.tax_code]);
    const cost = lineNet(l.qty, l.unit_cost_minor);
    if (cost > 0) {
      await c.query(`INSERT INTO job_costs(tenant_id,job_id,supplier_id,description,estimated_minor) VALUES ($1,$2,$3,$4,$5)`,
        [ctx.tenantId, jobId, l.supplier_id, l.description, cost]);
    }
  }
  let pos = 0;
  for (const [code, label] of MILESTONES[mode] ?? MILESTONES.ocean) {
    await c.query(`INSERT INTO job_milestones(tenant_id,job_id,code,label,position) VALUES ($1,$2,$3,$4,$5)`, [ctx.tenantId, jobId, code, label, ++pos]);
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "job.created", "job", jobId, { no, quoteId });
  return jobId;
}

export async function getJob(c: Conn, id: string) {
  const job = await must(c.query<any>(`SELECT j.*, p.name AS party_name, u.name AS assignee_name FROM jobs j
    JOIN parties p ON p.id=j.party_id LEFT JOIN team_members u ON u.user_id=j.assigned_to WHERE j.id=$1`, [id]), "Job");
  const [charges, costs, milestones, exceptions, docs, invoices] = await Promise.all([
    c.query<any>(`SELECT * FROM job_charges WHERE job_id=$1 ORDER BY description`, [id]),
    c.query<any>(`SELECT k.*, s.name AS supplier_name FROM job_costs k LEFT JOIN parties s ON s.id=k.supplier_id WHERE k.job_id=$1 ORDER BY k.created_at`, [id]),
    c.query<any>(`SELECT * FROM job_milestones WHERE job_id=$1 ORDER BY position`, [id]),
    c.query<any>(`SELECT x.*, u.name AS owner_name FROM job_exceptions x LEFT JOIN team_members u ON u.user_id=x.owner_id WHERE x.job_id=$1 ORDER BY x.created_at DESC`, [id]),
    c.query<any>(`SELECT * FROM documents WHERE job_id=$1 ORDER BY created_at DESC`, [id]),
    c.query<any>(`SELECT i.*, coalesce((SELECT sum(n.subtotal_minor) FROM credit_notes n WHERE n.invoice_id=i.id AND n.status='issued'),0) AS credited_subtotal_minor FROM invoices i WHERE job_id=$1 ORDER BY issued_at`, [id]),
  ]);
  return { job, charges: charges.rows, costs: costs.rows, milestones: milestones.rows, exceptions: exceptions.rows, docs: docs.rows, invoices: invoices.rows,
    margin: jobMargin(charges.rows, costs.rows, invoices.rows, await quoteEstimate(c, job.quote_version_id)) };
}

async function quoteEstimate(c: Conn, versionId: string | null) {
  if (!versionId) return null;
  const v = (await c.query<any>(`SELECT total_sell_minor, total_cost_minor FROM quote_versions WHERE id=$1`, [versionId])).rows[0];
  return v ? { sell: Number(v.total_sell_minor), cost: Number(v.total_cost_minor) } : null;
}

/**
 * Three margin views, kept separate (blueprint §13/§17):
 *  quotation estimate → updated expected (actual where reconciled, else estimate) → actual reconciled (only when nothing is estimated).
 */
export function jobMargin(charges: any[], costs: any[], invoices: any[], est: { sell: number; cost: number } | null) {
  const credits = invoices.filter(i => i.status !== "void").reduce((sum, i) => sum + Number(i.credited_subtotal_minor ?? 0), 0);
  const sell = charges.reduce((a, l) => a + lineNet(l.qty, l.unit_minor), 0) - credits;
  const unreconciled = costs.filter((k) => k.actual_minor == null);
  const expectedCost = costs.reduce((a, k) => a + Number(k.actual_minor ?? k.estimated_minor), 0);
  const accrual = unreconciled.reduce((a, k) => a + Number(k.estimated_minor), 0);
  const invoicedNet = invoices.filter((i) => i.status !== "void").reduce((a, i) => a + Number(i.subtotal_minor) - Number(i.credited_subtotal_minor ?? 0), 0);
  const actualCost = costs.filter((k) => k.actual_minor != null).reduce((a, k) => a + Number(k.actual_minor), 0);
  return {
    quotation: est ? { sell: est.sell, cost: est.cost, bps: marginBps(est.sell, est.cost) } : null,
    expected: { sell, cost: expectedCost, bps: marginBps(sell, expectedCost) },
    actual: unreconciled.length || !invoices.some(i => i.status !== "void") ? null : { sell: invoicedNet, cost: actualCost, bps: marginBps(invoicedNet, actualCost) },
    accrualMinor: accrual, unreconciledCosts: unreconciled.length,
  };
}

export const listJobs = (c: Conn, partyId?: string | null) =>
  c.query<any>(`SELECT j.*, p.name AS party_name,
      (SELECT coalesce(sum(round(qty*unit_minor)),0) FROM job_charges WHERE job_id=j.id) AS sell_minor
    FROM jobs j JOIN parties p ON p.id=j.party_id WHERE ($1::uuid IS NULL OR j.party_id=$1) ORDER BY j.created_at DESC`, [partyId ?? null]).then((r) => r.rows);

export async function updateJobRefs(c: Conn, ctx: Ctx, id: string, f: Record<string, any>) {
  require(ctx, "job.write");
  await assertWritable(c, ctx.tenantId);
  await c.query(`UPDATE jobs SET booking_ref=$2, master_ref=$3, house_ref=$4, carrier=$5, incoterm=$6, assigned_to=coalesce($7,assigned_to) WHERE id=$1`,
    [id, optStr(f.booking_ref, 80), optStr(f.master_ref, 80), optStr(f.house_ref, 80), optStr(f.carrier, 120), optStr(f.incoterm, 10), optStr(f.assigned_to, 40)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "job.refs_updated", "job", id);
}

export async function planMilestone(c: Conn, ctx: Ctx, milestoneId: string, plannedAt: string) {
  require(ctx, "job.write");
  await assertWritable(c, ctx.tenantId);
  await c.query(`UPDATE job_milestones SET planned_at=$2 WHERE id=$1`, [milestoneId, plannedAt || null]);
}

/** Record an actual milestone. Delivery requires proof of delivery on file; a notification failure never reverses it. */
export async function recordMilestone(c: Conn, ctx: Ctx, milestoneId: string, note?: string) {
  require(ctx, "job.write");
  await assertWritable(c, ctx.tenantId);
  const m = await must(c.query<any>(`SELECT * FROM job_milestones WHERE id=$1`, [milestoneId]), "Milestone");
  if (m.actual_at) throw badRequest("Milestone already recorded.");
  if (m.code === "delivered") {
    const pod = await c.query(`SELECT 1 FROM documents WHERE job_id=$1 AND kind='pod' AND status='issued' AND NOT hold LIMIT 1`, [m.job_id]);
    if (!pod.rows.length) throw badRequest("Attach issued, unheld proof of delivery (document kind “pod”) before recording delivery.");
  }
  await c.query(`UPDATE job_milestones SET actual_at=now(), note=$2, recorded_by=$3 WHERE id=$1`, [milestoneId, optStr(note, 500), ctx.userId]);
  const status = m.code === "delivered" ? "delivered" : m.code === "booked" ? null : "in_transit";
  if (status) await c.query(`UPDATE jobs SET status=$2, delivered_at = CASE WHEN $2='delivered' THEN now() ELSE delivered_at END WHERE id=$1 AND status IN ('planned','in_transit')`, [m.job_id, status]);
  await audit(c, ctx.tenantId, actorOf(ctx), "milestone.recorded", "job", m.job_id, { code: m.code });
}

export async function completeOperationally(c: Conn, ctx: Ctx, jobId: string) {
  require(ctx, "job.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`UPDATE jobs SET status='operationally_complete' WHERE id=$1 AND status='delivered' RETURNING id`, [jobId]), "Delivered job");
  await audit(c, ctx.tenantId, actorOf(ctx), "job.operationally_complete", "job", jobId);
}

export async function addCost(c: Conn, ctx: Ctx, jobId: string, f: Record<string, any>) {
  require(ctx, "job.cost");
  await assertWritable(c, ctx.tenantId);
  const supplier = optStr(f.supplier_id, 40);
  let override: string | null = null;
  if (supplier) {
    const job = await must(c.query<any>(`SELECT mode, origin, destination FROM jobs WHERE id=$1`, [jobId]), "Job");
    const problems = await supplierProblems(c, supplier, { mode: job.mode, origin: job.origin, destination: job.destination, amountMinor: toMinor(f.estimated || 0) });
    if (problems.length) {
      // an approver may knowingly proceed against a contract limit; the reason stays on the cost line
      if (!f.contract_override || !ctx.perms.has("quote.approve")) throw badRequest(`${problems.join(" ")} ${ctx.perms.has("quote.approve") ? "Enter an override reason to proceed." : "An approver must authorise this."}`);
      override = reqStr(f.contract_override, "Override reason", 500);
    }
  }
  await c.query(`INSERT INTO job_costs(tenant_id,job_id,supplier_id,description,estimated_minor,contract_override) VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.tenantId, jobId, supplier, reqStr(f.description, "Description", 300), toMinor(f.estimated || 0), override]);
  await audit(c, ctx.tenantId, actorOf(ctx), "cost.added", "job", jobId);
}

/** Reconcile a supplier invoice against an estimate: actual replaces the estimate in expected margin. */
export async function reconcileCost(c: Conn, ctx: Ctx, costId: string, actual: string, ref: string) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const k = await must(c.query<any>(`UPDATE job_costs SET actual_minor=$2, supplier_invoice_ref=$3, status='posted' WHERE id=$1 AND status<>'posted' RETURNING job_id`,
    [costId, toMinor(actual), reqStr(ref, "Supplier invoice reference", 100)]), "Open cost");
  await audit(c, ctx.tenantId, actorOf(ctx), "cost.reconciled", "job", k.job_id, { costId });
}

export async function addExceptionItem(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "job.write");
  await assertWritable(c, ctx.tenantId);
  if (!f.due_at) throw badRequest("Set a deadline.");
  await c.query(`INSERT INTO job_exceptions(tenant_id,job_id,title,detail,owner_id,due_at,escalate_to) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.tenantId, optStr(f.job_id, 40), reqStr(f.title, "Title", 200), optStr(f.detail, 1000), optStr(f.owner_id, 40) ?? ctx.userId, f.due_at, optStr(f.escalate_to, 40)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "exception.opened", "job", f.job_id ?? undefined);
}
export async function resolveException(c: Conn, ctx: Ctx, id: string) {
  require(ctx, ctx.perms.has("job.write") ? "job.write" : "wh.write");
  await assertWritable(c, ctx.tenantId);   // warehouse staff close the short-pick tasks they raise
  await c.query(`UPDATE job_exceptions SET status='resolved', resolved_at=now() WHERE id=$1`, [id]);
}

/** Financial closure is separate from operational completion and lists every blocker. */
export async function financialClosureBlockers(c: Conn, jobId: string) {
  const d = await getJob(c, jobId);
  const reasons: string[] = [];
  if (!["operationally_complete", "delivered"].includes(d.job.status)) reasons.push("job is not yet delivered / operationally complete");
  const uninvoiced = d.charges.filter((x) => x.approved && !x.invoice_id);
  if (uninvoiced.length) reasons.push(`${uninvoiced.length} approved charge(s) not yet invoiced`);
  const unpaid = d.invoices.filter((i) => i.status !== "void" && i.status !== "paid");
  if (unpaid.length) reasons.push(`${unpaid.length} invoice(s) not fully collected`);
  if (!d.invoices.some((i) => i.status !== "void")) reasons.push("no invoice issued");
  if (d.margin.unreconciledCosts) reasons.push(`${d.margin.unreconciledCosts} supplier cost(s) still estimated (accrual visible)`);
  const open = d.exceptions.filter((x) => x.status === "open");
  if (open.length) reasons.push(`${open.length} open exception(s)`);
  return reasons;
}

export async function closeFinancially(c: Conn, ctx: Ctx, jobId: string) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const reasons = await financialClosureBlockers(c, jobId);
  if (reasons.length) throw badRequest(`Cannot close financially: ${reasons.join("; ")}.`);
  await c.query(`UPDATE jobs SET financial_status='closed', status=CASE WHEN status='delivered' THEN 'operationally_complete' ELSE status END WHERE id=$1`, [jobId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "job.financially_closed", "job", jobId);
}
