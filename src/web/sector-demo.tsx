import { Hono } from "hono";
import { config } from "../config.js";
import { HttpError } from "../lib/util.js";
import { SECTORS, sectorBySlug } from "../platform/catalog.js";
import { Icon } from "./experience.js";
import { CtaBand, PHOTO, PageHero, Section, sectorPhoto, Ticks } from "./site-kit.js";
import { CONTACT, waLink } from "./brand.js";
import { PublicShell, type Page } from "./ui.js";
import type { C, Env } from "./mw.js";

/** A sample-data walkthrough of one sector: its stages, a board with sample records, the documents and the roles involved.
 * Every figure is invented sample data (reserved names, round numbers). It is a guided demo of the workflow, not a customer's records. */
type Row = [ref: string, who: string, what: string, stage: number, amount: string];
type Demo = { stages: string[]; kpis: [string, string][]; rows: Row[]; docs: string[]; roles: string[] };

export const SECTOR_DEMOS: Record<string, Demo> = {
  "freight-forwarding": {
    stages: ["Enquiry", "Quote", "Booked", "In transit", "Invoiced"],
    kpis: [["Open jobs", "37"], ["Quotes awaiting reply", "9"], ["Margin this month", "AED 184k"]],
    rows: [["FF-2041", "Gulf Gate Trading", "Jebel Ali → Mumbai · 2×40HC", 3, "AED 21,400"], ["FF-2042", "Pearl Textiles", "Dubai → Hamburg · air 1.2 t", 1, "AED 9,850"], ["FF-2043", "Oasis Foods", "Karachi → Dubai · 1×20GP", 2, "AED 6,300"], ["FF-2044", "Nova Tools", "Shanghai → Jebel Ali · LCL 8 cbm", 4, "AED 4,120"]],
    docs: ["Booking confirmation", "House bill of lading", "Commercial invoice", "Packing list", "Proof of delivery"],
    roles: ["Sales", "Pricing", "Coordinator", "Finance"],
  },
  "customs-brokerage": {
    stages: ["Case opened", "Evidence checked", "Approval", "Handed over", "Billed"],
    kpis: [["Open cases", "28"], ["Waiting for evidence", "6"], ["Deposits held", "AED 312k"]],
    rows: [["CB-880", "Gulf Gate Trading", "Import declaration · 14 lines", 1, "AED 3,200"], ["CB-881", "Pearl Textiles", "Export declaration · re-export", 2, "AED 1,850"], ["CB-882", "Oasis Foods", "Inspection query response", 0, "AED 640"], ["CB-883", "Nova Tools", "Handover pack for official channel", 3, "AED 2,100"]],
    docs: ["Invoice and packing list", "Certificate of origin", "Valuation estimate", "Independent approval record", "Handover pack"],
    roles: ["Broker", "Approver", "Coordinator", "Finance"],
  },
  "road-transport": {
    stages: ["Planned", "Assigned", "On the road", "Delivered", "POD filed"],
    kpis: [["Trips today", "42"], ["Fleet utilisation", "81%"], ["Late trips", "3"]],
    rows: [["TRP-0388", "Khalifa Port → Al Quoz", "Truck DXB-4412 · driver Rafi", 2, "AED 1,150"], ["TRP-0389", "Sharjah → Abu Dhabi", "Truck SHJ-2210 · subcontractor", 1, "AED 880"], ["TRP-0390", "Al Ain → Dubai", "Truck DXB-3098 · driver Imran", 0, "AED 940"], ["TRP-0391", "Jebel Ali → Ras Al Khaimah", "Truck DXB-5521 · driver Farid", 3, "AED 1,320"]],
    docs: ["Trip sheet", "Delivery note", "Proof of delivery", "Vehicle documents", "Subcontractor invoice"],
    roles: ["Dispatcher", "Driver", "Fleet manager", "Finance"],
  },
  "contract-warehouse-3pl": {
    stages: ["Inbound", "Put-away", "Stored", "Picked", "Dispatched"],
    kpis: [["Pallet positions used", "86%"], ["Movements today", "214"], ["Activity billing", "AED 58k"]],
    rows: [["IN-5501", "Oasis Foods", "Receipt · 24 pallets", 0, "—"], ["ST-2210", "Nova Tools", "Zone B · 120 cartons", 2, "AED 1,800 / mo"], ["PK-7710", "Pearl Textiles", "Pick wave · 38 lines", 3, "AED 420"], ["DS-3301", "Gulf Gate Trading", "Dispatch · 6 pallets", 4, "AED 310"]],
    docs: ["Goods received note", "Stock count sheet", "Pick list", "Dispatch note", "Activity billing statement"],
    roles: ["Warehouse manager", "Picker", "Inventory controller", "Finance"],
  },
  "courier-last-mile": {
    stages: ["Collected", "At hub", "Out for delivery", "Delivered", "Cash handed over"],
    kpis: [["Parcels today", "1,240"], ["First-attempt delivery", "92%"], ["COD to remit", "AED 41k"]],
    rows: [["P-883120", "Merchant: Fig & Olive", "Dubai Marina · COD AED 220", 2, "AED 220"], ["P-883121", "Merchant: Desert Gear", "Sharjah · prepaid", 1, "—"], ["P-883122", "Merchant: Fig & Olive", "Al Barsha · failed attempt 1", 2, "AED 145"], ["P-883123", "Merchant: Blue Loom", "JLT · COD AED 90", 3, "AED 90"]],
    docs: ["Waybill label", "Proof of delivery", "Failed-attempt record", "Rider cash handover", "Merchant remittance statement"],
    roles: ["Dispatcher", "Rider", "Cash desk", "Merchant owner"],
  },
  "ecommerce-fulfilment": {
    stages: ["Order in", "Reserved", "Picked", "Packed", "Shipped"],
    kpis: [["Orders today", "680"], ["Same-day ship rate", "96%"], ["Open returns", "23"]],
    rows: [["SO-91001", "Store: Fig & Olive", "3 lines · SKU FO-120, FO-044", 1, "AED 310"], ["SO-91002", "Store: Desert Gear", "1 line · SKU DG-9", 2, "AED 150"], ["SO-91003", "Store: Blue Loom", "5 lines · gift pack", 3, "AED 480"], ["SO-91004", "Store: Fig & Olive", "Return · 1 line", 0, "—"]],
    docs: ["Pick/pack slip", "Carrier label", "Return authorisation", "Stock count", "Merchant activity statement"],
    roles: ["Merchant", "Picker/packer", "Returns clerk", "Account manager"],
  },
  "consolidation-nvocc": {
    stages: ["Cargo received", "Container planned", "Loaded", "Sailed", "Settled with agent"],
    kpis: [["Open consolidations", "11"], ["Average fill", "84%"], ["Agent settlements due", "AED 96k"]],
    rows: [["CN-3010", "MBL MAEU-7712", "Jebel Ali → Hamburg · 40HC · 9 house bills", 2, "AED 38,000"], ["CN-3011", "MBL CMA-4408", "Jebel Ali → Mombasa · 20GP · 5 house bills", 1, "AED 12,600"], ["CN-3012", "MBL MSC-9901", "Sharjah → Karachi · 40HC · 12 house bills", 3, "AED 24,900"], ["CN-3013", "MBL MAEU-7790", "Jebel Ali → Rotterdam · 40HC · 8 house bills", 4, "AED 31,200"]],
    docs: ["Master bill of lading", "House bills of lading", "Container loading plan", "Cargo manifest", "Agent settlement statement"],
    roles: ["Consolidator", "Documentation", "Overseas agent", "Finance"],
  },
  "cold-chain": {
    stages: ["Booked", "Pre-cooled", "In transit", "Delivered", "Closed"],
    kpis: [["Temperature-controlled loads", "17"], ["Excursions this week", "2"], ["On-hold for review", "1"]],
    rows: [["CC-0710", "Oasis Foods", "Chilled 2–8 °C · 12 pallets", 2, "AED 5,400"], ["CC-0711", "Fresh Bay Dairy", "Frozen −18 °C · 8 pallets", 1, "AED 4,200"], ["CC-0712", "MedLine Supplies", "Pharma 15–25 °C · 4 pallets", 3, "AED 6,900"], ["CC-0713", "Oasis Foods", "Excursion record · hold for approval", 2, "—"]],
    docs: ["Temperature log", "Calibration certificate", "Excursion report", "Hold/release approval", "Delivery receipt"],
    roles: ["Dispatcher", "Quality approver", "Driver", "Customer"],
  },
  "project-heavy-cargo": {
    stages: ["Survey", "Permits", "Equipment booked", "Move", "Closed out"],
    kpis: [["Active projects", "6"], ["Permits pending", "4"], ["Budget used", "72%"]],
    rows: [["PJ-120", "Desert Power Co", "Transformer 82 t · Jebel Ali → Al Dhafra", 3, "AED 410,000"], ["PJ-121", "Harbour Build", "Crane sections · 3 abnormal loads", 1, "AED 126,000"], ["PJ-122", "Metro Works", "TBM parts · night move", 2, "AED 289,000"], ["PJ-123", "Desert Power Co", "Route survey · bridge limits", 0, "AED 18,500"]],
    docs: ["Route survey report", "Movement permits", "Lifting plan", "Equipment bookings", "Close-out budget report"],
    roles: ["Project manager", "Surveyor", "Equipment planner", "Finance"],
  },
  "automotive-logistics": {
    stages: ["Arrived at port", "Inspected", "Yard slot", "Released", "Delivered"],
    kpis: [["Vehicles in yard", "214"], ["Damage claims open", "5"], ["Released today", "38"]],
    rows: [["VIN-5521", "WBA…3391 · sedan", "Port inspection · scratch noted", 1, "—"], ["VIN-5522", "JTD…8820 · SUV", "Yard slot B-14 · ready", 2, "AED 90 / day"], ["VIN-5523", "KMH…1170 · hatch", "Released to dealer · Sharjah", 3, "AED 650"], ["VIN-5524", "WDD…4402 · coupe", "Delivered · signed condition report", 4, "AED 720"]],
    docs: ["Condition report", "Release authority", "Yard location record", "Dealer delivery receipt", "Damage claim file"],
    roles: ["Yard controller", "Inspector", "Dispatcher", "Dealer"],
  },
  "marine-agency": {
    stages: ["Port call opened", "Services requested", "Alongside", "Sailed", "Accounts final"],
    kpis: [["Vessels this week", "7"], ["Service requests open", "19"], ["Disbursements to settle", "AED 143k"]],
    rows: [["PC-4410", "MV Blue Marlin", "ETA Port Rashid · bunkers + crew change", 1, "AED 62,000"], ["PC-4411", "MV Coral Star", "Alongside Jebel Ali · provisions", 2, "AED 18,400"], ["PC-4412", "MV Nordic Pearl", "Sailed · disbursement estimate vs actual", 3, "AED 71,300"], ["PC-4413", "MV Atlas One", "Notice of readiness filed", 0, "AED 4,800"]],
    docs: ["Port call file", "Disbursement estimate", "Service orders", "Statement of facts", "Final disbursement account"],
    roles: ["Ship agent", "Operations", "Principal (owner)", "Finance"],
  },
  "aviation-logistics": {
    stages: ["Booked", "Handed to airline", "Flown", "Arrived", "Delivered"],
    kpis: [["Air shipments open", "24"], ["Flights tracked", "11"], ["Handling exceptions", "2"]],
    rows: [["AW-610", "Pearl Textiles", "DXB → FRA · 1.2 t · EK flight", 2, "AED 9,850"], ["AW-611", "MedLine Supplies", "DXB → LHR · 300 kg · pharma", 1, "AED 7,200"], ["AW-612", "Nova Tools", "SHJ → DEL · 800 kg", 3, "AED 5,600"], ["AW-613", "Oasis Foods", "DXB → JED · 2 t · perishable", 0, "AED 11,400"]],
    docs: ["Air waybill", "Dangerous goods declaration (if any)", "Flight manifest", "Milestone log", "Delivery receipt"],
    roles: ["Air desk", "Documentation", "Airline agent", "Customer"],
  },
  "moving-relocation": {
    stages: ["Survey", "Quote accepted", "Packing", "Moved", "Claims closed"],
    kpis: [["Moves this month", "34"], ["Inventory items logged", "5,120"], ["Open damage claims", "3"]],
    rows: [["MV-208", "Ms. Haddad", "Villa Jumeirah → Abu Dhabi · 3 beds", 2, "AED 7,800"], ["MV-209", "Mr. Okafor", "International · Dubai → Lagos · 1 container", 1, "AED 29,500"], ["MV-210", "Gulf Tech FZ", "Office move · 40 desks", 3, "AED 16,200"], ["MV-211", "Ms. Rahman", "Survey booked · Fri 10:00", 0, "—"]],
    docs: ["Survey sheet", "Inventory list", "Packing schedule", "Damage claim form", "Move completion note"],
    roles: ["Surveyor", "Crew lead", "Customer", "Finance"],
  },
  "import-export-trading": {
    stages: ["Sales order", "Purchase placed", "Shipped", "Landed", "Stock & margin closed"],
    kpis: [["Open trades", "19"], ["Landed-cost margin", "14.2%"], ["Stock value", "AED 1.1m"]],
    rows: [["TR-310", "Buyer: Oasis Retail", "Olive oil · 12 pallets · sales AED 84k", 2, "AED 84,000"], ["TR-311", "Buyer: Pearl Hotels", "Linen · 3 cartons-lots · sales AED 41k", 1, "AED 41,000"], ["TR-312", "Buyer: Nova Stores", "Hand tools · landed cost review", 3, "AED 56,000"], ["TR-313", "Buyer: Oasis Retail", "Dates · 8 pallets", 0, "AED 29,500"]],
    docs: ["Sales order", "Purchase order", "Commercial invoice", "Landed-cost sheet", "Stock ledger"],
    roles: ["Trader", "Buyer", "Warehouse", "Finance"],
  },
  distribution: {
    stages: ["Order received", "Allocated", "Loaded", "Delivered", "Returns settled"],
    kpis: [["Drops today", "186"], ["Fill rate", "97%"], ["Open returns", "14"]],
    rows: [["DO-7101", "Retailer: Corner Mart", "42 lines · van route R3", 2, "AED 11,900"], ["DO-7102", "Retailer: Green Basket", "18 lines · van route R1", 1, "AED 5,300"], ["DO-7103", "Retailer: Sunrise Cafe", "9 lines · delivered", 3, "AED 2,150"], ["DO-7104", "Retailer: Corner Mart", "Return · 3 cartons damaged", 4, "−AED 240"]],
    docs: ["Delivery order", "Load sheet", "Proof of delivery", "Credit note", "Route summary"],
    roles: ["Sales rep", "Dispatcher", "Driver", "Finance"],
  },
  "container-depot": {
    stages: ["Gate-in", "Inspected", "Stacked", "Repaired / ready", "Gate-out"],
    kpis: [["Containers in yard", "1,420"], ["Open repairs", "37"], ["Gate moves today", "118"]],
    rows: [["CT-MSKU771201", "Line: Maersk", "Gate-in · empty 40HC", 0, "AED 45"], ["CT-CMAU882300", "Line: CMA", "Stack C-12-3 · damage noted", 2, "AED 12 / day"], ["CT-MSCU340011", "Line: MSC", "Repair estimate · door panel", 3, "AED 780"], ["CT-HLCU902210", "Line: Hapag", "Gate-out · released to haulier", 4, "AED 45"]],
    docs: ["Equipment interchange receipt", "Damage survey", "Repair estimate and approval", "Release order", "Storage invoice"],
    roles: ["Gate clerk", "Surveyor", "Yard planner", "Billing"],
  },
  "dangerous-cargo": {
    stages: ["Classified", "Evidence checked", "Approved", "Moving", "Closed"],
    kpis: [["Regulated loads", "9"], ["Awaiting approval", "2"], ["Incidents this year", "0"]],
    rows: [["DG-045", "ChemSupply FZ", "UN1263 paint · class 3 · 4 drums", 1, "AED 3,900"], ["DG-046", "Gulf Gases", "UN1950 aerosols · class 2 · 60 cartons", 2, "AED 5,450"], ["DG-047", "LabCo", "UN3480 lithium batteries · class 9", 3, "AED 2,700"], ["DG-048", "ChemSupply FZ", "Classification evidence pending", 0, "—"]],
    docs: ["Safety data sheet", "Classification record", "Trained-driver certificate", "Approval record", "Incident log"],
    roles: ["Safety officer", "Approver", "Driver", "Customer"],
  },
  "cross-border-transit": {
    stages: ["Booked", "Documents ready", "At border", "Cleared", "Delivered"],
    kpis: [["Trucks in transit", "16"], ["Average border wait", "5.5 h"], ["Guarantees open", "AED 220k"]],
    rows: [["XB-901", "Oasis Foods", "Dubai → Muscat · Hatta border", 2, "AED 4,900"], ["XB-902", "Nova Tools", "Dubai → Riyadh · Ghuwaifat", 1, "AED 7,300"], ["XB-903", "Pearl Textiles", "Sharjah → Doha · transit declaration", 3, "AED 6,150"], ["XB-904", "Oasis Foods", "Dubai → Kuwait · guarantee released", 4, "AED 9,200"]],
    docs: ["Transit declaration", "Border crossing record", "Transit guarantee", "CMR / consignment note", "Delivery receipt"],
    roles: ["Dispatcher", "Border agent", "Driver", "Finance"],
  },
};

const pg = (c: C, title: string, extra: Partial<Page> = {}): Page => ({
  title, csrf: c.get("csrf"), path: c.req.path, user: c.get("session") ? { name: c.get("session")!.name } : null,
  ok: c.req.query("ok"), err: c.req.query("err"), heroDark: true, ...extra,
});

export const sectorDemo = new Hono<Env>();

sectorDemo.get("/demo/:slug", (c) => {
  const slug = c.req.param("slug");
  const s = sectorBySlug(slug);
  const d = SECTOR_DEMOS[slug];
  if (!s || !d) throw new HttpError(404, "Demo not found");
  const idx = SECTORS.findIndex((x) => x.slug === slug);
  const next = SECTORS[(idx + 1) % SECTORS.length];
  return c.html(
    <PublicShell p={pg(c, `${s.name} demo`, { description: `A walkthrough of the ${s.name} pack: stages, sample records, documents and roles.` })}>
      <PageHero kicker="SECTOR DEMO" crumb={s.name} photo={sectorPhoto(s.slug)} title={<>{s.name} <span class="badge ok">Demo</span></>} lede={`${s.workflow}.`}>
        <a class="btn red" href={`/start?sector=${s.slug}`}>Request this pack <Icon name="arrow" size={16} /></a>
        <a class="btn glass" href="/demo">All 18 sectors</a>
      </PageHero>
      <Section eyebrow="SAMPLE DASHBOARD" title={<>The day at a glance.</>} intro="Sample data with invented names and round figures. Your build uses your own fields, statuses and layouts.">
        <div class="grid g3">{d.kpis.map(([l, v]) => <div class="card" data-reveal><p class="mute small" style="margin:0">{l}</p><p style="margin:.2em 0 0;font-size:1.9rem;font-weight:800;letter-spacing:-.02em">{v}</p></div>)}</div>
      </Section>
      <Section tone="tint" eyebrow="THE WORKFLOW" title={<>From first touch to paid, in five stages.</>}>
        <ol class="steps" style="list-style:none;margin:0 0 28px;padding:0;display:flex;flex-wrap:wrap;gap:10px">{d.stages.map((t, i) => <li class="badge info" style="font-size:.8rem"><b>{i + 1}</b>&nbsp;{t}</li>)}</ol>
        <div class="table-wrap" data-reveal><table class="table"><thead><tr><th>Reference</th><th>Party</th><th>What</th><th>Stage</th><th>Value</th></tr></thead><tbody>
          {d.rows.map(([ref, who, what, st, amt]) => <tr><td><strong>{ref}</strong></td><td>{who}</td><td>{what}</td><td><span class={`badge ${st >= d.stages.length - 2 ? "ok" : "info"}`}>{d.stages[st]}</span></td><td>{amt}</td></tr>)}
        </tbody></table></div>
        <p class="mute small" style="margin-top:12px">Sample records. Names, vehicles, vessels and amounts are invented.</p>
      </Section>
      <Section eyebrow="DOCUMENTS AND PEOPLE" title={<>What gets produced, and who touches it.</>}>
        <div class="grid g2">
          <div class="card" data-reveal><h3>Documents</h3><Ticks items={d.docs} /></div>
          <div class="card" data-reveal><h3>Roles</h3><Ticks items={d.roles} /><p class="mute small">Each role sees only the screens it needs. Sensitive steps need a second person.</p></div>
        </div>
        {config.demoUrl ? <p style="margin-top:24px"><a class="btn" href={config.demoUrl} target="_blank" rel="noopener">Open the live demo environment <Icon name="arrowUpRight" size={16} /></a></p> : <p class="mute small" style="margin-top:24px">Want to click through it with a person? <a href="/contact">Ask for a guided demo</a> or <a href={waLink()} target="_blank" rel="noopener">WhatsApp {CONTACT.phoneDisplay}</a>.</p>}
      </Section>
      <CtaBand title={<>Like what you see?<br />Tell us what to change.</>} body={`Register a request and we customise this pack to your fields and layouts, then hand it over within ${config.deliveryHours} hours.`} primary={["Request this pack", `/start?sector=${s.slug}`]} />
      <Section tone="tint"><p style="margin:0;text-align:center"><a href={`/demo/${next.slug}`}>Next sector demo: {next.name} →</a></p></Section>
    </PublicShell>);
});
