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

## Short picks
Board → "short pick(s) are open" (also on the dashboard task list). The picker found fewer units than the system promised: the
missing units were released, the order shows *waiting* units, and a task names the SKU and bin. Count that bin (Stock → Count a bin);
once a different person approves, the stock level is corrected and waiting orders re-allocate automatically. Resolve the task.

## A count shows "stale" (voided)
Stock moved between the count and the approval, so applying the old difference would be wrong. Nothing was changed. Count again.

## Orders stuck "waiting for stock"
Check Stock → *Waiting* and *Incoming* for the SKU. A pending inbound will serve the oldest waiting orders automatically when received.
If stock exists in a non-sellable place, move it: units in `RECV` or `QUAR` are not allocatable until transferred to a bin
(Stock → Move stock). "Try to allocate waiting orders" on the board re-runs the pass.

## Closing an order short
Only when the merchant agrees the missing units will not come. Use *Close short* with a reason (audited); the rest can then ship.
Do not use it to hide a short pick — count the bin first.

## Merchant billing run
Billing activity → set each merchant's rate card (rates apply from now on) → *Create storage charges* once a month (snapshot of occupied
locations; safe to repeat) → *Invoice merchant*. A wrong invoice is voided (finance), which returns the activity to the unbilled pool.


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


## Delivery: a rider's cash is short or over
Cash desk → count the cash against “expected”. A difference needs a note and a **second person** (owner excepted) to Accept or send back for a recount.
Accepting records the variance against the rider (`Cash differences on record`); the merchant is still paid what was collected. Never edit a collection: the database refuses it.
If a rider took cash for a parcel the system refused (“stored, not applied” on the board), the cash arrives as an **overage** at handover — find the parcel from the board's conflict list and fix the parcel, not the cash.

## Delivery: paying a merchant
Cash desk → “Owed to merchants” → Prepare (tick *Net fees* to invoice their rated delivery charges and settle them out of the COD). A different person confirms the payout with the bank transfer reference.
A statement with no fees netted can be withdrawn before it is paid. If a statement is wrong after fees were netted, pay it, then correct through finance (credit/void) — do not delete.

## Delivery: undelivered and return-to-sender
Board → “Needs a decision”. Re-attempt (optionally with a corrected phone/address) or return to the merchant. A parcel that used all attempts is already marked return-to-sender with a 24-hour task.
Confirm *returned* when it is physically back with the merchant: that accrues the return fee once.

## Delivery: billing run
Rates & billing → set the merchant's rate (activity before the rate existed is priced at the rate in force that day). “Invoice” bills all rated, unbilled activity up to today. Voiding the invoice releases the charges.

## Delivery: a rider cannot see their run
The run must be **Sent out**, the rider needs a login (Riders → Invite), and a rider can have one run out at a time. Close the previous run first.


## Dead-lettered outbox rows (mail, SMS, webhooks, accounting)
`lbt_outbox_rows{status="dead"}` > 0 (see `docs/MONITORING.md`). `SELECT topic, last_error, count(*) FROM outbox WHERE status='dead' GROUP BY 1,2;`
- `email` + “rejected … domain” → fix the Resend sender domain (DKIM/SPF), then `UPDATE outbox SET status='pending', attempts=0, next_at=now() WHERE topic='email' AND status='dead'`. Invitation emails have already lost their link after a successful send, but a dead row still carries it — re-queueing is safe.
- `merchant.webhook` + “410” or “address refused” → the merchant removed or moved the endpoint: ask them to update *Integrations*; re-queue after they do. They can always read parcel status through the API meanwhile.
- `sms` + “rejected (… code 21211)” → bad number; nothing to retry.

## A merchant API key leaked
Delivery → Integrations → **Revoke** (takes effect on the next request), create a new key, give it to the merchant. Check *Last used*. A leaked key can only read/create that merchant's parcels; it cannot see other merchants, cash or rates.

## A merchant's webhook secret leaked
Integrations → tick **new secret** → Save (shown once). Old signatures stop verifying immediately.

## Uptime alert on /readyz
`curl -s https://www.yourdomain/readyz` shows which worker is stale (`outbox: silent for 300s`). `docker compose -f docker-compose.prod.yml logs --tail=200 web | grep worker:` for the error; restart the web container if a worker loop is wedged.
