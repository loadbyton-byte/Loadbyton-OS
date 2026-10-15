# Data protection

**Status: working draft. A qualified UAE data-protection adviser must review this before launch.** It describes what the product does with personal data; it is not legal advice and states no legal conclusion.

## What we hold
| Data | Whose | Why | Where |
|---|---|---|---|
| Name, e-mail, mobile, password hash, MFA secret | customer users and staff | sign-in and security | database (hashed / sealed) |
| Trade licence upload, company identity numbers | customer company | company verification against fake or duplicate accounts | database + private object storage; unique-identity keys are hashed |
| Recipient name, phone, address, delivery proof (photo, signature) | customers' end consumers | delivery and COD | database + object storage |
| Driver and rider locations, device readings | drivers, riders | dispatch, proof, temperature compliance | database |
| Bank/card statement lines | customers | reconciliation | database; customer-supplied credentials sealed |
| Support chat, enquiries | visitors, customers | support | database |

## Roles
For their own operations data the **customer is the controller and we are the processor**; for account, billing, verification and platform security data we are the controller. The data-processing terms customers accept must say so; they are drafts until reviewed.

## Retention
The application has a privacy-request queue and retention controls (see `docs/IMPLEMENTATION_BACKLOG.md` for what is automatic and what is manual). Proposed starting points for counsel to confirm: operational records 7 years where accounting/tax law requires; verification documents for the life of the account plus the period counsel advises; delivery proof photos 13 months; support chat 24 months; failed-login and rate-limit data 90 days; backups 35 days rolling.

## Requests
Access, correction, deletion and export requests are logged in the privacy-request queue and answered inside the legal period (confirm with counsel). Customers can export their workspace (`/app` export). Deletion keeps records the law requires us to keep and says so.

## Cross-border
Hosting regions and sub-processors are in VENDORS.md. The owner must confirm the lawful basis for each transfer outside the UAE with counsel, and publish the sub-processor list to customers.

## Minimisation and security
Personal data is excluded from logs where practical, identifiers in verification are stored as keyed hashes, photos and licences are in private buckets served by short-lived links, and every access by staff to a customer workspace is customer-approved and audited.
