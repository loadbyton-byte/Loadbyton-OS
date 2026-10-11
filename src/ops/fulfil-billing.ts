import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { TAX_CODES, badRequest, toMinor } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must } from "./common.js";
import { issueInvoice } from "./finance.js";

/** Activity-billing codes. The rate card is per merchant; a missing or zero rate simply produces no charge. */
export const RATE_CODES = {
  receive_unit: "Receiving, per unit",
  pick_order: "Pick & handle, per order",
  pick_unit: "Pick, per unit",
  pack_order: "Pack & dispatch, per order",
  return_unit: "Returns handling, per unit",
  storage_location_month: "Storage, per occupied location per month",
  storage_location_day: "Storage, per closing occupied location per Dubai day",
  storage_pallet_day: "Storage, per closing occupied pallet position per Dubai day",
  storage_cbm_day: "Storage, per closing stock cubic metre per Dubai day",
  storage_location_peak_day: "Storage, per peak occupied location per Dubai day",
  storage_pallet_peak_day: "Storage, per peak occupied pallet position per Dubai day",
  storage_cbm_peak_day: "Storage, per peak stock cubic metre per Dubai day",
} as const;
export type RateCode = keyof typeof RATE_CODES;

export interface ChargeInput { partyId: string; code: RateCode; qty: number; sourceKey: string; orderId?: string | null; detail?: string }

/**
 * Create a charge from an operational event at the rate in force now. `source_key` is unique per tenant, so a retried
 * or replayed event can never bill twice; a later rate change never rewrites a charge that already exists.
 */
export async function charge(c: Conn, ctx: Ctx, x: ChargeInput): Promise<string | null> {
  if (x.qty <= 0) return null;
  const rate = (await c.query<any>(`SELECT unit_minor, tax_code FROM fulfil_rates WHERE party_id=$1 AND code=$2`, [x.partyId, x.code])).rows[0];
  if (!rate || Number(rate.unit_minor) <= 0) return null;
  const r = await c.query<{ id: string }>(
    `INSERT INTO fulfil_charges(tenant_id,party_id,code,description,qty,unit_minor,tax_code,source_key,order_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, source_key) DO NOTHING RETURNING id`,
    [ctx.tenantId, x.partyId, x.code, RATE_CODES[x.code] + (x.detail ? ` — ${x.detail}` : ""), x.qty, rate.unit_minor, rate.tax_code, x.sourceKey, x.orderId ?? null]);
  return r.rows[0]?.id ?? null;
}

export async function setRate(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.rates");
  await assertWritable(c, ctx.tenantId);
  const code = String(f.code) as RateCode;
  if (!(code in RATE_CODES)) throw badRequest("Choose a rate type.");
  if(code.endsWith('_day'))throw badRequest('Daily storage requires an issued, reviewed contract in Daily storage.');
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.party_id]), "Merchant");
  const amount = toMinor(f.amount || "0");
  const tax = TAX_CODES[f.tax_code] ? f.tax_code : "SR5";
  await c.query(
    `INSERT INTO fulfil_rates(tenant_id,party_id,code,unit_minor,tax_code) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id,party_id,code) DO UPDATE SET unit_minor=$4, tax_code=$5, updated_at=now()`,
    [ctx.tenantId, f.party_id, code, amount, tax]);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil.rate_set", "party", f.party_id, { code, amount });
}

export const listRates = (c: Conn) => c.query<any>(
  `SELECT r.*, p.name AS party_name FROM fulfil_rates r JOIN parties p ON p.id=r.party_id ORDER BY p.name, r.code`).then((r) => r.rows);

/** Unbilled activity per merchant, with the lines that would appear on the invoice. */
export async function billingSummary(c: Conn) {
  const rows = (await c.query<any>(
    `SELECT ch.party_id, p.name AS party_name, ch.code, ch.tax_code, ch.unit_minor, sum(ch.qty)::float8 AS qty, count(*)::int AS events
     FROM fulfil_charges ch JOIN parties p ON p.id=ch.party_id WHERE ch.invoice_id IS NULL
     GROUP BY ch.party_id, p.name, ch.code, ch.tax_code, ch.unit_minor ORDER BY p.name, ch.code`)).rows;
  const byParty = new Map<string, { party_id: string; party_name: string; total: number; lines: any[] }>();
  for (const r of rows) {
    const e: { party_id: string; party_name: string; total: number; lines: any[] } = byParty.get(r.party_id) ?? { party_id: r.party_id, party_name: r.party_name, total: 0, lines: [] };
    e.lines.push({ ...r, net: Number(r.qty) * Number(r.unit_minor) });
    e.total += Number(r.qty) * Number(r.unit_minor);
    byParty.set(r.party_id, e);
  }
  return [...byParty.values()];
}

/** One invoice per merchant per run: unbilled charges are grouped by (type, rate, tax code) so thousands of orders stay readable. */
export async function invoiceMerchant(c: Conn, ctx: Ctx, partyId: string, termsDays = 30) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1`, [partyId]), "Merchant");
  const charges = (await c.query<any>(`SELECT * FROM fulfil_charges WHERE party_id=$1 AND invoice_id IS NULL FOR UPDATE`, [partyId])).rows;
  if (!charges.length) throw badRequest("No uninvoiced fulfilment activity for this merchant.");
  const groups = new Map<string, { code: string; unit: number; tax: string; qty: number; ids: string[] }>();
  for (const ch of charges) {
    const k = `${ch.code}|${ch.unit_minor}|${ch.tax_code}`;
    const g: { code: string; unit: number; tax: string; qty: number; ids: string[] } = groups.get(k) ?? { code: ch.code, unit: Number(ch.unit_minor), tax: ch.tax_code, qty: 0, ids: [] };
    g.qty += Number(ch.qty); g.ids.push(ch.id); groups.set(k, g);
  }
  const list = [...groups.values()];
  const ent = (await c.query<any>(`SELECT id,currency FROM entities ORDER BY created_at,id LIMIT 1`)).rows[0];
  if(ent.currency!=='AED'||charges.some(ch=>ch.entity_id&&ch.entity_id!==ent.id))throw badRequest('These AED fulfilment charges must be invoiced by their agreed AED billing entity.');
  const r = await issueInvoice(c, ctx, {
    entityId: ent.id, partyId,
    lines: list.map((g, i) => ({ id: String(i), description: RATE_CODES[g.code as RateCode] ?? g.code, qty: g.qty, unit_minor: g.unit, tax_code: g.tax })),
    markCharge: async (idx, invoiceId) => { await c.query(`UPDATE fulfil_charges SET invoice_id=$2 WHERE id = ANY($1::uuid[])`, [list[Number(idx)].ids, invoiceId]); },
  }, termsDays);
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil.invoiced", "invoice", r.id, { party: partyId, charges: charges.length });
  return r;
}

/**
 * Monthly storage charge. This is a SNAPSHOT of the locations that hold the merchant's stock when it is run — a daily
 * accrual of pallet/cbm occupancy is not built. Idempotent per (merchant, month).
 */
export async function runStorageCharges(c: Conn, ctx: Ctx, month: string) {
  require(ctx, "wh.rates");
  await assertWritable(c, ctx.tenantId);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("Choose a month.");
  if (month > new Date().toISOString().slice(0, 7)) throw badRequest("A future month cannot be billed yet.");
  const occ = (await c.query<any>(
    `SELECT s.party_id, count(DISTINCT l.location_id)::int n FROM stock_levels l JOIN skus s ON s.id=l.sku_id JOIN wh_locations loc ON loc.id=l.location_id
     WHERE l.on_hand > 0 AND loc.kind IN ('bin','receiving','quarantine') GROUP BY s.party_id`)).rows;
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`${ctx.tenantId}:stock`]);
  let created = 0, already = 0, noRate = 0, dailyContracts = 0;
  for (const o of occ) {
    if((await c.query(`SELECT 1 FROM fulfil_storage_contracts WHERE party_id=$1 AND valid_from<(($2||'-01')::date+interval '1 month') AND valid_until>=($2||'-01')::date`,[o.party_id,month])).rows.length){dailyContracts++;continue;}
    const id = await charge(c, ctx, { partyId: o.party_id, code: "storage_location_month", qty: o.n, sourceKey: `storage:${o.party_id}:${month}`, detail: `${month} · ${o.n} location(s) occupied at run time` });
    if (id) created++;
    else {
      const have = await c.query(`SELECT 1 FROM fulfil_charges WHERE source_key=$1`, [`storage:${o.party_id}:${month}`]);
      if (have.rows.length) already++; else noRate++;
    }
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "fulfil.storage_run", "tenant", ctx.tenantId, { month, created, already, noRate });
  return { created, already, noRate, dailyContracts };
}

export const unbilledForParty = (c: Conn, partyId?: string | null) => c.query<any>(
  `SELECT ch.*, ch.qty::float8 AS qty, o.no AS order_no FROM fulfil_charges ch LEFT JOIN fulfil_orders o ON o.id=ch.order_id
   WHERE ch.invoice_id IS NULL AND ($1::uuid IS NULL OR ch.party_id=$1) ORDER BY ch.created_at DESC LIMIT 200`, [partyId ?? null]).then((r) => r.rows);
