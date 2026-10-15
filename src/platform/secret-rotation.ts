import type { Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { seal, unsealWith } from "../lib/seal.js";

/**
 * Re-seal values stored under the session secret (merchant webhook signing secrets) with the new primary secret.
 * One locked transaction; every value must authenticate under one of the two secrets or the whole run aborts.
 * Dry run by default; only counts are returned or audited.
 */
/** Every column that holds a value sealed under the session secret: table, key columns, sealed column. */
const TARGETS: { name: string; table: string; keys: string[]; column: string }[] = [
  { name: "dlv_merchant_settings", table: "dlv_merchant_settings", keys: ["tenant_id", "merchant_id"], column: "webhook_secret_sealed" },
  { name: "feed_connections.secret_sealed", table: "feed_connections", keys: ["id"], column: "secret_sealed" },
  { name: "feed_connections.token_sealed", table: "feed_connections", keys: ["id"], column: "token_sealed" },
  { name: "feed_connections.tls_cert_sealed", table: "feed_connections", keys: ["id"], column: "tls_cert_sealed" },
  { name: "feed_connections.tls_key_sealed", table: "feed_connections", keys: ["id"], column: "tls_key_sealed" },
  { name: "feed_connections.sign_key_sealed", table: "feed_connections", keys: ["id"], column: "sign_key_sealed" },
  { name: "feed_connections.consent_verifier_sealed", table: "feed_connections", keys: ["id"], column: "consent_verifier_sealed" },
];
export async function resealSessionSecrets(db: Db, current: string, previous: string, apply = false) {
  if (current.length < 32 || previous.length < 32 || current === previous) throw new Error("Rotation requires distinct current and previous secrets of at least 32 characters");
  return db.system(async (c) => {
    const counts: Record<string, { examined: number; pending: number; rotated: number }> = {};
    for (const t of new Set(TARGETS.map((x) => x.table))) await c.query(`LOCK TABLE ${t} IN SHARE ROW EXCLUSIVE MODE`);
    for (const t of TARGETS) {
      const rows = (await c.query<any>(`SELECT ${t.keys.join(", ")}, ${t.column} s FROM ${t.table} WHERE ${t.column} IS NOT NULL ORDER BY ${t.keys.join(", ")}`)).rows;
      if (rows.length > 10000) throw new Error("Rotation exceeds the bounded maintenance limit");
      let pending = 0, rotated = 0;
      for (const r of rows) {
        try { unsealWith(r.s, current); continue; } catch { /* must authenticate under the previous secret */ }
        let plain: string;
        try { plain = unsealWith(r.s, previous); } catch { throw new Error("Rotation aborted: a sealed value authenticates under neither secret"); }
        pending++;
        if (apply) { await c.query(`UPDATE ${t.table} SET ${t.column}=$${t.keys.length + 1} WHERE ${t.keys.map((k, i) => `${k}=$${i + 1}`).join(" AND ")}`, [...t.keys.map((k) => r[k]), seal(plain, current)]); rotated++; }
      }
      counts[t.name] = { examined: rows.length, pending, rotated };
    }
    if (apply) await audit(c, null, { kind: "system" }, "security.session_secret_resealed", "platform", undefined, { counts });
    return { mode: apply ? "applied" : "dry_run", counts };
  });
}
