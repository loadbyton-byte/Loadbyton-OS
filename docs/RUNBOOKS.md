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

