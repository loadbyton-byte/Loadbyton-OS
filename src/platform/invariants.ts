import type { Db } from "../db/client.js";

export interface Violation { check: string; detail: string }

/**
 * Database-wide invariants (blueprint §20/§30). Run after every restore test and on a schedule:
 * a green backup job is not enough — the restored data must still reconcile.
 */
export async function verifyInvariants(db: Db): Promise<Violation[]> {
  const checks: [string, string][] = [
    ["invoice total = subtotal + tax", `SELECT id::text AS detail FROM invoices WHERE total_minor <> subtotal_minor + tax_minor`],
    ["invoice subtotal = sum of lines", `SELECT i.id::text FROM invoices i WHERE subtotal_minor <> (SELECT coalesce(sum(net_minor),0) FROM invoice_lines l WHERE l.invoice_id=i.id)`],
    ["invoice tax = sum of line tax", `SELECT i.id::text FROM invoices i WHERE tax_minor <> (SELECT coalesce(sum(tax_minor),0) FROM invoice_lines l WHERE l.invoice_id=i.id)`],
    ["paid = sum of receipts", `SELECT i.id::text FROM invoices i WHERE paid_minor <> (SELECT coalesce(sum(amount_minor),0) FROM receipts r WHERE r.invoice_id=i.id)`],
    ["paid never exceeds total", `SELECT id::text FROM invoices WHERE paid_minor > total_minor`],
    ["charges point at live invoices of the same job", `SELECT g.id::text FROM job_charges g JOIN invoices i ON i.id=g.invoice_id WHERE i.status='void' OR i.job_id <> g.job_id`],
    ["one job per quote", `SELECT quote_id::text FROM jobs WHERE quote_id IS NOT NULL GROUP BY quote_id HAVING count(*) > 1`],
    ["jobs have a customer in the same tenant", `SELECT j.id::text FROM jobs j JOIN parties p ON p.id=j.party_id WHERE p.tenant_id <> j.tenant_id`],
    ["every tenant has a subscription and entitlements", `SELECT t.id::text FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id=t.id) OR NOT EXISTS (SELECT 1 FROM entitlements e WHERE e.tenant_id=t.id)`],
    ["every active tenant has an owner", `SELECT t.id::text FROM tenants t WHERE t.status='active' AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=t.id AND m.active AND 'owner'=ANY(m.roles))`],
    ["a hostname maps to one live tenant", `SELECT hostname FROM domain_mappings WHERE status<>'removed' GROUP BY hostname HAVING count(*) > 1`],
    ["paid orders have exactly one provisioning job", `SELECT o.id::text FROM orders o WHERE o.status='paid' AND (SELECT count(*) FROM provision_jobs j WHERE j.order_id=o.id) <> 1`],
    ["one applied event per paid order", `SELECT o.id::text FROM orders o WHERE (SELECT count(*) FROM payment_events e WHERE e.order_id=o.id AND e.type='payment.succeeded' AND e.outcome='applied') > 1`],
    ["locked quote versions have lines", `SELECT v.id::text FROM quote_versions v WHERE v.locked AND NOT EXISTS (SELECT 1 FROM quote_lines l WHERE l.version_id=v.id)`],
    ["documents are stored under their tenant prefix", `SELECT id::text FROM documents WHERE storage_key NOT LIKE tenant_id::text || '/%'`],
  ];
  const out: Violation[] = [];
  for (const [check, sql] of checks) {
    const r = await db.query<any>(sql);
    for (const row of r.rows) out.push({ check, detail: String(Object.values(row)[0]) });
  }
  return out;
}
