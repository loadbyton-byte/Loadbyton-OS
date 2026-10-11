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
export interface AccountingPayment {
  reference: string; customer: string; invoiceExternalId: string; invoiceReference: string; currency: string; amountMinor: number; date: string; method: string; note?: string;
}
export interface AccountingCreditNote {
  reference: string; customer: string; invoiceExternalId: string; invoiceReference: string; issuedAt: string; currency: string;
  subtotalMinor: number; taxMinor: number; totalMinor: number; reason: string;
  lines: { description: string; qty: number; unitMinor: number; taxCode: string }[];
}
export interface AccountingAdapter {
  find(reference: string,expected?:AccountingInvoice): Promise<{ externalId: string } | null>;
  create(inv: AccountingInvoice): Promise<{ externalId: string }>;
  /** Optional: an adapter that cannot post cash or credit notes simply omits these, and the sync is marked for manual entry. */
  findPayment?(reference: string, expected?: AccountingPayment): Promise<{ externalId: string } | null>;
  createPayment?(p: AccountingPayment): Promise<{ externalId: string }>;
  findCreditNote?(reference: string, expected?: AccountingCreditNote): Promise<{ externalId: string } | null>;
  createCreditNote?(n: AccountingCreditNote): Promise<{ externalId: string }>;
}

/** Default: no external ledger. Marks invoices as exported with a deterministic external id (owner exports CSV). */
export const csvExportAdapter: AccountingAdapter = {
  async find(reference) { return { externalId: `EXPORT-${reference}` }; },
  async create(inv) { return { externalId: `EXPORT-${inv.reference}` }; },
};

async function selectAdapter(db: Db, tenantId: string, injected?: AccountingAdapter) {
  if (injected) return { adapter: injected, config: {} as Record<string, any> };
  const connection = (await db.query<any>(`SELECT * FROM accounting_connections WHERE tenant_id=$1`, [tenantId])).rows[0];
  if (connection?.provider !== "zoho" || !["connected", "validating", "live"].includes(connection.status)) throw new Error("No configured accounting adapter. CSV export is not synchronized accounting.");
  return { adapter: zohoBooksAdapter(JSON.parse(decryptSecret(connection.config.encrypted)) as ZohoSettings), config: connection.config as Record<string, any> };
}

export function accountingHandlers(db: Db, adapter?: AccountingAdapter): OutboxHandlers {
  return {
    /** Cash is posted only when the owner opted in; a payment has no draft state in the ledger, so the default is manual entry by the controller. */
    async "accounting.receipt"(row) {
      const rc = (await db.query<any>(`SELECT r.*, i.no AS invoice_no, i.external_id AS invoice_external, i.currency, i.tenant_id AS inv_tenant, p.name AS customer FROM receipts r JOIN invoices i ON i.id=r.invoice_id JOIN parties p ON p.id=i.party_id WHERE r.id=$1`, [row.payload.receiptId])).rows[0];
      if (!rc) throw new Error("receipt not found");
      if (rc.tenant_id !== row.tenant_id) throw new Error("Accounting event tenant mismatch");
      if ((await db.query(`SELECT 1 FROM receipt_reversals WHERE receipt_id=$1`, [rc.id])).rows.length) { await db.query(`UPDATE receipts SET sync_status='manual' WHERE id=$1`, [rc.id]); return {}; }
      if (rc.external_id) { await db.query(`UPDATE receipts SET sync_status='synced' WHERE id=$1`, [rc.id]); return { externalId: rc.external_id }; }
      try {
        const sel = await selectAdapter(db, row.tenant_id!, adapter);
        if (!sel.adapter.createPayment || (!adapter && sel.config.post_receipts !== true)) { await db.query(`UPDATE receipts SET sync_status='manual' WHERE id=$1`, [rc.id]); return {}; }
        if (!rc.invoice_external) throw new Error("The invoice has not been synchronized yet; the receipt will retry after it is.");
        const payment: AccountingPayment = {
          reference: adapter ? `RC-${rc.id}` : `LBT-${rc.tenant_id}-RC-${rc.id}`, customer: rc.customer, invoiceExternalId: rc.invoice_external, invoiceReference: rc.invoice_no,
          currency: rc.currency, amountMinor: Number(rc.amount_minor), date: new Date(rc.received_at).toISOString().slice(0, 10), method: rc.method, note: rc.reference ?? undefined,
        };
        const found = sel.adapter.findPayment ? await sel.adapter.findPayment(payment.reference, payment) : null;
        const res = found ?? (await sel.adapter.createPayment(payment));
        await db.query(`UPDATE receipts SET external_id=$2, sync_status='synced' WHERE id=$1`, [rc.id, res.externalId]);
        return { externalId: res.externalId };
      } catch (e) { await db.query(`UPDATE receipts SET sync_status='failed' WHERE id=$1`, [rc.id]); throw e; }
    },
    /** Credit notes are created as drafts for the controller to post, like invoices. */
    async "accounting.credit_note"(row) {
      const n = (await db.query<any>(`SELECT n.*, i.no AS invoice_no, i.external_id AS invoice_external, p.name AS customer FROM credit_notes n JOIN invoices i ON i.id=n.invoice_id JOIN parties p ON p.id=n.party_id WHERE n.id=$1`, [row.payload.creditNoteId])).rows[0];
      if (!n) throw new Error("credit note not found");
      if (n.tenant_id !== row.tenant_id) throw new Error("Accounting event tenant mismatch");
      if (n.external_id) { await db.query(`UPDATE credit_notes SET sync_status='synced' WHERE id=$1`, [n.id]); return { externalId: n.external_id }; }
      try {
        const sel = await selectAdapter(db, row.tenant_id!, adapter);
        if (!sel.adapter.createCreditNote) { await db.query(`UPDATE credit_notes SET sync_status='manual' WHERE id=$1`, [n.id]); return {}; }
        if (!n.invoice_external) throw new Error("The invoice has not been synchronized yet; the credit note will retry after it is.");
        const lines = (await db.query<any>(`SELECT * FROM credit_note_lines WHERE credit_note_id=$1 ORDER BY id`, [n.id])).rows;
        const note: AccountingCreditNote = {
          reference: adapter ? n.no : `LBT-${n.tenant_id}-${n.no}`, customer: n.customer, invoiceExternalId: n.invoice_external, invoiceReference: n.invoice_no, issuedAt: new Date(n.issued_at).toISOString(), currency: n.currency,
          subtotalMinor: Number(n.subtotal_minor), taxMinor: Number(n.tax_minor), totalMinor: Number(n.total_minor), reason: n.reason,
          lines: lines.map((l) => ({ description: l.description, qty: Number(l.qty), unitMinor: Number(l.unit_minor), taxCode: l.tax_code })),
        };
        const found = sel.adapter.findCreditNote ? await sel.adapter.findCreditNote(note.reference, note) : null;
        const res = found ?? (await sel.adapter.createCreditNote(note));
        await db.query(`UPDATE credit_notes SET external_id=$2, sync_status='synced' WHERE id=$1`, [n.id, res.externalId]);
        return { externalId: res.externalId };
      } catch (e) { await db.query(`UPDATE credit_notes SET sync_status='failed' WHERE id=$1`, [n.id]); throw e; }
    },
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
