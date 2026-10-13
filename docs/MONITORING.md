# Monitoring

The app exposes three endpoints. It does **not** page anyone: wire them to whatever alerting you use (Better Stack, UptimeRobot, Grafana Cloud, Prometheus + Alertmanager, Cloudflare Health Checks…).

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /healthz` | Liveness: the process answers and the database answers `SELECT 1`. | none |
| `GET /readyz` | Readiness: database reachable **and** (when this process runs workers) the provisioning, outbox and subscription loops have each run successfully recently. `503` with the reason otherwise. | none |
| `GET /metrics` | Prometheus text, aggregate counts only (no tenant names, emails or per-customer amounts). `404` unless `METRICS_TOKEN` is set. | `Authorization: Bearer $METRICS_TOKEN` |

Point an external uptime check at `https://www.yourdomain/readyz` (expect 200). `/readyz` is the better page-me signal: a process can be up while its queue has stopped.

## Series

| Series | Meaning | Alert when |
|---|---|---|
| `lbt_db_up` | database answers | `== 0` for 1 min |
| `lbt_workers_ok` | every worker ran recently | `== 0` for 2 min |
| `lbt_outbox_rows{topic,status="dead"}` | emails / SMS / webhooks / accounting that exhausted retries | `> 0` (look at `topic`) |
| `lbt_outbox_rows{topic="staff.review",status="pending"}` | items waiting for a human (refunds, **payments that could not be applied**, failed provisioning) | `> 0` for 1 h |
| `lbt_outbox_oldest_pending_seconds` | age of the oldest undelivered row | `> 900` |
| `lbt_provision_jobs{state="failed"}` | provisioning failures | `> 0` |
| `lbt_payment_events_24h{outcome="rejected"}` | provider events refused (amount/reference mismatch, unknown order) | `> 0` |
| `lbt_orders_pending_over_1h` | checkouts that started and never completed | trend only |
| `lbt_invoices_sync_failed` | accounting sync failures | `> 0` |
| `lbt_delivery_cash_with_riders_over_24h` | uncounted COD cash older than a day | `> 0` |
| `lbt_delivery_events_not_applied_7d` | rider events stored but not applied | rising trend |
| `lbt_delivery_webhooks_dead` | merchant webhook deliveries given up on | `> 0` |
| `lbt_db_ping_seconds`, `lbt_process_resident_memory_bytes`, `lbt_process_uptime_seconds` | health | latency `> 1`, memory growth, uptime resets |

## Example Prometheus rules

```yaml
groups:
- name: loadbyton
  rules:
  - alert: LbtDatabaseDown
    expr: lbt_db_up == 0
    for: 1m
    labels: { severity: page }
  - alert: LbtWorkersStopped
    expr: lbt_workers_ok == 0
    for: 2m
    labels: { severity: page }
  - alert: LbtDeadLetters
    expr: sum by (topic) (lbt_outbox_rows{status="dead"}) > 0
    for: 5m
    labels: { severity: ticket }
  - alert: LbtStaffReviewWaiting
    expr: lbt_outbox_rows{topic="staff.review",status="pending"} > 0
    for: 1h
    labels: { severity: ticket }
  - alert: LbtPaymentRejected
    expr: lbt_payment_events_24h{outcome="rejected"} > 0
    labels: { severity: page }
  - alert: LbtCodCashOverdue
    expr: lbt_delivery_cash_with_riders_over_24h > 0
    for: 1h
    labels: { severity: ticket }
```

Scrape config: `metrics_path: /metrics`, `scheme: https`, `authorization: { type: Bearer, credentials: <METRICS_TOKEN> }`. With Cloudflare in front, add a WAF *skip* rule for `/metrics` from your scraper's IPs, or scrape through the tunnel network.

## What counts as “monitored”
A sector moves from *Pilot* to *Available* only when these alerts are routed to a named on-call person **and** have been exercised (kill the database / stop a worker in staging and confirm the page arrives). That is an operating practice, not code, so it is deliberately not claimed here.

## Sentry error reporting

Set `SENTRY_DSN` (Sentry → Project → Settings → Client Keys) in `.env.production` to report unexpected errors from the web and worker processes. Empty = off. 4xx `HttpError`s are not reported; 5xx and unhandled errors are, tagged with `trace_id`, `route` and `service`. Cookies, request bodies, query strings, auth headers and user objects are stripped before sending (`src/platform/sentry.ts`). `SENTRY_TRACES_SAMPLE_RATE` defaults to 0 (no performance traces). Set `SENTRY_RELEASE` to the git SHA at deploy time.
