# Deployment: Oracle Cloud + Cloudflare + Neon/Supabase + Upstash + Stripe/Razorpay

What runs where:

```
 browser ──► Cloudflare (DNS, TLS, WAF, rate rules, optional Access on /admin)
                 │  Cloudflare Tunnel (outbound-only: no inbound ports on the VM)
                 ▼
          Oracle Cloud VM ── docker compose ── web  (this app, port 3000, in-process workers)
                 │                          └─ cloudflared
                 ├──► Neon or Supabase  (PostgreSQL only; TLS verified)
                 ├──► Upstash Redis     (shared rate limits; optional)
                 ├──► Stripe / Razorpay (checkout sessions out, signed webhooks in)
                 └──  /app/data/files   (uploaded documents: a Docker volume on the VM's disk)
```

Everything below is configuration. Nothing in the code needs editing, and **no credential is stored in the repository** — you
put your legal and payment details in `.env` on the server (see `.env.example`, every variable is documented there).

> **What has and has not been tested.** The payment adapters, webhook handling, configuration validation, TLS option mapping and
> rate limiter are covered by automated tests against simulated provider responses and signatures. They have **not** been run against
> live Stripe, Razorpay, Neon, Supabase, Upstash or Cloudflare accounts (this repository has no access to them). Follow the smoke
> test at the end in *test mode* before switching to live keys.

## 1. Database — Neon (recommended) or Supabase

Only the PostgreSQL database is used. The application manages its own sign-in, so Supabase Auth/Storage/Realtime are not used.

**Neon**: create a project in the region closest to the VM.
Create a *staging branch* first and run the migrations there. Copy two connection strings:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **pooled** string (`…-pooler….neon.tech`), with `?sslmode=require` |
| `MIGRATION_DATABASE_URL` | the **direct** string (no `-pooler`) |
| `DATABASE_SSL` | `require` |

**Supabase**: Project settings → Database → connection strings. `DATABASE_URL` = the *transaction pooler* (port 6543),
`MIGRATION_DATABASE_URL` = the direct connection (port 5432), `DATABASE_SSL=require`.

Notes that matter:

- The first migration creates a login-less role `lbt_app` and grants it to the connecting role. The role you connect as therefore
  needs `CREATEROLE` (Neon's default owner and Supabase's `postgres` have it). The app then runs every tenant query as `lbt_app`
  with row-level security — that isolation is the point, so do not point `DATABASE_URL` at a superuser-bypass setup.
- Migrations run at start-up under an advisory lock, on `MIGRATION_DATABASE_URL` when set. Do not run them through a transaction pooler.
- Neon free tier suspends idle compute; the first request after a pause is slow, and the app tolerates dropped idle connections.
  Use a paid plan (or disable auto-suspend) for production; also for point-in-time restore.
- Keep `DATABASE_POOL_MAX` at or below your plan's connection limit divided by the number of app instances.

## 2. Oracle Cloud VM

1. Create a VM (Ubuntu 22.04). **Ampere A1 (ARM64) Always Free** is fine — the image is `node:22-alpine`, which is multi-arch.
   Pick the region closest to your customers (Dubai/Abu Dhabi if available).
2. Security list: you do **not** need inbound 80/443 when you use the tunnel; leave only SSH (restrict it to your IP).
3. Install Docker (`curl -fsSL https://get.docker.com | sh`), clone the repo to `/opt/loadbyton`, then:
   ```bash
   cp .env.example .env && chmod 600 .env        # fill it in — see §6
   docker compose -f docker-compose.prod.yml up -d --build
   docker compose -f docker-compose.prod.yml logs -f web      # "listening on :3000 (production)"
   ```
4. The app **refuses to start** in production if a payment provider is half-configured, a test key is used, the base URL is not https,
   or `DATABASE_SSL=no-verify` is set. The error names the variable.
5. Backups: schedule `scripts/backup.sh` (see the header of that file) and copy off the VM. Do a restore drill (`docs/RUNBOOKS.md`).

## 3. Cloudflare

1. Add your domain; set **SSL/TLS → Full (strict)** and **Always use HTTPS**.
2. Zero Trust → Networks → **Tunnels** → create a tunnel, copy its token into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Add public hostnames
   `www`, `app`, `admin`, `help` and the wildcard `*` for your domain, each → `http://web:3000`. (Universal SSL covers one wildcard level,
   which is what `company.yourdomain` needs. Customers' *own* domains need Cloudflare for SaaS and are not set up by this guide.)
3. In `.env`: `PUBLIC_BASE_URL=https://www.yourdomain`, `ROOT_DOMAIN=yourdomain`, **`TRUST_PROXY=cloudflare`** (so sign-in throttling uses the real client
   address from `CF-Connecting-IP`; only valid because every request arrives through Cloudflare).
4. Recommended rules:
   - **Zero Trust Access** policy on `admin.yourdomain` (the control console) in front of the app's own TOTP login.
   - **WAF/Rate limit** on `POST /login` (e.g. 10 per minute per IP) in addition to the app's own limit.
   - **Skip** bot challenges and WAF managed rules for `/webhooks/payments/*` — Stripe and Razorpay are not browsers and a bot challenge makes
     them look like failed deliveries.
   - Cache: bypass for everything except `/assets/*` and `/brand/*`.

## 4. Upstash Redis (optional, recommended once you run more than one instance)

Create a Redis database (region near the VM), copy the **REST** URL and token into `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
It backs the sign-in / MFA throttle and the public tracking page limiter. If Upstash is unreachable the app logs it and falls back to a
per-process counter — sign-in keeps working, with weaker (per-instance) limits. Set both variables or neither.

## 5. Payments

Set `PAYMENT_PROVIDERS=stripe,razorpay` (either one alone is fine; the first is the default). Customers see one button per enabled method on
**Plan & billing**. Access is granted **only** by the signed webhook — never by the browser returning from the provider.

### Stripe (cards, Google Pay, Apple Pay)
1. Dashboard → Settings → Payment methods: enable *Cards* and *Google Pay* (and Apple Pay / Link if wanted). The app uses Stripe Checkout with
   dynamic payment methods, so wallets appear on supported devices automatically.
2. Developers → Webhooks → *Add endpoint* `https://www.yourdomain/webhooks/payments/stripe` with the events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
3. `STRIPE_SECRET_KEY` (`sk_…` or a restricted `rk_…` key with *Checkout Sessions: write*) and `STRIPE_WEBHOOK_SECRET` (`whsec_…`).
4. Orders are priced in AED (the plan currency). **Confirm with Stripe that your account type and country can present and settle in AED** and
   that your business model (software subscriptions sold from India to UAE customers) is permitted on your account — Stripe availability and
   settlement rules for Indian businesses differ from other countries and only Stripe can confirm them for your account.

### Razorpay (UPI incl. Google Pay, cards, netbanking)
1. Dashboard → Settings → API keys → generate; `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.
2. Webhooks → add `https://www.yourdomain/webhooks/payments/razorpay`, choose a secret (`RAZORPAY_WEBHOOK_SECRET`), and enable
   `payment_link.paid`, `payment_link.cancelled`, `payment_link.expired`, `refund.processed`.
3. The app creates hosted **Payment Links** (no browser script is loaded, so the strict Content-Security-Policy stays intact).
   Orders are in AED: your Razorpay account needs **International Payments** enabled and AED among its currencies. If it is INR-only, only Razorpay can change that;
   until then use Stripe, or price in a currency your account supports.

### Tax, GST and your legal identity
All of it is environment configuration, shown at checkout, on printable receipts (**Plan & billing → Receipt**) and in the site footer:
`SELLER_LEGAL_NAME`, `SELLER_TRADE_NAME`, `SELLER_ADDRESS`, `SELLER_GSTIN`, `SELLER_PAN`, `SELLER_SUPPORT_EMAIL`, and optionally `SELLER_SAC`,
`SELLER_SUPPLY_NOTE` (e.g. place of supply) and `SELLER_LUT_NOTE` (LUT/export declaration reference).
`CHECKOUT_VAT_BPS` is the percentage added at checkout in basis points (`0` for none) and `CHECKOUT_TAX_NOTE` replaces the default sentence.
The software does not decide your tax treatment: whether your supplies are zero-rated exports, subject to UAE VAT, or reverse-charged by the
customer is a question for your accountant, and the receipt says so. The receipt is a convenient record, not a certified GST e-invoice.

## 6. First deployment checklist

1. `.env` filled in: `SESSION_SECRET` (`openssl rand -hex 32`), `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DATABASE_SSL=require`, `PUBLIC_BASE_URL`, `ROOT_DOMAIN`, `TRUST_PROXY`, payment keys, seller identity.
2. `docker compose -f docker-compose.prod.yml up -d --build` → `https://www.yourdomain/healthz` returns `{"ok":true}`.
3. Create the first platform staff account (it prints a TOTP secret to enrol in an authenticator app):
   `docker compose -f docker-compose.prod.yml exec web npm run create-staff -- you@yourdomain "Your Name" '<12+ char password>' commercial_admin`
4. **Smoke test in test mode first.** Production refuses test keys unless you set `ALLOW_TEST_PAYMENT_KEYS=true` — set it together with your
   `sk_test_…` / `rzp_test_…` keys for the rehearsal, then remove it. Sign up a workspace → Plan & billing → pay with Stripe test card `4242 4242 4242 4242` → confirm the order flips to *paid* and the
   plan activates → in the Stripe dashboard, *Resend* the same webhook and confirm the app answers `duplicate` and nothing changes → refund the payment and
   confirm the order becomes *refunded*. Repeat with a Razorpay test payment link.
5. Replace the test keys with live keys, delete `ALLOW_TEST_PAYMENT_KEYS`, redeploy. In the Stripe/Razorpay dashboards confirm webhook deliveries show `200`.
6. Check the control console (`admin.yourdomain`) → *Queues & reviews*: any payment that could not be applied (amount mismatch, unknown order) lands there for a human.

## 7. Email (Resend)

`MAIL_PROVIDER=resend`, `RESEND_API_KEY=re_…`, `MAIL_FROM="LOAD|BY|TON <noreply@yourdomain.com>"` — verify the domain in Resend first (add its DKIM/SPF DNS records in Cloudflare, *DNS only*).
Sent: team invitations (with the one-time link, which is **removed from the database once delivered**), payment received, workspace ready. A rejected message (unverified domain, bad
address) goes straight to the dead queue and shows on `lbt_outbox_rows{status="dead"}`; a provider outage is retried with back-off. Until configured the app prints one line per email (never the body).

## 8. Document storage (Oracle Object Storage / Cloudflare R2)

`STORAGE_DRIVER=s3`. **Oracle:** Identity → your user → Customer secret keys (this is the S3 access key/secret); endpoint `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`,
`S3_REGION=<region>` (e.g. `me-dubai-1`), `S3_PATH_STYLE=true`. **Cloudflare R2:** R2 → API tokens (Object Read & Write on one bucket); endpoint `https://<account>.r2.cloudflarestorage.com`, `S3_REGION=auto`.
The bucket must be private. Objects are stored as `<tenantId>/<uuid>`; downloads still go through the app (session + tenant + signed link checks), never a public URL.
Moving existing files from the VM disk to the bucket is a one-off copy of `data/files/<tenantId>/<uuid>` to the same keys (e.g. `rclone copy`), done **before** switching the driver.

## 9. SMS to consignees (optional)

`SMS_PROVIDER=twilio` + `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. Texts go only to UAE mobile numbers, only for merchants who were switched on under *Delivery → Integrations*,
and only for “out for delivery” and “could not deliver” (the delivery code is included only for parcels that require it). The phone number, text and link are removed from the database after sending.
Sender-ID registration and consent for marketing/transactional SMS in the UAE are your responsibility with your SMS provider.

## 9a. UAE e-invoicing provider (optional)

Set `EINVOICE_ASP_NAME` (a short label such as `acme-asp`), `EINVOICE_ASP_BASE_URL` (https) and `EINVOICE_ASP_API_KEY` from your accredited service provider, then adjust the
`EINVOICE_ASP_*` paths, body format and status vocabulary to that provider's API (every variable is documented in `.env.example`). Submissions send the generated UBL with an idempotency
key; the provider's answer decides the state, and any answer the mapping does not recognise is recorded as *submitted*, never *accepted*. Choose the provider under *E-invoicing readiness → Settings* (mode *live*).
**Still yours:** accreditation with the provider, the provider's customization/profile identifiers, validation of the payloads against the official specification, and acceptance of real documents. Until the provider has accepted a document it is not a tax invoice issued through the national system. Mirsal (customs) has no adapter: it needs authorised access and an integration scope from the authority.

## 9a-2. E-invoicing as a paid add-on (per-client provider accounts)

A workspace asks for e-invoicing under *E-invoicing readiness* (package choice) and shows as **Onboarding** at `/admin/einvoice`. After the client has paid, platform staff attach the client's
provider account there: provider (installed adapters: **Wafeq**, **Aigentrix**), the provider **organisation API key** (`pk_test_…` reaches the provider's Sandbox, `pk_live_…` Live), the client's **taxpayer ID**
(Wafeq `txpay_…`, which exists only after the client has completed the provider's onboarding and granted your app consent), and the document allowance. Credentials are encrypted at rest with
`ENCRYPTION_SECRET` (covered by `npm run rotate-encryption-key`), are write-only from the admin screen, and are never shown again. Sandbox testing works while Onboarding; **Live sending needs Active**,
which records a payment reference. A Live document spends one unit of the allowance; Sandbox never does. Suspending stops sending without deleting anything.

Provider outages never lose a document: it stays *generated*, is retried by the `einvoice` worker after 2, 10, 30, 120 and 360 minutes, then marked *error* for a person. Refused credentials, a missing
subscription or a validation answer are not retried. Duplicate sending is prevented by the document lock, a stable idempotency key sent to the provider, and unique indexes on live documents and provider references.

Wafeq webhooks: in the Wafeq portal (Developer → Webhooks) add `https://<your-host>/webhooks/einvoice/wafeq`, subscribe to `document.sent`, `document.status`, `document.reported`, `document.received`
and the `taxpayer.*` events, and set the signing secret as `EINVOICE_WAFEQ_WEBHOOK_SECRET` (Standard Webhooks `whsec_…`; comma-separate two while rotating). Delivery state, FTA reporting state and supplier invoices
received for a client arrive this way; losing a client's consent (`taxpayer.deleted`) suspends their service.
**Aigentrix (TronStride).** One organisation API key (Settings → API Keys) serves every client; each client is a *company* in your Aigentrix organisation, and its numeric **company ID** goes in the taxpayer field.
Sending is two calls (create the draft, then submit it); a retry after a lost response finds and adopts the entry already sent instead of creating another. Before attaching a client:
1. Add the company in Aigentrix, switch on *Enable E-Invoice* and set its **default environment** to the one you will enter here. Aigentrix cannot be told the environment per request and does not report it, so the two must match. Events carry the real environment, and a mismatch suspends the service.
2. Create a webhook subscription for the company (`POST /webhookSubscriptions`, url `https://<your-host>/webhooks/einvoice/aigentrix`, events `*`), save the **signing secret** it returns once, and enter it in the admin form. Then call the subscription's `/verify` (the handshake is answered automatically) and `/test`.
Aigentrix secrets are per subscription, so they live encrypted with the client's credentials rather than in the environment. Credit notes need an FTA reason code: write one of `DL8.61.1.A–E` or `VD` in the credit note's reason, or use plain wording
(returned, cancelled, error, price change); otherwise the document is rejected before anything is sent. Webhooks are the normal path; a poller asks about documents still waiting after two minutes as a fallback.
**Still yours:** the commercial agreement with the provider (resale and branding terms), each client's provider onboarding (Wafeq also needs the client's OAuth consent), confirming each provider's status vocabulary in its Sandbox before Live, and the
package prices (none are set in software). Adapters not written: Marmin. Each is one file implementing `EInvoiceAdapter` plus an entry in `SERVICE_PROVIDERS`.

## 9b. WhatsApp delivery notices (optional)

`WHATSAPP_PROVIDER=cloud` with `WHATSAPP_ACCESS_TOKEN` (a permanent system-user token), `WHATSAPP_PHONE_NUMBER_ID`, and the names of two templates Meta has approved
(`WHATSAPP_TEMPLATE_OUT_FOR_DELIVERY`, `WHATSAPP_TEMPLATE_ATTEMPT_FAILED`; variable order is in `.env.example`). Notices go to UAE mobiles only, for merchants switched on under *Delivery → Integrations*, and
the number, delivery code and link are erased once sent. Inbound WhatsApp and telephony channels (signed webhooks) already exist; replies to customers remain recorded by a person.
**Still yours:** Meta business verification, the number, template approval, and your consent policy. Telephony needs only the Twilio account and numbers (the inbound webhook is built).

## 9c. Live statement feeds (optional)

List the provider hosts in `FEED_ALLOWED_HOSTS`; each workspace then adds its own feed (bank or card settlement, fuel card, Salik) under *Money → Statement feeds* with its own credential, sealed in the database.
A feed is a JSON API returning a list of transactions; the field names are mapped in the form. Pulls run about every `FEED_PULL_INTERVAL_MINUTES` and go through the same importers as CSV uploads: bank lines wait for matching, fuel and Salik lines
still need receipt-evidence approval, and each provider transaction id is remembered so overlapping pulls add nothing twice. The host list is re-checked on every pull. Provider-specific APIs (for example a particular open-banking scheme with its own consent flow) may need a small adapter beyond this generic JSON pull.

## 9d. OCR for scanned documents (optional)

`OCR_PROVIDER=google-vision` with `OCR_API_KEY` and `OCR_DATA_PROCESSING_REVIEWED=true` (document content is sent to Google). Scanned PDFs and photographed documents that have no text layer are read by OCR and then go through the same
field extraction and validation as any other document; the result is labelled as OCR and is a proposal a person must accept.

## 9e. Ledger and foreign-currency invoicing

No configuration. The owner enables the general ledger under *Money → General ledger* (start date fixed once enabled; earlier balances enter as an opening-balance manual entry). A customer is billed in a foreign currency by setting
its *billing currency* on the customer details page; invoices then need a current approved exchange rate (no older than seven days) and are issued in both currencies with VAT also stated in AED. The books and receipts stay in AED.

## 9f. Optional services added later

- **Address geocoding** — `GEOCODER_URL` (any Nominatim-shaped `/search`), `GEOCODER_API_KEY`, `GEOCODER_COUNTRY_CODES`. The public OpenStreetMap server forbids bulk use: run your own or use a commercial gateway.
- **Road routing** — `ROUTING_URL` (OSRM-compatible `/table/v1`), `ROUTING_API_KEY`, `ROUTING_PROFILE`, `ROUTING_MAX_POINTS`. Times are the service's own; the planner states whether it used road or straight-line distances.
- **Self-hosted OCR** — `OCR_PROVIDER=self-hosted`, `OCR_API_BASE=http://ocr:8080`, and start the sidecar with `docker compose -f docker-compose.prod.yml --profile ocr up -d`. Untested against real scans in this repository: run a sample of your own documents through it and have a person check the text.
- **Store and carrier connectors** — set up under *Fulfilment → Store connectors* (Shopify, WooCommerce) and *Carrier tracking*; each gives a secret webhook address once.
- **Label printing** — *Warehouse → Label printing*: create an agent, add each printer's LAN address, then run `PRINT_SERVER=https://your-host PRINT_TOKEN=lbtp_… node scripts/print-agent.mjs` on a PC on the warehouse network (it only makes outbound HTTPS calls). Jobs are retried three times, then marked failed for a person. Tested against a local socket, not a physical printer.
- **Account-holder consent for bank feeds** — add the bank's consent and token hosts to `FEED_ALLOWED_HOSTS`, register `PUBLIC_BASE_URL/app/settings/feeds/callback` as the redirect address in the bank's developer portal, then *Connect account* on the feed.

## 10. Monitoring

See [`MONITORING.md`](MONITORING.md): `/healthz` (liveness), `/readyz` (database + background workers), `/metrics` (Prometheus text, bearer `METRICS_TOKEN`), recommended alerts.

## 11. Known limits of this setup (pilot)

- **Several web instances are supported.** Each background job (provisioning, outbox, storage, subscriptions, ledger, feeds, e-invoicing, privacy) runs under a short database lease (`worker_leases`), so it runs on one instance at a time and moves to another within about 30 seconds if its holder dies. `RUN_WORKERS=false` still keeps workers off an instance. Share the rate limiter (Upstash) and object storage (`s3`) when you run more than one.
- With `STORAGE_DRIVER=fs`, uploaded documents live on the VM's Docker volume: back it up (`scripts/backup.sh`). Use `s3` to move them off the VM.
- **Alerting is yours to wire**: the app exposes health and metrics; something outside it must watch them and page a person (see MONITORING.md). Until that is running, sectors stay *Pilot*.
- Merchant webhooks and the merchant API are in place, but a merchant's own endpoint reliability is outside our control: failed deliveries are retried 12 times with growing back-off (about three hours in total) and then wait in the dead queue.
