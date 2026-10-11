import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor, convertedJob, future } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { uploadDocument } from "../src/ops/documents.js";
import { invoiceJob, recordReceipt, reverseReceipt, voidInvoice, getInvoice, ageing } from "../src/ops/finance.js";
import {
  approveBill, attachBillDocument, baseCurrency, cancelCreditNote, decideRate, draftCreditNote, enterBill, getBill, inputVatReport, issueCreditNote, listCreditNotes, payBill, payablesReport,
  proposeRate, rateOn, realisedFx, subledgerReconciliation, voidBill,
} from "../src/ops/finance-bridge.js";
import { accountingHandlers, type AccountingAdapter } from "../src/adapters/accounting.js";
import { zohoBooksAdapter } from "../src/adapters/zoho.js";
import { saveZohoConnection, setReceiptPosting } from "../src/ops/connections.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
async function member(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`fb-${role}-${++n}-${Date.now()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
const clean = async () => expect(await verifyInvariants(db)).toEqual([]);

async function invoiced(t: Awaited<ReturnType<typeof newTenant>>) {
  const j = await convertedJob(db, t, 100000, 60000);
  const inv = await db.tenant(t.tenantId, async (c) => {
    await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]);
    const r = await invoiceJob(c, t.ctx, j.jobId);
    return r;
  });
  return { ...j, invoiceId: inv.id };
}

describe("credit notes and receipt reversals", () => {
  it("drafts, needs a second issuer, reduces the balance, caps lines, and keeps the invoice's status honest", async () => {
    const t = await newTenant(db);
    const issuer = await member(t.tenantId, "owner");
    const { invoiceId } = await invoiced(t);
    const inv0 = (await db.tenant(t.tenantId, (c) => getInvoice(c, invoiceId)));
    const total = Number(inv0.inv.total_minor), line = inv0.lines[0];
    await db.tenant(t.tenantId, async (c) => {
      await expect(draftCreditNote(c, t.ctx, invoiceId, { reason: "", full: true })).rejects.toThrow(/Reason/);
      await expect(draftCreditNote(c, t.ctx, invoiceId, { reason: "Too much", lines: [{ invoice_line_id: line.id, qty: Number(line.qty) + 1 }] })).rejects.toThrow(/left to credit/);
      await expect(draftCreditNote(c, t.ctx, invoiceId, { reason: "Overpriced", lines: [{ invoice_line_id: line.id, qty: 1, unit: Number(line.unit_minor) + 1 }] })).rejects.toThrow(/above the invoiced unit price/);
      // partial credit of 400.00 net + 5% tax
      const d1 = await draftCreditNote(c, t.ctx, invoiceId, { reason: "Damaged cargo allowance", lines: [{ invoice_line_id: line.id, qty: 1, unit: 40000 }] });
      await cancelCreditNote(c, t.ctx, d1);                                    // a draft changes nothing until issued
    });
    // the owner who drafted may issue (owner exception); a finance user who drafted may not
    const fin = await member(t.tenantId, "finance");
    const d2 = await db.tenant(t.tenantId, (c) => draftCreditNote(c, fin, invoiceId, { reason: "Goodwill on part of the order", lines: [{ invoice_line_id: line.id, qty: 0.1 }] }));
    await expect(db.tenant(t.tenantId, (c) => issueCreditNote(c, fin, d2))).rejects.toThrow(/Your role|someone other/);
    const issued = await db.tenant(t.tenantId, (c) => issueCreditNote(c, issuer, d2));
    expect(issued.no).toMatch(/^CN-/);
    expect(await db.tenant(t.tenantId, (c) => issueCreditNote(c, issuer, d2))).toMatchObject({ already: true });
    let inv = (await db.tenant(t.tenantId, (c) => getInvoice(c, invoiceId))).inv;
    expect(Number(inv.credited_minor)).toBe(10500);
    expect(Number(inv.balance_minor)).toBe(total - 10500);
    expect(inv.status).toBe("issued");
    // full credit of what is left → "credited" (no cash was received)
    const d3 = await db.tenant(t.tenantId, async (c) => { const d = await draftCreditNote(c, fin, invoiceId, { reason: "Order cancelled", full: true }); return d; });
    const n3 = (await db.tenant(t.tenantId, (c) => listCreditNotes(c, invoiceId))).find((x: any) => x.id === d3);
    expect(Number(n3.total_minor)).toBe(total - 10500);
    await db.tenant(t.tenantId, (c) => issueCreditNote(c, issuer, d3));
    inv = (await db.tenant(t.tenantId, (c) => getInvoice(c, invoiceId))).inv;
    expect(inv.status).toBe("credited");
    expect(Number(inv.balance_minor)).toBe(0);
    await expect(db.tenant(t.tenantId, (c) => draftCreditNote(c, fin, invoiceId, { reason: "again", full: true }))).rejects.toThrow(/credited/);
    await expect(db.tenant(t.tenantId, (c) => voidInvoice(c, t.ctx, invoiceId, "x"))).rejects.toThrow(/credit notes/);
    await expect(db.tenant(t.tenantId, (c) => c.query(`UPDATE credit_notes SET total_minor=1 WHERE status='issued'`))).rejects.toThrow();
    await clean();
  });

  it("reverses a wrong receipt, reopens the invoice and job, and a credit + cash settlement reads as paid", async () => {
    const t = await newTenant(db);
    const { invoiceId, jobId } = await invoiced(t);
    const total = Number((await db.tenant(t.tenantId, (c) => getInvoice(c, invoiceId))).inv.total_minor);
    const r1 = await db.tenant(t.tenantId, async (c) => { await recordReceipt(c, t.ctx, invoiceId, { amount: (total / 100).toFixed(2), method: "bank transfer", reference: "WRONG" }); return (await c.query<any>(`SELECT id FROM receipts WHERE reference='WRONG'`)).rows[0].id; });
    expect((await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT financial_status FROM jobs WHERE id=$1`, [jobId]))).rows[0].financial_status).toBe("collected");
    await expect(db.tenant(t.tenantId, (c) => reverseReceipt(c, ctxFor(t.userId, t.tenantId, ["sales"]), r1, "x"))).rejects.toThrow(/Your role/);
    await db.tenant(t.tenantId, (c) => reverseReceipt(c, t.ctx, r1, "Posted to the wrong invoice"));
    await expect(db.tenant(t.tenantId, (c) => reverseReceipt(c, t.ctx, r1, "again"))).rejects.toThrow(/already reversed/);
    let inv = (await db.tenant(t.tenantId, (c) => getInvoice(c, invoiceId)));
    expect(inv.inv.status).toBe("issued"); expect(Number(inv.inv.paid_minor)).toBe(0);
    expect(inv.receipts[0].reversed).toBe(true);
    expect((await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT financial_status FROM jobs WHERE id=$1`, [jobId]))).rows[0].financial_status).toBe("invoiced");
    // cash for part + credit for the rest settles it
    const fin = await member(t.tenantId, "finance");
    await db.tenant(t.tenantId, (c) => recordReceipt(c, t.ctx, invoiceId, { amount: "500.00" }));
    const cn = await db.tenant(t.tenantId, (c) => draftCreditNote(c, fin, invoiceId, { reason: "Settlement discount", lines: [{ description: "Settlement discount", qty: 1, unit: total - 50000, tax_code: "ZR0" }] }));
    await db.tenant(t.tenantId, (c) => issueCreditNote(c, t.ctx, cn));
    inv = await db.tenant(t.tenantId, (c) => getInvoice(c, invoiceId));
    expect(inv.inv.status).toBe("paid"); expect(Number(inv.inv.balance_minor)).toBe(0);
    expect((await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT financial_status FROM jobs WHERE id=$1`, [jobId]))).rows[0].financial_status).toBe("collected");
    expect((await db.tenant(t.tenantId, (c) => ageing(c))).current).toBeDefined();
    const rec = await db.tenant(t.tenantId, (c) => subledgerReconciliation(c));
    expect(rec.differences).toEqual([]);
    await clean();
  });

  it("cancelling a draft leaves the invoice untouched", async () => {
    const t = await newTenant(db);
    const { invoiceId } = await invoiced(t);
    const id = await db.tenant(t.tenantId, (c) => draftCreditNote(c, t.ctx, invoiceId, { reason: "Maybe", full: true }));
    await db.tenant(t.tenantId, (c) => cancelCreditNote(c, t.ctx, id));
    await expect(db.tenant(t.tenantId, (c) => issueCreditNote(c, t.ctx, id))).resolves.toMatchObject({ already: true });
    expect(Number((await db.tenant(t.tenantId, (c) => getInvoice(c, invoiceId))).inv.credited_minor)).toBe(0);
  });
});

describe("supplier bills, approved FX rates and payments", () => {
  it("never defaults a rate, needs a second approver and evidence, reconciles the job cost, and books realised FX exactly", async () => {
    const t = await newTenant(db);
    const approver = await member(t.tenantId, "owner");
    const j = await convertedJob(db, t, 100000, 60000);           // cost estimate 600.00 AED, supplier = j.supplierId
    const costId = (await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT id FROM job_costs WHERE job_id=$1`, [j.jobId]))).rows[0].id;
    const doc = await db.tenant(t.tenantId, (c) => uploadDocument(c, t.ctx, { kind: "other", title: "Carrier invoice", issuer: "Carrier", filename: "inv.pdf", data: Buffer.from("%PDF-1.4 invoice") }));
    expect(await db.tenant(t.tenantId, (c) => baseCurrency(c))).toBe("AED");

    const bill = await db.tenant(t.tenantId, async (c) => {
      await expect(enterBill(c, t.ctx, { supplier_id: j.supplierId, supplier_ref: "C-1", currency: "usd", bill_date: future(-10), due_date: future(-9), lines: [] })).rejects.toThrow(/at least one/);
      const b = await enterBill(c, t.ctx, { supplier_id: j.supplierId, supplier_ref: "INV-8841", currency: "usd", bill_date: future(-10), due_date: future(20), lines: [{ description: "Ocean freight", net: "170.00", tax_code: "ZR0", job_cost_id: costId }] });
      await expect(enterBill(c, t.ctx, { supplier_id: j.supplierId, supplier_ref: "inv-8841", currency: "usd", bill_date: future(-10), due_date: future(20), lines: [{ description: "x", net: "1" }] })).rejects.toThrow(/already recorded/);
      return b;
    });
    await db.tenant(t.tenantId, async (c) => {
      await expect(approveBill(c, t.ctx, bill.id)).rejects.toThrow(/Attach the supplier's invoice/);
      await attachBillDocument(c, t.ctx, bill.id, doc);
      await expect(approveBill(c, t.ctx, bill.id)).rejects.toThrow(/No approved USD/);               // no rate: never defaulted
    });
    // rate proposed by finance, approved by another person
    const fin = await member(t.tenantId, "finance");
    const r1 = await db.tenant(t.tenantId, (c) => proposeRate(c, fin, { from_ccy: "USD", rate: "3.6725", as_of: future(-12), source: "Bank confirmation 2026-10-01" }));
    await expect(db.tenant(t.tenantId, (c) => decideRate(c, fin, r1, true))).rejects.toThrow(/Your role|someone other/);
    await db.tenant(t.tenantId, (c) => decideRate(c, approver, r1, true));
    await expect(db.tenant(t.tenantId, (c) => proposeRate(c, fin, { from_ccy: "AED", rate: "1", as_of: future(-1), source: "x" }))).rejects.toThrow(/foreign currency/);
    await expect(db.tenant(t.tenantId, (c) => proposeRate(c, fin, { from_ccy: "USD", rate: "3.7", as_of: future(3), source: "x" }))).rejects.toThrow(/future/);
    expect((await db.tenant(t.tenantId, (c) => rateOn(c, "USD", future(-1))))?.rate).toBe(3.6725);
    // estimate 600.00 vs 170 USD × 3.6725 = 624.325 → 624.33: within 5%
    await db.tenant(t.tenantId, async (c) => {
      await expect(approveBill(c, fin, bill.id)).rejects.toThrow(/Your role/);
      await approveBill(c, approver, bill.id);
    });
    let b = await db.tenant(t.tenantId, (c) => getBill(c, bill.id));
    expect(b.bill.status).toBe("approved");
    expect(Number(b.bill.base_total_minor)).toBe(Math.round(17000 * 3.6725));
    const cost = (await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT * FROM job_costs WHERE id=$1`, [costId]))).rows[0];
    expect(cost.status).toBe("posted"); expect(Number(cost.actual_minor)).toBe(Math.round(17000 * 3.6725)); expect(cost.supplier_invoice_ref).toBe("INV-8841");

    // pay in two parts at a different approved rate
    const r2 = await db.tenant(t.tenantId, (c) => proposeRate(c, fin, { from_ccy: "USD", rate: "3.6800", as_of: future(-2), source: "Bank confirmation 2026-10-09" }));
    await db.tenant(t.tenantId, (c) => decideRate(c, approver, r2, true));
    const p1 = await db.tenant(t.tenantId, (c) => payBill(c, fin, bill.id, { amount: "100.00", paid_on: future(-1), method: "wire", reference: "W-1" }));
    expect(p1.status).toBe("part_paid");
    await expect(db.tenant(t.tenantId, (c) => payBill(c, fin, bill.id, { amount: "70.01", paid_on: future(-1) }))).rejects.toThrow(/exceeds/);
    const p2 = await db.tenant(t.tenantId, (c) => payBill(c, fin, bill.id, { amount: "70.00", paid_on: future(-1), method: "wire", reference: "W-2" }));
    expect(p2.status).toBe("paid");
    b = await db.tenant(t.tenantId, (c) => getBill(c, bill.id));
    const sum = (k: string) => b.payments.reduce((a: number, p: any) => a + Number(p[k]), 0);
    expect(sum("base_bill_minor")).toBe(Number(b.bill.base_total_minor));                       // base value released exactly
    expect(sum("base_paid_minor")).toBe(Math.round(10000 * 3.68) + Math.round(7000 * 3.68));
    expect(sum("fx_gain_loss_minor")).toBe(sum("base_bill_minor") - sum("base_paid_minor"));
    expect(sum("fx_gain_loss_minor")).toBeLessThan(0);                                          // paid at a higher rate → a realised loss
    const fx = await db.tenant(t.tenantId, (c) => realisedFx(c, future(-30), future(0)));
    expect(fx.find((x: any) => x.currency === "USD")?.gain_loss).toBe(sum("fx_gain_loss_minor"));
    const vat = await db.tenant(t.tenantId, (c) => inputVatReport(c, future(-30), future(0)));
    expect(vat.find((x: any) => x.tax_code === "ZR0")?.net).toBe(17000);
    await expect(db.tenant(t.tenantId, (c) => voidBill(c, t.ctx, bill.id, "oops"))).rejects.toThrow(/payments/);
    await expect(db.tenant(t.tenantId, (c) => c.query(`UPDATE vendor_payments SET amount_minor=1`))).rejects.toThrow();
    const rec = await db.tenant(t.tenantId, (c) => subledgerReconciliation(c));
    expect(rec.differences).toEqual([]);
    await clean();
  });

  it("demands a variance note beyond 5%, restores the cost when a bill is voided, and ages open bills with unrealised FX", async () => {
    const t = await newTenant(db);
    const approver = await member(t.tenantId, "owner");
    const fin = await member(t.tenantId, "finance");
    const j = await convertedJob(db, t, 100000, 60000);
    const costId = (await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT id FROM job_costs WHERE job_id=$1`, [j.jobId]))).rows[0].id;
    const doc = await db.tenant(t.tenantId, (c) => uploadDocument(c, t.ctx, { kind: "other", title: "Invoice", issuer: "Carrier", filename: "i.pdf", data: Buffer.from("%PDF-1.4 i2") }));
    const b = await db.tenant(t.tenantId, (c) => enterBill(c, fin, { supplier_id: j.supplierId, supplier_ref: "AED-77", currency: "AED", bill_date: future(-40), due_date: future(-10), document_id: doc, lines: [{ description: "Freight", net: "900.00", tax_code: "SR5", job_cost_id: costId }] }));
    await expect(db.tenant(t.tenantId, (c) => approveBill(c, approver, b.id))).rejects.toThrow(/variance note/);
    await db.tenant(t.tenantId, (c) => approveBill(c, approver, b.id, { variance_note: "Fuel surcharge added by the carrier" }));
    expect((await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT status, actual_minor FROM job_costs WHERE id=$1`, [costId]))).rows[0]).toMatchObject({ status: "posted" });
    const rep = await db.tenant(t.tenantId, (c) => payablesReport(c));
    const row = rep.bills.find((x: any) => x.id === b.id);
    expect(row.bucket).toBe("1-30"); expect(row.outstanding).toBe(94500);
    await db.tenant(t.tenantId, (c) => voidBill(c, approver, b.id, "Duplicate of a corrected bill"));
    expect((await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT status, actual_minor FROM job_costs WHERE id=$1`, [costId]))).rows[0]).toMatchObject({ status: "estimated", actual_minor: null });
    await clean();
  });
});

describe("accounting bridge for receipts and credit notes", () => {
  it("posts credit notes as drafts and receipts only on opt-in, finds before creating, and stops on a reversed receipt", async () => {
    const t = await newTenant(db);
    const issuer = await member(t.tenantId, "owner");
    const fin = await member(t.tenantId, "finance");
    await db.tenant(t.tenantId, (c) => saveZohoConnection(c, t.ctx, { region: "com", client_id: "id", client_secret: "secret", refresh_token: "token", organization_id: "1", currency_ids: '{"AED":"2"}', tax_ids: '{"SR5":"3"}' }));
    const { invoiceId } = await invoiced(t);
    await db.query(`UPDATE invoices SET external_id='ZB-INV-1', sync_status='synced' WHERE id=$1`, [invoiceId]);
    const calls: string[] = [];
    const adapter: AccountingAdapter = {
      async find() { return null; }, async create() { return { externalId: "x" }; },
      async findPayment(ref) { calls.push(`findPayment ${ref}`); return null; },
      async createPayment(p) { calls.push(`createPayment ${p.amountMinor}`); return { externalId: "PAY-1" }; },
      async findCreditNote(ref) { calls.push(`findCreditNote ${ref}`); return null; },
      async createCreditNote(nn) { calls.push(`createCreditNote ${nn.totalMinor}`); return { externalId: "CN-EXT-1" }; },
    };
    const h = accountingHandlers(db, adapter);
    // credit note → outbox → draft in the ledger
    const cn = await db.tenant(t.tenantId, async (c) => { const id = await draftCreditNote(c, fin, invoiceId, { reason: "Short delivery", lines: [{ description: "Short delivery", qty: 1, unit: 20000, tax_code: "SR5" }] }); await issueCreditNote(c, issuer, id); return id; });
    const row = (await db.query<any>(`SELECT * FROM outbox WHERE key=$1`, [`credit-note:${cn}`])).rows[0];
    expect(row).toBeTruthy();
    await h["accounting.credit_note"](row);
    expect(calls).toEqual([expect.stringMatching(/^findCreditNote CN-/), "createCreditNote 21000"]);
    expect((await db.query<any>(`SELECT sync_status, external_id FROM credit_notes WHERE id=$1`, [cn])).rows[0]).toMatchObject({ sync_status: "synced", external_id: "CN-EXT-1" });
    await h["accounting.credit_note"](row);                                             // a retry does not post twice
    expect(calls.filter((x) => x.startsWith("createCreditNote"))).toHaveLength(1);

    // receipts are manual by default
    await db.tenant(t.tenantId, (c) => recordReceipt(c, t.ctx, invoiceId, { amount: "100.00", reference: "BANK-1" }));
    expect((await db.query<any>(`SELECT sync_status FROM receipts WHERE reference='BANK-1'`)).rows[0].sync_status).toBe("manual");
    expect((await db.query<any>(`SELECT * FROM outbox WHERE topic='accounting.receipt' AND tenant_id=$1`, [t.tenantId])).rows).toHaveLength(0);
    await db.tenant(t.tenantId, (c) => setReceiptPosting(c, t.ctx, true));
    await db.tenant(t.tenantId, (c) => recordReceipt(c, t.ctx, invoiceId, { amount: "50.00", reference: "BANK-2" }));
    const orow = (await db.query<any>(`SELECT * FROM outbox WHERE topic='accounting.receipt' AND tenant_id=$1`, [t.tenantId])).rows[0];
    await h["accounting.receipt"](orow);
    expect(calls).toContain("createPayment 5000");
    expect((await db.query<any>(`SELECT sync_status, external_id FROM receipts WHERE reference='BANK-2'`)).rows[0]).toMatchObject({ sync_status: "synced", external_id: "PAY-1" });
    // reversing a posted receipt asks the controller to reverse it in the ledger
    const rid = (await db.query<any>(`SELECT id FROM receipts WHERE reference='BANK-2'`)).rows[0].id;
    await db.tenant(t.tenantId, (c) => reverseReceipt(c, t.ctx, rid, "Bounced"));
    expect((await db.query<any>(`SELECT 1 FROM outbox WHERE key=$1`, [`receipt-reversed:${rid}`])).rows).toHaveLength(1);
    // a receipt reversed before it was sent is never posted
    await db.tenant(t.tenantId, (c) => recordReceipt(c, t.ctx, invoiceId, { amount: "10.00", reference: "BANK-3" }));
    const r3 = (await db.query<any>(`SELECT id FROM receipts WHERE reference='BANK-3'`)).rows[0].id;
    await db.tenant(t.tenantId, (c) => reverseReceipt(c, t.ctx, r3, "Entered twice"));
    const before = calls.length;
    await h["accounting.receipt"]((await db.query<any>(`SELECT * FROM outbox WHERE key=$1`, [`receipt:${r3}`])).rows[0]);
    expect(calls.length).toBe(before);
    await clean();
  });

  it("the Zoho adapter finds before creating payments and credit notes and verifies amounts", async () => {
    const json = (x: any) => new Response(JSON.stringify(x), { status: 200, headers: { "Content-Type": "application/json" } });
    const settings = { region: "com" as const, clientId: "id", clientSecret: "s", refreshToken: "t", organizationId: "1", currencyIds: { AED: "2" }, taxIds: { SR5: "3" } };
    const f1 = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ access_token: "x", expires_in: 3600 })).mockResolvedValueOnce(json({ code: 0, customerpayments: [{ payment_id: "P9", reference_number: "RC-1", amount: 50 }] }));
    expect(await zohoBooksAdapter(settings, f1).findPayment!("RC-1", { reference: "RC-1", customer: "C", invoiceExternalId: "I", invoiceReference: "INV", currency: "AED", amountMinor: 5000, date: "2026-10-01", method: "bank" })).toEqual({ externalId: "P9" });
    const f2 = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ access_token: "x", expires_in: 3600 })).mockResolvedValueOnce(json({ code: 0, customerpayments: [{ payment_id: "P9", reference_number: "RC-1", amount: 49 }] }));
    await expect(zohoBooksAdapter(settings, f2).findPayment!("RC-1", { reference: "RC-1", customer: "C", invoiceExternalId: "I", invoiceReference: "INV", currency: "AED", amountMinor: 5000, date: "2026-10-01", method: "bank" })).rejects.toThrow(/amount differs/);
    const f3 = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ access_token: "x", expires_in: 3600 })).mockResolvedValueOnce(json({ code: 0, invoice: { invoice_id: "I", customer_id: "CU", reference_number: "R" } })).mockResolvedValueOnce(json({ code: 0, creditnote: { creditnote_id: "CN1", total: 99, currency_code: "AED" } }));
    await expect(zohoBooksAdapter(settings, f3).createCreditNote!({ reference: "CN-1", customer: "C", invoiceExternalId: "I", invoiceReference: "INV", issuedAt: "2026-10-01T00:00:00Z", currency: "AED", subtotalMinor: 10000, taxMinor: 500, totalMinor: 10500, reason: "r", lines: [{ description: "d", qty: 1, unitMinor: 10000, taxCode: "SR5" }] })).rejects.toThrow(/amount\/currency differs/);
  });
});
