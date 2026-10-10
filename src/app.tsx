import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Db } from "./db/client.js";
import { HttpError } from "./lib/util.js";
import { csrfMw, dbMw, securityHeaders, sessionMw, type Env } from "./web/mw.js";
import { pub } from "./web/public.js";
import { auth } from "./web/auth.js";
import { core } from "./web/app-core.js";
import { sales } from "./web/app-sales.js";
import { ops } from "./web/app-ops.js";
import { transport } from "./web/app-transport.js";
import { fulfil } from "./web/app-fulfil.js";
import { warehouse } from "./web/app-warehouse.js";
import { delivery, deliveryPublic } from "./web/app-delivery.js";
import { customs } from "./web/app-customs.js";
import { deliveryApi } from "./web/api-delivery.js";
import { driver } from "./web/app-driver.js";
import { admin } from "./web/admin.js";
import { PublicShell } from "./web/ui.js";
import { config } from "./config.js";
import { safeEqual } from "./lib/util.js";
import { collectMetrics, workersStatus } from "./platform/metrics.js";

export function buildApp(db: Db) {
  const app = new Hono<Env>();
  app.use("*", securityHeaders);
  app.use("/assets/*", async (c, next) => { await next(); c.header("Cache-Control", "public, max-age=300"); });
  app.use("/assets/*", serveStatic({ root: "./public" }));
  app.use("/brand/*", serveStatic({ root: "./public" }));
  app.get("/healthz", async (c) => { await db.query("SELECT 1"); return c.json({ ok: true }); });
  // Readiness (for load balancers / uptime checks): the database answers AND the background workers have run recently.
  app.get("/readyz", async (c) => {
    try { await db.query("SELECT 1"); } catch { return c.json({ ok: false, problem: "database unreachable" }, 503); }
    const w = config.runWorkers ? workersStatus() : { ok: true, stale: [] as string[] };
    return c.json({ ok: w.ok, workers: w.ok ? "ok" : w.stale }, w.ok ? 200 : 503);
  });
  // Operational metrics for a scraper. Disabled unless METRICS_TOKEN is set; aggregate counts only.
  app.get("/metrics", async (c) => {
    const tok = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!config.metricsToken || !tok || !safeEqual(tok, config.metricsToken)) return c.notFound();
    return c.body(await collectMetrics(db), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
  });
  app.use("*", dbMw(db));
  app.use("*", sessionMw);
  app.use("*", csrfMw);

  app.route("/", pub);
  app.route("/", auth);
  app.route("/", admin);
  app.route("/", core);
  app.route("/", sales);
  app.route("/", ops);
  app.route("/", transport);
  app.route("/", fulfil);
  app.route("/", warehouse);
  app.route("/", delivery);
  app.route("/", deliveryPublic);
  app.route("/", deliveryApi);
  app.route("/", customs);
  app.route("/", driver);

  const errorPage = (c: any, status: number, title: string, message: string) =>
    c.html(
      <PublicShell p={{ title, csrf: c.get("csrf") ?? "", path: c.req.path, user: c.get("session") ? { name: c.get("session").name } : null }}>
        <section class="block"><div class="wrap prose">
          <h1>{title}</h1><p>{message}</p>
          <p><a class="btn" href={c.get("session") ? "/app" : "/"}>Go back home</a></p>
        </div></section>
      </PublicShell>, status);
  app.notFound((c) => errorPage(c, 404, "Page not found", "We could not find that page."));
  app.onError((e, c) => {
    if (e instanceof HttpError) {
      const title = e.status === 403 ? "Not permitted" : e.status === 404 ? "Not found" : e.status === 402 ? "Plan limit reached" : "Something is not right";
      return errorPage(c, e.status, title, e.message);
    }
    console.error("[error]", c.req.method, c.req.path, e);
    return errorPage(c, 500, "Something went wrong", "An unexpected error occurred. Nothing was lost; please try again. If it keeps happening, contact us with the time it happened.");
  });
  return app;
}
