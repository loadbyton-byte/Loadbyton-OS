import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, forbidden, sha256, toMinor } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, nextNumber, recordId, reqStr } from "./common.js";
import { parseCsv } from "./importer.js";

export interface CashPolicy { max_unsettled_minor: number; max_unsettled_hours: number; max_offline_hours: number; writeoff_owner_above_minor: number; configured: boolean }
export const DEFAULT_CASH_POLICY: CashPolicy = { max_unsettled_minor: 500_000, max_unsettled_hours: 48, max_offline_hours: 24, writeoff_owner_above_minor: 50_000, configured: false };

export async function getCashPolicy(c: Conn): Promise<CashPolicy> {
  const r = (await c.query<any>(`SELECT * FROM dlv_cash_policy`)).rows[0];
  return r ? { max_unsettled_minor: Number(r.max_unsettled_minor), max_unsettled_hours: r.max_unsettled_hours, max_offline_hours: r.max_offline_hours, writeoff_owner_above_minor: Number(r.writeoff_owner_above_minor), configured: true } : DEFAULT_CASH_POLICY;
}
export async function setCashPolicy(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "dlv.approve");
  if (!ctx.roles.includes("owner")) throw forbidden("Cash limits are set by the workspace owner.");
  const hours = (v: unknown, label: string, max: number) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`${label} must be 1 to ${max} hours.`); return n; };
  const p = { u: toMinor(f.max_unsettled ?? ""), uh: hours(f.max_unsettled_hours, "Unsettled cash age", 720), oh: hours(f.max_offline_hours, "Offline window", 336), w: toMinor(f.writeoff_owner_above ?? "0") };
  await c.query(
    `INSERT INTO dlv_cash_policy(tenant_id,max_unsettled_minor,max_unsettled_hours,max_offline_hours,writeoff_owner_above_minor,updated_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id) DO UPDATE SET max_unsettled_minor=$2, max_unsettled_hours=$3, max_offline_hours=$4, writeoff_owner_above_minor=$5, updated_by=$6, updated_at=now()`, [ctx.tenantId, p.u, p.uh, p.oh, p.w, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_cash_policy.set", "tenant", ctx.tenantId, { max_unsettled_minor: p.u, max_unsettled_hours: p.uh, max_offline_hours: p.oh });
}

/** Cash a rider has collected and not yet handed in. */
export async function riderExposure(c: Conn, driverId: string) {
  const r = (await c.query<any>(`SELECT coalesce(sum(amount_minor),0)::bigint AS amount, min(collected_at) AS oldest FROM dlv_collections WHERE driver_id=$1 AND settlement_id IS NULL`, [driverId])).rows[0];
  return { amount_minor: Number(r.amount), oldest: r.oldest ? new Date(r.oldest) : null };
}
/** Why a rider may not start another run: too much cash, or cash held too long. */
export async function cashHoldReason(c: Conn, driverId: string): Promise<string | null> {
  const [policy, ex] = [await getCashPolicy(c), await riderExposure(c, driverId)];
  if (ex.amount_minor > policy.max_unsettled_minor) return `The rider holds AED ${(ex.amount_minor / 100).toFixed(2)} of uncounted cash, above the AED ${(policy.max_unsettled_minor / 100).toFixed(2)} limit.`;
  if (ex.oldest && Date.now() - ex.oldest.getTime() > policy.max_unsettled_hours * 3600_000) return `The rider has held uncounted cash for more than ${policy.max_unsettled_hours} hours.`;
  return null;
}

// ───────────── bank statement import and matching
const DAY = /^(\d{4})-(\d{2})-(\d{2})$|^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/;
function parseDay(v: string): string | null {
  const m = DAY.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = m[1] ? [m[1], m[2], m[3]] : [m[6], m[5].padStart(2, "0"), m[4].padStart(2, "0")];
  const iso = `${y}-${mo}-${d}`, t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}
const money = (v: string) => { const s = v.trim().replace(/,/g, ""); if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null; return Math.round(Number(s) * 100); };

/**
 * Import a bank statement CSV (header required: date + amount, or date + credit/debit; optional reference, description).
 * Positive amounts are credits to the account, negative are debits. Re-importing the same file is refused; lines are immutable.
 */
export async function importBankStatement(c: Conn, ctx: Ctx, label: string, csv: string) {
  require(ctx, "dlv.cash");
  await assertWritable(c, ctx.tenantId);
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest("The statement needs a header row and at least one line.");
  if (rows.length > 2001) throw badRequest("A statement import holds at most 2,000 lines.");
  const head = rows[0].map((h) => h.trim().toLowerCase()), col = (n: string) => head.indexOf(n);
  const iDate = col("date"), iAmt = col("amount"), iCr = col("credit"), iDr = col("debit"), iRef = col("reference"), iDesc = col("description");
  if (iDate < 0 || (iAmt < 0 && (iCr < 0 || iDr < 0))) throw badRequest("Header must include date and amount (or credit and debit).");
  const hash = sha256(rows.map((r) => r.map((x) => x.trim()).join("|")).join("\n"));
  if ((await c.query(`SELECT 1 FROM dlv_bank_statements WHERE source_hash=$1`, [hash])).rows.length) throw new HttpError(409, "This statement was already imported.", "conflict");
  const lines: { date: string; amount: number; ref: string; desc: string }[] = [];
  for (const [i, r] of rows.slice(1).entries()) {
    const date = parseDay(r[iDate] ?? "");
    if (!date) throw badRequest(`Line ${i + 2}: unrecognised date.`);
    let amount: number | null;
    if (iAmt >= 0) amount = money(r[iAmt] ?? "");
    else { const cr = (r[iCr] ?? "").trim() ? money(r[iCr]) : 0, dr = (r[iDr] ?? "").trim() ? money(r[iDr]) : 0; amount = cr === null || dr === null ? null : (cr ?? 0) - (dr ?? 0); }
    if (amount === null || amount === 0) throw badRequest(`Line ${i + 2}: amount must be a non-zero amount with at most two decimals.`);
    lines.push({ date, amount, ref: (iRef >= 0 ? r[iRef] ?? "" : "").trim().slice(0, 200), desc: (iDesc >= 0 ? r[iDesc] ?? "" : "").trim().slice(0, 400) });
  }
  const st = (await c.query<{ id: string }>(`INSERT INTO dlv_bank_statements(tenant_id,source_hash,label,line_count,imported_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.tenantId, hash, reqStr(label, "Statement label", 120), lines.length, ctx.userId])).rows[0].id;
  for (const [i, l] of lines.entries()) await c.query(`INSERT INTO dlv_bank_lines(tenant_id,statement_id,line_no,line_date,amount_minor,reference,description) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ctx.tenantId, st, i + 1, l.date, l.amount, l.ref, l.desc]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_bank.imported", "dlv_bank_statement", st, { lines: lines.length });
  const matched = await autoMatchBankLines(c, ctx, st);
  return { id: st, lines: lines.length, matched };
}

/** Exact, unique matches only: the document number must appear in the bank text and the amount must be identical. Everything else is left for a person. */
export async function autoMatchBankLines(c: Conn, ctx: Ctx, statementId?: string) {
  require(ctx, "dlv.cash");
  const lines = (await c.query<any>(`SELECT * FROM dlv_bank_lines WHERE status='unmatched' AND ($1::uuid IS NULL OR statement_id=$1) ORDER BY statement_id, line_no FOR UPDATE`, [statementId ?? null])).rows;
  let matched = 0;
  for (const l of lines) {
    const text = `${l.reference} ${l.description}`.toUpperCase(), amt = Number(l.amount_minor);
    if (amt > 0) {
      const hit = (await c.query<any>(`SELECT s.id FROM dlv_settlements s WHERE s.status='closed' AND s.counted_minor=$2 AND position(upper(s.no) in $1)>0
        AND NOT EXISTS (SELECT 1 FROM dlv_bank_lines b WHERE b.settlement_id=s.id)`, [text, amt])).rows;
      if (hit.length === 1) { await c.query(`UPDATE dlv_bank_lines SET status='matched', settlement_id=$2, match_basis='auto', decided_at=now() WHERE id=$1`, [l.id, hit[0].id]); matched++; }
    } else {
      const hit = (await c.query<any>(`SELECT r.id FROM dlv_remittances r WHERE r.status='paid' AND r.net_minor=$2 AND (position(upper(r.no) in $1)>0 OR (r.pay_reference IS NOT NULL AND length(r.pay_reference)>=6 AND position(upper(r.pay_reference) in $1)>0))
        AND NOT EXISTS (SELECT 1 FROM dlv_bank_lines b WHERE b.remittance_id=r.id)`, [text, -amt])).rows;
      if (hit.length === 1) { await c.query(`UPDATE dlv_bank_lines SET status='matched', remittance_id=$2, match_basis='auto', decided_at=now() WHERE id=$1`, [l.id, hit[0].id]); matched++; }
    }
  }
  if (matched) await audit(c, ctx.tenantId, actorOf(ctx), "dlv_bank.auto_matched", "dlv_bank_statement", statementId, { matched });
  return matched;
}

export async function matchBankLine(c: Conn, ctx: Ctx, lineId: string, f: Record<string, any>) {
  require(ctx, "dlv.cash");
  const l = await must(c.query<any>(`SELECT * FROM dlv_bank_lines WHERE id=$1 FOR UPDATE`, [recordId(lineId)]), "Bank line");
  if (l.status !== "unmatched") throw badRequest(`This line is already ${l.status}.`);
  const amt = Number(l.amount_minor);
  if (f.settlement_id) {
    if (amt < 0) throw badRequest("A cash deposit must be a credit line.");
    const s = await must(c.query<any>(`SELECT * FROM dlv_settlements WHERE id=$1`, [f.settlement_id]), "Cash handover");
    if (s.status !== "closed") throw badRequest("Only a closed handover can be matched to a deposit.");
    if (Number(s.counted_minor) !== amt) throw badRequest(`The deposit is AED ${(amt / 100).toFixed(2)} but the handover counted AED ${(Number(s.counted_minor) / 100).toFixed(2)}. Ignore the line as 'other' with a note, or fix the cause first.`);
    await c.query(`UPDATE dlv_bank_lines SET status='matched', settlement_id=$2, match_basis='manual', decided_by=$3, decided_at=now() WHERE id=$1`, [l.id, s.id, ctx.userId]);
  } else if (f.remittance_id) {
    if (amt > 0) throw badRequest("A merchant payout must be a debit line.");
    const r = await must(c.query<any>(`SELECT * FROM dlv_remittances WHERE id=$1`, [f.remittance_id]), "Remittance");
    if (r.status !== "paid") throw badRequest("Only a paid remittance can be matched to a bank debit.");
    if (Number(r.net_minor) !== -amt) throw badRequest(`The debit is AED ${(-amt / 100).toFixed(2)} but the payout was AED ${(Number(r.net_minor) / 100).toFixed(2)}.`);
    await c.query(`UPDATE dlv_bank_lines SET status='matched', remittance_id=$2, match_basis='manual', decided_by=$3, decided_at=now() WHERE id=$1`, [l.id, r.id, ctx.userId]);
  } else throw badRequest("Choose a handover or remittance to match.");
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_bank.matched", "dlv_bank_line", l.id);
}
export async function ignoreBankLine(c: Conn, ctx: Ctx, lineId: string, category: string, note: string) {
  require(ctx, "dlv.cash");
  if (!["refund", "bank_fee", "other"].includes(category)) throw badRequest("Classify the line as a refund, bank fee or other.");
  const l = await must(c.query<any>(`SELECT * FROM dlv_bank_lines WHERE id=$1 FOR UPDATE`, [recordId(lineId)]), "Bank line");
  if (l.status !== "unmatched") throw badRequest(`This line is already ${l.status}.`);
  await c.query(`UPDATE dlv_bank_lines SET status='ignored', category=$2, note=$3, decided_by=$4, decided_at=now() WHERE id=$1`, [l.id, category, reqStr(note, "Note explaining the line", 300), ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_bank.classified", "dlv_bank_line", l.id, { category });
}
export async function unmatchBankLine(c: Conn, ctx: Ctx, lineId: string, reason: string) {
  require(ctx, "dlv.approve");
  const l = await must(c.query<any>(`SELECT * FROM dlv_bank_lines WHERE id=$1 FOR UPDATE`, [recordId(lineId)]), "Bank line");
  if (l.status === "unmatched") throw badRequest("This line is not matched.");
  if (l.decided_by === ctx.userId && !ctx.roles.includes("owner")) throw forbidden("A match must be reversed by someone other than the person who made it.");
  await c.query(`UPDATE dlv_bank_lines SET status='unmatched', settlement_id=NULL, remittance_id=NULL, match_basis=NULL, category=NULL, note=$2, decided_by=NULL, decided_at=NULL WHERE id=$1`, [l.id, `Reversed: ${reqStr(reason, "Reason", 300)}`]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_bank.unmatched", "dlv_bank_line", l.id);
}

/** What the bank has not yet confirmed: deposits and payouts older than `graceDays` with no matched statement line. */
export async function bankReconciliation(c: Conn, graceDays = 3) {
  const q = async (sql: string, p: unknown[] = []) => (await c.query<any>(sql, p)).rows;
  return {
    unmatchedLines: await q(`SELECT b.*, st.label FROM dlv_bank_lines b JOIN dlv_bank_statements st ON st.id=b.statement_id WHERE b.status='unmatched' ORDER BY b.line_date, b.line_no LIMIT 300`),
    undepositedHandovers: await q(`SELECT s.id, s.no, s.counted_minor, s.created_at, d.name AS rider FROM dlv_settlements s JOIN drivers d ON d.id=s.driver_id WHERE s.status='closed' AND s.created_at < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM dlv_bank_lines b WHERE b.settlement_id=s.id) ORDER BY s.created_at LIMIT 300`, [graceDays]),
    unconfirmedPayouts: await q(`SELECT r.id, r.no, r.net_minor, r.paid_at, p.name AS merchant FROM dlv_remittances r JOIN parties p ON p.id=r.merchant_id WHERE r.status='paid' AND r.paid_at < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM dlv_bank_lines b WHERE b.remittance_id=r.id) ORDER BY r.paid_at LIMIT 300`, [graceDays]),
  };
}
export const listBankStatements = (c: Conn) => c.query<any>(`SELECT st.*, (SELECT count(*)::int FROM dlv_bank_lines b WHERE b.statement_id=st.id AND b.status='unmatched') AS unmatched FROM dlv_bank_statements st ORDER BY st.created_at DESC LIMIT 50`).then((r) => r.rows);
export const openMatchTargets = async (c: Conn) => ({
  settlements: (await c.query<any>(`SELECT s.id, s.no, s.counted_minor FROM dlv_settlements s WHERE s.status='closed' AND NOT EXISTS (SELECT 1 FROM dlv_bank_lines b WHERE b.settlement_id=s.id) ORDER BY s.created_at DESC LIMIT 200`)).rows,
  remittances: (await c.query<any>(`SELECT r.id, r.no, r.net_minor FROM dlv_remittances r WHERE r.status='paid' AND NOT EXISTS (SELECT 1 FROM dlv_bank_lines b WHERE b.remittance_id=r.id) ORDER BY r.paid_at DESC LIMIT 200`)).rows,
});

// ───────────── approved write-offs of cash shortages
export async function proposeWriteOff(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "dlv.cash");
  await assertWritable(c, ctx.tenantId);
  const s = await must(c.query<any>(`SELECT * FROM dlv_settlements WHERE id=$1 FOR UPDATE`, [recordId(f.settlement_id, "Cash handover")]), "Cash handover");
  const shortage = -Number(s.variance_minor);
  if (s.status !== "closed" || shortage <= 0) throw badRequest("Only a closed handover with a counted shortage can have a shortage written off.");
  const amount = toMinor(f.amount ?? "");
  const used = Number((await c.query<any>(`SELECT coalesce(sum(amount_minor),0) n FROM dlv_writeoffs WHERE settlement_id=$1 AND status IN ('proposed','approved')`, [s.id])).rows[0].n);
  if (amount <= 0 || used + amount > shortage) throw badRequest(`At most AED ${((shortage - used) / 100).toFixed(2)} of this shortage can still be written off.`);
  const no = await nextNumber(c, ctx.tenantId, "dlv_writeoff", "WOF");
  const id = (await c.query<{ id: string }>(`INSERT INTO dlv_writeoffs(tenant_id,no,settlement_id,amount_minor,reason,proposed_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.tenantId, no, s.id, amount, reqStr(f.reason, "Reason and recovery attempts made", 500), ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_writeoff.proposed", "dlv_writeoff", id, { no, amount });
  return { id, no };
}
export async function decideWriteOff(c: Conn, ctx: Ctx, id: string, approve: boolean, note: string) {
  require(ctx, "dlv.approve");
  const w = await must(c.query<any>(`SELECT * FROM dlv_writeoffs WHERE id=$1 FOR UPDATE`, [recordId(id)]), "Write-off");
  if (w.status !== "proposed") throw badRequest(`This write-off is already ${w.status}.`);
  if (w.proposed_by === ctx.userId && !ctx.roles.includes("owner")) throw forbidden("A write-off cannot be decided by the person who proposed it.");
  const policy = await getCashPolicy(c);
  if (approve && Number(w.amount_minor) > policy.writeoff_owner_above_minor && !ctx.roles.includes("owner")) throw forbidden(`Write-offs above AED ${(policy.writeoff_owner_above_minor / 100).toFixed(2)} need the workspace owner.`);
  await c.query(`UPDATE dlv_writeoffs SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`, [id, approve ? "approved" : "rejected", ctx.userId, reqStr(note, "Decision note", 300)]);
  await audit(c, ctx.tenantId, actorOf(ctx), approve ? "dlv_writeoff.approved" : "dlv_writeoff.rejected", "dlv_writeoff", id, { amount: Number(w.amount_minor) });
}
/** Shortages still owed (counted shortage minus approved write-offs) per rider: the liability that remains on the books. */
export async function liabilityReport(c: Conn) {
  const rows = (await c.query<any>(
    `SELECT d.name AS rider, s.no, s.created_at, (-s.variance_minor)::bigint AS shortage_minor,
       coalesce((SELECT sum(w.amount_minor) FROM dlv_writeoffs w WHERE w.settlement_id=s.id AND w.status='approved'),0)::bigint AS written_off_minor,
       coalesce((SELECT sum(w.amount_minor) FROM dlv_writeoffs w WHERE w.settlement_id=s.id AND w.status='proposed'),0)::bigint AS proposed_minor
     FROM dlv_settlements s JOIN drivers d ON d.id=s.driver_id WHERE s.status='closed' AND s.variance_minor < 0 ORDER BY s.created_at DESC LIMIT 500`)).rows;
  return rows.map((r) => ({ ...r, shortage_minor: Number(r.shortage_minor), written_off_minor: Number(r.written_off_minor), proposed_minor: Number(r.proposed_minor), outstanding_minor: Number(r.shortage_minor) - Number(r.written_off_minor) }));
}
export const listWriteOffs = (c: Conn) => c.query<any>(`SELECT w.*, s.no AS settlement_no, d.name AS rider, pu.name AS proposer FROM dlv_writeoffs w JOIN dlv_settlements s ON s.id=w.settlement_id JOIN drivers d ON d.id=s.driver_id LEFT JOIN team_members pu ON pu.user_id=w.proposed_by ORDER BY w.proposed_at DESC LIMIT 200`).then((r) => r.rows);
/** Approved write-offs as CSV for the accountant: posting them to the books is a human act in the accounting system. */
export async function writeOffsCsv(c: Conn, ctx: Ctx) {
  require(ctx, "export");
  const rows = (await c.query<any>(`SELECT w.no, s.no AS settlement, d.name AS rider, w.amount_minor, w.reason, w.decided_at FROM dlv_writeoffs w JOIN dlv_settlements s ON s.id=w.settlement_id JOIN drivers d ON d.id=s.driver_id WHERE w.status='approved' ORDER BY w.decided_at`)).rows;
  const esc = (v: unknown) => { let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return ["writeoff_no,settlement,rider,amount_aed,reason,approved_at", ...rows.map((r) => [r.no, r.settlement, r.rider, (Number(r.amount_minor) / 100).toFixed(2), r.reason, r.decided_at].map(esc).join(","))].join("\n");
}
