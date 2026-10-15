import type { Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { SECTORS, sectorGateKey } from "./catalog.js";
import { HttpError, badRequest, forbidden } from "../lib/util.js";

/**
 * Release-readiness register. The software cannot supply merchant accounts, accredited providers, legal review, brand ownership or market
 * evidence — but it can refuse to call a gate done until someone has named an owner, submitted the evidence, and a different person with
 * authority has accepted it for a stated period. Acceptance expires, so stale evidence shows as due for review rather than as green forever.
 */
export interface GateSeed { key: string; area: string; title: string; evidence: string; blocking?: boolean }
export const GATES: GateSeed[] = [
  { key: "merchant_legal_tax", area: "Commercial", title: "Merchant, legal and tax position", evidence: "Contracting identity, GST/VAT treatment, reviewed terms, privacy notice, DPA and subprocessor schedule; provider account eligibility for services, currency and foreign customers" },
  { key: "stripe_acceptance", area: "Payments", title: "Stripe acceptance cases", evidence: "Test success, failure, async success, cancel, duplicate and rotated signatures, reconciliation, full and partial refund, dispute and settlement" },
  { key: "razorpay_acceptance", area: "Payments", title: "Razorpay acceptance cases", evidence: "Correct AED or reviewed INR link, wallet and card eligibility, repeated link creation after timeout, signed retry event, refund and dispute mapping, settlement" },
  { key: "google_pay", area: "Payments", title: "Google Pay checkout", evidence: "Actual supported merchant, device and currency checkout, or the recorded fallback when unavailable", blocking: false },
  { key: "routing_domains", area: "Infrastructure", title: "Routing and domains", evidence: "Wildcard proxy or tunnel, branded HTTPS, interrupted provisioning resume, custom hostname TXT and certificate, removal and reassignment on the real zone" },
  { key: "storage_scanner", area: "Infrastructure", title: "Storage and malware scanning", evidence: "Private bucket, anonymous access denied, malware rejection, scanner outage behaviour, integrity-checked authorised download" },
  { key: "redis_email", area: "Infrastructure", title: "Shared rate limits and email", evidence: "Multiple replicas share limits, outage behaviour, approved sender, delivered invitations and replies, ambiguous SMTP attempt reviewed before retry" },
  { key: "database_recovery", area: "Infrastructure", title: "Database failover and recovery", evidence: "Pooled and direct TLS, migrations, connection loss, point-in-time restore into an isolated database and object store, measured RPO and RTO" },
  { key: "monitoring_alerts", area: "Operations", title: "Monitoring and alert delivery", evidence: "Each web and worker replica scraped; queue, dead-letter and provisioning alerts delivered, acknowledged and recovered; named incident owner" },
  { key: "accounting_acceptance", area: "Finance", title: "Accounting system acceptance", evidence: "Customer-approved Zoho organisation, tax and currency maps, timeout reconciliation, totals, draft approval, credit-note and receipt handling in the system of record" },
  { key: "onboarding_acceptance", area: "Operations", title: "Onboarding service acceptance", evidence: "Agreed scope, appointment evidence, independent customer acceptance, source mapping, validation, cutover and fallback" },
  { key: "commercial_scope", area: "Commercial", title: "Pricing, allowances and support hours", evidence: "Approved pricing and allowances, staffing and support hours, retention and erasure procedures, design partners" },
  { key: "sector_release", area: "Operations", title: "Specialist sector releases", evidence: "Qualified review, representative live cases, incident and hold disposition, fee reconciliation and support ownership per sector pack" },
  { key: "einvoice_provider", area: "UAE", title: "Accredited e-invoicing provider", evidence: "Provider accreditation, its adapter installed and accepted, official specification validation of generated payloads, acceptance of real documents" },
  { key: "mirsal_access", area: "UAE", title: "Customs system (Mirsal) access", evidence: "Authorised access, integration scope and acceptance with the customs authority" },
  { key: "arabic_review", area: "UAE", title: "Arabic content review", evidence: "Native-speaker review of the interface dictionary; qualified review of legal and tax wording" },
  { key: "whatsapp_telephony", area: "Communications", title: "WhatsApp and telephony providers", evidence: "Meta business verification and number, Twilio account and numbers, approved templates, consent policy, tested signed webhooks" },
  { key: "brand_master", area: "Brand", title: "Approved vector brand master", evidence: "Approved vector master of the logo and mark, usage rules, and replacement of raster-only brand files" },
  { key: "domain_ownership", area: "Brand", title: "Domain ownership", evidence: "Registrar record showing the legal entity as registrant, DNS control, renewal owner and registrar lock" },
  { key: "market_evidence", area: "Business", title: "Market and go-to-market evidence", evidence: "Verified customer interviews or pilots, target segments, pricing tests, channel plan with sources" },
  { key: "unit_economics", area: "Business", title: "Unit economics", evidence: "Measured acquisition cost, conversion, retention, support cost and gross margin from real customers, with the calculation method" },
  { key: "support_coverage", area: "Governance", title: "Support coverage and escalation owners", evidence: "Named coverage hours, first-line and escalation owners, tested on-call contact path" },
  { key: "governance_owners", area: "Governance", title: "Security, privacy and change governance owners", evidence: "Named owners for security incidents, privacy requests, change approval and vendor review, with a review calendar" },
  ...SECTORS.map((x): GateSeed => ({ key: sectorGateKey(x.slug), area: "Sector release", title: `${x.name} release`, blocking: true,
    evidence: `${x.specialist ? "Qualified subject-matter review of the workflow and controls; " : ""}representative live cases run end to end, incident and hold disposition, fee and accounting reconciliation, and a named support owner for ${x.name}` })),
];

export type Staff = { userId: string; role: string };
const WRITERS = ["commercial_admin", "engineer", "support"], DECIDERS = ["commercial_admin", "auditor"];

export async function seedGates(db: Db) {
  await db.system(async (c) => { for (const g of GATES) await c.query(`INSERT INTO release_gates(key,area,title,evidence_required,blocking) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO UPDATE SET area=$2, title=$3, evidence_required=$4, blocking=$5`, [g.key, g.area, g.title, g.evidence, g.blocking ?? true]); });
}
const today = () => new Date().toISOString().slice(0, 10);

async function transition(db: Db, s: Staff, key: string, action: string, apply: (gate: any, c: any) => Promise<{ to: string; set: string; vals: any[]; note?: string }>) {
  return db.system(async (c) => {
    const g = (await c.query<any>(`SELECT * FROM release_gates WHERE key=$1 FOR UPDATE`, [key])).rows[0];
    if (!g) throw new HttpError(404, "Unknown gate");
    const r = await apply(g, c);
    await c.query(`UPDATE release_gates SET ${r.set}, status=$${r.vals.length + 2}, updated_at=now() WHERE key=$1`, [key, ...r.vals, r.to]);
    await c.query(`INSERT INTO release_gate_events(gate_key,actor_id,action,from_status,to_status,note) VALUES ($1,$2,$3,$4,$5,$6)`, [key, s.userId, action, g.status, r.to, r.note ?? null]);
    await audit(c, null, { kind: "platform_staff", userId: s.userId }, `readiness.${action}`, "release_gate", undefined, { key, from: g.status, to: r.to });
  });
}
const need = (cond: boolean, msg: string) => { if (!cond) throw badRequest(msg); };
const text = (v: unknown, label: string, max = 2000) => { const t = String(v ?? "").trim(); need(t.length > 0, `${label} is required.`); return t.slice(0, max); };

export async function assignOwner(db: Db, s: Staff, key: string, ownerName: string, ownerUserId?: string) {
  if (!WRITERS.includes(s.role)) throw forbidden("Your staff role cannot assign gate owners.");
  return transition(db, s, key, "owner_assigned", async (g) => {
    need(g.status !== "accepted", "Reopen an accepted gate before changing its owner.");
    return { to: g.status === "not_started" ? "in_progress" : g.status, set: "owner_name=$2, owner_user_id=$3", vals: [text(ownerName, "Owner", 120), ownerUserId || null], note: ownerName };
  });
}
export async function submitEvidence(db: Db, s: Staff, key: string, note: string, ref?: string) {
  if (!WRITERS.includes(s.role)) throw forbidden("Your staff role cannot submit gate evidence.");
  return transition(db, s, key, "evidence_submitted", async (g) => {
    need(!!g.owner_name, "Name an owner before submitting evidence.");
    need(!["accepted", "waived"].includes(g.status), "This gate is already decided. Reopen it to submit new evidence.");
    return { to: "evidence_submitted", set: "evidence_note=$2, evidence_ref=$3, submitted_by=$4, submitted_at=now()", vals: [text(note, "Evidence summary"), ref ? String(ref).slice(0, 500) : null, s.userId] };
  });
}
export async function accept(db: Db, s: Staff, key: string, note: string, validUntil: string) {
  if (!DECIDERS.includes(s.role)) throw forbidden("Gates are accepted by a commercial administrator or an auditor.");
  return transition(db, s, key, "accepted", async (g) => {
    need(g.status === "evidence_submitted", "Evidence must be submitted before acceptance.");
    need(g.submitted_by !== s.userId, "Evidence is accepted by someone other than the person who submitted it.");
    need(/^\d{4}-\d{2}-\d{2}$/.test(validUntil) && validUntil > today() && validUntil <= new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10), "Choose a review date within the next 400 days.");
    return { to: "accepted", set: "decided_by=$2, decided_at=now(), decision_note=$3, valid_until=$4", vals: [s.userId, text(note, "Acceptance note"), validUntil], note };
  });
}
export async function waive(db: Db, s: Staff, key: string, reason: string, validUntil: string) {
  if (!DECIDERS.includes(s.role)) throw forbidden("Gates are waived by a commercial administrator or an auditor.");
  return transition(db, s, key, "waived", async (g) => {
    need(g.status !== "accepted", "An accepted gate does not need a waiver.");
    need(/^\d{4}-\d{2}-\d{2}$/.test(validUntil) && validUntil > today() && validUntil <= new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10), "A waiver lasts at most 200 days.");
    return { to: "waived", set: "decided_by=$2, decided_at=now(), decision_note=$3, valid_until=$4", vals: [s.userId, text(reason, "Reason for the waiver"), validUntil], note: reason };
  });
}
export async function reopen(db: Db, s: Staff, key: string, reason: string) {
  if (!WRITERS.includes(s.role) && !DECIDERS.includes(s.role)) throw forbidden("Your staff role cannot reopen a gate.");
  return transition(db, s, key, "reopened", async (g) => {
    need(["accepted", "waived", "evidence_submitted"].includes(g.status), "Only a decided or submitted gate can be reopened.");
    return { to: "in_progress", set: "decided_by=NULL, decided_at=NULL, decision_note=NULL, valid_until=NULL", vals: [], note: text(reason, "Reason") };
  });
}

export interface GateView { key: string; area: string; title: string; evidence_required: string; blocking: boolean; status: string; effective: "accepted" | "waived" | "due_for_review" | "evidence_submitted" | "in_progress" | "not_started"; owner_name: string | null; evidence_note: string | null; evidence_ref: string | null; valid_until: string | null; decision_note: string | null }
export async function gateViews(db: Db, asOf = today()): Promise<GateView[]> {
  const rows = (await db.query<any>(`SELECT * FROM release_gates ORDER BY area, title`)).rows;
  return rows.map((g) => ({ key: g.key, area: g.area, title: g.title, evidence_required: g.evidence_required, blocking: g.blocking, status: g.status,
    effective: ["accepted", "waived"].includes(g.status) && String(g.valid_until).slice(0, 10) < asOf ? "due_for_review" : g.status, owner_name: g.owner_name, evidence_note: g.evidence_note, evidence_ref: g.evidence_ref,
    valid_until: g.valid_until ? String(g.valid_until).slice(0, 10) : null, decision_note: g.decision_note }));
}
export async function readinessSummary(db: Db, asOf = today()) {
  const gates = await gateViews(db, asOf);
  const ok = (g: GateView) => g.effective === "accepted" || (!g.key.startsWith("sector_") && g.effective === "waived");
  const open = gates.filter((g) => !ok(g));
  return { total: gates.length, done: gates.length - open.length, open, blockers: open.filter((g) => g.blocking), ready: !open.some((g) => g.blocking), gates };
}
export async function gateHistory(db: Db, key: string) {
  return (await db.query<any>(`SELECT e.*, u.name AS actor FROM release_gate_events e JOIN users u ON u.id=e.actor_id WHERE e.gate_key=$1 ORDER BY e.id DESC LIMIT 50`, [key])).rows;
}

/** Slugs of sectors whose own gate is accepted and still in date. A waiver is not evidence, so it never releases a sector. */
export async function releasedSectors(db: Pick<Db, "query">, asOf = today()): Promise<Set<string>> {
  const rows = (await db.query<any>(`SELECT key FROM release_gates WHERE key LIKE 'sector\\_%' AND status='accepted' AND valid_until >= $1`, [asOf])).rows;
  const keys = new Set(rows.map((r) => String(r.key)));
  return new Set(SECTORS.filter((x) => keys.has(sectorGateKey(x.slug))).map((x) => x.slug));
}
