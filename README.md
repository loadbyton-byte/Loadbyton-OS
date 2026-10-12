# LOAD|BY|TON.store

*Run the movement. Know the margin.* — UAE-first logistics SaaS. Implements the **Master Blueprint v1.0 (10 Oct 2026)**:
public commerce site, a tenant-isolated company application, billing/entitlements/provisioning, and a privileged control console.

> **What is built, honestly.** Five sector workflows run end to end on top of the commerce and control planes:
> **Forwarding Starter** (enquiry → quote → job → supplier costs → documents/milestones → invoice → collection),
> **Transport** (orders → trip planning with capacity/availability/compliance checks → dispatch → offline-tolerant driver app with
> proof of delivery → expenses, detention, subcontracting → invoice → trip profitability),
> **E-commerce fulfilment** (merchant SKUs → inbound receiving → stock ledger with reservation → pick / scan-verified pack / ship →
> returns → count adjustments with independent approval → activity billing and merchant invoice) and
> **Contract warehouse / 3PL** (customer-owned custody stock on an immutable movement ledger → receiving with variances and quarantine →
> FIFO allocation, pick, dispatch → blind cycle counts with independent approval → activity billing → invoice) and
> **Delivery / COD** (merchant parcels → delivery runs → rider phone app with proof of delivery and failed attempts → exact-cash COD
> collection → rider cash handover with independent variance approval → merchant remittance, fees netted → rate-card billing). All 18 sector packs are now shown as *Available* by owner decision; the per-sector evidence (qualified review, live cases, production monitoring and alert drills) is still tracked in `/admin/readiness` and is not implied by the label. The Customs module, the Customs module, marketplace and
> carrier-label connectors, barcode/RF hardware, e-invoicing, native ledger, live GPS / route optimisation and real infrastructure/payment
> adapters are **not** built and are shown publicly as *Planned* (blueprint §29: "Do not sell all 18 sector packs at launch").
> See [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) for a section-by-section status and [`docs/DECISIONS.md`](docs/DECISIONS.md) for the §32 decisions still needed.

The requested deployment stack is implemented: **Oracle Cloud** web/worker and scanner containers, **Cloudflare** routing/tunnel, **Neon** PostgreSQL, **Supabase** private objects and **Upstash Redis** rate limiting. **Stripe/Razorpay** hosted checkout supports card and eligible Google Pay methods, verified webhooks, payment reconciliation, immutable tax/merchant snapshots and optional reviewed INR quotes for an Indian Razorpay merchant. Production configuration refuses development mocks or missing required settings. No real credentials or production resources have been created.

Additional work includes company MFA, a Zoho Books draft-invoice bridge, reviewed SMTP replies, shared inbox/calendar SLAs, privacy request review, setup appointments/customer acceptance, controlled customer CSV migration/rollback, management reports, warehouse lot/expiry/serial controls and Arabic/RTL invoice documents. Encrypted database-plus-object backups and isolated restore verification are executable. Further verified controls include reviewed count schedules, provider chargeable-weight rules, scoped assistant drafts, daily storage contracts/automatic accrual, independent transport expense receipts, six versioned source-linked shipment document drafts, dual-key encryption maintenance and independently approved COD cash recovery/refund/corrections with current cash/liability reporting.

This is a substantial implementation of the blueprint, **not a claim that the entire future portfolio is release-complete**. See [the clause map](docs/TRACEABILITY.md), [remaining portfolio work](docs/IMPLEMENTATION_BACKLOG.md), [deployment instructions](docs/DEPLOYMENT.md) and [release acceptance](docs/RELEASE_ACCEPTANCE.md). External provider acceptance, actual infrastructure recovery, legal/tax settings and specialist reviews remain deployment gates; advanced connectors and warehouse/AI roadmap items remain explicit software work.

## Quick start

```bash
npm ci
npm run dev                 # http://localhost:3000  (embedded Postgres in ./data/pg; PAYMENT_PROVIDER=mock)
npm test                    # 170+ tests: isolation, payments, provisioning, quoting, finance, transport, offline sync, fulfilment & warehouse stock integrity, delivery/COD cash integrity, HTTP boundary
npm run seed-demo           # SEPARATE demo DB only — real workspaces always start empty
                            #   demo@… (freight) · transport@… (dispatcher) · driver1@… (phone view) · fulfilment@… (e-commerce) · warehouse@… (3PL manager) · delivery@… (courier owner) · customs@… (customs broker) · rider1@… (rider phone view) — all demo-password-123
npm run create-staff -- you@example.com "Your Name" '<12+ char password>' commercial_admin   # prints TOTP secret
CHROME=/usr/bin/chromium npm run e2e   # freight browser walkthrough against port 3000
npm run e2e:delivery         # Delivery/COD browser walkthrough; use CHROME as above
npm run verify              # database-wide invariants (use after every restore test)
```

Production-like: `docker compose up` (PostgreSQL 16). Merchant API: [`docs/API.md`](docs/API.md) · monitoring: [`docs/MONITORING.md`](docs/MONITORING.md).
Real deployment — Cloudflare tunnel, Neon/Supabase, Upstash, Stripe/Razorpay on an Oracle Cloud VM — is in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md); the same stack on AWS (two accounts, S3, SES, offsite backups) is in [`docs/DEPLOY_AWS.md`](docs/DEPLOY_AWS.md); every setting (including your legal/GST identity) is an environment variable documented in `.env.example`.
`PAYMENT_PROVIDERS=mock` is refused in production, and a half-configured provider stops the process at start-up; secrets must be ≥32 chars.

## Surfaces

| Surface | Path / host (blueprint §11) | Notes |
|---|---|---|
| Commerce | `www` — `/`, `/sectors`, `/products`, `/find-my-bundle`, `/pricing`, `/how-activation-works`, `/integrations`, `/security`, `/status`, `/legal/*`, `/start`, `/contact` | Honest Available / Pilot / Planned labels |
| Company app | `app` / `<slug>` — `/app/*` | Role-gated; navigation shows only relevant modules; `/app/transport/*` needs the Road transport sector |
| Fulfilment | `/app/fulfilment/*` | Needs the E-commerce fulfilment sector; board, orders, pick list, inbound, stock & counts, returns, catalogue, locations, billing activity. Merchants (portal role) see only their own stock and orders |
| Warehouse | `/app/warehouse/*` | Needs the Contract warehouse / 3PL sector: board, inbound, dispatch, stock + ledger, counts, locations & SKUs, activity billing; customer portal users see only their own stock |
| Customs | `/app/customs/*` | Needs the Customs brokerage sector (pilot): board, cases with goods lines (HS codes format-checked only; duty/VAT estimated from broker-entered rates), evidence checklist with uploads, second-person approval, printable handover pack + lines CSV, then recording the declaration number, assessment, inspections, queries, duty payments, deposits/guarantees (client money), release and invoicing with disbursements. **It does not file anything**: lodging is done by a licensed broker in Dubai Trade / Mirsal 2 |
| Delivery | `/app/delivery/*` | Needs the Courier / last mile sector: board, parcels (form + CSV), printable labels, runs, riders, cash desk (handover, variance approval, merchant payouts), rates & billing, integrations (merchant API keys, signed webhooks, SMS opt-in). Merchants (portal role) see only their own parcels and payouts. Public parcel tracking at `/t/<token>` |
| Driver app | `/app/driver/*` | Phone-first, large touch targets; `driver` seats are limited (no other pages); trips **and** delivery runs; offline queue + idempotent sync |
| Control console | `admin` — `/admin/*` | Platform staff + TOTP; separate privilege; audited |
| Guidance | `help` — `/help` | |
| Marketing pages | `/features`, `/industries`, `/for-forwarders`, `/for-transporters`, `/trust`, `/compliance`, `/about`, `/blog`, `/contact` | Thirteen public pages with the cinematic home; see [`docs/FRONTEND_SYSTEM.md`](docs/FRONTEND_SYSTEM.md) |
| Chat | assistant `/chat/bot`, live chat `/chat/live/*`, staff inbox `/admin/chats` | Own implementation; no third-party service |
| Operations | `/healthz` · `/readyz` · `/metrics` | Liveness · readiness (database + workers) · Prometheus metrics behind `METRICS_TOKEN` |

Host → tenant is only a *hint* (verified `domain_mappings`); **authenticated membership** authorises access.

## Stack and layout

TypeScript · Hono (SSR JSX, no client build) · PostgreSQL (PGlite for dev/test, `pg` in production) · transactional outbox + separate production workers (in-process workers for development).

```
src/db        schema (migrations/001_init.sql), tenant-scoped transactions (RLS)
src/platform  catalog, tenants, auth, billing, entitlements, provisioning, outbox, admin, invariants
src/ops       freight, transport, fulfilment, warehouse, delivery/COD, Customs, twelve specialist profiles, inbox/migration/reports
src/adapters  Zoho, malware scanning, Cloudflare, Razorpay quote helpers (payments, mail, storage and rate limiting live in `src/platform/payments`, `adapters/mail.ts`, `lib/storage.ts`, `lib/ratelimit.ts`)
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
