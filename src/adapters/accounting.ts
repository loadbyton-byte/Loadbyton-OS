import type { Db } from "../db/client.js";
import type { OutboxHandlers } from "../platform/outbox.js";

export interface AccountingInvoice {
  reference: string; customer: string; issuedAt: string; dueAt: string; currency: string;
  subtotalMinor: number; taxMinor: number; totalMinor: number;
  lines: { description: string; qty: number; unitMinor: number; taxCode: string }[];
}
/**
 * System-of-record bridge. `find` MUST be consulted before `create` so a retry after a timeout reconciles the
 * invoice that was already created instead of posting a second one.
 */
export interface AccountingAdapter {
  find(reference: string): Promise<{ externalId: string } | null>;
  create(inv: AccountingInvoice): Promise<{ externalId: string }>;
}

/** Default: no external ledger. Marks invoices as exported with a deterministic external id (owner exports CSV). */
export const csvExportAdapter: AccountingAdapter = {
  async find(reference) { return { externalId: `EXPORT-${reference}` }; },
  async create(inv) { return { externalId: `EXPORT-${inv.reference}` }; },
};

export function accountingHandlers(db: Db, adapter: AccountingAdapter = csvExportAdapter): OutboxHandlers {
  return {
    async "accounting.invoice"(row) {
      const invId = row.payload.invoiceId as string;
      const inv = (await db.query<any>(`SELECT i.*, p.name AS customer FROM invoices i JOIN parties p ON p.id=i.party_id WHERE i.id=$1`, [invId])).rows[0];
      if (!inv) throw new Error("invoice not found");
      if (inv.external_id) { await db.query(`UPDATE invoices SET sync_status='synced' WHERE id=$1`, [invId]); return { externalId: inv.external_id }; }
      const lines = (await db.query<any>(`SELECT * FROM invoice_lines WHERE invoice_id=$1`, [invId])).rows;
      const payload: AccountingInvoice = {
        reference: inv.no, customer: inv.customer, issuedAt: new Date(inv.issued_at).toISOString(), dueAt: new Date(inv.due_at).toISOString(),
        currency: inv.currency, subtotalMinor: Number(inv.subtotal_minor), taxMinor: Number(inv.tax_minor), totalMinor: Number(inv.total_minor),
        lines: lines.map((l) => ({ description: l.description, qty: Number(l.qty), unitMinor: Number(l.unit_minor), taxCode: l.tax_code })),
      };
      try {
        const found = await adapter.find(inv.no);
        const res = found ?? (await adapter.create(payload));
        await db.query(`UPDATE invoices SET external_id=$2, sync_status='synced' WHERE id=$1`, [invId, res.externalId]);
        return { externalId: res.externalId };
      } catch (e) {
        await db.query(`UPDATE invoices SET sync_status='failed' WHERE id=$1`, [invId]);
        throw e;
      }
    },
  };
}
