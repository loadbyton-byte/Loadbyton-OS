import type { Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { seal, unsealWith } from "../lib/seal.js";

/**
 * Re-seal values stored under the session secret (merchant webhook signing secrets) with the new primary secret.
 * One locked transaction; every value must authenticate under one of the two secrets or the whole run aborts.
 * Dry run by default; only counts are returned or audited.
 */
export async function resealSessionSecrets(db: Db, current: string, previous: string, apply = false) {
  if (current.length < 32 || previous.length < 32 || current === previous) throw new Error("Rotation requires distinct current and previous secrets of at least 32 characters");
  return db.system(async (c) => {
    await c.query(`LOCK TABLE dlv_merchant_settings IN SHARE ROW EXCLUSIVE MODE`);
    const rows = (await c.query<any>(`SELECT tenant_id, merchant_id, webhook_secret_sealed s FROM dlv_merchant_settings WHERE webhook_secret_sealed IS NOT NULL ORDER BY tenant_id, merchant_id`)).rows;
    if (rows.length > 10000) throw new Error("Rotation exceeds the bounded maintenance limit");
    let pending = 0, rotated = 0;
    for (const r of rows) {
      try { unsealWith(r.s, current); continue; } catch { /* must authenticate under the previous secret */ }
      let plain: string;
      try { plain = unsealWith(r.s, previous); } catch { throw new Error("Rotation aborted: a sealed value authenticates under neither secret"); }
      pending++;
      if (apply) { await c.query(`UPDATE dlv_merchant_settings SET webhook_secret_sealed=$3 WHERE tenant_id=$1 AND merchant_id=$2`, [r.tenant_id, r.merchant_id, seal(plain, current)]); rotated++; }
    }
    const counts = { dlv_merchant_settings: { examined: rows.length, pending, rotated } };
    if (apply) await audit(c, null, { kind: "system" }, "security.session_secret_resealed", "platform", undefined, { counts });
    return { mode: apply ? "applied" : "dry_run", counts };
  });
}
