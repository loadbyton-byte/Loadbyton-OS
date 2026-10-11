# Architecture

## Three planes (blueprint §19)

- **Commerce plane** — `src/web/public.tsx`, `src/platform/catalog.ts`: site, sector diagnostic, plans, checkout entry.
- **Control plane** — `src/platform/{billing,entitlements,provisioning,admin,outbox}.ts`, `src/web/admin.tsx`: subscriptions,
  entitlements, payment reconciliation, provisioning, domains, support grants, plan catalogue. Uses the table-owner DB role
  (`db.system`). Operational tenant staff cannot edit subscription facts through the company API.
- **Operating plane** — `src/ops/*`, `src/web/app-*.tsx`: tenant business records. Uses `db.tenant(tenantId, …)`, which opens a
  transaction, `SET LOCAL ROLE lbt_app`, and sets `app.tenant_id`; RLS policies do the rest.

Modular monolith + standalone production worker (`src/worker.ts`); `src/server.ts` can host in-process development workers. Domain modules take a `Conn` and a `Ctx`, so high-volume pieces
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
Development uses `simulatedAdapters`; production verifies Cloudflare wildcard routing and branded HTTPS. Exclusive expiring job leases prevent competing workers from claiming the same activation. Real routing/provider acceptance remains required before advertising an activation SLA.

## Quoting → cash

Enquiry (dedupe by source ref or content hash) → quote versions (lock on send; revision = new version) → approval gates
(margin, credit exposure, expired supplier rate) → acceptance converts to exactly one job (unique `quote_id`; quota consumed
with an idempotent reference) → milestones (delivery requires POD) → costs (estimate → reconciled actual) → invoice from approved
charges (per-line tax code) → receipts → financial closure with explicit blockers. Operational and financial status are separate.

Margin is shown three ways: quotation estimate, updated expected, actual reconciled (null while any cost is only estimated).

## Accounting bridge (blueprint §17)

`outbox(topic='accounting.invoice', key='invoice:<id>')` unique. The handler calls `adapter.find(reference)` **before**
`create`, so a retry after a provider timeout reconciles instead of double-posting. The configured default is a tenant-specific Zoho Books draft-invoice adapter with encrypted credentials and explicit tax/currency mappings. CSV export never impersonates synchronization. Live controller acceptance, credit notes and bank/receipt reconciliation remain separate scope.

## Production boundaries

The provider stack is Oracle/Cloudflare/Neon/Supabase/Upstash. Stripe and Razorpay use hosted checkout and provider-specific raw signatures; optional INR Razorpay quotes preserve both catalogue and charged money on immutable orders. MFA secrets/connectors are encrypted; company MFA and shared Redis limits are required in production. Supabase objects are private, upload scanning uses ClamAV INSTREAM and downloads validate prefix/hash. SMTP delivery requires TLS. Custom hostname activation requires TXT ownership and active Cloudflare routing/certificate/HTTPS; operator provisioning remains explicit.

New worker leases fence outbox/provisioning claims. Notification delivery is at least once; uncertain inbox SMTP attempts enter human delivery review and cannot automatically resend. Metrics include queue depth/age, dead letters, activation delay/failure and accounting failures. Backup/restore code authenticates encrypted archives and reconciles database/object evidence. PostgreSQL acceptance uses isolated databases and serialized queries on each transaction connection; idle connection failures have a bounded handler.

Actual provider acceptance is pending secure credentials, region/private-bucket checks, restore/PITR/failover and real alert delivery. `IMPLEMENTATION_BACKLOG.md` lists additional software rather than describing these adapters as unbuilt.

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


## Warehouse (blueprint §15)

`src/ops/warehouse.ts` (+ `web/app-warehouse.tsx`, `migrations/004_warehouse.sql`). Sector slug `contract-warehouse-3pl`.

- **Owner separation is structural.** A SKU belongs to one customer (`wh_skus.owner_id`). Stock, movements and every order line carry
  `owner_id` and reference the SKU through the composite key `(tenant_id, owner_id, sku_id)`, so a row that mixes owners cannot be
  inserted — even by buggy code. Allocation only ever looks at the order owner's stock.
- **Ledger first.** `wh_movements` is immutable (trigger). `wh_stock` is a maintained balance; every change goes through the single
  `post()` function, which applies the balance change and appends the ledger row in one transaction, refuses negative stock, refuses to
  drop below what is reserved, enforces location capacity, and is idempotent on an optional client reference (advisory lock +
  unique key). `npm run verify` reconciles balances against the ledger, reservations against open allocations, transfers net to zero,
  receipt/dispatch quantities against the ledger and warehouse invoices against their charges.
- **Inbound:** notice (ASN) → receive per line into a location (receiving/storage; damaged **must** go to quarantine; good goods may
  not) → close with recorded variances. Over-receipt needs an explicit acceptance. The retry check runs *before* the business rules so
  a resent receipt that completed its line is reported as a repeat, not rejected as an over-receipt.
- **Outbound:** allocate → pick → dispatch. Allocation reserves oldest-first (`first_received_at`, carried across moves) from *storage*
  locations only (never quarantine or the receiving dock) and is all-or-nothing unless the operator accepts a partial shipment. A short
  pick releases the difference immediately. Dispatch ships exactly what was picked and posts the ledger; the unshipped remainder is
  closed (backorders are not modelled).
- **Counts:** the sheet snapshots system quantity but hides it from counters (blind). Lines that match at submit need no decision;
  variances need a *different* person with `wh.approve` (owners excepted, audited). If the stock moved after the snapshot the line is
  marked stale and goes back to the counters with a fresh snapshot — a count only proves the balance at the moment it was cut. An
  adjustment can never push stock below what is reserved. Stock found where the system expected none is added as a line.
- **Billing unit:** the warehouse *order* (an inbound notice or a dispatch order; `wh_orders_per_month`, reference `wh_in:<id>` /
  `wh_out:<id>`). Plan version 4 adds the key; v1/v2/v3 subscriptions fall back to their jobs allowance.
- **Money:** `accrue()` writes one `wh_charges` row per source event (`source_ref` unique): handling-in per receipt movement,
  handling-out per dispatched line, an outbound-order fee, and daily storage = end-of-day units from the ledger × rate for each
  *completed* company day (UTC+4), idempotent per owner-day, backfilled exactly. Rates are effective-dated per customer; a rate in
  effect cannot be edited, only superseded. Activity with no rate is kept as *unrated* and priced automatically when the rate is set
  (using the rate in effect on the day it happened) — it is never dropped and never invoiced at zero. Invoicing groups charges by
  (type, rate, tax) so a month of storage is one line, goes through the shared `issueInvoice`, and a void releases the charges.
- **Customer portal:** portal users see their own on-hand/reserved/on-hold units only (`portalStock`), nothing else of the warehouse.

## Delivery and COD

`src/ops/delivery.ts`, `src/web/app-delivery.tsx`, `migrations/005_delivery.sql`.
Parcels are customer-owned, tenant-scoped and metered with `delivery_parcels_per_month` (falls back to the existing jobs allowance until approved plan versions introduce a dedicated limit). Merchant references are idempotent; conflicting retries fail. Active driver logins are required for dispatch, and limited driver seats can act only on their assigned parcels. Route references are manually assigned groups, not optimised routes.

Attempts, courier cash receipts, COD decisions and merchant remittances are immutable. Delivery needs recipient proof. Collection and cash handover retain actual amounts even when mismatched; a different finance approver must explain a mismatch. Remittances require reconciliation and cannot exceed the minimum of expected, collected and received cash less earlier remittances. Surpluses/shortages stay visible; a decision never manufactures cash or overwrites original evidence. Correction/recovery/refund entries for COD are still pending, so this is a limited pilot. Service-fee invoices use the shared invoice path and exclude customer-owned COD; authorised voids release the parcel fee for re-invoicing.

## Customs handover

`src/ops/customs.ts`, `src/web/app-customs.tsx`, `migrations/006_customs.sql`.
A case moves draft → ready → handed_over → inspection/cleared. Readiness requires invoice, packing list and transport-document evidence. Handover requires an official/authorised-agent reference; clearance requires attached release evidence. Permit applicability and specialist review remain manual. Owner/customs roles approve controlled transitions; coordinators can prepare cases. Deposits are immutable receipt/refund entries; refunds require a closed case and cannot exceed receipts. Cleared cases can invoice an immutable agreed service fee, separate from deposits; permitted cases require issued goods-specific permit evidence. No authority submission, duty assessment or authority disbursement is implemented. `customs_cases_per_month` falls back to the jobs allowance until commercial limits are approved.

## Monitoring

The authenticated `/metrics` endpoint exposes HTTP counts/latency and worker runs/errors without tenant/user/URL identifiers. It is disabled unless `METRICS_TOKEN` is at least 32 characters. Prometheus scrape and alert templates live in `ops/monitoring`; production scraping, alert delivery and canaries must still be deployed and tested.

## Specialist and shared workspaces

`specialist-profiles.ts` defines twelve typed manual profiles; `specialists.ts` enforces each state/event model. Readiness reviews have evidence/expiry, contract details are immutable, monetary references are deduplicated, excursions/damage/incidents require another approver, stock cannot exceed allocations, stages follow sequence, repairs block gate-out, transit guarantees precede activation, and agent settlements/fees reconcile before financial closure. Every table has tenant RLS/composite foreign keys. Public releases remain Planned until real subject-matter acceptance.

`workspace.ts` implements manual conversations, accepted handovers, Dubai working calendars, immutable reply versions, reviewed/consented SMTP delivery and staged source-file imports. Migration rollback only removes imported records unused by business foreign keys. Opening balances are not posted from unreviewed CSVs. `reports.ts` groups finance by currency and links reports to sources; sampling/stock-age limitations are displayed. `traceability.ts` adds immutable custody-lot/serial identity and expiry, FEFO and holds; serial movement/custody is one unit and mutations take the same tenant stock lock.

Setup, privacy, connection and scoped API modules live beside the operating modules. Privacy deletion requests are evidence/approval records, not fabricated erasure. Arabic invoice documents have RTL layout and isolate money direction; the full application remains English.

## Assistant draft boundary

`ops/assistant.ts` retrieves a fixed set of accessible forwarding fields and snapshots them with a canonical SHA-256 hash. `assistant_drafts` has tenant RLS, source/author integrity guards and immutable final evidence. The committed reservation precedes the optional external request; completion does not repeat generation. Quotas are a separate plan-v7 unit. A failed/interrupted provider request retains its conservative cost ceiling. Only the author with current source permissions can read/recover/export the draft. The OpenAI adapter has a fixed HTTPS endpoint, bounded request/output, no tools, no action execution, citation checks and personal-number/email filtering. Deterministic templates remain available when the provider is disabled/unavailable. Document extraction, report explanation and wider-sector retrieval still need their own implementation and acceptance.

## Daily fulfilment storage

`fulfil-storage.ts` adds immutable contract/day evidence to the existing fulfilment engine. The explicit pilot basis is closing occupied location per merchant at Dubai midnight, reconstructed from immutable movements. Staging is excluded. New reviewed terms begin at future month boundaries and have fixed AED pricing/tax/source validity. The shared stock mutex serializes contract approval, daily accrual and monthly snapshot exclusion; each merchant/day accrues once. `fulfil_charges` now protects its financial fields/deletion and preserves an agreed entity for daily charges. Invoicing and voiding may only change the invoice link; the day and pricing remain intact. `fulfil_storage_automation` provides separate finance-controlled enable/pause state; the bounded storage worker rechecks current authority and company/source eligibility, catches missing closed days, audits as system and never invoices. Physical pallet/cbm/peak bases and amendments require separate implementations.

### Generated document provenance and key maintenance

Forwarding templates and generated draft records are separate immutable tenant tables. The six fixed field schemas require explicit verified particulars and issued evidence for the exact source job. Immutable snapshots carry canonical SHA-256 integrity, template versions and append-only draft versions. SQL guards reject mismatched source jobs/template kinds; outputs always remain drafts. Private uploads and generated payload bytes share the tenant storage allowance and serialization lock.

MFA, accounting settings and invitation payloads share authenticated AES-256-GCM encryption. Optional dual-key readers support a bounded privileged maintenance migration in one locked transaction, with authenticated dry runs, rollback on any corrupt row and counts-only system audit. Secret rotation is never a tenant/API action or unattended worker job.

COD cash adjustments use immutable proposal and decision tables separate from original collection, handover, reconciliation and remittance events. All finance writes use the shared tenant delivery mutex; SQL insert guards enforce current finance membership, separate requester/reviewer, issued parcel evidence and cash/remittance bounds. Recovery, refund and custody corrections change explicit cash aggregates; merchant entitlement never changes by implication. There is no payment executor or automatic write-off behind these records.
