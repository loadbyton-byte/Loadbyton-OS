# Risk register

Likelihood and impact are the owner's judgement (L/M/H). Review quarterly.

| # | Risk | L | I | Mitigation in place | Gap / owner action |
|---|---|---|---|---|---|
| 1 | Cross-tenant data exposure | L | H | row-level security, composite keys, tenant tests, `verify` | independent penetration test |
| 2 | Single instance outage | M | H | automatic health rollback, backups, Terraform rebuild | second instance / multi-AZ when revenue allows; measured RTO |
| 3 | Backup unusable | L | H | encrypted backups, restore drills | run the drills; offline key custody |
| 4 | Provider integration wrong in production | H | M | stubs and contract tests; honest labels in UI | prove each in the provider sandbox before offering it |
| 5 | Payment or COD cash discrepancy | M | H | dual approval, reconciliation invariants, audit | monthly reconciliation; staff training |
| 6 | Fake accounts and abuse | M | M | company verification, rate limits, duplicate-identity blocks | weekly review; Cloudflare bot rules |
| 7 | Credential leak | M | H | sealed secrets, rotation tools, gitleaks | rotation calendar; MFA everywhere |
| 8 | Regulatory change (e-invoicing, PDPL) | M | M | configurable adapters and retention | adviser check-ins |
| 9 | Key person dependency | H | H | docs, runbooks, Terraform | second trained technical person; escrow of accounts and keys |
| 10 | Over-claiming capability (18 sectors) | M | H | readiness gates, honest labels | keep site wording aligned with evidence; official release is blocked until all 18 sector gates are accepted |
| 11 | Cleartext RF terminal intercepted | L | M | private network only, PIN lockout | VPN; replace with HTTPS handheld web app where hardware allows |
| 12 | Vendor price or terms change | M | M | portable stack (Postgres, S3 API) | vendor review yearly |
