import type { Conn } from "../db/client.js";
import { require, type Ctx } from "../lib/perms.js";
import { badRequest } from "../lib/util.js";
import { moveStock, refOf } from "./warehouse.js";

const clean = (v: string, max: number) => v.replace(/[\^~\\\u0000-\u001f]/g, " ").trim().slice(0, max);
export interface LabelSpec { code: string; title: string; subtitle?: string }

/** ZPL II for a 100×50 mm thermal label (203 dpi): human text above a Code 128 barcode. Control characters are stripped from all text. */
export function zpl(l: LabelSpec, copies = 1) {
  const code = clean(l.code, 40);
  if (!code) throw badRequest("A label needs a code.");
  const n = Math.max(1, Math.min(500, Math.floor(copies)));
  return ["^XA", "^CI28", "^PW812", "^LL406", `^PQ${n}`, `^FO40,30^A0N,48,48^FD${clean(l.title, 28)}^FS`, l.subtitle ? `^FO40,86^A0N,30,30^FD${clean(l.subtitle, 44)}^FS` : "",
    `^FO40,140^BY3,3,120^BCN,120,Y,N,N^FD${code}^FS`, "^XZ"].filter(Boolean).join("\n");
}

export type ScanHit =
  | { kind: "location"; id: string; code: string; locationKind: string; bonded: boolean }
  | { kind: "sku"; id: string; code: string; description: string; owner: string; ownerId: string }
  | { kind: "lot"; skuId: string; sku: string; lot: string }
  | { kind: "outbound"; id: string; no: string; status: string }
  | { kind: "inbound"; id: string; no: string; status: string };
/** Resolve whatever a scanner (or a keyboard-wedge typed code) produced. Several possible meanings are returned, never guessed. */
export async function resolveScan(c: Conn, ctx: Ctx, raw: string): Promise<ScanHit[]> {
  require(ctx, "read");
  const code = raw.trim().toUpperCase();
  if (!code || code.length > 80) throw badRequest("Scan or type a code.");
  const out: ScanHit[] = [];
  for (const r of (await c.query<any>(`SELECT id, code, kind, bonded FROM warehouse_locations WHERE upper(code)=$1`, [code])).rows) out.push({ kind: "location", id: r.id, code: r.code, locationKind: r.kind, bonded: r.bonded });
  for (const r of (await c.query<any>(`SELECT k.id, k.code, k.description, p.name AS owner, k.owner_id FROM wh_skus k JOIN parties p ON p.id=k.owner_id WHERE upper(k.code)=$1 OR upper(coalesce(k.barcode,''))=$1 LIMIT 10`, [code])).rows) out.push({ kind: "sku", id: r.id, code: r.code, description: r.description, owner: r.owner, ownerId: r.owner_id });
  for (const r of (await c.query<any>(`SELECT l.lot, k.id AS sku_id, k.code FROM wh_lots l JOIN wh_skus k ON k.id=l.sku_id WHERE upper(l.lot)=$1 OR upper(coalesce(l.serial_ref,''))=$1 LIMIT 10`, [code])).rows) out.push({ kind: "lot", skuId: r.sku_id, sku: r.code, lot: r.lot });
  for (const r of (await c.query<any>(`SELECT id, no, status FROM wh_outbound WHERE upper(no)=$1`, [code])).rows) out.push({ kind: "outbound", id: r.id, no: r.no, status: r.status });
  for (const r of (await c.query<any>(`SELECT id, no, status FROM wh_inbound WHERE upper(no)=$1`, [code])).rows) out.push({ kind: "inbound", id: r.id, no: r.no, status: r.status });
  return out;
}

/**
 * Handheld move: scan from-location, item (and lot), quantity, to-location. The retry reference makes a double scan harmless.
 * Items are found by code or barcode; if the same code exists for two customers the operator must say which.
 */
export async function rfMove(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  const from = (await c.query<any>(`SELECT id, code FROM warehouse_locations WHERE upper(code)=upper($1)`, [String(f.from_code ?? "").trim()])).rows[0];
  const to = (await c.query<any>(`SELECT id, code FROM warehouse_locations WHERE upper(code)=upper($1)`, [String(f.to_code ?? "").trim()])).rows[0];
  if (!from) throw badRequest(`Unknown source location “${String(f.from_code ?? "")}”.`);
  if (!to) throw badRequest(`Unknown destination “${String(f.to_code ?? "")}”.`);
  const item = String(f.item ?? "").trim().toUpperCase(), lot = String(f.lot ?? "").trim().toUpperCase();
  const rows = (await c.query<any>(
    `SELECT s.id, p.name AS owner, k.code, s.lot, (s.qty_on_hand - s.qty_reserved)::float8 AS free FROM wh_stock s JOIN wh_skus k ON k.id=s.sku_id JOIN parties p ON p.id=s.owner_id
     WHERE s.location_id=$1 AND s.qty_on_hand>0 AND (upper(k.code)=$2 OR upper(coalesce(k.barcode,''))=$2) AND ($3='' OR s.lot=$3) AND ($4::uuid IS NULL OR s.owner_id=$4)`, [from.id, item, lot, f.owner_id || null])).rows;
  if (!rows.length) throw badRequest(`No ${item}${lot ? ` lot ${lot}` : ""} stock at ${from.code}.`);
  if (rows.length > 1) throw badRequest(`${rows.length} stock rows match (${rows.map((r) => `${r.owner}${r.lot ? ` lot ${r.lot}` : ""}`).join("; ")}). Scan the lot or choose the customer.`);
  return moveStock(c, ctx, { stock_id: rows[0].id, to_location_id: to.id, qty: f.qty, client_ref: refOf(f.client_ref) ?? undefined });
}
