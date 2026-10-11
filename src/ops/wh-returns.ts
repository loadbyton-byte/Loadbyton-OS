import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, nextNumber, optStr, recordId, reqStr } from "./common.js";
import { accrue, dubaiDay, lotOf, moveStock, post, qtyOf, r3, refOf, stockLock } from "./warehouse.js";
import { getOwnerPolicy } from "./wh-terms.js";

/**
 * Customer returns into custody. Allowed only if the customer's policy accepts them; every unit lands in quarantine and is
 * released to storage (or disposed of) only by an approver — a return is never silently resold.
 */
export async function createWhReturn(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const owner = await must(c.query<any>(`SELECT id, kind FROM parties WHERE id=$1`, [f.owner_id]), "Customer");
  if (owner.kind !== "customer") throw badRequest("Returns belong to a customer.");
  if ((await getOwnerPolicy(c, owner.id)).returns_policy === "not_accepted") throw badRequest("This customer's policy does not accept returns into custody. Change the policy first, with the customer's agreement.");
  await must(c.query(`SELECT id FROM warehouses WHERE id=$1 AND active`, [f.warehouse_id]), "Warehouse");
  let outboundId: string | null = null;
  const lines = (Array.isArray(f.lines) ? f.lines : []).filter((l: any) => l.sku_id);
  if (!lines.length) throw badRequest("Add at least one SKU.");
  if (new Set(lines.map((l: any) => l.sku_id)).size !== lines.length) throw badRequest("Each SKU can appear once; add the quantities together.");
  if (f.outbound_id) {
    const o = await must(c.query<any>(`SELECT id, owner_id, status FROM wh_outbound WHERE id=$1`, [f.outbound_id]), "Dispatch order");
    if (o.owner_id !== owner.id || o.status !== "dispatched") throw badRequest("A return can only refer to a dispatched order of the same customer.");
    outboundId = o.id;
  }
  for (const l of lines) {
    const s = await must(c.query<any>(`SELECT owner_id, active, code FROM wh_skus WHERE id=$1`, [l.sku_id]), "SKU");
    if (s.owner_id !== owner.id) throw badRequest("A SKU belongs to a different customer.");
    if (outboundId) {
      const sent = Number((await c.query<any>(`SELECT coalesce(sum(qty_dispatched),0) n FROM wh_outbound_lines WHERE outbound_id=$1 AND sku_id=$2`, [outboundId, l.sku_id])).rows[0].n);
      const back = Number((await c.query<any>(`SELECT coalesce(sum(rl.qty_expected),0) n FROM wh_return_lines rl JOIN wh_returns r ON r.id=rl.return_id WHERE r.outbound_id=$1 AND rl.sku_id=$2 AND r.status<>'cancelled'`, [outboundId, l.sku_id])).rows[0].n);
      if (r3(back + qtyOf(l.qty, "Quantity")) > sent) throw badRequest(`${s.code}: ${sent} dispatched and ${back} already on returns.`);
    }
  }
  const no = await nextNumber(c, ctx.tenantId, "wh_return", "RTN");
  const id = (await c.query<{ id: string }>(`INSERT INTO wh_returns(tenant_id,no,owner_id,warehouse_id,outbound_id,reference,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, no, owner.id, f.warehouse_id, outboundId, optStr(f.reference, 80), ctx.userId])).rows[0].id;
  for (const l of lines) await c.query(`INSERT INTO wh_return_lines(tenant_id,return_id,owner_id,sku_id,qty_expected) VALUES ($1,$2,$3,$4,$5)`, [ctx.tenantId, id, owner.id, l.sku_id, qtyOf(l.qty, "Quantity")]);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_return.created", "wh_return", id, { no, lines: lines.length });
  return { id, no };
}

export async function receiveReturnLine(c: Conn, ctx: Ctx, lineId: string, f: Record<string, any>) {
  require(ctx, "wh.write");
  await stockLock(c, ctx);
  await assertWritable(c, ctx.tenantId);
  const line = await must(c.query<any>(`SELECT l.*, r.status AS rstatus, r.warehouse_id, r.no FROM wh_return_lines l JOIN wh_returns r ON r.id=l.return_id WHERE l.id=$1 FOR UPDATE OF l`, [lineId]), "Return line");
  if (!["expected", "receiving"].includes(line.rstatus)) throw badRequest(`Return ${line.no} is ${line.rstatus}.`);
  const loc = await must(c.query<any>(`SELECT * FROM warehouse_locations WHERE id=$1`, [f.location_id]), "Location");
  if (loc.kind !== "quarantine" || !loc.active || loc.warehouse_id !== line.warehouse_id) throw badRequest("Returned goods are received into an active quarantine location of the return's warehouse.");
  const qty = qtyOf(f.qty, "Quantity received");
  if (r3(Number(line.qty_received) + qty) > Number(line.qty_expected) && f.accept_over !== "1") throw badRequest("That exceeds the quantity expected. Tick “accept over-receipt” only if the extra units really arrived.");
  const lot = lotOf(f.lot), clientRef = refOf(f.client_ref);
  const m = await post(c, ctx, { ownerId: line.owner_id, skuId: line.sku_id, locationId: loc.id, lot, delta: qty, kind: "receipt", refType: "wh_return", refId: line.return_id, reason: "customer return", clientRef });
  if (m.duplicate) return { duplicate: true as const };
  await c.query(`INSERT INTO wh_return_receipts(tenant_id,line_id,lot,location_id,qty,created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, lineId, lot, loc.id, qty, ctx.userId]);
  await c.query(`UPDATE wh_return_lines SET qty_received = qty_received + $2 WHERE id=$1`, [lineId, qty]);
  await c.query(`UPDATE wh_returns SET status='receiving' WHERE id=$1 AND status='expected'`, [line.return_id]);
  await accrue(c, ctx.tenantId, { ownerId: line.owner_id, type: "handling_in_unit", qty, onDay: dubaiDay(), ref: `mv:${m.id}`, description: `Return handling ${line.no}` });
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_return.received", "wh_return", line.return_id, { qty });
  return { duplicate: false as const };
}

/** Inspection result: units pass to storage (approver) or are written off (approver, with a reason). */
export async function resolveReturnReceipt(c: Conn, ctx: Ctx, receiptId: string, f: { action: "restock" | "dispose"; qty: string | number; to_location_id?: string; reason?: string }) {
  require(ctx, "wh.approve");
  await stockLock(c, ctx);
  const rc = await must(c.query<any>(`SELECT x.*, l.owner_id, l.sku_id, l.return_id FROM wh_return_receipts x JOIN wh_return_lines l ON l.id=x.line_id WHERE x.id=$1 FOR UPDATE OF x`, [recordId(receiptId)]), "Return receipt");
  const qty = qtyOf(f.qty, "Quantity"), open = r3(Number(rc.qty) - Number(rc.restocked) - Number(rc.disposed));
  if (qty > open) throw badRequest(`Only ${open} unit(s) of this receipt are still awaiting a decision.`);
  const stock = await must(c.query<any>(`SELECT id FROM wh_stock WHERE owner_id=$1 AND sku_id=$2 AND location_id=$3 AND lot=$4`, [rc.owner_id, rc.sku_id, rc.location_id, rc.lot]), "Quarantined stock");
  if (f.action === "restock") {
    if (!f.to_location_id) throw badRequest("Choose the storage location.");
    const dest = await must(c.query<any>(`SELECT kind FROM warehouse_locations WHERE id=$1`, [f.to_location_id]), "Destination");
    if (dest.kind !== "storage") throw badRequest("Restock into a storage location.");
    await moveStock(c, ctx, { stock_id: stock.id, to_location_id: f.to_location_id, qty });
    await c.query(`UPDATE wh_return_receipts SET restocked = restocked + $2 WHERE id=$1`, [rc.id, qty]);
    await c.query(`UPDATE wh_return_lines SET qty_restocked = qty_restocked + $2 WHERE id=$1`, [rc.line_id, qty]);
  } else if (f.action === "dispose") {
    const why = reqStr(f.reason, "Reason for disposal", 300);
    await post(c, ctx, { ownerId: rc.owner_id, skuId: rc.sku_id, locationId: rc.location_id, lot: rc.lot, delta: -qty, kind: "adjust", refType: "wh_return", refId: rc.return_id, reason: `return disposal: ${why}`, clientRef: null });
    await c.query(`UPDATE wh_return_receipts SET disposed = disposed + $2 WHERE id=$1`, [rc.id, qty]);
    await c.query(`UPDATE wh_return_lines SET qty_disposed = qty_disposed + $2 WHERE id=$1`, [rc.line_id, qty]);
  } else throw badRequest("Choose restock or dispose.");
  await audit(c, ctx.tenantId, actorOf(ctx), `wh_return.${f.action}`, "wh_return", rc.return_id, { qty });
}
export async function closeWhReturn(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  const r = await must(c.query<any>(`SELECT * FROM wh_returns WHERE id=$1 FOR UPDATE`, [id]), "Return");
  if (!["expected", "receiving"].includes(r.status)) throw badRequest(`Return is ${r.status}.`);
  const undecided = Number((await c.query<any>(`SELECT coalesce(sum(qty_received - qty_restocked - qty_disposed),0) n FROM wh_return_lines WHERE return_id=$1`, [id])).rows[0].n);
  if (undecided > 0) throw badRequest(`${undecided} received unit(s) are still in quarantine awaiting an inspection decision.`);
  await c.query(`UPDATE wh_returns SET status=$2, closed_at=now() WHERE id=$1`, [id, r.status === "expected" ? "cancelled" : "closed"]);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_return.closed", "wh_return", id);
}
export const listWhReturns = (c: Conn) => c.query<any>(
  `SELECT r.*, p.name AS owner, (SELECT coalesce(sum(qty_expected),0) FROM wh_return_lines l WHERE l.return_id=r.id) AS expected, (SELECT coalesce(sum(qty_received),0) FROM wh_return_lines l WHERE l.return_id=r.id) AS received
   FROM wh_returns r JOIN parties p ON p.id=r.owner_id ORDER BY r.created_at DESC LIMIT 100`).then((x) => x.rows);
export async function getWhReturn(c: Conn, id: string) {
  const ret = await must(c.query<any>(`SELECT r.*, p.name AS owner, o.no AS outbound_no FROM wh_returns r JOIN parties p ON p.id=r.owner_id LEFT JOIN wh_outbound o ON o.id=r.outbound_id WHERE r.id=$1`, [id]), "Return");
  const lines = (await c.query<any>(`SELECT l.*, s.code, s.description FROM wh_return_lines l JOIN wh_skus s ON s.id=l.sku_id WHERE l.return_id=$1 ORDER BY s.code`, [id])).rows;
  const receipts = (await c.query<any>(`SELECT x.*, s.code, loc.code AS location FROM wh_return_receipts x JOIN wh_return_lines l ON l.id=x.line_id JOIN wh_skus s ON s.id=l.sku_id JOIN warehouse_locations loc ON loc.id=x.location_id WHERE l.return_id=$1 ORDER BY x.created_at`, [id])).rows;
  return { ret, lines, receipts };
}
