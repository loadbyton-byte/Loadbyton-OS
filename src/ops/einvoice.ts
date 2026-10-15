import type { Conn } from "../db/client.js";
import "../adapters/einvoice-asp.js";
import { adapterFor, sandboxAdapter, ProviderError, type EInvoiceAdapter, type StructuredDoc, type StructuredParty } from "../adapters/einvoice.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import type { Actor } from "../lib/audit.js";
import { assertAllowance, getService, routeFor, spendAllowance, type Route } from "./einvoice-service.js";
import { badRequest, forbidden, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, optStr, recordId } from "./common.js";

/**
 * UAE e-invoicing groundwork. Builds a UBL 2.1 invoice / credit-note document in the Peppol BIS Billing 3.0 core structure from an issued
 * invoice, runs completeness checks on the data an accredited provider will demand, and tracks submission state through a provider adapter.
 *
 * What this is not: it is not validated against the official UAE specification or schematron, and no provider is bundled. The CustomizationID
 * and ProfileID, and the customer's endpoint identifiers, come from the provider the customer is accredited with — they are entered, never
 * assumed. The provider's validation is authoritative. Until a document is accepted by a provider, the printed invoice remains an operational
 * invoice, not a tax invoice issued through the national system.
 */
export const FORMAT_LABEL = "UBL 2.1 · Peppol BIS Billing 3.0 core structure · not validated against the UAE specification";

const esc = (s: unknown) => String(s ?? "").replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch]!);
const amt = (minor: number | string) => (Number(minor) / 100).toFixed(2);
const day = (d: unknown) => new Date(d as any).toISOString().slice(0, 10);

/** Our tax codes mapped to UN/CEFACT 5305 category codes. Exempt and out-of-scope lines need an exemption reason. */
const TAX_CATEGORY: Record<string, { id: string; percent: number; reason?: string }> = {
  SR5: { id: "S", percent: 5 }, ZR0: { id: "Z", percent: 0 }, EX0: { id: "E", percent: 0, reason: "Exempt supply" }, OOS: { id: "O", percent: 0, reason: "Outside the scope of VAT" },
};

export interface Issue { level: "blocker" | "warning"; code: string; message: string }

async function loadParties(c: Conn, invoice: any) {
  const supplier = await must(c.query<any>(`SELECT * FROM entities WHERE id=$1`, [invoice.entity_id]), "Entity");
  const buyer = await must(c.query<any>(`SELECT * FROM parties WHERE id=$1`, [invoice.party_id]), "Customer");
  return { supplier, buyer };
}

export function checkReadiness(inv: any, supplier: any, buyer: any, lines: any[], settings: any): Issue[] {
  const out: Issue[] = [];
  const b = (code: string, message: string) => out.push({ level: "blocker", code, message });
  const w = (code: string, message: string) => out.push({ level: "warning", code, message });
  if (!/^\d{15}$/.test(String(supplier.tax_id ?? "").replace(/\s/g, ""))) b("supplier_trn", "Your tax registration number (TRN) is missing or is not 15 digits.");
  if (!supplier.legal_name) b("supplier_legal_name", "Your legal entity name is not set.");
  if (!supplier.address_line || !supplier.city || !supplier.emirate) b("supplier_address", "Your address, city and emirate are incomplete.");
  if (!settings?.managed && (!supplier.einvoice_scheme || !supplier.einvoice_endpoint)) b("supplier_endpoint", "Your e-invoicing endpoint identifier (scheme and ID from your provider) is not set.");
  if (!buyer.address_line || !buyer.city) b("buyer_address", `${buyer.name}: address or city is missing.`);
  if (!buyer.tax_id) w("buyer_trn", `${buyer.name}: no tax registration number. A VAT-registered business customer will need one on the document.`);
  else if (buyer.country === "AE" && !/^\d{15}$/.test(String(buyer.tax_id).replace(/\s/g, ""))) b("buyer_trn_format", `${buyer.name}: the tax registration number is not 15 digits.`);
  if (!buyer.einvoice_scheme || !buyer.einvoice_endpoint) w("buyer_endpoint", `${buyer.name}: no e-invoicing endpoint identifier; your provider may need one to deliver the document.`);
  if (!settings?.managed && (!settings?.customization_id || !settings?.profile_id)) b("format_ids", "The format identifiers (customization and profile) from your provider's specification are not set.");
  const sum = lines.reduce((a, l) => a + Number(l.net_minor), 0), tax = lines.reduce((a, l) => a + Number(l.tax_minor), 0);
  if (sum !== Number(inv.subtotal_minor) || tax !== Number(inv.tax_minor)) b("totals", "The invoice lines do not add up to its totals; it cannot be sent.");
  for (const l of lines) {
    if (!TAX_CATEGORY[l.tax_code]) b("tax_code", `Line “${l.description}” uses tax code ${l.tax_code}, which has no e-invoice category mapping.`);
    if (Math.abs(Math.round(Number(l.qty) * Number(l.unit_minor)) - Number(l.net_minor)) > 1) w("line_price", `Line “${l.description}”: quantity × unit price differs from its net amount.`);
  }
  if (!lines.length) b("no_lines", "The invoice has no lines.");
  return out;
}

function party(tag: string, name: string, legal: string, trn: string | null, scheme: string | null, endpoint: string | null, addr: { line: string | null; city: string | null; emirate: string | null; country: string }) {
  return `  <cac:${tag}>
    <cac:Party>
${scheme && endpoint ? `      <cbc:EndpointID schemeID="${esc(scheme)}">${esc(endpoint)}</cbc:EndpointID>\n` : ""}      <cac:PartyName><cbc:Name>${esc(name)}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(addr.line)}</cbc:StreetName>
        <cbc:CityName>${esc(addr.city)}</cbc:CityName>
${addr.emirate ? `        <cbc:CountrySubentity>${esc(addr.emirate)}</cbc:CountrySubentity>\n` : ""}        <cac:Country><cbc:IdentificationCode>${esc(addr.country)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
${trn ? `      <cac:PartyTaxScheme><cbc:CompanyID>${esc(trn.replace(/\s/g, ""))}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>\n` : ""}      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(legal)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:${tag}>`;
}

export interface DocSource { taxCurrency?: { code: string; taxMinor: number }; kind: "invoice" | "credit_note"; number: string; issuedAt: unknown; dueAt?: unknown; currency: string; subtotal: number; tax: number; total: number; reason?: string; invoiceRef?: string; invoiceRefDate?: unknown;
  lines: { description: string; qty: number | string; unit_minor: number | string; net_minor: number | string; tax_minor: number | string; tax_code: string }[] }

export function buildUbl(src: DocSource, supplier: any, buyer: any, settings: { customization_id?: string | null; profile_id?: string | null }): string {
  const root = src.kind === "invoice" ? "Invoice" : "CreditNote", ns = `urn:oasis:names:specification:ubl:schema:xsd:${root}-2`;
  const groups = new Map<string, { cat: { id: string; percent: number; reason?: string }; taxable: number; tax: number }>();
  for (const l of src.lines) {
    const cat = TAX_CATEGORY[l.tax_code]; if (!cat) continue;
    const key = `${cat.id}|${cat.percent}`, g = groups.get(key) ?? { cat, taxable: 0, tax: 0 };
    g.taxable += Number(l.net_minor); g.tax += Number(l.tax_minor); groups.set(key, g);
  }
  const lineTag = src.kind === "invoice" ? "InvoiceLine" : "CreditNoteLine", qtyTag = src.kind === "invoice" ? "InvoicedQuantity" : "CreditedQuantity";
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${esc(settings.customization_id ?? "")}</cbc:CustomizationID>
  <cbc:ProfileID>${esc(settings.profile_id ?? "")}</cbc:ProfileID>
  <cbc:ID>${esc(src.number)}</cbc:ID>
  <cbc:IssueDate>${day(src.issuedAt)}</cbc:IssueDate>
${src.kind === "invoice" && src.dueAt ? `  <cbc:DueDate>${day(src.dueAt)}</cbc:DueDate>\n` : ""}  <cbc:${src.kind === "invoice" ? "InvoiceTypeCode" : "CreditNoteTypeCode"}>${src.kind === "invoice" ? "380" : "381"}</cbc:${src.kind === "invoice" ? "InvoiceTypeCode" : "CreditNoteTypeCode"}>
${src.reason ? `  <cbc:Note>${esc(src.reason)}</cbc:Note>\n` : ""}  <cbc:DocumentCurrencyCode>${esc(src.currency)}</cbc:DocumentCurrencyCode>
${src.taxCurrency ? `  <cbc:TaxCurrencyCode>${esc(src.taxCurrency.code)}</cbc:TaxCurrencyCode>\n` : ""}${src.invoiceRef ? `  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(src.invoiceRef)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>\n` : ""}${party("AccountingSupplierParty", supplier.name, supplier.legal_name ?? supplier.name, supplier.tax_id, supplier.einvoice_scheme, supplier.einvoice_endpoint, { line: supplier.address_line, city: supplier.city, emirate: supplier.emirate, country: supplier.country })}
${party("AccountingCustomerParty", buyer.name, buyer.name, buyer.tax_id, buyer.einvoice_scheme, buyer.einvoice_endpoint, { line: buyer.address_line, city: buyer.city, emirate: buyer.emirate, country: buyer.country })}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${esc(src.currency)}">${amt(src.tax)}</cbc:TaxAmount>
${[...groups.values()].map((g) => `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${esc(src.currency)}">${amt(g.taxable)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${esc(src.currency)}">${amt(g.tax)}</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>${g.cat.id}</cbc:ID><cbc:Percent>${g.cat.percent.toFixed(2)}</cbc:Percent>${g.cat.reason ? `<cbc:TaxExemptionReason>${esc(g.cat.reason)}</cbc:TaxExemptionReason>` : ""}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>`).join("\n")}
  </cac:TaxTotal>
${src.taxCurrency ? `  <cac:TaxTotal>\n    <cbc:TaxAmount currencyID="${esc(src.taxCurrency.code)}">${amt(src.taxCurrency.taxMinor)}</cbc:TaxAmount>\n  </cac:TaxTotal>\n` : ""}  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${esc(src.currency)}">${amt(src.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${esc(src.currency)}">${amt(src.subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${esc(src.currency)}">${amt(src.total)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${esc(src.currency)}">${amt(src.total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${src.lines.map((l, i) => { const cat = TAX_CATEGORY[l.tax_code]; return `  <cac:${lineTag}>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:${qtyTag} unitCode="C62">${Number(l.qty)}</cbc:${qtyTag}>
    <cbc:LineExtensionAmount currencyID="${esc(src.currency)}">${amt(l.net_minor)}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>${esc(l.description)}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${cat?.id ?? ""}</cbc:ID><cbc:Percent>${(cat?.percent ?? 0).toFixed(2)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${esc(src.currency)}">${amt(l.unit_minor)}</cbc:PriceAmount></cac:Price>
  </cac:${lineTag}>`; }).join("\n")}
</${root}>
`;
}

/** The same document as plain data in major currency units, for providers that take JSON and build the UBL themselves. Frozen with the XML at generation. */
/** FTA credit-note reason codes (BTAE-03). An explicit code in the reason wins; otherwise common wording is read; otherwise none, and the provider step says so. */
export function creditReasonCode(reason: unknown): string | undefined {
  const t = String(reason ?? "");
  const explicit = t.match(/\bDL8\.61\.1\.[A-E]\b|\bVD\b/i)?.[0];
  if (explicit) return explicit.toUpperCase();
  if (/return|sent back|damag/i.test(t)) return "DL8.61.1.D";
  if (/cancel/i.test(t)) return "DL8.61.1.A";
  if (/error|mistake|wrong|incorrect/i.test(t)) return "DL8.61.1.E";
  if (/price|discount|amount|short|rebate|consideration/i.test(t)) return "DL8.61.1.C";
  return undefined;
}

/** The same document as plain data in major currency units, for providers that take JSON and build the UBL themselves. Frozen with the XML at generation. */
export function buildStructured(src: DocSource, supplier: any, buyer: any): StructuredDoc {
  const party = (p: any): StructuredParty => ({ name: p.name, legalName: p.legal_name ?? p.name, trn: p.tax_id ? String(p.tax_id).replace(/\s/g, "") : null,
    peppolId: p.einvoice_scheme && p.einvoice_endpoint ? `${p.einvoice_scheme}:${p.einvoice_endpoint}` : null, street: p.address_line ?? null, city: p.city ?? null, emirate: p.emirate ?? null, country: p.country ?? "AE" });
  const reasonCode = src.kind === "credit_note" ? creditReasonCode(src.reason) : undefined;
  return {
    number: src.number, issueDate: day(src.issuedAt), ...(src.dueAt ? { dueDate: day(src.dueAt) } : {}), currency: src.currency, ...(src.reason ? { notes: src.reason } : {}),
    supplier: party(supplier), buyer: party(buyer),
    lines: src.lines.map((l) => { const cat = TAX_CATEGORY[l.tax_code]; return { description: l.description, quantity: Number(l.qty), unitPrice: Number(l.unit_minor) / 100, taxCategory: cat?.id ?? "S", taxPercent: cat?.percent ?? 0, netAmount: Number(l.net_minor) / 100, taxAmount: Number(l.tax_minor) / 100, ...(cat?.reason ? { exemptionReason: cat.reason } : {}) }; }),
    totals: { net: Number(src.subtotal) / 100, tax: Number(src.tax) / 100, total: Number(src.total) / 100 },
    ...(src.invoiceRef ? { precedingNumber: src.invoiceRef } : {}), ...(src.invoiceRefDate ? { precedingIssueDate: day(src.invoiceRefDate) } : {}), ...(reasonCode ? { reasonCode } : {}),
  };
}

// ───────── settings and party data
export async function getSettings(c: Conn) {
  const base = (await c.query<any>(`SELECT * FROM einvoice_settings`)).rows[0] ?? { mode: "off", provider: null, customization_id: null, profile_id: null };
  return { ...base, managed: !!(await getService(c)).provider };       // with a managed provider account the provider builds the UBL and holds the supplier's network identity
}
export async function saveSettings(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "settings.manage");
  const mode = String(f.mode ?? "off");
  if (!["off", "sandbox", "live"].includes(mode)) throw badRequest("Choose off, sandbox or live.");
  const provider = optStr(f.provider, 80);
  if (mode === "live" && !adapterFor(provider)) throw badRequest("No adapter is installed for that provider. Live submission is only possible once an accredited provider's adapter is installed.");
  await c.query(
    `INSERT INTO einvoice_settings(tenant_id,mode,provider,customization_id,profile_id,updated_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id) DO UPDATE SET mode=$2, provider=$3, customization_id=$4, profile_id=$5, updated_by=$6, updated_at=now()`,
    [ctx.tenantId, mode, mode === "sandbox" ? "sandbox" : provider, optStr(f.customization_id, 200), optStr(f.profile_id, 200), ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "einvoice.settings", "tenant", ctx.tenantId, { mode });
}
const code2 = (v: unknown, label: string) => { const s = String(v ?? "AE").trim().toUpperCase(); if (!/^[A-Z]{2}$/.test(s)) throw badRequest(`${label} must be a two-letter country code.`); return s; };
export async function updateEntityDetails(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "settings.manage");
  const trn = optStr(f.tax_id, 40)?.replace(/\s/g, "") ?? null;
  if (trn && !/^\d{15}$/.test(trn)) throw badRequest("A UAE tax registration number is 15 digits.");
  await c.query(`UPDATE entities SET tax_id=coalesce($1,tax_id), legal_name_ar=$2, address_line=$3, city=$4, emirate=$5, country=$6, einvoice_scheme=$7, einvoice_endpoint=$8 WHERE id=(SELECT id FROM entities ORDER BY created_at LIMIT 1)`,
    [trn, optStr(f.legal_name_ar, 200), optStr(f.address_line, 200), optStr(f.city, 100), optStr(f.emirate, 60), code2(f.country, "Country"), optStr(f.einvoice_scheme, 20), optStr(f.einvoice_endpoint, 100)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "entity.details_updated", "tenant", ctx.tenantId);
}
export async function updatePartyDetails(c: Conn, ctx: Ctx, id: string, f: Record<string, any>) {
  require(ctx, "party.write");
  await assertWritable(c, ctx.tenantId);
  const trn = optStr(f.tax_id, 40)?.replace(/\s/g, "") ?? null, country = code2(f.country, "Country");
  if (trn && country === "AE" && !/^\d{15}$/.test(trn)) throw badRequest("A UAE tax registration number is 15 digits.");
  const billing = optStr(f.billing_currency, 20)?.toUpperCase() ?? null;
  if (billing && !/^[A-Z]{3}$/.test(billing)) throw badRequest("The billing currency is a three-letter code such as USD, or blank to bill in the company currency.");
  await must(c.query(`UPDATE parties SET tax_id=$2, name_ar=$3, address_line=$4, city=$5, emirate=$6, country=$7, einvoice_scheme=$8, einvoice_endpoint=$9, billing_currency=$10 WHERE id=$1 RETURNING id`,
    [recordId(id, "Party"), trn, optStr(f.name_ar, 200), optStr(f.address_line, 200), optStr(f.city, 100), optStr(f.emirate, 60), country, optStr(f.einvoice_scheme, 20), optStr(f.einvoice_endpoint, 100), billing]), "Party");
  await audit(c, ctx.tenantId, actorOf(ctx), "party.details_updated", "party", id);
}

// ───────── generation, readiness and submission
async function sourceFor(c: Conn, kind: "invoice" | "credit_note", id: string) {
  if (kind === "invoice") {
    const inv = await must(c.query<any>(`SELECT * FROM invoices WHERE id=$1`, [recordId(id, "Invoice")]), "Invoice");
    if (inv.status === "void") throw badRequest("A void invoice cannot be sent.");
    const lines = (await c.query<any>(`SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id`, [inv.id])).rows;
    if (inv.billing_currency) {                // presented in the customer's billing currency; VAT is also stated in the base currency
      const bl = lines.map((l: any) => ({ ...l, unit_minor: l.billing_unit_minor, net_minor: l.billing_net_minor, tax_minor: l.billing_tax_minor }));
      const bi = { ...inv, subtotal_minor: inv.billing_subtotal_minor, tax_minor: inv.billing_tax_minor, total_minor: inv.billing_total_minor };
      return { inv: bi, lines: bl, src: { kind, number: inv.no, issuedAt: inv.issued_at, dueAt: inv.due_at, currency: inv.billing_currency, subtotal: Number(inv.billing_subtotal_minor), tax: Number(inv.billing_tax_minor), total: Number(inv.billing_total_minor), taxCurrency: { code: inv.currency, taxMinor: Number(inv.tax_minor) }, lines: bl } as DocSource, entityId: inv.entity_id, partyId: inv.party_id };
    }
    return { inv, lines, src: { kind, number: inv.no, issuedAt: inv.issued_at, dueAt: inv.due_at, currency: inv.currency, subtotal: Number(inv.subtotal_minor), tax: Number(inv.tax_minor), total: Number(inv.total_minor), lines } as DocSource, entityId: inv.entity_id, partyId: inv.party_id };
  }
  const n = await must(c.query<any>(`SELECT n.*, i.no AS invoice_no, i.issued_at AS invoice_issued_at, i.billing_currency, i.fx_rate::float8 AS fx_rate FROM credit_notes n JOIN invoices i ON i.id=n.invoice_id WHERE n.id=$1`, [recordId(id, "Credit note")]), "Credit note");
  if (n.status !== "issued") throw badRequest("Only an issued credit note can be sent.");
  const lines = (await c.query<any>(`SELECT * FROM credit_note_lines WHERE credit_note_id=$1 ORDER BY id`, [n.id])).rows;
  if (n.billing_currency) {                    // a credit note against a foreign-currency invoice is presented at that invoice's own rate
    const r = Number(n.fx_rate), conv = (m: unknown) => Math.round(Number(m) / r);
    const bl = lines.map((l: any) => ({ ...l, unit_minor: conv(l.unit_minor), net_minor: conv(l.net_minor), tax_minor: conv(l.tax_minor) }));
    const sub = bl.reduce((a: number, l: any) => a + l.net_minor, 0), tax = bl.reduce((a: number, l: any) => a + l.tax_minor, 0);
    return { inv: { ...n, subtotal_minor: sub, tax_minor: tax, total_minor: sub + tax }, lines: bl, src: { kind, number: n.no, issuedAt: n.issued_at, currency: n.billing_currency, subtotal: sub, tax, total: sub + tax, taxCurrency: { code: n.currency, taxMinor: Number(n.tax_minor) }, reason: n.reason, invoiceRef: n.invoice_no, invoiceRefDate: n.invoice_issued_at, lines: bl } as DocSource, entityId: n.entity_id, partyId: n.party_id };
  }
  return { inv: n, lines, src: { kind, number: n.no, issuedAt: n.issued_at, currency: n.currency, subtotal: Number(n.subtotal_minor), tax: Number(n.tax_minor), total: Number(n.total_minor), reason: n.reason, invoiceRef: n.invoice_no, invoiceRefDate: n.invoice_issued_at, lines } as DocSource, entityId: n.entity_id, partyId: n.party_id };
}

export async function previewReadiness(c: Conn, kind: "invoice" | "credit_note", id: string) {
  const s = await sourceFor(c, kind, id), { supplier, buyer } = await loadParties(c, { entity_id: s.entityId, party_id: s.partyId }), settings = await getSettings(c);
  return { number: s.src.number, issues: checkReadiness(s.inv, supplier, buyer, s.lines, settings) };
}

export async function generateEInvoice(c: Conn, ctx: Ctx, kind: "invoice" | "credit_note", id: string) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const s = await sourceFor(c, kind, id), { supplier, buyer } = await loadParties(c, { entity_id: s.entityId, party_id: s.partyId }), settings = await getSettings(c);
  const col = kind === "invoice" ? "invoice_id" : "credit_note_id";
  const existing = (await c.query<any>(`SELECT * FROM einvoice_documents WHERE ${col}=$1 AND status IN ('generated','submitted','accepted')`, [id])).rows[0];
  if (existing && existing.status !== "generated") return existing;
  const issues = checkReadiness(s.inv, supplier, buyer, s.lines, settings);
  const xml = buildUbl(s.src, supplier, buyer, settings);
  if (existing) {
    if (existing.payload_sha256 === sha256(xml)) return existing;                       // nothing changed: the same document
    await c.query(`UPDATE einvoice_documents SET status='error', provider_response=$2 WHERE id=$1`, [existing.id, JSON.stringify({ superseded: "A fresh payload was generated after data changed." })]);
  }
  const row = (await c.query<any>(
    `INSERT INTO einvoice_documents(tenant_id,kind,${col},number,payload_xml,payload_sha256,format_label,issues,submittable,generated_by,payload_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [ctx.tenantId, kind, id, s.src.number, xml, sha256(xml), FORMAT_LABEL, JSON.stringify(issues), !issues.some((i) => i.level === "blocker"), ctx.userId, JSON.stringify(buildStructured(s.src, supplier, buyer))])).rows[0];
  await audit(c, ctx.tenantId, actorOf(ctx), "einvoice.generated", kind, id, { blockers: issues.filter((i) => i.level === "blocker").length });
  return row;
}

/** Submitting is an act toward the tax authority's network: an approver does it, only for a payload with no blockers, and only through an installed adapter. */
export async function submitEInvoice(c: Conn, ctx: Ctx, docId: string, adapterOverride?: EInvoiceAdapter) {
  require(ctx, "finance.void");
  await assertWritable(c, ctx.tenantId);
  const d = await must(c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1 FOR UPDATE`, [recordId(docId, "E-invoice")]), "E-invoice");
  if (d.status !== "generated") return d;
  if (!d.submittable) throw badRequest("This payload still has blocking issues. Fix the data and generate it again.");
  return sendDocument(c, { userId: ctx.userId, actor: actorOf(ctx) }, ctx.tenantId, d, adapterOverride);
}

/** Retry schedule for a provider outage: minutes before the next attempt, then give up and mark the document errored for a person to look at. */
export const RETRY_MINUTES = [2, 10, 30, 120, 360];

/**
 * The shared send path (interactive submit and the retry worker). A workspace with an e-invoicing service sends through its own provider account;
 * otherwise the older single-provider settings apply. Duplicate prevention is layered: the document row is locked, only a 'generated' document is sent,
 * the provider gets a stable idempotency reference, and unique indexes allow one live document per invoice and one document per provider reference.
 */
export async function sendDocument(c: Conn, who: { userId: string; actor: Actor }, tenantId: string, d: any, adapterOverride?: EInvoiceAdapter, fetchImpl?: typeof fetch) {
  let adapter = adapterOverride, route: Route | null = null, sandbox = false;
  if (!adapter) route = await routeFor(c, fetchImpl);
  if (route) { adapter = route.adapter; sandbox = route.environment === "sandbox"; assertAllowance(route); }
  else {
    const settings = await getSettings(c);
    if (settings.mode === "off") throw badRequest("E-invoicing is switched off for this workspace.");
    adapter = adapter ?? adapterFor(settings.provider) ?? undefined;
    if (!adapter) throw forbidden("No accredited provider adapter is installed. Submission is not possible.");
    if (settings.mode === "sandbox" && adapter.name !== "sandbox") throw forbidden("Sandbox mode only uses the sandbox adapter.");
    if (settings.mode === "live" && adapter.name === "sandbox") throw forbidden("Live mode cannot use the sandbox adapter.");
    sandbox = adapter.name === "sandbox";
  }
  let doc: StructuredDoc | undefined = d.payload_json ?? undefined;
  if (route && !doc) throw badRequest("This document predates provider submission. Generate it again before sending.");
  if (doc && d.kind === "credit_note") {                      // point the credit note at the provider's own id for the original when that provider issued it
    const orig = (await c.query<any>(`SELECT o.provider_ref FROM einvoice_documents o JOIN credit_notes n ON n.invoice_id=o.invoice_id WHERE n.id=$1 AND o.provider=$2 AND o.status IN ('submitted','accepted') ORDER BY o.generated_at DESC LIMIT 1`, [d.credit_note_id, adapter.name])).rows[0];
    if (orig?.provider_ref) doc = { ...doc, precedingProviderRef: orig.provider_ref };
  }
  const reference = route ? `${tenantId}-${d.number}-${String(d.payload_sha256).slice(0, 8)}` : `${tenantId}-${d.number}`;
  let result;
  try { result = await adapter.submit({ reference, kind: d.kind, xml: d.payload_xml, doc }); }
  catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 300), retryable = e instanceof ProviderError ? e.retryable : false;
    const attempts = Number(d.attempts ?? 0) + 1, exhausted = attempts > RETRY_MINUTES.length;
    if (retryable && !exhausted) {                            // an outage is not a verdict on the document: keep it, try again later
      await c.query(`UPDATE einvoice_documents SET attempts=$2, next_retry_at=now() + ($3 || ' minutes')::interval, last_error=$4, queued_by=$5 WHERE id=$1`, [d.id, attempts, String(RETRY_MINUTES[attempts - 1]), message, who.userId]);
      await audit(c, tenantId, who.actor, "einvoice.retry_scheduled", d.kind, d.invoice_id ?? d.credit_note_id, { attempts, provider: adapter.name });
      return (await c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1`, [d.id])).rows[0];
    }
    await c.query(`UPDATE einvoice_documents SET status='error', provider=$2, provider_response=$3, submitted_by=$4, submitted_at=now(), attempts=$5, next_retry_at=NULL, last_error=$6 WHERE id=$1`,
      [d.id, adapter.name, JSON.stringify({ error: message }), who.userId, attempts, message]);
    await audit(c, tenantId, who.actor, "einvoice.failed", d.kind, d.invoice_id ?? d.credit_note_id, { provider: adapter.name, retryable });
    if (!route && !(e instanceof ProviderError)) throw e;     // the older single-provider path reports the failure to the caller
    return (await c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1`, [d.id])).rows[0];
  }
  const status = result.status === "accepted" ? "accepted" : result.status === "rejected" ? "rejected" : result.status === "error" ? "error" : "submitted";
  await c.query(`UPDATE einvoice_documents SET status=$2, provider=$3, provider_ref=$4, provider_response=$5, submitted_by=$6, submitted_at=now(), decided_at=CASE WHEN $2 IN ('accepted','rejected') THEN now() ELSE NULL END,
      attempts=attempts+1, next_retry_at=NULL, last_error=NULL, tdd_status=$7 WHERE id=$1`,
    [d.id, status, adapter.name, result.providerRef, JSON.stringify({ reasons: result.reasons, sandbox }), who.userId, result.reporting ?? null]);
  if (route && (status === "submitted" || status === "accepted")) await spendAllowance(c, route);
  await audit(c, tenantId, who.actor, "einvoice.submitted", d.kind, d.invoice_id ?? d.credit_note_id, { status, provider: adapter.name });
  return (await c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1`, [d.id])).rows[0];
}

/** Asks the provider for the current state of a document it has not yet decided. A decision is final; an unreachable provider changes nothing. */
export async function refreshEInvoice(c: Conn, ctx: Ctx, docId: string, adapterOverride?: EInvoiceAdapter) {
  require(ctx, "finance.write");
  const d = await must(c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1 FOR UPDATE`, [recordId(docId, "E-invoice")]), "E-invoice");
  if (d.status !== "submitted" || !d.provider_ref) return d;
  const adapter = adapterOverride ?? (await adapterForDocument(c, d));
  if (!adapter) throw forbidden("The provider adapter for this document is no longer installed.");
  const r = await adapter.status(d.provider_ref);
  if (r.reporting && r.reporting !== d.tdd_status) await c.query(`UPDATE einvoice_documents SET tdd_status=$2 WHERE id=$1`, [d.id, r.reporting]);
  if (r.status !== "accepted" && r.status !== "rejected") return (await c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1`, [d.id])).rows[0];
  await c.query(`UPDATE einvoice_documents SET status=$2, provider_response=$3, decided_at=now() WHERE id=$1`, [d.id, r.status, JSON.stringify({ reasons: r.reasons, sandbox: adapter.name === "sandbox" || d.provider_response?.sandbox === true })]);
  await audit(c, ctx.tenantId, actorOf(ctx), "einvoice.refreshed", d.kind, d.invoice_id ?? d.credit_note_id, { status: r.status, provider: adapter.name });
  return (await c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1`, [d.id])).rows[0];
}

/** The adapter that holds a document: the workspace's own provider account when it has one, else a globally installed adapter. */
export async function adapterForDocument(c: Conn, d: any, fetchImpl?: typeof fetch): Promise<EInvoiceAdapter | null> {
  const route = await routeFor(c, fetchImpl, true).catch(() => null);
  if (route && route.adapter.name === d.provider) return route.adapter;
  return adapterFor(d.provider);
}

export async function listEInvoices(c: Conn) {
  return (await c.query<any>(`SELECT id, kind, number, status, submittable, provider, provider_ref, generated_at, jsonb_array_length(issues) AS issue_count FROM einvoice_documents ORDER BY generated_at DESC LIMIT 100`)).rows;
}
export async function getEInvoice(c: Conn, id: string) {
  return must(c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1`, [recordId(id, "E-invoice")]), "E-invoice");
}
export { sandboxAdapter };
