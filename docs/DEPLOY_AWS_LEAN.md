# Lean deployment: only the backend on AWS

AWS runs **one EC2 instance** (app, worker, malware scanner, tunnel). Everything else is outside AWS:

| Need | Service |
|---|---|
| Database | Supabase (PostgreSQL) |
| Uploaded files + backups | Cloudflare R2 |
| Domain, TLS, WAF, tunnel | Cloudflare |
| Shared rate limits | Upstash Redis |
| Error reporting | Sentry |
| Transactional mail | Resend (`MAIL_PROVIDER=resend`) or SES SMTP (cents per month) |

AWS cost is about US$30 a month (`t4g.medium` 24 + disk 2.5 + public IPv4 3.7), so US$100 lasts about three months. The Terraform here creates no S3 bucket and no second account (`create_files_bucket = false`). The Terraform has not been applied by anyone: read `terraform plan` first.

`t4g.medium` is the floor while production upload scanning (ClamAV) is required. Do not drop to `t4g.small` unless you accept the scanner running in swap or turn it off deliberately.

## 1. Accounts (all have free tiers)
1. **Cloudflare:** add your domain; change nameservers at the registrar; wait for *Active*.
2. **Supabase:** create a project in the region nearest to the server. Settings → Database: copy the *Transaction pooler* string (port 6543, `DATABASE_URL`) and the *Direct connection* string (port 5432, `MIGRATION_DATABASE_URL`).
3. **R2:** Cloudflare → R2 → create two **private** buckets, `loadbyton-files` and `loadbyton-backups`. R2 → Manage API tokens → create an *Object Read & Write* token limited to those buckets. Copy the access key ID, secret and account ID.
4. **Upstash:** create a Redis database; copy the REST URL and token.
5. **Sentry:** create a Node project; copy the DSN.

## 2. AWS account
Root MFA on, an admin user for daily work, a budget email under Billing, then locally `aws configure` and install Terraform.

## 3. Create the server
```bash
cd infra/aws
cp terraform.tfvars.example terraform.tfvars     # set alert_email
terraform init && terraform plan && terraform apply
```
Confirm the SNS email. Connect (no SSH, no open ports):
`aws ssm start-session --target <instance_id> --region ap-south-1`

## 4. Bring the app up
```bash
sudo -i
cd /opt/loadbyton && git clone https://github.com/loadbyton-byte/Loadbyton-OS.git .
cp .env.example .env.production && chmod 600 .env.production && nano .env.production
```
Set at least:
```
NODE_ENV=production
DATABASE_URL=...6543...   MIGRATION_DATABASE_URL=...5432...   DATABASE_SSL=require
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto   S3_PATH_STYLE=true   S3_BUCKET=loadbyton-files
S3_ACCESS_KEY_ID=...   S3_SECRET_ACCESS_KEY=...
UPSTASH_REDIS_REST_URL=...   UPSTASH_REDIS_REST_TOKEN=...
SENTRY_DSN=...   SENTRY_RELEASE=<git sha>
TRUST_PROXY=cloudflare
CLAMAV_HOST=scanner
CLOUDFLARE_TUNNEL_TOKEN=...      # step 5
```
plus every secret `.env.example` marks (generate each with `openssl rand -hex 32`) and the mail settings.
```bash
docker compose -f ops/production/compose.yml --env-file .env.production up -d --build
docker compose -f ops/production/compose.yml --env-file .env.production run --rm web npm run preflight
```

## 5. Connect the domain (Cloudflare Tunnel)
1. Zero Trust → Networks → Tunnels → *Create a tunnel* (Cloudflared). Copy the token into `.env.production`, then re-run `up -d`.
2. Public hostnames → add `yourdomain.com`, `www`, `app`, `admin`, `help` and `*`, each as service `HTTP` → `web:3000`. Cloudflare creates the DNS records.
3. SSL/TLS mode **Full**; enable *Always Use HTTPS*.
4. Open `https://yourdomain.com`; create the first staff user with `npm run create-staff` inside the container.

## 6. Nightly backups to R2
`npm run backup` writes encrypted archives to `BACKUP_OUTPUT_DIR`. Copy them to R2 with the AWS CLI (already installed):
```bash
# /etc/cron.d/loadbyton-backup
30 2 * * * root cd /opt/loadbyton && docker compose -f ops/production/compose.yml --env-file .env.production run --rm web npm run backup && AWS_ACCESS_KEY_ID=<r2 key> AWS_SECRET_ACCESS_KEY=<r2 secret> AWS_DEFAULT_REGION=auto aws s3 sync ./backups s3://loadbyton-backups --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com --only-show-errors
```
Use a separate R2 token for backups, scoped to the backups bucket only. Rehearse `npm run restore` on a scratch database before you rely on it.

## Keeping credit use low
- Stop nothing: the instance is the only meaningful cost. Delete unused Elastic IPs/volumes if you experiment.
- Watch Billing → Cost Explorer weekly; the budget alert in Terraform counts spend with credits excluded.

## Automatic deploys (GitHub Actions)
Every push to `main` runs the tests, then `.github/workflows/deploy.yml` tells the instance (through SSM, no SSH) to run `infra/aws/deploy.sh <sha>`: it checks out that commit, rebuilds, waits for web and worker health, and **rolls back** to the previous commit if the new one is unhealthy. AWS access uses GitHub OIDC, so no AWS keys are stored in GitHub.

One-time setup:
1. `terraform.tfvars`: keep `github_repo = "loadbyton-byte/Loadbyton-OS"` (set `create_github_oidc_provider = false` if the account already has a GitHub provider), then `terraform apply`. Note the `github_deploy_role_arn` output.
2. GitHub → Settings → Environments → create **production** (add yourself as a required reviewer if you want approval before each deploy).
3. GitHub → Settings → Secrets and variables → Actions → **Variables**: `AWS_REGION` (`ap-south-1`), `AWS_DEPLOY_ROLE_ARN` (the output), `AWS_INSTANCE_ID` (the `instance_id` output).
4. The instance must have been brought up once by hand (step 4 above) so `/opt/loadbyton` and `.env.production` exist. Run a first deploy from Actions → deploy → *Run workflow*.

The role may only assume from the `production` environment of this repository and may only run commands on this one instance. Secrets stay in `.env.production` on the server and never pass through GitHub.
