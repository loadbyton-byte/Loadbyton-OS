import type { Conn, Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { assertNoPrivateData } from "../lib/private-data.js";
import { HttpError, badRequest } from "../lib/util.js";

/**
 * The single point of contact between a client and our staff. Every message belongs to one of the client's requests, so staff always see it
 * next to the requirement, the brand kit and the clock. Messages cannot be edited or deleted (the database enforces it); they can only be read.
 */
export interface Message {
  id: string; tenant_id: string; request_id: string; author_kind: "client" | "staff"; author_name: string; body: string; created_at: string;
  read_by_client_at: string | null; read_by_staff_at: string | null;
}

const STAFF = ["commercial_admin", "support", "engineer"];
const MAX_BODY = 4000;

function cleanBody(body: unknown) {
  const b = String(body ?? "").replace(/\r\n/g, "\n").trim();
  if (!b) throw badRequest("Write a message first.");
  if (b.length > MAX_BODY) throw badRequest(`Messages are limited to ${MAX_BODY} characters.`);
  return b;
}

// ── client side (tenant-scoped connection)

/** A client writes to us about one of their requests. Private numbers are refused with a pointer to the hand-off guide. */
export async function postClientMessage(c: Conn, tenantId: string, user: { id: string; name: string }, requestId: string, body: string): Promise<Message> {
  const text = cleanBody(body);
  assertNoPrivateData(text, badRequest);
  const req = (await c.query(`SELECT id FROM service_requests WHERE id=$1`, [requestId])).rows[0];
  if (!req) throw new HttpError(404, "Request not found", "not_found");
  const m = (await c.query<Message>(
    `INSERT INTO request_messages(tenant_id,request_id,author_kind,author_user_id,author_name,body,read_by_client_at) VALUES ($1,$2,'client',$3,$4,$5,now()) RETURNING *`,
    [tenantId, requestId, user.id, user.name, text])).rows[0];
  // tell the team there is a message (the email carries no message text, only a link)
  await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email',$2,$3) ON CONFLICT (key) DO NOTHING`,
    [tenantId, `request-message:${m.id}`, JSON.stringify({ template: "client_message", requestId })]);
  await audit(c, tenantId, { kind: "user", userId: user.id }, "request.message_sent", "service_request", requestId);
  return m;
}

export const clientThread = async (c: Conn, requestId?: string) =>
  (await c.query<Message & { request_title: string }>(
    `SELECT m.*, r.title AS request_title FROM request_messages m JOIN service_requests r ON r.id=m.request_id
      WHERE ($1::uuid IS NULL OR m.request_id=$1) ORDER BY m.created_at, m.id`, [requestId ?? null])).rows;

export const unreadForClient = async (c: Conn) =>
  Number((await c.query<{ n: number }>(`SELECT count(*)::int n FROM request_messages WHERE author_kind='staff' AND read_by_client_at IS NULL`)).rows[0].n);

export async function markClientRead(c: Conn, requestId?: string) {
  await c.query(`UPDATE request_messages SET read_by_client_at=now() WHERE author_kind='staff' AND read_by_client_at IS NULL AND ($1::uuid IS NULL OR request_id=$1)`, [requestId ?? null]);
}

// ── staff side (system role: crosses tenants, so it checks the role itself)

const needStaff = (role: string | null | undefined) => { if (!role || !STAFF.includes(role)) throw new HttpError(403, `This action needs one of: ${STAFF.join(", ")}.`, "forbidden"); };

export async function postStaffMessage(db: Db, staff: { userId: string; name: string; role: string | null }, requestId: string, body: string): Promise<Message> {
  needStaff(staff.role);
  const text = cleanBody(body);
  // staff are held to the same rule: we never ask for, or repeat, a private number
  assertNoPrivateData(text, badRequest);
  return db.system(async (c) => {
    const req = (await c.query<{ tenant_id: string }>(`SELECT tenant_id FROM service_requests WHERE id=$1`, [requestId])).rows[0];
    if (!req) throw new HttpError(404, "Request not found", "not_found");
    const m = (await c.query<Message>(
      `INSERT INTO request_messages(tenant_id,request_id,author_kind,author_user_id,author_name,body,read_by_staff_at) VALUES ($1,$2,'staff',$3,$4,$5,now()) RETURNING *`,
      [req.tenant_id, requestId, staff.userId, staff.name, text])).rows[0];
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email',$2,$3) ON CONFLICT (key) DO NOTHING`,
      [req.tenant_id, `request-message:${m.id}`, JSON.stringify({ template: "request_reply", requestId })]);
    await audit(c, req.tenant_id, { kind: "platform_staff", userId: staff.userId }, "request.message_replied", "service_request", requestId);
    return m;
  });
}

export const staffThread = (db: Db, requestId: string) =>
  db.query<Message>(`SELECT * FROM request_messages WHERE request_id=$1 ORDER BY created_at, id`, [requestId]).then((r) => r.rows);

export async function markStaffRead(db: Db, requestId: string) {
  await db.system((c) => c.query(`UPDATE request_messages SET read_by_staff_at=now() WHERE request_id=$1 AND author_kind='client' AND read_by_staff_at IS NULL`, [requestId]));
}
