# Launch hardening checklist

Tick each item with a date and name. Items marked (code) are already enforced by the application and covered by tests; the rest are settings the owner must make.

## Accounts
- [ ] Root MFA on AWS, Cloudflare, Supabase, GitHub, payment and e-mail providers; recovery codes stored offline
- [ ] No access keys on the AWS root; GitHub deploys use OIDC
- [ ] Billing alerts set (AWS budget email)

## Infrastructure
- [ ] Instance has no inbound ports; access only via SSM
- [ ] Cloudflare: SSL mode Full (strict where possible), Always HTTPS, WAF managed rules on, rate-limit rule on `/auth` and `/api`, bot fight mode on
- [ ] Database not publicly reachable except through the provider's pooler with TLS (`DATABASE_SSL=require`)
- [ ] Buckets private; backups bucket token separate from files token
- [ ] Disk encryption on (Terraform default); snapshots scheduled

## Application
- [ ] `NODE_ENV=production`; `npm run preflight` passes (refuses mocks and weak secrets) (code)
- [ ] `KYC_REQUIRED` left unset or `true` (its production default) so new workspaces are verified (code)
- [ ] Staff accounts have TOTP; no shared staff login (code)
- [ ] Security headers, CSP, HSTS on (code)
- [ ] Production upload scanning (ClamAV) running (`CLAMAV_HOST`)
- [ ] Metrics endpoint token set (`METRICS_TOKEN` 32+ chars)
- [ ] RF terminal (`RF_PORT`) bound to a private address only, or off
- [ ] `FEED_ALLOWED_HOSTS` lists only providers actually used

## Monitoring
- [ ] Sentry receiving events; an alert goes to a real person
- [ ] Uptime check on `/readyz`; SNS email confirmed
- [ ] Weekly review of the security workflow results (audit, secrets, CodeQL) and Dependabot pull requests

## Legal and process
- [ ] Policies in this folder adopted; contacts filled in
- [ ] Terms, privacy notice, data-processing terms reviewed by counsel
- [ ] First restore drill done and recorded
