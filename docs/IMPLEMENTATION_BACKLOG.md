# Blueprint implementation and remaining portfolio work

Source: user-uploaded **LOAD_BY_TON.store — Master Blueprint (1).pdf**, extracted in `MASTER_BLUEPRINT_SOURCE.txt`. The document is available; earlier claims that it was absent are superseded. The user's selected hosting/payment/Indian merchant setup is captured in `DEPLOYMENT.md`. All current edits remain reviewable in the checkout; no upstream files were reset or production environment deployed.

## Implemented

- Manual COD recovery/refund/cash-correction ledger with exact-parcel issued evidence, one adjustment per evidence event, immutable proposals and independent active-finance decisions. Approved cash changes affect remittance bounds without changing original collection/handover/merchant entitlement; shortages and surplus stay visible. Delivery lists and management reports distinguish original handovers, approved cash changes, current received cash and outstanding expected merchant entitlement. Service and SQL guards serialize concurrent decisions and forbid negative balances or reversing already-remitted cash. This records verified external cash events, never transfers funds or writes off liability.

- Six generated document draft types (commercial invoice, packing list, booking confirmation, transport document, delivery order and shipment instructions), reviewed immutable template versions, exact-job issued source evidence, frozen job/evidence snapshots and integrity hashes, printable PDF/browser output, JSON/tenant exports, storage quotas and role/tenant/subscription fences. Every generated output remains a draft and cannot substitute for externally issued authority/release evidence.
- Dual-key authenticated readers and an atomic, bounded encryption-key migration for company MFA, accounting connections and invitation tokens. Dry run is the default; unknown/corrupted ciphertext aborts all changes. Counts-only system audit records and idempotent reruns support the maintenance runbook. This does not rotate gateway signing keys, session secrets or backup keys.

- Driver/office expense receipt uploads and immutable evidence versions linked to the exact trip/expense. New approvals require the latest current issued evidence and another person, including owners. Approved expense amounts/provenance cannot be edited or deleted; pre-existing decisions remain explicitly marked for legacy evidence review. Limited driver downloads require current trip assignment.

- Fulfilment daily storage accrual under issued, immutable, explicit AED closing-occupied-location contracts. Future month-boundary terms prevent invented historical pricing; historical closing balances come from immutable movements, including exact Dubai cutoff boundaries. Daily/monthly charging is mutually exclusive, zero-rate/zero-occupancy evidence persists, and accruals invoice/void/reissue without duplicating fees. Finance-controlled, pausable bounded workers now catch up missing closed days with system audit actors and no automatic invoices. Physical pallet/cbm/peak bases and contract amendments remain separate scope.

- Forwarding assistant summary/reply/classification drafts with fixed structured tenant/role-scoped retrieval, excluded document/contact/free text, linked snapshot provenance, source-change warnings, per-author access, immutable human-review output, plan-v7 quotas, durable USD cost reservation/metering, optional reviewed OpenAI adapter, safe deterministic fallback and non-resending interruption recovery. Full document extraction, report explanations and wider-sector retrieval are not included.

- Custody count policies with issued risk/value evidence, immutable tiers/frequency/scope, active named operators, Dubai due dates, manual count generation, overlap protection, immutable run history and authenticated due-count monitoring. Stock variances require a second person, including owner counters.

- Reviewed, issued-provider chargeable-weight rules for air/road volumetric kg and ocean LCL weight/measure, explicit coefficients/minimums/rounding, restricted scope confirmation, immutable source-linked enquiry calculations and exports. Pricing remains a human-approved workflow.
- Six scoped operational pilots: forwarding, transport/offline events, fulfilment, custody warehouse, Delivery/COD and Customs evidence handover/service fees.
- Twelve controlled specialist manual profiles with review validity, issued evidence, role/subscription/sector fences, independent exception disposition, immutable contracts/history, metered cases, paginated UI/API, exports and shared service invoices/collections.
- Fulfilment order/inbound/return pagination; server-side recipient name/phone/address restriction on operational views, packing slips and structured order exports; recipient-name search is unavailable to restricted roles. Merchant access is party-bound, and support grants do not expose these contacts. Wider document/free-text/legacy-module privacy and scheduled minimisation still need separate controls.
- Fulfilment-to-Delivery handover for committed Own fleet UAE shipments, one immutable parcel link, recipient/source lineage, explicit merchant fee/COD evidence, separate cash ledger and quota/idempotency safeguards.
- Custody warehouse lot/expiry/serial registration, immutable supplier evidence, FEFO, quality holds, expired-stock refusal and single-unit serial custody. Fulfilment's separate inventory engine has not acquired these controls by implication.
- Stripe/Razorpay hosted checkout, provider signatures/replay handling, reconciliation, refund/dispute review, renewal, downgrades, merchant/tax snapshots and optional explicit INR payment quotes. Gateway method eligibility is a release gate.
- Oracle Terraform/cloud-init and web/worker/scanner/tunnel Compose; Neon verified PostgreSQL; private S3-compatible objects plus ClamAV; Upstash rate limits (in-process fallback); Cloudflare wildcard/TLS and custom-hostname verification; Resend notifications/reviewed replies.
- Company/staff MFA, current-password invitation acceptance, role/capacity protections, API scopes/trace IDs/idempotency and private document integrity.
- Zoho Books encrypted tenant connection and find-before-create **draft invoice** bridge; CSV export remains separate from actual synchronization.
- Shared staff-captured inbox, handover acceptance, configurable Dubai business calendar, priority/due queue, immutable reply drafts, owner approval, message allowances and explicit review after uncertain mail-provider outcomes.
- Setup work orders, expiring appointments and independent customer acceptance; source-evidenced customer/supplier CSV staging, validation, cutover and unused-record rollback.
- Privacy request/decision records, tenant operational exports, management reports, bilingual English/Arabic RTL invoice documents, queue/SLA metrics and ten alert rules.
- Consistent encrypted database/object backups and isolated restore checks of files, all recorded table counts, financial/stock/platform invariants and tenant isolation.

- Fulfilment inventory depth (migrations 031–034): lot/batch/expiry/serial tracking with issued source evidence, FEFO/FIFO allocation with minimum shelf life, quality holds with second-person release, recall trace, serial pack scanning and lot-aware returns/counts/transfers; multi-site fulfilment with site-pinned orders and two-step TRANSIT transfers with controlled shortfalls; closing/peak pallet-position, location and stock-cbm storage bases with future-dated contract amendments; paginated stock/catalogue/location/adjustment/pick lists with code lookups; assembled and virtual kits; carton types and heuristic cartonisation recorded against shipments; zones and wave/zone/batch picking tasks. Cartonisation is a volume/weight/dimension heuristic the packer confirms, not a 3-D packing proof, and pallet/cbm pricing uses declared location pallet positions and SKU volumes.

- Privacy and security operations (migration 035): owner-set retention policies with an hourly bounded minimisation worker for fulfilment recipients and delivery consignees, immutable legal holds, counts-only run evidence, a two-person platform erasure plan with execution-time blocker re-checks, per-field authorisation for parties, consignees and drivers in exports, and dual-key session-secret, webhook-secret and backup-key rotation procedures with re-seal/re-encrypt tooling.

## External acceptance — code is present; deployment evidence remains

`RELEASE_ACCEPTANCE.md` lists merchant/provider credentials, live payment and wallet eligibility, actual regions/private buckets/tunnel, SMTP delivery, provider failover/PITR/restore, alert delivery, legal/tax/retention review, controller acceptance, specialist reviews and real pilot customers. These are not obtainable by inventing credentials, certifications or customer evidence.

## Additional software in the blueprint's broader portfolio

These remain real work, not items that merely need environment variables:

| Area | Remaining scope |
|---|---|
| Freight commercial depth | Richer opportunities/tenders/rate tiers and supplier contract restrictions; integrated forwarding master/house operations and authoritative issuer integration |
| Transport | Offline first-open/service-worker strategy, GPS/route optimisation, fuel-card/Salik provider feeds |
| Delivery/COD | Offline parcel/cash policy, automated bank matching/provider refund feeds and approved liability/write-off accounting |
| Fulfilment | Scheduled personal-data minimisation (see Legal/data operations); everything else in the former row is implemented |
| Custody warehouse | Backorder/return policy, approved bonded/liability boundary, richer scanner/printer/RF integrations; the new traceability controls require real quality/sector review |
| Specialist profiles | Full sector-specific advanced interfaces/provider feeds, automated physical/device evidence and industry validation beyond the tested manual workflows |
| Communications/AI | Approved inbound email/WhatsApp/telephony connectors, verified identity/consent policy, AI document extraction, report explanations and wider-sector retrieval, versioned automated templates and safe deterministic fallback |
| Finance | Receipt/credit-note/correction bridge, vendor payables and formally reconciled multi-currency books; native ledger only after its roadmap justification and controller review |
| UAE readiness | Verified accredited e-invoicing ASP/Mirsal access and integration acceptance; full Arabic application/content localisation beyond invoice rendering |
| Migration/service console | Reconciled stock/opening-balance migration, final-delta tooling, partner commission/refund ledger, rollout cohorts and richer SaaS cohort/contribution/churn reports |
| Legal/data operations | Legal/regulatory confirmation of the retention periods and erasure scope chosen per customer (a decision, not software); field policy is applied to exports, not yet to every legacy list screen |
| Brand/business | Approved vector brand master/domain ownership, verified market/unit-economics/GTM evidence, assigned coverage/support/governance owners |

The blueprint's release roadmap explicitly stages foundation → first paid workflow → commercial launch → supervised pilots → expansion. Public statuses preserve that distinction. This change closes many software gaps but does not claim that every future portfolio item above is complete.

## Deferred when this branch was reconciled with main

Delivery/COD and Customs on `main` (`dlv_*`, `cus_*`, migrations 005–008) replaced this branch's earlier parallel implementations. These features were built on the superseded `delivery_*` / `customs_*` tables and were **not** carried over; each needs a fresh design on the `main` schema:

- Independent COD cash-adjustment ledger and cash-balance guards (old migrations 031–034), with its management-report and invariant coverage.
- Fulfilment → Delivery hand-over of own-fleet shipments (old migration 018) and the linked parcel/COD view.
- Customs service-fee finance link (`customs_cases` fee immutability, old migration 013) and customs deposit/evidence invariants.
- Browser acceptance scripts `e2e:delivery` and `e2e:fulfilment-delivery`.

Behaviour changes where `main` wins: payments, mail (Resend), object storage (fs/S3), shared rate limiting (fails over to in-process when Upstash is unreachable instead of failing closed), `/metrics` (404 without the exact bearer token), and Delivery/Customs. Plan versions 7–9 add specialist cases, reviewed messages and assistant drafts after main's versions 5 (parcels) and 6 (customs cases). Migrations from this branch were renumbered 009–030.
