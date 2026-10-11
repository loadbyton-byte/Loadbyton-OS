import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Conn } from "../db/client.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, hmac, safeEqual, sha256 } from "../lib/util.js";
import { assertWritable, getLimit } from "../platform/entitlements.js";
import { must, optStr, reqStr } from "./common.js";
import { objectStorage, scanWithClamav, validateStorageKey } from "../adapters/storage.js";

export const DOC_KINDS = ["commercial_invoice", "packing_list", "booking_confirmation", "transport_document", "delivery_order", "shipment_instructions", "pod", "supplier_invoice", "other"] as const;
const ALLOWED: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  csv: "text/csv", txt: "text/plain",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * Upload gate. Executable/markup content is rejected by magic bytes regardless of extension. The default scanner is a
 * basic content check; plug a malware scanner (e.g. ClamAV) into `scan` before accepting untrusted public uploads.
 */
export type Scanner = (buf: Buffer, filename: string) => Promise<void>;
export const basicScan: Scanner = async (buf) => {
  const head = buf.subarray(0, 512).toString("latin1");
  const bad = [/^MZ/, /^\x7fELF/, /^#!/, /^\s*<\s*(!doctype|html|script|svg|\?xml)/i];
  if (bad.some((r) => r.test(head))) throw badRequest("This file type is not allowed.");
  await scanWithClamav(buf);
};
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 4).toString() === "%PDF",
  png: (b) => b[0] === 0x89 && b.subarray(1, 4).toString() === "PNG",
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8, jpeg: (b) => b[0] === 0xff && b[1] === 0xd8,
  xlsx: (b) => b.subarray(0, 2).toString() === "PK", docx: (b) => b.subarray(0, 2).toString() === "PK",
};

export async function uploadDocument(c: Conn, ctx: Ctx, f: DocInput, scan: Scanner = basicScan) {
  require(ctx, "doc.write");
  return storeDocument(c, ctx, f, scan);
}

export interface DocInput { job_id?: string | null; trip_id?: string | null; transport_order_id?: string | null; delivery_parcel_id?:string|null; kind: string; title: string; issuer?: string; customer_visible?: boolean; filename: string; data: Buffer }

/** Permission-free storage path: callers (office upload, driver POD photo) enforce their own authorisation first. */
export async function storeDocument(c: Conn, ctx: Ctx, f: DocInput, scan: Scanner = basicScan) {
  const ext = path.extname(f.filename).slice(1).toLowerCase();
  if (!ALLOWED[ext]) throw badRequest(`File type .${ext || "?"} is not allowed. Allowed: ${Object.keys(ALLOWED).join(", ")}.`);
  if (f.data.length === 0) throw badRequest("The file is empty.");
  if (f.data.length > config.maxUploadBytes) throw badRequest(`Files are limited to ${config.maxUploadBytes / 1048576} MB.`);
  if (MAGIC[ext] && !MAGIC[ext](f.data)) throw badRequest("File content does not match its extension.");
  await scan(f.data, f.filename);
  await assertWritable(c, ctx.tenantId);
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`document-storage:${ctx.tenantId}`]);
  const limitCheck = await c.query<{ n: string | number }>(`SELECT (SELECT coalesce(sum(size_bytes),0) FROM documents)+(SELECT coalesce(sum(size_bytes),0) FROM generated_documents) n`);
  const limitBytes = (await getLimit(c, ctx.tenantId, "storage_mb")) * 1048576;
  if (Number(limitCheck.rows[0].n) + f.data.length > limitBytes) throw new HttpError(402, "Storage allowance reached. Existing documents stay readable; upgrade to add more.", "quota_exceeded");

  const kind = (DOC_KINDS as readonly string[]).includes(f.kind) ? f.kind : "other";
  const issuer=optStr(f.issuer,200);
  if (f.job_id) await must(c.query(`SELECT id FROM jobs WHERE id=$1`, [f.job_id]), "Job");
  if(f.delivery_parcel_id)await must(c.query(`SELECT id FROM delivery_parcels WHERE id=$1`,[f.delivery_parcel_id]),'Parcel');
  const key = `${ctx.tenantId}/${crypto.randomUUID()}`;
  await objectStorage().put(key,f.data,ALLOWED[ext]);
  const version = f.job_id
    ? Number((await c.query<any>(`SELECT coalesce(max(version),0)+1 v FROM documents WHERE job_id=$1 AND kind=$2`, [f.job_id, kind])).rows[0].v) : 1;
  const r = await c.query<{ id: string }>(
    `INSERT INTO documents(tenant_id,job_id,trip_id,transport_order_id,delivery_parcel_id,kind,title,version,status,issuer,customer_visible,storage_key,filename,mime,size_bytes,sha256,created_by)
     VALUES ($1,$2,$15,$16,$17,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ctx.tenantId, f.job_id || null, kind, reqStr(f.title, "Title", 200), version, issuer ? "issued" : "draft", issuer,
      !!f.customer_visible, key, path.basename(f.filename).slice(0, 200), ALLOWED[ext], f.data.length, sha256(f.data), ctx.userId,
      f.trip_id || null, f.transport_order_id || null,f.delivery_parcel_id||null]);
  await audit(c, ctx.tenantId, actorOf(ctx), "document.uploaded", "document", r.rows[0].id, { kind, sha256: sha256(f.data) });
  return r.rows[0].id;
}

// short-lived signed access; the route also re-checks session, tenant and (for portal users) visibility
export function signDownload(tenantId: string, docId: string, ttlSec = 300) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return { exp, sig: hmac(config.sessionSecret, `dl:${tenantId}:${docId}:${exp}`) };
}
export function verifyDownload(tenantId: string, docId: string, exp: number, sig: string) {
  return exp > Date.now() / 1000 && safeEqual(sig, hmac(config.sessionSecret, `dl:${tenantId}:${docId}:${exp}`));
}
export function readDocumentFile(storageKey: string, tenantId: string): Buffer {
  validateStorageKey(storageKey,tenantId);
  if (!storageKey.startsWith(`${tenantId}/`)) throw new HttpError(403, "Not permitted", "forbidden");
  const full = path.resolve(config.storageDir, storageKey);
  if (!full.startsWith(path.resolve(config.storageDir) + path.sep)) throw new HttpError(403, "Not permitted", "forbidden");
  return fs.readFileSync(full);
}

export async function fetchDocumentFile(storageKey: string,tenantId: string,expectedHash: string): Promise<Buffer> {
  validateStorageKey(storageKey,tenantId);
  const buf=await objectStorage().get(storageKey);
  if(sha256(buf)!==expectedHash) throw new Error('Stored document integrity check failed');
  return buf;
}

export const listDocuments = (c: Conn, opts: { jobId?: string; portalPartyId?: string | null } = {}) =>
  c.query<any>(`SELECT d.*, j.no AS job_no FROM documents d LEFT JOIN jobs j ON j.id=d.job_id
    WHERE ($1::uuid IS NULL OR d.job_id=$1)
      AND ($2::uuid IS NULL OR (d.customer_visible AND j.party_id=$2))
    ORDER BY d.created_at DESC`, [opts.jobId ?? null, opts.portalPartyId ?? null]).then((r) => r.rows);

export async function setHold(c: Conn, ctx: Ctx, id: string, hold: boolean) {
  require(ctx, "doc.write");
  await c.query(`UPDATE documents SET hold=$2 WHERE id=$1`, [id, hold]);
  await audit(c, ctx.tenantId, actorOf(ctx), hold ? "document.hold" : "document.release", "document", id);
}
