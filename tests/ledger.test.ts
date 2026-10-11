import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor, convertedJob, future } from "./helpers.js";
import { uploadDocument } from "../src/ops/documents.js";
import { invoiceJob, recordReceipt, reverseReceipt, voidInvoice } from "../src/ops/finance.js";
import { approveBill, attachBillDocument, decideRate, draftCreditNote, enterBill, issueCreditNote, payBill, proposeRate, voidBill } from "../src/ops/finance-bridge.js";
import { accountLedger, addAccount, decideManualEntry, enableLedger, journalDetail, ledgerReconciliation, listAccounts, listJournals, postAllLedgers, postLedgerNow, proposeManualEntry, trialBalance, incomeStatement } from "../src/ops/ledger.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
async function member(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`gl-${role}-${++n}-${Date.now()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
const bal = (tb: Awaited<ReturnType<typeof trialBalance>>, code: string) => tb.rows.find((r) => r.code === code)!.balance;

describe("general ledger", () => {
  it("projects sales, cash, credits, supplier bills and payments into balanced journals, once, and reconciles to the sub-ledgers", async () => {
    const t = await newTenant(db);
    const fin = await member(t.tenantId, "finance"), approver = await member(t.tenantId, "owner");
    await expect(db.tenant(t.tenantId, (c) => postLedgerNow(c, t.ctx))).resolves.toBe(0);                 // not enabled: nothing happens
    await db.tenant(t.tenantId, (c) => enableLedger(c, t.ctx, future(-30)));
    await expect(db.tenant(t.tenantId, (c) => enableLedger(c, t.ctx, future(-30)))).rejects.toThrow(/already enabled/);

    // sales: invoice 1050.00 (1000 + 50 VAT), 500 received, then a 100 + 5 credit note
    const j = await convertedJob(db, t, 100000, 60000);
    const inv = await db.tenant(t.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]); return invoiceJob(c, t.ctx, j.jobId); });
    await db.tenant(t.tenantId, (c) => recordReceipt(c, t.ctx, inv.id, { amount: "500.00", method: "bank transfer", reference: "R1" }));
    const cn = await db.tenant(t.tenantId, async (c) => { const id = await draftCreditNote(c, fin, inv.id, { reason: "Short delivery", lines: [{ description: "Short delivery", qty: 1, unit: 10000, tax_code: "SR5" }] }); await issueCreditNote(c, t.ctx, id); return id; });
    void cn;
    // purchases: a USD 170 bill at 3.6725, paid at 3.68
    const doc = await db.tenant(t.tenantId, (c) => uploadDocument(c, t.ctx, { kind: "other", title: "Carrier invoice", issuer: "Carrier", filename: "inv.pdf", data: Buffer.from("%PDF-1.4 invoice gl") }));
    const costId = (await db.query<any>(`SELECT id FROM job_costs WHERE job_id=$1`, [j.jobId])).rows[0].id;
    const r1 = await db.tenant(t.tenantId, (c) => proposeRate(c, fin, { from_ccy: "USD", rate: "3.6725", as_of: future(-12), source: "Bank" }));
    await db.tenant(t.tenantId, (c) => decideRate(c, approver, r1, true));
    const bill = await db.tenant(t.tenantId, (c) => enterBill(c, t.ctx, { supplier_id: j.supplierId, supplier_ref: "INV-1", currency: "usd", bill_date: future(-10), due_date: future(20), document_id: doc, lines: [{ description: "Ocean freight", net: "170.00", tax_code: "ZR0", job_cost_id: costId }] }));
    await db.tenant(t.tenantId, (c) => approveBill(c, approver, bill.id));
    const r2 = await db.tenant(t.tenantId, (c) => proposeRate(c, fin, { from_ccy: "USD", rate: "3.6800", as_of: future(-2), source: "Bank" }));
    await db.tenant(t.tenantId, (c) => decideRate(c, approver, r2, true));
    await db.tenant(t.tenantId, (c) => payBill(c, fin, bill.id, { amount: "100.00", paid_on: future(-1), method: "wire", reference: "W1" }));

    const posted = await db.tenant(t.tenantId, (c) => postLedgerNow(c, t.ctx));
    expect(posted).toBe(5);                                                                              // invoice, receipt, credit note, bill, payment
    expect(await db.tenant(t.tenantId, (c) => postLedgerNow(c, t.ctx))).toBe(0);                          // idempotent
    let tb = await db.tenant(t.tenantId, (c) => trialBalance(c));
    expect(tb.balanced).toBe(true); expect(tb.debit).toBe(tb.credit);
    expect(bal(tb, "1100")).toBe(105000 - 50000 - 10500);                                                // receivable: invoiced − cash − credited
    expect(bal(tb, "1000")).toBe(50000 - Math.round(10000 * 3.68));                                       // bank: received − paid out
    expect(bal(tb, "2100")).toBe(-(5000 - 500));                                                          // output VAT after the credit note
    expect(bal(tb, "4000")).toBe(-(100000 - 10000));                                                      // revenue after the credit note
    const billBase = Math.round(17000 * 3.6725);
    expect(bal(tb, "5000")).toBe(billBase);                                                               // cost at the booked rate
    const released = Math.round(billBase * 10000 / 17000);                                                // base value released by a 100/170 payment
    expect(bal(tb, "2000")).toBe(-(billBase - released));
    const is = await db.tenant(t.tenantId, (c) => incomeStatement(c, future(-60), future(0)));
    expect(is.income).toBe(90000); expect(is.profit).toBe(is.income - is.expense);
    const rec = await db.tenant(t.tenantId, (c) => ledgerReconciliation(c));
    expect(rec).toMatchObject({ pending: 0, ok: true });
    const ar = await db.tenant(t.tenantId, (c) => listAccounts(c)).then((a) => a.find((x: any) => x.code === "1100"));
    const led = await db.tenant(t.tenantId, (c) => accountLedger(c, ar.id));
    expect(led.lines.at(-1)!.balance).toBe(bal(tb, "1100"));

    // reversals post as their own journals
    await db.tenant(t.tenantId, async (c) => { const r = (await c.query<any>(`SELECT id FROM receipts WHERE reference='R1'`)).rows[0].id; await reverseReceipt(c, t.ctx, r, "Wrong invoice"); });
    expect(await db.tenant(t.tenantId, (c) => postLedgerNow(c, t.ctx))).toBe(1);
    tb = await db.tenant(t.tenantId, (c) => trialBalance(c));
    expect(bal(tb, "1100")).toBe(105000 - 10500); expect(tb.balanced).toBe(true);
    expect((await db.tenant(t.tenantId, (c) => ledgerReconciliation(c)))!.ok).toBe(true);

    // a second invoice voided before and after posting
    const j2 = await convertedJob(db, t, 50000, 30000);
    const inv2 = await db.tenant(t.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j2.jobId]); return invoiceJob(c, t.ctx, j2.jobId); });
    await db.tenant(t.tenantId, (c) => postLedgerNow(c, t.ctx));
    await db.tenant(t.tenantId, (c) => voidInvoice(c, t.ctx, inv2.id, "Raised in error"));
    expect(await db.tenant(t.tenantId, (c) => postLedgerNow(c, t.ctx))).toBe(1);
    expect((await db.tenant(t.tenantId, (c) => ledgerReconciliation(c)))!.ok).toBe(true);
    void voidBill;

    // journals are numbered without gaps and are immutable; an unbalanced journal cannot be committed
    const js = await db.tenant(t.tenantId, (c) => listJournals(c, 100));
    expect(js.map((x: any) => Number(x.no)).sort((a, b) => a - b)).toEqual(Array.from({ length: js.length }, (_, i) => i + 1));
    const d = await db.tenant(t.tenantId, (c) => journalDetail(c, js[0].id));
    expect(d.lines.reduce((a: number, l: any) => a + Number(l.debit_minor) - Number(l.credit_minor), 0)).toBe(0);
    await expect(db.tenant(t.tenantId, (c) => c.query(`UPDATE gl_lines SET debit_minor=debit_minor+1`))).rejects.toThrow(/immutable|permission denied/);
    await expect(db.tenant(t.tenantId, (c) => c.query(`UPDATE gl_journals SET memo='x'`))).rejects.toThrow(/immutable|permission denied/);
    await expect(db.tenant(t.tenantId, async (c) => {
      const a = (await c.query<any>(`SELECT id FROM gl_accounts LIMIT 2`)).rows;
      const jid = (await c.query<any>(`INSERT INTO gl_journals(tenant_id,no,posted_on,source_type,source_id,memo) VALUES ($1,999,current_date,'test','x','x') RETURNING id`, [t.tenantId])).rows[0].id;
      await c.query(`INSERT INTO gl_lines(tenant_id,journal_id,account_id,debit_minor) VALUES ($1,$2,$3,100)`, [t.tenantId, jid, a[0].id]);
      await c.query(`INSERT INTO gl_lines(tenant_id,journal_id,account_id,credit_minor) VALUES ($1,$2,$3,99)`, [t.tenantId, jid, a[1].id]);
    })).rejects.toThrow(/balance/);
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("manual entries are balanced, proposed by one person and approved by another, and opening balances enter that way", async () => {
    const t = await newTenant(db);
    const fin = await member(t.tenantId, "finance"), approver = await member(t.tenantId, "owner");
    await expect(db.tenant(t.tenantId, (c) => proposeManualEntry(c, fin, { entry_date: future(-1), memo: "x", lines: [] }))).rejects.toThrow(/Enable the general ledger/);
    await db.tenant(t.tenantId, (c) => enableLedger(c, t.ctx, future(-10)));
    const accts = await db.tenant(t.tenantId, (c) => listAccounts(c));
    const id = (code: string) => accts.find((a: any) => a.code === code).id;
    const extra = await db.tenant(t.tenantId, (c) => addAccount(c, t.ctx, { code: "1010", name: "Petty cash", kind: "asset" }));
    await expect(db.tenant(t.tenantId, (c) => addAccount(c, t.ctx, { code: "1010", name: "Dup", kind: "asset" }))).rejects.toThrow(/already used/);
    const lines = [{ account_id: extra, debit: "500.00" }, { account_id: id("3000"), credit: "500.00", memo: "Opening balance" }];
    await expect(db.tenant(t.tenantId, (c) => proposeManualEntry(c, fin, { entry_date: future(-1), memo: "Unbalanced", lines: [{ account_id: extra, debit: "5" }, { account_id: id("3000"), credit: "4.99" }] }))).rejects.toThrow(/does not balance/);
    await expect(db.tenant(t.tenantId, (c) => proposeManualEntry(c, fin, { entry_date: future(-1), memo: "Both", lines: [{ account_id: extra, debit: "5", credit: "5" }, { account_id: id("3000"), credit: "5" }] }))).rejects.toThrow(/either a debit or a credit/);
    const e = await db.tenant(t.tenantId, (c) => proposeManualEntry(c, fin, { entry_date: future(-1), memo: "Opening petty cash", lines }));
    await expect(db.tenant(t.tenantId, (c) => decideManualEntry(c, fin, e, true))).rejects.toThrow(/Your role|someone other/);
    await db.tenant(t.tenantId, (c) => decideManualEntry(c, approver, e, true));
    await expect(db.tenant(t.tenantId, (c) => decideManualEntry(c, approver, e, true))).rejects.toThrow(/already approved/);
    const tb = await db.tenant(t.tenantId, (c) => trialBalance(c));
    expect(bal(tb, "1010")).toBe(50000); expect(bal(tb, "3000")).toBe(-50000); expect(tb.balanced).toBe(true);
    // a manual entry never disturbs the sub-ledger reconciliation
    expect((await db.tenant(t.tenantId, (c) => ledgerReconciliation(c)))!.ok).toBe(true);
  });

  it("the posting worker serves every enabled workspace and skips the rest", async () => {
    const a = await newTenant(db), b = await newTenant(db);
    await db.tenant(a.tenantId, (c) => enableLedger(c, a.ctx, future(-5)));
    const j = await convertedJob(db, a, 100000, 60000);
    await db.tenant(a.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]); await invoiceJob(c, a.ctx, j.jobId); });
    const r = await postAllLedgers(db);
    expect(r.failed).toBe(0); expect(r.posted).toBeGreaterThanOrEqual(1);
    expect((await db.query<any>(`SELECT count(*)::int n FROM gl_journals WHERE tenant_id=$1`, [b.tenantId])).rows[0].n).toBe(0);
  });
});
