import { Hono } from "hono";
import { config } from "../config.js";
import { HttpError, formatDate } from "../lib/util.js";
import { sectorBySlug, withLiveAvailability } from "../platform/catalog.js";
import { releasedSectors } from "../platform/readiness.js";
import {
  REQUEST_CATEGORIES, STATUS_LABEL, cancelOwnRequest, clockOf, createRequest, humanLeft, listAllRequests, listRequests, requestDetail, staffUpdateRequest,
  type ServiceRequest,
} from "../platform/requests.js";
import { act, appPage, ctxOf, withT } from "./appkit.js";
import { AuthFrame, Icon } from "./experience.js";
import { CtaBand, PHOTO, PageHero, Section, sectorPhoto } from "./site-kit.js";
import { CONTACT, waLink } from "./brand.js";
import { arr, formBody, requireStaff, str, type C, type Env } from "./mw.js";
import { AdminShell, Badge, Csrf, PublicShell, Table, type Page } from "./ui.js";
import { back } from "./appkit.js";

export const requests = new Hono<Env>();

const pubPg = (c: C, title: string, extra: Partial<Page> = {}): Page => ({
  title, csrf: c.get("csrf"), path: c.req.path, user: c.get("session") ? { name: c.get("session")!.name } : null,
  ok: c.req.query("ok"), err: c.req.query("err"), heroDark: true, ...extra,
});
const HOURS = () => config.deliveryHours;

// ───────── shared pieces
export const CATEGORY_POINTS: Record<"free" | "paid", string[]> = {
  free: [
    "One sector pack from the demo, customised to your fields, branding and document layouts",
    `Delivered within ${config.deliveryHours} hours of a complete request`,
    "Hand-off package you run on your own backend",
    "No usage dashboard, metering or subscription from us",
  ],
  paid: [
    "Several sectors combined, integrations, or a bespoke workflow",
    "We read your requirement and quote the build before work starts",
    `Delivered within ${config.deliveryHours} hours of the agreed quote`,
    "Same hand-off model: your backend, your data, no recurring usage fees",
  ],
};

const Clock = ({ r }: { r: Pick<ServiceRequest, "status" | "due_at" | "delivered_at" | "category" | "quote_note"> }) => {
  const k = clockOf(r);
  if (k.open && k.awaitingQuote) return <span class="badge warn">Awaiting quote</span>;
  if (!k.open) return r.status === "delivered" ? <span class={`badge ${k.late ? "warn" : "ok"}`}>{k.late ? "Delivered late" : "Delivered on time"}</span> : null;
  return <span class={`badge ${k.late ? "bad" : "info"}`}>{k.late ? `Overdue by ${humanLeft(k.msLeft)}` : `${humanLeft(k.msLeft)} left`}</span>;
};
/** Paid work has no deadline until the quote is agreed. */
const dueText = (r: Pick<ServiceRequest, "status" | "due_at" | "category" | "quote_note">) =>
  clockOf({ ...r, delivered_at: null }).awaitingQuote ? `${HOURS()}-hour clock starts when the quote is agreed` : `due ${formatDate(r.due_at)}`;
const StatusBadge = ({ s }: { s: ServiceRequest["status"] }) => <Badge s={s === "in_build" ? "provisioning" : s} label={STATUS_LABEL[s]} />;

/** Sector choice and requirement fields, shared by registration and the dashboard. */
async function RequestFields({ c, pre = [], category = "free" }: { c: C; pre?: string[]; category?: string }) {
  const sectors = withLiveAvailability(await releasedSectors(c.get("db")));
  const built = sectors.filter((s) => sectorBySlug(s.slug)!.availability !== "planned");
  const bespoke = sectors.filter((s) => sectorBySlug(s.slug)!.availability === "planned");
  return (<>
    <fieldset><legend>1 · Category</legend>
      <div class="grid g2">
        {(["free", "paid"] as const).map((k) => (
          <label class="card check" style="cursor:pointer;align-items:flex-start">
            <input type="radio" name="category" value={k} checked={category === k} required />
            <span><strong>{REQUEST_CATEGORIES[k].label}</strong><br /><span class="small mute">{REQUEST_CATEGORIES[k].blurb}</span>
              <ul class="small" style="margin:8px 0 0;padding-left:18px">{CATEGORY_POINTS[k].map((x) => <li>{x}</li>)}</ul></span>
          </label>))}
      </div>
    </fieldset>
    <fieldset class="sector-picker"><legend>2 · Sector(s) from the demo</legend>
      <p class="hint">Free covers one sector. Combine sectors under Paid.</p>
      <div class="checks">{built.map((s) => (
        <label class="check"><input type="checkbox" name="sector" value={s.slug} checked={pre.includes(s.slug)} /><span>{s.name}<br /><span class="small mute">{s.availability === "available" ? "Available" : "Pilot"} · <a href={`/sectors/${s.slug}`} target="_blank" rel="noopener">see profile</a></span></span></label>))}</div>
      <p class="hint" style="margin-top:14px">Bespoke sectors (not in the demo yet — Paid only):</p>
      <div class="checks">{bespoke.map((s) => (
        <label class="check"><input type="checkbox" name="sector" value={s.slug} checked={pre.includes(s.slug)} /><span>{s.name}<br /><span class="small mute">Bespoke build</span></span></label>))}</div>
    </fieldset>
    <fieldset><legend>3 · What should we customise?</legend>
      <div class="field"><label for="rq-title">Short title</label><input id="rq-title" name="title" type="text" required minlength={3} maxlength={160} placeholder="e.g. Freight pack with our quote layout and AED/USD invoicing" /></div>
      <div class="field"><label for="rq-req">Your requirement</label><textarea id="rq-req" name="requirements" required minlength={10} maxlength={6000} rows={6} placeholder="Fields, statuses, documents, approvals, branding and any workflow that differs from the demo."></textarea></div>
      <div class="field"><label for="rq-be">Your backend (optional)</label><textarea id="rq-be" name="backend_notes" maxlength={1500} rows={3} placeholder="Stack, database, hosting and any API we should integrate with. You run the delivered system yourself."></textarea>
        <div class="hint">We hand over a system that fits your backend. We do not host it or meter your usage.</div></div>
      <label class="check"><input type="checkbox" name="demo_reviewed" value="yes" required /><span>I have seen the demo and chose the sector(s) above from it.</span></label>
    </fieldset>
  </>);
}

export const parseRequest = (b: Record<string, any>) => ({
  category: str(b.category), sectors: arr(b.sector), title: str(b.title), requirements: str(b.requirements), backendNotes: str(b.backend_notes), demoReviewed: str(b.demo_reviewed) === "yes",
});

// ───────── public: demo
requests.get("/demo", async (c) => {
  const all = withLiveAvailability(await releasedSectors(c.get("db")));
  const live = all.filter((s) => sectorBySlug(s.slug)!.availability !== "planned");
  const bespoke = all.filter((s) => sectorBySlug(s.slug)!.availability === "planned");
  return c.html(
    <PublicShell p={pubPg(c, "See the demo", { description: "Walk through the working sector packs, then tell us what to customise. Delivered within 24 hours." })}>
      <PageHero kicker="DEMO" photo={PHOTO.intelligence} title={<>See it first.<br />Then tell us what to change.</>} lede={`Browse the working packs below. Register what you need and we customise it, then hand it over within ${HOURS()} hours.`}>
        {config.demoUrl ? <a class="btn red" href={config.demoUrl} target="_blank" rel="noopener">Open the live demo <Icon name="arrowUpRight" size={16} /></a> : null}
        <a class="btn glass" href="/start">Register my requirement</a>
      </PageHero>
      <Section eyebrow="WORKING PACKS" title={<>What the demo covers.</>} intro="Each pack is a complete workflow. Pick one for a free build, or combine several as a paid build.">
        <div class="grid g3">{live.map((s) => (
          <a class="sector-card" href={`/start?sector=${s.slug}`} data-reveal>
            <span class="sc-photo"><img src={sectorPhoto(s.slug, true)} alt="" width="800" height="450" loading="lazy" decoding="async" /></span>
            <span class="sc-body"><span class="badge ok">Working demo</span><h3>{s.name}</h3><p>{s.workflow}</p><span class="go">Request this pack <Icon name="arrow" size={14} /></span></span>
          </a>))}</div>
      </Section>
      <Section tone="tint" eyebrow={`MORE SECTORS · ${live.length + bespoke.length} IN ALL`} title={<>The other {bespoke.length} sectors, built to order.</>} intro="These sector packs are not in the working demo yet. Register a Paid build and we scope, quote and deliver it, with the same shared customer, finance and document records.">
        <div class="grid g3">{bespoke.map((s) => (
          <a class="sector-card" href={`/start?category=paid&sector=${s.slug}`} data-reveal>
            <span class="sc-photo"><img src={sectorPhoto(s.slug, true)} alt="" width="800" height="450" loading="lazy" decoding="async" /></span>
            <span class="sc-body"><span class="badge info">Built to order</span><h3>{s.name}</h3><p>{s.workflow}</p><span class="go">Request a paid build <Icon name="arrow" size={14} /></span></span>
          </a>))}</div>
        {config.demoUrl ? null : <p class="mute small" style="margin-top:24px">A guided walkthrough of the demo is arranged on request — <a href="/contact">ask for a demo link</a> or <a href={waLink()} target="_blank" rel="noopener">WhatsApp {CONTACT.phoneDisplay}</a>.</p>}
      </Section>
      <Section eyebrow="HOW IT WORKS" title={<>Four steps. No usage meter.</>}>
        <ol class="steps" style="list-style:none;margin:0;padding:0;max-width:820px">
          {[
            ["See the demo", "Open the packs and decide what fits."],
            ["Register your requirement", "Choose Free or Paid, the sector(s), and describe what to customise."],
            [`We deliver within ${HOURS()} hours`, "Free: from submission. Paid: from the agreed quote. Track it in your dashboard; you get a hand-off link and notes."],
            ["Run it on your backend", "It is yours to host. We do not meter, bill or watch your usage."],
          ].map(([t, d], i) => <li class="step" data-reveal><span class="n">0{i + 1}</span><div><p style="color:var(--ink);margin:0"><strong>{t}</strong> — {d}</p></div></li>)}
        </ol>
      </Section>
      <CtaBand title={<>Seen enough?<br />Tell us what you need.</>} body={`Register a request. Free builds start the ${HOURS()}-hour clock at once; paid builds start it when you agree the quote.`} primary={["Register my requirement", "/start"]} />
    </PublicShell>);
});

// ───────── public: free vs paid (replaces the plan/usage price table in brochure mode)
export async function brochurePricing(c: C) {
  return c.html(
    <PublicShell p={pubPg(c, "Free and paid builds")}>
      <PageHero kicker="CATEGORIES" photo={PHOTO.finance} title={<>Free build.<br />Paid build.</>} lede={`Both are customised to your requirement and delivered within ${HOURS()} hours. You run the result on your own backend.`} />
      <Section>
        <div class="grid g2">
          {(["free", "paid"] as const).map((k) => (
            <div class={`card plan spot ${k === "free" ? "hot" : ""}`} data-reveal>
              <h3>{REQUEST_CATEGORIES[k].label}</h3>
              <p class="mute">{REQUEST_CATEGORIES[k].blurb}</p>
              <ul>{CATEGORY_POINTS[k].map((x) => <li>{x}</li>)}</ul>
              <a class={`btn ${k === "free" ? "red" : ""}`} href={`/start?category=${k}`}>{k === "free" ? "Register a free build" : "Request a paid build"}</a>
            </div>))}
        </div>
        <div class="prose" style="margin-top:40px">
          <h2>What we do not do</h2>
          <ul>
            <li>We do not host your system, run a usage dashboard, or meter or bill what you do with it.</li>
            <li>We do not hold your customers' data — it lives on the backend you run.</li>
            <li>Paid builds are quoted per requirement; the quote is agreed before the build starts and recorded on your request.</li>
          </ul>
          <p>The delivery window runs from a complete Free request, or from the agreed quote for Paid. Missing information pauses the clock; we will tell you what we need.</p>
        </div>
      </Section>
      <CtaBand title={<>Not sure which?<br />Start with the demo.</>} primary={["See the demo", "/demo"]} />
    </PublicShell>);
}

// ───────── public: register (account + first request)
export async function brochureStartPage(c: C) {
  const pre = new URL(c.req.url).searchParams.getAll("sector");
  const category = c.req.query("category") === "paid" ? "paid" : "free";
  const p = pubPg(c, "Register your requirement", { quiet: true });
  return c.html(
    <PublicShell p={p}>
      <AuthFrame signup>
        <span class="eyebrow">REGISTER YOUR REQUIREMENT</span>
        <h1>Tell us what to build</h1>
        <p>Pick Free or Paid, choose from the demo and describe what to change. A free build is delivered within {HOURS()} hours of submitting. A paid build is quoted first and the {HOURS()}-hour clock starts when you agree the quote. You will get a dashboard to track it.</p>
        {p.err ? <div class="alert err" role="alert"><Icon name="alert" /><span><strong>Problem.</strong> {p.err}</span></div> : null}
        <form method="post" action="/start" class="signup-form">
          <Csrf t={p.csrf} />
          <fieldset><legend>Your company</legend>
            <div class="row">
              <div class="field"><label for="company">Company name</label><input id="company" name="company" type="text" required autocomplete="organization" /></div>
              <div class="field"><label for="contact">Your name</label><input id="contact" name="contact" type="text" required autocomplete="name" /></div>
            </div>
            <div class="row">
              <div class="field"><label for="email">Work email</label><input id="email" name="email" type="email" required autocomplete="email" /></div>
              <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" required minlength={10} autocomplete="new-password" /><div class="hint">At least 10 characters. Used to sign in to your dashboard.</div></div>
            </div>
          </fieldset>
          {await RequestFields({ c, pre, category })}
          <p class="small mute">By registering you agree to the <a href="/legal/terms">Terms</a> and acknowledge the <a href="/legal/privacy">Privacy notice</a>.</p>
          <button class="btn red" type="submit">Submit my request</button>
        </form>
        <p class="small">Already registered? <a href="/login">Sign in</a>.</p>
      </AuthFrame>
    </PublicShell>);
}

// ───────── client: dashboard (the /app landing page in brochure mode)
const RequestCard = ({ r, csrf }: { r: ServiceRequest; csrf: string }) => (
  <article class="card" data-reveal>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between">
      <h3 style="margin:0"><a href={`/app/requests/${r.id}`}>{r.title}</a></h3>
      <span style="display:flex;gap:8px;flex-wrap:wrap"><Badge s={r.category === "paid" ? "pending" : "available"} label={REQUEST_CATEGORIES[r.category].label} /><StatusBadge s={r.status} /><Clock r={r} /></span>
    </div>
    <p class="small mute" style="margin:8px 0">{r.sectors.map((s) => sectorBySlug(s)?.name ?? s).join(", ")} · submitted {formatDate(r.created_at)} · {dueText(r)}</p>
    {r.status === "delivered" ? <p>{r.delivery_url ? <a class="btn red sm" href={r.delivery_url} target="_blank" rel="noopener">Open hand-off <Icon name="arrowUpRight" size={14} /></a> : null} {r.delivery_notes ? <span class="small">See delivery notes</span> : null}</p> : null}
    {["received", "in_build"].includes(r.status) ? (
      <form method="post" action={`/app/requests/${r.id}/cancel`} data-confirm="Cancel this request?" class="inline"><Csrf t={csrf} /><button class="btn ghost sm" type="submit">Cancel request</button></form>) : null}
  </article>
);

export async function brochureDashboard(c: C) {
  const rows = await withT(c, (cn) => listRequests(cn));
  const open = rows.filter((r) => ["received", "in_build", "ready"].includes(r.status));
  const closed = rows.filter((r) => !open.includes(r));
  const csrf = c.get("csrf");
  return appPage(c, "Your requests", (<>
    <header class="page"><div><h1>Your requests</h1><p class="mute small" style="margin:.2em 0 0">We customise the demo to your requirement and hand it over within {HOURS()} hours. You run it on your own backend — there is no usage dashboard or billing from us.</p></div></header>
    {open.length ? <div class="grid" style="gap:16px">{open.map((r) => <RequestCard r={r} csrf={csrf} />)}</div>
      : <div class="card"><h3>No open requests</h3><p class="mute">Register what you need below, or <a href="/demo">revisit the demo</a>.</p></div>}
    <details class="card" style="margin-top:24px" open={!rows.length}>
      <summary><strong>Register a new requirement</strong></summary>
      <form method="post" action="/app/requests" class="signup-form" style="margin-top:16px">
        <Csrf t={csrf} />
        {await RequestFields({ c })}
        <button class="btn red" type="submit">Submit request</button>
      </form>
    </details>
    {closed.length ? <><h2 style="margin-top:32px">Earlier requests</h2><div class="grid" style="gap:16px">{closed.map((r) => <RequestCard r={r} csrf={csrf} />)}</div></> : null}
    <p class="small mute" style="margin-top:28px">Questions? <a href={`mailto:${CONTACT.emails.support}`}>{CONTACT.emails.support}</a> or <a href={waLink()} target="_blank" rel="noopener">WhatsApp {CONTACT.phoneDisplay}</a>.</p>
  </>));
}

requests.post("/app/requests", async (c) => {
  const ctx = ctxOf(c), b = await formBody(c);
  return act(c, "/app", async () => {
    const r = await withT(c, (cn) => createRequest(cn, ctx.tenantId, ctx.userId, parseRequest(b)));
    return { to: `/app/requests/${r.id}`, ok: r.category === "paid" ? "Request received. We will send you a quote; delivery follows within " + HOURS() + " hours of agreeing it." : `Request received. Delivery is due within ${HOURS()} hours.` };
  });
});

requests.get("/app/requests/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Request not found", "not_found");
  const { request: r, events } = await withT(c, (cn) => requestDetail(cn, id));
  return appPage(c, r.title, (<>
    <header class="page"><div><h1>{r.title}</h1><p class="mute small" style="margin:.2em 0 0">{REQUEST_CATEGORIES[r.category].label} · {r.sectors.map((s) => sectorBySlug(s)?.name ?? s).join(", ")}</p></div><div class="spacer"></div><span style="display:flex;gap:8px"><StatusBadge s={r.status} /><Clock r={r} /></span></header>
    <div class="grid g2">
      <section class="card"><h3>Your requirement</h3><p style="white-space:pre-wrap">{r.requirements}</p>
        {r.backend_notes ? <><h3>Your backend</h3><p style="white-space:pre-wrap">{r.backend_notes}</p></> : null}</section>
      <section class="card"><h3>Delivery</h3>
        <p class="small mute">Submitted {formatDate(r.created_at)} · {dueText(r)}{r.delivered_at ? ` · delivered ${formatDate(r.delivered_at)}` : ""}</p>
        {r.quote_note ? <p><strong>Agreed quote:</strong> {r.quote_note}</p> : null}
        {r.status === "delivered" ? (<>
          {r.delivery_url ? <p><a class="btn red" href={r.delivery_url} target="_blank" rel="noopener">Open hand-off <Icon name="arrowUpRight" size={16} /></a></p> : null}
          {r.delivery_notes ? <p style="white-space:pre-wrap">{r.delivery_notes}</p> : null}
        </>) : <p class="mute">The hand-off link and notes appear here when your build is delivered.</p>}
      </section>
    </div>
    <h2 style="margin-top:26px">Timeline</h2>
    <ol class="stages">{events.map((e: any) => <li><strong>{STATUS_LABEL[e.status as ServiceRequest["status"]]}</strong> <span class="small mute">{formatDate(e.at)} · {e.actor_kind}</span>{e.note ? <div class="small">{e.note}</div> : null}</li>)}</ol>
    <p><a href="/app">← All requests</a></p>
  </>));
});

requests.post("/app/requests/:id/cancel", async (c) => {
  const ctx = ctxOf(c), id = c.req.param("id");
  return act(c, "/app", async () => { await withT(c, (cn) => cancelOwnRequest(cn, ctx.tenantId, ctx.userId, id)); return { to: "/app", ok: "Request cancelled." }; });
});

// ───────── staff: delivery queue
requests.use("/admin/requests", requireStaff);
requests.use("/admin/requests/*", requireStaff);
const adminPg = (c: C, title: string): Page => ({ title, csrf: c.get("csrf"), path: c.req.path, user: { name: c.get("session")!.name }, ok: c.req.query("ok"), err: c.req.query("err") });

requests.get("/admin/requests", async (c) => {
  const scope = c.req.query("scope") === "all" ? "all" : "open";
  const rows = await listAllRequests(c.get("db"), scope);
  const csrf = c.get("csrf");
  const late = rows.filter((r) => clockOf(r).late).length;
  return c.html(
    <AdminShell p={adminPg(c, "Build requests")}>
      <header class="page"><h1>Build requests</h1><div class="spacer"></div><a class="btn ghost sm" href={scope === "open" ? "/admin/requests?scope=all" : "/admin/requests"}>{scope === "open" ? "Show all" : "Show open only"}</a></header>
      <p class="small mute">{rows.length} shown · <strong class={late ? "bad" : "good"}>{late} overdue</strong>. Sorted by delivery deadline.</p>
      <Table head={["Client", "Category", "Sectors", "Status", "Clock", "Work it"]} empty="No requests.">
        {rows.map((r) => (
          <tr>
            <td><strong>{r.tenant_name}</strong><br /><span class="small mute">{r.contact_name} · {r.contact_email}</span><br /><span class="small">{r.title}</span></td>
            <td><Badge s={r.category === "paid" ? "pending" : "available"} label={REQUEST_CATEGORIES[r.category].label} /></td>
            <td class="small">{r.sectors.map((s) => sectorBySlug(s)?.name ?? s).join(", ")}</td>
            <td><StatusBadge s={r.status} /></td>
            <td><Clock r={r} /><br /><span class="small mute">{dueText(r)}</span></td>
            <td>
              <details><summary class="small">Requirement &amp; update</summary>
                <p class="small" style="white-space:pre-wrap;max-width:420px">{r.requirements}{r.backend_notes ? `\n\nBackend: ${r.backend_notes}` : ""}</p>
                {["received", "in_build", "ready"].includes(r.status) ? (
                  <form method="post" action={`/admin/requests/${r.id}`}>
                    <Csrf t={csrf} />
                    <div class="field"><label>Status</label><select name="status">{(["received", "in_build", "ready", "delivered", "cancelled"] as const).map((s) => <option value={s} selected={s === r.status}>{STATUS_LABEL[s]}</option>)}</select></div>
                    {r.category === "paid" ? <div class="field"><label>Agreed quote / commercial note</label><input name="quote_note" type="text" maxlength={1000} value={r.quote_note ?? ""} /></div> : null}
                    <div class="field"><label>Hand-off link (https)</label><input name="delivery_url" type="url" maxlength={500} value={r.delivery_url ?? ""} /></div>
                    <div class="field"><label>Delivery notes (setup, credentials channel, docs)</label><textarea name="delivery_notes" rows={3} maxlength={4000}>{r.delivery_notes ?? ""}</textarea></div>
                    <div class="field"><label>Note on the timeline</label><input name="note" type="text" maxlength={1000} /></div>
                    <button class="btn sm" type="submit">Save</button>
                  </form>) : null}
              </details>
            </td>
          </tr>))}
      </Table>
    </AdminShell>);
});

requests.post("/admin/requests/:id", async (c) => {
  const b = await formBody(c), s = c.get("session")!;
  try {
    await staffUpdateRequest(c.get("db"), { userId: s.userId, role: s.staffRole }, c.req.param("id"), {
      status: str(b.status), note: str(b.note), quoteNote: str(b.quote_note), deliveryUrl: str(b.delivery_url), deliveryNotes: str(b.delivery_notes),
    });
    return back(c, "/admin/requests", "Request updated.");
  } catch (e) { if (e instanceof HttpError && e.status < 500) return back(c, "/admin/requests", undefined, e.message); throw e; }
});
