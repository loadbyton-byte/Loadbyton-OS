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
> collection → rider cash handover with independent variance approval → merchant remittance, fees netted → rate-card billing). All five are *Pilot*,
> not *Available* (no production monitoring yet). The other sector packs, the Customs module, marketplace and
> carrier-label connectors, barcode/RF hardware, e-invoicing, native ledger, live GPS / route optimisation and real infrastructure/payment
> adapters are **not** built and are shown publicly as *Planned* (blueprint §29: "Do not sell all 18 sector packs at launch").
> See [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) for a section-by-section status and [`docs/DECISIONS.md`](docs/DECISIONS.md) for the §32 decisions still needed.

> See [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) for a section-by-section status and [`docs/DECISIONS.md`](docs/DECISIONS.md) for the §32 decisions still needed.

## Quick start

```bash
npm install
cp .env.example .env        # optional; dev defaults work
npm run dev                 # http://localhost:3000  (embedded Postgres in ./data/pg; PAYMENT_PROVIDER=mock)
npm test                    # 170+ tests: isolation, payments, provisioning, quoting, finance, transport, offline sync, fulfilment & warehouse stock integrity, delivery/COD cash integrity, HTTP boundary
npm run seed-demo           # SEPARATE demo DB only — real workspaces always start empty
                            #   demo@… (freight) · transport@… (dispatcher) · driver1@… (phone view) · fulfilment@… (e-commerce) · warehouse@… (3PL manager) · delivery@… (courier owner) · rider1@… (rider phone view) — all demo-password-123
npm run create-staff -- you@example.com "Your Name" '<12+ char password>' commercial_admin   # prints TOTP secret
npm run e2e                 # browser walkthrough against a running server (needs Chromium)
npm run verify              # database-wide invariants (use after every restore test)
```

Production-like: `docker compose up` (PostgreSQL 16). Real deployment — Oracle Cloud VM, Cloudflare tunnel, Neon/Supabase, Upstash, Stripe/Razorpay — is in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md); every setting (including your legal/GST identity) is an environment variable documented in `.env.example`.
`PAYMENT_PROVIDERS=mock` is refused in production, and a half-configured provider stops the process at start-up; secrets must be ≥32 chars.

## Surfaces

| Surface | Path / host (blueprint §11) | Notes |
|---|---|---|
| Commerce | `www` — `/`, `/sectors`, `/products`, `/find-my-bundle`, `/pricing`, `/how-activation-works`, `/integrations`, `/security`, `/status`, `/legal/*`, `/start`, `/contact` | Honest Available / Pilot / Planned labels |
| Company app | `app` / `<slug>` — `/app/*` | Role-gated; navigation shows only relevant modules; `/app/transport/*` needs the Road transport sector |
| Fulfilment | `/app/fulfilment/*` | Needs the E-commerce fulfilment sector; board, orders, pick list, inbound, stock & counts, returns, catalogue, locations, billing activity. Merchants (portal role) see only their own stock and orders |
| Warehouse | `/app/warehouse/*` | Needs the Contract warehouse / 3PL sector: board, inbound, dispatch, stock + ledger, counts, locations & SKUs, activity billing; customer portal users see only their own stock |
| Delivery | `/app/delivery/*` | Needs the Courier / last mile sector: board, parcels (form + CSV), runs, riders, cash desk (handover, variance approval, merchant payouts), rates & billing. Merchants (portal role) see only their own parcels and payouts. Public parcel tracking at `/t/<token>` |
| Driver app | `/app/driver/*` | Phone-first, large touch targets; `driver` seats are limited (no other pages); trips **and** delivery runs; offline queue + idempotent sync |
| Control console | `admin` — `/admin/*` | Platform staff + TOTP; separate privilege; audited |
| Guidance | `help` — `/help` | |

Host → tenant is only a *hint* (verified `domain_mappings`); **authenticated membership** authorises access.

## Stack and layout

TypeScript · Hono (SSR JSX, no client build) · PostgreSQL (PGlite for dev/test, `pg` in production) · transactional outbox + in-process workers.

```
src/db        schema (migrations/001_init.sql), tenant-scoped transactions (RLS)
src/platform  catalog, tenants, auth, billing, entitlements, provisioning, outbox, admin, invariants
src/ops       enquiries, quotes, jobs, transport, fulfilment (+billing), finance, documents, dashboard, team, import, export
src/adapters  accounting bridge (find-before-create idempotency)
src/web       routes + UI (public, auth, app-core/sales/ops, admin)
tests         platform, ops, transport, fulfilment (+http), http, extras (acceptance scenarios §30)
src/ops       enquiries, quotes, jobs, transport, warehouse, finance, documents, dashboard, team, import, export
src/adapters  accounting bridge (find-before-create idempotency)
src/web       routes + UI (public, auth, app-core/sales/ops, admin)
tests         platform, ops, transport, warehouse, http, extras (acceptance scenarios §30)
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
