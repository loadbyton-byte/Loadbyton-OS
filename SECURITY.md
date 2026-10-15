# Security policy

## Reporting a vulnerability
Send a report to the security contact listed in `docs/security/CONTACTS.md` (the owner must fill it in before launch; until then use the repository owner's address). Please include what you found, how to reproduce it, and what you think the impact is. Do not test against other customers' data, do not run denial-of-service tests, and do not publish details before we have had a chance to fix the problem.

We aim to acknowledge a report within 2 business days, give a first assessment within 7 days, and fix confirmed critical issues as fast as we can safely ship a fix. These are targets, not guarantees. We will credit reporters who want credit.

## What is in scope
The web application, the control console, the merchant API, the driver and rider apps, the RF terminal server and the background workers. Hosted providers (Cloudflare, Supabase/Neon, AWS, Stripe/Razorpay) are out of scope; report problems with them to the provider.

## Controls in the code (verified by tests)
Row-level security on every tenant table, sealed provider credentials, hashed passwords and PINs, staff multi-factor sign-in, rate limits, content-security headers, immutable audit log, company verification before a new workspace can write, and reconciliation checks (`npm run verify`). See `docs/security/` for the operating policies that go with them.
