import { PLAN_SEEDS, sectorBySlug } from "./catalog.js";

/**
 * What a client can ask for on top of a sector pack.
 *  - free: part of the customisation we do at no charge (one sector pack, customised to the client's brand and wording).
 *  - paid: an add-on we build, hand over and keep supported. It needs a monthly plan, and the plan is the cheapest one that covers every paid
 *    add-on chosen (`minPlan`). Prices are the planning prices in the plan catalogue, not an approved tariff.
 * `status` is the same honest label the sector packs carry: nothing here is "available" until its provider/acceptance evidence exists.
 */
export type FeatureTier = "free" | "paid";
export type PaidPlan = "starter" | "business" | "operations";
export interface Feature {
  code: string; name: string; blurb: string; tier: FeatureTier;
  /** paid only: the smallest monthly plan that includes it */
  minPlan?: PaidPlan;
  status: "included" | "pilot";
  /** undefined = every sector */
  sectors?: string[];
  /** what the client brings so we can build it */
  youProvide?: string;
  /** staff switched it off: not offered to new requests (existing requests keep it) */
  disabled?: boolean;
}

export const FEATURES: Feature[] = [
  // ── free: the customisation every free build includes
  { code: "brand-documents", tier: "free", status: "included", name: "Your brand on every document", blurb: "Your logo, colours and footer on quotes, invoices, delivery notes and labels.", youProvide: "Logo and brand colours (your brand kit)" },
  { code: "field-labels", tier: "free", status: "included", name: "Your words on screen", blurb: "Rename fields, statuses and stages to the terms your team already uses, and hide what you don't need.", youProvide: "A list of the terms you use" },
  { code: "document-layouts", tier: "free", status: "included", name: "Your document layouts", blurb: "Quote, invoice and delivery-note layouts matched to a sample you send us.", youProvide: "A sample document with the private numbers blanked out" },
  { code: "team-roles", tier: "free", status: "included", name: "Roles for your team", blurb: "Owner, finance, dispatcher and other roles set up so you only have to invite your people.", youProvide: "Who does what in your team" },
  { code: "bilingual", tier: "free", status: "included", name: "Arabic and English", blurb: "A right-to-left Arabic layer and bilingual invoices.", youProvide: "Your preferred Arabic wording, if it differs" },
  { code: "csv-import", tier: "free", status: "included", name: "Bring your customer and supplier lists", blurb: "Your existing customers and suppliers loaded from a spreadsheet, with a template that matches your columns.", youProvide: "A spreadsheet (no bank or tax numbers needed)" },
  { code: "handoff-guide", tier: "free", status: "included", name: "Hand-off guide for your private details", blurb: "A written walkthrough of where to enter your tax registration number, licences and bank details yourself, in your own admin panel.", youProvide: "Nothing. You enter the private details yourself." },

  // ── paid: monthly add-ons
  { code: "accounting-bridge", tier: "paid", minPlan: "starter", status: "pilot", name: "Zoho Books invoice bridge", blurb: "Invoices raised in your system are sent to Zoho Books as drafts, with retries and a reconciliation view. CSV export is free.", youProvide: "Your Zoho organisation (you connect it yourself)" },
  { code: "ai-drafts", tier: "paid", minPlan: "starter", status: "pilot", sectors: ["freight-forwarding"], name: "Assistant drafts for enquiries", blurb: "Reviewed draft replies and quote notes from your own enquiries. A person always approves before anything is sent.", youProvide: "Examples of replies you like" },
  { code: "priority-support", tier: "paid", minPlan: "starter", status: "included", name: "Priority queue for changes and questions", blurb: "Your questions and change requests are worked ahead of the free queue, through the same message thread.", youProvide: "Nothing" },
  { code: "einvoice", tier: "paid", minPlan: "business", status: "pilot", name: "E-invoicing readiness", blurb: "Invoices produced in the UBL format and sent through the accredited provider you choose. We are not an accredited provider.", youProvide: "Your provider account (you enter its credentials yourself)" },
  { code: "merchant-api", tier: "paid", minPlan: "business", status: "pilot", sectors: ["courier-last-mile", "ecommerce-fulfilment", "contract-warehouse-3pl"], name: "Merchant API and signed webhooks", blurb: "Scoped API keys and signed, retried webhooks so your merchants' systems can create orders and receive status.", youProvide: "Which events your merchants need" },
  { code: "storefront-connectors", tier: "paid", minPlan: "business", status: "pilot", sectors: ["ecommerce-fulfilment", "courier-last-mile", "distribution"], name: "Shopify and WooCommerce order pull", blurb: "Orders pulled from your merchants' stores into your system on a schedule.", youProvide: "Store access that each merchant grants themselves" },
  { code: "carrier-labels", tier: "paid", minPlan: "business", status: "pilot", sectors: ["ecommerce-fulfilment", "courier-last-mile"], name: "Carrier tracking and shipping labels", blurb: "Carrier tracking events on your orders and domestic labels from the carrier you use.", youProvide: "Your carrier account (you enter its credentials yourself)" },
  { code: "delivery-notices", tier: "paid", minPlan: "business", status: "pilot", sectors: ["courier-last-mile", "ecommerce-fulfilment", "distribution"], name: "Delivery notices by SMS", blurb: "Recipients are told when a parcel is out for delivery. WhatsApp needs approved provider access and is added only when you have it.", youProvide: "Your message wording and sender name" },
  { code: "rf-terminal", tier: "paid", minPlan: "business", status: "pilot", sectors: ["contract-warehouse-3pl", "ecommerce-fulfilment"], name: "Handheld terminal and label printing", blurb: "A plain-text handheld screen for receiving, picking and counting, and label printing from your warehouse.", youProvide: "Your scanner and printer models" },
  { code: "live-routing", tier: "paid", minPlan: "operations", status: "pilot", sectors: ["road-transport", "distribution", "courier-last-mile", "moving-relocation", "cross-border-transit"], name: "Traffic-aware routing and live trips", blurb: "Drive-time estimates that use live traffic and a live view of trips on the road.", youProvide: "Your routing-provider key (you enter it yourself)" },
  { code: "device-feeds", tier: "paid", minPlan: "operations", status: "pilot", sectors: ["cold-chain", "automotive-logistics", "aviation-logistics", "distribution", "moving-relocation"], name: "Logger and telematics feeds", blurb: "Temperature loggers and vehicle devices post readings into your records, with excursion alerts and a certificate register.", youProvide: "Your device make and how it reports" },
  { code: "extra-sector", tier: "paid", minPlan: "operations", status: "pilot", name: "A second sector pack", blurb: "Run two sector packs side by side in one system, sharing customers, documents and invoices.", youProvide: "Which second sector, and how the two relate" },
];

export const featureByCode = (code: string) => FEATURES.find((f) => f.code === code);

const DEFAULT_PLAN = new Map(FEATURES.map((f) => [f.code, f.minPlan]));
/** Apply staff overrides (feature_settings rows) to the catalogue. Features without a row go back to their built-in default. */
export function applyFeatureSettings(rows: { code: string; enabled: boolean; min_plan: PaidPlan | null }[]) {
  const by = new Map(rows.map((r) => [r.code, r]));
  for (const f of FEATURES) {
    const r = by.get(f.code);
    f.disabled = r ? !r.enabled : false;
    if (f.tier === "paid") f.minPlan = r?.min_plan ?? DEFAULT_PLAN.get(f.code);
  }
}

/** Everything a client with these sectors may ask for: all free features, plus the paid ones that apply to at least one of their sectors. */
export function featuresForSectors(slugs: string[]): Feature[] {
  const mine = new Set(slugs);
  return FEATURES.filter((f) => !f.disabled && (!f.sectors || !mine.size || f.sectors.some((s) => mine.has(s))));
}

const ORDER: PaidPlan[] = ["starter", "business", "operations"];
export interface PlanNeed { plan: PaidPlan; name: string; monthlyMinor: number; setupMinor: number }
const planInfo = (code: PaidPlan): PlanNeed => {
  const p = PLAN_SEEDS.find((x) => x.code === code)!;
  return { plan: code, name: p.name, monthlyMinor: p.monthly, setupMinor: p.setup };
};
export const paidPlans = (): PlanNeed[] => ORDER.map(planInfo);

/** The cheapest monthly plan that includes every paid add-on chosen, or null when none of them is paid. */
export function planForFeatures(codes: string[]): PlanNeed | null {
  const paid = codes.map(featureByCode).filter((f): f is Feature => !!f && f.tier === "paid");
  if (!paid.length) return null;
  return planInfo(paid.map((f) => f.minPlan!).sort((a, b) => ORDER.indexOf(b) - ORDER.indexOf(a))[0]);
}

export interface FeatureChoice { sectors: string[]; features: string[]; category: "free" | "paid"; plan: PlanNeed | null }
/** Validates a selection against the sectors it is for. Free-only selections stay free; one paid add-on makes the request paid. */
export function checkFeatureChoice(sectors: string[], codes: string[], fail: (m: string) => Error): FeatureChoice {
  const secs = [...new Set(sectors.filter((s) => sectorBySlug(s)))];
  if (!secs.length) throw fail("Choose the sector these features are for.");
  const features = [...new Set(codes)];
  if (!features.length) throw fail("Pick at least one feature.");
  const ok = new Set(featuresForSectors(secs).map((f) => f.code));
  for (const c of features) {
    if (!featureByCode(c)) throw fail("One of those features no longer exists. Refresh the page and choose again.");
    if (!ok.has(c)) throw fail(`${featureByCode(c)!.name} doesn't apply to your sector.`);
  }
  const plan = planForFeatures(features);
  const category = plan ? "paid" : "free";
  if (category === "free" && secs.length > 1) throw fail("Free features cover one sector. Choose Paid to combine sectors.");
  return { sectors: secs, features, category, plan };
}
