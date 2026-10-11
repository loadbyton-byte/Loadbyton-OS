import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor, convertedJob, future } from "./helpers.js";
import { invoiceJob, getInvoice, recordReceipt } from "../src/ops/finance.js";
import { decideRate, draftCreditNote, issueCreditNote, proposeRate } from "../src/ops/finance-bridge.js";
import { generateEInvoice, previewReadiness, saveSettings, updateEntityDetails, updatePartyDetails } from "../src/ops/einvoice.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
async function member(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`fx-${role}-${++n}-${Date.now()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
const setup = async (billing: string | null) => {
  const t = await newTenant(db);
  const fin = await member(t.tenantId, "finance");
  const j = await convertedJob(db, t, 100000, 60000);
  await db.tenant(t.tenantId, async (c) => {
    await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]);
    await updatePartyDetails(c, t.ctx, j.customerId, { address_line: "Warehouse 4", city: "Dubai", emirate: "Dubai", country: "AE", tax_id: "100987654321003", billing_currency: billing ?? "" });
  });
  return { t, fin, j };
};
const approvedRate = async (t: any, fin: any, rate: string, asOf = future(0)) => {
  const id = await db.tenant(t.tenantId, (c) => proposeRate(c, fin, { from_ccy: "USD", rate, as_of: asOf, source: "Bank confirmation" }));
  await db.tenant(t.tenantId, (c) => decideRate(c, t.ctx, id, true));
  return id;
};

describe("foreign-currency customer invoicing", () => {
  it("an invoice to a USD customer carries USD amounts at the approved rate, keeps the books in AED, and states VAT in AED", async () => {
    const { t, fin, j } = await setup("USD");
    await expect(db.tenant(t.tenantId, (c) => invoiceJob(c, t.ctx, j.jobId))).rejects.toThrow(/no approved USD exchange rate/);      // never defaulted
    const stale = await approvedRate(t, fin, "3.6000", future(-20));
    await expect(db.tenant(t.tenantId, (c) => invoiceJob(c, t.ctx, j.jobId))).rejects.toThrow(/more than 7 days old/);
    void stale;
    const rateId = await approvedRate(t, fin, "3.6725");
    const inv = await db.tenant(t.tenantId, (c) => invoiceJob(c, t.ctx, j.jobId));
    const d = await db.tenant(t.tenantId, (c) => getInvoice(c, inv.id));
    // 1000.00 AED + 50.00 VAT → 272.30 USD + 13.62 USD at 3.6725 (each rounded to the cent)
    expect(d.inv).toMatchObject({ currency: "AED", billing_currency: "USD", fx_rate_id: rateId });
    expect(Number(d.inv.total_minor)).toBe(105000); expect(Number(d.inv.tax_minor)).toBe(5000);
    expect(Number(d.inv.billing_subtotal_minor)).toBe(Math.round(100000 / 3.6725)); expect(Number(d.inv.billing_tax_minor)).toBe(Math.round(5000 / 3.6725));
    expect(Number(d.inv.billing_total_minor)).toBe(Number(d.inv.billing_subtotal_minor) + Number(d.inv.billing_tax_minor));
    expect(d.lines.reduce((a: number, l: any) => a + Number(l.billing_net_minor), 0)).toBe(Number(d.inv.billing_subtotal_minor));       // lines add up in USD too
    // the books and cash stay in AED
    await db.tenant(t.tenantId, (c) => recordReceipt(c, t.ctx, inv.id, { amount: "1050.00", method: "bank transfer", received_at: future(0) }));
    expect((await db.tenant(t.tenantId, (c) => getInvoice(c, inv.id))).inv.status).toBe("paid");
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("a company-currency customer is unaffected, and a malformed billing currency is refused", async () => {
    const { t, fin, j } = await setup(null);
    const inv = await db.tenant(t.tenantId, (c) => invoiceJob(c, t.ctx, j.jobId));
    expect((await db.tenant(t.tenantId, (c) => getInvoice(c, inv.id))).inv.billing_currency).toBeNull();
    void fin;
    await expect(db.tenant(t.tenantId, (c) => updatePartyDetails(c, t.ctx, j.customerId, { billing_currency: "dollars" }))).rejects.toThrow(/three-letter/);
  });

  it("the e-invoice and its credit note are presented in USD with a second tax total in AED", async () => {
    const { t, fin, j } = await setup("USD");
    await approvedRate(t, fin, "3.6725");
    await db.tenant(t.tenantId, async (c) => {
      await c.query(`UPDATE entities SET legal_name='Fx Logistics LLC'`);
      await updateEntityDetails(c, t.ctx, { tax_id: "100111222333004", address_line: "x", city: "Dubai", emirate: "Dubai", einvoice_scheme: "S", einvoice_endpoint: "E" });
      await saveSettings(c, t.ctx, { mode: "sandbox", customization_id: "C", profile_id: "P" });
    });
    const inv = await db.tenant(t.tenantId, (c) => invoiceJob(c, t.ctx, j.jobId));
    expect((await db.tenant(t.tenantId, (c) => previewReadiness(c, "invoice", inv.id))).issues.filter((i) => i.level === "blocker")).toEqual([]);
    const doc = await db.tenant(t.tenantId, (c) => generateEInvoice(c, fin, "invoice", inv.id));
    const xml: string = doc.payload_xml;
    expect(doc.submittable).toBe(true);
    expect(xml).toContain("<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>"); expect(xml).toContain("<cbc:TaxCurrencyCode>AED</cbc:TaxCurrencyCode>");
    expect(xml).toContain('<cbc:TaxAmount currencyID="AED">50.00</cbc:TaxAmount>');
    expect(xml).toContain(`<cbc:TaxAmount currencyID="USD">${(Math.round(5000 / 3.6725) / 100).toFixed(2)}</cbc:TaxAmount>`);
    expect(xml.match(/<cac:TaxTotal>/g)).toHaveLength(2);
    const cnId = await db.tenant(t.tenantId, async (c) => { const id = await draftCreditNote(c, fin, inv.id, { reason: "Short delivery", lines: [{ description: "Short delivery", qty: 1, unit: 20000, tax_code: "SR5" }] }); await issueCreditNote(c, t.ctx, id); return id; });
    const cdoc = await db.tenant(t.tenantId, (c) => generateEInvoice(c, fin, "credit_note", cnId));
    expect(cdoc.submittable).toBe(true);
    expect(cdoc.payload_xml).toContain("<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>"); expect(cdoc.payload_xml).toContain('<cbc:TaxAmount currencyID="AED">10.00</cbc:TaxAmount>');
    expect(cdoc.payload_xml).toContain(`<cbc:PriceAmount currencyID="USD">${(Math.round(20000 / 3.6725) / 100).toFixed(2)}</cbc:PriceAmount>`);
  });
});
