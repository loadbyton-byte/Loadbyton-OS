import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Db } from "./db/client.js";
import { config } from "./config.js";
import { RuntimeMetrics } from "./platform/metrics.js";
import { HttpError, safeEqual } from "./lib/util.js";
import { csrfMw, dbMw, securityHeaders, sessionMw, type Env } from "./web/mw.js";
import { pub } from "./web/public.js";
import { auth } from "./web/auth.js";
import { core } from "./web/app-core.js";
import { sales } from "./web/app-sales.js";
import { ops } from "./web/app-ops.js";
import { transport } from "./web/app-transport.js";
import { fulfil } from "./web/app-fulfil.js";
import { warehouse } from "./web/app-warehouse.js";
import { customs } from "./web/app-customs.js";
import { delivery } from "./web/app-delivery.js";
import { driver } from "./web/app-driver.js";
import { admin } from "./web/admin.js";
import { PublicShell } from "./web/ui.js";
import { security } from "./web/security.js";
import {connections} from './web/connections.js';
import {privacy} from './web/privacy.js';
import {service} from './web/service.js';
import {api} from './web/api.js';
import {workspace} from './web/workspace.js';
import {specialists} from './web/app-specialists.js';
import {weight} from './web/chargeable-weight.js';
import {schedule} from './web/count-schedules.js';
import {assistant} from './web/assistant.js';
import {fulfilStorage} from './web/fulfil-storage.js';
import {documentDrafts} from './web/document-drafts.js';
import {bodyLimit} from 'hono/body-limit';
import {collectQueueMetrics} from './platform/health.js';
import {routePath} from 'hono/route';

export function buildApp(db: Db, options: { metrics?: RuntimeMetrics; metricsToken?: string } = {}) {
  const app = new Hono<Env>();
  app.use("*", securityHeaders);
  app.use('*',bodyLimit({maxSize:config.maxUploadBytes+262144,onError:c=>c.text('Request too large',413)}));
  const metrics = options.metrics ?? new RuntimeMetrics();
  const metricsToken = options.metricsToken ?? config.metricsToken;
  app.use("*", metrics.middleware());
  app.get("/metrics", async (c) => {
    if (metricsToken.length < 32) return c.notFound();
    if (!safeEqual(c.req.header("authorization") ?? "", `Bearer ${metricsToken}`)) return c.text("Not authorised", 401);
    await collectQueueMetrics(db,metrics);
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.body(metrics.render());
  });
  app.use("/assets/*", async (c, next) => { await next(); c.header("Cache-Control", "public, max-age=300"); });
  app.use("/assets/*", serveStatic({ root: "./public" }));
  app.use("/brand/*", serveStatic({ root: "./public" }));
  app.get("/healthz", async (c) => { await db.query("SELECT 1"); return c.json({ ok: true }); });
  app.use("*", dbMw(db));
  app.use("*", sessionMw);
  app.use("*", csrfMw);

  app.route("/", pub);
  app.route("/", auth);
  app.route("/", security);
  app.route("/", admin);
  app.route("/", core);
  app.route("/", connections);
  app.route("/", privacy);
  app.route("/", service);
  app.route("/", api);
  app.route("/", sales);
  app.route("/", ops);
  app.route("/", transport);
  app.route("/", fulfil);
  app.route("/", warehouse);
  app.route("/", driver);
  app.route("/", delivery);
  app.route("/", customs);
  app.route("/", specialists);
  app.route("/", weight);
  app.route("/", schedule);
  app.route("/", assistant);
  app.route("/", fulfilStorage);
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
    if(c.req.path.startsWith('/api/v1/'))return c.json({error:e instanceof HttpError?e.message:'API request failed',trace_id:c.get('traceId')},(e instanceof HttpError?e.status:500) as any);
    if (e instanceof HttpError) {
      const title = e.status === 403 ? "Not permitted" : e.status === 404 ? "Not found" : e.status === 402 ? "Plan limit reached" : "Something is not right";
      return errorPage(c, e.status, title, e.message);
    }
    console.error("[error]", c.req.method, routePath(c)||'unmatched');
    return errorPage(c, 500, "Something went wrong", "An unexpected error occurred. Refresh to check the record status before retrying. If it keeps happening, contact us with the time it happened.");
  });
  return app;
}
