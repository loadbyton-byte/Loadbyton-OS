import path from "node:path";

const env = process.env;
const isProd = env.NODE_ENV === "production";

function secret(name: string, dev: string): string {
  const v = env[name];
  if (v && v.length >= 32) return v;
  if (isProd) throw new Error(`${name} must be set (min 32 chars) in production`);
  return dev;
}

export const config = {
  isProd,
  metricsToken: env.METRICS_TOKEN ?? "",
  port: Number(env.PORT ?? 3000),
  baseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:3000",
  rootDomain: (env.ROOT_DOMAIN ?? "").toLowerCase(),
  databaseUrl: env.DATABASE_URL ?? "",
  migrateOnStart: (env.MIGRATE_ON_START ?? (isProd ? 'false' : 'true')) === 'true',
  pgliteDir: env.PGLITE_DIR ?? path.resolve("data/pg"),
  sessionSecret: secret("SESSION_SECRET", "dev-session-secret-dev-session-secret-0000"),
  encryptionSecret: secret("MFA_ENCRYPTION_KEY", "dev-mfa-encryption-dev-mfa-encryption-0000"),
  previousEncryptionSecret: env.MFA_ENCRYPTION_PREVIOUS_KEY ?? "",
  webhookSecret: isProd?'':secret("PAYMENT_WEBHOOK_SECRET", "dev-webhook-secret-dev-webhook-secret-0000"),
  paymentProvider: env.PAYMENT_PROVIDER ?? "mock",
  vatBps: Number(env.CHECKOUT_VAT_BPS ?? (isProd ? NaN : 500)),
  taxLabel: env.CHECKOUT_TAX_LABEL ?? "Tax",
  taxNote: env.CHECKOUT_TAX_NOTE ?? "Tax treatment is configured by the service provider for this transaction.",
  merchant: { legalName: env.MERCHANT_LEGAL_NAME ?? "", country: env.MERCHANT_COUNTRY ?? "IN", address: env.MERCHANT_ADDRESS ?? "", taxId: env.MERCHANT_TAX_ID ?? "", supportEmail: env.SUPPORT_EMAIL ?? "" },
  stripe: { key: env.STRIPE_SECRET_KEY ?? "", webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "" },
  razorpay: { keyId: env.RAZORPAY_KEY_ID ?? "", keySecret: env.RAZORPAY_KEY_SECRET ?? "", webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? "" },
  razorpayPresentment: {currency:env.RAZORPAY_PRESENTMENT_CURRENCY??'AED',aedToInr:Number(env.RAZORPAY_AED_TO_INR??0),note:env.RAZORPAY_FX_NOTE??''},
  enabledPaymentProviders: (env.PAYMENT_PROVIDERS ?? env.PAYMENT_PROVIDER ?? "mock").split(",").map(x => x.trim()).filter(Boolean),
  storageProvider: env.STORAGE_PROVIDER ?? "local",
  supabase: { url: env.SUPABASE_URL ?? "", key: env.SUPABASE_SERVICE_ROLE_KEY ?? "", bucket: env.SUPABASE_STORAGE_BUCKET ?? "documents" },
  clamav: { host: env.CLAMAV_HOST ?? "", port: Number(env.CLAMAV_PORT ?? 3310) },
  upstash: { url: env.UPSTASH_REDIS_REST_URL ?? "", token: env.UPSTASH_REDIS_REST_TOKEN ?? "" },
  cloudflare: { token: env.CLOUDFLARE_API_TOKEN ?? "", zoneId: env.CLOUDFLARE_ZONE_ID ?? "", origin: env.CLOUDFLARE_ORIGIN_HOSTNAME ?? "" },
  companyMfaRequired: (env.REQUIRE_COMPANY_MFA ?? (isProd ? "true" : "false")) === "true",
  legalReviewed: env.LEGAL_REVIEWED === 'true',
  retentionDays: Number(env.DATA_RETENTION_DAYS ?? 90),
  deploymentRegion: env.DEPLOYMENT_REGION ?? 'Development environment',
  smtp: { url: env.SMTP_URL ?? "", from: env.EMAIL_FROM ?? "" },
  assistant: { enabled:env.AI_PROVIDER==='openai',key:env.OPENAI_API_KEY??'',model:env.AI_MODEL??'gpt-4.1-mini',reviewed:env.AI_DATA_PROCESSING_REVIEWED==='true',inputMicroUsd:Number(env.AI_INPUT_MICRO_USD_PER_TOKEN??0),outputMicroUsd:Number(env.AI_OUTPUT_MICRO_USD_PER_TOKEN??0),monthlyBudget:Number(env.AI_MONTHLY_BUDGET_MICRO_USD??0),pricingNote:env.AI_PRICING_NOTE??'' },
  storageDir: path.resolve(env.STORAGE_DIR ?? "data/files"),
  runWorkers: (env.RUN_WORKERS ?? "true") === "true",
  maxUploadBytes: 10 * 1024 * 1024,
};

if (isProd && config.paymentProvider === "mock") {
  throw new Error("PAYMENT_PROVIDER=mock is not permitted in production");
}

if (!config.enabledPaymentProviders.length || config.enabledPaymentProviders.some(p => !["mock", "stripe", "razorpay"].includes(p)) || !config.enabledPaymentProviders.includes(config.paymentProvider)) {
  throw new Error("Unsupported payment provider configuration. Choose stripe, razorpay or development-only mock.");
}
if(env.AI_PROVIDER&&!['none','openai'].includes(env.AI_PROVIDER))throw new Error('Unsupported AI provider');
if(config.assistant.enabled&&(!config.assistant.key||!config.assistant.reviewed||!config.assistant.pricingNote||![config.assistant.inputMicroUsd,config.assistant.outputMicroUsd].every(x=>Number.isFinite(x)&&x>0&&x<=10000)||!Number.isSafeInteger(config.assistant.monthlyBudget)||config.assistant.monthlyBudget<1||config.assistant.monthlyBudget>1000000000||!/^[a-zA-Z0-9._-]{1,100}$/.test(config.assistant.model)))throw new Error('AI requires reviewed data processing, credentials, model, explicit token pricing and a bounded monthly budget');
if(!Number.isInteger(config.retentionDays)||config.retentionDays<1)throw new Error('DATA_RETENTION_DAYS must be a positive integer');
if(!['local','supabase'].includes(config.storageProvider))throw new Error('Unsupported storage provider');
if(config.previousEncryptionSecret&&(config.previousEncryptionSecret.length<32||config.previousEncryptionSecret===config.encryptionSecret))throw new Error('MFA_ENCRYPTION_PREVIOUS_KEY must be a distinct key of at least 32 characters');
if(!['AED','INR'].includes(config.razorpayPresentment.currency)||config.razorpayPresentment.currency==='INR'&&(!Number.isFinite(config.razorpayPresentment.aedToInr)||config.razorpayPresentment.aedToInr<=0||config.razorpayPresentment.aedToInr>10000||!config.razorpayPresentment.note))throw new Error('INR checkout requires a reviewed positive AED/INR rate and RAZORPAY_FX_NOTE');
if (isProd) {
  if (config.enabledPaymentProviders.includes("mock")) throw new Error("Mock payments are not permitted in production");
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required in production (Neon PostgreSQL)");
  if (!Number.isInteger(config.vatBps) || config.vatBps < 0 || config.vatBps > 10000 || !env.CHECKOUT_TAX_NOTE) throw new Error("Set CHECKOUT_VAT_BPS and CHECKOUT_TAX_NOTE to the approved merchant tax treatment");
  if (!config.merchant.legalName || !config.merchant.address || !config.merchant.supportEmail) throw new Error("Merchant legal name, address and support email are required in production");
  for (const p of config.enabledPaymentProviders) {
    if (p === "stripe" && (!config.stripe.key || !config.stripe.webhookSecret)) throw new Error("Stripe credentials are required");
    if (p === "razorpay" && (!config.razorpay.keyId || !config.razorpay.keySecret || !config.razorpay.webhookSecret)) throw new Error("Razorpay credentials are required");
  }
  if (!config.baseUrl.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must use HTTPS in production");
  if (config.storageProvider !== "supabase" || !config.supabase.url || !config.supabase.key) throw new Error("Private Supabase storage credentials are required in production");
  for(const url of [config.supabase.url,config.upstash.url])if(new URL(url).protocol!=='https:')throw new Error('Storage and rate-limit providers require HTTPS');
  if (!config.clamav.host) throw new Error("CLAMAV_HOST is required for production upload scanning");
  if (!config.upstash.url || !config.upstash.token) throw new Error("Upstash shared rate limiting is required in production");
  if (!config.smtp.url || !config.smtp.from) throw new Error("SMTP_URL and EMAIL_FROM are required for production notifications");
  if (!config.cloudflare.token||!config.cloudflare.zoneId||!config.cloudflare.origin||!config.rootDomain) throw new Error('Cloudflare routing credentials and ROOT_DOMAIN are required in production');
  if (!config.companyMfaRequired) throw new Error('Sensitive company roles must require MFA in production');
  if (!config.legalReviewed || !env.DATA_RETENTION_DAYS || !env.DEPLOYMENT_REGION) throw new Error('Set reviewed legal, retention and deployment region configuration before production release');
}
