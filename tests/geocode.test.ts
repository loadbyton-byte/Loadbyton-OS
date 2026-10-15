import { describe, it, expect, beforeAll, afterEach } from "vitest";
import type { Db } from "../src/db/client.js";
import { config } from "../src/config.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createDriver, createOrder, createTrip, createVehicle } from "../src/ops/transport.js";
import { geocodeTrip, lookupAddress, type Fetcher } from "../src/ops/geocode.js";
import { setLegCoordinates } from "../src/ops/transport-live.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const saved = { ...config.geocoder };
afterEach(() => { Object.assign(config.geocoder, saved); });
const on = () => { config.geocoder.url = "https://geo.example.test/search"; config.geocoder.countryCodes = "ae"; };
const reply = (body: unknown, status = 200): Fetcher => async () => ({ status, body: JSON.stringify(body) });
const dubai = (h: number) => new Date(Date.now() + h * 3600000 + 4 * 3600000).toISOString().slice(0, 16);

describe("address geocoding", () => {
  it("is off until configured, and sends the query with the country restriction and key", async () => {
    await expect(lookupAddress("Dubai Marina, Dubai", reply([]))).rejects.toThrow(/GEOCODER_URL/);
    on(); config.geocoder.apiKey = "k-1";
    let seen = "", hdr: Record<string, string> = {};
    const f: Fetcher = async (u, h) => { seen = u; hdr = h; return { status: 200, body: JSON.stringify([{ lat: "25.0805", lon: "55.1403", display_name: "Dubai Marina, Dubai, UAE" }]) }; };
    expect(await lookupAddress("Dubai Marina", f)).toEqual({ lat: 25.0805, lng: 55.1403, label: "Dubai Marina, Dubai, UAE" });
    const u = new URL(seen);
    expect(u.searchParams.get("q")).toBe("Dubai Marina"); expect(u.searchParams.get("countrycodes")).toBe("ae"); expect(hdr.authorization).toBe("Bearer k-1");
  });

  it("refuses no match, a point outside the country, an ambiguous address, an outage, rate limiting and junk", async () => {
    on();
    await expect(lookupAddress("Dubai Marina", reply([]))).rejects.toThrow(/No match/);
    await expect(lookupAddress("Riyadh street", reply([{ lat: "24.7", lon: "46.7" }]))).rejects.toThrow(/outside the expected country/);
    await expect(lookupAddress("Main Street", reply([{ lat: "25.2", lon: "55.3", importance: 0.5 }, { lat: "24.4", lon: "54.4", importance: 0.5 }]))).rejects.toThrow(/more than one place/);
    await expect(lookupAddress("Main Street", reply([{ lat: "25.2", lon: "55.3", importance: 0.8 }, { lat: "24.4", lon: "54.4", importance: 0.2 }]))).resolves.toMatchObject({ lat: 25.2 });
    await expect(lookupAddress("Dubai Marina", reply({}, 503))).rejects.toThrow(/answered 503/);
    await expect(lookupAddress("Dubai Marina", reply({}, 429))).rejects.toThrow(/rate limiting/);
    await expect(lookupAddress("Dubai Marina", async () => { throw new Error("down"); })).rejects.toThrow(/could not be reached/);
    await expect(lookupAddress("Dubai Marina", async () => ({ status: 200, body: "<html>" }))).rejects.toThrow(/not JSON/);
    await expect(lookupAddress("Dubai", reply([]))).rejects.toThrow(/too short/);
  });

  it("locates the stops of a trip, labels them, reports the ones it cannot, and never overwrites hand-entered points", async () => {
    on();
    const t = await newTenant(db, undefined, ["road-transport"]);
    const run = <T,>(fn: (c: any) => Promise<T>) => db.tenant(t.tenantId, fn);
    const { tripId } = await run(async (c) => {
      const cust = await createParty(c, t.ctx, { kind: "customer", name: "Cust" });
      const veh = await createVehicle(c, t.ctx, { reg_no: "dxb a 4321", capacity_kg: 3000, capacity_cbm: 20 });
      const drv = await createDriver(c, t.ctx, { name: "Imran", phone: "050" });
      const o = await createOrder(c, t.ctx, { party_id: cust, pickup_address: "Jebel Ali Free Zone, Dubai", delivery_address: "Nowhere Land 123 unknown", cargo_desc: "Boxes", weight_kg: 800, volume_cbm: 4, rate: "600", detention_rate: "100" });
      const tr = await createTrip(c, t.ctx, { vehicle_id: veh, driver_id: drv, planned_start: dubai(1), planned_end: dubai(6), order_ids: [o.id] });
      return { tripId: tr.id as string };
    });
    const fetcher: Fetcher = async (u) => new URL(u).searchParams.get("q")!.includes("Jebel Ali") ? { status: 200, body: JSON.stringify([{ lat: "24.9857", lon: "55.0272", display_name: "Jebel Ali Free Zone" }]) } : { status: 200, body: "[]" };
    const r = await run((c) => geocodeTrip(c, t.ctx, tripId, fetcher));
    expect(r.found).toBe(1); expect(r.failed).toHaveLength(1); expect(r.failed[0].reason).toMatch(/No match/);
    let legs = (await db.query<any>(`SELECT kind, lat, geo_source, geo_label FROM trip_legs WHERE trip_id=$1 ORDER BY seq`, [tripId])).rows;
    expect(legs[0]).toMatchObject({ kind: "pickup", geo_source: "geocoded", geo_label: "Jebel Ali Free Zone" }); expect(legs[1]).toMatchObject({ lat: null, geo_source: null });
    const dl = (await db.query<any>(`SELECT id FROM trip_legs WHERE trip_id=$1 AND kind='delivery'`, [tripId])).rows[0].id;
    await run((c) => setLegCoordinates(c, t.ctx, dl, "25.2", "55.27"));
    expect((await run((c) => geocodeTrip(c, t.ctx, tripId, fetcher))).found).toBe(0);     // nothing left to look up; the manual point stays
    legs = (await db.query<any>(`SELECT geo_source FROM trip_legs WHERE trip_id=$1 ORDER BY seq`, [tripId])).rows;
    expect(legs.map((l: any) => l.geo_source)).toEqual(["geocoded", "manual"]);
    config.geocoder.url = "";
    await expect(run((c) => geocodeTrip(c, t.ctx, tripId, fetcher))).rejects.toThrow(/GEOCODER_URL/);
  });
});
