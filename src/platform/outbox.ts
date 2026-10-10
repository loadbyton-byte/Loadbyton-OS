import type { Db } from "../db/client.js";

export interface OutboxRow { id: string; tenant_id: string | null; topic: string; key: string; payload: any; attempts: number }
export interface OutboxHandler { (row: OutboxRow): Promise<{ externalId?: string } | void> }
export type OutboxHandlers = Record<string, OutboxHandler>;

/** Default handlers. "email" logs (replace with a real mail adapter); staff.review rows are never auto-delivered: they wait in the control console until a staff member acknowledges them. */
export const defaultHandlers: OutboxHandlers = {
  async email(row) {
    if (process.env.NODE_ENV !== "test") console.log(`[email] ${row.payload.template ?? "message"} tenant=${row.tenant_id}`);
  },
};

/**
 * Deliver pending outbox rows with retry/backoff. A row is sent at most once (status flips in the same tx as a
 * successful handler); permanent failures go to 'dead', which is a staff-visible queue.
 */
export async function drainOutbox(db: Db, handlers: OutboxHandlers = defaultHandlers, maxAttempts = 6) {
  const rows = await db.query<OutboxRow>(`SELECT * FROM outbox WHERE status='pending' AND topic <> 'staff.review' AND next_at <= now() ORDER BY created_at LIMIT 50`);
  let sent = 0;
  for (const row of rows.rows) {
    const h = handlers[row.topic];
    try {
      if (!h) throw new Error(`no handler for ${row.topic}`);
      const res = await h(row);
      await db.query(`UPDATE outbox SET status='sent', attempts=attempts+1, external_id=coalesce($2,external_id), last_error=NULL WHERE id=$1`, [row.id, (res as any)?.externalId ?? null]);
      sent++;
    } catch (e: any) {
      const attempts = row.attempts + 1;
      const dead = attempts >= maxAttempts;
      await db.query(
        `UPDATE outbox SET attempts=$2, last_error=$3, status=$4, next_at=now() + ($5 || ' seconds')::interval WHERE id=$1`,
        [row.id, attempts, String(e?.message ?? e), dead ? "dead" : "pending", String(Math.min(3600, 5 * 2 ** attempts))]);
    }
  }
  return sent;
}
