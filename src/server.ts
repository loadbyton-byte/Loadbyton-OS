import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { openDb } from "./db/client.js";
import { buildApp } from "./app.js";
import { ensureCatalog } from "./platform/catalog.js";
import { processProvisioningQueue } from "./platform/provisioning.js";
import { drainOutbox, defaultHandlers } from "./platform/outbox.js";
import { accountingHandlers } from "./adapters/accounting.js";
import { applyDueSubscriptionChanges } from "./platform/billing.js";

const db = await openDb();
await db.system((c) => ensureCatalog(c));
const app = buildApp(db);

const server = serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`LOAD|BY|TON.store listening on :${i.port} (${config.isProd ? "production" : "development"})`));

// In-process workers for the pilot. Run as a separate process (RUN_WORKERS=false on web) once load justifies it.
let timers: NodeJS.Timeout[] = [];
if (config.runWorkers) {
  const handlers = { ...defaultHandlers, ...accountingHandlers(db) };
  const safe = (name: string, fn: () => Promise<unknown>) => () => fn().catch((e) => console.error(`[worker:${name}]`, e));
  timers = [
    setInterval(safe("provisioning", () => processProvisioningQueue(db)), 5_000),
    setInterval(safe("outbox", () => drainOutbox(db, handlers)), 5_000),
    setInterval(safe("subscriptions", () => applyDueSubscriptionChanges(db)), 10 * 60_000),
  ];
}
const shutdown = async () => { timers.forEach(clearInterval); server.close(); await db.close(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
