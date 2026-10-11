# Monitoring

The app exposes Prometheus text metrics at `/metrics` only when `METRICS_TOKEN` is set to a private token of at least 32 characters. The scrape request must send `Authorization: Bearer <token>`. Missing/incorrect tokens get 401; an unconfigured endpoint gets 404. Keep the endpoint on the internal application network.

HTTP labels contain registered route patterns, method and status, never actual customer IDs, recipient data or query strings. Metrics include request counts, latency histogram, active requests and per-worker run/error counts. They are process-local and reset on restart; scrape every app replica. Queue metrics also report pending/dead depth, oldest age, delayed/failed provisioning and failed invoice synchronization, due custody counts and pending/uncertain assistant costs and storage contracts with missing closed-day accruals. Provider outages appear through workers and queue failures; direct vendor health canaries require the real deployment.

Deploy Prometheus with `prometheus.yml` and `alerts.yml` mounted read-only under `/etc/prometheus`. Mount the matching scrape token securely at `/run/secrets/metrics_token`; the secret file must be readable by the Prometheus process. Targets `web:3000` and `worker:3001` use the Compose service names; change it for the selected hosting environment. Configure the chosen Alertmanager destination and notification receiver in deployment settings. Never commit a token or notification credential.

Validate before deployment:
```bash
promtool check config --syntax-only ops/monitoring/prometheus.yml
promtool check rules ops/monitoring/alerts.yml
```

Validated with Prometheus 3.2.1: configuration syntax and all ten alert rules passed. Automated tests verify authentication, request metrics, worker failure counters and absence of recipient/URL identifiers. Production rollout remains pending: verify real scrapes, exercise a worker error and app outage on staging, receive an alert, acknowledge it and record recovery before marking the monitoring release gate complete.

The optional overlay is `ops/production/monitoring.compose.yml`. Mount the same bearer token for web/worker scrapes using the secret file referenced there. Configure Alertmanager receivers and incident ownership before paid release. Monitoring templates contain no notification credentials.
