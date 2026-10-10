import type { Conn } from "../db/client.js";

export type Availability = "available" | "pilot" | "planned";

/**
 * Honest public status (blueprint §29): only the first complete workflow is offered; the rest are planned.
 * Flip a sector to "pilot"/"available" only after it passes its own evidence-based gate.
 */
export interface Sector {
  slug: string; name: string; family: "freight" | "storage" | "movement"; advanced: boolean;
  workflow: string; availability: Availability; specialist?: boolean;
}

export const SECTORS: Sector[] = [
  { slug: "freight-forwarding", name: "Freight forwarding", family: "freight", advanced: false, availability: "pilot",
    workflow: "Air/ocean/road jobs; import/export/cross-trade; route legs, bookings, charges and documents" },
  { slug: "customs-brokerage", name: "Customs brokerage", family: "freight", advanced: true, availability: "planned", specialist: true,
    workflow: "Declaration cases, evidence, deposits, inspections and controlled submission handover" },
  { slug: "road-transport", name: "Road transport", family: "movement", advanced: false, availability: "pilot",
    workflow: "Dispatch, trips, capacity, vehicles, drivers, subcontractors and POD" },
  { slug: "contract-warehouse-3pl", name: "Contract warehouse / 3PL", family: "storage", advanced: true, availability: "pilot",
    workflow: "Customer-owned custody stock, locations, movements and activity billing" },
  { slug: "courier-last-mile", name: "Courier / last mile", family: "movement", advanced: false, availability: "planned",
    workflow: "Parcel events, attempts, route assignment, POD and COD reconciliation" },
  { slug: "ecommerce-fulfilment", name: "E-commerce fulfilment", family: "storage", advanced: false, availability: "pilot",
    workflow: "Merchant SKUs, inbound, reservation, pick/pack/ship, returns, counts and activity billing (marketplace and carrier-label connectors are planned)" },
  { slug: "consolidation-nvocc", name: "Consolidation / NVOCC", family: "freight", advanced: true, availability: "planned",
    workflow: "Master/house relationships, container planning, allocations and destination-agent settlement" },
  { slug: "cold-chain", name: "Cold chain", family: "storage", advanced: true, availability: "planned", specialist: true,
    workflow: "Temperature events, excursions, calibration evidence and hold/release approvals" },
  { slug: "project-heavy-cargo", name: "Project / heavy cargo", family: "freight", advanced: true, availability: "planned",
    workflow: "Project budgets, equipment, permits, surveys and stage approvals" },
  { slug: "automotive-logistics", name: "Automotive logistics", family: "storage", advanced: false, availability: "planned",
    workflow: "VIN-level stock, condition inspection, yard locations and release authority" },
  { slug: "marine-agency", name: "Marine agency", family: "freight", advanced: true, availability: "planned",
    workflow: "Port-call cases, service requests, disbursement estimates and final accounts" },
  { slug: "aviation-logistics", name: "Aviation logistics", family: "freight", advanced: true, availability: "planned", specialist: true,
    workflow: "Air documents, milestones and customer/agent coordination; regulated procedures require validation" },
  { slug: "moving-relocation", name: "Moving / relocation", family: "movement", advanced: false, availability: "planned",
    workflow: "Survey, inventory, crew scheduling, packing, storage and damage claims" },
  { slug: "import-export-trading", name: "Import / export trading", family: "freight", advanced: false, availability: "planned",
    workflow: "Purchase/sales orders, landed cost, stock and trade documentation" },
  { slug: "distribution", name: "Distribution", family: "movement", advanced: false, availability: "planned",
    workflow: "Customer orders, allocations, dispatch routes, returns and collections" },
  { slug: "container-depot", name: "Container depot / yard", family: "storage", advanced: true, availability: "planned",
    workflow: "Gate events, equipment condition, dwell, repairs and release checks" },
  { slug: "dangerous-cargo", name: "Dangerous / regulated cargo", family: "movement", advanced: true, availability: "planned", specialist: true,
    workflow: "Classification evidence, trained-person approvals, restrictions and incident records" },
  { slug: "cross-border-transit", name: "Cross-border / transit", family: "freight", advanced: true, availability: "planned",
    workflow: "Border legs, permits, guarantee tracking and reconciliation of transit closure" },
];
export const sectorBySlug = (s: string) => SECTORS.find((x) => x.slug === s);

export const PRODUCTS = [
  { name: "LOAD|BY|TON Freight", blurb: "Enquiry → quote → job → supplier costs → documents → invoice → collection.", status: "pilot" as Availability },
  { name: "LOAD|BY|TON Transport", blurb: "Trips, vehicles, drivers, subcontractors, POD and trip profitability.", status: "pilot" as Availability },
  { name: "LOAD|BY|TON Warehouse", blurb: "Owner-separated stock ledger, inbound, counts and activity billing — shipped as two packs: E-commerce fulfilment (merchant orders, pick/pack/ship, returns) and Contract warehouse (owner-separated custody stock, FIFO dispatch, blind counts).", status: "pilot" as Availability },
  { name: "LOAD|BY|TON Delivery", blurb: "Parcels, attempts, proof of delivery and COD reconciliation.", status: "planned" as Availability },
  { name: "LOAD|BY|TON Customs", blurb: "Declaration cases, evidence and controlled handover to official channels.", status: "planned" as Availability },
  { name: "LOAD|BY|TON Finance", blurb: "Job costing, invoices, collections and one validated accounting bridge.", status: "pilot" as Availability },
  { name: "LOAD|BY|TON Intelligence", blurb: "Owner dashboard: margin, unbilled jobs, exposure, exceptions — with source records.", status: "pilot" as Availability },
];

export const INTEGRATIONS = [
  { name: "Accounting bridge (CSV export + external ID reconciliation)", status: "pilot" as Availability, note: "Outbox with idempotent retry. Provider selection pending (decision §32)." },
  { name: "Accredited e-invoicing service provider (UAE)", status: "planned" as Availability, note: "Adapter to be built against a verified accredited provider. LOAD|BY|TON is not an accredited provider." },
  { name: "Dubai Trade / Mirsal 2", status: "planned" as Availability, note: "Controlled document/export handover only until official access is confirmed." },
  { name: "WhatsApp Business messaging", status: "planned" as Availability, note: "Requires approved provider access and policy compliance." },
  { name: "Payment checkout", status: "pilot" as Availability, note: "Server-verified webhooks. Payment merchant pending (decision §32)." },
];

export interface PlanSeed {
  code: string; name: string; monthly: number; setup: number; contact?: boolean;
  limits: { max_users: number; max_branches: number; jobs_per_month: number; storage_mb: number; max_sectors: number; max_entities: number; trips_per_month?: number; fulfilment_orders_per_month?: number; wh_orders_per_month?: number };
}
// Pricing is a hypothesis (blueprint §06), not an approved tariff. Published versions are immutable; change = new version.
export const PLAN_SEEDS: PlanSeed[] = [
  { code: "free", name: "Free Forever", monthly: 0, setup: 0, limits: { max_users: 2, max_branches: 1, jobs_per_month: 25, storage_mb: 250, max_sectors: 1, max_entities: 1, trips_per_month: 25, fulfilment_orders_per_month: 50, wh_orders_per_month: 25 } },
  { code: "starter", name: "Starter", monthly: 14900, setup: 19900, limits: { max_users: 3, max_branches: 1, jobs_per_month: 150, storage_mb: 2048, max_sectors: 1, max_entities: 1, trips_per_month: 150, fulfilment_orders_per_month: 500, wh_orders_per_month: 150 } },
  { code: "business", name: "Business", monthly: 34900, setup: 39900, limits: { max_users: 8, max_branches: 2, jobs_per_month: 500, storage_mb: 10240, max_sectors: 1, max_entities: 1, trips_per_month: 500, fulfilment_orders_per_month: 2000, wh_orders_per_month: 500 } },
  { code: "operations", name: "Operations", monthly: 74900, setup: 79900, limits: { max_users: 15, max_branches: 3, jobs_per_month: 1500, storage_mb: 25600, max_sectors: 2, max_entities: 1, trips_per_month: 1500, fulfilment_orders_per_month: 8000, wh_orders_per_month: 1500 } },
  { code: "enterprise", name: "Enterprise", monthly: 149900, setup: 0, contact: true, limits: { max_users: 100, max_branches: 20, jobs_per_month: 20000, storage_mb: 204800, max_sectors: 18, max_entities: 5, trips_per_month: 20000, fulfilment_orders_per_month: 100000, wh_orders_per_month: 20000 } },
];

/**
 * Plan versions only ever ADD a billing unit: v1 = forwarding-era allowances; v2 adds Transport (trips/month);
 * v3 adds E-commerce fulfilment (fulfilment orders/month); v4 adds Contract warehouse (warehouse orders/month).
 * Published versions are immutable, so older subscriptions keep what they bought; for them a missing unit falls back
 * to the jobs allowance (see getLimit). New purchases use the latest version.
 */
const ADDED_BY_VERSION: Record<number, (keyof PlanSeed["limits"])[]> = { 2: ["trips_per_month"], 3: ["fulfilment_orders_per_month"], 4: ["wh_orders_per_month"] };
export async function ensureCatalog(c: Conn) {
  for (const p of PLAN_SEEDS) {
    for (const version of [1, 2, 3, 4]) {
      const later = Object.entries(ADDED_BY_VERSION).filter(([v]) => Number(v) > version).flatMap(([, keys]) => keys);
      const limits = Object.fromEntries(Object.entries(p.limits).filter(([k]) => !later.includes(k as any)));
      await c.query(
        `INSERT INTO plan_versions(plan_code, version, name, monthly_minor, setup_minor, limits, contact_sales)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (plan_code, version) DO NOTHING`,
        [p.code, version, p.name, p.monthly, p.setup, JSON.stringify(limits), !!p.contact],
      );
    }
  }
}

export interface PlanVersion {
  id: string; plan_code: string; version: number; name: string; monthly_minor: number; setup_minor: number;
  currency: string; limits: PlanSeed["limits"]; contact_sales: boolean;
}

/** Latest published version per plan, in tariff order. */
export async function currentPlans(c: Conn): Promise<PlanVersion[]> {
  const r = await c.query<PlanVersion>(
    `SELECT DISTINCT ON (plan_code) * FROM plan_versions ORDER BY plan_code, version DESC`);
  const order = PLAN_SEEDS.map((p) => p.code);
  return r.rows.sort((a, b) => order.indexOf(a.plan_code) - order.indexOf(b.plan_code));
}

/** Bundle builder: recommend a plan for chosen sectors and preview the net incremental price. */
export function recommendBundle(slugs: string[]) {
  const picked = slugs.map(sectorBySlug).filter(Boolean) as Sector[];
  if (!picked.length) return { plan: "free", reason: "Start free — pick sectors later.", compatible: true, picked };
  const families = new Set(picked.map((s) => s.family));
  const specialist = picked.filter((s) => s.specialist);
  const notes: string[] = [];
  if (specialist.length) notes.push(`${specialist.map((s) => s.name).join(", ")} need specialist review and a scoped engagement.`);
  if (picked.length === 1) {
    return { plan: picked[0].advanced ? "business" : "starter", compatible: true, picked, specialist: notes,
      reason: picked[0].advanced ? "One advanced sector fits Business." : "One standard sector fits Starter." };
  }
  if (picked.length === 2 && families.size === 1) {
    return { plan: "operations", compatible: true, picked, specialist: notes, reason: "Two compatible sectors fit Operations." };
  }
  return { plan: "enterprise", compatible: false, picked, specialist: notes,
    reason: picked.length > 2 ? "More than two sectors need a scoped Enterprise schedule." : "These sectors are in different families; a scoped Enterprise schedule is required." };
}
