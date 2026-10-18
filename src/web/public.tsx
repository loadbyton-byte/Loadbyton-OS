import { HomeExperience } from "./home.js";
import { Icon } from "./experience.js";
import { CONTACT, Lbt, waLink } from "./brand.js";
import { CtaBand, Faq, Feature, PHOTO, PageHero, Section, sectorPhoto } from "./site-kit.js";
import { Hono } from "hono";
import { currentPlans, INTEGRATIONS, PLAN_SEEDS, PRODUCTS, recommendBundle, SECTORS, withLiveAvailability, type PlanVersion } from "../platform/catalog.js";
import { releasedSectors } from "../platform/readiness.js";
import { HttpError, badRequest, fmtMoney } from "../lib/util.js";
import { arr, clientIp, formBody, str, type Env } from "./mw.js";
import { rateLimit } from "../lib/ratelimit.js";
import { Badge, Csrf, PublicShell, type Page } from "./ui.js";
import { provisioningStats } from "../platform/provisioning.js";
import { config } from "../config.js";
import { brochurePricing } from "./requests.js";
import { SectorCards, brochureSectorPage } from "./brochure.js";

export const pub = new Hono<Env>();

const pg = (c: any, title: string, extra: Partial<Page> = {}): Page => ({
  title, csrf: c.get("csrf"), path: c.req.path, user: c.get("session") ? { name: c.get("session").name } : null,
  ok: c.req.query("ok"), err: c.req.query("err"), heroDark: true, ...extra,
});
const aed = (v: number) => fmtMoney(v).replace(/\.00$/, "");
const AVAIL_LABEL = { available: "Available", pilot: "Pilot", planned: "Planned" } as const;
const AvailBadge = ({ s }: { s: keyof typeof AVAIL_LABEL }) => <Badge s={s} label={AVAIL_LABEL[s]} />;

pub.get("/", async (c) => {
  const p = pg(c, "Logistics operating platform for UAE logistics companies");
  const plans = await currentPlans(c.get("db"));
  const sectors = withLiveAvailability(await releasedSectors(c.get("db")));
  return c.html(
    <PublicShell p={p}>
      <HomeExperience plans={plans} sectors={sectors} />
    </PublicShell>,
  );
});


pub.get("/enterprise", (c) => c.html(
  <PublicShell p={pg(c, "Enterprise controls", { description: "Tenant isolation, team roles, reviewed financial operations, audit history and deployment readiness for your logistics workspace." })}>
    <PageHero kicker="ENTERPRISE CONTROLS" photo={PHOTO.enterprise} title={<>More operational depth.<br />More deliberate control.</>} lede="Bring your team, workflows and evidence together. Enterprise capacity builds on the same company records and approval controls.">
      <a class="btn red" href="/contact">Discuss your requirements <Icon name="arrow" size={16} /></a><a class="btn glass" href="/pricing">Compare plans</a>
    </PageHero>
    <Section eyebrow="IMPLEMENTED PLATFORM CONTROLS" title={<>Give every action<br />the right context.</>} intro="These controls exist in the platform. Your selected sectors, subscription capacity and team roles decide the tools each person sees.">
      <div class="grid g2">
        <Feature icon="shield" title="Company isolation and access">Tenant-scoped transactions, row-level security, team permissions, customer portals, limited driver seats and company MFA.</Feature>
        <Feature icon="people" title="Governance and review">Independent approval for sensitive workflows, controlled support-access grants, audited staff actions and versioned source evidence.</Feature>
        <Feature icon="money" title="Financial visibility">Invoices, collections, supplier bills, credit notes, exchange rates and an optional general ledger with sub-ledger reconciliation.</Feature>
        <Feature icon="document" title="Operational depth">Freight tenders, supplier contracts, master shipments, warehouse traceability, storage billing, transport receipts and delivery cash controls.</Feature>
        <Feature icon="grid" title="Platform management">Versioned plans, usage limits, billing, provisioning, rollout controls and a privileged platform console.</Feature>
        <Feature icon="clock" title="Continuity and monitoring">Health and readiness endpoints, gated metrics, encrypted backups, restore verification and retention review.</Feature>
      </div>
    </Section>
    <Section tone="tint" eyebrow="DEPLOYMENT IS A SEPARATE ACCEPTANCE STEP" title={<>Configure. Rehearse.<br />Then accept.</>} intro="Software capability and production acceptance are different stages. External services must be configured and verified for your deployment.">
      <div class="grid g3">
        <article class="card" data-reveal><Badge s="available" label="Available software" /><h3 style="margin-top:20px">Operational workflows</h3><p class="mute">Tested flows still need your own acceptance before production rollout.</p></article>
        <article class="card" data-reveal><Badge s="planned" label="Provider setup required" /><h3 style="margin-top:20px">External integrations</h3><p class="mute">Payments, messaging, object storage, OCR, e-invoicing and statement feeds need provider configuration and acceptance.</p></article>
        <article class="card" data-reveal><Badge s="planned" label="Separate capability" /><h3 style="margin-top:20px">Marketplace and enterprise identity</h3><p class="mute">Public carrier bidding, escrow settlement, SAML SSO and SCIM provisioning are not part of this platform.</p></article>
      </div>
    </Section>
    <CtaBand title={<>Bring us your<br />acceptance checklist.</>} />
  </PublicShell>
));

pub.get("/sectors", async (c) => {
  const SECTORS = withLiveAvailability(await releasedSectors(c.get("db")));
  const p = pg(c, "Sectors", { description: config.brochureMode ? "All 18 logistics sector packs in detail: what each does, what is free, what runs on a monthly plan." : "18 configurable logistics sector profiles. Combine them in one company account." });
  const fam = (s: (typeof SECTORS)[number]) => s.family;
  return c.html(
    <PublicShell p={p}>
      <PageHero kicker="SECTORS" photo={PHOTO.port} title={config.brochureMode ? <>Eighteen sector packs.<br />Made yours in {config.deliveryHours} hours.</> : <>Eighteen sector profiles.<br />One company account.</>} lede={config.brochureMode ? "Open any pack for what it does, the documents it produces, what we customise for free and what runs on a monthly plan. Proposed commercial profiles, not an official UAE classification." : "Proposed commercial profiles, not an official UAE classification. Combine them while keeping one entity and shared master records."} />
      <Section>
        <div data-filter-group>
          <div class="chips" role="group" aria-label="Filter sectors">
            {[["all", "All"], ["freight", "Freight"], ["movement", "Movement"], ["storage", "Storage"]].map(([k, l], i) => <button class="chip" type="button" data-filter={k} aria-pressed={i === 0 ? "true" : "false"}>{l}</button>)}
          </div>
          {config.brochureMode ? <SectorCards sectors={SECTORS} /> : <div class="grid g3">
            {SECTORS.map((s) => (
              <a class="sector-card" href={`/sectors/${s.slug}`} data-cat={fam(s)} data-reveal>
                <span class="sc-photo"><img src={sectorPhoto(s.slug, true)} alt="" width="800" height="450" loading="lazy" decoding="async" /><img class="si" src={`/brand/icons/${s.slug}.svg`} alt="" width="40" height="40" /></span>
                <span class="sc-body">
                  <h3>{s.name}</h3>
                  <span class="sc-badges"><AvailBadge s={s.availability} />{s.specialist ? <span class="badge bad">Specialist review</span> : null}</span>
                  <p>{s.workflow}</p>
                  <span class="go">Open profile <Icon name="arrow" size={14} /></span>
                </span>
              </a>
            ))}
          </div>}
        </div>
        <p class="mute small prose" style="margin-top:28px">Specialist profiles need subject-matter review: a generic workflow checklist is not certification to handle dangerous goods, pharmaceutical cold chain or bonded inventory.</p>
      </Section>
      {config.brochureMode ? <CtaBand title={<>Not sure which<br />pack fits?</>} body="Tell us what you move and we will point you to the right one." primary={["See how it works", "/how-it-works"]} /> : <CtaBand title={<>Not sure which<br />pack fits?</>} body="Tell us what you move and we will point you to the right one." primary={["Find my bundle", "/find-my-bundle"]} />}
    </PublicShell>,
  );
});

pub.get("/sectors/:slug", async (c) => {
  if (config.brochureMode) return brochureSectorPage(c);
  const s = withLiveAvailability(await releasedSectors(c.get("db"))).find((x) => x.slug === c.req.param("slug"));
  if (!s) throw new HttpError(404, "Sector not found");
  const rec = recommendBundle([s.slug]);
  const p = pg(c, s.name);
  return c.html(
    <PublicShell p={p}>
      <PageHero kicker="SECTOR PACK" crumb={s.name} photo={sectorPhoto(s.slug)} title={<>{s.name} <AvailBadge s={s.availability} /></>} lede={s.workflow + "."}>
        <a class="btn red" href={`/start?sector=${s.slug}`}>Start free with this sector <Icon name="arrow" size={16} /></a><a class="btn glass" href="/sectors">All sectors</a>
      </PageHero>
      <Section>
        <div class="sector-split">
        <div class="prose">
          <h2>Specialist workflow and required controls</h2>
          <p>{s.workflow}.</p>
          {s.availability === "available"
            ? <div class="alert info"><Icon name="info" />This sector pack is available. Its release evidence (review, live cases, support owner) is tracked in our readiness register and shared on request.</div>
            : s.availability === "planned"
            ? <div class="alert info"><Icon name="info" />This sector pack is <strong>planned</strong>, not yet released. Registering records your interest and shapes our interview and acceptance work; it does not buy functionality that does not exist yet.</div>
            : <div class="alert warn"><Icon name="alert" />This workflow is in <strong>pilot</strong> with design partners. Expect rapid change and hands-on support.</div>}
          {s.specialist ? <div class="alert err"><Icon name="alert" />Specialist profile: requires subject-matter review. This software is not a certification to handle regulated cargo.</div> : null}
          <p>Indicative fit: <strong>{rec.plan === "starter" ? "Starter" : "Business"}</strong> plan (see <a href="/pricing">pricing</a>).</p>
        </div>
        <figure class="sector-figure" data-reveal="unveil"><img src={sectorPhoto(s.slug)} alt="" width="1672" height="941" loading="lazy" decoding="async" /><figcaption><span class="eyebrow">{s.family.toUpperCase()}</span><b>{s.name}</b></figcaption></figure>
        </div>
      </Section>
      <CtaBand />
    </PublicShell>,
  );
});

pub.get("/products", (c) => {
  const p = pg(c, "Products");
  return c.html(
    <PublicShell p={p}>
      <PageHero kicker="PRODUCTS" photo={PHOTO.intelligence} title={<>One platform core.<br />Seven products.</>} lede="Identity, organisations, permissions, master records, documents, tasks, communications, audit, integrations and reporting sit under every product." />
      <Section>
        <div class="grid g3">{PRODUCTS.map((x) => <div class="card spot" data-reveal><AvailBadge s={x.status} /><h3 style="margin-top:14px"><Lbt tag={x.name.replace("LOAD|BY|TON ", "").toUpperCase()} /></h3><p class="mute" style="margin:0">{x.blurb}</p></div>)}</div>
        <div class="prose" style="margin-top:40px">
          <h2>What this is, and is not</h2>
          <p>Commercial domains (CRM, rates and contracts, quotations) and financial domains (job costing, invoicing, collections, payables and one validated accounting integration) are shared, so you are never charged twice for the same record.</p>
          <p><Lbt />.store sells software subscriptions, setup and support services. Your customers use the software to sell and deliver freight, transport, clearance, storage or delivery services. Those are separate commercial relationships and separate accounting books. We are not a freight broker, cargo marketplace or carrier, and we do not hold customer funds.</p>
        </div>
      </Section>
      <CtaBand />
    </PublicShell>,
  );
});

pub.get("/find-my-bundle", async (c) => {
  if (config.brochureMode) return c.redirect("/sectors", 302);   // plans and bundles are the operating platform's; the brochure shows add-on prices on /pricing
  const q = new URL(c.req.url).searchParams.getAll("sector");
  const rec = recommendBundle(q);
  const plans = await currentPlans(c.get("db"));
  const SECTORS = withLiveAvailability(await releasedSectors(c.get("db")));
  const picked = SECTORS.filter((s) => q.includes(s.slug));
  const plan = plans.find((x) => x.plan_code === rec.plan) as PlanVersion;
  const p = pg(c, "Find my bundle");
  return c.html(
    <PublicShell p={p}>
      <PageHero kicker="FIND MY BUNDLE" photo={PHOTO.onboarding} title={<>Pick your sectors.<br />Get your price.</>} lede="We recommend a plan and show the net price. Shared CRM, finance and documents are included once, never charged twice." />
      <Section>
        <form method="get" action="/find-my-bundle">
          <fieldset><legend>Sectors</legend>
            <div class="checks">
              {SECTORS.map((s) => (
                <label class="check"><input type="checkbox" name="sector" value={s.slug} checked={q.includes(s.slug)} /><span>{s.name}<br /><span class="small mute">{AVAIL_LABEL[s.availability]}</span></span></label>
              ))}
            </div>
          </fieldset>
          <button class="btn red" type="submit">Show my bundle</button>
        </form>
        {q.length ? (
          <div class="card flag" style="margin-top:24px">
            <h2>Recommended: {plan.name}</h2>
            <p>{rec.reason}</p>
            {(rec as any).specialist?.map((n: string) => <p class="alert warn">{n}</p>)}
            {plan.contact_sales
              ? <p><strong>Scoped schedule.</strong> From {fmtMoney(plan.monthly_minor)} / month. <a href="/contact">Talk to us</a>.</p>
              : (
                <p>
                  <strong>{fmtMoney(plan.monthly_minor)}</strong> / month + <strong>{fmtMoney(plan.setup_minor)}</strong> one-off setup. Excludes applicable VAT and third-party pass-through charges; checkout shows the actual tax treatment and payable total.
                </p>
              )}
            {picked.some((s) => s.availability === "planned") ? <p class="alert info">Sectors marked Planned are not yet released. Start free with a sector that is in pilot today ({SECTORS.filter((x) => x.availability !== "planned").map((x) => x.name).join(", ")}); we will tell you when your other sectors reach pilot.</p> : null}
            <a class="btn red" href={`/start?${q.map((s) => `sector=${encodeURIComponent(s)}`).join("&")}`}>Start free with these sectors</a>
          </div>
        ) : null}
      </Section>
    </PublicShell>,
  );
});

const Limits = ({ pl }: { pl: PlanVersion }) => (
  <ul>
    <li>{pl.limits.max_sectors} sector{pl.limits.max_sectors > 1 ? "s" : ""}{pl.plan_code === "business" ? " (advanced)" : ""}</li>
    <li>{pl.limits.max_users} full users</li>
    <li>{pl.limits.max_branches} branch{pl.limits.max_branches > 1 ? "es" : ""}</li>
    <li>{pl.limits.jobs_per_month.toLocaleString("en")} jobs / month</li><li>{pl.limits.ai_drafts_per_month??0} assistant drafts / month (forwarding sources)</li>
    <li>{pl.limits.storage_mb >= 1024 ? `${pl.limits.storage_mb / 1024} GB` : `${pl.limits.storage_mb} MB`} documents</li>
  </ul>
);

pub.get("/pricing", async (c) => {
  if (config.brochureMode) return brochurePricing(c);
  const plans = await currentPlans(c.get("db"));
  const p = pg(c, "Pricing and plans");
  return c.html(
    <PublicShell p={p}>
      <PageHero kicker="PRICING" photo={PHOTO.finance} title={<>Start free.<br />Pay for depth.</>} lede="Free is useful enough to build a real operating habit. We charge for depth and capacity, never for basic security or for retrieving your own data." />
      <Section>
        <div class="alert warn"><Icon name="info" /><span><strong>Pilot pricing hypothesis.</strong> Prices below are planning hypotheses for the pilot, not an approved tariff. Prices exclude applicable tax and third-party pass-through charges. Published plan versions are immutable: a later price change never silently rewrites your contract.</span></div>
        <div class="grid g4" style="margin-top:8px">
          {plans.map((pl) => (
            <div class={`card plan spot ${pl.plan_code === "starter" ? "hot" : ""}`} data-reveal>
              {pl.plan_code === "starter" ? <span class="badge ok" style="width:fit-content;margin-bottom:10px">Most chosen</span> : null}
              <h3>{pl.name}</h3>
              <div class="price">{pl.contact_sales ? `From ${aed(pl.monthly_minor)}` : aed(pl.monthly_minor)}<small class="mute"> / month</small></div>
              <p class="small mute">{pl.contact_sales ? "Scoped setup" : pl.setup_minor ? `${fmtMoney(pl.setup_minor)} one-off setup` : "No setup fee"}</p>
              {pl.contact_sales ? <ul><li>Named allowances</li><li>Support and infrastructure schedule</li></ul> : <Limits pl={pl} />}
              {pl.contact_sales ? <a class="btn ghost" href="/contact">Talk to us</a> : pl.plan_code === "free" ? <a class="btn red" href="/start">Start free</a> : <a class="btn" href={`/start?plan=${pl.plan_code}`}>Start free, then upgrade</a>}
            </div>
          ))}
        </div>
        <h2 style="margin-top:56px">Compare plans</h2>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Included</th>{plans.map((pl) => <th>{pl.name}</th>)}</tr></thead>
          <tbody>
            {([["Sectors", "max_sectors"], ["Full users", "max_users"], ["Branches", "max_branches"], ["Jobs / month", "jobs_per_month"], ["Documents (MB)", "storage_mb"]] as const).map(([l, k]) => (
              <tr><th scope="row">{l}</th>{plans.map((pl) => <td>{pl.limits[k].toLocaleString("en")}</td>)}</tr>
            ))}
            <tr><th scope="row">Data export (CSV/JSON)</th>{plans.map(() => <td>✓</td>)}</tr>
            <tr><th scope="row">Roles, audit trail, tenant isolation</th>{plans.map(() => <td>✓</td>)}</tr>
            <tr><th scope="row">Monthly price</th>{plans.map((pl) => <td>{aed(pl.monthly_minor)}</td>)}</tr>
            <tr><th scope="row">Setup</th>{plans.map((pl) => <td>{pl.contact_sales ? "Scoped" : aed(pl.setup_minor)}</td>)}</tr>
          </tbody>
        </table></div>
        <h2 style="margin-top:48px">How limits work</h2>
        <ul class="prose">
          <li>A <strong>job</strong> is an operational case with a unique job ID; milestones are not metered separately. Billing units differ per sector: a forwarding <strong>job</strong>, a transport <strong>trip</strong>, a delivery <strong>parcel</strong> and a warehouse <strong>order</strong> (one inbound notice or one dispatch order) are separate allowances, and a warehouse scan would be a different unit again.</li>
          <li>Exceeding storage or record limits blocks <em>new</em> excess usage — it never blocks reading or exporting existing records.</li>
          <li>Downgrades apply at renewal after a preview of the consequences. Paid-period cancellation keeps agreed access. A published grace period precedes restriction.</li>
          <li>We do not offer unlimited messaging, AI, storage or visits in low-priced bundles. No unlimited 24/7 human support is implied on low-cost plans.</li>
          <li>No escrow, proprietary tokens or customer funds are held by <Lbt />.</li>
        </ul>
      </Section>
      <CtaBand title={<>Questions about<br />the numbers?</>} body="Ask on WhatsApp or email. You will get a straight answer from the people who set the prices." />
    </PublicShell>,
  );
});

pub.get("/how-activation-works", (c) => {
  const p = pg(c, "How activation works");
  const steps = ["Payment pending", "Verified", "Information pending (if required)", "Queued", "Provisioning", "Validation", "Ready", "Onboarding"];
  return c.html(
    <PublicShell p={p}>
      <PageHero kicker="HOW IT WORKS" photo={PHOTO.onboarding} title={<>How activation<br />works.</>} lede="Your free workspace is reused when you upgrade. Nothing is recreated." />
      <Section>
        <div class="prose">
          <p>After server-verified payment, entitlements and branded provisioning follow this sequence:</p>
          <ol class="stages">{steps.map((s) => <li>{s}</li>)}</ol>
          <p>Each provisioning step is idempotent: reserve slug → apply entitlement version → load configuration → attach routing → verify TLS → validate owner access → health and isolation checks → readiness notice → onboarding work. If anything is interrupted, it resumes safely without duplicates.</p>
          <div class="alert warn"><Icon name="info" /><span><strong>Pilot target, not a guarantee.</strong> Our standard branded activation target is within 24 hours, starting after verified payment and the minimum setup information (your legal entity name). Custom domains, historical migration, field visits and external-provider approvals have separate milestones and conditions. A compensation policy for provider-caused delay will be published before this becomes a promise.</span></div>
          <h2>What we never do</h2>
          <ul><li>Grant access from a browser success redirect — only a verified server-side payment event does.</li><li>Rewrite your free data when you upgrade.</li><li>Use shared passwords: every invitation creates an individual account.</li></ul>
        </div>
      </Section>
      <CtaBand />
    </PublicShell>,
  );
});

pub.get("/integrations", (c) => {
  const p = pg(c, "Integrations and live status");
  return c.html(
    <PublicShell p={p}>
      <PageHero kicker="INTEGRATIONS" photo={PHOTO.intelligence} title={<>Integrations and<br />their live status.</>} lede="We say live only after a tested tenant flow exists. Acceptance covers retry, duplicates, expired authorisation, outage, partial failure and reconciliation." />
      <Section>
        <div class="tbl-wrap"><table><thead><tr><th>Connector</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>{INTEGRATIONS.map((i) => <tr><td>{i.name}</td><td><AvailBadge s={i.status} /></td><td>{i.note}</td></tr>)}</tbody></table></div>
        <p class="small mute" style="margin-top:12px">Requirements and provider availability must be rechecked at implementation and periodically thereafter.</p>
      </Section>
    </PublicShell>,
  );
});

pub.get("/security", (c) => {
  const p = pg(c, "Security");
  return c.html(
    <PublicShell p={p}>
      <PageHero kicker="SECURITY" photo={PHOTO.enterprise} title={<>How the platform<br />protects your data.</>} lede="Design controls, described plainly. Not a certification or a legal compliance statement." />
      <Section>
        <div class="alert info"><Icon name="info" />UAE data protection and cross-border processing need deployment-specific review.</div>
        <div class="grid g2" style="margin-top:8px">
          <Feature icon="lock" title="Tenant isolation">Every tenant record carries a tenant ID and is protected by database-enforced row-level security under a restricted runtime role. The tenant comes from your authenticated membership, never from a browser-supplied ID or hostname alone. Composite foreign keys stop a record referencing another tenant's parent.</Feature>
          <Feature icon="users" title="Access">Individual accounts, role-based permissions, session revocation and an append-only audit trail. MFA is required for platform administrators. Support staff see your data only through a time-limited, read-only grant that you approve, with the operator's identity recorded.</Feature>
          <Feature icon="document" title="Files">Private, tenant-scoped storage paths; short-lived signed download links; uploads limited by type and size with content checks; downloads served as attachments so uploaded content never renders as application content.</Feature>
          <Feature icon="money" title="Payments and entitlements">Entitlements follow server-verified, signature-checked, replay-resistant payment events. Duplicate or out-of-order events cannot create a second transition.</Feature>
          <Feature icon="download" title="Your data">Export is available on every plan. Retention, deletion, breach procedure and subprocessors are in the <a href="/legal/data-processing">data processing</a> and <a href="/legal/subprocessors">subprocessor</a> pages.</Feature>
          <Feature icon="shield" title="Reporting a problem">Write to <a href={`mailto:${CONTACT.emails.support}`}>{CONTACT.emails.support}</a>. See also <a href="/trust">Trust &amp; safety</a> and <a href="/compliance">Compliance</a>.</Feature>
        </div>
      </Section>
      <CtaBand />
    </PublicShell>,
  );
});

pub.get("/stories", (c) => c.html(
  <PublicShell p={pg(c, "Customer stories")}>
    <PageHero kicker="CUSTOMER STORIES" photo={PHOTO.fleet} title={<>None yet.<br />On purpose.</>} lede="We publish case studies only with the customer's consent and verified results." />
    <Section>
      <div class="prose"><p>The design-partner pilot is just starting, so there is nothing honest to show. If you run a small UAE freight forwarding or transport business and would like to shape the product, <a href="/contact">talk to us</a>.</p></div>
    </Section>
    <CtaBand title={<>Be the first<br />story.</>} body="Design partners get hands-on setup and a direct line to the builders." />
  </PublicShell>));

pub.get("/resources", (c) => c.html(
  <PublicShell p={pg(c, "Resources")}>
    <PageHero kicker="RESOURCES" photo={PHOTO.warehouse} title={<>Guides and<br />references.</>} />
    <Section>
      <div class="grid g2">
        <a class="sector-card" href="/sectors"><h3>Sector workflow profiles</h3><p>What each of the eighteen packs covers.</p></a>
        <a class="sector-card" href="/pricing"><h3>Plan allowances</h3><p>How limits work and what each plan includes.</p></a>
        <a class="sector-card" href="/how-activation-works"><h3>How activation works</h3><p>What happens from payment to a ready workspace.</p></a>
        <a class="sector-card" href="/blog"><h3>Notes from the build</h3><p>Short, practical notes on margin, driver apps and honest roadmaps.</p></a>
      </div>
      <p class="mute" style="margin-top:20px">Practical operating guides (quote-to-cash checklists, supplier-cost control, collections follow-up) will be added with real examples as the pilot progresses.</p>
    </Section>
  </PublicShell>));

pub.get("/help", (c) => c.html(
  <PublicShell p={pg(c, "Help")}>
    <PageHero kicker="HELP" photo={PHOTO.onboarding} title={<>Help,<br />in plain words.</>} lede="Start here. If you are still stuck, a person will answer.">
      <a class="btn glass" href={waLink()} target="_blank" rel="noopener"><Icon name="whatsapp" size={18} />WhatsApp us</a>
    </PageHero>
    <Section eyebrow="Getting started" title={<>Five steps to<br />a working record.</>}>
      <ol class="steps" style="list-style:none;margin:0;padding:0;max-width:820px">
        {["Create your free workspace.", "Import or add customers and suppliers.", "Create a real enquiry, turn it into a quote, then a job.", "Record supplier costs, attach proof of delivery, invoice and track collection.", "Open the Owner dashboard. Every card links to the records behind it."].map((t, i) => <li class="step" data-reveal><span class="n">0{i + 1}</span><div><p style="color:var(--ink);margin:0">{i === 0 ? <><a href="/start">Create your free workspace</a>.</> : t}</p></div></li>)}
      </ol>
    </Section>
    <Section tone="tint" eyebrow="Common questions" title={<>Quick answers.</>}>
      <Faq items={[
        ["What happens if I exceed a limit?", "New records of that type are blocked; existing records stay readable and exportable."],
        ["Can I leave?", "Yes. Settings → Export gives you JSON and CSV on every plan."],
        ["Is the invoice a UAE e-invoice?", <>No. <Lbt /> is not an accredited e-invoicing service provider. Operational invoices can be reconciled with your accounting system or provider.</>],
        ["How do I reach a person?", <>WhatsApp <a href={waLink()} target="_blank" rel="noopener">{CONTACT.phoneDisplay}</a>, email <a href={`mailto:${CONTACT.emails.support}`}>{CONTACT.emails.support}</a>, or the live chat at the bottom right of this page.</>],
      ]} />
    </Section>
  </PublicShell>));

pub.get("/coverage", (c) => c.html(
  <PublicShell p={pg(c, "Service coverage")}>
    <PageHero kicker="COVERAGE" photo={PHOTO.transit} title={<>What we cover.<br />What we do not.</>} />
    <Section>
      <div class="grid g2">
        <Feature icon="pin" title="Market">UAE-first. Initial design partners are small UAE freight forwarders that coordinate transport through suppliers and currently use email, WhatsApp and spreadsheets.</Feature>
        <Feature icon="globe" title="Software">English and Arabic interface layers, AED and multi-currency fields, tax identifiers and Arabic or RTL document layouts.</Feature>
        <Feature icon="headset" title="Setup">Basic setup is a bounded remote service: entity and branding, purchased templates, owner and staff invitation, initial customer import, one remote training session and an acceptance checklist. On-site visits, travel, printer or barcode setup and historical migration are scoped additions.</Feature>
        <Feature icon="alert" title="Not covered">Filing customs declarations (the customs module is case management and a controlled handover to your licensed broker channel), global customs coverage, airport-certified systems, complex bonded warehouse automation and enterprise-wide migration.</Feature>
      </div>
    </Section>
  </PublicShell>));

const LEGAL: Record<string, { title: string; body: any }> = {
  terms: { title: "Terms of service", body: (<>
    <p>LOAD|BY|TON.store provides logistics software subscriptions, setup and support services. You use the software to run your own logistics business; those services are separate commercial relationships and accounting books between you and your customers.</p>
    <h2>Plans and billing</h2><p>Published plan versions are immutable commercial records. Prices exclude applicable tax and third-party pass-through charges. Paid-period cancellation retains agreed access; a published grace period precedes restriction; exceeding limits blocks new excess usage, not reading or export.</p>
    <h2>No funds held</h2><p>LOAD|BY|TON does not hold, escrow or transmit customer funds. You may record collections in your own finance workflow.</p>
    <h2>Regulated activities</h2><p>The software is not an accredited e-invoicing provider, customs authority or certification to handle dangerous goods, pharmaceutical cold chain or bonded inventory.</p></>) },
  privacy: { title: "Privacy notice", body: (<>
    <p>We process account and operational data to provide the service. For your customers’ data, you are the controller and we act as processor under the data processing terms; for our own commercial relationship with you we are a controller.</p>
    <h2>Your rights</h2><p>Export is available on every plan. Owners can submit access, correction and deletion requests under Your data; deletion is reviewed for statutory retention and legal holds before the deployment operator performs erasure.</p></>) },
  "data-processing": { title: "Data processing", body: (<>
    <p>Roles: you are the controller of operational records in your workspace; LOAD|BY|TON is the processor. Records are stored in tenant-isolated storage; files are private with short-lived signed access.</p>
    <h2>Retention and exit</h2><p>The deployment retention schedule is {config.retentionDays} days after the applicable exit milestone, subject to contract terms, statutory records and legal holds. Export remains available while the account is retained. Approved erasure includes the database, private objects and eventual expiry of recovery copies under the provider schedule.</p>
    <h2>Incidents</h2><p>A breach procedure with customer communication owner and incident commander is maintained by the operating team.</p></>) },
  subprocessors: { title: "Subprocessors", body: (<>
    <ul><li>Oracle Cloud Infrastructure: application and background compute.</li><li>Cloudflare: DNS, TLS edge and origin tunnel.</li><li>Neon: transactional PostgreSQL and configured recovery.</li><li>Supabase: private document objects.</li><li>Upstash: shared abuse-prevention counters with pseudonymous keys.</li><li>Stripe and/or Razorpay: hosted payment processing when enabled.</li><li>Your configured SMTP provider: account and service notifications.</li></ul>
    <p>Deployment region and processing schedule: {config.deploymentRegion}. Review each provider's region, retention, transfer and recovery terms before deployment; providers may process security/payment data in additional locations.</p></>) },
  accessibility: { title: "Accessibility", body: (<>
    <p>We design for keyboard use, visible focus, sufficient contrast, text and icons in addition to colour (red is never the only indicator of an error), and large touch targets for driver workflows. We have not yet completed a formal accessibility audit; report problems via <a href="/contact">Contact</a>.</p></>) },
};
pub.get("/legal/:doc", (c) => {
  const d = LEGAL[c.req.param("doc")];
  if (!d) throw new HttpError(404, "Page not found");
  return c.html(
    <PublicShell p={pg(c, d.title)}>
      <PageHero kicker="LEGAL" photo={PHOTO.enterprise} title={d.title} />
      <Section>
        <div class="prose-card prose">
          {config.legalReviewed?null:<div class="draft-note"><strong>Draft — requires legal review before publication.</strong> Review this service-specific copy with the contracting entity before setting LEGAL_REVIEWED.</div>}
          {d.body}
          {config.seller.legalName?<p>Contracting service provider: {config.seller.legalName}, {config.seller.address}. {config.seller.gstin?`Tax registration: ${config.seller.gstin}.`:''} Contact: {config.seller.email}.</p>:null}
        </div>
      </Section>
    </PublicShell>);
});


pub.get("/contact", (c) => {
  const p = pg(c, "Contact");
  return c.html(
    <PublicShell p={p}>
      <PageHero kicker="CONTACT" photo={PHOTO.road} title={<>Talk to a person.<br />Not a form letter.</>} lede="Tell us about your logistics business. We reply from a named human, usually within one working day." />
      <Section>
        <div class="contact-grid">
          <ul class="contact-list" data-reveal>
            <li><a class="wa" href={waLink()} target="_blank" rel="noopener"><span class="ci"><Icon name="whatsapp" size={24} /></span><span><b>WhatsApp</b><small>{CONTACT.phoneDisplay} · fastest reply</small></span><Icon name="arrowUpRight" size={18} /></a></li>
            <li><a href={CONTACT.tel}><span class="ci"><Icon name="phone" size={22} /></span><span><b>Call</b><small>{CONTACT.phoneDisplay}</small></span><Icon name="arrowUpRight" size={18} /></a></li>
            <li><a href={`mailto:${CONTACT.emails.contact}`}><span class="ci"><Icon name="mail" size={22} /></span><span><b>Sales and enquiries</b><small>{CONTACT.emails.contact}</small></span><Icon name="arrowUpRight" size={18} /></a></li>
            <li><a href={`mailto:${CONTACT.emails.support}`}><span class="ci"><Icon name="headset" size={22} /></span><span><b>Support</b><small>{CONTACT.emails.support}</small></span><Icon name="arrowUpRight" size={18} /></a></li>
            <li><a href={`mailto:${CONTACT.emails.info}`}><span class="ci"><Icon name="info" size={22} /></span><span><b>General information</b><small>{CONTACT.emails.info}</small></span><Icon name="arrowUpRight" size={18} /></a></li>
            <li><button type="button" class="btn ghost" style="width:100%" data-open-chat><Icon name="chat" size={18} />Open live chat</button></li>
          </ul>
          <div class="prose-card" data-reveal>
            <h2 style="font-size:1.5rem">Write to us</h2>
            <form method="post" action="/contact">
              <Csrf t={p.csrf} />
              <div class="row">
                <div class="field"><label for="n">Your name</label><input id="n" name="name" type="text" required autocomplete="name" /></div>
                <div class="field"><label for="co">Company</label><input id="co" name="company" type="text" autocomplete="organization" /></div>
              </div>
              <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="email" /></div>
              <div class="field"><label for="m">How do you run quotes, jobs and invoices today?</label><textarea id="m" name="message" maxlength={2000}></textarea></div>
              <button class="btn red" type="submit">Send <Icon name="arrow" size={16} /></button>
            </form>
          </div>
        </div>
      </Section>
    </PublicShell>,
  );
});
pub.post("/contact", async (c) => {
  const b = await formBody(c);
  const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
  await rateLimit(`lead:${clientIp(c) || "local"}`, 8, 3600, "Too many messages from this connection. Please try again later.");
  const email = str(b.email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !str(b.name).trim()) {
    if (wantsJson) return c.json({ ok: false, error: "Enter your name and a valid email." }, 400);
    return c.redirect("/contact?err=" + encodeURIComponent("Enter your name and a valid email."));
  }
  const source = ["contact", "offer"].includes(str(b.source)) ? str(b.source) : "contact";
  await c.get("db").query(`INSERT INTO platform_leads(name,company,email,message,source) VALUES ($1,$2,$3,$4,$5)`,
    [str(b.name).slice(0, 200), str(b.company).slice(0, 200) || null, email, str(b.message).slice(0, 2000) || null, source]);
  if (wantsJson) return c.json({ ok: true });
  return c.redirect("/?ok=" + encodeURIComponent("Thanks — we will reply personally."));
});

pub.get("/status", async (c) => {
  const db = c.get("db");
  let dbOk = true;
  try { await db.query("SELECT 1"); } catch { dbOk = false; }
  const st = dbOk ? await provisioningStats(db) : null;
  const dead = dbOk ? Number((await db.query<any>(`SELECT count(*) n FROM outbox WHERE status='dead'`)).rows[0].n) : 0;
  const p = pg(c, "Service status");
  const row = (name: string, ok: boolean, note = "") => <tr><td>{name}</td><td><Badge s={ok ? "ok" : "failed"} label={ok ? "Operational" : "Degraded"} /></td><td class="mute">{note}</td></tr>;
  return c.html(
    <PublicShell p={p}>
      <PageHero kicker="STATUS" photo={PHOTO.intelligence} title={<>Service status.</>} />
      <Section>
        <div>
        <div class="tbl-wrap"><table><thead><tr><th>Component</th><th>State</th><th>Detail</th></tr></thead><tbody>
          {row("Application & database", dbOk)}
          {row("Workspace provisioning", !!st && st.failed === 0 && st.aged === 0, st ? `${st.completed} completed · ${st.aged} aged · ${st.failed} failed` : "")}
          {row("Outbound notifications", dead === 0, dead ? `${dead} undeliverable` : "")}
        </tbody></table></div>
        <p class="small mute" style="margin-top:12px">Targets (to be validated before any contractual commitment): 99.9% monthly availability; p95 ordinary interactive reads under 1.5 s at published pilot load; shared-platform RPO ≤ 1 hour, RTO ≤ 8 hours. These are engineering objectives, not present guarantees.</p>
        <p class="small mute">Environment: {config.isProd ? "production" : "development"}.</p>
        </div>
      </Section>
    </PublicShell>,
  );
});

export { AvailBadge };
