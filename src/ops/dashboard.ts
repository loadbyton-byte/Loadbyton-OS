import type { Conn } from "../db/client.js";
import { currentUsage, getLimits } from "../platform/entitlements.js";
import { ageing } from "./finance.js";
import { jobMargin } from "./jobs.js";

/**
 * Owner view. Every figure carries its currency/period and links (`href`) to the records behind it
 * ("Why this number?"). Costs flagged `estimated` are never presented as reconciled books.
 */
export async function ownerDashboard(c: Conn, tenantId: string) {
  const jobs = (await c.query<any>(`SELECT id FROM jobs WHERE status <> 'cancelled'`)).rows;
  const charges = (await c.query<any>(`SELECT job_id,qty,unit_minor FROM job_charges`)).rows;
  const costs = (await c.query<any>(`SELECT job_id,actual_minor,estimated_minor FROM job_costs`)).rows;
  const invoices = (await c.query<any>(`SELECT i.job_id,i.status,i.subtotal_minor,coalesce((SELECT sum(n.subtotal_minor) FROM credit_notes n WHERE n.invoice_id=i.id AND n.status='issued'),0) AS credited_subtotal_minor FROM invoices i`)).rows;
  const group = (rows: any[]) => { const byJob = new Map<string, any[]>(); for (const row of rows) { const list=byJob.get(row.job_id) ?? []; list.push(row); byJob.set(row.job_id,list); } return byJob; };
  const byCharge=group(charges),byCost=group(costs),byInvoice=group(invoices);
  let estSell = 0, estCost = 0, actSell = 0, actCost = 0, accrual = 0, reconciledJobs = 0;
  for (const j of jobs) {
    const m = jobMargin(byCharge.get(j.id) ?? [], byCost.get(j.id) ?? [], byInvoice.get(j.id) ?? [], null);
    estSell += m.expected.sell; estCost += m.expected.cost; accrual += m.accrualMinor;
    if (m.actual) { actSell += m.actual.sell; actCost += m.actual.cost; reconciledJobs++; }
  }

  const unbilled = (await c.query<any>(
    `SELECT j.id, j.no, p.name AS party, (SELECT sum(round(qty*unit_minor)) FROM job_charges g WHERE g.job_id=j.id AND g.approved AND g.invoice_id IS NULL) AS amount_minor
     FROM jobs j JOIN parties p ON p.id=j.party_id
     WHERE j.status IN ('delivered','operationally_complete') AND EXISTS (SELECT 1 FROM job_charges g WHERE g.job_id=j.id AND g.approved AND g.invoice_id IS NULL)
     ORDER BY j.delivered_at`)).rows;
  const overdue = (await c.query<any>(
    `SELECT i.id, i.no, p.name AS party, i.balance_minor AS amount_minor, i.due_at FROM invoices i JOIN parties p ON p.id=i.party_id
     WHERE i.status IN ('issued','part_paid') AND i.due_at < now() ORDER BY i.due_at`)).rows;
  const due7 = (await c.query<any>(
    `SELECT coalesce(sum(balance_minor),0) n FROM invoices WHERE status IN ('issued','part_paid') AND due_at >= now() AND due_at < now() + interval '7 days'`)).rows[0].n;
  const supplier = (await c.query<any>(
    `SELECT coalesce(sum(estimated_minor),0) n, count(*)::int c FROM job_costs WHERE actual_minor IS NULL`)).rows[0];
  const exceptions = (await c.query<any>(
    `SELECT x.id, x.title, x.due_at, x.job_id, u.name AS owner FROM job_exceptions x LEFT JOIN team_members u ON u.user_id=x.owner_id
     WHERE x.status='open' AND x.due_at < now() + interval '48 hours' ORDER BY x.due_at`)).rows;
  const delayed = (await c.query<any>(
    `SELECT m.id, m.label, m.planned_at, j.id AS job_id, j.no FROM job_milestones m JOIN jobs j ON j.id=m.job_id
     WHERE m.actual_at IS NULL AND m.planned_at < now() AND j.status IN ('planned','in_transit') ORDER BY m.planned_at`)).rows;
  const holds = (await c.query<any>(
    `SELECT d.id, d.title, d.job_id, 'on hold' AS why FROM documents d WHERE d.hold
     UNION ALL SELECT NULL, 'Delivered without proof of delivery', j.id, j.no FROM jobs j
       WHERE j.status IN ('delivered','operationally_complete') AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.job_id=j.id AND d.kind='pod' AND d.status='issued' AND NOT d.hold)`)).rows;
  const capacity = (await c.query<any>(
    `SELECT coalesce(u.name,'Unassigned') AS who, count(*)::int n FROM jobs j LEFT JOIN team_members u ON u.user_id=j.assigned_to
     WHERE j.status IN ('planned','in_transit') GROUP BY 1 ORDER BY 2 DESC`)).rows;
  const conc = (await c.query<any>(
    `SELECT p.name, sum(i.subtotal_minor - coalesce((SELECT sum(cn.subtotal_minor) FROM credit_notes cn WHERE cn.invoice_id=i.id AND cn.status='issued'),0)) AS n FROM invoices i JOIN parties p ON p.id=i.party_id WHERE i.status<>'void' GROUP BY p.id,p.name ORDER BY 2 DESC`)).rows;
  const concTotal = conc.reduce((a, r) => a + Number(r.n), 0);
  const unsynced = (await c.query<any>(`SELECT count(*)::int n FROM invoices WHERE sync_status<>'synced' AND status<>'void'`)).rows[0].n;
  const sub = (await c.query<any>(
    `SELECT s.status, s.period_end, pv.name AS plan, pv.plan_code FROM subscriptions s JOIN plan_versions pv ON pv.id=s.plan_version_id WHERE s.tenant_id=$1`, [tenantId])).rows[0];
  const limits = await getLimits(c, tenantId);
  const usage = {
    jobs: await currentUsage(c, tenantId, "jobs_per_month"), users: await currentUsage(c, tenantId, "max_users"),
    storage: await currentUsage(c, tenantId, "storage_mb"), branches: await currentUsage(c, tenantId, "max_branches"),
  };

  return {
    currency: "AED",
    margin: { estSell, estCost, estBps: estSell ? Math.round(((estSell - estCost) * 10000) / estSell) : 0,
      actSell, actCost, actBps: actSell ? Math.round(((actSell - actCost) * 10000) / actSell) : 0, reconciledJobs, totalJobs: jobs.length, accrual },
    unbilled, overdue, overdueTotal: overdue.reduce((a, r) => a + Number(r.amount_minor), 0), due7: Number(due7),
    supplier: { estimatedMinor: Number(supplier.n), count: supplier.c }, exceptions, delayed, holds, capacity,
    concentration: conc.slice(0, 3).map((r) => ({ name: r.name, pct: concTotal ? Math.round((Number(r.n) * 100) / concTotal) : 0 })),
    unsynced, subscription: sub, limits, usage, ageing: await ageing(c),
  };
}
