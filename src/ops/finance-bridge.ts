import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { TAX_CODES, badRequest, lineNet, taxFor, toMinor } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, nextNumber, optStr, recordId, reqStr, today } from "./common.js";
import { refreshCollection, settledStatus } from "./finance.js";

const day = (d: unknown) => String(d).slice(0, 10);
const isOwner = (ctx: Ctx) => ctx.roles.includes("owner");
const CCY = /^[A-Z]{3}$/;

// ═════════════ Credit notes
export interface CreditLineInput { invoice_line_id?: string | null; description?: string; qty?: number | string; unit?: number | string; tax_code?: string }

async function creditedSoFar(c: Conn, invoiceLineId: string) {
  const r = (await c.query<any>(
    `SELECT coalesce(sum(l.qty),0)::float8 AS qty, coalesce(sum(l.net_minor),0)::bigint AS net FROM credit_note_lines l JOIN credit_notes n ON n.id=l.credit_note_id
      WHERE l.invoice_line_id=$1 AND n.status='issued'`, [invoiceLineId])).rows[0];
  return { qty: Number(r.qty), net: Number(r.net) };
}

/** Draft a credit note against an issued invoice. `full` credits everything not already credited. Nothing changes on the invoice until a second person issues it. */
export async function draftCreditNote(c: Conn, ctx: Ctx, invoiceId: string, f: { reason: string; full?: boolean; lines?: CreditLineInput[] }) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const inv = await must(c.query<any>(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [recordId(invoiceId, "Invoice")]), "Invoice");
  if (["void", "credited"].includes(inv.status)) throw badRequest(`This invoice is ${inv.status}.`);
  if (Number(inv.balance_minor) <= 0) throw badRequest("This invoice has nothing outstanding to credit. Reverse the receipt, or arrange a refund outside this system.");
  const reason = reqStr(f.reason, "Reason for the credit", 500);
  const invLines = (await c.query<any>(`SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id`, [inv.id])).rows;
  const out: { invoice_line_id: string | null; description: string; qty: number; unit_minor: number; tax_code: string; net: number; tax: number }[] = [];
  if (f.full) {
    for (const l of invLines) {
      const done = await creditedSoFar(c, l.id), qty = Math.round((Number(l.qty) - done.qty) * 1000) / 1000;
      if (qty <= 0) continue;
      const net = Number(l.net_minor) - done.net;
      if (net <= 0) continue;
      const unit = Math.round(net / qty);
      out.push({ invoice_line_id: l.id, description: l.description, qty, unit_minor: unit, tax_code: l.tax_code, net, tax: taxFor(net, l.tax_code) });
    }
  } else {
    if (!f.lines?.length) throw badRequest("Add at least one line to credit.");
    for (const [i, x] of f.lines.entries()) {
      const qty = Number(x.qty);
      if (!(qty > 0)) throw badRequest(`Line ${i + 1}: quantity must be above zero.`);
      if (x.invoice_line_id) {
        const l = invLines.find((y: any) => y.id === x.invoice_line_id);
        if (!l) throw badRequest(`Line ${i + 1}: that is not a line of this invoice.`);
        const done = await creditedSoFar(c, l.id);
        if (qty > Number(l.qty) - done.qty + 1e-9) throw badRequest(`Line ${i + 1}: only ${Math.round((Number(l.qty) - done.qty) * 1000) / 1000} left to credit on “${l.description}”.`);
        const unit = x.unit === undefined || x.unit === "" ? Number(l.unit_minor) : typeof x.unit === "number" ? Math.round(x.unit) : toMinor(x.unit);
        if (unit > Number(l.unit_minor)) throw badRequest(`Line ${i + 1}: a credit cannot be priced above the invoiced unit price.`);
        const net = lineNet(qty, unit);
        if (net + done.net > Number(l.net_minor)) throw badRequest(`Line ${i + 1}: this would credit more than the line's invoiced value.`);
        out.push({ invoice_line_id: l.id, description: String(x.description || l.description), qty, unit_minor: unit, tax_code: l.tax_code, net, tax: taxFor(net, l.tax_code) });
      } else {
        const code = x.tax_code && TAX_CODES[x.tax_code] ? x.tax_code : null;
        if (!code) throw badRequest(`Line ${i + 1}: choose a tax code for a line that is not on the invoice.`);
        const unit = typeof x.unit === "number" ? Math.round(x.unit) : toMinor(x.unit ?? 0);
        const net = lineNet(qty, unit);
        out.push({ invoice_line_id: null, description: reqStr(x.description, `Line ${i + 1} description`, 300), qty, unit_minor: unit, tax_code: code, net, tax: taxFor(net, code) });
      }
    }
  }
  if (!out.length) throw badRequest("Everything on this invoice has already been credited.");
  const sub = out.reduce((a, l) => a + l.net, 0), tax = out.reduce((a, l) => a + l.tax, 0);
  if (sub + tax > Number(inv.balance_minor)) throw badRequest(f.full
    ? `A full credit would be ${((sub + tax) / 100).toFixed(2)} but only ${(Number(inv.balance_minor) / 100).toFixed(2)} is outstanding (part of the invoice has been paid or credited without being allocated to lines). Credit specific lines or amounts instead.`
    : `The credit (${((sub + tax) / 100).toFixed(2)}) exceeds the invoice's outstanding balance (${(Number(inv.balance_minor) / 100).toFixed(2)}).`);
  const id = (await c.query<any>(
    `INSERT INTO credit_notes(tenant_id,invoice_id,entity_id,party_id,currency,reason,subtotal_minor,tax_minor,total_minor,drafted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, inv.id, inv.entity_id, inv.party_id, inv.currency, reason, sub, tax, sub + tax, ctx.userId])).rows[0].id;
  for (const l of out) await c.query(`INSERT INTO credit_note_lines(tenant_id,credit_note_id,invoice_line_id,description,qty,unit_minor,tax_code,net_minor,tax_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ctx.tenantId, id, l.invoice_line_id, l.description, l.qty, l.unit_minor, l.tax_code, l.net, l.tax]);
  await audit(c, ctx.tenantId, actorOf(ctx), "credit_note.drafted", "credit_note", id, { invoice: inv.no, total: sub + tax });
  return id as string;
}

export async function issueCreditNote(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "finance.void");
  await assertWritable(c, ctx.tenantId);
  const n = await must(c.query<any>(`SELECT * FROM credit_notes WHERE id=$1 FOR UPDATE`, [recordId(id, "Credit note")]), "Credit note");
  if (n.status !== "draft") return { no: n.no, already: true };
  if (n.drafted_by === ctx.userId && !isOwner(ctx)) throw badRequest("A credit note must be issued by someone other than the person who drafted it.");
  const inv = await must(c.query<any>(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [n.invoice_id]), "Invoice");
  if (["void", "credited"].includes(inv.status)) throw badRequest(`The invoice is now ${inv.status}.`);
  if (Number(n.total_minor) > Number(inv.balance_minor)) throw badRequest("The invoice's outstanding balance is now lower than this credit. Cancel the draft and draft it again.");
  // line caps are re-checked at issue: another credit may have been issued since the draft
  for (const l of (await c.query<any>(`SELECT * FROM credit_note_lines WHERE credit_note_id=$1 AND invoice_line_id IS NOT NULL`, [n.id])).rows) {
    const il = (await c.query<any>(`SELECT qty, net_minor FROM invoice_lines WHERE id=$1`, [l.invoice_line_id])).rows[0], done = await creditedSoFar(c, l.invoice_line_id);
    if (Number(l.qty) + done.qty > Number(il.qty) + 1e-9 || Number(l.net_minor) + done.net > Number(il.net_minor)) throw badRequest("Another credit note has used up part of a line on this draft. Cancel it and draft it again.");
  }
  const no = await nextNumber(c, ctx.tenantId, "credit_note", "CN");
  const conn = (await c.query<any>(`SELECT status FROM accounting_connections`)).rows[0];
  const sync = conn && ["connected", "live", "validating"].includes(conn.status) ? "pending" : "not_connected";
  await c.query(`UPDATE credit_notes SET status='issued', no=$2, issued_by=$3, issued_at=now(), sync_status=$4 WHERE id=$1`, [n.id, no, ctx.userId, sync]);
  const credited = Number(inv.credited_minor) + Number(n.total_minor), status = settledStatus(Number(inv.total_minor), Number(inv.paid_minor), credited);
  await c.query(`UPDATE invoices SET credited_minor=$2, status=$3 WHERE id=$1`, [inv.id, credited, status]);
  await refreshCollection(c, inv, status);
  if (sync === "pending") await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'accounting.credit_note',$2,$3) ON CONFLICT (key) DO NOTHING`, [ctx.tenantId, `credit-note:${n.id}`, JSON.stringify({ creditNoteId: n.id })]);
  await audit(c, ctx.tenantId, actorOf(ctx), "credit_note.issued", "credit_note", n.id, { no, invoice: inv.no, total: n.total_minor });
  return { no, already: false };
}

export async function cancelCreditNote(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "finance.write");
  const n = await must(c.query<any>(`SELECT * FROM credit_notes WHERE id=$1 FOR UPDATE`, [recordId(id, "Credit note")]), "Credit note");
  if (n.status !== "draft") throw badRequest("Only a draft can be cancelled; an issued credit note is final.");
  await c.query(`UPDATE credit_notes SET status='cancelled' WHERE id=$1`, [n.id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "credit_note.cancelled", "credit_note", n.id);
}

export async function listCreditNotes(c: Conn, invoiceId?: string) {
  return (await c.query<any>(
    `SELECT n.*, i.no AS invoice_no, p.name AS party_name FROM credit_notes n JOIN invoices i ON i.id=n.invoice_id JOIN parties p ON p.id=n.party_id WHERE ($1::uuid IS NULL OR n.invoice_id=$1) ORDER BY n.created_at DESC LIMIT 300`, [invoiceId || null])).rows;
}
export async function getCreditNote(c: Conn, id: string) {
  const n = await must(c.query<any>(`SELECT n.*, i.no AS invoice_no, p.name AS party_name, e.legal_name, e.name AS entity_name, e.tax_id AS entity_tax_id FROM credit_notes n JOIN invoices i ON i.id=n.invoice_id JOIN parties p ON p.id=n.party_id JOIN entities e ON e.id=n.entity_id WHERE n.id=$1`, [recordId(id, "Credit note")]), "Credit note");
  return { note: n, lines: (await c.query<any>(`SELECT * FROM credit_note_lines WHERE credit_note_id=$1 ORDER BY id`, [n.id])).rows };
}

// ═════════════ Approved exchange rates
export async function baseCurrency(c: Conn): Promise<string> {
  return (await c.query<any>(`SELECT currency FROM entities ORDER BY created_at LIMIT 1`)).rows[0].currency;
}
export async function proposeRate(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const from = String(f.from_ccy ?? "").toUpperCase(), base = await baseCurrency(c), rate = Number(f.rate);
  if (!CCY.test(from) || from === base) throw badRequest(`Choose a foreign currency to convert into ${base}.`);
  if (!(rate > 0) || rate >= 1e6 || Math.abs(rate * 1e8 - Math.round(rate * 1e8)) > 1e-6) throw badRequest("Enter a positive rate with at most eight decimals.");
  const asOf = String(f.as_of ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf > today()) throw badRequest("The rate's date cannot be in the future.");
  const source = reqStr(f.source, "Rate source (e.g. central bank bulletin, bank confirmation)", 300);
  const dup = await c.query(`SELECT 1 FROM fx_rates WHERE from_ccy=$1 AND to_ccy=$2 AND as_of=$3`, [from, base, asOf]);
  if (dup.rows.length) throw badRequest("A rate for that currency and date already exists.");
  const id = (await c.query<any>(`INSERT INTO fx_rates(tenant_id,from_ccy,to_ccy,rate,as_of,source,entered_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, from, base, rate, asOf, source, ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "fx_rate.proposed", "fx_rate", id, { from, rate, asOf });
  return id as string;
}
export async function decideRate(c: Conn, ctx: Ctx, id: string, approve: boolean) {
  require(ctx, "finance.void");
  const r = await must(c.query<any>(`SELECT * FROM fx_rates WHERE id=$1 FOR UPDATE`, [recordId(id, "Rate")]), "Rate");
  if (r.status !== "proposed") throw badRequest(`This rate is already ${r.status}.`);
  if (r.entered_by === ctx.userId && !isOwner(ctx)) throw badRequest("Exchange rates are approved by someone other than the person who entered them.");
  await c.query(`UPDATE fx_rates SET status=$2, approved_by=$3, decided_at=now() WHERE id=$1`, [r.id, approve ? "approved" : "rejected", ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), approve ? "fx_rate.approved" : "fx_rate.rejected", "fx_rate", r.id);
}
export async function rateOn(c: Conn, ccy: string, onDate: string): Promise<{ rate: number; as_of: string; id: string } | null> {
  const base = await baseCurrency(c);
  if (ccy === base) return { rate: 1, as_of: onDate, id: "" };
  const r = (await c.query<any>(`SELECT id, rate::float8 AS rate, as_of FROM fx_rates WHERE from_ccy=$1 AND to_ccy=$2 AND status='approved' AND as_of<=$3 ORDER BY as_of DESC LIMIT 1`, [ccy, base, onDate])).rows[0];
  return r ? { rate: Number(r.rate), as_of: day(r.as_of), id: r.id } : null;
}
export async function listRates(c: Conn) {
  return (await c.query<any>(`SELECT f.*, f.rate::float8 AS rate_n, u.name AS entered_name FROM fx_rates f LEFT JOIN team_members u ON u.user_id=f.entered_by ORDER BY f.as_of DESC, f.from_ccy LIMIT 300`)).rows;
}

// ═════════════ Supplier bills and payments
export interface BillLineInput { description: string; net: number | string; tax_code?: string; job_cost_id?: string | null }
const VARIANCE_BPS = 500;
const conv = (minor: number, rate: number) => Math.round(minor * rate);

export async function enterBill(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const sup = await must(c.query<any>(`SELECT id, kind, name FROM parties WHERE id=$1`, [recordId(f.supplier_id, "Supplier")]), "Supplier");
  if (sup.kind === "customer") throw badRequest("Bills are entered against suppliers and agents.");
  const ref = reqStr(f.supplier_ref, "Supplier's invoice number", 100);
  const ccy = String(f.currency ?? "").toUpperCase(), base = await baseCurrency(c);
  if (!CCY.test(ccy)) throw badRequest("Enter the bill's three-letter currency.");
  const billDate = String(f.bill_date ?? ""), dueDate = String(f.due_date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate < billDate) throw badRequest("Enter the bill date and a due date on or after it.");
  if (billDate > today()) throw badRequest("The bill date cannot be in the future.");
  const dup = await c.query(`SELECT no FROM vendor_bills WHERE supplier_id=$1 AND lower(supplier_ref)=lower($2) AND status<>'void'`, [sup.id, ref]);
  if (dup.rows.length) throw badRequest(`${sup.name}'s invoice ${ref} is already recorded as ${dup.rows[0].no}.`);
  if (!f.lines?.length) throw badRequest("Add at least one bill line.");
  const lines = [] as { description: string; net: number; tax_code: string; tax: number; job_cost_id: string | null }[];
  const seen = new Set<string>();
  for (const [i, l] of (f.lines as BillLineInput[]).entries()) {
    const net = typeof l.net === "number" ? Math.round(l.net) : toMinor(l.net);
    if (!(net > 0)) throw badRequest(`Line ${i + 1}: enter an amount above zero.`);
    const code = l.tax_code && TAX_CODES[l.tax_code] ? l.tax_code : "SR5";
    let costId: string | null = null;
    if (l.job_cost_id) {
      if (seen.has(l.job_cost_id)) throw badRequest(`Line ${i + 1}: that job cost is already on this bill.`);
      seen.add(l.job_cost_id);
      const k = await must(c.query<any>(`SELECT * FROM job_costs WHERE id=$1`, [recordId(l.job_cost_id, "Job cost")]), "Job cost");
      if (k.status === "posted") throw badRequest(`Line ${i + 1}: that cost is already reconciled to a supplier invoice.`);
      if (k.supplier_id && k.supplier_id !== sup.id) throw badRequest(`Line ${i + 1}: that cost belongs to a different supplier.`);
      if ((await c.query(`SELECT 1 FROM vendor_bill_lines vl JOIN vendor_bills b ON b.id=vl.bill_id WHERE vl.job_cost_id=$1 AND b.status<>'void'`, [k.id])).rows.length) throw badRequest(`Line ${i + 1}: that cost is already on another bill.`);
      costId = k.id;
    }
    lines.push({ description: reqStr(l.description, `Line ${i + 1} description`, 300), net, tax_code: code, tax: taxFor(net, code), job_cost_id: costId });
  }
  const sub = lines.reduce((a, l) => a + l.net, 0), tax = lines.reduce((a, l) => a + l.tax, 0);
  const ent = (await c.query<any>(`SELECT id FROM entities ORDER BY created_at LIMIT 1`)).rows[0];
  const no = await nextNumber(c, ctx.tenantId, "vendor_bill", "VB");
  const id = (await c.query<any>(
    `INSERT INTO vendor_bills(tenant_id,entity_id,no,supplier_id,supplier_ref,bill_date,due_date,currency,base_currency,subtotal_minor,tax_minor,total_minor,document_id,entered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ctx.tenantId, ent.id, no, sup.id, ref, billDate, dueDate, ccy, base, sub, tax, sub + tax, f.document_id || null, ctx.userId])).rows[0].id;
  for (const l of lines) await c.query(`INSERT INTO vendor_bill_lines(tenant_id,bill_id,description,net_minor,tax_code,tax_minor,job_cost_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ctx.tenantId, id, l.description, l.net, l.tax_code, l.tax, l.job_cost_id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "vendor_bill.entered", "vendor_bill", id, { no, supplier: sup.id, total: sub + tax, currency: ccy });
  return { id: id as string, no };
}

export async function attachBillDocument(c: Conn, ctx: Ctx, id: string, documentId: string) {
  require(ctx, "finance.write");
  const b = await must(c.query<any>(`SELECT * FROM vendor_bills WHERE id=$1 FOR UPDATE`, [recordId(id, "Bill")]), "Bill");
  if (b.status !== "draft") throw badRequest("Evidence can only be attached while the bill is a draft.");
  await must(c.query(`SELECT id FROM documents WHERE id=$1 AND status='issued' AND NOT hold`, [recordId(documentId, "Supplier invoice document")]), "Issued supplier invoice document");
  await c.query(`UPDATE vendor_bills SET document_id=$2 WHERE id=$1`, [b.id, documentId]);
}

export async function approveBill(c: Conn, ctx: Ctx, id: string, f: { variance_note?: string } = {}) {
  require(ctx, "finance.void");
  await assertWritable(c, ctx.tenantId);
  const b = await must(c.query<any>(`SELECT * FROM vendor_bills WHERE id=$1 FOR UPDATE`, [recordId(id, "Bill")]), "Bill");
  if (b.status !== "draft") throw badRequest(`This bill is ${b.status}.`);
  if (b.entered_by === ctx.userId && !isOwner(ctx)) throw badRequest("A bill is approved by someone other than the person who entered it.");
  if (!b.document_id) throw badRequest("Attach the supplier's invoice as evidence before approving.");
  const doc = await c.query(`SELECT 1 FROM documents WHERE id=$1 AND status='issued' AND NOT hold`, [b.document_id]);
  if (!doc.rows.length) throw badRequest("The attached supplier invoice is on hold or not issued.");
  const fx = await rateOn(c, b.currency, day(b.bill_date));
  if (!fx) throw badRequest(`No approved ${b.currency} → ${b.base_currency} exchange rate on or before ${day(b.bill_date)}. Propose and approve one first.`);
  const lines = (await c.query<any>(`SELECT l.*, k.estimated_minor AS est, k.status AS cost_status FROM vendor_bill_lines l LEFT JOIN job_costs k ON k.id=l.job_cost_id WHERE l.bill_id=$1 ORDER BY l.id`, [b.id])).rows;
  let baseTotal = 0, baseTax = 0, needNote = false;
  for (const l of lines) {
    const bn = conv(Number(l.net_minor), fx.rate), bt = conv(Number(l.tax_minor), fx.rate);
    baseTotal += bn + bt; baseTax += bt;
    if (l.job_cost_id) {
      if (l.cost_status === "posted") throw badRequest("A linked job cost was reconciled elsewhere since this bill was entered.");
      const est = Number(l.est);
      if (est > 0 && Math.abs(bn - est) > Math.max(100, Math.round((est * VARIANCE_BPS) / 10_000))) needNote = true;
    }
  }
  const note = optStr(f.variance_note, 500);
  if (needNote && !note) throw badRequest("A linked cost differs from its estimate by more than 5%. Record why in the variance note to approve.");
  for (const l of lines) if (l.job_cost_id) {
    await c.query(`UPDATE job_costs SET actual_minor=$2, supplier_invoice_ref=$3, status='posted' WHERE id=$1`, [l.job_cost_id, conv(Number(l.net_minor), fx.rate), b.supplier_ref]);
  }
  await c.query(`UPDATE vendor_bills SET status='approved', approved_by=$2, approved_at=now(), fx_rate=$3, base_total_minor=$4, base_tax_minor=$5, variance_note=$6 WHERE id=$1`, [b.id, ctx.userId, fx.rate, baseTotal, baseTax, note]);
  await audit(c, ctx.tenantId, actorOf(ctx), "vendor_bill.approved", "vendor_bill", b.id, { no: b.no, rate: fx.rate, rate_as_of: fx.as_of, base_total: baseTotal });
}

export async function payBill(c: Conn, ctx: Ctx, id: string, f: Record<string, any>) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const b = await must(c.query<any>(`SELECT * FROM vendor_bills WHERE id=$1 FOR UPDATE`, [recordId(id, "Bill")]), "Bill");
  if (!["approved", "part_paid"].includes(b.status)) throw badRequest(`A ${b.status} bill cannot be paid.`);
  const amount = toMinor(f.amount), balance = Number(b.total_minor) - Number(b.paid_minor);
  if (!(amount > 0)) throw badRequest("Enter the amount paid.");
  if (amount > balance) throw badRequest("The payment exceeds what is outstanding on this bill.");
  const paidOn = String(f.paid_on || today());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn < day(b.bill_date) || paidOn > today()) throw badRequest("Enter a payment date between the bill date and today.");
  const fx = await rateOn(c, b.currency, paidOn);
  if (!fx) throw badRequest(`No approved ${b.currency} → ${b.base_currency} exchange rate on or before ${paidOn}.`);
  const prior = (await c.query<any>(`SELECT coalesce(sum(base_bill_minor),0)::bigint AS n FROM vendor_payments WHERE bill_id=$1`, [b.id])).rows[0].n;
  const finalPayment = amount === balance;
  // the bill's base value is released in proportion to what is paid; the last payment takes the remainder so the parts add up exactly
  const baseBill = finalPayment ? Number(b.base_total_minor) - Number(prior) : Math.round((Number(b.base_total_minor) * amount) / Number(b.total_minor));
  const basePaid = conv(amount, fx.rate);
  await c.query(`INSERT INTO vendor_payments(tenant_id,bill_id,amount_minor,paid_on,method,reference,fx_rate_paid,base_paid_minor,base_bill_minor,fx_gain_loss_minor,paid_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [ctx.tenantId, b.id, amount, paidOn, reqStr(f.method || "bank transfer", "Method", 40), optStr(f.reference, 120), fx.rate, basePaid, baseBill, baseBill - basePaid, ctx.userId]);
  const paid = Number(b.paid_minor) + amount;
  await c.query(`UPDATE vendor_bills SET paid_minor=$2, status=$3 WHERE id=$1`, [b.id, paid, paid >= Number(b.total_minor) ? "paid" : "part_paid"]);
  await audit(c, ctx.tenantId, actorOf(ctx), "vendor_bill.paid", "vendor_bill", b.id, { amount, rate: fx.rate });
  return { status: paid >= Number(b.total_minor) ? "paid" : "part_paid", fx_gain_loss_minor: baseBill - basePaid };
}

export async function voidBill(c: Conn, ctx: Ctx, id: string, reason: string) {
  require(ctx, "finance.void");
  const b = await must(c.query<any>(`SELECT * FROM vendor_bills WHERE id=$1 FOR UPDATE`, [recordId(id, "Bill")]), "Bill");
  if (b.status === "void") throw badRequest("Already void.");
  if (Number(b.paid_minor) > 0) throw badRequest("This bill has payments; it cannot be voided.");
  await c.query(`UPDATE job_costs SET actual_minor=NULL, supplier_invoice_ref=NULL, status='estimated' WHERE status='posted' AND id IN (SELECT job_cost_id FROM vendor_bill_lines WHERE bill_id=$1 AND job_cost_id IS NOT NULL) AND supplier_invoice_ref=$2`, [b.id, b.supplier_ref]);
  await c.query(`UPDATE vendor_bills SET status='void', void_reason=$2 WHERE id=$1`, [b.id, reqStr(reason, "Reason", 300)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "vendor_bill.voided", "vendor_bill", b.id);
}

export async function listBills(c: Conn, status?: string) {
  return (await c.query<any>(
    `SELECT b.*, p.name AS supplier_name, (b.due_date < current_date AND b.status IN ('approved','part_paid')) AS overdue FROM vendor_bills b JOIN parties p ON p.id=b.supplier_id
      WHERE ($1::text IS NULL OR b.status=$1) ORDER BY b.created_at DESC LIMIT 300`, [status || null])).rows;
}
export async function getBill(c: Conn, id: string) {
  const b = await must(c.query<any>(`SELECT b.*, p.name AS supplier_name FROM vendor_bills b JOIN parties p ON p.id=b.supplier_id WHERE b.id=$1`, [recordId(id, "Bill")]), "Bill");
  const [lines, payments] = await Promise.all([
    c.query<any>(`SELECT l.*, k.description AS cost_description, j.no AS job_no FROM vendor_bill_lines l LEFT JOIN job_costs k ON k.id=l.job_cost_id LEFT JOIN jobs j ON j.id=k.job_id WHERE l.bill_id=$1 ORDER BY l.id`, [b.id]),
    c.query<any>(`SELECT * FROM vendor_payments WHERE bill_id=$1 ORDER BY paid_on, created_at`, [b.id]),
  ]);
  return { bill: b, lines: lines.rows, payments: payments.rows };
}

// ═════════════ Reports and reconciliation
export async function payablesReport(c: Conn, asOf = today()) {
  const rows = (await c.query<any>(
    `SELECT b.id, b.no, b.supplier_ref, b.currency, b.due_date, b.fx_rate::float8 AS fx_rate, p.name AS supplier,
            (b.total_minor - b.paid_minor)::bigint AS outstanding,
            (b.base_total_minor - coalesce((SELECT sum(base_bill_minor) FROM vendor_payments x WHERE x.bill_id=b.id),0))::bigint AS base_outstanding
       FROM vendor_bills b JOIN parties p ON p.id=b.supplier_id WHERE b.status IN ('approved','part_paid') ORDER BY b.due_date`)).rows;
  const out = [] as any[];
  for (const r of rows) {
    const fx = await rateOn(c, r.currency, asOf);
    const dpd = Math.floor((Date.parse(asOf) - Date.parse(day(r.due_date))) / 86400000);
    const bucket = dpd <= 0 ? "current" : dpd <= 30 ? "1-30" : dpd <= 60 ? "31-60" : "60+";
    const baseNow = fx ? conv(Number(r.outstanding), fx.rate) : null;
    out.push({ ...r, outstanding: Number(r.outstanding), base_outstanding: Number(r.base_outstanding), bucket, base_now: baseNow, rate_now: fx?.rate ?? null, rate_now_as_of: fx?.as_of ?? null,
      unrealised_gain_loss: baseNow == null ? null : Number(r.base_outstanding) - baseNow });
  }
  const byCcy = new Map<string, { currency: string; outstanding: number; base_outstanding: number; unrealised: number | null }>();
  for (const r of out) {
    const x = byCcy.get(r.currency) ?? { currency: r.currency, outstanding: 0, base_outstanding: 0, unrealised: 0 };
    x.outstanding += r.outstanding; x.base_outstanding += r.base_outstanding;
    x.unrealised = x.unrealised == null || r.unrealised_gain_loss == null ? null : x.unrealised + r.unrealised_gain_loss;
    byCcy.set(r.currency, x);
  }
  return { asOf, base: await baseCurrency(c), bills: out, totals: [...byCcy.values()] };
}

export async function inputVatReport(c: Conn, from: string, to: string) {
  const r = (await c.query<any>(
    `SELECT l.tax_code, b.currency, sum(l.net_minor)::bigint AS net, sum(l.tax_minor)::bigint AS tax, sum(round(l.tax_minor * b.fx_rate))::bigint AS base_tax, sum(round(l.net_minor * b.fx_rate))::bigint AS base_net
       FROM vendor_bill_lines l JOIN vendor_bills b ON b.id=l.bill_id WHERE b.status IN ('approved','part_paid','paid') AND b.bill_date BETWEEN $1 AND $2 GROUP BY l.tax_code, b.currency ORDER BY l.tax_code, b.currency`, [from, to])).rows;
  return r.map((x: any) => ({ ...x, net: Number(x.net), tax: Number(x.tax), base_tax: Number(x.base_tax), base_net: Number(x.base_net) }));
}
export async function realisedFx(c: Conn, from: string, to: string) {
  return (await c.query<any>(`SELECT b.currency, count(*)::int AS payments, sum(p.fx_gain_loss_minor)::bigint AS gain_loss FROM vendor_payments p JOIN vendor_bills b ON b.id=p.bill_id WHERE p.paid_on BETWEEN $1 AND $2 GROUP BY b.currency ORDER BY b.currency`, [from, to])).rows
    .map((x: any) => ({ ...x, gain_loss: Number(x.gain_loss) }));
}

/**
 * Independent cross-check of the sub-ledgers: each stored balance is recomputed from the underlying receipts, reversals, credit notes, bills and payments.
 * A non-empty `differences` list means the stored balances and the ledgers disagree and needs a person.
 */
export async function subledgerReconciliation(c: Conn) {
  const ar = (await c.query<any>(
    `SELECT i.currency,
        sum(i.total_minor)::bigint AS invoiced,
        coalesce(sum((SELECT sum(r.amount_minor) FROM receipts r WHERE r.invoice_id=i.id AND NOT EXISTS (SELECT 1 FROM receipt_reversals v WHERE v.receipt_id=r.id))),0)::bigint AS receipts,
        coalesce(sum((SELECT sum(n.total_minor) FROM credit_notes n WHERE n.invoice_id=i.id AND n.status='issued')),0)::bigint AS credits,
        sum(i.balance_minor)::bigint AS stored_balance
       FROM invoices i WHERE i.status<>'void' GROUP BY i.currency ORDER BY i.currency`)).rows.map((r: any) => ({ currency: r.currency, invoiced: Number(r.invoiced), receipts: Number(r.receipts), credits: Number(r.credits), stored_balance: Number(r.stored_balance), computed_balance: Number(r.invoiced) - Number(r.receipts) - Number(r.credits) }));
  const ap = (await c.query<any>(
    `SELECT b.currency, sum(b.total_minor)::bigint AS billed, coalesce(sum((SELECT sum(p.amount_minor) FROM vendor_payments p WHERE p.bill_id=b.id)),0)::bigint AS payments, sum(b.total_minor - b.paid_minor)::bigint AS stored_balance
       FROM vendor_bills b WHERE b.status IN ('approved','part_paid','paid') GROUP BY b.currency ORDER BY b.currency`)).rows.map((r: any) => ({ currency: r.currency, billed: Number(r.billed), payments: Number(r.payments), stored_balance: Number(r.stored_balance), computed_balance: Number(r.billed) - Number(r.payments) }));
  const differences = [
    ...ar.filter((x) => x.stored_balance !== x.computed_balance).map((x) => `Receivables ${x.currency}: stored ${x.stored_balance} vs recomputed ${x.computed_balance}`),
    ...ap.filter((x) => x.stored_balance !== x.computed_balance).map((x) => `Payables ${x.currency}: stored ${x.stored_balance} vs recomputed ${x.computed_balance}`),
  ];
  return { ar, ap, differences, note: "Sub-ledger reconciliation only. This is not a general ledger or trial balance; the books remain in the accounting system of record." };
}
