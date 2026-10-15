import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, forbidden, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";
import { parseCsv } from "./importer.js";

// ───────────── GPS (consent-based)
/** The driver, not the office, grants or withdraws permission to be located. Withdrawal stops acceptance at once. */
export async function setLocationConsent(c: Conn, ctx: Ctx, grant: boolean) {
  require(ctx, "driver.act");
  if (!ctx.driverId) throw forbidden("Only a driver can grant location sharing.");
  await c.query(
    `INSERT INTO driver_location_consent(tenant_id,driver_id,granted_by,granted_at,revoked_at) VALUES ($1,$2,$3,now(),$4)
     ON CONFLICT (tenant_id,driver_id) DO UPDATE SET granted_by=$3, granted_at=CASE WHEN $4::timestamptz IS NULL THEN now() ELSE driver_location_consent.granted_at END, revoked_at=$4`,
    [ctx.tenantId, ctx.driverId, ctx.userId, grant ? null : new Date().toISOString()]);
  await audit(c, ctx.tenantId, actorOf(ctx), grant ? "driver.location_consent_granted" : "driver.location_consent_revoked", "driver", ctx.driverId);
}
export async function locationConsent(c: Conn, driverId: string | null) {
  if (!driverId) return false;
  const r = (await c.query<any>(`SELECT revoked_at FROM driver_location_consent WHERE driver_id=$1`, [driverId])).rows[0];
  return !!r && !r.revoked_at;
}

export interface PositionIn { lat: number | string; lng: number | string; accuracy_m?: number | string; speed_kmh?: number | string; device_time: string }
/** Batch from the phone. Only the assigned driver, only on a live trip, only with active consent; duplicates are harmless. */
export async function recordPositions(c: Conn, ctx: Ctx, tripId: string, points: PositionIn[]) {
  require(ctx, "driver.act");
  if (!Array.isArray(points) || !points.length || points.length > 100) throw badRequest("Send between 1 and 100 positions.");
  const trip = await must(c.query<any>(`SELECT id, driver_id, status FROM trips WHERE id=$1`, [recordId(tripId)]), "Trip");
  if (!ctx.driverId || trip.driver_id !== ctx.driverId) throw new HttpError(403, "This trip is not assigned to you.", "not_yours");
  if (!["dispatched", "in_progress"].includes(trip.status)) return { stored: 0, ignored: points.length, reason: "trip is not live" };
  if (!(await locationConsent(c, ctx.driverId))) return { stored: 0, ignored: points.length, reason: "location sharing is off" };
  const now = Date.now();
  let stored = 0, ignored = 0;
  for (const p of points) {
    const lat = Number(p.lat), lng = Number(p.lng), t = Date.parse(p.device_time);
    const acc = p.accuracy_m === undefined || p.accuracy_m === "" ? null : Math.round(Number(p.accuracy_m)), spd = p.speed_kmh === undefined || p.speed_kmh === "" ? null : Number(p.speed_kmh);
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) || Number.isNaN(t) || (acc !== null && !(acc >= 0 && acc <= 100000)) || (spd !== null && !(spd >= 0 && spd <= 400)) || t < now - 24 * 3600_000 || t > now + 5 * 60_000) { ignored++; continue; }
    const r = await c.query(
      `INSERT INTO trip_positions(tenant_id,trip_id,driver_id,lat,lng,accuracy_m,speed_kmh,device_time,effective_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (tenant_id,trip_id,device_time) DO NOTHING RETURNING 1`,
      [ctx.tenantId, trip.id, ctx.driverId, lat.toFixed(6), lng.toFixed(6), acc, spd, new Date(t).toISOString()]);
    if (r.rows.length) stored++; else ignored++;
  }
  return { stored, ignored };
}
/** Live board for dispatchers: the newest position of every live trip and its age. */
export async function latestPositions(c: Conn, ctx: Ctx) {
  require(ctx, "transport.write");
  return (await c.query<any>(
    `SELECT DISTINCT ON (t.id) t.id AS trip_id, t.no, t.status, d.name AS driver, v.reg_no, p.lat, p.lng, p.accuracy_m, p.speed_kmh, p.effective_time,
       extract(epoch FROM (now() - p.effective_time))::int AS age_s
     FROM trips t JOIN trip_positions p ON p.trip_id=t.id JOIN drivers d ON d.id=t.driver_id LEFT JOIN vehicles v ON v.id=t.vehicle_id
     WHERE t.status IN ('dispatched','in_progress') ORDER BY t.id, p.effective_time DESC`)).rows;
}
export async function tripTrail(c: Conn, ctx: Ctx, tripId: string, limit = 500) {
  require(ctx, "transport.write");
  return (await c.query<any>(`SELECT lat, lng, speed_kmh, effective_time FROM trip_positions WHERE trip_id=$1 ORDER BY effective_time DESC LIMIT $2`, [recordId(tripId), Math.min(2000, limit)])).rows;
}
/** Straight-line distance travelled from the recorded trail (a plausibility check against claimed km, not an odometer). */
export const trailKm = (pts: { lat: number | string; lng: number | string }[]) => pts.slice(1).reduce((a, p, i) => a + haversineKm(Number(pts[i].lat), Number(pts[i].lng), Number(p.lat), Number(p.lng)), 0);

// ───────────── route optimisation
export const haversineKm = (a1: number, o1: number, a2: number, o2: number) => {
  const r = Math.PI / 180, dLat = (a2 - a1) * r, dLng = (o2 - o1) * r, h = Math.sin(dLat / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};
export interface Stop { id: string; lat: number; lng: number; order: string; kind: "pickup" | "delivery" }
const valid = (seq: Stop[]) => { const seen = new Set<string>(); for (const s of seq) { if (s.kind === "delivery" && !seen.has(s.order) && seq.some((x) => x.order === s.order && x.kind === "pickup")) return false; if (s.kind === "pickup") seen.add(s.order); } return true; };
export const routeKm = (start: { lat: number; lng: number } | null, seq: Stop[]) => {
  let km = 0, prev = start;
  for (const s of seq) { if (prev) km += haversineKm(prev.lat, prev.lng, s.lat, s.lng); prev = s; }
  return km;
};
/**
 * Nearest-neighbour start (respecting pickup-before-delivery of each order) improved by 2-opt / relocation passes that keep the
 * precedence valid. Straight-line distances: a planning aid, not turn-by-turn routing with traffic.
 */
export function optimiseRoute(stops: Stop[], start: { lat: number; lng: number } | null) {
  const left = [...stops], seq: Stop[] = [];
  let cur = start ?? (left[0] ? { lat: left[0].lat, lng: left[0].lng } : null);
  while (left.length) {
    const ok = left.filter((s) => valid([...seq, s]));
    const cand = ok.length ? ok : left;
    let best = cand[0], bd = Infinity;
    for (const s of cand) { const d = cur ? haversineKm(cur.lat, cur.lng, s.lat, s.lng) : 0; if (d < bd) { bd = d; best = s; } }
    seq.push(best); left.splice(left.indexOf(best), 1); cur = best;
  }
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < seq.length - 1; i++) for (let j = i + 1; j < seq.length; j++) {
      const cand = [...seq.slice(0, i), ...seq.slice(i, j + 1).reverse(), ...seq.slice(j + 1)];
      if (valid(cand) && routeKm(start, cand) + 1e-9 < routeKm(start, seq)) { seq.splice(0, seq.length, ...cand); improved = true; }
    }
  }
  return { sequence: seq, km: routeKm(start, seq) };
}
export async function setLegCoordinates(c: Conn, ctx: Ctx, legId: string, lat: unknown, lng: unknown) {
  require(ctx, "transport.write");
  const la = Number(lat), lo = Number(lng);
  if (!(la >= -90 && la <= 90 && lo >= -180 && lo <= 180) || lat === "" || lng === "") throw badRequest("Latitude must be −90..90 and longitude −180..180.");
  await must(c.query(`UPDATE trip_legs SET lat=$2, lng=$3, geo_source='manual', geo_label=NULL WHERE id=$1 AND status='pending' RETURNING id`, [recordId(legId), la.toFixed(6), lo.toFixed(6)]), "Pending stop");
  await audit(c, ctx.tenantId, actorOf(ctx), "trip_leg.coordinates_set", "trip_leg", legId);
}
/** Propose (or apply) a better order for the trip's pending stops. Done stops are never moved; every pending stop needs coordinates. */
export async function optimiseTrip(c: Conn, ctx: Ctx, tripId: string, apply = false, start?: { lat: number; lng: number } | null) {
  require(ctx, "transport.write");
  const trip = await must(c.query<any>(`SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [recordId(tripId)]), "Trip");
  if (["completed", "cancelled"].includes(trip.status)) throw badRequest(`Trip is ${trip.status}.`);
  const legs = (await c.query<any>(`SELECT * FROM trip_legs WHERE trip_id=$1 ORDER BY seq`, [trip.id])).rows;
  const pending = legs.filter((l) => l.status === "pending");
  if (pending.length < 3) throw badRequest("Route optimisation needs at least three pending stops.");
  const missing = pending.filter((l) => l.lat === null);
  if (missing.length) throw badRequest(`Add coordinates for: ${missing.map((l) => l.address.slice(0, 40)).join("; ")}.`);
  const stops: Stop[] = pending.map((l) => ({ id: l.id, lat: Number(l.lat), lng: Number(l.lng), order: l.order_id, kind: l.kind }));
  // a delivery whose pickup already happened is free; only pending pickups constrain pending deliveries
  const from = start ?? (() => { const done = legs.filter((l) => l.status !== "pending" && l.lat !== null).pop(); return done ? { lat: Number(done.lat), lng: Number(done.lng) } : null; })();
  const before = routeKm(from, stops), best = optimiseRoute(stops, from);
  const result = { before_km: Math.round(before * 10) / 10, after_km: Math.round(best.km * 10) / 10, sequence: best.sequence.map((s) => s.id), saved_km: Math.round((before - best.km) * 10) / 10 };
  if (apply) {
    await assertWritable(c, ctx.tenantId);
    const base = Math.min(...pending.map((l) => l.seq));
    const seqs = pending.map((l) => l.seq).sort((a, b) => a - b);
    for (const [i, id] of best.sequence.map((s) => s.id).entries()) await c.query(`UPDATE trip_legs SET seq=$2 WHERE id=$1`, [id, seqs[i] ?? base + i]);
    await audit(c, ctx.tenantId, actorOf(ctx), "trip.route_optimised", "trip", trip.id, { before_km: result.before_km, after_km: result.after_km });
  }
  return result;
}

// ───────────── fuel-card and Salik statement feeds
const normPlate = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");
function parseWhen(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) { const tz = m[7] ? (m[7] === "Z" ? "Z" : m[7].length === 5 ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : m[7]) : "+04:00"; const t = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}${tz}`); return Number.isNaN(t.getTime()) ? null : t.toISOString(); }
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (m) { const t = new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${(m[4] ?? "00").padStart(2, "0")}:${m[5] ?? "00"}:00+04:00`); return Number.isNaN(t.getTime()) ? null : t.toISOString(); }
  return null;
}
/**
 * Import a fuel-card or Salik statement CSV (header required: reference, date, plate, amount; optional litres, description).
 * Lines carry the provider's own reference, so overlapping statements never double-count. Plate → vehicle, vehicle + time → trip.
 */
export async function importFeed(c: Conn, ctx: Ctx, kind: string, label: string, csv: string) {
  require(ctx, "transport.expense");
  await assertWritable(c, ctx.tenantId);
  if (!["fuel", "salik"].includes(kind)) throw badRequest("Choose fuel card or Salik.");
  const rows = parseCsv(csv);
  if (rows.length < 2 || rows.length > 5001) throw badRequest("Provide a header and between 1 and 5,000 lines.");
  const head = rows[0].map((h) => h.trim().toLowerCase()), col = (n: string) => head.indexOf(n);
  const iRef = col("reference"), iDate = col("date"), iPlate = col("plate"), iAmt = col("amount"), iQty = col("litres"), iDesc = col("description");
  if ([iRef, iDate, iPlate, iAmt].some((i) => i < 0)) throw badRequest("Header must include reference, date, plate and amount.");
  const hash = sha256(rows.map((r) => r.map((x) => x.trim()).join("|")).join("\n"));
  if ((await c.query(`SELECT 1 FROM transport_feed_imports WHERE source_hash=$1`, [hash])).rows.length) throw new HttpError(409, "This statement was already imported.", "conflict");
  const parsed = rows.slice(1).map((r, i) => {
    const when = parseWhen(r[iDate] ?? ""), amt = Math.round(Number((r[iAmt] ?? "").replace(/,/g, "")) * 100), plate = normPlate(r[iPlate] ?? ""), ref = (r[iRef] ?? "").trim();
    if (!ref || !when || !plate || !(amt > 0) || Number.isNaN(amt)) throw badRequest(`Line ${i + 2}: reference, date, plate and a positive amount are required.`);
    const qty = iQty >= 0 && (r[iQty] ?? "").trim() ? Number(r[iQty]) : null;
    return { ref: ref.slice(0, 80), when, plate, amt, qty: qty !== null && qty > 0 ? qty : null, desc: (iDesc >= 0 ? r[iDesc] ?? "" : "").trim().slice(0, 200) };
  });
  const imp = (await c.query<{ id: string }>(`INSERT INTO transport_feed_imports(tenant_id,kind,label,source_hash,line_count,imported_by) VALUES ($1,$2,$3,$4,0,$5) RETURNING id`, [ctx.tenantId, kind, reqStr(label, "Statement label", 120), hash, ctx.userId])).rows[0].id;
  const vehicles = (await c.query<any>(`SELECT id, reg_no FROM vehicles`)).rows.map((v) => ({ id: v.id as string, key: normPlate(v.reg_no) }));
  let added = 0, dup = 0, matched = 0;
  for (const l of parsed) {
    if ((await c.query(`SELECT 1 FROM transport_feed_lines WHERE kind=$1 AND reference=$2`, [kind, l.ref])).rows.length) { dup++; continue; }
    const veh = vehicles.find((v) => v.key === l.plate);
    const trip = veh ? (await c.query<any>(
      `SELECT id FROM trips WHERE vehicle_id=$1 AND status IN ('dispatched','in_progress','completed') AND $2::timestamptz BETWEEN planned_start - interval '2 hours' AND coalesce(completed_at, planned_end) + interval '6 hours'
       ORDER BY planned_start DESC LIMIT 2`, [veh.id, l.when])).rows : [];
    const status = veh ? (trip.length === 1 ? "matched" : "vehicle_only") : "unmatched";
    await c.query(`INSERT INTO transport_feed_lines(tenant_id,import_id,kind,reference,occurred_at,plate,amount_minor,quantity,detail,vehicle_id,trip_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.tenantId, imp, kind, l.ref, l.when, l.plate, l.amt, l.qty, l.desc, veh?.id ?? null, trip.length === 1 ? trip[0].id : null, status]);
    added++; if (status === "matched") matched++;
  }
  await c.query(`UPDATE transport_feed_imports SET line_count=$2, duplicate_count=$3 WHERE id=$1`, [imp, added, dup]);
  await audit(c, ctx.tenantId, actorOf(ctx), "transport_feed.imported", "transport_feed_import", imp, { kind, added, dup, matched });
  return { id: imp, added, duplicates: dup, matched };
}
/** Create unapproved trip expenses from matched lines, once each. They still follow the normal receipt-evidence approval. */
export async function postFeedExpenses(c: Conn, ctx: Ctx) {
  require(ctx, "transport.expense");
  await assertWritable(c, ctx.tenantId);
  const lines = (await c.query<any>(`SELECT * FROM transport_feed_lines WHERE status='matched' AND expense_id IS NULL ORDER BY occurred_at FOR UPDATE`)).rows;
  let posted = 0;
  for (const l of lines) {
    const kind = l.kind === "fuel" ? "fuel" : "toll";
    const e = await c.query<{ id: string }>(
      `INSERT INTO trip_expenses(tenant_id,trip_id,kind,amount_minor,note,client_event_id,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,client_event_id) DO NOTHING RETURNING id`,
      [ctx.tenantId, l.trip_id, kind, l.amount_minor, `${l.kind === "fuel" ? "Fuel card" : "Salik"} ${l.reference}${l.detail ? ` · ${l.detail}` : ""}`.slice(0, 200), `feed:${l.id}`, ctx.userId]);
    const id = e.rows[0]?.id ?? (await c.query<any>(`SELECT id FROM trip_expenses WHERE client_event_id=$1`, [`feed:${l.id}`])).rows[0].id;
    await c.query(`UPDATE transport_feed_lines SET status='posted', expense_id=$2, decided_by=$3 WHERE id=$1`, [l.id, id, ctx.userId]);
    posted++;
  }
  if (posted) await audit(c, ctx.tenantId, actorOf(ctx), "transport_feed.posted", "tenant", ctx.tenantId, { posted });
  return posted;
}
/** Assign an unmatched/vehicle-only line to a trip by hand, or set it aside with a reason. */
export async function resolveFeedLine(c: Conn, ctx: Ctx, lineId: string, f: { trip_id?: string; ignore?: string }) {
  require(ctx, "transport.expense");
  const l = await must(c.query<any>(`SELECT * FROM transport_feed_lines WHERE id=$1 FOR UPDATE`, [recordId(lineId)]), "Statement line");
  if (!["unmatched", "vehicle_only"].includes(l.status)) throw badRequest(`This line is already ${l.status}.`);
  if (f.ignore) await c.query(`UPDATE transport_feed_lines SET status='ignored', note=$2, decided_by=$3 WHERE id=$1`, [l.id, reqStr(f.ignore, "Reason", 300), ctx.userId]);
  else {
    const t = await must(c.query<any>(`SELECT id FROM trips WHERE id=$1 AND vehicle_id IS NOT NULL`, [f.trip_id]), "Trip");
    await c.query(`UPDATE transport_feed_lines SET status='matched', trip_id=$2, decided_by=$3 WHERE id=$1`, [l.id, t.id, ctx.userId]);
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "transport_feed.resolved", "transport_feed_line", l.id);
}
export const feedWorkspace = async (c: Conn) => ({
  imports: (await c.query<any>(`SELECT * FROM transport_feed_imports ORDER BY created_at DESC LIMIT 30`)).rows,
  open: (await c.query<any>(`SELECT l.*, v.reg_no FROM transport_feed_lines l LEFT JOIN vehicles v ON v.id=l.vehicle_id WHERE l.status IN ('matched','vehicle_only','unmatched') ORDER BY l.occurred_at DESC LIMIT 300`)).rows,
  trips: (await c.query<any>(`SELECT t.id, t.no, v.reg_no FROM trips t JOIN vehicles v ON v.id=t.vehicle_id WHERE t.status IN ('dispatched','in_progress','completed') ORDER BY t.planned_start DESC LIMIT 100`)).rows,
});
