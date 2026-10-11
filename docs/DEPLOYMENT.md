# Oracle / Cloudflare / Neon / Supabase / Upstash deployment

The repository contains deployment code, not a live deployment. Credentials are supplied in environment settings at deployment. The uploaded PDF is the requirement source (`MASTER_BLUEPRINT_SOURCE.txt`); the user's hosting and Indian-freelancer merchant choices take precedence over its undecided examples.

## Responsibilities and credentials

| Service | Responsibility | Configuration |
|---|---|---|
| Oracle Cloud | Ubuntu ARM VM, web, worker, malware scanner | Terraform `infra/oracle`; region/compartment/availability domain/SSH public key/restricted operator CIDR |
| Cloudflare | Public edge, wildcard DNS, HTTPS and tunnel | API token, zone, origin hostname, tunnel token, root domain |
| Neon | Application PostgreSQL | TLS-verified pooled runtime URL, direct migration/backup URL |
| Supabase | Private document objects | URL, server-only service role, private bucket |
| Upstash Redis | Shared sign-in/API limits | HTTPS REST URL/token |
| Stripe / Razorpay | Hosted payment authorization | Secret API credentials and each provider's webhook secret |
| SMTP (Oracle Email Delivery is an option) | Invitations/receipts/reviewed replies | SMTP URL, approved sender, verified email domain |

Use `ops/production/.env.production.example` as the setting inventory. Keep the actual `.env.production` private (0600) and excluded from Git. `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `METRICS_TOKEN` and `BACKUP_ENCRYPTION_KEY` must be independent strong secrets. Preserve the encryption/backup keys in an access-controlled recovery vault. GST/legal documents do not need to be uploaded into source control: configure the merchant's legal name, country `IN`, address, tax identifier and support contact in environment settings.

The correct Indian export-of-services/GST treatment and any UAE tax obligations are merchant-specific. Configure reviewed `CHECKOUT_VAT_BPS`, `CHECKOUT_TAX_LABEL`, `CHECKOUT_TAX_NOTE`; do not infer UAE VAT registration from Indian GST documents. Set `LEGAL_REVIEWED=true`, an approved retention period and the actual deployment region only after reviewing the published legal copy and subprocessors.

## Provision the host

1. Review `infra/oracle/terraform.tfvars.example`, including capacity and availability in your selected region. Supply OCI authentication through the provider's secure credential mechanism; it is not embedded in Terraform. Keep state encrypted and access-controlled.
2. Run `terraform init`, `terraform plan`, review the concrete resources/cost, then apply through your release process. Only restricted SSH ingress is configured. Application traffic reaches Oracle through Cloudflare Tunnel; do not expose PostgreSQL, Redis or the scanner publicly.
3. The cloud-init template installs Docker, Compose, PostgreSQL client tools and security updates. Copy the reviewed release checkout to the host. Build web and scanner images on the target architecture; the scanner uses Debian's native ARM/x86 packages because the official ClamAV stable image inspected during development exposed x86 only. Do not copy an x86-built application image onto an ARM host.
4. Pin the tested application/scanner/tunnel/monitoring image digests in deployment configuration. The template's `local`/`latest` defaults are for preparation, not reproducible release evidence.

## Configure managed services

Create Neon runtime and migration connections with `sslmode=verify-full`. Keep migration/admin credentials separate from the runtime role where the chosen Neon setup permits it. PostgreSQL migrations establish `lbt_app`; the operating plane executes under that restricted role and RLS. Run schema changes once using the direct endpoint, before rolling out code; runtime `MIGRATE_ON_START=false` verifies all migration names are present.

Create a **private** Supabase bucket with no anonymous/list/read policies. The service-role key stays server-side. No public object URL is used; downloads recheck authenticated membership, record authorization, object prefix and SHA-256. Configure object backups/retention with the provider. Redis should use the region selected in the subprocessor schedule; limits fail closed when Redis is unavailable.

Create a Cloudflare Tunnel with public hostnames `app`, `www`, `<tenant>` and other configured surfaces routing to `http://web:3000`. Configure proxied wildcard CNAME `*.ROOT_DOMAIN` to the configured tunnel origin and matching ingress rules/certificates. Provisioning verifies the wildcard record and HTTPS health before activation. Standard tenant subdomains still require authenticated membership.

Custom domains require the customer's unique TXT ownership token **and** active Cloudflare for SaaS custom-hostname routing/certificate plus HTTPS health. Provision the custom hostname in Cloudflare through the operator workflow first; domain verification will fail safely if the account has no SaaS access. Removing a domain removes application authorization immediately; clean up its Cloudflare hostname/certificate in the operator workflow. A reassignment requires a fresh ownership challenge.

The scanner must download signatures and pass its health check before web startup. It remains on a private scanner network. Failed or unavailable malware scanning rejects uploads. Check signature update connectivity and stale signatures in your operations monitoring.

## Configure payments and launch

Choose `PAYMENT_PROVIDER` and the comma-separated enabled `PAYMENT_PROVIDERS`. Enable each gateway only after that merchant account is authorised for the service, cross-border payments and the charged currency. Never use live keys in local acceptance fixtures.

The catalogue is AED. Razorpay can either present AED if authorised, or an explicit INR merchant quote with `RAZORPAY_PRESENTMENT_CURRENCY=INR`, reviewed `RAZORPAY_AED_TO_INR` and `RAZORPAY_FX_NOTE`. Checkout shows the quote, and the exact charged INR amount/currency/rate/note are immutable on each order. Webhooks compare the payment currency, not the catalogue currency. This is not a market-rate FX feed or an accounting conversion policy. Banks may apply their own charges. Card/Google Pay/UPI availability is controlled by the account, payment-link product, customer/device and currency; the app does not promise every method for every UAE payer.

Configure provider webhooks:

- Stripe: `https://PUBLIC_HOST/webhooks/payments/stripe`; completed/async Checkout payment events, full/partial refunds and disputes. Verify the endpoint secret and raw-body signatures.
- Razorpay: `https://PUBLIC_HOST/webhooks/payments/razorpay`; paid payment links, failed payments, processed refunds and disputes. Preserve `X-Razorpay-Event-Id` and signature headers.

Orders are one-month hosted service purchases. Renewal is explicit rather than an undisclosed auto-debit mandate. Paid renewals extend the existing period; scheduled paid downgrades require a new paid checkout and do not give an unpaid month. Partial refunds/disputes enter staff review. Refund authorization itself is performed in the merchant provider dashboard; the app consumes authenticated outcomes.

From the repository root, with the private env file already populated:

```sh
node --env-file=ops/production/.env.production --import tsx scripts/preflight.ts
node --env-file=ops/production/.env.production --import tsx src/db/migrate-cli.ts
docker compose --env-file ops/production/.env.production -f ops/production/compose.yml build
docker compose --env-file ops/production/.env.production -f ops/production/compose.yml up -d
```

Create platform staff using the reviewed staff-creation command in a secure terminal; enroll TOTP and store the setup secret in the staff vault. Company owner/finance/HR/customs/specialist/pricing/coordinator roles must enroll MFA through Account security in production. Do not share individual logins.

## Recovery and release

Schedule encrypted backups using the **direct** database endpoint and an encrypted, independently replicated backup destination. The script uses a consistent exported PostgreSQL snapshot, database dump, document catalogue, object hashes and all public-table counts. Retain Neon PITR as an additional recovery path, not a substitute for object recovery.

```sh
node --env-file=ops/production/.env.production --import tsx scripts/backup.ts
# Restore only into an explicitly confirmed empty isolated database and a separate private bucket.
RESTORE_CONFIRM_ISOLATED=true RESTORE_DATABASE_URL='<isolated direct URL>' \
RESTORE_SUPABASE_STORAGE_BUCKET='<separate private bucket>' \
node --env-file=ops/production/.env.production --import tsx scripts/restore.ts '<encrypted backup path>'
```

The restore authenticates the encrypted archive before extraction and checks objects, every recorded table count, business invariants and all tenant-scoped RLS tables. A local PostgreSQL restore drill is development evidence; repeat on Neon/Supabase in the selected region and measure RPO/RTO. Never run restored workers against live provider credentials during the drill.

Deploy the monitoring overlay and validate real scrapes/alert delivery using `ops/monitoring/README.md`. Complete `RELEASE_ACCEPTANCE.md` with dated evidence before advertising availability. Roll back the application to its tested prior digest only when compatible with the applied schema; restore into isolation and cut over through the reviewed recovery procedure for incompatible data/schema failures.

## Optional assistant provider

Deterministic source-linked drafts are available with `AI_PROVIDER=none`. Optional `AI_PROVIDER=openai` requires `OPENAI_API_KEY`, `AI_MODEL`, `AI_DATA_PROCESSING_REVIEWED=true`, reviewed `AI_INPUT_MICRO_USD_PER_TOKEN`/`AI_OUTPUT_MICRO_USD_PER_TOKEN`, `AI_PRICING_NOTE` and a positive bounded `AI_MONTHLY_BUDGET_MICRO_USD`. Rates are micro-USD per token; the budget is per company/month. These are configurable vendor assumptions, not a claim about current public pricing. Set and review processor/region/retention terms before enabling external requests. Fixed retrieval excludes arbitrary document/contact/free text, and output remains a human-reviewed draft. Validate real provider usage, timeout/fallback, quotas and cost accounting in staging before release.

## Encryption-key maintenance

`MFA_ENCRYPTION_PREVIOUS_KEY` is optional outside the rehearsed rotation window. Use `npm run rotate-encryption-key` for an authentication-only dry run and `npm run rotate-encryption-key -- --apply` for the atomic MFA/accounting/invitation migration. Apply all schema migrations first and follow the web/worker pause or dual-reader rollout sequence in `RUNBOOKS.md`. Never remove historical-backup decryption keys solely because live rows have been rotated. This command does not rotate session secrets, payment signatures or backup encryption.
