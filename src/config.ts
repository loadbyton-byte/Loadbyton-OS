import crypto from "node:crypto";
import path from "node:path";

const env = process.env;
const isProd = env.NODE_ENV === "production";

function secret(name: string, dev: string): string {
  const v = env[name];
  if (v && v.length >= 32) return v;
  if (isProd) throw new Error(`${name} must be set (min 32 chars) in production`);
  return dev;
}
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const text = (name: string) => (env[name] ?? "").trim();
const flag = (name: string) => ["1", "true", "yes"].includes(text(name).toLowerCase());

const paymentProviders = list(env.PAYMENT_PROVIDERS ?? env.PAYMENT_PROVIDER ?? "mock");
const KNOWN_PROVIDERS = ["mock", "stripe", "razorpay"];

/** Brochure mode (default on): the public site is a brochure with a demo, `/start` registers a free or paid build request, and `/app` is a
 * request tracker. The client runs the delivered system on their own backend, so no usage dashboard, metering or billing is exposed.
 * BROCHURE_MODE=false restores the full multi-tenant operating platform. */
const brochureMode = env.BROCHURE_MODE === undefined ? true : flag("BROCHURE_MODE");

/** Link with loadbyton.com: signed entitlement events in, "Continue with Loadbyton" sign-in out. Everything stays off until configured. */
const ecosystem = {
  sharedSecret: text("ECOSYSTEM_SHARED_SECRET"),
  comBaseUrl: text("COM_BASE_URL").replace(/\/$/, ""),
  oidcClientId: text("OIDC_CLIENT_ID"),
  oidcClientSecret: text("OIDC_CLIENT_SECRET"),
  oidcIssuer: (text("OIDC_ISSUER") || (text("COM_BASE_URL") ? `${text("COM_BASE_URL").replace(/\/$/, "")}/api/oidc` : "")).replace(/\/$/, ""),
};

export const config = {
  isProd,
  brochureMode,
  /** Delivery promise for a complete request, in hours from the moment it is submitted. */
  deliveryHours: Math.max(1, Number(env.DELIVERY_HOURS ?? 24)),
  /** Public URL of the live demo environment (the separate seeded demo database). Empty hides the "Open live demo" button. */
  demoUrl: text("DEMO_URL"),
  port: Number(env.PORT ?? 3000),
  baseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:3000",
  rootDomain: (env.ROOT_DOMAIN ?? "").toLowerCase(),
  ecosystem,
  /** "all" = the operator declares every sector pack live (decision of 18 Oct 2026). Independent acceptance records are still kept and shown in the readiness register; this changes what the public site calls a sector, not what the register says. Default "gated" = a sector is Available only once its own gate is accepted. */
  sectorRelease: (text("SECTOR_RELEASE").toLowerCase() === "all" ? "all" : "gated") as "all" | "gated",

  // ── database (PGlite when empty; Neon / Supabase / any PostgreSQL otherwise)
  databaseUrl: env.DATABASE_URL ?? "",
  /** Direct (non-pooled) URL used only for migrations. Neon/Supabase poolers are fine for the app, but DDL belongs on a direct connection. */
  migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? "",
  /** "" = driver default · "require" = TLS with certificate verification · "no-verify" = TLS without verification (not for production) · "disable" */
  databaseSsl: text("DATABASE_SSL").toLowerCase(),
  databaseCa: text("DATABASE_CA"),
  databasePoolMax: Number(env.DATABASE_POOL_MAX ?? 10),
  migrateOnStart: (env.MIGRATE_ON_START ?? (isProd ? "false" : "true")) === "true",
  pgliteDir: env.PGLITE_DIR ?? path.resolve("data/pg"),

  sessionSecret: secret("SESSION_SECRET", "dev-session-secret-dev-session-secret-0000"),
  /** During a session-secret rotation the previous value still verifies signed tokens/links and unseals stored secrets. */
  previousSessionSecret: env.SESSION_SECRET_PREVIOUS && env.SESSION_SECRET_PREVIOUS.length >= 32 ? env.SESSION_SECRET_PREVIOUS : "",
  /** Encrypts company-user MFA seeds, accounting connection secrets and queued invitation tokens. MFA_ENCRYPTION_PREVIOUS_KEY enables dual-key reads during rotation. */
  encryptionSecret: secret("MFA_ENCRYPTION_KEY", "dev-mfa-encryption-dev-mfa-encryption-0000"),
  previousEncryptionSecret: env.MFA_ENCRYPTION_PREVIOUS_KEY ?? "",
  companyMfaRequired: (env.REQUIRE_COMPANY_MFA ?? (isProd ? "true" : "false")) === "true",
  legalReviewed: env.LEGAL_REVIEWED === "true",
  retentionDays: Number(env.DATA_RETENTION_DAYS ?? 90),
  retentionExplicit: !!env.DATA_RETENTION_DAYS,
  regionExplicit: !!env.DEPLOYMENT_REGION,
  deploymentRegion: env.DEPLOYMENT_REGION ?? "Development environment",
  clamav: { host: env.CLAMAV_HOST ?? "", port: Number(env.CLAMAV_PORT ?? 3310) },
  cloudflare: { token: env.CLOUDFLARE_API_TOKEN ?? "", zoneId: env.CLOUDFLARE_ZONE_ID ?? "", origin: env.CLOUDFLARE_ORIGIN_HOSTNAME ?? "" },
  razorpayPresentment: { currency: env.RAZORPAY_PRESENTMENT_CURRENCY ?? "AED", aedToInr: Number(env.RAZORPAY_AED_TO_INR ?? 0), note: env.RAZORPAY_FX_NOTE ?? "" },
  assistant: { enabled: env.AI_PROVIDER === "openai", key: env.OPENAI_API_KEY ?? "", model: env.AI_MODEL ?? "gpt-4.1-mini", reviewed: env.AI_DATA_PROCESSING_REVIEWED === "true", inputMicroUsd: Number(env.AI_INPUT_MICRO_USD_PER_TOKEN ?? 0), outputMicroUsd: Number(env.AI_OUTPUT_MICRO_USD_PER_TOKEN ?? 0), monthlyBudget: Number(env.AI_MONTHLY_BUDGET_MICRO_USD ?? 0), pricingNote: env.AI_PRICING_NOTE ?? "" },

  /** Signs the simulated-provider webhook (mock only). Real providers use their own signing secrets below. */
  webhookSecret: isProd && !(env.PAYMENT_WEBHOOK_SECRET && env.PAYMENT_WEBHOOK_SECRET.length >= 32)
    ? crypto.randomBytes(32).toString("hex") : secret("PAYMENT_WEBHOOK_SECRET", "dev-webhook-secret-dev-webhook-secret-0000"),

  // ── payments: several providers can be enabled at once; the first is the default at checkout
  /** Rehearse on the production server with TEST keys (smoke test). Turn it off before taking real payments. */
  allowTestPaymentKeys: flag("ALLOW_TEST_PAYMENT_KEYS"),
  paymentProviders,
  paymentProvider: paymentProviders[0] ?? "mock",
  stripe: {
    secretKey: text("STRIPE_SECRET_KEY"), webhookSecret: text("STRIPE_WEBHOOK_SECRET"), webhookSecretPrevious: text("STRIPE_WEBHOOK_SECRET_PREVIOUS"), apiBase: env.STRIPE_API_BASE ?? "https://api.stripe.com",
    /** Optional comma list (e.g. "card"). Empty = Stripe's dynamic payment methods from the dashboard (cards, Google Pay, Apple Pay, Link…). */
    paymentMethods: list(env.STRIPE_PAYMENT_METHODS),
  },
  razorpay: {
    keyId: text("RAZORPAY_KEY_ID"), keySecret: text("RAZORPAY_KEY_SECRET"), webhookSecret: text("RAZORPAY_WEBHOOK_SECRET"), webhookSecretPrevious: text("RAZORPAY_WEBHOOK_SECRET_PREVIOUS"), apiBase: env.RAZORPAY_API_BASE ?? "https://api.razorpay.com",
  },

  // ── transactional email: "log" (default; prints a line, invitations stay visible as links in the UI) or "resend" (Resend REST API)
  mail: {
    provider: (text("MAIL_PROVIDER").toLowerCase() || "log"), resendApiKey: text("RESEND_API_KEY"), from: text("MAIL_FROM"), apiBase: env.RESEND_API_BASE ?? "https://api.resend.com",
    /** "smtp": any SMTP relay, for example Amazon SES (email-smtp.<region>.amazonaws.com, port 587, STARTTLS). */
    smtp: { host: text("SMTP_HOST"), port: Number(env.SMTP_PORT ?? 587), user: text("SMTP_USER"), pass: text("SMTP_PASSWORD"), secure: flag("SMTP_SECURE") },
  },

  // ── SMS to consignees (opt-in per merchant): "log" (default) or "twilio"
  sms: { provider: (text("SMS_PROVIDER").toLowerCase() || "log"), accountSid: text("TWILIO_ACCOUNT_SID"), authToken: text("TWILIO_AUTH_TOKEN"), from: text("TWILIO_FROM"), apiBase: env.TWILIO_API_BASE ?? "https://api.twilio.com" },

  // ── WhatsApp Business (Meta Cloud API) for delivery notices: "log" (default) or "cloud". Notices go out only as templates Meta has approved.
  whatsapp: {
    provider: (text("WHATSAPP_PROVIDER").toLowerCase() || "log"), accessToken: text("WHATSAPP_ACCESS_TOKEN"), phoneNumberId: text("WHATSAPP_PHONE_NUMBER_ID"),
    apiBase: env.WHATSAPP_API_BASE ?? "https://graph.facebook.com", apiVersion: text("WHATSAPP_API_VERSION") || "v21.0",
    templateLanguage: text("WHATSAPP_TEMPLATE_LANGUAGE") || "en", templateOutForDelivery: text("WHATSAPP_TEMPLATE_OUT_FOR_DELIVERY"), templateAttemptFailed: text("WHATSAPP_TEMPLATE_ATTEMPT_FAILED"),
  },

  // ── RF terminal server for handheld guns (cleartext line protocol: private network or VPN only). Off unless RF_PORT is set.
  rf: { port: Number(env.RF_PORT ?? 0), host: env.RF_HOST ?? "127.0.0.1", width: Number(env.RF_WIDTH ?? 24), rows: Number(env.RF_ROWS ?? 8), mode: (env.RF_MODE === "vt100" ? "vt100" : "lines") as "lines" | "vt100" },

  // ── live statement feeds (bank / card settlement / fuel card / Salik). A workspace may only point a feed at a host listed here; its credentials are its own.
  liveFeeds: { allowedHosts: list(env.FEED_ALLOWED_HOSTS), intervalMinutes: Number(env.FEED_PULL_INTERVAL_MINUTES ?? 60) },

  // ── company verification at registration. Required by default in production: a new workspace stays read-only until email, mobile, trade licence and staff review are done.
  kyc: { required: !brochureMode && (env.KYC_REQUIRED === undefined ? isProd : flag("KYC_REQUIRED")), allowFreeMail: flag("KYC_ALLOW_FREE_MAIL"), signupsPerIpPerDay: Number(env.KYC_SIGNUPS_PER_IP_PER_DAY ?? 3), phoneCountry: (text("KYC_PHONE_COUNTRY") || "AE").toUpperCase() },

  // ── address geocoding for transport stops: any service answering the Nominatim /search JSON shape (self-hosted Nominatim, Photon-compatible gateways, commercial proxies). Empty URL = off.
  geocoder: { url: text("GEOCODER_URL"), apiKey: text("GEOCODER_API_KEY"), countryCodes: (text("GEOCODER_COUNTRY_CODES") || "ae").toLowerCase(), userAgent: text("GEOCODER_USER_AGENT") || "LOADBYTON-OS/1.0" },

  // ── road-network routing for trip planning: any OSRM-compatible /table/v1 service (self-hosted OSRM, or a gateway speaking the same API). Empty = straight-line planning. Durations are the service's own (free-flow unless it models traffic).
  routing: { provider: (text("ROUTING_PROVIDER").toLowerCase() || "osrm"), googleBase: (env.ROUTING_GOOGLE_BASE ?? "https://routes.googleapis.com").replace(/\/$/, ""), url: text("ROUTING_URL").replace(/\/$/, ""), apiKey: text("ROUTING_API_KEY"), profile: text("ROUTING_PROFILE") || "driving", maxPoints: Number(env.ROUTING_MAX_POINTS ?? 60) },

  // ── OCR for scanned documents: "none" (default) or "google-vision". Document content is sent to the provider, so its processing must be reviewed first.
  ocr: { provider: (text("OCR_PROVIDER").toLowerCase() || "none"), apiKey: text("OCR_API_KEY"), apiBase: (env.OCR_API_BASE ?? "https://vision.googleapis.com").replace(/\/$/, ""), maxPages: Number(env.OCR_MAX_PAGES ?? 5), reviewed: flag("OCR_DATA_PROCESSING_REVIEWED") },

  // ── tax and seller identity shown at checkout (set from your own registrations; have an accountant confirm the treatment)
  vatBps: Number(env.CHECKOUT_VAT_BPS ?? 500),
  checkoutTaxNote: text("CHECKOUT_TAX_NOTE"),
  seller: {
    // One UAE legal entity operates loadbyton.com and loadbyton.store. trn = UAE Tax Registration Number (VAT), set only once the entity is VAT-registered.
    legalName: text("SELLER_LEGAL_NAME"), tradeName: text("SELLER_TRADE_NAME"), trn: text("SELLER_TRN"),
    tradeLicence: text("SELLER_TRADE_LICENCE"), licenceAuthority: text("SELLER_LICENCE_AUTHORITY"),
    address: text("SELLER_ADDRESS"), email: text("SELLER_SUPPORT_EMAIL"), supplyNote: text("SELLER_SUPPLY_NOTE"),
  },

  // ── public contact points shown across the site, in the assistant and in the live chat. WhatsApp links are built from the same number.
  contact: {
    phone: text("CONTACT_PHONE") || "+919661053007",
    emails: { info: text("CONTACT_EMAIL_INFO") || "info@loadbyton.com", support: text("CONTACT_EMAIL_SUPPORT") || "support@loadbyton.com", contact: text("CONTACT_EMAIL_CONTACT") || "contact@loadbyton.com" },
    /** Staffed hours of the live chat, in this IANA time zone (24 h clock). Outside them visitors are invited to leave a message. */
    chatTz: text("CHAT_TZ") || "Asia/Kolkata", chatFromHour: Number(env.CHAT_FROM_HOUR ?? 9), chatToHour: Number(env.CHAT_TO_HOUR ?? 21),
  },
  /** Site-wide launch offer. Shown only while OFFER_ENDS_ON (YYYY-MM-DD, end of that day UTC+5:30) is in the future; empty = no offer is shown. */
  offer: { code: text("OFFER_CODE"), title: text("OFFER_TITLE"), detail: text("OFFER_DETAIL"), endsOn: text("OFFER_ENDS_ON") },

  // ── shared rate limiting (Upstash Redis REST); in-memory per process when unset
  upstash: { url: text("UPSTASH_REDIS_REST_URL").replace(/\/$/, ""), token: text("UPSTASH_REDIS_REST_TOKEN") },
  /** Error reporting. Empty DSN = off. */
  sentry: { dsn: text("SENTRY_DSN"), environment: text("SENTRY_ENVIRONMENT") || (isProd ? "production" : "development"), release: text("SENTRY_RELEASE"), tracesSampleRate: Math.min(1, Math.max(0, Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0)) },
  /** Which header carries the real client IP: "cloudflare" (CF-Connecting-IP) or "xff" (first X-Forwarded-For hop). Empty = trust nothing. */
  trustProxy: text("TRUST_PROXY").toLowerCase(),
  /** Bearer token for GET /metrics (Prometheus text). Unset = the endpoint does not exist. */
  metricsToken: text("METRICS_TOKEN"),

  // ── UAE e-invoicing: the accredited service provider (ASP) the customer has contracted. Paths and vocabulary are the provider's own.
  einvoiceAsp: {
    name: text("EINVOICE_ASP_NAME").toLowerCase(), baseUrl: text("EINVOICE_ASP_BASE_URL"), apiKey: text("EINVOICE_ASP_API_KEY"),
    authScheme: (text("EINVOICE_ASP_AUTH") || "bearer").toLowerCase(), authHeader: text("EINVOICE_ASP_AUTH_HEADER") || "x-api-key",
    tenantId: text("EINVOICE_ASP_TENANT_ID"), tenantHeader: text("EINVOICE_ASP_TENANT_HEADER") || "x-tenant-id",
    bodyFormat: (text("EINVOICE_ASP_BODY") || "json").toLowerCase(),
    submitPath: text("EINVOICE_ASP_SUBMIT_PATH") || "/documents", statusPath: text("EINVOICE_ASP_STATUS_PATH") || "/documents/{ref}",
    referenceField: text("EINVOICE_ASP_REFERENCE_FIELD") || "id", statusField: text("EINVOICE_ASP_STATUS_FIELD") || "status", reasonsField: text("EINVOICE_ASP_REASONS_FIELD") || "errors",
    acceptedValues: list(env.EINVOICE_ASP_ACCEPTED_VALUES ?? "accepted,delivered,cleared,approved"), rejectedValues: list(env.EINVOICE_ASP_REJECTED_VALUES ?? "rejected,invalid,failed_validation"), errorValues: list(env.EINVOICE_ASP_ERROR_VALUES ?? "error"),
  },

  /** Signing secret(s) for the e-invoicing provider's webhooks (Standard Webhooks, "whsec_…"). Comma-separate two while rotating. Unset = the endpoint refuses everything. */
  einvoiceWebhookSecrets: (env.EINVOICE_WAFEQ_WEBHOOK_SECRET ?? "").split(",").map((x) => x.trim()).filter(Boolean),   // case-sensitive: not run through list()

  storageDir: path.resolve(env.STORAGE_DIR ?? "data/files"),
  /** "fs" (local disk, default) or "s3" (any S3-compatible store: Oracle Object Storage, Cloudflare R2, MinIO, AWS). */
  storage: {
    driver: (text("STORAGE_DRIVER").toLowerCase() || "fs"),
    s3: { endpoint: text("S3_ENDPOINT"), region: text("S3_REGION") || "auto", bucket: text("S3_BUCKET"), accessKeyId: text("S3_ACCESS_KEY_ID"), secretAccessKey: text("S3_SECRET_ACCESS_KEY"),
      pathStyle: (text("S3_PATH_STYLE") || "true") !== "false" },
  },
  runWorkers: (env.RUN_WORKERS ?? "true") === "true",
  maxUploadBytes: 10 * 1024 * 1024,
};

/** Fail fast in production: a half-configured payment provider must stop the process, not fail at the first customer checkout. */
export function validateConfig(c = config, production = isProd) {
  const problems: string[] = [];
  if (!c.paymentProviders.length) problems.push("PAYMENT_PROVIDERS is empty");
  for (const p of c.paymentProviders) {
    if (!KNOWN_PROVIDERS.includes(p)) problems.push(`unknown payment provider “${p}” (known: ${KNOWN_PROVIDERS.join(", ")})`);
    if (p === "mock" && production) problems.push("PAYMENT_PROVIDER=mock is not permitted in production");
    if (p === "stripe") {
      if (!/^sk_(live|test)_|^rk_(live|test)_/.test(c.stripe.secretKey)) problems.push("STRIPE_SECRET_KEY must be a Stripe secret (sk_…) or restricted (rk_…) key");
      if (!c.stripe.webhookSecret.startsWith("whsec_")) problems.push("STRIPE_WEBHOOK_SECRET must be the endpoint signing secret (whsec_…)");
      if (production && !c.allowTestPaymentKeys && c.stripe.secretKey.includes("_test_")) problems.push("STRIPE_SECRET_KEY is a test key but NODE_ENV=production (set ALLOW_TEST_PAYMENT_KEYS=true only for a smoke test)");
    }
    if (p === "razorpay") {
      if (!c.razorpay.keyId.startsWith("rzp_")) problems.push("RAZORPAY_KEY_ID must look like rzp_live_… or rzp_test_…");
      if (!c.razorpay.keySecret) problems.push("RAZORPAY_KEY_SECRET is required");
      if (c.razorpay.webhookSecret.length < 8) problems.push("RAZORPAY_WEBHOOK_SECRET is required (the secret you typed when creating the webhook)");
      if (production && !c.allowTestPaymentKeys && c.razorpay.keyId.startsWith("rzp_test_")) problems.push("RAZORPAY_KEY_ID is a test key but NODE_ENV=production (set ALLOW_TEST_PAYMENT_KEYS=true only for a smoke test)");
    }
  }
  if (c.metricsToken && c.metricsToken.length < 24) problems.push("METRICS_TOKEN must be at least 24 characters (openssl rand -hex 24)");
  if (!["fs", "s3"].includes(c.storage.driver)) problems.push(`STORAGE_DRIVER must be "fs" or "s3" (got "${c.storage.driver}")`);
  if (c.storage.driver === "s3") {
    if (!/^https:\/\//.test(c.storage.s3.endpoint)) problems.push("S3_ENDPOINT must be an https URL");
    for (const [k, v] of [["S3_BUCKET", c.storage.s3.bucket], ["S3_ACCESS_KEY_ID", c.storage.s3.accessKeyId], ["S3_SECRET_ACCESS_KEY", c.storage.s3.secretAccessKey]] as const) if (!v) problems.push(`${k} is required when STORAGE_DRIVER=s3`);
  }
  if (!["log", "twilio"].includes(c.sms.provider)) problems.push(`SMS_PROVIDER must be "log" or "twilio" (got "${c.sms.provider}")`);
  if (c.sms.provider === "twilio") {
    if (!/^AC[0-9a-f]{32}$/i.test(c.sms.accountSid)) problems.push("TWILIO_ACCOUNT_SID must look like AC…(32 hex)");
    if (!c.sms.authToken) problems.push("TWILIO_AUTH_TOKEN is required");
    if (!c.sms.from) problems.push("TWILIO_FROM is required (a number in E.164 format, or an approved alphanumeric sender ID)");
  }
  if (!["log", "cloud"].includes(c.whatsapp.provider)) problems.push(`WHATSAPP_PROVIDER must be "log" or "cloud" (got "${c.whatsapp.provider}")`);
  if (c.whatsapp.provider === "cloud") {
    if (!c.whatsapp.accessToken) problems.push("WHATSAPP_ACCESS_TOKEN is required when WHATSAPP_PROVIDER=cloud");
    if (!/^\d{5,20}$/.test(c.whatsapp.phoneNumberId)) problems.push("WHATSAPP_PHONE_NUMBER_ID must be the numeric phone number ID from Meta");
    for (const [k, v] of [["WHATSAPP_TEMPLATE_OUT_FOR_DELIVERY", c.whatsapp.templateOutForDelivery], ["WHATSAPP_TEMPLATE_ATTEMPT_FAILED", c.whatsapp.templateAttemptFailed]] as const)
      if (!/^[a-z0-9_]{1,512}$/.test(v)) problems.push(`${k} must be the name of a template Meta has approved (lower-case letters, digits, underscores)`);
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(c.whatsapp.templateLanguage)) problems.push("WHATSAPP_TEMPLATE_LANGUAGE must be a language code such as en or ar");
  }
  if (c.liveFeeds.allowedHosts.some((h) => !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(h))) problems.push("FEED_ALLOWED_HOSTS must be a comma list of public host names (no schemes, ports or paths)");
  if (!Number.isInteger(c.rf.port) || c.rf.port < 0 || c.rf.port > 65535) problems.push("RF_PORT must be a port number between 1 and 65535, or unset");
  if (c.rf.port && !(Number.isInteger(c.rf.width) && c.rf.width >= 16 && c.rf.width <= 80 && Number.isInteger(c.rf.rows) && c.rf.rows >= 2 && c.rf.rows <= 40)) problems.push("RF_WIDTH is 16 to 80 columns and RF_ROWS is 2 to 40");
  if (c.rf.port && c.isProd && /^(0\.0\.0\.0|::)$/.test(c.rf.host) && env.RF_BIND_ALL !== "yes") problems.push("RF_HOST must be a private address in production: the RF terminal is cleartext and must not listen on every interface (inside the container compose file, RF_BIND_ALL=yes is set and the published port is limited to RF_PUBLISH)");
  if (!["osrm", "google"].includes(c.routing.provider)) problems.push(`ROUTING_PROVIDER must be "osrm" or "google" (got "${c.routing.provider}")`);
  if (c.routing.provider === "google" && !c.routing.apiKey) problems.push("ROUTING_API_KEY (a Google Maps Platform key with the Routes API enabled) is required when ROUTING_PROVIDER=google");
  if (c.routing.url && !/^https:\/\/[^\s]+$/.test(c.routing.url)) problems.push("ROUTING_URL must be an https address");
  if (c.geocoder.url && !/^https:\/\/[^\s]+$/.test(c.geocoder.url)) problems.push("GEOCODER_URL must be an https address");
  if (!Number.isInteger(c.liveFeeds.intervalMinutes) || c.liveFeeds.intervalMinutes < 15 || c.liveFeeds.intervalMinutes > 1440) problems.push("FEED_PULL_INTERVAL_MINUTES must be a whole number between 15 and 1440");
  if (!["none", "google-vision", "self-hosted"].includes(c.ocr.provider)) problems.push(`OCR_PROVIDER must be "none", "google-vision" or "self-hosted" (got "${c.ocr.provider}")`);
  if (c.ocr.provider === "self-hosted" && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(c.ocr.apiBase)) problems.push("OCR_API_BASE must be the sidecar's address (for example http://ocr:8080) when OCR_PROVIDER=self-hosted");
  if (c.ocr.provider === "google-vision") {
    if (!c.ocr.apiKey) problems.push("OCR_API_KEY is required when OCR_PROVIDER=google-vision");
    if (!c.ocr.reviewed) problems.push("OCR sends document content to the provider: set OCR_DATA_PROCESSING_REVIEWED=true once that processing has been reviewed");
    if (!Number.isInteger(c.ocr.maxPages) || c.ocr.maxPages < 1 || c.ocr.maxPages > 5) problems.push("OCR_MAX_PAGES must be 1–5 (the provider's limit for inline PDFs)");
  }
  if (!["log", "resend", "smtp"].includes(c.mail.provider)) problems.push(`MAIL_PROVIDER must be "log", "resend" or "smtp" (got "${c.mail.provider}")`);
  if (c.mail.provider === "smtp") {
    if (!c.mail.smtp.host || !c.mail.smtp.user || !c.mail.smtp.pass) problems.push("SMTP_HOST, SMTP_USER and SMTP_PASSWORD are required when MAIL_PROVIDER=smtp");
    if (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$|<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(c.mail.from)) problems.push("MAIL_FROM must be an address on a verified sending domain, e.g. \"LOAD|BY|TON <noreply@loadbyton.com>\"");
  }
  if (c.mail.provider === "resend") {
    if (!c.mail.resendApiKey.startsWith("re_")) problems.push("RESEND_API_KEY must be a Resend API key (re_…)");
    if (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$|<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(c.mail.from)) problems.push('MAIL_FROM must be an address on a domain verified in Resend, e.g. "LOAD|BY|TON <noreply@yourdomain>"');
  }
  const asp = c.einvoiceAsp;
  if (asp.name || asp.baseUrl || asp.apiKey) {
    if (!/^[a-z0-9_-]{2,40}$/.test(asp.name) || asp.name === "sandbox") problems.push("EINVOICE_ASP_NAME must be 2–40 characters (letters, digits, - _) and not “sandbox”");
    if (!/^https:\/\//.test(asp.baseUrl)) problems.push("EINVOICE_ASP_BASE_URL must be an https URL");
    if (!asp.apiKey) problems.push("EINVOICE_ASP_API_KEY is required when an e-invoicing provider is configured");
    if (!["bearer", "header"].includes(asp.authScheme)) problems.push('EINVOICE_ASP_AUTH must be "bearer" or "header"');
    if (!["json", "xml"].includes(asp.bodyFormat)) problems.push('EINVOICE_ASP_BODY must be "json" or "xml"');
  }
  const eco = c.ecosystem;
  if (eco.sharedSecret || eco.comBaseUrl || eco.oidcClientId || eco.oidcClientSecret) {
    if (eco.sharedSecret.length < 32) problems.push("ECOSYSTEM_SHARED_SECRET must be at least 32 characters when the loadbyton.com link is configured");
    if (!/^https?:\/\/[^\s/]+$/.test(eco.comBaseUrl) || (production && !eco.comBaseUrl.startsWith("https://"))) problems.push("COM_BASE_URL must be the origin of loadbyton.com (https in production, no path)");
    if (!!eco.oidcClientId !== !!eco.oidcClientSecret) problems.push("set both OIDC_CLIENT_ID and OIDC_CLIENT_SECRET, or neither");
  }
  if (production && !/^https:\/\//.test(c.baseUrl)) problems.push("PUBLIC_BASE_URL must be https in production");
  if (production && c.databaseSsl === "no-verify") problems.push("DATABASE_SSL=no-verify is not permitted in production (use require)");
  if (!!c.upstash.url !== !!c.upstash.token) problems.push("set both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or neither");
  if (c.vatBps < 0 || c.vatBps > 2500 || !Number.isInteger(c.vatBps)) problems.push("CHECKOUT_VAT_BPS must be a whole number of basis points between 0 and 2500");
  if (env.AI_PROVIDER && !["none", "openai"].includes(env.AI_PROVIDER)) problems.push("AI_PROVIDER must be none or openai");
  const a = c.assistant;
  if (a.enabled && (!a.key || !a.reviewed || !a.pricingNote || ![a.inputMicroUsd, a.outputMicroUsd].every((x) => Number.isFinite(x) && x > 0 && x <= 10000) || !Number.isSafeInteger(a.monthlyBudget) || a.monthlyBudget < 1 || a.monthlyBudget > 1_000_000_000 || !/^[a-zA-Z0-9._-]{1,100}$/.test(a.model)))
    problems.push("AI requires reviewed data processing, credentials, model, explicit token pricing and a bounded monthly budget");
  if (!Number.isInteger(c.retentionDays) || c.retentionDays < 1) problems.push("DATA_RETENTION_DAYS must be a positive integer");
  if (c.previousEncryptionSecret && (c.previousEncryptionSecret.length < 32 || c.previousEncryptionSecret === c.encryptionSecret)) problems.push("MFA_ENCRYPTION_PREVIOUS_KEY must be a distinct key of at least 32 characters");
  const rp = c.razorpayPresentment;
  if (!["AED", "INR"].includes(rp.currency) || (rp.currency === "INR" && (!Number.isFinite(rp.aedToInr) || rp.aedToInr <= 0 || rp.aedToInr > 10000 || !rp.note))) problems.push("INR checkout requires a reviewed positive AED/INR rate and RAZORPAY_FX_NOTE");
  if (production) {
    if (!c.companyMfaRequired) problems.push("Sensitive company roles must require MFA in production (REQUIRE_COMPANY_MFA)");
    if (!c.legalReviewed || !c.retentionExplicit || !c.regionExplicit) problems.push("Set LEGAL_REVIEWED, DATA_RETENTION_DAYS and DEPLOYMENT_REGION before production release");
    if (!c.rootDomain || !c.cloudflare.token || !c.cloudflare.zoneId || !c.cloudflare.origin) problems.push("Cloudflare routing credentials and ROOT_DOMAIN are required in production");
    if (!c.clamav.host) problems.push("CLAMAV_HOST is required for production upload scanning");
  }
  if (problems.length) throw new Error(`Invalid configuration:\n - ${problems.join("\n - ")}`);
}
validateConfig();
