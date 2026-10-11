# LOAD|BY|TON.store

*Run the movement. Know the margin.* — UAE-first logistics SaaS. Implements the **Master Blueprint v1.0 (10 Oct 2026)**:
public commerce site, a tenant-isolated company application, billing/entitlements/provisioning, and a privileged control console.

Six operational pilots cover forwarding, transport, fulfilment, custody warehouse, Delivery/COD and manual Customs handover. Twelve specialist profiles now also have controlled manual case workspaces, readiness reviews, issued evidence, approvals, immutable events, quotas, UI/API and service-fee collection. Their public release remains **Planned** until sector specialists validate representative real cases.

The requested deployment stack is implemented: **Oracle Cloud** web/worker and scanner containers, **Cloudflare** routing/tunnel, **Neon** PostgreSQL, **Supabase** private objects and **Upstash Redis** rate limiting. **Stripe/Razorpay** hosted checkout supports card and eligible Google Pay methods, verified webhooks, payment reconciliation, immutable tax/merchant snapshots and optional reviewed INR quotes for an Indian Razorpay merchant. Production configuration refuses development mocks or missing required settings. No real credentials or production resources have been created.

Additional work includes company MFA, a Zoho Books draft-invoice bridge, reviewed SMTP replies, shared inbox/calendar SLAs, privacy request review, setup appointments/customer acceptance, controlled customer CSV migration/rollback, management reports, warehouse lot/expiry/serial controls and Arabic/RTL invoice documents. Encrypted database-plus-object backups and isolated restore verification are executable. Further verified controls include reviewed count schedules, provider chargeable-weight rules, scoped assistant drafts, daily storage contracts/automatic accrual, independent transport expense receipts, six versioned source-linked shipment document drafts, dual-key encryption maintenance and independently approved COD cash recovery/refund/corrections with current cash/liability reporting.

This is a substantial implementation of the blueprint, **not a claim that the entire future portfolio is release-complete**. See [the clause map](docs/TRACEABILITY.md), [remaining portfolio work](docs/IMPLEMENTATION_BACKLOG.md), [deployment instructions](docs/DEPLOYMENT.md) and [release acceptance](docs/RELEASE_ACCEPTANCE.md). External provider acceptance, actual infrastructure recovery, legal/tax settings and specialist reviews remain deployment gates; advanced connectors and warehouse/AI roadmap items remain explicit software work.

## Quick start

```bash
npm ci
npm run dev                 # http://localhost:3000  (embedded Postgres in ./data/pg; PAYMENT_PROVIDER=mock)
npm test                    # acceptance tests: isolation, payments, provisioning, quoting, finance, transport, offline sync, fulfilment & warehouse stock integrity, HTTP boundary
npm run seed-demo           # SEPARATE demo DB only — real workspaces always start empty
                            #   demo@… (freight) · transport@… (dispatcher) · driver1@… (phone view) · fulfilment@… (e-commerce) · warehouse@… (3PL manager) — all demo-password-123
npm run create-staff -- you@example.com "Your Name" '<12+ char password>' commercial_admin   # prints TOTP secret
CHROME=/usr/bin/chromium npm run e2e   # freight browser walkthrough against port 3000
npm run e2e:delivery         # Delivery/COD browser walkthrough; use CHROME as above
npm run verify              # database-wide invariants (use after every restore test)
```

For file-based local overrides, copy `.env.example` to `.env` and run `node --env-file=.env --import tsx src/server.ts`; otherwise export the settings before `npm run dev`.

Production configuration is supplied through secure environment variables or the private Compose env file. Follow [DEPLOYMENT.md](docs/DEPLOYMENT.md); the real payment and storage adapters are implemented, but live acceptance cannot be claimed before your merchant/provider credentials are supplied. `npm run preflight` checks setting names without printing credentials.

The same acceptance suites can run against a **disposable PostgreSQL test cluster** with database-creation permission:
```bash
TEST_POSTGRES_URL=postgres://postgres@localhost:5433/postgres npm test -- --maxWorkers=1 --no-file-parallelism
```
Each suite gets an isolated temporary database and removes it after the run. CI runs both PGlite and PostgreSQL 16. For browser tests, use a disposable app database too; the walkthroughs create tenants, business records and simulated payments. `BASE`, `CHROME`, and `SHOTS` override the URL, Chromium executable and screenshot directory. Restricted containers may require `CHROME_NO_SANDBOX=true`; the default keeps Chromium's sandbox enabled.

Optional metrics: configure a private `METRICS_TOKEN` of at least 32 characters and scrape `/metrics` with a matching Bearer token. See [monitoring instructions](ops/monitoring/README.md).

## Surfaces

| Surface | Path / host (blueprint §11) | Notes |
|---|---|---|
| Commerce | `www` — `/`, `/sectors`, `/products`, `/find-my-bundle`, `/pricing`, `/how-activation-works`, `/integrations`, `/security`, `/status`, `/legal/*`, `/start`, `/contact` | Honest Available / Pilot / Planned labels |
| Company app | `app` / `<slug>` — `/app/*` | Role-gated; navigation shows only relevant modules; `/app/transport/*` needs the Road transport sector |
| Fulfilment | `/app/fulfilment/*` | Needs the E-commerce fulfilment sector; board, orders, pick list, inbound, stock & counts, returns, catalogue, locations, billing activity. Merchants (portal role) see only their own stock and orders |
| Warehouse | `/app/warehouse/*` | Needs the Contract warehouse / 3PL sector: board, inbound, dispatch, stock + ledger, counts, locations & SKUs, activity billing; customer portal users see only their own stock |
| Driver app | `/app/driver/*` | Phone-first, large touch targets; `driver` seats are limited (no other pages), offline queue + idempotent sync |
| Control console | `admin` — `/admin/*` | Platform staff + TOTP; separate privilege; audited |
| Guidance | `help` — `/help` | |

Host → tenant is only a *hint* (verified `domain_mappings`); **authenticated membership** authorises access.

## Stack and layout

TypeScript · Hono (SSR JSX, no client build) · PostgreSQL (PGlite for dev/test, `pg` in production) · transactional outbox + separate production workers (in-process workers for development).

```
src/db        schema (migrations/001_init.sql), tenant-scoped transactions (RLS)
src/platform  catalog, tenants, auth, billing, entitlements, provisioning, outbox, admin, invariants
src/ops       freight, transport, fulfilment, warehouse, delivery/COD, Customs, twelve specialist profiles, inbox/migration/reports
src/adapters  payments, Zoho, private storage/scanning, Redis, Cloudflare, SMTP
src/web       routes + UI (public, auth, app-core/sales/ops, admin)
tests         platform, ops, transport, fulfilment, warehouse, delivery, customs, metrics and HTTP acceptance
docs          architecture, traceability, runbooks, decisions
```

## Key invariants (enforced in the database, not just code)

- Row-level security on every tenant table; the app runs as non-owner role `lbt_app`; tenant comes from membership, never a request field.
- Composite FKs (`tenant_id`, `id`) stop cross-tenant parent references.
- Plan versions, usage events, audit log: immutable (triggers). Sent quote versions: locked.
- One provider event → one transition (`payment_events` unique); one order → one provisioning job; one quote → one job.
- Controlled, gap-free document numbering; integer minor-unit money.
- Stock cannot be oversold (`reserved <= on_hand`, no negatives), every change to `on_hand` has one immutable ledger row, and an order
  line's allocated ≥ picked ≥ packed ≥ shipped chain is a CHECK constraint. `npm run verify` reconciles ledger ↔ levels ↔ allocations ↔ staging.

## Licence / status

Pilot software. Prices are planning hypotheses, legal pages are drafts needing counsel review, and no certification
(e-invoicing ASP, customs, dangerous goods, cold chain, data protection) is claimed.
