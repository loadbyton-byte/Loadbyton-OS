import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { freshDb, newTenant } from "./helpers.js";
import { collectMetrics, markWorker, resetWorkers, workersStatus } from "../src/platform/metrics.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });
const saved = { token: config.metricsToken, workers: config.runWorkers };
beforeEach(() => resetWorkers());
afterEach(() => { config.metricsToken = saved.token; config.runWorkers = saved.workers; });

describe("monitoring", () => {
  it("/metrics does not exist without a token and needs the exact bearer token with one", async () => {
    config.metricsToken = "";
    expect((await app.request("/metrics")).status).toBe(404);
    config.metricsToken = "m".repeat(32);
    expect((await app.request("/metrics")).status).toBe(404);
    expect((await app.request("/metrics", { headers: { authorization: "Bearer wrong" } })).status).toBe(404);
    const ok = await app.request("/metrics", { headers: { authorization: `Bearer ${"m".repeat(32)}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/plain");
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("exports aggregate operational series and no customer data", async () => {
    const t = await newTenant(db, "Secret Customer Ltd");
    await db.system((c) => c.query(`INSERT INTO outbox(tenant_id,topic,key,payload,status) VALUES ($1,'email','m1','{"email":"private@person.example"}','dead'),(NULL,'staff.review','m2','{}','pending')`, [t.tenantId]));
    markWorker("outbox", true);
    const text = await collectMetrics(db);
    expect(text).toContain("lbt_db_up 1");
    expect(text).toMatch(/lbt_outbox_rows\{topic="email",status="dead"\} [1-9]/);
    expect(text).toMatch(/lbt_outbox_rows\{topic="staff.review",status="pending"\} [1-9]/);
    for (const series of ["lbt_tenants_active", "lbt_orders_pending_over_1h", "lbt_delivery_cash_with_riders_over_24h", "lbt_delivery_events_not_applied_7d", "lbt_workers_ok", "lbt_process_uptime_seconds"]) expect(text).toContain(series);
    expect(text).toContain('lbt_worker_last_run_seconds{worker="outbox",ok="true"}');
    expect(text).toMatch(/# TYPE lbt_db_up gauge/);
    for (const secret of ["Secret Customer", "private@person.example", t.tenantId]) expect(text).not.toContain(secret);
  });

  it("readiness reflects the workers: silent, failing or never-started workers make it 503; separate-worker deployments are exempt", () => {
    const now = Date.now(), long = now - 10 * 60_000;
    expect(workersStatus({ outbox: 5_000 }, now, now).ok).toBe(true);                                       // just started: grace
    expect(workersStatus({ outbox: 5_000 }, now, long).stale[0]).toMatch(/outbox: never ran/);
    markWorker("outbox", true, now);
    expect(workersStatus({ outbox: 5_000 }, now, long).ok).toBe(true);
    markWorker("outbox", true, now - 5 * 60_000);
    expect(workersStatus({ outbox: 5_000 }, now, long).stale[0]).toMatch(/silent for 300s/);
    markWorker("outbox", false, now);
    expect(workersStatus({ outbox: 5_000 }, now, long).stale[0]).toMatch(/last run failed/);
  });

  it("/readyz is 200 when the process runs no workers and 503 when they should be running and are not", async () => {
    config.runWorkers = false;
    const a = await app.request("/readyz");
    expect(a.status).toBe(200); expect(await a.json()).toMatchObject({ ok: true });
    config.runWorkers = true;
    for (const w of ["provisioning", "outbox", "subscriptions"]) markWorker(w, true);
    expect((await app.request("/readyz")).status).toBe(200);
    markWorker("outbox", false);
    const b = await app.request("/readyz");
    expect(b.status).toBe(503); expect(JSON.stringify(await b.json())).toContain("outbox: last run failed");
  });
});
