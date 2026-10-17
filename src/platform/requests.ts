import type { Conn, Db } from "../db/client.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { HttpError, badRequest } from "../lib/util.js";
import { sectorBySlug } from "./catalog.js";

export const REQUEST_CATEGORIES = {
  free: { label: "Free", blurb: "One sector pack, customised to your fields, branding and document layouts." },
  paid: { label: "Paid", blurb: "Several sectors, integrations or bespoke workflows. We quote the build once we read your requirement." },
} as const;
export type RequestCategory = keyof typeof REQUEST_CATEGORIES;

export const REQUEST_STATUSES = ["received", "in_build", "ready", "delivered", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
const OPEN: RequestStatus[] = ["received", "in_build", "ready"];
export const STATUS_LABEL: Record<RequestStatus, string> = { received: "Received", in_build: "Being customised", ready: "Ready for hand-off", delivered: "Delivered", cancelled: "Cancelled" };

export interface ServiceRequest {
  id: string; tenant_id: string; requested_by: string; category: RequestCategory; sectors: string[]; title: string; requirements: string;
  backend_notes: string | null; demo_reviewed: boolean; status: RequestStatus; due_at: string; delivered_at: string | null;
  quote_note: string | null; delivery_url: string | null; delivery_notes: string | null; created_at: string; updated_at: string;
}

export interface NewRequest { category: string; sectors: string[]; title: string; requirements: string; backendNotes?: string; demoReviewed: boolean }

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);

/** Pure validation, so a registration can be rejected before any account is created. */
export function checkNewRequest(input: NewRequest) {
  if (!(input.category in REQUEST_CATEGORIES)) throw badRequest("Choose Free or Paid.");
  const sectors = [...new Set(input.sectors.filter((s) => sectorBySlug(s)))];
  if (!sectors.length) throw badRequest("Pick at least one sector from the demo.");
  if (input.category === "free" && sectors.some((s) => sectorBySlug(s)!.availability === "planned")) throw badRequest("That sector is a bespoke build (not in the demo yet). Choose Paid for it.");
  if (input.category === "free" && sectors.length > 1) throw badRequest("A free request covers one sector. Choose Paid to combine sectors.");
  const title = clean(input.title, 160), requirements = clean(input.requirements, 6000);
  if (title.length < 3) throw badRequest("Give the request a short title.");
  if (requirements.length < 10) throw badRequest("Describe what you need customised (at least a sentence).");
  if (!input.demoReviewed) throw badRequest("Confirm you have seen the demo so we build from what you chose.");
  return { category: input.category as RequestCategory, sectors, title, requirements, backendNotes: clean(input.backendNotes, 1500) || null };
}

/** Store a request from inside the client's own scope. The delivery clock starts at submission. */
export async function createRequest(c: Conn, tenantId: string, userId: string, input: NewRequest, now = new Date()): Promise<ServiceRequest> {
  const v = checkNewRequest(input);
  const due = new Date(now.getTime() + config.deliveryHours * 3600_000);
  const r = await c.query<ServiceRequest>(
    `INSERT INTO service_requests(tenant_id,requested_by,category,sectors,title,requirements,backend_notes,demo_reviewed,due_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$9) RETURNING *`,
    [tenantId, userId, v.category, v.sectors, v.title, v.requirements, v.backendNotes, due.toISOString(), now.toISOString()]);
  await c.query(`INSERT INTO service_request_events(tenant_id,request_id,status,note,actor_kind,actor_user_id) VALUES ($1,$2,'received',$3,'client',$4)`,
    [tenantId, r.rows[0].id, v.category === "paid" ? `Submitted as paid. We will agree a quote; the ${config.deliveryHours}-hour delivery window starts then.` : `Submitted as free. Delivery due ${due.toISOString()}.`, userId]);
  await audit(c, tenantId, { kind: "user", userId }, "request.created", "service_request", r.rows[0].id, { category: v.category, sectors: v.sectors });
  return r.rows[0];
}

export const listRequests = async (c: Conn) =>
  (await c.query<ServiceRequest>(`SELECT * FROM service_requests ORDER BY created_at DESC LIMIT 100`)).rows;

export async function requestDetail(c: Conn, id: string) {
  const request = (await c.query<ServiceRequest>(`SELECT * FROM service_requests WHERE id=$1`, [id])).rows[0];
  if (!request) throw new HttpError(404, "Request not found", "not_found");
  const events = (await c.query<any>(`SELECT * FROM service_request_events WHERE request_id=$1 ORDER BY at, id`, [id])).rows;
  return { request, events };
}

/** The client may withdraw a request that has not been handed off. */
export async function cancelOwnRequest(c: Conn, tenantId: string, userId: string, id: string) {
  const r = await c.query(`UPDATE service_requests SET status='cancelled', updated_at=now() WHERE id=$1 AND status IN ('received','in_build') RETURNING id`, [id]);
  if (!r.rows.length) throw new HttpError(409, "Only a request that is not yet ready can be cancelled.", "conflict");
  await c.query(`INSERT INTO service_request_events(tenant_id,request_id,status,note,actor_kind,actor_user_id) VALUES ($1,$2,'cancelled','Cancelled by the client.','client',$3)`, [tenantId, id, userId]);
}

/** Time left on the promise: negative means overdue. Closed requests have no clock. */
export function clockOf(r: Pick<ServiceRequest, "status" | "due_at" | "delivered_at" | "category" | "quote_note">, now = new Date()) {
  if (!OPEN.includes(r.status)) return { open: false as const, awaitingQuote: false, late: !!r.delivered_at && new Date(r.delivered_at) > new Date(r.due_at), msLeft: 0 };
  // Paid work: the delivery window starts when the quote is agreed, so there is nothing to be late against yet.
  if (r.category === "paid" && !r.quote_note) return { open: true as const, awaitingQuote: true, late: false, msLeft: 0 };
  const msLeft = new Date(r.due_at).getTime() - now.getTime();
  return { open: true as const, awaitingQuote: false, late: msLeft < 0, msLeft };
}
export function humanLeft(ms: number) {
  const abs = Math.abs(ms), h = Math.floor(abs / 3600_000), m = Math.floor((abs % 3600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// ── staff (platform) side: runs as the system role across tenants
const STAFF = ["commercial_admin", "support", "engineer"];
const needStaff = (role: string | null | undefined) => { if (!role || !STAFF.includes(role)) throw new HttpError(403, `This action needs one of: ${STAFF.join(", ")}.`, "forbidden"); };

export const listAllRequests = async (db: Db, scope: "open" | "all" = "open") =>
  (await db.query<ServiceRequest & { tenant_name: string; tenant_slug: string; contact_email: string; contact_name: string }>(
    `SELECT r.*, t.name AS tenant_name, t.slug AS tenant_slug, u.email AS contact_email, u.name AS contact_name
       FROM service_requests r JOIN tenants t ON t.id=r.tenant_id JOIN users u ON u.id=r.requested_by
      ${scope === "open" ? "WHERE r.status IN ('received','in_build','ready')" : ""} ORDER BY r.due_at LIMIT 300`)).rows;

/** Delivery-queue health for the staff overview. Mirrors clockOf: a paid request with no quote yet has no clock, so it is never counted late. */
export async function requestStats(db: Db) {
  const open = `status IN ('received','in_build','ready')`, waiting = `(category='paid' AND quote_note IS NULL)`;
  const r = (await db.query<any>(
    `SELECT count(*) FILTER (WHERE ${open})::int AS open,
            count(*) FILTER (WHERE ${open} AND ${waiting})::int AS awaiting_quote,
            count(*) FILTER (WHERE ${open} AND NOT ${waiting} AND due_at < now())::int AS overdue,
            count(*) FILTER (WHERE ${open} AND NOT ${waiting} AND due_at >= now() AND due_at < now() + interval '4 hours')::int AS due_soon,
            count(*) FILTER (WHERE status='delivered' AND delivered_at > now() - interval '7 days')::int AS delivered_week,
            count(*)::int AS total
       FROM service_requests`)).rows[0];
  return { open: r.open as number, awaitingQuote: r.awaiting_quote as number, overdue: r.overdue as number, dueSoon: r.due_soon as number, deliveredWeek: r.delivered_week as number, total: r.total as number };
}

export async function staffUpdateRequest(db: Db, staff: { userId: string; role: string | null }, id: string, input: { status: string; note?: string; quoteNote?: string; deliveryUrl?: string; deliveryNotes?: string }) {
  needStaff(staff.role);
  const status = input.status as RequestStatus;
  if (!REQUEST_STATUSES.includes(status)) throw badRequest("Unknown status.");
  const url = clean(input.deliveryUrl, 500);
  if (url && !/^https:\/\/[^\s]+$/i.test(url)) throw badRequest("The hand-off link must be an https:// address.");
  if (status === "delivered" && !url && !clean(input.deliveryNotes, 4000)) throw badRequest("Add the hand-off link or delivery notes the client will use.");
  return db.system(async (c) => {
    const cur = (await c.query<ServiceRequest>(`SELECT * FROM service_requests WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!cur) throw new HttpError(404, "Request not found", "not_found");
    if (!OPEN.includes(cur.status)) throw new HttpError(409, `This request is already ${cur.status}.`, "conflict");
    if (cur.category === "paid" && status !== "cancelled" && !clean(input.quoteNote, 1000) && !cur.quote_note && status !== "received")
      throw badRequest("Record the agreed quote or commercial note before building a paid request.");
    // The paid delivery window starts at the moment the quote is first recorded.
    const quoteAgreedNow = cur.category === "paid" && !cur.quote_note && !!clean(input.quoteNote, 1000);
    await c.query(
      `UPDATE service_requests SET status=$2, quote_note=coalesce($3,quote_note), delivery_url=coalesce($4,delivery_url), delivery_notes=coalesce($5,delivery_notes),
         due_at=CASE WHEN $6::boolean THEN now() + make_interval(hours => $7::int) ELSE due_at END,
         delivered_at=CASE WHEN $2='delivered' THEN now() ELSE NULL END, updated_at=now() WHERE id=$1`,
      [id, status, clean(input.quoteNote, 1000) || null, url || null, clean(input.deliveryNotes, 4000) || null, quoteAgreedNow, config.deliveryHours]);
    await c.query(`INSERT INTO service_request_events(tenant_id,request_id,status,note,actor_kind,actor_user_id) VALUES ($1,$2,$3,$4,'staff',$5)`,
      [cur.tenant_id, id, status, clean(input.note, 1000) || null, staff.userId]);
    await audit(c, cur.tenant_id, { kind: "platform_staff", userId: staff.userId }, `request.${status}`, "service_request", id, { from: cur.status });
  });
}
