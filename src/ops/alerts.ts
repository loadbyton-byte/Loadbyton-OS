import type { Conn } from "../db/client.js";
import { fmtMoney } from "../lib/util.js";

export interface Alert { level: "danger" | "warn" | "info"; title: string; text: string; href: string }

/**
 * Things that need a person today, drawn only from the tenant's own records (called inside a tenant transaction, so row-level security applies).
 * Money alerts are included only when the viewer may see money.
 */
export async function tenantAlerts(c: Conn, opts: { money: boolean }): Promise<Alert[]> {
  const n = async (sql: string, params: unknown[] = []) => (await c.query<any>(sql, params)).rows[0] ?? {};
  const out: Alert[] = [];
  if (opts.money) {
    const o = await n(`SELECT count(*)::int c, coalesce(sum(balance_minor),0) s FROM invoices WHERE status IN ('issued','part_paid') AND due_at < now()`);
    if (o.c) out.push({ level: "danger", title: `${o.c} overdue invoice${o.c > 1 ? "s" : ""}`, text: `${fmtMoney(o.s)} is past its due date.`, href: "/app/invoices?filter=overdue" });
    const u = await n(`SELECT count(*)::int c FROM jobs j WHERE j.status IN ('delivered','operationally_complete') AND EXISTS (SELECT 1 FROM job_charges g WHERE g.job_id=j.id AND g.approved AND g.invoice_id IS NULL)`);
    if (u.c) out.push({ level: "warn", title: `${u.c} delivered job${u.c > 1 ? "s" : ""} not invoiced`, text: "Approved charges are waiting to be billed.", href: "/app/reports" });
  }
  const x = await n(`SELECT count(*)::int c, count(*) FILTER (WHERE due_at < now())::int late FROM job_exceptions WHERE status='open' AND due_at < now() + interval '48 hours'`);
  if (x.c) out.push({ level: x.late ? "danger" : "warn", title: `${x.c} exception${x.c > 1 ? "s" : ""} due soon`, text: x.late ? `${x.late} already late.` : "Due within 48 hours.", href: "/app/tasks" });
  const d = await n(`SELECT count(*)::int c FROM job_milestones m JOIN jobs j ON j.id=m.job_id WHERE m.actual_at IS NULL AND m.planned_at < now() AND j.status IN ('planned','in_transit')`);
  if (d.c) out.push({ level: "warn", title: `${d.c} delayed milestone${d.c > 1 ? "s" : ""}`, text: "Planned time has passed and nothing is recorded.", href: "/app/jobs" });
  const h = await n(`SELECT (SELECT count(*) FROM documents WHERE hold)::int holds, (SELECT count(*) FROM jobs j WHERE j.status IN ('delivered','operationally_complete') AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.job_id=j.id AND d.kind='pod'))::int nopod`);
  if (h.holds) out.push({ level: "warn", title: `${h.holds} document${h.holds > 1 ? "s" : ""} on hold`, text: "Review and release or reject.", href: "/app/documents" });
  if (h.nopod) out.push({ level: "info", title: `${h.nopod} delivered without proof of delivery`, text: "Attach the signed POD to the job.", href: "/app/jobs" });
  return out;
}
