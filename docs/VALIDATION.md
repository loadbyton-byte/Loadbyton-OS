# Verification evidence — 10–11 October 2026

This is development verification of the reviewed checkout, not evidence of live merchant/provider or sector certification. Tests use reserved addresses, fake gateway fixtures and isolated local databases. No production deployment, actual charge/refund, customer email or DNS change was made.

| Check | Result | Scope |
|---|---|---|
| `npm run typecheck` | Passed | All current TypeScript code |
| `npm test -- --maxWorkers=1 --no-file-parallelism` | **220 tests, 25 files passed** | Embedded PGlite, isolated test databases |
| Same suite with `TEST_POSTGRES_URL` | **220 tests, 25 files passed** | Disposable PostgreSQL 16 container |
| `npm run e2e` | Passed; no browser errors | Real Chromium: signup, parties, enquiry, issued provider tariff/chargeable-weight calculation, quote approval/acceptance, source-linked assistant review draft, versioned packing-list draft with an actual printed PDF, job milestones/POD, invoice/receipt, mock paid upgrade |
| `npm run e2e:fulfilment-delivery` | Passed | Paid two-sector signup → source stock receipt → reserve/pick/pack/ship → one linked COD parcel, reciprocal lineage, issued daily-storage terms and automation enable/pause |
| `npm run e2e:transport` | Passed | Real Chromium: driver invite/dispatch/expense → missing-receipt refusal → actual assigned-driver upload → independent approval |
| `npm run e2e:delivery` | Passed | Real Chromium: courier/finance invites, parcel dispatch, POD/COD, shortage and self-review refusal, independent reconciliation, issued recovery evidence and second-person cash approval, bounded remittance, service invoice |
| `npm run verify` | All invariants hold | Development dataset and restored PostgreSQL dataset |
| Web image build and runtime | Passed; Docker health **healthy** | `node:22-alpine`, non-root application, disposable PostgreSQL, loopback health check with proxy disabled; freight document/PDF and COD/report browser workflows also passed against this final shipping image |
| Native scanner image build and runtime | Passed; daemon ping passed | Debian Bookworm/ClamAV 1.4.3; correct non-root config permissions/foreground logging and installed health client; actual build on amd64; arm64 runtime acceptance still required |
| ClamAV actual INSTREAM protocol | Passed | Clean fixture accepted; custom **verification-only** signature rejected. This does not validate current production virus definitions |
| Oracle Terraform `fmt -check` / `validate` | Passed | OCI provider 7.32 configuration; no plan/apply against an account |
| Production Compose validation | Passed | Structural validation with environment resolution/interpolation disabled; actual secrets remain to be supplied |
| Prometheus `check config --syntax-only` / `check rules` | Passed; **10 alert rules** | Web/worker scrape configuration and alert syntax, without real delivery |
| `git diff --check` | Passed | Whitespace check of tracked changes |

## Encrypted backup and restore drill

Thirty-four migrations were applied to the disposable PostgreSQL source. An exported consistent snapshot, private document catalogue, every public table count and integrity-checked local private objects were packed and authenticated with AES-256-GCM. The encrypted archive was restored into a newly created empty database and a different private local object directory.

The restore command passed: **six private documents**, catalogue/table counts, membership and audit checks, all dynamically discovered tenant-RLS tables, and financial/stock/platform invariants. A separate `npm run verify` on the restored database also passed. Snapshot timestamp: `2026-10-11T00:26:50.041Z`.

This drill verifies the local PostgreSQL/object recovery mechanism. It does not establish Neon PITR, Supabase/OCI region failover, off-instance archive durability, live production RPO/RTO, or customer acceptance. Backup keys used in this drill are test-only fixtures and must never be reused for production.

## Coverage and limits

The suite includes tenancy/role/subscription fences, provider signing and retries, checkout/INR snapshot integrity, company/staff TOTP replay protection, shared rate-limit failures, storage/scanner protocols, Zoho draft retry reconciliation, API scopes/idempotency, leased outbox work, consent/recipient-approved replies and uncertain SMTP review, controlled party migrations, all twelve manual specialist profiles, custody FEFO/serial controls, Customs evidence/deposits/fees and immutable COD reconciliation, evidenced cash recovery/refund/corrections, source-linked printable document drafts and atomic encryption-key rotation.

These checks complement the existing forwarding, transport, fulfilment and warehouse tests. They do not prove that advanced automation or integrations listed in `IMPLEMENTATION_BACKLOG.md` exist. Whole-application Arabic localisation is pending; the tested Arabic/RTL scope is invoice documents.

CI now includes embedded and PostgreSQL suites plus the four browser workflows. The updated workflow has been prepared in the checkout; it has not been run on GitHub during this session. Chromium was available at `/usr/bin/chromium` locally; a Playwright browser download was blocked by the environment's CDN policy, so the successful local runs explicitly used the installed executable.

See `RELEASE_ACCEPTANCE.md` for live acceptance and `DEPLOYMENT.md` for credential names and deployment procedure. This verification was completed before GitHub publication; no production deployment has been performed.

## Ongoing expansion

The 220-test full runs include reviewed count schedules, scoped assistant drafts/cost reservation, daily storage history/automatic catch-up, independent transport expense receipt approval, six immutable generated-document draft types, key rotation and the independent COD cash ledger. The final COD reporting additions are covered by 22 focused COD/Delivery/workspace regression checks on each database engine and the real browser workflow. Seven document-draft checks on each engine additionally confirm that whitespace-only issuer metadata stays draft and cannot serve as issued evidence. Four browser workflows pass. The thirty-four-migration recovery drill passed with non-empty assistant/count-policy/storage-contract/automation/document-template/generated-draft/expense-receipt/COD-adjustment fixtures and six integrity-checked private objects.

The rotation CLI was rehearsed against an isolated restored database: an authentication-only dry run, atomic apply and a follow-up dry run with zero pending secrets. MFA enrollment/replay counters, provider configuration and invitation delivery status were preserved. The maintenance changes never contacted providers or sent invitations. An isolated worker runtime exercised the registered storage loop with successful counters and zero storage errors; unit/transaction tests cover actual scoped day accrual and concurrent-worker behavior.

Broader work and external acceptance remain explicit in `IMPLEMENTATION_BACKLOG.md` and `RELEASE_ACCEPTANCE.md`; these checks do not establish live merchant eligibility, authoritative document issuance or completion of future expansion modules.
