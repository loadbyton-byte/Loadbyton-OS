import type { Db } from "../db/client.js";

/**
 * Service-console reports, computed from the orders, subscriptions and partner ledger already recorded.
 * No AI-model cost is recorded anywhere in the platform yet, so contribution is revenue − refunds − partner commission and
 * says so. Money is per currency; nothing is converted.
 */
const month = (d: Date) => d.toISOString().slice(0, 7);
const addMonths = (m: string, n: number) => { const [y, mo] = m.split("-").map(Number); return month(new Date(Date.UTC(y, mo - 1 + n, 1))); };

export async function cohortRetention(db: Db, now = new Date()) {
  const rows = (await db.query<any>(
    `SELECT t.id, to_char(t.created_at,'YYYY-MM') AS signup, s.status, s.period_end, s.cancel_at_period_end,
            (SELECT bool_or(o.status='paid') FROM orders o WHERE o.tenant_id=t.id) AS ever_paid
       FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id=t.id ORDER BY t.created_at`)).rows;
  const cur = month(now), by = new Map<string, { signed: number; paid: number; active: number; churned: number }>();
  for (const r of rows) {
    const b = by.get(r.signup) ?? { signed: 0, paid: 0, active: 0, churned: 0 };
    b.signed++;
    if (r.ever_paid) {
      b.paid++;
      const live = r.status === "active" && (!r.period_end || new Date(r.period_end) >= now);
      if (live) b.active++; else b.churned++;
    }
    by.set(r.signup, b);
  }
  return [...by.entries()].sort().map(([signup, b]) => ({
    signup, ...b, retention_pct: b.paid ? Math.round((b.active / b.paid) * 1000) / 10 : null, age_months: Math.max(0, monthsBetween(signup, cur)),
  }));
}
const monthsBetween = (a: string, b: string) => { const [y1, m1] = a.split("-").map(Number), [y2, m2] = b.split("-").map(Number); return (y2 - y1) * 12 + (m2 - m1); };

/** Monthly movement: new / churned / net by plan price, from subscription state and paid-order history. */
export async function revenueMovement(db: Db, months = 6, now = new Date()) {
  const paid = (await db.query<any>(`SELECT tenant_id, currency, to_char(paid_at,'YYYY-MM') AS m, sum(total_minor)::bigint AS gross FROM orders WHERE status IN ('paid','refunded') AND paid_at IS NOT NULL GROUP BY 1,2,3`)).rows;
  const refunds = (await db.query<any>(`SELECT tenant_id, currency, to_char(paid_at,'YYYY-MM') AS m, sum(total_minor)::bigint AS refunded FROM orders WHERE status='refunded' AND paid_at IS NOT NULL GROUP BY 1,2,3`)).rows;
  const cur = month(now), list: string[] = [];
  for (let i = months - 1; i >= 0; i--) list.push(addMonths(cur, -i));
  const seenBefore = new Set<string>();
  const out = [] as { month: string; currency: string; gross: number; refunded: number; net: number; new_tenants: number; returning_tenants: number }[];
  const first = new Map<string, string>();
  for (const p of paid) { const k = p.tenant_id + p.currency, f = first.get(k); if (!f || p.m < f) first.set(k, p.m); }
  const currencies = [...new Set(paid.map((p: any) => p.currency))].sort();
  for (const cu of currencies) for (const m of list) {
    const g = paid.filter((p: any) => p.currency === cu && p.m === m), r = refunds.filter((p: any) => p.currency === cu && p.m === m);
    const gross = g.reduce((s: number, x: any) => s + Number(x.gross), 0), refunded = r.reduce((s: number, x: any) => s + Number(x.refunded), 0);
    const nw = g.filter((x: any) => first.get(x.tenant_id + cu) === m).length;
    out.push({ month: m, currency: cu, gross, refunded, net: gross - refunded, new_tenants: nw, returning_tenants: g.length - nw });
  }
  void seenBefore;
  return out;
}

export async function churnSummary(db: Db, now = new Date()) {
  const rows = (await db.query<any>(
    `SELECT s.status, s.cancel_at_period_end, s.period_end, p.monthly_minor, p.currency FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id WHERE p.monthly_minor>0`)).rows;
  const soon = new Date(now.getTime() + 30 * 86400_000);
  const sum = (f: (r: any) => boolean) => { const m = new Map<string, number>(); let n = 0; for (const r of rows.filter(f)) { n++; m.set(r.currency, (m.get(r.currency) ?? 0) + Number(r.monthly_minor)); } return { count: n, mrr: Object.fromEntries(m) }; };
  return {
    active: sum((r) => r.status === "active" && !r.cancel_at_period_end),
    cancelling: sum((r) => r.status === "active" && r.cancel_at_period_end),
    grace: sum((r) => r.status === "grace"),
    restricted: sum((r) => r.status === "restricted"),
    cancelled: sum((r) => r.status === "cancelled"),
    expiring_30d: sum((r) => r.status === "active" && r.period_end && new Date(r.period_end) <= soon),
  };
}

/** Per-tenant contribution = paid − refunded − partner commission net of reversals (per currency). */
export async function tenantContribution(db: Db) {
  const rows = (await db.query<any>(
    `SELECT t.id, t.name, o.currency,
            coalesce(sum(o.total_minor) FILTER (WHERE o.status IN ('paid','refunded')),0)::bigint AS revenue,
            coalesce(sum(o.total_minor) FILTER (WHERE o.status='refunded'),0)::bigint AS refunds,
            coalesce((SELECT sum(l.amount_minor) FROM partner_ledger l WHERE l.tenant_id=t.id AND l.currency=o.currency AND l.kind IN ('commission','reversal')),0)::bigint AS commission,
            coalesce((SELECT sum(coalesce(a.cost_micro_usd, a.reserved_micro_usd)) FROM assistant_drafts a WHERE a.tenant_id=t.id),0)::bigint AS ai_cost
       FROM tenants t JOIN orders o ON o.tenant_id=t.id AND o.status IN ('paid','refunded')
      GROUP BY t.id, t.name, o.currency ORDER BY t.name`)).rows;
  return rows.map((r: any) => ({ tenant_id: r.id, tenant: r.name, currency: r.currency, revenue: Number(r.revenue), refunds: Number(r.refunds), partner_commission: Number(r.commission),
    contribution: Number(r.revenue) - Number(r.refunds) - Number(r.commission), ai_cost_usd_micro: Number(r.ai_cost) }));
}
