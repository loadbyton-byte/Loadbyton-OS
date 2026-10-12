# Reference repository analysis and implementation

Reviewed on 11 October 2026. Target: `loadbyton-byte/Loadbyton-OS` at `83a21cb08568e6fc5e0ea7a54aeb47ea279cb3c2` before these changes. Accessible reference: `loadbyton-byte/Project-Loadbyton` at `8c0e8e9f5239b1689f333ec21cdb9cdffc7e2fa4`.

## Scope and evidence

Project-Loadbyton was read from its checkout: README, brand guidelines/tokens, marketing CSS, homepage sections/runtime, authentication components/pages, dashboard/app navigation, backend route inventory, enterprise/RFP/EDI/organization/approval/payment/retention code and roadmap/deployment notes. This is source analysis, not a claim that the reference was deployed or its production integrations were tested.

`https://github.com/elvorashippingllc/ElvoraLogisticsOS.git` returned `Repository not found` to a native read-only Git request with the platform's existing authentication. No Elvora source was available. Its features, enterprise plan and design cannot be verified or declared present. The user instructed continuation with Project-Loadbyton; this comparison proceeds on that basis. Elvora remains an explicit outstanding comparison requiring readable source.

Superdesign CLI preflight ran. Login failed with HTTP 403 after using its supported writable config-directory override. HTTP requests to 21st.dev, impeccable.style, jitter.video and ui.shadcn.com also returned 403. No claim is made that their tools ran or their current component catalogues were retrieved. The implementation uses native Hono JSX, CSS and progressive JavaScript with local assets. Shadcn React/Radix components cannot be dropped into this Hono SSR application without introducing a separate hydrated React runtime; a framework migration is unnecessary for the requested interaction and appearance.

## Product architecture: what transfers and what does not

Project-Loadbyton is a freight **marketplace**: shipper/carrier roles, public loads, competing bids, awards, held funds, delivery, payouts and disputes. Its Express API uses SQLite in development and PostgreSQL in production; its frontend is a hydrated React/Vite application.

Loadbyton.store is a tenant-isolated **operating platform**: company memberships, sector workflows, customer/supplier records, operational evidence, subscription capacity and privileged platform management. It uses PostgreSQL/PGlite and Hono SSR. Its payment providers sell software subscriptions; they do not imply marketplace escrow. Its native general ledger is a business accounting sub-ledger; it is not the reference's carrier payout ledger.

The correct transferable layer is typography, brand discipline, navigation, layout, component patterns, evidence-oriented workflows and supported account flows. Moving marketplace SQL/routes literally would lose tenant/permission boundaries and mismatch money semantics. Likewise, the reference's basic EDI mapper and simulated customs commitment do not constitute a customs filing integration or validated EDI protocol implementation.

## Feature and enterprise coverage

“Present” means source exists in the target; only the checks listed in the validation section establish runtime evidence. “Related” identifies a different implementation with similar purpose, not full parity.

| Reference capability and source | Loadbyton.store evidence | Assessment |
| --- | --- | --- |
| Registration/login and organization seats: `server/routes/auth.routes.js`, `org.routes.js` | `src/platform/tenants.ts`, `auth.ts`, `ops/team.ts`, `lib/perms.ts` | Present with company memberships and a more granular role model; does not adopt shipper/carrier marketplace identity |
| Password recovery and reset: `auth.routes.js`, `web/src/pages/ForgotPassword.jsx`, `ResetPassword.jsx` | New `src/platform/password-recovery.ts`, migration 051, `src/web/auth.tsx`, mail template | Implemented here: one-hour single-use hashes, encrypted queued token, generic request response, throttling, session revocation, MFA preservation, no-referrer/no-store reset page |
| Email verification / TRN / carrier approval | No equivalent verified-email onboarding sequence in target | Gap; signup remains a real Free workspace without mandatory trade documents |
| TOTP, login throttling, encrypted fields | `src/platform/auth.ts`, `mfa.ts`, `lib/encryption.ts`, `lib/ratelimit.ts` | Present; company MFA and separately enforced platform staff MFA |
| Public job posting, carrier bids, award and negotiation: jobs/bids/lifecycle routes | Freight enquiries/quotes/jobs; transport orders/planning | Related internal workflows; public marketplace bidding and carrier award are absent |
| Escrow funding/release, commission, Stripe Connect, payout SLA and disputes | Subscription checkout in `platform/billing.ts`; COD remittances in `ops/delivery-finance.ts` | Different money flows; marketplace escrow, Connect settlement and dispute split are gaps |
| RFP bids and recurring contract lanes: `rfp.routes.js`, `retention.routes.js` | `ops/freight-commercial.ts`, `web/freight-commercial.tsx`; supplier contracts and tender decisions | Related; internal opportunity/tender management is present, cross-company carrier RFP bidding is not |
| Fleet, driver seats, dispatch/POD, detention and receipt evidence | `ops/transport.ts`, `web/app-transport.tsx`, `web/app-driver.tsx`, `ops/expense-receipts.ts` | Present internal transport workflow with independent receipt approval and offline driver queue |
| Live tracking and hardware telematics | `ops/transport-live.ts`, `web/transport-live.tsx`; temperature `ops/device-feed.ts` | Related provider-configured capabilities; not universal turn-key fleet telematics or routing optimization |
| DP World E-token and stage-specific EIR/seal checklist: `enterprise.routes.js` | Job references, evidence documents and milestones | Related recordkeeping only; dedicated gate-token/EIR workflow is a gap |
| EDI 304/310 and Cargo-XML: `edi.routes.js` | Scoped APIs, controlled import and fixed-rule document extraction | Related integration foundations; no implemented EDI protocol adapter |
| Customs compliance / commitment: `compliance.routes.js` | Customs cases, goods lines, deposits, evidence, independent handover approval | Present internal case management; neither implies direct customs filing, tax verification or ZKP certification |
| Carrier insurance quote/bind, credit request and financial rails | Evidence/compliance checks and accounts receivable | Gap for insurance brokerage APIs and marketplace credit approval |
| Templates and printed documents | `ops/document-drafts.ts`, `web/document-drafts.tsx`, public brand templates | Present versioned, source-linked document drafts; exact load/settlement/EIR marketplace templates remain separate |
| Analytics, dashboards, notifications/messages | Owner and management reports, tasks, shared inbox, inbound channels and outbox | Related operational reporting and communication; marketplace loyalty/referrals/notification center differ |
| Admin verification, audited support, two-person actions | `platform/admin.ts`, `web/admin*.tsx`, support grants, workflow approvals | Present platform controls; target support grants are approved/read-only, not a direct equivalent of mutable impersonation |
| Immutable/hash-chained ledger and audit | `lib/audit.ts`, migrations, `ops/ledger.ts`, invariants | Immutable target audit/ledger records and reconciliations exist; reference hash-chain verification is not asserted for target audit log |
| Plan billing, entitlements, provisioning and controlled rollout | `platform/catalog.ts`, `entitlements.ts`, `provisioning.ts`, `rollout.ts` | Present native software-platform controls beyond the reference's marketplace pricing model |
| Backup, recovery, metrics, readiness, retention | `platform/backup.ts`, `invariants.ts`, `health.ts`, `runtime-metrics.ts`, privacy flows | Present mechanisms; off-instance durability and actual provider recovery acceptance still require deployment evidence |
| SAML/SSO, SCIM, multi-region failover | Not implemented in target; reference infrastructure notes are not runtime proof | Gaps; not added as marketing claims |
| Fulfilment, warehouse, COD, specialist profiles | Existing `ops/fulfil*.ts`, `warehouse*.ts`, `delivery*.ts`, `specialist-profiles.ts` and respective screens | Native target depth; retained rather than replacing the platform with a marketplace |

## Frontend design transfer

| Reference pattern | Implemented adaptation |
| --- | --- |
| Geist display, Inter body, JetBrains Mono operational data | Existing locally hosted fonts retained; stronger type scale, spacing and hierarchy |
| Navy `#0F2B3D`, red `#E53935`, paper/cloud backgrounds | Navy structural surfaces, cream editorial sections, cloud application canvas; existing accessible `#C62828` reserved for action text/backgrounds |
| Cinematic freight photographs and slide controls | Three manually selected local scenes; four reused MIT repository images, original copyright/license retained at `public/assets/freight/LICENSE.txt`; no automatic distracting slideshow |
| Hero narrative, process strip, problem/solution, workflow cards, trust and CTA sections | New `HomeExperience`: connected operating record, sectors, bento capabilities, three workflow stages, truthful product availability and final CTA |
| Split photo-led Login/Register | Reusable `AuthFrame`; real existing POST endpoints and CSRF fields, preserved native validation/autocomplete; password visibility and functional recovery |
| App shell, operational status cards, recent work | Restyled `AppShell`/`AdminShell`, shared cards/tables/forms/badges; real setup progress, existing assigned work and report data retained |
| Command palette | Native modal dialog populated only from existing role/sector navigation; text filtering, empty result state, Ctrl/Cmd K, first-result keyboard entry, Escape close and native focus containment |
| Responsive nav and motion | Collapsible public and workspace menus at mobile widths, progressive scroll reveals, scene cross-fades, modest hover movement, reduced-motion and no-JS fallbacks |
| Brand and document templates | Existing LOAD|BY|TON.store logos and templates remain authoritative; no replacement with arbitrary icons or text-only brand marks |

`/enterprise` now explains implemented platform controls, links to existing product/security/plan pages and explicitly identifies provider setup and absent marketplace/enterprise identity capabilities. It does not claim enterprise readiness or Elvora parity.

## Validation and implementation boundaries

Required local checks: TypeScript, the full PGlite suite, forwarding and transport browser acceptance, the dedicated interface browser check and password recovery security tests. The interface check exercises scenes, assets, signup, password visibility, page search, keyboard navigation, mobile layouts/menus, reduced motion and JavaScript-disabled navigation. Screenshots are generated from the running application, not design-only mockups.

Password recovery tests use injected capture mailers and reserved fixture accounts. Real mail delivery requires an existing configured mail provider (`MAIL_PROVIDER=resend`, `RESEND_API_KEY`, verified `MAIL_FROM`); development log mode deliberately does not expose reset links. No provider values were requested or created, no live mail was sent, and no production deployment was performed. Migration 051 must be applied through the normal migration procedure before deploying the new code with automatic migrations disabled.

No dependencies or lockfile changed. `npm run e2e:experience` and the existing browser CI job now include the interface acceptance workflow. No React runtime, downloaded component bundles, animation video dependency or CDN fonts are required.

### Outstanding source comparison

Elvora source remains inaccessible; the all-features/all-enterprise-plan requirement cannot be assessed from the URL alone. When access is supplied, inventory its routes, migrations, permissions, jobs, subscriptions and enterprise gates; append each actual capability to this matrix, implement missing behavior in the target's tenant-scoped model, and verify it with the corresponding workflow tests. Do not convert the unverified feature inventory into “shipped” labels.

### Results from this implementation run

- `npm run typecheck`: passed.
- `npm test -- --maxWorkers=2`: **438 tests across 65 files passed**, PGlite, 354.21 seconds. No zero-test validation or disabled assertions.
- Final navigation/Arabic regression: **15 tests across 2 files passed** after the active-page and deduplication changes.
- `BASE=... CHROME=/usr/bin/chromium npm run e2e`: passed signup, customer/supplier, enquiry, tariff/chargeable weight, quote, assistant, evidence, document draft, invoice/receipt and mock upgrade with no browser errors.
- `npm run e2e:transport` against the isolated development instance: passed driver invitation, dispatch, expense receipt enforcement and independent approval.
- `npm run e2e:experience` with installed Chromium: passed user-controlled scenes, asset availability, password visibility, generic recovery request, real signup, page search, keyboard selection/Escape, mobile menus and responsive layouts, reduced motion and no-JS navigation.
- Password recovery/mail focused run: **9 tests across 2 files passed**, including security-sensitive reset behavior.
- `/readyz`: returned `ok:true, workers:ok` on the redesigned instance.
- `git diff --check`: passed.

The browser workflows used a separate development PGlite directory and local object directory under `/workspace/scratch`, reserved synthetic accounts and mock payments. Real PostgreSQL/provider acceptance and CI execution on GitHub were not run for this change. The full suite was started before the final navigation adjustment; the affected HTTP/Arabic tests were repeated afterward and passed. Browser acceptance was repeated after the final script and command changes.

The default development database also passed `npm run verify` after applying migration 051. The default server was restarted with `npm run dev`; `/readyz` passed and the new `/enterprise` page was served successfully.


## Update, 12 October 2026: Elvora source is now readable

`elvorashippingllc/ElvoraLogisticsOS` became public and was read (README, `DESIGN.md`, `PRODUCT.md`, `.impeccable/`, `src/web` shell, dashboard, workspaces, account card, carousel, command palette, `index.css`). It is a different product (Fastify + React 19 + Tailwind 4 ERP for one freight forwarder, 97 entities across 18 permission modules, AI employees, calendar, e-mail, WhatsApp), so only its **dashboard design language** was transferred, re-coloured to LOAD|BY|TON navy and red and driven by this application's tenant data: capsule navigation, narrow workspace rail with a popup, back button + breadcrumb, command search, notifications popover, status bar, "needs attention", movement desk, KPI tiles, disclosure sections, workspaces hub, tilting plan card, dark theme. Its feature set (calendar, AI team, e-mail console, double-entry ERP modules) was not ported and is not claimed. See `docs/FRONTEND_SYSTEM.md`.
