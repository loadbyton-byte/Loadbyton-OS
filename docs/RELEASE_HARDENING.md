# Release hardening review — 15 October 2026

Base: `bc740b3c29dde6f8fc026899210ce0859ac9d825` (the commit named by the supplied audit summary). The previous checkout had unrelated Git history. Its frontend changes were preserved in a stash and `/tmp/loadbyton-frontend-before-update.patch`, then reapplied on `fix/release-hardening`. No production deployment or upstream push was performed.

The upload contains the audit summary, not the linked ZIP or its full 26 findings and 77-task checklist. The checkout also contains an earlier repository/pipeline review in `AUDIT_2026-10-15.md`; its remaining requirements were checked alongside the supplied summary. This review addresses the reproducible findings visible in that summary and additional defects found while tracing them. It does not constitute an exhaustive semantic audit or live provider acceptance.

## Corrections

| Area | Result |
| --- | --- |
| Carrier delivery | Negative/failed/attempted statuses are checked before success; only definite success words map to delivered by default. Explicit configured mappings remain authoritative. |
| Team privileges | Non-owners cannot grant permissions they do not hold, either through role changes or invitations. Invitation acceptance rechecks the issuer's current authority. |
| Company verification | Approval checks confirmed owner email, confirmed phone, and a tenant-matching, unheld licence document. Reject/reopen cannot substitute for these checks. Reviewer roles are also checked by the service. |
| Export privacy | Conversation subjects and message bodies obey field authorization; support grants cannot use exports to obtain those values. |
| Financial identity | Migration 075 freezes seller and customer details on every newly issued invoice. Invoice views, CSV, credit-note views, accounting bridge and e-invoice payloads use the snapshots. Database guards prevent rewriting identity. Correct incomplete invoices through void/reissue where legally appropriate; already submitted tax documents require controller/provider correction procedures. |
| Freight profitability | Issued credit-note net amounts reduce expected and reconciled freight revenue, including fully credited invoices. The owner dashboard uses the same treatment. |
| POD evidence | Recording freight delivery requires issued, unheld proof for the exact job. Draft or held evidence cannot satisfy delivery. |
| Driver location | Same-origin driver pages may request geolocation; browser user permission and company consent are still required. Other pages retain a denied policy. |
| RF revocation | Connected terminals refresh membership and roles, close after revocation, and recheck access inside the lookup/movement transaction. |
| Sector release | Six pilots and twelve planned sector baselines replace unconditional availability. Only current accepted evidence releases a sector. All 18 individual gates block strict readiness; waivers do not release sectors. |
| Bookkeeping exports | Tenant exports include general-ledger settings, accounts, journals, lines, manual entries and foreign-exchange revaluations. Exports refuse more than 100,000 records rather than silently truncate or issue an unbounded query. |
| Deployment enforcement | Deployment calls the complete CI and security workflows for its revision, validates required AWS settings, and requires production preflight plus strict readiness before startup. |
| Deployment recovery | A fresh offsite backup is required using the previous revision before switching code or applying migrations. Offsite verification failure now returns an error instead of falling through to a success exit. Backup, build, preflight, migration, readiness, startup and health-check failures enter the recovery path. Recovery does not require the failed release's readiness acceptance. Application rollback does not reverse database migrations. |
| Shared-phone privacy | Authenticated driver HTML is no longer cached for offline display. Only the anonymous shell is cached; old driver caches are removed without deleting other applications' caches. Unscoped legacy action queues are not imported into the next driver's identity. Per-driver action queues remain. |
| Independent journals | Owners cannot approve their own manual journal proposals. A database constraint also rejects new self-decisions; pre-existing decisions are not rewritten. |
| Order imports | Rejected or deferred order details hold the import cursor back for retry, avoiding permanent loss when the details budget is exhausted. |
| Subscription restrictions | Critical finance/job/team service mutations check writable status; the application middleware also rejects restricted-subscription POSTs while retaining billing recovery, reads and exports. |
| Worker readiness | Readiness monitors all nine scheduled loops. Loops start immediately, and missing first heartbeats become unhealthy after startup grace. The separate worker exposes readiness and deployments check it. |
| Frontend | Shared centered brand/store lockup; pictured free offers; in-flow automatic notices; bounded scrollable dialogs; separate close-button space; consistent dashboard buttons; responsive hero images. Chat's launcher occupies navigation space instead of covering copy. Dashboard margin calculation groups rows once rather than repeatedly filtering all rows for every job. |

## Verification

Regression tests exercise permission escalation and invitation authority, KYC bypass, RF revocation, immutable invoice identities, credits and zero-revenue margins, draft/held POD refusal, support export redaction, complete ledger export, independent journals, subscription restrictions, sector gates, driver cache isolation and seven deployment failure stages.

Completed local checks:

- Full embedded-database suite: **606 tests / 91 files passed**. Four additional offsite-backup success/failure checks passed afterward (**610 distinct tests across 92 files**).
- PostgreSQL 16: seven affected suites passed (46 checks); the final 12-case release regression suite also passed after the last service changes.
- Type checking, JavaScript syntax, shell syntax and diff checks passed.
- The existing interface browser walkthrough passed; targeted checks passed at 320, 390, 768 and 1440px for brand centering, notices, close buttons, chat bounds, offer scrolling and Escape cleanup.
- The application image built with certificate verification enabled and started; `/healthz` and `/readyz` returned `ok:true`, including healthy workers.
- One cold local mobile run at 390px, DPR 1, fourfold CPU slowdown, 1.6Mbps and 150ms latency measured LCP **1.47s**, load **2.78s**, and about **461KB** of resource transfer. All three hero scenes selected their 800px WebP source; there was no horizontal overflow. This synthetic local measurement is not a production field-performance guarantee.

Validation logs from this task are in `/tmp/loadbyton-*`. PostgreSQL 16 checks use an isolated disposable container; browser walkthroughs use a disposable development database. Container startup uses development adapters and does not prove production provider connectivity.

## Migration and release limits

- Existing invoice identity cannot be reconstructed from current master data. Migration 075 marks those snapshots `legacy_migration`; invoice pages display a warning to verify them against original issued documents. Do not describe them as recovered historical identities.
- Existing self-approved journal decisions are preserved for controller review. The new constraint prevents new occurrences.
- The browser no longer displays cached personal driver pages when offline. Queued actions remain scoped per driver; reconnect to retrieve work. Unscoped legacy queues require manual reconciliation.
- Very large exports require an operator-managed database archive. Pagination/streaming for large reports remains further work; the export row cap is a resource safeguard, not a complete large-tenant export service.
- No live payment, accounting, carrier, marketplace, bank, OCR, messaging, customs, e-invoicing, hardware, legal or Arabic acceptance has been established here. No credentials, readiness evidence or legal attestations were invented.
- Scheduled restore-and-verify automation, Delivery/COD browser walkthroughs, and database/object recovery and migration-failure drills on the actual production stack remain required. The automated recovery tests cover command/control flow with local fakes, not recovery of production data.
- AWS deployment settings remain an owner/environment requirement. No AWS region, role or instance was guessed.
- All 18 sector gates require independent, current evidence before unrestricted official release. Qualified financial review, customer acceptance, production monitoring/alert delivery and the remaining portfolio work in `IMPLEMENTATION_BACKLOG.md` remain real requirements.

These changes strengthen the implemented product. They do not make the remaining portfolio or external acceptances complete by declaration.
