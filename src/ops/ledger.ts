import type { Conn, Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr, today } from "./common.js";
import { FX_RATE_MAX_AGE_DAYS } from "./finance.js";
import { rateOn } from "./finance-bridge.js";

/**
 * Native general ledger. Operational events (an invoice issued, cash received, a credit note, a supplier bill approved or paid, and their reversals) are projected
 * into balanced double-entry journals by an idempotent posting pass; each source can be journalled once, so running it twice changes nothing. Manual adjusting
 * entries are proposed by one person and approved by another. Journals are immutable and numbered without gaps; a correction is a reversing journal. The ledger
 * begins on the date it is enabled — earlier balances enter as an opening-balance manual entry. Amounts are in the entity's base currency.
 *
 * This is a bookkeeping ledger, not a statutory financial statement: chart-of-accounts design, period close, tax filing and the audit remain the controller's.
 */
export type Role = "bank" | "ar" | "input_vat" | "ap" | "output_vat" | "revenue" | "cost" | "fx";
export const DEFAULT_CHART: { code: string; name: string; kind: "asset" | "liability" | "equity" | "income" | "expense"; role?: Role }[] = [
  { code: "1000", name: "Bank and cash", kind: "asset", role: "bank" }, { code: "1100", name: "Accounts receivable", kind: "asset", role: "ar" }, { code: "1200", name: "Input VAT recoverable", kind: "asset", role: "input_vat" },
  { code: "2000", name: "Accounts payable", kind: "liability", role: "ap" }, { code: "2100", name: "Output VAT payable", kind: "liability", role: "output_vat" },
  { code: "3000", name: "Owner's equity", kind: "equity" }, { code: "4000", name: "Service revenue", kind: "income", role: "revenue" },
  { code: "5000", name: "Cost of services", kind: "expense", role: "cost" }, { code: "5900", name: "Foreign exchange gain / loss", kind: "expense", role: "fx" },
];
interface Line { role?: Role; account_id?: string; debit?: number; credit?: number; memo?: string }
const money = (m: unknown) => Number(m) || 0;
const day = (d: unknown) => (typeof d === "string" ? d : new Date(d as any).toISOString()).slice(0, 10);

export async function ledgerSettings(c: Conn) { return (await c.query<any>(`SELECT * FROM gl_settings`)).rows[0] ?? null; }
export async function enableLedger(c: Conn, ctx: Ctx, startDate: string) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(startDate))) throw badRequest("Enter the date the ledger starts, as YYYY-MM-DD.");
  if (startDate > today()) throw badRequest("The ledger cannot start in the future.");
  if (await ledgerSettings(c)) throw badRequest("The general ledger is already enabled; its start date cannot be changed.");
  await c.query(`INSERT INTO gl_settings(tenant_id,start_date,enabled_by) VALUES ($1,$2,$3)`, [ctx.tenantId, startDate, ctx.userId]);
  for (const a of DEFAULT_CHART) await c.query(`INSERT INTO gl_accounts(tenant_id,code,name,kind,role) VALUES ($1,$2,$3,$4,$5)`, [ctx.tenantId, a.code, a.name, a.kind, a.role ?? null]);
  await audit(c, ctx.tenantId, actorOf(ctx), "ledger.enabled", "tenant", ctx.tenantId, { startDate });
}
export async function addAccount(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "settings.manage");
  const kind = String(f.kind);
  if (!["asset", "liability", "equity", "income", "expense"].includes(kind)) throw badRequest("Choose asset, liability, equity, income or expense.");
  const code = reqStr(f.code, "Account code", 12);
  if (!/^[0-9A-Za-z.-]{1,12}$/.test(code)) throw badRequest("The account code is letters, digits, dots and hyphens.");
  if (!(await ledgerSettings(c))) throw badRequest("Enable the general ledger first.");
  if ((await c.query(`SELECT 1 FROM gl_accounts WHERE code=$1`, [code])).rows.length) throw badRequest("That account code is already used.");
  const id = (await c.query<any>(`INSERT INTO gl_accounts(tenant_id,code,name,kind) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.tenantId, code, reqStr(f.name, "Account name", 120), kind])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "ledger.account_added", "gl_account", id, { code });
  return id as string;
}
export const listAccounts = (c: Conn) => c.query<any>(`SELECT * FROM gl_accounts ORDER BY code`).then((r) => r.rows);

async function accountIds(c: Conn): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const a of (await c.query<any>(`SELECT id, role FROM gl_accounts WHERE role IS NOT NULL`)).rows) m.set(a.role, a.id);
  return m;
}
/** Writes one balanced journal. The same (source_type, source_id) is never journalled twice; a journal that does not balance is refused before it reaches the database. */
export async function postJournal(c: Conn, tenantId: string, userId: string | null, j: { posted_on: string; source_type: string; source_id: string; memo: string; lines: Line[] }, roles?: Map<string, string>): Promise<string | null> {
  const ids = roles ?? await accountIds(c);
  if ((await c.query(`SELECT 1 FROM gl_journals WHERE source_type=$1 AND source_id=$2`, [j.source_type, j.source_id])).rows.length) return null;
  const lines = j.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  const dr = lines.reduce((a, l) => a + (l.debit ?? 0), 0), cr = lines.reduce((a, l) => a + (l.credit ?? 0), 0);
  if (dr !== cr || lines.length < 2) throw badRequest(`Journal ${j.source_type}:${j.source_id} does not balance (debits ${dr}, credits ${cr}).`);
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${tenantId}:gl-number`]);
  const no = Number((await c.query<any>(`SELECT coalesce(max(no),0)+1 AS n FROM gl_journals`)).rows[0].n);
  const id = (await c.query<any>(`INSERT INTO gl_journals(tenant_id,no,posted_on,source_type,source_id,memo,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [tenantId, no, j.posted_on, j.source_type, j.source_id, j.memo.slice(0, 300), userId])).rows[0].id;
  for (const l of lines) {
    const acct = l.account_id ?? (l.role ? ids.get(l.role) : undefined);
    if (!acct) throw badRequest(`No ledger account for ${l.role}.`);
    await c.query(`INSERT INTO gl_lines(tenant_id,journal_id,account_id,debit_minor,credit_minor,memo) VALUES ($1,$2,$3,$4,$5,$6)`, [tenantId, id, acct, l.debit ?? 0, l.credit ?? 0, l.memo ?? null]);
  }
  return id as string;
}

/** A realised exchange difference: positive = gain (credit to the FX account), negative = loss. */
const fxLine = (gain: number): Line[] => (gain > 0 ? [{ role: "fx", credit: gain }] : gain < 0 ? [{ role: "fx", debit: -gain }] : []);
const has = (type: string, idExpr: string) => `EXISTS (SELECT 1 FROM gl_journals g WHERE g.source_type='${type}' AND g.source_id=${idExpr}::text)`;
/** The idempotent posting pass. Returns how many journals were written. */
export async function postPending(c: Conn, tenantId: string, userId: string | null, limit = 500): Promise<number> {
  const st = await ledgerSettings(c);
  if (!st) return 0;
  const start = day(st.start_date), roles = await accountIds(c);
  let n = 0;
  const post = async (j: Parameters<typeof postJournal>[3]) => { if (await postJournal(c, tenantId, userId, j, roles)) n++; };
  const left = () => limit - n;
  // sales
  for (const i of (await c.query<any>(`SELECT id, no, issued_at::date AS d, subtotal_minor, tax_minor, total_minor FROM invoices WHERE issued_at::date >= $1 AND NOT ${has("invoice", "invoices.id")} ORDER BY issued_at, no LIMIT $2`, [start, left()])).rows)
    await post({ posted_on: day(i.d), source_type: "invoice", source_id: i.id, memo: `Invoice ${i.no}`, lines: [{ role: "ar", debit: money(i.total_minor) }, { role: "revenue", credit: money(i.subtotal_minor) }, { role: "output_vat", credit: money(i.tax_minor) }] });
  if (left() > 0) for (const r of (await c.query<any>(`SELECT r.id, r.received_at AS d, r.amount_minor, coalesce(r.cash_minor, r.amount_minor) AS cash_minor, i.no FROM receipts r JOIN invoices i ON i.id=r.invoice_id WHERE r.received_at >= $1 AND ${has("invoice", "i.id")} AND NOT ${has("receipt", "r.id")} ORDER BY r.received_at LIMIT $2`, [start, left()])).rows)
    await post({ posted_on: day(r.d), source_type: "receipt", source_id: r.id, memo: `Receipt against ${r.no}`, lines: [{ role: "bank", debit: money(r.cash_minor) }, { role: "ar", credit: money(r.amount_minor) }, ...fxLine(money(r.cash_minor) - money(r.amount_minor))] });
  if (left() > 0) for (const k of (await c.query<any>(`SELECT n.id, n.no, n.issued_at::date AS d, n.subtotal_minor, n.tax_minor, n.total_minor FROM credit_notes n WHERE n.status='issued' AND n.issued_at::date >= $1 AND ${has("invoice", "n.invoice_id")} AND NOT ${has("credit_note", "n.id")} ORDER BY n.issued_at LIMIT $2`, [start, left()])).rows)
    await post({ posted_on: day(k.d), source_type: "credit_note", source_id: k.id, memo: `Credit note ${k.no}`, lines: [{ role: "revenue", debit: money(k.subtotal_minor) }, { role: "output_vat", debit: money(k.tax_minor) }, { role: "ar", credit: money(k.total_minor) }] });
  // purchases
  if (left() > 0) for (const b of (await c.query<any>(`SELECT id, no, approved_at::date AS d, base_total_minor, base_tax_minor FROM vendor_bills WHERE approved_by IS NOT NULL AND approved_at::date >= $1 AND NOT ${has("vendor_bill", "vendor_bills.id")} ORDER BY approved_at LIMIT $2`, [start, left()])).rows)
    await post({ posted_on: day(b.d), source_type: "vendor_bill", source_id: b.id, memo: `Supplier bill ${b.no}`, lines: [{ role: "cost", debit: money(b.base_total_minor) - money(b.base_tax_minor) }, { role: "input_vat", debit: money(b.base_tax_minor) }, { role: "ap", credit: money(b.base_total_minor) }] });
  if (left() > 0) for (const p of (await c.query<any>(`SELECT p.id, p.paid_on AS d, p.base_paid_minor, p.base_bill_minor, b.no FROM vendor_payments p JOIN vendor_bills b ON b.id=p.bill_id WHERE p.paid_on >= $1 AND ${has("vendor_bill", "b.id")} AND NOT ${has("vendor_payment", "p.id")} ORDER BY p.paid_on LIMIT $2`, [start, left()])).rows) {
    const gain = money(p.base_bill_minor) - money(p.base_paid_minor);          // paying less than the booked liability is a gain
    await post({ posted_on: day(p.d), source_type: "vendor_payment", source_id: p.id, memo: `Payment of ${p.no}`, lines: [{ role: "ap", debit: money(p.base_bill_minor) }, { role: "bank", credit: money(p.base_paid_minor) }, gain > 0 ? { role: "fx", credit: gain } : { role: "fx", debit: -gain }] });
  }
  // period-end revaluation of foreign-currency receivables, and its automatic reversal the day after
  if (left() > 0) for (const v of (await c.query<any>(`SELECT id, as_of, net_minor FROM fx_revaluations WHERE as_of >= $1 AND net_minor <> 0 AND NOT ${has("fx_reval", "fx_revaluations.id")} ORDER BY as_of LIMIT $2`, [start, left()])).rows)
    await post({ posted_on: day(v.as_of), source_type: "fx_reval", source_id: v.id, memo: `Revaluation of foreign-currency receivables at ${day(v.as_of)}`, lines: [{ role: "ar", debit: Math.max(0, money(v.net_minor)), credit: Math.max(0, -money(v.net_minor)) }, ...fxLine(money(v.net_minor))] });
  if (left() > 0) for (const v of (await c.query<any>(`SELECT id, as_of, net_minor FROM fx_revaluations WHERE as_of < current_date AND net_minor <> 0 AND ${has("fx_reval", "fx_revaluations.id")} AND NOT ${has("fx_reval_reversal", "fx_revaluations.id")} ORDER BY as_of LIMIT $1`, [left()])).rows)
    await post({ posted_on: day(new Date(Date.parse(day(v.as_of)) + 86400000)), source_type: "fx_reval_reversal", source_id: v.id, memo: `Reversal of revaluation at ${day(v.as_of)}`, lines: [{ role: "ar", debit: Math.max(0, -money(v.net_minor)), credit: Math.max(0, money(v.net_minor)) }, ...fxLine(-money(v.net_minor))] });
  // reversals, only of what was journalled
  if (left() > 0) for (const i of (await c.query<any>(`SELECT id, no, subtotal_minor, tax_minor, total_minor FROM invoices WHERE status='void' AND ${has("invoice", "invoices.id")} AND NOT ${has("invoice_void", "invoices.id")} LIMIT $1`, [left()])).rows)
    await post({ posted_on: today(), source_type: "invoice_void", source_id: i.id, memo: `Reversal of voided invoice ${i.no}`, lines: [{ role: "revenue", debit: money(i.subtotal_minor) }, { role: "output_vat", debit: money(i.tax_minor) }, { role: "ar", credit: money(i.total_minor) }] });
  if (left() > 0) for (const r of (await c.query<any>(`SELECT r.id, v.at::date AS d, r.amount_minor, coalesce(r.cash_minor, r.amount_minor) AS cash_minor, i.no FROM receipt_reversals v JOIN receipts r ON r.id=v.receipt_id JOIN invoices i ON i.id=r.invoice_id WHERE ${has("receipt", "r.id")} AND NOT ${has("receipt_reversal", "r.id")} ORDER BY v.at LIMIT $1`, [left()])).rows)
    await post({ posted_on: day(r.d), source_type: "receipt_reversal", source_id: r.id, memo: `Reversal of receipt against ${r.no}`, lines: [{ role: "ar", debit: money(r.amount_minor) }, { role: "bank", credit: money(r.cash_minor) }, ...fxLine(money(r.amount_minor) - money(r.cash_minor))] });
  if (left() > 0) for (const b of (await c.query<any>(`SELECT id, no, base_total_minor, base_tax_minor FROM vendor_bills WHERE status='void' AND approved_by IS NOT NULL AND ${has("vendor_bill", "vendor_bills.id")} AND NOT ${has("vendor_bill_void", "vendor_bills.id")} LIMIT $1`, [left()])).rows)
    await post({ posted_on: today(), source_type: "vendor_bill_void", source_id: b.id, memo: `Reversal of voided bill ${b.no}`, lines: [{ role: "ap", debit: money(b.base_total_minor) }, { role: "cost", credit: money(b.base_total_minor) - money(b.base_tax_minor) }, { role: "input_vat", credit: money(b.base_tax_minor) }] });
  if (n) await audit(c, tenantId, { kind: "system" }, "ledger.posted", "tenant", tenantId, { journals: n, requested_by: userId });
  return n;
}
export async function postLedgerNow(c: Conn, ctx: Ctx) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  let total = 0, n: number;
  do { n = await postPending(c, ctx.tenantId, ctx.userId); total += n; } while (n >= 500);
  return total;
}
/** Worker entry: every tenant with an enabled ledger, in turn. A failure in one tenant never blocks the others. */
export async function postAllLedgers(db: Db) {
  const tenants = (await db.system((c) => c.query<any>(`SELECT s.tenant_id FROM gl_settings s JOIN tenants t ON t.id=s.tenant_id WHERE t.status='active'`))).rows;
  let posted = 0, failed = 0;
  for (const t of tenants) {
    try { posted += await db.tenant(t.tenant_id, async (c) => { let total = 0, n: number; do { n = await postPending(c, t.tenant_id, null); total += n; } while (n >= 500); return total; }); }
    catch { failed++; }
  }
  return { posted, failed };
}

// ───────── manual adjusting entries (two people)
export async function proposeManualEntry(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const st = await ledgerSettings(c); if (!st) throw badRequest("Enable the general ledger first.");
  const date = String(f.entry_date ?? ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || date > today()) throw badRequest("Enter the entry date (not in the future).");
  const raw = Array.isArray(f.lines) ? f.lines : [];
  if (raw.length < 2 || raw.length > 50) throw badRequest("An entry has between 2 and 50 lines.");
  const lines: { account_id: string; debit: number; credit: number; memo: string }[] = [];
  for (const [i, l] of raw.entries()) {
    const a = await must(c.query<any>(`SELECT id FROM gl_accounts WHERE id=$1 AND active`, [recordId(l.account_id, `Account on line ${i + 1}`)]), `Account on line ${i + 1}`);
    const debit = Math.round(Number(l.debit || 0) * 100), credit = Math.round(Number(l.credit || 0) * 100);
    if (!(debit >= 0 && credit >= 0) || (debit > 0) === (credit > 0)) throw badRequest(`Line ${i + 1}: enter either a debit or a credit amount, above zero.`);
    lines.push({ account_id: a.id, debit, credit, memo: String(l.memo ?? "").slice(0, 200) });
  }
  const dr = lines.reduce((a, l) => a + l.debit, 0), cr = lines.reduce((a, l) => a + l.credit, 0);
  if (dr !== cr) throw badRequest(`The entry does not balance: debits ${(dr / 100).toFixed(2)}, credits ${(cr / 100).toFixed(2)}.`);
  const id = (await c.query<any>(`INSERT INTO gl_manual_entries(tenant_id,entry_date,memo,lines,proposed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.tenantId, date, reqStr(f.memo, "Explanation", 300), JSON.stringify(lines), ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "ledger.entry_proposed", "gl_manual_entry", id, { total: dr });
  return id as string;
}
export async function decideManualEntry(c: Conn, ctx: Ctx, id: string, approve: boolean) {
  require(ctx, "finance.void");
  await assertWritable(c, ctx.tenantId);
  const e = await must(c.query<any>(`SELECT * FROM gl_manual_entries WHERE id=$1 FOR UPDATE`, [recordId(id, "Entry")]), "Entry");
  if (e.status !== "proposed") throw badRequest(`This entry is already ${e.status}.`);
  if (e.proposed_by === ctx.userId && !ctx.roles.includes("owner")) throw badRequest("A manual entry is approved by someone other than the person who proposed it.");
  if (!approve) { await c.query(`UPDATE gl_manual_entries SET status='rejected', decided_by=$2, decided_at=now() WHERE id=$1`, [e.id, ctx.userId]); await audit(c, ctx.tenantId, actorOf(ctx), "ledger.entry_rejected", "gl_manual_entry", e.id); return null; }
  const lines: Line[] = (e.lines as any[]).map((l) => ({ account_id: l.account_id, debit: l.debit, credit: l.credit, memo: l.memo }));
  const journalId = await postJournal(c, ctx.tenantId, ctx.userId, { posted_on: day(e.entry_date), source_type: "manual", source_id: e.id, memo: e.memo, lines });
  await c.query(`UPDATE gl_manual_entries SET status='approved', decided_by=$2, decided_at=now(), journal_id=$3 WHERE id=$1`, [e.id, ctx.userId, journalId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "ledger.entry_approved", "gl_manual_entry", e.id, { journal: journalId });
  return journalId;
}
export const listManualEntries = (c: Conn) => c.query<any>(`SELECT e.*, p.name AS proposer FROM gl_manual_entries e LEFT JOIN team_members p ON p.user_id=e.proposed_by ORDER BY e.created_at DESC LIMIT 100`).then((r) => r.rows);

// ───────── reports
export async function trialBalance(c: Conn, asOf = today()) {
  const rows = (await c.query<any>(
    `SELECT a.id, a.code, a.name, a.kind, coalesce(sum(l.debit_minor),0)::bigint AS debit, coalesce(sum(l.credit_minor),0)::bigint AS credit
       FROM gl_accounts a LEFT JOIN gl_lines l ON l.account_id=a.id AND l.journal_id IN (SELECT id FROM gl_journals WHERE posted_on <= $1) GROUP BY a.id ORDER BY a.code`, [asOf])).rows
    .map((r: any) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit), balance: Number(r.debit) - Number(r.credit) }));
  const debit = rows.reduce((a: number, r: any) => a + r.debit, 0), credit = rows.reduce((a: number, r: any) => a + r.credit, 0);
  return { asOf, rows, debit, credit, balanced: debit === credit };
}
export async function incomeStatement(c: Conn, from: string, to: string) {
  const rows = (await c.query<any>(
    `SELECT a.code, a.name, a.kind, coalesce(sum(l.credit_minor) - sum(l.debit_minor),0)::bigint AS net_credit FROM gl_accounts a JOIN gl_lines l ON l.account_id=a.id JOIN gl_journals j ON j.id=l.journal_id
      WHERE a.kind IN ('income','expense') AND j.posted_on BETWEEN $1 AND $2 GROUP BY a.id ORDER BY a.code`, [from, to])).rows.map((r: any) => ({ ...r, net_credit: Number(r.net_credit) }));
  const income = rows.filter((r: any) => r.kind === "income").reduce((a: number, r: any) => a + r.net_credit, 0), expense = rows.filter((r: any) => r.kind === "expense").reduce((a: number, r: any) => a - r.net_credit, 0);
  return { from, to, rows, income, expense, profit: income - expense };
}
export async function accountLedger(c: Conn, accountId: string, limit = 500) {
  const a = await must(c.query<any>(`SELECT * FROM gl_accounts WHERE id=$1`, [recordId(accountId, "Account")]), "Account");
  const lines = (await c.query<any>(`SELECT j.no, j.posted_on, j.memo, j.source_type, l.debit_minor::bigint AS debit, l.credit_minor::bigint AS credit FROM gl_lines l JOIN gl_journals j ON j.id=l.journal_id WHERE l.account_id=$1 ORDER BY j.posted_on, j.no, l.id LIMIT $2`, [a.id, limit])).rows;
  let run = 0;
  return { account: a, lines: lines.map((l: any) => { run += Number(l.debit) - Number(l.credit); return { ...l, debit: Number(l.debit), credit: Number(l.credit), balance: run }; }) };
}
export const listJournals = (c: Conn, limit = 100) => c.query<any>(`SELECT j.*, (SELECT sum(debit_minor) FROM gl_lines WHERE journal_id=j.id)::bigint AS amount FROM gl_journals j ORDER BY j.no DESC LIMIT $1`, [limit]).then((r) => r.rows.map((x: any) => ({ ...x, amount: Number(x.amount) })));
export async function journalDetail(c: Conn, journalId: string) {
  const j = await must(c.query<any>(`SELECT * FROM gl_journals WHERE id=$1`, [recordId(journalId, "Journal")]), "Journal");
  return { journal: j, lines: (await c.query<any>(`SELECT l.*, a.code, a.name FROM gl_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.journal_id=$1 ORDER BY l.id`, [j.id])).rows };
}
/** The ledger's system-sourced control balances against the sub-ledgers they came from. Anything not journalled yet is reported as pending, so a difference is never hidden by timing. */
export async function ledgerReconciliation(c: Conn) {
  const st = await ledgerSettings(c); if (!st) return null;
  const start = day(st.start_date);
  const bal = async (role: string, side: "debit" | "credit") => Number((await c.query<any>(
    `SELECT coalesce(sum(${side === "debit" ? "l.debit_minor - l.credit_minor" : "l.credit_minor - l.debit_minor"}),0)::bigint AS b FROM gl_lines l JOIN gl_accounts a ON a.id=l.account_id JOIN gl_journals j ON j.id=l.journal_id WHERE a.role=$1 AND j.source_type NOT IN ('manual','fx_reval','fx_reval_reversal')`, [role])).rows[0].b);
  const one = async (sql: string, p: unknown[] = [start]) => Number((await c.query<any>(sql, p)).rows[0].v);
  const arSub = await one(`SELECT coalesce(sum(i.total_minor),0) - coalesce((SELECT sum(r.amount_minor) FROM receipts r JOIN invoices i2 ON i2.id=r.invoice_id WHERE i2.status<>'void' AND i2.issued_at::date >= $1 AND r.received_at >= $1 AND NOT EXISTS (SELECT 1 FROM receipt_reversals v WHERE v.receipt_id=r.id)),0) - coalesce((SELECT sum(n.total_minor) FROM credit_notes n JOIN invoices i3 ON i3.id=n.invoice_id WHERE n.status='issued' AND i3.status<>'void' AND i3.issued_at::date >= $1 AND n.issued_at::date >= $1),0) AS v FROM invoices i WHERE i.status<>'void' AND i.issued_at::date >= $1`);
  const apSub = await one(`SELECT coalesce(sum(b.base_total_minor),0) - coalesce((SELECT sum(p.base_bill_minor) FROM vendor_payments p JOIN vendor_bills b2 ON b2.id=p.bill_id WHERE b2.status<>'void' AND b2.approved_at::date >= $1 AND p.paid_on >= $1),0) AS v FROM vendor_bills b WHERE b.approved_by IS NOT NULL AND b.status<>'void' AND b.approved_at::date >= $1`);
  const pending = await one(`SELECT (SELECT count(*) FROM invoices i WHERE i.issued_at::date >= $1 AND NOT ${has("invoice", "i.id")}) + (SELECT count(*) FROM vendor_bills b WHERE b.approved_by IS NOT NULL AND b.approved_at::date >= $1 AND NOT ${has("vendor_bill", "b.id")}) AS v`);
  const items = [
    { name: "Accounts receivable", ledger: await bal("ar", "debit"), subledger: arSub }, { name: "Accounts payable", ledger: await bal("ap", "credit"), subledger: apSub },
  ].map((x) => ({ ...x, difference: x.ledger - x.subledger }));
  return { pending, items, ok: pending === 0 && items.every((x) => x.difference === 0) };
}

// ───────── foreign-currency receivables: revaluation and realised exchange differences
/**
 * Revalues every open foreign-currency invoice at today's approved rate (run it on the period-end day). The run is immutable, one per day. Its journal debits or credits
 * receivables against the exchange gain/loss account and is reversed automatically the next day, so only the period-end balance carries the revaluation.
 */
export async function revalueReceivables(c: Conn, ctx: Ctx) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const asOf = today();
  if ((await c.query(`SELECT 1 FROM fx_revaluations WHERE as_of=$1`, [asOf])).rows.length) throw badRequest("Receivables have already been revalued today.");
  const open = (await c.query<any>(`SELECT id, no, billing_currency, fx_rate, balance_minor FROM invoices WHERE billing_currency IS NOT NULL AND status IN ('issued','part_paid') AND balance_minor > 0 ORDER BY no`)).rows;
  if (!open.length) throw badRequest("There are no open foreign-currency invoices to revalue.");
  const lines = [] as any[];
  const missing = new Set<string>();
  for (const i of open) {
    const r = await rateOn(c, i.billing_currency, asOf);
    if (!r) { missing.add(i.billing_currency); continue; }
    if ((Date.parse(asOf) - Date.parse(r.as_of)) / 86400000 > FX_RATE_MAX_AGE_DAYS) { missing.add(i.billing_currency); continue; }
    const billingOpen = Math.round(Number(i.balance_minor) / Number(i.fx_rate)), carrying = Number(i.balance_minor), revalued = Math.round(billingOpen * r.rate);
    lines.push({ invoice_id: i.id, currency: i.billing_currency, billingOpen, carrying, rate: r.rate, rateId: r.id, revalued, diff: revalued - carrying });
  }
  if (missing.size) throw badRequest(`Approve a current ${[...missing].join(", ")} exchange rate (not older than ${FX_RATE_MAX_AGE_DAYS} days) before revaluing.`);
  const net = lines.reduce((a, l) => a + l.diff, 0);
  const id = (await c.query<any>(`INSERT INTO fx_revaluations(tenant_id,as_of,net_minor,created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.tenantId, asOf, net, ctx.userId])).rows[0].id as string;
  for (const l of lines) await c.query(`INSERT INTO fx_revaluation_lines(tenant_id,revaluation_id,invoice_id,currency,billing_open_minor,carrying_minor,rate,rate_id,revalued_minor,diff_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.tenantId, id, l.invoice_id, l.currency, l.billingOpen, l.carrying, l.rate, l.rateId, l.revalued, l.diff]);
  await audit(c, ctx.tenantId, actorOf(ctx), "fx.receivables_revalued", "fx_revaluation", id, { invoices: lines.length, net });
  return { id, as_of: asOf, net_minor: net, lines: lines.length };
}
export async function listRevaluations(c: Conn) {
  return (await c.query<any>(`SELECT v.*, (SELECT count(*) FROM fx_revaluation_lines l WHERE l.revaluation_id=v.id)::int AS lines FROM fx_revaluations v ORDER BY as_of DESC LIMIT 60`)).rows;
}
export async function revaluationDetail(c: Conn, id: string) {
  const v = await must(c.query<any>(`SELECT * FROM fx_revaluations WHERE id=$1`, [recordId(id, "Revaluation")]), "Revaluation");
  return { run: v, lines: (await c.query<any>(`SELECT l.*, i.no FROM fx_revaluation_lines l JOIN invoices i ON i.id=l.invoice_id WHERE l.revaluation_id=$1 ORDER BY i.no`, [v.id])).rows };
}
/** Realised exchange differences on foreign-currency receipts in a period, by currency and in total (positive = gain). Reversed receipts are excluded. */
export async function realisedReceiptFx(c: Conn, from: string, to: string) {
  const rows = (await c.query<any>(
    `SELECT r.id, r.received_at, i.no, i.billing_currency AS currency, r.billing_amount_minor, r.settlement_rate, r.amount_minor AS carrying_minor, r.cash_minor, (r.cash_minor - r.amount_minor) AS gain_minor
       FROM receipts r JOIN invoices i ON i.id=r.invoice_id WHERE r.cash_minor IS NOT NULL AND r.received_at BETWEEN $1 AND $2
        AND NOT EXISTS (SELECT 1 FROM receipt_reversals v WHERE v.receipt_id=r.id) ORDER BY r.received_at, i.no`, [from, to])).rows.map((x: any) => ({ ...x, gain_minor: Number(x.gain_minor) }));
  const by = new Map<string, number>();
  for (const x of rows) by.set(x.currency, (by.get(x.currency) ?? 0) + x.gain_minor);
  return { from, to, rows, by_currency: [...by].map(([currency, gain_minor]) => ({ currency, gain_minor })), total_minor: rows.reduce((a: number, x: any) => a + x.gain_minor, 0) };
}
