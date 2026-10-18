import type { Conn, Db } from "../db/client.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { HttpError, badRequest } from "../lib/util.js";
import { sectorBySlug } from "./catalog.js";
import { checkFeatureChoice, featureByCode, type PlanNeed } from "./features.js";

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
  features: string[]; plan_code: string | null; order_id: string | null;
  /** when the client's brand kit was in; the clock cannot start before this */
  brand_ready_at: string | null;
  /** when the delivery window began. Null = still waiting for the brand kit, the quote or the plan payment. */
  clock_started_at: string | null;
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

const OPEN_SQL = `('received','in_build','ready')`;
const brandIsConfirmed = async (c: Conn) => !!(await c.query(`SELECT 1 FROM brand_kits WHERE confirmed_at IS NOT NULL`)).rows.length;

/** Start the delivery window on every request of this scope that now has everything it was waiting for. Returns how many started. */
async function startReadyClocks(c: Conn, where: string, params: unknown[]) {
  const r = await c.query<{ id: string; tenant_id: string; status: RequestStatus }>(
    `UPDATE service_requests SET clock_started_at=now(), due_at=now()+make_interval(hours => $1::int), updated_at=now()
      WHERE clock_started_at IS NULL AND status IN ${OPEN_SQL} AND brand_ready_at IS NOT NULL AND (category='free' OR quote_note IS NOT NULL) AND ${where}
      RETURNING id, tenant_id, status`, [config.deliveryHours, ...params]);
  for (const row of r.rows)
    await c.query(`INSERT INTO service_request_events(tenant_id,request_id,status,note,actor_kind,at) VALUES ($1,$2,$3,$4,'system',clock_timestamp())`,
      [row.tenant_id, row.id, row.status, `Everything we needed is in. The ${config.deliveryHours}-hour delivery window has started.`]);
  return r.rows.length;
}

/** The client confirmed their brand kit: every open request that was waiting for it can proceed. */
export async function markBrandReady(c: Conn, tenantId: string) {
  const r = await c.query<{ id: string; status: RequestStatus }>(
    `UPDATE service_requests SET brand_ready_at=now(), updated_at=now() WHERE tenant_id=$1 AND brand_ready_at IS NULL AND status IN ${OPEN_SQL} RETURNING id, status`, [tenantId]);
  for (const row of r.rows)
    await c.query(`INSERT INTO service_request_events(tenant_id,request_id,status,note,actor_kind,at) VALUES ($1,$2,$3,'Brand kit received.','system',clock_timestamp())`, [tenantId, row.id, row.status]);
  await startReadyClocks(c, `tenant_id=$2`, [tenantId]);
  return r.rows.length;
}

/** A monthly-plan order was paid: the requests that were waiting on it have their commercial condition met. Runs as the system role. */
export async function onOrderPaid(c: Conn, order: { id: string; reference: string }, planName: string) {
  const r = await c.query<{ id: string; tenant_id: string; status: RequestStatus }>(
    `UPDATE service_requests SET quote_note=$2, updated_at=now() WHERE order_id=$1 AND quote_note IS NULL AND status IN ${OPEN_SQL} RETURNING id, tenant_id, status`,
    [order.id, `${planName} monthly plan paid \u00b7 order ${order.reference}`]);
  for (const row of r.rows)
    await c.query(`INSERT INTO service_request_events(tenant_id,request_id,status,note,actor_kind,at) VALUES ($1,$2,$3,$4,'system',clock_timestamp())`,
      [row.tenant_id, row.id, row.status, `Payment received (${order.reference}). Your ${planName} plan is active.`]);
  await startReadyClocks(c, `order_id=$2`, [order.id]);
  return r.rows.length;
}

/** A paid order was refunded: tell the request's timeline, so staff and the client see why the plan no longer backs it. */
export async function onOrderRefunded(c: Conn, orderId: string) {
  const r = await c.query<{ id: string; tenant_id: string; status: RequestStatus }>(`SELECT id, tenant_id, status FROM service_requests WHERE order_id=$1`, [orderId]);
  for (const row of r.rows)
    await c.query(`INSERT INTO service_request_events(tenant_id,request_id,status,note,actor_kind,at) VALUES ($1,$2,$3,'The monthly plan payment behind this request was refunded. Our team will contact you about what happens next.','system',clock_timestamp())`, [row.tenant_id, row.id, row.status]);
  return r.rows.length;
}

/** Nudge clients whose request is stuck waiting for a brand kit: after a day, then every three days, at most four times. Email carries no private data. */
export async function sendBrandReminders(db: Db, now = new Date()) {
  const due = (await db.query<{ id: string; tenant_id: string; n: number }>(
    `SELECT id, tenant_id, floor(extract(epoch from ($1::timestamptz - created_at))/259200)::int AS n FROM service_requests
      WHERE status IN ('received','in_build') AND brand_ready_at IS NULL AND created_at < $1::timestamptz - interval '24 hours'`, [now.toISOString()])).rows;
  let sent = 0;
  for (const r of due.filter((x) => x.n <= 3)) {
    const k = await db.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email',$2,$3) ON CONFLICT (key) DO NOTHING RETURNING id`,
      [r.tenant_id, `brand-reminder:${r.id}:${r.n}`, JSON.stringify({ template: "brand_reminder", requestId: r.id })]);
    sent += k.rows.length;
  }
  return sent;
}

/** Store a request from inside the client's own scope. The delivery window starts once the brand kit is in (and, for paid work, the quote or plan payment). */
export async function createRequest(c: Conn, tenantId: string, userId: string, input: NewRequest, now = new Date()): Promise<ServiceRequest> {
  const v = checkNewRequest(input);
  return insertRequest(c, tenantId, userId, { ...v, features: [], planCode: null, covered: null }, now);
}

interface Insert { category: RequestCategory; sectors: string[]; title: string; requirements: string; backendNotes: string | null; features: string[]; planCode: string | null; covered: string | null }
async function insertRequest(c: Conn, tenantId: string, userId: string, v: Insert, now: Date): Promise<ServiceRequest> {
  const brand = await brandIsConfirmed(c);
  const due = new Date(now.getTime() + config.deliveryHours * 3600_000);
  // free: the clock runs from the moment the brand kit is in. paid: it also needs the quote (set by staff) or, for add-ons, the plan payment.
  // A plan the client already pays for covers the add-on: the commercial condition is met on the spot.
  const startNow = brand && (v.category === "free" || !!v.covered);
  const r = await c.query<ServiceRequest>(
    `INSERT INTO service_requests(tenant_id,requested_by,category,sectors,title,requirements,backend_notes,demo_reviewed,due_at,created_at,updated_at,features,plan_code,quote_note,brand_ready_at,clock_started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [tenantId, userId, v.category, v.sectors, v.title, v.requirements, v.backendNotes, due.toISOString(), now.toISOString(), v.features, v.planCode, v.covered,
      brand ? now.toISOString() : null, startNow ? now.toISOString() : null]);
  const req = r.rows[0];
  const waiting: string[] = [];
  if (!brand) waiting.push("your brand kit");
  if (v.category === "paid" && !v.covered) waiting.push(v.planCode ? "the monthly plan payment" : "a quote from us");
  const note = !waiting.length
    ? `Submitted as ${v.category}. The ${config.deliveryHours}-hour delivery window has started (due ${due.toISOString()}).`
    : `Submitted as ${v.category}. The ${config.deliveryHours}-hour delivery window starts when we have ${waiting.join(" and ")}.`;
  await c.query(`INSERT INTO service_request_events(tenant_id,request_id,status,note,actor_kind,actor_user_id) VALUES ($1,$2,'received',$3,'client',$4)`, [tenantId, req.id, note, userId]);
  await audit(c, tenantId, { kind: "user", userId }, "request.created", "service_request", req.id, { category: v.category, sectors: v.sectors, features: v.features });
  return req;
}

const RANK: Record<string, number> = { free: 0, starter: 1, business: 2, operations: 3, enterprise: 4 };

export interface NewFeatureRequest { sectors: string[]; features: string[]; note?: string }
/**
 * Ask for extra features on a sector. Free features are delivered like any free request; one paid add-on makes the request paid, tied to the
 * cheapest monthly plan that covers it. A plan the client already pays for that is high enough covers it without a second payment.
 */
export async function createFeatureRequest(c: Conn, tenantId: string, userId: string, input: NewFeatureRequest, now = new Date()): Promise<{ request: ServiceRequest; plan: PlanNeed | null }> {
  const choice = checkFeatureChoice(input.sectors, input.features, badRequest);
  const names = choice.features.map((f) => featureByCode(f)!.name);
  const note = clean(input.note, 3000);
  const sub = (await c.query<any>(
    `SELECT p.plan_code, s.status, s.period_end FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id`)).rows[0];
  const covered = choice.plan && sub && sub.status === "active" && sub.plan_code !== "free" && new Date(sub.period_end).getTime() > now.getTime()
    && (RANK[sub.plan_code] ?? 0) >= RANK[choice.plan.plan]
    ? `Covered by your current ${choice.plan.name} monthly plan` : null;
  const request = await insertRequest(c, tenantId, userId, {
    category: choice.category, sectors: choice.sectors, title: clean(`Additional features: ${names.join(", ")}`, 160),
    requirements: `${names.map((n) => `\u2022 ${n}`).join("\n")}${note ? `\n\n${note}` : ""}`.padEnd(10, " "),
    backendNotes: null, features: choice.features, planCode: choice.plan?.plan ?? null, covered,
  }, now);
  return { request, plan: choice.plan };
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

/** What an open request is still waiting for before the delivery window can start. Empty once the clock is running or the request is closed. */
export type Waiting = "brand" | "quote" | "payment";
export function waitingFor(r: Pick<ServiceRequest, "status" | "category" | "quote_note" | "plan_code" | "brand_ready_at" | "clock_started_at">): Waiting[] {
  if (!OPEN.includes(r.status) || r.clock_started_at) return [];
  const w: Waiting[] = [];
  if (!r.brand_ready_at) w.push("brand");
  if (r.category === "paid" && !r.quote_note) w.push(r.plan_code ? "payment" : "quote");
  return w;
}

/** Time left on the promise: negative means overdue. Closed requests have no clock, and nothing is late before the clock has started. */
export function clockOf(r: Pick<ServiceRequest, "status" | "due_at" | "delivered_at" | "category" | "quote_note" | "plan_code" | "brand_ready_at" | "clock_started_at">, now = new Date()) {
  if (!OPEN.includes(r.status)) return { open: false as const, awaitingQuote: false, waiting: [] as Waiting[], late: !!r.delivered_at && !!r.clock_started_at && new Date(r.delivered_at) > new Date(r.due_at), msLeft: 0 };
  const waiting = waitingFor(r);
  if (waiting.length) return { open: true as const, awaitingQuote: waiting.includes("quote"), waiting, late: false, msLeft: 0 };
  const msLeft = new Date(r.due_at).getTime() - now.getTime();
  return { open: true as const, awaitingQuote: false, waiting, late: msLeft < 0, msLeft };
}
export function humanLeft(ms: number) {
  const abs = Math.abs(ms), h = Math.floor(abs / 3600_000), m = Math.floor((abs % 3600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// ── staff (platform) side: runs as the system role across tenants
const STAFF = ["commercial_admin", "support", "engineer"];
const needStaff = (role: string | null | undefined) => { if (!role || !STAFF.includes(role)) throw new HttpError(403, `This action needs one of: ${STAFF.join(", ")}.`, "forbidden"); };

export const listAllRequests = async (db: Db, scope: "open" | "all" = "open") =>
  (await db.query<ServiceRequest & { tenant_name: string; tenant_slug: string; contact_email: string; contact_name: string; unread: number }>(
    `SELECT r.*, t.name AS tenant_name, t.slug AS tenant_slug, u.email AS contact_email, u.name AS contact_name,
            (SELECT count(*)::int FROM request_messages m WHERE m.request_id=r.id AND m.author_kind='client' AND m.read_by_staff_at IS NULL) AS unread
       FROM service_requests r JOIN tenants t ON t.id=r.tenant_id JOIN users u ON u.id=r.requested_by
      ${scope === "open" ? "WHERE r.status IN ('received','in_build','ready')" : ""} ORDER BY (r.clock_started_at IS NULL), r.due_at LIMIT 300`)).rows;

/** Delivery-queue health for the staff overview. Mirrors waitingFor: a request whose clock has not started is never counted late. */
export async function requestStats(db: Db) {
  const open = `status IN ('received','in_build','ready')`, running = `clock_started_at IS NOT NULL`;
  const r = (await db.query<any>(
    `SELECT count(*) FILTER (WHERE ${open})::int AS open,
            count(*) FILTER (WHERE ${open} AND category='paid' AND plan_code IS NULL AND quote_note IS NULL)::int AS awaiting_quote,
            count(*) FILTER (WHERE ${open} AND category='paid' AND plan_code IS NOT NULL AND quote_note IS NULL)::int AS awaiting_payment,
            count(*) FILTER (WHERE ${open} AND brand_ready_at IS NULL)::int AS awaiting_brand,
            count(*) FILTER (WHERE ${open} AND ${running} AND due_at < now())::int AS overdue,
            count(*) FILTER (WHERE ${open} AND ${running} AND due_at >= now() AND due_at < now() + interval '4 hours')::int AS due_soon,
            count(*) FILTER (WHERE status='delivered' AND delivered_at > now() - interval '7 days')::int AS delivered_week,
            count(*)::int AS total,
            (SELECT count(*)::int FROM request_messages WHERE author_kind='client' AND read_by_staff_at IS NULL) AS unread
       FROM service_requests`)).rows[0];
  return { open: r.open as number, awaitingQuote: r.awaiting_quote as number, awaitingPayment: r.awaiting_payment as number, awaitingBrand: r.awaiting_brand as number, overdue: r.overdue as number, dueSoon: r.due_soon as number, deliveredWeek: r.delivered_week as number, total: r.total as number, unread: r.unread as number };
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
    await c.query(
      `UPDATE service_requests SET status=$2, quote_note=coalesce($3,quote_note), delivery_url=coalesce($4,delivery_url), delivery_notes=coalesce($5,delivery_notes),
         delivered_at=CASE WHEN $2='delivered' THEN now() ELSE NULL END, updated_at=now() WHERE id=$1`,
      [id, status, clean(input.quoteNote, 1000) || null, url || null, clean(input.deliveryNotes, 4000) || null]);
    await c.query(`INSERT INTO service_request_events(tenant_id,request_id,status,note,actor_kind,actor_user_id) VALUES ($1,$2,$3,$4,'staff',$5)`,
      [cur.tenant_id, id, status, clean(input.note, 1000) || null, staff.userId]);
    await audit(c, cur.tenant_id, { kind: "platform_staff", userId: staff.userId }, `request.${status}`, "service_request", id, { from: cur.status });
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email',$2,$3) ON CONFLICT (key) DO NOTHING`,
      [cur.tenant_id, `request-status:${id}:${status}:${Date.now()}`, JSON.stringify({ template: "request_status", requestId: id, status })]);
    // Recording the quote is what lets a paid request's window start (if the brand kit is already in).
    if (OPEN.includes(status)) await startReadyClocks(c, `id=$2`, [id]);
  });
}
