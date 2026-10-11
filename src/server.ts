import { serve } from "@hono/node-server";
import { RuntimeMetrics } from "./platform/runtime-metrics.js";
import { config } from "./config.js";
import { openDb } from "./db/client.js";
import { buildApp } from "./app.js";
import { ensureCatalog } from "./platform/catalog.js";
import { seedGates } from "./platform/readiness.js";
import { startWorkers } from './platform/workers.js';

const db = await openDb();
await db.system((c) => ensureCatalog(c));
await seedGates(db);
const metrics = new RuntimeMetrics();
const app = buildApp(db, { metrics });

const server = serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`LOAD|BY|TON.store listening on :${i.port} (${config.isProd ? "production" : "development"})`));

// In-process workers for the pilot. Run as a separate process (RUN_WORKERS=false on web) once load justifies it.
const stopWorkers=config.runWorkers?startWorkers(db,metrics):async()=>{};
const shutdown = async () => { await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),stopWorkers()]); await db.close(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
