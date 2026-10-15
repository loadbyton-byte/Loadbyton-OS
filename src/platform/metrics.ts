import type { Db } from "../db/client.js";

// ── worker heartbeats: each background loop stamps itself, so "the process is up but the queue has stopped" is detectable
const beats = new Map<string, { at: number; ok: boolean }>();
export const markWorker = (name: string, ok = true, at = Date.now()) => beats.set(name, { at, ok });
export const resetWorkers = () => beats.clear();
export const WORKERS = { provisioning: 5_000, outbox: 5_000, subscriptions: 60_000, storage: 60_000, ledger: 300_000, feeds: 300_000, orders: 300_000, einvoice: 60_000, privacy: 3_600_000 } as const;

/** Healthy when every expected worker ran successfully within 3 × its interval (and has run at least once after the start-up grace). */
export function workersStatus(expected: Record<string, number> = WORKERS, now = Date.now(), startedAt = processStart, graceMs = 60_000) {
  const stale: string[] = [];
  for (const [name, every] of Object.entries(expected)) {
    const b = beats.get(name);
    if (!b) { if (now - startedAt > graceMs) stale.push(`${name}: never ran`); continue; }
    if (!b.ok) stale.push(`${name}: last run failed`);
    else if (now - b.at > Math.max(3 * every, 30_000)) stale.push(`${name}: silent for ${Math.round((now - b.at) / 1000)}s`);
  }
  return { ok: stale.length === 0, stale };
}
const processStart = Date.now();

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
class Out {
  private lines: string[] = []; private seen = new Set<string>();
  gauge(name: string, help: string, value: number, labels: Record<string, string> = {}) {
    if (!this.seen.has(name)) { this.seen.add(name); this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`); }
    const l = Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(",");
    this.lines.push(`${name}${l ? `{${l}}` : ""} ${Number.isFinite(value) ? value : 0}`);
  }
  text() { return this.lines.join("\n") + "\n"; }
}

/**
 * Operational metrics in Prometheus text format. Only aggregate counts — never tenant names, emails or amounts per customer —
 * so scraping it from a monitoring service does not export personal or commercial data.
 */
export async function collectMetrics(db: Db): Promise<string> {
  const o = new Out(), q = async <T = any>(sql: string) => (await db.query<T>(sql)).rows;
  const t0 = Date.now();
  let up = 1;
  try { await db.query("SELECT 1"); } catch { up = 0; }
  o.gauge("lbt_db_up", "1 when the database answers", up);
  o.gauge("lbt_db_ping_seconds", "Round trip of SELECT 1", (Date.now() - t0) / 1000);
  o.gauge("lbt_process_uptime_seconds", "Process uptime", process.uptime());
  o.gauge("lbt_process_resident_memory_bytes", "Resident set size", process.memoryUsage().rss);
  if (!up) return o.text();

  for (const r of await q(`SELECT topic, status, count(*)::int n FROM outbox GROUP BY topic, status`)) o.gauge("lbt_outbox_rows", "Outbox rows by topic and status (dead and staff.review need a human)", r.n, { topic: r.topic, status: r.status });
  o.gauge("lbt_outbox_oldest_pending_seconds", "Age of the oldest deliverable pending outbox row", Number((await q(`SELECT coalesce(extract(epoch from now() - min(created_at)),0) s FROM outbox WHERE status='pending' AND topic <> 'staff.review'`))[0].s));
  for (const r of await q(`SELECT state, count(*)::int n FROM provision_jobs GROUP BY state`)) o.gauge("lbt_provision_jobs", "Provisioning jobs by state", r.n, { state: r.state });
  for (const r of await q(`SELECT outcome, count(*)::int n FROM payment_events WHERE received_at > now() - interval '24 hours' GROUP BY outcome`).catch(() => [])) o.gauge("lbt_payment_events_24h", "Payment provider events in the last 24 hours by outcome", r.n, { outcome: r.outcome });
  for (const r of await q(`SELECT status, count(*)::int n FROM orders GROUP BY status`)) o.gauge("lbt_orders", "Subscription orders by status", r.n, { status: r.status });
  o.gauge("lbt_orders_pending_over_1h", "Orders still pending an hour after checkout started", Number((await q(`SELECT count(*) n FROM orders WHERE status='pending' AND created_at < now() - interval '1 hour'`))[0].n));
  for (const r of await q(`SELECT status, count(*)::int n FROM subscriptions GROUP BY status`)) o.gauge("lbt_subscriptions", "Subscriptions by status", r.n, { status: r.status });
  o.gauge("lbt_tenants_active", "Active tenants", Number((await q(`SELECT count(*) n FROM tenants WHERE status='active'`))[0].n));
  o.gauge("lbt_invoices_sync_failed", "Invoices whose accounting sync failed", Number((await q(`SELECT count(*) n FROM invoices WHERE sync_status='failed'`))[0].n));
  // delivery: cash that has been with riders for more than a day, and rider events that were stored but not applied
  o.gauge("lbt_delivery_cash_with_riders_over_24h", "Uncounted COD collections older than 24 hours", Number((await q(`SELECT count(*) n FROM dlv_collections WHERE settlement_id IS NULL AND collected_at < now() - interval '24 hours'`))[0].n));
  o.gauge("lbt_delivery_events_not_applied_7d", "Rider events stored but not applied in the last 7 days", Number((await q(`SELECT count(*) n FROM dlv_events WHERE NOT applied AND server_time > now() - interval '7 days'`))[0].n));
  o.gauge("lbt_delivery_webhooks_dead", "Merchant webhook deliveries that exhausted their retries", Number((await q(`SELECT count(*) n FROM outbox WHERE topic='merchant.webhook' AND status='dead'`))[0].n));
  const w = workersStatus();
  o.gauge("lbt_workers_ok", "1 when every background worker ran recently", w.ok ? 1 : 0);
  for (const [name, b] of beats) o.gauge("lbt_worker_last_run_seconds", "Seconds since a worker last ran", (Date.now() - b.at) / 1000, { worker: name, ok: String(b.ok) });
  return o.text();
}
