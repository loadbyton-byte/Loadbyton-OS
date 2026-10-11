import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, forbidden } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, nextNumber, optStr, reqStr } from "./common.js";
import { findLot, skuMode } from "./fulfil-lots.js";
import { allocateWaitingInternal, lockStock, moveStock, resolveLocation, resolveSku, systemLocation } from "./fulfilment.js";

const posInt = (v: unknown, label: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 1_000_000) throw badRequest(`${label} must be a whole number above zero.`);
  return n;
};

export async function createSite(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  const code = reqStr(f.code, "Site code", 20).toUpperCase().replace(/\s+/g, "-");
  try {
    const r = await c.query<{ id: string }>(`INSERT INTO fulfil_sites(tenant_id,code,name) VALUES ($1,$2,$3) RETURNING id`, [ctx.tenantId, code, reqStr(f.name, "Site name", 120)]);
    await audit(c, ctx.tenantId, actorOf(ctx), "fulfil_site.created", "fulfil_site", r.rows[0].id, { code });
    return r.rows[0].id;
  } catch (e: any) {
    if (String(e.message).includes("fulfil_sites_tenant_id_code_key")) throw new HttpError(409, `Site ${code} already exists.`, "conflict");
    throw e;
  }
}
export async function setSiteActive(c: Conn, ctx: Ctx, id: string, active: boolean) {
  require(ctx, "wh.write");
  const s = await must(c.query<any>(`SELECT * FROM fulfil_sites WHERE id=$1 FOR UPDATE`, [id]), "Site");
  if (!active) {
    if ((await c.query(`SELECT 1 FROM stock_levels l JOIN wh_locations x ON x.id=l.location_id WHERE x.site_id=$1 AND l.on_hand>0 LIMIT 1`, [id])).rows.length) throw badRequest(`${s.code} still holds stock.`);
    if ((await c.query(`SELECT 1 FROM fulfil_site_transfers WHERE (from_site=$1 OR to_site=$1) AND status IN ('requested','dispatched') LIMIT 1`, [id])).rows.length) throw badRequest(`${s.code} has open transfers.`);
  }
  await c.query(`UPDATE fulfil_sites SET active=$2 WHERE id=$1`, [id, active]);
  await audit(c, ctx.tenantId, actorOf(ctx), active ? "fulfil_site.enabled" : "fulfil_site.disabled", "fulfil_site", id);
}
export const listSites = (c: Conn) => c.query<any>(
  `SELECT s.*, (SELECT count(*) FROM wh_locations l WHERE l.site_id=s.id)::int AS locations,
     coalesce((SELECT sum(v.on_hand) FROM stock_levels v JOIN wh_locations l ON l.id=v.location_id WHERE l.site_id=s.id),0)::int AS units FROM fulfil_sites s ORDER BY s.code`).then((r) => r.rows);

/** Assign (or move) a bin to a site. A bin that holds stock cannot change site: transfer the stock first. */
export async function assignLocationSite(c: Conn, ctx: Ctx, locationId: string, siteId: string | null) {
  require(ctx, "wh.write");
  const loc = await must(c.query<any>(`SELECT * FROM wh_locations WHERE id=$1 FOR UPDATE`, [locationId]), "Location");
  if (loc.kind !== "bin") throw badRequest("Only storage bins belong to a site.");
  if (siteId) await must(c.query(`SELECT id FROM fulfil_sites WHERE id=$1 AND active`, [siteId]), "Site");
  if ((loc.site_id ?? null) !== (siteId ?? null) && (await c.query(`SELECT 1 FROM stock_levels WHERE location_id=$1 AND (on_hand>0 OR reserved>0)`, [locationId])).rows.length) throw badRequest(`${loc.code} holds stock; move it before changing its site.`);
  await c.query(`UPDATE wh_locations SET site_id=$2 WHERE id=$1`, [locationId, siteId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "location.site_assigned", "location", locationId, { site: siteId });
}

/** Request: lines are "from bin, SKU, [lot], qty". No stock moves until it is dispatched. */
export async function requestSiteTransfer(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  if (f.from_site === f.to_site) throw badRequest("Choose two different sites.");
  const from = await must(c.query<any>(`SELECT * FROM fulfil_sites WHERE id=$1 AND active`, [f.from_site]), "Origin site");
  const to = await must(c.query<any>(`SELECT * FROM fulfil_sites WHERE id=$1 AND active`, [f.to_site]), "Destination site");
  const lines: any[] = Array.isArray(f.lines) ? f.lines : [];
  if (!lines.length || lines.length > 200) throw badRequest("Add between 1 and 200 transfer lines.");
  const no = await nextNumber(c, ctx.tenantId, "site_transfer", "XFR");
  const t = (await c.query<{ id: string }>(`INSERT INTO fulfil_site_transfers(tenant_id,no,from_site,to_site,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.tenantId, no, from.id, to.id, optStr(f.notes, 300), ctx.userId])).rows[0].id;
  for (const l of lines) {
    const loc = await resolveLocation(c, l);
    if (loc.kind !== "bin" || loc.site_id !== from.id) throw badRequest(`${loc.code} is not a bin at ${from.code}.`);
    const sku = await resolveSku(c, l);
    if (!sku.active) throw badRequest(`${sku.code} is inactive.`);
    const mode = await skuMode(c, sku.id);
    const lot = mode.tracked ? await findLot(c, sku.id, l.lot) : null;
    await c.query(`INSERT INTO fulfil_site_transfer_lines(tenant_id,transfer_id,sku_id,lot_id,from_location_id,qty) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, t, sku.id, lot?.id ?? null, loc.id, posInt(l.qty, "Quantity")]);
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "site_transfer.requested", "site_transfer", t, { no, from: from.code, to: to.code, lines: lines.length });
  return { id: t, no };
}

/** Dispatch takes unreserved stock out of the origin bins into TRANSIT; reserved units can never leave. */
export async function dispatchSiteTransfer(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const t = await must(c.query<any>(`SELECT * FROM fulfil_site_transfers WHERE id=$1 FOR UPDATE`, [id]), "Transfer");
  if (t.status !== "requested") throw badRequest(`This transfer is ${t.status}.`);
  const transit = await systemLocation(c, ctx.tenantId, "transit");
  const lines = (await c.query<any>(`SELECT * FROM fulfil_site_transfer_lines WHERE transfer_id=$1 ORDER BY id`, [id])).rows;
  for (const l of lines) {
    await moveStock(c, ctx, { skuId: l.sku_id, locationId: l.from_location_id, delta: -l.qty, kind: "site_out", refType: "site_transfer", refId: id, lotId: l.lot_id });
    await moveStock(c, ctx, { skuId: l.sku_id, locationId: transit, delta: l.qty, kind: "site_in", refType: "site_transfer", refId: id, note: "In transit", lotId: l.lot_id });
  }
  await c.query(`UPDATE fulfil_site_transfers SET status='dispatched', dispatched_by=$2, dispatched_at=now() WHERE id=$1`, [id, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "site_transfer.dispatched", "site_transfer", id, { no: t.no, lines: lines.length });
}

export async function receiveSiteTransferLine(c: Conn, ctx: Ctx, id: string, f: Record<string, any>) {
  require(ctx, "wh.floor");
  await assertWritable(c, ctx.tenantId);
  await lockStock(c, ctx.tenantId);
  const t = await must(c.query<any>(`SELECT * FROM fulfil_site_transfers WHERE id=$1 FOR UPDATE`, [id]), "Transfer");
  if (t.status !== "dispatched") throw badRequest(`This transfer is ${t.status}.`);
  const line = await must(c.query<any>(`SELECT * FROM fulfil_site_transfer_lines WHERE id=$1 AND transfer_id=$2 FOR UPDATE`, [f.line_id, id]), "Transfer line");
  const qty = posInt(f.qty, "Quantity");
  if (line.received_qty + qty > line.qty) throw badRequest(`Only ${line.qty - line.received_qty} unit(s) are still in transit on this line.`);
  const dest = await resolveLocation(c, f);
  if (dest.kind !== "bin" || !dest.active || dest.site_id !== t.to_site) throw badRequest(`${dest.code} is not an active bin at the destination site.`);
  const transit = await systemLocation(c, ctx.tenantId, "transit");
  await moveStock(c, ctx, { skuId: line.sku_id, locationId: transit, delta: -qty, kind: "site_out", refType: "site_transfer", refId: id, lotId: line.lot_id });
  await moveStock(c, ctx, { skuId: line.sku_id, locationId: dest.id, delta: qty, kind: "site_in", refType: "site_transfer", refId: id, lotId: line.lot_id });
  await c.query(`UPDATE fulfil_site_transfer_lines SET received_qty = received_qty + $2 WHERE id=$1`, [line.id, qty]);
  const open = (await c.query<any>(`SELECT count(*)::int n FROM fulfil_site_transfer_lines WHERE transfer_id=$1 AND received_qty < qty`, [id])).rows[0].n;
  if (!open) await c.query(`UPDATE fulfil_site_transfers SET status='received', received_by=$2, received_at=now() WHERE id=$1`, [id, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "site_transfer.received", "site_transfer", id, { qty, line: line.id, complete: !open });
  const alloc = await allocateWaitingInternal(c, ctx);
  return { complete: !open, allocated: alloc };
}

/** Close with units unreceived: the shortfall stays visible in TRANSIT until a count adjustment writes it off. Needs approval. */
export async function closeSiteTransferShort(c: Conn, ctx: Ctx, id: string, reason: string) {
  require(ctx, "wh.approve");
  const why = reqStr(reason, "Reason for the shortfall", 500);
  const t = await must(c.query<any>(`SELECT * FROM fulfil_site_transfers WHERE id=$1 FOR UPDATE`, [id]), "Transfer");
  if (t.status !== "dispatched") throw badRequest(`This transfer is ${t.status}.`);
  if (t.dispatched_by === ctx.userId && !ctx.roles.includes("owner")) throw forbidden("A shortfall cannot be accepted by the person who dispatched the transfer.");
  const short = Number((await c.query<any>(`SELECT coalesce(sum(qty-received_qty),0) n FROM fulfil_site_transfer_lines WHERE transfer_id=$1`, [id])).rows[0].n);
  if (!short) throw badRequest("Everything was received.");
  await c.query(`UPDATE fulfil_site_transfers SET status='received', variance=true, variance_reason=$2, received_by=$3, received_at=now() WHERE id=$1`, [id, why, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "site_transfer.closed_short", "site_transfer", id, { short, reason: why });
  return { short };
}

export async function cancelSiteTransfer(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "wh.write");
  const t = await must(c.query<any>(`SELECT * FROM fulfil_site_transfers WHERE id=$1 FOR UPDATE`, [id]), "Transfer");
  if (t.status !== "requested") throw badRequest("Only a transfer that has not been dispatched can be cancelled.");
  await c.query(`UPDATE fulfil_site_transfers SET status='cancelled' WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "site_transfer.cancelled", "site_transfer", id);
}

export const listSiteTransfers = (c: Conn) => c.query<any>(
  `SELECT t.*, f.code AS from_code, d.code AS to_code,
     (SELECT coalesce(sum(qty),0)::int FROM fulfil_site_transfer_lines l WHERE l.transfer_id=t.id) AS units,
     (SELECT coalesce(sum(received_qty),0)::int FROM fulfil_site_transfer_lines l WHERE l.transfer_id=t.id) AS received
   FROM fulfil_site_transfers t JOIN fulfil_sites f ON f.id=t.from_site JOIN fulfil_sites d ON d.id=t.to_site ORDER BY t.created_at DESC LIMIT 100`).then((r) => r.rows);
export async function getSiteTransfer(c: Conn, id: string) {
  const t = await must(c.query<any>(`SELECT t.*, f.code AS from_code, d.code AS to_code FROM fulfil_site_transfers t JOIN fulfil_sites f ON f.id=t.from_site JOIN fulfil_sites d ON d.id=t.to_site WHERE t.id=$1`, [id]), "Transfer");
  const lines = (await c.query<any>(
    `SELECT l.*, s.code AS sku_code, s.name AS sku_name, loc.code AS from_code, lot.lot FROM fulfil_site_transfer_lines l JOIN skus s ON s.id=l.sku_id
     JOIN wh_locations loc ON loc.id=l.from_location_id LEFT JOIN fulfil_lots lot ON lot.id=l.lot_id WHERE l.transfer_id=$1 ORDER BY s.code`, [id])).rows;
  return { t, lines };
}
