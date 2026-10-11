import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";

/** Minimal RFC 4180 parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cur = "", q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cur += ch;
  }
  if(q)throw badRequest("CSV has an unclosed quoted field.");
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export interface ImportReport { created: number; duplicates: string[]; rejected: { line: number; reason: string }[] }

/** Customer/supplier import. Columns: name,kind,email,phone,tax_id (header row required). Duplicates are skipped, not overwritten. */
export async function importParties(c: Conn, ctx: Ctx, csv: string, dryRun = false): Promise<ImportReport> {
  require(ctx, "party.write");
  await assertWritable(c, ctx.tenantId);
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest("The file needs a header row and at least one data row.");
  if (rows.length > 2001) throw badRequest("Import is limited to 2,000 rows per file.");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (n: string) => head.indexOf(n);
  if (idx("name") < 0) throw badRequest("A “name” column is required.");
  const rep: ImportReport = { created: 0, duplicates: [], rejected: [] };
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], get = (n: string) => (idx(n) >= 0 ? (r[idx(n)] ?? "").trim() : "");
    const name = get("name"), kind = (get("kind") || "customer").toLowerCase();
    if (!name) { rep.rejected.push({ line: i + 1, reason: "name is empty" }); continue; }
    if (!["customer", "supplier", "agent"].includes(kind)) { rep.rejected.push({ line: i + 1, reason: `unknown kind “${kind}”` }); continue; }
    const email = get("email");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { rep.rejected.push({ line: i + 1, reason: "invalid email" }); continue; }
    const key = `${kind}:${name.toLowerCase()}`;
    if (seen.has(key)) { rep.duplicates.push(name); continue; }
    seen.add(key);
    const exists = await c.query(`SELECT 1 FROM parties WHERE kind=$1 AND lower(name)=lower($2)`, [kind, name]);
    if (exists.rows.length) { rep.duplicates.push(name); continue; }
    if (!dryRun) await c.query(`INSERT INTO parties(tenant_id,kind,name,email,phone,tax_id,owner_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, kind, name.slice(0, 200), email || null, get("phone").slice(0, 50) || null, get("tax_id").slice(0, 60) || null, ctx.userId]);
    rep.created++;
  }
  if (!dryRun) await audit(c, ctx.tenantId, actorOf(ctx), "party.imported", "party", undefined, { created: rep.created, duplicates: rep.duplicates.length, rejected: rep.rejected.length });
  return rep;
}
