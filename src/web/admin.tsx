import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HttpError, badRequest, fmtMoney, formatDate, toMinor } from "../lib/util.js";
import { currentPlans } from "../platform/catalog.js";
import {
  acknowledgeReview, listDeadOutbox, listOrders, listProvisioning, listRejectedEvents, listStaffReview, listTenants,
  overview, publishPlanVersion, requestGrant, startSupportView, tenantDetail,
} from "../platform/admin.js";
import { provisioningStats, retryProvisioning } from "../platform/provisioning.js";
import { SESSION_COOKIE, formBody, requireStaff, str, type Env, type C } from "./mw.js";
import { AdminShell, Badge, Csrf, Money, Table, type Page } from "./ui.js";
import { back } from "./appkit.js";

export const admin = new Hono<Env>();
admin.use("/admin/*", async (c, next) => (c.req.path === "/admin/mfa" ? next() : requireStaff(c, next)));
admin.use("/admin", requireStaff);

const pg = (c: C, title: string): Page => ({ title, csrf: c.get("csrf"), path: c.req.path, user: { name: c.get("session")!.name }, ok: c.req.query("ok"), err: c.req.query("err") });
const staffNeed = (c: C, ...roles: string[]) => {
  const r = c.get("session")!.staffRole!;
  if (!roles.includes(r)) throw new HttpError(403, `This action needs one of: ${roles.join(", ")}.`, "forbidden");
};
const run = async (c: C, to: string, fn: () => Promise<string>) => {
  try { return back(c, to, await fn()); } catch (e) { if (e instanceof HttpError && e.status < 500) return back(c, to, undefined, e.message); throw e; }
};

admin.get("/admin", async (c) => {
  const db = c.get("db");
  const [o, st] = await Promise.all([overview(db), provisioningStats(db)]);
  const m = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)} min`);
  return c.html(
    <AdminShell p={pg(c, "Control console")}>
      <header class="page"><h1>Control console</h1></header>
      <div class="grid g4">
        <div class="card"><h3>Tenants</h3><div class="kpi">{o.tenants}</div><p class="small mute">{o.paid} paid</p></div>
        <div class="card"><h3>MRR (excl. setup & tax)</h3><div class="kpi">{fmtMoney(o.mrrMinor)}</div></div>
        <div class="card"><h3>Pending orders</h3><div class="kpi">{o.pendingOrders}</div></div>
        <div class="card"><h3>Open leads</h3><div class="kpi">{o.openLeads}</div></div>
      </div>
      <h2 style="margin-top:26px">Provisioning health</h2>
      <div class="grid g4">
        <div class="card"><h3>p50 queue→ready</h3><div class="kpi">{m(st.p50)}</div></div><div class="card"><h3>p95 queue→ready</h3><div class="kpi">{m(st.p95)}</div></div>
        <div class="card"><h3>Aged queue (&gt;4 h)</h3><div class={`kpi ${st.aged ? "bad" : "good"}`}>{st.aged}</div></div><div class="card"><h3>Failed (manual intervention)</h3><div class={`kpi ${st.failed ? "bad" : "good"}`}>{st.failed}</div></div>
      </div>
      <h2 style="margin-top:26px">Needs attention</h2>
      <ul>
        <li>Rejected payment events: <strong>{o.rejectedEvents}</strong> — <a href="/admin/orders">review</a></li>
        <li>Undeliverable outbox rows: <strong>{o.deadOutbox}</strong> — <a href="/admin/queues">review</a></li>
        <li>Staff review items (refunds, failed activations): <strong>{o.staffReview}</strong> — <a href="/admin/queues">review</a></li>
      </ul>
    </AdminShell>);
});

admin.get("/admin/tenants", async (c) => {
  const rows = await listTenants(c.get("db"));
  return c.html(
    <AdminShell p={pg(c, "Tenants")}>
      <header class="page"><h1>Tenants</h1></header>
      <Table head={["Company", "Slug", "Plan", "Subscription", "Users", "Jobs", "Created"]}>
        {rows.map((t: any) => <tr><td><a href={`/admin/tenants/${t.id}`}>{t.name}</a></td><td>{t.slug}</td><td>{t.plan}</td><td><Badge s={t.sub_status ?? "cancelled"} /></td><td>{t.users}</td><td>{t.jobs}</td><td class="small">{formatDate(t.created_at)}</td></tr>)}
      </Table>
    </AdminShell>);
});

admin.get("/admin/tenants/:id", async (c) => {
  const d = await tenantDetail(c.get("db"), c.req.param("id"));
  const csrf = c.get("csrf"), t = d.tenant;
  const me = c.get("session")!;
  const active = d.grants.find((g: any) => g.staff_user_id === me.userId && g.status === "approved" && new Date(g.expires_at) > new Date());
  return c.html(
    <AdminShell p={pg(c, t.name)}>
      <header class="page"><h1>{t.name}</h1><div class="spacer"></div><Badge s={t.status} /></header>
      <p class="mute">Operational data is not shown here. Staff access to a workspace requires a customer-approved, time-limited, read-only grant.</p>
      <div class="grid g2">
        <section class="card"><h3>Subscription</h3><p>{d.sub?.plan} · <Badge s={d.sub?.status ?? "cancelled"} /> {d.sub?.period_end ? `· renews ${formatDate(d.sub.period_end)}` : "· free forever"}</p>
          <h3>Entitlements (effective)</h3><ul>{d.entitlements.map((e: any) => <li>{e.key}: <strong>{e.int_limit}</strong> <span class="small mute">({e.source})</span></li>)}</ul>
          <h3>Usage</h3><ul>{d.usage.map((u: any) => <li>{u.key} {u.period}: {u.used}</li>)}</ul></section>
        <section class="card"><h3>Support access</h3>
          {active ? <><p class="alert ok">Approved until {formatDate(active.expires_at)}.</p><form method="post" action={`/admin/tenants/${t.id}/view`}><Csrf t={csrf} /><button class="btn red sm" type="submit">Open workspace read-only</button></form></> : (
            <form method="post" action={`/admin/tenants/${t.id}/grant`}><Csrf t={csrf} /><div class="field"><label for="r">Reason (shown to the customer)</label><input id="r" name="reason" type="text" minlength={10} required /></div><button class="btn sm" type="submit">Request grant</button></form>)}
          <Table head={["Staff", "Reason", "Status"]} empty={d.grants.length ? undefined : "No grants."}>{d.grants.map((g: any) => <tr><td>{g.staff}</td><td class="small">{g.reason}</td><td><Badge s={g.status} /></td></tr>)}</Table></section>
      </div>
      <h3 style="margin-top:22px">Domains</h3><Table head={["Hostname", "Kind", "Status"]}>{d.domains.map((x: any) => <tr><td>{x.hostname}</td><td>{x.kind}</td><td><Badge s={x.status} /></td></tr>)}</Table>
      <h3 style="margin-top:22px">Orders</h3><Table head={["Reference", "Created", ["Total", "num"], "Status"]}>{d.orders.map((o: any) => <tr><td>{o.reference}</td><td class="small">{formatDate(o.created_at)}</td><td class="num"><Money v={o.total_minor} /></td><td><Badge s={o.status} /></td></tr>)}</Table>
      <h3 style="margin-top:22px">Provisioning</h3><Table head={["State", "Attempts", "Queued", "Ready", "Detail"]}>{d.provisioning.map((j: any) => <tr><td><Badge s={j.state} /></td><td>{j.attempts}</td><td class="small">{formatDate(j.queued_at)}</td><td class="small">{formatDate(j.ready_at)}</td><td class="small">{j.failure_reason ?? ""}</td></tr>)}</Table>
      <h3 style="margin-top:22px">Recent audit</h3><Table head={["When", "Kind", "Action", "Record"]}>{d.audit.map((a: any) => <tr><td class="small nowrap">{formatDate(a.at)}</td><td>{a.actor_kind}</td><td>{a.action}</td><td class="small mute">{a.entity_type} {String(a.entity_id ?? "").slice(0, 8)}</td></tr>)}</Table>
    </AdminShell>);
});
admin.post("/admin/tenants/:id/grant", async (c) => {
  staffNeed(c, "support", "engineer", "commercial_admin");
  const b = await formBody(c), id = c.req.param("id");
  return run(c, `/admin/tenants/${id}`, async () => { await requestGrant(c.get("db"), c.get("session")!.userId, id, str(b.reason)); return "Grant requested. The customer owner must approve it."; });
});
admin.post("/admin/tenants/:id/view", async (c) => {
  const id = c.req.param("id"), s = c.get("session")!;
  try { await startSupportView(c.get("db"), getCookie(c, SESSION_COOKIE)!, s.userId, id); return c.redirect("/app"); }
  catch (e) { if (e instanceof HttpError && e.status < 500) return back(c, `/admin/tenants/${id}`, undefined, e.message); throw e; }
});

admin.get("/admin/orders", async (c) => {
  const [orders, events] = await Promise.all([listOrders(c.get("db")), listRejectedEvents(c.get("db"))]);
  return c.html(
    <AdminShell p={pg(c, "Orders & payments")}>
      <header class="page"><h1>Orders & payments</h1></header>
      <Table head={["Reference", "Tenant", "Created", ["Total", "num"], "Status", "Events"]}>
        {orders.map((o: any) => <tr><td>{o.reference}</td><td><a href={`/admin/tenants/${o.tenant_id}`}>{o.tenant_name}</a></td><td class="small">{formatDate(o.created_at)}</td><td class="num"><Money v={o.total_minor} cur={o.currency} /></td><td><Badge s={o.status} /></td>
          <td class="small">{(o.events ?? []).map((e: any) => `${e.type.replace("payment.", "")}:${e.outcome}`).join(" · ") || "—"}</td></tr>)}
      </Table>
      <h2 style="margin-top:26px">Rejected / ignored provider events (reconcile against provider records)</h2>
      <Table head={["Received", "Provider", "Event", "Type", "Outcome"]} empty={events.length ? undefined : "None."}>
        {events.map((e: any) => <tr><td class="small">{formatDate(e.received_at)}</td><td>{e.provider}</td><td class="small">{e.event_id}</td><td>{e.type}</td><td><Badge s={e.outcome === "rejected" ? "failed" : "warn"} label={e.outcome} /></td></tr>)}
      </Table>
    </AdminShell>);
});

admin.get("/admin/provisioning", async (c) => {
  const rows = await listProvisioning(c.get("db"));
  const csrf = c.get("csrf");
  return c.html(
    <AdminShell p={pg(c, "Provisioning")}>
      <header class="page"><h1>Provisioning queue</h1></header>
      <Table head={["Tenant", "Order", "State", "Steps", "Attempts", "Queued", "Detail", ""]} empty={rows.length ? undefined : "No jobs."}>
        {rows.map((j: any) => <tr><td><a href={`/admin/tenants/${j.tenant_id}`}>{j.tenant_name}</a></td><td class="small">{j.reference}</td><td><Badge s={j.state} /></td><td>{j.steps_done}/9</td><td>{j.attempts}</td><td class="small">{formatDate(j.queued_at)}</td><td class="small">{j.failure_reason ?? j.owner_action ?? ""}</td>
          <td>{j.state === "failed" ? <form method="post" action="/admin/provisioning/retry" class="inline"><Csrf t={csrf} /><input type="hidden" name="id" value={j.id} /><button class="btn sm" type="submit">Retry</button></form> : null}</td></tr>)}
      </Table>
    </AdminShell>);
});
admin.post("/admin/provisioning/retry", async (c) => {
  staffNeed(c, "engineer", "support");
  const b = await formBody(c);
  await retryProvisioning(c.get("db"), str(b.id), c.get("session")!.userId);
  return back(c, "/admin/provisioning", "Requeued; completed steps will be skipped.");
});

admin.get("/admin/catalog", async (c) => {
  const db = c.get("db");
  const plans = await currentPlans(db);
  const history = (await db.query<any>(`SELECT plan_code, version, monthly_minor, setup_minor, published_at, (SELECT count(*) FROM subscriptions s WHERE s.plan_version_id=pv.id)::int AS subs FROM plan_versions pv ORDER BY plan_code, version DESC`)).rows;
  const csrf = c.get("csrf");
  return c.html(
    <AdminShell p={pg(c, "Catalog & prices")}>
      <header class="page"><h1>Catalog & price versions</h1></header>
      <div class="alert info">Published plan versions are immutable. Publishing creates a new version for <em>new</em> purchases; existing subscriptions keep the version they bought.</div>
      <div class="grid g3">{plans.map((p) => (
        <form method="post" action="/admin/catalog/publish" class="card"><Csrf t={csrf} /><input type="hidden" name="plan" value={p.plan_code} />
          <h3>{p.name} · v{p.version}</h3>
          <div class="field"><label>Monthly (AED)</label><input name="monthly" type="number" step="0.01" min="0" value={String(p.monthly_minor / 100)} /></div>
          <div class="field"><label>Setup (AED)</label><input name="setup" type="number" step="0.01" min="0" value={String(p.setup_minor / 100)} /></div>
          <button class="btn sm" type="submit">Publish new version</button></form>))}</div>
      <h2 style="margin-top:26px">Version history</h2>
      <Table head={["Plan", "Version", ["Monthly", "num"], ["Setup", "num"], "Published", "Subscriptions"]}>
        {history.map((h: any) => <tr><td>{h.plan_code}</td><td>v{h.version}</td><td class="num"><Money v={h.monthly_minor} /></td><td class="num"><Money v={h.setup_minor} /></td><td class="small">{formatDate(h.published_at)}</td><td>{h.subs}</td></tr>)}</Table>
    </AdminShell>);
});
admin.post("/admin/catalog/publish", async (c) => {
  staffNeed(c, "commercial_admin");
  const b = await formBody(c);
  return run(c, "/admin/catalog", async () => {
    const v = await publishPlanVersion(c.get("db"), c.get("session")!.userId, str(b.plan), { monthly: toMinor(str(b.monthly)), setup: toMinor(str(b.setup)) });
    return `Published version ${v}.`;
  });
});

admin.get("/admin/queues", async (c) => {
  const [review, dead] = await Promise.all([listStaffReview(c.get("db")), listDeadOutbox(c.get("db"))]);
  const csrf = c.get("csrf");
  return c.html(
    <AdminShell p={pg(c, "Queues & reviews")}>
      <header class="page"><h1>Queues & reviews</h1></header>
      <h2>Staff review</h2>
      <Table head={["Created", "Key", "Detail", ""]} empty={review.length ? undefined : "Nothing waiting."}>
        {review.map((r: any) => <tr><td class="small">{formatDate(r.created_at)}</td><td>{r.key}</td><td class="small">{JSON.stringify(r.payload)}</td>
          <td><form method="post" action="/admin/queues/ack" class="inline"><Csrf t={csrf} /><input type="hidden" name="id" value={r.id} /><button class="btn sm" type="submit">Acknowledge</button></form></td></tr>)}</Table>
      <h2 style="margin-top:26px">Undeliverable outbox</h2>
      <Table head={["Created", "Topic", "Attempts", "Last error"]} empty={dead.length ? undefined : "None."}>
        {dead.map((r: any) => <tr><td class="small">{formatDate(r.created_at)}</td><td>{r.topic}</td><td>{r.attempts}</td><td class="small">{r.last_error}</td></tr>)}</Table>
    </AdminShell>);
});
admin.post("/admin/queues/ack", async (c) => {
  const b = await formBody(c);
  await acknowledgeReview(c.get("db"), str(b.id), c.get("session")!.userId);
  return back(c, "/admin/queues", "Acknowledged.");
});

admin.get("/admin/leads", async (c) => {
  const rows = (await c.get("db").query<any>(`SELECT * FROM platform_leads ORDER BY created_at DESC LIMIT 200`)).rows;
  return c.html(
    <AdminShell p={pg(c, "Leads")}>
      <header class="page"><h1>Leads</h1></header>
      <Table head={["When", "Name", "Company", "Email", "Source", "Message / sectors"]} empty={rows.length ? undefined : "No leads."}>
        {rows.map((l: any) => <tr><td class="small">{formatDate(l.created_at)}</td><td>{l.name}</td><td>{l.company ?? "—"}</td><td>{l.email}</td><td>{l.source}</td><td class="small">{l.message ?? ""} {(l.sectors ?? []).join(", ")}</td></tr>)}</Table>
    </AdminShell>);
});
