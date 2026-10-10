import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";

const TABLES = ["parties", "enquiries", "rates", "quotes", "quote_versions", "quote_lines", "jobs", "job_charges", "job_costs",
  "job_milestones", "job_exceptions", "documents", "invoices", "invoice_lines", "receipts"];

/** Data export is available on every plan (including Free and after downgrade): depth is charged, retrieval is not. */
export async function exportTenantData(c: Conn, ctx: Ctx) {
  require(ctx, "export");
  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), tenant_id: ctx.tenantId };
  for (const t of TABLES) out[t] = (await c.query(`SELECT * FROM ${t}`)).rows;
  await audit(c, ctx.tenantId, actorOf(ctx), "data.exported", "tenant", ctx.tenantId);
  return out;
}

const esc = (v: unknown) => {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export async function invoicesCsv(c: Conn, ctx: Ctx) {
  require(ctx, "export");
  const r = await c.query<any>(`SELECT i.no, p.name AS customer, i.issued_at, i.due_at, i.currency, i.subtotal_minor, i.tax_minor, i.total_minor, i.paid_minor, i.status, i.external_id, i.sync_status
    FROM invoices i JOIN parties p ON p.id=i.party_id ORDER BY i.issued_at`);
  const head = "invoice_no,customer,issued_at,due_at,currency,subtotal,tax,total,paid,status,external_id,sync_status";
  const rows = r.rows.map((x) => [x.no, x.customer, x.issued_at, x.due_at, x.currency, x.subtotal_minor / 100, x.tax_minor / 100, x.total_minor / 100, x.paid_minor / 100, x.status, x.external_id, x.sync_status].map(esc).join(","));
  return [head, ...rows].join("\n");
}
