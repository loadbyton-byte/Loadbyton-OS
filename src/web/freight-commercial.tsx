import { Hono } from "hono";
import { HttpError, formatDay } from "../lib/util.js";
import { listParties } from "../ops/crm.js";
import { listQuotes } from "../ops/quotes.js";
import { today } from "../ops/common.js";
import {
  addLane, addMasterCost, allocateMasterCost, attachHouse, cancelMaster, closeMaster, createMaster, createOpportunity, createSupplierContract, detachHouse, getOpportunity, linkQuote,
  listMasters, listOpportunities, manifestCsv, masterSummary, moveOpportunity, pipelineReport, priceRate, setContractStatus, setRateTiers, setSupplierPolicy,
} from "../ops/freight-commercial.js";
import { act, appPage, can, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

export const freightCommercial = new Hono<Env>();
const label = (s: string) => s.replace(/_/g, " ");
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;
const money = (m: number, cur = "AED") => `${cur} ${(Number(m) / 100).toFixed(2)}`;

// ───────── opportunities and tenders
freightCommercial.get("/app/freight/opportunities", async (c) => {
  need(c, "read");
  const stage = c.req.query("stage") || undefined, csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ rows: await listOpportunities(cn, stage), rep: await pipelineReport(cn), customers: await listParties(cn, "customer") }));
  return appPage(c, "Opportunities and tenders", <>
    <PageHead title="Opportunities and tenders" sub="Track bids from identification through the bid / no-bid decision to the recorded outcome." />
    <div class="grid g4">
      <div class="card"><h3>Win rate (12 months)</h3><div class="kpi">{d.rep.win_rate_pct == null ? "—" : `${d.rep.win_rate_pct}%`}</div><p class="small mute">{d.rep.won} won · {d.rep.lost} lost</p></div>
      {d.rep.stages.slice(0, 3).map((s: any) => <div class="card"><h3>{label(s.stage)}</h3><div class="kpi">{s.n}</div><p class="small mute">{money(s.value, s.currency)} · weighted {money(s.weighted, s.currency)}</p></div>)}
    </div>
    {d.rep.due.length ? <section class="card"><h2>Deadlines in the next 14 days</h2><Table head={["Opportunity", "Customer", "Stage", "Submission by"]}>{d.rep.due.map((x: any) => <tr><td><a href={`/app/freight/opportunities/${x.id}`}>{x.no} · {x.title}</a></td><td>{x.party_name}</td><td><Badge s={x.stage} /></td><td class={x.overdue ? "bad" : ""}>{formatDay(x.submission_by)}{x.overdue ? " — overdue" : ""}</td></tr>)}</Table></section> : null}
    <Table head={["No", "Opportunity", "Customer", "Stage", ["Value", "num"], "Submission by", "Quotes"]} empty={d.rows.length ? undefined : "No opportunities yet."}>
      {d.rows.map((o: any) => <tr><td><a href={`/app/freight/opportunities/${o.id}`}>{o.no}</a></td><td>{o.title}<div class="small mute">{label(o.kind)}{o.source_ref ? ` · ${o.source_ref}` : ""}</div></td><td>{o.party_name}</td><td><Badge s={o.stage} /></td><td class="num">{money(o.est_value_minor, o.currency)}</td><td class="small">{o.submission_by ? formatDay(o.submission_by) : "—"}</td><td>{o.quotes}</td></tr>)}</Table>
    {can(c, "enquiry.write") ? <form class="card" method="post" action="/app/freight/opportunities"><Csrf t={csrf} /><h2>Record an opportunity</h2>
      <div class="field"><label for="kind">Kind</label><select id="kind" name="kind"><option value="tender">Tender</option><option value="rfq">RFQ</option><option value="spot">Spot request</option><option value="renewal">Contract renewal</option></select></div>
      <div class="field"><label for="party_id">Customer</label><select id="party_id" name="party_id" required>{d.customers.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
      {field("title", "Title", { required: true })}{field("source_ref", "Tender / RFQ reference")}{field("est_value", "Estimated annual value (AED)", { type: "number", step: "0.01", min: "0" })}{field("win_pct", "Win probability %", { type: "number", min: "0", max: "100", value: "20" })}
      {field("clarification_by", "Clarifications close", { type: "date" })}{field("submission_by", "Submission deadline", { type: "date" })}<button class="btn">Record</button></form> : null}
  </>);
});
freightCommercial.post("/app/freight/opportunities", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/freight/opportunities", async () => {
    const r = await withT(c, (cn, ctx) => createOpportunity(cn, ctx, { kind: str(b.kind), party_id: str(b.party_id), title: str(b.title), source_ref: str(b.source_ref), est_value: str(b.est_value), win_pct: str(b.win_pct), clarification_by: str(b.clarification_by), submission_by: str(b.submission_by) }));
    return { to: `/app/freight/opportunities/${r.id}`, ok: `${r.no} recorded.` };
  });
});
freightCommercial.get("/app/freight/opportunities/:id", async (c) => {
  need(c, "read");
  const id = c.req.param("id"), csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ ...(await getOpportunity(cn, id)), allQuotes: await listQuotes(cn) }));
  const o = d.opp, open = !["won", "lost", "no_bid", "withdrawn"].includes(o.stage);
  return appPage(c, o.no, <>
    <PageHead title={`${o.no} · ${o.title}`} sub={`${o.party_name} · ${label(o.kind)}${o.source_ref ? ` · ${o.source_ref}` : ""}`}><Badge s={o.stage} /></PageHead>
    <div class="card"><dl style="display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:0">
      <dt class="mute">Estimated value</dt><dd style="margin:0">{money(o.est_value_minor, o.currency)} at {o.win_pct}% → {money((Number(o.est_value_minor) * o.win_pct) / 100, o.currency)} weighted</dd>
      <dt class="mute">Clarifications / submission</dt><dd style="margin:0">{o.clarification_by ? formatDay(o.clarification_by) : "—"} / {o.submission_by ? formatDay(o.submission_by) : "—"}</dd>
      {o.bid_decision_note ? <><dt class="mute">Bid decision</dt><dd style="margin:0">{o.bid_decision_note}</dd></> : null}
      {o.outcome_note ? <><dt class="mute">Outcome</dt><dd style="margin:0">{o.outcome_note}</dd></> : null}
      {o.lost_reason ? <><dt class="mute">Lost because</dt><dd style="margin:0">{o.lost_reason}{o.competitor_note ? ` — ${o.competitor_note}` : ""}</dd></> : null}</dl></div>
    <h2>Lanes</h2>
    <Table head={["Mode", "Lane", ["Volume", "num"]]} empty={d.lanes.length ? undefined : "No lanes recorded."}>{d.lanes.map((l: any) => <tr><td>{l.mode}</td><td>{l.origin} → {l.destination}</td><td class="num">{Number(l.volume)} {l.unit} / {l.period}</td></tr>)}</Table>
    {open && can(c, "enquiry.write") ? <form class="card" method="post" action={`/app/freight/opportunities/${id}/lane`}><Csrf t={csrf} />
      <div class="field"><label for="mode">Mode</label><select id="mode" name="mode"><option>ocean</option><option>air</option><option>road</option></select></div>
      {field("origin", "Origin", { required: true })}{field("destination", "Destination", { required: true })}{field("volume", "Volume", { type: "number", step: "0.001", min: "0" })}
      <div class="field"><label for="unit">Unit</label><select id="unit" name="unit"><option>shipments</option><option>teu</option><option>kg</option><option>cbm</option></select></div><button class="btn sm">Add lane</button></form> : null}
    <h2>Quotations</h2>
    <Table head={["Quote", "Status", ["Sell", "num"], ["Cost", "num"]]} empty={d.quotes.length ? undefined : "No quotation linked."}>{d.quotes.map((q: any) => <tr><td><a href={`/app/quotes/${q.id}`}>{q.no}</a></td><td><Badge s={q.status} /></td><td class="num"><Money v={q.total_sell_minor} /></td><td class="num"><Money v={q.total_cost_minor} /></td></tr>)}</Table>
    {open && can(c, "quote.write") ? <form class="card" method="post" action={`/app/freight/opportunities/${id}/quote`}><Csrf t={csrf} /><div class="field"><label for="quote_id">Link a quotation to this customer</label>
      <select id="quote_id" name="quote_id">{d.allQuotes.filter((q: any) => q.party_id === o.party_id).map((q: any) => <option value={q.id}>{q.no} · {label(q.status)}</option>)}</select></div><button class="btn sm">Link</button></form> : null}
    {open && can(c, "enquiry.write") ? <section class="card"><h2>Move forward</h2>
      {d.next.map((to: string) => <form method="post" action={`/app/freight/opportunities/${id}/move`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="to" value={to} />
        <input name="note" placeholder={to === "won" ? "Award reference" : to === "bidding" || to === "no_bid" ? "Bid / no-bid rationale" : "Note"} />
        {to === "lost" ? <><input name="lost_reason" placeholder="Reason lost" required /><input name="competitor_note" placeholder="Competitor / price intelligence" /></> : null}<button class={`btn sm ${to === "no_bid" || to === "lost" || to === "withdrawn" ? "ghost" : ""}`}>{label(to)}</button></form>)}</section> : null}
    <h2>History</h2>
    <Table head={["When", "From", "To", "By", "Note"]}>{d.events.map((e: any) => <tr><td class="small">{formatDay(e.at)}</td><td>{e.from_stage ? label(e.from_stage) : "—"}</td><td>{label(e.to_stage)}</td><td>{e.actor ?? "—"}</td><td class="small">{e.note ?? ""}</td></tr>)}</Table>
  </>);
});
freightCommercial.post("/app/freight/opportunities/:id/lane", async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `/app/freight/opportunities/${id}`, async () => { await withT(c, (cn, ctx) => addLane(cn, ctx, id, { mode: str(b.mode), origin: str(b.origin), destination: str(b.destination), volume: str(b.volume), unit: str(b.unit) })); return { to: `/app/freight/opportunities/${id}`, ok: "Lane added." }; });
});
freightCommercial.post("/app/freight/opportunities/:id/quote", async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `/app/freight/opportunities/${id}`, async () => { await withT(c, (cn, ctx) => linkQuote(cn, ctx, id, str(b.quote_id))); return { to: `/app/freight/opportunities/${id}`, ok: "Quotation linked." }; });
});
freightCommercial.post("/app/freight/opportunities/:id/move", async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `/app/freight/opportunities/${id}`, async () => { await withT(c, (cn, ctx) => moveOpportunity(cn, ctx, id, str(b.to) as any, { note: str(b.note), lost_reason: str(b.lost_reason), competitor_note: str(b.competitor_note) })); return { to: `/app/freight/opportunities/${id}`, ok: "Stage updated." }; });
});

// ───────── rate breaks
freightCommercial.get("/app/rates/:id", async (c) => {
  need(c, "read");
  const id = c.req.param("id"), csrf = c.get("csrf"), qty = Number(c.req.query("qty") || 0);
  const d = await withT(c, async (cn) => {
    const rate = (await cn.query<any>(`SELECT r.*, p.name AS supplier_name FROM rates r LEFT JOIN parties p ON p.id=r.supplier_id WHERE r.id=$1`, [id])).rows[0];
    if (!rate) throw new HttpError(404, "Rate not found");
    return { rate, tiers: (await cn.query<any>(`SELECT from_qty::float8 AS from_qty, unit_cost_minor FROM rate_tiers WHERE rate_id=$1 ORDER BY from_qty`, [id])).rows, price: qty > 0 ? await priceRate(cn, id, qty) : null };
  });
  const r = d.rate;
  return appPage(c, "Rate breaks", <>
    <PageHead title={`${r.charge_name} · ${r.origin} → ${r.destination}`} sub={`${r.supplier_name ?? "No supplier"} · ${r.mode} · ${label(r.basis)} · valid ${formatDay(r.valid_from)} – ${formatDay(r.valid_to)}`} />
    <p class="small mute">Breaks apply to the whole quantity at the highest break reached. Base cost {money(r.unit_cost_minor)} per unit; minimum charge {money(r.minimum_minor)}. Breaks are fixed once set.</p>
    <Table head={["From quantity", ["Cost per unit", "num"]]} empty="No quantity breaks — the base cost always applies.">{d.tiers.map((t: any) => <tr><td>{t.from_qty}</td><td class="num">{money(t.unit_cost_minor)}</td></tr>)}</Table>
    <form class="card" method="get" action={`/app/rates/${id}`}><h2>Price a quantity</h2>{field("qty", "Quantity", { type: "number", step: "0.001", min: "0.001", value: qty ? String(qty) : "" })}<button class="btn sm">Calculate</button>
      {d.price ? <p><strong>{money(d.price.total_minor)}</strong> at {money(d.price.unit_minor)} per unit{d.price.tier_from ? ` (break from ${d.price.tier_from})` : ""}{d.price.minimum_applied ? " — minimum charge applied" : ""}{d.price.expired ? " — this rate has expired" : ""}.</p> : null}</form>
    {can(c, "rate.write") && !d.tiers.length && r.basis !== "per_shipment" ? <form class="card" method="post" action={`/app/rates/${id}/tiers`}><Csrf t={csrf} /><h2>Set quantity breaks</h2>
      <p class="small mute">One break per line as “from quantity, cost per unit”. Start at 0; a higher break must not cost more.</p><textarea name="tiers" rows={5} required placeholder={"0, 10.00\n100, 8.50\n500, 7.00"}></textarea><button class="btn sm">Save breaks</button></form> : null}
  </>);
});
freightCommercial.post("/app/rates/:id/tiers", async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `/app/rates/${id}`, async () => {
    const tiers = str(b.tiers).split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [q, u] = l.split(/[,;\t ]+/); return { from_qty: Number(q), unit_cost: u }; });
    await withT(c, (cn, ctx) => setRateTiers(cn, ctx, id, tiers));
    return { to: `/app/rates/${id}`, ok: "Breaks saved." };
  });
});

// ───────── supplier contracts
freightCommercial.get("/app/freight/contracts", async (c) => {
  need(c, "read");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({
    suppliers: await listParties(cn, "supplier"),
    contracts: (await cn.query<any>(`SELECT k.*, p.name AS supplier_name FROM supplier_contracts k JOIN parties p ON p.id=k.supplier_id ORDER BY p.name, k.valid_to DESC LIMIT 300`)).rows,
    policies: (await cn.query<any>(`SELECT sp.*, p.name FROM supplier_policy sp JOIN parties p ON p.id=sp.supplier_id WHERE sp.blocked OR sp.contract_required ORDER BY p.name`)).rows,
  }));
  return appPage(c, "Supplier contracts", <>
    <PageHead title="Supplier contracts" sub="A supplier with an active contract can only be used for the modes, lanes and amounts it covers. Work outside it needs an approver's recorded override." />
    <Table head={["Supplier", "Reference", "Valid", "Covers", ["Limit", "num"], "Status", ""]} empty={d.contracts.length ? undefined : "No contracts recorded — suppliers are unrestricted."}>
      {d.contracts.map((k: any) => <tr><td>{k.supplier_name}</td><td>{k.reference}</td><td class="small">{formatDay(k.valid_from)} – {formatDay(k.valid_to)}</td>
        <td class="small">{k.modes.length ? k.modes.join("/") : "any mode"}; {k.origins.length ? k.origins.join(", ") : "any origin"} → {k.destinations.length ? k.destinations.join(", ") : "any destination"}</td>
        <td class="num">{k.max_cost_minor ? money(k.max_cost_minor) : "—"}</td><td><Badge s={k.status} /></td>
        <td>{can(c, "quote.approve") && k.status !== "ended" ? <form method="post" action={`/app/freight/contracts/${k.id}/status`} class="inline-form"><Csrf t={csrf} />
          <button class="btn ghost sm" name="status" value={k.status === "active" ? "suspended" : "active"}>{k.status === "active" ? "Suspend" : "Reinstate"}</button> <button class="btn ghost sm" name="status" value="ended">End</button></form> : null}</td></tr>)}</Table>
    {can(c, "rate.write") ? <form class="card" method="post" action="/app/freight/contracts"><Csrf t={csrf} /><h2>Record a contract</h2>
      <div class="field"><label for="supplier_id">Supplier</label><select id="supplier_id" name="supplier_id" required>{d.suppliers.map((s: any) => <option value={s.id}>{s.name}</option>)}</select></div>
      {field("reference", "Contract reference", { required: true })}{field("valid_from", "Valid from", { type: "date", required: true, value: today() })}{field("valid_to", "Valid to", { type: "date", required: true })}
      {field("modes", "Modes (air, ocean, road — blank for any)")}{field("origins", "Origins (comma-separated, blank for any)")}{field("destinations", "Destinations (comma-separated, blank for any)")}{field("max_cost", "Per-cost limit (AED, blank for none)", { type: "number", step: "0.01", min: "0" })}
      <button class="btn">Save contract</button></form> : null}
    <h2>Blocked or contract-required suppliers</h2>
    <Table head={["Supplier", "Contract required", "Blocked", "Reason"]} empty="None.">{d.policies.map((p: any) => <tr><td>{p.name}</td><td>{p.contract_required ? "Yes" : "No"}</td><td>{p.blocked ? "Yes" : "No"}</td><td class="small">{p.blocked_reason ?? ""}</td></tr>)}</Table>
    {can(c, "quote.approve") ? <form class="card" method="post" action="/app/freight/contracts/policy"><Csrf t={csrf} /><h2>Supplier policy</h2>
      <div class="field"><label for="ps">Supplier</label><select id="ps" name="supplier_id">{d.suppliers.map((s: any) => <option value={s.id}>{s.name}</option>)}</select></div>
      <label class="check"><input type="checkbox" name="contract_required" value="1" />Require an active contract</label><label class="check"><input type="checkbox" name="blocked" value="1" />Block this supplier</label>{field("blocked_reason", "Reason for blocking")}<button class="btn sm">Save policy</button></form> : null}
  </>);
});
freightCommercial.post("/app/freight/contracts", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/freight/contracts", async () => { await withT(c, (cn, ctx) => createSupplierContract(cn, ctx, { supplier_id: str(b.supplier_id), reference: str(b.reference), valid_from: str(b.valid_from), valid_to: str(b.valid_to), modes: str(b.modes), origins: str(b.origins), destinations: str(b.destinations), max_cost: str(b.max_cost) })); return { to: "/app/freight/contracts", ok: "Contract recorded." }; });
});
freightCommercial.post("/app/freight/contracts/policy", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/freight/contracts", async () => { await withT(c, (cn, ctx) => setSupplierPolicy(cn, ctx, str(b.supplier_id), { contract_required: !!b.contract_required, blocked: !!b.blocked, blocked_reason: str(b.blocked_reason) })); return { to: "/app/freight/contracts", ok: "Policy saved." }; });
});
freightCommercial.post("/app/freight/contracts/:id/status", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/freight/contracts", async () => { await withT(c, (cn, ctx) => setContractStatus(cn, ctx, c.req.param("id"), str(b.status) as any)); return { to: "/app/freight/contracts", ok: "Contract updated." }; });
});

// ───────── master / house shipments
freightCommercial.get("/app/freight/masters", async (c) => {
  need(c, "read");
  const csrf = c.get("csrf"), rows = await withT(c, (cn) => listMasters(cn));
  return appPage(c, "Master shipments", <>
    <PageHead title="Master shipments" sub="A master is the carrier-level booking or waybill; each customer's job rides it as a house shipment." />
    <Table head={["No", "Master", "Mode", "Lane", "Houses", "ETD", "Status"]} empty={rows.length ? undefined : "No masters yet."}>
      {rows.map((m: any) => <tr><td><a href={`/app/freight/masters/${m.id}`}>{m.no}</a></td><td>{m.master_ref}<div class="small mute">{m.carrier ?? ""} {m.vessel_or_flight ?? ""}</div></td><td>{m.mode}</td><td>{m.origin} → {m.destination}</td><td>{m.houses}</td><td class="small">{m.etd ? formatDay(m.etd) : "—"}</td><td><Badge s={m.status} /></td></tr>)}</Table>
    {can(c, "job.write") ? <form class="card" method="post" action="/app/freight/masters"><Csrf t={csrf} /><h2>New master</h2>
      <div class="field"><label for="mode">Mode</label><select id="mode" name="mode"><option>ocean</option><option>air</option><option>road</option></select></div>
      {field("master_ref", "Master B/L, AWB or CMR number", { required: true })}{field("carrier", "Carrier")}{field("vessel_or_flight", "Vessel / flight")}{field("origin", "Origin", { required: true })}{field("destination", "Destination", { required: true })}{field("etd", "ETD", { type: "date" })}{field("eta", "ETA", { type: "date" })}
      <p class="small mute">Air masters are checked against the IATA air-waybill check digit. The authoritative waybill is issued by the carrier or its agent.</p><button class="btn">Create master</button></form> : null}
  </>);
});
freightCommercial.post("/app/freight/masters", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/freight/masters", async () => { const r = await withT(c, (cn, ctx) => createMaster(cn, ctx, { mode: str(b.mode), master_ref: str(b.master_ref), carrier: str(b.carrier), vessel_or_flight: str(b.vessel_or_flight), origin: str(b.origin), destination: str(b.destination), etd: str(b.etd), eta: str(b.eta) })); return { to: `/app/freight/masters/${r.id}`, ok: `${r.no} created.` }; });
});
freightCommercial.get("/app/freight/masters/:id", async (c) => {
  need(c, "read");
  const id = c.req.param("id"), csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ s: await masterSummary(cn, id), jobs: (await cn.query<any>(`SELECT j.id, j.no, p.name AS party_name FROM jobs j JOIN parties p ON p.id=j.party_id WHERE j.master_id IS NULL AND j.mode=(SELECT mode FROM freight_masters WHERE id=$1) AND j.status IN ('planned','in_transit') ORDER BY j.created_at DESC LIMIT 200`, [id])).rows, suppliers: await listParties(cn, "supplier") }));
  const m = d.s.master, open = m.status === "open", t = d.s.totals;
  return appPage(c, m.no, <>
    <PageHead title={`${m.no} · ${m.master_ref}`} sub={`${m.mode} · ${m.origin} → ${m.destination}${m.carrier ? ` · ${m.carrier}` : ""}${m.vessel_or_flight ? ` · ${m.vessel_or_flight}` : ""}`}><Badge s={m.status} /><a class="btn ghost sm" href={`/app/freight/masters/${id}/manifest.csv`}>Manifest CSV</a></PageHead>
    <div class="grid g4"><div class="card"><h3>Houses</h3><div class="kpi">{t.houses}</div></div><div class="card"><h3>Pieces</h3><div class="kpi">{t.pieces}</div></div><div class="card"><h3>Gross kg</h3><div class="kpi">{t.weight_kg}</div></div><div class="card"><h3>Volume cbm</h3><div class="kpi">{t.volume_cbm}</div></div></div>
    <h2>House shipments</h2>
    <Table head={["House", "Job", "Customer", ["Pieces", "num"], ["kg", "num"], ["cbm", "num"], ["Chargeable", "num"], ""]} empty="No houses attached.">
      {d.s.houses.map((h: any) => <tr><td>{h.house_ref}</td><td><a href={`/app/jobs/${h.id}`}>{h.no}</a></td><td>{h.party_name}</td><td class="num">{h.pieces ?? "—"}</td><td class="num">{h.weight_kg ?? "—"}</td><td class="num">{h.volume_cbm ?? "—"}</td><td class="num">{h.chargeable ?? "—"}</td>
        <td>{open && can(c, "job.write") ? <form method="post" action={`/app/freight/masters/${id}/detach`}><Csrf t={csrf} /><input type="hidden" name="job_id" value={h.id} /><button class="btn ghost sm">Remove</button></form> : null}</td></tr>)}</Table>
    {open && can(c, "job.write") ? <form class="card" method="post" action={`/app/freight/masters/${id}/house`}><Csrf t={csrf} /><h2>Attach a job as a house shipment</h2>
      <div class="field"><label for="job_id">Job</label><select id="job_id" name="job_id">{d.jobs.map((j: any) => <option value={j.id}>{j.no} · {j.party_name}</option>)}</select></div>{field("house_ref", "House B/L or AWB number", { required: true })}<button class="btn sm">Attach</button></form> : null}
    <h2>Master charges</h2>
    <Table head={["Charge", "Supplier", ["Amount", "num"], "Allocated by", ""]} empty="No charges.">
      {d.s.costs.map((k: any) => <tr><td>{k.description}</td><td>{k.supplier_name ?? "—"}</td><td class="num">{money(k.amount_minor)}</td><td>{k.basis ? label(k.basis) : "—"}</td>
        <td>{open && !k.allocated_at && can(c, "job.cost") ? <form method="post" action={`/app/freight/masters/${id}/allocate`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="cost_id" value={k.id} />
          <select name="basis"><option value="chargeable_weight">chargeable weight</option><option value="weight">gross weight</option><option value="volume">volume</option><option value="pieces">pieces</option><option value="equal">equal shares</option></select><button class="btn sm">Allocate</button></form> : null}</td></tr>)}</Table>
    {open && can(c, "job.cost") ? <form class="card" method="post" action={`/app/freight/masters/${id}/cost`}><Csrf t={csrf} /><h2>Add a carrier charge</h2>{field("description", "Description", { required: true })}{field("amount", "Amount (AED)", { type: "number", step: "0.01", min: "0.01", required: true })}
      <div class="field"><label for="supplier_id">Supplier</label><select id="supplier_id" name="supplier_id"><option value="">—</option>{d.suppliers.map((s: any) => <option value={s.id}>{s.name}</option>)}</select></div><button class="btn sm">Add charge</button></form> : null}
    {open && can(c, "job.write") ? <div style="display:flex;gap:10px;margin-top:16px"><form method="post" action={`/app/freight/masters/${id}/close`}><Csrf t={csrf} /><button class="btn">Close master</button></form><form method="post" action={`/app/freight/masters/${id}/cancel`}><Csrf t={csrf} /><button class="btn ghost">Cancel master</button></form></div> : null}
  </>);
});
const mpost = (path: string, run: (cn: any, ctx: any, id: string, b: Record<string, any>) => Promise<unknown>, ok: string) =>
  freightCommercial.post(`/app/freight/masters/:id/${path}`, async (c) => {
    const id = c.req.param("id"), b = await formBody(c);
    return act(c, `/app/freight/masters/${id}`, async () => { const r: any = await withT(c, (cn, ctx) => run(cn, ctx, id, b)); return { to: `/app/freight/masters/${id}`, ok: r?.warnings?.length ? `${ok} ${r.warnings.join(" ")}` : ok }; });
  });
mpost("house", (cn, ctx, id, b) => attachHouse(cn, ctx, id, str(b.job_id), str(b.house_ref)), "House attached.");
mpost("detach", (cn, ctx, id, b) => detachHouse(cn, ctx, id, str(b.job_id)), "House removed.");
mpost("cost", (cn, ctx, id, b) => addMasterCost(cn, ctx, id, { description: str(b.description), amount: str(b.amount), supplier_id: str(b.supplier_id) }), "Charge added.");
mpost("allocate", (cn, ctx, _id, b) => allocateMasterCost(cn, ctx, str(b.cost_id), str(b.basis) as any), "Charge allocated to the houses.");
mpost("close", (cn, ctx, id) => closeMaster(cn, ctx, id), "Master closed.");
mpost("cancel", (cn, ctx, id) => cancelMaster(cn, ctx, id), "Master cancelled.");
freightCommercial.get("/app/freight/masters/:id/manifest.csv", async (c) => {
  need(c, "read");
  const csv = await withT(c, (cn) => manifestCsv(cn, c.req.param("id")));
  return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="manifest-${c.req.param("id").slice(0, 8)}.csv"` });
});
