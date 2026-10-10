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
    ["a trip carries only orders that point back at it", `SELECT l.id::text FROM trip_legs l JOIN transport_orders o ON o.id=l.order_id WHERE o.trip_id IS DISTINCT FROM l.trip_id`],
    ["delivered orders have a recorded proof of delivery", `SELECT o.id::text FROM transport_orders o WHERE o.status='delivered' AND NOT EXISTS (SELECT 1 FROM trip_legs l WHERE l.order_id=o.id AND l.kind='delivery' AND l.pod_name IS NOT NULL)`],
    ["completed legs have arrival and departure", `SELECT id::text FROM trip_legs WHERE status='done' AND (arrived_at IS NULL OR departed_at IS NULL)`],
    ["trips are fleet XOR subcontract and completed trips have no open stops", `SELECT t.id::text FROM trips t WHERE t.status='completed' AND EXISTS (SELECT 1 FROM trip_legs l WHERE l.trip_id=t.id AND l.status<>'done')`],
    ["transport invoices total their order charges", `SELECT i.id::text FROM invoices i WHERE i.transport_order_id IS NOT NULL AND i.status<>'void' AND i.subtotal_minor <> (SELECT coalesce(sum(round(ch.qty*ch.unit_minor)),0) FROM transport_order_charges ch WHERE ch.invoice_id=i.id)`],
    // ── E-commerce fulfilment (stock integrity)
    ["on_hand equals the sum of its ledger movements", `SELECT l.sku_id::text||'@'||l.location_id::text FROM stock_levels l WHERE l.on_hand <> coalesce((SELECT sum(m.delta) FROM stock_movements m WHERE m.tenant_id=l.tenant_id AND m.sku_id=l.sku_id AND m.location_id=l.location_id),0)`],
    ["ledger movements always land on a stock level", `SELECT m.sku_id::text||'@'||m.location_id::text FROM stock_movements m WHERE NOT EXISTS (SELECT 1 FROM stock_levels l WHERE l.tenant_id=m.tenant_id AND l.sku_id=m.sku_id AND l.location_id=m.location_id) GROUP BY m.sku_id, m.location_id HAVING sum(m.delta) <> 0`],
    ["reserved equals the unpicked part of allocations", `SELECT l.sku_id::text||'@'||l.location_id::text FROM stock_levels l WHERE l.reserved <> coalesce((SELECT sum(a.qty - a.picked_qty) FROM stock_allocations a WHERE a.tenant_id=l.tenant_id AND a.sku_id=l.sku_id AND a.location_id=l.location_id),0)`],
    ["open allocations point at a stock level", `SELECT a.id::text FROM stock_allocations a WHERE a.qty > a.picked_qty AND NOT EXISTS (SELECT 1 FROM stock_levels l WHERE l.tenant_id=a.tenant_id AND l.sku_id=a.sku_id AND l.location_id=a.location_id)`],
    ["order lines match their allocations", `SELECT l.id::text FROM fulfil_order_lines l WHERE l.allocated_qty <> coalesce((SELECT sum(a.qty) FROM stock_allocations a WHERE a.line_id=l.id),0) OR l.picked_qty <> coalesce((SELECT sum(a.picked_qty) FROM stock_allocations a WHERE a.line_id=l.id),0)`],
    ["staging holds exactly the picked-not-shipped units", `SELECT s.id::text FROM skus s WHERE coalesce((SELECT sum(l.on_hand) FROM stock_levels l JOIN wh_locations x ON x.id=l.location_id WHERE l.sku_id=s.id AND x.kind='staging'),0) <> coalesce((SELECT sum(ol.picked_qty) FROM fulfil_order_lines ol JOIN fulfil_orders o ON o.id=ol.order_id WHERE ol.sku_id=s.id AND o.status NOT IN ('shipped','cancelled')),0)`],
    ["shipped orders have one shipment and shipped = packed", `SELECT o.id::text FROM fulfil_orders o WHERE (o.status='shipped' AND (NOT EXISTS (SELECT 1 FROM fulfil_shipments sh WHERE sh.order_id=o.id) OR EXISTS (SELECT 1 FROM fulfil_order_lines l WHERE l.order_id=o.id AND l.shipped_qty <> l.packed_qty))) OR (o.status<>'shipped' AND EXISTS (SELECT 1 FROM fulfil_shipments sh WHERE sh.order_id=o.id))`],
    ["order and inbound lines use SKUs of the same merchant", `SELECT l.id::text FROM fulfil_order_lines l JOIN fulfil_orders o ON o.id=l.order_id JOIN skus s ON s.id=l.sku_id WHERE s.party_id<>o.party_id UNION ALL SELECT l.id::text FROM inbound_lines l JOIN inbound_shipments i ON i.id=l.inbound_id JOIN skus s ON s.id=l.sku_id WHERE s.party_id<>i.party_id`],
    ["inbound lines equal their receipts", `SELECT l.id::text FROM inbound_lines l WHERE l.received_qty <> coalesce((SELECT sum(r.good_qty) FROM inbound_receipts r WHERE r.line_id=l.id),0) OR l.damaged_qty <> coalesce((SELECT sum(r.damaged_qty) FROM inbound_receipts r WHERE r.line_id=l.id),0)`],
    ["return lines equal their receipts", `SELECT l.id::text FROM fulfil_return_lines l WHERE l.restocked_qty <> coalesce((SELECT sum(r.qty) FROM fulfil_return_receipts r WHERE r.line_id=l.id AND r.disposition='restock'),0) OR l.quarantined_qty <> coalesce((SELECT sum(r.qty) FROM fulfil_return_receipts r WHERE r.line_id=l.id AND r.disposition='quarantine'),0) OR l.disposed_qty <> coalesce((SELECT sum(r.qty) FROM fulfil_return_receipts r WHERE r.line_id=l.id AND r.disposition='dispose'),0)`],
    ["fulfilment invoices total their charges", `SELECT i.id::text FROM invoices i WHERE i.status<>'void' AND EXISTS (SELECT 1 FROM fulfil_charges ch WHERE ch.invoice_id=i.id) AND i.subtotal_minor <> (SELECT sum(ch.qty*ch.unit_minor) FROM fulfil_charges ch WHERE ch.invoice_id=i.id)`],
    ["void invoices hold no fulfilment charges", `SELECT ch.id::text FROM fulfil_charges ch JOIN invoices i ON i.id=ch.invoice_id WHERE i.status='void'`],
    ["stock balance = sum of its ledger movements", `SELECT s.id::text FROM wh_stock s WHERE s.qty_on_hand <> coalesce((SELECT sum(m.qty_delta) FROM wh_movements m WHERE m.owner_id=s.owner_id AND m.sku_id=s.sku_id AND m.location_id=s.location_id AND m.lot=s.lot),0)`],
    ["every ledger movement has a stock row", `SELECT m.id::text FROM wh_movements m WHERE NOT EXISTS (SELECT 1 FROM wh_stock s WHERE s.owner_id=m.owner_id AND s.sku_id=m.sku_id AND s.location_id=m.location_id AND s.lot=m.lot)`],
    ["reserved stock = open allocations", `SELECT s.id::text FROM wh_stock s WHERE s.qty_reserved <> coalesce((SELECT sum(a.qty) FROM wh_allocations a WHERE a.stock_id=s.id AND a.status IN ('reserved','picked')),0)`],
    ["stock is held only for the owner of its SKU", `SELECT s.id::text FROM wh_stock s JOIN wh_skus k ON k.id=s.sku_id WHERE k.owner_id <> s.owner_id`],
    ["transfers net to zero", `SELECT group_id::text FROM wh_movements WHERE group_id IS NOT NULL GROUP BY group_id HAVING sum(qty_delta) <> 0`],
    ["received quantities match the receipt ledger", `SELECT l.id::text FROM wh_inbound_lines l WHERE l.qty_received + l.qty_damaged <> coalesce((SELECT sum(m.qty_delta) FROM wh_movements m WHERE m.kind='receipt' AND m.ref_id=l.inbound_id AND m.sku_id=l.sku_id),0)`],
    ["dispatched quantities match the dispatch ledger", `SELECT l.id::text FROM wh_outbound_lines l JOIN wh_outbound o ON o.id=l.outbound_id WHERE o.status='dispatched' AND l.qty_dispatched <> coalesce((SELECT -sum(m.qty_delta) FROM wh_movements m WHERE m.kind='dispatch' AND m.ref_id=o.id AND m.sku_id=l.sku_id),0)`],
    ["warehouse charges point at live invoices of the same customer", `SELECT g.id::text FROM wh_charges g JOIN invoices i ON i.id=g.invoice_id WHERE i.status='void' OR i.party_id <> g.owner_id`],
    // lines are grouped by (type, rate, tax) and rounded once per line, so allow one minor unit of rounding per group
    ["warehouse invoices total their charges", `SELECT i.id::text FROM invoices i WHERE i.wh_run_id IS NOT NULL AND i.status<>'void' AND abs(i.subtotal_minor - (SELECT coalesce(sum(g.n),0) FROM (SELECT round(sum(qty)*unit_minor) AS n FROM wh_charges WHERE invoice_id=i.id GROUP BY charge_type, unit_minor, tax_code) g)) > (SELECT count(*) FROM invoice_lines l WHERE l.invoice_id=i.id)`],
    ["documents are stored under their tenant prefix", `SELECT id::text FROM documents WHERE storage_key NOT LIKE tenant_id::text || '/%'`],
  ];
  const out: Violation[] = [];
  for (const [check, sql] of checks) {
    const r = await db.query<any>(sql);
    for (const row of r.rows) out.push({ check, detail: String(Object.values(row)[0]) });
  }
  return out;
}
