import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, TAX_CODES, badRequest, forbidden, lineNet, toMinor } from "../lib/util.js";
import { assertWritable, consumeQuota } from "../platform/entitlements.js";
import { must, nextNumber, optNum, optStr, reqStr, today } from "./common.js";
import { issueInvoice } from "./finance.js";

/** Company timezone for UAE tenants is UTC+4 all year (no DST). Form values are local wall-clock. */
export const dubaiToIso = (local: string) => {
  if (!local) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(local)) return local;
  return `${local.length === 16 ? local + ":00" : local}+04:00`;
};
const needTs = (v: unknown, label: string) => {
  const s = dubaiToIso(String(v ?? ""));
  if (!s || Number.isNaN(Date.parse(s))) throw badRequest(`${label} is required.`);
  return s;
};

// ───────────────────────── fleet & people
export async function createVehicle(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "transport.write");
  await assertWritable(c, ctx.tenantId);
  const kg = optNum(f.capacity_kg);
  if (!kg || kg <= 0) throw badRequest("Capacity (kg) must be above zero.");
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO vehicles(tenant_id,reg_no,kind,capacity_kg,capacity_cbm) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.tenantId, reqStr(f.reg_no, "Registration", 30).toUpperCase(), optStr(f.kind, 40) ?? "truck", kg, optNum(f.capacity_cbm)]);
    await audit(c, ctx.tenantId, actorOf(ctx), "vehicle.created", "vehicle", r.rows[0].id);
    return r.rows[0].id;
  } catch (e: any) {
    if (String(e.message).includes("vehicles_tenant_id_reg_no_key")) throw new HttpError(409, "A vehicle with that registration already exists.", "conflict");
    throw e;
  }
}

export async function createDriver(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "transport.write");
  await assertWritable(c, ctx.tenantId);
  const r = await c.query<{ id: string }>(`INSERT INTO drivers(tenant_id,name,phone,licence_no) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.tenantId, reqStr(f.name, "Driver name", 120), optStr(f.phone, 40), optStr(f.licence_no, 60)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "driver.created", "driver", r.rows[0].id);
  return r.rows[0].id;
}

export async function addCompliance(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "transport.write");
  const type = f.subject_type === "driver" ? "driver" : "vehicle";
  const exists = await c.query(`SELECT 1 FROM ${type === "driver" ? "drivers" : "vehicles"} WHERE id=$1`, [f.subject_id]);
  if (!exists.rows.length) throw badRequest("Choose a vehicle or driver.");
  if (!f.expires_on) throw badRequest("Expiry date is required.");
  await c.query(`INSERT INTO compliance_items(tenant_id,subject_type,subject_id,kind,blocking,expires_on,note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.tenantId, type, f.subject_id, reqStr(f.kind, "Kind", 60), f.blocking !== "0", f.expires_on, optStr(f.note, 200)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "compliance.added", type, f.subject_id, { kind: f.kind, expires_on: f.expires_on });
}

export async function addMaintenance(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "transport.write");
  const s = needTs(f.starts_at, "Start"), e = needTs(f.ends_at, "End");
  if (Date.parse(e) <= Date.parse(s)) throw badRequest("Maintenance must end after it starts.");
  await must(c.query(`SELECT id FROM vehicles WHERE id=$1`, [f.vehicle_id]), "Vehicle");
  await c.query(`INSERT INTO maintenance_blocks(tenant_id,vehicle_id,starts_at,ends_at,reason) VALUES ($1,$2,$3,$4,$5)`,
    [ctx.tenantId, f.vehicle_id, s, e, reqStr(f.reason, "Reason", 200)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "maintenance.blocked", "vehicle", f.vehicle_id);
}

export const listVehicles = (c: Conn) => c.query<any>(
  `SELECT v.*, (SELECT min(expires_on) FROM compliance_items ci WHERE ci.subject_type='vehicle' AND ci.subject_id=v.id) AS next_expiry,
     (SELECT count(*)::int FROM compliance_items ci WHERE ci.subject_type='vehicle' AND ci.subject_id=v.id AND ci.blocking AND ci.expires_on < current_date) AS expired
   FROM vehicles v ORDER BY reg_no`).then((r) => r.rows);
export const listDrivers = (c: Conn) => c.query<any>(
  `SELECT d.*, (SELECT count(*)::int FROM compliance_items ci WHERE ci.subject_type='driver' AND ci.subject_id=d.id AND ci.blocking AND ci.expires_on < current_date) AS expired,
     (SELECT email FROM team_members m WHERE m.driver_id=d.id AND m.active LIMIT 1) AS login_email
   FROM drivers d WHERE active ORDER BY name`).then((r) => r.rows);
export const listCompliance = (c: Conn) => c.query<any>(
  `SELECT ci.*, coalesce(v.reg_no, d.name) AS subject_name, (ci.expires_on - current_date) AS days_left
   FROM compliance_items ci LEFT JOIN vehicles v ON ci.subject_type='vehicle' AND v.id=ci.subject_id LEFT JOIN drivers d ON ci.subject_type='driver' AND d.id=ci.subject_id
   ORDER BY ci.expires_on`).then((r) => r.rows);
export const listMaintenance = (c: Conn) => c.query<any>(
  `SELECT m.*, v.reg_no FROM maintenance_blocks m JOIN vehicles v ON v.id=m.vehicle_id WHERE m.ends_at > now() - interval '1 day' ORDER BY m.starts_at`).then((r) => r.rows);

// ───────────────────────── orders
export async function createOrder(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "transport.write");
  await assertWritable(c, ctx.tenantId);
  const party = await must(c.query<any>(`SELECT id,kind FROM parties WHERE id=$1`, [f.party_id]), "Customer");
  if (party.kind !== "customer") throw badRequest("Transport orders are placed by customers.");
  const rate = toMinor(f.rate || "0");
  if (rate <= 0) throw badRequest("Enter the agreed transport charge (above zero).");
  const taxCode = TAX_CODES[f.tax_code] ? f.tax_code : "SR5";
  const no = await nextNumber(c, ctx.tenantId, "transport_order", "TRO");
  const r = await c.query<{ id: string }>(
    `INSERT INTO transport_orders(tenant_id,no,party_id,pickup_address,delivery_address,cargo_desc,weight_kg,volume_cbm,ready_at,deliver_by,detention_rate_minor,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ctx.tenantId, no, f.party_id, reqStr(f.pickup_address, "Pickup address", 300), reqStr(f.delivery_address, "Delivery address", 300), optStr(f.cargo_desc, 500),
      optNum(f.weight_kg) ?? 0, optNum(f.volume_cbm) ?? 0, dubaiToIso(String(f.ready_at ?? "")), dubaiToIso(String(f.deliver_by ?? "")),
      f.detention_rate ? toMinor(f.detention_rate) : 0, ctx.userId]);
  await c.query(`INSERT INTO transport_order_charges(tenant_id,order_id,description,qty,unit_minor,tax_code) VALUES ($1,$2,'Transport',1,$3,$4)`, [ctx.tenantId, r.rows[0].id, rate, taxCode]);
  await audit(c, ctx.tenantId, actorOf(ctx), "transport_order.created", "transport_order", r.rows[0].id, { no });
  return { id: r.rows[0].id, no };
}

export async function addOrderCharge(c: Conn, ctx: Ctx, orderId: string, f: Record<string, any>) {
  require(ctx, "transport.write");
  const o = await must(c.query<any>(`SELECT status FROM transport_orders WHERE id=$1`, [orderId]), "Order");
  if (o.status === "cancelled") throw badRequest("Order is cancelled.");
  await c.query(`INSERT INTO transport_order_charges(tenant_id,order_id,description,qty,unit_minor,tax_code) VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.tenantId, orderId, reqStr(f.description, "Description", 200), optNum(f.qty) ?? 1, toMinor(f.amount), TAX_CODES[f.tax_code] ? f.tax_code : "SR5"]);
  await audit(c, ctx.tenantId, actorOf(ctx), "transport_order.charge_added", "transport_order", orderId);
}

export const listOrders = (c: Conn, partyId?: string | null) => c.query<any>(
  `SELECT o.*, p.name AS party_name, t.no AS trip_no,
     (SELECT coalesce(sum(round(qty*unit_minor)),0) FROM transport_order_charges ch WHERE ch.order_id=o.id) AS sell_minor
   FROM transport_orders o JOIN parties p ON p.id=o.party_id LEFT JOIN trips t ON t.id=o.trip_id
   WHERE ($1::uuid IS NULL OR o.party_id=$1) ORDER BY o.created_at DESC`, [partyId ?? null]).then((r) => r.rows);

export async function cancelOrder(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "transport.write");
  await must(c.query(`UPDATE transport_orders SET status='cancelled' WHERE id=$1 AND status='new' RETURNING id`, [id]), "Unplanned order");
  await audit(c, ctx.tenantId, actorOf(ctx), "transport_order.cancelled", "transport_order", id);
}

// ───────────────────────── assignment rules
export interface AssignmentInput {
  vehicleId?: string | null; driverId?: string | null; start: string; end: string;
  orderIds: string[]; excludeTripId?: string | null;
}

/** Capacity, availability, maintenance and compliance. Returns every reason at once so a dispatcher can fix them together. */
export async function checkAssignment(c: Conn, a: AssignmentInput): Promise<string[]> {
  const issues: string[] = [];
  const endDay = new Date(Date.parse(a.end)).toISOString().slice(0, 10);
  const orders = a.orderIds.length ? (await c.query<any>(`SELECT weight_kg, volume_cbm FROM transport_orders WHERE id = ANY($1::uuid[])`, [a.orderIds])).rows : [];
  const kg = orders.reduce((s, o) => s + Number(o.weight_kg), 0), cbm = orders.reduce((s, o) => s + Number(o.volume_cbm), 0);
  const range = `tstzrange($1::timestamptz, $2::timestamptz)`;
  if (a.vehicleId) {
    const v = await must(c.query<any>(`SELECT * FROM vehicles WHERE id=$1`, [a.vehicleId]), "Vehicle");
    if (v.status !== "active") issues.push(`Vehicle ${v.reg_no} is retired.`);
    if (kg > Number(v.capacity_kg)) issues.push(`Load ${kg} kg exceeds ${v.reg_no} capacity of ${Number(v.capacity_kg)} kg.`);
    if (v.capacity_cbm != null && cbm > Number(v.capacity_cbm)) issues.push(`Volume ${cbm} cbm exceeds ${v.reg_no} capacity of ${Number(v.capacity_cbm)} cbm.`);
    const m = await c.query<any>(`SELECT reason FROM maintenance_blocks WHERE vehicle_id=$3 AND tstzrange(starts_at, ends_at) && ${range}`, [a.start, a.end, a.vehicleId]);
    for (const x of m.rows) issues.push(`Vehicle ${v.reg_no} is blocked for maintenance (${x.reason}).`);
    const busy = await c.query<any>(`SELECT no FROM trips WHERE vehicle_id=$3 AND status IN ('planned','dispatched','in_progress') AND ($4::uuid IS NULL OR id<>$4) AND tstzrange(planned_start, planned_end) && ${range}`, [a.start, a.end, a.vehicleId, a.excludeTripId ?? null]);
    for (const x of busy.rows) issues.push(`Vehicle ${v.reg_no} is already on ${x.no} in that window.`);
    const comp = await c.query<any>(`SELECT kind, expires_on FROM compliance_items WHERE subject_type='vehicle' AND subject_id=$1 AND blocking AND expires_on < $2::date`, [a.vehicleId, endDay]);
    for (const x of comp.rows) issues.push(`Vehicle ${v.reg_no}: ${x.kind} expires ${String(x.expires_on).slice(0, 10)}, before the trip ends.`);
  }
  if (a.driverId) {
    const d = await must(c.query<any>(`SELECT * FROM drivers WHERE id=$1`, [a.driverId]), "Driver");
    if (!d.active) issues.push(`Driver ${d.name} is inactive.`);
    const busy = await c.query<any>(`SELECT no FROM trips WHERE driver_id=$3 AND status IN ('planned','dispatched','in_progress') AND ($4::uuid IS NULL OR id<>$4) AND tstzrange(planned_start, planned_end) && ${range}`, [a.start, a.end, a.driverId, a.excludeTripId ?? null]);
    for (const x of busy.rows) issues.push(`Driver ${d.name} is already on ${x.no} in that window.`);
    const comp = await c.query<any>(`SELECT kind, expires_on FROM compliance_items WHERE subject_type='driver' AND subject_id=$1 AND blocking AND expires_on < $2::date`, [a.driverId, endDay]);
    for (const x of comp.rows) issues.push(`Driver ${d.name}: ${x.kind} expires ${String(x.expires_on).slice(0, 10)}, before the trip ends.`);
  }
  return issues;
}

// ───────────────────────── trips
export interface TripInput {
  vehicle_id?: string; driver_id?: string; subcontractor_id?: string; subcontract_estimate?: string;
  planned_start: string; planned_end: string; est_km?: string; notes?: string; order_ids: string[];
}

export async function createTrip(c: Conn, ctx: Ctx, f: TripInput) {
  require(ctx, "transport.write");
  await assertWritable(c, ctx.tenantId);
  if (!f.order_ids.length) throw badRequest("Add at least one transport order to the trip.");
  const start = needTs(f.planned_start, "Planned start"), end = needTs(f.planned_end, "Planned end");
  if (Date.parse(end) <= Date.parse(start)) throw badRequest("The trip must end after it starts.");
  const sub = !!f.subcontractor_id;
  if (sub) {
    const p = await must(c.query<any>(`SELECT kind FROM parties WHERE id=$1`, [f.subcontractor_id]), "Subcontractor");
    if (p.kind !== "supplier") throw badRequest("A subcontractor must be a supplier record.");
    if (f.vehicle_id || f.driver_id) throw badRequest("A subcontracted trip has no own vehicle or driver.");
    if (toMinor(f.subcontract_estimate || "0") <= 0) throw badRequest("Enter the agreed subcontract cost estimate.");
  } else if (!f.vehicle_id || !f.driver_id) throw badRequest("Choose a vehicle and a driver, or a subcontractor.");

  const orders = (await c.query<any>(`SELECT * FROM transport_orders WHERE id = ANY($1::uuid[]) FOR UPDATE`, [f.order_ids])).rows;
  if (orders.length !== new Set(f.order_ids).size) throw badRequest("One or more orders were not found.");
  for (const o of orders) if (o.status !== "new" || o.trip_id) throw badRequest(`Order ${o.no} is ${o.status === "new" ? "already on a trip" : o.status}.`);
  const issues = sub ? [] : await checkAssignment(c, { vehicleId: f.vehicle_id, driverId: f.driver_id, start, end, orderIds: f.order_ids });
  if (issues.length) throw badRequest(issues.join(" "));

  const no = await nextNumber(c, ctx.tenantId, "trip", "TRP");
  // billable unit for this sector is the trip; the reference makes a retried request idempotent
  const t = await c.query<{ id: string }>(
    `INSERT INTO trips(tenant_id,no,vehicle_id,driver_id,subcontractor_id,subcontract_estimate_minor,planned_start,planned_end,est_km,notes,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ctx.tenantId, no, f.vehicle_id || null, f.driver_id || null, f.subcontractor_id || null, sub ? toMinor(f.subcontract_estimate!) : 0, start, end, optNum(f.est_km), optStr(f.notes, 500), ctx.userId]);
  const tripId = t.rows[0].id;
  await consumeQuota(c, ctx.tenantId, "trips_per_month", `trip:${tripId}`);

  // all pickups first, then deliveries, in the order the dispatcher listed the orders
  const ordered = f.order_ids.map((id) => orders.find((o) => o.id === id)!);
  let seq = 0;
  for (const o of ordered) await c.query(`INSERT INTO trip_legs(tenant_id,trip_id,order_id,seq,kind,address,planned_at) VALUES ($1,$2,$3,$4,'pickup',$5,$6)`, [ctx.tenantId, tripId, o.id, ++seq, o.pickup_address, o.ready_at]);
  for (const o of ordered) await c.query(`INSERT INTO trip_legs(tenant_id,trip_id,order_id,seq,kind,address,planned_at) VALUES ($1,$2,$3,$4,'delivery',$5,$6)`, [ctx.tenantId, tripId, o.id, ++seq, o.delivery_address, o.deliver_by]);
  await c.query(`UPDATE transport_orders SET status='planned', trip_id=$2 WHERE id = ANY($1::uuid[])`, [f.order_ids, tripId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "trip.created", "trip", tripId, { no, orders: f.order_ids.length, subcontracted: sub });
  return { id: tripId, no };
}

/** Dispatch re-checks everything: a licence may have lapsed or a maintenance block been added since planning. */
export async function dispatchTrip(c: Conn, ctx: Ctx, tripId: string) {
  require(ctx, "transport.write");
  const t = await must(c.query<any>(`SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [tripId]), "Trip");
  if (t.status !== "planned") throw badRequest(`Trip is ${t.status}.`);
  if (!t.subcontractor_id) {
    const orderIds = (await c.query<any>(`SELECT id FROM transport_orders WHERE trip_id=$1`, [tripId])).rows.map((r) => r.id);
    const issues = await checkAssignment(c, { vehicleId: t.vehicle_id, driverId: t.driver_id, start: new Date(t.planned_start).toISOString(), end: new Date(t.planned_end).toISOString(), orderIds, excludeTripId: tripId });
    if (issues.length) throw badRequest(`Cannot dispatch: ${issues.join(" ")}`);
    const login = await c.query(`SELECT 1 FROM memberships WHERE driver_id=$1 AND active`, [t.driver_id]);
    if (!login.rows.length) throw badRequest("The driver has no login yet. Invite the driver from Transport → Drivers so they can record events.");
  }
  await c.query(`UPDATE trips SET status='dispatched' WHERE id=$1`, [tripId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "trip.dispatched", "trip", tripId);
}

export async function cancelTrip(c: Conn, ctx: Ctx, tripId: string) {
  require(ctx, "transport.write");
  const t = await must(c.query<any>(`SELECT status FROM trips WHERE id=$1 FOR UPDATE`, [tripId]), "Trip");
  if (!["planned", "dispatched"].includes(t.status)) throw badRequest(`A ${t.status} trip cannot be cancelled.`);
  const ev = await c.query(`SELECT 1 FROM trip_events WHERE trip_id=$1 LIMIT 1`, [tripId]);
  if (ev.rows.length) throw badRequest("Driver events exist for this trip; it cannot be cancelled.");
  await c.query(`UPDATE trips SET status='cancelled' WHERE id=$1`, [tripId]);
  await c.query(`UPDATE transport_orders SET status='new', trip_id=NULL WHERE trip_id=$1`, [tripId]);
  await c.query(`DELETE FROM trip_legs WHERE trip_id=$1`, [tripId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "trip.cancelled", "trip", tripId);
}

export async function completeTrip(c: Conn, ctx: Ctx, tripId: string, f: { actual_km?: string; subcontract_actual?: string }) {
  require(ctx, "transport.write");
  const t = await must(c.query<any>(`SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [tripId]), "Trip");
  if (!["dispatched", "in_progress"].includes(t.status)) throw badRequest(`Trip is ${t.status}.`);
  const open = (await c.query<any>(`SELECT count(*)::int n FROM trip_legs WHERE trip_id=$1 AND status<>'done'`, [tripId])).rows[0].n;
  if (open) throw badRequest(`${open} stop(s) are not completed. Every stop needs arrival, departure and (for deliveries) proof of delivery.`);
  const actual = f.subcontract_actual ? toMinor(f.subcontract_actual) : null;
  await c.query(`UPDATE trips SET status='completed', completed_at=now(), actual_km=coalesce($2,actual_km), subcontract_actual_minor=coalesce($3,subcontract_actual_minor) WHERE id=$1`,
    [tripId, optNum(f.actual_km), actual]);
  await audit(c, ctx.tenantId, actorOf(ctx), "trip.completed", "trip", tripId);
}

export async function setSubcontractActual(c: Conn, ctx: Ctx, tripId: string, amount: string) {
  require(ctx, "transport.expense");
  await must(c.query(`UPDATE trips SET subcontract_actual_minor=$2 WHERE id=$1 AND subcontractor_id IS NOT NULL RETURNING id`, [tripId, toMinor(amount)]), "Subcontracted trip");
  await audit(c, ctx.tenantId, actorOf(ctx), "trip.subcontract_reconciled", "trip", tripId);
}

// ───────────────────────── driver events (offline-safe)
export interface DriverEvent {
  client_event_id: string; trip_id: string; leg_id?: string | null;
  kind: "arrive" | "depart" | "pod" | "exception" | "expense" | "note"; device_time: string; payload?: Record<string, any>;
}
export type EventOutcome = "applied" | "stored" | "duplicate" | "rejected";
export interface EventResult { client_event_id: string; outcome: EventOutcome; reason?: string }

const MAX_SKEW_MS = 5 * 60_000;

/**
 * Apply one driver event. Guarantees (blueprint §14/§30):
 *  - a client event id causes at most one server record, however many times it is synced;
 *  - device time is kept verbatim, an implausible clock is clamped and flagged;
 *  - events arriving late/out of order are reconciled (earliest arrival wins) and never overwrite
 *    proof of delivery, completed stops, or approved/rejected expenses.
 */
export async function applyDriverEvent(c: Conn, ctx: Ctx, ev: DriverEvent): Promise<EventResult> {
  const id = String(ev.client_event_id ?? "");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return { client_event_id: id, outcome: "rejected", reason: "invalid event id" };
  const kinds = ["arrive", "depart", "pod", "exception", "expense", "note"];
  if (!kinds.includes(ev.kind)) return { client_event_id: id, outcome: "rejected", reason: "unknown event kind" };
  const raw = Date.parse(ev.device_time);
  if (Number.isNaN(raw)) return { client_event_id: id, outcome: "rejected", reason: "invalid device time" };

  const isDriver = ctx.perms.has("driver.act"), isStaff = ctx.perms.has("transport.write");
  if (!isDriver && !isStaff) throw forbidden("Your role cannot record trip events.");
  if (ctx.readOnly) throw forbidden("This session is read-only (support access).");

  // serialise concurrent syncs of the same event id (retry storms, two tabs)
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${ctx.tenantId}:${id}`]);
  const dup = await c.query(`SELECT 1 FROM trip_events WHERE client_event_id=$1`, [id]);
  if (dup.rows.length) return { client_event_id: id, outcome: "duplicate" };

  const trip = (await c.query<any>(`SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [ev.trip_id])).rows[0];
  if (!trip) return { client_event_id: id, outcome: "rejected", reason: "unknown trip" };
  if (!isStaff && trip.driver_id !== ctx.driverId) throw forbidden("This trip is not assigned to you.");

  const now = Date.now();
  let eff = raw, notes: string[] = [];
  if (raw > now + MAX_SKEW_MS) { eff = now; notes.push("device clock ahead of server; server time used"); }
  else if (raw < now - 14 * 86400_000) { eff = now; notes.push("device time implausibly old; server time used"); }
  const effIso = new Date(eff).toISOString();
  const payload = ev.payload ?? {};
  let applied = false, resolution: string | null = null;

  const leg = ev.leg_id ? (await c.query<any>(`SELECT * FROM trip_legs WHERE id=$1 AND trip_id=$2 FOR UPDATE`, [ev.leg_id, ev.trip_id])).rows[0] : null;
  const live = ["dispatched", "in_progress"].includes(trip.status);
  const refuse = (why: string) => { applied = false; resolution = why; };

  if (["arrive", "depart", "pod"].includes(ev.kind) && !leg) refuse("stop not found on this trip");
  else if (["arrive", "depart", "pod"].includes(ev.kind) && !live && !(trip.status === "completed")) refuse(`trip is ${trip.status}`);
  else if (trip.status === "completed" && ev.kind !== "note") refuse("trip already completed");
  else if (ev.kind === "arrive") {
    if (leg.status === "done") refuse("stop already completed");
    else if (!leg.arrived_at) {
      await c.query(`UPDATE trip_legs SET arrived_at=$2, status='arrived' WHERE id=$1`, [leg.id, effIso]); applied = true;
      await c.query(`UPDATE trips SET status='in_progress' WHERE id=$1 AND status='dispatched'`, [trip.id]);
      await c.query(`UPDATE transport_orders SET status='in_progress' WHERE id=$1 AND status='planned'`, [leg.order_id]);
    } else if (eff < Date.parse(leg.arrived_at)) {
      await c.query(`UPDATE trip_legs SET arrived_at=$2 WHERE id=$1`, [leg.id, effIso]); applied = true; notes.push("earlier arrival adopted");
    } else refuse("arrival already recorded");
  } else if (ev.kind === "pod") {
    const name = String(payload.name ?? "").trim().slice(0, 120);
    if (leg.kind !== "delivery") refuse("proof of delivery applies to delivery stops");
    else if (!name) refuse("receiver name is required");
    else if (leg.pod_name) refuse("proof of delivery already recorded; original retained");
    else {
      const cap = (await c.query<any>(`SELECT capture_location FROM entities ORDER BY created_at LIMIT 1`)).rows[0]?.capture_location;
      const lat = cap ? optNum(payload.lat) : null, lng = cap ? optNum(payload.lng) : null;
      if (!cap && (payload.lat != null || payload.lng != null)) notes.push("location ignored: capture not enabled by company policy");
      await c.query(`UPDATE trip_legs SET pod_name=$2, pod_at=$3, pod_lat=$4, pod_lng=$5, arrived_at=coalesce(arrived_at,$3), status=CASE WHEN status='pending' THEN 'arrived' ELSE status END WHERE id=$1`,
        [leg.id, name, effIso, lat, lng]);
      applied = true;
    }
  } else if (ev.kind === "depart") {
    if (leg.status === "done") refuse("stop already completed");
    else if (!leg.arrived_at) refuse("no arrival recorded for this stop");
    else if (leg.kind === "delivery" && !leg.pod_name) refuse("proof of delivery is required before leaving a delivery stop");
    else {
      let dep = eff; if (dep < Date.parse(leg.arrived_at)) { dep = Date.parse(leg.arrived_at); notes.push("departure before arrival clamped to arrival"); }
      const mins = Math.round((dep - Date.parse(leg.arrived_at)) / 60000);
      await c.query(`UPDATE trip_legs SET departed_at=$2, status='done', detention_minutes=$3 WHERE id=$1`, [leg.id, new Date(dep).toISOString(), Math.max(0, mins - leg.free_minutes)]);
      applied = true;
      if (leg.kind === "delivery") {
        await c.query(`UPDATE transport_orders SET status='delivered', delivered_at=$2 WHERE id=$1 AND status IN ('planned','in_progress')`, [leg.order_id, new Date(dep).toISOString()]);
      }
    }
  } else if (ev.kind === "expense") {
    const kind = ["fuel", "toll", "parking", "other"].includes(payload.kind) ? payload.kind : "other";
    const amount = Math.round(Number(payload.amount) * 100);
    if (!(amount > 0) || amount > 50_000_00) refuse("invalid expense amount");
    else {
      await c.query(`INSERT INTO trip_expenses(tenant_id,trip_id,kind,amount_minor,note,client_event_id,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ctx.tenantId, trip.id, kind, amount, optStr(payload.note, 200), id, ctx.userId]);
      applied = true;
    }
  } else if (ev.kind === "exception") {
    const text = String(payload.text ?? "").trim().slice(0, 300);
    if (!text) refuse("describe the problem");
    else {
      await c.query(`INSERT INTO job_exceptions(tenant_id,title,detail,owner_id,due_at) VALUES ($1,$2,$3,$4, now() + interval '4 hours')`,
        [ctx.tenantId, `Trip ${trip.no}: ${text.slice(0, 120)}`, text, trip.created_by]);
      applied = true;
    }
  } else { applied = true; } // note

  const resolutionText = [resolution, ...notes].filter(Boolean).join("; ") || null;
  await c.query(
    `INSERT INTO trip_events(tenant_id,trip_id,leg_id,client_event_id,kind,device_time,effective_time,payload,applied,resolution,actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [ctx.tenantId, trip.id, leg?.id ?? null, id, ev.kind, new Date(raw).toISOString(), effIso, JSON.stringify(payload), applied, resolutionText, ctx.userId]);
  if (applied) await audit(c, ctx.tenantId, actorOf(ctx), `trip.event.${ev.kind}`, "trip", trip.id, { client_event_id: id });
  return { client_event_id: id, outcome: applied ? "applied" : "stored", reason: resolutionText ?? undefined };
}

/** Batch sync from a device that was offline: oldest first so arrivals are applied before departures. */
export async function syncDriverEvents(c: Conn, ctx: Ctx, events: DriverEvent[]): Promise<EventResult[]> {
  if (!Array.isArray(events) || events.length > 100) throw badRequest("Send between 1 and 100 events per sync.");
  const sorted = [...events].sort((a, b) => Date.parse(a.device_time) - Date.parse(b.device_time));
  const out: EventResult[] = [];
  for (const e of sorted) out.push(await applyDriverEvent(c, ctx, e));
  return out;
}

export async function decideExpense(c: Conn, ctx: Ctx, expenseId: string, approve: boolean) {
  require(ctx, "transport.expense");
  await assertWritable(c,ctx.tenantId);
  const x = await must(c.query<any>(`SELECT * FROM trip_expenses WHERE id=$1 FOR UPDATE`, [expenseId]), "Expense");
  if (x.status !== "recorded") throw badRequest(`Expense is already ${x.status}; decisions are final.`);
  if (x.recorded_by === ctx.userId) throw forbidden("Expenses cannot be approved by the person who recorded them.");
  let receiptId:string|null=null;
  if(approve&&x.evidence_required){const r=await must(c.query<any>(`SELECT r.id,d.trip_id,d.status,d.hold,d.kind FROM trip_expense_receipts r JOIN documents d ON d.id=r.document_id WHERE r.expense_id=$1 ORDER BY r.version DESC LIMIT 1`,[x.id]),'Current issued expense receipt');if(r.trip_id!==x.trip_id||r.status!=='issued'||r.hold||!['supplier_invoice','other'].includes(r.kind))throw badRequest('The current receipt is unavailable; review and link valid issued evidence before approval.');receiptId=r.id;}
  await c.query(`UPDATE trip_expenses SET status=$2, decided_by=$3,approved_receipt_id=$4 WHERE id=$1`, [expenseId, approve ? "approved" : "rejected", ctx.userId,receiptId]);
  await audit(c, ctx.tenantId, actorOf(ctx), approve ? "expense.approved" : "expense.rejected", "trip", x.trip_id, { expenseId,receipt_id:receiptId });
}

/** Detention: minutes beyond free time × the order's hourly rate, billable once per stop. */
export async function billDetention(c: Conn, ctx: Ctx, legId: string) {
  require(ctx, "transport.write");
  const leg = await must(c.query<any>(`SELECT l.*, o.detention_rate_minor, o.no AS order_no FROM trip_legs l JOIN transport_orders o ON o.id=l.order_id WHERE l.id=$1`, [legId]), "Stop");
  if (!(leg.detention_minutes > 0)) throw badRequest("No detention beyond free time on this stop.");
  if (!(Number(leg.detention_rate_minor) > 0)) throw badRequest("This order has no detention rate agreed.");
  const hours = Math.ceil(leg.detention_minutes / 60);
  const r = await c.query(`INSERT INTO transport_order_charges(tenant_id,order_id,description,qty,unit_minor,source_leg_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (source_leg_id) DO NOTHING RETURNING id`,
    [ctx.tenantId, leg.order_id, `Detention at ${leg.kind} (${leg.detention_minutes} min beyond ${leg.free_minutes} free)`, hours, leg.detention_rate_minor, legId]);
  if (!r.rows.length) throw badRequest("Detention for this stop has already been billed.");
  await audit(c, ctx.tenantId, actorOf(ctx), "detention.billed", "transport_order", leg.order_id, { legId, hours });
  return hours;
}

export async function invoiceOrder(c: Conn, ctx: Ctx, orderId: string, termsDays = 30) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const o = await must(c.query<any>(`SELECT * FROM transport_orders WHERE id=$1 FOR UPDATE`, [orderId]), "Order");
  if (o.status !== "delivered") throw badRequest("Only delivered orders (with proof of delivery) can be invoiced.");
  const charges = (await c.query<any>(`SELECT * FROM transport_order_charges WHERE order_id=$1 AND invoice_id IS NULL`, [orderId])).rows;
  if (!charges.length) throw badRequest("No uninvoiced charges on this order.");
  const ent = (await c.query<any>(`SELECT id FROM entities ORDER BY created_at LIMIT 1`)).rows[0];
  const r = await issueInvoice(c, ctx, {
    entityId: ent.id, partyId: o.party_id, transportOrderId: orderId, lines: charges.map((x) => ({ ...x, unit_minor: x.unit_minor })),
    markCharge: async (chargeId, invoiceId) => { await c.query(`UPDATE transport_order_charges SET invoice_id=$2 WHERE id=$1`, [chargeId, invoiceId]); },
  }, termsDays);
  await c.query(`UPDATE transport_orders SET financial_status='invoiced' WHERE id=$1 AND financial_status='open'`, [orderId]);
  return r;
}

// ───────────────────────── reading
export async function tripProfit(c: Conn, tripId: string) {
  const t = await must(c.query<any>(`SELECT * FROM trips WHERE id=$1`, [tripId]), "Trip");
  const revenue = Number((await c.query<any>(`SELECT coalesce(sum(round(ch.qty*ch.unit_minor)),0) n FROM transport_order_charges ch JOIN transport_orders o ON o.id=ch.order_id WHERE o.trip_id=$1`, [tripId])).rows[0].n);
  const exp = (await c.query<any>(`SELECT status, coalesce(sum(amount_minor),0) n FROM trip_expenses WHERE trip_id=$1 GROUP BY status`, [tripId])).rows;
  const sum = (s: string) => Number(exp.find((x) => x.status === s)?.n ?? 0);
  const subcontract = t.subcontractor_id ? Number(t.subcontract_actual_minor ?? t.subcontract_estimate_minor) : 0;
  const approved = sum("approved"), pending = sum("recorded");
  const cost = subcontract + approved + pending;
  const estimated = (t.subcontractor_id && t.subcontract_actual_minor == null) || pending > 0;
  return {
    revenue, subcontract, subcontractEstimated: !!t.subcontractor_id && t.subcontract_actual_minor == null,
    approvedExpenses: approved, unapprovedExpenses: pending, cost, margin: revenue - cost,
    marginBps: revenue ? Math.round(((revenue - cost) * 10000) / revenue) : 0,
    costPerKm: t.actual_km && Number(t.actual_km) > 0 ? Math.round(cost / Number(t.actual_km)) : null,
    reconciled: !estimated && t.status === "completed",
  };
}

export async function getTrip(c: Conn, id: string) {
  const trip = await must(c.query<any>(
    `SELECT t.*, v.reg_no, v.capacity_kg, d.name AS driver_name, s.name AS subcontractor_name FROM trips t
     LEFT JOIN vehicles v ON v.id=t.vehicle_id LEFT JOIN drivers d ON d.id=t.driver_id LEFT JOIN parties s ON s.id=t.subcontractor_id WHERE t.id=$1`, [id]), "Trip");
  const [legs, orders, events, expenses] = await Promise.all([
    c.query<any>(`SELECT l.*, o.no AS order_no, p.name AS customer FROM trip_legs l JOIN transport_orders o ON o.id=l.order_id JOIN parties p ON p.id=o.party_id WHERE l.trip_id=$1 ORDER BY l.seq`, [id]),
    c.query<any>(`SELECT o.*, p.name AS party_name FROM transport_orders o JOIN parties p ON p.id=o.party_id WHERE o.trip_id=$1`, [id]),
    c.query<any>(`SELECT e.*, l.kind AS leg_kind FROM trip_events e LEFT JOIN trip_legs l ON l.id=e.leg_id WHERE e.trip_id=$1 ORDER BY e.effective_time, e.server_time`, [id]),
    c.query<any>(`SELECT x.*, u.name AS recorder,r.document_id AS receipt_document_id FROM trip_expenses x LEFT JOIN team_members u ON u.user_id=x.recorded_by LEFT JOIN LATERAL(SELECT document_id FROM trip_expense_receipts WHERE expense_id=x.id AND (x.approved_receipt_id IS NULL OR id=x.approved_receipt_id) ORDER BY version DESC LIMIT 1) r ON true WHERE x.trip_id=$1 ORDER BY x.created_at`, [id]),
  ]);
  const kg = orders.rows.reduce((s, o) => s + Number(o.weight_kg), 0);
  return { trip, legs: legs.rows, orders: orders.rows, events: events.rows, expenses: expenses.rows, loadKg: kg, profit: await tripProfit(c, id) };
}

export const listTrips = (c: Conn, opts: { driverId?: string | null; activeOnly?: boolean } = {}) => c.query<any>(
  `SELECT t.*, v.reg_no, d.name AS driver_name, s.name AS subcontractor_name,
     (SELECT count(*)::int FROM trip_legs l WHERE l.trip_id=t.id) AS legs, (SELECT count(*)::int FROM trip_legs l WHERE l.trip_id=t.id AND l.status='done') AS legs_done
   FROM trips t LEFT JOIN vehicles v ON v.id=t.vehicle_id LEFT JOIN drivers d ON d.id=t.driver_id LEFT JOIN parties s ON s.id=t.subcontractor_id
   WHERE ($1::uuid IS NULL OR t.driver_id=$1) AND (NOT $2 OR t.status IN ('dispatched','in_progress'))
   ORDER BY t.planned_start DESC`, [opts.driverId ?? null, !!opts.activeOnly]).then((r) => r.rows);

export async function getOrder(c: Conn, id: string) {
  const order = await must(c.query<any>(`SELECT o.*, p.name AS party_name, t.no AS trip_no FROM transport_orders o JOIN parties p ON p.id=o.party_id LEFT JOIN trips t ON t.id=o.trip_id WHERE o.id=$1`, [id]), "Order");
  const [charges, legs, invoices, docs] = await Promise.all([
    c.query<any>(`SELECT * FROM transport_order_charges WHERE order_id=$1 ORDER BY description`, [id]),
    c.query<any>(`SELECT * FROM trip_legs WHERE order_id=$1 ORDER BY seq`, [id]),
    c.query<any>(`SELECT * FROM invoices WHERE transport_order_id=$1 ORDER BY issued_at`, [id]),
    c.query<any>(`SELECT * FROM documents WHERE transport_order_id=$1 ORDER BY created_at DESC`, [id]),
  ]);
  return { order, charges: charges.rows, legs: legs.rows, invoices: invoices.rows, docs: docs.rows };
}

/** Planning board data: what needs a trip, what is expiring, what is moving. */
export async function transportOverview(c: Conn) {
  const n = async (sql: string) => Number((await c.query<any>(sql)).rows[0].n);
  return {
    unplanned: (await c.query<any>(`SELECT o.id,o.no,o.pickup_address,o.delivery_address,o.deliver_by,p.name AS party FROM transport_orders o JOIN parties p ON p.id=o.party_id WHERE o.status='new' ORDER BY o.deliver_by NULLS LAST LIMIT 10`)).rows,
    active: await listTrips(c, { activeOnly: true }),
    expiring: (await listCompliance(c)).filter((x: any) => Number(x.days_left) <= 30),
    unbilled: (await c.query<any>(`SELECT o.id,o.no,p.name AS party FROM transport_orders o JOIN parties p ON p.id=o.party_id WHERE o.status='delivered' AND EXISTS (SELECT 1 FROM transport_order_charges ch WHERE ch.order_id=o.id AND ch.invoice_id IS NULL)`)).rows,
    pendingExpenses: await n(`SELECT count(*) n FROM trip_expenses WHERE status='recorded'`),
    lateDeliveries: await n(`SELECT count(*) n FROM transport_orders WHERE status IN ('new','planned','in_progress') AND deliver_by < now()`),
    conflicts: await n(`SELECT count(*) n FROM trip_events WHERE NOT applied AND server_time > now() - interval '7 days'`),
  };
}
