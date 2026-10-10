import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, TAX_CODES, badRequest, forbidden, toMinor } from "../lib/util.js";
import { assertWritable, consumeQuota } from "../platform/entitlements.js";
import { must, nextNumber, optStr, reqStr } from "./common.js";
import { issueInvoice } from "./finance.js";
import { storeDocument } from "./documents.js";

/**
 * Customs brokerage CASE MANAGEMENT. This module prepares, controls and hands over; it does not file. The declaration is lodged by a licensed
 * broker in the official channel, and only the official declaration number, assessment and release are recorded back here. There is no
 * built-in tariff: HS codes and duty/VAT rates are entered by the broker and the figures are ESTIMATES, never advice.
 */
export const DIRECTIONS: Record<string, string> = { import: "Import", export: "Export", re_export: "Re-export", transit: "Transit" };
export const MODES: Record<string, string> = { sea: "Sea", air: "Air", road: "Road" };
export const CHANNELS: Record<string, string> = { dubai_trade: "Dubai Trade", mirsal2: "Mirsal 2", other: "Other channel" };
export const STATUS_LABEL: Record<string, string> = {
  collecting: "collecting documents", in_review: "awaiting approval", approved: "approved — ready to hand over", submitted: "submitted (official channel)", assessed: "assessed",
  inspection: "held for inspection", released: "released", rejected: "rejected", closed: "closed", cancelled: "cancelled",
};
const EDITABLE = ["collecting", "in_review"];

/** Suggested evidence only. What a given declaration actually requires is the broker's call, so every item can be edited, waived (with a reason) or added to. */
export const CHECKLIST_TEMPLATES: Record<string, { kind: string; label: string; mandatory: boolean }[]> = {
  import: [
    { kind: "commercial_invoice", label: "Commercial invoice", mandatory: true }, { kind: "packing_list", label: "Packing list", mandatory: true },
    { kind: "transport_document", label: "Bill of lading / airway bill / CMR", mandatory: true }, { kind: "delivery_order", label: "Delivery order (carrier release)", mandatory: true },
    { kind: "certificate_of_origin", label: "Certificate of origin (if origin treatment is claimed)", mandatory: false }, { kind: "insurance_certificate", label: "Insurance certificate", mandatory: false },
  ],
  export: [
    { kind: "commercial_invoice", label: "Commercial invoice", mandatory: true }, { kind: "packing_list", label: "Packing list", mandatory: true },
    { kind: "transport_document", label: "Booking / airway bill / CMR", mandatory: true },
  ],
  re_export: [
    { kind: "commercial_invoice", label: "Commercial invoice", mandatory: true }, { kind: "packing_list", label: "Packing list", mandatory: true },
    { kind: "transport_document", label: "Bill of lading / airway bill / CMR", mandatory: true }, { kind: "customs_declaration", label: "Original import declaration (reference / copy)", mandatory: true },
  ],
  transit: [
    { kind: "commercial_invoice", label: "Commercial invoice", mandatory: true }, { kind: "packing_list", label: "Packing list", mandatory: true },
    { kind: "transport_document", label: "Bill of lading / airway bill / CMR", mandatory: true },
  ],
};

const bigRound = (num: bigint, den: bigint) => Number((num * 2n + den) / (den * 2n));       // round half up, exact for large products
const country = (v: unknown, label: string, required = false) => {
  const s = String(v ?? "").trim().toUpperCase();
  if (!s) { if (required) throw badRequest(`${label} is required.`); return null; }
  if (!/^[A-Z]{2}$/.test(s)) throw badRequest(`${label} must be a 2-letter country code (e.g. AE, CN).`);
  return s;
};
const money = (v: unknown, label: string) => { const s = String(v ?? "").trim(); if (!s) return 0; try { return toMinor(s); } catch { throw badRequest(`${label} must be a valid amount.`); } };
export const normalizeHs = (v: unknown) => {
  const d = String(v ?? "").replace(/[\s.\-]/g, "");
  if (!/^\d{6,12}$/.test(d)) throw badRequest("The HS code must be 6 to 12 digits (dots and spaces are allowed). Classification is the broker's responsibility; the software only checks the format.");
  return d;
};

async function logEvent(c: Conn, ctx: Ctx, caseId: string, kind: string, detail: Record<string, unknown> = {}) {
  await c.query(`INSERT INTO cus_events(tenant_id,case_id,kind,detail,actor_user_id) VALUES ($1,$2,$3,$4,$5)`, [ctx.tenantId, caseId, kind, JSON.stringify(detail), ctx.userId]);
}
const lockCase = async (c: Conn, id: string) => must(c.query<any>(`SELECT * FROM cus_cases WHERE id=$1 FOR UPDATE`, [id]), "Customs case");
const isOwner = (ctx: Ctx) => ctx.roles.includes("owner");

// ───────────────────────── valuation (an ESTIMATE from the broker's own rates)
/** Allocate `total` over `weights` so the parts sum to exactly `total` (largest remainder). */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length || sum <= 0 || total === 0) return weights.map(() => 0);
  const T = BigInt(total), S = BigInt(sum);
  const parts = weights.map((w) => (T * BigInt(w)) / S), rem = weights.map((w) => (T * BigInt(w)) % S);
  let left = Number(T - parts.reduce((a, b) => a + b, 0n));
  const order = rem.map((r, i) => [r, i] as const).sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] > b[0] ? -1 : 1));
  const out = parts.map(Number);
  for (const [, i] of order) { if (left <= 0) break; out[i]++; left--; }
  return out;
}

export interface Totals { value: number; alloc: number; cifAed: number; duty: number; vat: number; weightNet: number; weightGross: number }
/** Recompute every line's allocation, CIF (AED), duty and VAT from the case header and rates. Pure arithmetic on entered figures. */
export async function recompute(c: Conn, caseId: string): Promise<Totals> {
  const k = (await c.query<any>(`SELECT * FROM cus_cases WHERE id=$1`, [caseId])).rows[0];
  const lines = (await c.query<any>(`SELECT * FROM cus_lines WHERE case_id=$1 ORDER BY line_no`, [caseId])).rows;
  const alloc = allocate(Number(k.freight_minor) + Number(k.insurance_minor) + Number(k.other_minor), lines.map((l) => Number(l.value_minor)));
  const fx = BigInt(Math.round(Number(k.fx_rate) * 1_000_000));
  const t: Totals = { value: 0, alloc: 0, cifAed: 0, duty: 0, vat: 0, weightNet: 0, weightGross: 0 };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], cif = Number(l.value_minor) + alloc[i];
    const cifAed = bigRound(BigInt(cif) * fx, 1_000_000n);
    const duty = bigRound(BigInt(cifAed) * BigInt(l.duty_rate_bps), 10_000n);
    const vat = bigRound(BigInt(cifAed + duty) * BigInt(l.vat_rate_bps), 10_000n);
    await c.query(`UPDATE cus_lines SET alloc_minor=$2, cif_aed_minor=$3, duty_minor=$4, vat_minor=$5 WHERE id=$1`, [l.id, alloc[i], cifAed, duty, vat]);
    t.value += Number(l.value_minor); t.alloc += alloc[i]; t.cifAed += cifAed; t.duty += duty; t.vat += vat; t.weightNet += Number(l.net_kg); t.weightGross += Number(l.gross_kg);
  }
  return t;
}

// ───────────────────────── cases
export interface CaseInput {
  party_id: string; job_id?: string; direction: string; mode: string; customs_office?: string; origin_country?: string; destination_country?: string; incoterm?: string;
  currency?: string; fx_rate?: string | number; freight?: string; insurance?: string; other?: string; transport_ref?: string; container_nos?: string; vessel_flight?: string; eta?: string;
}
function header(f: Partial<CaseInput>, existing?: any) {
  const direction = f.direction ?? existing?.direction, mode = f.mode ?? existing?.mode;
  if (!DIRECTIONS[direction]) throw badRequest("Choose import, export, re-export or transit.");
  if (!MODES[mode]) throw badRequest("Choose sea, air or road.");
  const currency = String(f.currency ?? existing?.currency ?? "AED").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw badRequest("Currency must be a 3-letter code (e.g. AED, USD).");
  const fx = f.fx_rate === undefined || String(f.fx_rate).trim() === "" ? Number(existing?.fx_rate ?? 1) : Number(f.fx_rate);
  if (!Number.isFinite(fx) || fx <= 0 || fx > 100000) throw badRequest("The exchange rate to AED must be a positive number.");
  if (currency === "AED" && fx !== 1) throw badRequest("For AED the exchange rate is 1.");
  const eta = f.eta === undefined ? existing?.eta ?? null : String(f.eta).trim() || null;
  if (eta && !/^\d{4}-\d{2}-\d{2}$/.test(String(eta).slice(0, 10))) throw badRequest("ETA is not a valid date.");
  return {
    direction, mode, currency, fx,
    office: f.customs_office === undefined ? existing?.customs_office ?? null : optStr(f.customs_office, 120),
    origin: f.origin_country === undefined ? existing?.origin_country ?? null : country(f.origin_country, "Origin country"),
    dest: f.destination_country === undefined ? existing?.destination_country ?? null : country(f.destination_country, "Destination country"),
    incoterm: f.incoterm === undefined ? existing?.incoterm ?? null : optStr(f.incoterm, 10)?.toUpperCase() ?? null,
    freight: f.freight === undefined ? Number(existing?.freight_minor ?? 0) : money(f.freight, "Freight"),
    insurance: f.insurance === undefined ? Number(existing?.insurance_minor ?? 0) : money(f.insurance, "Insurance"),
    other: f.other === undefined ? Number(existing?.other_minor ?? 0) : money(f.other, "Other charges"),
    ref: f.transport_ref === undefined ? existing?.transport_ref ?? null : optStr(f.transport_ref, 60),
    containers: f.container_nos === undefined ? existing?.container_nos ?? null : optStr(f.container_nos, 300),
    vessel: f.vessel_flight === undefined ? existing?.vessel_flight ?? null : optStr(f.vessel_flight, 80),
    eta: eta ? String(eta).slice(0, 10) : null,
  };
}

export async function createCase(c: Conn, ctx: Ctx, f: CaseInput) {
  require(ctx, "cus.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.party_id]), "Customer");
  if (f.job_id) await must(c.query(`SELECT id FROM jobs WHERE id=$1`, [f.job_id]), "Job");
  const h = header(f);
  const no = await nextNumber(c, ctx.tenantId, "cus_case", "CUS");
  const r = await c.query<{ id: string }>(
    `INSERT INTO cus_cases(tenant_id,no,party_id,job_id,direction,mode,customs_office,origin_country,destination_country,incoterm,currency,fx_rate,freight_minor,insurance_minor,other_minor,
       transport_ref,container_nos,vessel_flight,eta,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [ctx.tenantId, no, f.party_id, f.job_id || null, h.direction, h.mode, h.office, h.origin, h.dest, h.incoterm, h.currency, h.fx, h.freight, h.insurance, h.other, h.ref, h.containers, h.vessel, h.eta, ctx.userId]);
  const id = r.rows[0].id;
  await consumeQuota(c, ctx.tenantId, "cus_cases_per_month", `cus:${id}`);
  for (const t of CHECKLIST_TEMPLATES[h.direction]) await c.query(`INSERT INTO cus_checklist(tenant_id,case_id,kind,label,mandatory,source) VALUES ($1,$2,$3,$4,$5,'template')`, [ctx.tenantId, id, t.kind, t.label, t.mandatory]);
  await logEvent(c, ctx, id, "created", { direction: h.direction });
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_case.created", "cus_case", id, { no });
  return { id, no };
}

/** Header/line edits are allowed while collecting; an edit during review sends the case back to collecting (the approval was for something that no longer exists). */
async function openForEdit(c: Conn, ctx: Ctx, id: string) {
  const k = await lockCase(c, id);
  if (!EDITABLE.includes(k.status)) throw badRequest(`A case that is ${STATUS_LABEL[k.status] ?? k.status} cannot be edited${k.status === "approved" ? " — reopen it first" : ""}.`);
  if (k.status === "in_review") { await c.query(`UPDATE cus_cases SET status='collecting' WHERE id=$1`, [id]); await logEvent(c, ctx, id, "edited_during_review", { note: "returned to collecting" }); }
  return k;
}

export async function updateCase(c: Conn, ctx: Ctx, id: string, f: Partial<CaseInput>) {
  require(ctx, "cus.write");
  await assertWritable(c, ctx.tenantId);
  const k = await openForEdit(c, ctx, id);
  const h = header(f, k);
  await c.query(
    `UPDATE cus_cases SET direction=$2,mode=$3,customs_office=$4,origin_country=$5,destination_country=$6,incoterm=$7,currency=$8,fx_rate=$9,freight_minor=$10,insurance_minor=$11,other_minor=$12,
       transport_ref=$13,container_nos=$14,vessel_flight=$15,eta=$16 WHERE id=$1`,
    [id, h.direction, h.mode, h.office, h.origin, h.dest, h.incoterm, h.currency, h.fx, h.freight, h.insurance, h.other, h.ref, h.containers, h.vessel, h.eta]);
  await recompute(c, id);
  await logEvent(c, ctx, id, "header_updated");
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_case.updated", "cus_case", id);
}

// ───────────────────────── lines
export interface LineInput { description: string; hs_code: string; origin_country?: string; qty?: string | number; uom?: string; net_kg?: string | number; gross_kg?: string | number; value: string | number; duty_pct?: string | number; vat_pct?: string | number; restricted?: boolean | string; restriction_note?: string }
function lineValues(f: LineInput) {
  const value = toMinor(String(f.value ?? "")), qty = Number(f.qty ?? 1), net = Number(f.net_kg ?? 0), gross = Number(f.gross_kg ?? f.net_kg ?? 0);
  if (!(value > 0)) throw badRequest("The line value must be above zero.");
  if (!(qty > 0)) throw badRequest("Quantity must be above zero.");
  if (!(net >= 0) || !(gross >= net)) throw badRequest("Gross weight cannot be below net weight.");
  const duty = Math.round(Number(f.duty_pct ?? 0) * 100), vat = Math.round(Number(f.vat_pct ?? 5) * 100);
  if (!Number.isFinite(duty) || duty < 0 || duty > 10000) throw badRequest("The duty rate must be between 0% and 100%.");
  if (!Number.isFinite(vat) || vat < 0 || vat > 2500) throw badRequest("The VAT rate must be between 0% and 25%.");
  const restricted = f.restricted === true || f.restricted === "1" || f.restricted === "on";
  if (restricted && !String(f.restriction_note ?? "").trim()) throw badRequest("Say what permit or specialist handling this restricted line needs.");
  return { desc: reqStr(f.description, "Description", 300), hs: normalizeHs(f.hs_code), origin: country(f.origin_country, "Origin country"), qty, uom: optStr(f.uom, 20) ?? "unit", net, gross, value, duty, vat, restricted, note: restricted ? optStr(f.restriction_note, 300) : null };
}
/** Keeps exactly one mandatory permit item while any line is flagged restricted; removes it again only if nobody touched it. */
async function syncRestrictedItem(c: Conn, ctx: Ctx, caseId: string) {
  const n = Number((await c.query<any>(`SELECT count(*) n FROM cus_lines WHERE case_id=$1 AND restricted`, [caseId])).rows[0].n);
  const item = (await c.query<any>(`SELECT * FROM cus_checklist WHERE case_id=$1 AND source='restricted_goods'`, [caseId])).rows[0];
  if (n && !item) await c.query(`INSERT INTO cus_checklist(tenant_id,case_id,kind,label,mandatory,source) VALUES ($1,$2,'import_permit','Permit / NOC for restricted goods',true,'restricted_goods')`, [ctx.tenantId, caseId]);
  if (!n && item && item.status === "missing") await c.query(`DELETE FROM cus_checklist WHERE id=$1`, [item.id]);
}

export async function addLine(c: Conn, ctx: Ctx, caseId: string, f: LineInput) {
  require(ctx, "cus.write");
  await assertWritable(c, ctx.tenantId);
  await openForEdit(c, ctx, caseId);
  const v = lineValues(f);
  const next = Number((await c.query<any>(`SELECT coalesce(max(line_no),0)+1 n FROM cus_lines WHERE case_id=$1`, [caseId])).rows[0].n);
  if (next > 200) throw badRequest("A case holds at most 200 lines; split the consignment.");
  const r = await c.query<{ id: string }>(
    `INSERT INTO cus_lines(tenant_id,case_id,line_no,description,hs_code,origin_country,qty,uom,net_kg,gross_kg,value_minor,duty_rate_bps,vat_rate_bps,restricted,restriction_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [ctx.tenantId, caseId, next, v.desc, v.hs, v.origin, v.qty, v.uom, v.net, v.gross, v.value, v.duty, v.vat, v.restricted, v.note]);
  await syncRestrictedItem(c, ctx, caseId);
  const t = await recompute(c, caseId);
  await logEvent(c, ctx, caseId, "line_added", { line_no: next, hs: v.hs });
  return { id: r.rows[0].id, line_no: next, totals: t };
}
export async function updateLine(c: Conn, ctx: Ctx, lineId: string, f: LineInput) {
  require(ctx, "cus.write");
  const l = await must(c.query<any>(`SELECT * FROM cus_lines WHERE id=$1`, [lineId]), "Line");
  await openForEdit(c, ctx, l.case_id);
  const v = lineValues(f);
  await c.query(`UPDATE cus_lines SET description=$2,hs_code=$3,origin_country=$4,qty=$5,uom=$6,net_kg=$7,gross_kg=$8,value_minor=$9,duty_rate_bps=$10,vat_rate_bps=$11,restricted=$12,restriction_note=$13 WHERE id=$1`,
    [lineId, v.desc, v.hs, v.origin, v.qty, v.uom, v.net, v.gross, v.value, v.duty, v.vat, v.restricted, v.note]);
  await syncRestrictedItem(c, ctx, l.case_id);
  const t = await recompute(c, l.case_id);
  await logEvent(c, ctx, l.case_id, "line_updated", { line_no: l.line_no });
  return t;
}
export async function removeLine(c: Conn, ctx: Ctx, lineId: string) {
  require(ctx, "cus.write");
  const l = await must(c.query<any>(`SELECT * FROM cus_lines WHERE id=$1`, [lineId]), "Line");
  await openForEdit(c, ctx, l.case_id);
  await c.query(`DELETE FROM cus_lines WHERE id=$1`, [lineId]);
  // renumber 1..n with no gaps; park the numbers above the 200-line cap first so the unique key is never hit mid-update
  await c.query(`UPDATE cus_lines SET line_no = line_no + 1000 WHERE case_id=$1`, [l.case_id]);
  await c.query(`WITH n AS (SELECT id, row_number() OVER (ORDER BY line_no) rn FROM cus_lines WHERE case_id=$1) UPDATE cus_lines x SET line_no = n.rn FROM n WHERE x.id=n.id`, [l.case_id]);
  await syncRestrictedItem(c, ctx, l.case_id);
  const t = await recompute(c, l.case_id);
  await logEvent(c, ctx, l.case_id, "line_removed", { line_no: l.line_no });
  return t;
}

// ───────────────────────── evidence checklist
export async function addChecklistItem(c: Conn, ctx: Ctx, caseId: string, f: { label: string; kind?: string; mandatory?: boolean | string }) {
  require(ctx, "cus.write");
  await openForEdit(c, ctx, caseId);
  const r = await c.query<{ id: string }>(`INSERT INTO cus_checklist(tenant_id,case_id,kind,label,mandatory,source) VALUES ($1,$2,$3,$4,$5,'manual') RETURNING id`,
    [ctx.tenantId, caseId, optStr(f.kind, 40) ?? "other", reqStr(f.label, "Label", 160), f.mandatory === true || f.mandatory === "1" || f.mandatory === "on"]);
  await logEvent(c, ctx, caseId, "checklist_item_added", { label: f.label });
  return r.rows[0].id;
}
/** Upload evidence to the case (stored like every document: tenant-prefixed, type-checked, scanned) and tick the item it answers. */
export async function attachEvidence(c: Conn, ctx: Ctx, caseId: string, f: { item_id?: string; kind: string; title: string; filename: string; data: Buffer }) {
  require(ctx, "cus.write");
  const k = await lockCase(c, caseId);
  if (["closed", "cancelled"].includes(k.status)) throw badRequest(`A ${k.status} case takes no more documents.`);
  const docId = await storeDocument(c, ctx, { cus_case_id: caseId, kind: f.kind, title: f.title, filename: f.filename, data: f.data });
  if (f.item_id) {
    const it = await must(c.query<any>(`SELECT * FROM cus_checklist WHERE id=$1 AND case_id=$2`, [f.item_id, caseId]), "Checklist item");
    if (it.status === "waived") throw badRequest("That item was waived; undo the waiver first.");
    await c.query(`UPDATE cus_checklist SET status='received', document_id=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [it.id, docId, ctx.userId]);
  }
  await logEvent(c, ctx, caseId, "evidence_attached", { document_id: docId, item_id: f.item_id ?? null });
  return docId;
}
export async function markSeen(c: Conn, ctx: Ctx, itemId: string, note: string) {
  require(ctx, "cus.write");
  const it = await must(c.query<any>(`SELECT * FROM cus_checklist WHERE id=$1`, [itemId]), "Checklist item");
  await openForEdit(c, ctx, it.case_id);
  await c.query(`UPDATE cus_checklist SET status='received', note=$2, waived_reason=NULL, decided_by=$3, decided_at=now() WHERE id=$1`, [itemId, reqStr(note, "A note saying where the original was seen", 200), ctx.userId]);
  await logEvent(c, ctx, it.case_id, "checklist_item_seen", { label: it.label });
}
/** Waiving a requirement is a compliance decision: it needs approval rights and a written reason. */
export async function waiveItem(c: Conn, ctx: Ctx, itemId: string, reason: string) {
  require(ctx, "cus.approve");
  const it = await must(c.query<any>(`SELECT * FROM cus_checklist WHERE id=$1`, [itemId]), "Checklist item");
  await openForEdit(c, ctx, it.case_id);
  await c.query(`UPDATE cus_checklist SET status='waived', waived_reason=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [itemId, reqStr(reason, "A reason for waiving this document", 300), ctx.userId]);
  await logEvent(c, ctx, it.case_id, "checklist_item_waived", { label: it.label, reason });
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_checklist.waived", "cus_case", it.case_id, { label: it.label, reason });
}
export async function resetItem(c: Conn, ctx: Ctx, itemId: string) {
  require(ctx, "cus.write");
  const it = await must(c.query<any>(`SELECT * FROM cus_checklist WHERE id=$1`, [itemId]), "Checklist item");
  await openForEdit(c, ctx, it.case_id);
  await c.query(`UPDATE cus_checklist SET status='missing', document_id=NULL, note=NULL, waived_reason=NULL, decided_by=NULL, decided_at=NULL WHERE id=$1`, [itemId]);
  await logEvent(c, ctx, it.case_id, "checklist_item_reset", { label: it.label });
}

/** Everything that must be true before a case may go to a second person. Returned together so a broker can fix them in one pass. */
export async function readinessIssues(c: Conn, caseId: string): Promise<string[]> {
  const k = (await c.query<any>(`SELECT * FROM cus_cases WHERE id=$1`, [caseId])).rows[0];
  const issues: string[] = [];
  if (!k.transport_ref) issues.push("Enter the bill of lading / airway bill / CMR number.");
  if (!k.customs_office) issues.push("Enter the customs office / port of entry.");
  const lines = Number((await c.query<any>(`SELECT count(*) n FROM cus_lines WHERE case_id=$1`, [caseId])).rows[0].n);
  if (!lines) issues.push("Add at least one goods line with its HS code and value.");
  if (k.direction === "import" && !k.origin_country) issues.push("Enter the country of origin / dispatch.");
  const missing = (await c.query<any>(`SELECT label FROM cus_checklist WHERE case_id=$1 AND mandatory AND status='missing' ORDER BY label`, [caseId])).rows;
  for (const m of missing) issues.push(`Missing: ${m.label}.`);
  return issues;
}

// ───────────────────────── maker → checker → handover
export async function submitForReview(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "cus.write");
  const k = await lockCase(c, id);
  if (k.status !== "collecting") throw badRequest(`A case that is ${STATUS_LABEL[k.status] ?? k.status} cannot be sent for review.`);
  const issues = await readinessIssues(c, id);
  if (issues.length) throw badRequest(`Not ready for review. ${issues.join(" ")}`);
  await c.query(`UPDATE cus_cases SET status='in_review', prepared_by=$2 WHERE id=$1`, [id, ctx.userId]);
  await logEvent(c, ctx, id, "sent_for_review");
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_case.sent_for_review", "cus_case", id);
}

/** Approval by someone other than the person who prepared the case (the owner may approve their own: small companies have one user). Snapshots the estimate. */
export async function approveCase(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "cus.approve");
  const k = await lockCase(c, id);
  if (k.status !== "in_review") throw badRequest(`Only a case awaiting approval can be approved (this one is ${STATUS_LABEL[k.status] ?? k.status}).`);
  if (k.prepared_by === ctx.userId && !isOwner(ctx)) throw forbidden("A case cannot be approved by the person who prepared it.");
  const issues = await readinessIssues(c, id);
  if (issues.length) throw badRequest(`Not ready to approve. ${issues.join(" ")}`);
  const t = await recompute(c, id);
  await c.query(`UPDATE cus_cases SET status='approved', approved_by=$2, approved_at=now(), estimated_duty_minor=$3, estimated_vat_minor=$4 WHERE id=$1`, [id, ctx.userId, t.duty, t.vat]);
  await logEvent(c, ctx, id, "approved", { estimated_duty_minor: t.duty, estimated_vat_minor: t.vat });
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_case.approved", "cus_case", id);
}
export async function returnForChanges(c: Conn, ctx: Ctx, id: string, reason: string) {
  require(ctx, "cus.approve");
  const k = await lockCase(c, id);
  if (k.status !== "in_review") throw badRequest("Only a case awaiting approval can be sent back.");
  await c.query(`UPDATE cus_cases SET status='collecting' WHERE id=$1`, [id]);
  await logEvent(c, ctx, id, "returned_for_changes", { reason: reqStr(reason, "Reason", 300) });
}
/** An approved case that has NOT yet been handed over can be reopened (the approval is withdrawn). After handover, amendments are made in the official channel. */
export async function reopenCase(c: Conn, ctx: Ctx, id: string, reason: string) {
  require(ctx, "cus.approve");
  const k = await lockCase(c, id);
  if (k.status !== "approved") throw badRequest("Only an approved case that has not been handed over can be reopened.");
  await c.query(`UPDATE cus_cases SET status='collecting', approved_by=NULL, approved_at=NULL, estimated_duty_minor=NULL, estimated_vat_minor=NULL, reopen_count=reopen_count+1 WHERE id=$1`, [id]);
  await logEvent(c, ctx, id, "reopened", { reason: reqStr(reason, "Reason", 300) });
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_case.reopened", "cus_case", id, { reason });
}

/** The broker lodged the declaration in the official channel and records its number here. One declaration number can belong to one case only. */
export async function recordSubmission(c: Conn, ctx: Ctx, id: string, f: { channel: string; declaration_no: string; submitted_at?: string }) {
  require(ctx, "cus.submit");
  const k = await lockCase(c, id);
  if (k.status !== "approved") throw badRequest(`Only an approved case can be recorded as submitted (this one is ${STATUS_LABEL[k.status] ?? k.status}).`);
  if (!CHANNELS[f.channel]) throw badRequest("Choose the official channel the declaration was lodged in.");
  const no = String(f.declaration_no ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9][A-Z0-9\-\/._]{2,39}$/.test(no)) throw badRequest("Enter the declaration number exactly as the official channel shows it (3–40 letters, digits, - / . _).");
  const at = f.submitted_at ? new Date(f.submitted_at) : new Date();
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60_000) throw badRequest("The submission time is not valid.");
  try {
    await c.query(`UPDATE cus_cases SET status='submitted', channel=$2, declaration_no=$3, submitted_by=$4, submitted_at=$5 WHERE id=$1`, [id, f.channel, no, ctx.userId, at.toISOString()]);
  } catch (e: any) {
    if (String(e.message).includes("cus_cases_tenant_id_channel_declaration_no_key")) throw new HttpError(409, `Declaration ${no} is already recorded on another case in ${CHANNELS[f.channel]}.`, "conflict");
    throw e;
  }
  await logEvent(c, ctx, id, "submitted", { channel: f.channel, declaration_no: no });
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_case.submitted", "cus_case", id, { channel: f.channel, declaration_no: no });
}

export interface Variance { estimated: number; assessed: number; diff: number; pct: number; flagged: boolean }
export const varianceOf = (estDuty: number, estVat: number, aDuty: number, aVat: number): Variance => {
  const estimated = estDuty + estVat, assessed = aDuty + aVat, diff = assessed - estimated;
  const pct = estimated ? Math.round((Math.abs(diff) * 10000) / estimated) / 100 : assessed ? 100 : 0;
  return { estimated, assessed, diff, pct, flagged: Math.abs(diff) >= 10_000 && pct >= 5 };      // material = at least AED 100 AND at least 5%
};
export async function recordAssessment(c: Conn, ctx: Ctx, id: string, f: { duty: string; vat: string; note?: string }) {
  require(ctx, "cus.submit");
  const k = await lockCase(c, id);
  if (!["submitted", "assessed", "inspection"].includes(k.status)) throw badRequest(`An assessment can only be recorded after submission (this case is ${STATUS_LABEL[k.status] ?? k.status}).`);
  const duty = money(f.duty, "Assessed duty"), vat = money(f.vat, "Assessed VAT");
  const paid = Number((await c.query<any>(`SELECT coalesce(sum(CASE WHEN kind IN ('duty','vat') THEN amount_minor WHEN kind='refund' THEN -amount_minor ELSE 0 END),0) n FROM cus_payments WHERE case_id=$1`, [id])).rows[0].n);
  if (paid > duty + vat) throw badRequest("Payments already recorded exceed this assessment. Check the figures.");
  const pending = Number((await c.query<any>(`SELECT count(*) n FROM cus_inspections WHERE case_id=$1 AND result='pending'`, [id])).rows[0].n);
  await c.query(`UPDATE cus_cases SET assessed_duty_minor=$2, assessed_vat_minor=$3, assessed_at=now(), status=$4 WHERE id=$1`, [id, duty, vat, pending ? "inspection" : "assessed"]);
  const v = varianceOf(Number(k.estimated_duty_minor ?? 0), Number(k.estimated_vat_minor ?? 0), duty, vat);
  await logEvent(c, ctx, id, "assessed", { duty_minor: duty, vat_minor: vat, variance: v, note: optStr(f.note, 300) });
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_case.assessed", "cus_case", id, { duty, vat, flagged: v.flagged });
  return v;
}
export async function recordRejection(c: Conn, ctx: Ctx, id: string, reason: string) {
  require(ctx, "cus.submit");
  const k = await lockCase(c, id);
  if (!["submitted", "assessed", "inspection"].includes(k.status)) throw badRequest("Only a submitted case can be recorded as rejected.");
  await c.query(`UPDATE cus_cases SET status='rejected', rejection_reason=$2 WHERE id=$1`, [id, reqStr(reason, "The rejection reason given by customs", 400)]);
  await logEvent(c, ctx, id, "rejected", { reason, declaration_no: k.declaration_no });
  await c.query(`INSERT INTO job_exceptions(tenant_id,title,detail,owner_id,due_at) VALUES ($1,$2,$3,$4, now() + interval '8 hours')`, [ctx.tenantId, `Customs case ${k.no} rejected`, reason, k.created_by]);
}
/** After a rejection a new declaration is needed: the old official number stays in the history, the case returns to collecting and must be approved again. */
export async function reopenAfterRejection(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "cus.write");
  const k = await lockCase(c, id);
  if (k.status !== "rejected") throw badRequest("Only a rejected case can be prepared again.");
  const paid = Number((await c.query<any>(`SELECT count(*) n FROM cus_payments WHERE case_id=$1 AND kind IN ('duty','vat')`, [id])).rows[0].n);
  if (paid) throw badRequest("Duty or VAT was already paid on this case. Resolve the payment (refund or carry it to the new declaration) with finance before preparing it again.");
  await c.query(`UPDATE cus_cases SET status='collecting', approved_by=NULL, approved_at=NULL, estimated_duty_minor=NULL, estimated_vat_minor=NULL, channel=NULL, declaration_no=NULL, submitted_by=NULL, submitted_at=NULL,
    assessed_duty_minor=NULL, assessed_vat_minor=NULL, assessed_at=NULL, rejection_reason=NULL, prepared_by=NULL, reopen_count=reopen_count+1 WHERE id=$1`, [id]);
  await logEvent(c, ctx, id, "prepared_again", { previous_declaration_no: k.declaration_no, previous_channel: k.channel });
}

// ───────────────────────── inspections and queries
export async function addInspection(c: Conn, ctx: Ctx, id: string, f: { kind: string; location?: string; requested_on?: string }) {
  require(ctx, "cus.submit");
  const k = await lockCase(c, id);
  if (!["submitted", "assessed", "inspection"].includes(k.status)) throw badRequest("Inspections are recorded after submission.");
  if (!["document", "physical", "scanner", "lab"].includes(f.kind)) throw badRequest("Choose the inspection type.");
  const on = f.requested_on || new Date().toISOString().slice(0, 10);
  await c.query(`INSERT INTO cus_inspections(tenant_id,case_id,kind,location,requested_on,recorded_by) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, id, f.kind, optStr(f.location, 120), on, ctx.userId]);
  await c.query(`UPDATE cus_cases SET status='inspection' WHERE id=$1`, [id]);
  await logEvent(c, ctx, id, "inspection_requested", { kind: f.kind });
}
export async function closeInspection(c: Conn, ctx: Ctx, inspectionId: string, f: { result: string; findings: string }) {
  require(ctx, "cus.submit");
  const ins = await must(c.query<any>(`SELECT * FROM cus_inspections WHERE id=$1 FOR UPDATE`, [inspectionId]), "Inspection");
  if (ins.result !== "pending") throw badRequest("That inspection is already closed.");
  if (!["passed", "passed_with_conditions", "failed"].includes(f.result)) throw badRequest("Choose the inspection result.");
  const k = await lockCase(c, ins.case_id);
  await c.query(`UPDATE cus_inspections SET result=$2, findings=$3, closed_at=now(), recorded_by=$4 WHERE id=$1`, [inspectionId, f.result, reqStr(f.findings, "Findings", 500), ctx.userId]);
  await logEvent(c, ctx, ins.case_id, "inspection_closed", { result: f.result });
  if (f.result === "failed") {
    await c.query(`UPDATE cus_cases SET status='rejected', rejection_reason=$2 WHERE id=$1`, [ins.case_id, `Inspection failed: ${f.findings}`.slice(0, 400)]);
    await c.query(`INSERT INTO job_exceptions(tenant_id,title,detail,owner_id,due_at) VALUES ($1,$2,$3,$4, now() + interval '8 hours')`, [ctx.tenantId, `Customs case ${k.no}: inspection failed`, f.findings, k.created_by]);
    return;
  }
  const open = Number((await c.query<any>(`SELECT count(*) n FROM cus_inspections WHERE case_id=$1 AND result='pending'`, [ins.case_id])).rows[0].n);
  if (!open && k.status === "inspection") await c.query(`UPDATE cus_cases SET status=$2 WHERE id=$1`, [ins.case_id, k.assessed_at ? "assessed" : "submitted"]);
}
export async function raiseQuery(c: Conn, ctx: Ctx, id: string, f: { text: string; due_on?: string }) {
  require(ctx, "cus.submit");
  const k = await lockCase(c, id);
  if (!["submitted", "assessed", "inspection"].includes(k.status)) throw badRequest("Customs queries are recorded after submission.");
  const due = f.due_on || null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw badRequest("The due date is not valid.");
  const r = await c.query<{ id: string }>(`INSERT INTO cus_queries(tenant_id,case_id,raised_on,text,due_on,raised_by) VALUES ($1,$2,current_date,$3,$4,$5) RETURNING id`, [ctx.tenantId, id, reqStr(f.text, "The query raised by customs", 500), due, ctx.userId]);
  await c.query(`INSERT INTO job_exceptions(tenant_id,title,detail,owner_id,due_at) VALUES ($1,$2,$3,$4,$5)`,
    [ctx.tenantId, `Customs query on ${k.no} [Q:${r.rows[0].id.slice(0, 8)}]`, f.text, k.created_by, due ? `${due}T17:00:00+04:00` : new Date(Date.now() + 24 * 3600_000).toISOString()]);
  await logEvent(c, ctx, id, "query_raised", { due_on: due });
  return r.rows[0].id;
}
export async function answerQuery(c: Conn, ctx: Ctx, queryId: string, answer: string) {
  require(ctx, "cus.submit");
  const q = await must(c.query<any>(`SELECT * FROM cus_queries WHERE id=$1 FOR UPDATE`, [queryId]), "Query");
  if (q.answered_at) throw badRequest("That query is already answered.");
  await c.query(`UPDATE cus_queries SET answered_at=now(), answer=$2, answered_by=$3 WHERE id=$1`, [queryId, reqStr(answer, "The answer sent to customs", 500), ctx.userId]);
  await c.query(`UPDATE job_exceptions SET status='resolved', resolved_at=now() WHERE tenant_id=$1 AND status='open' AND title LIKE $2`, [ctx.tenantId, `%[Q:${queryId.slice(0, 8)}]`]);
  await logEvent(c, ctx, q.case_id, "query_answered");
}

// ───────────────────────── client money: deposits and guarantees
export async function receiveDeposit(c: Conn, ctx: Ctx, f: { party_id: string; kind: string; amount: string; reference: string; received_on?: string; expires_on?: string }) {
  require(ctx, "cus.cash");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.party_id]), "Customer");
  if (!["cash_deposit", "bank_guarantee"].includes(f.kind)) throw badRequest("Choose cash deposit or bank guarantee.");
  const amount = toMinor(String(f.amount ?? ""));
  if (!(amount > 0)) throw badRequest("The amount must be above zero.");
  if (f.kind === "bank_guarantee" && !f.expires_on) throw badRequest("A bank guarantee needs its expiry date.");
  const r = await c.query<{ id: string }>(`INSERT INTO cus_deposits(tenant_id,party_id,kind,amount_minor,reference,received_on,expires_on,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, f.party_id, f.kind, amount, reqStr(f.reference, "Reference", 80), f.received_on || new Date().toISOString().slice(0, 10), f.expires_on || null, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_deposit.received", "cus_deposit", r.rows[0].id, { amount });
  return r.rows[0].id;
}
export const depositBalance = async (c: Conn, id: string) => {
  const d = await must(c.query<any>(`SELECT d.amount_minor, d.refunded_minor, coalesce((SELECT sum(a.amount_minor) FROM cus_deposit_apps a WHERE a.deposit_id=d.id),0) AS applied FROM cus_deposits d WHERE d.id=$1`, [id]), "Deposit");
  return Number(d.amount_minor) - Number(d.refunded_minor) - Number(d.applied);
};
/** Return unused client money (or release a guarantee). A second person confirms it: the one who received it cannot also give it back (owner excepted). */
export async function refundDeposit(c: Conn, ctx: Ctx, id: string, amountStr?: string) {
  require(ctx, "cus.cash");
  const d = await must(c.query<any>(`SELECT * FROM cus_deposits WHERE id=$1 FOR UPDATE`, [id]), "Deposit");
  if (d.created_by === ctx.userId && !isOwner(ctx)) throw forbidden("Client money cannot be returned by the person who received it.");
  const bal = await depositBalance(c, id);
  const amount = amountStr === undefined || String(amountStr).trim() === "" ? bal : toMinor(amountStr);
  if (!(amount > 0) || amount > bal) throw badRequest(`Only ${(bal / 100).toFixed(2)} is unused and can be returned.`);
  await c.query(`UPDATE cus_deposits SET refunded_minor=refunded_minor+$2 WHERE id=$1`, [id, amount]);
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_deposit.refunded", "cus_deposit", id, { amount });
}
export const listDeposits = (c: Conn, partyId?: string | null) => c.query<any>(
  `SELECT d.*, p.name AS party_name, coalesce((SELECT sum(a.amount_minor) FROM cus_deposit_apps a WHERE a.deposit_id=d.id),0)::bigint AS applied_minor,
     (d.amount_minor - d.refunded_minor - coalesce((SELECT sum(a.amount_minor) FROM cus_deposit_apps a WHERE a.deposit_id=d.id),0))::bigint AS balance_minor,
     (d.expires_on IS NOT NULL AND d.expires_on < current_date) AS expired
   FROM cus_deposits d JOIN parties p ON p.id=d.party_id WHERE ($1::uuid IS NULL OR d.party_id=$1) ORDER BY d.received_on DESC, d.created_at DESC`, [partyId ?? null])
  .then((r) => r.rows.map((x) => ({ ...x, balance_minor: Number(x.balance_minor), applied_minor: Number(x.applied_minor) })));

// ───────────────────────── duty payments (to customs, AED)
export async function recordPayment(c: Conn, ctx: Ctx, id: string, f: { kind: string; amount: string; method: string; deposit_id?: string; reference: string; paid_on?: string; idem_key?: string }) {
  require(ctx, "cus.cash");
  await assertWritable(c, ctx.tenantId);
  const k = await lockCase(c, id);
  if (!["duty", "vat", "fine", "refund"].includes(f.kind)) throw badRequest("Choose duty, VAT, fine or refund.");
  if (!["deposit", "bank", "card", "cash"].includes(f.method)) throw badRequest("Choose how it was paid.");
  const amount = toMinor(String(f.amount ?? ""));
  if (!(amount > 0)) throw badRequest("The amount must be above zero.");
  const idem = optStr(f.idem_key, 80);
  if (idem) {
    const have = (await c.query<any>(`SELECT * FROM cus_payments WHERE idem_key=$1`, [idem])).rows[0];
    if (have) { if (have.case_id !== id || Number(have.amount_minor) !== amount) throw new HttpError(409, "That payment key was already used for a different payment.", "conflict"); return { id: have.id, duplicate: true }; }
  }
  if (["duty", "vat"].includes(f.kind) && !["assessed", "inspection"].includes(k.status)) throw badRequest("Duty and VAT are recorded after the official assessment and before release.");
  if (f.kind === "refund" && f.method === "deposit") throw badRequest("A refund from customs goes back to the bank, not to a deposit.");
  if (["fine"].includes(f.kind) && !["submitted", "assessed", "inspection", "released", "closed"].includes(k.status)) throw badRequest("Fines are recorded after submission.");
  if (f.kind === "refund" && !["released", "closed"].includes(k.status)) throw badRequest("Refunds are recorded after release.");
  const paidOn = f.paid_on || new Date().toISOString().slice(0, 10);
  if (["duty", "vat"].includes(f.kind)) {
    const row = (await c.query<any>(`SELECT coalesce(sum(amount_minor) FILTER (WHERE kind='duty'),0) d, coalesce(sum(amount_minor) FILTER (WHERE kind='vat'),0) v FROM cus_payments WHERE case_id=$1`, [id])).rows[0];
    const cap = f.kind === "duty" ? Number(k.assessed_duty_minor) : Number(k.assessed_vat_minor), already = Number(f.kind === "duty" ? row.d : row.v);
    if (already + amount > cap) throw badRequest(`That would pay ${((already + amount) / 100).toFixed(2)} of ${f.kind === "duty" ? "duty" : "VAT"} against an assessment of ${(cap / 100).toFixed(2)}.`);
  }
  let depositId: string | null = null;
  if (f.method === "deposit") {
    const d = await must(c.query<any>(`SELECT * FROM cus_deposits WHERE id=$1 FOR UPDATE`, [f.deposit_id]), "Deposit");
    if (d.party_id !== k.party_id) throw badRequest("That deposit belongs to a different customer.");
    if (d.expires_on && String(d.expires_on).slice(0, 10) < paidOn) throw badRequest("That deposit or guarantee has expired.");
    const bal = await depositBalance(c, d.id);
    if (amount > bal) throw badRequest(`The deposit has only ${(bal / 100).toFixed(2)} available.`);
    depositId = d.id;
  }
  const r = await c.query<{ id: string }>(`INSERT INTO cus_payments(tenant_id,case_id,kind,amount_minor,method,deposit_id,reference,paid_on,idem_key,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, id, f.kind, amount, f.method, depositId, reqStr(f.reference, "Payment reference", 80), paidOn, idem, ctx.userId]);
  if (depositId) await c.query(`INSERT INTO cus_deposit_apps(tenant_id,deposit_id,payment_id,amount_minor) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, depositId, r.rows[0].id, amount]);
  await logEvent(c, ctx, id, "payment_recorded", { kind: f.kind, amount_minor: amount, method: f.method });
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_payment.recorded", "cus_case", id, { kind: f.kind, amount, method: f.method });
  return { id: r.rows[0].id, duplicate: false };
}
export const netPaid = async (c: Conn, id: string) => {
  const r = (await c.query<any>(`SELECT coalesce(sum(CASE WHEN kind IN ('duty','vat') THEN amount_minor END),0) AS dv FROM cus_payments WHERE case_id=$1`, [id])).rows[0];
  return Number(r.dv);
};

// ───────────────────────── release and close
export async function releaseCase(c: Conn, ctx: Ctx, id: string, f: { release_ref: string; released_at?: string }) {
  require(ctx, "cus.submit");
  const k = await lockCase(c, id);
  if (!["assessed", "inspection"].includes(k.status)) throw badRequest(`Only an assessed case can be released (this one is ${STATUS_LABEL[k.status] ?? k.status}).`);
  const problems: string[] = [];
  const due = Number(k.assessed_duty_minor) + Number(k.assessed_vat_minor), paid = await netPaid(c, id);
  if (paid < due) problems.push(`Duty and VAT of ${(due / 100).toFixed(2)} AED are not fully paid (${(paid / 100).toFixed(2)} recorded).`);
  const open = Number((await c.query<any>(`SELECT count(*) n FROM cus_inspections WHERE case_id=$1 AND result='pending'`, [id])).rows[0].n);
  if (open) problems.push(`${open} inspection(s) are still open.`);
  const q = Number((await c.query<any>(`SELECT count(*) n FROM cus_queries WHERE case_id=$1 AND answered_at IS NULL`, [id])).rows[0].n);
  if (q) problems.push(`${q} customs query(ies) are unanswered.`);
  if (problems.length) throw badRequest(`Cannot release. ${problems.join(" ")}`);
  if (k.status !== "assessed") throw badRequest("Cannot release: the case is still held for inspection.");
  const at = f.released_at ? new Date(f.released_at) : new Date();
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60_000) throw badRequest("The release time is not valid.");
  await c.query(`UPDATE cus_cases SET status='released', release_ref=$2, released_at=$3, released_by=$4 WHERE id=$1`, [id, reqStr(f.release_ref, "Release / gate-pass reference", 80), at.toISOString(), ctx.userId]);
  await logEvent(c, ctx, id, "released", { release_ref: f.release_ref });
  await audit(c, ctx.tenantId, actorOf(ctx), "customs_case.released", "cus_case", id, { release_ref: f.release_ref });
}
export async function closeCase(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "cus.submit");
  const k = await lockCase(c, id);
  if (k.status !== "released") throw badRequest("Only a released case can be closed.");
  await c.query(`UPDATE cus_cases SET status='closed', closed_at=now() WHERE id=$1`, [id]);
  await logEvent(c, ctx, id, "closed");
}
export async function cancelCase(c: Conn, ctx: Ctx, id: string, reason: string) {
  require(ctx, "cus.write");
  const k = await lockCase(c, id);
  if (!["collecting", "in_review", "approved", "rejected"].includes(k.status)) throw badRequest("A case that has been handed over cannot be cancelled here — withdraw the declaration in the official channel first, then record the rejection.");
  const paid = Number((await c.query<any>(`SELECT count(*) n FROM cus_payments WHERE case_id=$1`, [id])).rows[0].n);
  if (paid) throw badRequest("Payments are recorded on this case; it cannot be cancelled.");
  await c.query(`UPDATE cus_cases SET status='cancelled' WHERE id=$1`, [id]);
  await logEvent(c, ctx, id, "cancelled", { reason: reqStr(reason, "Reason", 300) });
}

// ───────────────────────── billing: broker fees and duty disbursements
export async function addCharge(c: Conn, ctx: Ctx, id: string, f: { kind: string; description: string; amount: string; qty?: string; tax_code?: string }) {
  require(ctx, "cus.write");
  const k = await lockCase(c, id);
  if (k.status === "cancelled") throw badRequest("The case is cancelled.");
  if (!["broker_fee", "disbursement", "other"].includes(f.kind)) throw badRequest("Choose broker fee, disbursement or other.");
  const amount = toMinor(String(f.amount ?? "")), qty = Number(f.qty ?? 1);
  if (!(amount > 0) || !(qty > 0)) throw badRequest("Enter an amount and quantity above zero.");
  const tax = TAX_CODES[f.tax_code ?? ""] ? f.tax_code! : f.kind === "disbursement" ? "OOS" : "SR5";
  const r = await c.query<{ id: string }>(`INSERT INTO cus_charges(tenant_id,case_id,kind,description,qty,unit_minor,tax_code,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, id, f.kind, reqStr(f.description, "Description", 200), qty, amount, tax, ctx.userId]);
  await logEvent(c, ctx, id, "charge_added", { kind: f.kind });
  return r.rows[0].id;
}
/** Duty, VAT and fines paid on the customer's behalf are recovered at cost, once per payment, outside the broker's VAT (disbursement). */
export async function billDisbursements(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "cus.cash");
  const k = await lockCase(c, id);
  if (!["released", "closed"].includes(k.status)) throw badRequest("Duty is recovered from the customer after release.");
  const refunds = Number((await c.query<any>(`SELECT count(*) n FROM cus_payments WHERE case_id=$1 AND kind='refund'`, [id])).rows[0].n);
  if (refunds) throw badRequest("A refund is recorded on this case: add the disbursement lines by hand so the net amount is billed.");
  const pays = (await c.query<any>(`SELECT * FROM cus_payments WHERE case_id=$1 AND kind IN ('duty','vat','fine') AND method <> 'deposit' ORDER BY created_at`, [id])).rows;
  let n = 0;
  for (const p of pays) {
    const r = await c.query(`INSERT INTO cus_charges(tenant_id,case_id,kind,description,qty,unit_minor,tax_code,source_ref,created_by) VALUES ($1,$2,$3,$4,1,$5,'OOS',$6,$7) ON CONFLICT (tenant_id,source_ref) DO NOTHING RETURNING id`,
      [ctx.tenantId, id, p.kind === "duty" ? "duty" : p.kind === "vat" ? "vat" : "disbursement", `${p.kind === "duty" ? "Customs duty" : p.kind === "vat" ? "Import VAT paid to customs" : "Customs fine"} · declaration ${k.declaration_no} · ref ${p.reference}`, p.amount_minor, `pay:${p.id}`, ctx.userId]);
    if (r.rows.length) n++;
  }
  // duty paid from the customer's own deposit is not advanced by us, so it is not billed; it is shown on the statement instead
  return { added: n };
}
export async function invoiceCase(c: Conn, ctx: Ctx, id: string, termsDays = 30) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const k = await lockCase(c, id);
  if (!["released", "closed"].includes(k.status)) throw badRequest("Invoice a customs case after release.");
  const charges = (await c.query<any>(`SELECT * FROM cus_charges WHERE case_id=$1 AND invoice_id IS NULL ORDER BY created_at FOR UPDATE`, [id])).rows;
  if (!charges.length) throw badRequest("There are no uninvoiced charges on this case.");
  const ent = (await c.query<any>(`SELECT id FROM entities ORDER BY created_at LIMIT 1`)).rows[0];
  return issueInvoice(c, ctx, {
    entityId: ent.id, partyId: k.party_id, customsCaseId: id, lines: charges.map((x) => ({ id: x.id, description: `${x.description}${x.kind === "broker_fee" ? ` (${k.no})` : ""}`, qty: x.qty, unit_minor: x.unit_minor, tax_code: x.tax_code })),
    markCharge: async (chargeId, invoiceId) => { await c.query(`UPDATE cus_charges SET invoice_id=$2 WHERE id=$1`, [chargeId, invoiceId]); },
  }, termsDays);
}

// ───────────────────────── reading
export interface CaseFilter { status?: string; partyId?: string | null; q?: string; limit?: number }
export const listCases = (c: Conn, o: CaseFilter = {}) => c.query<any>(
  `SELECT k.*, p.name AS party_name,
     (SELECT count(*)::int FROM cus_lines l WHERE l.case_id=k.id) AS line_count,
     (SELECT count(*)::int FROM cus_checklist x WHERE x.case_id=k.id AND x.mandatory AND x.status='missing') AS missing,
     (SELECT coalesce(sum(duty_minor+vat_minor),0)::bigint FROM cus_lines l WHERE l.case_id=k.id) AS estimate_minor
   FROM cus_cases k JOIN parties p ON p.id=k.party_id
   WHERE ($1::text IS NULL OR k.status=$1) AND ($2::uuid IS NULL OR k.party_id=$2)
     AND ($3::text IS NULL OR k.no ILIKE $3 OR k.declaration_no ILIKE $3 OR k.transport_ref ILIKE $3 OR p.name ILIKE $3)
   ORDER BY k.created_at DESC LIMIT $4`,
  [o.status || null, o.partyId ?? null, o.q?.trim() ? `%${o.q.trim().replace(/[%_]/g, "")}%` : null, o.limit ?? 300]).then((r) => r.rows.map((x) => ({ ...x, estimate_minor: Number(x.estimate_minor) })));

export async function getCase(c: Conn, id: string) {
  const k = await must(c.query<any>(`SELECT k.*, p.name AS party_name, p.tax_id AS party_tax_id, j.no AS job_no, u.name AS prepared_name, a.name AS approved_name FROM cus_cases k JOIN parties p ON p.id=k.party_id
    LEFT JOIN jobs j ON j.id=k.job_id LEFT JOIN team_members u ON u.user_id=k.prepared_by LEFT JOIN team_members a ON a.user_id=k.approved_by WHERE k.id=$1`, [id]), "Customs case");
  const [lines, checklist, inspections, queries, events, payments, charges, deposits] = await Promise.all([
    c.query<any>(`SELECT * FROM cus_lines WHERE case_id=$1 ORDER BY line_no`, [id]),
    c.query<any>(`SELECT x.*, d.title AS doc_title, d.filename, d.sha256 FROM cus_checklist x LEFT JOIN documents d ON d.id=x.document_id WHERE x.case_id=$1 ORDER BY x.mandatory DESC, x.label`, [id]),
    c.query<any>(`SELECT * FROM cus_inspections WHERE case_id=$1 ORDER BY requested_on, id`, [id]),
    c.query<any>(`SELECT * FROM cus_queries WHERE case_id=$1 ORDER BY raised_on, id`, [id]),
    c.query<any>(`SELECT e.*, u.name AS actor FROM cus_events e LEFT JOIN team_members u ON u.user_id=e.actor_user_id WHERE e.case_id=$1 ORDER BY e.created_at`, [id]),
    c.query<any>(`SELECT * FROM cus_payments WHERE case_id=$1 ORDER BY created_at`, [id]),
    c.query<any>(`SELECT * FROM cus_charges WHERE case_id=$1 ORDER BY created_at`, [id]),
    listDeposits(c, k.party_id),
  ]);
  const t = lines.rows.reduce((a: Totals, l: any) => ({ value: a.value + Number(l.value_minor), alloc: a.alloc + Number(l.alloc_minor), cifAed: a.cifAed + Number(l.cif_aed_minor), duty: a.duty + Number(l.duty_minor), vat: a.vat + Number(l.vat_minor),
    weightNet: a.weightNet + Number(l.net_kg), weightGross: a.weightGross + Number(l.gross_kg) }), { value: 0, alloc: 0, cifAed: 0, duty: 0, vat: 0, weightNet: 0, weightGross: 0 });
  const paid = payments.rows.reduce((a: number, p: any) => a + (["duty", "vat"].includes(p.kind) ? Number(p.amount_minor) : 0), 0);
  const variance = k.assessed_at ? varianceOf(Number(k.estimated_duty_minor ?? 0), Number(k.estimated_vat_minor ?? 0), Number(k.assessed_duty_minor), Number(k.assessed_vat_minor)) : null;
  return { case: k, lines: lines.rows, totals: t, checklist: checklist.rows, inspections: inspections.rows, queries: queries.rows, events: events.rows, payments: payments.rows, charges: charges.rows,
    deposits: deposits.filter((d: any) => d.balance_minor > 0 && !d.expired), paidDutyVat: paid, variance, issues: EDITABLE.includes(k.status) ? await readinessIssues(c, id) : [] };
}

export async function customsOverview(c: Conn) {
  const n = async (sql: string) => Number((await c.query<any>(sql)).rows[0].n);
  const byStatus: Record<string, number> = {};
  for (const r of (await c.query<any>(`SELECT status, count(*)::int n FROM cus_cases GROUP BY status`)).rows) byStatus[r.status] = r.n;
  return {
    byStatus,
    toApprove: (await c.query<any>(`SELECT k.id,k.no,p.name AS party FROM cus_cases k JOIN parties p ON p.id=k.party_id WHERE k.status='in_review' ORDER BY k.created_at LIMIT 10`)).rows,
    toHandOver: (await c.query<any>(`SELECT k.id,k.no,p.name AS party FROM cus_cases k JOIN parties p ON p.id=k.party_id WHERE k.status='approved' ORDER BY k.approved_at LIMIT 10`)).rows,
    openQueries: (await c.query<any>(`SELECT q.id, q.text, q.due_on, k.id AS case_id, k.no, (q.due_on IS NOT NULL AND q.due_on < current_date) AS late FROM cus_queries q JOIN cus_cases k ON k.id=q.case_id WHERE q.answered_at IS NULL ORDER BY q.due_on NULLS LAST LIMIT 10`)).rows,
    openInspections: await n(`SELECT count(*) n FROM cus_inspections WHERE result='pending'`),
    rejected: await n(`SELECT count(*) n FROM cus_cases WHERE status='rejected'`),
    awaitingPayment: (await c.query<any>(`SELECT k.id,k.no,p.name AS party, (k.assessed_duty_minor + k.assessed_vat_minor)::bigint AS due_minor,
        coalesce((SELECT sum(amount_minor) FROM cus_payments x WHERE x.case_id=k.id AND x.kind IN ('duty','vat')),0)::bigint AS paid_minor FROM cus_cases k JOIN parties p ON p.id=k.party_id WHERE k.status IN ('assessed','inspection') ORDER BY k.assessed_at LIMIT 10`)).rows
      .map((x) => ({ ...x, due_minor: Number(x.due_minor), paid_minor: Number(x.paid_minor) })),
    unbilled: await n(`SELECT count(DISTINCT k.id) n FROM cus_cases k WHERE k.status IN ('released','closed') AND EXISTS (SELECT 1 FROM cus_charges g WHERE g.case_id=k.id AND g.invoice_id IS NULL)`),
    guaranteesExpiring: await n(`SELECT count(*) n FROM cus_deposits d WHERE d.kind='bank_guarantee' AND d.expires_on IS NOT NULL AND d.expires_on <= current_date + 30 AND d.amount_minor - d.refunded_minor - coalesce((SELECT sum(a.amount_minor) FROM cus_deposit_apps a WHERE a.deposit_id=d.id),0) > 0`),
    clientMoney: Number((await c.query<any>(`SELECT coalesce(sum(d.amount_minor - d.refunded_minor - coalesce((SELECT sum(a.amount_minor) FROM cus_deposit_apps a WHERE a.deposit_id=d.id),0)),0) n FROM cus_deposits d WHERE d.kind='cash_deposit'`)).rows[0].n),
  };
}

// ───────────────────────── handover pack and CSV (a working record for the broker to lodge in the official channel)
export async function handoverPack(c: Conn, id: string) {
  const d = await getCase(c, id);
  if (!["approved", "submitted", "assessed", "inspection", "released", "closed"].includes(d.case.status)) throw badRequest("The handover pack is available once the case has been approved.");
  return d;
}
const csvCell = (v: unknown) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };   // spreadsheet-formula-safe
export function linesCsv(d: Awaited<ReturnType<typeof getCase>>): string {
  const head = ["line", "description", "hs_code", "origin", "qty", "uom", "net_kg", "gross_kg", `value_${d.case.currency}`, "freight_insurance_other_alloc", "cif_aed", "duty_rate_pct_entered", "est_duty_aed", "vat_rate_pct_entered", "est_vat_aed", "restricted"];
  const rows = d.lines.map((l: any) => [l.line_no, l.description, l.hs_code, l.origin_country ?? "", l.qty, l.uom, l.net_kg, l.gross_kg, (l.value_minor / 100).toFixed(2), (l.alloc_minor / 100).toFixed(2), (l.cif_aed_minor / 100).toFixed(2),
    (l.duty_rate_bps / 100).toFixed(2), (l.duty_minor / 100).toFixed(2), (l.vat_rate_bps / 100).toFixed(2), (l.vat_minor / 100).toFixed(2), l.restricted ? "yes" : "no"]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** What a customer may see: where the case stands and which documents are still wanted. Never rates, estimates, notes or other customers. */
export const portalCases = (c: Conn, partyId: string) => c.query<any>(
  `SELECT k.id, k.no, k.direction, k.status, k.transport_ref, k.declaration_no, k.released_at,
     coalesce((SELECT array_agg(x.label ORDER BY x.label) FROM cus_checklist x WHERE x.case_id=k.id AND x.mandatory AND x.status='missing'),'{}') AS wanted
   FROM cus_cases k WHERE k.party_id=$1 AND k.status <> 'cancelled' ORDER BY k.created_at DESC LIMIT 100`, [partyId]).then((r) => r.rows);
