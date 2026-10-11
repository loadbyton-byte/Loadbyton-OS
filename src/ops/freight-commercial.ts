import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest, forbidden, toMinor } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, nextNumber, optStr, recordId, reqStr, today } from "./common.js";

async function gate(c: Conn, ctx: Ctx, perm: Parameters<typeof require>[1], write = true) {
  require(ctx, perm);
  if (write) await assertWritable(c, ctx.tenantId);
  if (!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='freight-forwarding'`)).rows.length) throw forbidden("Freight forwarding is not selected.");
}
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
const day = (d: unknown) => String(d).slice(0, 10);

// ═════════════ Rate tiers
export interface Tier { from_qty: number; unit_cost_minor: number }

/** Quantity breaks apply to the whole quantity at the highest break reached; they are fixed once set (publish a new rate to change them). */
export async function setRateTiers(c: Conn, ctx: Ctx, rateId: string, input: { from_qty: number | string; unit_cost: number | string }[]) {
  await gate(c, ctx, "rate.write");
  const rate = await must(c.query<any>(`SELECT id, basis FROM rates WHERE id=$1`, [recordId(rateId, "Rate")]), "Rate");
  if (rate.basis === "per_shipment") throw badRequest("A per-shipment rate has no quantity breaks.");
  if ((await c.query(`SELECT 1 FROM rate_tiers WHERE rate_id=$1`, [rate.id])).rows.length) throw badRequest("This rate's breaks are fixed. Publish a new rate to change them.");
  const tiers = input.map((t) => ({ from_qty: Number(t.from_qty), unit_cost_minor: typeof t.unit_cost === "number" ? Math.round(t.unit_cost) : toMinor(t.unit_cost) }));
  if (tiers.length < 2) throw badRequest("Enter at least two breaks, starting at 0.");
  tiers.sort((a, b) => a.from_qty - b.from_qty);
  if (tiers[0].from_qty !== 0) throw badRequest("The first break must start at 0.");
  for (let i = 1; i < tiers.length; i++) {
    if (!(tiers[i].from_qty > tiers[i - 1].from_qty)) throw badRequest("Breaks must be strictly increasing.");
    if (tiers[i].unit_cost_minor > tiers[i - 1].unit_cost_minor) throw badRequest("A higher break must not cost more per unit than a lower one.");
  }
  for (const t of tiers) await c.query(`INSERT INTO rate_tiers(tenant_id,rate_id,from_qty,unit_cost_minor,created_by) VALUES ($1,$2,$3,$4,$5)`, [ctx.tenantId, rate.id, t.from_qty, t.unit_cost_minor, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "rate.tiers_set", "rate", rate.id, { breaks: tiers.length });
}

export interface RatePrice { unit_minor: number; total_minor: number; tier_from: number; minimum_applied: boolean; expired: boolean; basis: string }
export async function priceRate(c: Conn, rateId: string, qty: number, onDate = today()): Promise<RatePrice> {
  const rate = await must(c.query<any>(`SELECT * FROM rates WHERE id=$1`, [recordId(rateId, "Rate")]), "Rate");
  if (!(qty > 0)) throw badRequest("Quantity must be above zero.");
  const tiers = (await c.query<any>(`SELECT from_qty, unit_cost_minor FROM rate_tiers WHERE rate_id=$1 ORDER BY from_qty`, [rate.id])).rows;
  let unit = Number(rate.unit_cost_minor), from = 0;
  for (const t of tiers) if (qty >= Number(t.from_qty)) { unit = Number(t.unit_cost_minor); from = Number(t.from_qty); }
  const gross = Math.round(qty * unit), min = Number(rate.minimum_minor);
  return { unit_minor: unit, total_minor: Math.max(gross, min), tier_from: from, minimum_applied: gross < min, expired: day(rate.valid_to) < onDate, basis: rate.basis };
}

// ═════════════ Supplier contract restrictions
const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean);

export async function createSupplierContract(c: Conn, ctx: Ctx, f: Record<string, any>) {
  await gate(c, ctx, "rate.write");
  const sup = await must(c.query<any>(`SELECT id, kind FROM parties WHERE id=$1`, [recordId(f.supplier_id, "Supplier")]), "Supplier");
  if (sup.kind === "customer") throw badRequest("Contracts are held against suppliers and agents.");
  if (!f.valid_from || !f.valid_to || f.valid_to < f.valid_from) throw badRequest("Enter a valid date range.");
  const modes = list(f.modes).map(norm);
  if (modes.some((m) => !["air", "ocean", "road"].includes(m))) throw badRequest("Modes are air, ocean or road.");
  const max = f.max_cost ? toMinor(f.max_cost) : null;
  if (f.document_id) await must(c.query(`SELECT id FROM documents WHERE id=$1 AND status='issued' AND NOT hold`, [recordId(f.document_id, "Contract document")]), "Issued contract document");
  const id = (await c.query<any>(
    `INSERT INTO supplier_contracts(tenant_id,supplier_id,reference,valid_from,valid_to,modes,origins,destinations,max_cost_minor,terms,document_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ctx.tenantId, sup.id, reqStr(f.reference, "Contract reference", 120), f.valid_from, f.valid_to, modes, list(f.origins), list(f.destinations), max, optStr(f.terms, 2000), f.document_id || null, ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "supplier_contract.created", "supplier_contract", id, { supplier: sup.id });
  return id as string;
}
export async function setContractStatus(c: Conn, ctx: Ctx, id: string, status: "active" | "suspended" | "ended") {
  await gate(c, ctx, "quote.approve");
  if (!["active", "suspended", "ended"].includes(status)) throw badRequest("Choose active, suspended or ended.");
  await must(c.query(`UPDATE supplier_contracts SET status=$2 WHERE id=$1 AND status<>'ended' RETURNING id`, [recordId(id, "Contract"), status]), "Open contract");
  await audit(c, ctx.tenantId, actorOf(ctx), "supplier_contract.status", "supplier_contract", id, { status });
}
export async function setSupplierPolicy(c: Conn, ctx: Ctx, supplierId: string, f: { contract_required?: boolean; blocked?: boolean; blocked_reason?: string }) {
  await gate(c, ctx, "quote.approve");
  const sup = await must(c.query<any>(`SELECT id FROM parties WHERE id=$1 AND kind<>'customer'`, [recordId(supplierId, "Supplier")]), "Supplier");
  const blocked = !!f.blocked;
  const reason = blocked ? reqStr(f.blocked_reason, "Reason for blocking", 500) : null;
  await c.query(
    `INSERT INTO supplier_policy(tenant_id,supplier_id,contract_required,blocked,blocked_reason,updated_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id,supplier_id) DO UPDATE SET contract_required=$3, blocked=$4, blocked_reason=$5, updated_by=$6, updated_at=now()`,
    [ctx.tenantId, sup.id, !!f.contract_required, blocked, reason, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "supplier_policy.set", "party", sup.id, { blocked, contract_required: !!f.contract_required });
}

export interface SupplierUse { mode?: string | null; origin?: string | null; destination?: string | null; amountMinor?: number; onDate?: string }
const laneHit = (allowed: string[], value?: string | null) => !allowed.length || (!!value && allowed.some((a) => norm(value).includes(norm(a)) || norm(a).includes(norm(value))));

/** Returns the reasons a supplier may not be used for this work; empty means allowed. A supplier without any contract is unrestricted unless policy says a contract is required. */
export async function supplierProblems(c: Conn, supplierId: string, use: SupplierUse): Promise<string[]> {
  const on = use.onDate ?? today();
  const pol = (await c.query<any>(`SELECT * FROM supplier_policy WHERE supplier_id=$1`, [supplierId])).rows[0];
  const name = (await c.query<any>(`SELECT name FROM parties WHERE id=$1`, [supplierId])).rows[0]?.name ?? "Supplier";
  if (pol?.blocked) return [`${name} is blocked: ${pol.blocked_reason}`];
  const contracts = (await c.query<any>(`SELECT * FROM supplier_contracts WHERE supplier_id=$1 AND status='active'`, [supplierId])).rows;
  if (!contracts.length) return pol?.contract_required ? [`${name} requires an active contract and none is recorded`] : [];
  const misses: string[] = [];
  for (const k of contracts) {
    const why: string[] = [];
    if (on < day(k.valid_from) || on > day(k.valid_to)) why.push(`outside ${day(k.valid_from)}–${day(k.valid_to)}`);
    if (k.modes.length && (!use.mode || !k.modes.includes(norm(use.mode)))) why.push(`mode ${use.mode ?? "unknown"} is not covered`);
    if (!laneHit(k.origins, use.origin)) why.push(`origin ${use.origin ?? "unknown"} is not covered`);
    if (!laneHit(k.destinations, use.destination)) why.push(`destination ${use.destination ?? "unknown"} is not covered`);
    if (k.max_cost_minor != null && (use.amountMinor ?? 0) > Number(k.max_cost_minor)) why.push(`cost exceeds the ${(Number(k.max_cost_minor) / 100).toFixed(2)} limit`);
    if (!why.length) return [];
    misses.push(`${k.reference}: ${why.join(", ")}`);
  }
  return [`${name} has no contract covering this work (${misses.join("; ")})`];
}

// ═════════════ Opportunities and tenders
type Stage = "identified" | "bid_review" | "bidding" | "submitted" | "won" | "lost" | "no_bid" | "withdrawn";
const NEXT: Record<string, Stage[]> = {
  identified: ["bid_review", "no_bid", "withdrawn"], bid_review: ["bidding", "no_bid", "withdrawn"], bidding: ["submitted", "withdrawn"], submitted: ["won", "lost", "withdrawn"],
};
const TERMINAL = ["won", "lost", "no_bid", "withdrawn"];

export async function createOpportunity(c: Conn, ctx: Ctx, f: Record<string, any>) {
  await gate(c, ctx, "enquiry.write");
  const party = await must(c.query<any>(`SELECT id, kind FROM parties WHERE id=$1`, [recordId(f.party_id, "Customer")]), "Customer");
  if (party.kind !== "customer") throw badRequest("Opportunities are raised against customers.");
  if (!["tender", "rfq", "spot", "renewal"].includes(f.kind)) throw badRequest("Choose tender, RFQ, spot or renewal.");
  for (const k of ["clarification_by", "submission_by", "decision_expected"]) if (f[k] && String(f[k]) < "2000-01-01") throw badRequest("Enter valid dates.");
  if (f.clarification_by && f.submission_by && f.clarification_by > f.submission_by) throw badRequest("Clarifications must close before the submission deadline.");
  const win = f.win_pct === undefined || f.win_pct === "" ? 20 : Number(f.win_pct);
  if (!Number.isInteger(win) || win < 0 || win > 100) throw badRequest("Win probability is 0–100.");
  const no = await nextNumber(c, ctx.tenantId, "opportunity", "OPP");
  const id = (await c.query<any>(
    `INSERT INTO opportunities(tenant_id,no,kind,party_id,title,source_ref,est_value_minor,win_pct,clarification_by,submission_by,decision_expected,owner_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
    [ctx.tenantId, no, f.kind, party.id, reqStr(f.title, "Title", 200), optStr(f.source_ref, 200), f.est_value ? toMinor(f.est_value) : 0, win, f.clarification_by || null, f.submission_by || null, f.decision_expected || null, ctx.userId])).rows[0].id;
  await c.query(`INSERT INTO opportunity_events(tenant_id,opportunity_id,from_stage,to_stage,note,actor_id) VALUES ($1,$2,NULL,'identified',$3,$4)`, [ctx.tenantId, id, "Opportunity recorded", ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "opportunity.created", "opportunity", id, { no, kind: f.kind });
  return { id: id as string, no };
}

export async function addLane(c: Conn, ctx: Ctx, opportunityId: string, f: Record<string, any>) {
  await gate(c, ctx, "enquiry.write");
  const o = await must(c.query<any>(`SELECT id, stage FROM opportunities WHERE id=$1`, [recordId(opportunityId, "Opportunity")]), "Opportunity");
  if (TERMINAL.includes(o.stage)) throw badRequest("This opportunity is closed.");
  if (!["air", "ocean", "road"].includes(f.mode)) throw badRequest("Choose a mode.");
  const vol = Number(f.volume || 0);
  if (!(vol >= 0)) throw badRequest("Volume cannot be negative.");
  await c.query(`INSERT INTO opportunity_lanes(tenant_id,opportunity_id,mode,origin,destination,volume,unit,period) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.tenantId, o.id, f.mode, reqStr(f.origin, "Origin", 200), reqStr(f.destination, "Destination", 200), vol, f.unit || "shipments", f.period || "year"]);
}

export async function linkQuote(c: Conn, ctx: Ctx, opportunityId: string, quoteId: string) {
  await gate(c, ctx, "quote.write");
  const o = await must(c.query<any>(`SELECT id, party_id, stage FROM opportunities WHERE id=$1`, [recordId(opportunityId, "Opportunity")]), "Opportunity");
  if (TERMINAL.includes(o.stage)) throw badRequest("This opportunity is closed.");
  const q = await must(c.query<any>(`SELECT id, party_id FROM quotes WHERE id=$1`, [recordId(quoteId, "Quote")]), "Quote");
  if (q.party_id !== o.party_id) throw badRequest("The quote is addressed to a different customer.");
  await c.query(`INSERT INTO opportunity_quotes(tenant_id,opportunity_id,quote_id,linked_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [ctx.tenantId, o.id, q.id, ctx.userId]);
}

export async function moveOpportunity(c: Conn, ctx: Ctx, id: string, to: Stage, f: { note?: string; lost_reason?: string; competitor_note?: string } = {}) {
  await gate(c, ctx, "enquiry.write");
  const o = await must(c.query<any>(`SELECT * FROM opportunities WHERE id=$1 FOR UPDATE`, [recordId(id, "Opportunity")]), "Opportunity");
  if (!(NEXT[o.stage] ?? []).includes(to)) throw badRequest(`An opportunity at “${o.stage.replace("_", " ")}” cannot move to “${String(to).replace("_", " ")}”.`);
  const note = optStr(f.note, 1000);
  const set: string[] = [], vals: any[] = [o.id];
  const add = (col: string, v: unknown) => { vals.push(v); set.push(`${col}=$${vals.length}`); };
  if ((o.stage === "bid_review" && (to === "bidding" || to === "no_bid")) || (o.stage === "identified" && to === "no_bid")) {
    require(ctx, "quote.approve");
    if (o.created_by === ctx.userId && !ctx.roles.includes("owner")) throw forbidden("The bid / no-bid decision belongs to someone other than the person who raised the opportunity.");
    add("bid_decision_by", ctx.userId); add("bid_decision_note", reqStr(note, "Bid / no-bid rationale", 1000));
  }
  if (to === "submitted") {
    const sent = await c.query(`SELECT 1 FROM opportunity_quotes oq JOIN quotes q ON q.id=oq.quote_id WHERE oq.opportunity_id=$1 AND q.status IN ('sent','accepted','converted')`, [o.id]);
    if (!sent.rows.length) throw badRequest("Link at least one quotation that has been sent to the customer before marking the bid submitted.");
  }
  if (to === "won") add("outcome_note", reqStr(note, "Award reference or outcome", 1000));
  if (to === "lost") { add("lost_reason", reqStr(f.lost_reason, "Reason lost", 500)); if (f.competitor_note) add("competitor_note", optStr(f.competitor_note, 500)); if (note) add("outcome_note", note); }
  if (to === "withdrawn") add("outcome_note", reqStr(note, "Reason withdrawn", 1000));
  if (TERMINAL.includes(to)) set.push("closed_at=now()");
  await c.query(`UPDATE opportunities SET stage='${to}'${set.length ? ", " + set.join(", ") : ""} WHERE id=$1`, vals);
  await c.query(`INSERT INTO opportunity_events(tenant_id,opportunity_id,from_stage,to_stage,note,actor_id) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, o.id, o.stage, to, note ?? f.lost_reason ?? null, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "opportunity.moved", "opportunity", o.id, { from: o.stage, to });
}

export async function listOpportunities(c: Conn, stage?: string) {
  return (await c.query<any>(
    `SELECT o.*, p.name AS party_name, (SELECT count(*) FROM opportunity_quotes q WHERE q.opportunity_id=o.id)::int AS quotes FROM opportunities o JOIN parties p ON p.id=o.party_id
      WHERE ($1::text IS NULL OR o.stage=$1) ORDER BY o.closed_at IS NOT NULL, o.submission_by NULLS LAST, o.created_at DESC LIMIT 300`, [stage || null])).rows;
}
export async function getOpportunity(c: Conn, id: string) {
  const o = await must(c.query<any>(`SELECT o.*, p.name AS party_name FROM opportunities o JOIN parties p ON p.id=o.party_id WHERE o.id=$1`, [recordId(id, "Opportunity")]), "Opportunity");
  const [lanes, quotes, events] = await Promise.all([
    c.query<any>(`SELECT * FROM opportunity_lanes WHERE opportunity_id=$1 ORDER BY origin, destination`, [o.id]),
    c.query<any>(`SELECT q.id, q.no, q.status, v.total_sell_minor, v.total_cost_minor FROM opportunity_quotes oq JOIN quotes q ON q.id=oq.quote_id JOIN quote_versions v ON v.quote_id=q.id AND v.version=q.current_version WHERE oq.opportunity_id=$1 ORDER BY q.created_at`, [o.id]),
    c.query<any>(`SELECT e.*, u.name AS actor FROM opportunity_events e LEFT JOIN team_members u ON u.user_id=e.actor_id WHERE e.opportunity_id=$1 ORDER BY e.id`, [o.id]),
  ]);
  return { opp: o, lanes: lanes.rows, quotes: quotes.rows, events: events.rows, next: NEXT[o.stage] ?? [] };
}

export async function pipelineReport(c: Conn, asOf = today()) {
  const stages = (await c.query<any>(
    `SELECT stage, currency, count(*)::int AS n, sum(est_value_minor)::bigint AS value, sum(est_value_minor * win_pct / 100)::bigint AS weighted FROM opportunities WHERE closed_at IS NULL GROUP BY stage, currency ORDER BY stage`)).rows;
  const due = (await c.query<any>(
    `SELECT o.id, o.no, o.title, o.stage, o.submission_by, p.name AS party_name, (o.submission_by < $1::date) AS overdue FROM opportunities o JOIN parties p ON p.id=o.party_id
      WHERE o.closed_at IS NULL AND o.submission_by IS NOT NULL AND o.stage IN ('identified','bid_review','bidding') AND o.submission_by <= $1::date + 14 ORDER BY o.submission_by`, [asOf])).rows;
  const r = (await c.query<any>(
    `SELECT count(*) FILTER (WHERE stage='won')::int AS won, count(*) FILTER (WHERE stage='lost')::int AS lost FROM opportunities WHERE closed_at >= $1::date - 365`, [asOf])).rows[0];
  const reasons = (await c.query<any>(`SELECT lost_reason, count(*)::int AS n FROM opportunities WHERE stage='lost' AND closed_at >= $1::date - 365 GROUP BY 1 ORDER BY n DESC LIMIT 10`, [asOf])).rows;
  return { stages, due, won: r.won, lost: r.lost, win_rate_pct: r.won + r.lost ? Math.round((r.won / (r.won + r.lost)) * 1000) / 10 : null, lost_reasons: reasons };
}

// ═════════════ Master / house shipments
/** IATA air waybill: 3-digit airline prefix + 7-digit serial + 1 check digit, where the check digit is the serial modulo 7. */
export function validateAwb(ref: string): string {
  const m = /^(\d{3})[- ]?(\d{7})(\d)$/.exec(ref.trim());
  if (!m) throw badRequest("An air master waybill is 11 digits: a 3-digit airline prefix, a 7-digit serial and a check digit.");
  if (Number(m[2]) % 7 !== Number(m[3])) throw badRequest("The air waybill's check digit does not match its serial (serial modulo 7).");
  return `${m[1]}-${m[2]}${m[3]}`;
}

export async function createMaster(c: Conn, ctx: Ctx, f: Record<string, any>) {
  await gate(c, ctx, "job.write");
  if (!["air", "ocean", "road"].includes(f.mode)) throw badRequest("Choose a mode.");
  const ref = f.mode === "air" ? validateAwb(reqStr(f.master_ref, "Master air waybill", 40)) : reqStr(f.master_ref, "Master reference", 80);
  const no = await nextNumber(c, ctx.tenantId, "freight_master", "MST");
  const dup = await c.query(`SELECT 1 FROM freight_masters WHERE mode=$1 AND lower(master_ref)=lower($2) AND status<>'cancelled'`, [f.mode, ref]);
  if (dup.rows.length) throw badRequest("A master with that reference already exists.");
  if (f.etd && f.eta && f.eta < f.etd) throw badRequest("ETA cannot be before ETD.");
  const id = (await c.query<any>(
    `INSERT INTO freight_masters(tenant_id,no,mode,master_ref,carrier,origin,destination,vessel_or_flight,etd,eta,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ctx.tenantId, no, f.mode, ref, optStr(f.carrier, 120), reqStr(f.origin, "Origin", 200), reqStr(f.destination, "Destination", 200), optStr(f.vessel_or_flight, 120), f.etd || null, f.eta || null, ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "master.created", "freight_master", id, { no, ref });
  return { id: id as string, no };
}

async function openMaster(c: Conn, id: string) {
  const m = await must(c.query<any>(`SELECT * FROM freight_masters WHERE id=$1 FOR UPDATE`, [recordId(id, "Master")]), "Master");
  if (m.status !== "open") throw badRequest(`This master is ${m.status}.`);
  return m;
}

export async function attachHouse(c: Conn, ctx: Ctx, masterId: string, jobId: string, houseRef: string) {
  await gate(c, ctx, "job.write");
  const m = await openMaster(c, masterId);
  const j = await must(c.query<any>(`SELECT * FROM jobs WHERE id=$1 FOR UPDATE`, [recordId(jobId, "Job")]), "Job");
  if (j.mode !== m.mode) throw badRequest(`This is a ${j.mode} job; the master is ${m.mode}.`);
  if (j.master_id) throw badRequest("This job is already on a master.");
  if (["cancelled", "operationally_complete"].includes(j.status)) throw badRequest(`A ${j.status.replace("_", " ")} job cannot join a master.`);
  const ref = reqStr(houseRef, "House reference", 80);
  const dup = await c.query(`SELECT 1 FROM jobs WHERE master_id=$1 AND lower(house_ref)=lower($2)`, [m.id, ref]);
  if (dup.rows.length) throw badRequest("That house reference is already on this master.");
  await c.query(`UPDATE jobs SET master_id=$2, house_ref=$3, master_ref=$4, carrier=coalesce(carrier,$5) WHERE id=$1`, [j.id, m.id, ref, m.master_ref, m.carrier]);
  await audit(c, ctx.tenantId, actorOf(ctx), "master.house_attached", "freight_master", m.id, { job: j.id, house: ref });
  const warnings: string[] = [];
  if (j.destination && !laneHit([m.destination], j.destination) && !laneHit([j.destination], m.destination)) warnings.push(`Job destination “${j.destination}” differs from the master's “${m.destination}” — check the onward leg.`);
  return { warnings };
}

export async function detachHouse(c: Conn, ctx: Ctx, masterId: string, jobId: string) {
  await gate(c, ctx, "job.write");
  const m = await openMaster(c, masterId);
  const used = await c.query(`SELECT 1 FROM freight_master_allocations WHERE job_id=$1`, [recordId(jobId, "Job")]);
  if (used.rows.length) throw badRequest("Master costs have been allocated to this house; it cannot be removed.");
  await must(c.query(`UPDATE jobs SET master_id=NULL WHERE id=$1 AND master_id=$2 RETURNING id`, [jobId, m.id]), "House shipment on this master");
  await audit(c, ctx.tenantId, actorOf(ctx), "master.house_detached", "freight_master", m.id, { job: jobId });
}

/** Houses with their gross figures and — when a reviewed chargeable-weight assessment exists for the job's enquiry — the chargeable weight. */
export async function masterSummary(c: Conn, id: string) {
  const m = await must(c.query<any>(`SELECT * FROM freight_masters WHERE id=$1`, [recordId(id, "Master")]), "Master");
  const houses = (await c.query<any>(
    `SELECT j.id, j.no, j.house_ref, j.status, j.pieces, j.weight_kg::float8 AS weight_kg, j.volume_cbm::float8 AS volume_cbm, p.name AS party_name,
            (SELECT w.chargeable::float8 FROM weight_assessments w JOIN quotes q ON q.enquiry_id=w.enquiry_id WHERE q.id=j.quote_id ORDER BY w.created_at DESC LIMIT 1) AS chargeable
       FROM jobs j JOIN parties p ON p.id=j.party_id WHERE j.master_id=$1 ORDER BY j.house_ref`, [m.id])).rows;
  const sum = (k: string) => houses.reduce((a: number, h: any) => a + Number(h[k] ?? 0), 0);
  const costs = (await c.query<any>(`SELECT k.*, s.name AS supplier_name FROM freight_master_costs k LEFT JOIN parties s ON s.id=k.supplier_id WHERE k.master_id=$1 ORDER BY k.created_at`, [m.id])).rows;
  return { master: m, houses, costs, totals: { houses: houses.length, pieces: sum("pieces"), weight_kg: Math.round(sum("weight_kg") * 1000) / 1000, volume_cbm: Math.round(sum("volume_cbm") * 1000) / 1000, chargeable: houses.every((h: any) => h.chargeable != null) ? sum("chargeable") : null } };
}

export async function addMasterCost(c: Conn, ctx: Ctx, masterId: string, f: Record<string, any>) {
  await gate(c, ctx, "job.cost");
  const m = await openMaster(c, masterId);
  const amount = toMinor(f.amount);
  if (!(amount > 0)) throw badRequest("Enter the carrier charge.");
  let supplier: string | null = null;
  if (f.supplier_id) {
    supplier = (await must(c.query<any>(`SELECT id FROM parties WHERE id=$1 AND kind<>'customer'`, [recordId(f.supplier_id, "Supplier")]), "Supplier")).id;
    const problems = await supplierProblems(c, supplier!, { mode: m.mode, origin: m.origin, destination: m.destination, amountMinor: amount });
    if (problems.length) throw badRequest(problems.join(" "));
  }
  const id = (await c.query<any>(`INSERT INTO freight_master_costs(tenant_id,master_id,supplier_id,description,amount_minor,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, m.id, supplier, reqStr(f.description, "Description", 300), amount, ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "master.cost_added", "freight_master", m.id, { amount });
  return id as string;
}

/** Largest-remainder split: shares are whole minor units that add up to the amount exactly, and the same inputs always give the same split. */
export function splitProportionally(amount: number, weights: { key: string; w: number }[]): Map<string, number> {
  const total = weights.reduce((a, x) => a + x.w, 0);
  if (!(total > 0)) throw badRequest("Nothing to allocate against.");
  const raw = weights.map((x) => ({ key: x.key, exact: (amount * x.w) / total }));
  const out = new Map(raw.map((r) => [r.key, Math.floor(r.exact)]));
  let left = amount - [...out.values()].reduce((a, b) => a + b, 0);
  for (const r of [...raw].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.key.localeCompare(b.key))) {
    if (left <= 0) break;
    out.set(r.key, out.get(r.key)! + 1); left--;
  }
  return out;
}

export async function allocateMasterCost(c: Conn, ctx: Ctx, costId: string, basis: "chargeable_weight" | "weight" | "volume" | "pieces" | "equal") {
  await gate(c, ctx, "job.cost");
  if (!["chargeable_weight", "weight", "volume", "pieces", "equal"].includes(basis)) throw badRequest("Choose an allocation basis.");
  const k = await must(c.query<any>(`SELECT * FROM freight_master_costs WHERE id=$1 FOR UPDATE`, [recordId(costId, "Master cost")]), "Master cost");
  if (k.allocated_at) throw badRequest("This charge has already been allocated; allocations are final.");
  const m = await openMaster(c, k.master_id);
  const s = await masterSummary(c, m.id);
  if (!s.houses.length) throw badRequest("Attach house shipments before allocating.");
  const col = { chargeable_weight: "chargeable", weight: "weight_kg", volume: "volume_cbm", pieces: "pieces", equal: "" }[basis];
  const w = s.houses.map((h: any) => {
    const v = basis === "equal" ? 1 : h[col];
    if (v == null) throw badRequest(basis === "chargeable_weight" ? `${h.no} has no chargeable-weight assessment. Assess it from its enquiry (reviewed provider rule) or choose another basis.` : `${h.no} has no ${basis.replace("_", " ")} recorded.`);
    if (!(Number(v) > 0)) throw badRequest(`${h.no} has a zero ${basis.replace("_", " ")}.`);
    return { key: h.id as string, w: Number(v) };
  });
  const shares = splitProportionally(Number(k.amount_minor), w);
  for (const h of s.houses) {
    const amount = shares.get(h.id)!;
    const jc = (await c.query<any>(`INSERT INTO job_costs(tenant_id,job_id,supplier_id,description,estimated_minor) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.tenantId, h.id, k.supplier_id, `Master ${m.master_ref}: ${k.description}`, amount])).rows[0].id;
    await c.query(`INSERT INTO freight_master_allocations(tenant_id,master_cost_id,job_id,job_cost_id,basis_value,amount_minor) VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.tenantId, k.id, h.id, jc, w.find((x: any) => x.key === h.id)!.w, amount]);
  }
  await c.query(`UPDATE freight_master_costs SET basis=$2, allocated_at=now(), allocated_by=$3 WHERE id=$1`, [k.id, basis, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "master.cost_allocated", "freight_master", m.id, { cost: k.id, basis, houses: s.houses.length });
}

export async function closeMaster(c: Conn, ctx: Ctx, id: string) {
  await gate(c, ctx, "job.write");
  const m = await openMaster(c, id);
  const s = await masterSummary(c, m.id);
  if (!s.houses.length) throw badRequest("A master with no house shipments cannot be closed; cancel it instead.");
  const open = s.costs.filter((x: any) => !x.allocated_at);
  if (open.length) throw badRequest(`Allocate ${open.length} master charge${open.length > 1 ? "s" : ""} to the houses before closing.`);
  await c.query(`UPDATE freight_masters SET status='closed', closed_at=now() WHERE id=$1`, [m.id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "master.closed", "freight_master", m.id);
}
export async function cancelMaster(c: Conn, ctx: Ctx, id: string) {
  await gate(c, ctx, "job.write");
  const m = await openMaster(c, id);
  const s = await masterSummary(c, m.id);
  if (s.houses.length || s.costs.length) throw badRequest("Remove the houses and charges first.");
  await c.query(`UPDATE freight_masters SET status='cancelled' WHERE id=$1`, [m.id]);
}
export async function listMasters(c: Conn) {
  return (await c.query<any>(`SELECT m.*, (SELECT count(*) FROM jobs j WHERE j.master_id=m.id)::int AS houses FROM freight_masters m ORDER BY m.created_at DESC LIMIT 200`)).rows;
}

/** Manifest as CSV for the carrier / agent; the authoritative document is issued by the carrier or its agent, not by this system. */
export async function manifestCsv(c: Conn, id: string) {
  const s = await masterSummary(c, id);
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["master_ref", "house_ref", "job", "customer", "pieces", "gross_kg", "volume_cbm", "chargeable"];
  return [head.join(","), ...s.houses.map((h: any) => [s.master.master_ref, h.house_ref, h.no, h.party_name, h.pieces ?? "", h.weight_kg ?? "", h.volume_cbm ?? "", h.chargeable ?? ""].map(q).join(","))].join("\n");
}
