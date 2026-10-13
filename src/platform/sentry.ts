import * as Sentry from "@sentry/node";
import { config } from "../config.js";

let on = false;
const SECRET = /authorization|cookie|token|secret|password|api[-_]?key|csrf|set-cookie/i;

/** Strips credentials from a request/breadcrumb object. No body, cookie or query string ever leaves the process. */
function scrub(v: any): any {
  if (!v || typeof v !== "object") return v;
  for (const k of Object.keys(v)) { if (SECRET.test(k)) v[k] = "[redacted]"; else scrub(v[k]); }
  return v;
}

/** Starts error reporting when SENTRY_DSN is set; otherwise every function here is a no-op. */
export function initSentry(service: "web" | "worker") {
  if (!config.sentry.dsn || on) return;
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    release: config.sentry.release || undefined,
    tracesSampleRate: config.sentry.tracesSampleRate,
    initialScope: { tags: { service } },
    beforeSend(event) {
      if (event.request) { delete event.request.cookies; delete event.request.data; delete event.request.query_string; scrub(event.request.headers); }
      delete event.user;
      return scrub(event);
    },
    beforeBreadcrumb: (b) => scrub(b),
  });
  on = true;
}

/** Report an unexpected error (HttpError 4xx must NOT be passed here). */
export function captureError(e: unknown, ctx?: { traceId?: string; method?: string; route?: string }) {
  if (!on) return;
  Sentry.withScope((s) => {
    if (ctx?.traceId) s.setTag("trace_id", ctx.traceId);
    if (ctx?.method) s.setTag("method", ctx.method);
    if (ctx?.route) s.setTag("route", ctx.route);
    Sentry.captureException(e);
  });
}

/** Wait for queued events before the process exits. */
export async function flushSentry() { if (on) await Sentry.flush(2000).catch(() => false); }
