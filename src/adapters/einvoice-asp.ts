import { config } from "../config.js";
import { PROVIDERS, ProviderError, type EInvoiceAdapter, type EInvoiceResult, type EInvoiceSubmission } from "./einvoice.js";

/**
 * Configurable adapter for an accredited service provider (ASP) that exposes a JSON/HTTPS API. Providers differ in paths, authentication and
 * response vocabulary, so those come from the environment (EINVOICE_ASP_*). Nothing here is evidence of accreditation or of acceptance by the
 * national system: the provider's answer is authoritative, and an unrecognised answer is treated as "submitted", never as "accepted".
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type AspConfig = typeof config.einvoiceAsp;

const pick = (obj: any, path: string): unknown => path.split(".").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const asList = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => (typeof x === "string" ? x : JSON.stringify(x)).slice(0, 300)).slice(0, 20);

export function aspAdapter(cfg: AspConfig = config.einvoiceAsp, fetchImpl: Fetch = fetch): EInvoiceAdapter {
  const url = (tpl: string, vars: Record<string, string>) => cfg.baseUrl.replace(/\/$/, "") + tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    accept: "application/json", ...extra,
    ...(cfg.authScheme === "bearer" ? { authorization: `Bearer ${cfg.apiKey}` } : { [cfg.authHeader]: cfg.apiKey }),
    ...(cfg.tenantId ? { [cfg.tenantHeader]: cfg.tenantId } : {}),
  });
  const map = (body: any, ref: string): EInvoiceResult => {
    const raw = String(pick(body, cfg.statusField) ?? "").toLowerCase();
    const status = cfg.acceptedValues.includes(raw) ? "accepted" : cfg.rejectedValues.includes(raw) ? "rejected" : cfg.errorValues.includes(raw) ? "error" : "submitted";
    return { providerRef: String(pick(body, cfg.referenceField) ?? ref).slice(0, 200), status, reasons: asList(pick(body, cfg.reasonsField)) };
  };
  async function call(path: string, init: RequestInit): Promise<any> {
    let res: Response;
    try { res = await fetchImpl(path, { ...init, signal: AbortSignal.timeout(20_000) }); }
    catch (e: any) { throw new ProviderError(`e-invoicing provider unreachable: ${e.message}`, true); }
    const text = await res.text();
    let body: any = {}; try { body = text ? JSON.parse(text) : {}; } catch { /* non-JSON body */ }
    // a 4xx with a body the provider understands is a rejection, not an outage; 5xx and 429 are retryable errors
    if (res.status >= 500 || res.status === 429) throw new ProviderError(`e-invoicing provider answered ${res.status}`, true);
    if (res.status === 401 || res.status === 403) throw new ProviderError("e-invoicing provider refused the credentials", false);
    if (!res.ok) return { __http: res.status, ...body };
    return body;
  }
  return {
    name: cfg.name,
    async submit(s: EInvoiceSubmission) {
      const payload: { body: string; headers: Record<string, string> } = cfg.bodyFormat === "xml"
        ? { body: s.xml, headers: { "content-type": "application/xml", "idempotency-key": s.reference, "x-document-kind": s.kind } }
        : { body: JSON.stringify({ reference: s.reference, kind: s.kind, document: Buffer.from(s.xml).toString("base64"), encoding: "base64", format: "ubl-2.1" }), headers: { "content-type": "application/json", "idempotency-key": s.reference } };
      const body = await call(url(cfg.submitPath, { reference: s.reference }), { method: "POST", headers: headers(payload.headers), body: payload.body });
      if (body.__http) return { providerRef: `${cfg.name}-${s.reference}`.slice(0, 200), status: "rejected" as const, reasons: asList(pick(body, cfg.reasonsField)).length ? asList(pick(body, cfg.reasonsField)) : [`Provider answered HTTP ${body.__http}`] };
      return map(body, s.reference);
    },
    async status(ref: string) {
      const body = await call(url(cfg.statusPath, { ref }), { method: "GET", headers: headers() });
      if (body.__http) return { providerRef: ref, status: "error" as const, reasons: [`Provider answered HTTP ${body.__http}`] };
      return map(body, ref);
    },
  };
}

/** Registers the configured provider under its configured name. Without credentials nothing is registered and selecting it fails closed. */
export function registerConfiguredAsp(cfg: AspConfig = config.einvoiceAsp, fetchImpl?: Fetch) {
  if (!cfg.name || !cfg.baseUrl || !cfg.apiKey || cfg.name === "sandbox") return;
  PROVIDERS[cfg.name] = () => aspAdapter(cfg, fetchImpl);
}
registerConfiguredAsp();
