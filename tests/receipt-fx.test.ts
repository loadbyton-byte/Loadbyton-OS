import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor, convertedJob, future } from "./helpers.js";
import { invoiceJob, getInvoice, recordReceipt, reverseReceipt } from "../src/ops/finance.js";
import { decideRate, proposeRate } from "../src/ops/finance-bridge.js";
import { updatePartyDetails } from "../src/ops/einvoice.js";
import { enableLedger, ledgerReconciliation, postLedgerNow, realisedReceiptFx, revaluationDetail, revalueReceivables, trialBalance } from "../src/ops/ledger.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
async function member(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`rfx-${role}-${++n}-${Date.now()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
async function setup() {
  const t = await newTenant(db);
  const fin = await member(t.tenantId, "finance");
  const j = await convertedJob(db, t, 100000, 60000);
  await db.tenant(t.tenantId, async (c) => {
    await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]);
    await updatePartyDetails(c, t.ctx, j.customerId, { address_line: "Warehouse 4", city: "Dubai", emirate: "Dubai", country: "AE", tax_id: "100987654321003", billing_currency: "USD" });
  });
  const rate = async (r: string, asOf = future(0)) => { const id = await db.tenant(t.tenantId, (c) => proposeRate(c, fin, { from_ccy: "USD", rate: r, as_of: asOf, source: "Bank" })); await db.tenant(t.tenantId, (c) => decideRate(c, t.ctx, id, true)); };
  await rate("3.6725", future(-2));
  await db.tenant(t.tenantId, (c) => enableLedger(c, t.ctx, future(-1)));
  const inv = await db.tenant(t.tenantId, (c) => invoiceJob(c, t.ctx, j.jobId));          // AED 1050.00 = USD 285.92 at 3.6725
  const run = <T,>(fn: (c: any) => Promise<T>) => db.tenant(t.tenantId, fn);
  return { t, fin, inv, rate, run };
}
const bal = (tb: any, code: string) => tb.rows.find((r: any) => r.code === code).balance;

describe("realised FX on foreign-currency receipts", () => {
  it("settles the invoice at its own rate, books the difference as realised gain or loss, and keeps the ledger balanced", async () => {
    const s = await setup();
    const open = (await s.run((c) => getInvoice(c, s.inv.id))).inv;
    const usd = Math.round(Number(open.balance_minor) / Number(open.fx_rate));
    await s.rate("3.7000", future(0));                                                // the dirham strengthened against... paid at a better rate
    const half = Math.floor(usd / 2);
    const r1 = await s.run((c) => recordReceipt(c, s.t.ctx, s.inv.id, { billing_amount: (half / 100).toFixed(2), method: "bank transfer", received_at: future(0) }));
    expect(r1.realised_fx_minor).toBe(Math.round(half * 3.7) - Math.round(half * 3.6725));
    expect(r1.status).toBe("part_paid");
    const rest = ((usd - half) / 100).toFixed(2);
    await expect(s.run((c) => recordReceipt(c, s.t.ctx, s.inv.id, { billing_amount: ((usd - half + 1) / 100).toFixed(2) }))).rejects.toThrow(/exceeds what is still open/);
    const r2 = await s.run((c) => recordReceipt(c, s.t.ctx, s.inv.id, { billing_amount: rest, method: "bank transfer", received_at: future(0) }));
    expect(r2.status).toBe("paid");                                                    // the last receipt clears the AED balance exactly
    const after = (await s.run((c) => getInvoice(c, s.inv.id))).inv;
    expect(Number(after.balance_minor)).toBe(0);
    await s.run((c) => postLedgerNow(c, s.t.ctx));
    const fx = await s.run((c) => realisedReceiptFx(c, future(-5), future(5)));
    expect(fx.rows).toHaveLength(2);
    const tb = await s.run((c) => trialBalance(c));
    expect(tb.balanced).toBe(true);
    expect(-bal(tb, "5900")).toBe(fx.total_minor);                                     // credit balance on the FX account = total gain
    expect(bal(tb, "1100")).toBe(0);                                                   // receivables fully cleared in AED
    expect(bal(tb, "1000")).toBe(Math.round(half * 3.7) + Math.round((usd - half) * 3.7));
    expect((await s.run((c) => ledgerReconciliation(c)))!.ok).toBe(true);
    expect(await verifyInvariants(db)).toEqual([]);

    // reversing the first receipt reverses its cash and its FX exactly
    const first = (await db.query<any>(`SELECT id FROM receipts WHERE invoice_id=$1 ORDER BY received_at, id LIMIT 1`, [s.inv.id])).rows[0].id;
    await s.run((c) => reverseReceipt(c, s.t.ctx, first, "Bank returned the payment"));
    await s.run((c) => postLedgerNow(c, s.t.ctx));
    expect((await s.run((c) => trialBalance(c))).balanced).toBe(true);
    expect((await s.run((c) => ledgerReconciliation(c)))!.ok).toBe(true);
  });

  it("needs an approved current rate, refuses foreign amounts on company-currency invoices, and still takes a plain AED receipt", async () => {
    const s = await setup();
    await expect(s.run((c) => recordReceipt(c, s.t.ctx, s.inv.id, { billing_amount: "10.00", received_at: future(40) }))).rejects.toThrow(/more than 7 days/);
    await expect(s.run((c) => recordReceipt(c, s.t.ctx, s.inv.id, { billing_amount: "0" }))).rejects.toThrow(/Enter the amount/);
    const r = await s.run((c) => recordReceipt(c, s.t.ctx, s.inv.id, { amount: "100.00" }));
    expect(r.realised_fx_minor).toBe(0);
    const plain = await newTenant(db);
    const j = await convertedJob(db, plain, 100000, 60000);
    await db.tenant(plain.tenantId, (c) => c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]));
    const inv = await db.tenant(plain.tenantId, (c) => invoiceJob(c, plain.ctx, j.jobId));
    await expect(db.tenant(plain.tenantId, (c) => recordReceipt(c, plain.ctx, inv.id, { billing_amount: "10" }))).rejects.toThrow(/company currency/);
  });
});

describe("revaluation of foreign-currency receivables", () => {
  it("revalues open USD invoices at the approved rate once a day, journals the net difference and reconciles", async () => {
    const s = await setup();
    await expect(s.run((c) => revalueReceivables(c, s.t.ctx))).resolves.toMatchObject({ lines: 1, net_minor: 0 });     // rate unchanged: nothing to book
    const s2 = await setup();
    await s2.rate("3.7500", future(0));
    const v = await s2.run((c) => revalueReceivables(c, s2.t.ctx));
    const open = (await s2.run((c) => getInvoice(c, s2.inv.id))).inv;
    const usd = Math.round(Number(open.balance_minor) / Number(open.fx_rate));
    expect(v.net_minor).toBe(Math.round(usd * 3.75) - Number(open.balance_minor));
    await expect(s2.run((c) => revalueReceivables(c, s2.t.ctx))).rejects.toThrow(/already been revalued today/);
    const d = await s2.run((c) => revaluationDetail(c, v.id));
    expect(d.lines[0]).toMatchObject({ currency: "USD", diff_minor: v.net_minor });
    await s2.run((c) => postLedgerNow(c, s2.t.ctx));
    const tb = await s2.run((c) => trialBalance(c));
    expect(tb.balanced).toBe(true);
    expect(bal(tb, "1100")).toBe(Number(open.total_minor) + v.net_minor);               // receivables carried at the revalued amount
    expect(-bal(tb, "5900")).toBe(v.net_minor);
    expect((await s2.run((c) => ledgerReconciliation(c)))!.ok).toBe(true);              // the revaluation is shown apart from the sub-ledger, never as a difference
    await expect(db.system((c) => c.query(`UPDATE fx_revaluations SET net_minor=0`))).rejects.toThrow();
  });
  it("reverses a past period-end revaluation the day after, leaving receivables at their carrying value", async () => {
    const s = await setup();
    const yesterday = future(-1);
    await db.system((c) => c.query(`INSERT INTO fx_revaluations(tenant_id,as_of,net_minor,created_by) VALUES ($1,$2,2500,$3)`, [s.t.tenantId, yesterday, s.t.ctx.userId]));
    await s.run((c) => postLedgerNow(c, s.t.ctx));
    const types = (await db.query<any>(`SELECT source_type, posted_on FROM gl_journals WHERE tenant_id=$1 AND source_type LIKE 'fx_reval%' ORDER BY no`, [s.t.tenantId])).rows;
    expect(types.map((x: any) => x.source_type)).toEqual(["fx_reval", "fx_reval_reversal"]);
    const tb = await s.run((c) => trialBalance(c));
    expect(tb.balanced).toBe(true);
    expect(bal(tb, "5900")).toBe(0);
    expect(bal(tb, "1100")).toBe(105000);
  });
  it("refuses to revalue without a current approved rate, or with nothing open", async () => {
    const empty = await newTenant(db);
    await expect(db.tenant(empty.tenantId, (c) => revalueReceivables(c, empty.ctx))).rejects.toThrow(/no open foreign-currency/);
  });
});
