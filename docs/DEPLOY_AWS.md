# Deploying on AWS (two accounts, about US$200 of credits)

This replaces the Oracle Cloud VM in [`DEPLOYMENT.md`](DEPLOYMENT.md) with AWS. **Everything else stays as it is**: Cloudflare Tunnel and DNS in front, Neon (or Supabase) PostgreSQL, Upstash rate limits, Stripe/Razorpay. The application and its `docker compose` stack are unchanged; only the host, the object store and the mail relay move.

> **Status.** The Terraform in `infra/aws/` and `infra/aws/backup-account/` was written against current provider documentation but has **not been applied** (no AWS credentials were used while building it). Run `terraform plan`, read every line, and expect to fix small things. Prices below are approximate list prices from memory; confirm them in the AWS Pricing Calculator for your region before relying on them.

## What each account does

| Account | Purpose | Contents |
|---|---|---|
| **A: production** | Runs the product | 1 EC2 instance, its disk, an S3 bucket for uploaded documents, alarms, a budget alert |
| **B: safety** | Holds what must survive a mistake or a break-in in A | One append-only S3 bucket for encrypted backups (Object Lock, no deletes from A). Optionally a throw-away staging instance when you need one |

Using the second account for backups, rather than a second server, is the best use of its credit: a compromised production host cannot delete the copies.

## Rough monthly cost (production, one instance)

| Item | Choice | About (USD) |
|---|---|---|
| Compute | `t4g.medium` 2 vCPU / 4 GB (app, worker, malware scanner, tunnel) | 24 |
| Disk | 30 GB gp3, encrypted | 2.5 |
| Public IPv4 | the instance's address | 3.7 |
| S3 | documents, a few GB | 0.1–1 |
| Backups (account B) | encrypted dumps, tens of MB per day | under 1 |
| Mail (SES) | transactional, a few thousand a month | under 1 |
| **Total** | | **about 32** |

US$100 in account A therefore covers roughly three months of production; the second account's credit extends the runway or pays for a staging instance. A `t4g.small` (2 GB, about 12) works if you run without the ClamAV scanner and accept that uploads are not virus-scanned, which is a decision to take deliberately. The Terraform budget alert counts real spend with credits excluded, so you see what the bill would be after the credits end.

Check before you start: Cloudflare Tunnel, Neon and Upstash are billed by their own providers, not AWS, and are not in this table.

## Steps

### 1. Prepare both accounts
- Enable MFA on each account's root user and create an administrator IAM Identity Center or IAM user for daily work; do not use root.
- In **Billing → Budgets** confirm your credits are attached to the right accounts and set the email contact.
- Pick the region. `ap-south-1` (Mumbai) is the default: close to you and cheap. `me-central-1` (UAE) is closest to customers and must be enabled under *Account → AWS Regions*, with higher prices. Latency from the UAE to Mumbai is fine for this application; data-residency expectations from a customer are the reason to choose the UAE region.

### 2. Backup bucket in account B
```bash
cd infra/aws/backup-account
terraform init
terraform apply -var production_account_id=<account A id>
# note the output backup_bucket
```

### 3. Production in account A
```bash
cd infra/aws
cp terraform.tfvars.example terraform.tfvars   # set alert_email and backup_bucket_name
terraform init && terraform plan && terraform apply
```
Confirm the SNS email subscription that arrives. Terraform creates an instance with no inbound ports: you connect with Session Manager, not SSH.
```bash
aws ssm start-session --target <instance_id> --region <region>
```

### 4. Create the two access keys by hand (so they never enter Terraform state)
```bash
aws iam create-access-key --user-name loadbyton-prod-files     # S3 for documents
aws iam create-access-key --user-name loadbyton-prod-backup    # put-only into account B
```

### 5. Bring the app up
On the instance:
```bash
sudo -i
cd /opt/loadbyton && git clone https://github.com/loadbyton-byte/Loadbyton-OS.git . 
cp .env.example .env.production && chmod 600 .env.production
```
Edit `.env.production` (every variable is documented in `.env.example`). The AWS-specific ones:
```
DEPLOYMENT_REGION=AWS ap-south-1 (Mumbai)
STORAGE_DRIVER=s3
S3_ENDPOINT=https://s3.ap-south-1.amazonaws.com
S3_REGION=ap-south-1
S3_BUCKET=<files_bucket output>
S3_ACCESS_KEY_ID=...        S3_SECRET_ACCESS_KEY=...
S3_PATH_STYLE=false
MAIL_PROVIDER=smtp
SMTP_HOST=email-smtp.ap-south-1.amazonaws.com   SMTP_PORT=587
SMTP_USER=<SES SMTP user>   SMTP_PASSWORD=<SES SMTP password>
MAIL_FROM="LOAD|BY|TON <noreply@loadbyton.com>"
```
Then start the same stack used on Oracle:
```bash
docker compose -f ops/production/compose.yml --env-file .env.production up -d --build
```
Create the Cloudflare Tunnel in the Cloudflare dashboard, put its token in `.env.production` as `CLOUDFLARE_TUNNEL_TOKEN`, and point the public hostname at `http://web:3000`. Use `npm run preflight` and `npm run readiness` as described in `DEPLOYMENT.md`.

### 6. Email through Amazon SES
1. In SES (same region) verify the domain `loadbyton.com`; add the DKIM CNAMEs, and SPF/DMARC records in Cloudflare DNS.
2. Request **production access** (new accounts start in a sandbox that only delivers to verified addresses). Describe the use as transactional email: invitations, password resets, invoices.
3. Create SMTP credentials (SES → SMTP settings) and put them in `.env.production`.
4. Receiving mail at `info@`, `support@` and `contact@loadbyton.com` is separate: keep your existing mail host or Cloudflare Email Routing. The site only needs to *send* through SES.

### 7. Nightly encrypted backups into account B
`npm run backup` writes an encrypted archive to `BACKUP_OUTPUT_DIR`. Copy new files out with the put-only key:
```bash
# /etc/cron.d/loadbyton-backup  (runs as root on the instance)
30 2 * * *  root  cd /opt/loadbyton && docker compose -f ops/production/compose.yml --env-file .env.production run --rm web npm run backup && AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... aws s3 sync ./backups s3://<backup_bucket>/ --only-show-errors
```
Practise `npm run restore` against a scratch database before you need it. A backup that has never been restored is a hope, not a backup.

## What this does not give you
- No load balancer, no second instance, no automatic fail-over. One instance with auto-recovery on a system fault is a sensible start for a pilot; the status page targets are objectives, not guarantees.
- No managed database: PostgreSQL stays on Neon/Supabase as before. Moving to RDS would cost more than a credit-funded runway allows.
- No claim of data residency in the UAE unless you choose the UAE region and the database region to match.
