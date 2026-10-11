import { Hono } from "hono";
import { formatDay } from "../lib/util.js";
import { applyExtractionToJob, decideExtraction, EXTRACTOR_VERSION, extractFromDocument, listExtractions, type Extracted } from "../ops/doc-extract.js";
import { act, appPage, can, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { arr, formBody, str, type Env } from "./mw.js";

export const extraction = new Hono<Env>();
const U = "/app/extractions";

extraction.get(U, async (c) => {
  need(c, "doc.write");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ docs: (await cn.query<any>(`SELECT id,title,filename,mime,job_id,created_at FROM documents WHERE status='issued' AND NOT hold ORDER BY created_at DESC LIMIT 100`)).rows, xs: await listExtractions(cn) }));
  return appPage(c, "Document extraction", <>
    <PageHead title="Document extraction" sub={`Fixed rules (version ${EXTRACTOR_VERSION}) read reference numbers, dates, amounts and cargo particulars from the text of an issued document. Every result is a proposal that a person accepts or rejects; nothing is applied automatically.`} />
    <p class="small mute">Container numbers are checked against ISO 6346, air waybills against the IATA check digit, HS codes and tax registration numbers for length, and dates and amounts for validity. Scanned pages and unusual PDF fonts have no readable text — those are entered by hand.</p>
    <h2>Proposals</h2>
    <Table head={["Document", "Run", "Fields", "Status", ""]} empty={d.xs.length ? undefined : "No extractions yet."}>
      {d.xs.map((x: any) => <tr><td><a href={`${U}/${x.id}`}>{x.title}</a></td><td class="small">{formatDay(x.created_at)}</td><td>{(x.fields as Extracted[]).length}{x.warnings.length ? <> <Badge s="warn" label={`${x.warnings.length} warning${x.warnings.length === 1 ? "" : "s"}`} /></> : null}</td><td><Badge s={x.status} /></td><td></td></tr>)}</Table>
    <h2>Issued documents</h2>
    <Table head={["Document", "Type", "Added", ""]} empty="No issued documents.">
      {d.docs.map((x: any) => <tr><td>{x.title}<div class="small mute">{x.filename}</div></td><td class="small">{x.mime}</td><td class="small">{formatDay(x.created_at)}</td><td><form method="post" action={`${U}/run`}><Csrf t={csrf} /><input type="hidden" name="document_id" value={x.id} /><button class="btn ghost sm">Extract</button></form></td></tr>)}</Table>
  </>);
});
extraction.post(`${U}/run`, async (c) => {
  const b = await formBody(c);
  return act(c, U, async () => { const x = await withT(c, (cn, ctx) => extractFromDocument(cn, ctx, str(b.document_id))); return { to: `${U}/${x.id}`, ok: x.readable ? "Extraction ready for review." : "No readable text — enter the details by hand." }; });
});
extraction.get(`${U}/:id`, async (c) => {
  need(c, "doc.write");
  const id = c.req.param("id"), csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ x: (await cn.query<any>(`SELECT x.*, d.title, d.job_id FROM document_extractions x JOIN documents d ON d.id=x.document_id WHERE x.id=$1`, [id])).rows[0] }));
  if (!d.x) return c.notFound();
  const x = d.x, fields = x.fields as Extracted[];
  return appPage(c, "Extraction", <>
    <PageHead title={x.title} sub={`Extractor ${x.extractor_version} · ${formatDay(x.created_at)}`}><Badge s={x.status} /></PageHead>
    {(x.warnings as string[]).map((w) => <div class="alert warn">{w}</div>)}
    <Table head={["Field", "Value", "Check", "Found in the text"]} empty="Nothing recognised.">
      {fields.map((f) => <tr><td>{f.label}</td><td><strong>{f.value}</strong>{f.valid ? null : <> <Badge s="bad" label="failed check" /></>}</td><td class="small">{f.check}</td><td class="small mute">…{f.snippet}…</td></tr>)}</Table>
    {x.status === "proposed" && can(c, "doc.write") ? <div style="display:flex;gap:10px;flex-wrap:wrap">
      <form method="post" action={`${U}/${id}/decide`} class="inline-form"><Csrf t={csrf} /><input name="note" placeholder="Note (required to reject)" /><button class="btn" name="decision" value="accept">Accept as read</button> <button class="btn ghost" name="decision" value="reject">Reject</button></form></div> : null}
    {x.status === "accepted" && x.job_id && can(c, "job.write") ? <form class="card" method="post" action={`${U}/${id}/apply`}><Csrf t={csrf} /><h2>Fill job references</h2>
      <p class="small">Only fields that passed their check can be applied, and only to the job this document is attached to.</p>
      {fields.filter((f) => f.valid && ["awb_number", "bl_number"].includes(f.key)).map((f) => <label class="check"><input type="checkbox" name="key" value={f.key} />{f.label}: {f.value}</label>)}
      <label class="check"><input type="checkbox" name="overwrite" value="1" />Replace a different value already on the job</label><input type="hidden" name="job_id" value={x.job_id} /><button class="btn sm">Apply to job</button></form> : null}
    {x.applied_fields?.length ? <p class="small">Applied to the job: {x.applied_fields.join(", ")}.</p> : null}
    <p><a href={U}>Back</a></p>
  </>);
});
extraction.post(`${U}/:id/decide`, async (c) => {
  const b = await formBody(c), id = c.req.param("id");
  return act(c, `${U}/${id}`, async () => { await withT(c, (cn, ctx) => decideExtraction(cn, ctx, id, str(b.decision) === "accept", str(b.note))); return { to: `${U}/${id}`, ok: "Decision recorded." }; });
});
extraction.post(`${U}/:id/apply`, async (c) => {
  const b = await formBody(c), id = c.req.param("id");
  return act(c, `${U}/${id}`, async () => { await withT(c, (cn, ctx) => applyExtractionToJob(cn, ctx, id, str(b.job_id), arr(b.key), !!b.overwrite)); return { to: `${U}/${id}`, ok: "Job references updated." }; });
});
