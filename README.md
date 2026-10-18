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
> collection → rider cash handover with independent variance approval → merchant remittance, fees netted → rate-card billing). Each sector becomes *Available* only after its own release gate has current, independently accepted evidence. Otherwise it remains *Pilot* or *Planned*. All 18 sector gates block an unrestricted official release; a waiver does not establish sector acceptance. Evidence is recorded in `/admin/readiness`. The Customs module (case management and a controlled handover to the licensed broker's channel, not filing), e-invoicing (UBL generation, a configurable accredited-provider adapter, and Wafeq and Aigentrix add-on adapters), the native ledger, storefront order connectors (Shopify and WooCommerce) and address geocoding are built; Magento and Amazon order-pull profiles, DHL Express domestic labels, Google Routes traffic-aware routing, bank-grade request signing and mutual TLS, a plain-text RF terminal and a device-certificate register are built but **unproven against the live providers**; a noon connector (field map built from a captured delivery), air waybill messages (built, never sent for you) and a VT100 RF terminal are also built; live provider acceptance, sending to airlines and vendor-proprietary RF protocols are **not** (blueprint §29: "Do not sell all 18 sector packs at launch").
See [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) for a section-by-section status and [`docs/DECISIONS.md`](docs/DECISIONS.md) for the §32 decisions still needed.

The deployment options are implemented: web/worker and scanner containers on **Oracle Cloud** or a single **AWS EC2** instance (Terraform and GitHub Actions deploy in `infra/aws`, see `docs/DEPLOY_AWS_LEAN.md`), **Cloudflare** routing/tunnel, **Neon** or **Supabase** PostgreSQL, private S3-compatible objects (Cloudflare R2, Oracle Object Storage or Supabase) and **Upstash Redis** rate limiting. Several web instances can run together (background jobs hold short database leases). **Stripe/Razorpay** hosted checkout supports card and eligible Google Pay methods, verified webhooks, payment reconciliation, immutable tax/merchant snapshots and optional reviewed INR quotes for an Indian Razorpay merchant. Production configuration refuses development mocks or missing required settings. No real credentials or production resources have been created.

Additional work includes company MFA, a Zoho Books draft-invoice bridge, reviewed SMTP replies, shared inbox/calendar SLAs, privacy request review, setup appointments/customer acceptance, controlled customer CSV migration/rollback, management reports, warehouse lot/expiry/serial controls and Arabic/RTL invoice documents. Encrypted database-plus-object backups and isolated restore verification are executable. Further verified controls include reviewed count schedules, provider chargeable-weight rules, scoped assistant drafts, daily storage contracts/automatic accrual, independent transport expense receipts, six versioned source-linked shipment document drafts, dual-key encryption maintenance and independently approved COD cash recovery/refund/corrections with current cash/liability reporting.

This is a substantial implementation of the blueprint, **not a claim that the entire future portfolio is release-complete**. See [the clause map](docs/TRACEABILITY.md), [remaining portfolio work](docs/IMPLEMENTATION_BACKLOG.md), [deployment instructions](docs/DEPLOYMENT.md) and [release acceptance](docs/RELEASE_ACCEPTANCE.md). External provider acceptance, actual infrastructure recovery, legal/tax settings and specialist reviews remain deployment gates; advanced connectors and warehouse/AI roadmap items remain explicit software work.

## Brochure mode (default)

LOAD|BY|TON.OS is sold as a **brochure + demo + client portal**, not as hosted software with a usage meter:

1. **Learn** — the public site explains the product (`/`, `/how-it-works`), gives each of the 18 sectors a full page (`/sectors/:slug`: what the pack does, stages, documents, roles, what is free, which paid add-ons apply, what the client enters themselves) and shows free vs paid with every add-on price (`/pricing`). `/demo` and `/demo/:slug` are click-through walkthroughs.
2. **Register** (`/start`) — one form creates the account, the first request (Free = one sector; Paid = several sectors/integrations/bespoke, quoted) and the **brand kit** (name, colours, logo upload or "no logo yet").
3. **Dedicated dashboard** (`/app`) — a five-step journey, the request clock, "what we provide for your sector", and tabs for Requests, Features, Brand kit, Messages, Your details and Plan & payment.
4. **24-hour clock** (`DELIVERY_HOURS`) — starts only when everything needed is in: the confirmed brand kit, and for paid work the agreed quote (bespoke) or the paid monthly plan (add-ons). The dashboard says exactly what a request is waiting for.
5. **Extra features** (`/app/features`) — free features (`src/platform/features.ts`) are simply added; any paid add-on makes the request paid and needs the cheapest monthly plan that covers it. The client pays through the normal checkout (`/app/billing/pay/*`); the verified payment webhook starts the clock (`onOrderPaid`). A plan they already pay for that is high enough covers it. Cancel at period end from `/app/plan`.
6. **One point of contact** — a message thread per request, visible to client and staff (`/app/messages`, `/admin/requests/:id`), with unread badges, an email that carries no message text, and immutable history.
7. **Private details stay private** — we never ask for TRN, bank/IBAN, card numbers or passwords. Messages and brand notes containing them are refused (`src/lib/private-data.ts`), and `/app/guide` (`src/platform/private-guide.ts`) teaches where the client enters each one in their own admin panel, with a checklist.
8. Staff work the queue at `/admin/requests` (deadline-ordered, waiting-on-client flagged, unread flagged), open a request for its brand kit, files and thread, record the quote, and deliver with an https hand-off link and notes.

Brand files are validated by type, magic bytes and size, SVGs with script are refused, ClamAV scans them when configured, and they are served only to the owning client or staff as nosniff, sandboxed responses. `BROCHURE_MODE=false` restores the full multi-tenant operating platform (the operating plane is untouched, only fenced off). Operating-platform suites run with it off; `tests/requests.test.ts`, `tests/portal.test.ts` and `tests/portal-http.test.ts` cover the brochure flow.

Decisions still yours: the monthly plan prices (they reuse the planning prices in the plan catalogue), the wording of the plan cancellation terms, and which add-ons you are ready to sell before their provider acceptance (they are labelled Pilot).

## Quick start

```bash
npm ci
npm run dev                 # http://localhost:3000  (embedded Postgres in ./data/pg; PAYMENT_PROVIDER=mock)
npm test                    # 651 tests: isolation, payments, provisioning, quoting, finance, transport, offline sync, fulfilment & warehouse stock integrity, delivery/COD cash integrity, HTTP boundary
npm run seed-demo           # SEPARATE demo DB only — real workspaces always start empty. Run the demo with BROCHURE_MODE=false so the operating screens open.
                            #   showcase@loadbyton.example — ONE workspace with all eighteen sectors (the six full packs plus the twelve reviewed specialist packs, each with a live customer case) on the Enterprise plan,
                            #     a full team (showcase.{sales,pricing,coordinator,dispatcher,finance,customs,auditor,portal}@…), phone views (showcase.driver1@…, showcase.rider1@…) and build requests at every stage
                            #   demo@… (freight) · transport@… (dispatcher) · driver1@… (phone view) · fulfilment@… (e-commerce) · warehouse@… (3PL manager) · delivery@… (courier owner) · customs@… (customs broker) · rider1@… (rider phone view)
                            #   admin@… (commercial_admin) and auditor@… sign in at /login then enter the authenticator code for /admin; the seed prints their authenticator links once
                            #   every password is demo-password-123; re-running only adds what is missing and never resets a staff authenticator
npm run create-staff -- you@example.com "Your Name" '<12+ char password>' commercial_admin   # prints TOTP secret
CHROME=/usr/bin/chromium npm run e2e   # freight browser walkthrough against port 3000
# Delivery/COD browser walkthroughs (e2e:delivery, e2e:fulfilment-delivery) are NOT in this checkout: see docs/IMPLEMENTATION_BACKLOG.md
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
