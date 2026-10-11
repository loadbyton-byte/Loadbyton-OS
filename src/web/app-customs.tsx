import { Hono } from "hono";
import { HttpError, TAX_CODES, formatDate, formatDay, fmtMoney } from "../lib/util.js";
import {
  CHANNELS, DIRECTIONS, MODES, STATUS_LABEL, addCharge, addChecklistItem, addInspection, addLine, answerQuery, approveCase, attachEvidence, billDisbursements, cancelCase, closeCase, closeInspection,
  createCase, customsOverview, getCase, handoverPack, invoiceCase, linesCsv, listCases, listDeposits, markSeen, raiseQuery, receiveDeposit, recordAssessment, recordPayment, recordRejection,
  recordSubmission, refundDeposit, releaseCase, removeLine, reopenAfterRejection, reopenCase, resetItem, returnForChanges, submitForReview, updateCase, updateLine, waiveItem,
} from "../ops/customs.js";
import { listParties } from "../ops/crm.js";
import { formBody, str, type Env } from "./mw.js";
import { act, appPage, can, Confirm, need, PageHead, PostBtn, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table } from "./ui.js";

export const customs = new Hono<Env>();
const K = "/app/customs";
const dt = (v: any) => (v ? formatDate(v) : "—");
const aed = (minor: number | string) => fmtMoney(Number(minor));
const EVIDENCE_KINDS = ["commercial_invoice", "packing_list", "transport_document", "delivery_order", "certificate_of_origin", "import_permit", "insurance_certificate", "customs_declaration", "customs_assessment", "customs_receipt", "inspection_report", "other"];
const BSTAT: Record<string, string> = { collecting: "info", in_review: "warn", approved: "ok", submitted: "info", assessed: "info", inspection: "warn", released: "ok", rejected: "bad", closed: "ok", cancelled: "bad" };
const CSt = ({ s }: { s: string }) => <Badge s={BSTAT[s] ?? s} label={STATUS_LABEL[s] ?? s} />;
const ageDays = (v: any) => Math.floor((Date.parse(v) - Date.now()) / 86400000);

const Disclaimer = () => (
  <p class="small mute" style="margin:.4em 0 1em">Working record and handover only. The declaration is lodged by a licensed broker in the official channel (Dubai Trade / Mirsal 2), which this software does not access. HS codes, duty and VAT rates are entered by you; figures are estimates and the official assessment prevails.</p>
);

// ───────── board
customs.get(K, async (c) => {
  need(c, "read");
  const d = await withT(c, (cn) => customsOverview(cn));
  const n = (k: string) => d.byStatus[k] ?? 0;
  return appPage(c, "Customs board", (<>
    <PageHead title="Customs board" sub="Cases from documents to release — what needs a second pair of eyes, what is waiting on customs, and whose money is held.">
      {can(c, "cus.write") ? <a class="btn red sm" href={`${K}/cases/new`}>New case</a> : null}
    </PageHead>
    <Disclaimer />
    <div class="grid g4">
      <div class="card"><h3>Collecting documents</h3><div class="kpi">{n("collecting")}</div></div>
      <div class="card"><h3>Awaiting approval</h3><div class={`kpi ${n("in_review") ? "bad" : ""}`}>{n("in_review")}</div></div>
      <div class="card"><h3>Ready to hand over</h3><div class="kpi">{n("approved")}</div></div>
      <div class="card"><h3>With customs</h3><div class="kpi">{n("submitted") + n("assessed") + n("inspection")}</div><p class="small mute">{d.openInspections} inspection(s) open</p></div>
    </div>
    <div class="grid g4" style="margin-top:16px">
      <div class="card"><h3>Duty to pay</h3><div class="kpi"><Money v={d.awaitingPayment.reduce((a: number, x: any) => a + x.due_minor - x.paid_minor, 0)} /></div><p class="small mute">{d.awaitingPayment.length} case(s) assessed</p></div>
      <div class="card"><h3>Client money held</h3><div class="kpi"><Money v={d.clientMoney} /></div><p class="small mute">cash deposits not yet used or returned — not our income</p></div>
      <div class="card"><h3>Rejected</h3><div class={`kpi ${d.rejected ? "bad" : "good"}`}>{d.rejected}</div></div>
      <div class="card"><h3>Released, not invoiced</h3><div class={`kpi ${d.unbilled ? "bad" : "good"}`}>{d.unbilled}</div>{d.guaranteesExpiring ? <p class="small"><Badge s="warn" label={`${d.guaranteesExpiring} guarantee(s) expiring in 30 days`} /></p> : null}</div>
    </div>
    <div class="grid g2" style="margin-top:20px;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr))">
      <section><Table caption="Waiting for approval" head={["Case", "Customer"]} empty={d.toApprove.length ? undefined : "Nothing waiting."}>
        {d.toApprove.map((x: any) => <tr><td><a href={`${K}/cases/${x.id}`}>{x.no}</a></td><td>{x.party}</td></tr>)}</Table></section>
      <section><Table caption="Approved — hand over to the official channel" head={["Case", "Customer"]} empty={d.toHandOver.length ? undefined : "Nothing waiting."}>
        {d.toHandOver.map((x: any) => <tr><td><a href={`${K}/cases/${x.id}`}>{x.no}</a></td><td>{x.party}</td></tr>)}</Table></section>
      <section><Table caption="Customs queries open" head={["Case", "Query", "Due"]} empty={d.openQueries.length ? undefined : "No open queries."}>
        {d.openQueries.map((x: any) => <tr><td><a href={`${K}/cases/${x.case_id}`}>{x.no}</a></td><td class="small">{x.text}</td><td>{x.due_on ? formatDay(x.due_on) : "—"} {x.late ? <Badge s="bad" label="late" /> : null}</td></tr>)}</Table></section>
      <section><Table caption="Assessed — duty to pay" head={["Case", "Customer", ["Due", "num"], ["Paid", "num"]]} empty={d.awaitingPayment.length ? undefined : "Nothing to pay."}>
        {d.awaitingPayment.map((x: any) => <tr><td><a href={`${K}/cases/${x.id}`}>{x.no}</a></td><td>{x.party}</td><td class="num"><Money v={x.due_minor} /></td><td class="num"><Money v={x.paid_minor} /></td></tr>)}</Table></section>
    </div>
  </>));
});

// ───────── cases
customs.get(`${K}/cases`, async (c) => {
  need(c, "read");
  const status = c.req.query("status") ?? "", q = c.req.query("q") ?? "";
  const rows = await withT(c, (cn) => listCases(cn, { status: status || undefined, q }));
  return appPage(c, "Cases", (<>
    <PageHead title="Customs cases" sub="Latest 300 matching.">{can(c, "cus.write") ? <a class="btn red sm" href={`${K}/cases/new`}>New case</a> : null}</PageHead>
    <form method="get" action={`${K}/cases`} class="inline-form" style="margin-bottom:14px">
      <input name="q" type="search" value={q} placeholder="Case, declaration, B/L or customer" />
      <select name="status" aria-label="Status"><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option value={k} selected={k === status}>{v}</option>)}</select>
      <button class="btn ghost sm" type="submit">Filter</button></form>
    <Table head={["Case", "Customer", "Type", "B/L · AWB", "Declaration", ["Est. duty+VAT", "num"], "Evidence", "Status"]} empty={rows.length ? undefined : "No cases."}>
      {rows.map((k: any) => <tr><td><a href={`${K}/cases/${k.id}`}>{k.no}</a></td><td>{k.party_name}</td><td>{DIRECTIONS[k.direction]} · {MODES[k.mode]}</td><td class="small">{k.transport_ref ?? "—"}</td><td class="small">{k.declaration_no ?? "—"}</td>
        <td class="num">{k.line_count ? <Money v={k.estimate_minor} /> : "—"}</td><td>{["collecting", "in_review"].includes(k.status) ? (k.missing ? <Badge s="warn" label={`${k.missing} missing`} /> : <Badge s="ok" label="complete" />) : "—"}</td><td><CSt s={k.status} /></td></tr>)}
    </Table>
  </>));
});

const CaseForm = (p: { action: string; csrf: string; k?: any; merchants?: any[]; submit: string }) => {
  const k = p.k ?? {};
  return (
    <form method="post" action={p.action} class="card" style="max-width:860px"><Csrf t={p.csrf} />
      {p.merchants ? <div class="field"><label for="cp">Importer / exporter (customer)</label><select id="cp" name="party_id" required><option value="">— select —</option>{p.merchants.map((m: any) => <option value={m.id}>{m.name}</option>)}</select></div> : null}
      <div class="row"><div class="field"><label for="cd">Type</label><select id="cd" name="direction">{Object.entries(DIRECTIONS).map(([v, l]) => <option value={v} selected={v === (k.direction ?? "import")}>{l}</option>)}</select></div>
        <div class="field"><label for="cm">Mode</label><select id="cm" name="mode">{Object.entries(MODES).map(([v, l]) => <option value={v} selected={v === (k.mode ?? "sea")}>{l}</option>)}</select></div>
        <div class="field"><label for="co">Customs office / port</label><input id="co" name="customs_office" type="text" value={k.customs_office ?? ""} /></div></div>
      <div class="row"><div class="field"><label for="tr">B/L · AWB · CMR number</label><input id="tr" name="transport_ref" type="text" value={k.transport_ref ?? ""} /></div>
        <div class="field"><label for="cn">Container numbers</label><input id="cn" name="container_nos" type="text" value={k.container_nos ?? ""} /></div>
        <div class="field"><label for="vf">Vessel / flight</label><input id="vf" name="vessel_flight" type="text" value={k.vessel_flight ?? ""} /></div></div>
      <div class="row"><div class="field"><label for="oc">Origin country (2 letters)</label><input id="oc" name="origin_country" type="text" maxlength={2} value={k.origin_country ?? ""} /></div>
        <div class="field"><label for="dc">Destination country</label><input id="dc" name="destination_country" type="text" maxlength={2} value={k.destination_country ?? "AE"} /></div>
        <div class="field"><label for="it">Incoterm</label><input id="it" name="incoterm" type="text" maxlength={10} value={k.incoterm ?? ""} /></div>
        <div class="field"><label for="et">ETA</label><input id="et" name="eta" type="date" value={k.eta ? String(k.eta).slice(0, 10) : ""} /></div></div>
      <div class="row"><div class="field"><label for="cu">Invoice currency</label><input id="cu" name="currency" type="text" maxlength={3} value={k.currency ?? "AED"} /></div>
        <div class="field"><label for="fx">Rate to AED (as you apply it)</label><input id="fx" name="fx_rate" type="number" step="0.000001" min="0" value={k.fx_rate ? String(Number(k.fx_rate)) : "1"} /></div>
        <div class="field"><label for="fr">Freight ({k.currency ?? "invoice currency"})</label><input id="fr" name="freight" type="number" step="0.01" min="0" value={k.freight_minor ? (Number(k.freight_minor) / 100).toFixed(2) : ""} /></div>
        <div class="field"><label for="in">Insurance</label><input id="in" name="insurance" type="number" step="0.01" min="0" value={k.insurance_minor ? (Number(k.insurance_minor) / 100).toFixed(2) : ""} /></div>
        <div class="field"><label for="ot">Other charges</label><input id="ot" name="other" type="number" step="0.01" min="0" value={k.other_minor ? (Number(k.other_minor) / 100).toFixed(2) : ""} /></div></div>
      <button class="btn red" type="submit">{p.submit}</button>
    </form>
  );
};
customs.get(`${K}/cases/new`, async (c) => {
  need(c, "cus.write");
  const merchants = await withT(c, (cn) => listParties(cn, "customer"));
  return appPage(c, "New customs case", (<><PageHead title="New customs case" sub="Freight, insurance and other charges are shared over the goods lines by value to estimate the customs value." /><Disclaimer /><CaseForm action={`${K}/cases`} csrf={c.get("csrf")} merchants={merchants} submit="Create case" /></>));
});
customs.post(`${K}/cases`, async (c) => {
  need(c, "cus.write");
  const b = await formBody(c);
  return act(c, `${K}/cases/new`, async () => {
    const r = await withT(c, (cn, ctx) => createCase(cn, ctx, b as any));
    return { to: `${K}/cases/${r.id}`, ok: `Case ${r.no} created with a suggested evidence checklist.` };
  });
});

// ───────── the case workspace
const LineForm = (p: { action: string; csrf: string; l?: any; cur: string; label: string }) => {
  const l = p.l ?? {};
  return (
    <form method="post" action={p.action} class="card" style="margin-top:10px"><Csrf t={p.csrf} />
      <div class="row"><div class="field" style="flex:2"><label>Description</label><input name="description" type="text" required value={l.description ?? ""} /></div>
        <div class="field"><label>HS code (broker's classification)</label><input name="hs_code" type="text" required inputmode="numeric" value={l.hs_code ?? ""} placeholder="8471.30.10" /></div>
        <div class="field"><label>Origin</label><input name="origin_country" type="text" maxlength={2} value={l.origin_country ?? ""} /></div></div>
      <div class="row"><div class="field"><label>Qty</label><input name="qty" type="number" step="0.001" min="0.001" value={l.qty ? String(Number(l.qty)) : "1"} /></div>
        <div class="field"><label>Unit</label><input name="uom" type="text" value={l.uom ?? "unit"} /></div>
        <div class="field"><label>Net kg</label><input name="net_kg" type="number" step="0.001" min="0" value={l.net_kg ? String(Number(l.net_kg)) : ""} /></div>
        <div class="field"><label>Gross kg</label><input name="gross_kg" type="number" step="0.001" min="0" value={l.gross_kg ? String(Number(l.gross_kg)) : ""} /></div>
        <div class="field"><label>Value ({p.cur})</label><input name="value" type="number" step="0.01" min="0.01" required value={l.value_minor ? (Number(l.value_minor) / 100).toFixed(2) : ""} /></div>
        <div class="field"><label>Duty rate % (yours)</label><input name="duty_pct" type="number" step="0.01" min="0" max="100" value={l.duty_rate_bps !== undefined ? String(Number(l.duty_rate_bps) / 100) : "0"} /></div>
        <div class="field"><label>VAT rate %</label><input name="vat_pct" type="number" step="0.01" min="0" max="25" value={l.vat_rate_bps !== undefined ? String(Number(l.vat_rate_bps) / 100) : "5"} /></div></div>
      <div class="row"><label class="check"><input type="checkbox" name="restricted" value="1" checked={!!l.restricted} /><span>Restricted / needs a permit or specialist handling</span></label>
        <div class="field" style="flex:2"><input name="restriction_note" type="text" placeholder="Which permit / NOC / handling?" value={l.restriction_note ?? ""} /></div></div>
      <button class="btn sm" type="submit">{p.label}</button></form>
  );
};

customs.get(`${K}/cases/:id`, async (c) => {
  need(c, "read");
  const id = c.req.param("id");
  const d = await withT(c, (cn) => getCase(cn, id));
  const k = d.case, csrf = c.get("csrf"), st = k.status, edit = ["collecting", "in_review"].includes(st);
  const w = can(c, "cus.write"), sub = can(c, "cus.submit"), appr = can(c, "cus.approve"), cash = can(c, "cus.cash");
  const dueTotal = k.assessed_at ? Number(k.assessed_duty_minor) + Number(k.assessed_vat_minor) : 0;
  const a = (path: string) => `${K}/cases/${id}/${path}`;
  return appPage(c, k.no, (<>
    <PageHead title={`${k.no} · ${k.party_name}`} sub={`${DIRECTIONS[k.direction]} · ${MODES[k.mode]}${k.transport_ref ? ` · ${k.transport_ref}` : ""}${k.job_no ? ` · job ${k.job_no}` : ""}`}>
      <a class="btn ghost sm" href={`${K}/cases`}>← Cases</a>
      {["approved", "submitted", "assessed", "inspection", "released", "closed"].includes(st) ? <><a class="btn sm" href={a("pack")} target="_blank">Handover pack</a><a class="btn ghost sm" href={a("lines.csv")}>Lines CSV</a></> : null}
    </PageHead>
    <p><CSt s={st} /> {k.declaration_no ? <span class="small mute"> · {CHANNELS[k.channel]} declaration <strong>{k.declaration_no}</strong></span> : null}</p>
    <Disclaimer />
    {st === "rejected" ? <div class="alert err"><strong>Rejected:</strong> {k.rejection_reason}</div> : null}
    {d.variance?.flagged ? <div class="alert warn"><strong>The assessment differs materially from the estimate:</strong> {aed(d.variance.estimated)} estimated vs {aed(d.variance.assessed)} assessed ({d.variance.diff > 0 ? "+" : ""}{(d.variance.diff / 100).toFixed(2)} AED, {d.variance.pct}%). Check the HS codes, values and rates before paying.</div> : null}

    <div class="grid g4">
      <div class="card"><h3>Goods value</h3><div class="kpi">{(d.totals.value / 100).toFixed(2)} <span class="small">{k.currency}</span></div><p class="small mute">{d.lines.length} line(s) · {Number(d.totals.weightGross)} kg gross</p></div>
      <div class="card"><h3>Customs value (CIF, AED)</h3><div class="kpi"><Money v={d.totals.cifAed} /></div><p class="small mute">rate {Number(k.fx_rate)} · charges shared by value</p></div>
      <div class="card"><h3>Estimated duty + VAT</h3><div class="kpi"><Money v={d.totals.duty + d.totals.vat} /></div><p class="small mute">duty {aed(d.totals.duty)} · VAT {aed(d.totals.vat)} · your rates</p></div>
      <div class="card"><h3>{k.assessed_at ? "Assessed by customs" : "Assessment"}</h3><div class="kpi">{k.assessed_at ? <Money v={dueTotal} /> : "—"}</div><p class="small mute">{k.assessed_at ? `paid ${aed(d.paidDutyVat)}` : "not yet assessed"}</p></div>
    </div>

    {/* ── next step */}
    <section class="card" style="margin-top:16px"><h3>Next step</h3>
      {st === "collecting" ? (<>
        {d.issues.length ? <><p>Before this can go for approval:</p><ul>{d.issues.map((i: string) => <li>{i}</li>)}</ul></> : <p class="good">Everything is in place.</p>}
        {w ? <div class="inline-form">
          <PostBtn action={a("review")} csrf={csrf} label="Send for approval" cls="red sm" />
          <Confirm action={a("cancel")} csrf={csrf} label="Cancel case" confirm="Cancel this case?" cls="ghost sm" fields={{ reason: "Cancelled by user" }} /></div> : null}
      </>) : null}
      {st === "in_review" ? (<>
        <p>Prepared by <strong>{k.prepared_name ?? "—"}</strong>. A second person approves it before it is handed over.</p>
        {appr ? <div class="inline-form"><PostBtn action={a("approve")} csrf={csrf} label="Approve" cls="red sm" />
          <form method="post" action={a("return")} class="inline-form"><Csrf t={csrf} /><input name="reason" type="text" placeholder="What needs to change?" required /><button class="btn ghost sm" type="submit">Send back</button></form></div> : <p class="small mute">You do not have approval rights.</p>}
      </>) : null}
      {st === "approved" ? (<>
        <p>Approved by <strong>{k.approved_name}</strong> on {dt(k.approved_at)}. Open the handover pack, lodge the declaration in the official channel, then record its number here.</p>
        {sub ? <form method="post" action={a("submit")} class="inline-form"><Csrf t={csrf} />
          <select name="channel" aria-label="Channel">{Object.entries(CHANNELS).map(([v, l]) => <option value={v}>{l}</option>)}</select>
          <input name="declaration_no" type="text" placeholder="Declaration number" required /><button class="btn red sm" type="submit">Record submission</button></form> : null}
        {appr ? <form method="post" action={a("reopen")} class="inline-form" style="margin-top:8px"><Csrf t={csrf} /><input name="reason" type="text" placeholder="Reason to reopen" required /><button class="btn ghost sm" type="submit">Reopen (withdraw approval)</button></form> : null}
      </>) : null}
      {["submitted", "assessed", "inspection"].includes(st) && sub ? (<div class="inline-form">
        <form method="post" action={a("assess")} class="inline-form"><Csrf t={csrf} /><input name="duty" type="number" step="0.01" min="0" placeholder="Assessed duty (AED)" required /><input name="vat" type="number" step="0.01" min="0" placeholder="Assessed VAT (AED)" required /><button class="btn sm" type="submit">{k.assessed_at ? "Correct assessment" : "Record assessment"}</button></form>
        <form method="post" action={a("inspection")} class="inline-form"><Csrf t={csrf} /><select name="kind" aria-label="Inspection type"><option value="document">Document</option><option value="physical">Physical</option><option value="scanner">Scanner</option><option value="lab">Lab</option></select><input name="location" type="text" placeholder="Where" /><button class="btn ghost sm" type="submit">Inspection requested</button></form>
        <form method="post" action={a("query")} class="inline-form"><Csrf t={csrf} /><input name="text" type="text" placeholder="Query raised by customs" required style="min-width:240px" /><input name="due_on" type="date" aria-label="Due" /><button class="btn ghost sm" type="submit">Record query</button></form>
        <form method="post" action={a("reject")} class="inline-form" data-confirm="Record that customs rejected this declaration?"><Csrf t={csrf} /><input name="reason" type="text" placeholder="Rejection reason given" required /><button class="btn danger sm" type="submit">Rejected</button></form></div>) : null}
      {["assessed", "inspection"].includes(st) && sub ? (
        <form method="post" action={a("release")} class="inline-form" style="margin-top:8px"><Csrf t={csrf} /><input name="release_ref" type="text" placeholder="Release / gate-pass reference" required /><button class="btn red sm" type="submit">Record release</button><span class="small mute"> needs duty paid, inspections closed, queries answered</span></form>) : null}
      {st === "released" && sub ? <PostBtn action={a("close")} csrf={csrf} label="Close case" cls="sm" /> : null}
      {st === "rejected" ? (w ? <><p class="small">A new declaration is needed. Preparing it again returns the case to document collection and clears the declaration number (kept in the history).</p><PostBtn action={a("again")} csrf={csrf} label="Prepare again" cls="red sm" /></> : null) : null}
      {["closed", "cancelled"].includes(st) ? <p class="mute">No further steps.</p> : null}
    </section>

    {/* ── header (editable while preparing) */}
    {edit && w ? <details style="margin-top:16px"><summary><strong>Edit case details</strong></summary><CaseForm action={a("update")} csrf={csrf} k={k} submit="Save details" /></details> : (
      <section class="card" style="margin-top:16px"><h3>Details</h3><p class="small">Office {k.customs_office ?? "—"} · origin {k.origin_country ?? "—"} → {k.destination_country ?? "—"} · {k.incoterm ?? "—"} · {k.vessel_flight ?? "—"} · containers {k.container_nos ?? "—"} · ETA {k.eta ? formatDay(k.eta) : "—"} · freight {(Number(k.freight_minor) / 100).toFixed(2)} + insurance {(Number(k.insurance_minor) / 100).toFixed(2)} + other {(Number(k.other_minor) / 100).toFixed(2)} {k.currency}</p></section>)}

    {/* ── lines */}
    <div style="margin-top:20px"><Table caption="Goods lines (duty and VAT are estimates from your rates)" head={["#", "Description", "HS code", "Origin", ["Qty", "num"], ["Value", "num"], ["CIF AED", "num"], ["Duty", "num"], ["VAT", "num"], ""]} empty={d.lines.length ? undefined : "No lines yet."}>
      {d.lines.map((l: any) => <tr><td>{l.line_no}</td><td>{l.description}{l.restricted ? <> <Badge s="warn" label="restricted" /><div class="small mute">{l.restriction_note}</div></> : null}</td><td><code>{l.hs_code}</code></td><td>{l.origin_country ?? "—"}</td><td class="num">{Number(l.qty)} {l.uom}</td>
        <td class="num">{(Number(l.value_minor) / 100).toFixed(2)}</td><td class="num"><Money v={l.cif_aed_minor} /></td><td class="num"><Money v={l.duty_minor} /> <span class="small mute">{(l.duty_rate_bps / 100).toFixed(2)}%</span></td><td class="num"><Money v={l.vat_minor} /></td>
        <td class="no-print">{edit && w ? <><a class="small" href={`${K}/lines/${l.id}`}>edit</a> <Confirm action={`${K}/lines/${l.id}/remove`} csrf={csrf} label="×" confirm="Remove this line?" cls="ghost sm" fields={{ case_id: id }} /></> : null}</td></tr>)}</Table></div>
    {edit && w ? <details><summary><strong>Add a goods line</strong></summary><LineForm action={a("lines")} csrf={csrf} cur={k.currency} label="Add line" /></details> : null}

    {/* ── evidence */}
    <div style="margin-top:20px"><Table caption="Evidence checklist (suggested — your broker decides what the declaration needs)" head={["Document", "Needed", "Status", "Evidence", ""]}>
      {d.checklist.map((x: any) => <tr><td>{x.label}{x.source === "restricted_goods" ? <> <Badge s="warn" label="restricted goods" /></> : null}</td><td>{x.mandatory ? "required" : "optional"}</td>
        <td>{x.status === "received" ? <Badge s="ok" label="received" /> : x.status === "waived" ? <Badge s="warn" label="waived" /> : <Badge s="bad" label="missing" />}</td>
        <td class="small">{x.status === "received" ? (x.document_id ? <>{x.doc_title} <a href={`/app/documents/${x.document_id}/download`}>download</a></> : x.note) : x.status === "waived" ? x.waived_reason : ""}</td>
        <td class="no-print">{w && !["closed", "cancelled"].includes(st) ? (<>
          {x.status === "missing" ? <form method="post" action={a("evidence")} enctype="multipart/form-data" class="inline-form"><Csrf t={csrf} /><input type="hidden" name="item_id" value={x.id} /><input type="hidden" name="kind" value={x.kind} /><input type="hidden" name="title" value={x.label} /><input name="file" type="file" required aria-label={`File for ${x.label}`} /><button class="btn sm" type="submit">Upload</button></form> : null}
          {x.status === "missing" && edit ? <form method="post" action={`${K}/items/${x.id}/seen`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="case_id" value={id} /><input name="note" type="text" placeholder="Original seen at…" /><button class="btn ghost sm" type="submit">Seen</button></form> : null}
          {x.status === "missing" && edit && appr ? <form method="post" action={`${K}/items/${x.id}/waive`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="case_id" value={id} /><input name="reason" type="text" placeholder="Reason to waive" /><button class="btn ghost sm" type="submit">Waive</button></form> : null}
          {x.status !== "missing" && edit ? <PostBtn action={`${K}/items/${x.id}/reset`} csrf={csrf} label="Undo" cls="ghost sm" fields={{ case_id: id }} /> : null}</>) : null}</td></tr>)}</Table></div>
    {edit && w ? <form method="post" action={a("item")} class="inline-form" style="margin:8px 0 20px"><Csrf t={csrf} /><input name="label" type="text" placeholder="Add a document you need" required /><label class="check"><input type="checkbox" name="mandatory" value="1" /><span>required</span></label><button class="btn ghost sm" type="submit">Add</button></form> : null}
    {w && !["closed", "cancelled"].includes(st) ? <form method="post" action={a("evidence")} enctype="multipart/form-data" class="inline-form" style="margin-bottom:20px"><Csrf t={csrf} />
      <select name="kind" aria-label="Document type">{EVIDENCE_KINDS.map((x) => <option value={x}>{x.replace(/_/g, " ")}</option>)}</select><input name="title" type="text" placeholder="Title" required /><input name="file" type="file" required aria-label="File" /><button class="btn ghost sm" type="submit">Attach other document</button></form> : null}

    {/* ── inspections, queries, payments */}
    {d.inspections.length ? <Table caption="Inspections" head={["Type", "Where", "Requested", "Result", ""]}>
      {d.inspections.map((i: any) => <tr><td>{i.kind}</td><td>{i.location ?? "—"}</td><td>{formatDay(i.requested_on)}</td><td>{i.result === "pending" ? <Badge s="warn" label="pending" /> : <><Badge s={i.result === "failed" ? "bad" : "ok"} label={i.result.replace(/_/g, " ")} /> <span class="small">{i.findings}</span></>}</td>
        <td>{i.result === "pending" && sub ? <form method="post" action={`${K}/inspections/${i.id}/close`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="case_id" value={id} /><select name="result" aria-label="Result"><option value="passed">Passed</option><option value="passed_with_conditions">Passed with conditions</option><option value="failed">Failed</option></select><input name="findings" type="text" placeholder="Findings" required /><button class="btn sm" type="submit">Close</button></form> : null}</td></tr>)}</Table> : null}
    {d.queries.length ? <div style="margin-top:16px"><Table caption="Customs queries" head={["Raised", "Query", "Due", "Answer"]}>
      {d.queries.map((q: any) => <tr><td>{formatDay(q.raised_on)}</td><td>{q.text}</td><td>{q.due_on ? formatDay(q.due_on) : "—"}</td>
        <td>{q.answered_at ? q.answer : sub ? <form method="post" action={`${K}/queries/${q.id}/answer`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="case_id" value={id} /><input name="answer" type="text" placeholder="Answer sent to customs" required /><button class="btn sm" type="submit">Answered</button></form> : <Badge s="warn" label="open" />}</td></tr>)}</Table></div> : null}

    {["assessed", "inspection", "released", "closed", "submitted"].includes(st) ? (<div style="margin-top:20px">
      <Table caption="Duty, VAT and fines paid to customs (AED)" head={["Date", "Kind", "Method", "Reference", ["Amount", "num"]]} empty={d.payments.length ? undefined : "No payments recorded."}>
        {d.payments.map((p: any) => <tr><td>{formatDay(p.paid_on)}</td><td>{p.kind}</td><td>{p.method}</td><td class="small">{p.reference}</td><td class="num">{p.kind === "refund" ? "−" : ""}<Money v={p.amount_minor} /></td></tr>)}</Table>
      {cash && ["assessed", "inspection", "released", "closed", "submitted"].includes(st) ? <form method="post" action={a("payment")} class="inline-form" style="margin:8px 0 20px"><Csrf t={csrf} />
        <select name="kind" aria-label="Kind"><option value="duty">Duty</option><option value="vat">VAT</option><option value="fine">Fine</option><option value="refund">Refund from customs</option></select>
        <input name="amount" type="number" step="0.01" min="0.01" placeholder="Amount AED" required />
        <select name="method" aria-label="Method"><option value="bank">Bank</option><option value="card">Card</option><option value="cash">Cash</option><option value="deposit">From customer's deposit</option></select>
        <select name="deposit_id" aria-label="Deposit"><option value="">— deposit —</option>{d.deposits.map((x: any) => <option value={x.id}>{x.reference} · {aed(x.balance_minor)} left</option>)}</select>
        <input name="reference" type="text" placeholder="Receipt / reference" required /><button class="btn sm" type="submit">Record payment</button></form> : null}</div>) : null}

    {/* ── billing */}
    {["released", "closed"].includes(st) || d.charges.length ? (<div style="margin-top:20px">
      <Table caption="Charges to the customer" head={["Charge", ["Amount", "num"], "Tax", "Invoice"]} empty={d.charges.length ? undefined : "No charges yet."}>
        {d.charges.map((g: any) => <tr><td class="small">{g.description}</td><td class="num"><Money v={Math.round(Number(g.qty) * Number(g.unit_minor))} /></td><td>{g.tax_code}</td><td>{g.invoice_id ? <a href={`/app/invoices/${g.invoice_id}`}>invoiced</a> : "unbilled"}</td></tr>)}</Table>
      {w ? <form method="post" action={a("charge")} class="inline-form" style="margin:8px 0"><Csrf t={csrf} /><select name="kind" aria-label="Kind"><option value="broker_fee">Broker fee</option><option value="disbursement">Disbursement</option><option value="other">Other</option></select>
        <input name="description" type="text" placeholder="Description" required /><input name="amount" type="number" step="0.01" min="0.01" placeholder="Amount" required />
        <select name="tax_code" aria-label="Tax">{Object.entries(TAX_CODES).map(([v, x]) => <option value={v}>{v} — {x.label}</option>)}</select><button class="btn ghost sm" type="submit">Add charge</button></form> : null}
      {["released", "closed"].includes(st) ? <div class="inline-form">{cash ? <PostBtn action={a("disbursements")} csrf={csrf} label="Add duty paid on their behalf" cls="ghost sm" /> : null}{can(c, "finance.write") ? <PostBtn action={a("invoice")} csrf={csrf} label="Invoice the customer" cls="red sm" /> : null}</div> : null}
    </div>) : null}

    <div style="margin-top:20px"><Table caption="History" head={["When", "What", "Who", "Detail"]}>
      {d.events.map((e: any) => <tr><td class="small">{dt(e.created_at)}</td><td>{e.kind.replace(/_/g, " ")}</td><td class="small">{e.actor ?? "—"}</td><td class="small">{["reason", "label", "declaration_no", "release_ref", "result", "note"].map((f) => e.detail?.[f]).filter(Boolean).join(" · ")}</td></tr>)}</Table></div>
  </>));
});

// actions: every handler is gated by the domain layer's own permission and state checks
const post = (path: string, ok: string, fn: (cn: any, ctx: any, id: string, b: any, c: any) => Promise<unknown>, to?: (id: string) => string) =>
  customs.post(`${K}/cases/:id/${path}`, async (c) => {
    const id = c.req.param("id"), b = await formBody(c);
    return act(c, `${K}/cases/${id}`, async () => { await withT(c, (cn, ctx) => fn(cn, ctx, id, b, c)); return { to: to ? to(id) : `${K}/cases/${id}`, ok }; });
  });
post("update", "Details saved.", (cn, ctx, id, b) => updateCase(cn, ctx, id, b));
post("lines", "Line added; the estimate was recalculated.", (cn, ctx, id, b) => addLine(cn, ctx, id, b));
post("review", "Sent for approval.", (cn, ctx, id) => submitForReview(cn, ctx, id));
post("approve", "Approved. Hand it over to the official channel.", (cn, ctx, id) => approveCase(cn, ctx, id));
post("return", "Sent back for changes.", (cn, ctx, id, b) => returnForChanges(cn, ctx, id, str(b.reason)));
post("reopen", "Reopened; the approval was withdrawn.", (cn, ctx, id, b) => reopenCase(cn, ctx, id, str(b.reason)));
post("submit", "Submission recorded.", (cn, ctx, id, b) => recordSubmission(cn, ctx, id, { channel: str(b.channel), declaration_no: str(b.declaration_no) }));
post("assess", "Assessment recorded.", (cn, ctx, id, b) => recordAssessment(cn, ctx, id, { duty: str(b.duty), vat: str(b.vat) }));
post("reject", "Rejection recorded.", (cn, ctx, id, b) => recordRejection(cn, ctx, id, str(b.reason)));
post("again", "Back in document collection; approve it again before handing it over.", (cn, ctx, id) => reopenAfterRejection(cn, ctx, id));
post("inspection", "Inspection recorded; the case is held until it is closed.", (cn, ctx, id, b) => addInspection(cn, ctx, id, { kind: str(b.kind), location: str(b.location) }));
post("query", "Query recorded; a task was raised.", (cn, ctx, id, b) => raiseQuery(cn, ctx, id, { text: str(b.text), due_on: str(b.due_on) }));
post("release", "Release recorded.", (cn, ctx, id, b) => releaseCase(cn, ctx, id, { release_ref: str(b.release_ref) }));
post("close", "Case closed.", (cn, ctx, id) => closeCase(cn, ctx, id));
post("cancel", "Case cancelled.", (cn, ctx, id, b) => cancelCase(cn, ctx, id, str(b.reason) || "Cancelled"), () => `${K}/cases`);
post("item", "Added to the checklist.", (cn, ctx, id, b) => addChecklistItem(cn, ctx, id, { label: str(b.label), mandatory: str(b.mandatory) }));
post("payment", "Payment recorded.", (cn, ctx, id, b) => recordPayment(cn, ctx, id, { kind: str(b.kind), amount: str(b.amount), method: str(b.method), deposit_id: str(b.deposit_id) || undefined, reference: str(b.reference) }));
post("charge", "Charge added.", (cn, ctx, id, b) => addCharge(cn, ctx, id, { kind: str(b.kind), description: str(b.description), amount: str(b.amount), tax_code: str(b.tax_code) }));
post("disbursements", "Duty paid on the customer's behalf was added as disbursement lines.", (cn, ctx, id) => billDisbursements(cn, ctx, id));
post("invoice", "Invoice issued.", async (cn, ctx, id) => invoiceCase(cn, ctx, id));
customs.post(`${K}/cases/:id/evidence`, async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `${K}/cases/${id}`, async () => {
    const f = b.file;
    if (!(f instanceof File)) throw new HttpError(400, "Choose a file.");
    const data = Buffer.from(await f.arrayBuffer());
    await withT(c, (cn, ctx) => attachEvidence(cn, ctx, id, { item_id: str(b.item_id) || undefined, kind: str(b.kind), title: str(b.title) || f.name, filename: f.name, data }));
    return { to: `${K}/cases/${id}`, ok: "Document stored and attached." };
  });
});
const item = (path: string, ok: string, fn: (cn: any, ctx: any, itemId: string, b: any) => Promise<unknown>) =>
  customs.post(`${K}/items/:item/${path}`, async (c) => {
    const b = await formBody(c), back = `${K}/cases/${str(b.case_id)}`;
    return act(c, back, async () => { await withT(c, (cn, ctx) => fn(cn, ctx, c.req.param("item"), b)); return { to: back, ok }; });
  });
item("seen", "Marked as seen.", (cn, ctx, i, b) => markSeen(cn, ctx, i, str(b.note)));
item("waive", "Waived, with your reason on record.", (cn, ctx, i, b) => waiveItem(cn, ctx, i, str(b.reason)));
item("reset", "Back to missing.", (cn, ctx, i) => resetItem(cn, ctx, i));
customs.post(`${K}/inspections/:i/close`, async (c) => {
  const b = await formBody(c), back = `${K}/cases/${str(b.case_id)}`;
  return act(c, back, async () => { await withT(c, (cn, ctx) => closeInspection(cn, ctx, c.req.param("i"), { result: str(b.result), findings: str(b.findings) })); return { to: back, ok: "Inspection closed." }; });
});
customs.post(`${K}/queries/:q/answer`, async (c) => {
  const b = await formBody(c), back = `${K}/cases/${str(b.case_id)}`;
  return act(c, back, async () => { await withT(c, (cn, ctx) => answerQuery(cn, ctx, c.req.param("q"), str(b.answer))); return { to: back, ok: "Answer recorded; the task is resolved." }; });
});
customs.get(`${K}/lines/:lid`, async (c) => {
  need(c, "cus.write");
  const lid = c.req.param("lid");
  const l = await withT(c, async (cn) => (await cn.query<any>(`SELECT l.*, k.currency, k.no FROM cus_lines l JOIN cus_cases k ON k.id=l.case_id WHERE l.id=$1`, [lid])).rows[0]);
  if (!l) throw new HttpError(404, "Line not found");
  return appPage(c, "Edit line", (<><PageHead title={`${l.no} · line ${l.line_no}`}><a class="btn ghost sm" href={`${K}/cases/${l.case_id}`}>← Case</a></PageHead><LineForm action={`${K}/lines/${lid}`} csrf={c.get("csrf")} l={l} cur={l.currency} label="Save line" /></>));
});
customs.post(`${K}/lines/:lid`, async (c) => {
  need(c, "cus.write");
  const b = await formBody(c), lid = c.req.param("lid");
  const caseId = await withT(c, async (cn) => (await cn.query<any>(`SELECT case_id FROM cus_lines WHERE id=$1`, [lid])).rows[0]?.case_id);
  return act(c, `${K}/lines/${lid}`, async () => { await withT(c, (cn, ctx) => updateLine(cn, ctx, lid, b as any)); return { to: `${K}/cases/${caseId}`, ok: "Line saved; the estimate was recalculated." }; });
});
customs.post(`${K}/lines/:lid/remove`, async (c) => {
  need(c, "cus.write");
  const b = await formBody(c), back = `${K}/cases/${str(b.case_id)}`;
  return act(c, back, async () => { await withT(c, (cn, ctx) => removeLine(cn, ctx, c.req.param("lid"))); return { to: back, ok: "Line removed." }; });
});

// ───────── handover pack (printable) and CSV
customs.get(`${K}/cases/:id/pack`, async (c) => {
  need(c, "read");
  const d = await withT(c, (cn) => handoverPack(cn, c.req.param("id")));
  const k = d.case, t = c.get("tenant")!;
  return c.html(
    <html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Handover pack {k.no}</title><link rel="stylesheet" href="/assets/app.css" /><script src="/assets/app.js" defer></script>
      <style>{`body{background:#fff;color:#000}.pk{max-width:210mm;margin:0 auto;padding:12mm;font:12px/1.4 system-ui,Arial,sans-serif}.pk h1{font-size:20px;margin:0}.pk h2{font-size:14px;margin:16px 0 4px;border-bottom:1px solid #000}.pk table{width:100%;border-collapse:collapse}.pk td,.pk th{border:1px solid #888;padding:3px 5px;text-align:left}.pk .r{text-align:right}.note{border:2px solid #000;padding:6px;margin:8px 0;font-weight:700}@media print{.bar{display:none}}`}</style></head>
    <body><div class="bar no-print" style="padding:8px 16px;background:#071D35;color:#fff"><button class="btn sm" type="button" data-print>Print</button></div>
      <div class="pk">
        <h1>Customs handover pack — {k.no}</h1>
        <div class="note">WORKING RECORD FOR THE BROKER. Not a customs declaration. Lodge the declaration in the official channel and record its number in the system. Duty and VAT figures are estimates from rates entered by the broker; the official assessment prevails.</div>
        <table><tbody>
          <tr><th>Prepared for</th><td>{k.party_name}{k.party_tax_id ? ` · tax reg. ${k.party_tax_id}` : ""}</td><th>Broker</th><td>{t.name}</td></tr>
          <tr><th>Type · mode</th><td>{DIRECTIONS[k.direction]} · {MODES[k.mode]}</td><th>Customs office</th><td>{k.customs_office ?? "—"}</td></tr>
          <tr><th>B/L · AWB · CMR</th><td>{k.transport_ref ?? "—"}</td><th>Containers · vessel/flight</th><td>{k.container_nos ?? "—"} · {k.vessel_flight ?? "—"}</td></tr>
          <tr><th>Origin → destination</th><td>{k.origin_country ?? "—"} → {k.destination_country ?? "—"}</td><th>Incoterm · ETA</th><td>{k.incoterm ?? "—"} · {k.eta ? formatDay(k.eta) : "—"}</td></tr>
          <tr><th>Currency · rate to AED</th><td>{k.currency} · {Number(k.fx_rate)}</td><th>Freight · insurance · other</th><td>{(Number(k.freight_minor) / 100).toFixed(2)} · {(Number(k.insurance_minor) / 100).toFixed(2)} · {(Number(k.other_minor) / 100).toFixed(2)}</td></tr>
          {k.declaration_no ? <tr><th>Declaration</th><td>{CHANNELS[k.channel]} {k.declaration_no}</td><th>Submitted</th><td>{dt(k.submitted_at)}</td></tr> : null}
        </tbody></table>
        <h2>Goods</h2>
        <table><thead><tr><th>#</th><th>Description</th><th>HS code</th><th>Origin</th><th class="r">Qty</th><th class="r">Net kg</th><th class="r">Gross kg</th><th class="r">Value {k.currency}</th><th class="r">CIF AED</th><th class="r">Duty %</th><th class="r">Est. duty</th><th class="r">Est. VAT</th></tr></thead>
          <tbody>{d.lines.map((l: any) => <tr><td>{l.line_no}</td><td>{l.description}{l.restricted ? ` [RESTRICTED: ${l.restriction_note}]` : ""}</td><td>{l.hs_code}</td><td>{l.origin_country ?? ""}</td><td class="r">{Number(l.qty)} {l.uom}</td><td class="r">{Number(l.net_kg)}</td><td class="r">{Number(l.gross_kg)}</td>
            <td class="r">{(Number(l.value_minor) / 100).toFixed(2)}</td><td class="r">{(Number(l.cif_aed_minor) / 100).toFixed(2)}</td><td class="r">{(l.duty_rate_bps / 100).toFixed(2)}</td><td class="r">{(Number(l.duty_minor) / 100).toFixed(2)}</td><td class="r">{(Number(l.vat_minor) / 100).toFixed(2)}</td></tr>)}
            <tr><th colspan={4}>Totals</th><th></th><th class="r">{d.totals.weightNet}</th><th class="r">{d.totals.weightGross}</th><th class="r">{(d.totals.value / 100).toFixed(2)}</th><th class="r">{(d.totals.cifAed / 100).toFixed(2)}</th><th></th><th class="r">{(d.totals.duty / 100).toFixed(2)}</th><th class="r">{(d.totals.vat / 100).toFixed(2)}</th></tr></tbody></table>
        <h2>Supporting documents (SHA-256 fingerprints of the stored files)</h2>
        <table><thead><tr><th>Document</th><th>Status</th><th>File</th><th>SHA-256</th></tr></thead>
          <tbody>{d.checklist.map((x: any) => <tr><td>{x.label}</td><td>{x.status}{x.status === "waived" ? ` — ${x.waived_reason}` : ""}{x.status === "received" && !x.document_id ? ` — ${x.note}` : ""}</td><td>{x.filename ?? ""}</td><td style="font-size:9px;word-break:break-all">{x.sha256 ?? ""}</td></tr>)}</tbody></table>
        <h2>Control</h2>
        <p>Prepared by {k.prepared_name ?? "—"} · approved by {k.approved_name ?? "—"} on {dt(k.approved_at)} (estimated duty {(Number(k.estimated_duty_minor ?? 0) / 100).toFixed(2)} AED, VAT {(Number(k.estimated_vat_minor ?? 0) / 100).toFixed(2)} AED at approval).</p>
        <p class="small">Generated {dt(new Date().toISOString())}.</p>
      </div></body></html>);
});
customs.get(`${K}/cases/:id/lines.csv`, async (c) => {
  need(c, "read");
  const d = await withT(c, (cn) => handoverPack(cn, c.req.param("id")));
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${d.case.no}-lines.csv"`);
  return c.body(linesCsv(d));
});

// ───────── deposits and guarantees (client money)
customs.get(`${K}/deposits`, async (c) => {
  need(c, "read");
  const d = await withT(c, async (cn) => ({ rows: await listDeposits(cn), customers: await listParties(cn, "customer") }));
  const csrf = c.get("csrf"), cash = can(c, "cus.cash");
  return appPage(c, "Deposits", (<>
    <PageHead title="Deposits & guarantees" sub="Money held for customers to pay duty. It is theirs until it is used on their case or returned — never revenue." />
    <Table head={["Customer", "Type", "Reference", ["Amount", "num"], ["Used", "num"], ["Returned", "num"], ["Balance", "num"], "Expires", ""]} empty={d.rows.length ? undefined : "No deposits."}>
      {d.rows.map((x: any) => <tr><td>{x.party_name}</td><td>{x.kind === "cash_deposit" ? "cash deposit" : "bank guarantee"}</td><td>{x.reference}</td><td class="num"><Money v={x.amount_minor} /></td><td class="num"><Money v={x.applied_minor} /></td><td class="num"><Money v={x.refunded_minor} /></td><td class="num"><strong><Money v={x.balance_minor} /></strong></td>
        <td>{x.expires_on ? <>{formatDay(x.expires_on)} {x.expired ? <Badge s="bad" label="expired" /> : ageDays(x.expires_on) <= 30 ? <Badge s="warn" label="soon" /> : null}</> : "—"}</td>
        <td>{cash && x.balance_minor > 0 ? <form method="post" action={`${K}/deposits/${x.id}/refund`} class="inline-form" data-confirm="Return this money to the customer?"><Csrf t={csrf} /><input name="amount" type="number" step="0.01" min="0.01" placeholder={`up to ${(x.balance_minor / 100).toFixed(2)}`} /><button class="btn ghost sm" type="submit">{x.kind === "cash_deposit" ? "Return" : "Release"}</button></form> : null}</td></tr>)}</Table>
    {cash ? <form method="post" action={`${K}/deposits`} class="card" style="margin-top:16px;max-width:820px"><Csrf t={csrf} /><h3>Record a deposit or guarantee</h3>
      <div class="row"><div class="field"><label>Customer</label><select name="party_id" required><option value="">— select —</option>{d.customers.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <div class="field"><label>Type</label><select name="kind"><option value="cash_deposit">Cash deposit</option><option value="bank_guarantee">Bank guarantee</option></select></div>
        <div class="field"><label>Amount (AED)</label><input name="amount" type="number" step="0.01" min="0.01" required /></div></div>
      <div class="row"><div class="field"><label>Reference</label><input name="reference" type="text" required /></div><div class="field"><label>Received on</label><input name="received_on" type="date" /></div><div class="field"><label>Guarantee expires on</label><input name="expires_on" type="date" /></div></div>
      <button class="btn red" type="submit">Record</button></form> : null}
  </>));
});
customs.post(`${K}/deposits`, async (c) => {
  need(c, "cus.cash");
  const b = await formBody(c);
  return act(c, `${K}/deposits`, async () => { await withT(c, (cn, ctx) => receiveDeposit(cn, ctx, { party_id: str(b.party_id), kind: str(b.kind), amount: str(b.amount), reference: str(b.reference), received_on: str(b.received_on) || undefined, expires_on: str(b.expires_on) || undefined })); return { to: `${K}/deposits`, ok: "Recorded." }; });
});
customs.post(`${K}/deposits/:id/refund`, async (c) => {
  need(c, "cus.cash");
  const b = await formBody(c);
  return act(c, `${K}/deposits`, async () => { await withT(c, (cn, ctx) => refundDeposit(cn, ctx, c.req.param("id"), str(b.amount))); return { to: `${K}/deposits`, ok: "Returned to the customer." }; });
});
void Money; void formatDay;
