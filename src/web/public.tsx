import { Hono } from "hono";
import { currentPlans, INTEGRATIONS, PLAN_SEEDS, PRODUCTS, recommendBundle, SECTORS, sectorBySlug, type PlanVersion } from "../platform/catalog.js";
import { HttpError, badRequest, fmtMoney } from "../lib/util.js";
import { arr, formBody, str, type Env } from "./mw.js";
import { Badge, Csrf, PublicShell, type Page } from "./ui.js";
import { provisioningStats } from "../platform/provisioning.js";
import { config } from "../config.js";

export const pub = new Hono<Env>();

const pg = (c: any, title: string, extra: Partial<Page> = {}): Page => ({
  title, csrf: c.get("csrf"), path: c.req.path, user: c.get("session") ? { name: c.get("session").name } : null,
  ok: c.req.query("ok"), err: c.req.query("err"), ...extra,
});
const AVAIL_LABEL = { available: "Available", pilot: "Pilot", planned: "Planned" } as const;
const AvailBadge = ({ s }: { s: keyof typeof AVAIL_LABEL }) => <Badge s={s} label={AVAIL_LABEL[s]} />;

pub.get("/", async (c) => {
  const p = pg(c, "Logistics operating platform for UAE logistics companies");
  return c.html(
    <PublicShell p={p}>
      <section class="hero">
        <div class="wrap">
          <img class="hero-logo" src="/brand/logo-silver.png" alt="LOAD|BY|TON.store" width="560" height="172" />
          <div class="eyebrow">Business · Product · Architecture · Execution</div>
          <h1>Run the movement. Know the margin.</h1>
          <p class="lead">Your logistics company, connected. Start free, choose the tools your business needs, and run enquiries, jobs, documents, deliveries and collections from one branded workspace.</p>
          <div class="actions">
            <a class="btn red" href="/start">Start free</a>
            <a class="btn ghost" href="/find-my-bundle">Find my bundle</a>
          </div>
        </div>
      </section>

      <section class="block">
        <div class="wrap">
          <h2>One workspace. One set of records. Upgrade without starting over.</h2>
          <div class="grid g3">
            <div class="card flat"><h3>1 · Register once</h3><p>Company, contact, emirate and sectors. You get a real, empty workspace on the permanent Free plan — no trade documents demanded up front.</p></div>
            <div class="card flat"><h3>2 · Add depth as you grow</h3><p>Buy sector bundles with a visible total price. The same company account upgrades in place; your customers, jobs and documents stay exactly where they are.</p></div>
            <div class="card flat"><h3>3 · See the margin</h3><p>Quotation estimate, updated expected cost and actual reconciled outcome — kept separate, with “Why this number?” linking to source records.</p></div>
          </div>
        </div>
      </section>

      <section class="block alt">
        <div class="wrap">
          <h2>First complete workflow: LOAD<span class="sep"></span>BY<span class="sep"></span>TON Forwarding Starter</h2>
          <p class="prose">Enquiry → quote → job → supplier costs → document and milestone control → invoice → collection visibility. Build so a small logistics owner can trust one complete daily workflow before anything else is added.</p>
          <ol class="stages" aria-label="Forwarding workflow">
            {["Enquiry", "Quote", "Job", "Supplier costs", "Documents & milestones", "Invoice", "Collection"].map((s) => <li>{s}</li>)}
          </ol>
          <div class="grid g3">
            <div class="card"><h3>Jobs delivered, not yet invoiced</h3><p>See them as soon as proof of delivery is on file — before cash leaks.</p></div>
            <div class="card"><h3>Costs missed before invoicing</h3><p>Supplier costs stay as visible accruals until the supplier invoice is reconciled.</p></div>
            <div class="card"><h3>Operational vs financial closure</h3><p>A delivered job can still have unreceived supplier invoices or overdue receivables. Owners see the difference.</p></div>
          </div>
        </div>
      </section>

      <section class="block">
        <div class="wrap">
          <h2>Honest availability</h2>
          <p class="prose">We sell the first complete workflow and publish a clear distinction between what is available, in pilot and planned. Nothing below is shown as live until a tested end-to-end flow exists.</p>
          <div class="grid g3">
            {PRODUCTS.map((x) => (
              <div class="card"><h3>{x.name} <AvailBadge s={x.status} /></h3><p class="mute">{x.blurb}</p></div>
            ))}
          </div>
          <p style="margin-top:20px"><a class="btn ghost" href="/sectors">See all 18 sector profiles</a></p>
        </div>
      </section>
    </PublicShell>,
  );
});

pub.get("/sectors", (c) => {
  const p = pg(c, "Sectors", { description: "18 configurable logistics sector profiles. Combine them in one company account." });
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="wrap">
        <h1>18 configurable sector profiles</h1>
        <p class="prose">These are proposed commercial profiles, not an official UAE sector classification. A customer can combine them while keeping one entity and shared master records. Specialist profiles need subject-matter review: a generic workflow checklist is not certification to handle dangerous goods, pharmaceutical cold chain or bonded inventory.</p>
        <div class="grid g3">
          {SECTORS.map((s) => (
            <a class="card" href={`/sectors/${s.slug}`} style="text-decoration:none;color:inherit">
              <h3>{s.name} <AvailBadge s={s.availability} /></h3>
              <p class="mute small">{s.workflow}</p>
              {s.specialist ? <span class="badge bad">Specialist review required</span> : null}
            </a>
          ))}
        </div>
      </div></section>
    </PublicShell>,
  );
});

pub.get("/sectors/:slug", (c) => {
  const s = sectorBySlug(c.req.param("slug"));
  if (!s) throw new HttpError(404, "Sector not found");
  const rec = recommendBundle([s.slug]);
  const p = pg(c, s.name);
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="wrap prose">
        <p><a href="/sectors">← All sectors</a></p>
        <h1>{s.name} <AvailBadge s={s.availability} /></h1>
        <h2>Specialist workflow and required controls</h2>
        <p>{s.workflow}.</p>
        {s.availability === "planned"
          ? <div class="alert info">This sector pack is <strong>planned</strong>, not yet released. Registering records your interest and shapes our interview and acceptance work; it does not buy functionality that does not exist yet.</div>
          : <div class="alert warn">This workflow is in <strong>pilot</strong> with design partners. Expect rapid change and hands-on support.</div>}
        {s.specialist ? <div class="alert err">Specialist profile: requires subject-matter review. This software is not a certification to handle regulated cargo.</div> : null}
        <p>Indicative fit: <strong>{rec.plan === "starter" ? "Starter" : "Business"}</strong> plan (see <a href="/pricing">pricing hypothesis</a>).</p>
        <p><a class="btn red" href={`/start?sector=${s.slug}`}>Start free with this sector</a></p>
      </div></section>
    </PublicShell>,
  );
});

pub.get("/products", (c) => {
  const p = pg(c, "Products");
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="wrap">
        <h1>One platform core. Seven LOAD|BY|TON products.</h1>
        <p class="prose">The shared core — identity, organizations, permissions, master records, documents, tasks, communications, audit, integrations and reporting — sits under every product. Commercial domains (CRM, rates and contracts, quotations) and financial domains (job costing, invoicing, collections, payables and one validated accounting integration) are shared, so you are never charged twice for the same record.</p>
        <div class="grid g3">
          {PRODUCTS.map((x) => <div class="card flat"><h3>{x.name} <AvailBadge s={x.status} /></h3><p>{x.blurb}</p></div>)}
        </div>
        <h2 style="margin-top:36px">What this is — and is not</h2>
        <p class="prose">LOAD|BY|TON.store sells software subscriptions, setup and support services. Your customers use the software to sell and deliver freight, transport, clearance, storage or delivery services — those are separate commercial relationships and separate accounting books. LOAD|BY|TON is not a freight broker, cargo marketplace or carrier, and it does not hold customer funds.</p>
      </div></section>
    </PublicShell>,
  );
});

pub.get("/find-my-bundle", async (c) => {
  const q = new URL(c.req.url).searchParams.getAll("sector");
  const rec = recommendBundle(q);
  const plans = await currentPlans(c.get("db"));
  const plan = plans.find((x) => x.plan_code === rec.plan) as PlanVersion;
  const p = pg(c, "Find my bundle");
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="wrap">
        <h1>Find my bundle</h1>
        <p class="prose">Pick the sectors you operate in. We recommend a plan and show the net price — shared CRM, finance and documents are included once, never charged twice.</p>
        <form method="get" action="/find-my-bundle">
          <fieldset><legend>Sectors</legend>
            <div class="checks">
              {SECTORS.map((s) => (
                <label class="check"><input type="checkbox" name="sector" value={s.slug} checked={q.includes(s.slug)} /><span>{s.name}<br /><span class="small mute">{AVAIL_LABEL[s.availability]}</span></span></label>
              ))}
            </div>
          </fieldset>
          <button class="btn" type="submit">Show my bundle</button>
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
            {rec.picked.some((s) => s.availability === "planned") ? <p class="alert info">Sectors marked Planned are not yet released. Start free with Freight forwarding today; we will tell you when your other sectors reach pilot.</p> : null}
            <a class="btn red" href={`/start?${q.map((s) => `sector=${encodeURIComponent(s)}`).join("&")}`}>Start free with these sectors</a>
          </div>
        ) : null}
      </div></section>
    </PublicShell>,
  );
});

const Limits = ({ pl }: { pl: PlanVersion }) => (
  <ul>
    <li>{pl.limits.max_sectors} sector{pl.limits.max_sectors > 1 ? "s" : ""}{pl.plan_code === "business" ? " (advanced)" : ""}</li>
    <li>{pl.limits.max_users} full users</li>
    <li>{pl.limits.max_branches} branch{pl.limits.max_branches > 1 ? "es" : ""}</li>
    <li>{pl.limits.jobs_per_month.toLocaleString("en")} jobs / month</li>
    <li>{pl.limits.storage_mb >= 1024 ? `${pl.limits.storage_mb / 1024} GB` : `${pl.limits.storage_mb} MB`} documents</li>
  </ul>
);

pub.get("/pricing", async (c) => {
  const plans = await currentPlans(c.get("db"));
  const p = pg(c, "Pricing and plans");
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="wrap">
        <h1>Start free. Pay for depth, capacity and service.</h1>
        <p class="prose">Free is useful enough to build a real operating habit. We charge for depth and capacity — never for basic security or for retrieving your own data: export is available on every plan, including after a downgrade.</p>
        <div class="alert warn"><strong>Pilot pricing hypothesis.</strong> Prices below are planning hypotheses for the pilot, not an approved tariff. Prices exclude applicable tax and third-party pass-through charges. Published plan versions are immutable: a later price change never silently rewrites your contract.</div>
        <div class="grid g4">
          {plans.map((pl) => (
            <div class={`card plan ${pl.plan_code === "starter" ? "hot" : ""}`}>
              <h3>{pl.name}</h3>
              <div class="price">{pl.contact_sales ? `From ${fmtMoney(pl.monthly_minor)}` : fmtMoney(pl.monthly_minor)}<span class="small mute"> / month</span></div>
              <p class="small mute">{pl.contact_sales ? "Scoped setup" : pl.setup_minor ? `${fmtMoney(pl.setup_minor)} one-off setup` : "No setup fee"}</p>
              {pl.contact_sales ? <ul><li>Named allowances</li><li>Support and infrastructure schedule</li></ul> : <Limits pl={pl} />}
              {pl.contact_sales ? <a class="btn ghost" href="/contact">Talk to us</a> : pl.plan_code === "free" ? <a class="btn red" href="/start">Start free</a> : <a class="btn" href={`/start?plan=${pl.plan_code}`}>Start free, then upgrade</a>}
            </div>
          ))}
        </div>
        <h2 style="margin-top:40px">Compare plans</h2>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Included</th>{plans.map((pl) => <th>{pl.name}</th>)}</tr></thead>
          <tbody>
            {([["Sectors", "max_sectors"], ["Full users", "max_users"], ["Branches", "max_branches"], ["Jobs / month", "jobs_per_month"], ["Documents (MB)", "storage_mb"]] as const).map(([l, k]) => (
              <tr><th scope="row">{l}</th>{plans.map((pl) => <td>{pl.limits[k].toLocaleString("en")}</td>)}</tr>
            ))}
            <tr><th scope="row">Data export (CSV/JSON)</th>{plans.map(() => <td>✓</td>)}</tr>
            <tr><th scope="row">Roles, audit trail, tenant isolation</th>{plans.map(() => <td>✓</td>)}</tr>
            <tr><th scope="row">Monthly price</th>{plans.map((pl) => <td>{fmtMoney(pl.monthly_minor)}</td>)}</tr>
            <tr><th scope="row">Setup</th>{plans.map((pl) => <td>{pl.contact_sales ? "Scoped" : fmtMoney(pl.setup_minor)}</td>)}</tr>
          </tbody>
        </table></div>
        <h2 style="margin-top:32px">How limits work</h2>
        <ul class="prose">
          <li>A <strong>job</strong> is an operational case with a unique job ID; milestones are not metered separately. Billing units differ per sector: a forwarding <strong>job</strong>, a transport <strong>trip</strong> and a warehouse <strong>order</strong> (one inbound notice or one dispatch order) are separate allowances, and a parcel or a warehouse scan would be a different unit again.</li>
          <li>Exceeding storage or record limits blocks <em>new</em> excess usage — it never blocks reading or exporting existing records.</li>
          <li>Downgrades apply at renewal after a preview of the consequences. Paid-period cancellation keeps agreed access. A published grace period precedes restriction.</li>
          <li>We do not offer unlimited messaging, AI, storage or visits in low-priced bundles. No unlimited 24/7 human support is implied on low-cost plans.</li>
          <li>No escrow, proprietary tokens or customer funds are held by LOAD|BY|TON.</li>
        </ul>
      </div></section>
    </PublicShell>,
  );
});

pub.get("/how-activation-works", (c) => {
  const p = pg(c, "How activation works");
  const steps = ["Payment pending", "Verified", "Information pending (if required)", "Queued", "Provisioning", "Validation", "Ready", "Onboarding"];
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="wrap prose">
        <h1>How activation works</h1>
        <p>Your free workspace is reused when you upgrade — nothing is recreated. After server-verified payment, entitlements and branded provisioning follow this sequence:</p>
        <ol class="stages">{steps.map((s) => <li>{s}</li>)}</ol>
        <p>Each provisioning step is idempotent: reserve slug → apply entitlement version → load configuration → attach routing → verify TLS → validate owner access → health and isolation checks → readiness notice → onboarding work. If anything is interrupted, it resumes safely without duplicates.</p>
        <div class="alert warn"><strong>Pilot target, not a guarantee.</strong> Our standard branded activation target is within 24 hours, starting after verified payment and the minimum setup information (your legal entity name). Custom domains, historical migration, field visits and external-provider approvals have separate milestones and conditions. A compensation policy for provider-caused delay will be published before this becomes a promise.</div>
        <h2>What we never do</h2>
        <ul><li>Grant access from a browser success redirect — only a verified server-side payment event does.</li><li>Rewrite your free data when you upgrade.</li><li>Use shared passwords: every invitation creates an individual account.</li></ul>
      </div></section>
    </PublicShell>,
  );
});

pub.get("/integrations", (c) => {
  const p = pg(c, "Integrations and live status");
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="wrap">
        <h1>Integrations and their live status</h1>
        <p class="prose">We say “live” only after a tested tenant flow exists. Connector acceptance covers retry, duplicates, expired authorization, provider outage, partial failure and reconciliation.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Connector</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>{INTEGRATIONS.map((i) => <tr><td>{i.name}</td><td><AvailBadge s={i.status} /></td><td>{i.note}</td></tr>)}</tbody></table></div>
        <p class="small mute" style="margin-top:12px">Requirements and provider availability must be rechecked at implementation and periodically thereafter.</p>
      </div></section>
    </PublicShell>,
  );
});

pub.get("/security", (c) => {
  const p = pg(c, "Security");
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="wrap prose">
        <h1>Security</h1>
        <div class="alert info">This page describes design controls. It is not a certification or legal compliance statement. UAE data protection and cross-border processing need deployment-specific review.</div>
        <h2>Tenant isolation</h2>
        <p>Every tenant record carries a tenant ID and is protected by database-enforced row-level security running under a restricted runtime role. The tenant is derived from your authenticated membership — never from a browser-supplied ID or hostname alone. Composite foreign keys stop a record referencing another tenant’s parent.</p>
        <h2>Access</h2>
        <p>Individual accounts, role-based permissions (owner, sales, pricing, coordinator, dispatcher, warehouse, finance, HR, auditor, portal), session revocation, and an append-only audit trail. Multi-factor authentication is required for platform administrators. Support staff see your data only through a time-limited grant that you approve, in read-only mode, with the operator’s identity recorded.</p>
        <h2>Files</h2>
        <p>Private, tenant-scoped storage paths; short-lived signed download links; uploads limited by type and size with content checks; downloads are served as attachments so uploaded content never renders as application content.</p>
        <h2>Payments and entitlements</h2>
        <p>Entitlements follow server-verified, signature-checked, replay-resistant payment events; duplicate or out-of-order events cannot create a second transition.</p>
        <h2>Your data</h2>
        <p>Export is available on every plan. Retention, deletion, breach procedure and subprocessor disclosures are listed in the <a href="/legal/data-processing">data processing</a> and <a href="/legal/subprocessors">subprocessor</a> pages.</p>
      </div></section>
    </PublicShell>,
  );
});

pub.get("/stories", (c) => c.html(
  <PublicShell p={pg(c, "Customer stories")}>
    <section class="block"><div class="wrap prose">
      <h1>Customer stories</h1>
      <p>We publish case studies only with the customer’s consent and verified results. None are published yet — the design-partner pilot is just starting. If you run a small UAE freight forwarding business and would like to shape the product, <a href="/contact">talk to us</a>.</p>
    </div></section>
  </PublicShell>));

pub.get("/resources", (c) => c.html(
  <PublicShell p={pg(c, "Resources")}>
    <section class="block"><div class="wrap prose">
      <h1>Resources</h1>
      <ul>
        <li><a href="/sectors">Sector workflow profiles</a></li>
        <li><a href="/pricing">Plan allowances and how limits work</a></li>
        <li><a href="/how-activation-works">How activation works</a></li>
        <li><a href="/help">Help centre</a></li>
      </ul>
      <p class="mute">Practical operating guides (quote-to-cash checklists, supplier-cost control, collections follow-up) will be added with real examples as the pilot progresses.</p>
    </div></section>
  </PublicShell>));

pub.get("/help", (c) => c.html(
  <PublicShell p={pg(c, "Help")}>
    <section class="block"><div class="wrap prose">
      <h1>Help</h1>
      <h2>Getting started</h2>
      <ol>
        <li><a href="/start">Create your free workspace</a>.</li>
        <li>Import or add customers and suppliers.</li>
        <li>Create a real enquiry, turn it into a quote, then a job.</li>
        <li>Record supplier costs, attach proof of delivery, invoice and track collection.</li>
        <li>Open the Owner dashboard — every card links to the records behind it.</li>
      </ol>
      <h2>Common questions</h2>
      <p><strong>What happens if I exceed a limit?</strong> New records of that type are blocked; existing records stay readable and exportable.</p>
      <p><strong>Can I leave?</strong> Yes. Settings → Export gives you JSON and CSV on every plan.</p>
      <p><strong>Is the invoice a UAE e-invoice?</strong> No. LOAD|BY|TON is not an accredited e-invoicing service provider. Operational invoices can be reconciled with your accounting system or provider.</p>
      <p><a href="/contact">Contact us</a> for anything else.</p>
    </div></section>
  </PublicShell>));

pub.get("/coverage", (c) => c.html(
  <PublicShell p={pg(c, "Service coverage")}>
    <section class="block"><div class="wrap prose">
      <h1>Service coverage</h1>
      <p><strong>Market:</strong> UAE-first. Initial design partners are small UAE freight forwarders that coordinate transport through suppliers and currently use email, WhatsApp and spreadsheets.</p>
      <p><strong>Software:</strong> English interface today; AED and multi-currency fields, tax identifiers, tax-code mappings and Arabic/RTL document layouts are on the roadmap.</p>
      <p><strong>Setup:</strong> basic setup is a bounded remote service — entity/branding, purchased templates, owner/staff invitation, initial customer import, one remote training session and an acceptance checklist. On-site visits, travel, printer/barcode setup and historical migration are scoped additions.</p>
      <p><strong>Not covered:</strong> global customs coverage, airport-certified systems, complex bonded warehouse automation, enterprise-wide migration.</p>
    </div></section>
  </PublicShell>));

const LEGAL: Record<string, { title: string; body: any }> = {
  terms: { title: "Terms of service", body: (<>
    <p>LOAD|BY|TON.store provides logistics software subscriptions, setup and support services. You use the software to run your own logistics business; those services are separate commercial relationships and accounting books between you and your customers.</p>
    <h2>Plans and billing</h2><p>Published plan versions are immutable commercial records. Prices exclude applicable tax and third-party pass-through charges. Paid-period cancellation retains agreed access; a published grace period precedes restriction; exceeding limits blocks new excess usage, not reading or export.</p>
    <h2>No funds held</h2><p>LOAD|BY|TON does not hold, escrow or transmit customer funds. You may record collections in your own finance workflow.</p>
    <h2>Regulated activities</h2><p>The software is not an accredited e-invoicing provider, customs authority or certification to handle dangerous goods, pharmaceutical cold chain or bonded inventory.</p></>) },
  privacy: { title: "Privacy notice", body: (<>
    <p>We process account and operational data to provide the service. For your customers’ data, you are the controller and we act as processor under the data processing terms; for our own commercial relationship with you we are a controller.</p>
    <h2>Your rights</h2><p>Data access, export and deletion workflows are provided in-product (export on every plan). Retention periods, breach procedures and cross-border processing are defined per deployment.</p></>) },
  "data-processing": { title: "Data processing", body: (<>
    <p>Roles: you are the controller of operational records in your workspace; LOAD|BY|TON is the processor. Records are stored in tenant-isolated storage; files are private with short-lived signed access.</p>
    <h2>Retention and exit</h2><p>Export access and retention duration are defined in your contract; we do not promise unlimited perpetual hosting. Deletion requires human approval.</p>
    <h2>Incidents</h2><p>A breach procedure with customer communication owner and incident commander is maintained by the operating team.</p></>) },
  subprocessors: { title: "Subprocessors", body: (<>
    <p>The following categories of subprocessor will be listed here by name, purpose, region and recovery position <strong>before the first paid customer is onboarded</strong>.</p>
    <ul><li>Managed PostgreSQL database hosting</li><li>Private object storage</li><li>Application hosting / compute</li><li>Transactional email and messaging</li><li>Payment processing</li><li>Monitoring and error tracking</li></ul>
    <p class="mute">Hosting and managed-service choices require a current cost, security, region and recovery assessment before procurement.</p></>) },
  accessibility: { title: "Accessibility", body: (<>
    <p>We design for keyboard use, visible focus, sufficient contrast, text and icons in addition to colour (red is never the only indicator of an error), and large touch targets for driver workflows. We have not yet completed a formal accessibility audit; report problems via <a href="/contact">Contact</a>.</p></>) },
};
pub.get("/legal/:doc", (c) => {
  const d = LEGAL[c.req.param("doc")];
  if (!d) throw new HttpError(404, "Page not found");
  return c.html(
    <PublicShell p={pg(c, d.title)}>
      <section class="block"><div class="wrap prose">
        <div class="draft-note"><strong>Draft — requires legal review before publication.</strong> This text is a starting point written for the pilot and has not been reviewed by counsel.</div>
        <h1>{d.title}</h1>{d.body}
      </div></section>
    </PublicShell>);
});

pub.get("/contact", (c) => {
  const p = pg(c, "Contact");
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="wrap" style="max-width:640px">
        <h1>Contact</h1>
        <p>Tell us about your logistics business. We will reply from a named person — no automated sequences.</p>
        <form method="post" action="/contact">
          <Csrf t={p.csrf} />
          <div class="field"><label for="n">Your name</label><input id="n" name="name" type="text" required autocomplete="name" /></div>
          <div class="field"><label for="co">Company</label><input id="co" name="company" type="text" autocomplete="organization" /></div>
          <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="email" /></div>
          <div class="field"><label for="m">How do you run quotes, jobs and invoices today?</label><textarea id="m" name="message" maxlength={2000}></textarea></div>
          <button class="btn red" type="submit">Send</button>
        </form>
      </div></section>
    </PublicShell>,
  );
});
pub.post("/contact", async (c) => {
  const b = await formBody(c);
  const email = str(b.email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !str(b.name).trim()) return c.redirect("/contact?err=" + encodeURIComponent("Enter your name and a valid email."));
  await c.get("db").query(`INSERT INTO platform_leads(name,company,email,message,source) VALUES ($1,$2,$3,$4,'contact')`,
    [str(b.name).slice(0, 200), str(b.company).slice(0, 200) || null, email, str(b.message).slice(0, 2000) || null]);
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
      <section class="block"><div class="wrap">
        <h1>Service status</h1>
        <div class="tbl-wrap"><table><thead><tr><th>Component</th><th>State</th><th>Detail</th></tr></thead><tbody>
          {row("Application & database", dbOk)}
          {row("Workspace provisioning", !!st && st.failed === 0 && st.aged === 0, st ? `${st.completed} completed · ${st.aged} aged · ${st.failed} failed` : "")}
          {row("Outbound notifications", dead === 0, dead ? `${dead} undeliverable` : "")}
        </tbody></table></div>
        <p class="small mute" style="margin-top:12px">Targets (to be validated before any contractual commitment): 99.9% monthly availability; p95 ordinary interactive reads under 1.5 s at published pilot load; shared-platform RPO ≤ 1 hour, RTO ≤ 8 hours. These are engineering objectives, not present guarantees.</p>
        <p class="small mute">Environment: {config.isProd ? "production" : "development"}.</p>
      </div></section>
    </PublicShell>,
  );
});

export { AvailBadge };
