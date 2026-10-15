# Access control

## Principles
Least privilege, separate duties, no shared accounts, every privileged action audited.

## Production access
- **Server:** only through AWS Systems Manager Session Manager (no SSH, no inbound ports). Access is granted through named IAM identities with MFA; the root account is not used day to day and has MFA and no access keys.
- **Database:** the application runs as the non-owner role `lbt_app` under row-level security. The migration (owner) connection string exists only in `.env.production` on the server and in the password manager of the technical owner. Nobody queries production by hand without a ticket noting why; read-only investigation uses a restored copy where possible.
- **Object storage:** two private buckets with separate scoped tokens (files, backups). Backups token cannot read files and the reverse.
- **Cloudflare, Supabase, AWS, GitHub, Stripe/Razorpay, e-mail provider:** named accounts, hardware-key or authenticator MFA, no shared logins, recovery codes stored offline by the owner.

## Platform staff (control console)
Staff sign in with a password and a TOTP code. Roles are the minimum needed: support staff do not see payment settings, finance does not see customer content. Looking inside a customer's workspace requires a **customer-approved support grant** (default 4 hours, read-only, audited with the staff member's identity). Staff accounts are created with `npm run create-staff` and reviewed every quarter against the current team list.

## Joiners, movers, leavers
1. Joiner: create named accounts, assign roles from the table above, record in the access register (who, what, approved by, date).
2. Mover: remove the old access the same day.
3. Leaver: same-day removal from AWS, GitHub, Cloudflare, Supabase, the provider consoles, the password manager and the control console; rotate any shared secret they could read (see KEY_MANAGEMENT.md); record completion.

## Quarterly review
The owner exports the staff list, AWS IAM users, GitHub collaborators and provider team members, compares to the real team, removes the rest, and files the result.

## Customer-side
Customers manage their own users and roles. Company verification (e-mail, mobile, trade licence, staff review) must complete before a new workspace can create or change records.
