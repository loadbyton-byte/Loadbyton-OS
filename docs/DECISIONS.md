# Decision register (blueprint §32)

| # | Decision | Where the code is waiting |
|---|---|---|
| 1 | Approve first sector and end-to-end scope (recommended: Forwarding Starter) | Built; pilot with ≥5 design partners (§29 gate) |
| 2 | Contracting entity and **payment merchant** | **Decided: an India-based GST-registered freelancer selling to UAE customers; Stripe (cards, Google Pay) and Razorpay (UPI/Google Pay/cards).** Adapters built (`PAYMENT_PROVIDERS`); identity/GST/PAN/tax text are env vars. Still to confirm with the providers: AED presentment/settlement for your accounts; with your accountant: tax treatment of the supply |
| 3 | Hosting, region and recovery budget | **Decided: Oracle Cloud VM + Cloudflare (tunnel) + Neon or Supabase (PostgreSQL) + Upstash (rate limits).** See `docs/DEPLOYMENT.md`. Region, recovery budget (RPO/RTO) and the subprocessor page still to be set |
| 4 | Pilot plan limits | `PLAN_SEEDS` in `src/platform/catalog.ts` (hypotheses, immutable once published) |
| 5 | Accounting system of record | `AccountingAdapter` (CSV/export stub today). Subscription receipts for your own SaaS sales are printable from Plan & billing |
| 6 | Setup and visit coverage | Copy on `/coverage`; setup orders / technician appointments not built |
| 7 | Support hours and tiers | Not published; do not promise 24/7 on low plans |
| 8 | Free-tier retention/exit policy | Export exists; retention/deletion workflow not built |
| 9 | Initial connector provider (e-invoicing ASP, WhatsApp, Mirsal) | **Mail: Resend and SMS: Twilio adapters built** (env-selected; default is log-only). E-invoicing ASP, WhatsApp and Mirsal remain *Planned* on `/integrations` |
| 10 | Specialist review owners (accounting, customs, DG, cold chain) | Specialist sectors flagged "review required" |
| 11 | Verify domain registrant evidence and approve the vector identity | `public/brand` now contains outlined parent/.store/OS masters, rebuilt BY icons, full templates and an owner-review checklist, based on Project-Loadbyton. Owner artwork approval and registrar proof remain pending; SVG/PNG/DNS checks do not supply them |
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


## Added with Delivery / COD

| # | Decision | Where the code is waiting |
|---|---|---|
| 37 | Delivery billing unit and plan allowances (`parcels_per_month`: 100 / 1,500 / 6,000 / 25,000 / 500,000) | Hypotheses in `PLAN_SEEDS`; plan v5. Older versions fall back to the jobs allowance |
| 38 | COD cash policy: who counts, who may accept a difference, any tolerance, and who bears a shortage (company vs. rider deduction) | Any non-zero difference needs a second person (owner excepted); no tolerance; the shortage is only *recorded*, no payroll deduction |
| 39 | COD payment methods beyond cash (card-on-delivery terminal, payment links, wallet) | Cash only. Exact amount required; no partial acceptance |
| 40 | Remittance cycle and cap (daily/weekly, holdbacks, merchant bank details, payout file format) | Manual: staff prepare a statement and a second person records the bank reference. No bank file, no bank-detail storage |
| 41 | Consignee notifications (SMS / WhatsApp) and delivery-code delivery | **SMS built** (Twilio, opt-in per merchant, UAE mobiles, out-for-delivery and failed-attempt only; code included only when the parcel requires it). WhatsApp needs approved templates and is not built. Sender-ID registration and consent are the courier's/merchant's responsibility |
| 42 | Route optimisation / live rider location / geofenced POD | Runs are ordered by the dispatcher; no GPS (see #14) |
| 43 | Carrier hand-off: label printing, AWB format, merchant API/webhooks, marketplace connectors | **Built:** label printing (Code 128), merchant API v1 (`docs/API.md`), signed webhooks. Waybill is `DLV-<year>-<seq>` (no carrier-standard AWB format). Marketplace connectors (Shopify, Noon, Amazon…) are not built — merchants integrate through the API |
| 44 | Parcel data retention: consignee name/phone/address kept indefinitely and visible to all office roles | Same as #27; no anonymisation job |
| 45 | Inter-emirate pricing zones, weight/size bands, and failed-delivery fees | One flat delivery fee, one inter-emirate surcharge (destination ≠ origin emirate), one return fee, COD % with a minimum |
| 46 | Multiple COD currencies / cross-border | AED only |

## Added with Customs brokerage

| # | Decision | Where the code is waiting |
|---|---|---|
| 47 | Customs billing unit and plan allowances (`cus_cases_per_month`: 5 / 50 / 200 / 600 / 6,000) | Hypotheses in `PLAN_SEEDS`; plan v6. Older versions fall back to the jobs allowance |
| 48 | Official filing: Dubai Trade / Mirsal 2 / Abu Dhabi channels need licensed-broker accounts and their own API agreements | Not integrated. The system produces a handover pack + CSV and records the declaration number the broker gets back (unique per channel) |
| 49 | Tariff and rates: HS classification, duty rates, exemptions, FTA origin rules | No built-in tariff. HS codes are format-checked (6–12 digits); duty/VAT rates are entered by the broker and results are labelled estimates. The official assessment prevails and a difference of AED 100 **and** 5% is flagged |
| 50 | Who may approve a case | A different person from the preparer; an owner may approve their own (single-person firms are normal). Waiving a missing document needs the approve permission and a reason |
| 51 | Deposits and bank guarantees | Held as client money: never revenue, never over-applied (row-locked), refunds ≤ balance, immutable ledger. Guarantee expiry is shown, not enforced |
| 52 | Valuation method | Freight/insurance/other charges are shared over lines by value (largest remainder, exact to the fils) and converted at the broker-entered rate. Other methods (weight, quantity) not built |
| 53 | Restricted goods / permits | A line can be flagged restricted with a note; this adds a mandatory permit item to the checklist. No automatic restricted-goods list |

## Added with platform operations

| # | Decision | Where the code is waiting |
|---|---|---|
| 47 | Alert routing and on-call: who is paged, for which `docs/MONITORING.md` alerts, and the failure drill that earns *Available* | Endpoints and rules exist; nobody is wired to them. Sectors stay *Pilot* until this is decided and exercised |
| 48 | Document storage location and retention (Oracle Object Storage vs Cloudflare R2; encryption keys; deletion/retention policy; migrating existing files) | `STORAGE_DRIVER=s3` works with either; no migration tool, no retention job (links to #8) |
| 49 | Mail sender identity and templates (domain, branding, languages, Arabic) | Three plain English templates (invitation, payment received, workspace ready) via Resend |
| 50 | Webhook/API commercial terms (rate limits per plan, SLA for webhook delivery, key rotation policy) | 120 requests/minute per key, 5 keys per merchant, ~3 h of retries; no per-plan differences |
