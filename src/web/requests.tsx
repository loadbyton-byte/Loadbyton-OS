import { Hono } from "hono";
import { config } from "../config.js";
import { HttpError, fmtMoney, formatDate } from "../lib/util.js";
import { sectorBySlug, withLiveAvailability } from "../platform/catalog.js";
import { releasedSectors } from "../platform/readiness.js";
import {
  REQUEST_CATEGORIES, STATUS_LABEL, cancelOwnRequest, clockOf, createRequest, humanLeft, listAllRequests, listRequests, requestDetail, staffUpdateRequest,
  type ServiceRequest,
} from "../platform/requests.js";
import { NEVER_ASK } from "../platform/private-guide.js";
import { FEATURES, paidPlans } from "../platform/features.js";
import { ASSET_KINDS, readBrandAsset } from "../platform/brand-kit.js";
import { markStaffRead, postStaffMessage, staffThread } from "../platform/messages.js";
import { act, ctxOf, withT } from "./appkit.js";
import { MessageForm, Thread } from "./thread.js";
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
    "One sector pack from the demo, customised to your brand, wording, fields and document layouts",
    `Delivered within ${config.deliveryHours} hours once your request and brand kit are in`,
    "A step-by-step guide to adding your own private details in your admin panel",
    "No card, no subscription. Extra free features can be added later from your dashboard",
  ],
  paid: [
    "Several sectors combined, integrations, or a bespoke workflow",
    "We read your requirement and quote the build before work starts",
    `Delivered within ${config.deliveryHours} hours of the agreed quote, with your brand kit in`,
    "Add-ons that need upkeep run on a monthly plan you pay in your dashboard",
  ],
};

const WAIT_LABEL = { brand: "your brand kit", quote: "our quote", payment: "your plan payment" } as const;
type ClockFields = Pick<ServiceRequest, "status" | "due_at" | "delivered_at" | "category" | "quote_note" | "plan_code" | "brand_ready_at" | "clock_started_at">;
export const Clock = ({ r }: { r: ClockFields }) => {
  const k = clockOf(r);
  if (k.open && k.waiting.length) return <span class="badge warn">Waiting for {k.waiting.map((w) => WAIT_LABEL[w]).join(" and ")}</span>;
  if (!k.open) return r.status === "delivered" ? <span class={`badge ${k.late ? "warn" : "ok"}`}>{k.late ? "Delivered late" : "Delivered on time"}</span> : null;
  return <span class={`badge ${k.late ? "bad" : "info"}`}>{k.late ? `Overdue by ${humanLeft(k.msLeft)}` : `${humanLeft(k.msLeft)} left`}</span>;
};
/** The window starts only when everything we need is in. */
export const dueText = (r: ClockFields) => {
  const w = clockOf({ ...r, delivered_at: null }).waiting;
  return w.length ? `${HOURS()}-hour clock starts when we have ${w.map((x) => WAIT_LABEL[x]).join(" and ")}` : `due ${formatDate(r.due_at)}`;
};
export const StatusBadge = ({ s }: { s: ServiceRequest["status"] }) => <Badge s={s === "in_build" ? "provisioning" : s} label={STATUS_LABEL[s]} />;

/** Sector choice and requirement fields, shared by registration and the dashboard. */
export async function RequestFields({ c, pre = [], category = "free" }: { c: C; pre?: string[]; category?: string }) {
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

/** Brand fields on the registration form. Everything but the company name is optional here; the dashboard asks for what is missing. */
export const parseBrand = (b: Record<string, any>) => ({
  displayName: str(b.brand_name) || str(b.company), primaryColour: str(b.primary_colour), secondaryColour: str(b.secondary_colour), noLogo: str(b.no_logo) === "yes",
});

/** Read an uploaded form file into the shape the brand-kit module checks. Returns null when nothing was chosen. */
export async function fileFromForm(v: unknown, kind: string) {
  const f = Array.isArray(v) ? v[0] : v;
  if (!f || typeof f === "string" || typeof (f as File).arrayBuffer !== "function" || !(f as File).name) return null;
  return { filename: (f as File).name, data: Buffer.from(await (f as File).arrayBuffer()), kind };
}

export const PrivateNotice = () => (
  <div class="alert info private-notice"><Icon name="lock" /><span><strong>Please don't send us private numbers.</strong> {NEVER_ASK.join(", ")}: you type these into your own admin panel, and we show you exactly where (<a href="/app/guide">step-by-step guide</a>). Messages that contain them are refused.</span></div>
);

// ───────── public: demo
requests.get("/demo", async (c) => {
  const all = withLiveAvailability(await releasedSectors(c.get("db")));
  return c.html(
    <PublicShell p={pubPg(c, "See the demo", { description: "Walk through the working sector packs, then tell us what to customise. Delivered within 24 hours." })}>
      <PageHero kicker="DEMO" photo={PHOTO.intelligence} title={<>See it first.<br />Then tell us what to change.</>} lede={`Browse the working packs below. Register what you need and we customise it, then hand it over within ${HOURS()} hours.`}>
        {config.demoUrl ? <a class="btn red" href={config.demoUrl} target="_blank" rel="noopener">Open the live demo <Icon name="arrowUpRight" size={16} /></a> : null}
        <a class="btn glass" href="/start">Register my requirement</a>
      </PageHero>
      <Section eyebrow="ALL 18 SECTORS" title={<>What the demo covers.</>} intro="Open any sector to see its stages, sample records, documents and roles. Register the one you want and we customise it to your business.">
        <div class="grid g3">{all.map((s) => {
          const full = sectorBySlug(s.slug)!.availability !== "planned";
          return (
          <a class="sector-card" href={`/demo/${s.slug}`} data-reveal>
            <span class="sc-photo"><img src={sectorPhoto(s.slug, true)} alt="" width="800" height="450" loading="lazy" decoding="async" /></span>
            <span class="sc-body"><span class="badge ok">Demo</span><h3>{s.name}</h3><p>{s.workflow}</p><span class="small mute">{full ? "Full working pack" : "Sample-data walkthrough"}</span><span class="go">See the demo <Icon name="arrow" size={14} /></span></span>
          </a>);
        })}</div>
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
  const plans = paidPlans(), free = FEATURES.filter((f) => f.tier === "free"), paid = FEATURES.filter((f) => f.tier === "paid");
  const aed = (m: number) => fmtMoney(m).replace(/\.00$/, "");
  return c.html(
    <PublicShell p={pubPg(c, "Free and paid builds", { description: `What is free, what runs on a monthly plan, and exactly what each add-on costs. Delivered within ${HOURS()} hours.` })}>
      <PageHero kicker="FREE & PAID" photo={PHOTO.finance} title={<>Free build.<br />Paid add-ons.</>} lede={`Both are customised to your requirement and delivered within ${HOURS()} hours. Free costs nothing. Paid add-ons run on a monthly plan that you see in full before you pay.`}>
        <a class="btn red" href="/start?category=free">Register a free build</a><a class="btn glass" href="/how-it-works">How it works</a>
      </PageHero>
      <Section>
        <div class="grid g2">
          {(["free", "paid"] as const).map((k) => (
            <div class={`card plan spot ${k === "free" ? "hot" : ""}`} data-reveal>
              <h3>{k === "free" ? "Free build" : "Paid build"}</h3>
              <p class="mute">{REQUEST_CATEGORIES[k].blurb}</p>
              <ul>{CATEGORY_POINTS[k].map((x) => <li>{x}</li>)}</ul>
              <a class={`btn ${k === "free" ? "red" : ""}`} href={`/start?category=${k}`}>{k === "free" ? "Register a free build" : "Request a paid build"}</a>
            </div>))}
        </div>
      </Section>
      <Section tone="tint" eyebrow="EVERY FEATURE" title={<>Free customisation.<br />Paid add-ons.</>} intro="Free features are part of every free build. Paid add-ons need the monthly plan shown beside them; a higher plan includes everything in the plans below it.">
        <div class="grid g2">
          <div class="card" data-reveal><span class="badge ok">Free</span><h3 style="margin-top:12px">Customisation we do for you</h3>
            <ul class="tick-list">{free.map((f) => <li><Icon name="check" size={18} /><span><strong>{f.name}.</strong> {f.blurb}</span></li>)}</ul></div>
          <div class="card" data-reveal><span class="badge warn">Monthly plan</span><h3 style="margin-top:12px">Paid add-ons</h3>
            <ul class="tick-list">{paid.map((f) => { const p = plans.find((x) => x.plan === f.minPlan)!; return <li><Icon name="plus" size={18} /><span><strong>{f.name}</strong> <span class="mute small">· {p.name} plan{f.status === "pilot" ? " · pilot" : ""}</span><br />{f.blurb}</span></li>; })}</ul>
            <p class="mute small">Pilot means built and tested, and not yet accepted against the live provider. Some add-ons apply to specific sectors only.</p></div>
        </div>
      </Section>
      <Section eyebrow="THE MONTHLY PLANS" title={<>Pay for the plan<br />that covers your add-ons.</>} intro="We pick the smallest plan that covers everything you tick, show the amount, VAT and one-off setup fee, and only then ask you to pay. These are planning prices, not an approved tariff.">
        <div class="grid g3">{plans.map((p) => (
          <div class="card plan spot" data-reveal><h3>{p.name}</h3><div class="price">{aed(p.monthlyMinor)}<span class="small mute"> / month</span></div><p class="mute small">+ {aed(p.setupMinor)} one-off setup</p>
            <ul>{paid.filter((f) => f.minPlan === p.plan).map((f) => <li>{f.name}</li>)}</ul></div>))}</div>
        <p class="mute small" style="margin-top:14px">Enterprise (more than two sectors, several entities) is scoped with us: <a href="/contact">talk to us</a>. Excludes VAT, which is shown at checkout.</p>
      </Section>
      <Section tone="alt">
        <div class="prose">
          <h2>What we do not do</h2>
          <ul>
            <li>We do not host your system or run a usage dashboard, and we do not meter or bill what you do with it.</li>
            <li>We do not hold your customers' data: it lives on the backend you run.</li>
            <li>We do not ask for your tax number, bank details or passwords. You add them yourself, and we show you how.</li>
            <li>Bespoke paid builds are quoted per requirement; the quote is agreed before the build starts and recorded on your request.</li>
          </ul>
          <p>The delivery window runs from a complete request with your brand kit (free), from the agreed quote (paid build), or from the confirmed payment (monthly-plan add-ons). Missing information pauses the start, and your dashboard says exactly what we are waiting for.</p>
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
        <form method="post" action="/start" class="signup-form" enctype="multipart/form-data">
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
          <fieldset><legend>Your brand (so we can start the {HOURS()}-hour clock)</legend>
            <p class="hint">Your name, colours and logo go on every document we customise. You can finish this later in your dashboard, but the clock starts when it is in.</p>
            <div class="field"><label for="brand_name">Company name as it should print</label><input id="brand_name" name="brand_name" type="text" maxlength={120} placeholder="Same as above unless it differs" /></div>
            <div class="row">
              <div class="field"><label for="primary_colour">Main colour (optional)</label><input id="primary_colour" name="primary_colour" type="text" maxlength={7} pattern="#[0-9A-Fa-f]{6}" placeholder="#0F2B3D" /></div>
              <div class="field"><label for="secondary_colour">Second colour (optional)</label><input id="secondary_colour" name="secondary_colour" type="text" maxlength={7} pattern="#[0-9A-Fa-f]{6}" placeholder="#D81724" /></div>
            </div>
            <div class="field"><label for="logo">Logo</label><input id="logo" name="logo" type="file" accept=".png,.jpg,.jpeg,.webp,.svg,.pdf" /><div class="hint">PNG, JPG, WebP, SVG or PDF, up to 5 MB. A transparent PNG works best.</div></div>
            <label class="check"><input type="checkbox" name="no_logo" value="yes" /><span>I don't have a logo yet. Use my company name as plain text.</span></label>
          </fieldset>
          <PrivateNotice />
          {await RequestFields({ c, pre, category })}
          <p class="small mute">By registering you agree to the <a href="/legal/terms">Terms</a> and acknowledge the <a href="/legal/privacy">Privacy notice</a>.</p>
          <button class="btn red" type="submit">Submit my request</button>
        </form>
        <p class="small">Already registered? <a href="/login">Sign in</a>.</p>
      </AuthFrame>
    </PublicShell>);
}

requests.post("/app/requests", async (c) => {
  const ctx = ctxOf(c), b = await formBody(c);
  return act(c, "/app", async () => {
    const r = await withT(c, (cn) => createRequest(cn, ctx.tenantId, ctx.userId, parseRequest(b)));
    return { to: `/app/requests/${r.id}`, ok: r.category === "paid" ? "Request received. We will send you a quote; delivery follows within " + HOURS() + " hours of agreeing it." : `Request received. Delivery is due within ${HOURS()} hours.` };
  });
});

requests.post("/app/requests/:id/cancel", async (c) => {
  const ctx = ctxOf(c), id = c.req.param("id");
  return act(c, "/app", async () => { await withT(c, (cn) => cancelOwnRequest(cn, ctx.tenantId, ctx.userId, id)); return { to: "/app", ok: "Request cancelled." }; });
});

// ───────── staff: delivery queue
requests.use("/admin/requests", requireStaff);
requests.use("/admin/requests/*", requireStaff);
requests.use("/admin/brand-assets/*", requireStaff);
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
            <td><strong>{r.tenant_name}</strong>{r.unread ? <> <span class="flag-dot" title="Unread client messages">{r.unread}</span></> : null}<br /><span class="small mute">{r.contact_name} · {r.contact_email}</span><br /><a class="small" href={`/admin/requests/${r.id}`}>{r.title}</a></td>
            <td><Badge s={r.category === "paid" ? "pending" : "available"} label={REQUEST_CATEGORIES[r.category].label} /></td>
            <td class="small">{r.sectors.map((s) => sectorBySlug(s)?.name ?? s).join(", ")}</td>
            <td><StatusBadge s={r.status} /></td>
            <td><Clock r={r} /><br /><span class="small mute">{dueText(r)}</span></td>
            <td>
              <details><summary class="small">Quick update</summary>
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

const WAIT = { brand: "the client's brand kit", quote: "a quote from us", payment: "the client's plan payment" } as const;

requests.get("/admin/requests/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Request not found", "not_found");
  const db = c.get("db"), csrf = c.get("csrf");
  const r = (await db.query<any>(
    `SELECT r.*, t.name AS tenant_name, t.slug AS tenant_slug, u.email AS contact_email, u.name AS contact_name
       FROM service_requests r JOIN tenants t ON t.id=r.tenant_id JOIN users u ON u.id=r.requested_by WHERE r.id=$1`, [id])).rows[0];
  if (!r) throw new HttpError(404, "Request not found", "not_found");
  const [events, thread, kit, assets, order, ticks] = await Promise.all([
    db.query<any>(`SELECT * FROM service_request_events WHERE request_id=$1 ORDER BY at, id`, [id]).then((x) => x.rows),
    staffThread(db, id),
    db.query<any>(`SELECT * FROM brand_kits WHERE tenant_id=$1`, [r.tenant_id]).then((x) => x.rows[0]),
    db.query<any>(`SELECT * FROM brand_assets WHERE tenant_id=$1 AND removed_at IS NULL ORDER BY created_at`, [r.tenant_id]).then((x) => x.rows),
    r.order_id ? db.query<any>(`SELECT reference, status, total_minor, currency FROM orders WHERE id=$1`, [r.order_id]).then((x) => x.rows[0]) : Promise.resolve(null),
    db.query<any>(`SELECT code FROM private_detail_ticks WHERE tenant_id=$1`, [r.tenant_id]).then((x) => x.rows.length),
  ]);
  await markStaffRead(db, id);
  const k = clockOf(r), feats = (r.features as string[]).map((x) => FEATURES.find((f) => f.code === x)).filter(Boolean) as typeof FEATURES;
  return c.html(
    <AdminShell p={adminPg(c, r.title)}>
      <header class="page"><div><h1>{r.title}</h1><p class="mute small" style="margin:.2em 0 0"><strong>{r.tenant_name}</strong> · {r.contact_name} · <a href={`mailto:${r.contact_email}`}>{r.contact_email}</a></p></div><div class="spacer"></div><span style="display:flex;gap:8px;flex-wrap:wrap"><Badge s={r.category === "paid" ? "pending" : "available"} label={REQUEST_CATEGORIES[r.category as "free" | "paid"].label} /><StatusBadge s={r.status} /><Clock r={r} /></span></header>
      {k.open && k.waiting.length ? <div class="alert warn"><Icon name="clock" /><span>The delivery clock has not started: waiting for {k.waiting.map((w) => WAIT[w]).join(" and ")}.</span></div> : null}
      <div class="grid g2">
        <section class="card"><h3>Requirement</h3>
          <p class="small mute">{r.sectors.map((s: string) => sectorBySlug(s)?.name ?? s).join(", ")} · submitted {formatDate(r.created_at)} · {dueText(r)}</p>
          <p style="white-space:pre-wrap">{r.requirements}</p>
          {r.backend_notes ? <><h4>Backend</h4><p style="white-space:pre-wrap">{r.backend_notes}</p></> : null}
          {feats.length ? <><h4>Features asked for</h4><ul class="ticks">{feats.map((f) => <li>{f.name} <span class={`badge ${f.tier === "paid" ? "warn" : "ok"}`}>{f.tier}</span></li>)}</ul></> : null}
          {r.plan_code ? <p class="small"><strong>Plan:</strong> {paidPlans().find((p) => p.plan === r.plan_code)?.name} {order ? <>· order {order.reference} <Badge s={order.status} /></> : "· checkout not opened yet"}</p> : null}
          {r.quote_note ? <p class="small"><strong>Quote / commercial note:</strong> {r.quote_note}</p> : null}
          <p class="small mute">Client private-details checklist: {ticks} step{ticks === 1 ? "" : "s"} ticked.</p>
        </section>
        <section class="card"><h3>Brand kit</h3>
          {kit ? (<>
            <p><strong>{kit.display_name}</strong>{kit.tagline ? <> · {kit.tagline}</> : null}{kit.website ? <><br /><span class="small">{kit.website}</span></> : null}</p>
            <p class="small">{kit.primary_colour ? <><span class="swatch" style={`background:${kit.primary_colour}`}></span> {kit.primary_colour} </> : null}{kit.secondary_colour ? <><span class="swatch" style={`background:${kit.secondary_colour}`}></span> {kit.secondary_colour}</> : null}</p>
            {kit.doc_footer ? <p class="small">Footer: {kit.doc_footer}</p> : null}
            {kit.notes ? <p class="small" style="white-space:pre-wrap">{kit.notes}</p> : null}
            <p class="small">{kit.confirmed_at ? <span class="badge ok">Confirmed {formatDate(kit.confirmed_at)}</span> : <span class="badge warn">Not confirmed</span>} {kit.no_logo ? <span class="badge info">No logo yet</span> : null}</p>
            {assets.length ? <ul class="asset-list">{assets.map((a: any) => <li><span class="asset-ic"><Icon name="document" size={22} /></span><span><strong>{a.filename}</strong><br /><span class="small mute">{ASSET_KINDS[a.kind as keyof typeof ASSET_KINDS]} · {(a.size_bytes / 1024).toFixed(0)} KB</span></span><span class="asset-actions"><a class="btn ghost sm" href={`/admin/brand-assets/${a.id}`}>Download</a></span></li>)}</ul> : null}
          </>) : <p class="mute">The client has not saved a brand kit yet.</p>}
        </section>
      </div>

      <h2 style="margin-top:26px">Messages</h2>
      <Thread messages={thread} />
      <MessageForm csrf={csrf} action={`/admin/requests/${r.id}/messages`} />
      <p class="small mute">Never ask for, or repeat, a tax number, bank account, card or password. Point the client to “Add your private details” in their dashboard. Messages containing them are refused.</p>

      {["received", "in_build", "ready"].includes(r.status) ? (
        <section class="card" style="margin-top:20px"><h3>Update</h3>
          <form method="post" action={`/admin/requests/${r.id}`}><Csrf t={csrf} />
            <div class="field"><label>Status</label><select name="status">{(["received", "in_build", "ready", "delivered", "cancelled"] as const).map((s) => <option value={s} selected={s === r.status}>{STATUS_LABEL[s]}</option>)}</select></div>
            {r.category === "paid" ? <div class="field"><label>Agreed quote / commercial note</label><input name="quote_note" type="text" maxlength={1000} value={r.quote_note ?? ""} /><div class="hint">Recording it starts the delivery clock once the brand kit is in.</div></div> : null}
            <div class="field"><label>Hand-off link (https)</label><input name="delivery_url" type="url" maxlength={500} value={r.delivery_url ?? ""} /></div>
            <div class="field"><label>Delivery notes: setup steps, and the exact screens where the client enters their private details</label><textarea name="delivery_notes" rows={4} maxlength={4000}>{r.delivery_notes ?? ""}</textarea></div>
            <div class="field"><label>Note on the timeline</label><input name="note" type="text" maxlength={1000} /></div>
            <button class="btn" type="submit">Save</button>
          </form></section>) : null}

      <h2 style="margin-top:26px">Timeline</h2>
      <ol class="stages">{events.map((e: any) => <li><strong>{STATUS_LABEL[e.status as ServiceRequest["status"]]}</strong> <span class="small mute">{formatDate(e.at)} · {e.actor_kind}</span>{e.note ? <div class="small">{e.note}</div> : null}</li>)}</ol>
      <p><a href="/admin/requests">← Queue</a></p>
    </AdminShell>);
});

requests.post("/admin/requests/:id/messages", async (c) => {
  const b = await formBody(c), s = c.get("session")!, id = c.req.param("id");
  try {
    await postStaffMessage(c.get("db"), { userId: s.userId, name: s.name, role: s.staffRole }, id, str(b.body));
    return back(c, `/admin/requests/${id}`, "Reply sent. The client has been emailed a link, not the text.");
  } catch (e) { if (e instanceof HttpError && e.status < 500) return back(c, `/admin/requests/${id}`, undefined, e.message); throw e; }
});

/** Staff download of a client's brand file (always an attachment, never rendered in our origin). */
requests.get("/admin/brand-assets/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "File not found", "not_found");
  const a = (await c.get("db").query<any>(`SELECT * FROM brand_assets WHERE id=$1 AND removed_at IS NULL`, [id])).rows[0];
  if (!a) throw new HttpError(404, "File not found", "not_found");
  const buf = await readBrandAsset(a, a.tenant_id);
  return new Response(new Uint8Array(buf), { headers: {
    "content-type": a.mime, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": `attachment; filename="${String(a.filename).replace(/[^\w.\- ]/g, "_")}"`, "cache-control": "private, no-store",
  } });
});
