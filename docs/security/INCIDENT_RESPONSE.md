# Incident response

## Severity
| Level | Meaning | Examples | Target response |
|---|---|---|---|
| S1 | Customer data exposed or lost, or service fully down | cross-tenant leak, leaked database credential, region outage | start at once, any hour |
| S2 | Serious degradation or a security weakness being exploited | payments failing, workers stopped, account takeover pattern | within 1 hour in business hours |
| S3 | Limited impact, workaround exists | one provider feed failing, one customer blocked | same business day |

## First hour (S1/S2)
1. **Name an incident lead** (the technical owner by default) and open a log (time-stamped notes, who did what).
2. **Contain:** rotate the exposed secret (see KEY_MANAGEMENT.md), disable the affected account or feature, block the source in Cloudflare, or take the app to maintenance mode. Prefer stopping the damage over finding the cause.
3. **Preserve evidence:** do not delete logs; snapshot the instance volume; export the audit log (`/admin` audit trail) for the window.
4. **Assess:** which tenants, which data, which time window. The audit log and `device_readings`/`webhook` tables show what was touched.
5. **Decide on notice** (below). Write down the decision and the reason.

## Notice
- **Customers:** tell affected customers without undue delay, plainly: what happened, what data, what we did, what they should do. Do not guess; say what is not yet known.
- **Regulators:** the UAE federal data protection law and, for free-zone customers, the free-zone regimes may require notifying the authority within a stated period. **The owner must confirm the exact duties and deadlines with a UAE data-protection adviser before launch** and write them in CONTACTS.md; this document does not state them.
- **Card networks and payment providers:** card data never touches our servers (hosted checkout), but tell the payment provider if their credentials were involved.

## After
Within 5 business days: write a blameless post-mortem (timeline, root cause, what worked, what did not, actions with owners and dates). Add the regression test or monitor that would have caught it. Update this document.

## Drills
Twice a year run a table-top exercise (a leaked token, a bad deploy, a cross-tenant report) and record what was learned.
