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

See `TRACEABILITY.md`. Notably: no inbound email/WhatsApp intake, no transport/warehouse/delivery/customs modules, no native ledger,
no Arabic/RTL, no e-invoicing adapter, rate limiting is in-memory, ClamAV scanning is a hook not an integration, and the `pg`
(production) driver path is untested against a live PostgreSQL server in this repository's CI (PGlite is real Postgres but
single-connection).
