import { rateLimit as limit, resetRateLimits } from "../lib/ratelimit.js";
export { resetRateLimits };
/** Compatibility wrapper over the shared limiter (Upstash when configured, in-process otherwise). Defaults: 8 attempts per 15 minutes. */
export const rateLimit = (key: string, max = 8, seconds = 900) =>
  limit(`rl:${key}`, max, seconds, "Too many sign-in attempts. Try again in a few minutes.");
