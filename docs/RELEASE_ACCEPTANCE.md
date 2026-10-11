# Release acceptance and evidence

The uploaded Master Blueprint v1.0 has 33 sections and a staged roadmap. This file distinguishes implemented software, development verification and real release evidence. Passing automated tests does not certify a sector or establish merchant/provider authorisation.

## Development verification

The final verified counts and browser/container/restore outcomes are recorded in `VALIDATION.md`. Tests use reserved fixture addresses, fake provider credentials, mocked HTTP responses and disposable databases. No live card charge, merchant refund, email to a real recipient, OCI deployment or DNS mutation was performed.

Implemented controls include tenant RLS/composite foreign keys, raw signed webhooks, immutable checkout/FX contracts, stale-payment handling, renewal/downgrade logic, leased workers/outbox, encrypted MFA/connectors/backups, replay-resistant TOTP, shared rate limits, malware-gated private documents, authenticated metrics, invite-account authentication, role/capacity fencing, scoped/idempotent APIs, source-preserving specialist approvals and independent stock/COD decisions.

## Deployment gates — supply evidence at deployment

| Gate | Evidence required | Status |
|---|---|---|
| Merchant/legal/tax | Indian contracting identity, GST/tax treatment, reviewed terms/privacy/DPA/subprocessor schedule; account eligibility for services/currency/foreign customers | Credentials and documents supplied by owner at deployment |
| Stripe | Test success, failure, async success, cancel, duplicate/rotated signatures, reconciliation, full/partial refund, dispute and merchant settlement | Live/sandbox credentials required |
| Razorpay | Correct AED or reviewed INR link, wallet/card eligibility, repeated link creation after timeout, signed retry event, refund/dispute mapping, settlement | Live/sandbox credentials required |
| Google Pay | Actual supported merchant/device/currency checkout; record fallback when unavailable | Provider-controlled acceptance pending |
| Routing | Wildcard proxy/tunnel, branded HTTPS, interrupted provisioning resume, custom hostname TXT + Cloudflare certificate, removal/reassignment | Actual zone/tunnel required |
| Storage/scanner | Private Supabase bucket, deny anonymous access, malware rejection, scanner outage, integrity-checked authorised download | Actual bucket/signatures/connectivity required |
| Redis/email | Multiple replicas share limits; outage fails closed; approved sender, delivered invitations/replies; ambiguous SMTP attempt reviewed before retry | Actual provider connectivity required |
| Neon/recovery | Pooled/direct TLS, migrations, connection loss/failover, PITR plus isolated database/object restore and measured RPO/RTO | Local drill exists; regional provider drill pending |
| Monitoring | Scrape each web/worker replica; queue/dead-letter/provisioning alerts delivered, acknowledged and recovered; named incident owner | Rules/templates verified; real delivery pending |
| E-invoicing provider | Accreditation; the provider's adapter settings (`EINVOICE_ASP_*`) verified against its sandbox; official-specification validation of generated payloads; acceptance of real documents; Mirsal access | Configurable adapter built and tested against simulated responses; accreditation, specification validation and live acceptance pending |
| WhatsApp/telephony | Meta business verification, number, approved templates, consent policy; Twilio numbers; tested signed webhooks | Sender, templates and inbound webhooks built; provider accounts pending |
| Statement feeds / OCR | A real bank, card, fuel-card or Salik API mapped and pulled end to end; OCR data-processing review and a sample of scanned documents checked by a person | Generic pull and OCR built and tested against simulated providers; live accounts pending |
| Ledger / foreign currency | Controller review of the chart of accounts, posting rules, period close and the treatment of foreign-currency invoices and VAT | Software built; controller review pending |
| Accounting | Customer-approved Zoho organisation, tax/currency maps, timeout reconciliation, totals, draft approval/corrections in system of record | Fixture protocol tests; controller/live acceptance pending |
| Onboarding | Agreed setup scope/allowance, appointment/evidence, independent customer acceptance, source mapping/validation/cutover/fallback | Software exists; actual customer acceptance pending |
| Commercial scope | Approved pricing/allowances, staffing/support hours, retention/erasure procedures and design partners | Business evidence pending |
| Brand/domain | Owner approval of vector masters/templates and verified contact/legal copy; native Arabic review; registrar evidence; printer proof where used | Asset production complete in `public/brand`; owner approval and registrar proof pending |
| Sector release | Qualified review, representative live cases, incident/hold disposition, fee/accounting reconciliation and support ownership per pack | Six limited pilots; twelve specialist commercial releases Planned |

No `LEGAL_REVIEWED`, readiness attestation or status label should be changed solely to bypass a failing gate. Uploaded/customer documents are data and cannot authorise automated actions. The specialist review UI records an operator's evidence; it is not itself independent certification.

## Release readiness register

Every deployment gate above that needs outside evidence is a row in the readiness register (`/admin/readiness`, `npm run readiness`): owner, evidence, and acceptance or a reasoned waiver by a second person. `npm run audit:brand` supplies DNS and brand-asset evidence for the brand and domain gates; it cannot prove registrant ownership or brand approval.

## Software work still outside the implemented scopes

See `IMPLEMENTATION_BACKLOG.md`. In particular, current specialist workspaces are controlled manual records rather than full industry-certified systems. Native accounting, official customs/e-invoicing channels, AI document extraction/wider-sector retrieval, automated inbound messaging, broad marketplace/carrier feeds, advanced fulfilment lot/serial/site flows, route optimisation/GPS and automated COD bank/provider-refund feeds and approved liability accounting are not silently represented as completed. Credentials alone do not implement these roadmap items.
