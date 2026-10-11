import type { Conn } from "../db/client.js";
import { sha256, badRequest, notFound } from "../lib/util.js";

/** Controlled numbering: gap-free per tenant because the increment commits or rolls back with the document. */
export async function nextNumber(c: Conn, tenantId: string, name: "enquiry" | "quote" | "job" | "invoice" | "transport_order" | "trip" | "fulfil_order" | "inbound" | "return" | "wh_inbound" | "wh_outbound" | "wh_count" | "dlv_shipment" | "dlv_run" | "dlv_settlement" | "dlv_remittance" | "cus_case" | "specialist_case" | "dlv_writeoff" | "site_transfer" | "pick_wave" | "kit_build", prefix: string) {
  const r = await c.query<{ value: number }>(
    `INSERT INTO counters(tenant_id,name,value) VALUES ($1,$2,1)
     ON CONFLICT (tenant_id,name) DO UPDATE SET value = counters.value + 1 RETURNING value`, [tenantId, name]);
  const year = new Date().getUTCFullYear();
  return `${prefix}-${year}-${String(r.rows[0].value).padStart(5, "0")}`;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
export const dedupeHash = (parts: unknown[]) => sha256(parts.map(norm).join("|"));

export function reqStr(v: unknown, label: string, max = 500): string {
  const s = String(v ?? "").trim();
  if (!s) throw badRequest(`${label} is required.`);
  if (s.length > max) throw badRequest(`${label} is too long.`);
  return s;
}
export const optStr = (v: unknown, max = 500) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (s.length > max) throw badRequest("A field is too long.");
  return s;
};
export const optNum = (v: unknown) => {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw badRequest("Numbers must be zero or positive.");
  return n;
};

export async function must<T>(p: Promise<{ rows: T[] }>, what = "Record"): Promise<T> {
  const r = (await p).rows[0];
  if (!r) throw notFound(`${what} not found`);
  return r;
}

/** Validate UUID identifiers at the HTTP/domain boundary before PostgreSQL casts them. */
export function recordId(value: unknown, label = "Record"): string {
  const id = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw badRequest(`${label} identifier is invalid.`);
  return id;
}
