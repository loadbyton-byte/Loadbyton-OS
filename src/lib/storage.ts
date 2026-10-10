import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { HttpError } from "./util.js";

/** Private object storage for uploaded documents. Keys are always `<tenantId>/<uuid>`; callers authorise before reading. */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

/** Local disk (single VM / development). Refuses any key that would escape the root. */
export function fsStorage(root: string): Storage {
  const resolve = (key: string) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new HttpError(403, "Not permitted", "forbidden");
    return full;
  };
  return {
    async put(key, data) { const f = resolve(key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data, { mode: 0o600 }); },
    async get(key) { return fs.readFileSync(resolve(key)); },
  };
}

// ───────────────────────── AWS Signature Version 4 (what every S3-compatible store speaks)
const sha256hex = (d: string | Buffer) => crypto.createHash("sha256").update(d).digest("hex");
const hmac = (k: string | Buffer, d: string) => crypto.createHmac("sha256", k).update(d).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SigV4Input {
  method: string; host: string; path: string; query?: string; headers?: Record<string, string>; payloadHash: string;
  region: string; service: string; accessKeyId: string; secretAccessKey: string; amzDate: string;   // 20130524T000000Z
}
/** Returns the full header set to send (host excluded), including Authorization. Canonical URI is the path as given (already encoded). */
export function signV4(i: SigV4Input): { headers: Record<string, string>; signature: string; canonicalRequest: string } {
  const hdrs: Record<string, string> = { ...(i.headers ?? {}), host: i.host, "x-amz-content-sha256": i.payloadHash, "x-amz-date": i.amzDate };
  const names = Object.keys(hdrs).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const canonicalRequest = [i.method, i.path, i.query ?? "", ...names.map((n) => `${n}:${lower[n]}`), "", names.join(";"), i.payloadHash].join("\n");
  const day = i.amzDate.slice(0, 8), scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), i.service), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _h, ...send } = hdrs;
  return {
    signature, canonicalRequest,
    headers: { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` },
  };
}

export interface S3Config { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; pathStyle: boolean }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** S3-compatible object storage over fetch (no SDK): Oracle Object Storage (S3 compatibility API), Cloudflare R2, MinIO, AWS S3. */
export function s3Storage(cfg: S3Config, fetchImpl: Fetch = fetch, now: () => Date = () => new Date()): Storage {
  const base = new URL(cfg.endpoint);
  const target = (key: string) => {
    const k = key.split("/").map(enc).join("/");
    return cfg.pathStyle
      ? { host: base.host, path: `/${enc(cfg.bucket)}/${k}`, url: `${base.protocol}//${base.host}/${enc(cfg.bucket)}/${k}` }
      : { host: `${cfg.bucket}.${base.host}`, path: `/${k}`, url: `${base.protocol}//${cfg.bucket}.${base.host}/${k}` };
  };
  const call = async (method: "PUT" | "GET", key: string, body?: Buffer) => {
    const t = target(key), amzDate = now().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const s = signV4({ method, host: t.host, path: t.path, payloadHash: sha256hex(body ?? ""), region: cfg.region, service: "s3", accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate });
    try {
      return await fetchImpl(t.url, { method, headers: s.headers, body: body as any, signal: AbortSignal.timeout(30_000) });
    } catch (e) { throw new HttpError(502, "The document store could not be reached. Please try again.", "storage_unavailable"); }
  };
  return {
    async put(key, data) {
      const r = await call("PUT", key, data);
      if (!r.ok) { console.error("[storage] put failed", r.status, (await r.text().catch(() => "")).slice(0, 300)); throw new HttpError(502, "The document could not be stored. Please try again.", "storage_unavailable"); }
    },
    async get(key) {
      const r = await call("GET", key);
      if (r.status === 404) throw new HttpError(404, "Document file not found");
      if (!r.ok) { console.error("[storage] get failed", r.status); throw new HttpError(502, "The document could not be read. Please try again.", "storage_unavailable"); }
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

export const storage: Storage = config.storage.driver === "s3"
  ? s3Storage({ ...config.storage.s3, pathStyle: config.storage.s3.pathStyle })
  : fsStorage(config.storageDir);
