# Support and customer operations

## Channels and targets (set real hours before launch)
| Priority | Example | First reply target |
|---|---|---|
| Urgent | service down, cannot dispatch, cash figures wrong | 1 hour in support hours |
| High | a feature broken for one customer | 4 hours |
| Normal | how-to, small defect | 1 business day |

The shared inbox, SLAs and calendar in the product are the working tool. Publish the hours and targets; do not promise 24/7 unless it is staffed.

## Onboarding
1. Registration and company verification (e-mail, mobile code, licence upload, staff review at `/admin/kyc`). Review checklist: licence is legible and current, company name and number match the registration details, the person is plausible for the company, the identity is not already in use.
2. Setup appointment and acceptance as in the product.
3. Customer imports their data (controlled CSV, with rollback).
4. First-week check-in.

## Fraud and abuse handling
- **Fake or duplicate free accounts:** unique company identity keys, licence review and mobile verification are the barriers; staff reject with a reason, and rejected identities stay blocked. Review the rejection queue weekly for patterns (same phone, same licence image, same payment card).
- **Payment fraud:** never mark an order paid by hand; reconcile with the provider (docs/RUNBOOKS.md).
- **Abusive content or use:** warn, restrict, then suspend under the acceptable-use policy; keep the audit trail.
- **Support impersonation:** staff verify the requester is an owner or admin of the workspace before changing access; password resets go only to the registered e-mail.

## Escalation
Support → technical owner (defects) → owner (commercial, legal, security). Security reports follow INCIDENT_RESPONSE.md.
