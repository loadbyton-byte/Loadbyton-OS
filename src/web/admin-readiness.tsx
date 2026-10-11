import { Hono } from "hono";
import { HttpError, formatDate } from "../lib/util.js";
import { accept, assignOwner, gateHistory, readinessSummary, reopen, seedGates, submitEvidence, waive } from "../platform/readiness.js";
import { formBody, requireStaff, str, type Env, type C } from "./mw.js";
import { AdminShell, Badge, Csrf, Table, type Page } from "./ui.js";
import { back } from "./appkit.js";

export const adminReadiness = new Hono<Env>();
adminReadiness.use("/admin/readiness", requireStaff);
adminReadiness.use("/admin/readiness/*", requireStaff);
const pg = (c: C, title: string): Page => ({ title, csrf: c.get("csrf"), path: c.req.path, user: { name: c.get("session")!.name }, ok: c.req.query("ok"), err: c.req.query("err") });
const who = (c: C) => ({ userId: c.get("session")!.userId, role: c.get("session")!.staffRole! });
const run = async (c: C, to: string, fn: () => Promise<string>) => {
  try { return back(c, to, await fn()); } catch (e) { if (e instanceof HttpError && e.status < 500) return back(c, to, undefined, e.message); throw e; }
};
const BADGE: Record<string, string> = { accepted: "ok", waived: "warn", due_for_review: "bad", evidence_submitted: "info", in_progress: "info", not_started: "bad" };

adminReadiness.get("/admin/readiness", async (c) => {
  const db = c.get("db"), csrf = c.get("csrf");
  await seedGates(db);
  const s = await readinessSummary(db), selected = c.req.query("gate");
  const sel = selected ? s.gates.find((g) => g.key === selected) : null;
  const history = sel ? await gateHistory(db, sel.key) : [];
  return c.html(<AdminShell p={pg(c, "Release readiness")}>
    <header class="page"><h1>Release readiness</h1></header>
    <p class="small mute">External accounts, provider approvals, legal and brand ownership, and business evidence cannot be produced by software. Each gate here needs a named owner, submitted evidence, and acceptance by a different person for a stated period; acceptance expires and shows as due for review.</p>
    <div class="grid g4"><div class="card"><h3>Gates accepted or waived</h3><div class="kpi">{s.done} / {s.total}</div></div>
      <div class="card"><h3>Blocking and open</h3><div class={`kpi ${s.blockers.length ? "bad" : "good"}`}>{s.blockers.length}</div></div>
      <div class="card"><h3>Ready to release</h3><div class={`kpi ${s.ready ? "good" : "bad"}`}>{s.ready ? "Yes" : "No"}</div></div></div>
    <Table head={["Area", "Gate", "Status", "Owner", "Valid until", ""]}>
      {s.gates.map((g) => <tr><td>{g.area}</td><td>{g.title}{g.blocking ? "" : <span class="small mute"> (advisory)</span>}</td><td><Badge s={BADGE[g.effective] ?? "info"} label={g.effective.replace(/_/g, " ")} /></td><td>{g.owner_name ?? "—"}</td><td class="small">{g.valid_until ?? "—"}</td><td><a href={`/admin/readiness?gate=${g.key}`}>Open</a></td></tr>)}</Table>
    {sel ? <section class="card"><h2>{sel.title}</h2>
      <p class="small"><strong>Evidence required:</strong> {sel.evidence_required}</p>
      {sel.evidence_note ? <p class="small"><strong>Submitted:</strong> {sel.evidence_note}{sel.evidence_ref ? <> · <code>{sel.evidence_ref}</code></> : null}</p> : null}
      {sel.decision_note ? <p class="small"><strong>Decision:</strong> {sel.decision_note} (until {sel.valid_until})</p> : null}
      <form method="post" action={`/admin/readiness/${sel.key}/owner`} class="inline-form"><Csrf t={csrf} /><input name="owner_name" placeholder="Owner (person or role)" value={sel.owner_name ?? ""} required /><button class="btn sm">Assign owner</button></form>
      <form method="post" action={`/admin/readiness/${sel.key}/evidence`}><Csrf t={csrf} /><div class="field"><label for="note">Evidence summary</label><textarea id="note" name="note" required></textarea></div><div class="field"><label for="ref">Reference (link, document id, ticket)</label><input id="ref" name="ref" /></div><button class="btn sm">Submit evidence</button></form>
      <form method="post" action={`/admin/readiness/${sel.key}/accept`} class="inline-form"><Csrf t={csrf} /><input name="note" placeholder="Acceptance note" required /><input name="valid_until" type="date" required /><button class="btn sm">Accept</button></form>
      <form method="post" action={`/admin/readiness/${sel.key}/waive`} class="inline-form"><Csrf t={csrf} /><input name="note" placeholder="Reason for waiver" required /><input name="valid_until" type="date" required /><button class="btn ghost sm">Waive</button></form>
      <form method="post" action={`/admin/readiness/${sel.key}/reopen`} class="inline-form"><Csrf t={csrf} /><input name="note" placeholder="Reason to reopen" required /><button class="btn ghost sm">Reopen</button></form>
      <h3>History</h3><Table head={["When", "By", "Action", "Change"]} empty="No activity.">{history.map((h: any) => <tr><td class="small">{formatDate(h.at)}</td><td>{h.actor}</td><td>{h.action.replace(/_/g, " ")}</td><td class="small">{h.from_status} → {h.to_status}{h.note ? ` · ${h.note}` : ""}</td></tr>)}</Table></section> : null}
  </AdminShell>);
});
const post = (path: string, fn: (c: C, key: string, b: Record<string, any>) => Promise<unknown>, ok: string) =>
  adminReadiness.post(`/admin/readiness/:key/${path}`, async (c) => { const key = c.req.param("key"), b = await formBody(c); return run(c, `/admin/readiness?gate=${key}`, async () => { await fn(c, key, b); return ok; }); });
post("owner", (c, k, b) => assignOwner(c.get("db"), who(c), k, str(b.owner_name)), "Owner assigned.");
post("evidence", (c, k, b) => submitEvidence(c.get("db"), who(c), k, str(b.note), str(b.ref)), "Evidence submitted for acceptance.");
post("accept", (c, k, b) => accept(c.get("db"), who(c), k, str(b.note), str(b.valid_until)), "Gate accepted.");
post("waive", (c, k, b) => waive(c.get("db"), who(c), k, str(b.note), str(b.valid_until)), "Gate waived for a limited period.");
post("reopen", (c, k, b) => reopen(c.get("db"), who(c), k, str(b.note)), "Gate reopened.");
