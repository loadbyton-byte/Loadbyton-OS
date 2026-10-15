import crypto from "node:crypto";
import type { Db } from "../db/client.js";

export const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

/**
 * Takes (or renews) the lease for a named worker. Exactly one holder can own an unexpired lease, so with several web instances each job still runs on one
 * of them at a time. A crashed holder's lease lapses after `ttlMs`, and another instance picks the job up on its next tick.
 */
export async function acquireLease(db: Db, name: string, ttlMs: number, holder = INSTANCE_ID): Promise<boolean> {
  const r = await db.system((c) => c.query<any>(
    `INSERT INTO worker_leases(name,holder,expires_at) VALUES ($1,$2, now() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (name) DO UPDATE SET holder=EXCLUDED.holder, expires_at=EXCLUDED.expires_at, renewed_at=now()
     WHERE worker_leases.holder=EXCLUDED.holder OR worker_leases.expires_at < now() RETURNING holder`, [name, holder, String(Math.round(ttlMs))]));
  return r.rows.length === 1;
}
export async function releaseLease(db: Db, name: string, holder = INSTANCE_ID) {
  await db.system((c) => c.query(`DELETE FROM worker_leases WHERE name=$1 AND holder=$2`, [name, holder]));
}
