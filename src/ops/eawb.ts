import crypto from "node:crypto";
import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";
import { validateAwb } from "./freight-commercial.js";

/**
 * Air waybill numbers from the agent's own stock, and a Cargo-IMP FWB message built from a job. The message follows the common FWB layout (identification, routing, parties, charge declarations,
 * rate description, nature of goods). It has not been checked against any airline's or handler's validator: have the receiving party check the first message before relying on the format.
 * Nothing here sends a message. Sending needs the airline's or handler's own agreement and channel; a person hands the file over and records that they did.
 */
const clean = (v: unknown, max: number) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9 .,'()\-/&]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const iata = (v: unknown, what: string) => { const s = String(v ?? "").trim().toUpperCase(); if (!/^[A-Z]{3}$/.test(s)) throw badRequest(`${what} is a 3-letter airport code.`); return s; };
const num = (v: unknown, what: string, max: number) => { const n = Number(v); if (!(n > 0 && n <= max)) throw badRequest(`${what} must be above 0 and at most ${max}.`); return n; };
export const checkDigit = (serial: number) => serial % 7;

export async function addAwbStock(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "job.write");
  await assertWritable(c, ctx.tenantId);
  const prefix = String(f.prefix ?? "").trim(), first = Number(f.first_serial), last = Number(f.last_serial);
  if (!/^\d{3}$/.test(prefix)) throw badRequest("The airline prefix is 3 digits.");
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last > 9999999) throw badRequest("Give the first and last serial (7-digit serials, last not before first).");
  const overlap = await c.query(`SELECT 1 FROM awb_stock WHERE prefix=$1 AND NOT (last_serial < $2 OR first_serial > $3)`, [prefix, first, last]);
  if (overlap.rows.length) throw badRequest("That range overlaps stock you already hold for this airline.");
  const id = (await c.query<any>(`INSERT INTO awb_stock(tenant_id,prefix,airline,first_serial,last_serial,next_serial,created_by) VALUES ($1,$2,$3,$4,$5,$4,$6) RETURNING id`, [ctx.tenantId, prefix, reqStr(f.airline, "Airline", 80), first, last, ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "awb_stock.added", "awb_stock", id, { prefix, first, last });
  return id as string;
}
/** The next unused number from a stock range, with its check digit. */
export async function allocateAwb(c: Conn, ctx: Ctx, stockId: string): Promise<string> {
  require(ctx, "job.write");
  const s = await must(c.query<any>(`SELECT * FROM awb_stock WHERE id=$1 FOR UPDATE`, [recordId(stockId, "Stock")]), "Stock");
  if (s.next_serial > s.last_serial) throw badRequest("This range is used up.");
  await c.query(`UPDATE awb_stock SET next_serial=next_serial+1 WHERE id=$1`, [s.id]);
  const serial = String(s.next_serial).padStart(7, "0");
  return validateAwb(`${s.prefix}${serial}${checkDigit(s.next_serial)}`);
}

export interface Party { name: string; street: string; place: string; country: string; postcode?: string }
export interface FwbInput {
  awb: string; origin: string; destination: string; pieces: number; weightKg: number; volumeCbm?: number; flight?: { carrier: string; number: string; day: string };
  shipper: Party; consignee: Party; currency: string; chargesPrepaid: boolean; goods: string; rate?: { amount: number; chargeable: number };
}
const party = (tag: string, p: Party) => [tag, `/${clean(p.name, 35)}`, `/${clean(p.street, 35)}`, `/${clean(p.place, 17)}`, `/${clean(p.country, 2)}${p.postcode ? `/${clean(p.postcode, 9)}` : ""}`];
/** Build a Cargo-IMP FWB/16 message. Pure: same input, same text. */
export function buildFwb(i: FwbInput): string {
  const awb = validateAwb(i.awb), origin = iata(i.origin, "Origin"), dest = iata(i.destination, "Destination");
  const pcs = Math.floor(num(i.pieces, "Pieces", 99999)), kg = num(i.weightKg, "Weight", 999999);
  if (origin === dest) throw badRequest("Origin and destination are the same.");
  for (const [tag, p] of [["Shipper", i.shipper], ["Consignee", i.consignee]] as const) if (!p?.name || !p.street || !p.place || !/^[A-Za-z]{2}$/.test(p.country ?? "")) throw badRequest(`${tag} needs a name, street, place and 2-letter country.`);
  if (!/^[A-Z]{3}$/.test(i.currency)) throw badRequest("The currency is a 3-letter code.");
  const w = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
  const lines = [
    "FWB/16",
    `${awb}${origin}${dest}/T${pcs}K${w(kg)}${i.volumeCbm ? `MC${(Math.round(num(i.volumeCbm, "Volume", 99999) * 100) / 100).toFixed(2)}` : ""}`,
  ];
  if (i.flight) lines.push(`FLT/${clean(i.flight.carrier, 2)}${clean(i.flight.number, 4)}/${clean(i.flight.day, 2)}`);
  lines.push(`RTG/${dest}${i.flight ? clean(i.flight.carrier, 2) : ""}`, ...party("SHP", i.shipper), ...party("CNE", i.consignee),
    `CVD/${i.currency}//${i.chargesPrepaid ? "PP" : "CC"}/NVD/NCV/XXX`);
  lines.push(`RTD/1/P${pcs}/K${w(kg)}${i.rate ? `/CQ/W${w(i.rate.chargeable)}/R${i.rate.amount.toFixed(2)}/T${(i.rate.chargeable * i.rate.amount).toFixed(2)}` : ""}`, `/NG/${clean(i.goods, 20)}`);
  return lines.join("\n");
}

export async function issueFwb(c: Conn, ctx: Ctx, jobId: string, f: Record<string, any>) {
  require(ctx, "doc.write");
  await assertWritable(c, ctx.tenantId);
  const job = await must(c.query<any>(`SELECT id, no, mode FROM jobs WHERE id=$1`, [recordId(jobId, "Job")]), "Job");
  if (!/air/i.test(job.mode)) throw badRequest("Air waybills are for air jobs.");
  const p = (k: string): Party => ({ name: String(f[`${k}_name`] ?? ""), street: String(f[`${k}_street`] ?? ""), place: String(f[`${k}_place`] ?? ""), country: String(f[`${k}_country`] ?? ""), postcode: String(f[`${k}_postcode`] ?? "") || undefined });
  const awb = f.stock_id ? await allocateAwb(c, ctx, String(f.stock_id)) : validateAwb(String(f.awb ?? ""));
  const body = buildFwb({ awb, origin: f.origin, destination: f.destination, pieces: f.pieces, weightKg: f.weight_kg, volumeCbm: f.volume_cbm ? Number(f.volume_cbm) : undefined,
    flight: f.flight_carrier ? { carrier: String(f.flight_carrier), number: String(f.flight_number ?? ""), day: String(f.flight_day ?? "") } : undefined, shipper: p("shipper"), consignee: p("consignee"),
    currency: String(f.currency ?? "AED").toUpperCase(), chargesPrepaid: f.charges !== "collect", goods: String(f.goods ?? "GENERAL CARGO"), rate: f.rate_amount ? { amount: num(f.rate_amount, "Rate", 1e7), chargeable: num(f.chargeable_kg ?? f.weight_kg, "Chargeable weight", 999999) } : undefined });
  const r = await c.query<any>(`INSERT INTO eawb_messages(tenant_id,job_id,awb_no,body,body_sha256,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, job.id, awb, body, crypto.createHash("sha256").update(body).digest("hex"), ctx.userId]).catch((e) => { if (/unique/i.test(String(e.message))) throw badRequest("A message for that air waybill already exists. Void it first to issue a new one."); throw e; });
  await audit(c, ctx.tenantId, actorOf(ctx), "eawb.issued", "job", job.id, { awb });
  return { id: r.rows[0].id as string, awb, body };
}
export async function markHandedOver(c: Conn, ctx: Ctx, id: string, note: string) {
  require(ctx, "doc.write");
  const n = String(note ?? "").trim();
  if (n.length < 3) throw badRequest("Say who it was handed to and how (at least 3 characters).");
  await must(c.query(`UPDATE eawb_messages SET status='handed_over', handed_over_by=$2, handed_over_at=now(), handed_over_note=$3 WHERE id=$1 AND status='issued' RETURNING id`, [recordId(id, "Message"), ctx.userId, n.slice(0, 300)]), "Issued message");
  await audit(c, ctx.tenantId, actorOf(ctx), "eawb.handed_over", "eawb_message", id);
}
export async function voidMessage(c: Conn, ctx: Ctx, id: string, reason: string) {
  require(ctx, "job.write");
  const r = String(reason ?? "").trim();
  if (r.length < 5) throw badRequest("Say why it is void (at least 5 characters).");
  await must(c.query(`UPDATE eawb_messages SET status='void', void_reason=$2 WHERE id=$1 AND status <> 'void' RETURNING id`, [recordId(id, "Message"), r.slice(0, 300)]), "Message");
  await audit(c, ctx.tenantId, actorOf(ctx), "eawb.void", "eawb_message", id);
}
export const listMessages = (c: Conn) => c.query<any>(`SELECT m.id, m.awb_no, m.status, m.created_at, m.handed_over_note, m.void_reason, j.no AS job_no FROM eawb_messages m JOIN jobs j ON j.id=m.job_id ORDER BY m.created_at DESC LIMIT 200`).then((r) => r.rows);
export const getMessage = (c: Conn, id: string) => must(c.query<any>(`SELECT * FROM eawb_messages WHERE id=$1`, [recordId(id, "Message")]), "Message");
export const listStock = (c: Conn) => c.query<any>(`SELECT *, (last_serial - next_serial + 1) AS remaining FROM awb_stock ORDER BY created_at DESC`).then((r) => r.rows);
export const airJobs = (c: Conn) => c.query<any>(`SELECT id, no, origin, destination FROM jobs WHERE mode ILIKE '%air%' AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 100`).then((r) => r.rows);
