import { Hono } from "hono";
import { formatDay } from "../lib/util.js";
import { listParties } from "../ops/crm.js";
import { today } from "../ops/common.js";
import { getInvoice } from "../ops/finance.js";
import {
  approveBill, attachBillDocument, baseCurrency, cancelCreditNote, decideRate, draftCreditNote, enterBill, getBill, getCreditNote, inputVatReport, issueCreditNote, listBills, listCreditNotes,
  listRates, payBill, payablesReport, proposeRate, realisedFx, subledgerReconciliation, voidBill,
} from "../ops/finance-bridge.js";
import { act, appPage, can, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

export const financeBridge = new Hono<Env>();
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;
const m = (v: unknown, cur = "AED") => `${cur} ${(Number(v) / 100).toFixed(2)}`;
const label = (s: string) => s.replace(/_/g, " ");

// ───────── credit notes
financeBridge.get("/app/finance/credit-notes", async (c) => {
  need(c, "read");
  const rows = await withT(c, (cn) => listCreditNotes(cn));
  return appPage(c, "Credit notes", <>
    <PageHead title="Credit notes" sub="Draft from an invoice. A second person issues it; issued credit notes are final and reduce what the customer owes." />
    <Table head={["Credit note", "Invoice", "Customer", "Reason", ["Total", "num"], "Status", "Accounting"]} empty={rows.length ? undefined : "No credit notes yet."}>
      {rows.map((n: any) => <tr><td><a href={`/app/finance/credit-notes/${n.id}`}>{n.no ?? "Draft"}</a></td><td><a href={`/app/invoices/${n.invoice_id}`}>{n.invoice_no}</a></td><td>{n.party_name}</td><td class="small">{n.reason}</td><td class="num">{m(n.total_minor, n.currency)}</td><td><Badge s={n.status} /></td><td class="small">{label(n.sync_status)}</td></tr>)}</Table>
  </>);
});
financeBridge.get("/app/finance/credit-notes/:id", async (c) => {
  need(c, "read");
  const id = c.req.param("id"), csrf = c.get("csrf");
  const d = await withT(c, (cn) => getCreditNote(cn, id));
  const n = d.note;
  return appPage(c, n.no ?? "Credit note draft", <>
    <PageHead title={n.no ? `Credit note ${n.no}` : "Credit note (draft)"} sub={`${n.party_name} · against invoice ${n.invoice_no}`}><Badge s={n.status} /><button class="btn ghost sm" data-print="1" type="button">Print</button></PageHead>
    <div class="print-doc">
      <h2>{n.legal_name ?? n.entity_name}</h2>
      <p class="small">{n.entity_tax_id ? `Tax registration no. ${n.entity_tax_id} · ` : ""}Credit note <strong>{n.no ?? "DRAFT"}</strong>{n.issued_at ? ` · Issued ${formatDay(n.issued_at)}` : ""}<br />Reason: {n.reason}</p>
      <Table head={["Description", ["Qty", "num"], ["Unit", "num"], "Tax", ["Net", "num"], ["Tax", "num"]]}>
        {d.lines.map((l: any) => <tr><td>{l.description}</td><td class="num">{Number(l.qty)}</td><td class="num">{m(l.unit_minor, n.currency)}</td><td>{l.tax_code}</td><td class="num">{m(l.net_minor, n.currency)}</td><td class="num">{m(l.tax_minor, n.currency)}</td></tr>)}
        <tr><th colspan={4} class="right">Total credited</th><th class="num" colspan={2}>{m(n.total_minor, n.currency)}</th></tr></Table>
      <p class="small mute">Operational credit note. It is not an accredited UAE e-invoice credit note.</p>
    </div>
    {n.status === "draft" ? <div class="no-print" style="display:flex;gap:10px;margin-top:14px">
      {can(c, "finance.void") ? <form method="post" action={`/app/finance/credit-notes/${id}/issue`}><Csrf t={csrf} /><button class="btn">Issue credit note</button></form> : null}
      {can(c, "finance.write") ? <form method="post" action={`/app/finance/credit-notes/${id}/cancel`}><Csrf t={csrf} /><button class="btn ghost">Cancel draft</button></form> : null}</div> : null}
  </>);
});
financeBridge.post("/app/finance/credit-notes", async (c) => {
  const b = await formBody(c), inv = str(b.invoice_id);
  return act(c, `/app/invoices/${inv}`, async () => {
    const id = await withT(c, (cn, ctx) => draftCreditNote(cn, ctx, inv, b.mode === "full"
      ? { reason: str(b.reason), full: true }
      : { reason: str(b.reason), lines: [{ invoice_line_id: str(b.invoice_line_id) || null, description: str(b.description), qty: str(b.qty), unit: str(b.unit) ? str(b.unit) : undefined, tax_code: str(b.tax_code) || undefined }] }));
    return { to: `/app/finance/credit-notes/${id}`, ok: "Draft saved. A second person must issue it." };
  });
});
financeBridge.post("/app/finance/credit-notes/:id/issue", async (c) => {
  const id = c.req.param("id");
  return act(c, `/app/finance/credit-notes/${id}`, async () => { const r = await withT(c, (cn, ctx) => issueCreditNote(cn, ctx, id)); return { to: `/app/finance/credit-notes/${id}`, ok: `Issued as ${r.no}.` }; });
});
financeBridge.post("/app/finance/credit-notes/:id/cancel", async (c) => {
  const id = c.req.param("id");
  return act(c, `/app/finance/credit-notes/${id}`, async () => { await withT(c, (cn, ctx) => cancelCreditNote(cn, ctx, id)); return { to: "/app/finance/credit-notes", ok: "Draft cancelled." }; });
});
financeBridge.get("/app/invoices/:id/credit", async (c) => {
  need(c, "finance.write");
  const id = c.req.param("id"), csrf = c.get("csrf");
  const d = await withT(c, (cn) => getInvoice(cn, id));
  return appPage(c, "Credit an invoice", <>
    <PageHead title={`Credit invoice ${d.inv.no}`} sub={`Outstanding ${m(d.inv.balance_minor, d.inv.currency)} of ${m(d.inv.total_minor, d.inv.currency)}`} />
    <form class="card" method="post" action="/app/finance/credit-notes"><Csrf t={csrf} /><input type="hidden" name="invoice_id" value={id} />
      <div class="field"><label for="mode">What to credit</label><select id="mode" name="mode"><option value="line">One invoice line (or part of it)</option><option value="full">Everything not yet credited</option></select></div>
      <div class="field"><label for="invoice_line_id">Invoice line</label><select id="invoice_line_id" name="invoice_line_id">{d.lines.map((l: any) => <option value={l.id}>{l.description} · {Number(l.qty)} × {m(l.unit_minor, d.inv.currency)}</option>)}</select></div>
      {field("qty", "Quantity to credit", { type: "number", step: "0.001", min: "0.001", value: "1" })}{field("unit", "Unit price to credit (blank = invoiced price)", { type: "number", step: "0.01", min: "0" })}{field("reason", "Reason for the credit", { required: true })}
      <button class="btn">Save draft</button></form>
  </>);
});

// ───────── exchange rates
financeBridge.get("/app/finance/fx", async (c) => {
  need(c, "read");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ rates: await listRates(cn), base: await baseCurrency(cn) }));
  return appPage(c, "Exchange rates", <>
    <PageHead title="Exchange rates" sub={`Rates into ${d.base}. A foreign-currency bill cannot be approved or paid without an approved rate on or before its date — rates are never assumed.`} />
    <Table head={["As of", "Currency", ["Rate", "num"], "Source", "Status", ""]} empty={d.rates.length ? undefined : "No rates yet."}>
      {d.rates.map((r: any) => <tr><td>{formatDay(r.as_of)}</td><td>{r.from_ccy} → {r.to_ccy}</td><td class="num">{r.rate_n}</td><td class="small">{r.source}<div class="mute">entered by {r.entered_name ?? "—"}</div></td><td><Badge s={r.status} /></td>
        <td>{r.status === "proposed" && can(c, "finance.void") ? <form method="post" action={`/app/finance/fx/${r.id}`} class="inline-form"><Csrf t={csrf} /><button class="btn sm" name="decision" value="approve">Approve</button> <button class="btn ghost sm" name="decision" value="reject">Reject</button></form> : null}</td></tr>)}</Table>
    {can(c, "finance.write") ? <form class="card" method="post" action="/app/finance/fx"><Csrf t={csrf} /><h2>Propose a rate</h2>
      {field("from_ccy", "Currency (e.g. USD)", { required: true, maxlength: "3" })}{field("rate", `Rate (1 unit = ? ${d.base})`, { type: "number", step: "0.00000001", min: "0.00000001", required: true })}{field("as_of", "Rate date", { type: "date", required: true, value: today() })}{field("source", "Source (bulletin, bank confirmation, contract)", { required: true })}<button class="btn">Propose</button></form> : null}
  </>);
});
financeBridge.post("/app/finance/fx", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/finance/fx", async () => { await withT(c, (cn, ctx) => proposeRate(cn, ctx, { from_ccy: str(b.from_ccy), rate: str(b.rate), as_of: str(b.as_of), source: str(b.source) })); return { to: "/app/finance/fx", ok: "Proposed. Someone else must approve it before it is used." }; });
});
financeBridge.post("/app/finance/fx/:id", async (c) => {
  const b = await formBody(c), id = c.req.param("id");
  return act(c, "/app/finance/fx", async () => { await withT(c, (cn, ctx) => decideRate(cn, ctx, id, str(b.decision) === "approve")); return { to: "/app/finance/fx", ok: "Decision recorded." }; });
});

// ───────── supplier bills
financeBridge.get("/app/finance/payables", async (c) => {
  need(c, "finance.write");
  const csrf = c.get("csrf"), status = c.req.query("status") || undefined;
  const d = await withT(c, async (cn) => ({ bills: await listBills(cn, status), suppliers: await listParties(cn, "supplier"), base: await baseCurrency(cn),
    costs: (await cn.query<any>(`SELECT k.id, k.description, k.estimated_minor, j.no AS job_no FROM job_costs k JOIN jobs j ON j.id=k.job_id WHERE k.status<>'posted' AND NOT EXISTS (SELECT 1 FROM vendor_bill_lines l JOIN vendor_bills b ON b.id=l.bill_id WHERE l.job_cost_id=k.id AND b.status<>'void') ORDER BY k.created_at DESC LIMIT 200`)).rows }));
  return appPage(c, "Supplier bills", <>
    <PageHead title="Supplier bills" sub="Enter a supplier's invoice, attach it as evidence, and have a second person approve it. Approval reconciles the linked job cost."><a class="btn ghost sm" href="/app/finance/payables/report">Ageing & unrealised FX</a></PageHead>
    <Table head={["Bill", "Supplier", "Their ref", "Due", ["Total", "num"], ["Paid", "num"], "Status"]} empty={d.bills.length ? undefined : "No bills yet."}>
      {d.bills.map((b: any) => <tr><td><a href={`/app/finance/payables/${b.id}`}>{b.no}</a></td><td>{b.supplier_name}</td><td>{b.supplier_ref}</td><td>{formatDay(b.due_date)}{b.overdue ? <> <Badge s="bad" label="overdue" /></> : null}</td><td class="num">{m(b.total_minor, b.currency)}</td><td class="num">{m(b.paid_minor, b.currency)}</td><td><Badge s={b.status} /></td></tr>)}</Table>
    <form class="card" method="post" action="/app/finance/payables"><Csrf t={csrf} /><h2>Enter a supplier bill</h2>
      <div class="field"><label for="supplier_id">Supplier</label><select id="supplier_id" name="supplier_id" required>{d.suppliers.map((s: any) => <option value={s.id}>{s.name}</option>)}</select></div>
      {field("supplier_ref", "Supplier's invoice number", { required: true })}{field("currency", "Currency", { value: d.base, maxlength: "3", required: true })}{field("bill_date", "Bill date", { type: "date", required: true, value: today() })}{field("due_date", "Due date", { type: "date", required: true })}
      {field("description", "Line description", { required: true })}{field("net", "Net amount", { type: "number", step: "0.01", min: "0.01", required: true })}
      <div class="field"><label for="tax_code">Tax code</label><select id="tax_code" name="tax_code"><option>SR5</option><option>ZR0</option><option>EX0</option><option>OOS</option></select></div>
      <div class="field"><label for="job_cost_id">Reconcile a job cost</label><select id="job_cost_id" name="job_cost_id"><option value="">None</option>{d.costs.map((k: any) => <option value={k.id}>{k.job_no} · {k.description} · est. {m(k.estimated_minor)}</option>)}</select></div>
      <button class="btn">Save draft</button></form>
  </>);
});
financeBridge.post("/app/finance/payables", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/finance/payables", async () => {
    const r = await withT(c, (cn, ctx) => enterBill(cn, ctx, { supplier_id: str(b.supplier_id), supplier_ref: str(b.supplier_ref), currency: str(b.currency), bill_date: str(b.bill_date), due_date: str(b.due_date),
      lines: [{ description: str(b.description), net: str(b.net), tax_code: str(b.tax_code), job_cost_id: str(b.job_cost_id) || null }] }));
    return { to: `/app/finance/payables/${r.id}`, ok: `${r.no} saved as a draft. Attach the supplier's invoice, then a second person approves it.` };
  });
});
financeBridge.get("/app/finance/payables/report", async (c) => {
  need(c, "finance.write");
  const today_ = today(), from = c.req.query("from") || `${today_.slice(0, 4)}-01-01`, to = c.req.query("to") || today_;
  const d = await withT(c, async (cn) => ({ rep: await payablesReport(cn), vat: await inputVatReport(cn, from, to), fx: await realisedFx(cn, from, to), rec: await subledgerReconciliation(cn) }));
  return appPage(c, "Payables report", <>
    <PageHead title="Payables, input VAT and FX" sub={`Base currency ${d.rep.base}. Unrealised figures use the latest approved rate; where none exists they are not shown.`} />
    <Table head={["Supplier", "Bill", "Due", "Bucket", ["Outstanding", "num"], ["Base at bill rate", "num"], ["Base at today's rate", "num"], ["Unrealised", "num"]]} empty={d.rep.bills.length ? undefined : "Nothing outstanding."}>
      {d.rep.bills.map((b: any) => <tr><td>{b.supplier}</td><td><a href={`/app/finance/payables/${b.id}`}>{b.no}</a></td><td>{formatDay(b.due_date)}</td><td>{b.bucket}</td><td class="num">{m(b.outstanding, b.currency)}</td><td class="num">{m(b.base_outstanding, d.rep.base)}</td><td class="num">{b.base_now == null ? "no rate" : m(b.base_now, d.rep.base)}</td><td class="num">{b.unrealised_gain_loss == null ? "—" : m(b.unrealised_gain_loss, d.rep.base)}</td></tr>)}</Table>
    <h2>Input VAT {from} – {to}</h2>
    <Table head={["Tax code", "Currency", ["Net", "num"], ["Tax", "num"], [`Tax in ${d.rep.base}`, "num"]]} empty="No approved bills in this period.">{d.vat.map((v: any) => <tr><td>{v.tax_code}</td><td>{v.currency}</td><td class="num">{m(v.net, v.currency)}</td><td class="num">{m(v.tax, v.currency)}</td><td class="num">{m(v.base_tax, d.rep.base)}</td></tr>)}</Table>
    <h2>Realised exchange differences</h2>
    <Table head={["Currency", "Payments", [`Gain / (loss) in ${d.rep.base}`, "num"]]} empty="No foreign-currency payments in this period.">{d.fx.map((x: any) => <tr><td>{x.currency}</td><td>{x.payments}</td><td class="num">{m(x.gain_loss, d.rep.base)}</td></tr>)}</Table>
    <h2>Sub-ledger reconciliation</h2>
    <p class="small mute">{d.rec.note}</p>
    {d.rec.differences.length ? <div class="alert warn">{d.rec.differences.map((x: string) => <p>{x}</p>)}</div> : <p class="good">Stored balances agree with the underlying receipts, credit notes, bills and payments.</p>}
    <Table head={["Receivables", ["Invoiced", "num"], ["Receipts", "num"], ["Credits", "num"], ["Balance", "num"]]} empty="No invoices.">{d.rec.ar.map((a: any) => <tr><td>{a.currency}</td><td class="num">{m(a.invoiced, a.currency)}</td><td class="num">{m(a.receipts, a.currency)}</td><td class="num">{m(a.credits, a.currency)}</td><td class="num">{m(a.stored_balance, a.currency)}</td></tr>)}</Table>
    <Table head={["Payables", ["Billed", "num"], ["Payments", "num"], ["Balance", "num"]]} empty="No approved bills.">{d.rec.ap.map((a: any) => <tr><td>{a.currency}</td><td class="num">{m(a.billed, a.currency)}</td><td class="num">{m(a.payments, a.currency)}</td><td class="num">{m(a.stored_balance, a.currency)}</td></tr>)}</Table>
  </>);
});
financeBridge.get("/app/finance/payables/:id", async (c) => {
  need(c, "finance.write");
  const id = c.req.param("id"), csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ ...(await getBill(cn, id)), docs: (await cn.query<any>(`SELECT id,title FROM documents WHERE status='issued' AND NOT hold ORDER BY created_at DESC LIMIT 200`)).rows }));
  const b = d.bill, owed = Number(b.total_minor) - Number(b.paid_minor);
  return appPage(c, b.no, <>
    <PageHead title={`${b.no} · ${b.supplier_name}`} sub={`Their invoice ${b.supplier_ref} · ${formatDay(b.bill_date)} · due ${formatDay(b.due_date)}`}><Badge s={b.status} /></PageHead>
    <Table head={["Description", "Job", "Tax", ["Net", "num"], ["Tax", "num"]]}>{d.lines.map((l: any) => <tr><td>{l.description}</td><td>{l.job_no ?? "—"}</td><td>{l.tax_code}</td><td class="num">{m(l.net_minor, b.currency)}</td><td class="num">{m(l.tax_minor, b.currency)}</td></tr>)}
      <tr><th colspan={3} class="right">Total</th><th class="num" colspan={2}>{m(b.total_minor, b.currency)}</th></tr></Table>
    {b.fx_rate && b.currency !== b.base_currency && b.base_total_minor != null ? <p class="small">Rate {Number(b.fx_rate)} → {m(b.base_total_minor, b.base_currency)} in base currency.</p> : null}
    {b.variance_note ? <p class="small">Variance note: {b.variance_note}</p> : null}
    <h2>Payments</h2>
    <Table head={["Paid on", "Method", "Reference", ["Amount", "num"], ["Rate", "num"], ["Gain / (loss)", "num"]]} empty="No payments.">{d.payments.map((p: any) => <tr><td>{formatDay(p.paid_on)}</td><td>{p.method}</td><td>{p.reference ?? "—"}</td><td class="num">{m(p.amount_minor, b.currency)}</td><td class="num">{Number(p.fx_rate_paid)}</td><td class="num">{m(p.fx_gain_loss_minor, b.base_currency)}</td></tr>)}</Table>
    {b.status === "draft" ? <>
      <form class="card" method="post" action={`/app/finance/payables/${id}/document`}><Csrf t={csrf} /><div class="field"><label for="document_id">Supplier's invoice (issued document)</label><select id="document_id" name="document_id">{d.docs.map((x: any) => <option value={x.id} selected={x.id === b.document_id}>{x.title}</option>)}</select></div><button class="btn sm">Attach evidence</button></form>
      {can(c, "finance.void") ? <form class="card" method="post" action={`/app/finance/payables/${id}/approve`}><Csrf t={csrf} />{field("variance_note", "Variance note (needed if a linked cost differs from its estimate by more than 5%)")}<button class="btn">Approve</button></form> : null}</> : null}
    {["approved", "part_paid"].includes(b.status) ? <form class="card" method="post" action={`/app/finance/payables/${id}/pay`}><Csrf t={csrf} /><h2>Record a payment</h2>
      {field("amount", `Amount (${b.currency}, up to ${(owed / 100).toFixed(2)})`, { type: "number", step: "0.01", min: "0.01", max: (owed / 100).toFixed(2), required: true })}{field("paid_on", "Paid on", { type: "date", value: today(), required: true })}{field("method", "Method", { value: "bank transfer" })}{field("reference", "Bank reference")}<button class="btn">Record payment</button></form> : null}
    {b.status !== "void" && Number(b.paid_minor) === 0 && can(c, "finance.void") ? <form method="post" action={`/app/finance/payables/${id}/void`} class="inline-form" style="margin-top:12px" data-confirm="Void this bill? Any reconciled job cost goes back to its estimate."><Csrf t={csrf} />{field("reason", "Reason", { required: true })}<button class="btn danger sm">Void</button></form> : null}
  </>);
});
const bp = (path: string, run: (cn: any, ctx: any, id: string, b: Record<string, any>) => Promise<unknown>, ok: string) =>
  financeBridge.post(`/app/finance/payables/:id/${path}`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, `/app/finance/payables/${id}`, async () => { await withT(c, (cn, ctx) => run(cn, ctx, id, b)); return { to: `/app/finance/payables/${id}`, ok }; }); });
bp("document", (cn, ctx, id, b) => attachBillDocument(cn, ctx, id, str(b.document_id)), "Evidence attached.");
bp("approve", (cn, ctx, id, b) => approveBill(cn, ctx, id, { variance_note: str(b.variance_note) }), "Bill approved.");
bp("pay", (cn, ctx, id, b) => payBill(cn, ctx, id, { amount: str(b.amount), paid_on: str(b.paid_on), method: str(b.method), reference: str(b.reference) }), "Payment recorded.");
bp("void", (cn, ctx, id, b) => voidBill(cn, ctx, id, str(b.reason)), "Bill voided.");
