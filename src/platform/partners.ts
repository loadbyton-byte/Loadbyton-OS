import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { badRequest } from "../lib/util.js";
import { must, recordId, reqStr } from "../ops/common.js";

/**
 * Partner commission and refund ledger. Platform-owned and append-only: commission accrues on each paid order of a referred
 * tenant for a limited number of months, a refund posts an exact reversal, and a payout is a second-person-approved negative
 * entry. Rates and terms come from the signed agreement the staff member records; nothing here sets commercial policy.
 */
export interface Staff { userId: string }

export async function createPartner(c: Conn, s: Staff, f: Record<string, any>) {
  const bps = Number(f.commission_bps), months = Number(f.commission_months);
  if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw badRequest("Commission is 0–50% (basis points).");
  if (!Number.isInteger(months) || months < 1 || months > 36) throw badRequest("Commission period is 1–36 months.");
  const id = (await c.query<any>(`INSERT INTO partners(name,email,commission_bps,commission_months,agreement_ref,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [reqStr(f.name, "Partner name", 120), f.email ? reqStr(f.email, "Email", 200) : null, bps, months, reqStr(f.agreement_ref, "Signed agreement reference", 300), s.userId])).rows[0].id;
  await audit(c, null, { kind: "platform_staff", userId: s.userId }, "partner.created", "partner", id, { bps, months });
  return id as string;
}

export async function recordReferral(c: Conn, s: Staff, partnerId: string, tenantId: string, evidence: string) {
  const p = await must(c.query<any>(`SELECT * FROM partners WHERE id=$1`, [recordId(partnerId, "Partner")]), "Partner");
  if (p.status !== "active") throw badRequest("This partner is suspended.");
  await must(c.query<any>(`SELECT id FROM tenants WHERE id=$1`, [recordId(tenantId, "Tenant")]), "Tenant");
  const dup = await c.query(`SELECT 1 FROM partner_referrals WHERE tenant_id=$1`, [tenantId]);
  if (dup.rows.length) throw badRequest("This customer already has a recorded referral; it cannot be reassigned.");
  await c.query(`INSERT INTO partner_referrals(tenant_id,partner_id,evidence,recorded_by) VALUES ($1,$2,$3,$4)`, [tenantId, p.id, reqStr(evidence, "Referral evidence", 1000), s.userId]);
  await audit(c, tenantId, { kind: "platform_staff", userId: s.userId }, "partner.referral", "partner", p.id);
}

/** Called inside the payment transaction. Idempotent per order (source_key). */
export async function accrueCommission(c: Conn, order: { id: string; tenant_id: string; total_minor: number | string; currency: string; paid_at?: Date | string | null }) {
  const ref = (await c.query<any>(
    `SELECT r.partner_id, r.referred_at, p.commission_bps, p.commission_months, p.status FROM partner_referrals r JOIN partners p ON p.id=r.partner_id WHERE r.tenant_id=$1`, [order.tenant_id])).rows[0];
  if (!ref || ref.status !== "active" || !ref.commission_bps) return null;
  const window = (await c.query<any>(`SELECT (now() <= $1::timestamptz + make_interval(months => $2)) AS ok`, [ref.referred_at, ref.commission_months])).rows[0].ok;
  if (!window) return null;
  const basis = Number(order.total_minor), amount = Math.round(basis * ref.commission_bps / 10000);
  if (amount <= 0) return null;
  const r = await c.query<any>(
    `INSERT INTO partner_ledger(partner_id,tenant_id,order_id,kind,currency,amount_minor,basis_minor,source_key,note) VALUES ($1,$2,$3,'commission',$4,$5,$6,$7,$8)
     ON CONFLICT (source_key) DO NOTHING RETURNING id`,
    [ref.partner_id, order.tenant_id, order.id, order.currency, amount, basis, `commission:${order.id}`, `${ref.commission_bps / 100}% of paid order`]);
  return r.rows[0]?.id ?? null;
}

/** A refund reverses exactly what was accrued for that order — never more. */
export async function reverseCommission(c: Conn, orderId: string) {
  const acc = (await c.query<any>(`SELECT * FROM partner_ledger WHERE source_key=$1`, [`commission:${orderId}`])).rows[0];
  if (!acc) return null;
  const r = await c.query<any>(
    `INSERT INTO partner_ledger(partner_id,tenant_id,order_id,kind,currency,amount_minor,basis_minor,source_key,note) VALUES ($1,$2,$3,'reversal',$4,$5,$6,$7,'Order refunded')
     ON CONFLICT (source_key) DO NOTHING RETURNING id`,
    [acc.partner_id, acc.tenant_id, orderId, acc.currency, -Number(acc.amount_minor), acc.basis_minor, `reversal:${orderId}`]);
  return r.rows[0]?.id ?? null;
}

export async function partnerBalances(c: Conn) {
  return (await c.query<any>(
    `SELECT p.id, p.name, p.status, p.commission_bps, p.commission_months, l.currency,
            coalesce(sum(l.amount_minor) FILTER (WHERE l.kind='commission'),0)::bigint AS earned,
            coalesce(sum(l.amount_minor) FILTER (WHERE l.kind='reversal'),0)::bigint AS reversed,
            coalesce(sum(l.amount_minor) FILTER (WHERE l.kind='payout'),0)::bigint AS paid,
            coalesce(sum(l.amount_minor),0)::bigint AS owed,
            (SELECT coalesce(sum(x.amount_minor),0) FROM partner_payouts x WHERE x.partner_id=p.id AND x.currency=l.currency AND x.status='requested')::bigint AS pending
       FROM partners p LEFT JOIN partner_ledger l ON l.partner_id=p.id GROUP BY p.id, l.currency ORDER BY p.name`)).rows;
}

export async function requestPayout(c: Conn, s: Staff, partnerId: string, currency: string, amountMinor: number) {
  const bal = (await partnerBalances(c)).find((b: any) => b.id === partnerId && b.currency === currency);
  const open = Number(bal?.owed ?? 0) - Number(bal?.pending ?? 0);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw badRequest("Enter a payout amount.");
  if (amountMinor > open) throw badRequest("A payout cannot exceed the commission balance not already requested.");
  return (await c.query<any>(`INSERT INTO partner_payouts(partner_id,currency,amount_minor,requested_by) VALUES ($1,$2,$3,$4) RETURNING id`, [partnerId, currency, amountMinor, s.userId])).rows[0].id as string;
}

export async function decidePayout(c: Conn, s: Staff, payoutId: string, approve: boolean, reference?: string) {
  const p = await must(c.query<any>(`SELECT * FROM partner_payouts WHERE id=$1 FOR UPDATE`, [recordId(payoutId, "Payout")]), "Payout");
  if (p.status !== "requested") throw badRequest(`This payout is already ${p.status}.`);
  if (p.requested_by === s.userId) throw badRequest("A second person must decide a payout.");
  if (!approve) { await c.query(`UPDATE partner_payouts SET status='rejected', decided_by=$2, decided_at=now() WHERE id=$1`, [p.id, s.userId]); return; }
  const ref = reqStr(reference, "Bank transfer reference", 200);
  await c.query(`UPDATE partner_payouts SET status='paid', reference=$3, decided_by=$2, decided_at=now() WHERE id=$1`, [p.id, s.userId, ref]);
  await c.query(`INSERT INTO partner_ledger(partner_id,currency,kind,amount_minor,source_key,note,created_by) VALUES ($1,$2,'payout',$3,$4,$5,$6)`,
    [p.partner_id, p.currency, -Number(p.amount_minor), `payout:${p.id}`, `Paid ${ref}`, s.userId]);
  await audit(c, null, { kind: "platform_staff", userId: s.userId }, "partner.payout", "partner", p.partner_id, { amount: p.amount_minor });
}
