import { Hono } from "hono";
import dns from "node:dns/promises";
import { config } from "../config.js";
import { HttpError, baseUrl, badRequest, fmtMoney, formatDate, formatDay } from "../lib/util.js";
import { ROLES } from "../lib/perms.js";
import { audit } from "../lib/audit.js";
import { actorOf } from "../lib/perms.js";
import { currentPlans, PRODUCTS, SECTORS } from "../platform/catalog.js";
import { currentUsage, getLimits, previewPlanChange } from "../platform/entitlements.js";
import { cancelAtPeriodEnd, createOrder, priceCheckout, scheduleDowngrade, signPayload, buildMockEvent } from "../platform/billing.js";
import { processProvisioningQueue, releaseInformationPending } from "../platform/provisioning.js";
import { switchTenant, membershipsFor, resolveCtx } from "../platform/auth.js";
import { decideGrant, removeDomain, requestCustomDomain, verifyCustomDomain } from "../platform/admin.js";
import { setSectors } from "../platform/tenants.js";
import { invite, listTeam, setRoles, deactivate } from "../ops/team.js";
import { ownerDashboard } from "../ops/dashboard.js";
import { exportTenantData, invoicesCsv } from "../ops/exporter.js";
import { listJobs } from "../ops/jobs.js";
import { portalStock } from "../ops/warehouse.js";
import { listInvoices } from "../ops/finance.js";
import { listDocuments } from "../ops/documents.js";
import { assertCapacity } from "../platform/entitlements.js";
import { arr, formBody, requireCtx, str, type Env } from "./mw.js";
import { act, appPage, back, can, ctxOf, need, PageHead, PostBtn, Confirm, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table, sectorName } from "./ui.js";
import { handlePaymentWebhook } from "./auth.js";

export const core = new Hono<Env>();

// ── context + tenant info for every /app page; portal users are fenced to the portal
core.use("/app/*", requireCtx);
core.use("/app", requireCtx);
core.use("/app/*", async (c, next) => {
  const ctx = ctxOf(c);
  const db = c.get("db");
  const t = (await db.query<any>(
    `SELECT t.name, t.slug, p.name AS plan, p.plan_code, s.status AS sub_status,
       coalesce((SELECT array_agg(sector) FROM tenant_sectors ts WHERE ts.tenant_id=t.id), '{}') AS sectors
     FROM tenants t JOIN subscriptions s ON s.tenant_id=t.id JOIN plan_versions p ON p.id=s.plan_version_id WHERE t.id=$1`, [ctx.tenantId])).rows[0];
  c.set("tenant", { name: t.name, slug: t.slug, sectors: t.sectors, plan: t.plan, planCode: t.plan_code, subStatus: t.sub_status });
  c.set("memberships", (await membershipsFor(db, ctx.userId)).map((m) => ({ tenant_id: m.tenant_id, name: m.name })));
  const portalOnly = ctx.roles.length === 1 && ctx.roles[0] === "portal";
  const driverOnly = ctx.roles.length === 1 && ctx.roles[0] === "driver";
  const p = c.req.path;
  if (portalOnly && !p.startsWith("/app/portal") && !p.startsWith("/app/documents/") && !p.startsWith("/app/invoices/") && p !== "/app/switch") return c.redirect("/app/portal");
  if (driverOnly && !p.startsWith("/app/driver") && p !== "/app/switch") return c.redirect("/app/driver");
  if (!driverOnly && !portalOnly && p.startsWith("/app/transport") && !t.sectors.includes("road-transport")) {
    return appPage(c, "Sector not enabled", (
      <div class="card" style="max-width:640px">
        <h1>Road transport is not selected</h1>
        <p>Transport planning belongs to the <strong>Road transport</strong> sector. Your selected sectors: {t.sectors.length ? t.sectors.map(sectorName).join(", ") : "none"}.</p>
        {can(c, "settings.manage") ? <a class="btn red" href="/app/settings">Choose sectors</a> : <p>Ask an owner to enable it in Settings.</p>}
      </div>));
  }
  if (!driverOnly && !portalOnly && p.startsWith("/app/warehouse") && !t.sectors.includes("contract-warehouse-3pl")) {
    return appPage(c, "Sector not enabled", (
      <div class="card" style="max-width:640px">
        <h1>Contract warehouse / 3PL is not selected</h1>
        <p>Custody stock, receiving, dispatch and counts belong to the <strong>Contract warehouse / 3PL</strong> sector. Your selected sectors: {t.sectors.length ? t.sectors.map(sectorName).join(", ") : "none"}.</p>
        {can(c, "settings.manage") ? <a class="btn red" href="/app/settings">Choose sectors</a> : <p>Ask an owner to enable it in Settings.</p>}
      </div>));
  }
  // forwarding workflow requires the sector to be selected
  const fwdOnly = ["/app/enquiries", "/app/quotes", "/app/jobs", "/app/rates", "/app/tasks", "/app/invoices", "/app/reports"];
  if (!portalOnly && fwdOnly.some((x) => p.startsWith(x)) && !t.sectors.includes("freight-forwarding")) {
    return appPage(c, "Sector not enabled", (
      <div class="card" style="max-width:640px">
        <h1>Freight forwarding is not selected</h1>
        <p>The first complete workflow (enquiry → quote → job → costs → invoice → collection) belongs to the <strong>Freight forwarding</strong> sector. Your selected sectors: {t.sectors.length ? t.sectors.map(sectorName).join(", ") : "none"}.</p>
        <p class="mute small">Other sector packs are planned and not yet released.</p>
        {can(c, "settings.manage") ? <a class="btn red" href="/app/settings">Choose sectors</a> : <p>Ask an owner to enable it in Settings.</p>}
      </div>));
  }
  await next();
});

core.post("/app/switch", async (c) => {
  const b = await formBody(c);
  const s = c.get("session")!;
  await switchTenant(c.get("db"), s.token, s.userId, str(b.tenant_id));
  return c.redirect("/app");
});

// ── overview
core.get("/app", async (c) => {
  const ctx = ctxOf(c), t = c.get("tenant")!;
  if (ctx.roles.length === 1 && ctx.roles[0] === "driver") return c.redirect("/app/driver");
  const data = await withT(c, async (cn) => {
    const n = async (sql: string) => Number((await cn.query<any>(sql)).rows[0].n);
    const checklist = [
      { done: (await n(`SELECT count(*) n FROM parties WHERE kind='customer'`)) > 0, label: "Add or import your first customer", href: "/app/parties" },
      { done: (await n(`SELECT count(*) n FROM parties WHERE kind='supplier'`)) > 0, label: "Add a supplier (carrier, agent, trucker)", href: "/app/parties" },
      { done: (await n(`SELECT count(*) n FROM enquiries`)) > 0, label: "Record a genuine enquiry", href: "/app/enquiries/new" },
      { done: (await n(`SELECT count(*) n FROM quotes`)) > 0, label: "Prepare a quotation", href: "/app/quotes" },
      { done: (await n(`SELECT count(*) n FROM jobs`)) > 0, label: "Accept a quote → one job", href: "/app/quotes" },
      { done: (await n(`SELECT count(*) n FROM invoices`)) > 0, label: "Invoice a job", href: "/app/invoices" },
      { done: (await n(`SELECT count(*) n FROM memberships WHERE active`)) > 1, label: "Invite a colleague (individual account)", href: "/app/team" },
    ];
    const mine = (await cn.query<any>(`SELECT id,no,status,origin,destination FROM jobs WHERE assigned_to=$1 AND status IN ('planned','in_transit') ORDER BY created_at DESC LIMIT 8`, [ctx.userId])).rows;
    const tasks = (await cn.query<any>(`SELECT id,title,due_at FROM job_exceptions WHERE status='open' AND (owner_id=$1 OR owner_id IS NULL) ORDER BY due_at LIMIT 8`, [ctx.userId])).rows;
    return { checklist, mine, tasks };
  });
  const prov = (await c.get("db").query<any>(`SELECT j.state, j.owner_action, j.failure_reason FROM provision_jobs j WHERE j.tenant_id=$1 ORDER BY queued_at DESC LIMIT 1`, [ctx.tenantId])).rows[0];
  const goal = (await c.get("db").query<any>(`SELECT goal FROM tenants WHERE id=$1`, [ctx.tenantId])).rows[0].goal;
  const done = data.checklist.filter((x) => x.done).length;
  return appPage(c, "Overview", (<>
    <PageHead title={`Welcome, ${t.name}`} sub={`${t.plan} plan · ${t.sectors.map(sectorName).join(", ") || "no sector selected"}`}>
      {can(c, "enquiry.write") && t.sectors.includes("freight-forwarding") ? <a class="btn red" href="/app/enquiries/new">New enquiry</a> : null}
    </PageHead>
    {prov && prov.state !== "onboarding" ? (
      <div class={`alert ${prov.state === "failed" ? "err" : "info"}`}><strong>Activation: {prov.state.replace(/_/g, " ")}.</strong> {prov.owner_action ?? "We are preparing your upgraded workspace."} <a href="/app/billing">Details</a></div>
    ) : null}
    {goal ? <p class="mute">Your first goal: <strong>{goal}</strong></p> : null}
    <div class="grid g2">
      <section class="card flat"><h3>Getting started · {done}/{data.checklist.length}</h3>
        <ul style="list-style:none;padding:0;margin:0">{data.checklist.map((x) => (
          <li style="padding:6px 0">{x.done ? <Badge s="ok" label="Done" /> : <Badge s="open" label="To do" />} <a href={x.href}>{x.label}</a></li>
        ))}</ul>
      </section>
      <section class="card flat"><h3>My work</h3>
        {data.mine.length || data.tasks.length ? (<>
          {data.mine.map((j: any) => <p style="margin:.2em 0"><a href={`/app/jobs/${j.id}`}>{j.no}</a> <span class="mute small">{j.origin} → {j.destination}</span> <Badge s={j.status} /></p>)}
          {data.tasks.map((x: any) => <p style="margin:.2em 0"><a href="/app/tasks">{x.title}</a> <span class="mute small">due {formatDate(x.due_at)}</span></p>)}
        </>) : <p class="mute">Nothing assigned to you right now.</p>}
      </section>
    </div>
    <h2 style="margin-top:28px">Discoverable upgrades</h2>
    <p class="mute small">Only the modules you use are in your navigation. These exist on the roadmap; none is sold until it is released.</p>
    <div class="grid g3">{PRODUCTS.filter((p) => p.status === "planned").map((p) => <div class="card"><h3>{p.name} <Badge s={p.status} label="Planned" /></h3><p class="small mute">{p.blurb}</p></div>)}</div>
  </>));
});

// ── owner reports
core.get("/app/reports", async (c) => {
  need(c, "dashboard.owner");
  const d = await withT(c, (cn, ctx) => ownerDashboard(cn, ctx.tenantId));
  const bps = (b: number) => `${(b / 100).toFixed(1)}%`;
  return appPage(c, "Owner dashboard", (<>
    <PageHead title="Owner dashboard" sub={`All figures in ${d.currency}, ex-VAT unless stated. Costs not yet reconciled are estimates, not books. Generated ${formatDate(new Date())} (Asia/Dubai).`} />
    <div class="grid g4">
      <div class="card flag"><h3>Expected margin</h3><div class="kpi">{bps(d.margin.estBps)}</div><p class="small mute">Sell <Money v={d.margin.estSell} /> − expected cost <Money v={d.margin.estCost} /></p><p class="why"><a href="/app/jobs">Why this number? → jobs</a></p></div>
      <div class="card"><h3>Actual reconciled margin</h3><div class="kpi">{d.margin.reconciledJobs ? bps(d.margin.actBps) : "—"}</div><p class="small mute">{d.margin.reconciledJobs} of {d.margin.totalJobs} jobs fully reconciled. Estimated accrual outstanding: <Money v={d.margin.accrual} /></p></div>
      <div class="card"><h3>Overdue receivables</h3><div class={`kpi ${d.overdue.length ? "bad" : "good"}`}><Money v={d.overdueTotal} /></div><p class="small mute">{d.overdue.length} invoice(s). Due in next 7 days: <Money v={d.due7} />.</p><p class="why"><a href="/app/invoices?filter=overdue">Why this number? → invoices</a></p></div>
      <div class="card"><h3>Supplier exposure</h3><div class="kpi"><Money v={d.supplier.estimatedMinor} /></div><p class="small mute">{d.supplier.count} cost line(s) still estimated (not yet reconciled to a supplier invoice).</p></div>
    </div>
    <div class="grid g2" style="margin-top:20px">
      <section><Table caption="Delivered but not yet invoiced" head={["Job", "Customer", ["Unbilled", "num"]]} empty={d.unbilled.length ? undefined : "None. Everything delivered has been invoiced."}>
        {d.unbilled.map((r: any) => <tr><td><a href={`/app/jobs/${r.id}`}>{r.no}</a></td><td>{r.party}</td><td class="num"><Money v={r.amount_minor} /></td></tr>)}</Table></section>
      <section><Table caption="Overdue invoices" head={["Invoice", "Customer", "Due", ["Outstanding", "num"]]} empty={d.overdue.length ? undefined : "None overdue."}>
        {d.overdue.map((r: any) => <tr><td><a href={`/app/invoices/${r.id}`}>{r.no}</a></td><td>{r.party}</td><td>{formatDay(r.due_at)}</td><td class="num"><Money v={r.amount_minor} /></td></tr>)}</Table></section>
      <section><Table caption="Exceptions due within 48 h or overdue" head={["Exception", "Owner", "Due"]} empty={d.exceptions.length ? undefined : "No exceptions approaching deadline."}>
        {d.exceptions.map((r: any) => <tr><td><a href={r.job_id ? `/app/jobs/${r.job_id}` : "/app/tasks"}>{r.title}</a></td><td>{r.owner ?? "—"}</td><td>{formatDate(r.due_at)}</td></tr>)}</Table></section>
      <section><Table caption="Delayed milestones" head={["Job", "Milestone", "Planned"]} empty={d.delayed.length ? undefined : "No delayed milestones."}>
        {d.delayed.map((r: any) => <tr><td><a href={`/app/jobs/${r.job_id}`}>{r.no}</a></td><td>{r.label}</td><td>{formatDate(r.planned_at)}</td></tr>)}</Table></section>
      <section><Table caption="Document holds" head={["Item", "Reason"]} empty={d.holds.length ? undefined : "No document holds."}>
        {d.holds.map((r: any) => <tr><td><a href={r.job_id ? `/app/jobs/${r.job_id}` : "/app/documents"}>{r.title}</a></td><td>{r.why}</td></tr>)}</Table></section>
      <section><Table caption="Team capacity (open jobs)" head={["Person", ["Open jobs", "num"]]} empty={d.capacity.length ? undefined : "No open jobs."}>
        {d.capacity.map((r: any) => <tr><td>{r.who}</td><td class="num">{r.n}</td></tr>)}</Table></section>
    </div>
    <div class="grid g3" style="margin-top:20px">
      <div class="card"><h3>Customer concentration</h3>{d.concentration.length ? d.concentration.map((x: any) => <p style="margin:.2em 0">{x.name}: <strong>{x.pct}%</strong> of invoiced revenue</p>) : <p class="mute">No invoices yet.</p>}</div>
      <div class="card"><h3>Receivables ageing</h3><p class="small" style="margin:.2em 0">Current <Money v={d.ageing.current} /></p><p class="small" style="margin:.2em 0">1–30 days <Money v={d.ageing.d1_30} /></p><p class="small" style="margin:.2em 0">31–60 days <Money v={d.ageing.d31_60} /></p><p class="small" style="margin:.2em 0">60+ days <Money v={d.ageing.d60p} /></p></div>
      <div class="card"><h3>Subscription usage</h3>
        <p class="small" style="margin:.2em 0">Jobs this month: {d.usage.jobs} / {d.limits.jobs_per_month}</p>
        <p class="small" style="margin:.2em 0">Users: {d.usage.users} / {d.limits.max_users}</p>
        <p class="small" style="margin:.2em 0">Storage: {d.usage.storage} / {d.limits.storage_mb} MB</p>
        <p class="small" style="margin:.2em 0">Plan: {d.subscription?.plan} <Badge s={d.subscription?.status} /></p>
        {d.unsynced ? <p class="alert warn small" style="margin-top:8px">{d.unsynced} invoice(s) not yet synchronized to accounting.</p> : null}</div>
    </div>
  </>));
});

// ── customer/supplier portal (limited)
core.get("/app/portal", async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.partyId && !ctx.roles.includes("portal")) return c.redirect("/app");
  const d = await withT(c, async (cn) => ({
    jobs: await listJobs(cn, ctx.partyId), invoices: await listInvoices(cn, ctx.partyId),
    docs: await listDocuments(cn, { portalPartyId: ctx.partyId }),
    stock: ctx.partyId ? await portalStock(cn, ctx.partyId) : [],
  }));
  return appPage(c, "My shipments", (<>
    <PageHead title="My shipments" sub="A limited view: your shipments, issued documents and invoices only." />
    <Table caption="Shipments" head={["Job", "Route", "Status"]} empty={d.jobs.length ? undefined : "No shipments yet."}>
      {d.jobs.map((j: any) => <tr><td>{j.no}</td><td>{j.origin} → {j.destination}</td><td><Badge s={j.status} /></td></tr>)}</Table>
    {d.stock.length ? <><div style="height:18px" /><Table caption="Stock held for you" head={["SKU", "Description", ["On hand", "num"], ["Reserved", "num"], ["On hold", "num"]]}>
      {d.stock.map((s: any) => <tr><td>{s.sku_code}</td><td>{s.sku_desc}</td><td class="num">{Number(s.on_hand)} {s.uom}</td><td class="num">{Number(s.reserved)}</td><td class="num">{Number(s.quarantined)}</td></tr>)}</Table></> : null}
    <div style="height:18px" />
    <Table caption="Documents shared with you" head={["Document", "Job", ""]} empty={d.docs.length ? undefined : "No documents shared."}>
      {d.docs.map((x: any) => <tr><td>{x.title}</td><td>{x.job_no}</td><td><a href={`/app/documents/${x.id}/download`}>Download</a></td></tr>)}</Table>
    <div style="height:18px" />
    <Table caption="Invoices" head={["Invoice", "Due", ["Total", "num"], "Status"]} empty={d.invoices.length ? undefined : "No invoices."}>
      {d.invoices.map((x: any) => <tr><td><a href={`/app/invoices/${x.id}`}>{x.no}</a></td><td>{formatDay(x.due_at)}</td><td class="num"><Money v={x.total_minor} /></td><td><Badge s={x.status} /></td></tr>)}</Table>
  </>));
});

// ── team
core.get("/app/team", async (c) => {
  need(c, "team.manage");
  const d = await withT(c, async (cn) => ({
    team: await listTeam(cn),
    pending: (await cn.query<any>(`SELECT email, roles, expires_at FROM invitations WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`)).rows,
    customers: (await cn.query<any>(`SELECT id,name FROM parties WHERE kind='customer' ORDER BY name`)).rows,
  }));
  const limits = await withT(c, async (cn, ctx) => ({ lim: (await getLimits(cn, ctx.tenantId)).max_users, used: await currentUsage(cn, ctx.tenantId, "max_users") }));
  const csrf = c.get("csrf");
  const link = c.req.query("link");
  return appPage(c, "Team", (<>
    <PageHead title="Team" sub={`${limits.used} of ${limits.lim} full user seats used. Portal users do not use seats.`} />
    {link ? <div class="alert info"><strong>Invitation link (shown once):</strong><br /><code>{baseUrl()}/invite/{link}</code><br /><span class="small">Send it to the invitee. It expires in 7 days and creates an individual account.</span></div> : null}
    <Table head={["Name", "Email", "Roles", ""]}>
      {d.team.map((m: any) => (
        <tr><td>{m.name}{!m.active ? <> <Badge s="void" label="inactive" /></> : null}</td><td>{m.email}</td>
          <td>
            <form method="post" action="/app/team/roles" class="inline-form"><Csrf t={csrf} /><input type="hidden" name="user_id" value={m.user_id} />
              {m.roles.includes("driver") ? <span class="small mute">driver seat (managed under Transport → Fleet &amp; drivers)</span> : (<>
                {ROLES.filter((r) => r !== "driver").map((r) => <label class="small" style="display:inline-flex;gap:4px;font-weight:500;margin:0 6px 0 0"><input type="checkbox" name="roles" value={r} checked={m.roles.includes(r)} /> {r}</label>)}
                <button class="btn ghost sm" type="submit">Save</button></>)}</form>
          </td>
          <td>{m.active ? <Confirm action="/app/team/deactivate" csrf={csrf} label="Deactivate" confirm={`Deactivate ${m.name}?`} fields={{ user_id: m.user_id }} /> : null}</td></tr>
      ))}
    </Table>
    {d.pending.length ? <><h3 style="margin-top:20px">Pending invitations</h3><Table head={["Email", "Roles", "Expires"]}>{d.pending.map((i: any) => <tr><td>{i.email}</td><td>{i.roles.join(", ")}</td><td>{formatDate(i.expires_at)}</td></tr>)}</Table></> : null}
    <section class="card" style="margin-top:24px;max-width:720px"><h3>Invite someone</h3>
      <form method="post" action="/app/team/invite"><Csrf t={csrf} />
        <div class="field"><label for="ie">Email</label><input id="ie" name="email" type="email" required /></div>
        <fieldset><legend>Roles</legend><div class="checks">{ROLES.filter((r) => r !== "driver").map((r) => <label class="check"><input type="checkbox" name="roles" value={r} /><span>{r}</span></label>)}</div>
          <p class="hint">Purchasing an entitlement does not grant every staff member access: roles decide what each person can do.</p></fieldset>
        <div class="field"><label for="ip">Customer (portal role only)</label><select id="ip" name="party_id"><option value="">—</option>{d.customers.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <button class="btn red" type="submit">Create invitation</button>
      </form></section>
  </>));
});
core.post("/app/team/invite", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/team", async () => {
    const token = await withT(c, (cn, ctx) => invite(cn, ctx, { email: str(b.email), roles: arr(b.roles), party_id: str(b.party_id) || undefined }));
    return { to: `/app/team?link=${token}`, ok: "Invitation created." };
  });
});
core.post("/app/team/roles", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/team", async () => { await withT(c, (cn, ctx) => setRoles(cn, ctx, str(b.user_id), arr(b.roles))); return { to: "/app/team", ok: "Roles updated." }; });
});
core.post("/app/team/deactivate", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/team", async () => { await withT(c, (cn, ctx) => deactivate(cn, ctx, str(b.user_id))); return { to: "/app/team", ok: "User deactivated." }; });
});

// ── billing & lifecycle
core.get("/app/billing", async (c) => {
  need(c, "billing.manage");
  const ctx = ctxOf(c), db = c.get("db");
  const [plans, sub, orders, jobs] = await Promise.all([
    currentPlans(db),
    db.query<any>(`SELECT s.*, p.name AS plan, p.plan_code, sp.name AS scheduled_name FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id
      LEFT JOIN plan_versions sp ON sp.id=s.scheduled_plan_version_id WHERE s.tenant_id=$1`, [ctx.tenantId]).then((r) => r.rows[0]),
    db.query<any>(`SELECT * FROM orders WHERE tenant_id=$1 ORDER BY created_at DESC`, [ctx.tenantId]).then((r) => r.rows),
    db.query<any>(`SELECT j.*, (SELECT count(*) FROM provision_steps s WHERE s.job_id=j.id)::int AS done FROM provision_jobs j WHERE tenant_id=$1 ORDER BY queued_at DESC LIMIT 3`, [ctx.tenantId]).then((r) => r.rows),
  ]);
  const usage = await withT(c, async (cn) => ({ limits: await getLimits(cn, ctx.tenantId),
    used: { max_users: await currentUsage(cn, ctx.tenantId, "max_users"), jobs_per_month: await currentUsage(cn, ctx.tenantId, "jobs_per_month"),
      storage_mb: await currentUsage(cn, ctx.tenantId, "storage_mb"), max_branches: await currentUsage(cn, ctx.tenantId, "max_branches"),
      trips_per_month: await currentUsage(cn, ctx.tenantId, "trips_per_month"), wh_orders_per_month: await currentUsage(cn, ctx.tenantId, "wh_orders_per_month") } }));
  const quotes: Record<string, Awaited<ReturnType<typeof priceCheckout>> | null> = {};
  for (const pl of plans) quotes[pl.plan_code] = await db.system((cn) => priceCheckout(cn, ctx.tenantId, pl)).catch(() => null);
  const csrf = c.get("csrf");
  const want = c.req.query("plan");
  return appPage(c, "Plan & billing", (<>
    <PageHead title="Plan & billing" sub={`Current: ${sub.plan} · ${sub.status}${sub.period_end ? ` · renews ${formatDay(sub.period_end)}` : " · free forever"}`} />
    {sub.scheduled_name ? <div class="alert warn">Scheduled to move to <strong>{sub.scheduled_name}</strong> at renewal.</div> : null}
    {sub.cancel_at_period_end ? <div class="alert warn">Cancellation scheduled: access continues to the end of the paid period, then the workspace moves to Free.</div> : null}
    <div class="grid g3">
      <div class="card"><h3>Users</h3><div class="kpi">{usage.used.max_users} / {usage.limits.max_users}</div></div>
      <div class="card"><h3>Jobs this month</h3><div class="kpi">{usage.used.jobs_per_month} / {usage.limits.jobs_per_month}</div></div>
      <div class="card"><h3>Documents</h3><div class="kpi">{usage.used.storage_mb} / {usage.limits.storage_mb} MB</div></div>
      {c.get("tenant")!.sectors.includes("road-transport") ? <div class="card"><h3>Trips this month</h3><div class="kpi">{usage.used.trips_per_month} / {usage.limits.trips_per_month}</div></div> : null}
      {c.get("tenant")!.sectors.includes("contract-warehouse-3pl") ? <div class="card"><h3>Warehouse orders this month</h3><div class="kpi">{usage.used.wh_orders_per_month} / {usage.limits.wh_orders_per_month}</div><p class="small mute">Inbound notices + dispatch orders</p></div> : null}
    </div>
    <h2 style="margin-top:28px">Change plan</h2>
    <p class="mute small">Net incremental price shown: setup already paid at a lower tier is credited. No proration in the pilot. Tax is shown at checkout.</p>
    <div class="grid g4">
      {plans.filter((p) => p.plan_code !== "free").map((pl) => {
        const q = quotes[pl.plan_code]; const cur = pl.plan_code === sub.plan_code;
        return (
          <div class={`card plan ${want === pl.plan_code ? "hot" : ""}`}>
            <h3>{pl.name} {cur ? <Badge s="active" label="current" /> : null}</h3>
            <div class="price">{pl.contact_sales ? "From " : ""}{fmtMoney(pl.monthly_minor)}<span class="small mute"> / mo</span></div>
            {pl.contact_sales ? <p class="small mute">Scoped with our team.</p> : cur ? <p class="small mute">Your current plan.</p> : q ? <p class="small">Due now: <strong>{fmtMoney(q.subtotal)}</strong> + VAT {fmtMoney(q.tax)} = <strong>{fmtMoney(q.total)}</strong>{q.setupCredit ? <><br />Setup credit applied: {fmtMoney(q.setupCredit)}</> : null}</p> : null}
            <div style="flex:1" />
            {pl.contact_sales ? <a class="btn ghost" href="/contact">Contact sales</a> : cur ? null : (
              <>
                <PostBtn action="/app/billing/checkout" csrf={csrf} label="Upgrade / switch" cls="red" fields={{ plan: pl.plan_code }} />
                {pl.monthly_minor < (plans.find((x) => x.plan_code === sub.plan_code)?.monthly_minor ?? 0) ? <PostBtn action="/app/billing/downgrade" csrf={csrf} label="Preview & schedule at renewal" cls="ghost sm" fields={{ plan: pl.plan_code }} /> : null}
              </>)}
          </div>);
      })}
    </div>
    <div style="margin-top:16px" class="inline-form">
      {sub.plan_code !== "free" ? <><PostBtn action="/app/billing/downgrade" csrf={csrf} label="Move to Free at renewal" cls="ghost sm" fields={{ plan: "free" }} /><Confirm action="/app/billing/cancel" csrf={csrf} label="Cancel at period end" confirm="Cancel at the end of the paid period?" /></> : null}
    </div>
    <h2 style="margin-top:28px">Activation</h2>
    <Table head={["Order", "State", "Steps", "Detail"]} empty={jobs.length ? undefined : "No paid upgrade yet."}>
      {jobs.map((j: any) => <tr><td class="small">{formatDate(j.queued_at)}</td><td><Badge s={j.state} /></td><td>{j.done}/9</td><td class="small">{j.owner_action ?? j.failure_reason ?? (j.ready_at ? `Ready ${formatDate(j.ready_at)}` : "")}</td></tr>)}</Table>
    <h2 style="margin-top:28px">Orders</h2>
    <Table head={["Reference", "Date", ["Total", "num"], "Status", ""]} empty={orders.length ? undefined : "No orders."}>
      {orders.map((o: any) => <tr><td>{o.reference}</td><td>{formatDate(o.created_at)}</td><td class="num"><Money v={o.total_minor} cur={o.currency} /></td><td><Badge s={o.status} /></td>
        <td>{o.status === "pending" && config.paymentProvider === "mock" ? <a class="btn sm" href={`/app/billing/pay/${o.id}`}>Pay</a> : null}</td></tr>)}</Table>
  </>));
});
core.post("/app/billing/checkout", async (c) => {
  need(c, "billing.manage");
  const b = await formBody(c); const ctx = ctxOf(c);
  return act(c, "/app/billing", async () => {
    const r = await createOrder(c.get("db"), ctx.tenantId, ctx.userId, str(b.plan));
    // a real provider adapter would redirect to the provider-hosted session here
    return { to: `/app/billing/pay/${r.orderId}` };
  });
});
core.post("/app/billing/downgrade", async (c) => {
  need(c, "billing.manage");
  const b = await formBody(c); const ctx = ctxOf(c);
  return act(c, "/app/billing", async () => {
    const pv = await scheduleDowngrade(c.get("db"), ctx.tenantId, ctx.userId, str(b.plan));
    return { to: "/app/billing", ok: `Scheduled for renewal. ${pv.issues.length ? "Consequences: " + pv.issues.join("; ") + ". " : ""}${pv.note}` };
  });
});
core.post("/app/billing/cancel", async (c) => {
  need(c, "billing.manage");
  const ctx = ctxOf(c);
  await cancelAtPeriodEnd(c.get("db"), ctx.tenantId, ctx.userId);
  return back(c, "/app/billing", "Cancellation scheduled for the end of the paid period.");
});

// Mock checkout (development/test only): drives the same signed-webhook path a real provider would.
core.get("/app/billing/pay/:id", async (c) => {
  need(c, "billing.manage");
  if (config.paymentProvider !== "mock") throw new HttpError(404, "Not found");
  const ctx = ctxOf(c);
  const o = (await c.get("db").query<any>(`SELECT o.*, p.name AS plan FROM orders o JOIN plan_versions p ON p.id=o.plan_version_id WHERE o.id=$1 AND o.tenant_id=$2`, [c.req.param("id"), ctx.tenantId])).rows[0];
  if (!o) throw new HttpError(404, "Order not found");
  const csrf = c.get("csrf");
  return appPage(c, "Checkout", (
    <div class="card" style="max-width:640px">
      <div class="alert warn"><strong>Simulated payment provider (non-production).</strong> Access is granted only by the server-verified webhook this page triggers — never by this redirect.</div>
      <h1>Checkout · {o.plan}</h1>
      <Table head={["Item", ["Amount", "num"]]}>
        {o.lines.map((l: any) => <tr><td>{l.label}</td><td class="num"><Money v={l.amount_minor} cur={o.currency} /></td></tr>)}
        <tr><td>VAT</td><td class="num"><Money v={o.tax_minor} cur={o.currency} /></td></tr>
        <tr><th>Total payable</th><th class="num"><Money v={o.total_minor} cur={o.currency} /></th></tr>
      </Table>
      <p class="small mute">{o.tax_note}</p>
      <p class="small">Reference <code>{o.reference}</code> · status <Badge s={o.status} /></p>
      {o.status === "pending" ? (
        <div class="inline-form">
          <PostBtn action={`/app/billing/pay/${o.id}`} csrf={csrf} label="Simulate successful payment" cls="red" fields={{ outcome: "success" }} />
          <PostBtn action={`/app/billing/pay/${o.id}`} csrf={csrf} label="Simulate failed payment" cls="ghost" fields={{ outcome: "failed" }} />
        </div>) : <a class="btn" href="/app/billing">Back to billing</a>}
    </div>));
});
core.post("/app/billing/pay/:id", async (c) => {
  need(c, "billing.manage");
  if (config.paymentProvider !== "mock") throw new HttpError(404, "Not found");
  const ctx = ctxOf(c), b = await formBody(c), db = c.get("db");
  const o = (await db.query<any>(`SELECT * FROM orders WHERE id=$1 AND tenant_id=$2`, [c.req.param("id"), ctx.tenantId])).rows[0];
  if (!o) throw new HttpError(404, "Order not found");
  const raw = JSON.stringify(buildMockEvent(o, str(b.outcome) === "failed" ? "payment.failed" : "payment.succeeded"));
  const r = await handlePaymentWebhook(db, "mock", raw, signPayload(raw));
  if (r.status !== 200) return back(c, "/app/billing", undefined, `Payment was not applied (${(r.body as any).reason ?? (r.body as any).error}).`);
  await processProvisioningQueue(db);
  return back(c, "/app/billing", str(b.outcome) === "failed" ? "Payment failed. No changes were made." : "Payment verified. Your workspace is being activated.");
});

// ── settings
core.get("/app/settings", async (c) => {
  need(c, "settings.manage");
  const ctx = ctxOf(c), db = c.get("db"), t = c.get("tenant")!;
  const d = await withT(c, async (cn) => ({
    ent: (await cn.query<any>(`SELECT * FROM entities ORDER BY created_at LIMIT 1`)).rows[0],
    branches: (await cn.query<any>(`SELECT * FROM branches ORDER BY name`)).rows,
    domains: (await cn.query<any>(`SELECT * FROM domain_mappings ORDER BY created_at`)).rows,
    limits: await getLimits(cn, ctx.tenantId),
  }));
  const grants = (await db.query<any>(`SELECT g.*, u.name AS staff FROM support_grants g JOIN users u ON u.id=g.staff_user_id WHERE g.tenant_id=$1 ORDER BY requested_at DESC LIMIT 10`, [ctx.tenantId])).rows;
  const csrf = c.get("csrf");
  return appPage(c, "Settings", (<>
    <PageHead title="Settings" />
    <div class="grid g2">
      <section class="card"><h3>Legal entity & finance</h3>
        <form method="post" action="/app/settings/entity"><Csrf t={csrf} />
          <div class="field"><label for="ln">Legal name</label><input id="ln" name="legal_name" type="text" value={d.ent.legal_name ?? ""} /><div class="hint">Minimum setup information for paid activation.</div></div>
          <div class="field"><label for="tx">Tax registration number</label><input id="tx" name="tax_id" type="text" value={d.ent.tax_id ?? ""} /></div>
          <div class="row"><div class="field"><label for="pf">Invoice prefix</label><input id="pf" name="invoice_prefix" type="text" value={d.ent.invoice_prefix} maxlength={6} pattern="[A-Za-z0-9]{2,6}" /></div>
            <div class="field"><label for="mt">Margin approval threshold (%)</label><input id="mt" name="margin_pct" type="number" step="0.1" min="0" max="90" value={String(d.ent.margin_threshold_bps / 100)} /></div></div>
          <button class="btn" type="submit">Save</button></form></section>
      <section class="card"><h3>Sectors</h3><p class="hint">Your plan includes {d.limits.max_sectors} sector(s).</p>
        <form method="post" action="/app/settings/sectors"><Csrf t={csrf} />
          <div class="checks" style="grid-template-columns:1fr">{SECTORS.map((s) => <label class="check"><input type="checkbox" name="sector" value={s.slug} checked={t.sectors.includes(s.slug)} /><span>{s.name} <Badge s={s.availability} /></span></label>)}</div>
          <button class="btn" style="margin-top:10px" type="submit">Save sectors</button></form></section>
      <section class="card"><h3>Branches</h3>
        {d.branches.length ? <ul>{d.branches.map((b: any) => <li>{b.name} {b.city ? `· ${b.city}` : ""}</li>)}</ul> : <p class="mute">No branches yet.</p>}
        <form method="post" action="/app/settings/branch" class="inline-form"><Csrf t={csrf} /><input name="name" type="text" placeholder="Branch name" required /><input name="city" type="text" placeholder="City" /><button class="btn ghost sm" type="submit">Add branch</button></form></section>
      <section class="card"><h3>Domains</h3>
        <Table head={["Hostname", "Kind", "Status", ""]}>
          {d.domains.filter((x: any) => x.status !== "removed").map((m: any) => (
            <tr><td>{m.hostname}</td><td>{m.kind}</td><td><Badge s={m.status} />{m.status === "pending_verification" ? <div class="small mute">Publish TXT <code>_loadbyton.{m.hostname}</code> = <code>{m.verify_token}</code></div> : null}</td>
              <td>{m.status === "pending_verification" ? <PostBtn action="/app/settings/domain/verify" csrf={csrf} label="Verify" fields={{ id: m.id }} /> : null}
                {m.kind === "custom" ? <Confirm action="/app/settings/domain/remove" csrf={csrf} label="Remove" confirm="Remove this domain mapping?" fields={{ id: m.id }} /> : null}</td></tr>))}
        </Table>
        <p class="hint">The standard subdomain keeps working while a custom domain is set up. Hostnames only select a workspace; access always needs your login.</p>
        <form method="post" action="/app/settings/domain" class="inline-form"><Csrf t={csrf} /><input name="hostname" type="text" placeholder="track.yourcompany.com" required /><button class="btn ghost sm" type="submit">Request custom domain</button></form></section>
      <section class="card"><h3>Support access requests</h3>
        {grants.length ? <Table head={["Staff", "Reason", "Status", ""]}>{grants.map((g: any) => (
          <tr><td>{g.staff}</td><td class="small">{g.reason}</td><td><Badge s={g.status} />{g.expires_at ? <div class="small mute">until {formatDate(g.expires_at)}</div> : null}</td>
            <td>{g.status === "requested" ? <><PostBtn action="/app/settings/grant" csrf={csrf} label="Approve 4 h" fields={{ id: g.id, decision: "approve" }} /><PostBtn action="/app/settings/grant" csrf={csrf} label="Deny" cls="ghost sm" fields={{ id: g.id, decision: "deny" }} /></> : null}</td></tr>))}</Table> : <p class="mute">No requests. Staff can only see your data after you approve a time-limited, read-only grant.</p>}</section>
      <section class="card"><h3>Your data</h3><p>Export is available on every plan.</p>
        <p><a class="btn ghost sm" href="/app/export.json">Export all data (JSON)</a> <a class="btn ghost sm" href="/app/export/invoices.csv">Invoices (CSV)</a></p></section>
    </div>
  </>));
});
core.post("/app/settings/entity", async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  return act(c, "/app/settings", async () => {
    const prefix = str(b.invoice_prefix).trim().toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(prefix)) throw badRequest("Invoice prefix must be 2–6 letters/digits.");
    const pct = Number(str(b.margin_pct));
    if (!(pct >= 0 && pct <= 90)) throw badRequest("Margin threshold must be between 0 and 90.");
    await withT(c, async (cn, ctx) => {
      await cn.query(`UPDATE entities SET legal_name=$1, tax_id=$2, invoice_prefix=$3, margin_threshold_bps=$4 WHERE id=(SELECT id FROM entities ORDER BY created_at LIMIT 1)`,
        [str(b.legal_name).trim() || null, str(b.tax_id).trim() || null, prefix, Math.round(pct * 100)]);
      await audit(cn, ctx.tenantId, actorOf(ctx), "settings.entity_updated", "entity");
    });
    await releaseInformationPending(c.get("db"), ctxOf(c).tenantId);
    return { to: "/app/settings", ok: "Saved." };
  });
});
core.post("/app/settings/sectors", async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  return act(c, "/app/settings", async () => { await withT(c, (cn, ctx) => setSectors(cn, ctx.tenantId, arr(b.sector), ctx.userId)); return { to: "/app/settings", ok: "Sectors updated." }; });
});
core.post("/app/settings/branch", async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  return act(c, "/app/settings", async () => {
    await withT(c, async (cn, ctx) => {
      await assertCapacity(cn, ctx.tenantId, "max_branches");
      const e = (await cn.query<any>(`SELECT id FROM entities ORDER BY created_at LIMIT 1`)).rows[0];
      if (!str(b.name).trim()) throw badRequest("Branch name is required.");
      await cn.query(`INSERT INTO branches(tenant_id,entity_id,name,city) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, e.id, str(b.name).trim().slice(0, 120), str(b.city).trim().slice(0, 120) || null]);
    });
    return { to: "/app/settings", ok: "Branch added." };
  });
});
core.post("/app/settings/domain", async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c), ctx = ctxOf(c);
  return act(c, "/app/settings", async () => { await requestCustomDomain(c.get("db"), ctx.tenantId, ctx.userId, str(b.hostname)); return { to: "/app/settings", ok: "Domain requested. Publish the TXT record, then verify." }; });
});
core.post("/app/settings/domain/verify", async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c), ctx = ctxOf(c);
  return act(c, "/app/settings", async () => {
    await verifyCustomDomain(c.get("db"), ctx.tenantId, str(b.id), async (h) => (await dns.resolveTxt(h).catch(() => [])).map((x) => x.join("")));
    return { to: "/app/settings", ok: "Domain verified." };
  });
});
core.post("/app/settings/domain/remove", async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c), ctx = ctxOf(c);
  await removeDomain(c.get("db"), ctx.tenantId, ctx.userId, str(b.id));
  return back(c, "/app/settings", "Domain mapping removed.");
});
core.post("/app/settings/grant", async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c), ctx = ctxOf(c);
  return act(c, "/app/settings", async () => { await decideGrant(c.get("db"), ctx.tenantId, ctx.userId, str(b.id), str(b.decision) === "approve", 4); return { to: "/app/settings", ok: "Decision recorded." }; });
});

// ── audit + export
core.get("/app/audit", async (c) => {
  need(c, "audit.read");
  const rows = await withT(c, async (cn) => (await cn.query<any>(`SELECT a.*, u.name AS who FROM audit_log a LEFT JOIN team_members u ON u.user_id=a.actor_user_id ORDER BY a.id DESC LIMIT 300`)).rows);
  return appPage(c, "Audit trail", (<>
    <PageHead title="Audit trail" sub="Append-only. Newest 300 events." />
    <Table head={["When", "Who", "Kind", "Action", "Record"]}>
      {rows.map((r: any) => <tr><td class="nowrap small">{formatDate(r.at)}</td><td>{r.who ?? "—"}</td><td><Badge s={r.actor_kind === "user" ? "info" : "warn"} label={r.actor_kind.replace("_", " ")} /></td><td>{r.action}</td><td class="small mute">{r.entity_type} {String(r.entity_id ?? "").slice(0, 8)}</td></tr>)}
    </Table>
  </>));
});
core.get("/app/export.json", async (c) => {
  const out = await withT(c, (cn, ctx) => exportTenantData(cn, ctx));
  c.header("Content-Disposition", `attachment; filename="loadbyton-export-${new Date().toISOString().slice(0, 10)}.json"`);
  c.header("Content-Type", "application/json");
  return c.body(JSON.stringify(out, null, 1));
});
core.get("/app/export/invoices.csv", async (c) => {
  const csv = await withT(c, (cn, ctx) => invoicesCsv(cn, ctx));
  c.header("Content-Disposition", `attachment; filename="invoices-${new Date().toISOString().slice(0, 10)}.csv"`);
  c.header("Content-Type", "text/csv; charset=utf-8");
  return c.body(csv);
});
