import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest, lineNet, taxFor, toMinor } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, nextNumber, reqStr, today } from "./common.js";

export interface InvoiceSource {
  entityId: string; partyId: string; jobId?: string | null; transportOrderId?: string | null; whRunId?: string | null; dlvRunId?: string | null; customsCaseId?: string | null;
  lines: { id: string; description: string; qty: number | string; unit_minor: number | string; tax_code: string }[];
  /** called after the invoice row exists so the caller can mark its own charge rows as invoiced */
  markCharge: (chargeId: string, invoiceId: string) => Promise<void>;
}

/**
 * Shared issuing path for every sector: controlled numbering, per-line tax, outbox row for the accounting bridge.
 * One unique outbox key per invoice means a retry can never create a second external posting.
 */
export async function issueInvoice(c: Conn, ctx: Ctx, src: InvoiceSource, termsDays = 30) {
  const ent = (await c.query<any>(`SELECT * FROM entities WHERE id=$1`, [src.entityId])).rows[0];
  const lines = src.lines.map((l) => {
    const net = lineNet(l.qty, l.unit_minor);
    return { ...l, net, tax: taxFor(net, l.tax_code) };
  });
  const subtotal = lines.reduce((a, l) => a + l.net, 0);
  const tax = lines.reduce((a, l) => a + l.tax, 0);
  const no = await nextNumber(c, ctx.tenantId, "invoice", ent.invoice_prefix);
  const conn = (await c.query<any>(`SELECT status FROM accounting_connections`)).rows[0];
  const sync = conn && ["connected", "live", "validating"].includes(conn.status) ? "pending" : "not_connected";
  const inv = await c.query<{ id: string }>(
    `INSERT INTO invoices(tenant_id,entity_id,no,party_id,job_id,transport_order_id,wh_run_id,dlv_run_id,cus_case_id,currency,subtotal_minor,tax_minor,total_minor,due_at,sync_status,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + ($14 || ' days')::interval, $15,$16) RETURNING id`,
    [ctx.tenantId, src.entityId, no, src.partyId, src.jobId ?? null, src.transportOrderId ?? null, src.whRunId ?? null, src.dlvRunId ?? null, src.customsCaseId ?? null, ent.currency, subtotal, tax, subtotal + tax, String(termsDays), sync, ctx.userId]);
  const id = inv.rows[0].id;
  for (const l of lines) {
    await c.query(`INSERT INTO invoice_lines(tenant_id,invoice_id,description,qty,unit_minor,tax_code,net_minor,tax_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.tenantId, id, l.description, l.qty, l.unit_minor, l.tax_code, l.net, l.tax]);
    await src.markCharge(l.id, id);
  }
  if (sync === "pending") {
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'accounting.invoice',$2,$3) ON CONFLICT (key) DO NOTHING`,
      [ctx.tenantId, `invoice:${id}`, JSON.stringify({ invoiceId: id })]);
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "invoice.issued", "invoice", id, { no, total: subtotal + tax });
  return { id, no };
}

/** Invoice from approved, not-yet-invoiced job charges. Outstanding supplier costs do not block but are returned as warnings. */
export async function invoiceJob(c: Conn, ctx: Ctx, jobId: string, termsDays = 30) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const job = await must(c.query<any>(`SELECT * FROM jobs WHERE id=$1 FOR UPDATE`, [jobId]), "Job");
  const charges = (await c.query<any>(`SELECT * FROM job_charges WHERE job_id=$1 AND approved AND invoice_id IS NULL`, [jobId])).rows;
  if (!charges.length) throw badRequest("No approved, uninvoiced charges on this job.");
  const r = await issueInvoice(c, ctx, {
    entityId: job.entity_id, partyId: job.party_id, jobId, lines: charges,
    markCharge: async (chargeId, invoiceId) => { await c.query(`UPDATE job_charges SET invoice_id=$2 WHERE id=$1`, [chargeId, invoiceId]); },
  }, termsDays);
  await c.query(`UPDATE jobs SET financial_status='invoiced' WHERE id=$1 AND financial_status='open'`, [jobId]);
  const open = (await c.query<any>(`SELECT count(*)::int n FROM job_costs WHERE job_id=$1 AND actual_minor IS NULL`, [jobId])).rows[0].n;
  return { ...r, warnings: open ? [`${open} supplier cost(s) are still estimated; margin is not final.`] : [] };
}

export async function recordReceipt(c: Conn, ctx: Ctx, invoiceId: string, f: Record<string, any>) {
  require(ctx, "finance.write");
  const inv = await must(c.query<any>(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [invoiceId]), "Invoice");
  if (inv.status === "void") throw badRequest("Invoice is void.");
  const amount = toMinor(f.amount);
  if (amount <= 0) throw badRequest("Enter an amount above zero.");
  const outstanding = Number(inv.total_minor) - Number(inv.paid_minor);
  if (amount > outstanding) throw badRequest("Receipt exceeds the outstanding balance.");
  await c.query(`INSERT INTO receipts(tenant_id,invoice_id,amount_minor,received_at,method,reference,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.tenantId, invoiceId, amount, f.received_at || today(), reqStr(f.method || "bank transfer", "Method", 40), f.reference || null, ctx.userId]);
  const paid = Number(inv.paid_minor) + amount;
  const status = paid >= Number(inv.total_minor) ? "paid" : "part_paid";
  await c.query(`UPDATE invoices SET paid_minor=$2, status=$3 WHERE id=$1`, [invoiceId, paid, status]);
  if (inv.job_id && status === "paid") {
    const open = await c.query(`SELECT 1 FROM invoices WHERE job_id=$1 AND status NOT IN ('paid','void')`, [inv.job_id]);
    const uninv = await c.query(`SELECT 1 FROM job_charges WHERE job_id=$1 AND approved AND invoice_id IS NULL`, [inv.job_id]);
    if (!open.rows.length && !uninv.rows.length) await c.query(`UPDATE jobs SET financial_status='collected' WHERE id=$1 AND financial_status IN ('open','invoiced')`, [inv.job_id]);
  }
  if (inv.transport_order_id && status === "paid") {
    const open = await c.query(`SELECT 1 FROM invoices WHERE transport_order_id=$1 AND status NOT IN ('paid','void')`, [inv.transport_order_id]);
    const uninv = await c.query(`SELECT 1 FROM transport_order_charges WHERE order_id=$1 AND invoice_id IS NULL`, [inv.transport_order_id]);
    if (!open.rows.length && !uninv.rows.length) await c.query(`UPDATE transport_orders SET financial_status='collected' WHERE id=$1`, [inv.transport_order_id]);
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "receipt.recorded", "invoice", invoiceId, { amount });
  return { status };
}

/** Posted invoices are never edited; a void is an authorised reversal that releases the charges. */
export async function voidInvoice(c: Conn, ctx: Ctx, invoiceId: string, reason: string) {
  require(ctx, "finance.void");
  const inv = await must(c.query<any>(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [invoiceId]), "Invoice");
  if (Number(inv.paid_minor) > 0) throw badRequest("Invoice has receipts. Reverse receipts first.");
  if (inv.status === "void") throw badRequest("Already void.");
  await c.query(`UPDATE invoices SET status='void' WHERE id=$1`, [invoiceId]);
  await c.query(`UPDATE job_charges SET invoice_id=NULL WHERE invoice_id=$1`, [invoiceId]);
  await c.query(`UPDATE fulfil_charges SET invoice_id=NULL WHERE invoice_id=$1`, [invoiceId]);   // activity returns to the unbilled pool
  if (inv.job_id) await c.query(`UPDATE jobs SET financial_status='open' WHERE id=$1 AND financial_status IN ('invoiced','collected')`, [inv.job_id]);
  if (inv.transport_order_id) {
    await c.query(`UPDATE transport_order_charges SET invoice_id=NULL WHERE invoice_id=$1`, [invoiceId]);
    await c.query(`UPDATE transport_orders SET financial_status='open' WHERE id=$1`, [inv.transport_order_id]);
  }
  if (inv.wh_run_id) {
    // warehouse activity returns to the unbilled pool so it can be re-invoiced (after a rate correction, say)
    await c.query(`UPDATE wh_charges SET invoice_id=NULL WHERE invoice_id=$1`, [invoiceId]);
    await c.query(`UPDATE wh_billing_runs SET status='void' WHERE id=$1`, [inv.wh_run_id]);
  }
  if (inv.dlv_run_id) {
    // delivery activity returns to the unbilled pool so it can be re-invoiced
    await c.query(`UPDATE dlv_charges SET invoice_id=NULL WHERE invoice_id=$1`, [invoiceId]);
    await c.query(`UPDATE dlv_billing_runs SET status='void' WHERE id=$1`, [inv.dlv_run_id]);
  }
  if (inv.cus_case_id) await c.query(`UPDATE cus_charges SET invoice_id=NULL WHERE invoice_id=$1`, [invoiceId]);   // customs charges return to the unbilled pool
  await audit(c, ctx.tenantId, actorOf(ctx), "invoice.voided", "invoice", invoiceId, { reason: reqStr(reason, "Reason", 300) });
}

export async function getInvoice(c: Conn, id: string) {
  const inv = await must(c.query<any>(`SELECT i.*, p.name AS party_name, p.tax_id AS party_tax_id, e.legal_name, e.name AS entity_name, e.tax_id AS entity_tax_id, coalesce(j.no, o.no, CASE WHEN i.wh_run_id IS NOT NULL THEN 'Warehouse activity' WHEN i.dlv_run_id IS NOT NULL THEN 'Delivery activity' WHEN i.cus_case_id IS NOT NULL THEN 'Customs case' END) AS job_no
    FROM invoices i JOIN parties p ON p.id=i.party_id JOIN entities e ON e.id=i.entity_id LEFT JOIN jobs j ON j.id=i.job_id LEFT JOIN transport_orders o ON o.id=i.transport_order_id WHERE i.id=$1`, [id]), "Invoice");
  const lines = (await c.query<any>(`SELECT * FROM invoice_lines WHERE invoice_id=$1`, [id])).rows;
  const receipts = (await c.query<any>(`SELECT * FROM receipts WHERE invoice_id=$1 ORDER BY received_at`, [id])).rows;
  return { inv, lines, receipts };
}

export const listInvoices = (c: Conn, partyId?: string | null) =>
  c.query<any>(`SELECT i.*, p.name AS party_name, coalesce(j.no, o.no, CASE WHEN i.wh_run_id IS NOT NULL THEN 'Warehouse activity' WHEN i.dlv_run_id IS NOT NULL THEN 'Delivery activity' WHEN i.cus_case_id IS NOT NULL THEN 'Customs case' END) AS job_no, (i.due_at < now() AND i.status IN ('issued','part_paid')) AS overdue
    FROM invoices i JOIN parties p ON p.id=i.party_id LEFT JOIN jobs j ON j.id=i.job_id LEFT JOIN transport_orders o ON o.id=i.transport_order_id WHERE ($1::uuid IS NULL OR i.party_id=$1) ORDER BY i.issued_at DESC`, [partyId ?? null]).then((r) => r.rows);

/** Receivables ageing by days past due. */
export async function ageing(c: Conn) {
  const r = await c.query<any>(`SELECT
    coalesce(sum(CASE WHEN due_at >= now() THEN total_minor-paid_minor END),0) AS current,
    coalesce(sum(CASE WHEN due_at < now() AND due_at >= now() - interval '30 days' THEN total_minor-paid_minor END),0) AS d1_30,
    coalesce(sum(CASE WHEN due_at < now() - interval '30 days' AND due_at >= now() - interval '60 days' THEN total_minor-paid_minor END),0) AS d31_60,
    coalesce(sum(CASE WHEN due_at < now() - interval '60 days' THEN total_minor-paid_minor END),0) AS d60p
    FROM invoices WHERE status IN ('issued','part_paid')`);
  const x = r.rows[0];
  return { current: Number(x.current), d1_30: Number(x.d1_30), d31_60: Number(x.d31_60), d60p: Number(x.d60p) };
}
