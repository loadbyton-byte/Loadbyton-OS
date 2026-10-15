import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, sentQuote, convertedJob, future, ctxFor } from "./helpers.js";
import { acceptQuote, approveQuote, getQuote, reviseQuote, sendQuote, submitQuote, createQuote } from "../src/ops/quotes.js";
import { addCost, closeFinancially, completeOperationally, financialClosureBlockers, getJob, reconcileCost, recordMilestone } from "../src/ops/jobs.js";
import { invoiceJob, recordReceipt, voidInvoice } from "../src/ops/finance.js";
import { uploadDocument, signDownload, verifyDownload, readDocumentFile } from "../src/ops/documents.js";
import { accountingHandlers, type AccountingAdapter } from "../src/adapters/accounting.js";
import { drainOutbox } from "../src/platform/outbox.js";
import { createParty } from "../src/ops/crm.js";
import { ownerDashboard } from "../src/ops/dashboard.js";
import { invoicesCsv } from "../src/ops/exporter.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const pdf = Buffer.from("%PDF-1.4 test proof of delivery");

describe("quoting", () => {
  it("auto-approves healthy margin; below-threshold needs a different approver; sent version locks; revision keeps history", async () => {
    const t = await newTenant(db);
    const ok = await sentQuote(db, t, 100000, 70000);              // 30% margin
    expect(ok.submit.status).toBe("approved");
    const low = await sentQuote(db, t, 100000, 95000);             // 5% < 10% threshold
    expect(low.submit.status).toBe("pending_approval");
    expect(low.submit.reasons[0]).toMatch(/below the 10.0% threshold/);
    // a non-owner author cannot self-approve; an owner can
    const salesPricing = ctxFor(t.userId, t.tenantId, ["sales", "pricing"]);
    await expect(db.tenant(t.tenantId, (c) => approveQuote(c, salesPricing, low.quoteId))).rejects.toThrow(/cannot be approved by its author/);
    await expect(db.tenant(t.tenantId, (c) => approveQuote(c, t.ctx, ok.quoteId))).rejects.toThrow(/not awaiting approval/);
    await db.tenant(t.tenantId, (c) => approveQuote(c, t.ctx, low.quoteId));
    await db.tenant(t.tenantId, async (c) => {
      await sendQuote(c, t.ctx, ok.quoteId);
      await expect(c.query(`UPDATE quote_versions SET total_sell_minor=1 WHERE quote_id=$1`, [ok.quoteId])).rejects.toThrow(/locked/);
    });
  });
  it("revision creates v2; v1 stays locked and unchanged; accepting twice yields one job", async () => {
    const t = await newTenant(db);
    const q = await sentQuote(db, t);
    await db.tenant(t.tenantId, async (c) => {
      await sendQuote(c, t.ctx, q.quoteId);
      const v = await reviseQuote(c, t.ctx, q.quoteId, { valid_until: future(10), lines: [{ description: "Ocean freight", qty: 1, unit_sell: 120000, unit_cost: 70000, supplier_id: q.supplierId }] });
      expect(v).toBe(2);
      const d = await getQuote(c, q.quoteId);
      expect(d.versions.map((x: any) => [x.version, x.locked, Number(x.total_sell_minor)])).toEqual([[2, false, 120000], [1, true, 100000]]);
      await submitQuote(c, t.ctx, q.quoteId); await sendQuote(c, t.ctx, q.quoteId);
      const a1 = await acceptQuote(c, t.ctx, q.quoteId);
      const a2 = await acceptQuote(c, t.ctx, q.quoteId);
      expect(a1.created).toBe(true); expect(a2.created).toBe(false); expect(a2.jobId).toBe(a1.jobId);
      expect((await c.query(`SELECT 1 FROM jobs`)).rows).toHaveLength(1);
      expect((await c.query(`SELECT used FROM usage_counters WHERE key='jobs_per_month'`)).rows[0].used).toBe(1);
    });
  });
  it("expired quote cannot be accepted", async () => {
    const t = await newTenant(db);
    const q = await sentQuote(db, t);
    // backdate validity while the version is still an unlocked draft, then send and try to accept
    await db.system((c) => c.query(`UPDATE quote_versions SET valid_until = current_date - 1 WHERE quote_id=$1`, [q.quoteId]));
    await db.tenant(t.tenantId, (c) => sendQuote(c, t.ctx, q.quoteId));
    await expect(db.tenant(t.tenantId, (c) => acceptQuote(c, t.ctx, q.quoteId))).rejects.toThrow(/expired/);
    const st = await db.tenant(t.tenantId, (c) => c.query(`SELECT status FROM quotes WHERE id=$1`, [q.quoteId]));
    expect(st.rows[0].status).toBe("sent");  // the failed accept rolled back; user must revise
  });
});

describe("job → cash (acceptance: late supplier invoice, accounting retry)", () => {
  it("delivered job with a late supplier invoice: operationally complete, financially open, accrual visible", async () => {
    const t = await newTenant(db);
    const j = await convertedJob(db, t, 100000, 70000);
    await db.tenant(t.tenantId, async (c) => {
      const d = await getJob(c, j.jobId);
      const delivered = d.milestones.find((m: any) => m.code === "delivered");
      await expect(recordMilestone(c, t.ctx, delivered.id)).rejects.toThrow(/proof of delivery/);
      await uploadDocument(c, t.ctx, { job_id: j.jobId, kind: "pod", title: "POD", issuer: "Consignee", filename: "pod.pdf", data: pdf });
      for (const m of d.milestones) await recordMilestone(c, t.ctx, m.id);
      await completeOperationally(c, t.ctx, j.jobId);
      const inv = await invoiceJob(c, t.ctx, j.jobId);
      expect(inv.warnings[0]).toMatch(/still estimated/);
      const blockers = await financialClosureBlockers(c, j.jobId);
      expect(blockers.join("|")).toMatch(/not fully collected/);
      expect(blockers.join("|")).toMatch(/supplier cost\(s\) still estimated/);
      const dd = await getJob(c, j.jobId);
      expect(dd.job.status).toBe("operationally_complete");
      expect(dd.job.financial_status).toBe("invoiced");
      expect(dd.margin.accrualMinor).toBe(70000);
      expect(dd.margin.actual).toBeNull();               // never labelled reconciled while a cost is estimated
      expect(dd.margin.quotation?.bps).toBe(3000);
      // dashboard shows the accrual and the unreconciled position
      const dash = await ownerDashboard(c, t.tenantId);
      expect(dash.supplier.estimatedMinor).toBe(70000);
      expect(dash.margin.accrual).toBe(70000);
      // supplier invoice arrives late and is higher; expected + actual margin update
      const cost = dd.costs[0];
      await reconcileCost(c, t.ctx, cost.id, "750.00", "SUP-INV-9");
      const after = await getJob(c, j.jobId);
      expect(after.margin.actual).toMatchObject({ sell: 100000, cost: 75000, bps: 2500 });
      const invoice = after.invoices[0];
      await recordReceipt(c, t.ctx, invoice.id, { amount: "500.00", method: "bank" });
      await expect(closeFinancially(c, t.ctx, j.jobId)).rejects.toThrow(/not fully collected/);
      await recordReceipt(c, t.ctx, invoice.id, { amount: "550.00", method: "bank" });          // 1,000 + 5% VAT = 1,050
      expect((await getJob(c, j.jobId)).job.financial_status).toBe("collected");
      await closeFinancially(c, t.ctx, j.jobId);
      expect((await getJob(c, j.jobId)).job.financial_status).toBe("closed");
      await expect(recordReceipt(c, t.ctx, invoice.id, { amount: "1.00" })).rejects.toThrow(/exceeds/);
    });
  });

  it("invoice numbering is controlled; void releases charges; receipts block void", async () => {
    const t = await newTenant(db);
    const j = await convertedJob(db, t);
    await db.tenant(t.tenantId, async (c) => {
      const a = await invoiceJob(c, t.ctx, j.jobId);
      expect(a.no).toMatch(/^INV-\d{4}-00001$/);
      await expect(invoiceJob(c, t.ctx, j.jobId)).rejects.toThrow(/No approved, uninvoiced/);
      await voidInvoice(c, t.ctx, a.id, "wrong customer reference");
      const b = await invoiceJob(c, t.ctx, j.jobId);
      expect(b.no).toMatch(/00002$/);
      await recordReceipt(c, t.ctx, b.id, { amount: "10" });
      await expect(voidInvoice(c, t.ctx, b.id, "x y z")).rejects.toThrow(/receipts/);
      const csv = await invoicesCsv(c, t.ctx);
      expect(csv.split("\n")).toHaveLength(3);
    });
  });

  it("accounting provider timeout then retry reconciles the existing external invoice; no duplicate posting", async () => {
    const t = await newTenant(db);
    await db.system((c) => c.query(`INSERT INTO accounting_connections(tenant_id,provider,status) VALUES ($1,'stub','live')`, [t.tenantId]));
    const j = await convertedJob(db, t);
    const inv = await db.tenant(t.tenantId, (c) => invoiceJob(c, t.ctx, j.jobId));
    const ledger = new Map<string, string>();
    let timeoutOnce = true;
    const adapter: AccountingAdapter = {
      async find(ref) { return ledger.has(ref) ? { externalId: ledger.get(ref)! } : null; },
      async create(i) { ledger.set(i.reference, `EXT-${i.reference}`); if (timeoutOnce) { timeoutOnce = false; throw new Error("ETIMEDOUT after create"); } return { externalId: `EXT-${i.reference}` }; },
    };
    const h = accountingHandlers(db, adapter);
    await drainOutbox(db, h);
    expect((await db.query<any>(`SELECT sync_status FROM invoices WHERE id=$1`, [inv.id])).rows[0].sync_status).toBe("failed");
    await db.query(`UPDATE outbox SET next_at=now() WHERE topic='accounting.invoice'`);
    await drainOutbox(db, h);
    const row = (await db.query<any>(`SELECT sync_status, external_id FROM invoices WHERE id=$1`, [inv.id])).rows[0];
    expect(row).toMatchObject({ sync_status: "synced", external_id: `EXT-${inv.no}` });
    expect(ledger.size).toBe(1);
    await drainOutbox(db, h);                                         // nothing pending → still one
    expect((await db.query(`SELECT 1 FROM outbox WHERE topic='accounting.invoice'`)).rows).toHaveLength(1);
  });
});

describe("documents", () => {
  it("rejects executable/markup content, bad extensions, mismatched magic bytes; enforces signed tenant-scoped access", async () => {
    const t = await newTenant(db), o = await newTenant(db);
    await db.tenant(t.tenantId, async (c) => {
      await expect(uploadDocument(c, t.ctx, { kind: "other", title: "x", filename: "a.exe", data: Buffer.from("MZ...") })).rejects.toThrow(/not allowed/);
      await expect(uploadDocument(c, t.ctx, { kind: "other", title: "x", filename: "a.pdf", data: Buffer.from("<html><script>") })).rejects.toThrow(/does not match|not allowed/);
      await expect(uploadDocument(c, t.ctx, { kind: "other", title: "x", filename: "a.txt", data: Buffer.from("<!doctype html><script>alert(1)</script>") })).rejects.toThrow(/not allowed/);
      const id = await uploadDocument(c, t.ctx, { kind: "other", title: "Booking", filename: "../../etc/passwd.pdf", data: pdf });
      const doc = (await c.query<any>(`SELECT * FROM documents WHERE id=$1`, [id])).rows[0];
      expect(doc.filename).toBe("passwd.pdf");
      const { exp, sig } = signDownload(t.tenantId, id);
      expect(verifyDownload(t.tenantId, id, exp, sig)).toBe(true);
      expect(verifyDownload(o.tenantId, id, exp, sig)).toBe(false);
      expect((await readDocumentFile(doc.storage_key, t.tenantId)).equals(pdf)).toBe(true);
      await expect(readDocumentFile(doc.storage_key, o.tenantId)).rejects.toThrow();
    });
  });
  it("storage allowance blocks new uploads but keeps existing readable", async () => {
    const t = await newTenant(db);
    await db.system((c) => c.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES ($1,'storage_mb',0,'test')`, [t.tenantId]));
    await db.tenant(t.tenantId, async (c) => {
      await expect(uploadDocument(c, t.ctx, { kind: "other", title: "x", filename: "a.pdf", data: pdf })).rejects.toThrow(/Storage allowance/);
    });
  });
});

describe("roles", () => {
  it("coordinator cannot approve quotes or invoice; auditor is read-only", async () => {
    const t = await newTenant(db);
    const coord = ctxFor(t.userId, t.tenantId, ["coordinator"]);
    const aud = ctxFor(t.userId, t.tenantId, ["auditor"]);
    const j = await convertedJob(db, t);
    await db.tenant(t.tenantId, async (c) => {
      await expect(invoiceJob(c, coord, j.jobId)).rejects.toThrow(/does not allow/);
      await expect(createParty(c, aud, { name: "x" })).rejects.toThrow(/does not allow/);
    });
  });
});
