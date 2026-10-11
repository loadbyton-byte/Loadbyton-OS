import crypto from "node:crypto";
import { config } from "../config.js";

/** Authenticated encryption for small secrets we must be able to read back (e.g. a merchant's webhook signing secret). Key derives from SESSION_SECRET. */
const key = (secret: string) => crypto.createHash("sha256").update(`lbt:seal:v1:${secret}`).digest();
export function seal(plain: string, secret = config.sessionSecret): string {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key(secret), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
export function unseal(sealed: string, secret = config.sessionSecret): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("bad sealed value");
  const d = crypto.createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
