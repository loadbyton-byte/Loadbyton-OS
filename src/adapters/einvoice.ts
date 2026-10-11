/**
 * Accredited service provider (ASP) boundary for UAE e-invoicing. Each real provider has its own API, onboarding and credentials, so a live
 * integration is one small adapter implementing this interface, registered below once the customer has chosen and been accredited with a
 * provider. None is shipped: only a deterministic sandbox for development and tests, which never contacts anyone and is not accepted evidence
 * of anything.
 */
export interface EInvoiceSubmission { reference: string; kind: "invoice" | "credit_note"; xml: string }
export interface EInvoiceResult { providerRef: string; status: "submitted" | "accepted" | "rejected" | "error"; reasons: string[] }
export interface EInvoiceAdapter {
  name: string;
  submit(s: EInvoiceSubmission): Promise<EInvoiceResult>;
  status(providerRef: string): Promise<EInvoiceResult>;
}

const REQUIRED = ["<cbc:ID>", "<cbc:IssueDate>", "<cbc:DocumentCurrencyCode>", "<cac:AccountingSupplierParty>", "<cac:AccountingCustomerParty>", "<cac:LegalMonetaryTotal>", "<cac:TaxTotal>"];

/** Accepts structurally complete payloads and rejects incomplete ones, so the submit / reject / track paths can be exercised without a provider. */
export function sandboxAdapter(): EInvoiceAdapter {
  const seen = new Map<string, EInvoiceResult>();
  const evaluate = (s: EInvoiceSubmission): EInvoiceResult => {
    const missing = REQUIRED.filter((t) => !s.xml.includes(t));
    const providerRef = `SANDBOX-${s.reference}`;
    return missing.length ? { providerRef, status: "rejected", reasons: missing.map((m) => `Missing ${m}`) } : { providerRef, status: "accepted", reasons: [] };
  };
  return {
    name: "sandbox",
    async submit(s) { const r = seen.get(s.reference) ?? evaluate(s); seen.set(s.reference, r); return r; },
    async status(ref) { const r = [...seen.values()].find((x) => x.providerRef === ref); return r ?? { providerRef: ref, status: "error", reasons: ["Unknown submission"] }; },
  };
}

/** Live adapters register here (by provider name) when they exist. Selecting an unregistered provider fails closed. */
export const PROVIDERS: Record<string, () => EInvoiceAdapter> = {};
export function adapterFor(name: string | null | undefined): EInvoiceAdapter | null {
  if (name === "sandbox") return sandboxAdapter();
  const make = name ? PROVIDERS[name] : undefined;
  return make ? make() : null;
}
