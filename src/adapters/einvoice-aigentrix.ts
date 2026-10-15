import { ProviderError, type EInvoiceAdapter, type EInvoiceResult, type EInvoiceSubmission, type InboundDocument, type StructuredDoc } from "./einvoice.js";

/**
 * Aigentrix (TronStride) adapter — https://www.tronstride.com/api-docs/. One organisation API key serves every client; each client is a *company* in that organisation
 * and every call carries its `companyId`. Sending is two calls: `POST /eInvoiceEntry/createFull` stores the invoice as a DRAFT, then
 * `PUT /eInvoiceEntry/{id}` with `status: SUBMITTED` queues it. Validation, delivery and FTA reporting then happen asynchronously and are read back from the entry
 * (`status` for delivery, `taxStatus` for reporting) or pushed by webhook.
 *
 * Whether a company talks to the Peppol TEST network or production is that company's default environment in the Aigentrix portal; the API cannot be told otherwise
 * and does not report it. The `environment` held here must therefore match the portal, and webhook events carry the real one so a mismatch can be caught.
 * A business refusal arrives as HTTP 200 with `success:false`, so that flag is always read.
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface AigentrixCredentials { apiKey: string; companyId: string; environment: "sandbox" | "live"; webhookSecret?: string; baseUrl?: string }
export const AIGENTRIX_BASE_URL = "https://app.aigentrix.ai/external/api/v1";

const ACCEPTED = new Set(["DELIVERED", "ACKNOWLEDGED", "CREDIT_NOTE_ISSUED"]);
const REJECTED = new Set(["REJECTED", "VALIDATION_FAILED"]);
const EDITABLE = new Set(["DRAFT", "VALIDATION_FAILED", "REJECTED", "TRANSMISSION_FAILED"]);      // states in which a re-post overwrites the entry
const FATAL_KEYS = new Set(["company.not.found", "company.not.accessible", "organisation.not.found", "document.plan.missing", "document.limit.exist"]);   // about the account, not the document
const CREDIT_REASONS = /^(DL8\.61\.1\.[A-E]|VD)$/;

export function validateAigentrixCredentials(c: Record<string, any>): AigentrixCredentials {
  const apiKey = String(c.apiKey ?? "").trim(), companyId = String(c.taxpayerId ?? c.companyId ?? "").trim(), baseUrl = String(c.baseUrl ?? "").trim() || undefined;
  const env = String(c.environment ?? "sandbox").trim().toLowerCase(), webhookSecret = String(c.webhookSecret ?? "").trim() || undefined;
  if (!/^[\x21-\x7e]{16,200}$/.test(apiKey)) throw new Error("The Aigentrix API key looks wrong (it is the organisation key from Settings → API Keys).");
  if (!/^\d{1,12}$/.test(companyId)) throw new Error("The Aigentrix company ID is the number shown for the client's company (not its TRN).");
  if (env !== "sandbox" && env !== "live") throw new Error("Choose Sandbox or Live. It must match the company's default environment in the Aigentrix portal.");
  if (baseUrl && !/^https:\/\//.test(baseUrl)) throw new Error("The provider address must be https.");
  if (webhookSecret && webhookSecret.length < 16) throw new Error("The webhook signing secret looks too short.");
  return { apiKey, companyId, environment: env, webhookSecret, baseUrl };
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const subdivision = (country: string, e: string | null) => { const v = (e ?? "").trim(); if (/^(AUH|DXB|SHJ|AJM|UAQ|RAK|FUJ)$/.test(v.toUpperCase())) return v.toUpperCase();
  const m: Record<string, string> = { "abu dhabi": "AUH", dubai: "DXB", sharjah: "SHJ", ajman: "AJM", "umm al quwain": "UAQ", "ras al khaimah": "RAK", fujairah: "FUJ" }; return m[v.toLowerCase()] ?? (country === "AE" ? undefined : v || undefined); };

/** The createFull body. The seller block is left out on purpose: Aigentrix fills it from the company's master record. Totals follow the issuing system's own figures; any difference from the
 *  provider's per-breakdown tax goes in `roundingAmount`, as the provider's documentation prescribes. */
export function aigentrixBody(kind: "invoice" | "credit_note", d: StructuredDoc, companyId: string): Record<string, unknown> {
  const lines = d.lines.map((l, i) => {
    const net = l.netAmount ?? r2(l.quantity * l.unitPrice), tax = l.taxAmount ?? r2(net * l.taxPercent / 100);
    return { lineNumber: i + 1, itemName: l.description.slice(0, 200), itemDescription: l.description.slice(0, 500), quantity: l.quantity, quantityUom: "H87", unitPrice: l.unitPrice, priceBaseQty: 1, lineNetAmount: r2(net),
      taxCategory: l.taxCategory, taxRatePercent: l.taxPercent, taxScheme: "VAT", lineTaxAmount: r2(tax), inclVatAmount: r2(net + tax), ...(l.exemptionReason ? { vatExemptReasonText: l.exemptionReason } : {}) };
  });
  const groups = new Map<string, number>();
  for (const l of lines) groups.set(`${l.taxCategory}|${l.taxRatePercent}`, (groups.get(`${l.taxCategory}|${l.taxRatePercent}`) ?? 0) + l.lineNetAmount);
  const net = r2(lines.reduce((a, l) => a + l.lineNetAmount, 0)), tax = r2([...groups.entries()].reduce((a, [k, n]) => a + n * Number(k.split("|")[1]) / 100, 0)), incl = r2(net + tax);
  const payable = r2(d.totals?.total ?? incl), b = d.buyer;
  return {
    companyId: Number(companyId), invoiceRef: d.number.slice(0, 50), documentId: d.number, issueDate: d.issueDate, invoiceTypeCode: kind === "invoice" ? "380" : "381", invoiceTransactionType: "00000000", documentCurrencyCode: d.currency,
    ...(kind === "invoice" ? { paymentDueDate: d.dueDate ?? d.issueDate } : { originalInvoiceReference: d.precedingNumber, ...(d.precedingIssueDate ? { originalInvoiceReferenceDate: d.precedingIssueDate } : {}), creditNoteReasonCode: d.reasonCode }),
    ...(d.notes ? { noteEN: d.notes.slice(0, 500) } : {}),
    buyerName: b.name, buyerRegisteredName: b.legalName, ...(b.trn ? { buyerVatTrn: b.trn, buyerVatScheme: "VAT" } : {}), buyerAddressLine1: b.street || b.city || "", buyerCity: b.city ?? "",
    ...(subdivision(b.country, b.emirate) ? { buyerCountrySubdivision: subdivision(b.country, b.emirate) } : {}), buyerCountryCode: b.country || "AE",
    ...(b.peppolId ? { customerParticipantId: b.peppolId } : {}),
    lineExtensionTotal: net, docLevelDiscount: 0, docLevelCharges: 0, taxAmount: tax, totalIncludingTax: incl, roundingAmount: r2(payable - incl), payableAmount: payable,
    lines, allowances: [],
    payments: kind === "invoice" ? [{ paymentMeansCode: "ZZZ" }] : [],                     // a credit note carries no payment means (ibr-191-ae); "mutually defined" avoids inventing bank details
  };
}

const textList = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean).slice(0, 20).map((x: any) => (typeof x === "string" ? x : x.message ?? x.rule ?? x.error ?? JSON.stringify(x)).toString().slice(0, 300));

/** Reads an Aigentrix delivery status (and optional FTA reporting status) into our vocabulary. Only a delivered/acknowledged state is "accepted". */
export function mapAigentrixStatus(status: unknown, ref: string, reporting?: unknown, reasons: string[] = []): EInvoiceResult {
  const s = String(status ?? "").toUpperCase();
  const out: EInvoiceResult = { providerRef: ref, status: REJECTED.has(s) ? "rejected" : ACCEPTED.has(s) ? "accepted" : "submitted", reasons };
  if (s === "TRANSMISSION_FAILED" || s === "ERROR") out.reasons = reasons.length ? reasons : ["The provider could not deliver the document and is retrying."];
  if (reporting) out.reporting = String(reporting);
  return out;
}

export function aigentrixAdapter(creds: AigentrixCredentials, fetchImpl: Fetch = fetch): EInvoiceAdapter {
  const base = (creds.baseUrl ?? AIGENTRIX_BASE_URL).replace(/\/$/, "");
  const headers = (extra: Record<string, string> = {}) => ({ accept: "application/json", "x-api-key": creds.apiKey, ...extra });
  async function call(path: string, init: RequestInit): Promise<{ status: number; body: any; text: string }> {
    let res: Response;
    try { res = await fetchImpl(base + path, { ...init, signal: AbortSignal.timeout(20_000) }); }
    catch (e: any) { throw new ProviderError(`e-invoicing provider unreachable: ${e.message}`, true); }
    const text = await res.text(); let body: any = {}; try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (res.status >= 500 || res.status === 429) throw new ProviderError(`e-invoicing provider answered ${res.status}`, true);
    if (res.status === 401 || res.status === 403) throw new ProviderError("e-invoicing provider refused the API key or this company", false);
    return { status: res.status, body, text };
  }
  /** A business refusal about the account (plan missing, limit reached) is final and not the document's fault. */
  const fatal = (body: any) => { const k = String(body?.errorKey ?? ""); if (FATAL_KEYS.has(k)) throw new ProviderError(k === "document.limit.exist" ? "the provider says the plan's document limit has been reached" : `the provider refused the account (${k})`, false); };
  const refusal = (r: { status: number; body: any }) => { fatal(r.body); const m = textList(r.body?.errorLog ?? r.body?.error ?? r.body?.errorKey); return m.length ? m : [`Provider answered HTTP ${r.status}`]; };

  const entryOf = async (ref: string) => (await call(`/eInvoiceEntry/${encodeURIComponent(ref)}`, { method: "GET", headers: headers() })).body;
  const errorsOf = async (ref: string): Promise<string[]> => { const r = await call(`/eInvoiceEntry/${encodeURIComponent(ref)}/validationErrors`, { method: "GET", headers: headers() }); return textList(r.body?.errors).length ? textList(r.body?.errors) : textList(r.body?.schematronValidation?.failedRules); };

  /** An entry already sent for this document number (a retry after a lost response must adopt it, not post it again). */
  async function existing(d: StructuredDoc) {
    const q = new URLSearchParams({ companyId: creds.companyId, startDate: d.issueDate, endDate: d.issueDate, searchString: d.number, type: "OUTBOUND", perPage: "10" });
    const r = await call(`/eInvoiceEntry?${q}`, { method: "GET", headers: headers() });
    return (Array.isArray(r.body?.content) ? r.body.content : []).find((e: any) => e.documentIdEN === d.number);
  }

  return {
    name: "aigentrix",
    async submit(s: EInvoiceSubmission): Promise<EInvoiceResult> {
      const d = s.doc;
      if (!d) throw new ProviderError("Aigentrix needs the structured document, not UBL alone", false);
      if (s.kind === "credit_note" && !CREDIT_REASONS.test(d.reasonCode ?? "")) return { providerRef: `aigentrix-${d.number}`, status: "rejected", reasons: ["A credit note needs an FTA reason code. Put one of DL8.61.1.A–E or VD in the credit note's reason, or word it such as returned, cancelled, error or price change."] };
      const prior = await existing(d);
      if (prior && !EDITABLE.has(String(prior.status).toUpperCase())) return mapAigentrixStatus(prior.status, String(prior.id), undefined, []);   // already sent: adopt, do not duplicate
      let id = prior ? String(prior.id) : "";
      const created = await call("/eInvoiceEntry/createFull", { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(aigentrixBody(s.kind, d, creds.companyId)) });
      if (created.status >= 400 || created.body?.success === false || !created.body?.entryId) return { providerRef: `aigentrix-${d.number}`, status: "rejected", reasons: refusal(created) };
      id = String(created.body.entryId);
      const submitted = await call(`/eInvoiceEntry/${encodeURIComponent(id)}`, { method: "PUT", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ id: Number(id), status: "SUBMITTED" }) });
      if (submitted.status >= 400 || submitted.body?.success === false) return { providerRef: id, status: "rejected", reasons: refusal(submitted) };
      return mapAigentrixStatus(submitted.body?.status ?? "SUBMITTED", id);
    },
    async status(ref: string) {
      const e = await call(`/eInvoiceEntry/${encodeURIComponent(ref)}`, { method: "GET", headers: headers() });
      if (e.status >= 400) return { providerRef: ref, status: "error" as const, reasons: [`Provider answered HTTP ${e.status}`] };
      const st = String(e.body?.status ?? "").toUpperCase();
      return mapAigentrixStatus(st, ref, e.body?.taxStatus, REJECTED.has(st) ? (await errorsOf(ref).catch(() => [])) : []);
    },
    async downloadXml(ref: string, opts?: { inbound?: boolean }) {
      const r = await call(`/print/orgxml/${encodeURIComponent(ref)}?fileName=${opts?.inbound ? "inbound_receive" : "outbound_sent"}`, { method: "GET", headers: headers({ accept: "application/xml" }) });
      if (r.status >= 400) throw new ProviderError(`the provider could not return the XML (HTTP ${r.status})`, false);
      return r.text;
    },
    async describeDocument(ref: string): Promise<InboundDocument> {
      const e = await entryOf(ref), total = Number(e.legalFinalPayableEN);
      return { providerDocId: String(e.id ?? ref), number: e.documentIdEN ?? null, senderName: e.supplyPartyNameEN ?? null, currency: e.documentCurrencyCode ?? null, totalMinor: Number.isFinite(total) ? Math.round(total * 100) : null, issuedOn: e.issueDateEN ? String(e.issueDateEN).slice(0, 10) : null };
    },
  };
}
