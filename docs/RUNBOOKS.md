# Runbooks

## Restore test (blueprint §24, §30 "Backup restored")
A green backup job is not enough. Quarterly, and before any schema release:

1. Restore the latest backup into an isolated database (`pg_restore` / provider PITR) and restore the object-store prefix.
2. `DATABASE_URL=<restored> npm run verify` — must print `All invariants hold.`
3. Sign in to a test tenant on the restored stack; open a job → documents download; open the audit trail; compare balances on
   the owner dashboard against production for that tenant.
4. Record RPO/RTO achieved vs targets (RPO ≤ 1 h, RTO ≤ 8 h are objectives to validate, not guarantees).

## Failed provisioning
Control console → Provisioning → failed jobs show the failing step in `failure_reason`. Fix the cause (adapter outage, DNS), press
**Retry**: completed steps are skipped. Customer sees "Activation is delayed" with no data loss; their free workspace stays usable.

## Payment reconciliation
Control console → Orders & payments → "Rejected / ignored provider events". For every `rejected`, compare with the provider
dashboard. Never mark an order paid by hand; replay the provider's event through the signed webhook instead.

## Refund received
Creates a `staff.review` item. Decide entitlement treatment (keep until period end vs restrict) and record it; acknowledge.

## Support access
Staff request a grant (reason shown to the customer) → customer owner approves in Settings (default 4 h, max 24 h) → staff open the
workspace **read-only**; every view start is audited with the staff identity.

## Plan price change
Control console → Catalog → publish new version. Existing subscriptions keep their version; new purchases use the new one.

## Incident roles
Name an incident commander and a customer-communications owner before the first paid customer (blueprint §26).

## Driver events that were "stored, not applied"
The planning board shows a count (last 7 days). Open the trip → *Driver event log*: each row says why (duplicate stop, arrival
already recorded, proof already recorded, clock ahead, trip completed). Nothing is lost — device time and payload are kept. A real
correction (e.g. wrong receiver name) is handled outside the phone flow; proof of delivery is deliberately not overwritable.

## Compliance expiries
Blocking items (registration, insurance, licence) prevent assignment and dispatch when they expire before the trip ends. Renew by
adding the new item; the old one stays as history. Warning-only items never block.

## Warehouse: a count variance is waiting
Warehouse → Counts → open the submitted count. Approvers see system vs counted; counters never do. *Approve adjustment* posts one `adjust`
movement (visible in the Movement ledger with the count number and the approver). *Reject* leaves stock unchanged. If the page says the
stock moved since the sheet was cut, nothing was adjusted: the line is back with the counters with a fresh snapshot — recount it. An
adjustment that would drop stock below what is reserved is refused: cancel or re-allocate the dispatch order first.

## Warehouse: a short pick
Confirm the pick with what was actually found; the shortfall is released at once and the order dispatches what was picked. Raise a
count of that location straight away — the shortage is a stock-accuracy problem, not just an order problem.

## Warehouse: damaged goods / releasing from quarantine
Damaged goods are received into a quarantine location (the system refuses to put them anywhere else). Quarantine stock is never
allocated. Moving it out is a release decision and needs `wh.approve` (owner, finance, coordinator); it is audited.

## Warehouse: billing run
1. Warehouse → Activity billing → *Accrue storage to yesterday* (idempotent; only completed company days; safe to repeat).
2. Resolve **Unrated** lines by adding the missing rate card — earlier activity is priced using the rate in effect on its day.
3. *Invoice* per customer. A wrong invoice is voided (finance.void) which releases its charges for re-invoicing; fix the rate first by
   adding a new rate from a later date (rates already in effect cannot be edited).

## Warehouse: stock does not reconcile
Run `npm run verify`. A "stock balance = sum of its ledger movements" violation means the balance table and the immutable ledger disagree:
never edit either by hand — the ledger is the source of truth. Restore from backup, or post an approved count adjustment once the
cause is understood. Reservation violations point at an interrupted allocation/pick; cancel the dispatch order to release them.
