---
title: "LOAD|BY|TON.store — Operations Handbook"
---

# LOAD|BY|TON.store — Operations Handbook

The one place for every step and command needed to run the live site. Written for a non-technical owner.
Tick the boxes (☐) as you go. **Never paste passwords, keys or tokens into chat, email or screenshots.**

# 1. The system at a glance

| Piece | What it does | Where |
|---|---|---|
| Website + app | Runs the product | One AWS server (EC2), region **eu-north-1 (Stockholm)** |
| Server ID | Used to connect | `i-0f878ed97ff158915` |
| Code | The program | GitHub `loadbyton-byte/Loadbyton-OS`, branch `main` |
| Internet entrance | Domain, security, tunnel to server | Cloudflare (domain `loadbyton.store`) |
| Database | All customer data | Supabase (PostgreSQL, Europe) |
| Files + backups | Uploaded documents, nightly backups | Cloudflare R2 (two buckets: files, backups) |
| Rate limits | Stops abuse | Upstash (Europe) |
| Errors | Alerts when code breaks | Sentry |
| Payments | Card payments | Stripe (test mode now) |
| Email | Invitations, receipts | Resend (domain verified) |

Web addresses: `https://www.loadbyton.store` (site) · `https://admin.loadbyton.store` (admin) · `https://www.loadbyton.store/healthz` (should show `{"ok":true}`).

Server folder: `/opt/loadbyton`. Settings file: `/opt/loadbyton/.env.production` (secret, never share).

# 2. Golden rules

1. **Backup before any change.** The deploy script does it automatically.
2. **Change one thing at a time**, then check `/healthz`.
3. **Secrets live only in** `.env.production` on the server, your password manager and the provider dashboards.
4. If a secret was ever pasted somewhere public: **rotate it** (create a new one, update the server, delete the old).
5. Money: never switch to live payment keys until the launch checklist (section 13) is fully ticked.
6. Watch the AWS bill weekly (budget about US$30/month against the US$100 credit).

# 3. Connect to the server (every time)

On your Chromebook Linux terminal:

```
aws ssm start-session --target i-0f878ed97ff158915 --region eu-north-1
sudo -i
cd /opt/loadbyton
```

You should see a prompt ending `/opt/loadbyton#`. To leave: type `exit` twice.

If the command fails, the AWS keys on the Chromebook may have changed: run `aws configure` (region `eu-north-1`) and use a **new** access key from AWS IAM.

# 4. Check everything is healthy

```
curl -s https://www.loadbyton.store/healthz
bash infra/aws/compose.sh ps
bash infra/aws/compose.sh logs --tail=40 web
bash infra/aws/compose.sh logs --tail=40 worker
bash infra/aws/configure-env.sh check
```

* `healthz` must print `{"ok":true}`.
* `ps` must show web, worker, scanner, tunnel all running/healthy.
* `check` lists which settings are set or EMPTY (never prints secrets).

# 5. Deploy a new version (manual, always works)

Use this after changes are **merged into `main` on GitHub**. Find the newest commit address with `git rev-parse origin/main` (a 40-character code).

☐ 1. Connect (section 3), then `cd /opt/loadbyton`.
☐ 2. Back up first: `bash infra/aws/backup.sh` (must end `backup OK: uploaded and found in R2`).
☐ 3. Deploy (replace COMMIT with the 40-character code):

```
git fetch origin
git checkout --quiet --detach COMMIT
bash infra/aws/compose.sh build
bash infra/aws/compose.sh run --rm --no-deps web npm run migrate
bash infra/aws/compose.sh up -d --remove-orphans
```

☐ 4. Wait a minute, then check:

```
bash infra/aws/compose.sh ps
curl -s https://www.loadbyton.store/healthz
curl -s https://www.loadbyton.store/readyz
```

Success: all containers healthy, `{"ok":true}` and `{"ok":true,"workers":"ok"}`.

**Roll back** (use the commit you were on before; `git rev-parse HEAD` before deploying shows it):

```
git checkout --quiet --detach OLD_COMMIT
bash infra/aws/compose.sh build
bash infra/aws/compose.sh up -d --remove-orphans
```

Database changes are not reversed by a rollback.

**About the scripted deploy (`infra/aws/deploy.sh`):** it also runs `readiness --strict`, which refuses until every launch gate in the readiness register is signed off. Until then, use the manual steps above. The automatic GitHub deploy has the same limit.

# 6. Automatic deploys from GitHub (one-time setup)

After this, every merge to `main` tests and deploys by itself (watch it in GitHub → Actions).

☐ 1. In GitHub repo → **Settings → Secrets and variables → Actions → Variables**, add:

| Variable | Value |
|---|---|
| `AWS_REGION` | `eu-north-1` |
| `AWS_DEPLOY_ROLE_ARN` | output `github_deploy_role_arn` from Terraform (section 12) |
| `AWS_INSTANCE_ID` | `i-0f878ed97ff158915` |

☐ 2. **Settings → Environments → New environment** named `production`.
☐ 3. Merge a small change to `main` and watch **Actions** turn green.
☐ 4. Check `/healthz`.

# 7. Settings (secrets and configuration)

Change a setting safely:

```
cd /opt/loadbyton
bash infra/aws/configure-env.sh
```

It asks one question at a time. **Press Enter to keep the current value.** Long values (database address) are typed in pieces: host, project ref, password. After changes, restart:

```
bash infra/aws/compose.sh up -d
bash infra/aws/compose.sh exec web npm run preflight
```

`preflight` must say `Deployment setting validation passed.`

Database certificate error (`SELF_SIGNED_CERT_IN_CHAIN`): run `bash infra/aws/supabase-ca.sh`, then restart.

Upstash message `[ratelimit] upstash unavailable... fetch failed`: the app still works with a built-in counter, but fix it: in the Upstash dashboard copy the REST URL and token of the **Europe** database, run `configure-env.sh`, enter them, restart.

**Two keys to keep in a password manager (generated by the script, cannot be recovered):** `BACKUP_ENCRYPTION_KEY` and `MFA_ENCRYPTION_KEY`. Without them backups and 2-step logins cannot be recovered.

# 8. Backups and restore

Nightly backup at 02:30 server time → encrypted `.lbt` file → R2 backups bucket.

One-time setup (already done):

```
bash infra/aws/backup.sh setup
bash infra/aws/backup.sh install-cron
```

Run a backup now and check: `bash infra/aws/backup.sh` → must end `backup OK: uploaded and found in R2`. Log: `/var/log/loadbyton-backup.log`.

**Restore drill (do before launch, then quarterly)** — see `docs/RUNBOOKS.md`:

☐ 1. Create a **new, empty** Supabase project (never use the live one) and a different private storage bucket.
☐ 2. Download the newest `.lbt` from the R2 backups bucket.
☐ 3. Set `RESTORE_DATABASE_URL`, `RESTORE_CONFIRM_ISOLATED=true`, the backup key, and the different bucket; run `npm run restore -- <file.lbt>`.
☐ 4. Run `npm run verify` against the restored database: it must print `All invariants hold.`
☐ 5. Log in to the restored copy, open a document, open the audit trail. Write down how long it took.

Never point restore at the live database.

# 9. Admin users and protection

Create an admin (the password is typed hidden, never put in the command):

```
cd /opt/loadbyton
read -rp "Admin email: " E
read -rp "Name: " N
read -rsp "Password (12+ characters): " P; echo
bash infra/aws/compose.sh exec -T web npm run create-staff -- "$E" "$N" "$P" commercial_admin
```

It prints a secret for your authenticator app (Google Authenticator, etc.). Add it to the app immediately. Roles: `commercial_admin`, `support`, `engineer`, `auditor`.

Protect the admin address with Cloudflare Access:

☐ Cloudflare → **Zero Trust → Access → Applications → Add → Self-hosted**
☐ Hostname `admin.loadbyton.store`
☐ Policy: **Allow**, rule **Emails**, only your email address
☐ Test in a private window: a Cloudflare code screen must appear first.

# 10. Email (Resend)

Already verified. To change the sender or key: run `configure-env.sh`, answer the Resend questions (key `re_...`, sender `noreply@loadbyton.store`), restart. Test by inviting a team member to your own address. Check the spam folder.

# 11. Payments (Stripe)

Today: **test mode**. Webhook address: `https://www.loadbyton.store/webhooks/payments/stripe` (5 events).

Go live — only when section 13 is complete:

☐ 1. Stripe dashboard → switch to **Live mode**; complete business verification.
☐ 2. Create a **live** webhook with the same address and the same 5 events; copy its signing secret (`whsec_...`).
☐ 3. Server: `bash infra/aws/configure-env.sh` → enter the live secret key (`sk_live_...`) and the new signing secret.
☐ 4. Edit `.env.production` and **delete the line** `ALLOW_TEST_PAYMENT_KEYS=true`.
☐ 5. `bash infra/aws/compose.sh up -d` then `... exec web npm run preflight`.
☐ 6. Make one small real purchase, confirm the order shows paid, then refund it.

# 12. AWS and Terraform commands (on the Chromebook)

Run from the repo folder on the Chromebook (not on the server): `cd Loadbyton-OS/infra/aws`.

| Task | Command |
|---|---|
| See what would change | `terraform plan` |
| Apply changes | `terraform apply` (read the plan, type `yes`) |
| Show outputs (server ID, deploy role) | `terraform output` |
| Check AWS login works | `aws sts get-caller-identity --region eu-north-1` |

**Important:** the AWS account only allows region **eu-north-1**. Other regions are blocked. **Never run `terraform destroy`** — it deletes the server.

Reboot the server if ever needed: AWS console → EC2 → instance → Instance state → Reboot. The containers restart by themselves.

# 13. Launch checklist (before real customers)

☐ Site and `/healthz` OK · ☐ Admin login works with 2-step code
☐ Cloudflare Access on `admin.loadbyton.store`
☐ Nightly backup ran and `backup OK` seen · ☐ **Restore drill done and recorded**
☐ Email invitation test received · ☐ Stripe test payment and webhook = 200
☐ `preflight` passes · ☐ `readiness --strict` passes (deploy script runs it)
☐ `CHECKOUT_TAX_NOTE` wording approved by your accountant
☐ Privacy policy, terms, 90-day retention reviewed (`LEGAL_REVIEWED=true`)
☐ Sentry receiving events · ☐ AWS budget alert set
☐ Stripe live keys in, `ALLOW_TEST_PAYMENT_KEYS` removed, one real purchase + refund tested
☐ Old Mumbai Supabase/Upstash projects deleted

# 14. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Site down, `healthz` fails | Container stopped | `bash infra/aws/compose.sh up -d`, then logs (section 4) |
| `ECONNREFUSED 127.0.0.1:5432` | Database address wrong or broken by paste | Re-enter with `configure-env.sh` (3 short pieces) |
| `SELF_SIGNED_CERT_IN_CHAIN` | Missing database CA | `bash infra/aws/supabase-ca.sh` |
| Deploy: `backup.sh: No such file` | Server on old commit | Fix in section 5 |
| Deploy: checkout would overwrite `backup.sh` | File not executable | `chmod +x infra/aws/backup.sh && git add infra/aws/backup.sh` |
| `UNHEALTHY... rolling back` | New version failed | Read last 25 lines; old version stays |
| Upstash `fetch failed` | Wrong/old Upstash URL/token | Section 7 |
| Admin cannot log in | Wrong 2-step code or no admin | Create admin (section 9) |
| Stripe event not 200 | Wrong signing secret | Re-copy `whsec_...`, `configure-env.sh`, restart |
| Invitation email missing | Resend domain/key | Check Resend domain is Verified; section 10 |
| AWS `AccessDenied` / SCP error | Wrong region | Always use `eu-north-1` |

# 15. Where to ask for help

Give: the **exact command** you ran and the **last 25 lines** of output. Never include passwords, keys, tokens or whole `.env.production` contents.

Source files for everything here: `infra/aws/` (scripts), `docs/RUNBOOKS.md`, `docs/MONITORING.md`, `docs/DEPLOY_AWS_LEAN.md`.
