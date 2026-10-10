# Blueprint traceability (v1.0, 10 Oct 2026)

Legend: ✅ built and tested · 🟡 partial · ⛔ not built (shown as *Planned* publicly where customer-facing) · 📝 content/decision only

| § | Topic | Status | Notes |
|---|---|---|---|
| 01 | What the store is | ✅ | Home, products, "what this is / is not"; no brokerage/escrow claims |
| 02 | Brand & positioning | 🟡 | Tokens (#071D35/#D81724/#F5F7FA/#172536/#18745C), logos extracted from the PDF, red never sole error signal, stacked-BY separators as stage motif. **Vector master still required.** |
| 03–04 | Market, competitors | 📝 | Positioning copy only; no superiority claim published |
| 05 | Commercial model | ✅ | Free useful tier; export on every plan; visible totals; no unlimited AI/messaging; no escrow |
| 06 | Pricing & allowances | ✅ | 5 plans, immutable versions, net incremental setup credit, tax shown at checkout; "pilot hypothesis" banner |
| 07 | Unit economics | 📝 | Not product code |
| 08 | 18 sector profiles | 🟡 | Catalogue, public pages, diagnostic, specialist flags ✅; workflows built for Freight forwarding, Road transport and E-commerce fulfilment (all Pilot) |
| 09 | Product/org structure | 🟡 | Tenant ≠ entity ≠ branch ✅, roles ✅ (+ limited driver seat); Transport ✅; E-commerce fulfilment ✅ (stock, orders, returns, counts, activity billing); contract-3PL custody, Delivery and Customs domains ⛔ |
| 10 | Customer & staff experience | ✅ | Start free → empty real workspace → checklist; paid upgrade preview; individual invitations; role-aware nav; "Why this number?" links |
| 11 | Information architecture | 🟡 | All public pages ✅; app: Overview/Enquiries/Quotations/Customers/Rates/Jobs/Documents/Tasks/Finance/Reports/Team/Settings/Billing/Audit ✅, Dispatch ✅ (Transport), Warehouse ✅ (Fulfilment pages: board, orders, pick list, inbound, stock, returns, catalogue, locations, billing activity); Deliveries/Clearance/Inbox ⛔; console: tenants/orders/provisioning/catalog/queues/leads/support grants ✅, partner commissions, rollout cohorts, setup orders, technician appointments, restore ops ⛔ |
| 12 | Enquiry → collection (10 steps) | 🟡 | Steps 2–10 ✅. Step 1 intake is manual capture with dedupe — no inbound email/WhatsApp ingestion ⛔ |
| 13 | Freight/commercial spec | 🟡 | Parties, rates w/ validity, versioned quotes, approvals, jobs, refs, document versions with issuer ✅. Consolidation allocations, chargeable-weight rules, document template generation, tenders/lost-reason analytics ⛔ |
| 14 | Transport, delivery, COD | 🟡 | **Transport ✅ (pilot):** orders, trips/legs, capacity + availability + maintenance + compliance-expiry checks, subcontractors, driver app with large targets, POD, offline events with local ids/device time and conflict-safe server resolution, fuel/tolls with independent approval, detention billing, trip profitability. Route estimate is a manual km figure; **route optimisation and live GPS need providers and are not built**; POD location only when company policy enables it. **Delivery (parcels) and COD ⛔** |
| 15 | Warehouse & fulfilment | 🟡 | **E-commerce fulfilment ✅ (pilot):** merchant-owned SKUs (stock never mixes between merchants), locations (bins + system receiving/staging/quarantine), immutable stock-movement ledger, inbound receiving (idempotent per submit token, damage → quarantine, over-receipt must be accepted), order reservation that is all-or-nothing unless partial shipment is allowed (oldest waiting order served first when stock arrives/returns/is counted in), short-pick handling with a count task, scan-verified packing (wrong item / over-pack refused), dispatch with carrier + unique tracking, cancel-after-pick put-back, returns capped by shipped quantity with restock / quarantine / dispose, counts → adjustments needing a *different* approver and voided if stock moved meanwhile (releasing newest reservations if the count falls below reserved), CSV order & SKU import (dry-run, idempotent), rate cards + per-event charges that bill once, monthly merchant invoice, merchant portal view. **Not built:** contract-3PL custody workflows, lot/batch/expiry/serial tracking, multi-warehouse, cartonisation, wave/zone/batch picking optimisation, handheld scanner hardware, marketplace/Shopify/WooCommerce connectors, carrier label & tracking APIs, COD, kitting, cycle-count scheduling, daily storage accrual (storage billing is a monthly snapshot), list pagination (order/inbound/return lists are capped at the latest 200–300), per-role hiding of recipient personal data |
| 16 | Customs & UAE readiness | 🟡 | Honest handover stance, tax code per line, AED, no ASP claim ✅; Mirsal/e-invoicing adapters, Arabic/RTL ⛔ |
| 17 | Finance integrity | 🟡 | Job costing, accruals, operational vs financial closure, numbering, void-by-reversal, outbox + external ids + find-before-create ✅; native ledger deliberately later |
| 18 | Work, comms, AI | 🟡 | Owner/due/escalation queue ✅, consent flag ✅; business-calendar SLA, shared inbox, AI ⛔ |
| 19 | Three planes | ✅ | Modular monolith + workers; separate DB roles |
| 20 | Data model & invariants | 🟡 | Identity/Commercial/Operations/Transport/Warehouse (fulfilment)/Finance/Platform/Service/Integration groups ✅. Invariants: `platform/invariants.ts` |
| 21 | Isolation & security | 🟡 | RLS, composite FKs, signed files, upload gating, staff MFA, audit, session revocation ✅; MFA for sensitive *company* roles, deletion workflow, malware scanner integration ⛔ |
| 22 | Payments & entitlements | ✅ | Signed/replay-resistant webhook, idempotent transitions, effective-dated entitlements, transactional quotas, downgrade preview, grace/restricted. **Real provider adapter pending** |
| 23 | Provisioning | 🟡 | State machine + 9 idempotent steps ✅; DNS/TLS adapters simulated; custom-domain TXT verification ✅ |
| 24 | Reliability & recovery | 🟡 | Outbox, retries, dead queue, status page, restore runbook + invariant verifier ✅; monitoring stack, canaries ⛔ |
| 25 | Onboarding & migration | 🟡 | CSV party import (dry-run), invite flow ✅; staged migration tooling, opening-balance import ⛔ |
| 26 | Team/service governance | 📝 | Runbooks only |
| 27 | Owner dashboard & reports | 🟡 | Owner view ✅ (margin 3-way, unbilled, overdue, exposure, exceptions, delayed milestones, holds, capacity, concentration, usage); sales/transport/warehouse/finance reports beyond ageing ⛔; platform SaaS reports partial (MRR, provisioning p50/p95) |
| 28 | Go-to-market | 📝 | Public copy follows it (no fake testimonials) |
| 29 | Roadmap & gates | 📝 | Availability labels implement the gate discipline |
| 30 | Acceptance scenarios | see below | |
| 31 | Risks | 📝 | Controls referenced above |
| 32 | Decisions | 📝 | `docs/DECISIONS.md` |

## §30 acceptance scenarios

| Scenario | Test |
|---|---|
| Cross-tenant access via edited ID or hostname | `platform.test` (RLS, FKs, users table), `http.test` (jobs, quotes, documents, export) — search/AI retrieval N/A (not built) |
| Replayed payment success | `platform.test` "replayed payment success…", `http.test` webhook |
| Provisioning interruption after slug assignment | `platform.test` "provisioning interrupted…" |
| Free-to-paid upgrade | `platform.test` "free → paid…" |
| Job delivered with late supplier invoice | `ops.test` "delivered job with a late supplier invoice…" |
| Warehouse count adjustment | `fulfilment.test` "needs a different approver; shrinking below reserved releases orders; a stale count is voided", "staging stock is counted by finishing orders…" |
| Transport-specific: capacity/compliance/maintenance/double-booking; conflicting late events; decided expenses immutable; detention billed once; void releases charges; driver fencing | `transport.test`, `http.test` |
| COD collection mismatch | ⛔ module not built |
| Accounting provider retry after timeout | `ops.test` "accounting provider timeout then retry…" |
| Offline driver proof synchronized twice | `transport.test` "the same batch synced twice…" (+ concurrent triple sync, out-of-order batch), `http.test` JSON sync with CSRF header; real-browser offline queue verified manually (Chromium offline → queue → online → flushed) |
| Downgrade while above capacity | `platform.test` "downgrade above capacity…", "restricted subscription is read-only…" |
| Domain removed or re-assigned | `platform.test` "domain: ownership verified…" |
| Fulfilment-specific: no overselling / race for last unit; all-or-nothing reservation; short pick; cancel after pick; double-submitted receive; return cap; billing once & void releases; tenant isolation; role fencing | `fulfilment.test`, `fulfilment-http.test` (+ stock invariants in `npm run verify`) |
| Backup restored | Runbook + `npm run verify` (invariants tested in `extras.test`); a live restore drill needs real infrastructure |

"Definition of done" (§30): a feature is released only with UI, API, authorisation, entitlement enforcement, state logic, audit,
realistic tests, documentation, monitoring and a support runbook. Forwarding Starter, Transport and E-commerce fulfilment have all except **production monitoring**
(no metrics/alerting stack is wired). Hence its public status is *Pilot*, not *Available*.
