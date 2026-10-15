import { Hono } from "hono";
import { HttpError, formatDate } from "../lib/util.js";
import { decideKyc, kycDetail, kycState, listKycQueue, resendEmailVerification, sendPhoneCode, submitLicence, verifyPhoneCode } from "../platform/kyc.js";
import { gateMessage } from "../platform/kyc-messages.js";
import { fetchDocumentFile } from "../ops/documents.js";
import { act, appPage, back, ctxOf, PageHead } from "./appkit.js";
import { Badge, Csrf, AdminShell, Table, type Page } from "./ui.js";
import { formBody, requireStaff, str, type Env, type C } from "./mw.js";

/** The owner's checklist. Exempt from the read-only gate: this is how a workspace becomes editable. */
export const verify = new Hono<Env>();
const U = "/app/verify";
const step = (done: boolean, title: string, body: any) => <section class="card"><h3>{done ? <Badge s="ok" label="done" /> : <Badge s="warn" label="to do" />} {title}</h3>{done ? null : body}</section>;

verify.get(U, async (c) => {
  const ctx = ctxOf(c), csrf = c.get("csrf");
  const k = await kycState(c.get("db"), ctx.tenantId);
  if (!k || k.status === "verified") return appPage(c, "Company verification", <><PageHead title="Company verification" sub="This company is verified." /><p><a class="btn" href="/app">Open the workspace</a></p></>);
  const owner = ctx.roles.includes("owner");
  return appPage(c, "Company verification", <>
    <PageHead title="Verify your company" sub={gateMessage(k.status)} />
    {k.status === "rejected" ? <div class="alert err">{k.note ?? "Verification was not approved."}</div> : null}
    {k.status === "in_review" && k.note ? <div class="alert info">{k.note}</div> : null}
    {!k.hasRecord ? <p>No verification details were recorded for this workspace. Contact support.</p> : <>
      {step(k.emailOk, `Confirm your email address (${k.email})`, owner ? <form method="post" action={`${U}/email`}><Csrf t={csrf} /><p class="small">We sent a link to your email. It works once and expires in 24 hours.</p><button class="btn ghost sm">Send the link again</button></form> : <p class="small">The workspace owner must do this.</p>)}
      {step(k.phoneOk, `Confirm your mobile number (${k.phone})`, owner ? <>
        <form method="post" action={`${U}/phone/send`} class="inline-form"><Csrf t={csrf} /><button class="btn ghost sm">Send me a code</button></form>
        <form method="post" action={`${U}/phone/check`} class="inline-form"><Csrf t={csrf} /><input name="code" inputmode="numeric" maxlength={6} placeholder="6-digit code" aria-label="6-digit code" required /><button class="btn sm">Confirm</button></form></> : <p class="small">The workspace owner must do this.</p>)}
      {step(k.licenceOk, "Upload your trade licence", owner ? <form method="post" action={`${U}/licence`} enctype="multipart/form-data"><Csrf t={csrf} /><div class="field"><label for="file">Trade licence (PDF, PNG or JPEG)</label><input id="file" name="file" type="file" accept=".pdf,.png,.jpg,.jpeg" required /></div><button class="btn sm">Upload</button></form> : <p class="small">The workspace owner must do this.</p>)}
      {k.status === "in_review" ? <p class="alert info">Everything is submitted. Our team reviews it, usually within one working day, and emails you the result.</p> : null}</>}
  </>);
});
const doIt = (path: string, ok: string, fn: (c: C, b: Record<string, any>) => Promise<unknown>) =>
  verify.post(`${U}/${path}`, async (c) => { const b = await formBody(c); return act(c, U, async () => { if (!ctxOf(c).roles.includes("owner")) throw new HttpError(403, "Only the workspace owner can verify the company.", "forbidden"); await fn(c, b); return { to: U, ok }; }); });
doIt("email", "A new link is on its way.", (c) => resendEmailVerification(c.get("db"), ctxOf(c).userId));
doIt("phone/send", "A code is on its way to your mobile number.", (c) => sendPhoneCode(c.get("db"), ctxOf(c).tenantId));
doIt("phone/check", "Mobile number confirmed.", (c, b) => verifyPhoneCode(c.get("db"), ctxOf(c).tenantId, str(b.code)));
doIt("licence", "Trade licence uploaded.", async (c, b) => {
  const f = b.file; if (!(f instanceof File)) throw new HttpError(400, "Choose a file.", "bad_request");
  await submitLicence(c.get("db"), ctxOf(c), { filename: f.name, data: Buffer.from(await f.arrayBuffer()) });
});

// ───────── staff review
export const adminKyc = new Hono<Env>();
adminKyc.use("/admin/kyc", requireStaff); adminKyc.use("/admin/kyc/*", requireStaff);
const apg = (c: C, title: string): Page => ({ title, csrf: c.get("csrf"), path: c.req.path, user: { name: c.get("session")!.name }, ok: c.req.query("ok"), err: c.req.query("err") });
const FLAG: Record<string, string> = { in_review: "warn", unverified: "info", rejected: "bad", verified: "ok" };

adminKyc.get("/admin/kyc", async (c) => {
  const rows = await listKycQueue(c.get("db"), c.req.query("all") ? ["in_review", "unverified", "rejected", "verified"] : undefined);
  return c.html(<AdminShell p={apg(c, "Company verification")}>
    <header class="page"><h1>Company verification</h1></header>
    <p class="small mute">Workspaces in review first, highest risk first. Approving needs email, mobile and licence done. <a href="/admin/kyc?all=1">Include verified</a></p>
    <Table head={["Company", "Owner email", "Licence", "Checks", "Risk", "Status", "Registered", ""]} empty="Nothing waiting.">
      {rows.map((r: any) => <tr><td>{r.name}<div class="small mute">{r.plan}</div></td><td class="small">{r.email}</td><td class="small">{r.licence_no}<div class="mute">{r.licence_authority}</div></td>
        <td class="small">{r.email_verified_at ? "✓" : "✗"} email · {r.phone_verified_at ? "✓" : "✗"} mobile · {r.licence_document_id ? "✓" : "✗"} licence</td>
        <td><Badge s={r.risk_score >= 40 ? "bad" : r.risk_score > 0 ? "warn" : "ok"} label={String(r.risk_score)} /></td><td><Badge s={FLAG[r.status] ?? "info"} label={r.status.replace("_", " ")} /></td><td class="small">{formatDate(r.created_at)}</td><td><a class="btn ghost sm" href={`/admin/kyc/${r.id}`}>Review</a></td></tr>)}</Table>
  </AdminShell>);
});
adminKyc.get("/admin/kyc/:id", async (c) => {
  const d = await kycDetail(c.get("db"), c.req.param("id")), t = d.t, csrf = c.get("csrf");
  return c.html(<AdminShell p={apg(c, t.name)}>
    <header class="page"><h1>{t.name}</h1><Badge s={FLAG[t.verification_status] ?? "info"} label={t.verification_status.replace("_", " ")} /></header>
    <div class="grid g3">
      <div class="card"><h3>Identity given</h3><p>Licence <strong>{t.licence_no}</strong><br />Issued by {t.licence_authority}<br />TRN {t.trn ?? "—"}<br />Mobile {t.phone_e164} {t.phone_verified_at ? <Badge s="ok" label="confirmed" /> : <Badge s="warn" label="not confirmed" />}<br />Owner {t.owner_name} · {t.email} {t.email_verified_at ? <Badge s="ok" label="confirmed" /> : <Badge s="warn" label="not confirmed" />}</p>
        {t.licence_document_id ? <p><a class="btn sm" href={`/admin/kyc/${t.id}/licence`}>Open the trade licence</a></p> : <p class="mute">No licence uploaded.</p>}</div>
      <div class="card"><h3>Risk signals ({t.risk_score})</h3>{(t.risk_flags as any[]).length ? <ul>{(t.risk_flags as any[]).map((f) => <li><strong>{f.code.replace(/_/g, " ")}</strong> +{f.points}<div class="small mute">{f.detail}</div></li>)}</ul> : <p class="mute">None.</p>}</div>
      <div class="card"><h3>Possibly related workspaces</h3>{d.related.length ? <ul>{d.related.map((r: any) => <li><a href={`/admin/kyc/${r.id}`}>{r.name}</a> · {r.status} · {r.licence_no}</li>)}</ul> : <p class="mute">None found by name, email domain or network address.</p>}</div></div>
    <section class="card"><h2>What to check</h2><p class="small">Open the licence and check that the company name, licence number and issuing authority match what was typed, that the licence is current, and that it names the person or business registering. Confirm it with the issuing authority's public register where one exists. Software does not do this check.</p>
      <form method="post" action={`/admin/kyc/${t.id}/decide`} class="inline-form"><Csrf t={csrf} /><input name="note" placeholder="Reason / what you checked" required minlength={5} maxlength={500} />
        <button class="btn sm" name="decision" value="approve">Approve</button><button class="btn ghost sm" name="decision" value="reject">Reject</button>{t.verification_status === "rejected" ? <button class="btn ghost sm" name="decision" value="reopen">Reopen</button> : null}</form></section>
    <h3>History</h3><Table head={["When", "Who", "Event", "Detail"]}>{d.events.map((e: any) => <tr><td class="small">{formatDate(e.created_at)}</td><td class="small">{e.actor}</td><td>{e.kind.replace(/_/g, " ")}</td><td class="small">{JSON.stringify(e.detail)}</td></tr>)}</Table>
  </AdminShell>);
});
adminKyc.get("/admin/kyc/:id/licence", async (c) => {
  const db = c.get("db"), id = c.req.param("id");
  const d = (await db.query<any>(`SELECT d.storage_key, d.sha256, d.mime, d.filename FROM tenant_kyc k JOIN documents d ON d.id=k.licence_document_id WHERE k.tenant_id=$1`, [id])).rows[0];
  if (!d) throw new HttpError(404, "No licence uploaded.", "not_found");
  const buf = await fetchDocumentFile(d.storage_key, id, d.sha256);
  return c.body(buf as any, 200, { "content-type": d.mime, "content-disposition": `inline; filename="${String(d.filename).replace(/[^A-Za-z0-9._-]/g, "_")}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
});
adminKyc.post("/admin/kyc/:id/decide", async (c) => {
  const id = c.req.param("id"), b = await formBody(c), s = c.get("session")!;
  try { await decideKyc(c.get("db"), { userId: s.userId, role: s.staffRole! }, id, str(b.decision) as any, str(b.note)); return back(c, "/admin/kyc", "Decision recorded."); }
  catch (e) { if (e instanceof HttpError && e.status < 500) return back(c, `/admin/kyc/${id}`, undefined, e.message); throw e; }
});
