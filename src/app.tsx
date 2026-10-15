import {captureError} from "./platform/sentry.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Db } from "./db/client.js";
import { config } from "./config.js";
import { RuntimeMetrics } from "./platform/runtime-metrics.js";
import { HttpError, safeEqual } from "./lib/util.js";
import { setCookie } from "hono/cookie";
import { isLocale } from "./lib/i18n.js";
import { brandHtml } from "./lib/brand-html.js";
import { LANG_COOKIE, csrfMw, dbMw, localeMw, securityHeaders, sessionMw, type Env } from "./web/mw.js";
import { pub } from "./web/public.js";
import { marketing } from "./web/pages-marketing.js";
import { chat } from "./web/chat.js";
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
import { adminConsole } from "./web/admin-console.js";
import { adminReadiness } from "./web/admin-readiness.js";
import { stockMigration } from "./web/stock-migration.js";
import { freightCommercial } from "./web/freight-commercial.js";
import { financeBridge } from "./web/finance-bridge.js";
import { inboundHooks, inboundUi } from "./web/inbound.js";
import { extraction } from "./web/extraction.js";
import { einvoice, einvoiceHooks } from "./web/einvoice.js";
import { adminEInvoice } from "./web/admin-einvoice.js";
import { feeds } from "./web/feeds.js";
import { ledger } from "./web/ledger.js";
import { deviceHooks, deviceUi } from "./web/devices.js";
import { storefrontHooks, storefrontUi } from "./web/storefront.js";
import { carrierHooks, carrierUi } from "./web/carrier-feeds.js";
import { printApi, printUi } from "./web/printing.js";
import { orderPulls } from "./web/order-pulls.js";
import { PublicShell } from "./web/ui.js";
import { security } from "./web/security.js";
import { connections } from "./web/connections.js";
import { privacy } from "./web/privacy.js";
import { service } from "./web/service.js";
import { api } from "./web/api.js";
import { workspace } from "./web/workspace.js";
import { specialists } from "./web/app-specialists.js";
import { weight } from "./web/chargeable-weight.js";
import { schedule } from "./web/count-schedules.js";
import { assistant } from "./web/assistant.js";
import { fulfilStorage } from "./web/fulfil-storage.js";
import { fulfilLots } from "./web/fulfil-lots.js";
import { fulfilSites } from "./web/fulfil-sites.js";
import { fulfilOps } from "./web/fulfil-ops.js";
import { transportLive } from "./web/transport-live.js";
import { warehousePolicy } from "./web/warehouse-policy.js";
import { deliveryFinance } from "./web/delivery-finance.js";
import { documentDrafts } from "./web/document-drafts.js";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { routePath } from "hono/route";
import { collectQueueMetrics } from "./platform/health.js";
import { collectMetrics, workersStatus } from "./platform/metrics.js";

export function buildApp(db: Db, options: { metrics?: RuntimeMetrics; metricsToken?: string } = {}) {
  const app = new Hono<Env>();
  // gzip/deflate for HTML, CSS, JS, JSON and SVG (already-compressed images and fonts are skipped by content type)
  app.use("*", compress());
  app.use("*", securityHeaders);
  // outermost response filter: draw the LOAD|BY|TON wordmark as the logo does, after any Arabic translation has run
  app.use("*", async (c, next) => {
    await next();
    if (!(c.res.headers.get("content-type") ?? "").startsWith("text/html") || c.req.path.startsWith("/app/driver/offline")) return;
    const html = await c.res.text();
    const res = new Response(brandHtml(html), c.res);
    res.headers.delete("content-length");
    c.res = res;
  });
  app.use('*',bodyLimit({maxSize:config.maxUploadBytes+262144,onError:c=>c.text('Request too large',413)}));
  const metrics = options.metrics ?? new RuntimeMetrics();
  app.use("*", metrics.middleware());
  // Driver offline shell: served without a session so the service worker can install and update; contains no tenant data.
  const staticFile = (file: string, type: string, extra: Record<string, string> = {}) => async (c: any) => c.body(await fs.readFile(path.resolve("public", file)), 200, { "content-type": type, "cache-control": "no-cache", ...extra });
  app.get("/app/driver/sw.js", staticFile("driver-sw.js", "application/javascript; charset=utf-8", { "service-worker-allowed": "/app/driver" }));
  app.get("/app/driver/offline", staticFile("driver-offline.html", "text/html; charset=utf-8"));
  app.get("/app/driver/manifest.webmanifest", staticFile("driver-manifest.webmanifest", "application/manifest+json; charset=utf-8"));
  // Static files keep stable names, so: CSS/JS revalidate daily (served stale while refreshing), fonts and images are cached for a month.
  const staticCache = (p: string) => /\.(woff2?|webp|png|jpe?g|ico|svg)$/i.test(p) ? "public, max-age=2592000, stale-while-revalidate=604800" : "public, max-age=3600, stale-while-revalidate=86400";
  app.use("/assets/*", async (c, next) => { await next(); if (c.res.status === 200) c.header("Cache-Control", staticCache(c.req.path)); });
  app.use("/assets/*", serveStatic({ root: "./public" }));
  app.use("/brand/*", async (c, next) => { await next(); if (c.res.status === 200) c.header("Cache-Control", staticCache(c.req.path)); });
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
    const metricsToken = options.metricsToken ?? config.metricsToken;
    if (!metricsToken || !tok || !safeEqual(tok, metricsToken)) return c.notFound();
    await collectQueueMetrics(db, metrics);
    return c.body((await collectMetrics(db)) + metrics.render(), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
  });
  app.use("*", dbMw(db));
  app.use("*", sessionMw);
  app.use("*", csrfMw);
  app.use("*", localeMw);
  app.get("/lang/:code", (c) => {
    const code = c.req.param("code");
    if (!isLocale(code)) return c.notFound();
    const next = c.req.query("next") ?? "/";
    setCookie(c, LANG_COOKIE, code, { path: "/", maxAge: 31536000, sameSite: "Lax", secure: config.baseUrl.startsWith("https://"), httpOnly: false });
    return c.redirect(/^\/(?!\/)[^\\\r\n]*$/.test(next) ? next : "/");
  });

  app.route("/", pub);
  app.route("/", marketing);
  app.route("/", chat);
  app.route("/", auth);
  app.route("/", security);
  app.route("/", admin);
  app.route("/", inboundHooks);
  app.route("/", deviceHooks);
  app.route("/", storefrontHooks);
  app.route("/", carrierHooks);
  app.route("/", printApi);
  app.route("/", adminConsole);
  app.route("/", adminReadiness);
  app.route("/", adminEInvoice);
  app.route("/", einvoiceHooks);
  app.route("/", core);
  app.route("/", stockMigration);
  app.route("/", freightCommercial);
  app.route("/", financeBridge);
  app.route("/", inboundUi);
  app.route("/", extraction);
  app.route("/", einvoice);
  app.route("/", feeds);
  app.route("/", ledger);
  app.route("/", deviceUi);
  app.route("/", storefrontUi);
  app.route("/", carrierUi);
  app.route("/", printUi);
  app.route("/", orderPulls);
  app.route("/", connections);
  app.route("/", privacy);
  app.route("/", service);
  app.route("/", api);
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
  app.route("/", specialists);
  app.route("/", weight);
  app.route("/", schedule);
  app.route("/", assistant);
  app.route("/", fulfilStorage);
  app.route("/", fulfilLots);
  app.route("/", fulfilSites);
  app.route("/", fulfilOps);
  app.route("/", transportLive);
  app.route("/", warehousePolicy);
  app.route("/", deliveryFinance);
  app.route("/", documentDrafts);
  app.route("/", workspace);

  const errorPage = (c: any, status: number, title: string, message: string) =>
    c.html(
      <PublicShell p={{ title, csrf: c.get("csrf") ?? "", path: c.req.path, user: c.get("session") ? { name: c.get("session").name } : null }}>
        <section class="block"><div class="wrap prose">
          <h1>{title}</h1><p>{message}</p>
          <p><a class="btn" href={c.get("session") ? "/app" : "/"}>Go back home</a></p>
        </div></section>
      </PublicShell>, status);
  app.notFound((c) => c.req.path.startsWith('/api/v1/')?c.json({error:'Endpoint not found',trace_id:c.get('traceId')},404):errorPage(c, 404, "Page not found", "We could not find that page."));
  app.onError((e, c) => {
    if(!(e instanceof HttpError)||e.status>=500)captureError(e,{traceId:c.get('traceId'),method:c.req.method,route:routePath(c)||undefined});
    if(c.req.path.startsWith('/api/v1/'))return c.json({error:e instanceof HttpError?e.message:'API request failed',trace_id:c.get('traceId')},(e instanceof HttpError?e.status:500) as any);
    if (e instanceof HttpError) {
      const title = e.status === 403 ? "Not permitted" : e.status === 404 ? "Not found" : e.status === 402 ? "Plan limit reached" : "Something is not right";
      return errorPage(c, e.status, title, e.message);
    }
    console.error("[error]", c.req.method, routePath(c)||"unmatched", process.env.LBT_DEBUG_ERRORS ? e : "");
    return errorPage(c, 500, "Something went wrong", "An unexpected error occurred. Refresh to check the record status before retrying. If it keeps happening, contact us with the time it happened.");
  });
  return app;
}
