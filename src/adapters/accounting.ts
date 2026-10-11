import type { Db } from "../db/client.js";
import type { OutboxHandlers } from "../platform/outbox.js";
import {zohoBooksAdapter,type ZohoSettings} from './zoho.js';
import {decryptSecret} from '../lib/encryption.js';

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
  find(reference: string,expected?:AccountingInvoice): Promise<{ externalId: string } | null>;
  create(inv: AccountingInvoice): Promise<{ externalId: string }>;
}

/** Default: no external ledger. Marks invoices as exported with a deterministic external id (owner exports CSV). */
export const csvExportAdapter: AccountingAdapter = {
  async find(reference) { return { externalId: `EXPORT-${reference}` }; },
  async create(inv) { return { externalId: `EXPORT-${inv.reference}` }; },
};

export function accountingHandlers(db: Db, adapter?: AccountingAdapter): OutboxHandlers {
  return {
    async "accounting.invoice"(row) {
      const invId = row.payload.invoiceId as string;
      const inv = (await db.query<any>(`SELECT i.*, p.name AS customer FROM invoices i JOIN parties p ON p.id=i.party_id WHERE i.id=$1`, [invId])).rows[0];
      if (!inv) throw new Error("invoice not found");
      if(inv.status==='void')throw new Error('Void invoice needs controller reversal review; draft sync was stopped');
      if(inv.tenant_id!==row.tenant_id)throw new Error('Accounting event tenant mismatch');
      try {
      let selected=adapter;
      if(!selected) {
        const connection=(await db.query<any>(`SELECT * FROM accounting_connections WHERE tenant_id=$1`,[row.tenant_id])).rows[0];
        if(connection?.provider!=='zoho'||!['connected','validating','live'].includes(connection.status))throw new Error('No configured accounting adapter. CSV export is not synchronized accounting.');
        const settings=JSON.parse(decryptSecret(connection.config.encrypted)) as ZohoSettings;
        selected=zohoBooksAdapter(settings);
      }
      if (inv.external_id) { await db.query(`UPDATE invoices SET sync_status='synced' WHERE id=$1`, [invId]); return { externalId: inv.external_id }; }
      const lines = (await db.query<any>(`SELECT * FROM invoice_lines WHERE invoice_id=$1`, [invId])).rows;
      const payload: AccountingInvoice = {
        reference: adapter?inv.no:`LBT-${inv.tenant_id}-${inv.no}`, customer: inv.customer, issuedAt: new Date(inv.issued_at).toISOString(), dueAt: new Date(inv.due_at).toISOString(),
        currency: inv.currency, subtotalMinor: Number(inv.subtotal_minor), taxMinor: Number(inv.tax_minor), totalMinor: Number(inv.total_minor),
        lines: lines.map((l) => ({ description: l.description, qty: Number(l.qty), unitMinor: Number(l.unit_minor), taxCode: l.tax_code })),
      };
        const found = await selected.find(payload.reference,payload);
        const res = found ?? (await selected.create(payload));
        await db.query(`UPDATE invoices SET external_id=$2, sync_status='synced' WHERE id=$1`, [invId, res.externalId]);
        return { externalId: res.externalId };
      } catch (e) {
        await db.query(`UPDATE invoices SET sync_status='failed' WHERE id=$1`, [invId]);
        throw e;
      }
    },
  };
}
