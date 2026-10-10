# Architecture

## Three planes (blueprint §19)

- **Commerce plane** — `src/web/public.tsx`, `src/platform/catalog.ts`: site, sector diagnostic, plans, checkout entry.
- **Control plane** — `src/platform/{billing,entitlements,provisioning,admin,outbox}.ts`, `src/web/admin.tsx`: subscriptions,
  entitlements, payment reconciliation, provisioning, domains, support grants, plan catalogue. Uses the table-owner DB role
  (`db.system`). Operational tenant staff cannot edit subscription facts through the company API.
- **Operating plane** — `src/ops/*`, `src/web/app-*.tsx`: tenant business records. Uses `db.tenant(tenantId, …)`, which opens a
  transaction, `SET LOCAL ROLE lbt_app`, and sets `app.tenant_id`; RLS policies do the rest.

Modular monolith + background workers (`src/server.ts`). Domain modules take a `Conn` and a `Ctx`, so high-volume pieces
(tracking, integrations) can be lifted into separate workers later without changing business logic.

## Tenant isolation

1. Authenticated `sessions` → `memberships` → `Ctx {tenantId, roles, perms}` (`platform/auth.ts#resolveCtx`).
2. All operating queries run inside `db.tenant()`; RLS `USING/WITH CHECK (tenant_id = current_setting('app.tenant_id'))`.
3. `lbt_app` has no access to `users` (a `team_members` view exposes name/email only); `audit_log` is insert/select only.
4. Files: `storage_key` is `<tenant>/<uuid>`; reads re-check the prefix and a short-lived HMAC signature; served as attachments
   with `sandbox` CSP and `nosniff`.
5. Tested for DB queries, edited IDs over HTTP, documents, exports, composite FKs, `users` table (`tests/platform|http`).
   **Not yet covered by tests:** search indexes and AI retrieval (not built), caches (none), queues beyond outbox.

## Money path (blueprint §22)

`createOrder` (immutable priced lines + tax note) → provider session → **signed webhook** (`t=…,v1=hmac`, 5-minute window) →
`processPaymentEvent` in one transaction: dedupe on `(provider,event_id)`, validate reference/amount/currency, lock order,
transition order → subscription → entitlements (append-only, effective-dated) → provisioning job → outbox. Browser redirects
never grant access. Failed-after-success, duplicates, replays under new event ids, mismatches and refunds are handled and recorded.

## Provisioning (blueprint §23)

State: `information_pending → queued → provisioning → validation → ready → onboarding` (+`failed`/`cancelled`).
Nine steps, each with a unique idempotency key; a retry skips completed steps and every step is itself idempotent.
**Infrastructure adapters are simulated** (`simulatedAdapters`): DNS/routing and TLS must be implemented before advertising the
24-hour target as a promise.

## Quoting → cash

Enquiry (dedupe by source ref or content hash) → quote versions (lock on send; revision = new version) → approval gates
(margin, credit exposure, expired supplier rate) → acceptance converts to exactly one job (unique `quote_id`; quota consumed
with an idempotent reference) → milestones (delivery requires POD) → costs (estimate → reconciled actual) → invoice from approved
charges (per-line tax code) → receipts → financial closure with explicit blockers. Operational and financial status are separate.

Margin is shown three ways: quotation estimate, updated expected, actual reconciled (null while any cost is only estimated).

## Accounting bridge (blueprint §17)

`outbox(topic='accounting.invoice', key='invoice:<id>')` unique. The handler calls `adapter.find(reference)` **before**
`create`, so a retry after a provider timeout reconciles instead of double-posting. Default adapter is a CSV/export stub; a real
provider needs selection (decision §32) and connector acceptance tests.

## Known limitations

See `TRACEABILITY.md`. Notably: no inbound email/WhatsApp intake, no delivery/COD or customs modules, no contract-3PL custody workflows, no marketplace or carrier connectors, no native ledger,
no Arabic/RTL, no e-invoicing adapter, rate limiting is in-memory, ClamAV scanning is a hook not an integration, and the `pg`
(production) driver path is untested against a live PostgreSQL server in this repository's CI (PGlite is real Postgres but
single-connection).

## Transport (blueprint §14)

`src/ops/transport.ts` (+ `web/app-transport.tsx`, `web/app-driver.tsx`, `migrations/002_transport.sql`).

- **Billing unit:** the *trip* (`trips_per_month`, consumed with reference `trip:<id>`). Plan version 2 adds the key; version 1
  subscriptions fall back to their jobs allowance (published versions are immutable). Driver logins are *limited seats*: they do not
  use full-user seats but are capped at 5× the full-user allowance.
- **Assignment rules:** `checkAssignment` returns every reason at once — vehicle weight/volume capacity, retired vehicle,
  maintenance blocks, overlapping trips for vehicle *and* driver, expired *blocking* compliance items before the trip ends.
  Dispatch re-runs the checks and requires the driver to have a login.
- **Driver events** (`trip_events`, immutable): keyed by a client-generated `client_event_id` (unique per tenant) behind an advisory
  lock, so replays and concurrent syncs create at most one record. The device time is stored verbatim; implausible clocks are
  clamped to server time and flagged. Rules: earliest arrival wins; departure never precedes arrival; delivery stops cannot be left
  without proof of delivery; the first POD is retained and later ones are stored-not-applied; expense events create `recorded`
  expenses that only an independent approver can decide, and decisions are final. Events for completed trips never mutate state;
  events for another driver's trip are refused outright.
- **Offline:** `public/assets/driver.js` queues actions in `localStorage` with their ids and phone time and POSTs batches to
  `/app/driver/sync` (CSRF via signed token header). Limits: there is no service worker, so the page must have been opened online
  first; photo upload needs signal.
- **Money:** order charges → `issueInvoice` (shared with forwarding: controlled numbering, per-line tax, accounting outbox).
  Detention (minutes beyond free time × hourly rate) is billable once per stop (`source_leg_id` unique). Trip profit = order
  charges − subcontract (actual, else estimate) − approved expenses − unapproved expenses (flagged as estimates); `reconciled`
  only when nothing is estimated.

## E-commerce fulfilment (blueprint §15)

`src/ops/fulfilment.ts`, `src/ops/fulfil-billing.ts` (+ `web/app-fulfil.tsx`, `migrations/003_fulfilment.sql`).

- **Stock model.** `stock_levels(sku, location)` holds `on_hand` and `reserved` with `CHECK (reserved <= on_hand)` and no negatives, so
  overselling is impossible even if code is wrong. `moveStock` is the *only* code path that changes `on_hand`: a guarded update plus one
  row in the append-only `stock_movements` ledger. Locations: `bin` (the only allocatable kind) and system `RECV`, `STAGE`, `QUAR`.
  Picking moves bin → `STAGE` (physically still in the building, no longer allocatable); shipping removes it from `STAGE`; damage and
  returns for inspection land in `QUAR`, which is never sold from.
- **Reservation.** `stock_allocations` ties an order line to a bin; the reserved remainder is `qty - picked_qty`. `planBins` takes one
  bin that covers the need (smallest sufficient) or else the fullest bins. Without `allow_partial` an order reserves *every* line or
  *none* (status `backordered`), so stock is never stranded on an order that cannot complete. Whenever stock appears (receipt, return
  restock, transfer into a bin, count up, cancelled order) the waiting orders are re-allocated oldest first.
- **Concurrency.** Every stock-mutating operation takes one per-tenant advisory lock first (`pg_advisory_xact_lock(tenant:stock)`), so
  receives, allocations, picks and counts serialise instead of racing or deadlocking; throughput is deliberately traded for
  correctness in the pilot. Idempotency: orders on (merchant, external ref); receipts on a per-form token (checked *before* any state
  validation, so a retry is a no-op); billing on `source_key`.
- **Order status is derived** from the line/allocation quantities (`refreshStatus`), never set by hand, so it cannot drift:
  `new/backordered → allocated → picking → picked → packed → shipped` (+ `cancelled`).
- **Counts.** A count that differs creates a `pending` adjustment recording the system quantity at count time. Approval requires
  `wh.approve` and (unless owner) a different person; if on-hand changed since, the adjustment becomes `stale` and nothing moves.
  When the counted quantity is below what is reserved, the newest reservations at that bin are released and those orders re-allocate or wait.
- **Billing.** Events create `fulfil_charges` at the merchant's rate card at that moment (rate 0/missing = no charge; later rate
  changes never rewrite history). `invoiceMerchant` groups unbilled charges by (type, rate, tax) into one invoice through the shared
  `issueInvoice`; voiding the invoice returns the charges to the unbilled pool. Plan billing unit: `fulfilment_orders_per_month`
  (plan v3; older versions fall back to the jobs allowance).
- **Invariants checked by `npm run verify`:** ledger sum = on_hand; reserved = Σ unpicked allocations; line quantities = their
  allocations; staging = Σ picked-not-shipped; shipped orders have one shipment and shipped = packed; SKU merchant = order/inbound
  merchant; receipts = line totals; fulfilment invoices total their charges.

