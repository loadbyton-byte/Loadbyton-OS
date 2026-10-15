import { ProviderError, type EInvoiceAdapter, type EInvoiceResult, type EInvoiceSubmission, type InboundDocument, type StructuredDoc } from "./einvoice.js";

/**
 * Wafeq e-invoicing ASP adapter (https://wafeq-e-invoicing-asp.readme.io). Wafeq takes the invoice as JSON and builds the PINT-AE UBL itself, so this adapter
 * sends the structured document rather than our own UBL. One organisation API key serves every client; each call names the client's taxpayer in
 * `x-ae-taxpayer-id`. A key beginning `pk_test_` reaches Sandbox and `pk_live_` reaches Live, on the same base URL.
 *
 * The provider's answer is authoritative. Only an explicit delivered/accepted state is read as accepted; anything unrecognised stays "submitted" so
 * it is looked at again rather than trusted. The exact status vocabulary should be confirmed against Wafeq Sandbox before Live use.
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface WafeqCredentials { apiKey: string; taxpayerId: string; baseUrl?: string }
export const WAFEQ_BASE_URL = "https://api.wafeq.com/ae/v1";

const ACCEPTED = new Set(["delivered", "accepted"]);
const REJECTED = new Set(["rejected", "failed", "invalid", "not_compliant", "failed_validation"]);
const EMIRATES: Record<string, string> = { dubai: "DXB", "abu dhabi": "AUH", sharjah: "SHJ", ajman: "AJM", "umm al quwain": "UAQ", "ras al khaimah": "RAK", fujairah: "FUJ" };

export function validateWafeqCredentials(c: Partial<WafeqCredentials>): WafeqCredentials {
  const apiKey = String(c.apiKey ?? "").trim(), taxpayerId = String(c.taxpayerId ?? "").trim(), baseUrl = String(c.baseUrl ?? "").trim() || undefined;
  if (!/^pk_(test|live)_[A-Za-z0-9]+$/.test(apiKey)) throw new Error("The Wafeq API key must be an organisation key starting pk_test_ or pk_live_.");
  if (!/^txpay_[A-Za-z0-9]+$/.test(taxpayerId)) throw new Error("The Wafeq taxpayer ID must start txpay_ (it is not the TRN or TIN).");
  if (baseUrl && !/^https:\/\//.test(baseUrl)) throw new Error("The provider address must be https.");
  return { apiKey, taxpayerId, baseUrl };
}
/** Which Wafeq environment a key reaches. */
export const wafeqEnvironment = (apiKey: string): "sandbox" | "live" => (apiKey.startsWith("pk_live_") ? "live" : "sandbox");

const emirateCode = (e: string | null) => { const v = (e ?? "").trim(); return /^[A-Z]{3}$/.test(v) ? v : EMIRATES[v.toLowerCase()] ?? undefined; };
const line = (l: StructuredDoc["lines"][number]) => ({
  description: l.description.slice(0, 1024), quantity: l.quantity, unit_price: l.unitPrice, tax_category: l.taxCategory, tax_percent: l.taxPercent,
  ...(l.exemptionReason ? { tax_exemption_reason: l.exemptionReason } : {}),
});
const customer = (b: StructuredDoc["buyer"]) => ({
  name: b.legalName.slice(0, 512), address: { street: (b.street ?? "").slice(0, 256), city: (b.city ?? "").slice(0, 128), country: b.country || "AE", ...(emirateCode(b.emirate) ? { country_subentity: emirateCode(b.emirate) } : {}) },
  ...(b.trn ? { vat_number: b.trn } : {}), ...(b.peppolId ? { id: b.peppolId } : {}),
});

/** The request body Wafeq expects for an invoice or a credit note. */
export function wafeqBody(kind: "invoice" | "credit_note", d: StructuredDoc, sourceId: string): Record<string, unknown> {
  const common = { issue_date: d.issueDate, currency: d.currency, source_id: sourceId.slice(0, 64), customer: customer(d.buyer), line_items: d.lines.map(line), ...(d.notes ? { notes: d.notes.slice(0, 2000) } : {}) };
  if (kind === "invoice") return { ...common, invoice_number: d.number, due_date: d.dueDate ?? d.issueDate };
  return {
    ...common, credit_note_number: d.number, ...(d.reasonCode ? { credit_note_reason_code: d.reasonCode } : {}),
    ...(d.precedingProviderRef ? { previous_invoice_source: "ap", previous_document_id: d.precedingProviderRef } : { previous_invoice_source: "external", previous_invoice_number: d.precedingNumber }),
  };
}

const reasonsOf = (body: any): string[] => {
  const raw: unknown[] = [];
  if (Array.isArray(body?.validation_errors)) raw.push(...body.validation_errors);
  if (Array.isArray(body?.detail)) raw.push(...body.detail);
  else if (body?.detail && typeof body.detail === "object") raw.push(body.detail.message ?? body.detail.code);
  if (body?.error) raw.push(body.error);
  return raw.filter(Boolean).slice(0, 20).map((x: any) => (typeof x === "string" ? x : x.message ?? x.msg ?? x.rule ?? x.code ?? JSON.stringify(x)).toString().slice(0, 300));
};

/** Reads a Wafeq document answer (send response, document record or webhook data) into our vocabulary. Only an explicit delivered/accepted state is "accepted". */
export function mapWafeqResult(body: any, fallbackRef: string): EInvoiceResult {
  const state = String(body?.delivery_status ?? body?.status ?? "").toLowerCase(), reasons = reasonsOf(body);
  const status = body?.success === false || REJECTED.has(state) || (reasons.length && !ACCEPTED.has(state)) ? "rejected" : ACCEPTED.has(state) ? "accepted" : "submitted";
  return { providerRef: String(body?.document_id ?? body?.invoice_id ?? body?.id ?? fallbackRef).slice(0, 200), status, reasons, ...(body?.tdd_status ? { reporting: String(body.tdd_status) } : {}) };
}

export function wafeqAdapter(creds: WafeqCredentials, fetchImpl: Fetch = fetch): EInvoiceAdapter {
  const base = (creds.baseUrl ?? WAFEQ_BASE_URL).replace(/\/$/, "");
  const headers = (extra: Record<string, string> = {}) => ({ accept: "application/json", authorization: `Api-Key ${creds.apiKey}`, "x-ae-taxpayer-id": creds.taxpayerId, ...extra });
  async function call(path: string, init: RequestInit): Promise<{ status: number; body: any; text: string }> {
    let res: Response;
    try { res = await fetchImpl(base + path, { ...init, signal: AbortSignal.timeout(20_000) }); }
    catch (e: any) { throw new ProviderError(`e-invoicing provider unreachable: ${e.message}`, true); }
    const text = await res.text(); let body: any = {}; try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (res.status >= 500 || res.status === 429 || res.status === 409) throw new ProviderError(`e-invoicing provider answered ${res.status}`, true);   // 409: an earlier attempt is still in progress; the same key is safe to repeat
    if (res.status === 401 || res.status === 403) throw new ProviderError("e-invoicing provider refused the credentials or the taxpayer has not granted access", false);
    if (res.status === 402) throw new ProviderError("the provider reports no active subscription for this client", false);
    return { status: res.status, body, text };
  }
  const map = mapWafeqResult;
  return {
    name: "wafeq",
    async submit(s: EInvoiceSubmission) {
      if (!s.doc) throw new ProviderError("Wafeq needs the structured document, not UBL alone", false);
      const key = s.reference.replace(/[^\x21-\x7e]/g, "_").slice(0, 128);
      const r = await call(s.kind === "invoice" ? "/invoices" : "/credit-notes", { method: "POST", headers: headers({ "content-type": "application/json", "idempotency-key": key }), body: JSON.stringify(wafeqBody(s.kind, s.doc, s.reference)) });
      if (r.status >= 400) { const reasons = reasonsOf(r.body); return { providerRef: `wafeq-${key}`.slice(0, 200), status: "rejected" as const, reasons: reasons.length ? reasons : [`Provider answered HTTP ${r.status}`] }; }
      return map(r.body, `wafeq-${key}`);
    },
    async status(ref: string) {
      const r = await call(`/invoices/${encodeURIComponent(ref)}`, { method: "GET", headers: headers() });
      if (r.status >= 400) return { providerRef: ref, status: "error" as const, reasons: [`Provider answered HTTP ${r.status}`] };
      return map(r.body, ref);
    },
    async downloadXml(ref: string) {
      const r = await call(`/invoices/${encodeURIComponent(ref)}/xml`, { method: "GET", headers: headers({ accept: "application/xml" }) });
      if (r.status >= 400) throw new ProviderError(`the provider could not return the XML (HTTP ${r.status})`, false);
      return r.text;
    },
    async describeDocument(ref: string): Promise<InboundDocument> {
      const r = await call(`/invoices/${encodeURIComponent(ref)}`, { method: "GET", headers: headers() });
      if (r.status >= 400) throw new ProviderError(`the provider could not describe the document (HTTP ${r.status})`, false);
      const b = r.body, total = Number(b.total);
      return { providerDocId: String(b.id ?? ref), number: b.invoice_number ?? null, senderName: b.seller_name ?? null, currency: b.currency ?? null, totalMinor: Number.isFinite(total) ? Math.round(total * 100) : null, issuedOn: b.issue_date ? String(b.issue_date).slice(0, 10) : null };
    },
  };
}
