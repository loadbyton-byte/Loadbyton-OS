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

export const config = {
  isProd,
  port: Number(env.PORT ?? 3000),
  baseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:3000",
  rootDomain: (env.ROOT_DOMAIN ?? "").toLowerCase(),

  // ── database (PGlite when empty; Neon / Supabase / any PostgreSQL otherwise)
  databaseUrl: env.DATABASE_URL ?? "",
  /** Direct (non-pooled) URL used only for migrations. Neon/Supabase poolers are fine for the app, but DDL belongs on a direct connection. */
  migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? "",
  /** "" = driver default · "require" = TLS with certificate verification · "no-verify" = TLS without verification (not for production) · "disable" */
  databaseSsl: text("DATABASE_SSL").toLowerCase(),
  databaseCa: text("DATABASE_CA"),
  databasePoolMax: Number(env.DATABASE_POOL_MAX ?? 10),
  pgliteDir: env.PGLITE_DIR ?? path.resolve("data/pg"),

  sessionSecret: secret("SESSION_SECRET", "dev-session-secret-dev-session-secret-0000"),
  /** Signs the simulated-provider webhook (mock only). Real providers use their own signing secrets below. */
  webhookSecret: isProd && !(env.PAYMENT_WEBHOOK_SECRET && env.PAYMENT_WEBHOOK_SECRET.length >= 32)
    ? crypto.randomBytes(32).toString("hex") : secret("PAYMENT_WEBHOOK_SECRET", "dev-webhook-secret-dev-webhook-secret-0000"),

  // ── payments: several providers can be enabled at once; the first is the default at checkout
  /** Rehearse on the production server with TEST keys (smoke test). Turn it off before taking real payments. */
  allowTestPaymentKeys: flag("ALLOW_TEST_PAYMENT_KEYS"),
  paymentProviders,
  paymentProvider: paymentProviders[0] ?? "mock",
  stripe: {
    secretKey: text("STRIPE_SECRET_KEY"), webhookSecret: text("STRIPE_WEBHOOK_SECRET"), apiBase: env.STRIPE_API_BASE ?? "https://api.stripe.com",
    /** Optional comma list (e.g. "card"). Empty = Stripe's dynamic payment methods from the dashboard (cards, Google Pay, Apple Pay, Link…). */
    paymentMethods: list(env.STRIPE_PAYMENT_METHODS),
  },
  razorpay: {
    keyId: text("RAZORPAY_KEY_ID"), keySecret: text("RAZORPAY_KEY_SECRET"), webhookSecret: text("RAZORPAY_WEBHOOK_SECRET"), apiBase: env.RAZORPAY_API_BASE ?? "https://api.razorpay.com",
  },

  // ── tax and seller identity shown at checkout (set from your own registrations; have an accountant confirm the treatment)
  vatBps: Number(env.CHECKOUT_VAT_BPS ?? 500),
  checkoutTaxNote: text("CHECKOUT_TAX_NOTE"),
  seller: {
    legalName: text("SELLER_LEGAL_NAME"), tradeName: text("SELLER_TRADE_NAME"), gstin: text("SELLER_GSTIN"), pan: text("SELLER_PAN"),
    address: text("SELLER_ADDRESS"), email: text("SELLER_SUPPORT_EMAIL"), lutNote: text("SELLER_LUT_NOTE"),
    sac: text("SELLER_SAC"), supplyNote: text("SELLER_SUPPLY_NOTE"),
  },

  // ── shared rate limiting (Upstash Redis REST); in-memory per process when unset
  upstash: { url: text("UPSTASH_REDIS_REST_URL").replace(/\/$/, ""), token: text("UPSTASH_REDIS_REST_TOKEN") },
  /** Which header carries the real client IP: "cloudflare" (CF-Connecting-IP) or "xff" (first X-Forwarded-For hop). Empty = trust nothing. */
  trustProxy: text("TRUST_PROXY").toLowerCase(),

  storageDir: path.resolve(env.STORAGE_DIR ?? "data/files"),
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
  if (production && !/^https:\/\//.test(c.baseUrl)) problems.push("PUBLIC_BASE_URL must be https in production");
  if (production && c.databaseSsl === "no-verify") problems.push("DATABASE_SSL=no-verify is not permitted in production (use require)");
  if (!!c.upstash.url !== !!c.upstash.token) problems.push("set both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or neither");
  if (c.vatBps < 0 || c.vatBps > 2500 || !Number.isInteger(c.vatBps)) problems.push("CHECKOUT_VAT_BPS must be a whole number of basis points between 0 and 2500");
  if (problems.length) throw new Error(`Invalid configuration:\n - ${problems.join("\n - ")}`);
}
validateConfig();
