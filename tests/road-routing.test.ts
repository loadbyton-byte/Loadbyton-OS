import { describe, it, expect, beforeAll, afterEach } from "vitest";
import type { Db } from "../src/db/client.js";
import { config } from "../src/config.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createDriver, createOrder, createTrip, createVehicle } from "../src/ops/transport.js";
import { optimiseTrip, setLegCoordinates, haversineKm } from "../src/ops/transport-live.js";
import { roadMatrix, type MatrixFetcher } from "../src/ops/road-matrix.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const saved = { ...config.routing };
afterEach(() => { Object.assign(config.routing, saved); });
const dubai = (h: number) => new Date(Date.now() + h * 3600000 + 4 * 3600000).toISOString().slice(0, 16);
const ok = (body: unknown, status = 200) => async () => ({ status, body: JSON.stringify(body) });

describe("road-network routing", () => {
  it("is off until configured, asks the service for the right table and refuses incomplete or failed answers", async () => {
    await expect(roadMatrix([{ lat: 25, lng: 55 }, { lat: 25.1, lng: 55.1 }], ok({}))).rejects.toThrow(/ROUTING_URL/);
    config.routing.url = "https://osrm.example.test"; config.routing.apiKey = "key-1"; config.routing.maxPoints = 3;
    let seen = "", hdr: Record<string, string> = {};
    const f: MatrixFetcher = async (u, h) => { seen = u; hdr = h; return { status: 200, body: JSON.stringify({ code: "Ok", durations: [[0, 60], [70, 0]], distances: [[0, 1000], [1100, 0]] }) }; };
    const m = await roadMatrix([{ lat: 25, lng: 55 }, { lat: 25.1, lng: 55.1 }], f);
    expect(m.duration[0][1]).toBe(60);
    expect(seen).toBe("https://osrm.example.test/table/v1/driving/55.000000,25.000000;55.100000,25.100000?annotations=duration%2Cdistance"); expect(hdr.authorization).toBe("Bearer key-1");
    const P = { lat: 25, lng: 55 };
    await expect(roadMatrix([P, P, P, P], f)).rejects.toThrow(/limited to 3/);
    await expect(roadMatrix([P], f)).rejects.toThrow(/at least two/);
    await expect(roadMatrix([P, P], ok({ code: "NoTable", message: "too big" }))).rejects.toThrow(/too big/);
    await expect(roadMatrix([P, P], ok({ code: "Ok", durations: [[0, null], [1, 0]], distances: [[0, 1], [1, 0]] }))).rejects.toThrow(/off the road network/);
    await expect(roadMatrix([P, P], ok({}, 503))).rejects.toThrow(/answered 503/);
    await expect(roadMatrix([P, P], async () => { throw new Error("x"); })).rejects.toThrow(/could not be reached/);
  });

  it("plans a trip by road time instead of straight line and reports road km and minutes", async () => {
    config.routing.url = "https://osrm.example.test"; config.routing.maxPoints = 60;
    const t = await newTenant(db, undefined, ["road-transport"]);
    const run = <T,>(fn: (c: any) => Promise<T>) => db.tenant(t.tenantId, fn);
    const tripId = await run(async (c) => {
      const cust = await createParty(c, t.ctx, { kind: "customer", name: "Cust" });
      const veh = await createVehicle(c, t.ctx, { reg_no: "dxb a 7777", capacity_kg: 9000, capacity_cbm: 40 });
      const drv = await createDriver(c, t.ctx, { name: "Imran", phone: "050" });
      const os = [];
      for (const d of ["B", "C"]) os.push((await createOrder(c, t.ctx, { party_id: cust, pickup_address: `Pickup ${d}`, delivery_address: `Drop ${d}`, cargo_desc: "Boxes", weight_kg: 100, volume_cbm: 1, rate: "100", detention_rate: "10" })).id);
      return (await createTrip(c, t.ctx, { vehicle_id: veh, driver_id: drv, planned_start: dubai(1), planned_end: dubai(8), order_ids: os })).id as string;
    });
    const legs = (await db.query<any>(`SELECT id, kind FROM trip_legs WHERE trip_id=$1 ORDER BY seq`, [tripId])).rows;
    // pickups B and C are straight-line close, but a one-way system makes the road between B→C long: coordinates chosen so the road matrix disagrees with the crow
    const coords: [string, string][] = [["25.00", "55.00"], ["25.01", "55.01"], ["25.02", "55.02"], ["25.03", "55.03"]];
    for (const [i, l] of legs.entries()) await run((c) => setLegCoordinates(c, t.ctx, l.id, coords[i][0], coords[i][1]));
    const calls: string[] = [];
    // a fake road network: travel time is 100 s per index step, but going backwards costs 10 times more
    const fetcher: MatrixFetcher = async (u) => {
      calls.push(u);
      const n = u.split("/").pop()!.split("?")[0].split(";").length;
      const d = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : j > i ? 100 * (j - i) : 1000 * (i - j))));
      return { status: 200, body: JSON.stringify({ code: "Ok", durations: d, distances: d.map((r) => r.map((v) => v * 10)) }) };
    };
    const plan = await run((c) => optimiseTrip(c, t.ctx, tripId, false, null, fetcher));
    expect(plan.basis).toBe("road"); expect(calls).toHaveLength(1);
    expect(plan.before_min).toBeGreaterThan(0); expect(plan.after_min).toBeLessThanOrEqual(plan.before_min!);
    expect(plan.before_km).toBeGreaterThan(0);
    // without a routing service the same trip falls back to straight-line planning and says so
    config.routing.url = "";
    const straight = await run((c) => optimiseTrip(c, t.ctx, tripId, false));
    expect(straight.basis).toBe("straight-line"); expect(straight.before_min).toBeUndefined();
    expect(haversineKm(25, 55, 25.01, 55.01)).toBeGreaterThan(0);
  });
});
