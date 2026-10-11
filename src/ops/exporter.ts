import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import {canReadGeneratedDrafts} from './document-drafts.js';
import {redactFulfilmentRecipient,redactFields} from '../lib/data-policy.js';

const TABLES = ["parties", "enquiries", "rates", "quotes", "quote_versions", "quote_lines", "jobs", "job_charges", "job_costs",
  "job_milestones", "job_exceptions", "documents", "invoices", "invoice_lines", "receipts",
  "entities", "branches", "tenant_sectors", "audit_log",
  "vehicles", "drivers", "compliance_items",
  "maintenance_blocks", "trips", "transport_orders", "transport_order_charges", "trip_legs", "trip_events",
  "trip_expenses", "trip_expense_receipts", "wh_locations", "skus", "stock_levels", "stock_movements", "inbound_shipments",
  "inbound_lines", "inbound_receipts", "fulfil_orders", "fulfil_order_lines", "stock_allocations", "fulfil_shipments",
  "fulfil_returns", "fulfil_return_lines", "fulfil_return_receipts", "stock_adjustments", "fulfil_rates", "fulfil_charges", "fulfil_storage_contracts", "fulfil_storage_days", "fulfil_storage_automation", "fulfil_storage_amendments", "privacy_retention_policies", "privacy_legal_holds", "privacy_minimisation_runs", "dlv_cash_policy", "driver_location_consent", "trip_positions", "transport_feed_imports", "transport_feed_lines", "dlv_bank_statements", "dlv_bank_lines", "dlv_writeoffs", "wh_owner_policy", "wh_owner_terms", "wh_returns", "wh_return_lines", "wh_return_receipts", "fulfil_lots", "stock_lot_levels", "fulfil_pack_serials", "fulfil_lot_decisions", "fulfil_sites", "fulfil_site_transfers", "fulfil_site_transfer_lines", "fulfil_carton_types", "fulfil_order_cartons", "fulfil_order_carton_lines", "fulfil_waves", "fulfil_wave_orders", "fulfil_pick_tasks", "fulfil_kits", "fulfil_kit_components", "fulfil_order_kit_lines", "fulfil_kit_builds", "fulfil_kit_build_lots", "stock_migrations", "opportunities", "opportunity_lanes", "opportunity_quotes", "opportunity_events", "rate_tiers", "supplier_contracts", "supplier_policy", "freight_masters", "freight_master_costs", "freight_master_allocations",
  "warehouses", "warehouse_locations", "wh_skus", "wh_stock", "wh_movements", "wh_inbound",
  "wh_inbound_lines", "wh_outbound", "wh_outbound_lines", "wh_allocations", "wh_counts", "wh_count_lines",
  "wh_rates", "wh_billing_runs", "wh_charges", "wh_count_schedules", "wh_count_schedule_runs", "dlv_runs", "dlv_shipments", "dlv_events", "dlv_settlements", "dlv_remittances", "dlv_collections", "dlv_rates", "dlv_billing_runs", "dlv_charges",
  "cus_cases", "cus_lines", "cus_checklist", "cus_inspections", "cus_queries", "cus_events", "cus_deposits", "cus_payments", "cus_deposit_apps", "cus_charges", "data_requests", "setup_orders", "specialist_reviews", "specialist_cases", "specialist_events", "business_calendars", "conversations", "conversation_messages", "migration_batches", "wh_lots", "weight_rules", "weight_assessments", "document_templates", "generated_documents"];

/** Data export is available on every plan (including Free and after downgrade): depth is charged, retrieval is not. */
export async function exportTenantData(c: Conn, ctx: Ctx) {
  require(ctx, "export");
  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), tenant_id: ctx.tenantId };
  for (const t of TABLES) {const rows=(await c.query(`SELECT * FROM ${t}`)).rows;out[t]=['generated_documents','document_templates'].includes(t)&&!canReadGeneratedDrafts(ctx)?[]:t==='fulfil_orders'?rows.map(row=>redactFulfilmentRecipient(row,ctx)):rows.map(row=>redactFields(t,row,ctx));}
  await audit(c, ctx.tenantId, actorOf(ctx), "data.exported", "tenant", ctx.tenantId);
  return out;
}

const esc = (v: unknown) => {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export async function invoicesCsv(c: Conn, ctx: Ctx) {
  require(ctx, "export");
  const r = await c.query<any>(`SELECT i.no, p.name AS customer, i.issued_at, i.due_at, i.currency, i.subtotal_minor, i.tax_minor, i.total_minor, i.paid_minor, i.status, i.external_id, i.sync_status
    FROM invoices i JOIN parties p ON p.id=i.party_id ORDER BY i.issued_at`);
  const head = "invoice_no,customer,issued_at,due_at,currency,subtotal,tax,total,paid,status,external_id,sync_status";
  const rows = r.rows.map((x) => [x.no, x.customer, x.issued_at, x.due_at, x.currency, x.subtotal_minor / 100, x.tax_minor / 100, x.total_minor / 100, x.paid_minor / 100, x.status, x.external_id, x.sync_status].map(esc).join(","));
  return [head, ...rows].join("\n");
}
