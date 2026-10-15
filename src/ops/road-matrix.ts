import { config } from "../config.js";
import { getJson, type PostResult } from "../lib/safe-http.js";
import { badRequest } from "../lib/util.js";

/**
 * Road travel times and distances between points from an OSRM-compatible /table service. The answer is the service's own network model: free-flow
 * unless the service itself models traffic. Anything unreachable, malformed or oversized is refused with a message; the planner never guesses a leg.
 */
export type MatrixFetcher = (url: string, headers: Record<string, string>) => Promise<PostResult>;
export const roadRoutingEnabled = () => !!config.routing.url;
export interface RoadMatrix { duration: number[][]; distance: number[][] }

export async function roadMatrix(points: { lat: number; lng: number }[], fetcher: MatrixFetcher = (u, h) => getJson(u, h, { timeoutMs: 20_000, maxBodyBytes: 4_000_000 })): Promise<RoadMatrix> {
  if (!roadRoutingEnabled()) throw badRequest("Road routing is not enabled on this installation: the administrator must set ROUTING_URL.");
  if (points.length < 2) throw badRequest("Road routing needs at least two points.");
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
