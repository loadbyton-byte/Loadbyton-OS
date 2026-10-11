# Decision register (blueprint §32)

| # | Decision | Where the code is waiting |
|---|---|---|
| 1 | Approve first sector and end-to-end scope (recommended: Forwarding Starter) | Built; pilot with ≥5 design partners (§29 gate) |
| 2 | Contracting entity and payment merchant | User chose Indian freelance service provider serving UAE, with GST/legal documents. Stripe/Razorpay adapters implemented; identity, tax treatment and account eligibility supplied/verified at deployment. |
| 3 | Hosting, region and recovery budget | User chose Oracle, Cloudflare, Redis/Upstash, Supabase and Neon. Adapters/templates and encrypted restore tooling implemented; actual regions/PITR/recovery evidence remain deployment inputs. |
| 4 | Pilot plan limits | `PLAN_SEEDS` in `src/platform/catalog.ts` (hypotheses, immutable once published) |
| 5 | Accounting system of record | Zoho Books encrypted draft-invoice bridge implemented; controller acceptance required. CSV export is not sync. Native ledger remains a later justified roadmap. |
| 6 | Setup and visit coverage | Copy on `/coverage`; setup orders / expiring appointments / evidence / customer acceptance implemented; actual visit coverage remains a business input |
| 7 | Support hours and tiers | Not published; do not promise 24/7 on low plans |
| 8 | Free-tier retention/exit policy | Export exists; privacy requests/review implemented; reviewed retention/erasure execution remains pending |
| 9 | Initial connector provider (e-invoicing ASP, WhatsApp, Mirsal) | Official connectors are shown as *Planned* on `/integrations`; manual Customs handover does not replace provider selection |
| 10 | Specialist review owners (accounting, customs, DG, cold chain) | Specialist sectors flagged "review required" |
| 11 | Verify domain ownership; produce **vector** logo master and check BY mark at favicon size | Raster logos extracted from the blueprint PDF are used; `public/brand/by-mark-*.png` favicon checked at 64 px |
| 12 | Proration policy for mid-period upgrades | Pilot charges full first month, credits setup only |
| 13 | Legal review of Terms/Privacy/DPA | Pages are marked **Draft** |

## Added with Transport

| # | Decision | Where the code is waiting |
|---|---|---|
| 14 | Route-estimate / live-GPS provider (and its consent + retention policy) | Estimated km is a manual figure; no tracking; `capture_location` is off by default and only gates POD coordinates |
| 15 | Driver app: browser PWA with service worker vs native app | Today: server-rendered page + localStorage queue; add a service worker if drivers must open it offline |
| 16 | Trip billing unit and plan allowances (`trips_per_month`) | Hypotheses equal to the jobs allowance; plan v2 |
| 17 | Fuel/toll policy (who approves, limits, receipt upload) | Current issued trip-linked receipts and an independent approver, including owners, are required for new expense approval. Driver/office uploads retain immutable receipt versions; legacy decisions need evidence review; fuel/toll provider feeds and company-specific caps remain pending |
| 18 | Salik/toll and fuel-card integrations | Not built |

## Added with E-commerce fulfilment

| # | Decision | Where the code is waiting |
|---|---|---|
| 19 | Fulfilment billing unit and plan allowances (`fulfilment_orders_per_month`: 50 / 500 / 2,000 / 8,000 / 100,000) | Hypotheses in `PLAN_SEEDS`; plan v3. v1/v2 subscriptions fall back to their jobs allowance |
| 20 | Marketplace / storefront connector provider and order-ingestion contract (Shopify, Noon, Amazon, WooCommerce, REST) | Orders enter by form or CSV, idempotent on (merchant, external ref). No connectors, so marketplace stock levels are not pushed back |
| 21 | Carrier label and tracking provider(s) | Carrier and tracking number are typed in at dispatch; tracking is unique per carrier. No labels, rates or status feeds |
| 22 | COD handling (belongs with Delivery) | Delivery/COD now stores collections, handovers, independent variance decisions and bounded remittances. Committed UAE Own fleet fulfilment dispatch now links to one immutable source parcel. COD corrections/recovery/refunds and formal shortage accounting remain pending |
| 23 | Storage billing basis (pallet/cbm/location, daily accrual vs month-end snapshot) | Reviewed future AED daily contracts accrue closed Dubai-day occupied bin/receiving/quarantine locations from the movement ledger. Monthly snapshots skip months covered by daily terms. Pallet/cbm/peak pricing and amendments still need agreed models |
| 24 | Lot/batch/expiry/serial tracking and FEFO | Not built; required before food, cosmetics with expiry, or electronics with serials |
| 25 | Count policy: who may approve, variance thresholds, scheduled cycle counts | Every non-zero variance requires a different approver, including owners. Reviewed count schedules/value tiers currently belong to the separate custody pack; fulfilment count schedules and monetary adjustment thresholds remain pending |
| 26 | Shortage policy: backorder vs. partial shipment per merchant; short-pick investigation SLA | Default is "ship complete" (all-or-nothing); partial is a per-order flag; a short pick raises a 4-hour task |
| 27 | Recipient personal-data retention, deletion and who may see it | Recipient names, phones and addresses are restricted to fulfilment operators or the bound merchant on views, packing slips and structured order exports, including search restrictions. Support grants hide these fields. Scheduled minimisation and broader legacy/free-text/document policy remain pending |
| 28 | Multi-warehouse / multi-site stock and inter-site transfer | One stock pool per workspace |
| 29 | Hand-held scanner / label printer hardware | Packing accepts a typed or keyboard-wedge scan; no mobile pick app (the driver-app pattern could be reused) |


## Added with Warehouse

| # | Decision | Where the code is waiting |
|---|---|---|
| 30 | Warehouse billing unit and plan allowances (`wh_orders_per_month`) | Hypotheses equal to the jobs allowance; plan v4. Alternatives: per scan/line, per pallet position |
| 31 | Storage billing basis: per unit-day (today) vs per pallet position or per cbm | `accrueStorage` uses end-of-day units on hand; pallet/cbm needs SKU master data (units per pallet, dimensions) |
| 32 | Who may release stock from quarantine and who approves count adjustments (and value thresholds) | `wh.approve` = owner, finance, coordinator; counter ≠ approver, including owners. Reviewed high-value/standard/low-value count tiers are explicit policies; monetary adjustment thresholds remain pending |
| 33 | Stock rotation policy | Custody SKUs choose FIFO/FEFO and none/lot/serial tracking at creation. Source-evidenced expiry/serial identities and quality holds are enforced. Fulfilment uses its separate inventory model and still needs equivalent controls. |
| 34 | Barcode/RF scanning hardware and a WMS/ERP integration | Scan/retry references exist (`client_ref`); no hardware or integration |
| 35 | Backorders, partial-shipment policy and returns | Partial allocation closes the shortfall; no returns flow (belongs with E-commerce fulfilment) |
| 36 | Insurance / liability cut-off for custody stock and bonded goods | Not modelled; bonded warehousing is explicitly out of scope (see /coverage) |

## Delivery and Customs implementation decisions still required

| # | Decision | Current boundary |
|---|---|---|
| 37 | Parcel and customs-case allowances, and courier/service fees | Dedicated usage keys fall back to jobs/month; published plans are unchanged. Parcel fee is entered manually; Customs cleared-case service-fee billing is implemented separately from deposits |
| 38 | COD settlement schedule, shortages/surpluses, subsequent recovery, refunds and bank reconciliation | Actual figures are immutable; mismatches need an independent finance approver. Remittances are bounded by real reconciled cash; no loss accounting, recovery or refund workflow exists yet |
| 39 | Delivery dispatch/route provider and offline cash collection policy | Manual courier + route reference; parcel actions require connectivity. Transport offline sync remains separate |
| 40 | Customs specialist approval, permits by goods/category, authority/agent channel and duty/deposit policy | Manual evidence-based case handover only; no filing, duty assessment, authority disbursement or provider certification |
| 41 | Monitoring hosting, notification receiver and incident ownership | Authenticated instrumentation and alert templates exist; deployment and end-to-end alert delivery remain pending |

The uploaded complete blueprint is now extracted in `MASTER_BLUEPRINT_SOURCE.txt`; it supersedes the earlier summary-only baseline. The user's hosting and merchant choices supersede their previously undecided entries. Do not request those choices again. Credentials/legal identifiers belong in secure environment settings at deployment.

Plan v5 adds separate specialist-case allowances (2 / 10 / 25 / 50 / 500); v6 adds approved-message allowances (20 / 100 / 500 / 2,000 / 10,000); v7 adds assistant draft allowances (10 / 50 / 150 / 500 / 2,000). These are pilot hypotheses, not approved commercial commitments. Older published versions are preserved; these units do not fall back to forwarding jobs. Pricing/coverage/retention/specialist release evidence must be reviewed before availability claims.

Optional Razorpay INR presentment requires a reviewed quoted AED/INR rate/note. The order retains catalogue and payment money; it never treats Indian GST credentials as evidence that a particular UAE VAT rate or payment method is supported.
