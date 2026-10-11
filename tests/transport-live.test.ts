import { describe, it, expect, beforeAll } from "vitest";
import type { Db, Conn } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import { permsFor, type Ctx } from "../src/lib/perms.js";
import { createParty } from "../src/ops/crm.js";
import { createDriver, createOrder, createTrip, createVehicle, dispatchTrip, getTrip, type DriverEvent } from "../src/ops/transport.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { importFeed, latestPositions, locationConsent, optimiseRoute, optimiseTrip, postFeedExpenses, recordPositions, resolveFeedLine, routeKm, setLegCoordinates, setLocationConsent, tripTrail, trailKm, feedWorkspace } from "../src/ops/transport-live.js";
import { verifyInvariants } from "../src/platform/invariants.js";
import { processDataMinimisation, setRetentionPolicy } from "../src/ops/privacy-retention.js";
let db: Db;
beforeAll(async () => { db = await freshDb(); });
const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60000).toISOString();
const dubai = (offsetH: number) => new Date(Date.now() + offsetH * 3600000 + 4 * 3600000).toISOString().slice(0, 16);   // wall-clock in UTC+4

async function fleet(opts: { kg?: number } = {}) {
  const t = await newTenant(db, undefined, ["road-transport"]);
  const r = await db.tenant(t.tenantId, async (c) => {
    const cust = await createParty(c, t.ctx, { kind: "customer", name: "Cust" });
    const veh = await createVehicle(c, t.ctx, { reg_no: "dxb a 1234", capacity_kg: opts.kg ?? 3000, capacity_cbm: 20 });
    const drv = await createDriver(c, t.ctx, { name: "Imran", phone: "050" });
    const token = await invite(c, t.ctx, { email: `drv-${Date.now()}-${Math.random()}@x.com`, roles: ["driver"], driver_id: drv });
    return { cust, veh, drv, token };
  });
  const acc = await acceptInvite(db, r.token, { name: "Imran", password: "driver-password-1" });
  const driverCtx: Ctx = { userId: acc.userId, tenantId: t.tenantId, roles: ["driver"], perms: permsFor(["driver"]), partyId: null, driverId: r.drv, readOnly: false, supportStaffId: null };
  return { t, ...r, driverCtx };
}
const order = (t: any, cust: string, o: Record<string, any> = {}) =>
  db.tenant(t.tenantId, (c) => createOrder(c, t.ctx, { party_id: cust, pickup_address: "Jebel Ali", delivery_address: "Dubai Marina", cargo_desc: "Boxes", weight_kg: 800, volume_cbm: 4, rate: "600", detention_rate: "100", ...o }));
const trip = (t: any, f: any, orderIds: string[]) =>
  db.tenant(t.tenantId, (c) => createTrip(c, t.ctx, { planned_start: dubai(1), planned_end: dubai(6), order_ids: orderIds, ...f }));
const ev = (tripId: string, kind: DriverEvent["kind"], legId: string | null, over: Partial<DriverEvent> = {}): DriverEvent =>
  ({ client_event_id: `ev-${Math.random().toString(36).slice(2)}-${Date.now()}`, trip_id: tripId, leg_id: legId, kind, device_time: iso(0), payload: {}, ...over });


const live = async (n = 1) => {
  const f = await fleet();
  const orders = [];
  for (let i = 0; i < n; i++) orders.push(await order(f.t, f.cust));
  const tr = await trip(f.t, { vehicle_id: f.veh, driver_id: f.drv }, orders.map((o) => o.id));
  await db.tenant(f.t.tenantId, (c) => dispatchTrip(c, f.t.ctx, tr.id));
  return { ...f, trip: tr };
};
const run = <T>(f: { t: any }, fn: (c: Conn) => Promise<T>) => db.tenant(f.t.tenantId, fn);

describe("consent-based GPS", () => {
  it("records only with the driver's own consent, for the assigned live trip, and stops when consent is withdrawn", async () => {
    const f = await live();
    const pt = (i: number, over: Record<string, any> = {}) => ({ lat: 25.2 + i / 1000, lng: 55.27, accuracy_m: 8, speed_kmh: 40, device_time: iso(-i), ...over });
    expect((await run(f, (c) => recordPositions(c, f.driverCtx, f.trip.id, [pt(1)]))).reason).toMatch(/off/);
    await run(f, (c) => setLocationConsent(c, f.driverCtx, true));
    expect(await run(f, (c) => locationConsent(c, f.drv))).toBe(true);
    const r = await run(f, (c) => recordPositions(c, f.driverCtx, f.trip.id, [pt(3), pt(2), pt(2), pt(1, { lat: 95 }), pt(1, { device_time: iso(60) }), pt(0)]));
    expect(r).toEqual({ stored: 3, ignored: 3 });                      // duplicate time, impossible latitude, future time
    const other = await live();
    await expect(run(other, (c) => recordPositions(c, other.driverCtx, f.trip.id, [pt(0)]))).rejects.toThrow(/not assigned|not found/i);
    const board = await run(f, (c) => latestPositions(c, f.t.ctx));
    expect(board.length).toBe(1);
    expect(Number(board[0].lat)).toBeCloseTo(25.2, 3);
    const trail = await run(f, (c) => tripTrail(c, f.t.ctx, f.trip.id));
    expect(trail.length).toBe(3);
    expect(trailKm(trail.slice().reverse())).toBeGreaterThan(0);
    await run(f, (c) => setLocationConsent(c, f.driverCtx, false));
    expect((await run(f, (c) => recordPositions(c, f.driverCtx, f.trip.id, [pt(0, { device_time: iso(-0.5) })]))).reason).toMatch(/off/);
    await expect(run(f, (c) => setLocationConsent(c, f.t.ctx, true))).rejects.toThrow();     // an office user cannot consent for a driver
  });
});

describe("route optimisation", () => {
  it("never puts a delivery before its pickup and shortens a bad order", () => {
    const stops = [
      { id: "far-del", lat: 25.0, lng: 55.5, order: "A", kind: "delivery" as const },
      { id: "near-pick", lat: 25.2, lng: 55.27, order: "A", kind: "pickup" as const },
      { id: "mid", lat: 25.21, lng: 55.28, order: "B", kind: "pickup" as const },
      { id: "mid-del", lat: 25.3, lng: 55.3, order: "B", kind: "delivery" as const },
    ];
    const start = { lat: 25.2, lng: 55.26 };
    const bad = [stops[0], stops[3], stops[1], stops[2]];
    const best = optimiseRoute(stops, start);
    const ids = best.sequence.map((s) => s.id);
    expect(ids.indexOf("near-pick")).toBeLessThan(ids.indexOf("far-del"));
    expect(ids.indexOf("mid")).toBeLessThan(ids.indexOf("mid-del"));
    expect(best.km).toBeLessThanOrEqual(routeKm(start, bad));
  });
  it("reorders only pending stops of a trip, needs coordinates, and audits the change", async () => {
    const f = await live(3);
    const detail = await run(f, (c) => getTrip(c, f.trip.id));
    const legs = detail.legs as any[];
    await expect(run(f, (c) => optimiseTrip(c, f.t.ctx, f.trip.id))).rejects.toThrow(/coordinates/);
    const spots: [number, number][] = [[25.0, 55.0], [25.5, 55.5], [25.01, 55.01], [25.49, 55.49], [25.02, 55.02], [25.48, 55.48]];
    for (const [i, l] of legs.entries()) await run(f, (c) => setLegCoordinates(c, f.t.ctx, l.id, spots[i % 6][0], spots[i % 6][1]));
    await expect(run(f, (c) => setLegCoordinates(c, f.t.ctx, legs[0].id, 120, 0))).rejects.toThrow(/Latitude/);
    const plan = await run(f, (c) => optimiseTrip(c, f.t.ctx, f.trip.id, false, { lat: 25.0, lng: 55.0 }));
    expect(plan.after_km).toBeLessThanOrEqual(plan.before_km);
    await run(f, (c) => optimiseTrip(c, f.t.ctx, f.trip.id, true, { lat: 25.0, lng: 55.0 }));
    const after = ((await run(f, (c) => getTrip(c, f.trip.id))).legs as any[]).map((l) => l.id);
    expect(after).toEqual(plan.sequence);
    expect(Number((await run(f, (c) => c.query<any>(`SELECT count(*) n FROM audit_log WHERE action='trip.route_optimised'`))).rows[0].n)).toBe(1);
  });
});

describe("fuel-card and Salik feeds", () => {
  it("matches plate and time to the trip, never double-counts overlapping statements, and posts unapproved expenses once", async () => {
    const f = await live();
    const when = (offsetMin: number) => new Date(Date.now() + 4 * 3600_000 + offsetMin * 60000).toISOString().slice(0, 16).replace("T", " ");
    const csv = ["reference,date,plate,amount,litres,description",
      `F-1,${when(30)},DXB A 1234,150.50,62.5,ADNOC Jebel Ali`,
      `F-2,${when(40)},XXX-999,80,,Unknown vehicle`,
      `F-3,${when(24 * 60 * 20)},dxb-a-1234,45,,Far outside any trip`].join("\n");
    const r = await run(f, (c) => importFeed(c, f.t.ctx, "fuel", "ADNOC March", csv));
    expect(r).toMatchObject({ added: 3, duplicates: 0, matched: 1 });
    await expect(run(f, (c) => importFeed(c, f.t.ctx, "fuel", "again", csv))).rejects.toThrow(/already imported/);
    const overlap = await run(f, (c) => importFeed(c, f.t.ctx, "fuel", "overlap", csv + `\nF-4,${when(50)},DXB A 1234,20,,new line`));
    expect(overlap).toMatchObject({ added: 1, duplicates: 3 });
    expect(await run(f, (c) => postFeedExpenses(c, f.t.ctx))).toBe(2);                    // F-1 and F-4
    expect(await run(f, (c) => postFeedExpenses(c, f.t.ctx))).toBe(0);
    const ex = (await run(f, (c) => c.query<any>(`SELECT kind, amount_minor, status FROM trip_expenses ORDER BY amount_minor DESC`))).rows;
    expect(ex.map((e: any) => [e.kind, Number(e.amount_minor), e.status])).toEqual([["fuel", 15050, "recorded"], ["fuel", 2000, "recorded"]]);
    const w = await run(f, (c) => feedWorkspace(c));
    const far = w.open.find((l: any) => l.reference === "F-3");
    expect(far.status).toBe("vehicle_only");
    await run(f, (c) => resolveFeedLine(c, f.t.ctx, far.id, { trip_id: f.trip.id }));
    await run(f, (c) => resolveFeedLine(c, f.t.ctx, w.open.find((l: any) => l.reference === "F-2").id, { ignore: "Not our vehicle" }));
    await expect(db.query(`UPDATE transport_feed_lines SET amount_minor=1 WHERE reference='F-1'`)).rejects.toThrow(/immutable/);
    expect(await verifyInvariants(db)).toEqual([]);
  });
  it("Salik statements post as toll expenses", async () => {
    const f = await live();
    const when = new Date(Date.now() + 4 * 3600_000 + 30 * 60000).toISOString().slice(0, 16).replace("T", " ");
    await run(f, (c) => importFeed(c, f.t.ctx, "salik", "Salik", `reference,date,plate,amount\nS-1,${when},DXB A 1234,4`));
    await run(f, (c) => postFeedExpenses(c, f.t.ctx));
    expect((await run(f, (c) => c.query<any>(`SELECT kind FROM trip_expenses`))).rows).toEqual([{ kind: "toll" }]);
  });
});

describe("GPS retention", () => {
  it("deletes positions older than the owner's retention period and keeps recent ones", async () => {
    const f = await live();
    await run(f, (c) => setLocationConsent(c, f.driverCtx, true));
    await run(f, (c) => recordPositions(c, f.driverCtx, f.trip.id, [{ lat: 25.2, lng: 55.2, device_time: iso(-10) }, { lat: 25.3, lng: 55.3, device_time: iso(-5) }]));
    await db.system((c) => c.query(`UPDATE trip_positions SET effective_time = now() - interval '45 days' WHERE tenant_id=$1 AND lat=25.2`, [f.t.tenantId]));
    await run(f, (c) => setRetentionPolicy(c, f.t.ctx, { subject: "driver_positions", retain_days: 30, reason: "Driver notice: GPS kept 30 days" }));
    const r = await processDataMinimisation(db);
    expect(r.failed).toBe(0);
    expect((await run(f, (c) => c.query<any>(`SELECT lat FROM trip_positions`))).rows.map((x: any) => Number(x.lat))).toEqual([25.3]);
  });
});
