import { Hono } from "hono";
import { Icon } from "./experience.js";
import { CONTACT, Lbt, waLink } from "./brand.js";
import { CtaBand, Faq, Feature, PHOTO, PageHero, Section, Ticks } from "./site-kit.js";
import { PublicShell, type Page } from "./ui.js";
import { PRODUCTS, SECTORS } from "../platform/catalog.js";
import { config } from "../config.js";
import type { Env } from "./mw.js";

export const marketing = new Hono<Env>();

const pg = (c: any, title: string, extra: Partial<Page> = {}): Page => ({
  title, csrf: c.get("csrf"), path: c.req.path, user: c.get("session") ? { name: c.get("session").name } : null,
  ok: c.req.query("ok"), err: c.req.query("err"), heroDark: true, ...extra,
});

marketing.get("/terms", (c) => c.redirect("/legal/terms", 301));
marketing.get("/privacy", (c) => c.redirect("/legal/privacy", 301));

/* ───────────────────────── Platform / features ───────────────────────── */
marketing.get("/features", (c) => c.html(
  <PublicShell p={pg(c, "Platform features", { description: "Quotes, jobs, trips, stock, parcels, documents, invoices and collections in one tenant-isolated workspace, with approvals, audit history and an offline driver app." })}>
    <PageHero kicker="PLATFORM" photo={PHOTO.intelligence} title={<>Everything the work needs.<br />Nothing it does not.</>} lede="A shared core for people, documents, approvals and money, with seven products on top. Switch on the ones you run.">
      <a class="btn red" href="/start">Start free <Icon name="arrow" size={16} /></a><a class="btn glass" href="/pricing">See pricing</a>
    </PageHero>
    <Section eyebrow="The shared core" title={<>Built once.<br />Used by every product.</>} intro="Customers, suppliers, documents, tasks and approvals are shared, so you are never charged twice for the same record.">
      <div class="grid g3">
        <Feature icon="people" title="Customers and suppliers">One list for every party. Import a spreadsheet, add contacts, keep rates and contracts against the right name.</Feature>
        <Feature icon="document" title="Documents with versions">Source-linked drafts, holds, proof of delivery and Arabic or English invoice layouts. Each version is kept.</Feature>
        <Feature icon="shield" title="Roles and approvals">Owner, sales, pricing, coordinator, dispatcher, warehouse, finance, auditor, portal. Sensitive steps need a second person.</Feature>
        <Feature icon="layers" title="Tasks and exceptions">Open exceptions have an owner and a due time. Delays and holds surface on the dashboard, not in someone's inbox.</Feature>
        <Feature icon="receipt" title="Audit trail">Every important change is written to an append-only history you can search, with who did it and when.</Feature>
        <Feature icon="download" title="Export, always">CSV and JSON on every plan, including after a downgrade. Your records are yours.</Feature>
      </div>
    </Section>
    <Section tone="tint" eyebrow="Seven products" title={<>One core.<br />Seven products.</>}>
      <div class="grid g3">{PRODUCTS.map((p) => <article class="card spot" data-reveal><span class="badge ok">Available</span><h3 style="margin-top:14px"><Lbt tag={p.name.replace("LOAD|BY|TON ", "").toUpperCase()} /></h3><p class="mute" style="margin:0">{p.blurb}</p></article>)}</div>
    </Section>
    <Section eyebrow="Under the hood" title={<>The parts that<br />keep you honest.</>} intro="These are built and tested in the platform. Provider setup (payments, messaging, e-invoicing) is a separate, stated step.">
      <div class="grid g2">
        <Feature icon="lock" title="Tenant isolation in the database">Row-level security under a restricted role, composite keys, tenant taken from your membership, never from a browser field.</Feature>
        <Feature icon="truck" title="Offline driver app">Large targets, a local queue and idempotent sync. Proof of delivery survives a dead zone and never double-posts.</Feature>
        <Feature icon="money" title="Money you can trace">Foreign-currency invoicing at an approved rate, VAT in base currency, a native general ledger projected from sub-ledgers.</Feature>
        <Feature icon="bolt" title="Merchant API and signed webhooks">Scoped API keys, signed webhooks and idempotent writes for e-commerce and courier customers.</Feature>
        <Feature icon="chart" title="Owner dashboard with sources">Expected, estimated and reconciled margin, unbilled work and overdue invoices. Every number links to its records.</Feature>
        <Feature icon="globe" title="Arabic and English">Arabic interface layer with right-to-left layout and bilingual documents.</Feature>
      </div>
    </Section>
    <CtaBand />
  </PublicShell>,
));

/* ───────────────────────── Industries ───────────────────────── */
const INDUSTRY: [string, string, string, string][] = [
  ["Freight forwarders", "ship", "Quotes in email, costs in sheets, invoices late.", "freight-forwarding"],
  ["Transport and fleets", "truck", "Trips planned by phone, detention lost, drivers chased.", "road-transport"],
  ["Warehouses and 3PL", "warehouse", "Customer stock that has to be exact, every day.", "contract-warehouse-3pl"],
  ["E-commerce fulfilment", "box", "Orders, pick, pack, ship and returns for merchants.", "ecommerce-fulfilment"],
  ["Couriers and last mile", "parcel", "Parcels, riders and cash on delivery that must tally.", "courier-last-mile"],
  ["Customs brokers", "document", "Cases, evidence and approvals before anything is lodged.", "customs-brokerage"],
  ["Trading companies", "scale", "Landed cost, stock and trade documents in one place.", "import-export-trading"],
  ["Cold chain", "thermo", "Temperature events, excursions and release approvals.", "cold-chain"],
  ["Project and heavy cargo", "anchor", "Budgets, permits, surveys and stage approvals.", "project-heavy-cargo"],
];
marketing.get("/industries", (c) => c.html(
  <PublicShell p={pg(c, "Industries", { description: "How UAE freight forwarders, transporters, warehouses, couriers, customs brokers and traders use LOAD|BY|TON.store." })}>
    <PageHero kicker="WHO IT IS FOR" photo={PHOTO.port} title={<>If you move cargo<br />and send invoices.</>} lede="Eighteen sector packs share one company account. Start with the one that pays your bills.">
      <a class="btn red" href="/find-my-bundle">Find my bundle <Icon name="arrow" size={16} /></a>
    </PageHero>
    <Section eyebrow="Industries" title={<>Nine places it<br />earns its keep.</>}>
      <div class="grid g3">{INDUSTRY.map(([n, ic, pain, slug]) => <a class="sector-card spot" href={`/sectors/${slug}`} data-reveal><span class="ic-tile"><Icon name={ic} size={22} /></span><h3>{n}</h3><p>{pain}</p><span class="go">See the workflow <Icon name="arrow" size={14} /></span></a>)}</div>
      <p style="margin-top:24px"><a href="/sectors">All {SECTORS.length} sector packs <Icon name="arrow" size={16} /></a></p>
    </Section>
    <CtaBand title={<>Tell us what you<br />move.</>} body="We will point you to the right sector pack and the plan that fits it." />
  </PublicShell>,
));

/* ───────────────────────── For forwarders / transporters ───────────────────────── */
marketing.get("/for-forwarders", (c) => c.html(
  <PublicShell p={pg(c, "For freight forwarders", { description: "From enquiry to collection: quotes, supplier rates, jobs, documents, invoices and what each shipment actually earned." })}>
    <PageHero kicker="FOR FREIGHT FORWARDERS" photo={PHOTO.freight} title={<>Quote with context.<br />Close with clarity.</>} lede="The forwarding workflow runs end to end: enquiry, quote, job, supplier costs, documents, invoice and collection.">
      <a class="btn red" href="/start?sector=freight-forwarding">Start free with forwarding <Icon name="arrow" size={16} /></a>
    </PageHero>
    <Section eyebrow="The workflow" title={<>Six steps.<br />One job record.</>}>
      <div class="grid g3">
        <Feature icon="mail" title="Enquiry">Capture who asked, what they ship and where. Assign an owner and a follow-up.</Feature>
        <Feature icon="scale" title="Quote">Supplier rates, chargeable weight rules, margin check and approval before it is sent.</Feature>
        <Feature icon="ship" title="Job">One accepted quote becomes one job. Route legs, bookings and milestones live on it.</Feature>
        <Feature icon="receipt" title="Costs">Expected cost on day one, reconciled to the supplier invoice when it arrives.</Feature>
        <Feature icon="document" title="Documents">Versioned drafts, holds and proof of delivery attached to the shipment.</Feature>
        <Feature icon="money" title="Invoice and collect">Bill approved charges, see unbilled deliveries and who is overdue.</Feature>
      </div>
    </Section>
    <Section tone="tint" eyebrow="Also in the box" title={<>For the harder<br />parts of forwarding.</>}>
      <div class="grid g2">
        <Feature icon="layers" title="Master and house shipments">Consolidation, container planning and destination-agent settlement.</Feature>
        <Feature icon="shield" title="Customs handover pack">Evidence checklist and a controlled handover to your licensed broker channel.</Feature>
        <Feature icon="chart" title="Tenders and contracts">Track opportunities, tender decisions and supplier contracts next to the jobs they feed.</Feature>
        <Feature icon="sparkle" title="Assistant drafts">Scoped drafts for enquiry replies and document text. A person reviews everything before it leaves.</Feature>
      </div>
    </Section>
    <CtaBand />
  </PublicShell>,
));

marketing.get("/for-transporters", (c) => c.html(
  <PublicShell p={pg(c, "For transport and fleet operators", { description: "Plan trips with capacity and compliance checks, dispatch to an offline-tolerant driver app, and see trip profit." })}>
    <PageHero kicker="FOR TRANSPORT & FLEETS" photo={PHOTO.transport} title={<>Plan the trip.<br />Dispatch the driver.</>} lede="Orders, trips, vehicles, drivers and subcontractors in one board. Drivers get a phone app built for gates, yards and weak signal.">
      <a class="btn red" href="/start?sector=road-transport">Start free with transport <Icon name="arrow" size={16} /></a>
    </PageHero>
    <Section eyebrow="Operations" title={<>From order<br />to trip profit.</>}>
      <div class="grid g3">
        <Feature icon="route" title="Planning board">Capacity, availability and compliance are checked before a trip is planned, not after it goes wrong.</Feature>
        <Feature icon="truck" title="Driver app">One job at a time, large buttons, offline queue and proof of delivery with a signature.</Feature>
        <Feature icon="clock" title="Detention and expenses">Waiting time and driver expenses are recorded with receipts and independently approved.</Feature>
        <Feature icon="users" title="Subcontractors">Assign work to partner fleets and keep their cost against the trip.</Feature>
        <Feature icon="pin" title="Live trips">Follow trips on the board when a tracking feed is connected.</Feature>
        <Feature icon="chart" title="Trip profit">Revenue less fuel, expenses and subcontract cost, per trip, with the records behind it.</Feature>
      </div>
    </Section>
    <Section tone="tint" eyebrow="On the road" title={<>Built for dead zones<br />and busy gates.</>}>
      <div class="grid g2">
        <div class="prose-card" data-reveal><h3>What the driver sees</h3><Ticks items={["Today's trips, in order", "Address, contact and notes at the top", "Confirm pickup, delivery, failed attempt", "A banner when actions are waiting to sync"]} /></div>
        <div class="prose-card" data-reveal><h3>What the office sees</h3><Ticks items={["Each event stamped with the phone's clock time", "No duplicates when a sync is retried", "Exceptions with owners and due times", "Cost and profit as soon as the trip closes"]} /></div>
      </div>
    </Section>
    <CtaBand />
  </PublicShell>,
));

/* ───────────────────────── Trust ───────────────────────── */
marketing.get("/trust", (c) => c.html(
  <PublicShell p={pg(c, "Trust and safety", { description: "How LOAD|BY|TON.store protects company records, money flows and evidence — and what we do not claim." })}>
    <PageHero kicker="TRUST & SAFETY" photo={PHOTO.enterprise} title={<>Control you can<br />point to.</>} lede="Logistics software holds your customers, rates and cash. These are the controls that protect it, in plain words.">
      <a class="btn red" href="/security">Read the security detail <Icon name="arrow" size={16} /></a>
    </PageHero>
    <Section eyebrow="Protection" title={<>Six things we<br />hold ourselves to.</>}>
      <div class="grid g3">
        <Feature icon="lock" title="Your records stay yours">Each company is isolated by the database itself. A mistake in the app cannot read another tenant's rows.</Feature>
        <Feature icon="users" title="Individual accounts">No shared logins. Roles decide what each person sees, and portal users only ever see their own shipments.</Feature>
        <Feature icon="shield" title="Two-person approval">Cash recovery, stock adjustments, expense receipts and customs handover need a second person.</Feature>
        <Feature icon="receipt" title="Evidence on the record">Documents, approvals and milestones stay attached to the job, with versions and who changed what.</Feature>
        <Feature icon="money" title="No funds held">We sell software. We never hold, escrow or move your customers' money.</Feature>
        <Feature icon="download" title="A clean exit">Export your data in CSV and JSON on every plan. Erasure requests are reviewed against legal holds.</Feature>
      </div>
    </Section>
    <Section tone="tint" eyebrow="What we do not claim" title={<>Plain limits.</>} intro="Trust is also knowing where the edges are.">
      <div class="callout" data-reveal><b>Not a certification.</b> The controls described here are design controls, not an audit report or legal compliance statement. Your deployment needs its own review.</div>
      <div class="callout" data-reveal><b>Not an authority.</b> We are not an accredited UAE e-invoicing provider, not a customs authority, and not a licence to handle dangerous goods, pharmaceutical cold chain or bonded stock.</div>
      <div class="callout" data-reveal><b>Evidence over adjectives.</b> Every sector pack's review and live-case evidence is tracked in a readiness register, shared on request.</div>
    </Section>
    <Section eyebrow="Questions" title={<>If something<br />goes wrong.</>}>
      <Faq items={[
        ["Who can see my workspace?", "Your team, by role. Support staff see it only through a read-only, time-limited grant that you approve, and every access is audited."],
        ["How do I report a problem?", <>Write to <a href={`mailto:${CONTACT.emails.support}`}>{CONTACT.emails.support}</a> or message <a href={waLink()} target="_blank" rel="noopener">WhatsApp {CONTACT.phoneDisplay}</a>. Security reports are read by a person the same day.</>],
        ["What about backups?", "Encrypted database and file backups with restore verification are built in. The deployment must still prove its own recovery before any commitment is made."],
      ]} />
    </Section>
    <CtaBand />
  </PublicShell>,
));

/* ───────────────────────── Compliance ───────────────────────── */
marketing.get("/compliance", (c) => c.html(
  <PublicShell p={pg(c, "Compliance", { description: "How data protection, VAT invoicing, hosting and retention are handled, and where specialist review is required." })}>
    <PageHero kicker="COMPLIANCE" photo={PHOTO.customs} title={<>What is covered.<br />What is not.</>} lede="Practical notes on data, tax and hosting. They describe the software and its settings; they are not legal advice.">
      <a class="btn red" href="/legal/data-processing">Data processing terms <Icon name="arrow" size={16} /></a>
    </PageHero>
    <Section eyebrow="The notes" title={<>Five topics,<br />stated plainly.</>}>
      <div class="grid g2">
        <Feature icon="lock" title="Personal data">You are the controller of the operational records in your workspace; we act as processor. Access, correction and deletion requests are handled in Your data, with review for statutory retention and legal holds.</Feature>
        <Feature icon="receipt" title="VAT and invoices">Invoices carry your tax registration number. The default UAE VAT rate is configurable (currently {(config.vatBps / 100).toFixed(0)}%). Foreign-currency invoices show VAT in the base currency.</Feature>
        <Feature icon="document" title="E-invoicing">We are not an accredited e-invoicing service provider. An adapter for a verified provider is on the roadmap; today invoices reconcile with the system you already use.</Feature>
        <Feature icon="globe" title="Hosting and region">Deployment region: {config.deploymentRegion}. Subprocessors and their roles are listed on the <a href="/legal/subprocessors">subprocessors page</a>.</Feature>
        <Feature icon="clock" title="Retention">Records are kept {config.retentionDays} days after the applicable exit milestone, subject to contract, statutory records and legal holds.</Feature>
        <Feature icon="shield" title="Regulated cargo and customs">The customs module manages cases and hands over to a licensed broker channel. Dangerous, cold-chain and bonded workflows need subject-matter review.</Feature>
      </div>
      {config.legalReviewed ? null : <div class="draft-note" style="margin-top:24px"><strong>Draft copy.</strong> The legal pages are pending review by the contracting entity's adviser.</div>}
    </Section>
    <CtaBand title={<>Need a document<br />for your auditor?</>} body="Ask for the data processing terms, subprocessor list or readiness register. We will send them." />
  </PublicShell>,
));

/* ───────────────────────── About ───────────────────────── */
marketing.get("/about", (c) => c.html(
  <PublicShell p={pg(c, "About", { description: "LOAD|BY|TON.store is a subsidiary of LOAD|BY|TON, built by two AI-native product builders in India for logistics companies in the UAE." })}>
    <PageHero kicker="ABOUT" photo={PHOTO.fleet} title={<>Small team.<br />Serious software.</>} lede={<><Lbt />.store builds the operating system that logistics companies run on, from India, for the UAE.</>}>
      <a class="btn red" href="/contact">Talk to us <Icon name="arrow" size={16} /></a><a class="btn glass" href="/features">What we build</a>
    </PageHero>

    <Section eyebrow="Our story" title={<>Built to be useful<br />on a Tuesday.</>} intro="Most logistics software is made for the buyer's committee. We make it for the coordinator who has forty open jobs and a customer on the phone.">
      <div class="grid g2">
        <div class="prose-card" data-reveal>
          <h3>Why we exist</h3>
          <p>Logistics in the UAE moves on skill and relationships, then gets recorded in email threads and spreadsheets. The margin disappears in the gaps. The tools that could help often arrive with long contracts, big setup fees and features nobody asked for.</p>
          <p>We build the opposite: software that is clear about what it does, priced where a small company can say yes, and supported by the people who wrote it.</p>
        </div>
        <div class="prose-card" data-reveal>
          <h3>What we believe</h3>
          <Ticks items={["One record per movement. Not five silos.", "Say what works today and what does not.", "Never charge for getting your own data out.", "A person is accountable for every change that ships."]} />
        </div>
      </div>
    </Section>

    <Section tone="dark" eyebrow="Corporate profile" title={<>Part of<br />the <Lbt /> group.</>} intro="LOAD|BY|TON.store operates as a subsidiary of LOAD|BY|TON.">
      <div class="grid g2">
        <div class="prose-card" style="background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12);color:#C7D6E0" data-reveal>
          <h3 style="color:#fff">The parent: <Lbt /></h3>
          <p><Lbt /> is a UAE road freight and container drayage platform. Shippers post a requirement, verified carriers respond with a price and an ETA, the shipper awards one, and the job is tracked through pickup, transit and delivery to proof of delivery. Payment protection, ratings, dispute handling and an audited admin console sit around that flow, with contract lanes, EDI-style consignment ingestion and GCC corridor views for larger shippers.</p>
          <p>It is the product that taught us how freight actually moves between ports, yards, gates and customers in the UAE.</p>
        </div>
        <div class="prose-card" style="background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12);color:#C7D6E0" data-reveal>
          <h3 style="color:#fff">The subsidiary: <Lbt />.store</h3>
          <p><Lbt />.store takes that operating knowledge and packages it for logistics companies themselves: freight forwarders, transporters, warehouses, couriers and customs brokers. It is a multi-tenant operating platform with eighteen sector packs, an offline driver app, customer portals and an owner dashboard, sold as a subscription.</p>
          <p>The two share a brand, a design language and an engineering approach. They are separate products with separate customers and separate books.</p>
        </div>
      </div>
      <div class="tbl-wrap" style="margin-top:24px;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.12)" data-reveal>
        <table style="color:#C7D6E0"><tbody>
          <tr><th scope="row" style="background:transparent;color:#8FB0C6">Parent company</th><td><Lbt /> — UAE road freight and drayage platform</td></tr>
          <tr><th scope="row" style="background:transparent;color:#8FB0C6">This business</th><td><Lbt />.store — logistics operating software (subsidiary)</td></tr>
          <tr><th scope="row" style="background:transparent;color:#8FB0C6">Built and run by</th><td>Two independent product builders based in India</td></tr>
          <tr><th scope="row" style="background:transparent;color:#8FB0C6">Business registration</th><td>Udyam-registered MSME · GST registered (details on invoices and on request)</td></tr>
          <tr><th scope="row" style="background:transparent;color:#8FB0C6">Market</th><td>United Arab Emirates, with GCC corridors on the roadmap</td></tr>
          <tr><th scope="row" style="background:transparent;color:#8FB0C6">Contact</th><td><a href={`mailto:${CONTACT.emails.contact}`} style="color:#fff">{CONTACT.emails.contact}</a> · <a href={CONTACT.tel} style="color:#fff">{CONTACT.phoneDisplay}</a></td></tr>
        </tbody></table>
      </div>
    </Section>

    <Section eyebrow="The people" title={<>Two builders.<br />Every layer.</>} intro="We are two freelancers from India who work as AI-native product builders: we design, build, test and operate the whole product between us.">
      <div class="grid g3">
        <Feature icon="layers" title="Full-stack, end to end">TypeScript on the server and the page, PostgreSQL with row-level security, server-rendered interfaces that load fast on any phone.</Feature>
        <Feature icon="sparkle" title="AI-native, human-checked">We build with AI coding and design tools every day, then review, test and own every line. Hundreds of automated tests guard the money and stock logic.</Feature>
        <Feature icon="gauge" title="Design that earns trust">A single design system across the site, the workspace, the console and the driver app, with 3D and motion used where it explains something.</Feature>
        <Feature icon="lock" title="Security by default">Tenant isolation in the database, two-person approvals, encrypted secrets, signed webhooks, audited staff access.</Feature>
        <Feature icon="globe" title="Built for the region">AED pricing, VAT handling, Arabic and right-to-left layouts, UAE document conventions and port and gate realities.</Feature>
        <Feature icon="headset" title="You talk to the builders">Support is the people who wrote the code. Message us on WhatsApp, email, or use the live chat on this site.</Feature>
      </div>
    </Section>

    <Section tone="tint" eyebrow="How we work" title={<>Lean on purpose.</>}>
      <ol class="timeline" data-reveal>
        <li><span></span><div><h3>We ship in small, tested steps</h3><p>Every change runs through the same suite that protects stock, cash and tenant isolation.</p></div></li>
        <li><span></span><div><h3>We publish what is not built</h3><p>Planned items are labelled planned. Pilot is pilot. Nothing is sold before it exists.</p></div></li>
        <li><span></span><div><h3>We keep the cost honest</h3><p>No field sales, no inflated implementation fee. Cloud costs are watched line by line, which is why prices can stay low.</p></div></li>
        <li><span></span><div><h3>We stay reachable</h3><p>One phone number, three mailboxes, a live chat. A person answers.</p></div></li>
      </ol>
    </Section>
    <CtaBand />
  </PublicShell>,
));

/* ───────────────────────── Notes (blog) ───────────────────────── */
const POSTS = [
  { slug: "margin-has-three-numbers", title: "A job's margin has three numbers, not one", date: "7 Oct 2026", tag: "Finance", photo: PHOTO.finance,
    body: ["When a quote goes out you have an expected margin. When costs start to arrive you have an estimated one. When the last supplier invoice is matched you have a reconciled one. They are three different numbers and most tools show you only one of them, usually the happiest.", "We keep all three on the job and say which is which. The owner dashboard links each figure to the records behind it, so when the margin is 14% you can see exactly what it is made of."] },
  { slug: "why-the-free-plan-starts-empty", title: "Why a new workspace starts empty", date: "29 Sep 2026", tag: "Product", photo: PHOTO.onboarding,
    body: ["Many products fill a new account with sample jobs so it looks alive. Then you spend an afternoon deleting them, and one day a demo invoice shows up in a real report.", "A LOAD|BY|TON workspace starts empty. A short checklist tells you what to add first: a customer, a supplier, a real enquiry. The only sample data lives in a separate demo database you never touch."] },
  { slug: "a-driver-app-for-dead-zones", title: "A driver app that survives a dead zone", date: "18 Sep 2026", tag: "Engineering", photo: PHOTO.transport,
    body: ["Port gates, yards and basement docks lose signal. A driver who taps Delivered and gets a spinner taps again, and now the system has two deliveries.", "Every action in the app carries a client-generated id and the phone's clock time. If the network fails, the action waits in a local queue. When the signal returns the queue is sent, and the server keeps one copy of each id. Retrying is always safe."] },
  { slug: "what-we-will-not-build-yet", title: "What we will not build yet", date: "9 Sep 2026", tag: "Honesty", photo: PHOTO.intelligence,
    body: ["We do not file customs declarations. We manage the case, the evidence and the approvals, and hand over to your licensed broker channel.", "We are not an accredited e-invoicing provider. Invoices reconcile with the provider you already use. Saying so on the pricing page costs us a few sales. Pretending would cost more."] },
];
marketing.get("/blog", (c) => c.html(
  <PublicShell p={pg(c, "Notes from the build", { description: "Short notes on margin, driver apps, honest roadmaps and building logistics software with a small team." })}>
    <PageHero kicker="NOTES" photo={PHOTO.road} title={<>Notes from<br />the build.</>} lede="Short, practical, no content marketing. How the product thinks about freight, money and honesty." />
    <Section>
      <div class="grid" style="gap:28px;max-width:980px">
        {POSTS.map((p) => (
          <article class="card spot" style="display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:24px;padding:26px" data-reveal id={p.slug}>
            <div><p class="mono mute" style="margin-bottom:10px">{p.tag.toUpperCase()} · {p.date}</p><h2 style="font-size:1.6rem">{p.title}</h2>{p.body.map((t) => <p class="mute">{t.includes("LOAD|BY|TON") ? <>{t.split("LOAD|BY|TON")[0]}<Lbt />{t.split("LOAD|BY|TON")[1]}</> : t}</p>)}</div>
            <img src={p.photo} alt="" loading="lazy" style="width:100%;height:100%;min-height:180px;object-fit:cover;border-radius:18px" />
          </article>
        ))}
      </div>
    </Section>
    <CtaBand title={<>Read enough.<br />Move freight.</>} />
  </PublicShell>,
));
