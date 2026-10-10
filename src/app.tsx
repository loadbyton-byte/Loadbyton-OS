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
import { warehouse } from "./web/app-warehouse.js";
import { driver } from "./web/app-driver.js";
import { admin } from "./web/admin.js";
import { PublicShell } from "./web/ui.js";

export function buildApp(db: Db) {
  const app = new Hono<Env>();
  app.use("*", securityHeaders);
  app.use("/assets/*", async (c, next) => { await next(); c.header("Cache-Control", "public, max-age=300"); });
  app.use("/assets/*", serveStatic({ root: "./public" }));
  app.use("/brand/*", serveStatic({ root: "./public" }));
  app.get("/healthz", async (c) => { await db.query("SELECT 1"); return c.json({ ok: true }); });
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
  app.route("/", warehouse);
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
