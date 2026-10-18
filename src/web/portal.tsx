import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { config } from "../config.js";
import { HttpError, badRequest, fmtMoney, formatDate } from "../lib/util.js";
import { SECTORS, sectorBySlug } from "../platform/catalog.js";
import { ASSET_KINDS, ASSET_TYPES_LABEL, addBrandAsset, brandReady, confirmBrandKit, getBrand, readBrandAsset, removeBrandAsset, saveBrandKit } from "../platform/brand-kit.js";
import { FEATURES, featuresForSectors, paidPlans, type Feature } from "../platform/features.js";
import { clientThread, markClientRead, postClientMessage, unreadForClient } from "../platform/messages.js";
import { enabledProviders, getAdapter } from "../platform/payments/index.js";
import { NEVER_ASK, PRIVATE_ITEMS, privateItemsFor } from "../platform/private-guide.js";
import { payForRequest, planPrice } from "../platform/request-plan.js";
import { REQUEST_CATEGORIES, STATUS_LABEL, clockOf, createFeatureRequest, humanLeft, listRequests, requestDetail, waitingFor, type ServiceRequest, type Waiting } from "../platform/requests.js";
import { startCheckout } from "../platform/billing.js";
import { sectorContent } from "../platform/sector-content.js";
import { act, appPage, back, can, ctxOf, need, withT } from "./appkit.js";
import { CONTACT, waLink } from "./brand.js";
import { Icon } from "./experience.js";
import { arr, formBody, str, type C, type Env } from "./mw.js";
import { Badge, Csrf, Money, Table } from "./ui.js";
import { MessageForm, Thread } from "./thread.js";
import { Clock, PrivateNotice, RequestFields, StatusBadge, dueText, fileFromForm } from "./requests.js";

export const portal = new Hono<Env>();

const HOURS = () => config.deliveryHours;
const OPEN = ["received", "in_build", "ready"];
const isOpen = (r: Pick<ServiceRequest, "status">) => OPEN.includes(r.status);
const aed = (minor: number) => fmtMoney(minor).replace(/\.00$/, "");
const sectorLabel = (slug: string) => sectorBySlug(slug)?.name ?? slug;
const providerLabel = (p: string) => (p === "mock" ? "Pay (test mode)" : getAdapter(p)?.label ?? p);
const WAIT_TEXT: Record<Waiting, string> = { brand: "your brand kit", quote: "our quote", payment: "your monthly plan payment" };

/** Sectors and features the client has asked for so far (cancelled requests don't count). */
const interests = (rows: ServiceRequest[]) => {
  const live = rows.filter((r) => r.status !== "cancelled");
  return { sectors: [...new Set(live.flatMap((r) => r.sectors))], features: [...new Set(live.flatMap((r) => r.features))] };
};

// ───────────────────────── home: the journey and what we provide

type StepState = "done" | "now" | "wait" | "todo";
const Step = ({ n, title, state, children, action }: { n: number; title: string; state: StepState; children: Child; action?: [string, string] }) => (
  <li class={`j-step ${state}`}>
    <span class="j-n" aria-hidden="true">{state === "done" ? <Icon name="check" size={16} /> : n}</span>
    <div class="j-body">
      <h3>{title} <span class="sr-only">{state === "done" ? "(done)" : state === "now" ? "(your turn)" : state === "wait" ? "(in progress)" : "(later)"}</span></h3>
      <p class="small">{children}</p>
      {action ? <a class={`btn sm ${state === "now" ? "red" : "ghost"}`} href={action[1]}>{action[0]}</a> : null}
    </div>
  </li>
);

const MessagePreview = ({ m }: { m: { author_kind: string; author_name: string; body: string; created_at: string } }) => (
  <div class={`msg ${m.author_kind}`}><div class="msg-meta">{m.author_kind === "staff" ? "LOAD|BY|TON team" : m.author_name} · {formatDate(m.created_at)}</div><p>{m.body.length > 160 ? m.body.slice(0, 157) + "…" : m.body}</p></div>
);

export async function portalHome(c: C) {
  const ctx = ctxOf(c), t = c.get("tenant")!;
  const data = await withT(c, async (cn) => ({
    rows: await listRequests(cn), brand: await getBrand(cn), unread: await unreadForClient(cn),
    thread: (await clientThread(cn)).slice(-2),
    ticks: new Set((await cn.query<{ code: string }>(`SELECT code FROM private_detail_ticks`)).rows.map((x) => x.code)),
  }));
  const { rows, brand, unread, thread, ticks } = data;
  const open = rows.filter(isOpen), delivered = rows.filter((r) => r.status === "delivered");
  const { sectors, features } = interests(rows);
  const brandOk = !!brand.kit?.confirmed_at && brandReady(brand.kit, brand.assets);
  const items = privateItemsFor(sectors, features), doneItems = items.filter((i) => ticks.has(i.code));
  const running = open.find((r) => !waitingFor(r).length), waiting = open.filter((r) => waitingFor(r).length);
  const csrf = c.get("csrf");

  const buildState: StepState = delivered.length && !open.length ? "done" : running ? "now" : waiting.length ? "wait" : "todo";
  return appPage(c, "Your dashboard", (<>
    <header class="dashboard-welcome">
      <div><h1>Hello, {c.get("session")!.name.split(" ")[0]}.</h1><p>This is your space with LOAD|BY|TON.store for <strong data-notranslate>{t.name}</strong>: your requests, brand, messages and next steps in one place.</p></div>
      <div class="grow"></div>
      <nav><a class="btn red" href="/app/requests/new">Apply for a free service <Icon name="arrow" size={16} /></a><a class="btn ghost" href="/app/messages">Message our team{unread ? ` (${unread} new)` : ""}</a></nav>
    </header>

    <section class="card journey-card" aria-labelledby="journey-h">
      <h2 id="journey-h" style="font-size:1.25rem">Where you are</h2>
      <ol class="journey">
        <Step n={1} title="Registered" state="done">Your account is open. {rows.length ? `You have ${rows.length} request${rows.length > 1 ? "s" : ""}.` : "Apply for your first service whenever you are ready."}</Step>
        <Step n={2} title="Send your brand kit" state={brandOk ? "done" : "now"} action={brandOk ? ["Review brand kit", "/app/brand"] : ["Add your brand kit", "/app/brand"]}>
          {brandOk ? "Your logo and colours are in. We use them on every document." : `Your company name, colours and logo. Without them we can't start the ${HOURS()}-hour clock.`}
        </Step>
        <Step n={3} title={`We customise and deliver within ${HOURS()} hours`} state={buildState} action={open[0] ? ["Open the request", `/app/requests/${(running ?? open[0]).id}`] : undefined}>
          {delivered.length && !open.length ? `Delivered ${formatDate(delivered[0].delivered_at!)}.`
            : running ? (<>Your build is in progress. <Clock r={running} /></>)
            : waiting.length ? `Waiting for ${[...new Set(waiting.flatMap((r) => waitingFor(r)))].map((w) => WAIT_TEXT[w]).join(" and ")}.`
            : "Starts when you apply and your brand kit is in."}
        </Step>
        <Step n={4} title="Add your private details yourself" state={items.length && doneItems.length === items.length ? "done" : delivered.length ? "now" : "todo"} action={["Open the guide", "/app/guide"]}>
          Your tax number, bank details and licences go into your own admin panel. We show you where. {items.length ? `${doneItems.length} of ${items.length} done.` : ""}
        </Step>
        <Step n={5} title="Need more? Add features" state="todo" action={["Browse features", "/app/features"]}>Free features we simply add. Paid ones run on a monthly plan.</Step>
      </ol>
    </section>

    <div class="grid g2" style="margin-top:18px">
      <section class="card" aria-labelledby="req-h">
        <h2 id="req-h" style="font-size:1.25rem">Your requests</h2>
        {rows.length ? rows.slice(0, 4).map((r) => (
          <article class="req-row">
            <div><a href={`/app/requests/${r.id}`}><strong>{r.title}</strong></a><div class="small mute">{r.sectors.map(sectorLabel).join(", ")} · {dueText(r)}</div></div>
            <span class="req-badges"><Badge s={r.category === "paid" ? "pending" : "available"} label={REQUEST_CATEGORIES[r.category].label} /><StatusBadge s={r.status} /><Clock r={r} /></span>
          </article>)) : <p class="mute">No requests yet.</p>}
        <p style="margin:14px 0 0"><a href="/app/requests">All requests</a> · <a href="/app/requests/new">Apply for a service</a></p>
      </section>
      <section class="card" aria-labelledby="msg-h">
        <h2 id="msg-h" style="font-size:1.25rem">Messages {unread ? <span class="badge bad">{unread} new</span> : null}</h2>
        {thread.length ? thread.map((m) => <MessagePreview m={m} />) : <p class="mute">Nothing yet. Ask us anything about your build: a person answers here, not a bot.</p>}
        <p style="margin:14px 0 0"><a class="btn sm" href="/app/messages">Open messages</a></p>
        <p class="small mute" style="margin-top:12px">Prefer to talk? <a href={waLink()} target="_blank" rel="noopener">WhatsApp {CONTACT.phoneDisplay}</a> · <a href={`mailto:${CONTACT.emails.support}`}>{CONTACT.emails.support}</a></p>
      </section>
    </div>

    {sectors.length ? <WhatWeProvide sectors={sectors} requested={new Set(features)} /> : null}
  </>));
}

/** For each sector the client chose: what the pack does, what is free, and what the monthly add-ons are. */
function WhatWeProvide({ sectors, requested }: { sectors: string[]; requested: Set<string> }) {
  return (
    <section style="margin-top:28px" aria-labelledby="prov-h">
      <h2 id="prov-h">What we provide for you</h2>
      {sectors.map((slug) => {
        const sc = sectorContent(slug), all = featuresForSectors([slug]);
        const free = all.filter((f) => f.tier === "free"), paid = all.filter((f) => f.tier === "paid");
        return (
          <article class="card" style="margin-bottom:16px">
            <div style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap;align-items:baseline"><h3 style="margin:0">{sectorLabel(slug)}</h3><a class="small" href={`/sectors/${slug}`}>Full sector page</a></div>
            {sc ? <ul class="ticks">{sc.highlights.map((h) => <li>{h}</li>)}</ul> : null}
            <div class="grid g2">
              <div><h4>Free: customisation we do for you</h4><ul class="ticks">{free.map((f) => <li>{f.name}{requested.has(f.code) ? <span class="badge ok">asked for</span> : null}</li>)}</ul></div>
              <div><h4>Paid: monthly add-ons</h4><ul class="ticks plus">{paid.map((f) => <li>{f.name} <span class="small mute">· {paidPlans().find((p) => p.plan === f.minPlan)!.name} plan</span>{requested.has(f.code) ? <span class="badge ok">asked for</span> : null}</li>)}</ul></div>
            </div>
            <p style="margin:12px 0 0"><a class="btn sm" href={`/app/features?sector=${slug}`}>Choose features for {sectorLabel(slug)}</a></p>
          </article>);
      })}
    </section>
  );
}

// ───────────────────────── requests: list, apply, detail

portal.get("/app/requests", async (c) => {
  const rows = await withT(c, (cn) => listRequests(cn));
  return appPage(c, "Your requests", (<>
    <header class="page"><div><h1>Your requests</h1><p class="mute small">Every service you have asked for, with its status and delivery clock.</p></div><div class="spacer"></div><a class="btn red" href="/app/requests/new">Apply for a service</a></header>
    {rows.length ? <div class="grid" style="gap:14px">{rows.map((r) => (
      <article class="card req-row">
        <div><a href={`/app/requests/${r.id}`}><strong>{r.title}</strong></a><div class="small mute">{r.sectors.map(sectorLabel).join(", ")} · submitted {formatDate(r.created_at)} · {dueText(r)}</div></div>
        <span class="req-badges"><Badge s={r.category === "paid" ? "pending" : "available"} label={REQUEST_CATEGORIES[r.category].label} /><StatusBadge s={r.status} /><Clock r={r} /></span>
      </article>))}</div>
      : <div class="card"><h3>No requests yet</h3><p class="mute">Apply for a free service to get started.</p></div>}
  </>));
});

portal.get("/app/requests/new", async (c) => {
  const pre = new URL(c.req.url).searchParams.getAll("sector");
  const category = c.req.query("category") === "paid" ? "paid" : "free";
  return appPage(c, "Apply for a service", (<>
    <header class="page"><div><h1>Apply for a service</h1><p class="mute small">Free covers one sector pack. Paid covers several sectors, integrations or a bespoke workflow, and we quote it first. Your brand kit is used for every request.</p></div></header>
    <PrivateNotice />
    <form method="post" action="/app/requests" class="signup-form card" style="margin-top:16px">
      <Csrf t={c.get("csrf")} />
      {await RequestFields({ c, pre, category })}
      <button class="btn red" type="submit">Submit request</button>
    </form>
  </>));
});

portal.get("/app/requests/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Request not found", "not_found");
  const ctx = ctxOf(c);
  const { request: r, events, thread, brand } = await withT(c, async (cn) => {
    const d = await requestDetail(cn, id);
    await markClientRead(cn, id);
    return { ...d, thread: await clientThread(cn, id), brand: await getBrand(cn) };
  });
  const waiting = waitingFor(r), csrf = c.get("csrf");
  const needsPlan = r.category === "paid" && !!r.plan_code && !r.quote_note && isOpen(r);
  const price = needsPlan ? await planPrice(c.get("db"), ctx.tenantId, r.plan_code!).catch(() => null) : null;
  const brandOk = !!brand.kit?.confirmed_at;
  const feats = r.features.map((code) => FEATURES.find((f) => f.code === code)).filter((f): f is Feature => !!f);
  return appPage(c, r.title, (<>
    <header class="page"><div><h1>{r.title}</h1><p class="mute small" style="margin:.2em 0 0">{REQUEST_CATEGORIES[r.category].label} · {r.sectors.map(sectorLabel).join(", ")}</p></div><div class="spacer"></div><span class="req-badges"><StatusBadge s={r.status} /><Clock r={r} /></span></header>

    {waiting.length ? (
      <div class="alert warn" role="status"><Icon name="clock" /><span><strong>The {HOURS()}-hour clock has not started.</strong> We are waiting for {waiting.map((w) => WAIT_TEXT[w]).join(" and ")}.
        {waiting.includes("brand") ? <> <a class="btn red sm" href="/app/brand">Add your brand kit</a></> : null}
        {waiting.includes("quote") ? <> We will send a quote in the messages below; the clock starts when you agree it.</> : null}</span></div>) : null}

    {needsPlan ? (
      <section class="card plan-panel">
        <h2 style="font-size:1.25rem">Pay for your monthly plan to start</h2>
        <p>These add-ons need the <strong>{paidPlans().find((p) => p.plan === r.plan_code)!.name}</strong> monthly plan. Your {HOURS()}-hour window starts when the payment is confirmed.</p>
        {price ? (<Table head={["Item", ["Amount", "num"]]}>
          {price.price.lines.map((l) => <tr><td>{l.label}</td><td class="num"><Money v={l.amount_minor} cur={price.plan.currency} /></td></tr>)}
          <tr><td>VAT</td><td class="num"><Money v={price.price.tax} cur={price.plan.currency} /></td></tr>
          <tr><th>Due now</th><th class="num"><Money v={price.price.total} cur={price.plan.currency} /></th></tr>
        </Table>) : null}
        <p class="small mute">{price?.price.taxNote} Then {price ? aed(price.plan.monthly_minor) : ""} a month. Pricing shown is our planning price. You can cancel at the end of any paid month in Plan &amp; payment.</p>
        {can(c, "billing.manage") ? (
          <form method="post" action={`/app/requests/${r.id}/pay`} class="inline-form"><Csrf t={csrf} />
            {enabledProviders().map((pv, i) => <button class={`btn ${i === 0 ? "red" : "ghost"}`} name="provider" value={pv} type="submit">{providerLabel(pv)}</button>)}
          </form>) : <p class="small">Ask an owner of your company to pay: they have the billing permission.</p>}
      </section>) : null}

    <div class="grid g2" style="margin-top:16px">
      <section class="card"><h3>Your requirement</h3><p style="white-space:pre-wrap">{r.requirements}</p>
        {r.backend_notes ? <><h3>Your backend</h3><p style="white-space:pre-wrap">{r.backend_notes}</p></> : null}
        {feats.length ? <><h3>Features</h3><ul class="ticks">{feats.map((f) => <li>{f.name} <span class={`badge ${f.tier === "paid" ? "warn" : "ok"}`}>{f.tier === "paid" ? "Paid" : "Free"}</span></li>)}</ul></> : null}
      </section>
      <section class="card"><h3>Delivery</h3>
        <p class="small mute">Submitted {formatDate(r.created_at)} · {dueText(r)}{r.delivered_at ? ` · delivered ${formatDate(r.delivered_at)}` : ""}</p>
        {r.quote_note ? <p><strong>{r.plan_code ? "Plan:" : "Agreed quote:"}</strong> {r.quote_note}</p> : null}
        <p class="small">Brand kit: {brandOk ? <span class="badge ok">received</span> : <><span class="badge warn">missing</span> <a href="/app/brand">add it</a></>}</p>
        {r.status === "delivered" ? (<>
          {r.delivery_url ? <p><a class="btn red" href={r.delivery_url} target="_blank" rel="noopener">Open hand-off <Icon name="arrowUpRight" size={16} /></a></p> : null}
          {r.delivery_notes ? <p style="white-space:pre-wrap">{r.delivery_notes}</p> : null}
          <div class="alert info"><Icon name="lock" /><span><strong>Your turn: add your private details.</strong> Your tax number, bank details and licences go into your own admin panel. <a href="/app/guide">Open the step-by-step guide</a>.</span></div>
        </>) : <p class="mute">The hand-off link and notes appear here when your build is delivered.</p>}
        {["received", "in_build"].includes(r.status) ? <form method="post" action={`/app/requests/${r.id}/cancel`} data-confirm="Cancel this request?" class="inline"><Csrf t={csrf} /><button class="btn ghost sm" type="submit">Cancel request</button></form> : null}
      </section>
    </div>

    <h2 style="margin-top:26px">Messages about this request</h2>
    <Thread messages={thread} />
    <MessageForm csrf={csrf} action={`/app/requests/${r.id}/messages`} />

    <h2 style="margin-top:26px">Timeline</h2>
    <ol class="stages">{events.map((e: any) => <li><strong>{STATUS_LABEL[e.status as ServiceRequest["status"]]}</strong> <span class="small mute">{formatDate(e.at)} · {e.actor_kind}</span>{e.note ? <div class="small">{e.note}</div> : null}</li>)}</ol>
    <p><a href="/app/requests">← All requests</a></p>
  </>));
});

portal.post("/app/requests/:id/pay", async (c) => {
  need(c, "billing.manage");
  const ctx = ctxOf(c), b = await formBody(c), id = c.req.param("id"), db = c.get("db");
  return act(c, `/app/requests/${id}`, async () => {
    const provider = str(b.provider) || config.paymentProvider;
    const o = await payForRequest(db, ctx.tenantId, ctx.userId, id, provider);
    if (provider !== "mock") await startCheckout(db, o.orderId, ctx.tenantId, { success: `${config.baseUrl}/app/requests/${id}?ok=${encodeURIComponent("Thank you. Your plan starts when the provider confirms the payment.")}`, cancel: `${config.baseUrl}/app/requests/${id}?err=${encodeURIComponent("Checkout was cancelled. Nothing was charged.")}` });
    return { to: `/app/billing/pay/${o.orderId}` };
  });
});

// ───────────────────────── messages

portal.get("/app/messages", async (c) => {
  const { thread, rows } = await withT(c, async (cn) => {
    const rows = await listRequests(cn);
    const thread = await clientThread(cn);
    await markClientRead(cn);
    return { thread, rows };
  });
  return appPage(c, "Messages", (<>
    <header class="page"><div><h1>Messages</h1><p class="mute small">Your single point of contact with our team. Everything is kept with the request it is about.</p></div></header>
    <Thread messages={thread} />
    {rows.length ? <MessageForm csrf={c.get("csrf")} action="/app/messages" requests={rows} /> : <div class="card"><p>Apply for a service first, then you can message us about it. Meanwhile: <a href={waLink()} target="_blank" rel="noopener">WhatsApp {CONTACT.phoneDisplay}</a> or <a href={`mailto:${CONTACT.emails.support}`}>{CONTACT.emails.support}</a>.</p></div>}
  </>));
});
const sendMessage = async (c: C, requestId: string, body: string, failTo: string) => {
  const ctx = ctxOf(c), s = c.get("session")!;
  return act(c, failTo, async () => {
    await withT(c, (cn) => postClientMessage(cn, ctx.tenantId, { id: ctx.userId, name: s.name }, requestId, body));
    return { to: failTo, ok: "Message sent. We will reply here." };
  });
};
portal.post("/app/messages", async (c) => { const b = await formBody(c); return sendMessage(c, str(b.request_id), str(b.body), "/app/messages"); });
portal.post("/app/requests/:id/messages", async (c) => { const b = await formBody(c), id = c.req.param("id"); return sendMessage(c, id, str(b.body), `/app/requests/${id}`); });

// ───────────────────────── features and the monthly plan

portal.get("/app/features", async (c) => {
  const rows = await withT(c, (cn) => listRequests(cn));
  const { sectors: mine } = interests(rows);
  const sectors = mine.length ? mine : SECTORS.map((s) => s.slug);
  const sel = sectors.includes(c.req.query("sector") ?? "") ? c.req.query("sector")! : sectors[0];
  const requested = new Set(rows.filter((r) => r.status !== "cancelled" && r.sectors.includes(sel)).flatMap((r) => r.features));
  const all = featuresForSectors([sel]), free = all.filter((f) => f.tier === "free"), paid = all.filter((f) => f.tier === "paid");
  const Row = ({ f }: { f: Feature }) => {
    const plan = f.minPlan ? paidPlans().find((p) => p.plan === f.minPlan)! : null;
    return (
      <label class={`feat${requested.has(f.code) ? " is-requested" : ""}`}>
        <input type="checkbox" name="feature" value={f.code} data-tier={f.tier} data-plan={plan?.plan ?? ""} data-plan-name={plan?.name ?? ""} data-plan-rank={plan ? String(paidPlans().indexOf(plan) + 1) : "0"} data-plan-price={plan ? aed(plan.monthlyMinor) : ""} disabled={requested.has(f.code)} />
        <span>
          <strong>{f.name}</strong> <span class={`badge ${f.tier === "paid" ? "warn" : "ok"}`}>{f.tier === "paid" ? "Paid" : "Free"}</span>
          {f.status === "pilot" ? <span class="badge info" title="Built and tested, but not yet accepted against the live provider">Pilot</span> : null}
          {requested.has(f.code) ? <span class="badge ok">Already asked for</span> : null}
          <br /><span class="small mute">{f.blurb}</span>
          {f.youProvide ? <><br /><span class="small">You bring: {f.youProvide}</span></> : null}
          {plan ? <><br /><span class="small">Needs the {plan.name} plan ({aed(plan.monthlyMinor)} a month)</span></> : null}
        </span>
      </label>);
  };
  return appPage(c, "Features and add-ons", (<>
    <header class="page"><div><h1>Features and add-ons</h1><p class="mute small"><a href="/app/plan">See the monthly plans</a>. Tick what you want on top of your {sectorLabel(sel)} pack. Free features we simply add. A paid add-on needs a monthly plan, and we show the price before you pay anything.</p></div></header>
    {sectors.length > 1 ? <nav class="chips" aria-label="Sector">{sectors.map((s) => <a class="chip" href={`/app/features?sector=${s}`} aria-current={s === sel ? "page" : undefined} style="text-decoration:none">{sectorLabel(s)}</a>)}</nav> : null}
    <form method="post" action="/app/features" data-feature-form data-hours={String(HOURS())}>
      <Csrf t={c.get("csrf")} /><input type="hidden" name="sector" value={sel} />
      <div class="grid g2">
        <section><h2 style="font-size:1.2rem">Free: customisation we do for you</h2><div class="feat-list">{free.map((f) => <Row f={f} />)}</div></section>
        <section><h2 style="font-size:1.2rem">Paid: monthly add-ons</h2><div class="feat-list">{paid.map((f) => <Row f={f} />)}</div></section>
      </div>
      <div class="field" style="margin-top:14px"><label for="f-note">Anything we should know? (optional)</label><textarea id="f-note" name="note" rows={3} maxlength={3000} placeholder="Wording, examples, which of your systems it should talk to."></textarea></div>
      <aside class="plan-summary" data-plan-summary aria-live="polite"><strong>Your selection</strong><p class="small" data-plan-text>Tick features to see what they need. Free features cost nothing.</p></aside>
      <button class="btn red" type="submit">Request these features</button>
    </form>
    <script src="/assets/portal.js" defer></script>
  </>));
});

portal.post("/app/features", async (c) => {
  need(c, "settings.manage");
  const ctx = ctxOf(c), b = await formBody(c);
  return act(c, "/app/features", async () => {
    const { request, plan } = await withT(c, (cn) => createFeatureRequest(cn, ctx.tenantId, ctx.userId, { sectors: [str(b.sector)], features: arr(b.feature), note: str(b.note) }));
    const covered = request.category === "paid" && !!request.quote_note;
    return {
      to: `/app/requests/${request.id}`,
      ok: !plan ? `Request received. Free features are delivered within ${HOURS()} hours once your brand kit is in.`
        : covered ? `Request received. Your current plan already covers it, so your ${HOURS()}-hour window has started.`
        : `Request received. These add-ons need the ${plan.name} plan (${aed(plan.monthlyMinor)} a month). Pay below to start.`,
    };
  });
});

portal.get("/app/plan", async (c) => {
  const ctx = ctxOf(c), db = c.get("db");
  const [rows, sub, orders] = await Promise.all([
    withT(c, (cn) => listRequests(cn)),
    db.query<any>(`SELECT s.status, s.period_end, s.cancel_at_period_end, p.name AS plan, p.plan_code FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id WHERE s.tenant_id=$1`, [ctx.tenantId]).then((r) => r.rows[0]),
    db.query<any>(`SELECT * FROM orders WHERE tenant_id=$1 ORDER BY created_at DESC`, [ctx.tenantId]).then((r) => r.rows),
  ]);
  const unpaid = rows.filter((r) => r.category === "paid" && r.plan_code && !r.quote_note && isOpen(r));
  const paid = sub.plan_code !== "free";
  const csrf = c.get("csrf");
  return appPage(c, "Plan and payment", (<>
    <header class="page"><div><h1>Plan and payment</h1><p class="mute small">Free builds cost nothing. Paid add-ons run on a monthly plan: the smallest one that covers everything you chose.</p></div></header>
    <div class="grid g2">
      <section class="card"><h3>Your plan</h3>
        <p><strong>{paid ? sub.plan : "No paid plan"}</strong> {paid ? <Badge s={sub.status} /> : null}</p>
        <p class="small mute">{paid ? `${sub.cancel_at_period_end ? "Ends" : "Renews"} ${formatDate(sub.period_end)}.` : "You only need a plan when you ask for a paid add-on."}</p>
        {paid && !sub.cancel_at_period_end && can(c, "billing.manage") ? <form method="post" action="/app/billing/cancel" data-confirm="Cancel at the end of the paid period?" class="inline"><Csrf t={csrf} /><button class="btn ghost sm" type="submit">Cancel at period end</button></form> : null}
      </section>
      <section class="card"><h3>Waiting for payment</h3>
        {unpaid.length ? unpaid.map((r) => <p><a href={`/app/requests/${r.id}`}><strong>{r.title}</strong></a><br /><span class="small mute">Needs the {paidPlans().find((p) => p.plan === r.plan_code)?.name} plan</span> <a class="btn sm red" href={`/app/requests/${r.id}`}>Pay</a></p>) : <p class="mute">Nothing is waiting for payment.</p>}
      </section>
    </div>
    <h2 style="margin-top:26px">The monthly plans</h2>
    <p class="mute small">A plan covers every paid add-on up to its level. Prices are planning prices; the exact amount, VAT and a one-off setup fee are shown before you pay.</p>
    <div class="grid g3">{paidPlans().map((p) => (
      <div class="card plan">
        <h3>{p.name}</h3><div class="price">{aed(p.monthlyMinor)}<span class="small mute"> / month</span></div>
        <p class="small mute">+ {aed(p.setupMinor)} one-off setup. Includes:</p>
        <ul class="ticks">{FEATURES.filter((f) => f.tier === "paid" && f.minPlan === p.plan).map((f) => <li>{f.name}</li>)}</ul>
      </div>))}</div>
    <p class="small mute">Add-ons of a lower plan are included in a higher one. Larger or bespoke work is quoted: <a href="/app/requests/new?category=paid">apply for a paid build</a>.</p>
    <h2 style="margin-top:26px">Payments</h2>
    <Table head={["Reference", "Date", ["Total", "num"], "Status", ""]} empty={orders.length ? undefined : "No payments yet."}>
      {orders.map((o: any) => <tr><td>{o.reference}</td><td>{formatDate(o.created_at)}</td><td class="num"><Money v={o.total_minor} cur={o.currency} /></td><td><Badge s={o.status} /></td>
        <td>{o.status === "paid" ? <a class="btn ghost sm" href={`/app/billing/orders/${o.id}/receipt`}>Receipt</a> : null}{o.status === "pending" && (o.provider === "mock" ? config.paymentProviders.includes("mock") : !!o.checkout_url) ? <a class="btn sm" href={`/app/billing/pay/${o.id}`}>{o.provider === "mock" ? "Pay" : "Continue to payment"}</a> : null}</td></tr>)}
    </Table>
  </>));
});

// ───────────────────────── brand kit

portal.get("/app/brand", async (c) => {
  const { kit, assets } = await withT(c, getBrand);
  const t = c.get("tenant")!, csrf = c.get("csrf"), ready = brandReady(kit, assets), confirmed = !!kit?.confirmed_at;
  return appPage(c, "Brand kit", (<>
    <header class="page"><div><h1>Your brand kit</h1><p class="mute small">What makes the system look like your company: name, colours, logo and a footer line. We use it for every request.</p></div><div class="spacer"></div>{confirmed ? <span class="badge ok">Confirmed</span> : <span class="badge warn">Not confirmed yet</span>}</header>
    {!confirmed ? <div class="alert warn"><Icon name="clock" /><span>Your {HOURS()}-hour clock starts when you confirm this kit. Save your name, add a logo (or say you don't have one yet), then press <strong>Confirm brand kit</strong>.</span></div> : null}
    <div class="alert info private-notice"><Icon name="lock" /><span><strong>No private numbers here.</strong> Leave out your tax number, bank account and passwords. They would be printed on documents; you add them yourself in your own admin panel (<a href="/app/guide">guide</a>).</span></div>
    <div class="grid g2" style="margin-top:16px">
      <section class="card"><h3>Company on documents</h3>
        <form method="post" action="/app/brand"><Csrf t={csrf} />
          <div class="field"><label for="b-name">Company name as it should print</label><input id="b-name" name="display_name" type="text" required maxlength={120} value={kit?.display_name ?? t.name} /></div>
          <div class="field"><label for="b-tag">Tagline (optional)</label><input id="b-tag" name="tagline" type="text" maxlength={160} value={kit?.tagline ?? ""} /></div>
          <div class="field"><label for="b-web">Website (optional)</label><input id="b-web" name="website" type="text" maxlength={200} value={kit?.website ?? ""} placeholder="www.example.com" /></div>
          <div class="row">
            <div class="field"><label for="b-c1">Main colour</label><input id="b-c1" name="primary_colour" type="text" maxlength={7} pattern="#[0-9A-Fa-f]{6}" placeholder="#0F2B3D" value={kit?.primary_colour ?? ""} />{kit?.primary_colour ? <span class="swatch" style={`background:${kit.primary_colour}`} title={kit.primary_colour}></span> : null}</div>
            <div class="field"><label for="b-c2">Second colour</label><input id="b-c2" name="secondary_colour" type="text" maxlength={7} pattern="#[0-9A-Fa-f]{6}" placeholder="#D81724" value={kit?.secondary_colour ?? ""} />{kit?.secondary_colour ? <span class="swatch" style={`background:${kit.secondary_colour}`} title={kit.secondary_colour}></span> : null}</div>
          </div>
          <div class="field"><label for="b-foot">Footer line for documents (optional)</label><input id="b-foot" name="doc_footer" type="text" maxlength={300} value={kit?.doc_footer ?? ""} placeholder="Address, phone and email: no tax or bank numbers" /></div>
          <div class="field"><label for="b-notes">Anything else about your brand? (optional)</label><textarea id="b-notes" name="notes" rows={3} maxlength={2000} placeholder="Fonts, tone, things to avoid.">{kit?.notes ?? ""}</textarea></div>
          <label class="check"><input type="checkbox" name="no_logo" value="yes" checked={kit?.no_logo} /><span>I don't have a logo yet. Use my company name as plain text.</span></label>
          <button class="btn" style="margin-top:12px" type="submit">Save</button>
        </form>
      </section>
      <section class="card"><h3>Logo and brand files</h3>
        {assets.length ? <ul class="asset-list">{assets.map((a) => (
          <li>
            {a.mime.startsWith("image/") && a.mime !== "image/svg+xml" ? <img src={`/app/brand/assets/${a.id}`} alt="" width="56" height="56" loading="lazy" /> : <span class="asset-ic"><Icon name="document" size={22} /></span>}
            <span><strong>{a.filename}</strong><br /><span class="small mute">{ASSET_KINDS[a.kind]} · {(a.size_bytes / 1024).toFixed(0)} KB</span></span>
            <span class="asset-actions"><a class="btn ghost sm" href={`/app/brand/assets/${a.id}?download=1`}>Download</a>
              <form method="post" action={`/app/brand/assets/${a.id}/remove`} data-confirm="Remove this file?" class="inline"><Csrf t={csrf} /><button class="btn ghost sm" type="submit">Remove</button></form></span>
          </li>))}</ul> : <p class="mute">No files yet.</p>}
        {kit ? (
          <form method="post" action="/app/brand/assets" enctype="multipart/form-data" style="margin-top:14px"><Csrf t={csrf} />
            <div class="field"><label for="a-kind">What is it?</label><select id="a-kind" name="kind">{Object.entries(ASSET_KINDS).map(([k, l]) => <option value={k}>{l}</option>)}</select></div>
            <div class="field"><label for="a-file">File</label><input id="a-file" name="file" type="file" required accept=".png,.jpg,.jpeg,.webp,.svg,.pdf" /><div class="hint">{ASSET_TYPES_LABEL}. A square or wide PNG on a transparent background works best.</div></div>
            <button class="btn" type="submit">Upload</button>
          </form>) : <p class="small mute" style="margin-top:12px">Save your company name first, then upload files.</p>}
      </section>
    </div>
    <form method="post" action="/app/brand/confirm" style="margin-top:18px"><Csrf t={csrf} />
      <button class="btn red" type="submit" disabled={!ready}>{confirmed ? "Brand kit confirmed. Confirm again after changes" : "Confirm brand kit and start the clock"}</button>
      {!ready ? <span class="small mute"> Save a name and add a logo (or tick “I don't have a logo yet”) first.</span> : null}
    </form>
  </>));
});

portal.post("/app/brand", async (c) => {
  need(c, "settings.manage");
  const ctx = ctxOf(c), b = await formBody(c);
  return act(c, "/app/brand", async () => {
    await withT(c, (cn) => saveBrandKit(cn, ctx.tenantId, ctx.userId, {
      displayName: str(b.display_name), tagline: str(b.tagline), website: str(b.website), primaryColour: str(b.primary_colour), secondaryColour: str(b.secondary_colour),
      docFooter: str(b.doc_footer), notes: str(b.notes), noLogo: str(b.no_logo) === "yes",
    }));
    return { to: "/app/brand", ok: "Brand kit saved." };
  });
});

portal.post("/app/brand/assets", async (c) => {
  need(c, "settings.manage");
  const ctx = ctxOf(c), b = await formBody(c);
  return act(c, "/app/brand", async () => {
    const file = await fileFromForm(b.file, str(b.kind));
    if (!file) throw badRequest("Choose a file to upload.");
    await withT(c, (cn) => addBrandAsset(cn, ctx.tenantId, ctx.userId, file));
    return { to: "/app/brand", ok: "File uploaded." };
  });
});
portal.post("/app/brand/assets/:id/remove", async (c) => {
  need(c, "settings.manage");
  const ctx = ctxOf(c);
  return act(c, "/app/brand", async () => { await withT(c, (cn) => removeBrandAsset(cn, ctx.tenantId, ctx.userId, c.req.param("id"))); return { to: "/app/brand", ok: "File removed." }; });
});
portal.post("/app/brand/confirm", async (c) => {
  need(c, "settings.manage");
  const ctx = ctxOf(c);
  return act(c, "/app/brand", async () => {
    const n = await withT(c, (cn) => confirmBrandKit(cn, ctx.tenantId, ctx.userId));
    return { to: "/app", ok: n ? `Brand kit confirmed. ${n} request${n > 1 ? "s were" : " was"} waiting for it; the ${HOURS()}-hour clock is running where nothing else is outstanding.` : "Brand kit confirmed." };
  });
});

/** Serve a brand file to its own client: images inline (for the preview), everything else (and ?download=1) as an attachment. */
portal.get("/app/brand/assets/:id", async (c) => {
  const ctx = ctxOf(c), id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "File not found", "not_found");
  const a = await withT(c, async (cn) => (await getBrand(cn)).assets.find((x) => x.id === id));
  if (!a) throw new HttpError(404, "File not found", "not_found");
  const buf = await readBrandAsset(a, ctx.tenantId);
  const inline = !c.req.query("download") && a.mime.startsWith("image/") && a.mime !== "image/svg+xml";
  return new Response(new Uint8Array(buf), { headers: {
    "content-type": a.mime, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${a.filename.replace(/[^\w.\- ]/g, "_")}"`, "cache-control": "private, no-store",
  } });
});

// ───────────────────────── private-details guide

portal.get("/app/guide", async (c) => {
  const { rows, ticks } = await withT(c, async (cn) => ({ rows: await listRequests(cn), ticks: new Set((await cn.query<{ code: string }>(`SELECT code FROM private_detail_ticks`)).rows.map((x) => x.code)) }));
  const { sectors, features } = interests(rows);
  const items = privateItemsFor(sectors, features), done = items.filter((i) => ticks.has(i.code)).length, csrf = c.get("csrf");
  const delivered = rows.some((r) => r.status === "delivered");
  return appPage(c, "Add your private details", (<>
    <header class="page"><div><h1>Add your private details</h1><p class="mute small">Your tax number, bank details, licences and logins belong in your own admin panel, typed by you. We never ask for them, and we show you exactly where each one goes.</p></div></header>
    <div class="grid g2">
      <section class="card"><h3>Why you do this yourself</h3>
        <ul class="ticks"><li>Nobody at LOAD|BY|TON.store ever holds your numbers or logins, so they can't leak from us.</li><li>It takes a few minutes, and the steps are below.</li><li>If a step looks different in your build, your hand-off notes list the exact screens. Ask us in <a href="/app/messages">messages</a>.</li></ul>
        <p class="small mute" style="margin-bottom:0">We will never ask for: {NEVER_ASK.join("; ")}.</p></section>
      <section class="card"><h3>Your progress</h3>
        <div class="progress" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={items.length}><i style={`width:${items.length ? Math.round((done / items.length) * 100) : 0}%`}></i></div>
        <p>{done} of {items.length} done</p>
        {!delivered ? <p class="small mute">You can read the steps now. You'll do them in your admin panel once your build is delivered.</p> : null}
      </section>
    </div>
    <h2 style="margin-top:24px">Step by step</h2>
    <div class="guide">{items.map((i) => (
      <details class={`card guide-item${ticks.has(i.code) ? " is-done" : ""}`}>
        <summary><span class="g-state">{ticks.has(i.code) ? <Icon name="check" size={16} /> : <Icon name="lock" size={16} />}</span><span><strong>{i.title}</strong><br /><span class="small mute">{i.what} · {i.where}</span></span></summary>
        <ol>{i.steps.map((s) => <li>{s}</li>)}</ol>
        <form method="post" action="/app/guide/tick" class="inline"><Csrf t={csrf} /><input type="hidden" name="code" value={i.code} />
          {ticks.has(i.code) ? <button class="btn ghost sm" name="done" value="" type="submit">Mark as not done</button> : <button class="btn sm" name="done" value="yes" type="submit">I've done this</button>}
        </form>
      </details>))}</div>
    {sectors.length ? <>
      <h2 style="margin-top:24px">Specific to your sector{sectors.length > 1 ? "s" : ""}</h2>
      <div class="grid g2">{sectors.map((s) => <section class="card"><h3>{sectorLabel(s)}</h3><ul class="ticks">{(sectorContent(s)?.yours ?? []).map((y) => <li>{y}</li>)}</ul></section>)}</div></> : null}
    <p class="small mute" style="margin-top:20px">Stuck? <a href="/app/messages">Message us</a> without the number: say which step and what you see, and we'll talk you through it.</p>
  </>));
});

portal.post("/app/guide/tick", async (c) => {
  need(c, "settings.manage");
  const ctx = ctxOf(c), b = await formBody(c), code = str(b.code);
  return act(c, "/app/guide", async () => {
    if (!PRIVATE_ITEMS.some((i) => i.code === code)) throw badRequest("Unknown step.");
    await withT(c, (cn) => str(b.done) === "yes"
      ? cn.query(`INSERT INTO private_detail_ticks(tenant_id,code,done_by) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,code) DO NOTHING`, [ctx.tenantId, code, ctx.userId])
      : cn.query(`DELETE FROM private_detail_ticks WHERE code=$1`, [code]));
    return { to: "/app/guide" };
  });
});

export { back };
