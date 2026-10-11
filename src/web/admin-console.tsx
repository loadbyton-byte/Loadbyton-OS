import { Hono } from "hono";
import { HttpError, badRequest, fmtMoney, formatDate, toMinor } from "../lib/util.js";
import { addToCohort, createCohort, removeFromCohort, rolloutOverview, setFlag } from "../platform/rollout.js";
import { createPartner, decidePayout, partnerBalances, recordReferral, requestPayout } from "../platform/partners.js";
import { churnSummary, cohortRetention, revenueMovement, tenantContribution } from "../platform/reports.js";
import { formBody, requireStaff, str, type Env, type C } from "./mw.js";
import { AdminShell, Badge, Csrf, Table, type Page } from "./ui.js";
import { arr } from "./mw.js";
import { back } from "./appkit.js";

export const adminConsole = new Hono<Env>();
adminConsole.use("/admin/partners", requireStaff);
adminConsole.use("/admin/partners/*", requireStaff);
adminConsole.use("/admin/rollout", requireStaff);
adminConsole.use("/admin/rollout/*", requireStaff);
adminConsole.use("/admin/reports", requireStaff);

const pg = (c: C, title: string): Page => ({ title, csrf: c.get("csrf"), path: c.req.path, user: { name: c.get("session")!.name }, ok: c.req.query("ok"), err: c.req.query("err") });
const staffNeed = (c: C, ...roles: string[]) => {
  const r = c.get("session")!.staffRole!;
  if (!roles.includes(r)) throw new HttpError(403, `This action needs one of: ${roles.join(", ")}.`, "forbidden");
};
const run = async (c: C, to: string, fn: () => Promise<string>) => {
  try { return back(c, to, await fn()); } catch (e) { if (e instanceof HttpError && e.status < 500) return back(c, to, undefined, e.message); throw e; }
};
const money = (m: number, cur: string) => `${cur} ${(m / 100).toFixed(2)}`;
const who = (c: C) => ({ userId: c.get("session")!.userId });

// ───────── partners
adminConsole.get("/admin/partners", async (c) => {
  const db = c.get("db"), csrf = c.get("csrf");
  const [bal, tenants, payouts] = await Promise.all([
    partnerBalances(db),
    db.query<any>(`SELECT id,name FROM tenants ORDER BY name LIMIT 500`).then((r) => r.rows),
    db.query<any>(`SELECT x.*, p.name FROM partner_payouts x JOIN partners p ON p.id=x.partner_id ORDER BY x.requested_at DESC LIMIT 50`).then((r) => r.rows),
  ]);
  const partners = [...new Map(bal.map((b: any) => [b.id, b])).values()];
  return c.html(<AdminShell p={pg(c, "Partners")}>
    <header class="page"><h1>Partners</h1></header>
    <p class="small mute">Commission accrues on each paid order of a referred customer for the agreed number of months, and is reversed exactly when the order is refunded. Terms come from the signed agreement you reference.</p>
    <Table head={["Partner", "Rate", "Months", "Currency", ["Earned", "num"], ["Reversed", "num"], ["Paid", "num"], ["Owed", "num"]]} empty={bal.length ? undefined : "No partners yet."}>
      {bal.map((b: any) => <tr><td>{b.name} <Badge s={b.status} /></td><td>{b.commission_bps / 100}%</td><td>{b.commission_months}</td><td>{b.currency ?? "—"}</td><td>{b.currency ? money(Number(b.earned), b.currency) : ""}</td><td>{b.currency ? money(Number(b.reversed), b.currency) : ""}</td><td>{b.currency ? money(Number(b.paid), b.currency) : ""}</td><td>{b.currency ? money(Number(b.owed), b.currency) : ""}</td></tr>)}
    </Table>
    <form class="card" method="post" action="/admin/partners"><Csrf t={csrf} /><h2>New partner</h2>
      <div class="field"><label for="n">Name</label><input id="n" name="name" required /></div>
      <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" /></div>
      <div class="field"><label for="bp">Commission (basis points, 1000 = 10%)</label><input id="bp" name="commission_bps" type="number" min="0" max="5000" required /></div>
      <div class="field"><label for="m">Commission months (1–36)</label><input id="m" name="commission_months" type="number" min="1" max="36" required /></div>
      <div class="field"><label for="a">Signed agreement reference</label><input id="a" name="agreement_ref" required /></div><button class="btn">Create partner</button></form>
    <form class="card" method="post" action="/admin/partners/referral"><Csrf t={csrf} /><h2>Record a referral</h2>
      <div class="field"><label for="p">Partner</label><select id="p" name="partner_id">{partners.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
      <div class="field"><label for="t">Customer</label><select id="t" name="tenant_id">{tenants.map((t: any) => <option value={t.id}>{t.name}</option>)}</select></div>
      <div class="field"><label for="ev">Evidence (agreement clause, introduction email, code)</label><input id="ev" name="evidence" required /></div><button class="btn">Record</button></form>
    <form class="card" method="post" action="/admin/partners/payout"><Csrf t={csrf} /><h2>Request a payout</h2>
      <div class="field"><label for="pp">Partner</label><select id="pp" name="partner_id">{partners.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
      <div class="field"><label for="cu">Currency</label><input id="cu" name="currency" value="AED" required /></div>
      <div class="field"><label for="am">Amount</label><input id="am" name="amount" required /></div><button class="btn">Request</button></form>
    <h2>Payouts</h2>
    <Table head={["Partner", "Amount", "Status", "Requested", ""]} empty={payouts.length ? undefined : "None."}>
      {payouts.map((x: any) => <tr><td>{x.name}</td><td>{money(Number(x.amount_minor), x.currency)}</td><td><Badge s={x.status} /></td><td class="small">{formatDate(x.requested_at)}</td>
        <td>{x.status === "requested" ? <form method="post" action={`/admin/partners/payout/${x.id}`}><Csrf t={csrf} /><input name="reference" placeholder="Bank transfer reference" /><button class="btn sm" name="decision" value="approve">Mark paid</button> <button class="btn ghost sm" name="decision" value="reject">Reject</button></form> : x.reference ?? ""}</td></tr>)}
    </Table>
  </AdminShell>);
});
adminConsole.post("/admin/partners", async (c) => {
  staffNeed(c, "commercial_admin");
  const b = await formBody(c);
  return run(c, "/admin/partners", async () => { await createPartner(c.get("db"), who(c), { name: str(b.name), email: str(b.email), commission_bps: Number(str(b.commission_bps)), commission_months: Number(str(b.commission_months)), agreement_ref: str(b.agreement_ref) }); return "Partner created."; });
});
adminConsole.post("/admin/partners/referral", async (c) => {
  staffNeed(c, "commercial_admin");
  const b = await formBody(c);
  return run(c, "/admin/partners", async () => { await recordReferral(c.get("db"), who(c), str(b.partner_id), str(b.tenant_id), str(b.evidence)); return "Referral recorded."; });
});
adminConsole.post("/admin/partners/payout", async (c) => {
  staffNeed(c, "commercial_admin");
  const b = await formBody(c);
  return run(c, "/admin/partners", async () => { await requestPayout(c.get("db"), who(c), str(b.partner_id), str(b.currency).toUpperCase(), toMinor(str(b.amount))); return "Payout requested. A second person must decide it."; });
});
adminConsole.post("/admin/partners/payout/:id", async (c) => {
  staffNeed(c, "commercial_admin", "auditor");
  const b = await formBody(c), id = c.req.param("id");
  return run(c, "/admin/partners", async () => { await decidePayout(c.get("db"), who(c), id, str(b.decision) === "approve", str(b.reference)); return "Decision recorded."; });
});

// ───────── rollout
adminConsole.get("/admin/rollout", async (c) => {
  const db = c.get("db"), csrf = c.get("csrf");
  const [o, tenants] = await Promise.all([rolloutOverview(db), db.query<any>(`SELECT id,name FROM tenants ORDER BY name LIMIT 500`).then((r) => r.rows)]);
  return c.html(<AdminShell p={pg(c, "Rollout")}>
    <header class="page"><h1>Rollout cohorts and flags</h1></header>
    <p class="small mute">A feature is released to nobody, to named cohorts of customers, or to everyone. An unknown flag is always off.</p>
    <h2>Flags</h2>
    <Table head={["Flag", "Audience", "Cohorts", "Updated"]} empty={o.flags.length ? undefined : "No flags set."}>
      {o.flags.map((f: any) => <tr><td>{f.key}</td><td><Badge s={f.audience} /></td><td class="small">{(f.cohorts ?? []).join(", ")}</td><td class="small">{formatDate(f.updated_at)}</td></tr>)}</Table>
    <form class="card" method="post" action="/admin/rollout/flag"><Csrf t={csrf} /><h2>Set a flag</h2>
      <div class="field"><label for="k">Flag key</label><input id="k" name="key" required /></div>
      <div class="field"><label for="a">Audience</label><select id="a" name="audience"><option value="off">Off</option><option value="cohorts">Selected cohorts</option><option value="all">Everyone</option></select></div>
      <fieldset><legend>Cohorts</legend>{o.cohorts.map((x: any) => <label class="check"><input type="checkbox" name="cohort" value={x.id} />{x.name}</label>)}</fieldset>
      <div class="field"><label for="no">Note</label><input id="no" name="note" /></div><button class="btn">Save flag</button></form>
    <h2>Cohorts</h2>
    <Table head={["Cohort", "Customers", ""]} empty={o.cohorts.length ? undefined : "No cohorts."}>
      {o.cohorts.map((x: any) => <tr><td>{x.name}<div class="small mute">{x.description}</div></td><td>{x.members}</td><td>
        <form method="post" action={`/admin/rollout/cohort/${x.id}/member`}><Csrf t={csrf} /><select name="tenant_id">{tenants.map((t: any) => <option value={t.id}>{t.name}</option>)}</select><button class="btn sm" name="op" value="add">Add</button> <button class="btn ghost sm" name="op" value="remove">Remove</button></form></td></tr>)}</Table>
    <form class="card" method="post" action="/admin/rollout/cohort"><Csrf t={csrf} /><h2>New cohort</h2>
      <div class="field"><label for="cn">Name</label><input id="cn" name="name" required /></div><div class="field"><label for="cd">Description</label><input id="cd" name="description" /></div><button class="btn">Create cohort</button></form>
  </AdminShell>);
});
adminConsole.post("/admin/rollout/cohort", async (c) => {
  staffNeed(c, "commercial_admin", "engineer");
  const b = await formBody(c);
  return run(c, "/admin/rollout", async () => { await createCohort(c.get("db"), who(c), str(b.name), str(b.description)); return "Cohort created."; });
});
adminConsole.post("/admin/rollout/cohort/:id/member", async (c) => {
  staffNeed(c, "commercial_admin", "engineer");
  const b = await formBody(c), id = c.req.param("id");
  return run(c, "/admin/rollout", async () => { if (str(b.op) === "remove") await removeFromCohort(c.get("db"), who(c), id, str(b.tenant_id)); else await addToCohort(c.get("db"), who(c), id, str(b.tenant_id)); return "Cohort updated."; });
});
adminConsole.post("/admin/rollout/flag", async (c) => {
  staffNeed(c, "commercial_admin", "engineer");
  const b = await formBody(c);
  return run(c, "/admin/rollout", async () => { await setFlag(c.get("db"), who(c), str(b.key).trim(), str(b.audience) as any, arr(b.cohort), str(b.note)); return "Flag saved."; });
});

// ───────── reports
adminConsole.get("/admin/reports", async (c) => {
  const db = c.get("db");
  const [ret, mov, churn, contrib] = await Promise.all([cohortRetention(db), revenueMovement(db), churnSummary(db), tenantContribution(db)]);
  const mrr = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => money(v, k)).join(" · ") || "—";
  return c.html(<AdminShell p={pg(c, "Reports")}>
    <header class="page"><h1>Retention, churn and contribution</h1></header>
    <p class="small mute">Computed from recorded orders, subscriptions and the partner ledger. Money is shown per currency and never converted. No AI-model cost is recorded in the platform yet, so contribution excludes it.</p>
    <h2>Subscription state</h2>
    <Table head={["State", "Subscriptions", "Monthly value"]}>
      {Object.entries(churn).map(([k, v]: any) => <tr><td>{k.replace(/_/g, " ")}</td><td>{v.count}</td><td>{mrr(v.mrr)}</td></tr>)}</Table>
    <h2>Signup cohorts</h2>
    <Table head={["Signup month", "Signed up", "Ever paid", "Still active", "Lapsed", "Retention"]} empty={ret.length ? undefined : "No customers yet."}>
      {ret.map((r) => <tr><td>{r.signup}</td><td>{r.signed}</td><td>{r.paid}</td><td>{r.active}</td><td>{r.churned}</td><td>{r.retention_pct == null ? "—" : `${r.retention_pct}%`}</td></tr>)}</Table>
    <h2>Revenue movement (last 6 months)</h2>
    <Table head={["Month", "Currency", ["Gross", "num"], ["Refunded", "num"], ["Net", "num"], "New", "Returning"]} empty={mov.length ? undefined : "No paid orders yet."}>
      {mov.map((r) => <tr><td>{r.month}</td><td>{r.currency}</td><td>{money(r.gross, r.currency)}</td><td>{money(r.refunded, r.currency)}</td><td>{money(r.net, r.currency)}</td><td>{r.new_tenants}</td><td>{r.returning_tenants}</td></tr>)}</Table>
    <h2>Contribution by customer</h2>
    <Table head={["Customer", "Currency", ["Revenue", "num"], ["Refunds", "num"], ["Partner commission", "num"], ["Contribution", "num"]]} empty={contrib.length ? undefined : "No paid orders yet."}>
      {contrib.map((r) => <tr><td><a href={`/admin/tenants/${r.tenant_id}`}>{r.tenant}</a></td><td>{r.currency}</td><td>{money(r.revenue, r.currency)}</td><td>{money(r.refunds, r.currency)}</td><td>{money(r.partner_commission, r.currency)}</td><td>{money(r.contribution, r.currency)}</td></tr>)}</Table>
  </AdminShell>);
});
void badRequest; void fmtMoney;
