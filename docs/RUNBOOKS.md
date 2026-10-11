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


## Warehouse: physical counts are due

Open Warehouse → Count schedules. An approver records issued valuation/risk policy evidence, an explicit interval, location scope, expiry and an active named counter. There is no universal value threshold or automatic physical count. Start each due count when the operator can perform it; overlapping open/submitted counts must be completed or cancelled first. The next due date advances from the actual Dubai start day. Held/expired evidence and inactive counters block generation; disable and replace an obsolete policy rather than editing its history. The private `lbt_warehouse_counts_due` gauge includes blocked due policies so they remain visible; connect its alert receiver during deployment. Generation only creates a blind sheet. It never adjusts stock.

## Warehouse: a count variance is waiting
Warehouse → Counts → open the submitted count. Approvers see system vs counted; counters never do. *Approve adjustment* posts one `adjust`
movement (visible in the Movement ledger with the count number and the approver). *Reject* leaves stock unchanged. If the page says the
stock moved since the sheet was cut, nothing was adjusted: the line is back with the counters with a fresh snapshot — recount it. An
owner cannot approve a variance they counted; assign a different finance/coordinator approver. An adjustment that would drop stock below what is reserved is refused: cancel or re-allocate the dispatch order first.

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

## Delivery: unsuccessful attempts and return to merchant

Delivery → parcel → Dispatch chooses an active courier with an accepted individual driver invitation and a manual route reference. Drivers open My trips → My parcels. A failed attempt needs a reason and collects no COD. Redispatch a failed parcel for another attempt, or record its return with a reason. Delivery requires recipient proof; its recorded evidence cannot be overwritten. Only undispatched parcels can be cancelled. Parcel events currently require an online connection; the Transport offline queue does not cover COD.

## Delivery: COD shortage or surplus

Do not edit expected or collected figures. Finance records the actual cash handover, including zero when nothing arrived. If expected, collected and received figures differ, a *different* finance approver must explain the variance; owner status does not bypass independence. Keep the underlying investigation/reference in the explanation. Reconciliation preserves every amount and does not write off a receivable or create funds. Remit only reconciled cash available, recording the real bank reference; duplicate references retry once and over-remittance is refused. Surpluses and shortages remain visible. COD corrections, subsequent recovery, refunds, bank reconciliation and formal loss accounting are not yet implemented—resolve these cases with finance outside this pilot rather than altering ledger entries. Service-fee invoices exclude COD; ordinary invoice voiding does not reverse COD.

## Customs: evidence and handover

Upload evidence in Documents and attach it to the case by kind. Readiness requires commercial invoice, packing list and transport document; the approver must additionally check goods-specific permits and specialist requirements. Record an authorised-agent/official reference at handover. Record inspection when requested. Only record clearance after attaching authentic official release evidence. This workflow does not file a declaration or make an authority decision. Customer deposits remain separate from revenue; refund only after clearance/cancellation and within the recorded balance. Goods-specific permit evidence is mandatory when the case marks it required. After clearance, finance can invoice the agreed service fee with its snapshotted tax code; collection uses the shared receipt workflow. Voiding releases the fee for re-invoicing. Duty assessment and authority payments remain external to this pilot. Customer deposits are never invoiced as service revenue.

## Metrics and alerts

Follow `ops/monitoring/README.md`. A missing scrape can mean app outage, connectivity failure or a token mismatch; inspect the actual response before restarting anything. Worker errors require checking the relevant queue and application logs. Exercise alert delivery in staging and name the incident owner before production. Templates and a passing endpoint test alone do not establish production monitoring readiness.


## Production backup and isolated restore

Use `npm run backup` with a direct `MIGRATION_DATABASE_URL` (or direct `DATABASE_URL`), `BACKUP_ENCRYPTION_KEY`, `BACKUP_OUTPUT_DIR`, and working PostgreSQL client tools. Keep the key separately from encrypted archives. The job holds an exported consistent database snapshot while dumping; it verifies every immutable document hash before packaging. Copy the resulting encrypted archive to approved storage outside the Oracle VM and monitor success and age. A local archive alone does not survive VM loss.

For a drill, provide a new empty `RESTORE_DATABASE_URL`, `RESTORE_CONFIRM_ISOLATED=true`, the backup key, and a **different private** `RESTORE_SUPABASE_STORAGE_BUCKET` (or isolated development `RESTORE_STORAGE_DIR`). Run `npm run restore -- <archive.lbt>`. This verifies authenticated decryption, all recorded table counts, private object hashes, business invariants, and tenant visibility. Never point this command at an active database/bucket. Then use the restored app for a login, evidence download, and audit inspection; record measured snapshot age and recovery duration. Provider PITR and live incident recovery need separate acceptance.

## Manual specialist readiness and exceptions

Use the selected sector workspace to register an issued review document, qualified reviewer, review scope and validity. Required source evidence must also be issued and unheld. Readiness does not certify a company or replace an authority approval. Required reviews/evidence are rechecked at active/completed transitions; renew expired reviews by retaining history and recording fresh source evidence.

Cold-chain excursions and recorded vehicle/container damage place cases on hold. An independent approver must record the supported disposition. Container repairs must close before gate-out; transit guarantees must cover the contract at activation, release only after recorded exit and closure evidence, and have no residual balance at completion. Consolidator agent settlements and distribution dispatch quantities must reconcile before completion. Financial close requires the shared case service invoice to be collected, independently of recorded external costs/guarantees.

## Warehouse registered lots, expiry, serials and holds

Register tracked custody inventory with its issued supplier evidence before receiving it. FEFO requires a valid expiry date. Expired or held inventory can enter quarantine with its nonconforming condition; it cannot be allocated or dispatched. A quality release needs an approver and a supported reason, and cannot change the immutable source/expiry/serial contract. Renewal of an expired source document does not rewrite the original evidence record.

Serial inventory moves in single whole units and cannot exist twice across locations. Investigate duplicate scans before retrying a receipt. Transfers retain the serial identity. Cancel an allocation that became held before dispatch, then allocate eligible stock; never directly edit stock balances or remove a quality hold to force shipment. Fulfilment has a separate inventory engine; these custody controls do not implicitly apply there.

## Inbox handover, approval and uncertain delivery

Capture the source reference and party; record actual email consent. The assigned team member accepts a handover before drafting a reply. Owner approval captures the recipient and consumes the plan's message allowance; only approved drafts enter the outbox. Inspect the configurable Dubai business calendar when a due date is disputed.

A timeout after SMTP submission can mean delivery succeeded. The system places such a message in delivery review and prevents automatic resending. Inspect the provider delivery log using the recorded deterministic Message-ID, then record supporting evidence with **confirmed sent**, **retry**, or **cancel**. Retry is an explicit owner decision after checking the recipient/consent and the expired worker lease; it is not proof that an earlier delivery failed. SMTP cannot provide a universal exactly-once delivery guarantee. Actual inbound mail/WhatsApp ingestion is not implemented by the manual capture form.

## Source-evidenced party migration

Upload and issue the source CSV, stage a migration batch, inspect every rejected/duplicate row and the source hash, and record the approved cutover evidence. Staging does not alter operational parties. A valid apply is atomic and repeatable; it creates new records and never overwrites existing parties. Rollback is allowed only while imported parties have no operational references. Stock, opening balances and final-delta migrations require additional reconciled tooling and controller acceptance.

## MFA, invitations and credential changes

Owners and staff enroll TOTP through Security, retaining recovery procedures under the reviewed support policy. Enrollment requires the current password and revokes other sessions. Company sensitive-role MFA is enforced in production; staff MFA is separate. Revoke compromised sessions and API keys through their corresponding controls. Existing accounts accepting invitations must enter their current password; old legacy invitation tokens must be reissued by an authorized owner. Do not manually clear MFA or grant a support membership to bypass the acceptance workflow.

Changing the MFA/connection encryption key without migration makes existing encrypted secrets unreadable. The repository now provides `npm run rotate-encryption-key` for MFA seeds, encrypted accounting connections and invitation tokens, with a default authentication-only dry run and explicit `--apply`. Run it against the direct privileged database endpoint with `MFA_ENCRYPTION_KEY` set to the new key and `MFA_ENCRYPTION_PREVIOUS_KEY` set to the old key. Both must be distinct and at least 32 characters. Never pass secrets as CLI arguments or print them.

Rehearse on an isolated restore and take a verified encrypted backup first. During a maintenance window, pause web and workers, configure the new primary plus old previous key, run the dry run, inspect counts, then run `npm run rotate-encryption-key -- --apply`. The command locks all three secret-bearing tables in one transaction, handles at most 10,000 records in bounded pages, and aborts the entire migration on unknown/corrupted ciphertext. It does not send invitations, alter MFA enrollment/replay counters or contact accounting providers. Success produces only table counts and a system audit event. Restart every process with the new primary plus old previous key and verify MFA/accounting/invitation delivery using controlled acceptance records. A subsequent dry run must report zero pending records. Only then remove the previous key from live process environments. Retain the old key separately under the approved backup-retention policy so historical backups remain recoverable. Production maintenance and acceptance have not been performed in this checkout.

For a rolling deployment, first deploy this dual-reader code to every process with the old primary and new previous key, then switch every process to the new primary and old previous key before migrating. Do not introduce new-key writes while any old code remains. Do not remove either decryption key while either primary key is still in use. Gateway signing keys, session secrets and backup keys have separate rotations and are not changed by this tool. Legal/tax/merchant variables must describe the actual Indian service merchant; GST documentation alone must not be treated as UAE VAT registration.

## Offline transport event reconciliation

Transport event queues are scoped to the current company and user. Rejected sync events retain their payload and rejection reason for review; do not delete them to hide a failure. Submit bounded batches while online and inspect the trip event log. Legacy version-one queues are retained rather than automatically reassigned to a new identity: review their original company/user before any controlled resubmission. The current Transport queue does not provide offline Delivery/COD or first-open offline application caching.

## Privacy requests and retention

A request/decision record is evidence of review, not evidence that data was erased. Keep legal holds, accounting retention and document evidence in the controller decision. Execute only a reviewed procedure, verify affected records/objects/backups and retain the approved completion evidence. Automated tenant erasure, scheduled anonymisation and fine-grained recipient minimisation remain software backlog items; do not acknowledge completion merely by changing a request status.


## Chargeable weight and provider tariff changes

Upload the actual external provider tariff and identify its issuer. Pricing/approval staff record the provider, mode, exact divisor or weight/measure coefficient, rounding increment, minimum, service restrictions, valid dates and reviewer. There is no universal prefilled divisor. Air/road volumetric rules use cm³/kg; ocean LCL weight/measure uses kg/revenue tonne and cbm.

Before calculating, confirm that the enquiry falls within the reviewed service, lane and cargo restrictions; both gross kg and cbm must be recorded. Held, draft, future or expired provider evidence is refused. Each calculation preserves its inputs and provenance. A changed tariff requires a new immutable rule; earlier calculations retain their original source. Use the reviewed quantity when preparing a quote, retaining the source link, then follow ordinary price approval. Calculations do not automatically send prices, issue regulated documents or authorize a provider commitment.


## Fulfilment shipment handover to Delivery

Select both packs within the paid sector allowance. Complete reservation, picking, packing and a shipment using **Own fleet** for a UAE domestic recipient. A user with fulfilment-write and delivery-write permissions records the merchant-approved service fee, explicit COD (zero for prepaid), tax treatment and instruction evidence in the shipment's handover form. Add a recipient phone when absent from the source.

The handover creates one metered parcel and an immutable source link; concurrent/repeated submissions return the same parcel. Changed fee/COD/phone details are refused rather than rewriting the collection contract. It does not move stock again, collect cash, remit funds or invoice COD. Continue courier assignment, recipient proof, cash handover and reconciliation in Delivery. Fulfilment handling charges and Delivery service charges remain separately identifiable. External carrier and cross-border shipments require their own approved provider flow; they are refused by this internal handover.


## Fulfilment recipient access and paginated queues

Warehouse operators/coordinators and owners can read the recipient contacts needed for fulfilment. The merchant portal stays within its bound merchant. Financial/read-only roles and support grants receive restricted recipient name/phone/address on order views and structured order exports; their searches cannot match the hidden recipient name. Packing-slip printing requires recipient access. This projection does not anonymise source records, attachments or arbitrary free-text history. Those need controller-reviewed retention/minimisation policies.

Orders, inbound deliveries and returns show 50 records per page, retain filters, and sort by timestamp plus ID. Use Next/Previous to reach earlier records rather than assuming the first page is the whole queue. Records remain available after plan restriction and export remains supported.

## Assistant draft or provider cost needs review

Open Assistant drafts under the operating company user who created the draft. Drafts are suggestions, never approvals or executed actions. Verify the cited current record; a changed source shows a warning. Current roles and membership are rechecked on reads and exports. Copy a reviewed reply into the existing consent/approval-controlled inbox workflow if needed; the assistant itself cannot send.

The default deterministic template does not contact a model. Enable OpenAI only after reviewing data processing/regions/retention and recording the current model/token prices and per-company USD budget. A plan-v7 draft allowance and a conservative request ceiling are reserved in a committed transaction before network work. Older plans require an explicit upgrade. Known token usage is measured; timeout, invalid output, missing usage and process interruption retain the ceiling as uncertain cost. Do not manually zero uncertain costs or retry with a new reference to bypass review. Repeated references never contact the provider again. After a pending request has aged one minute, its author may recover a deterministic snapshot draft without sending again. Deployment staff reconcile uncertain costs against actual vendor accounting; automatic cost write-offs are not implemented.

Check private `lbt_assistant_pending`/`lbt_assistant_uncertain` alerts and contact the affected authorized author using the reviewed support process. Private document text, contact names, addresses, routes, notes and financial prices are not sent by this structured retriever. Document extraction and wider-sector/report assistance remain separate work.

## Fulfilment: daily storage accrual and missing days

Open Fulfilment → Daily storage. Record issued agreed terms with their reviewer, explicit AED per-location daily amount (including zero), reviewed tax code, goods/location scope, Dubai closing cutoff and future month-boundary start. This basis counts occupied bins/receiving/quarantine locations per merchant at midnight; staging is excluded. It does not infer pallet/cbm/peak pricing. Past contracts are not fabricated from today's rate card, and overlapping daily terms are refused.

For each closed contract day, run **Accrue day**. The quantity comes from immutable movements before the following Dubai midnight, not the current stock cache. Every merchant/day has one immutable occupancy record; safe retries retain it even after invoicing. Zero occupancy and explicit free rates still produce evidence without charges. The approved daily term blocks monthly snapshots for covered months. Invoice activity separately after finance review; voiding only releases the existing charge for reissue. It does not delete a day or produce a second fee. A changed billing-entity currency blocks relabelling AED amounts. Held source evidence blocks new accrual.

Monitor `lbt_fulfilment_storage_due` for contracts with missing closed days, including expired contracts with gaps. Finance may enable or pause automatic closed-day accrual with an audited reason. The worker rechecks the active approving finance membership, tenant/subscription/sector, source and AED entity; each tick catches up one earliest missing closed day per contract, up to 25 contracts. It uses a system audit actor, preserves manual/worker idempotency and never issues invoices. Manual day accrual remains available. A contract-amendment procedure is not implemented. Do not edit/delete a financial charge or replace historical terms to correct billing; retain source evidence and use a controller-reviewed correction procedure.

## Transport: receipt evidence is missing or withdrawn

A recorded fuel/toll/parking/other expense does not count as approved trip cost until finance reviews its latest issued receipt and a different person decides it. Owner status cannot bypass independence. Drivers upload their own assigned-trip receipt when connected; offline expense capture can precede upload. Office operators/finance can upload or link an issued supplier invoice/receipt attached to that exact trip. Enter the actual issuer and inspect the amount/tax/business purpose rather than treating uploaded metadata as proof of accuracy.

Replacement evidence appends an immutable version while the expense is pending. A held/draft/latest unavailable receipt blocks approval; an older good version is not silently substituted. Approval freezes the specific receipt and original amount/event. Rejection can proceed without a receipt; a decided expense cannot be replaced, repriced or deleted. Historical pre-change decisions are marked **legacy expense: evidence review pending** and are not retroactively certified. Investigate later withdrawal through the controller correction process rather than changing approved costs. Driver downloads recheck current trip assignment on each request; they do not grant company-wide file access.

## Generated shipment document drafts

An owner publishes an immutable reviewed template version in Document drafts. An authorized forwarding operator chooses a job and its current issued customer/provider evidence, then supplies verified cargo particulars. Generated versions preserve their exact template, field values, job snapshot and evidence hash. Print/save PDF and JSON export preserve the draft marker; source withdrawal/hold produces a warning without erasing history. Changes require a new draft/template version. Generated commercial invoices are goods-document drafts, never service invoices or ledger postings. Delivery-order and transport-document drafts do not authorize release, certify cargo or replace a carrier/authority-issued instrument. Keep actual externally issued evidence in Documents and follow the separate issuer/approval acceptance process.

## COD cash recovery, refunds and corrections

Reconcile the original collection and handover first; the original recorder cannot decide a mismatch. Upload issued cash-event evidence from the parcel finance page, then propose a recovery, refund, correction in or correction out with its amount and external reference. Each issued evidence record can belong to one adjustment; a corrected/rejected event needs a new source version. A different current owner/finance member reviews actual cash, issuer, parcel and reference before approving or rejecting. Pending/rejected proposals have no cash effect. Decisions are immutable; repairs require new separately evidenced events.

Original merchant entitlement, collection and handover figures remain visible. Approved recovery can cover a collection/custody shortage; a custody correction does not silently change the original customer collection. Surplus is never extra merchant entitlement. A refund reduces custody cash and may leave an unresolved merchant liability; no write-off is implied. A cash-out change cannot reverse previously remitted cash or make the balance negative. Record actual returned cash with separate issued evidence before recording a subsequent refund when funds were already remitted. Review withdrawn/held sources without erasing historical decisions. The software records external events and does not collect, hold or transfer customer funds, initiate gateway refunds, automatically match bank statements or post a native liability journal. Those integrations/controller approvals remain separate release scope.
