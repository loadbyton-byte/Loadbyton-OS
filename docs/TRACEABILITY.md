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
| 08 | 18 sector profiles | 🟡 | Catalogue, public pages, diagnostic, specialist flags ✅; only Freight forwarding workflow built |
| 09 | Product/org structure | 🟡 | Tenant ≠ entity ≠ branch ✅, roles ✅; Transport/Warehouse/Delivery/Customs domains ⛔ |
| 10 | Customer & staff experience | ✅ | Start free → empty real workspace → checklist; paid upgrade preview; individual invitations; role-aware nav; "Why this number?" links |
| 11 | Information architecture | 🟡 | All public pages ✅; app: Overview/Enquiries/Quotations/Customers/Rates/Jobs/Documents/Tasks/Finance/Reports/Team/Settings/Billing/Audit ✅, Dispatch/Warehouse/Deliveries/Clearance/Inbox ⛔; console: tenants/orders/provisioning/catalog/queues/leads/support grants ✅, partner commissions, rollout cohorts, setup orders, technician appointments, restore ops ⛔ |
| 12 | Enquiry → collection (10 steps) | 🟡 | Steps 2–10 ✅. Step 1 intake is manual capture with dedupe — no inbound email/WhatsApp ingestion ⛔ |
| 13 | Freight/commercial spec | 🟡 | Parties, rates w/ validity, versioned quotes, approvals, jobs, refs, document versions with issuer ✅. Consolidation allocations, chargeable-weight rules, document template generation, tenders/lost-reason analytics ⛔ |
| 14 | Transport, delivery, COD | ⛔ | Not built (planned) |
| 15 | Warehouse & fulfilment | ⛔ | Not built (planned) |
| 16 | Customs & UAE readiness | 🟡 | Honest handover stance, tax code per line, AED, no ASP claim ✅; Mirsal/e-invoicing adapters, Arabic/RTL ⛔ |
| 17 | Finance integrity | 🟡 | Job costing, accruals, operational vs financial closure, numbering, void-by-reversal, outbox + external ids + find-before-create ✅; native ledger deliberately later |
| 18 | Work, comms, AI | 🟡 | Owner/due/escalation queue ✅, consent flag ✅; business-calendar SLA, shared inbox, AI ⛔ |
| 19 | Three planes | ✅ | Modular monolith + workers; separate DB roles |
| 20 | Data model & invariants | 🟡 | Identity/Commercial/Operations/Finance/Platform/Service/Integration groups ✅; Transport/Warehouse groups ⛔. Invariants: `platform/invariants.ts` |
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
| Warehouse count adjustment | ⛔ module not built |
| COD collection mismatch | ⛔ module not built |
| Accounting provider retry after timeout | `ops.test` "accounting provider timeout then retry…" |
| Offline driver proof synchronized twice | ⛔ module not built |
| Downgrade while above capacity | `platform.test` "downgrade above capacity…", "restricted subscription is read-only…" |
| Domain removed or re-assigned | `platform.test` "domain: ownership verified…" |
| Backup restored | Runbook + `npm run verify` (invariants tested in `extras.test`); a live restore drill needs real infrastructure |

"Definition of done" (§30): a feature is released only with UI, API, authorisation, entitlement enforcement, state logic, audit,
realistic tests, documentation, monitoring and a support runbook. Forwarding Starter has all except **production monitoring**
(no metrics/alerting stack is wired). Hence its public status is *Pilot*, not *Available*.
