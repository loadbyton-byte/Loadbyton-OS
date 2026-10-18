import { Hono } from "hono";
import { config } from "../config.js";
import { HttpError, fmtMoney } from "../lib/util.js";
import { SECTORS, withLiveAvailability, type Availability } from "../platform/catalog.js";
import { FEATURES, featuresForSectors, paidPlans } from "../platform/features.js";
import { NEVER_ASK } from "../platform/private-guide.js";
import { releasedSectors } from "../platform/readiness.js";
import { sectorContent } from "../platform/sector-content.js";
import { CONTACT, Lbt, waLink } from "./brand.js";
import { Icon } from "./experience.js";
import type { Env } from "./mw.js";
import { SECTOR_DEMOS } from "./sector-demo.js";
import { CtaBand, Faq, PHOTO, PageHero, Section, sectorPhoto } from "./site-kit.js";
import { Badge, PublicShell, type Page } from "./ui.js";

export const brochure = new Hono<Env>();

const H = () => config.deliveryHours;
const aed = (minor: number) => fmtMoney(minor).replace(/\.00$/, "");
const AVAIL = { available: "Available", pilot: "Pilot", planned: "Planned" } as const;
const pg = (c: any, title: string, extra: Partial<Page> = {}): Page => ({
  title, csrf: c.get("csrf"), path: c.req.path, user: c.get("session") ? { name: c.get("session").name } : null,
  ok: c.req.query("ok"), err: c.req.query("err"), heroDark: true, ...extra,
});

/** The journey, told once and used on the home page, the how-it-works page and the sector pages. */
export const JOURNEY: [string, string][] = [
  ["See the demo", "Open any of the 18 sector packs and click through sample data. Nothing to sign up for."],
  ["Register and say what you need", "Company, email and password, then Free or Paid, the sector, and what to change. One form."],
  ["Send your brand", "Your company name, colours and logo (or tell us you have no logo yet). The clock starts when this is in."],
  [`We customise and deliver within ${H()} hours`, "Free: from your complete request. Paid: from the agreed quote. Watch the countdown in your dashboard and message us there."],
  ["Add your private details yourself", "Your tax number, bank details and licences go into your own admin panel. We never ask for them; a step-by-step guide shows where each one goes."],
  ["Ask for more any time", "Extra features we can add free, we add. Paid ones run on a monthly plan you pay in your dashboard, with the same " + H() + "-hour promise."],
];

export const HowSteps = () => (
  <ol class="how-steps">{JOURNEY.map(([t, d], i) => <li class="how-step" data-reveal><span class="n">{i + 1}</span><div><h3>{t}</h3><p>{d}</p></div></li>)}</ol>
);

export const NeverAsk = () => (
  <aside class="never-ask" data-reveal>
    <span class="ic-tile"><Icon name="lock" size={22} /></span>
    <div><h3>What we will never ask you for</h3>
      <ul>{NEVER_ASK.map((x) => <li>{x}</li>)}</ul>
      <p>These stay with you. After delivery you type them into your own admin panel, and your dashboard walks you through it, one step at a time.</p></div>
  </aside>
);

export function WhatIsIt() {
  return (
    <Section eyebrow="WHAT IT IS" title={<>Working logistics software,<br />made to look and run like yours.</>}
      intro={<><Lbt />.store builds operating software for logistics companies in the UAE: enquiries, quotes, jobs, trips, stock, parcels, customs cases, documents and invoices. We don't sell a login to a shared system. We take a pack that already works, customise it to your company, and hand it over.</>}>
      <div class="grid g3 what-cols">
        <article class="card spot" data-reveal><span class="ic-tile"><Icon name="layers" size={22} /></span><h3>1. A pack that already works</h3><p class="mute">Eighteen sector packs, from freight forwarding to dangerous cargo. You can click through every one with sample data before you decide anything.</p></article>
        <article class="card spot" data-reveal><span class="ic-tile"><Icon name="tag" size={22} /></span><h3>2. Made yours in {H()} hours</h3><p class="mute">Your name, colours, logo, wording, statuses and document layouts. Free for one sector. Paid for several sectors, integrations or a bespoke workflow, quoted first.</p></article>
        <article class="card spot" data-reveal><span class="ic-tile"><Icon name="shield" size={22} /></span><h3>3. Yours to run, with you in control</h3><p class="mute">You run it on your own backend and enter your own private details. A dashboard keeps one thread between you and our team for questions, changes and extra features.</p></article>
      </div>
    </Section>
  );
}

export function FreeVsPaid() {
  const free = FEATURES.filter((f) => f.tier === "free");
  return (
    <Section tone="tint" eyebrow="FREE AND PAID" title={<>What costs nothing.<br />What runs on a monthly plan.</>} intro="Free is real: no card, no trial clock. Paid is for work that needs more than customisation.">
      <div class="grid g2">
        <article class="card plan spot hot" data-reveal><Badge s="available" label="Free" /><h3 style="margin-top:14px">Free build</h3><p class="mute">One sector pack, customised to your brand and wording.</p>
          <ul>{free.map((f) => <li>{f.name}</li>)}</ul>
          <a class="btn red" href="/start?category=free">Register a free build</a></article>
        <article class="card plan spot" data-reveal><Badge s="pending" label="Paid" /><h3 style="margin-top:14px">Paid add-ons and builds</h3><p class="mute">Several sectors, integrations, a bespoke workflow, or any add-on that needs upkeep.</p>
          <ul><li>Add-ons run on a monthly plan: {paidPlans().map((p) => `${p.name} ${aed(p.monthlyMinor)}`).join(" · ")}</li>
            <li>Bespoke work is quoted first; the {H()} hours start when you agree it</li>
            <li>Pay in your dashboard; the {H()}-hour window starts when payment is confirmed</li></ul>
          <a class="btn" href="/pricing">See every add-on and price</a></article>
      </div>
    </Section>
  );
}

export function SectorCards({ sectors }: { sectors: { slug: string; name: string; workflow: string; family: string; availability: Availability; specialist?: boolean }[] }) {
  return (
    <div class="grid g3">{sectors.map((s) => (
      <a class="sector-card" href={`/sectors/${s.slug}`} data-cat={s.family} data-reveal>
        <span class="sc-photo"><img src={sectorPhoto(s.slug, true)} alt="" width="800" height="450" loading="lazy" decoding="async" /><img class="si" src={`/brand/icons/${s.slug}.svg`} alt="" width="40" height="40" /></span>
        <span class="sc-body"><h3>{s.name}</h3><span class="sc-badges"><Badge s={s.availability} label={AVAIL[s.availability]} />{s.specialist ? <span class="badge bad">Specialist review</span> : null}</span>
          <p>{sectorContent(s.slug)?.who ?? s.workflow}</p><span class="go">Everything in this pack <Icon name="arrow" size={14} /></span></span>
      </a>))}</div>
  );
}

export const HOME_FAQ: [string, any][] = [
  ["What is LOAD|BY|TON.store?", <>Logistics operating software for UAE companies, delivered as a customised pack rather than a shared login. You choose a sector, we make it look and work like your company, and you run it on your own backend.</>],
  ["What do I get for free?", <>One sector pack, customised: your brand on every document, your wording on screen, your document layouts, roles for your team, Arabic and English, a customer list import and a written guide to your own admin panel. No card needed.</>],
  [`How does the ${H()}-hour promise work?`, <>The clock starts when we have everything we need: your complete request and your brand kit. For paid work it also needs the agreed quote, or your monthly plan payment for add-ons. Your dashboard shows the countdown and what, if anything, we are waiting for.</>],
  ["Why don't you ask for my tax number or bank details?", <>Because you shouldn't send them to anyone who doesn't need them. After delivery you type them into your own admin panel and your dashboard shows you where. Our messages even refuse them if you paste one by mistake.</>],
  ["What if I need more later?", <>Choose features in your dashboard. If we can add them as part of the free customisation, we do. If they need upkeep, such as an accounting bridge or e-invoicing, they run on a monthly plan that you pay in the dashboard.</>],
  ["Can I talk to someone first?", <>Yes. <a href={waLink()} target="_blank" rel="noopener">WhatsApp {CONTACT.phoneDisplay}</a> or <a href={`mailto:${CONTACT.emails.contact}`}>{CONTACT.emails.contact}</a>. After you register, the Messages page in your dashboard is the single place we keep every conversation.</>],
];

// ───────── how it works

brochure.get("/how-it-works", (c) => c.html(
  <PublicShell p={pg(c, "How it works", { description: `Register, send your brand, and get your customised logistics system within ${H()} hours. You add your own private details; we show you how.` })}>
    <PageHero kicker="HOW IT WORKS" photo={PHOTO.onboarding} title={<>From first look<br />to running in {H()} hours.</>} lede="Six steps, one dashboard. You always see where you are, what we are waiting for and how long is left.">
      <a class="btn red" href="/start">Register your requirement <Icon name="arrow" size={16} /></a><a class="btn glass" href="/demo">See the demo first</a>
    </PageHero>
    <Section eyebrow="THE JOURNEY" title={<>What happens,<br />in order.</>}>
      <HowSteps />
    </Section>
    <Section tone="tint" eyebrow="YOUR DASHBOARD" title={<>One place to see<br />and ask for everything.</>} intro="The moment you register you get a dashboard of your own. It is also the single line between you and our team.">
      <div class="grid g3">
        <article class="card spot" data-reveal><span class="ic-tile"><Icon name="clock" size={22} /></span><h3>Status and countdown</h3><p class="mute">Each request shows where it is and how long is left, or exactly what we are waiting for: your brand kit, a quote or a plan payment.</p></article>
        <article class="card spot" data-reveal><span class="ic-tile"><Icon name="tag" size={22} /></span><h3>Brand kit</h3><p class="mute">Upload your logo, set your colours and footer line once. It is used for every request, now and later.</p></article>
        <article class="card spot" data-reveal><span class="ic-tile"><Icon name="chat" size={22} /></span><h3>Messages</h3><p class="mute">Ask a question, send wording or request a change. A person replies in the same thread, next to your request.</p></article>
        <article class="card spot" data-reveal><span class="ic-tile"><Icon name="star" size={22} /></span><h3>Features and add-ons</h3><p class="mute">See what we provide for your sector. Free ones we add. Paid ones show the monthly plan they need before you pay anything.</p></article>
        <article class="card spot" data-reveal><span class="ic-tile"><Icon name="money" size={22} /></span><h3>Plan and payment</h3><p class="mute">Pay for a plan, get receipts, or cancel at the end of the paid period. Nothing renews without you seeing it.</p></article>
        <article class="card spot" data-reveal><span class="ic-tile"><Icon name="lock" size={22} /></span><h3>Your private details</h3><p class="mute">A checklist that shows where your tax number, bank details, licences and logins go in your own admin panel, with a tick for each one.</p></article>
      </div>
    </Section>
    <Section eyebrow="THE FINE PRINT, PLAINLY" title={<>When the clock starts.</>}>
      <div class="grid g2">
        <div class="prose"><h3>Free</h3><p>From the moment your request is complete and your brand kit is confirmed. If you register with your logo (or tell us you have none yet), that is the moment you submit.</p>
          <h3>Paid, quoted</h3><p>When you agree the quote and your brand kit is in. We read your requirement first and record the quote on your request.</p>
          <h3>Paid add-ons</h3><p>When your monthly plan payment is confirmed by the payment provider. If you already pay for a plan that covers the add-on, it starts straight away.</p></div>
        <NeverAsk />
      </div>
    </Section>
    <Section tone="alt" eyebrow="QUESTIONS" title={<>Asked often.</>}>
      <Faq items={HOME_FAQ} />
    </Section>
    <CtaBand />
  </PublicShell>,
));

// ───────── one sector, in full

export async function brochureSectorPage(c: any) {
  const live = withLiveAvailability(await releasedSectors(c.get("db")));
  const s = live.find((x) => x.slug === c.req.param("slug"));
  if (!s) throw new HttpError(404, "Sector not found");
  const sc = sectorContent(s.slug), demo = SECTOR_DEMOS[s.slug];
  const feats = featuresForSectors([s.slug]), free = feats.filter((f) => f.tier === "free"), paid = feats.filter((f) => f.tier === "paid");
  const plans = paidPlans();
  const idx = SECTORS.findIndex((x) => x.slug === s.slug), next = SECTORS[(idx + 1) % SECTORS.length];
  return c.html(
    <PublicShell p={pg(c, s.name, { description: `${s.name}: ${sc?.who ?? s.workflow} What the pack does, what is free, what runs on a monthly plan, and what you add yourself.` })}>
      <PageHero kicker="SECTOR PACK" crumb={s.name} photo={sectorPhoto(s.slug)} title={<>{s.name} <Badge s={s.availability} label={AVAIL[s.availability]} /></>} lede={sc?.who ?? s.workflow}>
        <a class="btn red" href={`/start?sector=${s.slug}`}>Apply for this pack <Icon name="arrow" size={16} /></a><a class="btn glass" href={`/demo/${s.slug}`}>See the demo</a><a class="btn glass" href="/sectors">All 18 sectors</a>
      </PageHero>
      <Section eyebrow="WHAT IT IS" title={<>What this pack does.</>} intro={sc ? <>Replaces: {sc.pain.charAt(0).toLowerCase() + sc.pain.slice(1)}</> : s.workflow}>
        <div class="sector-split">
          <div>
            {sc ? <ul class="tick-list big">{sc.highlights.map((h) => <li><Icon name="check" size={18} />{h}</li>)}</ul> : null}
            <p class="mute small">{s.workflow}.</p>
            {s.availability === "pilot" ? <div class="alert warn"><Icon name="alert" /><span>This pack is in <strong>pilot</strong> with design partners: it is built and tested, and not yet accepted against live providers or by an independent reviewer. Expect rapid change and hands-on support.</span></div> : null}
            {s.availability === "planned" ? <div class="alert info"><Icon name="info" /><span>This pack is <strong>planned</strong>. Registering records your interest and shapes the build; ask us what is possible today.</span></div> : null}
            {s.specialist ? <div class="alert err"><Icon name="alert" /><span><strong>Specialist profile.</strong> Needs subject-matter review. This software is not a certification to handle regulated cargo or to file with an official channel.</span></div> : null}
          </div>
          <figure class="sector-figure" data-reveal="unveil"><img src={sectorPhoto(s.slug)} alt="" width="1672" height="941" loading="lazy" decoding="async" /><figcaption><span class="eyebrow">{s.family.toUpperCase()}</span><b>{s.name}</b></figcaption></figure>
        </div>
      </Section>
      {demo ? (
        <Section tone="tint" eyebrow="THE WORKFLOW" title={<>Stage by stage, with the paperwork it produces.</>}>
          <ol class="stage-flow" data-reveal>{demo.stages.map((t, i) => <li><span class="n">{i + 1}</span>{t}</li>)}</ol>
          <div class="grid g2" style="margin-top:22px">
            <div class="card" data-reveal><h3>Documents</h3><ul class="tick-list">{demo.docs.map((d) => <li><Icon name="document" size={18} />{d}</li>)}</ul></div>
            <div class="card" data-reveal><h3>Roles</h3><ul class="tick-list">{demo.roles.map((d) => <li><Icon name="people" size={18} />{d}</li>)}</ul><p class="mute small">Each role sees only what it needs. Sensitive steps need a second person.</p></div>
          </div>
          <p style="margin-top:20px"><a class="btn" href={`/demo/${s.slug}`}>Click through the {s.name} demo <Icon name="arrow" size={16} /></a></p>
        </Section>) : null}
      <Section eyebrow="FREE AND PAID" title={<>What you get free.<br />What runs monthly.</>} intro="Free customisation is part of every free build. Paid add-ons are optional and priced by the monthly plan that covers them.">
        <div class="grid g2">
          <div class="card" data-reveal><Badge s="available" label="Free" /><h3 style="margin-top:12px">Customisation we do for you</h3>
            <ul class="tick-list">{free.map((f) => <li><Icon name="check" size={18} /><span><strong>{f.name}.</strong> {f.blurb}</span></li>)}</ul></div>
          <div class="card" data-reveal><Badge s="pending" label="Monthly plan" /><h3 style="margin-top:12px">Paid add-ons for this sector</h3>
            <ul class="tick-list">{paid.map((f) => <li><Icon name="plus" size={18} /><span><strong>{f.name}</strong> <span class="mute small">· {plans.find((p) => p.plan === f.minPlan)!.name} plan, {aed(plans.find((p) => p.plan === f.minPlan)!.monthlyMinor)} a month{f.status === "pilot" ? " · pilot" : ""}</span><br />{f.blurb}</span></li>)}</ul>
            <p class="mute small">Prices are planning prices. VAT and a one-off setup fee are shown before you pay. <a href="/pricing">Compare plans</a>.</p></div>
        </div>
      </Section>
      {sc ? (
        <Section tone="alt" eyebrow="YOURS TO ADD" title={<>What you enter yourself.</>} intro="We build the system. You add your private details in your own admin panel, and your dashboard shows the exact screen for each.">
          <div class="grid g2"><div class="card" data-reveal><h3>For {s.name}</h3><ul class="tick-list">{sc.yours.map((y) => <li><Icon name="lock" size={18} />{y}</li>)}</ul></div><NeverAsk /></div>
        </Section>) : null}
      <CtaBand title={<>Want {s.name}<br />made yours?</>} body={`Register, send your brand, and we deliver within ${H()} hours.`} primary={["Apply for this pack", `/start?sector=${s.slug}`]} />
      <Section tone="tint"><p style="margin:0;text-align:center"><a href={`/sectors/${next.slug}`}>Next: {next.name} →</a></p></Section>
    </PublicShell>);
}
