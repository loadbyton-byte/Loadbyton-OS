# LOAD|BY|TON.store

*Run the movement. Know the margin.* — UAE-first logistics SaaS. Implements the **Master Blueprint v1.0 (10 Oct 2026)**:
public commerce site, a tenant-isolated company application, billing/entitlements/provisioning, and a privileged control console.

> **What is built, honestly.** The blueprint's first product — **Forwarding Starter** (enquiry → quote → job → supplier costs →
> documents/milestones → invoice → collection) — is implemented end to end, on top of the commerce and control planes.
> The other sector packs, Transport/Warehouse/Delivery/Customs modules, e-invoicing, native ledger and real infrastructure/payment
> adapters are **not** built and are shown publicly as *Planned* (blueprint §29: "Do not sell all 18 sector packs at launch").
> See [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) for a section-by-section status and [`docs/DECISIONS.md`](docs/DECISIONS.md) for the §32 decisions still needed.

## Quick start

```bash
npm install
cp .env.example .env        # optional; dev defaults work
npm run dev                 # http://localhost:3000  (embedded Postgres in ./data/pg; PAYMENT_PROVIDER=mock)
npm test                    # 40 tests: isolation, payments, provisioning, quoting, finance, HTTP boundary
npm run seed-demo           # SEPARATE demo DB only — real workspaces always start empty
npm run create-staff -- you@example.com "Your Name" '<12+ char password>' commercial_admin   # prints TOTP secret
npm run e2e                 # browser walkthrough against a running server (needs Chromium)
npm run verify              # database-wide invariants (use after every restore test)
```

Production-like: `docker compose up` (PostgreSQL 16). `PAYMENT_PROVIDER=mock` is refused in production; secrets must be ≥32 chars.

## Surfaces

| Surface | Path / host (blueprint §11) | Notes |
|---|---|---|
| Commerce | `www` — `/`, `/sectors`, `/products`, `/find-my-bundle`, `/pricing`, `/how-activation-works`, `/integrations`, `/security`, `/status`, `/legal/*`, `/start`, `/contact` | Honest Available / Pilot / Planned labels |
| Company app | `app` / `<slug>` — `/app/*` | Role-gated; navigation shows only relevant modules |
| Control console | `admin` — `/admin/*` | Platform staff + TOTP; separate privilege; audited |
| Guidance | `help` — `/help` | |

Host → tenant is only a *hint* (verified `domain_mappings`); **authenticated membership** authorises access.

## Stack and layout

TypeScript · Hono (SSR JSX, no client build) · PostgreSQL (PGlite for dev/test, `pg` in production) · transactional outbox + in-process workers.

```
src/db        schema (migrations/001_init.sql), tenant-scoped transactions (RLS)
src/platform  catalog, tenants, auth, billing, entitlements, provisioning, outbox, admin, invariants
src/ops       enquiries, quotes, jobs, finance, documents, dashboard, team, import, export
src/adapters  accounting bridge (find-before-create idempotency)
src/web       routes + UI (public, auth, app-core/sales/ops, admin)
tests         platform, ops, http, extras (acceptance scenarios §30)
docs          architecture, traceability, runbooks, decisions
```

## Key invariants (enforced in the database, not just code)

- Row-level security on every tenant table; the app runs as non-owner role `lbt_app`; tenant comes from membership, never a request field.
- Composite FKs (`tenant_id`, `id`) stop cross-tenant parent references.
- Plan versions, usage events, audit log: immutable (triggers). Sent quote versions: locked.
- One provider event → one transition (`payment_events` unique); one order → one provisioning job; one quote → one job.
- Controlled, gap-free document numbering; integer minor-unit money.

## Licence / status

Pilot software. Prices are planning hypotheses, legal pages are drafts needing counsel review, and no certification
(e-invoicing ASP, customs, dangerous goods, cold chain, data protection) is claimed.
