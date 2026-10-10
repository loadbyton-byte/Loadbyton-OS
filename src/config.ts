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
  port: Number(env.PORT ?? 3000),
  baseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:3000",
  rootDomain: (env.ROOT_DOMAIN ?? "").toLowerCase(),
  databaseUrl: env.DATABASE_URL ?? "",
  pgliteDir: env.PGLITE_DIR ?? path.resolve("data/pg"),
  sessionSecret: secret("SESSION_SECRET", "dev-session-secret-dev-session-secret-0000"),
  webhookSecret: secret("PAYMENT_WEBHOOK_SECRET", "dev-webhook-secret-dev-webhook-secret-0000"),
  paymentProvider: env.PAYMENT_PROVIDER ?? "mock",
  vatBps: Number(env.CHECKOUT_VAT_BPS ?? 500),
  storageDir: path.resolve(env.STORAGE_DIR ?? "data/files"),
  runWorkers: (env.RUN_WORKERS ?? "true") === "true",
  maxUploadBytes: 10 * 1024 * 1024,
};

if (isProd && config.paymentProvider === "mock") {
  throw new Error("PAYMENT_PROVIDER=mock is not permitted in production");
}
