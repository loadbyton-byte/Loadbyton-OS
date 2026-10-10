import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, toMinor } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { dedupeHash, must, nextNumber, optNum, optStr, reqStr } from "./common.js";

export async function createParty(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "party.write");
  await assertWritable(c, ctx.tenantId);
  const kind = ["customer", "supplier", "agent"].includes(f.kind) ? f.kind : "customer";
  const name = reqStr(f.name, "Name", 200);
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO parties(tenant_id,kind,name,email,phone,tax_id,credit_limit_minor,consent_marketing,owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ctx.tenantId, kind, name, optStr(f.email, 200), optStr(f.phone, 50), optStr(f.tax_id, 60),
        f.credit_limit ? toMinor(f.credit_limit) : 0, f.consent_marketing === "on" || f.consent_marketing === true, ctx.userId]);
    await audit(c, ctx.tenantId, actorOf(ctx), "party.created", "party", r.rows[0].id, { kind, name });
    return r.rows[0].id;
  } catch (e: any) {
    if (String(e.message).includes("parties_name_unique")) throw new HttpError(409, `A ${kind} named “${name}” already exists.`, "conflict");
    throw e;
  }
}

export const listParties = (c: Conn, kind?: string) =>
  c.query<any>(`SELECT p.*, (SELECT coalesce(sum(total_minor-paid_minor),0) FROM invoices i
     WHERE i.party_id=p.id AND i.status IN ('issued','part_paid')) AS outstanding_minor
     FROM parties p WHERE ($1::text IS NULL OR kind=$1) ORDER BY lower(name)`, [kind ?? null]).then((r) => r.rows);

export async function createEnquiry(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "enquiry.write");
  await assertWritable(c, ctx.tenantId);
  const mode = ["air", "ocean", "road"].includes(f.mode) ? f.mode : null;
  if (!mode) throw badRequest("Choose a mode: air, ocean or road.");
  const source = optStr(f.source, 40) ?? "manual";
  const external = optStr(f.external_ref, 120);
  const partyId = optStr(f.party_id, 40);
  const key = external
    ? `${source}:${external}`
    : dedupeHash([partyId, mode, f.origin, f.destination, f.cargo_desc, f.ready_date]);

  const dup = await c.query<{ id: string; no: string }>(`SELECT id,no FROM enquiries WHERE dedupe_key=$1`, [key]);
  if (dup.rows.length) return { id: dup.rows[0].id, no: dup.rows[0].no, duplicate: true };

  const missing: string[] = [];
  if (!partyId) missing.push("customer");
  if (!optStr(f.origin)) missing.push("origin");
  if (!optStr(f.destination)) missing.push("destination");
  if (!optStr(f.cargo_desc)) missing.push("cargo description");
  if (optNum(f.weight_kg) == null && optNum(f.volume_cbm) == null) missing.push("weight or volume");
  if (!optStr(f.ready_date, 10)) missing.push("cargo ready date");

  const no = await nextNumber(c, ctx.tenantId, "enquiry", "ENQ");
  const r = await c.query<{ id: string }>(
    `INSERT INTO enquiries(tenant_id,no,party_id,source,external_ref,dedupe_key,mode,trade,origin,destination,cargo_desc,pieces,
       weight_kg,volume_cbm,ready_date,incoterm,status,assigned_to,missing_info,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [ctx.tenantId, no, partyId, source, external, key, mode, ["import", "export", "cross_trade"].includes(f.trade) ? f.trade : "import",
      optStr(f.origin, 200), optStr(f.destination, 200), optStr(f.cargo_desc, 1000), optNum(f.pieces), optNum(f.weight_kg),
      optNum(f.volume_cbm), optStr(f.ready_date, 10), optStr(f.incoterm, 10), missing.length ? "new" : "qualified",
      optStr(f.assigned_to, 40) ?? ctx.userId, missing, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "enquiry.created", "enquiry", r.rows[0].id, { no, source, missing });
  return { id: r.rows[0].id, no, duplicate: false, missing };
}

export const listEnquiries = (c: Conn) =>
  c.query<any>(`SELECT e.*, p.name AS party_name FROM enquiries e LEFT JOIN parties p ON p.id=e.party_id ORDER BY e.created_at DESC`).then((r) => r.rows);

export async function loseEnquiry(c: Conn, ctx: Ctx, id: string, reason: string) {
  require(ctx, "enquiry.write");
  await must(c.query(`UPDATE enquiries SET status='lost', lost_reason=$2 WHERE id=$1 AND status IN ('new','qualified','quoted') RETURNING id`, [id, reqStr(reason, "Lost reason", 300)]), "Open enquiry");
  await audit(c, ctx.tenantId, actorOf(ctx), "enquiry.lost", "enquiry", id, { reason });
}

export async function createRate(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "rate.write");
  await assertWritable(c, ctx.tenantId);
  if (!f.valid_from || !f.valid_to || f.valid_to < f.valid_from) throw badRequest("Enter a valid date range.");
  const basis = ["per_kg", "per_cbm", "per_shipment", "per_container"].includes(f.basis) ? f.basis : null;
  if (!basis) throw badRequest("Choose a charge basis.");
  const r = await c.query<{ id: string }>(
    `INSERT INTO rates(tenant_id,supplier_id,mode,origin,destination,charge_name,basis,unit_cost_minor,minimum_minor,currency,valid_from,valid_to,exclusions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'AED',$10,$11,$12) RETURNING id`,
    [ctx.tenantId, optStr(f.supplier_id, 40), reqStr(f.mode, "Mode", 20), reqStr(f.origin, "Origin", 200), reqStr(f.destination, "Destination", 200),
      reqStr(f.charge_name, "Charge", 200), basis, toMinor(f.unit_cost), f.minimum ? toMinor(f.minimum) : 0, f.valid_from, f.valid_to, optStr(f.exclusions, 500)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "rate.created", "rate", r.rows[0].id);
  return r.rows[0].id;
}

export const listRates = (c: Conn) =>
  c.query<any>(`SELECT r.*, p.name AS supplier_name, (r.valid_to < current_date) AS expired
    FROM rates r LEFT JOIN parties p ON p.id=r.supplier_id ORDER BY r.valid_to DESC`).then((r) => r.rows);
