import { Hono } from "hono";
import { HttpError, TAX_CODES, badRequest, fmtMoney, formatDay } from "../lib/util.js";
import { importParties } from "../ops/importer.js";
import { createEnquiry, createParty, createRate, listEnquiries, listParties, listRates, loseEnquiry } from "../ops/crm.js";
import { acceptQuote, approveQuote, createQuote, getQuote, listQuotes, rejectQuote, reviseQuote, sendQuote, submitQuote, type LineInput } from "../ops/quotes.js";
import { arr, formBody, str, type Env } from "./mw.js";
import { redactAll } from "../lib/data-policy.js";
import { act, appPage, can, Confirm, ctxOf, need, PageHead, PostBtn, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table } from "./ui.js";
import { today } from "../ops/common.js";

export const sales = new Hono<Env>();
const plus = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

// ───────── customers & suppliers
sales.get("/app/parties", async (c) => {
  const kind = c.req.query("kind");
  const rows = redactAll("parties", await withT(c, (cn) => listParties(cn, kind)), ctxOf(c));
  const csrf = c.get("csrf");
  return appPage(c, "Customers & suppliers", (<>
    <PageHead title="Customers & suppliers" sub="One master record per party, shared by quotes, jobs, invoices and the portal.">
      <a class="btn ghost sm" href="/app/parties">All</a><a class="btn ghost sm" href="/app/parties?kind=customer">Customers</a><a class="btn ghost sm" href="/app/parties?kind=supplier">Suppliers</a>
    </PageHead>
    <Table head={["Name", "Kind", "Email", "Phone", ["Credit limit", "num"], ["Outstanding", "num"]]} empty={rows.length ? undefined : "No records yet. Add your first customer below."}>
      {rows.map((p: any) => <tr><td>{p.name}</td><td><Badge s="info" label={p.kind} /></td><td>{p.email ?? "—"}</td><td>{p.phone ?? "—"}</td>
        <td class="num">{Number(p.credit_limit_minor) ? <Money v={p.credit_limit_minor} /> : "—"}</td><td class="num"><Money v={p.outstanding_minor} /></td></tr>)}
    </Table>
    {can(c, "party.write") ? (
      <section class="card" style="margin-top:22px;max-width:760px"><h3>Add a customer or supplier</h3>
        <form method="post" action="/app/parties"><Csrf t={csrf} />
          <div class="row"><div class="field"><label for="pn">Name</label><input id="pn" name="name" type="text" required /></div>
            <div class="field"><label for="pk">Kind</label><select id="pk" name="kind"><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="agent">Agent</option></select></div></div>
          <div class="row"><div class="field"><label for="pe">Email</label><input id="pe" name="email" type="email" /></div><div class="field"><label for="pp">Phone</label><input id="pp" name="phone" type="text" /></div>
            <div class="field"><label for="pt">Tax registration no.</label><input id="pt" name="tax_id" type="text" /></div>
            <div class="field"><label for="pc">Credit limit (AED)</label><input id="pc" name="credit_limit" type="number" min="0" step="0.01" /></div></div>
          <label class="check" style="max-width:420px"><input type="checkbox" name="consent_marketing" /><span>Customer has consented to marketing messages</span></label>
          <button class="btn red" style="margin-top:12px" type="submit">Save</button></form></section>) : null}
    {can(c, "party.write") ? (
      <section class="card" style="margin-top:22px;max-width:760px"><h3>Import from CSV</h3>
        <p class="small mute">Header row required: <code>name,kind,email,phone,tax_id</code> (kind = customer, supplier or agent). Existing names are skipped, never overwritten. Max 2,000 rows.</p>
        <form method="post" action="/app/parties/import" enctype="multipart/form-data"><Csrf t={csrf} />
          <div class="field"><input name="file" type="file" accept=".csv,text/csv" required /></div>
          <label class="check" style="max-width:420px"><input type="checkbox" name="dry_run" /><span>Preview only (dry run, nothing saved)</span></label>
          <button class="btn ghost sm" style="margin-top:10px" type="submit">Import</button></form></section>) : null}
  </>));
});
sales.post("/app/parties/import", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/parties", async () => {
    const f = b.file;
    if (!(f instanceof File)) throw new HttpError(400, "Choose a CSV file.");
    if (f.size > 1_000_000) throw new HttpError(400, "CSV files are limited to 1 MB.");
    const dry = b.dry_run === "on";
    const text = Buffer.from(await f.arrayBuffer()).toString("utf8");
    const r = await withT(c, (cn, ctx) => importParties(cn, ctx, text, dry));
    const parts = [`${dry ? "Would create" : "Created"} ${r.created}`, r.duplicates.length ? `${r.duplicates.length} duplicate(s) skipped` : "", r.rejected.length ? `${r.rejected.length} rejected (${r.rejected.slice(0, 3).map((x) => `line ${x.line}: ${x.reason}`).join("; ")})` : ""].filter(Boolean);
    return { to: "/app/parties", ok: parts.join(" · ") + "." };
  });
});
sales.post("/app/parties", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/parties", async () => { await withT(c, (cn, ctx) => createParty(cn, ctx, b)); return { to: "/app/parties", ok: "Saved." }; });
});

// ───────── enquiries
sales.get("/app/enquiries", async (c) => {
  const rows = await withT(c, (cn) => listEnquiries(cn));
  return appPage(c, "Enquiries", (<>
    <PageHead title="Enquiries" sub="From forms, email or approved channels. Duplicates are caught on source reference or content."><a class="btn red" href="/app/enquiries/new">New enquiry</a></PageHead>
    <Table head={["No.", "Customer", "Route", "Mode", "Source", "Status", "Missing"]} empty={rows.length ? undefined : "No enquiries yet."}>
      {rows.map((e: any) => <tr><td><a href={`/app/enquiries/${e.id}`}>{e.no}</a></td><td>{e.party_name ?? "—"}</td><td>{e.origin ?? "?"} → {e.destination ?? "?"}</td><td>{e.mode}</td><td>{e.source}</td><td><Badge s={e.status} /></td>
        <td class="small">{e.missing_info.length ? e.missing_info.join(", ") : "—"}</td></tr>)}
    </Table>
  </>));
});
sales.get("/app/enquiries/new", async (c) => {
  need(c, "enquiry.write");
  const parties = await withT(c, (cn) => listParties(cn, "customer"));
  const csrf = c.get("csrf");
  return appPage(c, "New enquiry", (<>
    <PageHead title="New enquiry" />
    <form method="post" action="/app/enquiries" class="card" style="max-width:820px"><Csrf t={csrf} />
      <div class="row"><div class="field"><label for="pa">Customer</label><select id="pa" name="party_id"><option value="">— select —</option>{parties.map((p: any) => <option value={p.id}>{p.name}</option>)}</select><div class="hint"><a href="/app/parties">Add a customer first</a> if not listed.</div></div>
        <div class="field"><label for="mo">Mode</label><select id="mo" name="mode" required><option value="ocean">Ocean</option><option value="air">Air</option><option value="road">Road</option></select></div>
        <div class="field"><label for="tr">Trade</label><select id="tr" name="trade"><option value="import">Import</option><option value="export">Export</option><option value="cross_trade">Cross-trade</option></select></div></div>
      <div class="row"><div class="field"><label for="or">Origin</label><input id="or" name="origin" type="text" /></div><div class="field"><label for="de">Destination</label><input id="de" name="destination" type="text" /></div>
        <div class="field"><label for="ic">Incoterm</label><select id="ic" name="incoterm"><option value="">—</option>{["EXW", "FCA", "FOB", "CIF", "CFR", "DAP", "DDP"].map((x) => <option>{x}</option>)}</select></div></div>
      <div class="field"><label for="cd">Cargo description</label><input id="cd" name="cargo_desc" type="text" /></div>
      <div class="row"><div class="field"><label for="pc">Pieces</label><input id="pc" name="pieces" type="number" min="0" /></div><div class="field"><label for="wk">Weight (kg)</label><input id="wk" name="weight_kg" type="number" min="0" step="0.001" /></div>
        <div class="field"><label for="vc">Volume (cbm)</label><input id="vc" name="volume_cbm" type="number" min="0" step="0.001" /></div><div class="field"><label for="rd">Cargo ready date</label><input id="rd" name="ready_date" type="date" /></div></div>
      <div class="row"><div class="field"><label for="so">Source</label><select id="so" name="source"><option value="manual">Manual</option><option value="email">Email</option><option value="whatsapp">WhatsApp (manual capture)</option><option value="web_form">Web form</option><option value="phone">Phone</option></select></div>
        <div class="field"><label for="er">External reference</label><input id="er" name="external_ref" type="text" /><div class="hint">E.g. email message-id: used to avoid duplicates.</div></div></div>
      <button class="btn red" type="submit">Save enquiry</button>
    </form>
  </>));
});
sales.post("/app/enquiries", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/enquiries/new", async () => {
    const r: any = await withT(c, (cn, ctx) => createEnquiry(cn, ctx, b));
    return { to: `/app/enquiries/${r.id}`, ok: r.duplicate ? `Already recorded as ${r.no} — no duplicate created.` : `Enquiry ${r.no} saved.${r.missing?.length ? " Missing: " + r.missing.join(", ") + "." : ""}` };
  });
});
sales.get("/app/enquiries/:id", async (c) => {
  const e = await withT(c, async (cn) => (await cn.query<any>(`SELECT e.*, p.name AS party_name, (SELECT id FROM quotes q WHERE q.enquiry_id=e.id ORDER BY created_at DESC LIMIT 1) AS quote_id FROM enquiries e LEFT JOIN parties p ON p.id=e.party_id WHERE e.id=$1`, [c.req.param("id")])).rows[0]);
  if (!e) throw new HttpError(404, "Enquiry not found");
  const csrf = c.get("csrf");
  return appPage(c, e.no, (<>
    <PageHead title={`${e.no} · ${e.origin ?? "?"} → ${e.destination ?? "?"}`} sub={`${e.party_name ?? "No customer"} · ${e.mode} · ${e.trade.replace("_", "-")} · via ${e.source}`}>
      <Badge s={e.status} />
      {e.party_id && can(c, "quote.write") && !e.quote_id && !["lost", "won"].includes(e.status) ? <a class="btn red sm" href={`/app/quotes/new?enquiry=${e.id}`}>Prepare quote</a> : null}
      {e.quote_id ? <a class="btn sm" href={`/app/quotes/${e.quote_id}`}>Open quote</a> : null}
    </PageHead>
    {e.missing_info.length ? <div class="alert warn"><strong>Missing information:</strong> {e.missing_info.join(", ")}. Complete these before quoting.</div> : null}
    <div class="card"><dl style="display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:0">
      <dt class="mute">Cargo</dt><dd style="margin:0">{e.cargo_desc ?? "—"}</dd><dt class="mute">Pieces / weight / volume</dt><dd style="margin:0">{e.pieces ?? "—"} / {e.weight_kg ?? "—"} kg / {e.volume_cbm ?? "—"} cbm</dd>
      <dt class="mute">Ready date</dt><dd style="margin:0">{formatDay(e.ready_date)}</dd><dt class="mute">Incoterm</dt><dd style="margin:0">{e.incoterm ?? "—"}</dd></dl></div>
    {["new", "qualified", "quoted"].includes(e.status) && can(c, "enquiry.write") ? (
      <form method="post" action={`/app/enquiries/${e.id}/lose`} class="inline-form" style="margin-top:16px"><Csrf t={csrf} /><input name="reason" type="text" placeholder="Lost reason" required /><button class="btn danger sm" type="submit">Mark lost</button></form>) : null}
    {e.lost_reason ? <p class="mute">Lost: {e.lost_reason}</p> : null}
    {can(c,'quote.write')?<p><a href="/app/freight/weight">Calculate chargeable quantity with a reviewed provider rule</a></p>:null}
  </>));
});
sales.post("/app/enquiries/:id/lose", async (c) => {
  const b = await formBody(c);
  return act(c, `/app/enquiries/${c.req.param("id")}`, async () => { await withT(c, (cn, ctx) => loseEnquiry(cn, ctx, c.req.param("id"), str(b.reason))); return { to: "/app/enquiries", ok: "Marked lost." }; });
});

// ───────── rates
sales.get("/app/rates", async (c) => {
  const d = await withT(c, async (cn) => ({ rates: await listRates(cn), suppliers: await listParties(cn, "supplier") }));
  const csrf = c.get("csrf");
  return appPage(c, "Supplier rates", (<>
    <PageHead title="Supplier rates" sub="Validity, currency, basis and exclusions are tracked. Expired rates flag quotes for approval." />
    <Table head={["Supplier", "Lane", "Charge", "Basis", ["Cost", "num"], "Valid", ""]} empty={d.rates.length ? undefined : "No rates yet."}>
      {d.rates.map((r: any) => <tr><td>{r.supplier_name ?? "—"}</td><td>{r.origin} → {r.destination} ({r.mode})</td><td>{r.charge_name}{r.exclusions ? <div class="small mute">Excl: {r.exclusions}</div> : null}</td><td>{r.basis.replace("_", " ")}</td>
        <td class="num"><Money v={r.unit_cost_minor} cur={r.currency} /></td><td class="small">{formatDay(r.valid_from)} – {formatDay(r.valid_to)}</td><td>{r.expired ? <Badge s="expired" /> : <Badge s="ok" label="valid" />} <a class="small" href={`/app/rates/${r.id}`}>Breaks</a></td></tr>)}
    </Table>
    {can(c, "rate.write") ? (
      <section class="card" style="margin-top:22px;max-width:820px"><h3>Add a rate</h3>
        <form method="post" action="/app/rates"><Csrf t={csrf} />
          <div class="row"><div class="field"><label for="rs">Supplier</label><select id="rs" name="supplier_id"><option value="">—</option>{d.suppliers.map((s: any) => <option value={s.id}>{s.name}</option>)}</select></div>
            <div class="field"><label for="rm">Mode</label><select id="rm" name="mode"><option>ocean</option><option>air</option><option>road</option></select></div>
            <div class="field"><label for="rc">Charge</label><input id="rc" name="charge_name" type="text" required /></div></div>
          <div class="row"><div class="field"><label for="ro">Origin</label><input id="ro" name="origin" type="text" required /></div><div class="field"><label for="rd">Destination</label><input id="rd" name="destination" type="text" required /></div>
            <div class="field"><label for="rb">Basis</label><select id="rb" name="basis"><option value="per_shipment">per shipment</option><option value="per_kg">per kg</option><option value="per_cbm">per cbm</option><option value="per_container">per container</option></select></div></div>
          <div class="row"><div class="field"><label for="ru">Unit cost (AED)</label><input id="ru" name="unit_cost" type="number" min="0" step="0.01" required /></div><div class="field"><label for="rmn">Minimum (AED)</label><input id="rmn" name="minimum" type="number" min="0" step="0.01" /></div>
            <div class="field"><label for="rf">Valid from</label><input id="rf" name="valid_from" type="date" value={today()} required /></div><div class="field"><label for="rt">Valid to</label><input id="rt" name="valid_to" type="date" value={plus(30)} required /></div></div>
          <div class="field"><label for="rx">Exclusions</label><input id="rx" name="exclusions" type="text" /></div>
          <button class="btn red" type="submit">Save rate</button></form></section>) : null}
  </>));
});
sales.post("/app/rates", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/rates", async () => { await withT(c, (cn, ctx) => createRate(cn, ctx, b)); return { to: "/app/rates", ok: "Rate saved." }; });
});

// ───────── quotations
const LineRows = ({ lines, suppliers }: { lines: any[]; suppliers: any[] }) => (<>
  {lines.map((l) => (
    <div class="line-row card" style="margin-bottom:10px">
      <div class="row tight">
        <div class="field" style="grid-column:span 2"><label>Description</label><input name="ld" type="text" value={l.description ?? ""} /></div>
        <div class="field"><label>Qty</label><input name="lq" type="number" min="0" step="0.001" value={String(l.qty ?? 1)} /></div>
        <div class="field"><label>Unit sell (AED)</label><input name="lp" type="number" min="0" step="0.01" value={l.sell != null ? String(l.sell) : ""} /></div>
        <div class="field"><label>Unit cost (AED)</label><input name="lc" type="number" min="0" step="0.01" value={l.cost != null ? String(l.cost) : ""} /></div>
        <div class="field"><label>Supplier</label><select name="ls"><option value="">—</option>{suppliers.map((s) => <option value={s.id} selected={l.supplier_id === s.id}>{s.name}</option>)}</select></div>
        <div class="field"><label>Tax code</label><select name="lt">{Object.entries(TAX_CODES).map(([k, v]) => <option value={k} selected={(l.tax_code ?? "SR5") === k}>{k} · {v.label}</option>)}</select></div>
      </div>
      <button type="button" class="btn ghost sm" data-remove-row="1">Remove line</button>
    </div>
  ))}
  <template id="line-tpl">
    <div class="line-row card" style="margin-bottom:10px">
      <div class="row tight">
        <div class="field" style="grid-column:span 2"><label>Description</label><input name="ld" type="text" /></div>
        <div class="field"><label>Qty</label><input name="lq" type="number" min="0" step="0.001" value="1" /></div>
        <div class="field"><label>Unit sell (AED)</label><input name="lp" type="number" min="0" step="0.01" /></div>
        <div class="field"><label>Unit cost (AED)</label><input name="lc" type="number" min="0" step="0.01" /></div>
        <div class="field"><label>Supplier</label><select name="ls"><option value="">—</option>{suppliers.map((s) => <option value={s.id}>{s.name}</option>)}</select></div>
        <div class="field"><label>Tax code</label><select name="lt">{Object.entries(TAX_CODES).map(([k, v]) => <option value={k}>{k} · {v.label}</option>)}</select></div>
      </div>
      <button type="button" class="btn ghost sm" data-remove-row="1">Remove line</button>
    </div>
  </template>
  <button type="button" class="btn ghost sm" data-add-row="line-tpl">+ Add line</button>
</>);

function parseLines(b: Record<string, any>): LineInput[] {
  const d = arr(b.ld), q = arr(b.lq), p = arr(b.lp), cs = arr(b.lc), s = arr(b.ls), t = arr(b.lt);
  const out: LineInput[] = [];
  d.forEach((desc, i) => {
    if (!desc.trim() && !p[i]) return;
    out.push({ description: desc, qty: Number(q[i] || 1), unit_sell: p[i] || "0", unit_cost: cs[i] || "0", supplier_id: s[i] || null, tax_code: t[i] || "SR5" });
  });
  return out;
}

sales.get("/app/quotes", async (c) => {
  const rows = await withT(c, (cn) => listQuotes(cn));
  return appPage(c, "Quotations", (<>
    <PageHead title="Quotations" sub="Versioned. Approval is required below the margin threshold or above credit exposure."><a class="btn red" href="/app/quotes/new">New quote</a></PageHead>
    <Table head={["No.", "Customer", "Ver.", ["Sell", "num"], ["Margin", "num"], "Valid until", "Status"]} empty={rows.length ? undefined : "No quotes yet."}>
      {rows.map((q: any) => <tr><td><a href={`/app/quotes/${q.id}`}>{q.no}</a></td><td>{q.party_name}</td><td>v{q.current_version}</td><td class="num"><Money v={q.total_sell_minor} /></td>
        <td class="num">{Number(q.total_sell_minor) ? `${(((Number(q.total_sell_minor) - Number(q.total_cost_minor)) / Number(q.total_sell_minor)) * 100).toFixed(1)}%` : "—"}</td><td>{formatDay(q.valid_until)}</td><td><Badge s={q.status} /></td></tr>)}
    </Table>
  </>));
});

sales.get("/app/quotes/new", async (c) => {
  need(c, "quote.write");
  const d = await withT(c, async (cn) => {
    const enq = c.req.query("enquiry") ? (await cn.query<any>(`SELECT * FROM enquiries WHERE id=$1`, [c.req.query("enquiry")])).rows[0] : null;
    return { enq, customers: await listParties(cn, "customer"), suppliers: await listParties(cn, "supplier"), rates: await listRates(cn) };
  });
  const csrf = c.get("csrf");
  return appPage(c, "New quote", (<>
    <PageHead title="New quotation" sub={d.enq ? `For ${d.enq.no}: ${d.enq.origin} → ${d.enq.destination}` : undefined} />
    <form method="post" action="/app/quotes" style="max-width:1000px"><Csrf t={csrf} />
      <input type="hidden" name="enquiry_id" value={d.enq?.id ?? ""} />
      <div class="row"><div class="field"><label for="qc">Customer</label><select id="qc" name="party_id" required><option value="">— select —</option>{d.customers.map((p: any) => <option value={p.id} selected={d.enq?.party_id === p.id}>{p.name}</option>)}</select></div>
        <div class="field"><label for="qv">Valid until</label><input id="qv" name="valid_until" type="date" value={plus(14)} min={today()} required /></div></div>
      <h3>Charges</h3>
      <LineRows lines={[{ description: "", qty: 1 }]} suppliers={d.suppliers} />
      <div class="field" style="margin-top:14px"><label for="qx">Exclusions</label><input id="qx" name="exclusions" type="text" placeholder="e.g. Customs duty, demurrage, inspection charges" /></div>
      <div class="field"><label for="qt">Terms</label><textarea id="qt" name="terms"></textarea></div>
      {d.rates.length ? <p class="small mute">Reference rates on file: {d.rates.slice(0, 5).map((r: any) => `${r.charge_name} ${r.origin}→${r.destination} ${fmtMoney(r.unit_cost_minor)}${r.expired ? " (expired)" : ""}`).join(" · ")}</p> : null}
      <button class="btn red" type="submit">Save draft</button>
    </form>
  </>));
});
sales.post("/app/quotes", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/quotes/new", async () => {
    const q = await withT(c, (cn, ctx) => createQuote(cn, ctx, { enquiry_id: str(b.enquiry_id) || null, party_id: str(b.party_id), valid_until: str(b.valid_until), exclusions: str(b.exclusions), terms: str(b.terms), lines: parseLines(b) }));
    return { to: `/app/quotes/${q.id}`, ok: `Quote ${q.no} saved as draft.` };
  });
});

sales.get("/app/quotes/:id", async (c) => {
  const id = c.req.param("id");
  const d = await withT(c, (cn) => getQuote(cn, id));
  const csrf = c.get("csrf");
  const q = d.quote, st = q.status;
  const lines = d.lines;
  const sell = Number(d.current.total_sell_minor), cost = Number(d.current.total_cost_minor);
  const below = d.marginBps < d.thresholdBps;
  return appPage(c, q.no, (<>
    <PageHead title={`${q.no} · ${q.party_name}`} sub={`Version ${q.current_version} · valid until ${formatDay(d.current.valid_until)}${q.enquiry_no ? ` · from ${q.enquiry_no}` : ""}`}>
      <Badge s={st} />
      <a class="btn ghost sm" href={`/app/quotes/${id}/print`}>Print view</a>
      {st === "draft" && can(c, "quote.write") ? <PostBtn action={`/app/quotes/${id}/submit`} csrf={csrf} label="Submit" cls="red sm" /> : null}
      {st === "pending_approval" && can(c, "quote.approve") ? <PostBtn action={`/app/quotes/${id}/approve`} csrf={csrf} label="Approve" cls="red sm" /> : null}
      {st === "approved" && can(c, "quote.write") ? <PostBtn action={`/app/quotes/${id}/send`} csrf={csrf} label="Mark sent (locks version)" cls="red sm" /> : null}
      {st === "sent" && can(c, "quote.write") ? <><PostBtn action={`/app/quotes/${id}/accept`} csrf={csrf} label="Customer accepted → create job" cls="red sm" /><Confirm action={`/app/quotes/${id}/reject`} csrf={csrf} label="Rejected" confirm="Mark this quote rejected?" /></> : null}
      {["draft", "approved", "sent", "rejected", "expired", "pending_approval"].includes(st) && can(c, "quote.write") ? <a class="btn ghost sm" href={`/app/quotes/${id}/revise`}>Revise (new version)</a> : null}
    </PageHead>
    {q.approval_reason ? <div class="alert warn"><strong>Approval needed:</strong> {q.approval_reason}.</div> : null}
    {below && st === "draft" ? <div class="alert warn">Margin {(d.marginBps / 100).toFixed(1)}% is below the {(d.thresholdBps / 100).toFixed(1)}% threshold: submitting will require approval.</div> : null}
    <Table head={["Description", "Supplier", ["Qty", "num"], ["Unit sell", "num"], ["Unit cost", "num"], "Tax", ["Line sell", "num"]]}>
      {lines.map((l: any) => <tr><td>{l.description}{l.rate_valid_to && String(l.rate_valid_to).slice(0, 10) < today() ? <> <Badge s="expired" label="rate expired" /></> : null}</td><td>{l.supplier_name ?? "—"}</td><td class="num">{Number(l.qty)}</td>
        <td class="num"><Money v={l.unit_sell_minor} /></td><td class="num"><Money v={l.unit_cost_minor} /></td><td>{l.tax_code}</td><td class="num"><Money v={Math.round(Number(l.qty) * Number(l.unit_sell_minor))} /></td></tr>)}
      <tr><th colspan={6} class="right">Total sell (ex-VAT)</th><th class="num"><Money v={sell} /></th></tr>
      <tr><td colspan={6} class="right mute">Estimated cost</td><td class="num"><Money v={cost} /></td></tr>
      <tr><td colspan={6} class="right mute">Margin</td><td class="num"><strong>{(d.marginBps / 100).toFixed(1)}%</strong></td></tr>
    </Table>
    {d.current.exclusions ? <p><strong>Exclusions:</strong> {d.current.exclusions}</p> : null}
    {d.current.terms ? <p><strong>Terms:</strong> {d.current.terms}</p> : null}
    <h3 style="margin-top:22px">Version history</h3>
    <Table head={["Version", "Created", ["Sell", "num"], "State"]}>
      {d.versions.map((v: any) => <tr><td>v{v.version}</td><td class="small">{formatDay(v.created_at)}</td><td class="num"><Money v={v.total_sell_minor} /></td><td>{v.locked ? <Badge s="sent" label="locked" /> : <Badge s="draft" />}</td></tr>)}
    </Table>
  </>));
});
for (const [path, fn, okMsg] of [
  ["submit", submitQuote, "Submitted."], ["approve", approveQuote, "Approved."], ["send", sendQuote, "Marked sent; this version is now locked."], ["reject", rejectQuote, "Marked rejected."],
] as const) {
  sales.post(`/app/quotes/:id/${path}`, async (c) => {
    const id = c.req.param("id");
    return act(c, `/app/quotes/${id}`, async () => {
      const r: any = await withT(c, (cn, ctx) => (fn as any)(cn, ctx, id));
      const ok = path === "submit" ? (r.status === "approved" ? "Approved automatically (within policy)." : `Sent for approval: ${r.reasons.join("; ")}.`) : okMsg;
      return { to: `/app/quotes/${id}`, ok };
    });
  });
}
sales.post("/app/quotes/:id/accept", async (c) => {
  const id = c.req.param("id");
  return act(c, `/app/quotes/${id}`, async () => {
    const r = await withT(c, (cn, ctx) => acceptQuote(cn, ctx, id));
    return { to: `/app/jobs/${r.jobId}`, ok: r.created ? "Quote accepted and converted to one job. Customer details were not re-keyed." : "Already converted — opened the existing job." };
  });
});
sales.get("/app/quotes/:id/revise", async (c) => {
  need(c, "quote.write");
  const id = c.req.param("id");
  const d = await withT(c, async (cn) => ({ q: await getQuote(cn, id), suppliers: await listParties(cn, "supplier") }));
  const csrf = c.get("csrf");
  return appPage(c, "Revise quote", (<>
    <PageHead title={`Revise ${d.q.quote.no}`} sub={`Creates version ${d.q.quote.current_version + 1}. Version ${d.q.quote.current_version} stays as locked history.`} />
    <form method="post" action={`/app/quotes/${id}/revise`} style="max-width:1000px"><Csrf t={csrf} />
      <div class="field" style="max-width:260px"><label for="rv">Valid until</label><input id="rv" name="valid_until" type="date" value={plus(14)} min={today()} required /></div>
      <LineRows suppliers={d.suppliers} lines={d.q.lines.map((l: any) => ({ description: l.description, qty: Number(l.qty), sell: Number(l.unit_sell_minor) / 100, cost: Number(l.unit_cost_minor) / 100, supplier_id: l.supplier_id, tax_code: l.tax_code }))} />
      <div class="field" style="margin-top:14px"><label for="rx">Exclusions</label><input id="rx" name="exclusions" type="text" value={d.q.current.exclusions ?? ""} /></div>
      <div class="field"><label for="rt">Terms</label><textarea id="rt" name="terms">{d.q.current.terms ?? ""}</textarea></div>
      <button class="btn red" type="submit">Save new version</button></form>
  </>));
});
sales.post("/app/quotes/:id/revise", async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `/app/quotes/${id}/revise`, async () => {
    const v = await withT(c, (cn, ctx) => reviseQuote(cn, ctx, id, { valid_until: str(b.valid_until), exclusions: str(b.exclusions), terms: str(b.terms), lines: parseLines(b) }));
    return { to: `/app/quotes/${id}`, ok: `Version ${v} saved as draft.` };
  });
});
sales.get("/app/quotes/:id/print", async (c) => {
  const d = await withT(c, (cn) => getQuote(cn, c.req.param("id")));
  const ent = await withT(c, async (cn) => (await cn.query<any>(`SELECT * FROM entities ORDER BY created_at LIMIT 1`)).rows[0]);
  const sell = Number(d.current.total_sell_minor);
  return appPage(c, d.quote.no, (
    <div class="print-doc">
      <h1>Quotation {d.quote.no}</h1>
      <p><strong>{ent.legal_name ?? ent.name}</strong>{ent.tax_id ? ` · Tax no. ${ent.tax_id}` : ""}<br />To: {d.quote.party_name}<br />Version {d.quote.current_version} · Valid until {formatDay(d.current.valid_until)}</p>
      <Table head={["Description", ["Qty", "num"], ["Unit", "num"], ["Amount", "num"]]}>
        {d.lines.map((l: any) => <tr><td>{l.description}</td><td class="num">{Number(l.qty)}</td><td class="num"><Money v={l.unit_sell_minor} /></td><td class="num"><Money v={Math.round(Number(l.qty) * Number(l.unit_sell_minor))} /></td></tr>)}
        <tr><th colspan={3} class="right">Total (ex-VAT)</th><th class="num"><Money v={sell} /></th></tr>
      </Table>
      {d.current.exclusions ? <p><strong>Exclusions:</strong> {d.current.exclusions}</p> : null}
      {d.current.terms ? <p>{d.current.terms}</p> : null}
      <p class="small mute">Tax is applied per line on invoicing according to the transaction. {d.quote.status === "draft" || d.quote.status === "pending_approval" ? "DRAFT — not yet approved or sent." : ""}</p>
      <p class="no-print"><button class="btn" data-print="1" type="button">Print</button></p>
    </div>));
});
