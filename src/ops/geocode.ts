import type { Conn } from "../db/client.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { getJson, type PostResult } from "../lib/safe-http.js";
import { badRequest } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId } from "./common.js";

/**
 * Address geocoding for transport stops. The configured service must answer the Nominatim /search JSON shape. A result is accepted only when it is
 * a single usable point inside the configured countries' bounding box; anything else leaves the stop without coordinates and says why. Coordinates
 * that came from the service are labelled "geocoded" and can be overwritten by hand ("manual"). Only pending stops without coordinates are looked up.
 */
export type Fetcher = (url: string, headers: Record<string, string>) => Promise<PostResult>;
const BOX: Record<string, [number, number, number, number]> = { ae: [22.4, 51.5, 26.3, 56.5], sa: [16.0, 34.4, 32.2, 55.7], om: [16.6, 51.8, 26.5, 60.0], qa: [24.4, 50.7, 26.3, 51.7], kw: [28.4, 46.5, 30.2, 48.5], bh: [25.5, 50.3, 26.4, 50.9] };

export interface Geocoded { lat: number; lng: number; label: string }
export const geocoderEnabled = () => !!config.geocoder.url;

export async function lookupAddress(address: string, fetcher: Fetcher = (u, h) => getJson(u, h)): Promise<Geocoded> {
  if (!geocoderEnabled()) throw badRequest("Address lookup is not enabled on this installation: the administrator must set GEOCODER_URL.");
  const q = address.replace(/\s+/g, " ").trim();
  if (q.length < 6) throw badRequest("The address is too short to look up.");
  const u = new URL(config.geocoder.url);
  u.searchParams.set("q", q); u.searchParams.set("format", "jsonv2"); u.searchParams.set("limit", "2"); u.searchParams.set("countrycodes", config.geocoder.countryCodes);
  const headers: Record<string, string> = { "user-agent": config.geocoder.userAgent, accept: "application/json" };
  if (config.geocoder.apiKey) headers.authorization = `Bearer ${config.geocoder.apiKey}`;
  let res: PostResult;
  try { res = await fetcher(u.toString(), headers); } catch { throw badRequest("The address lookup service could not be reached. Try again, or enter the coordinates by hand."); }
  if (res.status === 429) throw badRequest("The address lookup service is rate limiting requests. Try again shortly.");
  if (res.status < 200 || res.status >= 300) throw badRequest(`The address lookup service answered ${res.status}.`);
  let list: any;
  try { list = JSON.parse(res.body); } catch { throw badRequest("The address lookup service returned something that is not JSON."); }
  if (!Array.isArray(list) || !list.length) throw badRequest("No match for that address. Add the area or building name, or enter the coordinates by hand.");
  const hit = list[0], lat = Number(hit.lat), lng = Number(hit.lon ?? hit.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw badRequest("The lookup service returned an unusable point.");
  const boxes = config.geocoder.countryCodes.split(",").map((x) => BOX[x.trim()]).filter(Boolean);
  if (boxes.length && !boxes.some(([s, w, n, e]) => lat >= s && lat <= n && lng >= w && lng <= e)) throw badRequest("The match lies outside the expected country, so it was not used.");
  // two candidates this far apart mean the address is ambiguous; a person should choose
  if (list.length > 1) {
    const b = list[1], bl = Number(b.lat), bo = Number(b.lon ?? b.lng);
    if (Number.isFinite(bl) && Number.isFinite(bo) && Math.hypot(bl - lat, bo - lng) > 0.2 && Number(b.importance ?? 0) >= Number(hit.importance ?? 0) - 0.05) throw badRequest("The address matches more than one place. Add the area or building name, or enter the coordinates by hand.");
  }
  return { lat, lng, label: String(hit.display_name ?? "").slice(0, 200) };
}

/** Look up every pending stop of a trip that has no coordinates. Per-stop failures are reported, not thrown, so one bad address does not block the rest. */
export async function geocodeTrip(c: Conn, ctx: Ctx, tripId: string, fetcher?: Fetcher) {
  require(ctx, "transport.write");
  await assertWritable(c, ctx.tenantId);
  const trip = await must(c.query<any>(`SELECT id, status FROM trips WHERE id=$1 FOR UPDATE`, [recordId(tripId)]), "Trip");
  if (["completed", "cancelled"].includes(trip.status)) throw badRequest(`Trip is ${trip.status}.`);
  const legs = (await c.query<any>(`SELECT id, address FROM trip_legs WHERE trip_id=$1 AND status='pending' AND lat IS NULL ORDER BY seq`, [trip.id])).rows;
  if (!geocoderEnabled()) throw badRequest("Address lookup is not enabled on this installation: the administrator must set GEOCODER_URL.");
  const out = { found: 0, failed: [] as { leg: string; address: string; reason: string }[] };
  for (const l of legs) {
    try {
      const g = await lookupAddress(l.address, fetcher);
      await c.query(`UPDATE trip_legs SET lat=$2, lng=$3, geo_source='geocoded', geo_label=$4 WHERE id=$1 AND status='pending' AND lat IS NULL`, [l.id, g.lat.toFixed(6), g.lng.toFixed(6), g.label]);
      out.found++;
    } catch (e: any) { out.failed.push({ leg: l.id, address: String(l.address).slice(0, 80), reason: e.message }); }
  }
  await audit(c, ctx.tenantId, actorOf(ctx), "trip.geocoded", "trip", trip.id, { found: out.found, failed: out.failed.length });
  return out;
}
