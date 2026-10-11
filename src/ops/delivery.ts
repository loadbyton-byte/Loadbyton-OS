import crypto from "node:crypto";
import type { Db, Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, TAX_CODES, badRequest, forbidden, randomToken, toMinor } from "../lib/util.js";
import { assertWritable, consumeQuota } from "../platform/entitlements.js";
import { must, nextNumber, optNum, optStr, reqStr } from "./common.js";
import { issueInvoice, recordReceipt } from "./finance.js";
import { parseCsv, type ImportReport } from "./importer.js";
import { emitParcelEvent } from "./delivery-notify.js";
import { cashHoldReason, getCashPolicy, riderExposure } from "./delivery-finance.js";
import { dubaiToIso } from "./transport.js";

/** Company day in UTC+4 (no DST). */
export const dubaiDay = (d = new Date()) => new Date(d.getTime() + 4 * 3600_000).toISOString().slice(0, 10);

export const EMIRATES = ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"] as const;
export const FAIL_REASONS: Record<string, string> = {
  not_home: "Consignee not available", refused: "Consignee refused the parcel", wrong_address: "Wrong or incomplete address", unreachable: "Phone unreachable",
  no_cash: "Consignee cannot pay the COD amount", reschedule: "Consignee asked for another day", damaged: "Parcel damaged", other: "Other",
};
export const CHARGE_LABEL: Record<string, string> = { delivery: "Delivery", intercity: "Inter-emirate surcharge", cod_fee: "COD handling fee", return: "Return to merchant" };
const MAX_SKEW_MS = 5 * 60_000;
const emirateOf = (v: unknown, label: string) => {
  const e = EMIRATES.find((x) => x.toLowerCase() === String(v ?? "").trim().toLowerCase());
  if (!e) throw badRequest(`${label} must be one of: ${EMIRATES.join(", ")}.`);
  return e;
};
const aed = (minor: number) => (minor / 100).toFixed(2);

// ───────────────────────── events (immutable history)
async function logEvent(c: Conn, ctx: Ctx, shipmentId: string, runId: string | null, kind: string, payload: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await c.query(
    `INSERT INTO dlv_events(tenant_id,shipment_id,run_id,client_event_id,kind,device_time,effective_time,payload,applied,actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,true,$8)`,
    [ctx.tenantId, shipmentId, runId, `srv-${crypto.randomUUID()}`, kind, now, JSON.stringify(payload), ctx.userId]);
}

// ───────────────────────── shipments
export interface ShipmentInput {
  merchant_id: string; external_ref?: string; consignee_name: string; consignee_phone?: string; address: string; emirate: string; origin_emirate?: string;
  pieces?: string | number; weight_kg?: string | number; description?: string; cod?: string | number; require_code?: boolean | string; deliver_by?: string; max_attempts?: string | number;
}

/** Idempotent on (merchant, external_ref): a retried API call or re-imported CSV row never creates a second parcel. */
async function placeShipment(c: Conn, ctx: Ctx, f: ShipmentInput): Promise<{ id: string; no: string; created: boolean }> {
  const ref = optStr(f.external_ref, 80);
  if (ref) {
    const ex = (await c.query<any>(`SELECT id, no FROM dlv_shipments WHERE merchant_id=$1 AND external_ref=$2`, [f.merchant_id, ref])).rows[0];
    if (ex) return { id: ex.id, no: ex.no, created: false };
  }
  // validate every field BEFORE taking a number: an import skips bad rows and must not leave gaps in the numbering
  const cod = f.cod === undefined || String(f.cod).trim() === "" ? 0 : toMinor(f.cod);
  if (cod > 5_000_000) throw badRequest("COD above AED 50,000 per parcel is not accepted.");
  const pieces = optNum(f.pieces) ?? 1;
  if (!Number.isInteger(pieces) || pieces < 1) throw badRequest("Pieces must be a whole number of at least 1.");
  const maxAttempts = optNum(f.max_attempts) ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw badRequest("Maximum attempts must be between 1 and 10.");
  const deliverBy = f.deliver_by ? dubaiToIso(String(f.deliver_by)) : null;
  if (deliverBy && Number.isNaN(Date.parse(deliverBy))) throw badRequest("Deliver-by time is not valid.");
  const v = {
    name: reqStr(f.consignee_name, "Consignee name", 150), phone: optStr(f.consignee_phone, 40), address: reqStr(f.address, "Delivery address", 400),
    emirate: emirateOf(f.emirate, "Emirate"), origin: f.origin_emirate ? emirateOf(f.origin_emirate, "Origin emirate") : "Dubai",
    desc: optStr(f.description, 300), weight: optNum(f.weight_kg) ?? 0,
  };
  const no = await nextNumber(c, ctx.tenantId, "dlv_shipment", "DLV");
  const r = await c.query<{ id: string }>(
    `INSERT INTO dlv_shipments(tenant_id,no,merchant_id,external_ref,track_token,delivery_code,require_code,consignee_name,consignee_phone,address,emirate,origin_emirate,
       pieces,weight_kg,description,cod_minor,max_attempts,deliver_by,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [ctx.tenantId, no, f.merchant_id, ref, randomToken(12), String(crypto.randomInt(0, 10000)).padStart(4, "0"), f.require_code === true || f.require_code === "1",
      v.name, v.phone, v.address, v.emirate, v.origin, pieces, v.weight, v.desc, cod, maxAttempts, deliverBy, ctx.userId]);
  const id = r.rows[0].id;
  // billing unit for this sector is the parcel; the reference makes a retried request idempotent
  await consumeQuota(c, ctx.tenantId, "parcels_per_month", `parcel:${id}`);
  await logEvent(c, ctx, id, null, "created", { cod_minor: cod });
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_shipment.created", "dlv_shipment", id, { no, cod_minor: cod });
  return { id, no, created: true };
}

export async function createShipment(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "dlv.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.merchant_id]), "Merchant");
  const r = await placeShipment(c, ctx, f as ShipmentInput);
  if (!r.created) throw new HttpError(409, `That merchant reference already exists as ${r.no}.`, "conflict");
  return r;
}

/** Same as createShipment, but a known merchant reference returns the existing parcel (idempotent API create) instead of an error. */
export async function ensureShipment(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "dlv.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.merchant_id]), "Merchant");
  return placeShipment(c, ctx, f as ShipmentInput);
}

/**
 * CSV import (one row per parcel). Required columns: external_ref, consignee_name, address, emirate.
 * Optional: consignee_phone, cod (AED), pieces, weight_kg, description, origin_emirate, require_code, max_attempts.
 * Known references are skipped, bad rows are reported, and a quota or read-only error aborts the whole file.
 */
export async function importShipments(c: Conn, ctx: Ctx, merchantId: string, csv: string, dryRun = false): Promise<ImportReport> {
  require(ctx, "dlv.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [merchantId]), "Merchant");
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest("The file needs a header row and at least one data row.");
  if (rows.length > 2001) throw badRequest("Import is limited to 2,000 rows per file.");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  for (const need of ["external_ref", "consignee_name", "address", "emirate"]) if (col(need) < 0) throw badRequest(`A “${need}” column is required.`);
  const rep: ImportReport = { created: 0, duplicates: [], rejected: [] };
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], get = (n: string) => (col(n) >= 0 ? (r[col(n)] ?? "").trim() : "");
    const ref = get("external_ref");
    if (!ref) { rep.rejected.push({ line: i + 1, reason: "external_ref is empty" }); continue; }
    if (seen.has(ref)) { rep.duplicates.push(ref); continue; }
    seen.add(ref);
    try {
      const input: ShipmentInput = {
        merchant_id: merchantId, external_ref: ref, consignee_name: get("consignee_name"), consignee_phone: get("consignee_phone"), address: get("address"), emirate: get("emirate"),
        origin_emirate: get("origin_emirate") || undefined, pieces: get("pieces") || undefined, weight_kg: get("weight_kg") || undefined, description: get("description"),
        cod: get("cod"), require_code: ["1", "yes", "true", "y"].includes(get("require_code").toLowerCase()), max_attempts: get("max_attempts") || undefined,
      };
      if ((await c.query(`SELECT 1 FROM dlv_shipments WHERE merchant_id=$1 AND external_ref=$2`, [merchantId, ref])).rows.length) { rep.duplicates.push(ref); continue; }
      if (dryRun) {
        // same validation as a real create, without taking a number
        emirateOf(input.emirate, "Emirate"); reqStr(input.consignee_name, "Consignee name"); reqStr(input.address, "Delivery address");
        if (input.cod && toMinor(input.cod) > 5_000_000) throw badRequest("COD above AED 50,000 per parcel is not accepted.");
        rep.created++; continue;
      }
      const placed = await placeShipment(c, ctx, input);
      if (placed.created) rep.created++; else rep.duplicates.push(ref);
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) rep.rejected.push({ line: i + 1, reason: `${ref}: ${e.message}` }); else throw e;
    }
  }
  if (!dryRun) await audit(c, ctx.tenantId, actorOf(ctx), "dlv_shipment.imported", "party", merchantId, { created: rep.created, duplicates: rep.duplicates.length, rejected: rep.rejected.length });
  return rep;
}

export async function cancelShipment(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "dlv.write");
  const s = await must(c.query<any>(`SELECT * FROM dlv_shipments WHERE id=$1 FOR UPDATE`, [id]), "Parcel");
  if (s.status !== "new") throw badRequest(`A parcel that is ${s.status.replace(/_/g, " ")} cannot be cancelled${s.status === "assigned" ? " — take it off its run first" : ""}.`);
  await c.query(`UPDATE dlv_shipments SET status='cancelled' WHERE id=$1`, [id]);
  await logEvent(c, ctx, id, null, "cancel");
  await emitParcelEvent(c, ctx.tenantId, s, "parcel.cancelled", "cancelled");
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_shipment.cancelled", "dlv_shipment", id);
}

/** Undelivered → back in the queue for a new run (optionally with a new deliver-by time and a corrected phone/address). */
export async function reattemptShipment(c: Conn, ctx: Ctx, id: string, f: Record<string, any> = {}) {
  require(ctx, "dlv.write");
  await assertWritable(c, ctx.tenantId);
  const s = await must(c.query<any>(`SELECT * FROM dlv_shipments WHERE id=$1 FOR UPDATE`, [id]), "Parcel");
  if (s.status !== "undelivered") throw badRequest(`Only an undelivered parcel can be re-attempted (this one is ${s.status.replace(/_/g, " ")}).`);
  if (s.attempts >= s.max_attempts) throw badRequest(`This parcel has used all ${s.max_attempts} attempts. Return it to the merchant, or raise the limit first.`);
  const by = f.deliver_by ? dubaiToIso(String(f.deliver_by)) : null;
  if (by && Number.isNaN(Date.parse(by))) throw badRequest("Deliver-by time is not valid.");
  const phone = optStr(f.consignee_phone, 40), address = optStr(f.address, 400);
  await c.query(`UPDATE dlv_shipments SET status='new', run_id=NULL, deliver_by=coalesce($2,deliver_by), consignee_phone=coalesce($3,consignee_phone), address=coalesce($4,address) WHERE id=$1`, [id, by, phone, address]);
  await logEvent(c, ctx, id, null, "reattempt", { corrected: !!(phone || address) });
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_shipment.reattempt", "dlv_shipment", id);
}

export async function returnToSender(c: Conn, ctx: Ctx, id: string, reason: string) {
  require(ctx, "dlv.write");
  const s = await must(c.query<any>(`SELECT * FROM dlv_shipments WHERE id=$1 FOR UPDATE`, [id]), "Parcel");
  if (!["new", "undelivered"].includes(s.status)) throw badRequest(`A ${s.status.replace(/_/g, " ")} parcel cannot be returned from here.`);
  await c.query(`UPDATE dlv_shipments SET status='return_to_sender', run_id=NULL, last_failure=coalesce(last_failure,$2) WHERE id=$1`, [id, reqStr(reason, "Reason", 200)]);
  await logEvent(c, ctx, id, null, "rts", { reason });
  await emitParcelEvent(c, ctx.tenantId, s, "parcel.return_to_sender", "return_to_sender", { reason });
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_shipment.rts", "dlv_shipment", id, { reason });
}

/** The parcel is physically back with the merchant: close it and bill the return once. */
export async function confirmReturned(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "dlv.write");
  const s = await must(c.query<any>(`SELECT * FROM dlv_shipments WHERE id=$1 FOR UPDATE`, [id]), "Parcel");
  if (s.status !== "return_to_sender") throw badRequest("Only a parcel marked return-to-sender can be confirmed as returned.");
  await c.query(`UPDATE dlv_shipments SET status='returned', returned_at=now() WHERE id=$1`, [id]);
  await accrue(c, ctx.tenantId, s, "return", dubaiDay());
  await logEvent(c, ctx, id, null, "returned");
  await emitParcelEvent(c, ctx.tenantId, s, "parcel.returned", "returned");
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_shipment.returned", "dlv_shipment", id);
}

// ───────────────────────── riders (a rider is a driver record with a limited-seat login)
export async function createRider(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "dlv.write");
  await assertWritable(c, ctx.tenantId);
  const r = await c.query<{ id: string }>(`INSERT INTO drivers(tenant_id,name,phone) VALUES ($1,$2,$3) RETURNING id`, [ctx.tenantId, reqStr(f.name, "Rider name", 120), optStr(f.phone, 40)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "rider.created", "driver", r.rows[0].id);
  return r.rows[0].id;
}

// ───────────────────────── runs
export async function createRun(c: Conn, ctx: Ctx, f: { driver_id: string; run_date?: string; shipment_ids?: string[]; notes?: string }) {
  require(ctx, "dlv.write");
  await assertWritable(c, ctx.tenantId);
  const d = await must(c.query<any>(`SELECT * FROM drivers WHERE id=$1`, [f.driver_id]), "Rider");
  if (!d.active) throw badRequest(`${d.name} is inactive.`);
  const day = f.run_date || dubaiDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw badRequest("Run date is not valid.");
  const no = await nextNumber(c, ctx.tenantId, "dlv_run", "RUN");
  const r = await c.query<{ id: string }>(`INSERT INTO dlv_runs(tenant_id,no,driver_id,run_date,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, no, f.driver_id, day, optStr(f.notes, 300), ctx.userId]);
  if (f.shipment_ids?.length) await addToRun(c, ctx, r.rows[0].id, f.shipment_ids);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_run.created", "dlv_run", r.rows[0].id, { no });
  return { id: r.rows[0].id, no };
}

export async function addToRun(c: Conn, ctx: Ctx, runId: string, shipmentIds: string[]) {
  require(ctx, "dlv.write");
  const run = await must(c.query<any>(`SELECT * FROM dlv_runs WHERE id=$1 FOR UPDATE`, [runId]), "Run");
  if (!["planned", "out"].includes(run.status)) throw badRequest(`A ${run.status} run cannot take more parcels.`);
  const ids = [...new Set(shipmentIds)];
  if (!ids.length) throw badRequest("Choose at least one parcel.");
  const rows = (await c.query<any>(`SELECT * FROM dlv_shipments WHERE id = ANY($1::uuid[]) FOR UPDATE`, [ids])).rows;
  if (rows.length !== ids.length) throw badRequest("One or more parcels were not found.");
  for (const s of rows) if (s.status !== "new") throw badRequest(`${s.no} is ${s.status.replace(/_/g, " ")} and cannot be assigned.`);
  const next = run.status === "out" ? "out_for_delivery" : "assigned";
  await c.query(`UPDATE dlv_shipments SET status=$2, run_id=$3 WHERE id = ANY($1::uuid[])`, [ids, next, runId]);
  for (const s of rows) {
    await logEvent(c, ctx, s.id, runId, run.status === "out" ? "out" : "assigned", { run: run.no });
    if (run.status === "out") await emitParcelEvent(c, ctx.tenantId, s, "parcel.out_for_delivery", "out_for_delivery", { run: run.no });
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_run.assigned", "dlv_run", runId, { parcels: ids.length });
}

export async function removeFromRun(c: Conn, ctx: Ctx, runId: string, shipmentId: string) {
  require(ctx, "dlv.write");
  const run = await must(c.query<any>(`SELECT * FROM dlv_runs WHERE id=$1 FOR UPDATE`, [runId]), "Run");
  if (run.status !== "planned") throw badRequest("Parcels can only be taken off a run that has not started.");
  const r = await c.query(`UPDATE dlv_shipments SET status='new', run_id=NULL WHERE id=$1 AND run_id=$2 AND status='assigned' RETURNING id`, [shipmentId, runId]);
  if (!r.rows.length) throw badRequest("That parcel is not on this run.");
  await logEvent(c, ctx, shipmentId, runId, "unassigned");
}

export async function startRun(c: Conn, ctx: Ctx, runId: string, override?: string) {
  require(ctx, "dlv.write");
  const run = await must(c.query<any>(`SELECT * FROM dlv_runs WHERE id=$1 FOR UPDATE`, [runId]), "Run");
  if (run.status !== "planned") throw badRequest(`Run is ${run.status}.`);
  const n = Number((await c.query<any>(`SELECT count(*) n FROM dlv_shipments WHERE run_id=$1 AND status='assigned'`, [runId])).rows[0].n);
  if (!n) throw badRequest("Add at least one parcel before sending the rider out.");
  const login = await c.query(`SELECT 1 FROM memberships WHERE driver_id=$1 AND active`, [run.driver_id]);
  if (!login.rows.length) throw badRequest("The rider has no login yet. Invite the rider so they can record deliveries on their phone.");
  const hold = await cashHoldReason(c, run.driver_id);
  if (hold) {
    // a supervisor may release a cash hold with a recorded reason; otherwise cash must be counted in first
    if (!override?.trim()) throw badRequest(`${hold} Count the rider's cash at the cash desk before sending them out.`);
    require(ctx, "dlv.approve");
    await audit(c, ctx.tenantId, actorOf(ctx), "dlv_run.cash_hold_overridden", "dlv_run", runId, { reason: reqStr(override, "Override reason", 300), hold });
  }
  const busy = (await c.query<any>(`SELECT no FROM dlv_runs WHERE driver_id=$1 AND status='out' AND id<>$2 LIMIT 1`, [run.driver_id, runId])).rows[0];
  if (busy) throw badRequest(`This rider is still out on ${busy.no}. Close it first.`);
  await c.query(`UPDATE dlv_runs SET status='out', started_at=now() WHERE id=$1`, [runId]);
  const moved = (await c.query<any>(`UPDATE dlv_shipments SET status='out_for_delivery' WHERE run_id=$1 AND status='assigned' RETURNING *`, [runId])).rows;
  for (const s of moved) {
    await logEvent(c, ctx, s.id, runId, "out", { run: run.no });
    await emitParcelEvent(c, ctx.tenantId, s, "parcel.out_for_delivery", "out_for_delivery", { run: run.no });
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_run.started", "dlv_run", runId, { parcels: moved.length });
}

/** A run closes only when every parcel on it has an outcome; cash is handed over separately at the cash desk. */
export async function closeRun(c: Conn, ctx: Ctx, runId: string) {
  require(ctx, "dlv.write");
  const run = await must(c.query<any>(`SELECT * FROM dlv_runs WHERE id=$1 FOR UPDATE`, [runId]), "Run");
  if (run.status !== "out") throw badRequest(`Run is ${run.status}.`);
  const open = Number((await c.query<any>(`SELECT count(*) n FROM dlv_shipments WHERE run_id=$1 AND status IN ('assigned','out_for_delivery')`, [runId])).rows[0].n);
  if (open) throw badRequest(`${open} parcel(s) have no outcome yet. Every parcel needs “delivered” or a failed-attempt reason.`);
  await c.query(`UPDATE dlv_runs SET status='closed', closed_at=now() WHERE id=$1`, [runId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_run.closed", "dlv_run", runId);
}

export async function cancelRun(c: Conn, ctx: Ctx, runId: string) {
  require(ctx, "dlv.write");
  const run = await must(c.query<any>(`SELECT * FROM dlv_runs WHERE id=$1 FOR UPDATE`, [runId]), "Run");
  if (run.status !== "planned") throw badRequest("Only a run that has not started can be cancelled.");
  const back = (await c.query<any>(`UPDATE dlv_shipments SET status='new', run_id=NULL WHERE run_id=$1 AND status='assigned' RETURNING id`, [runId])).rows;
  for (const s of back) await logEvent(c, ctx, s.id, runId, "unassigned", { reason: "run cancelled" });
  await c.query(`UPDATE dlv_runs SET status='cancelled' WHERE id=$1`, [runId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_run.cancelled", "dlv_run", runId);
}

// ───────────────────────── rider events (offline-safe)
export interface RiderEvent {
  client_event_id: string; shipment_id: string; kind: "deliver" | "fail" | "note"; device_time: string; payload?: Record<string, any>;
}
export type RiderOutcome = "applied" | "stored" | "duplicate" | "rejected";
export interface RiderResult { client_event_id: string; outcome: RiderOutcome; reason?: string }

/**
 * Apply one rider event. Guarantees (same contract as the transport driver app):
 *  - a client event id causes at most one server record, however many times it is synced (advisory lock + unique key);
 *  - device time is kept verbatim, an implausible clock is clamped and flagged;
 *  - cash is recorded only with a delivery, only at the exact COD amount, and only once per parcel;
 *  - a late or out-of-order event never overwrites a completed delivery.
 */
export async function applyRiderEvent(c: Conn, ctx: Ctx, ev: RiderEvent): Promise<RiderResult> {
  const id = String(ev.client_event_id ?? "");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return { client_event_id: id, outcome: "rejected", reason: "invalid event id" };
  if (!["deliver", "fail", "note"].includes(ev.kind)) return { client_event_id: id, outcome: "rejected", reason: "unknown event kind" };
  const raw = Date.parse(ev.device_time);
  if (Number.isNaN(raw)) return { client_event_id: id, outcome: "rejected", reason: "invalid device time" };
  const isRider = ctx.perms.has("driver.act"), isStaff = ctx.perms.has("dlv.write");
  if (!isRider && !isStaff) throw forbidden("Your role cannot record deliveries.");
  if (ctx.readOnly) throw forbidden("This session is read-only (support access).");

  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${ctx.tenantId}:${id}`]);
  if ((await c.query(`SELECT 1 FROM dlv_events WHERE client_event_id=$1`, [id])).rows.length) return { client_event_id: id, outcome: "duplicate" };

  const s = (await c.query<any>(`SELECT * FROM dlv_shipments WHERE id=$1 FOR UPDATE`, [ev.shipment_id])).rows[0];
  if (!s) return { client_event_id: id, outcome: "rejected", reason: "unknown parcel" };
  const run = s.run_id ? (await c.query<any>(`SELECT * FROM dlv_runs WHERE id=$1`, [s.run_id])).rows[0] : null;
  if (!isStaff && run?.driver_id !== ctx.driverId) {
    // a parcel recalled from this rider's run while their phone was offline is a conflict to record, not an authorisation failure
    const had = (await c.query(`SELECT 1 FROM dlv_events e JOIN dlv_runs r ON r.id=e.run_id WHERE e.shipment_id=$1 AND r.driver_id=$2 LIMIT 1`, [s.id, ctx.driverId])).rows.length;
    if (!had) throw new HttpError(403, "This parcel is not on one of your runs.", "not_yours");
  }

  const now = Date.now();
  let eff = raw; const notes: string[] = [];
  if (raw > now + MAX_SKEW_MS) { eff = now; notes.push("device clock ahead of server; server time used"); }
  else if (raw < now - 14 * 86400_000) { eff = now; notes.push("device time implausibly old; server time used"); }
  const effIso = new Date(eff).toISOString();
  const policy = await getCashPolicy(c);
  const lateHours = Math.floor((now - raw) / 3600_000);
  const lateSync = ev.kind !== "note" && lateHours >= policy.max_offline_hours;
  if (lateSync) notes.push(`synced ${lateHours}h after it happened (offline window ${policy.max_offline_hours}h); supervisor check raised`);
  const p = ev.payload ?? {};
  let applied = false, resolution: string | null = null;
  const refuse = (why: string) => { applied = false; resolution = why; };
  const live = s.status === "out_for_delivery" || (s.status === "undelivered" && run?.status === "out");   // same-day retry by the same rider is allowed

  if (ev.kind === "note") {
    applied = true;
  } else if (!run) {
    refuse(`parcel is ${s.status.replace(/_/g, " ")} and not on a run`);
  } else if (s.status === "delivered") {
    refuse("already delivered; original retained");
  } else if (!live) {
    refuse(`parcel is ${s.status.replace(/_/g, " ")}`);
  } else if (ev.kind === "deliver") {
    const name = String(p.name ?? "").trim().slice(0, 120);
    const cash = p.cash === undefined || String(p.cash).trim() === "" ? null : Math.round(Number(p.cash) * 100);
    if (!name) refuse("receiver name is required");
    else if (s.require_code && String(p.code ?? "").trim() !== s.delivery_code) refuse("the delivery code is missing or wrong");
    else if (Number(s.cod_minor) > 0 && cash !== Number(s.cod_minor)) refuse(`collect exactly AED ${aed(Number(s.cod_minor))} in cash${cash == null ? "" : ` (you entered ${aed(cash)})`}; if the consignee cannot pay, record a failed attempt`);
    else if (Number(s.cod_minor) === 0 && cash) refuse("this parcel has no COD amount; no cash should be taken");
    else {
      await c.query(`UPDATE dlv_shipments SET status='delivered', delivered_at=$2, delivered_to=$3, attempts=attempts+1, last_failure=NULL WHERE id=$1`, [s.id, effIso, name]);
      if (Number(s.cod_minor) > 0) {
        await c.query(`INSERT INTO dlv_collections(tenant_id,shipment_id,driver_id,amount_minor,collected_at,client_event_id) VALUES ($1,$2,$3,$4,$5,$6)`,
          [ctx.tenantId, s.id, run.driver_id, s.cod_minor, effIso, id]);
      }
      await accrueDelivery(c, ctx.tenantId, s, dubaiDay(new Date(eff)));
      if (Number(s.cod_minor) > 0 && run.driver_id) {
        const ex = await riderExposure(c, run.driver_id);
        if (ex.amount_minor > policy.max_unsettled_minor) {
          const name = (await c.query<any>(`SELECT name FROM drivers WHERE id=$1`, [run.driver_id])).rows[0]?.name ?? "Rider";
          const title = `Cash limit exceeded: ${name}`;
          if (!(await c.query(`SELECT 1 FROM job_exceptions WHERE title=$1 AND status='open' AND created_at > now() - interval '24 hours'`, [title])).rows.length)
            await c.query(`INSERT INTO job_exceptions(tenant_id,title,detail,owner_id,due_at) VALUES ($1,$2,$3,$4, now() + interval '4 hours')`,
              [ctx.tenantId, title, `${name} holds AED ${aed(ex.amount_minor)} of uncounted cash (limit AED ${aed(policy.max_unsettled_minor)}). Count the cash in before the next run.`, s.created_by]);
        }
      }
      await emitParcelEvent(c, ctx.tenantId, { ...s, attempts: s.attempts + 1 }, "parcel.delivered", "delivered", { delivered_at: effIso, received_by: name, cod_collected_minor: Number(s.cod_minor) });
      applied = true;
    }
  } else if (ev.kind === "fail") {
    const reason = FAIL_REASONS[String(p.reason)] ? String(p.reason) : "other";
    const text = `${FAIL_REASONS[reason]}${p.note ? ` — ${String(p.note).slice(0, 200)}` : ""}`;
    const attempts = s.attempts + 1, exhausted = attempts >= s.max_attempts;
    await c.query(`UPDATE dlv_shipments SET status=$2, attempts=$3, last_failure=$4 WHERE id=$1`, [s.id, exhausted ? "return_to_sender" : "undelivered", attempts, text]);
    if (exhausted) {
      notes.push(`attempt ${attempts} of ${s.max_attempts}: sent to return-to-sender`);
      await c.query(`INSERT INTO job_exceptions(tenant_id,title,detail,owner_id,due_at) VALUES ($1,$2,$3,$4, now() + interval '24 hours')`,
        [ctx.tenantId, `Parcel ${s.no}: all ${s.max_attempts} attempts used`, `${text}. Return it to the merchant or contact the consignee.`, s.created_by]);
    } else if (reason === "no_cash") {
      await c.query(`INSERT INTO job_exceptions(tenant_id,title,detail,owner_id,due_at) VALUES ($1,$2,$3,$4, now() + interval '8 hours')`,
        [ctx.tenantId, `Parcel ${s.no}: consignee cannot pay COD`, `Call the merchant for a decision. ${text}`, s.created_by]);
    }
    const after = { ...s, attempts };
    await emitParcelEvent(c, ctx.tenantId, after, "parcel.attempt_failed", exhausted ? "return_to_sender" : "undelivered", { reason: FAIL_REASONS[reason], attempt: attempts, max_attempts: s.max_attempts, will_return: exhausted });
    if (exhausted) await emitParcelEvent(c, ctx.tenantId, after, "parcel.return_to_sender", "return_to_sender", { reason: "all attempts used" });
    applied = true;
  }

  if (lateSync && (applied || ev.kind !== "note")) {
    await c.query(`INSERT INTO job_exceptions(tenant_id,title,detail,owner_id,due_at) VALUES ($1,$2,$3,$4, now() + interval '24 hours')`,
      [ctx.tenantId, `Late offline sync: parcel ${s.no}`, `A ${ev.kind} event reached the server ${lateHours} hours after it happened (offline window ${policy.max_offline_hours}h). Confirm it with the rider${applied ? "; it was applied" : "; it was not applied"}.`, s.created_by]);
  }
  const resolutionText = [resolution, ...notes].filter(Boolean).join("; ") || null;
  const stored = ev.kind === "deliver" && applied ? { name: p.name, cash_minor: Number(s.cod_minor) } : p;
  // never keep the delivery code in the event log
  const safe = { ...stored } as Record<string, unknown>; delete safe.code;
  await c.query(
    `INSERT INTO dlv_events(tenant_id,shipment_id,run_id,client_event_id,kind,device_time,effective_time,payload,applied,resolution,actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [ctx.tenantId, s.id, run?.id ?? null, id, ev.kind, new Date(raw).toISOString(), effIso, JSON.stringify(safe), applied, resolutionText, ctx.userId]);
  if (applied) await audit(c, ctx.tenantId, actorOf(ctx), `dlv.event.${ev.kind}`, "dlv_shipment", s.id, { client_event_id: id });
  return { client_event_id: id, outcome: applied ? "applied" : "stored", reason: resolutionText ?? undefined };
}

/** Batch sync from a phone that was offline: oldest first so a failed attempt is applied before the retry that follows it. */
export async function syncRiderEvents(c: Conn, ctx: Ctx, events: RiderEvent[]): Promise<RiderResult[]> {
  if (!Array.isArray(events) || events.length > 100) throw badRequest("Send between 1 and 100 events per sync.");
  const sorted = [...events].sort((a, b) => Date.parse(a.device_time) - Date.parse(b.device_time));
  const out: RiderResult[] = [];
  for (const e of sorted) {
    try { out.push(await applyRiderEvent(c, ctx, e)); }
    catch (err) {
      // one event for somebody else's parcel must not wedge the rest of a phone's queue
      if (err instanceof HttpError && err.code === "not_yours") out.push({ client_event_id: String(e.client_event_id), outcome: "rejected", reason: err.message });
      else throw err;
    }
  }
  return out;
}

// ───────────────────────── rates and charges
export async function setRate(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "dlv.bill");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [f.merchant_id]), "Merchant");
  const from = String(f.effective_from || dubaiDay());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from))) throw badRequest("Effective date is not valid.");
  const have = (await c.query<any>(`SELECT id FROM dlv_rates WHERE merchant_id=$1 AND effective_from=$2`, [f.merchant_id, from])).rows[0];
  if (have && from < dubaiDay()) throw badRequest("A rate already in effect for that date cannot be edited. Add a new rate from a later date.");
  const bps = Math.round(Number(f.cod_fee_pct || 0) * 100);
  if (!Number.isFinite(bps) || bps < 0 || bps > 2000) throw badRequest("COD fee must be between 0% and 20%.");
  const v = [toMinor(f.delivery || "0"), toMinor(f.intercity || "0"), toMinor(f.return || "0"), bps, toMinor(f.cod_fee_min || "0")];
  const tax = TAX_CODES[f.tax_code] ? f.tax_code : "SR5";
  await c.query(
    `INSERT INTO dlv_rates(tenant_id,merchant_id,delivery_minor,intercity_minor,return_minor,cod_fee_bps,cod_fee_min_minor,tax_code,effective_from,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id,merchant_id,effective_from) DO UPDATE SET delivery_minor=EXCLUDED.delivery_minor, intercity_minor=EXCLUDED.intercity_minor,
       return_minor=EXCLUDED.return_minor, cod_fee_bps=EXCLUDED.cod_fee_bps, cod_fee_min_minor=EXCLUDED.cod_fee_min_minor, tax_code=EXCLUDED.tax_code, created_by=EXCLUDED.created_by`,
    [ctx.tenantId, f.merchant_id, ...v, tax, from, ctx.userId]);
  const priced = await repriceUnrated(c, f.merchant_id);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_rate.set", "party", f.merchant_id, { from, priced });
  return { priced };
}

const rateFor = async (c: Conn, merchantId: string, day: string) =>
  (await c.query<any>(`SELECT * FROM dlv_rates WHERE merchant_id=$1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1`, [merchantId, day])).rows[0] ?? null;

function priceOf(rate: any, type: string, s: { cod_minor: any }): number {
  if (type === "delivery") return Number(rate.delivery_minor);
  if (type === "intercity") return Number(rate.intercity_minor);
  if (type === "return") return Number(rate.return_minor);
  const pct = Math.round((Number(s.cod_minor) * Number(rate.cod_fee_bps)) / 10_000);
  return Number(rate.cod_fee_bps) > 0 || Number(rate.cod_fee_min_minor) > 0 ? Math.max(pct, Number(rate.cod_fee_min_minor)) : 0;
}

/** One charge per (parcel, type), idempotent on source_ref. No rate card yet → kept as unrated and priced later. */
async function accrue(c: Conn, tenantId: string, s: any, type: "delivery" | "intercity" | "cod_fee" | "return", day: string) {
  const rate = await rateFor(c, s.merchant_id, day);
  const unit = rate ? priceOf(rate, type, s) : 0;
  if (rate && unit === 0) return;                          // this merchant's tariff does not charge for it
  await c.query(
    `INSERT INTO dlv_charges(tenant_id,merchant_id,shipment_id,charge_type,description,unit_minor,tax_code,occurred_on,source_ref,unrated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id,source_ref) DO NOTHING`,
    [tenantId, s.merchant_id, s.id, type, `${CHARGE_LABEL[type]} · ${s.no}`, unit, rate?.tax_code ?? "SR5", day, `dlv:${s.id}:${type}`, !rate]);
}
async function accrueDelivery(c: Conn, tenantId: string, s: any, day: string) {
  await accrue(c, tenantId, s, "delivery", day);
  if (s.emirate !== s.origin_emirate) await accrue(c, tenantId, s, "intercity", day);
  if (Number(s.cod_minor) > 0) await accrue(c, tenantId, s, "cod_fee", day);
}

/** Price activity that happened before its rate card existed, using the rate effective on the day it happened. */
async function repriceUnrated(c: Conn, merchantId: string) {
  const rows = (await c.query<any>(
    `SELECT g.id, g.charge_type, g.occurred_on, s.cod_minor FROM dlv_charges g JOIN dlv_shipments s ON s.id=g.shipment_id
     WHERE g.merchant_id=$1 AND g.unrated AND g.invoice_id IS NULL`, [merchantId])).rows;
  let n = 0;
  for (const g of rows) {
    const rate = await rateFor(c, merchantId, String(g.occurred_on).slice(0, 10));
    if (!rate) continue;
    const unit = priceOf(rate, g.charge_type, g);
    if (unit === 0) await c.query(`DELETE FROM dlv_charges WHERE id=$1`, [g.id]);            // never invoiced; the tariff does not charge for it
    else await c.query(`UPDATE dlv_charges SET unit_minor=$2, tax_code=$3, unrated=false WHERE id=$1`, [g.id, unit, rate.tax_code]);
    n++;
  }
  return n;
}

type Group = { id: string; type: string; unit: number; tax: string; qty: number; ids: string[]; from: string; to: string };
/** Invoice one merchant's rated, unbilled activity. Lines are grouped by type/rate/tax so a month is a handful of lines, not thousands. */
async function invoiceCharges(c: Conn, ctx: Ctx, merchantId: string, through: string, termsDays: number) {
  const charges = (await c.query<any>(
    `SELECT * FROM dlv_charges WHERE merchant_id=$1 AND invoice_id IS NULL AND NOT unrated AND occurred_on <= $2 ORDER BY occurred_on, id FOR UPDATE`, [merchantId, through])).rows;
  if (!charges.length) return null;
  const unrated = Number((await c.query<any>(`SELECT count(*) n FROM dlv_charges WHERE merchant_id=$1 AND unrated AND invoice_id IS NULL AND occurred_on <= $2`, [merchantId, through])).rows[0].n);
  const groups = new Map<string, Group>();
  for (const g of charges) {
    const key = `${g.charge_type}|${g.unit_minor}|${g.tax_code}`, day = String(g.occurred_on).slice(0, 10);
    const x: Group = groups.get(key) ?? { id: key, type: g.charge_type, unit: Number(g.unit_minor), tax: g.tax_code, qty: 0, ids: [], from: day, to: day };
    x.qty += Number(g.qty); x.ids.push(g.id); if (day < x.from) x.from = day; if (day > x.to) x.to = day;
    groups.set(key, x);
  }
  const ent = (await c.query<any>(`SELECT id FROM entities ORDER BY created_at LIMIT 1`)).rows[0];
  const run = (await c.query<{ id: string }>(`INSERT INTO dlv_billing_runs(tenant_id,merchant_id,through_on,created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.tenantId, merchantId, through, ctx.userId])).rows[0].id;
  const inv = await issueInvoice(c, ctx, {
    entityId: ent.id, partyId: merchantId, dlvRunId: run,
    lines: [...groups.values()].map((x) => ({ id: x.id, description: `${CHARGE_LABEL[x.type]}${x.from === x.to ? ` ${x.from}` : ` ${x.from} → ${x.to}`}`, qty: x.qty, unit_minor: x.unit, tax_code: x.tax })),
    markCharge: async (lineKey, invoiceId) => { await c.query(`UPDATE dlv_charges SET invoice_id=$2 WHERE id = ANY($1::uuid[])`, [groups.get(lineKey)!.ids, invoiceId]); },
  }, termsDays);
  await c.query(`UPDATE dlv_billing_runs SET invoice_id=$2 WHERE id=$1`, [run, inv.id]);
  return { ...inv, charges: charges.length, unrated };
}

export async function invoiceMerchant(c: Conn, ctx: Ctx, merchantId: string, f: { through?: string } = {}, termsDays = 30) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1`, [merchantId]), "Merchant");
  const r = await invoiceCharges(c, ctx, merchantId, f.through || dubaiDay(), termsDays);
  if (!r) throw badRequest("No rated, unbilled delivery activity for this merchant up to that date.");
  return { id: r.id, no: r.no, charges: r.charges, warnings: r.unrated ? [`${r.unrated} unrated activity line(s) were left out; set the missing rates to bill them.`] : [] };
}

// ───────────────────────── cash: rider handover → settlement
export async function cashInHand(c: Conn) {
  return (await c.query<any>(
    `SELECT d.id AS driver_id, d.name, count(*)::int AS parcels, sum(k.amount_minor)::bigint AS amount_minor, min(k.collected_at) AS oldest
     FROM dlv_collections k JOIN drivers d ON d.id=k.driver_id WHERE k.settlement_id IS NULL GROUP BY d.id, d.name ORDER BY min(k.collected_at)`)).rows
    .map((r) => ({ ...r, amount_minor: Number(r.amount_minor) }));
}

/**
 * The cash desk counts a rider's cash against everything the rider has collected and not yet handed in.
 * A match closes at once. A difference is recorded as a variance and needs a second person's decision.
 */
export async function settleRider(c: Conn, ctx: Ctx, driverId: string, f: { counted: string | number; note?: string }) {
  require(ctx, "dlv.cash");
  await assertWritable(c, ctx.tenantId);
  if (ctx.driverId && ctx.driverId === driverId) throw forbidden("You cannot receive your own cash.");
  const d = await must(c.query<any>(`SELECT * FROM drivers WHERE id=$1`, [driverId]), "Rider");
  const coll = (await c.query<any>(`SELECT id, amount_minor FROM dlv_collections WHERE driver_id=$1 AND settlement_id IS NULL ORDER BY collected_at FOR UPDATE`, [driverId])).rows;
  if (!coll.length) throw badRequest(`${d.name} has no uncounted cash.`);
  if (f.counted === undefined || String(f.counted).trim() === "") throw badRequest("Enter the amount you counted.");
  const counted = toMinor(f.counted);
  const expected = coll.reduce((a, x) => a + Number(x.amount_minor), 0);
  const variance = counted - expected;
  const note = variance ? reqStr(f.note, "A note explaining the difference", 300) : optStr(f.note, 300);
  const no = await nextNumber(c, ctx.tenantId, "dlv_settlement", "CSH");
  const s = await c.query<{ id: string }>(
    `INSERT INTO dlv_settlements(tenant_id,no,driver_id,expected_minor,counted_minor,status,received_by,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, no, driverId, expected, counted, variance ? "pending_approval" : "closed", ctx.userId, note]);
  await c.query(`UPDATE dlv_collections SET settlement_id=$2 WHERE id = ANY($1::uuid[])`, [coll.map((x) => x.id), s.rows[0].id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_settlement.received", "dlv_settlement", s.rows[0].id, { no, expected, counted, variance });
  return { id: s.rows[0].id, no, expected, counted, variance, status: variance ? "pending_approval" : "closed" };
}

/**
 * Approve (the shortage/overage stays on record against the rider; merchants are still paid what was collected) or reject
 * (the cash goes back to the rider's uncounted pile to be counted again). Never by the person who counted it, unless they are the owner.
 */
export async function decideSettlement(c: Conn, ctx: Ctx, id: string, approve: boolean) {
  require(ctx, "dlv.approve");
  const s = await must(c.query<any>(`SELECT * FROM dlv_settlements WHERE id=$1 FOR UPDATE`, [id]), "Cash handover");
  if (s.status !== "pending_approval") throw badRequest(`This handover is already ${s.status.replace(/_/g, " ")}.`);
  if (s.received_by === ctx.userId && !ctx.roles.includes("owner")) throw forbidden("A cash variance cannot be decided by the person who counted the cash.");
  if (approve) {
    await c.query(`UPDATE dlv_settlements SET status='closed', decided_by=$2, decided_at=now() WHERE id=$1`, [id, ctx.userId]);
  } else {
    await c.query(`UPDATE dlv_settlements SET status='rejected', decided_by=$2, decided_at=now() WHERE id=$1`, [id, ctx.userId]);
    await c.query(`UPDATE dlv_collections SET settlement_id=NULL WHERE settlement_id=$1 AND remittance_id IS NULL`, [id]);
  }
  await audit(c, ctx.tenantId, actorOf(ctx), approve ? "dlv_settlement.approved" : "dlv_settlement.rejected", "dlv_settlement", id, { variance: Number(s.variance_minor) });
}

// ───────────────────────── merchant remittance
/** COD that has been counted in, per merchant, and not yet paid out. */
export const remittable = (c: Conn) => c.query<any>(
  `SELECT p.id AS merchant_id, p.name, count(*)::int AS parcels, sum(k.amount_minor)::bigint AS gross_minor, min(k.collected_at) AS oldest,
     (SELECT coalesce(sum(round(g.qty*g.unit_minor)),0)::bigint FROM dlv_charges g WHERE g.merchant_id=p.id AND g.invoice_id IS NULL AND NOT g.unrated) AS unbilled_minor
   FROM dlv_collections k JOIN dlv_settlements st ON st.id=k.settlement_id AND st.status='closed' JOIN dlv_shipments s ON s.id=k.shipment_id JOIN parties p ON p.id=s.merchant_id
   WHERE k.remittance_id IS NULL GROUP BY p.id, p.name ORDER BY min(k.collected_at)`)
  .then((r) => r.rows.map((x) => ({ ...x, gross_minor: Number(x.gross_minor), unbilled_minor: Number(x.unbilled_minor) })));

/**
 * Create a payout statement for everything counted in for one merchant. With net_fees, the merchant's unbilled rated charges are
 * invoiced and settled out of the COD (a receipt “netted from COD remittance”), never above the COD available.
 */
export async function createRemittance(c: Conn, ctx: Ctx, merchantId: string, f: { net_fees?: boolean | string } = {}) {
  require(ctx, "dlv.remit");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1`, [merchantId]), "Merchant");
  const coll = (await c.query<any>(
    `SELECT k.id, k.amount_minor FROM dlv_collections k JOIN dlv_settlements st ON st.id=k.settlement_id AND st.status='closed' JOIN dlv_shipments s ON s.id=k.shipment_id
     WHERE s.merchant_id=$1 AND k.remittance_id IS NULL ORDER BY k.collected_at FOR UPDATE OF k`, [merchantId])).rows;
  if (!coll.length) throw badRequest("There is no counted-in COD waiting to be paid to this merchant.");
  const gross = coll.reduce((a, x) => a + Number(x.amount_minor), 0);
  let fees = 0, invoiceId: string | null = null, invoiceNo: string | null = null;
  const no = await nextNumber(c, ctx.tenantId, "dlv_remittance", "REM");
  if (f.net_fees === true || f.net_fees === "1") {
    require(ctx, "finance.write");                      // invoicing and receipting are finance acts
    const inv = await invoiceCharges(c, ctx, merchantId, dubaiDay(), 30);
    if (inv) {
      const total = Number((await c.query<any>(`SELECT total_minor FROM invoices WHERE id=$1`, [inv.id])).rows[0].total_minor);
      fees = Math.min(total, gross); invoiceId = inv.id; invoiceNo = inv.no;
      await recordReceipt(c, ctx, inv.id, { amount: aed(fees), method: "Netted from COD remittance", reference: no });
    }
  }
  const r = await c.query<{ id: string }>(
    `INSERT INTO dlv_remittances(tenant_id,no,merchant_id,gross_minor,fees_minor,net_minor,invoice_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, no, merchantId, gross, fees, gross - fees, invoiceId, ctx.userId]);
  await c.query(`UPDATE dlv_collections SET remittance_id=$2 WHERE id = ANY($1::uuid[])`, [coll.map((x) => x.id), r.rows[0].id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_remittance.created", "dlv_remittance", r.rows[0].id, { no, gross, fees, parcels: coll.length });
  return { id: r.rows[0].id, no, gross, fees, net: gross - fees, invoiceNo };
}

/** Record that the bank transfer was made. A second person confirms it (the owner excepted); the reference is mandatory. */
export async function payRemittance(c: Conn, ctx: Ctx, id: string, f: { reference?: string }) {
  require(ctx, "dlv.approve");
  const r = await must(c.query<any>(`SELECT * FROM dlv_remittances WHERE id=$1 FOR UPDATE`, [id]), "Remittance");
  if (r.status !== "pending_payment") throw badRequest(`This remittance is already ${r.status.replace(/_/g, " ")}.`);
  if (r.created_by === ctx.userId && !ctx.roles.includes("owner")) throw forbidden("A payout cannot be confirmed by the person who prepared it.");
  const ref = reqStr(f.reference, "Bank transfer reference", 80);
  await c.query(`UPDATE dlv_remittances SET status='paid', pay_reference=$2, paid_by=$3, paid_at=now() WHERE id=$1`, [id, ref, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_remittance.paid", "dlv_remittance", id, { ref, net: Number(r.net_minor) });
  const set = (await c.query<any>(`SELECT webhook_active FROM dlv_merchant_settings WHERE merchant_id=$1`, [r.merchant_id])).rows[0];
  if (set?.webhook_active) {
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'merchant.webhook',$2,$3) ON CONFLICT (key) DO NOTHING`,
      [ctx.tenantId, `mwh:remittance:${id}`, JSON.stringify({ merchant_id: r.merchant_id, type: "remittance.paid", data: { remittance: r.no, cod_collected_minor: Number(r.gross_minor), fees_minor: Number(r.fees_minor), paid_to_merchant_minor: Number(r.net_minor), bank_reference: ref } })]);
  }
}

/** A statement prepared by mistake can be withdrawn while nothing else depends on it (no fees netted, not yet paid). */
export async function voidRemittance(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "dlv.remit");
  const r = await must(c.query<any>(`SELECT * FROM dlv_remittances WHERE id=$1 FOR UPDATE`, [id]), "Remittance");
  if (r.status !== "pending_payment") throw badRequest(`A ${r.status.replace(/_/g, " ")} remittance cannot be withdrawn.`);
  if (Number(r.fees_minor) > 0) throw badRequest("Fees were netted against an invoice. Void the invoice's receipt through finance before withdrawing, or pay this statement.");
  await c.query(`UPDATE dlv_collections SET remittance_id=NULL WHERE remittance_id=$1`, [id]);
  await c.query(`UPDATE dlv_remittances SET status='void' WHERE id=$1`, [id]);
  await audit(c, ctx.tenantId, actorOf(ctx), "dlv_remittance.void", "dlv_remittance", id);
}

// ───────────────────────── reading
export interface ShipmentFilter { status?: string; merchantId?: string | null; q?: string; runId?: string; limit?: number }
export const listShipments = (c: Conn, o: ShipmentFilter = {}) => c.query<any>(
  `SELECT s.*, p.name AS merchant_name, r.no AS run_no, d.name AS rider_name,
     (s.deliver_by IS NOT NULL AND s.deliver_by < now() AND s.status IN ('new','assigned','out_for_delivery','undelivered')) AS late
   FROM dlv_shipments s JOIN parties p ON p.id=s.merchant_id LEFT JOIN dlv_runs r ON r.id=s.run_id LEFT JOIN drivers d ON d.id=r.driver_id
   WHERE ($1::text IS NULL OR s.status=$1) AND ($2::uuid IS NULL OR s.merchant_id=$2) AND ($3::uuid IS NULL OR s.run_id=$3)
     AND ($4::text IS NULL OR s.no ILIKE $4 OR s.external_ref ILIKE $4 OR s.consignee_name ILIKE $4 OR s.consignee_phone ILIKE $4)
   ORDER BY s.created_at DESC, s.no DESC LIMIT $5`,
  [o.status || null, o.merchantId ?? null, o.runId ?? null, o.q?.trim() ? `%${o.q.trim().replace(/[%_]/g, "")}%` : null, o.limit ?? 300]).then((r) => r.rows);

export async function getShipment(c: Conn, id: string) {
  const shipment = await must(c.query<any>(
    `SELECT s.*, p.name AS merchant_name, r.no AS run_no, r.status AS run_status, d.name AS rider_name FROM dlv_shipments s JOIN parties p ON p.id=s.merchant_id
     LEFT JOIN dlv_runs r ON r.id=s.run_id LEFT JOIN drivers d ON d.id=r.driver_id WHERE s.id=$1`, [id]), "Parcel");
  const [events, collection, charges, docs] = await Promise.all([
    c.query<any>(`SELECT e.*, u.name AS actor FROM dlv_events e LEFT JOIN team_members u ON u.user_id=e.actor_user_id WHERE e.shipment_id=$1 ORDER BY e.effective_time, e.server_time`, [id]),
    c.query<any>(`SELECT k.*, st.no AS settlement_no, st.status AS settlement_status, rm.no AS remittance_no, rm.status AS remittance_status
      FROM dlv_collections k LEFT JOIN dlv_settlements st ON st.id=k.settlement_id LEFT JOIN dlv_remittances rm ON rm.id=k.remittance_id WHERE k.shipment_id=$1`, [id]),
    c.query<any>(`SELECT * FROM dlv_charges WHERE shipment_id=$1 ORDER BY created_at`, [id]),
    c.query<any>(`SELECT * FROM documents WHERE dlv_shipment_id=$1 ORDER BY created_at DESC`, [id]),
  ]);
  return { shipment, events: events.rows, collection: collection.rows[0] ?? null, charges: charges.rows, docs: docs.rows };
}

export const listRuns = (c: Conn, o: { driverId?: string | null; activeOnly?: boolean } = {}) => c.query<any>(
  `SELECT r.*, d.name AS rider_name,
     (SELECT count(*)::int FROM dlv_shipments s WHERE s.run_id=r.id) AS parcels,
     (SELECT count(*)::int FROM dlv_shipments s WHERE s.run_id=r.id AND s.status='delivered') AS delivered,
     (SELECT count(*)::int FROM dlv_shipments s WHERE s.run_id=r.id AND s.status IN ('undelivered','return_to_sender','returned')) AS failed,
     (SELECT coalesce(sum(s.cod_minor),0)::bigint FROM dlv_shipments s WHERE s.run_id=r.id AND s.status<>'cancelled') AS cod_minor,
     (SELECT coalesce(sum(k.amount_minor),0)::bigint FROM dlv_collections k JOIN dlv_shipments s ON s.id=k.shipment_id WHERE s.run_id=r.id) AS collected_minor
   FROM dlv_runs r JOIN drivers d ON d.id=r.driver_id
   WHERE ($1::uuid IS NULL OR r.driver_id=$1) AND (NOT $2 OR r.status IN ('planned','out')) ORDER BY r.run_date DESC, r.no DESC LIMIT 200`,
  [o.driverId ?? null, !!o.activeOnly]).then((r) => r.rows.map((x) => ({ ...x, cod_minor: Number(x.cod_minor), collected_minor: Number(x.collected_minor) })));

export async function getRun(c: Conn, id: string) {
  const run = await must(c.query<any>(`SELECT r.*, d.name AS rider_name FROM dlv_runs r JOIN drivers d ON d.id=r.driver_id WHERE r.id=$1`, [id]), "Run");
  const shipments = await listShipments(c, { runId: id, limit: 500 });
  return { run, shipments: shipments.reverse() };
}

export const listSettlements = (c: Conn) => c.query<any>(
  `SELECT st.*, d.name AS rider_name, u.name AS received_name, x.name AS decided_name, (SELECT count(*)::int FROM dlv_collections k WHERE k.settlement_id=st.id) AS parcels
   FROM dlv_settlements st JOIN drivers d ON d.id=st.driver_id LEFT JOIN team_members u ON u.user_id=st.received_by LEFT JOIN team_members x ON x.user_id=st.decided_by
   ORDER BY st.created_at DESC LIMIT 200`).then((r) => r.rows);

export const listRemittances = (c: Conn, merchantId?: string | null) => c.query<any>(
  `SELECT rm.*, p.name AS merchant_name, i.no AS invoice_no, (SELECT count(*)::int FROM dlv_collections k WHERE k.remittance_id=rm.id) AS parcels
   FROM dlv_remittances rm JOIN parties p ON p.id=rm.merchant_id LEFT JOIN invoices i ON i.id=rm.invoice_id
   WHERE ($1::uuid IS NULL OR rm.merchant_id=$1) ORDER BY rm.created_at DESC LIMIT 200`, [merchantId ?? null]).then((r) => r.rows);

export async function getRemittance(c: Conn, id: string) {
  const rm = await must(c.query<any>(`SELECT rm.*, p.name AS merchant_name, i.no AS invoice_no FROM dlv_remittances rm JOIN parties p ON p.id=rm.merchant_id LEFT JOIN invoices i ON i.id=rm.invoice_id WHERE rm.id=$1`, [id]), "Remittance");
  const lines = (await c.query<any>(
    `SELECT s.no, s.external_ref, s.delivered_at, k.amount_minor, st.no AS settlement_no FROM dlv_collections k JOIN dlv_shipments s ON s.id=k.shipment_id
     JOIN dlv_settlements st ON st.id=k.settlement_id WHERE k.remittance_id=$1 ORDER BY k.collected_at`, [id])).rows;
  return { rm, lines };
}

export const listRates = (c: Conn, merchantId?: string | null) => c.query<any>(
  `SELECT r.*, p.name AS merchant_name FROM dlv_rates r JOIN parties p ON p.id=r.merchant_id WHERE ($1::uuid IS NULL OR r.merchant_id=$1) ORDER BY p.name, r.effective_from DESC`, [merchantId ?? null]).then((r) => r.rows);

export const billingSummary = (c: Conn) => c.query<any>(
  `SELECT p.id, p.name, count(*) FILTER (WHERE NOT g.unrated) AS rated_lines, count(*) FILTER (WHERE g.unrated) AS unrated_lines,
     coalesce(sum(round(g.qty*g.unit_minor)) FILTER (WHERE NOT g.unrated),0)::bigint AS rated_minor
   FROM dlv_charges g JOIN parties p ON p.id=g.merchant_id WHERE g.invoice_id IS NULL GROUP BY p.id, p.name ORDER BY p.name`)
  .then((r) => r.rows.map((x) => ({ ...x, rated_lines: Number(x.rated_lines), unrated_lines: Number(x.unrated_lines), rated_minor: Number(x.rated_minor) })));

/** Variances the cash desk has accepted, newest first: what the company absorbed (negative) or found (positive). */
export const cashVariances = (c: Conn) => c.query<any>(
  `SELECT st.no, st.created_at, d.name AS rider_name, st.expected_minor, st.counted_minor, st.variance_minor, st.status, st.note
   FROM dlv_settlements st JOIN drivers d ON d.id=st.driver_id WHERE st.variance_minor <> 0 ORDER BY st.created_at DESC LIMIT 100`).then((r) => r.rows);

export async function deliveryOverview(c: Conn) {
  const n = async (sql: string) => Number((await c.query<any>(sql)).rows[0].n);
  const today = dubaiDay();
  return {
    awaiting: await n(`SELECT count(*) n FROM dlv_shipments WHERE status='new'`),
    out: await n(`SELECT count(*) n FROM dlv_shipments WHERE status='out_for_delivery'`),
    undelivered: await n(`SELECT count(*) n FROM dlv_shipments WHERE status='undelivered'`),
    toReturn: await n(`SELECT count(*) n FROM dlv_shipments WHERE status='return_to_sender'`),
    deliveredToday: await n(`SELECT count(*) n FROM dlv_shipments WHERE status='delivered' AND ((delivered_at AT TIME ZONE 'UTC') + interval '4 hours')::date = '${today}'::date`),
    late: await n(`SELECT count(*) n FROM dlv_shipments WHERE deliver_by < now() AND status IN ('new','assigned','out_for_delivery','undelivered')`),
    conflicts: await n(`SELECT count(*) n FROM dlv_events WHERE NOT applied AND server_time > now() - interval '7 days'`),
    toDecide: await n(`SELECT count(*) n FROM dlv_settlements WHERE status='pending_approval'`),
    unrated: await n(`SELECT count(*) n FROM dlv_charges WHERE unrated AND invoice_id IS NULL`),
    pendingPayouts: await n(`SELECT count(*) n FROM dlv_remittances WHERE status='pending_payment'`),
    cash: await cashInHand(c),
    remittable: await remittable(c),
    activeRuns: await listRuns(c, { activeOnly: true }),
    needsAction: (await c.query<any>(
      `SELECT s.id, s.no, s.status, s.last_failure, s.attempts, s.max_attempts, p.name AS merchant FROM dlv_shipments s JOIN parties p ON p.id=s.merchant_id
       WHERE s.status IN ('undelivered','return_to_sender') ORDER BY s.created_at LIMIT 15`)).rows,
  };
}

// ───────────────────────── rider app
export async function riderHome(c: Conn, driverId: string) {
  const runs = await listRuns(c, { driverId, activeOnly: true });
  const cash = (await c.query<any>(`SELECT count(*)::int AS parcels, coalesce(sum(amount_minor),0)::bigint AS amount_minor FROM dlv_collections WHERE driver_id=$1 AND settlement_id IS NULL`, [driverId])).rows[0];
  return { runs, cash: { parcels: cash.parcels, amount_minor: Number(cash.amount_minor) } };
}

// ───────────────────────── public tracking (no login; no personal data)
export const PUBLIC_STEP: Record<string, string> = {
  created: "Order received by the courier", assigned: "Assigned to a delivery run", out: "Out for delivery", deliver: "Delivered", fail: "Delivery attempt unsuccessful",
  reattempt: "Re-attempt scheduled", rts: "Being returned to the sender", returned: "Returned to the sender", cancel: "Cancelled",
};
export interface Tracking { no: string; merchant: string; status: string; emirate: string; cod_minor: number; attempts: number; steps: { at: string; text: string }[]; delivered_at: string | null }

/** Looks up by the unguessable token. Shows status and milestones only — never the consignee's name, phone, address or delivery code. */
export async function trackByToken(db: Db, token: string): Promise<Tracking | null> {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) return null;
  return db.system(async (c) => {
    const s = (await c.query<any>(`SELECT s.*, p.name AS merchant FROM dlv_shipments s JOIN parties p ON p.id=s.merchant_id WHERE s.track_token=$1`, [token])).rows[0];
    if (!s) return null;
    const ev = (await c.query<any>(`SELECT kind, effective_time FROM dlv_events WHERE shipment_id=$1 AND applied AND kind <> 'note' ORDER BY effective_time, server_time`, [s.id])).rows;
    return {
      no: s.no, merchant: s.merchant, status: s.status, emirate: s.emirate, cod_minor: Number(s.cod_minor), attempts: s.attempts,
      delivered_at: s.delivered_at ? new Date(s.delivered_at).toISOString() : null,
      steps: ev.filter((e) => PUBLIC_STEP[e.kind]).map((e) => ({ at: new Date(e.effective_time).toISOString(), text: PUBLIC_STEP[e.kind] })),
    };
  });
}
