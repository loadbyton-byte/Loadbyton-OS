import { Hono } from "hono";
import { HttpError, formatDate, formatDay, fmtMoney, lineNet, taxFor } from "../lib/util.js";
import { addCost, addExceptionItem, closeFinancially, completeOperationally, financialClosureBlockers, getJob, listJobs, planMilestone, reconcileCost, recordMilestone, resolveException, updateJobRefs } from "../ops/jobs.js";
import { getInvoice, invoiceJob, listInvoices, recordReceipt, voidInvoice } from "../ops/finance.js";
import { DOC_KINDS, listDocuments, readDocumentFile, setHold, signDownload, uploadDocument, verifyDownload } from "../ops/documents.js";
import { listParties } from "../ops/crm.js";
import { listTeam } from "../ops/team.js";
import { formBody, str, type Env } from "./mw.js";
import { act, appPage, can, Confirm, ctxOf, need, PageHead, PostBtn, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table } from "./ui.js";
import { config } from "../config.js";
import { today } from "../ops/common.js";

export const ops = new Hono<Env>();

// ───────── jobs
ops.get("/app/jobs", async (c) => {
  const rows = await withT(c, (cn) => listJobs(cn));
  return appPage(c, "Jobs", (<>
    <PageHead title="Jobs" sub="Operational status and financial status are tracked separately." />
    <Table head={["Job", "Customer", "Route", "Mode", ["Sell", "num"], "Operational", "Financial"]} empty={rows.length ? undefined : "No jobs yet. A job is created when a customer accepts a quote."}>
      {rows.map((j: any) => <tr><td><a href={`/app/jobs/${j.id}`}>{j.no}</a></td><td>{j.party_name}</td><td>{j.origin ?? "?"} → {j.destination ?? "?"}</td><td>{j.mode}</td><td class="num"><Money v={j.sell_minor} /></td><td><Badge s={j.status} /></td><td><Badge s={j.financial_status} /></td></tr>)}
    </Table>
  </>));
});

ops.get("/app/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const d = await withT(c, async (cn) => ({
    j: await getJob(cn, id), blockers: await financialClosureBlockers(cn, id), team: await listTeam(cn),
    suppliers: await listParties(cn, "supplier"),
  }));
  const { job, charges, costs, milestones, exceptions, docs, invoices, margin } = d.j;
  const csrf = c.get("csrf");
  const bps = (b: number) => `${(b / 100).toFixed(1)}%`;
  const done = (m: any) => !!m.actual_at;
  const stage = milestones.findIndex((m: any) => !done(m));
  const uninvoiced = charges.filter((x: any) => x.approved && !x.invoice_id);
  return appPage(c, job.no, (<>
    <PageHead title={`${job.no} · ${job.party_name}`} sub={`${job.origin ?? "?"} → ${job.destination ?? "?"} · ${job.mode}${job.incoterm ? ` · ${job.incoterm}` : ""} · assigned to ${job.assignee_name ?? "—"}`}>
      <Badge s={job.status} /><Badge s={job.financial_status} />
      {job.status === "delivered" && can(c, "job.write") ? <PostBtn action={`/app/jobs/${id}/complete`} csrf={csrf} label="Mark operationally complete" cls="sm" /> : null}
      {uninvoiced.length && can(c, "finance.write") ? <PostBtn action={`/app/jobs/${id}/invoice`} csrf={csrf} label="Invoice approved charges" cls="red sm" /> : null}
    </PageHead>
    <ol class="stages" aria-label="Milestones">{milestones.map((m: any, i: number) => <li class={done(m) ? "done" : i === stage ? "now" : ""}>{m.label}{done(m) ? " ✓" : ""}</li>)}</ol>
    <div class="grid g3">
      <div class="card"><h3>Quotation estimate</h3>{margin.quotation ? <><div class="kpi">{bps(margin.quotation.bps)}</div><p class="small mute">Sell <Money v={margin.quotation.sell} /> · cost <Money v={margin.quotation.cost} /></p></> : <p class="mute">—</p>}</div>
      <div class="card flag"><h3>Updated expected</h3><div class="kpi">{bps(margin.expected.bps)}</div><p class="small mute">Sell <Money v={margin.expected.sell} /> · cost <Money v={margin.expected.cost} /></p>{margin.accrualMinor ? <p class="small"><Badge s="warn" label="accrual" /> <Money v={margin.accrualMinor} /> still estimated ({margin.unreconciledCosts} line)</p> : null}</div>
      <div class="card"><h3>Actual reconciled</h3>{margin.actual ? <><div class="kpi good">{bps(margin.actual.bps)}</div><p class="small mute">Invoiced <Money v={margin.actual.sell} /> · posted cost <Money v={margin.actual.cost} /></p></> : <><div class="kpi">—</div><p class="small mute">{margin.unreconciledCosts ? "Not reconciled: supplier costs still estimated." : "Not invoiced yet."}</p></>}</div>
    </div>

    <h2 style="margin-top:26px">Milestones & evidence</h2>
    <Table head={["Milestone", "Planned", "Actual", ""]}>
      {milestones.map((m: any) => (
        <tr><td>{m.label}</td>
          <td>{can(c, "job.write") && !m.actual_at ? <form method="post" action={`/app/milestones/${m.id}/plan`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="job" value={id} /><input type="datetime-local" name="planned_at" value={m.planned_at ? new Date(m.planned_at).toISOString().slice(0, 16) : ""} /><button class="btn ghost sm" type="submit">Set</button></form> : formatDate(m.planned_at)}</td>
          <td>{m.actual_at ? <>{formatDate(m.actual_at)}{m.note ? <div class="small mute">{m.note}</div> : null}</> : "—"}</td>
          <td>{!m.actual_at && can(c, "job.write") ? <form method="post" action={`/app/milestones/${m.id}/record`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="job" value={id} /><input name="note" type="text" placeholder="Note (optional)" /><button class="btn sm" type="submit">Record now</button></form> : null}</td></tr>))}
    </Table>
    <p class="small mute">Recording “Delivered” requires proof of delivery (document kind “pod”) on file.</p>

    <h2 style="margin-top:26px">Charges (customer)</h2>
    <Table head={["Description", ["Qty", "num"], ["Unit", "num"], "Tax", ["Net", "num"], "Invoiced"]}>
      {charges.map((l: any) => <tr><td>{l.description}</td><td class="num">{Number(l.qty)}</td><td class="num"><Money v={l.unit_minor} /></td><td>{l.tax_code}</td><td class="num"><Money v={lineNet(l.qty, l.unit_minor)} /></td><td>{l.invoice_id ? <Badge s="invoiced" /> : <Badge s="open" label="not yet" />}</td></tr>)}
    </Table>

    <h2 style="margin-top:26px">Supplier costs</h2>
    <Table head={["Supplier", "Description", ["Estimated", "num"], ["Actual", "num"], "Supplier invoice", ""]} empty={costs.length ? undefined : "No costs recorded."}>
      {costs.map((k: any) => (
        <tr><td>{k.supplier_name ?? "—"}</td><td>{k.description}</td><td class="num"><Money v={k.estimated_minor} /></td><td class="num">{k.actual_minor == null ? <Badge s="warn" label="estimated" /> : <Money v={k.actual_minor} />}</td><td>{k.supplier_invoice_ref ?? "—"}</td>
          <td>{k.actual_minor == null && can(c, "finance.write") ? <form method="post" action={`/app/costs/${k.id}/reconcile`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="job" value={id} /><input name="actual" type="number" step="0.01" min="0" placeholder="Actual AED" required style="width:110px" /><input name="ref" type="text" placeholder="Supplier inv #" required style="width:130px" /><button class="btn sm" type="submit">Reconcile</button></form> : null}</td></tr>))}
    </Table>
    {can(c, "job.cost") ? <form method="post" action={`/app/jobs/${id}/cost`} class="inline-form" style="margin-top:10px"><Csrf t={csrf} />
      <select name="supplier_id"><option value="">Supplier…</option>{d.suppliers.map((s: any) => <option value={s.id}>{s.name}</option>)}</select><input name="description" type="text" placeholder="Cost description" required /><input name="estimated" type="number" step="0.01" min="0" placeholder="Estimate AED" required style="width:130px" /><button class="btn ghost sm" type="submit">Add cost</button></form> : null}

    <h2 style="margin-top:26px">Documents</h2>
    <Table head={["Title", "Kind", "Ver.", "Status", "Visible to customer", ""]} empty={docs.length ? undefined : "No documents yet."}>
      {docs.map((x: any) => <tr><td>{x.title}{x.hold ? <> <Badge s="bad" label="hold" /></> : null}</td><td>{x.kind.replace(/_/g, " ")}</td><td>v{x.version}</td><td><Badge s={x.status === "issued" ? "ok" : "draft"} label={x.status === "issued" ? `issued by ${x.issuer}` : "draft"} /></td><td>{x.customer_visible ? "Yes" : "No"}</td>
        <td><a href={`/app/documents/${x.id}/download`}>Download</a></td></tr>)}
    </Table>
    {can(c, "doc.write") ? (
      <form method="post" action={`/app/documents?job=${id}`} enctype="multipart/form-data" class="card" style="margin-top:10px"><Csrf t={csrf} /><input type="hidden" name="job_id" value={id} />
        <div class="row"><div class="field"><label>Title</label><input name="title" type="text" required /></div>
          <div class="field"><label>Kind</label><select name="kind">{DOC_KINDS.map((k) => <option value={k}>{k.replace(/_/g, " ")}</option>)}</select></div>
          <div class="field"><label>Issued/approved by (if issued externally)</label><input name="issuer" type="text" placeholder="Leave blank for a draft" /></div></div>
        <div class="row"><div class="field"><label>File (pdf, png, jpg, xlsx, docx, csv, txt · max {config.maxUploadBytes / 1048576} MB)</label><input name="file" type="file" required /></div>
          <label class="check" style="align-self:end"><input type="checkbox" name="customer_visible" /><span>Share with customer portal</span></label></div>
        <button class="btn ghost sm" type="submit">Upload</button>
        <p class="hint">A generated draft is not an externally issued authoritative document. Record who issued or approved it.</p></form>) : null}

    <h2 style="margin-top:26px">Exceptions</h2>
    <Table head={["Exception", "Owner", "Due", "Status", ""]} empty={exceptions.length ? undefined : "No exceptions."}>
      {exceptions.map((x: any) => <tr><td>{x.title}{x.detail ? <div class="small mute">{x.detail}</div> : null}</td><td>{x.owner_name ?? "—"}</td><td>{formatDate(x.due_at)}</td><td><Badge s={x.status} /></td>
        <td>{x.status === "open" && can(c, "job.write") ? <PostBtn action={`/app/exceptions/${x.id}/resolve`} csrf={csrf} label="Resolve" fields={{ job: id }} /> : null}</td></tr>)}
    </Table>
    {can(c, "job.write") ? <form method="post" action="/app/exceptions" class="inline-form" style="margin-top:10px"><Csrf t={csrf} /><input type="hidden" name="job_id" value={id} />
      <input name="title" type="text" placeholder="What went wrong?" required /><select name="owner_id"><option value="">Owner…</option>{d.team.map((m: any) => <option value={m.user_id}>{m.name}</option>)}</select>
      <select name="escalate_to"><option value="">Escalate to…</option>{d.team.map((m: any) => <option value={m.user_id}>{m.name}</option>)}</select><input name="due_at" type="datetime-local" required /><button class="btn ghost sm" type="submit">Open exception</button></form> : null}

    <h2 style="margin-top:26px">Invoices & financial closure</h2>
    <Table head={["Invoice", "Issued", "Due", ["Total", "num"], ["Paid", "num"], "Status"]} empty={invoices.length ? undefined : "No invoices yet."}>
      {invoices.map((i: any) => <tr><td><a href={`/app/invoices/${i.id}`}>{i.no}</a></td><td>{formatDay(i.issued_at)}</td><td>{formatDay(i.due_at)}</td><td class="num"><Money v={i.total_minor} /></td><td class="num"><Money v={i.paid_minor} /></td><td><Badge s={i.status} /></td></tr>)}
    </Table>
    {job.financial_status !== "closed" ? (
      <div class="alert info" style="margin-top:12px"><strong>Financial closure blockers:</strong>{d.blockers.length ? <ul style="margin:.4em 0 0">{d.blockers.map((b: string) => <li>{b}</li>)}</ul> : " none — ready to close."}
        {!d.blockers.length && can(c, "finance.write") ? <PostBtn action={`/app/jobs/${id}/close`} csrf={csrf} label="Close financially" cls="red sm" /> : null}</div>) : <div class="alert ok">Financially closed.</div>}

    {can(c, "job.write") ? (
      <details style="margin-top:22px"><summary class="btn ghost sm">Edit references</summary>
        <form method="post" action={`/app/jobs/${id}/refs`} class="card" style="margin-top:10px"><Csrf t={csrf} />
          <div class="row"><div class="field"><label>Booking ref</label><input name="booking_ref" type="text" value={job.booking_ref ?? ""} /></div><div class="field"><label>Master ref</label><input name="master_ref" type="text" value={job.master_ref ?? ""} /></div>
            <div class="field"><label>House ref</label><input name="house_ref" type="text" value={job.house_ref ?? ""} /></div><div class="field"><label>Carrier / agent</label><input name="carrier" type="text" value={job.carrier ?? ""} /></div>
            <div class="field"><label>Incoterm</label><input name="incoterm" type="text" value={job.incoterm ?? ""} maxlength={10} /></div>
            <div class="field"><label>Assigned to</label><select name="assigned_to">{d.team.map((m: any) => <option value={m.user_id} selected={m.user_id === job.assigned_to}>{m.name}</option>)}</select></div></div>
          <button class="btn sm" type="submit">Save</button></form></details>) : null}
  </>));
});

const J = (id: string) => `/app/jobs/${id}`;
ops.post("/app/jobs/:id/refs", async (c) => { const b = await formBody(c), id = c.req.param("id"); return act(c, J(id), async () => { await withT(c, (cn, ctx) => updateJobRefs(cn, ctx, id, b)); return { to: J(id), ok: "References saved." }; }); });
ops.post("/app/jobs/:id/complete", async (c) => { const id = c.req.param("id"); return act(c, J(id), async () => { await withT(c, (cn, ctx) => completeOperationally(cn, ctx, id)); return { to: J(id), ok: "Marked operationally complete. Financial closure is tracked separately." }; }); });
ops.post("/app/jobs/:id/close", async (c) => { const id = c.req.param("id"); return act(c, J(id), async () => { await withT(c, (cn, ctx) => closeFinancially(cn, ctx, id)); return { to: J(id), ok: "Financially closed." }; }); });
ops.post("/app/jobs/:id/cost", async (c) => { const b = await formBody(c), id = c.req.param("id"); return act(c, J(id), async () => { await withT(c, (cn, ctx) => addCost(cn, ctx, id, b)); return { to: J(id), ok: "Cost added as an estimate." }; }); });
ops.post("/app/jobs/:id/invoice", async (c) => {
  const id = c.req.param("id");
  return act(c, J(id), async () => {
    const r = await withT(c, (cn, ctx) => invoiceJob(cn, ctx, id));
    return { to: `/app/invoices/${r.id}`, ok: `Invoice ${r.no} issued. ${r.warnings.join(" ")}` };
  });
});
ops.post("/app/milestones/:mid/record", async (c) => { const b = await formBody(c), j = str(b.job); return act(c, J(j), async () => { await withT(c, (cn, ctx) => recordMilestone(cn, ctx, c.req.param("mid"), str(b.note))); return { to: J(j), ok: "Milestone recorded." }; }); });
ops.post("/app/milestones/:mid/plan", async (c) => { const b = await formBody(c), j = str(b.job); return act(c, J(j), async () => { await withT(c, (cn, ctx) => planMilestone(cn, ctx, c.req.param("mid"), str(b.planned_at))); return { to: J(j), ok: "Planned time set." }; }); });
ops.post("/app/costs/:cid/reconcile", async (c) => { const b = await formBody(c), j = str(b.job); return act(c, J(j), async () => { await withT(c, (cn, ctx) => reconcileCost(cn, ctx, c.req.param("cid"), str(b.actual), str(b.ref))); return { to: J(j), ok: "Supplier invoice reconciled; actual cost replaces the estimate." }; }); });
ops.post("/app/exceptions", async (c) => { const b = await formBody(c); const j = str(b.job_id); return act(c, j ? J(j) : "/app/tasks", async () => { await withT(c, (cn, ctx) => addExceptionItem(cn, ctx, b)); return { to: j ? J(j) : "/app/tasks", ok: "Exception opened." }; }); });
ops.post("/app/exceptions/:xid/resolve", async (c) => { const b = await formBody(c); const j = str(b.job); return act(c, j ? J(j) : "/app/tasks", async () => { await withT(c, (cn, ctx) => resolveException(cn, ctx, c.req.param("xid"))); return { to: j ? J(j) : "/app/tasks", ok: "Resolved." }; }); });

// ───────── tasks (owned queue with escalation target)
ops.get("/app/tasks", async (c) => {
  const d = await withT(c, async (cn) => ({
    rows: (await cn.query<any>(`SELECT x.*, o.name AS owner_name, e.name AS escalate_name, j.no AS job_no FROM job_exceptions x LEFT JOIN team_members o ON o.user_id=x.owner_id
      LEFT JOIN team_members e ON e.user_id=x.escalate_to LEFT JOIN jobs j ON j.id=x.job_id WHERE x.status='open' ORDER BY x.due_at`)).rows, team: await listTeam(cn) }));
  const csrf = c.get("csrf");
  return appPage(c, "Tasks & exceptions", (<>
    <PageHead title="Tasks & exceptions" sub="Every item has an owner, a deadline and an escalation contact — escalation goes to the person who can resolve it, not to everyone." />
    <Table head={["Item", "Job", "Owner", "Escalates to", "Due", ""]} empty={d.rows.length ? undefined : "Nothing open. "}>
      {d.rows.map((x: any) => <tr><td>{x.title}{x.detail ? <div class="small mute">{x.detail}</div> : null}</td><td>{x.job_id ? <a href={J(x.job_id)}>{x.job_no}</a> : "—"}</td><td>{x.owner_name ?? "—"}</td><td>{x.escalate_name ?? "—"}</td>
        <td>{new Date(x.due_at) < new Date() ? <Badge s="bad" label="overdue" /> : null} {formatDate(x.due_at)}</td><td>{can(c, "job.write") ? <PostBtn action={`/app/exceptions/${x.id}/resolve`} csrf={csrf} label="Resolve" /> : null}</td></tr>)}
    </Table>
    {can(c, "job.write") ? <form method="post" action="/app/exceptions" class="inline-form" style="margin-top:14px"><Csrf t={csrf} /><input name="title" type="text" placeholder="New task or exception" required />
      <select name="owner_id"><option value="">Owner…</option>{d.team.map((m: any) => <option value={m.user_id}>{m.name}</option>)}</select><select name="escalate_to"><option value="">Escalate to…</option>{d.team.map((m: any) => <option value={m.user_id}>{m.name}</option>)}</select>
      <input name="due_at" type="datetime-local" required /><button class="btn ghost sm" type="submit">Add</button></form> : null}
  </>));
});

// ───────── documents
ops.get("/app/documents", async (c) => {
  const ctx = ctxOf(c);
  const docs = await withT(c, (cn) => listDocuments(cn, { portalPartyId: ctx.partyId }));
  const csrf = c.get("csrf");
  return appPage(c, "Documents", (<>
    <PageHead title="Documents" sub="Private storage, tenant-scoped paths, short-lived signed downloads." />
    <Table head={["Title", "Job", "Kind", "Ver.", "Status", "Size", ""]} empty={docs.length ? undefined : "No documents yet. Upload from a job to link it."}>
      {docs.map((x: any) => <tr><td>{x.title}{x.hold ? <> <Badge s="bad" label="hold" /></> : null}</td><td>{x.job_no ?? "—"}</td><td>{x.kind.replace(/_/g, " ")}</td><td>v{x.version}</td><td><Badge s={x.status === "issued" ? "ok" : "draft"} label={x.status === "issued" ? `issued by ${x.issuer}` : "draft"} /></td><td class="small">{(x.size_bytes / 1024).toFixed(0)} KB</td>
        <td><a href={`/app/documents/${x.id}/download`}>Download</a> {can(c, "doc.write") ? <PostBtn action={`/app/documents/${x.id}/hold`} csrf={csrf} label={x.hold ? "Release hold" : "Hold"} cls="ghost sm" fields={{ hold: x.hold ? "0" : "1" }} /> : null}</td></tr>)}
    </Table>
    {can(c, "doc.write") ? <section class="card" style="margin-top:20px;max-width:760px"><h3>Upload a document</h3>
      <form method="post" action="/app/documents" enctype="multipart/form-data"><Csrf t={csrf} />
        <div class="row"><div class="field"><label>Title</label><input name="title" type="text" required /></div><div class="field"><label>Kind</label><select name="kind">{DOC_KINDS.map((k) => <option value={k}>{k.replace(/_/g, " ")}</option>)}</select></div></div>
        <div class="field"><label>File</label><input name="file" type="file" required /></div><button class="btn ghost sm" type="submit">Upload</button></form></section> : null}
  </>));
});
ops.post("/app/documents", async (c) => {
  const b = await formBody(c);
  const to = c.req.query("job") ? J(c.req.query("job")!) : "/app/documents";
  return act(c, to, async () => {
    const f = b.file;
    if (!(f instanceof File)) throw new HttpError(400, "Choose a file to upload.");
    const data = Buffer.from(await f.arrayBuffer());
    await withT(c, (cn, ctx) => uploadDocument(cn, ctx, { job_id: str(b.job_id) || null, kind: str(b.kind) || "other", title: str(b.title), issuer: str(b.issuer) || undefined, customer_visible: b.customer_visible === "on", filename: f.name, data }));
    return { to, ok: "Document uploaded." };
  });
});
ops.post("/app/documents/:id/hold", async (c) => { const b = await formBody(c); return act(c, "/app/documents", async () => { await withT(c, (cn, ctx) => setHold(cn, ctx, c.req.param("id"), str(b.hold) === "1")); return { to: "/app/documents", ok: "Updated." }; }); });
ops.get("/app/documents/:id/download", async (c) => {
  const ctx = ctxOf(c), id = c.req.param("id");
  const exp = Number(c.req.query("exp")), sig = c.req.query("sig");
  const doc = await withT(c, async (cn) => (await cn.query<any>(`SELECT d.*, j.party_id FROM documents d LEFT JOIN jobs j ON j.id=d.job_id WHERE d.id=$1`, [id])).rows[0]);
  if (!doc) throw new HttpError(404, "Document not found");
  if (ctx.partyId && !(doc.customer_visible && doc.party_id === ctx.partyId)) throw new HttpError(403, "Not permitted", "forbidden");
  if (!exp || !sig) { const s = signDownload(ctx.tenantId, id); return c.redirect(`/app/documents/${id}/download?exp=${s.exp}&sig=${s.sig}`); }
  if (!verifyDownload(ctx.tenantId, id, exp, sig)) throw new HttpError(403, "This download link has expired. Go back and open it again.", "forbidden");
  const buf = readDocumentFile(doc.storage_key, ctx.tenantId);
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Disposition", `attachment; filename="${doc.filename.replace(/[^\w.\- ]/g, "_")}"`);
  c.header("Content-Security-Policy", "sandbox; default-src 'none'");
  return c.body(buf as any);
});

// ───────── invoices & collections
ops.get("/app/invoices", async (c) => {
  const f = c.req.query("filter");
  const ctx = ctxOf(c);
  let rows = await withT(c, (cn) => listInvoices(cn, ctx.partyId));
  if (f === "overdue") rows = rows.filter((r: any) => r.overdue);
  const csrf = c.get("csrf");
  return appPage(c, "Invoices & collections", (<>
    <PageHead title="Invoices & collections" sub="Operational invoices. These are not e-invoices issued through an accredited service provider.">
      <a class="btn ghost sm" href="/app/invoices">All</a><a class="btn ghost sm" href="/app/invoices?filter=overdue">Overdue</a><a class="btn ghost sm" href="/app/export/invoices.csv">CSV</a>
    </PageHead>
    <Table head={["Invoice", "Customer", "Job", "Due", ["Total", "num"], ["Outstanding", "num"], "Status", "Accounting"]} empty={rows.length ? undefined : "No invoices."}>
      {rows.map((i: any) => <tr><td><a href={`/app/invoices/${i.id}`}>{i.no}</a></td><td>{i.party_name}</td><td>{i.job_no ?? "—"}</td><td>{formatDay(i.due_at)}{i.overdue ? <> <Badge s="bad" label="overdue" /></> : null}</td>
        <td class="num"><Money v={i.total_minor} /></td><td class="num"><Money v={Number(i.total_minor) - Number(i.paid_minor)} /></td><td><Badge s={i.status} /></td><td><Badge s={i.sync_status === "synced" ? "synced" : i.sync_status === "failed" ? "failed" : "draft"} label={i.sync_status.replace("_", " ")} /></td></tr>)}
    </Table>
  </>));
});
ops.get("/app/invoices/:id", async (c) => {
  const id = c.req.param("id"), ctx = ctxOf(c);
  const d = await withT(c, (cn) => getInvoice(cn, id));
  if (ctx.partyId && d.inv.party_id !== ctx.partyId) throw new HttpError(403, "Not permitted", "forbidden");
  const csrf = c.get("csrf"), inv = d.inv;
  const out = Number(inv.total_minor) - Number(inv.paid_minor);
  return appPage(c, inv.no, (<>
    <PageHead title={`Invoice ${inv.no}`} sub={`${inv.party_name}${inv.job_no ? ` · job ${inv.job_no}` : ""}`}>
      <Badge s={inv.status} />{inv.job_id && !ctx.partyId ? <a class="btn ghost sm" href={J(inv.job_id)}>Open job</a> : null}<button class="btn ghost sm" data-print="1" type="button">Print</button>
    </PageHead>
    <div class="print-doc">
      <h2>{inv.legal_name ?? inv.entity_name}</h2>
      <p class="small">{inv.entity_tax_id ? `Tax registration no. ${inv.entity_tax_id} · ` : ""}Invoice <strong>{inv.no}</strong> · Issued {formatDay(inv.issued_at)} · Due {formatDay(inv.due_at)}<br />Bill to: {inv.party_name}{inv.party_tax_id ? ` · Tax no. ${inv.party_tax_id}` : ""}</p>
      <Table head={["Description", ["Qty", "num"], ["Unit", "num"], "Tax", ["Net", "num"], ["Tax", "num"]]}>
        {d.lines.map((l: any) => <tr><td>{l.description}</td><td class="num">{Number(l.qty)}</td><td class="num"><Money v={l.unit_minor} /></td><td>{l.tax_code}</td><td class="num"><Money v={l.net_minor} cur={inv.currency} /></td><td class="num"><Money v={l.tax_minor} cur={inv.currency} /></td></tr>)}
        <tr><td colspan={4} class="right">Subtotal</td><td class="num" colspan={2}><Money v={inv.subtotal_minor} cur={inv.currency} /></td></tr>
        <tr><td colspan={4} class="right">Tax</td><td class="num" colspan={2}><Money v={inv.tax_minor} cur={inv.currency} /></td></tr>
        <tr><th colspan={4} class="right">Total</th><th class="num" colspan={2}><Money v={inv.total_minor} cur={inv.currency} /></th></tr>
        <tr><td colspan={4} class="right">Paid</td><td class="num" colspan={2}><Money v={inv.paid_minor} cur={inv.currency} /></td></tr>
        <tr><th colspan={4} class="right">Outstanding</th><th class="num" colspan={2}><Money v={out} cur={inv.currency} /></th></tr>
      </Table>
      <p class="small mute">Operational invoice generated by LOAD|BY|TON. UAE e-invoicing is performed through an accredited service provider; synchronization status: {inv.sync_status.replace("_", " ")}{inv.external_id ? ` (${inv.external_id})` : ""}.</p>
    </div>
    <h3 style="margin-top:22px" class="no-print">Receipts</h3>
    <div class="no-print">
      <Table head={["Date", "Method", "Reference", ["Amount", "num"]]} empty={d.receipts.length ? undefined : "No receipts yet."}>
        {d.receipts.map((r: any) => <tr><td>{formatDay(r.received_at)}</td><td>{r.method}</td><td>{r.reference ?? "—"}</td><td class="num"><Money v={r.amount_minor} cur={inv.currency} /></td></tr>)}</Table>
      {can(c, "finance.write") && out > 0 && inv.status !== "void" ? (
        <form method="post" action={`/app/invoices/${id}/receipt`} class="inline-form" style="margin-top:12px"><Csrf t={csrf} />
          <input name="amount" type="number" step="0.01" min="0.01" max={(out / 100).toFixed(2)} placeholder="Amount received" required /><input name="method" type="text" value="bank transfer" /><input name="reference" type="text" placeholder="Bank reference" /><input name="received_at" type="date" value={today()} /><button class="btn red sm" type="submit">Record receipt</button></form>) : null}
      {can(c, "finance.void") && inv.status !== "void" && Number(inv.paid_minor) === 0 ? (
        <form method="post" action={`/app/invoices/${id}/void`} data-confirm="Void this invoice? Charges return to the job." class="inline-form" style="margin-top:12px"><Csrf t={csrf} /><input name="reason" type="text" placeholder="Reason for reversal" required /><button class="btn danger sm" type="submit">Void invoice</button></form>) : null}
    </div>
  </>));
});
ops.post("/app/invoices/:id/receipt", async (c) => { const b = await formBody(c), id = c.req.param("id"); return act(c, `/app/invoices/${id}`, async () => { await withT(c, (cn, ctx) => recordReceipt(cn, ctx, id, b)); return { to: `/app/invoices/${id}`, ok: "Receipt recorded." }; }); });
ops.post("/app/invoices/:id/void", async (c) => { const b = await formBody(c), id = c.req.param("id"); return act(c, `/app/invoices/${id}`, async () => { await withT(c, (cn, ctx) => voidInvoice(cn, ctx, id, str(b.reason))); return { to: `/app/invoices/${id}`, ok: "Invoice voided; charges released to the job." }; }); });
