import { Hono } from "hono";
import { formatDay } from "../lib/util.js";
import { FORMAT_LABEL, generateEInvoice, getEInvoice, getSettings, listEInvoices, previewReadiness, refreshEInvoice, saveSettings, submitEInvoice, updateEntityDetails, updatePartyDetails } from "../ops/einvoice.js";
import { act, appPage, can, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

export const einvoice = new Hono<Env>();
const U = "/app/einvoice";
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;

einvoice.get(U, async (c) => {
  need(c, "finance.write");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({
    settings: await getSettings(cn), docs: await listEInvoices(cn),
    entity: (await cn.query<any>(`SELECT * FROM entities ORDER BY created_at LIMIT 1`)).rows[0],
    invoices: (await cn.query<any>(`SELECT i.id,i.no,p.name AS party,i.total_minor,i.currency FROM invoices i JOIN parties p ON p.id=i.party_id WHERE i.status IN ('issued','part_paid','paid') AND NOT EXISTS (SELECT 1 FROM einvoice_documents e WHERE e.invoice_id=i.id AND e.status IN ('generated','submitted','accepted')) ORDER BY i.issued_at DESC LIMIT 50`)).rows,
    parties: (await cn.query<any>(`SELECT id,name FROM parties WHERE kind='customer' AND (address_line IS NULL OR city IS NULL OR tax_id IS NULL) ORDER BY name LIMIT 50`)).rows,
  }));
  const s = d.settings, e = d.entity;
  return appPage(c, "E-invoicing readiness", <>
    <PageHead title="E-invoicing readiness" sub="Prepare invoice data and a UBL document for an accredited e-invoicing provider. Nothing is sent to the tax authority's network from here." />
    <div class="alert warn"><strong>Not a tax invoice yet.</strong> {FORMAT_LABEL}. Your accredited provider's validation is authoritative, and a document is only an e-invoice once that provider has accepted it. Printed invoices remain operational invoices until then. No provider is bundled; the sandbox only exercises the flow and proves nothing to any authority.</div>
    <h2>Documents</h2>
    <Table head={["Document", "Kind", "Status", "Issues", "Generated", ""]} empty="No documents generated yet.">
      {d.docs.map((x: any) => <tr><td><a href={`${U}/${x.id}`}>{x.number}</a></td><td>{x.kind.replace("_", " ")}</td><td><Badge s={x.status} /></td><td>{x.issue_count ? <Badge s={x.submittable ? "warn" : "bad"} label={x.submittable ? `${x.issue_count} warning(s)` : "blocked"} /> : "None"}</td><td class="small">{formatDay(x.generated_at)}</td>
        <td>{x.status === "generated" && x.submittable && can(c, "finance.void") && s.mode !== "off" ? <form method="post" action={`${U}/${x.id}/submit`}><Csrf t={csrf} /><button class="btn sm">Submit</button></form> : null}</td></tr>)}</Table>
    {can(c, "finance.write") ? <form class="card" method="post" action={`${U}/generate`}><Csrf t={csrf} /><h2>Prepare a document</h2>
      <div class="field"><label for="invoice_id">Invoice</label><select id="invoice_id" name="invoice_id">{d.invoices.map((i: any) => <option value={i.id}>{i.no} · {i.party}</option>)}</select></div><button class="btn sm">Check data and generate</button></form> : null}
    {d.parties.length ? <section class="card"><h2>Customers missing details</h2><p class="small">Address, city and tax registration number are expected on a business customer's tax invoice.</p>
      <ul>{d.parties.map((p: any) => <li><a href={`/app/parties/${p.id}/details`}>{p.name}</a></li>)}</ul></section> : null}
    {can(c, "settings.manage") ? <>
      <form class="card" method="post" action={`${U}/entity`}><Csrf t={csrf} /><h2>Your business details</h2>
        {field("tax_id", "Tax registration number (TRN, 15 digits)", { value: e.tax_id ?? "", inputmode: "numeric" })}{field("legal_name_ar", "Legal name in Arabic", { value: e.legal_name_ar ?? "", dir: "rtl" })}{field("address_line", "Street address", { value: e.address_line ?? "" })}
        {field("city", "City", { value: e.city ?? "" })}{field("emirate", "Emirate", { value: e.emirate ?? "" })}{field("country", "Country (2 letters)", { value: e.country ?? "AE", maxlength: "2" })}
        {field("einvoice_scheme", "Endpoint scheme (from your provider)", { value: e.einvoice_scheme ?? "" })}{field("einvoice_endpoint", "Endpoint ID (from your provider)", { value: e.einvoice_endpoint ?? "" })}<button class="btn">Save</button></form>
      <form class="card" method="post" action={`${U}/settings`}><Csrf t={csrf} /><h2>Provider settings</h2>
        <div class="field"><label for="mode">Mode</label><select id="mode" name="mode"><option value="off" selected={s.mode === "off"}>Off</option><option value="sandbox" selected={s.mode === "sandbox"}>Sandbox (no provider contacted)</option><option value="live" selected={s.mode === "live"}>Live (needs an installed provider adapter)</option></select></div>
        {field("provider", "Provider name (live mode)", { value: s.provider && s.provider !== "sandbox" ? s.provider : "" })}{field("customization_id", "Customization ID (from your provider's specification)", { value: s.customization_id ?? "" })}{field("profile_id", "Profile ID (from your provider's specification)", { value: s.profile_id ?? "" })}<button class="btn">Save</button></form></> : null}
  </>);
});
einvoice.post(`${U}/settings`, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => saveSettings(cn, ctx, b)); return { to: U, ok: "Settings saved." }; }); });
einvoice.post(`${U}/entity`, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => updateEntityDetails(cn, ctx, b)); return { to: U, ok: "Business details saved." }; }); });
einvoice.post(`${U}/generate`, async (c) => {
  const b = await formBody(c);
  return act(c, U, async () => { const d = await withT(c, (cn, ctx) => generateEInvoice(cn, ctx, "invoice", str(b.invoice_id))); return { to: `${U}/${d.id}`, ok: d.submittable ? "Document generated." : "Generated, with blocking issues to fix first." }; });
});
einvoice.post(`${U}/:id/submit`, async (c) => {
  const id = c.req.param("id");
  return act(c, `${U}/${id}`, async () => { const d = await withT(c, (cn, ctx) => submitEInvoice(cn, ctx, id)); return { to: `${U}/${id}`, ok: `Provider result: ${d.status}.` }; });
});
einvoice.post(`${U}/:id/refresh`, async (c) => {
  const id = c.req.param("id");
  return act(c, `${U}/${id}`, async () => { const d = await withT(c, (cn, ctx) => refreshEInvoice(cn, ctx, id)); return { to: `${U}/${id}`, ok: `Provider state: ${d.status}.` }; });
});
einvoice.get(`${U}/:id/xml`, async (c) => {
  need(c, "finance.write");
  const d = await withT(c, (cn) => getEInvoice(cn, c.req.param("id")));
  return c.body(d.payload_xml, 200, { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${d.number.replace(/[^A-Za-z0-9._-]/g, "_")}.xml"` });
});
einvoice.get(`${U}/:id`, async (c) => {
  need(c, "finance.write");
  const id = c.req.param("id");
  const d = await withT(c, (cn) => getEInvoice(cn, id));
  return appPage(c, d.number, <>
    <PageHead title={`${d.number} · ${d.kind.replace("_", " ")}`} sub={d.format_label}><Badge s={d.status} /><a class="btn ghost sm" href={`${U}/${id}/xml`}>Download XML</a></PageHead>
    {(d.issues as any[]).length ? <Table head={["", "Check"]}>{(d.issues as any[]).map((i) => <tr><td><Badge s={i.level === "blocker" ? "bad" : "warn"} label={i.level} /></td><td>{i.message}</td></tr>)}</Table> : <p class="good">Every readiness check passed.</p>}
    {d.provider ? <p class="small">Provider: {d.provider}{d.provider_ref ? ` · reference ${d.provider_ref}` : ""}{d.provider_response?.sandbox ? " · sandbox result — not evidence of acceptance by any authority" : ""}{d.provider_response?.reasons?.length ? ` · ${d.provider_response.reasons.join("; ")}` : ""}</p> : null}
    {d.status === "submitted" ? <form method="post" action={`${U}/${id}/refresh`}><Csrf t={c.get("csrf")} /><button class="btn ghost sm">Check provider status</button></form> : null}
    <p class="small mute">Payload integrity: <code>{d.payload_sha256}</code></p>
    <p><a href={U}>Back</a></p></>);
});
einvoice.get("/app/parties/:id/details", async (c) => {
  need(c, "party.write");
  const id = c.req.param("id"), csrf = c.get("csrf");
  const p = await withT(c, async (cn) => (await cn.query<any>(`SELECT * FROM parties WHERE id=$1`, [id])).rows[0]);
  if (!p) return c.notFound();
  return appPage(c, p.name, <>
    <PageHead title={p.name} sub="Registration, address and e-invoicing details" />
    <form class="card" method="post" action={`/app/parties/${id}/details`}><Csrf t={csrf} />
      {field("tax_id", "Tax registration number (TRN)", { value: p.tax_id ?? "", inputmode: "numeric" })}{field("name_ar", "Name in Arabic", { value: p.name_ar ?? "", dir: "rtl" })}{field("address_line", "Street address", { value: p.address_line ?? "" })}
      {field("city", "City", { value: p.city ?? "" })}{field("emirate", "Emirate", { value: p.emirate ?? "" })}{field("country", "Country (2 letters)", { value: p.country ?? "AE", maxlength: "2" })}
      {field("einvoice_scheme", "Endpoint scheme", { value: p.einvoice_scheme ?? "" })}{field("einvoice_endpoint", "Endpoint ID", { value: p.einvoice_endpoint ?? "" })}<button class="btn">Save</button></form></>);
});
einvoice.post("/app/parties/:id/details", async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `/app/parties/${id}/details`, async () => { await withT(c, (cn, ctx) => updatePartyDetails(cn, ctx, id, b)); return { to: U, ok: "Details saved." }; });
});
void previewReadiness;
