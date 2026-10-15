import { Hono } from "hono";
import { HttpError, formatDate } from "../lib/util.js";
import { PACKAGES, SERVICE_PROVIDERS, staffConfigure, staffListServices, staffSetState } from "../ops/einvoice-service.js";
import { formBody, requireStaff, str, type Env, type C } from "./mw.js";
import { AdminShell, Badge, Csrf, Table, type Page } from "./ui.js";
import { back } from "./appkit.js";

/** Platform staff: set up e-invoicing for the workspaces that bought it. Provider credentials are written here and never shown again. */
export const adminEInvoice = new Hono<Env>();
adminEInvoice.use("/admin/einvoice", requireStaff);
adminEInvoice.use("/admin/einvoice/*", requireStaff);
const pg = (c: C, title: string): Page => ({ title, csrf: c.get("csrf"), path: c.req.path, user: { name: c.get("session")!.name }, ok: c.req.query("ok"), err: c.req.query("err") });
const who = (c: C) => ({ userId: c.get("session")!.userId, role: c.get("session")!.staffRole! });
const run = async (c: C, to: string, fn: () => Promise<string>) => {
  try { return back(c, to, await fn()); } catch (e) { if (e instanceof HttpError && e.status < 500) return back(c, to, undefined, e.message); throw e; }
};
const BADGE: Record<string, string> = { active: "ok", onboarding: "info", suspended: "bad", not_activated: "warn" };
const pkgLabel = (k: string | null) => PACKAGES.find((p) => p.key === k)?.label ?? (k ?? "—");

adminEInvoice.get("/admin/einvoice", async (c) => {
  const rows = await staffListServices(c.get("db")), sel = c.req.query("tenant"), cur = sel ? rows.find((r) => r.tenant_id === sel) : null, csrf = c.get("csrf");
  return c.html(<AdminShell p={pg(c, "E-invoicing service")}>
    <header class="page"><h1>E-invoicing service</h1></header>
    <p class="small mute">A workspace asks for e-invoicing, pays, and appears here as Onboarding. Attach its provider account and credentials, set the document allowance, then activate it. Credentials are stored encrypted and cannot be read back. Live sending needs Active; Sandbox testing works while Onboarding.</p>
    <Table head={["Workspace", "State", "Package", "Provider", "Environment", "Documents", "Requested", ""]} empty="No workspace has asked for e-invoicing yet.">
      {rows.map((r: any) => <tr><td>{r.workspace}</td><td><Badge s={BADGE[r.state] ?? "info"} label={r.state.replace(/_/g, " ")} /></td><td class="small">{pkgLabel(r.package)}</td><td>{r.provider ?? "—"}{r.provider && !r.has_credentials ? <span class="small mute"> (no credentials)</span> : null}</td>
        <td>{r.provider ? r.environment : "—"}</td><td class="small">{r.used_docs}{r.allowance_docs !== null ? ` / ${r.allowance_docs}` : ""}</td><td class="small">{r.requested_at ? formatDate(r.requested_at) : "—"}</td><td><a href={`/admin/einvoice?tenant=${r.tenant_id}`}>Open</a></td></tr>)}</Table>
    {cur ? <section class="card"><h2>{cur.workspace}</h2>
      <p class="small">Requested package: <strong>{pkgLabel(cur.package)}</strong>{cur.payment_note ? <> · Payment note: {cur.payment_note}</> : null}{cur.activated_at ? <> · Activated {formatDate(cur.activated_at)}</> : null}</p>
      <form method="post" action={`/admin/einvoice/${cur.tenant_id}/configure`}><Csrf t={csrf} />
        <div class="field"><label for="provider">Provider</label><select id="provider" name="provider">{Object.entries(SERVICE_PROVIDERS).map(([k, v]) => <option value={k} selected={cur.provider === k}>{v.label}</option>)}</select></div>
        <div class="field"><label for="api_key">Provider API key (organisation key; Wafeq: pk_test_… reaches Sandbox, pk_live_… Live)</label><input id="api_key" name="api_key" type="password" autocomplete="off" placeholder={cur.has_credentials ? "Stored — leave blank to keep" : ""} /></div>
        <div class="field"><label for="taxpayer_id">Client's account at the provider (Wafeq: taxpayer ID txpay_… · Aigentrix: company ID) — not the TRN</label><input id="taxpayer_id" name="taxpayer_id" autocomplete="off" value={cur.taxpayer_ref ?? ""} placeholder="txpay_… or company number" /></div>
        <div class="field"><label for="environment">Aigentrix only: environment (must match the company's default environment in the Aigentrix portal; Wafeq takes it from the key)</label><select id="environment" name="environment"><option value="">Keep as stored</option><option value="sandbox">Sandbox</option><option value="live">Live</option></select></div>
        <div class="field"><label for="webhook_secret">Aigentrix only: webhook signing secret (shown once when the subscription is created)</label><input id="webhook_secret" name="webhook_secret" type="password" autocomplete="off" placeholder="Stored — leave blank to keep" /></div>
        <div class="field"><label for="allowance_docs">Document allowance for the period (blank = no limit)</label><input id="allowance_docs" name="allowance_docs" inputmode="numeric" value={cur.allowance_docs ?? ""} /></div>
        <div class="field"><label for="period_ends">Allowance period ends</label><input id="period_ends" name="period_ends" type="date" value={cur.period_ends ? String(cur.period_ends).slice(0, 10) : ""} /></div>
        <button class="btn sm">Save</button></form>
      <form method="post" action={`/admin/einvoice/${cur.tenant_id}/state`} class="inline-form"><Csrf t={csrf} />
        <input name="reason" placeholder="Payment reference / reason" required /><select name="state"><option value="active">Activate</option><option value="suspended">Suspend</option><option value="onboarding">Back to onboarding</option></select><button class="btn sm">Apply</button></form></section> : null}
  </AdminShell>);
});
adminEInvoice.post("/admin/einvoice/:tenant/configure", async (c) => {
  const t = c.req.param("tenant"), b = await formBody(c);
  return run(c, `/admin/einvoice?tenant=${t}`, async () => { await staffConfigure(c.get("db"), who(c), t, b); return "Saved."; });
});
adminEInvoice.post("/admin/einvoice/:tenant/state", async (c) => {
  const t = c.req.param("tenant"), b = await formBody(c);
  return run(c, `/admin/einvoice?tenant=${t}`, async () => { await staffSetState(c.get("db"), who(c), t, str(b.state) as any, str(b.reason)); return "Updated."; });
});
