import { config } from "../config.js";
import { HttpError } from "./util.js";

export interface HitResult { ok: boolean; count: number; retryAfter: number }
export interface Limiter { hit(key: string, limit: number, windowSec: number): Promise<HitResult> }

/** Fixed-window counter in process memory: correct for one instance, per-instance only when scaled out. */
export function memoryLimiter(now: () => number = Date.now): Limiter & { reset(): void } {
  const m = new Map<string, { n: number; start: number }>();
  return {
    async hit(key, limit, windowSec) {
      const t = now(), a = m.get(key);
      if (!a || t - a.start >= windowSec * 1000) { m.set(key, { n: 1, start: t }); return { ok: true, count: 1, retryAfter: 0 }; }
      a.n++;
      return { ok: a.n <= limit, count: a.n, retryAfter: Math.max(1, Math.ceil((a.start + windowSec * 1000 - t) / 1000)) };
    },
    reset: () => m.clear(),
  };
}

/**
 * Shared counter on Upstash Redis (REST, so it works from any host with no TCP connection): INCR, then EXPIRE … NX so the window starts at the
 * first hit and is never extended by later ones. If Redis is unreachable the limiter falls back to the in-process counter — protection degrades to
 * per-instance rather than every sign-in failing.
 */
export function upstashLimiter(url: string, token: string, fallback: Limiter, fetchImpl: typeof fetch = fetch): Limiter {
  return {
    async hit(key, limit, windowSec) {
      try {
        const k = `lbt:rl:${key}`;
        const res = await fetchImpl(`${url}/pipeline`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify([["INCR", k], ["EXPIRE", k, String(windowSec), "NX"], ["TTL", k]]), signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) throw new Error(`upstash ${res.status}`);
        const out = (await res.json()) as { result?: number; error?: string }[];
        const n = Number(out[0]?.result), ttl = Number(out[2]?.result);
        if (!Number.isFinite(n)) throw new Error(out[0]?.error ?? "bad reply");
        return { ok: n <= limit, count: n, retryAfter: ttl > 0 ? ttl : windowSec };
      } catch (e) {
        console.error("[ratelimit] upstash unavailable, using in-process counter:", (e as Error).message);
        return fallback.hit(key, limit, windowSec);
      }
    },
  };
}

const memory = memoryLimiter();
export const limiter: Limiter = config.upstash.url ? upstashLimiter(config.upstash.url, config.upstash.token, memory) : memory;
export const resetRateLimits = () => memory.reset();

/** Throws 429 when the caller exceeded `limit` hits in `windowSec` seconds. */
export async function rateLimit(key: string, limit: number, windowSec: number, message = "Too many requests. Please wait a moment and try again.") {
  const r = await limiter.hit(key, limit, windowSec);
  if (!r.ok) throw new HttpError(429, message, "throttled");
}
