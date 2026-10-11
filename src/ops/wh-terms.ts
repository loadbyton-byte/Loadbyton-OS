import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, forbidden } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";

const today = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const aed = (m: number | string) => (Number(m) / 100).toFixed(2);

// ───────────── owner policy: backorders and returns
export interface OwnerPolicy { backorder_policy: "close" | "backorder"; returns_policy: "not_accepted" | "quarantine_inspect" }
export async function getOwnerPolicy(c: Conn, ownerId: string): Promise<OwnerPolicy> {
  const r = (await c.query<any>(`SELECT backorder_policy, returns_policy FROM wh_owner_policy WHERE owner_id=$1`, [ownerId])).rows[0];
  return r ?? { backorder_policy: "close", returns_policy: "not_accepted" };
}
export async function setOwnerPolicy(c: Conn, ctx: Ctx, ownerId: string, f: Record<string, any>) {
  require(ctx, "wh.approve");
  await assertWritable(c, ctx.tenantId);
  const owner = await must(c.query<any>(`SELECT id, kind FROM parties WHERE id=$1`, [recordId(ownerId, "Customer")]), "Customer");
  if (owner.kind !== "customer") throw badRequest("Policies belong to a customer.");
  const cur = await getOwnerPolicy(c, owner.id);
  const backorder = f.backorder_policy ?? cur.backorder_policy, returns = f.returns_policy ?? cur.returns_policy;
  if (!["close", "backorder"].includes(backorder) || !["not_accepted", "quarantine_inspect"].includes(returns)) throw badRequest("Choose a valid backorder and returns policy.");
  await c.query(
    `INSERT INTO wh_owner_policy(tenant_id,owner_id,backorder_policy,returns_policy,updated_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id,owner_id) DO UPDATE SET backorder_policy=$3, returns_policy=$4, updated_by=$5, updated_at=now()`, [ctx.tenantId, owner.id, backorder, returns, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_policy.set", "party", owner.id, { backorder, returns });
}

// ───────────── approved bonded / liability terms
export interface Terms { id: string; bonded: boolean; liability_cap_minor: number | null; valid_until: string }
export async function activeTerms(c: Conn, ownerId: string, day = today()): Promise<Terms | null> {
  const r = (await c.query<any>(`SELECT id, bonded, liability_cap_minor, valid_until FROM wh_owner_terms WHERE owner_id=$1 AND valid_from<=$2::date AND valid_until>=$2::date ORDER BY valid_from DESC LIMIT 1`, [ownerId, day])).rows[0];
  return r ? { id: r.id, bonded: r.bonded, liability_cap_minor: r.liability_cap_minor === null ? null : Number(r.liability_cap_minor), valid_until: String(r.valid_until) } : null;
}
/**
 * Record executed bonded-storage / liability-cap terms for a customer. Terms are immutable, backed by an issued document, reviewed by
 * a named person, and may not overlap in time. A cap of AED X is the most declared stock value the warehouse will hold for the customer.
 */
export async function approveOwnerTerms(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "wh.approve");
  await assertWritable(c, ctx.tenantId);
  if (!ctx.roles.includes("owner") && !ctx.roles.includes("finance")) throw forbidden("Bonded and liability terms are approved by the owner or finance.");
  const owner = await must(c.query<any>(`SELECT id, kind FROM parties WHERE id=$1`, [recordId(f.owner_id, "Customer")]), "Customer");
  if (owner.kind !== "customer") throw badRequest("Terms belong to a customer.");
  const from = String(f.valid_from ?? ""), until = String(f.valid_until ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || until < from) throw badRequest("Choose valid start and end dates.");
  const cap = f.liability_cap === undefined || String(f.liability_cap).trim() === "" ? null : Math.round(Number(String(f.liability_cap).replace(/,/g, "")) * 100);
  if (cap !== null && !(cap > 0)) throw badRequest("The liability cap must be above zero (or blank for none).");
  const bonded = f.bonded === true || f.bonded === "1" || f.bonded === "on";
  if (!bonded && cap === null) throw badRequest("Terms must set bonded storage, a liability cap, or both.");
  const ref = recordId(f.reference, "Terms reference"), doc = recordId(f.document_id, "Executed terms document");
  await must(c.query(`SELECT id FROM documents WHERE id=$1 AND status='issued' AND NOT hold`, [doc]), "Issued executed terms");
  const old = (await c.query<any>(`SELECT * FROM wh_owner_terms WHERE reference=$1`, [ref])).rows[0];
  const reviewer = reqStr(f.reviewer, "Terms reviewer", 200), scope = reqStr(f.scope, "What the terms cover (locations, goods, insurer, cap basis)", 2000);
  if (old) {
    if (old.owner_id !== owner.id || String(old.valid_from).slice(0, 10) !== from || String(old.valid_until).slice(0, 10) !== until || old.bonded !== bonded || (old.liability_cap_minor === null ? null : Number(old.liability_cap_minor)) !== cap || old.document_id !== doc) throw new HttpError(409, "That reference belongs to different terms.", "conflict");
    return old.id as string;
  }
  if ((await c.query(`SELECT 1 FROM wh_owner_terms WHERE owner_id=$1 AND valid_from<=$3::date AND valid_until>=$2::date`, [owner.id, from, until])).rows.length) throw badRequest("Approved terms already cover part of this period. Record non-overlapping terms.");
  const id = (await c.query<{ id: string }>(`INSERT INTO wh_owner_terms(tenant_id,reference,owner_id,valid_from,valid_until,bonded,liability_cap_minor,document_id,reviewer,scope,approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ctx.tenantId, ref, owner.id, from, until, bonded, cap, doc, reviewer, scope, ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_terms.approved", "party", owner.id, { id, bonded, cap, from, until });
  return id;
}

export async function setSkuDeclaredValue(c: Conn, ctx: Ctx, skuId: string, amount: unknown) {
  require(ctx, "wh.write");
  const v = amount === "" || amount === null || amount === undefined ? null : Math.round(Number(String(amount).replace(/,/g, "")) * 100);
  if (v !== null && !(v > 0 && v <= 1_000_000_000)) throw badRequest("The declared unit value must be a positive AED amount.");
  const sku = await must(c.query<any>(`SELECT id, code FROM wh_skus WHERE id=$1`, [recordId(skuId, "SKU")]), "SKU");
  await c.query(`UPDATE wh_skus SET declared_unit_minor=$2 WHERE id=$1`, [sku.id, v]);
  await audit(c, ctx.tenantId, actorOf(ctx), "wh_sku.declared_value_set", "wh_sku", sku.id, { code: sku.code, value_minor: v });
}
export async function setLocationBonded(c: Conn, ctx: Ctx, locationId: string, bonded: boolean) {
  require(ctx, "wh.approve");
  const loc = await must(c.query<any>(`SELECT * FROM warehouse_locations WHERE id=$1 FOR UPDATE`, [recordId(locationId, "Location")]), "Location");
  if (loc.bonded === bonded) return;
  if ((await c.query(`SELECT 1 FROM wh_stock WHERE location_id=$1 AND qty_on_hand>0`, [loc.id])).rows.length) throw badRequest(`${loc.code} holds stock; move it before changing its bonded status.`);
  await c.query(`UPDATE warehouse_locations SET bonded=$2 WHERE id=$1`, [loc.id, bonded]);
  await audit(c, ctx.tenantId, actorOf(ctx), bonded ? "wh_location.bonded" : "wh_location.unbonded", "warehouse_location", loc.id);
}

/** Enforced inside the single stock-posting path: bonded segregation on every inbound leg and the liability cap on receipts. */
export async function assertStorageTerms(c: Conn, p: { ownerId: string; skuId: string; locationId: string; delta: number; kind: string }) {
  if (p.delta <= 0) return;
  const loc = (await c.query<any>(`SELECT code, bonded FROM warehouse_locations WHERE id=$1`, [p.locationId])).rows[0];
  const terms = await activeTerms(c, p.ownerId);
  if (loc.bonded && !terms?.bonded) throw badRequest(`${loc.code} is a bonded location. This customer has no approved bonded-storage terms in force.`);
  if (terms?.bonded && !loc.bonded) throw badRequest(`This customer's goods are bonded and must stay in bonded locations; ${loc.code} is not bonded.`);
  if (p.kind === "receipt" && terms?.liability_cap_minor) {
    const sku = (await c.query<any>(`SELECT code, declared_unit_minor FROM wh_skus WHERE id=$1`, [p.skuId])).rows[0];
    if (sku.declared_unit_minor === null) throw badRequest(`${sku.code} needs a declared unit value: this customer's liability cap applies to declared stock value.`);
    const cur = (await c.query<any>(`SELECT coalesce(sum(s.qty_on_hand * k.declared_unit_minor),0)::float8 v, count(*) FILTER (WHERE s.qty_on_hand>0 AND k.declared_unit_minor IS NULL)::int missing
      FROM wh_stock s JOIN wh_skus k ON k.id=s.sku_id WHERE s.owner_id=$1`, [p.ownerId])).rows[0];
    if (cur.missing) throw badRequest("Some of this customer's stock has no declared unit value, so the liability cap cannot be checked. Declare the values first.");
    const after = cur.v + p.delta * Number(sku.declared_unit_minor);
    if (after > terms.liability_cap_minor) throw badRequest(`Receiving this would take declared stock to AED ${aed(Math.round(after))}, above the AED ${aed(terms.liability_cap_minor)} liability cap. Agree higher cover (new approved terms) first.`);
  }
}

/** Exposure of each customer against its cap. */
export async function exposureReport(c: Conn) {
  const owners = (await c.query<any>(`SELECT p.id, p.name FROM parties p WHERE p.kind='customer' AND EXISTS (SELECT 1 FROM wh_stock s WHERE s.owner_id=p.id AND s.qty_on_hand>0) ORDER BY p.name`)).rows;
  const out: any[] = [];
  for (const o of owners) {
    const v = (await c.query<any>(`SELECT coalesce(sum(s.qty_on_hand * k.declared_unit_minor),0)::float8 v, count(*) FILTER (WHERE s.qty_on_hand>0 AND k.declared_unit_minor IS NULL)::int missing FROM wh_stock s JOIN wh_skus k ON k.id=s.sku_id WHERE s.owner_id=$1`, [o.id])).rows[0];
    const t = await activeTerms(c, o.id);
    out.push({ owner_id: o.id, owner: o.name, declared_minor: Math.round(v.v), undeclared_skus: v.missing, bonded: !!t?.bonded, cap_minor: t?.liability_cap_minor ?? null, terms_until: t?.valid_until ?? null,
      used_pct: t?.liability_cap_minor ? Math.round((v.v / t.liability_cap_minor) * 100) : null });
  }
  return out;
}
export const termsHistory = (c: Conn) => c.query<any>(`SELECT t.*, p.name AS owner, d.title AS document FROM wh_owner_terms t JOIN parties p ON p.id=t.owner_id JOIN documents d ON d.id=t.document_id ORDER BY t.valid_from DESC LIMIT 100`).then((r) => r.rows);
export const listOwnerPolicies = (c: Conn) => c.query<any>(`SELECT p.id, p.name, coalesce(w.backorder_policy,'close') AS backorder_policy, coalesce(w.returns_policy,'not_accepted') AS returns_policy FROM parties p LEFT JOIN wh_owner_policy w ON w.owner_id=p.id WHERE p.kind='customer' ORDER BY p.name`).then((r) => r.rows);
