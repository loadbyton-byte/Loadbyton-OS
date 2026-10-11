import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";
import { fetchDocumentFile } from "./documents.js";
import { parseCsv } from "./importer.js";
import { moveStock, resolveLocation, resolveSku } from "./fulfilment.js";
import { skuMode } from "./fulfil-lots.js";
import { post, r3 } from "./warehouse.js";

/**
 * Opening-balance and final-delta migration for stock.
 * A snapshot is a CSV of what the old system holds. It is validated against a declared control total, diffed against what this
 * system holds now, and only an approved batch is applied — as ordinary `adjust` movements through the same guarded paths
 * (so the immutable ledgers, lot rules and location rules all still apply). Running a second snapshot at cutover is the
 * "final delta": it adjusts only the difference since the first load. Nothing is posted from an unreviewed file.
 */
type Module = "fulfilment" | "custody";
interface Target { key: string; sku_id: string; location_id: string; owner_id?: string; lot: string; label: string; qty: number }
interface DiffRow { key: string; label: string; current: number; target: number; delta: number; problem?: string }

const COLS: Record<Module, string[]> = {
  fulfilment: ["sku_code", "location_code", "qty"],
  custody: ["owner", "sku_code", "location_code", "lot", "qty"],
};

async function source(c: Conn, id: string) {
  const doc = await must(c.query<any>(`SELECT * FROM documents WHERE id=$1 AND status='issued' AND NOT hold`, [recordId(id, "Source file")]), "Issued source file");
  if (doc.mime !== "text/csv") throw badRequest("Use an issued CSV source file.");
  return { doc, csv: (await fetchDocumentFile(doc.storage_key, doc.tenant_id, doc.sha256)).toString("utf8") };
}

async function parse(c: Conn, module: Module, csv: string, controlUnits: number) {
  const rows = parseCsv(csv).filter((r) => r.some((x) => x.trim()));
  if (rows.length < 2) throw badRequest("The snapshot has no rows.");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  for (const need of COLS[module]) if (!head.includes(need)) throw badRequest(`Snapshot needs the columns: ${COLS[module].join(", ")} (missing “${need}”).`);
  const col = (r: string[], n: string) => (r[head.indexOf(n)] ?? "").trim();
  const errors: string[] = [], seen = new Set<string>(), targets: Target[] = [];
  let total = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], line = i + 1;
    try {
      const qty = Number(col(r, "qty"));
      if (!Number.isFinite(qty) || qty < 0) throw badRequest("quantity must be zero or more");
      if (module === "fulfilment") {
        if (!Number.isInteger(qty)) throw badRequest("fulfilment quantities are whole units");
        const sku = await resolveSku(c, { sku_code: col(r, "sku_code") });
        const mode = await skuMode(c, sku.id);
        if (mode.tracked) throw badRequest(`${sku.code} is lot/serial/expiry tracked — load it through lot receipts so each lot is identified`);
        const loc = await resolveLocation(c, { location_code: col(r, "location_code") });
        const key = `${sku.id}|${loc.id}`;
        if (seen.has(key)) throw badRequest("duplicate SKU/location row");
        seen.add(key);
        targets.push({ key, sku_id: sku.id, location_id: loc.id, lot: "", label: `${sku.code} @ ${loc.code}`, qty });
      } else {
        const owner = await must(c.query<any>(`SELECT id,name FROM parties WHERE kind='customer' AND (lower(name)=lower($1) OR id::text=$1)`, [col(r, "owner")]), `Customer “${col(r, "owner")}”`);
        const sku = await must(c.query<any>(`SELECT id,code FROM wh_skus WHERE owner_id=$1 AND (upper(code)=upper($2) OR barcode=$2)`, [owner.id, col(r, "sku_code")]), `SKU “${col(r, "sku_code")}”`);
        const loc = await must(c.query<any>(`SELECT id,code FROM warehouse_locations WHERE upper(code)=upper($1)`, [col(r, "location_code")]), `Location “${col(r, "location_code")}”`);
        const lot = col(r, "lot");
        const key = `${owner.id}|${sku.id}|${loc.id}|${lot}`;
        if (seen.has(key)) throw badRequest("duplicate owner/SKU/location/lot row");
        seen.add(key);
        targets.push({ key, sku_id: sku.id, location_id: loc.id, owner_id: owner.id, lot, label: `${owner.name} · ${sku.code} @ ${loc.code}${lot ? ` · ${lot}` : ""}`, qty });
      }
      total += qty;
    } catch (e: any) { errors.push(`Line ${line}: ${e.message}`); }
  }
  if (r3(total) !== r3(controlUnits)) errors.push(`Control total mismatch: the file sums to ${r3(total)} units but ${r3(controlUnits)} was declared.`);
  return { targets, errors, total: r3(total), rows: rows.length - 1 };
}

async function currentQty(c: Conn, module: Module, t: Target): Promise<number> {
  if (module === "fulfilment") return Number((await c.query<any>(`SELECT coalesce(sum(on_hand),0) n FROM stock_levels WHERE sku_id=$1 AND location_id=$2`, [t.sku_id, t.location_id])).rows[0].n);
  return Number((await c.query<any>(`SELECT coalesce(sum(qty_on_hand),0) n FROM wh_stock WHERE owner_id=$1 AND sku_id=$2 AND location_id=$3 AND lot=$4`, [t.owner_id, t.sku_id, t.location_id, t.lot])).rows[0].n);
}

async function reservedQty(c: Conn, module: Module, t: Target): Promise<number> {
  if (module === "fulfilment") return Number((await c.query<any>(`SELECT coalesce(sum(reserved),0) n FROM stock_levels WHERE sku_id=$1 AND location_id=$2`, [t.sku_id, t.location_id])).rows[0].n);
  return Number((await c.query<any>(`SELECT coalesce(sum(qty_reserved),0) n FROM wh_stock WHERE owner_id=$1 AND sku_id=$2 AND location_id=$3 AND lot=$4`, [t.owner_id, t.sku_id, t.location_id, t.lot])).rows[0].n);
}

async function diffOf(c: Conn, module: Module, targets: Target[]): Promise<DiffRow[]> {
  const out: DiffRow[] = [];
  for (const t of targets) {
    const current = await currentQty(c, module, t), delta = r3(t.qty - current);
    const row: DiffRow = { key: t.key, label: t.label, current, target: t.qty, delta };
    if (delta < 0 && t.qty < (await reservedQty(c, module, t))) row.problem = "target is below stock already reserved for orders";
    out.push(row);
  }
  return out;
}

export async function stageStockMigration(c: Conn, ctx: Ctx, module: Module, documentId: string, purpose: string, controlUnits: number) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  if (!["fulfilment", "custody"].includes(module)) throw badRequest("Choose fulfilment or custody stock.");
  if (!Number.isFinite(controlUnits) || controlUnits < 0) throw badRequest("Declare the control total of units from the old system.");
  const { doc, csv } = await source(c, documentId);
  const p = await parse(c, module, csv, controlUnits);
  const diff = p.errors.length ? [] : await diffOf(c, module, p.targets);
  const problems = [...p.errors, ...diff.filter((d) => d.problem).map((d) => `${d.label}: ${d.problem}`)];
  const summary = {
    rows: p.rows, total_units: p.total, control_units: r3(controlUnits), errors: problems,
    changes: diff.filter((d) => d.delta !== 0).length, unchanged: diff.filter((d) => d.delta === 0).length,
    net_delta: r3(diff.reduce((s, d) => s + d.delta, 0)),
    note: "Final-delta: stage the same file format again at cutover — only the difference since the first load is adjusted. Positions absent from a later file are left as they are.",
  };
  // an earlier validated-but-unapplied batch for the same module is superseded by the fresh snapshot
  await c.query(`UPDATE stock_migrations SET status='superseded' WHERE module=$1 AND status='validated'`, [module]);
  const id = (await c.query<any>(
    `INSERT INTO stock_migrations(tenant_id,module,purpose,source_document_id,source_hash,control_units,targets,diff,summary,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, module, reqStr(purpose, "Cutover scope", 2000), doc.id, sha256(csv), controlUnits, JSON.stringify(p.targets), JSON.stringify(diff), JSON.stringify(summary), ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "stock_migration.validated", "stock_migration", id, { module, ...summary });
  return id as string;
}

export async function applyStockMigration(c: Conn, ctx: Ctx, id: string, evidence: string) {
  require(ctx, "settings.manage");
  require(ctx, "wh.approve");
  await assertWritable(c, ctx.tenantId);
  const b = await must(c.query<any>(`SELECT * FROM stock_migrations WHERE id=$1 FOR UPDATE`, [recordId(id, "Stock migration")]), "Stock migration");
  if (b.status === "applied") return b.summary;
  if (b.status !== "validated") throw badRequest(`This batch is ${b.status}; stage a fresh snapshot.`);
  if (b.created_by === ctx.userId) throw badRequest("A second person must approve a stock migration.");
  if ((b.summary.errors ?? []).length) throw badRequest("Resolve the snapshot errors, then stage it again.");
  const { csv } = await source(c, b.source_document_id);
  if (sha256(csv) !== b.source_hash) throw badRequest("The source file changed after validation; stage it again.");
  const module = b.module as Module, targets: Target[] = b.targets;
  const fresh = await diffOf(c, module, targets);
  const drift = fresh.filter((d, i) => d.delta !== (b.diff[i]?.delta));
  if (drift.length) throw badRequest(`Stock moved since validation (${drift.slice(0, 3).map((d) => d.label).join("; ")}). Stage the snapshot again.`);
  let posted = 0;
  for (const t of targets) {
    const d = fresh.find((x) => x.key === t.key)!;
    if (!d.delta) continue;
    if (module === "fulfilment") await moveStock(c, ctx, { skuId: t.sku_id, locationId: t.location_id, delta: d.delta, kind: "adjust", refType: "stock_migration", refId: b.id, note: `Migration ${b.id.slice(0, 8)}` });
    else await post(c, ctx, { ownerId: t.owner_id!, skuId: t.sku_id, locationId: t.location_id, lot: t.lot, delta: d.delta, kind: "adjust", refType: "stock_migration", refId: b.id, reason: `Migration ${b.id.slice(0, 8)}`, clientRef: `mig:${b.id}:${t.key}` });
    posted++;
  }
  const summary = { ...b.summary, posted };
  await c.query(`UPDATE stock_migrations SET status='applied', approved_by=$2, evidence=$3, summary=$4, applied_at=now() WHERE id=$1`,
    [b.id, ctx.userId, reqStr(evidence, "Counted-and-signed-off evidence, change freeze and fallback", 3000), JSON.stringify(summary)]);
  await audit(c, ctx.tenantId, actorOf(ctx), "stock_migration.applied", "stock_migration", b.id, { module, posted });
  return summary;
}

export async function listStockMigrations(c: Conn) {
  return (await c.query<any>(`SELECT id,module,purpose,status,control_units,summary,created_at,applied_at FROM stock_migrations ORDER BY created_at DESC LIMIT 50`)).rows;
}
export async function getStockMigration(c: Conn, id: string) {
  return must(c.query<any>(`SELECT * FROM stock_migrations WHERE id=$1`, [recordId(id, "Stock migration")]), "Stock migration");
}
