import type { Db } from "../db/client.js";
import { randomToken } from '../lib/util.js';

export interface OutboxRow { id: string; tenant_id: string | null; topic: string; key: string; payload: any; attempts: number }
export interface OutboxHandler { (row: OutboxRow): Promise<{ externalId?: string } | void> }
export type OutboxHandlers = Record<string, OutboxHandler>;

/** Default handlers. "email" logs (adapters/mail.ts replaces it with a real provider when MAIL_PROVIDER is set); staff.review rows are never auto-delivered: they wait in the control console until a staff member acknowledges them. */
export const defaultHandlers: OutboxHandlers = {
  async email(row) {
    if (process.env.NODE_ENV !== "test") console.log(`[email] ${row.payload.template ?? "message"} tenant=${row.tenant_id}`);
  },
};

/**
 * Deliver with exclusive expiring leases and retry/backoff. Delivery is at least once: handlers must deduplicate
 * row.key after an ambiguous provider timeout. Permanent failures remain in the staff-visible queue.
 */
/** Merchant endpoints and mail providers have outages measured in hours, so those topics keep trying longer (back-off caps at 1 h per try). */
export const MAX_ATTEMPTS: Record<string, number> = { "merchant.webhook": 12, email: 8 };
export async function drainOutbox(db: Db, handlers: OutboxHandlers = defaultHandlers, maxAttempts = 6) {
  // Claim one row at a time: a slow batch cannot exhaust the leases on later rows.
  let sent = 0;
  for(let i=0;i<50;i++) {
    const lease=randomToken(16);
    const row=await db.system(async c=>(await c.query<OutboxRow>(`UPDATE outbox SET lease_token=$1,lease_until=now()+interval '5 minutes' WHERE id=(SELECT id FROM outbox WHERE status='pending' AND topic<>'staff.review' AND next_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,[lease])).rows[0]);
    if(!row)break;
    const h = handlers[row.topic];
    try {
      if (!h) throw new Error(`no handler for ${row.topic}`);
      const res = await h(row);
      // once delivered, one-time credentials and personal data (an invitation link or its encrypted token, a delivery code in an SMS, a phone number) must not stay readable in the database
      await db.query(`UPDATE outbox SET status='sent', attempts=attempts+1, external_id=coalesce($2,external_id), last_error=NULL, lease_until=NULL, lease_token=NULL, payload = payload - 'link' - 'tokenEncrypted' - 'body' - 'to' WHERE id=$1 AND lease_token=$3`, [row.id, (res as any)?.externalId ?? null, lease]);
      sent++;
    } catch (e: any) {
      const attempts = row.attempts + 1;
      const dead = attempts >= (MAX_ATTEMPTS[row.topic] ?? maxAttempts) || e?.permanent === true;
      await db.query(
        `UPDATE outbox SET attempts=$2, last_error=$3, status=$4, next_at=now() + ($5 || ' seconds')::interval,lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$6`,
        [row.id, attempts, String(e?.message ?? e).slice(0,1000), dead ? "dead" : "pending", String(Math.min(3600, 5 * 2 ** attempts)),lease]);
    }
  }
  return sent;
}
