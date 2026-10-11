import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { extractText } from "../lib/text-extract.js";
import { badRequest, forbidden, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, optStr, recordId, reqStr } from "./common.js";
import { fetchDocumentFile } from "./documents.js";
import { validateAwb } from "./freight-commercial.js";

/**
 * Rule-based extraction of trade-document fields. The same text always gives the same result under the same EXTRACTOR_VERSION; no model is involved.
 * Every field carries the exact snippet it came from and whether a checksum or format rule confirmed it. Extractions are PROPOSALS: a person accepts
 * or rejects them, and only an accepted extraction can fill specific job reference fields — never automatically.
 */
export const EXTRACTOR_VERSION = "2026.10-1";
const CURRENCIES = new Set(["AED", "USD", "EUR", "GBP", "SAR", "QAR", "KWD", "BHD", "OMR", "INR", "CNY", "JPY", "CHF", "CAD", "AUD", "SGD", "HKD", "TRY", "EGP", "ZAR", "PKR", "LKR", "BDT", "THB", "MYR", "IDR", "KRW", "NZD", "SEK", "NOK", "DKK"]);
const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];

export interface Extracted { key: string; label: string; raw: string; value: string; valid: boolean; check: string; snippet: string; offset: number; note?: string }

/** ISO 6346: letters map to 10–38 skipping multiples of 11, weights 2^position, mod 11, then mod 10. */
export function iso6346Valid(code: string): boolean {
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(code)) return false;
  const letter = (ch: string) => { let n = 10; for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") { if (n % 11 === 0) n++; if (c === ch) return n; n++; } return 0; };
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (i < 4 ? letter(code[i]) : Number(code[i])) * 2 ** i;
  return (sum % 11) % 10 === Number(code[10]);
}
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function parseDate(s: string): { iso: string; note?: string } | null {
  const t = s.trim();
  let m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(t), y: number, mo: number, d: number, note: string | undefined;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})$/.exec(t))) { d = +m[1]; mo = +m[2]; y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; if (d <= 12 && mo <= 12 && d !== mo) note = "Read as day/month/year; check if the document uses month/day."; if (mo > 12) { [d, mo] = [mo, d]; note = "Month and day were swapped because the second number exceeds 12."; } }
  else if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(t))) { d = +m[1]; mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()]; y = +m[3]; if (!mo) return null; }
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return { iso: dt.toISOString().slice(0, 10), note };
}
const num = (s: string) => Number(s.replace(/,/g, ""));
const snip = (text: string, idx: number, len: number) => text.slice(Math.max(0, idx - 20), Math.min(text.length, idx + len + 20)).replace(/\s+/g, " ").trim();

export function extractFields(text: string): Extracted[] {
  const out: Extracted[] = [];
  const add = (f: Omit<Extracted, "snippet"> & { len: number }) => { const { len, ...rest } = f; out.push({ ...rest, snippet: snip(text, f.offset, len) }); };
  const first = (re: RegExp) => { const m = re.exec(text); return m ? { m, offset: m.index } : null; };

  let r = first(/\b(?:tax\s+invoice|commercial\s+invoice|invoice)\s*(?:no\.?|number|#|ref\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,30})/i) ?? first(/\binv(?:oice)?\s*no\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,30})/i);
  if (r) add({ key: "invoice_number", label: "Invoice number", raw: r.m[1], value: r.m[1].toUpperCase(), valid: true, check: "label match", offset: r.offset, len: r.m[0].length });

  r = first(/\b(?:invoice\s+date|date\s+of\s+issue|issue\s+date|dated?)\s*[:\-]?\s*(\d{1,4}[-\/.]\d{1,2}[-\/.]\d{1,4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4})/i);
  if (r) { const d = parseDate(r.m[1]); add({ key: "invoice_date", label: "Invoice date", raw: r.m[1], value: d?.iso ?? r.m[1], valid: !!d, check: "calendar date", offset: r.offset, len: r.m[0].length, note: d?.note }); }

  r = first(/\b(?:grand\s+total|total\s+(?:amount|value|invoice(?:\s+value)?)|invoice\s+total|amount\s+due|total)\s*(?:\(([A-Z]{3})\))?\s*[:\-]?\s*([A-Z]{3})?\s*([0-9][0-9,]*(?:\.\d{1,2})?)\s*([A-Z]{3})?/i);
  if (r) {
    const ccy = [r.m[1], r.m[2], r.m[4]].map((x) => x?.toUpperCase()).find((x) => x && CURRENCIES.has(x));
    add({ key: "total_amount", label: "Total amount", raw: r.m[3], value: String(num(r.m[3])), valid: Number.isFinite(num(r.m[3])) && num(r.m[3]) > 0, check: "numeric", offset: r.offset, len: r.m[0].length });
    if (ccy) add({ key: "currency", label: "Currency", raw: ccy, value: ccy, valid: true, check: "ISO 4217 list", offset: r.offset, len: r.m[0].length });
  }
  r = first(/\bcurrency\s*[:\-]?\s*([A-Z]{3})\b/);
  if (r && !out.some((f) => f.key === "currency")) add({ key: "currency", label: "Currency", raw: r.m[1], value: r.m[1], valid: CURRENCIES.has(r.m[1]), check: "ISO 4217 list", offset: r.offset, len: r.m[0].length });

  const inc = first(new RegExp(`\\b(${INCOTERMS.join("|")})\\b(?:\\s+[A-Z][A-Za-z ,.-]{2,40})?`));
  if (inc) add({ key: "incoterm", label: "Incoterm", raw: inc.m[1], value: inc.m[1], valid: true, check: "Incoterms 2020 list", offset: inc.offset, len: inc.m[0].length });

  const hs = first(/\b(?:HS|HSN|H\.S\.|tariff)\s*(?:code|no\.?)?\s*[:#-]?\s*(\d{4}[.\s]?\d{2}(?:[.\s]?\d{2,4})?)\b/i);
  if (hs) { const digits = hs.m[1].replace(/\D/g, ""); add({ key: "hs_code", label: "HS code", raw: hs.m[1], value: digits, valid: [6, 8, 10].includes(digits.length), check: "6, 8 or 10 digits", offset: hs.offset, len: hs.m[0].length, note: digits.length === 8 ? undefined : digits.length === 6 ? "Six-digit HS heading only; the UAE tariff uses eight digits." : undefined }); }

  const seenC = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z]{3}[UJZ])\s?(\d{6})\s?(\d)\b/g)) {
    const code = `${m[1]}${m[2]}${m[3]}`;
    if (seenC.has(code)) continue; seenC.add(code);
    add({ key: "container_number", label: "Container number", raw: m[0], value: code, valid: iso6346Valid(code), check: "ISO 6346 check digit", offset: m.index!, len: m[0].length });
    if (seenC.size >= 10) break;
  }

  const awb = first(/\b(?:AWB|MAWB|HAWB|air\s*waybill)\s*(?:no\.?|number|#)?\s*[:#-]?\s*(\d{3})[- ]?(\d{7})(\d)\b/i);
  if (awb) { let valid = true, value = `${awb.m[1]}-${awb.m[2]}${awb.m[3]}`; try { validateAwb(value); } catch { valid = false; } add({ key: "awb_number", label: "Air waybill number", raw: awb.m[0], value, valid, check: "IATA check digit (serial mod 7)", offset: awb.offset, len: awb.m[0].length }); }

  const bl = first(/\b(?:B\/L|BL|bill\s+of\s+lading)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Z]{2,5}[A-Z0-9\-\/]{5,24})\b/i);
  if (bl && !/^(?:OF|NO|NUMBER)$/i.test(bl.m[1])) add({ key: "bl_number", label: "Bill of lading number", raw: bl.m[1], value: bl.m[1].toUpperCase(), valid: true, check: "label match", offset: bl.offset, len: bl.m[0].length });

  const pk = first(/\b(\d{1,6})\s*(?:packages|pkgs?|ctns?|cartons?|pieces|pcs|pallets|plts)\b/i);
  if (pk) add({ key: "packages", label: "Packages", raw: pk.m[0], value: pk.m[1], valid: +pk.m[1] > 0, check: "numeric", offset: pk.offset, len: pk.m[0].length });

  const gw = first(/\bgross\s*(?:weight|wt\.?)\s*[:\-]?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(kgs?|kilograms?|lbs?|pounds?|t|tons?|tonnes?)?/i);
  if (gw) {
    const unit = (gw.m[2] ?? "kg").toLowerCase(), v = num(gw.m[1]), kg = /^(lb|pound)/.test(unit) ? v * 0.45359237 : /^(t$|ton)/.test(unit) ? v * 1000 : v;
    add({ key: "gross_weight_kg", label: "Gross weight (kg)", raw: gw.m[0], value: String(Math.round(kg * 1000) / 1000), valid: Number.isFinite(kg) && kg > 0, check: gw.m[2] ? `unit ${unit}` : "unit assumed kg", offset: gw.offset, len: gw.m[0].length, note: gw.m[2] ? undefined : "No unit printed; read as kilograms." });
  }
  const vol = first(/\b(?:volume|measurement|cbm)\s*[:\-]?\s*([0-9]+(?:\.\d+)?)\s*(?:cbm|m3|m³)/i);
  if (vol) add({ key: "volume_cbm", label: "Volume (cbm)", raw: vol.m[0], value: String(num(vol.m[1])), valid: num(vol.m[1]) > 0, check: "numeric with unit", offset: vol.offset, len: vol.m[0].length });

  const trn = first(/\b(?:TRN|tax\s+registration\s+(?:no\.?|number))\s*[:#-]?\s*(\d{15})\b/i);
  if (trn) add({ key: "tax_registration", label: "Tax registration number (TRN)", raw: trn.m[1], value: trn.m[1], valid: true, check: "15 digits", offset: trn.offset, len: trn.m[0].length });

  return out.sort((a, b) => a.offset - b.offset || a.key.localeCompare(b.key));
}

export async function extractFromDocument(c: Conn, ctx: Ctx, documentId: string) {
  require(ctx, "doc.write");
  await assertWritable(c, ctx.tenantId);
  if (ctx.partyId || ctx.supportStaffId) throw forbidden("Extraction needs an operating company session.");
  const doc = await must(c.query<any>(`SELECT * FROM documents WHERE id=$1 AND status='issued' AND NOT hold`, [recordId(documentId, "Document")]), "Issued document");
  const buf = await fetchDocumentFile(doc.storage_key, doc.tenant_id, doc.sha256);
  const t = extractText(buf, doc.mime ?? "", doc.filename ?? doc.title ?? "");
  const textHash = sha256(t.text);
  const old = (await c.query<any>(`SELECT * FROM document_extractions WHERE document_id=$1 AND extractor_version=$2 AND text_hash=$3`, [doc.id, EXTRACTOR_VERSION, textHash])).rows[0];
  if (old) return old;
  const fields = t.readable ? extractFields(t.text) : [];
  const warnings: string[] = [];
  if (!t.readable) warnings.push(t.note ?? "No readable text.");
  else if (!fields.length) warnings.push("No recognised fields were found in this document's text.");
  for (const f of fields) { if (!f.valid) warnings.push(`${f.label} “${f.raw}” failed its ${f.check} check — do not rely on it.`); if (f.note) warnings.push(`${f.label}: ${f.note}`); }
  const row = (await c.query<any>(
    `INSERT INTO document_extractions(tenant_id,document_id,doc_sha256,extractor_version,text_hash,readable,fields,warnings,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ctx.tenantId, doc.id, doc.sha256, EXTRACTOR_VERSION, textHash, t.readable, JSON.stringify(fields), JSON.stringify(warnings), ctx.userId])).rows[0];
  await audit(c, ctx.tenantId, actorOf(ctx), "document.extracted", "document", doc.id, { extraction: row.id, fields: fields.length, readable: t.readable });
  return row;
}

export async function decideExtraction(c: Conn, ctx: Ctx, id: string, accept: boolean, note?: string) {
  require(ctx, "doc.write");
  const x = await must(c.query<any>(`SELECT * FROM document_extractions WHERE id=$1 FOR UPDATE`, [recordId(id, "Extraction")]), "Extraction");
  if (x.status !== "proposed") throw badRequest(`This extraction is already ${x.status}.`);
  const doc = await must(c.query<any>(`SELECT sha256 FROM documents WHERE id=$1 AND status='issued' AND NOT hold`, [x.document_id]), "Issued document");
  if (doc.sha256 !== x.doc_sha256) throw badRequest("The document changed after extraction; extract it again.");
  const reason = accept ? optStr(note, 500) : reqStr(note, "Reason for rejecting", 500);
  await c.query(`UPDATE document_extractions SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1`, [x.id, accept ? "accepted" : "rejected", ctx.userId, reason]);
  await audit(c, ctx.tenantId, actorOf(ctx), accept ? "document.extraction_accepted" : "document.extraction_rejected", "document", x.document_id, { extraction: x.id });
}

const REF_TARGET: Record<string, string> = { awb_number: "master_ref", bl_number: "master_ref" };
/** Apply chosen, valid, accepted fields to the job's reference columns only. Existing different values are never overwritten silently. */
export async function applyExtractionToJob(c: Conn, ctx: Ctx, id: string, jobId: string, keys: string[], overwrite = false) {
  require(ctx, "job.write");
  const x = await must(c.query<any>(`SELECT * FROM document_extractions WHERE id=$1 FOR UPDATE`, [recordId(id, "Extraction")]), "Extraction");
  if (x.status !== "accepted") throw badRequest("Accept the extraction before applying anything from it.");
  const job = await must(c.query<any>(`SELECT * FROM jobs WHERE id=$1 FOR UPDATE`, [recordId(jobId, "Job")]), "Job");
  const doc = await must(c.query<any>(`SELECT job_id, sha256 FROM documents WHERE id=$1`, [x.document_id]), "Document");
  if (doc.job_id !== job.id) throw badRequest("Only a document attached to this job can fill its references.");
  if (!keys.length) throw badRequest("Choose the fields to apply.");
  const sets: string[] = [], vals: any[] = [job.id], applied: string[] = [];
  for (const k of keys) {
    const col = REF_TARGET[k];
    if (!col) throw badRequest(`“${k}” cannot be applied to a job reference.`);
    const f = (x.fields as Extracted[]).find((y) => y.key === k);
    if (!f || !f.valid) throw badRequest(`“${k}” was not extracted with a passing check.`);
    if (job[col] && job[col] !== f.value && !overwrite) throw badRequest(`The job already has ${col.replace("_", " ")} “${job[col]}”. Confirm the overwrite to replace it.`);
    if (sets.some((s) => s.startsWith(col))) continue;
    vals.push(f.value); sets.push(`${col}=$${vals.length}`); applied.push(k);
  }
  await c.query(`UPDATE jobs SET ${sets.join(", ")} WHERE id=$1`, vals);
  await c.query(`UPDATE document_extractions SET applied_job_id=$2, applied_fields=$3 WHERE id=$1`, [x.id, job.id, applied]);
  await audit(c, ctx.tenantId, actorOf(ctx), "document.extraction_applied", "job", job.id, { extraction: x.id, applied });
}

export async function listExtractions(c: Conn, documentId?: string) {
  return (await c.query<any>(`SELECT x.*, d.title FROM document_extractions x JOIN documents d ON d.id=x.document_id WHERE ($1::uuid IS NULL OR x.document_id=$1) ORDER BY x.created_at DESC LIMIT 100`, [documentId || null])).rows;
}
