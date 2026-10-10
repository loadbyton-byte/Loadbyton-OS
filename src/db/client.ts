import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

/** Minimal connection surface shared by PGlite (dev/test) and node-postgres (production). */
export interface Conn {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface Db extends Conn {
  /** Run fn in one transaction as the table owner (platform/system work; bypasses tenant RLS). */
  system<T>(fn: (c: Conn) => Promise<T>): Promise<T>;
  /** Run fn in one transaction as the restricted runtime role with the tenant scope established. */
  tenant<T>(tenantId: string, fn: (c: Conn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

async function runMigrations(c: Conn) {
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = path.join(here, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await c.query(`SELECT 1 FROM schema_migrations WHERE name=$1`, [f]);
    if (done.rows.length) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    await c.query("BEGIN");
    try {
      await execMulti(c, sql);
      await c.query(`INSERT INTO schema_migrations(name) VALUES ($1)`, [f]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  }
}

// pg's simple-query protocol accepts multi statements when no params are supplied; PGlite exposes exec().
async function execMulti(c: Conn, sql: string) {
  const anyC = c as any;
  if (typeof anyC.exec === "function") await anyC.exec(sql);
  else await c.query(sql);
}

/**
 * TLS settings for managed PostgreSQL (Neon, Supabase, RDS…). The certificate is verified unless you explicitly choose no-verify (never in production).
 * Neon/Supabase strings usually end in ?sslmode=require: we strip that parameter and apply DATABASE_SSL instead, because node-postgres reads
 * `sslmode=require` as full verification against the system roots only and its semantics changed between versions.
 */
export function pgConnection(url: string, c = config): { connectionString: string; ssl?: pg.ClientConfig["ssl"] } {
  const u = new URL(url);
  const mode = c.databaseSsl || (u.searchParams.get("sslmode") === "disable" ? "disable" : ["require", "verify-full", "verify-ca", "prefer"].includes(u.searchParams.get("sslmode") ?? "") ? "require" : "");
  u.searchParams.delete("sslmode"); u.searchParams.delete("ssl");
  const connectionString = u.toString();
  if (!mode || mode === "disable") return { connectionString };
  if (mode === "no-verify") return { connectionString, ssl: { rejectUnauthorized: false } };
  if (mode !== "require") throw new Error(`DATABASE_SSL must be empty, "require", "no-verify" or "disable" (got "${mode}")`);
  return { connectionString, ssl: c.databaseCa ? { rejectUnauthorized: true, ca: c.databaseCa.replace(/\\n/g, "\n") } : { rejectUnauthorized: true } };
}

export async function openDb(opts: { url?: string; dir?: string | null } = {}): Promise<Db> {
  const url = opts.url ?? config.databaseUrl;
  if (url) return openPg(url);
  return openPglite(opts.dir === undefined ? config.pgliteDir : opts.dir);
}

async function openPglite(dir: string | null): Promise<Db> {
  if (dir) fs.mkdirSync(path.dirname(dir), { recursive: true });
  // DATE columns stay 'YYYY-MM-DD' strings (no timezone-shifted Date objects)
  const opts = { parsers: { 1082: (v: string) => v } };
  const pgl = dir ? new PGlite(dir, opts) : new PGlite(opts);
  await pgl.waitReady;
  const migrator: Conn & { exec(s: string): Promise<unknown> } = {
    query: async (s: string, p?: unknown[]) => {
      const r = await pgl.query(s, p as any[]);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
    exec: (s: string) => pgl.exec(s),
  } as any;
  await runMigrations(migrator);

  const wrap = (tx: { query: PGlite["query"] }): Conn => ({
    query: async (s, p) => {
      const r = await tx.query(s, p as any[]);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
  });

  return {
    query: (s, p) => wrap(pgl).query(s, p),
    system: (fn) => pgl.transaction((tx) => fn(wrap(tx as any))),
    tenant: (tenantId, fn) =>
      pgl.transaction(async (tx) => {
        const c = wrap(tx as any);
        await scopeToTenant(c, tenantId);
        return fn(c);
      }),
    close: () => pgl.close(),
  };
}

async function openPg(url: string): Promise<Db> {
  const pool = new pg.Pool({ ...pgConnection(url), max: config.databasePoolMax, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
  pool.on("error", (e) => console.error("[pg] idle client error", e.message));   // a dropped idle connection (serverless Postgres suspends) must not crash the process
  pg.types.setTypeParser(20, (v) => Number(v)); // int8 -> number (amounts stay well below 2^53 minor units)
  pg.types.setTypeParser(1082, (v) => v);      // date -> 'YYYY-MM-DD'
  pg.types.setTypeParser(1700, (v) => v);      // numeric stays string to preserve precision
  // Migrations run on the direct connection when one is given (poolers in transaction mode are meant for application queries).
  const mPool = config.migrationDatabaseUrl ? new pg.Pool({ ...pgConnection(config.migrationDatabaseUrl), max: 1 }) : pool;
  const client = await mPool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(727001)`);        // two instances starting together must not both migrate
    await runMigrations({
      query: async (s, p) => {
        const r = await client.query(s, p as any[]);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
    });
  } finally {
    await client.query(`SELECT pg_advisory_unlock(727001)`).catch(() => {});
    client.release();
    if (mPool !== pool) await mPool.end();
  }
  const withClient = async <T>(fn: (c: Conn) => Promise<T>, scope?: string): Promise<T> => {
    const cl = await pool.connect();
    const c: Conn = {
      query: async (s, p) => {
        const r = await cl.query(s, p as any[]);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
    };
    try {
      await cl.query("BEGIN");
      if (scope) await scopeToTenant(c, scope);
      const out = await fn(c);
      await cl.query("COMMIT");
      return out;
    } catch (e) {
      await cl.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      cl.release();
    }
  };
  return {
    query: async (s, p) => {
      const r = await pool.query(s, p as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    system: (fn) => withClient(fn),
    tenant: (id, fn) => withClient(fn, id),
    close: () => pool.end(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function scopeToTenant(c: Conn, tenantId: string) {
  if (!UUID_RE.test(tenantId)) throw new Error("invalid tenant scope");
  await c.query(`SET LOCAL ROLE lbt_app`);
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
}
