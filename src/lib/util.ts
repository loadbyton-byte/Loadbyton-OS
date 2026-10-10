import crypto from "node:crypto";
import { config } from "../config.js";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}
export const forbidden = (m = "Not permitted") => new HttpError(403, m, "forbidden");
export const notFound = (m = "Not found") => new HttpError(404, m, "not_found");
export const badRequest = (m: string) => new HttpError(400, m, "bad_request");
export const quotaExceeded = (key: string, limit: number) =>
  new HttpError(402, `Plan limit reached for ${key} (${limit}). Existing records stay readable and exportable; upgrade to add more.`, "quota_exceeded");

export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const hmac = (key: string, data: string) => crypto.createHmac("sha256", key).update(data).digest("hex");
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ── passwords: scrypt with per-user salt
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await new Promise<Buffer>((res, rej) =>
    crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, k] = stored.split("$");
  if (alg !== "scrypt") return false;
  const key = await new Promise<Buffer>((res, rej) =>
    crypto.scrypt(pw, Buffer.from(s, "base64"), 64, { N: 16384, r: 8, p: 1 }, (e, kk) => (e ? rej(e) : res(kk))));
  return crypto.timingSafeEqual(key, Buffer.from(k, "base64"));
}
export function checkPasswordStrength(pw: string) {
  if (pw.length < 10) throw badRequest("Password must be at least 10 characters.");
}

// ── TOTP (RFC 6238) for platform administrators
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret(): string {
  const b = crypto.randomBytes(20);
  let bits = "", out = "";
  for (const x of b) bits += x.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}
function b32decode(s: string): Buffer {
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(secret: string, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, "0");
}
export function verifyTotp(secret: string, code: string, at = Date.now()): boolean {
  return [-1, 0, 1].some((w) => safeEqual(totp(secret, at + w * 30_000), code.trim()));
}

// ── money (integer minor units, 2 decimals)
export const fmtMoney = (minor: number | string, currency = "AED") =>
  `${currency} ${(Number(minor) / 100).toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const toMinor = (v: string | number): number => {
  const n = Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) throw badRequest("Invalid amount");
  return Math.round(n * 100);
};
export const lineNet = (qty: number | string, unitMinor: number | string) => Math.round(Number(qty) * Number(unitMinor));

// Tax codes are configuration; the right code depends on the transaction, so users choose per line. Accountant review required.
export const TAX_CODES: Record<string, { label: string; bps: number }> = {
  SR5: { label: "Standard rated 5%", bps: 500 },
  ZR0: { label: "Zero rated 0%", bps: 0 },
  EX0: { label: "Exempt", bps: 0 },
  OOS: { label: "Out of scope", bps: 0 },
};
export const taxFor = (net: number, code: string) => {
  const t = TAX_CODES[code];
  if (!t) throw badRequest(`Unknown tax code ${code}`);
  return Math.round((net * t.bps) / 10_000);
};

export function formatDate(d: Date | string | null | undefined, tz = "Asia/Dubai") {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(d));
}
export function formatDay(d: Date | string | null | undefined) {
  if (!d) return "—";
  const s = typeof d === "string" ? d : d.toISOString();
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(s.slice(0, 10)));
}

export const RESERVED_SLUGS = new Set([
  "www", "app", "admin", "api", "help", "status", "mail", "smtp", "ftp", "ns1", "ns2", "docs", "static", "assets", "cdn",
  "login", "signup", "billing", "pay", "payments", "security", "support", "root", "system", "staging", "dev", "test",
  "loadbyton", "company", "portal", "console", "auth", "sso", "webhooks", "files",
]);
export function slugify(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "company";
}
export const baseUrl = () => config.baseUrl.replace(/\/$/, "");
