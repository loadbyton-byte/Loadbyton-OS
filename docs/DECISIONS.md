# Decisions required before implementation continues (blueprint §32)

| # | Decision | Where the code is waiting |
|---|---|---|
| 1 | Approve first sector and end-to-end scope (recommended: Forwarding Starter) | Built; pilot with ≥5 design partners (§29 gate) |
| 2 | Contracting entity and **payment merchant** | `PAYMENT_PROVIDER` adapter (only `mock` exists; refused in production) |
| 3 | Hosting, region and recovery budget | Dockerfile/compose are generic; subprocessor page lists categories only |
| 4 | Pilot plan limits | `PLAN_SEEDS` in `src/platform/catalog.ts` (hypotheses, immutable once published) |
| 5 | Accounting system of record | `AccountingAdapter` (CSV/export stub today) |
| 6 | Setup and visit coverage | Copy on `/coverage`; setup orders / technician appointments not built |
| 7 | Support hours and tiers | Not published; do not promise 24/7 on low plans |
| 8 | Free-tier retention/exit policy | Export exists; retention/deletion workflow not built |
| 9 | Initial connector provider (e-invoicing ASP, WhatsApp, Mirsal) | All shown as *Planned* on `/integrations` |
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
| 17 | Fuel/toll policy (who approves, limits, receipt upload) | One independent approver, no receipt upload yet |
| 18 | Salik/toll and fuel-card integrations | Not built |

## Added with Warehouse

| # | Decision | Where the code is waiting |
|---|---|---|
| 19 | Warehouse billing unit and plan allowances (`wh_orders_per_month`) | Hypotheses equal to the jobs allowance; plan v3. Alternatives: per scan/line, per pallet position |
| 20 | Storage billing basis: per unit-day (today) vs per pallet position or per cbm | `accrueStorage` uses end-of-day units on hand; pallet/cbm needs SKU master data (units per pallet, dimensions) |
| 21 | Who may release stock from quarantine and who approves count adjustments (and value thresholds) | `wh.approve` = owner, finance, coordinator; counter ≠ approver (owner excepted). No value-based tiers |
| 22 | Stock rotation policy: FIFO by received date today; FEFO/expiry, lot-controlled and serial-tracked goods | `first_received_at`; lots are free text; no expiry |
| 23 | Barcode/RF scanning hardware and a WMS/ERP integration | Scan/retry references exist (`client_ref`); no hardware or integration |
| 24 | Backorders, partial-shipment policy and returns | Partial allocation closes the shortfall; no returns flow (belongs with E-commerce fulfilment) |
| 25 | Insurance / liability cut-off for custody stock and bonded goods | Not modelled; bonded warehousing is explicitly out of scope (see /coverage) |
