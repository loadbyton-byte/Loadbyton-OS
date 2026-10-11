import { Badge } from './ui.js';
import { Icon } from './experience.js';
import { PRODUCTS } from '../platform/catalog.js';

const workflows = [
  { name: 'Freight forwarding', slug: 'freight-forwarding', icon: 'document', body: 'Enquiry to collection, with every cost and document in context.', photo: 'port', tag: 'SELL · OPERATE · COLLECT' },
  { name: 'Road transport', slug: 'road-transport', icon: 'truck', body: 'Plan the trip. Dispatch the driver. Reconcile the outcome.', photo: 'road', tag: 'PLAN · DISPATCH · DELIVER' },
  { name: 'Warehouse & fulfilment', slug: 'contract-warehouse-3pl', icon: 'grid', body: 'Customer-owned stock, controlled movements and activity billing.', photo: 'warehouse', tag: 'RECEIVE · PICK · SHIP' },
];

export function HomeExperience() {
  return <>
    <section class="cinematic-hero" aria-labelledby="hero-heading">
      <div class="hero-images" aria-hidden="true">
        <img class="hero-image is-active" src="/assets/freight/fleet.webp" alt="" fetchpriority="high" />
        <img class="hero-image" src="/assets/freight/port.webp" alt="" loading="lazy" />
        <img class="hero-image" src="/assets/freight/road.webp" alt="" loading="lazy" />
      </div>
      <div class="hero-shade"></div>
      <div class="wrap hero-content">
        <div class="hero-copy">
          <span class="eyebrow"><span class="signal-dot"></span>UAE LOGISTICS · ONE OPERATING RECORD</span>
          <h1 id="hero-heading">Run the movement.<br /><em>Know the margin.</em></h1>
          <p>Your logistics company, connected. Bring enquiries, people, documents, deliveries and collections into one workspace.</p>
          <div class="actions"><a class="btn red" href="/start">Start free <Icon name="arrow" /></a><a class="btn hero-outline" href="#workflows">Explore the platform <span aria-hidden="true">↓</span></a></div>
          <p class="hero-note">Permanent Free plan. Your workspace starts empty.</p>
        </div>
        <div class="record-preview" data-reveal>
          <div class="record-heading"><span><span class="signal-dot"></span>THE OPERATING RECORD</span><Badge s="info" label="Illustrative workflow" /></div>
          <div class="record-route"><span>Enquiry</span><Icon name="arrow" /><span>Collection</span></div>
          <p>One movement. One connected history.</p>
          <ol class="record-timeline"><li><span>01</span><div><strong>Quote with context</strong><small>Customer, lane, supplier rates and approval.</small></div><Icon name="document" /></li><li><span>02</span><div><strong>Move with confidence</strong><small>Ownership, milestones and delivery evidence.</small></div><Icon name="truck" /></li><li><span>03</span><div><strong>Close with clarity</strong><small>Costs, invoices and collection visibility.</small></div><Icon name="money" /></li></ol>
          <a href="/how-activation-works">See how it connects <Icon name="arrow" /></a>
        </div>
      </div>
      <div class="wrap hero-bottom"><span>BUILT AROUND THE WAY LOGISTICS WORKS</span><div class="hero-scenes" aria-label="Choose freight scene"><button type="button" data-hero-scene="0" aria-label="Fleet scene" aria-pressed="true">01</button><button type="button" data-hero-scene="1" aria-label="Port scene" aria-pressed="false">02</button><button type="button" data-hero-scene="2" aria-label="Road scene" aria-pressed="false">03</button></div></div>
    </section>
    <div class="workflow-strip"><div class="wrap">{['ENQUIRE', 'QUOTE', 'MOVE', 'DOCUMENT', 'INVOICE', 'COLLECT'].map((s, i) => <span><small>{String(i + 1).padStart(2,'0')}</small>{s}<span class="strip-point" aria-hidden="true">+</span></span>)}</div></div>

    <section class="block story-section" id="workflows"><div class="wrap">
      <div class="section-heading" data-reveal><div><span class="eyebrow">LESS FRAGMENTATION. MORE CONTROL.</span><h2>Every team.<br />The same picture.</h2></div><p>Stop piecing together the day from spreadsheets and message threads. Keep the commercial promise, operational progress and financial outcome connected.</p></div>
      <div class="grid g3 workflow-cards">{workflows.map(w => <a class="workflow-card" href={`/sectors/${w.slug}`} data-reveal><div class="workflow-photo"><img src={`/assets/freight/${w.photo}.webp`} alt="" loading="lazy" /><span class="badge">Pilot workflow</span></div><div class="workflow-card-body"><span class="eyebrow">{w.tag}</span><h3>{w.name}</h3><p>{w.body}</p><span class="workflow-link">Explore workflow <Icon name="arrow" /></span></div></a>)}</div>
    </div></section>

    <section class="block platform-section"><div class="wrap"><div class="section-heading" data-reveal><div><span class="eyebrow">A PLATFORM THAT GROWS WITH YOU</span><h2>One workspace.<br />Room to go further.</h2></div><p>Register once. Add depth as you grow. Your customers, jobs and documents stay with the same company account.</p></div>
      <div class="platform-bento"><article class="bento-feature" data-reveal><Icon name="money" /><h3>Know what the job<br />actually earned.</h3><p>Quotation estimates, expected costs and reconciled outcomes stay separate. Follow the numbers back to their source records.</p><div class="margin-lanes"><span>ESTIMATED <i></i></span><span>EXPECTED <i></i></span><span>RECONCILED <i></i></span></div><small>Three views of margin. No invented totals.</small></article>
        <article class="card" data-reveal><Icon name="people" /><h3>Everyone has their place.</h3><p>Individual accounts, team roles, customer portals and a focused driver interface.</p><a href="/security">Explore access controls <Icon name="arrow" /></a></article>
        <article class="card" data-reveal><Icon name="shield" /><h3>Control is built in.</h3><p>Tenant isolation, approval gates, immutable histories and evidence attached to the work.</p><a href="/enterprise">Explore enterprise controls <Icon name="arrow" /></a></article>
        <article class="card bento-wide" data-reveal><div><span class="eyebrow">START SMALL. KEEP YOUR HISTORY.</span><h3>Your next capability is an upgrade,<br />not a new implementation.</h3></div><a class="btn ghost" href="/find-my-bundle">Find my bundle <Icon name="arrow" /></a></article>
      </div>
    </div></section>

    <section class="block" id="connected-workflow"><div class="wrap"><div class="section-heading" data-reveal><div><span class="eyebrow">FROM FIRST CONVERSATION TO FINAL COLLECTION</span><h2>The whole journey.<br />In one context.</h2></div><p>The Forwarding Starter workflow connects the daily work before you add more tools.</p></div><ol class="journey-grid">{[['Enquiry & quote','Capture the requirement and prepare a reviewed quotation.'],['Job & evidence','Keep supplier costs, documents and milestones with the job.'],['Invoice & collection','See unbilled deliveries and outstanding receivables.']].map(([title,body],i)=><li data-reveal><span class="journey-number">0{i+1}</span><h3>{title}</h3><p>{body}</p></li>)}</ol></div></section>

    <section class="block alt"><div class="wrap"><div class="section-heading" data-reveal><div><span class="eyebrow">CLEAR ABOUT WHAT WORKS TODAY</span><h2>A portfolio.<br />An honest roadmap.</h2></div><p>Pilot means a working workflow awaiting production acceptance. Planned capabilities remain visible without being presented as live.</p></div><div class="grid g3">{PRODUCTS.map(x=><article class="card product-card" data-reveal><Icon name="grid" /><Badge s={x.status} label={x.status === 'pilot' ? 'Pilot' : x.status === 'planned' ? 'Planned' : 'Available'} /><h3>{x.name}</h3><p class="mute">{x.blurb}</p></article>)}</div><p class="portfolio-link"><a href="/sectors">Explore all 18 sector profiles <Icon name="arrow" /></a></p></div></section>

    <section class="closing-cta"><div class="wrap" data-reveal><span class="eyebrow">YOUR NEXT MOVE</span><h2>Make room for<br />better operations.</h2><p>Start with a real workspace. Build around your business.</p><div class="actions"><a class="btn red" href="/start">Create my free workspace <Icon name="arrow" /></a><a class="btn hero-outline" href="/contact">Talk to us</a></div></div></section>
  </>;
}
