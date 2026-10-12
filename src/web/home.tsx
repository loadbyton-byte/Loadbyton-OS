import { Icon } from "./experience.js";
import { CONTACT, Lbt, waLink } from "./brand.js";
import { CtaBand, Faq, PHOTO, Section } from "./site-kit.js";
import { fmtMoney } from "../lib/util.js";
import { SECTORS, PRODUCTS, type PlanVersion } from "../platform/catalog.js";

const MARQUEE = ["Enquire", "Quote", "Move", "Document", "Invoice", "Collect"];

const DEMOS = [
  { id: "fwd", tab: "Forwarding", title: "Quote it. Move it. Know what it earned.", icon: "ship",
    points: ["Enquiry to quote with supplier rates, chargeable weight and approval.", "Costs, documents and milestones sit on the job.", "Margin shown three ways: expected, estimated and reconciled."],
    kpis: [["Open jobs", "24"], ["Unbilled", "AED 41k"], ["Margin", "14.2%"]],
    rows: [["LBT-J-0142", "Jebel Ali → Nhava Sheva", "In transit"], ["LBT-J-0141", "Dubai → Jeddah", "Docs ready"], ["LBT-J-0139", "Sharjah → Mombasa", "Invoiced"]] },
  { id: "trn", tab: "Transport", title: "Plan the trip. Dispatch the driver. Reconcile.", icon: "truck",
    points: ["Capacity, availability and compliance are checked before a trip is planned.", "Drivers work from a phone app, even with a weak signal.", "Detention, expenses and subcontracting roll into trip profit."],
    kpis: [["Trips today", "9"], ["On the road", "6"], ["Detention", "AED 1.2k"]],
    rows: [["TRP-0388", "Khalifa Port → Al Quoz", "Delivered"], ["TRP-0389", "Jebel Ali → RAK", "In transit"], ["TRP-0390", "Al Ain → Dubai", "Planned"]] },
  { id: "whs", tab: "Warehouse", title: "Customer stock, always accounted for.", icon: "warehouse",
    points: ["Owner-separated stock on an immutable movement ledger.", "FIFO allocation, blind counts and independent approval.", "Storage and handling activity turns into the invoice."],
    kpis: [["SKUs", "1,284"], ["Receiving", "3"], ["Count diff", "0.4%"]],
    rows: [["IN-2210", "Receipt · Merchant A", "Received"], ["OUT-4471", "Dispatch · 38 lines", "Picking"], ["CNT-0091", "Blind count · Aisle C", "Approved"]] },
  { id: "dlv", tab: "Delivery", title: "Parcels, riders and cash on delivery.", icon: "parcel",
    points: ["Runs, rider app, proof of delivery and failed attempts.", "Exact-cash collection and a rider handover with variance approval.", "Merchant remittance with fees netted, then billed."],
    kpis: [["Parcels out", "212"], ["Delivered", "187"], ["COD held", "AED 9.4k"]],
    rows: [["RUN-0720", "Rider 4 · 38 parcels", "Out"], ["RUN-0719", "Rider 2 · 41 parcels", "Closed"], ["REM-0061", "Merchant payout", "Pending"]] },
];

const SEQUENCE: [string, string][] = [
  ["Enquire", "Capture the requirement once. Customer, lane, cargo and who owns it."],
  ["Quote", "Price from supplier rates, check the margin, get it approved, send it."],
  ["Move", "Turn the accepted quote into one job. Plan legs, dispatch, follow milestones."],
  ["Document", "Keep every document, hold and proof of delivery on the same record."],
  ["Invoice and collect", "Bill from approved charges. See what is unbilled and what is overdue."],
];

export function HomeExperience({ plans }: { plans: PlanVersion[] }) {
  const paid = plans.filter((x) => x.monthly_minor > 0 && !x.contact_sales).sort((a, b) => a.monthly_minor - b.monthly_minor);
  const from = paid[0]?.monthly_minor;
  return <>
    <section class="hero3d" aria-labelledby="hero-heading">
      <div class="wrap grid-hero">
        <div class="hero-copy">
          <span class="eyebrow"><span class="signal-dot"></span>Logistics software · built in India · priced for the UAE</span>
          <h1 id="hero-heading">Run the movement.<br /><em>Know the margin.</em></h1>
          <p class="lead">One workspace for enquiries, quotes, jobs, trips, stock, parcels, documents and collections.{from ? <> Start free. Paid plans from <strong style="color:#fff">{fmtMoney(from).replace(/\.00$/, "")}</strong> a month.</> : " Start free."}</p>
          <div class="hero-actions">
            <a class="btn red" href="/start">Start free <Icon name="arrow" size={16} /></a>
            <a class="btn glass" href={waLink()} target="_blank" rel="noopener"><Icon name="whatsapp" size={18} />Talk on WhatsApp</a>
          </div>
          <ul class="hero-chips" aria-label="Business facts">
            <li><b>Udyam</b> registered MSME</li><li><b>GST</b> registered, India</li><li><b>AED</b> pricing</li><li><b>العربية</b> + English</li>
          </ul>
          <p class="world-clock mono" data-world-clock aria-live="off"></p>
        </div>
        <div class="stage3d" id="stage3d" aria-label="Globe with shipping routes from Dubai. Decorative.">
          <div class="poster" aria-hidden="true"></div>
          <div class="float-card fc1" aria-hidden="true"><div class="row-s"><i class="dot"></i><b>LBT-J-0142</b></div><span class="mono">Jebel Ali → Nhava Sheva</span></div>
          <div class="float-card fc2" aria-hidden="true"><span class="mono">MARGIN · RECONCILED</span><b>14.2%</b></div>
          <div class="float-card fc3" aria-hidden="true"><span class="mono">POD · SIGNED</span><b>Delivered, Al Quoz</b></div>
        </div>
      </div>
      <div class="hero-foot"><div class="wrap">
        <div><b data-count={String(SECTORS.length)}>{SECTORS.length}</b><span>Sector packs</span></div>
        <div><b data-count={String(PRODUCTS.length)}>{PRODUCTS.length}</b><span>Products, one core</span></div>
        <div><b data-count="3">3</b><span>Surfaces: web, driver, portal</span></div>
        <div><b data-pre="AED " data-count="0">AED 0</b><span>To start. Free plan stays free</span></div>
      </div></div>
    </section>

    <div class="marquee-wrap" aria-hidden="true"><div class="marquee"><div class="marquee-track">
      {[0, 1].map(() => <span>{MARQUEE.map((m) => <><i></i>{m}</>)}<i></i><Lbt /></span>)}
    </div></div></div>

    <Section eyebrow="Less patching. More control." title={<>Every team.<br />The same picture.</>} intro="Most small logistics companies run on four tools and a lot of memory. The work gets done; the margin goes missing in the gaps.">
      <div class="versus" data-reveal>
        <div class="before"><span class="eyebrow">TODAY</span><h3>Pieces everywhere</h3><ul>
          <li>Quotes live in email, rates in a spreadsheet.</li><li>Status is whatever someone last said on WhatsApp.</li><li>Costs arrive weeks after the job is done.</li><li>Invoices go out late because nobody is sure what was delivered.</li></ul></div>
        <div class="after"><span class="eyebrow">WITH <Lbt /></span><h3>One record per movement</h3><ul>
          <li>The quote, the job, the costs and the documents are one thread.</li><li>Dispatch and drivers work from the same job, on a phone.</li><li>Expected, estimated and reconciled margin stay separate and traceable.</li><li>Unbilled and overdue are a click away, with the records behind them.</li></ul></div>
      </div>
    </Section>

    <Section tone="tint" eyebrow="See the work" title={<>Built around how<br />each team works.</>} intro="Pick a workflow. The screens below are illustrative samples, not customer data.">
      <div data-tabs>
        <div class="demo-tabs" role="tablist" aria-label="Workflows">{DEMOS.map((d, i) => <button role="tab" type="button" id={`tab-${d.id}`} aria-controls={`panel-${d.id}`} aria-selected={i === 0 ? "true" : "false"}>{d.tab}</button>)}</div>
        {DEMOS.map((d, i) => (
          <div role="tabpanel" id={`panel-${d.id}`} aria-labelledby={`tab-${d.id}`} hidden={i !== 0 ? true : undefined}>
            <div class="demo-grid">
              <div class="demo-copy">
                <span class="eyebrow">{d.tab.toUpperCase()}</span>
                <h3>{d.title}</h3>
                <ul>{d.points.map((x) => <li><Icon name="check" size={18} />{x}</li>)}</ul>
                <a class="btn" href={`/sectors`}>Explore the sector packs <Icon name="arrow" size={16} /></a>
              </div>
              <div class="perspective">
                <div class="device" data-tilt="5">
                  <div class="chrome"><i></i><i></i><i></i><span>app.loadbyton.store / {d.tab.toLowerCase()}</span></div>
                  <div class="screen">
                    <div class="mini-kpis">{d.kpis.map(([l, v]) => <div><small>{l}</small><b>{v}</b></div>)}</div>
                    <div class="mini-list">{d.rows.map(([a, b, c]) => <div><span class="mono">{a}</span><span>{b}</span><span class="badge info">{c}</span></div>)}</div>
                    <div class="bars" aria-hidden="true">{[38, 62, 48, 80, 56, 90, 70, 100, 64, 84].map((h) => <i style={`height:${h}%`}></i>)}</div>
                  </div>
                </div>
                <p class="demo-note">ILLUSTRATIVE SAMPLE DATA</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>

    <Section eyebrow="From first conversation to final collection" title={<>One movement.<br />Five stages.</>} intro="Every stage shares the same job record, so nothing has to be put back together at month end.">
      <div class="sequence">
        <div class="stick" data-reveal>
          <div class="card" style="background:linear-gradient(150deg,var(--navy),var(--deep));color:#CFE0EB;border:0;padding:clamp(24px,3vw,40px)">
            <span class="eyebrow" style="color:#FF9B96">THE RECORD</span>
            <h3 style="color:#fff;font-size:1.8rem;line-height:1.05">The job carries<br />its own history.</h3>
            <p style="color:#9FB6C6">Who quoted it, what it was supposed to earn, what the supplier charged, which document is on hold, when it was delivered and what is still unpaid.</p>
            <div class="margin-lanes"><span>EXPECTED <i style="--w:82%"></i><b>82%</b></span><span>ESTIMATED <i style="--w:64%"></i><b>64%</b></span><span>RECONCILED <i style="--w:46%"></i><b>46%</b></span></div>
            <small style="color:#8FB0C6;font:600 .66rem var(--f-mono);letter-spacing:.06em;display:block;margin-top:12px">THREE VIEWS OF MARGIN. NO INVENTED TOTALS.</small>
          </div>
        </div>
        <ol class="steps" style="list-style:none;margin:0;padding:0">{SEQUENCE.map(([t, b], i) => <li class="step" data-reveal><span class="n">0{i + 1}</span><div><h3>{t}</h3><p>{b}</p></div></li>)}</ol>
      </div>
    </Section>

    <Section tone="alt" eyebrow="Platform" title={<>One workspace.<br />Room to grow.</>} intro="Register once. Add depth when you need it. Your customers, jobs and documents stay with the same company account.">
      <div class="bento">
        <article class="b-a spot" data-reveal><span class="ic"><Icon name="gauge" size={24} /></span><h3>Know what the job actually earned.</h3><p>Quotation estimates, expected costs and reconciled outcomes are kept apart, and every figure links back to its source records.</p><div class="margin-lanes"><span>EXPECTED <i style="--w:78%"></i><b>AED 18.4k</b></span><span>ESTIMATED <i style="--w:61%"></i><b>AED 14.9k</b></span><span>RECONCILED <i style="--w:52%"></i><b>AED 12.3k</b></span></div></article>
        <article class="b-b spot" data-reveal><span class="ic"><Icon name="people" size={24} /></span><h3>Everyone has their place.</h3><p>Individual accounts, team roles, customer portals and a focused driver app.</p><a href="/trust">How access works <Icon name="arrow" size={14} /></a></article>
        <article class="b-c spot" data-reveal><span class="ic"><Icon name="shield" size={24} /></span><h3>Control is built in.</h3><p>Tenant isolation, approval gates, immutable history and evidence attached to the work.</p><a href="/security">Security <Icon name="arrow" size={14} /></a></article>
        <article class="b-d spot" data-reveal><span class="ic"><Icon name="document" size={24} /></span><h3>Documents that follow the job.</h3><p>Versioned drafts, holds and proof of delivery, with Arabic and English invoice layouts.</p><a href="/features">All features <Icon name="arrow" size={14} /></a></article>
        <article class="b-e spot" data-reveal><span class="ic"><Icon name="truck" size={24} /></span><h3>A driver app that works offline.</h3><p>Large buttons, a queue that syncs when the signal returns, no duplicate events.</p><a href="/for-transporters">For fleets <Icon name="arrow" size={14} /></a></article>
        <article class="b-f" data-reveal><div><h3>Your next capability is an upgrade,<br />not a new implementation.</h3><p>Start with one sector. Add more without moving your data.</p></div><a class="btn glass" href="/find-my-bundle">Find my bundle <Icon name="arrow" size={16} /></a></article>
      </div>
    </Section>

    <Section eyebrow="Pick your lane" title={<>Built for the<br />work you do.</>} intro="Start with the sector that pays your bills. Combine more later in the same account.">
      <div class="photo-cards">
        {[
          ["freight-forwarding", "Freight forwarding", "Enquiry to collection, with every cost and document in context.", PHOTO.crane, "SELL · OPERATE · COLLECT"],
          ["road-transport", "Road transport", "Plan the trip. Dispatch the driver. Reconcile the outcome.", PHOTO.gate, "PLAN · DISPATCH · DELIVER"],
          ["contract-warehouse-3pl", "Warehouse & fulfilment", "Customer-owned stock, controlled movements, activity billing.", PHOTO.crossdock, "RECEIVE · PICK · SHIP"],
        ].map(([slug, name, body, img, tag]) => <a class="photo-card" href={`/sectors/${slug}`} data-reveal data-tilt="3"><img src={img} alt="" loading="lazy" /><div><span class="eyebrow">{tag}</span><h3>{name}</h3><p>{body}</p></div></a>)}
      </div>
      <p style="margin-top:22px"><a href="/sectors">Explore all {SECTORS.length} sector packs <Icon name="arrow" size={16} /></a></p>
    </Section>

    <Section tone="tint" eyebrow="Why it costs less" title={<>Fair prices.<br />No padding.</>} intro="Software from the UAE market often arrives with a sales team, an implementation fee and a long contract. We built this differently.">
      <div class="afford">
        <div data-reveal><span class="big">2</span><h3>People, not a floor of sellers</h3><p class="mute" style="margin:0">Two engineers build and run <span class="nw"><Lbt />.store</span>. Your money goes into the product and the service, not a pipeline.</p></div>
        <div data-reveal><span class="big">AI</span><h3>Built with AI, reviewed by people</h3><p class="mute" style="margin:0">AI-native tooling lets a small team ship in weeks what used to need a department. Every change still has a person accountable for it.</p></div>
        <div data-reveal><span class="big">{from ? fmtMoney(from).replace(/\.00$/, "") : "AED"}</span><h3>Published prices, in AED</h3><p class="mute" style="margin:0">Plans are listed on the pricing page. Setup is a stated one-off. Export is free on every plan, including after you downgrade.</p></div>
      </div>
      <div class="chips" style="margin-top:26px">{plans.map((pl) => <a class="chip" href="/pricing" style="text-decoration:none">{pl.contact_sales ? `${pl.name} · from ${fmtMoney(pl.monthly_minor).replace(/\.00$/, "")}` : pl.monthly_minor ? `${pl.name} · ${fmtMoney(pl.monthly_minor).replace(/\.00$/, "")}` : pl.name}</a>)}</div>
    </Section>

    <Section eyebrow="Honest answers" title={<>Questions people<br />ask first.</>}>
      <Faq items={[
        ["Who is it for?", <>Freight forwarders, transport and fleet operators, warehouse and fulfilment teams, couriers and customs brokers, mostly in the UAE. If you coordinate cargo and send invoices, it fits.</>],
        ["Is the free plan really free?", <>Yes. It is a permanent plan with real limits (two users, 25 jobs a month). Your workspace starts empty; we do not fill it with fake data.</>],
        ["Where does my data live, and can I take it with me?", <>Each company's records are isolated at database level. Export in CSV and JSON is on every plan, so you can leave whenever you want. Hosting region is stated on the <a href="/legal/subprocessors">subprocessors page</a>.</>],
        ["Do you file customs declarations or issue UAE e-invoices?", <>No, and we say so plainly. The customs module manages cases and hands over to your licensed broker channel. We are not an accredited e-invoicing provider; the platform reconciles with the one you use.</>],
        ["Why is it priced so differently from other vendors?", <>It is built and supported by a small team in India, with AI-native tooling and no field sales force. See <a href="/about">About</a> for how we work.</>],
        ["Can I talk to someone before I sign up?", <>Yes. Message us on <a href={waLink()} target="_blank" rel="noopener">WhatsApp {CONTACT.phoneDisplay}</a> or write to <a href={`mailto:${CONTACT.emails.contact}`}>{CONTACT.emails.contact}</a>. The chat on this page also reaches a person during staffed hours.</>],
      ]} />
    </Section>

    <CtaBand title={<>Make room for<br />better operations.</>} />
  </>;
}
