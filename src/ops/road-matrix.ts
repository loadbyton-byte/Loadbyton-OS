import { config } from "../config.js";
import { getJson, postJson, type PostResult } from "../lib/safe-http.js";
import { badRequest } from "../lib/util.js";

/**
 * Road travel times and distances between points from an OSRM-compatible /table service. The answer is the service's own network model: free-flow
 * unless the service itself models traffic. Anything unreachable, malformed or oversized is refused with a message; the planner never guesses a leg.
 */
export type MatrixFetcher = (url: string, headers: Record<string, string>, body?: string) => Promise<PostResult>;
export const roadRoutingEnabled = () => (config.routing.provider === "google" ? !!config.routing.apiKey : !!config.routing.url);
/** `traffic` is true when the durations model live traffic at the time of the request (Google's TRAFFIC_AWARE); OSRM times are free-flow. */
export interface RoadMatrix { duration: number[][]; distance: number[][]; traffic?: boolean }
const defaultFetch: MatrixFetcher = (u, h, body) => (body === undefined ? getJson(u, h, { timeoutMs: 20_000, maxBodyBytes: 4_000_000 }) : postJson(u, body, h, { timeoutMs: 25_000, maxBodyBytes: 4_000_000 }));
const GOOGLE_MAX_POINTS = 25;                 // Routes API: at most 625 elements (25 × 25) for a traffic-aware matrix

/**
 * Google Routes API computeRouteMatrix with TRAFFIC_AWARE routing: durations reflect traffic now. Each origin–destination pair is one element in the streamed JSON array.
 * The field mask keeps the answer small and the cost at the basic tier. A pair without a route fails the whole plan: the planner never guesses a leg.
 */
async function googleMatrix(points: { lat: number; lng: number }[], fetcher: MatrixFetcher): Promise<RoadMatrix> {
  const n = points.length;
  if (n > Math.min(GOOGLE_MAX_POINTS, config.routing.maxPoints)) throw badRequest(`Live-traffic routing is limited to ${Math.min(GOOGLE_MAX_POINTS, config.routing.maxPoints)} points per request.`);
  const wp = (p: { lat: number; lng: number }) => ({ waypoint: { location: { latLng: { latitude: Number(p.lat.toFixed(6)), longitude: Number(p.lng.toFixed(6)) } } } });
  const body = JSON.stringify({ origins: points.map(wp), destinations: points.map(wp), travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", departureTime: new Date(Date.now() + 60_000).toISOString(), units: "METRIC" });
  let res: PostResult;
  try { res = await fetcher(`${config.routing.googleBase}/distanceMatrix/v2:computeRouteMatrix`, { "x-goog-api-key": config.routing.apiKey, "x-goog-fieldmask": "originIndex,destinationIndex,duration,distanceMeters,status,condition" }, body); }
  catch { throw badRequest("The routing service could not be reached. Try again, or plan on straight-line distances."); }
  if (res.status === 403 || res.status === 401) throw badRequest("The routing service refused the API key (check that the Routes API is enabled and the key is allowed from this server).");
  if (res.status === 429) throw badRequest("The routing service is rate limiting requests. Try again shortly.");
  if (res.status < 200 || res.status >= 300) throw badRequest(`The routing service answered ${res.status}.`);
  let list: any;
  try { list = JSON.parse(res.body); } catch { throw badRequest("The routing service returned something that is not JSON."); }
  if (!Array.isArray(list)) throw badRequest("The routing service returned an unexpected answer.");
  const duration = Array.from({ length: n }, () => Array<number>(n).fill(NaN)), distance = Array.from({ length: n }, () => Array<number>(n).fill(NaN));
  for (const e of list) {
    const i = Number(e.originIndex), j = Number(e.destinationIndex);
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= n || j >= n) continue;
    if (i === j) { duration[i][j] = 0; distance[i][j] = 0; continue; }
    if (e.condition !== "ROUTE_EXISTS" || (e.status && Object.keys(e.status).length)) continue;
    const secs = Number(String(e.duration ?? "").replace(/s$/, ""));
    if (Number.isFinite(secs) && secs >= 0 && Number.isFinite(Number(e.distanceMeters))) { duration[i][j] = secs; distance[i][j] = Number(e.distanceMeters); }
  }
  for (let i = 0; i < n; i++) { duration[i][i] = 0; distance[i][i] = 0; }
  if (duration.some((r) => r.some((v) => !Number.isFinite(v))) || distance.some((r) => r.some((v) => !Number.isFinite(v)))) throw badRequest("The routing service could not connect every stop by road (a stop may be off the road network). Check the coordinates.");
  return { duration, distance, traffic: true };
}

export async function roadMatrix(points: { lat: number; lng: number }[], fetcher: MatrixFetcher = defaultFetch): Promise<RoadMatrix> {
  if (!roadRoutingEnabled()) throw badRequest("Road routing is not enabled on this installation: the administrator must set ROUTING_URL (OSRM) or ROUTING_PROVIDER=google with ROUTING_API_KEY.");
  if (points.length < 2) throw badRequest("Road routing needs at least two points.");
  if (config.routing.provider === "google") return googleMatrix(points, fetcher);
  if (points.length > config.routing.maxPoints) throw badRequest(`Road routing is limited to ${config.routing.maxPoints} points per request.`);
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const u = new URL(`${config.routing.url}/table/v1/${encodeURIComponent(config.routing.profile)}/${coords}`);
  u.searchParams.set("annotations", "duration,distance");
  const headers: Record<string, string> = {};
  if (config.routing.apiKey) headers.authorization = `Bearer ${config.routing.apiKey}`;
  let res: PostResult;
  try { res = await fetcher(u.toString(), headers); } catch { throw badRequest("The routing service could not be reached. Try again, or plan on straight-line distances."); }
  if (res.status < 200 || res.status >= 300) throw badRequest(`The routing service answered ${res.status}.`);
  let body: any;
  try { body = JSON.parse(res.body); } catch { throw badRequest("The routing service returned something that is not JSON."); }
  if (body?.code !== "Ok") throw badRequest(`The routing service could not plan this: ${String(body?.message ?? body?.code ?? "unknown error").slice(0, 120)}.`);
  const n = points.length, ok = (m: any) => Array.isArray(m) && m.length === n && m.every((r: any) => Array.isArray(r) && r.length === n && r.every((v: any) => typeof v === "number" && Number.isFinite(v) && v >= 0));
  if (!ok(body.durations) || !ok(body.distances)) throw badRequest("The routing service could not connect every stop by road (a stop may be off the road network). Check the coordinates.");
  return { duration: body.durations, distance: body.distances };
}
