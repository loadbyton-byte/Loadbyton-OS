import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, TAX_CODES, badRequest, forbidden, lineNet, toMinor } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, nextNumber, optStr, reqStr, today } from "./common.js";
import { createJobFromQuote } from "./jobs.js";

export interface LineInput {
  description: string; qty: number; unit_sell: number | string; unit_cost?: number | string;
  supplier_id?: string | null; tax_code?: string; rate_id?: string | null;
}

export const marginBps = (sell: number, cost: number) => (sell > 0 ? Math.round(((sell - cost) * 10_000) / sell) : 0);

function normaliseLines(lines: LineInput[]) {
  if (!lines.length) throw badRequest("Add at least one charge line.");
  return lines.map((l, i) => {
    const qty = Number(l.qty);
    if (!(qty > 0)) throw badRequest(`Line ${i + 1}: quantity must be above zero.`);
    const tax = l.tax_code && TAX_CODES[l.tax_code] ? l.tax_code : "SR5";
    return {
      description: reqStr(l.description, `Line ${i + 1} description`, 300), qty, tax_code: tax,
      unit_sell_minor: typeof l.unit_sell === "number" ? Math.round(l.unit_sell) : toMinor(l.unit_sell),
      unit_cost_minor: l.unit_cost == null || l.unit_cost === "" ? 0 : typeof l.unit_cost === "number" ? Math.round(l.unit_cost) : toMinor(l.unit_cost),
      supplier_id: l.supplier_id || null, rate_id: l.rate_id || null,
    };
  });
}

async function writeVersion(c: Conn, tenantId: string, quoteId: string, version: number, lines: LineInput[], validUntil: string, exclusions: string | null, terms: string | null) {
  const ls = normaliseLines(lines);
  const sell = ls.reduce((a, l) => a + lineNet(l.qty, l.unit_sell_minor), 0);
  const cost = ls.reduce((a, l) => a + lineNet(l.qty, l.unit_cost_minor), 0);
  const v = await c.query<{ id: string }>(
    `INSERT INTO quote_versions(tenant_id,quote_id,version,valid_until,exclusions,terms,total_sell_minor,total_cost_minor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [tenantId, quoteId, version, validUntil, exclusions, terms, sell, cost]);
  let pos = 0;
  for (const l of ls) {
    await c.query(
      `INSERT INTO quote_lines(tenant_id,version_id,position,description,supplier_id,qty,unit_sell_minor,unit_cost_minor,tax_code,rate_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, v.rows[0].id, ++pos, l.description, l.supplier_id, l.qty, l.unit_sell_minor, l.unit_cost_minor, l.tax_code, l.rate_id]);
  }
  return v.rows[0].id;
}

export async function createQuote(c: Conn, ctx: Ctx, f: { enquiry_id?: string | null; party_id: string; valid_until: string; exclusions?: string; terms?: string; lines: LineInput[] }) {
  require(ctx, "quote.write");
  await assertWritable(c, ctx.tenantId);
  const party = await must(c.query<any>(`SELECT id,kind FROM parties WHERE id=$1`, [f.party_id]), "Customer");
  if (party.kind !== "customer") throw badRequest("Quotes are issued to customers.");
  if (!f.valid_until || f.valid_until < today()) throw badRequest("Validity date must be today or later.");
  const no = await nextNumber(c, ctx.tenantId, "quote", "QT");
  const q = await c.query<{ id: string }>(
    `INSERT INTO quotes(tenant_id,no,enquiry_id,party_id,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.tenantId, no, f.enquiry_id || null, f.party_id, ctx.userId]);
  await writeVersion(c, ctx.tenantId, q.rows[0].id, 1, f.lines, f.valid_until, optStr(f.exclusions, 1000), optStr(f.terms, 2000));
  if (f.enquiry_id) await c.query(`UPDATE enquiries SET status='quoted' WHERE id=$1 AND status IN ('new','qualified')`, [f.enquiry_id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "quote.created", "quote", q.rows[0].id, { no });
  return { id: q.rows[0].id, no };
}

export async function getQuote(c: Conn, id: string) {
  const q = await must(c.query<any>(
    `SELECT q.*, p.name AS party_name, p.credit_limit_minor, e.no AS enquiry_no FROM quotes q
     JOIN parties p ON p.id=q.party_id LEFT JOIN enquiries e ON e.id=q.enquiry_id WHERE q.id=$1`, [id]), "Quote");
  const versions = (await c.query<any>(`SELECT * FROM quote_versions WHERE quote_id=$1 ORDER BY version DESC`, [id])).rows;
  const cur = versions.find((v) => v.version === q.current_version);
  const lines = (await c.query<any>(
    `SELECT l.*, s.name AS supplier_name, r.valid_to AS rate_valid_to FROM quote_lines l
     LEFT JOIN parties s ON s.id=l.supplier_id LEFT JOIN rates r ON r.id=l.rate_id WHERE l.version_id=$1 ORDER BY position`, [cur.id])).rows;
  const entity = (await c.query<any>(`SELECT margin_threshold_bps FROM entities ORDER BY created_at LIMIT 1`)).rows[0];
  return { quote: q, versions, current: cur, lines, thresholdBps: entity.margin_threshold_bps, marginBps: marginBps(Number(cur.total_sell_minor), Number(cur.total_cost_minor)) };
}

async function openReceivable(c: Conn, partyId: string) {
  const r = await c.query<{ n: string | number }>(
    `SELECT coalesce(sum(total_minor-paid_minor),0) n FROM invoices WHERE party_id=$1 AND status IN ('issued','part_paid')`, [partyId]);
  return Number(r.rows[0].n);
}

/** Submit for approval: below-threshold margin, credit exposure and expired supplier rates need a human decision. */
export async function submitQuote(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "quote.write");
  const d = await getQuote(c, id);
  if (!["draft"].includes(d.quote.status)) throw badRequest(`Quote is ${d.quote.status}.`);
  const reasons: string[] = [];
  if (d.marginBps < d.thresholdBps) reasons.push(`margin ${(d.marginBps / 100).toFixed(1)}% is below the ${(d.thresholdBps / 100).toFixed(1)}% threshold`);
  const limit = Number(d.quote.credit_limit_minor);
  if (limit > 0) {
    const exposure = (await openReceivable(c, d.quote.party_id)) + Number(d.current.total_sell_minor);
    if (exposure > limit) reasons.push(`credit exposure would exceed the customer's limit`);
  }
  if (d.lines.some((l: any) => l.rate_valid_to && String(l.rate_valid_to).slice(0, 10) < today())) reasons.push("a supplier rate used has expired");
  const status = reasons.length ? "pending_approval" : "approved";
  await c.query(`UPDATE quotes SET status=$2, approval_reason=$3 WHERE id=$1`, [id, status, reasons.join("; ") || null]);
  await audit(c, ctx.tenantId, actorOf(ctx), "quote.submitted", "quote", id, { status, reasons });
  return { status, reasons };
}

export async function approveQuote(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "quote.approve");
  const q = await must(c.query<any>(`SELECT status, created_by FROM quotes WHERE id=$1`, [id]), "Quote");
  if (q.status !== "pending_approval") throw badRequest("Quote is not awaiting approval.");
  if (q.created_by === ctx.userId && !ctx.roles.includes("owner")) throw forbidden("A quote below threshold cannot be approved by its author.");
  await c.query(`UPDATE quotes SET status='approved', approved_by=$2 WHERE id=$1`, [id, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "quote.approved", "quote", id);
}

/** Sending locks the version: a customer-facing version never changes afterwards. */
export async function sendQuote(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "quote.write");
  const q = await must(c.query<any>(`SELECT status,current_version FROM quotes WHERE id=$1`, [id]), "Quote");
  if (q.status !== "approved") throw badRequest("Only approved quotes can be sent.");
  await c.query(`UPDATE quote_versions SET locked=true WHERE quote_id=$1 AND version=$2`, [id, q.current_version]);
  await c.query(`UPDATE quotes SET status='sent' WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "quote.sent", "quote", id, { version: q.current_version });
}

/** Revision creates version n+1 from the current lines; earlier versions remain as locked history. */
export async function reviseQuote(c: Conn, ctx: Ctx, id: string, f: { valid_until: string; lines: LineInput[]; exclusions?: string; terms?: string }) {
  require(ctx, "quote.write");
  const q = await must(c.query<any>(`SELECT status,current_version FROM quotes WHERE id=$1`, [id]), "Quote");
  if (["accepted", "converted"].includes(q.status)) throw badRequest("An accepted quote cannot be revised.");
  await c.query(`UPDATE quote_versions SET locked=true WHERE quote_id=$1 AND NOT locked`, [id]);
  const next = q.current_version + 1;
  await writeVersion(c, ctx.tenantId, id, next, f.lines, f.valid_until, optStr(f.exclusions, 1000), optStr(f.terms, 2000));
  await c.query(`UPDATE quotes SET current_version=$2, status='draft', approval_reason=NULL, approved_by=NULL WHERE id=$1`, [id, next]);
  await audit(c, ctx.tenantId, actorOf(ctx), "quote.revised", "quote", id, { version: next });
  return next;
}

export async function rejectQuote(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "quote.write");
  await must(c.query(`UPDATE quotes SET status='rejected' WHERE id=$1 AND status IN ('sent','approved','pending_approval') RETURNING id`, [id]), "Open quote");
  await audit(c, ctx.tenantId, actorOf(ctx), "quote.rejected", "quote", id);
}

/**
 * Acceptance converts to exactly one job without re-keying customer data. Idempotent: accepting again
 * returns the same job (jobs.quote_id is unique).
 */
export async function acceptQuote(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "quote.write");
  const q = await must(c.query<any>(`SELECT * FROM quotes WHERE id=$1 FOR UPDATE`, [id]), "Quote");
  const existing = await c.query<{ id: string }>(`SELECT id FROM jobs WHERE quote_id=$1`, [id]);
  if (existing.rows.length) return { jobId: existing.rows[0].id, created: false };
  if (q.status !== "sent") throw badRequest("Only sent quotes can be accepted.");
  const v = (await c.query<any>(`SELECT valid_until FROM quote_versions WHERE quote_id=$1 AND version=$2`, [id, q.current_version])).rows[0];
  if (String(v.valid_until).slice(0, 10) < today()) {
    await c.query(`UPDATE quotes SET status='expired' WHERE id=$1`, [id]);
    throw new HttpError(409, "This quote has expired. Revise it with a new validity date.", "conflict");
  }
  await c.query(`UPDATE quotes SET status='accepted', accepted_at=now() WHERE id=$1`, [id]);
  const jobId = await createJobFromQuote(c, ctx, id);
  await c.query(`UPDATE quotes SET status='converted' WHERE id=$1`, [id]);
  if (q.enquiry_id) await c.query(`UPDATE enquiries SET status='won' WHERE id=$1`, [q.enquiry_id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "quote.accepted", "quote", id, { jobId });
  return { jobId, created: true };
}

export const listQuotes = (c: Conn) =>
  c.query<any>(`SELECT q.*, p.name AS party_name, v.total_sell_minor, v.total_cost_minor, v.valid_until FROM quotes q
    JOIN parties p ON p.id=q.party_id JOIN quote_versions v ON v.quote_id=q.id AND v.version=q.current_version
    ORDER BY q.created_at DESC`).then((r) => r.rows);
