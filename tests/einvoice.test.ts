import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor, convertedJob } from "./helpers.js";
import { invoiceJob } from "../src/ops/finance.js";
import { draftCreditNote, issueCreditNote } from "../src/ops/finance-bridge.js";
import { buildUbl, FORMAT_LABEL, generateEInvoice, getSettings, previewReadiness, saveSettings, submitEInvoice, updateEntityDetails, updatePartyDetails } from "../src/ops/einvoice.js";
import { PROVIDERS, sandboxAdapter } from "../src/adapters/einvoice.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
async function member(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`ei-${role}-${++n}-${Date.now()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}

describe("e-invoice groundwork", () => {
  it("blocks an incomplete payload, builds UBL from complete data, and tracks a sandbox submission with separation of duties", async () => {
    const t = await newTenant(db);
    const fin = await member(t.tenantId, "finance");
    const j = await convertedJob(db, t, 100000, 60000);
    const inv = await db.tenant(t.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]); return invoiceJob(c, t.ctx, j.jobId); });
    const first = await db.tenant(t.tenantId, (c) => generateEInvoice(c, fin, "invoice", inv.id));
    expect(first.submittable).toBe(false);
    const codes = (first.issues as any[]).filter((i) => i.level === "blocker").map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["supplier_trn", "supplier_address", "supplier_endpoint", "buyer_address", "format_ids"]));
    await expect(db.tenant(t.tenantId, (c) => submitEInvoice(c, t.ctx, first.id))).rejects.toThrow(/blocking issues/);

    // complete the data: supplier, customer, provider identifiers
    await db.tenant(t.tenantId, async (c) => {
      await updateEntityDetails(c, t.ctx, { tax_id: "100 2345 6789 0003", address_line: "Office 12, Business Bay", city: "Dubai", emirate: "Dubai", country: "AE", einvoice_scheme: "SCHEME-X", einvoice_endpoint: "SUP-ENDPOINT-1", legal_name_ar: "شركة الاختبار" });
      await c.query(`UPDATE entities SET legal_name='Test Logistics & Co LLC'`);
      await updatePartyDetails(c, t.ctx, j.customerId, { tax_id: "100987654321003", address_line: "Warehouse 4, <Jebel Ali>", city: "Dubai", emirate: "Dubai", country: "AE", name_ar: "العميل" });
      await saveSettings(c, t.ctx, { mode: "sandbox", customization_id: "CUSTOM-ID-FROM-PROVIDER", profile_id: "PROFILE-ID-FROM-PROVIDER" });
    });
    await expect(db.tenant(t.tenantId, (c) => updateEntityDetails(c, t.ctx, { tax_id: "123" }))).rejects.toThrow(/15 digits/);
    await expect(db.tenant(t.tenantId, (c) => saveSettings(c, t.ctx, { mode: "live", provider: "no-such-asp" }))).rejects.toThrow(/No adapter is installed/);
    const ready = await db.tenant(t.tenantId, (c) => previewReadiness(c, "invoice", inv.id));
    expect(ready.issues.filter((i) => i.level === "blocker")).toEqual([]);
    expect(ready.issues.map((i) => i.code)).toContain("buyer_endpoint");                          // advisory only

    const doc = await db.tenant(t.tenantId, (c) => generateEInvoice(c, fin, "invoice", inv.id));
    expect(doc.submittable).toBe(true); expect(doc.format_label).toBe(FORMAT_LABEL);
    expect((await db.query<any>(`SELECT status FROM einvoice_documents WHERE id=$1`, [first.id])).rows[0].status).toBe("error");   // the stale payload is superseded
    const xml: string = doc.payload_xml;
    expect(xml).toContain("<Invoice xmlns=\"urn:oasis:names:specification:ubl:schema:xsd:Invoice-2\"");
    expect(xml).toContain(`<cbc:ID>${inv.no}</cbc:ID>`);
    expect(xml).toContain("<cbc:CompanyID>100234567890003</cbc:CompanyID>");                    // spaces stripped
    expect(xml).toContain("Warehouse 4, &lt;Jebel Ali&gt;");                                      // escaped
    expect(xml).toContain("Test Logistics &amp; Co LLC");
    expect(xml).toContain("<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>");
    expect(xml).toContain("<cbc:CustomizationID>CUSTOM-ID-FROM-PROVIDER</cbc:CustomizationID>");
    expect(xml).toMatch(/<cbc:ID>S<\/cbc:ID><cbc:Percent>5\.00<\/cbc:Percent>/);
    expect(xml).toContain('<cbc:PayableAmount currencyID="AED">1050.00</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="AED">50.00</cbc:TaxAmount>');
    // an unchanged regeneration returns the same row
    expect((await db.tenant(t.tenantId, (c) => generateEInvoice(c, fin, "invoice", inv.id))).id).toBe(doc.id);

    await expect(db.tenant(t.tenantId, (c) => submitEInvoice(c, fin, doc.id))).rejects.toThrow(/Your role/);
    const sent = await db.tenant(t.tenantId, (c) => submitEInvoice(c, t.ctx, doc.id));
    expect(sent.status).toBe("accepted"); expect(sent.provider).toBe("sandbox"); expect(sent.provider_response.sandbox).toBe(true);
    expect((await db.tenant(t.tenantId, (c) => submitEInvoice(c, t.ctx, doc.id))).status).toBe("accepted");          // idempotent
    await expect(db.query(`UPDATE einvoice_documents SET status='rejected' WHERE id=$1`, [doc.id])).rejects.toThrow(/final/);
    await expect(db.query(`UPDATE einvoice_documents SET payload_xml='x' WHERE id=$1`, [doc.id])).rejects.toThrow(/immutable/);

    // a credit note against it becomes a credit-note document that references the invoice
    const cnId = await db.tenant(t.tenantId, async (c) => { const id = await draftCreditNote(c, fin, inv.id, { reason: "Short delivery", lines: [{ description: "Short delivery", qty: 1, unit: 20000, tax_code: "SR5" }] }); await issueCreditNote(c, t.ctx, id); return id; });
    const cdoc = await db.tenant(t.tenantId, (c) => generateEInvoice(c, fin, "credit_note", cnId));
    expect(cdoc.payload_xml).toContain("<CreditNote xmlns=");
    expect(cdoc.payload_xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
    expect(cdoc.payload_xml).toContain(`<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${inv.no}</cbc:ID>`);
    expect(cdoc.payload_xml).toContain("<cbc:CreditedQuantity");
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("live mode needs an installed adapter; the sandbox is refused there and a rejecting provider is recorded", async () => {
    const t = await newTenant(db);
    const j = await convertedJob(db, t, 50000, 30000);
    const inv = await db.tenant(t.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]); return invoiceJob(c, t.ctx, j.jobId); });
    await db.tenant(t.tenantId, async (c) => {
      await c.query(`UPDATE entities SET legal_name='Second Logistics LLC'`);
      await updateEntityDetails(c, t.ctx, { tax_id: "100111222333004", address_line: "x", city: "Dubai", emirate: "Dubai", einvoice_scheme: "S", einvoice_endpoint: "E" });
      await updatePartyDetails(c, t.ctx, j.customerId, { address_line: "y", city: "Dubai", country: "AE" });
      await saveSettings(c, t.ctx, { mode: "sandbox", customization_id: "C", profile_id: "P" });
    });
    const doc = await db.tenant(t.tenantId, (c) => generateEInvoice(c, t.ctx, "invoice", inv.id));
    expect(doc.submittable).toBe(true);
    // a provider adapter that rejects
    PROVIDERS["fake-asp"] = () => ({ name: "fake-asp", submit: async () => ({ providerRef: "R1", status: "rejected", reasons: ["Buyer endpoint unknown"] }), status: async (r) => ({ providerRef: r, status: "rejected", reasons: [] }) });
    await db.tenant(t.tenantId, (c) => saveSettings(c, t.ctx, { mode: "live", provider: "fake-asp", customization_id: "C", profile_id: "P" }));
    await expect(db.tenant(t.tenantId, (c) => submitEInvoice(c, t.ctx, doc.id, sandboxAdapter()))).rejects.toThrow(/cannot use the sandbox/);
    const done = await db.tenant(t.tenantId, (c) => submitEInvoice(c, t.ctx, doc.id));
    expect(done).toMatchObject({ status: "rejected", provider: "fake-asp", provider_ref: "R1" });
    expect(done.provider_response.reasons).toEqual(["Buyer endpoint unknown"]);
    // a rejected document can be generated afresh after the fix
    const again = await db.tenant(t.tenantId, (c) => generateEInvoice(c, t.ctx, "invoice", inv.id));
    expect(again.id).not.toBe(doc.id); expect(again.status).toBe("generated");
    delete PROVIDERS["fake-asp"];
    expect((await db.tenant(t.tenantId, (c) => getSettings(c))).mode).toBe("live");
  });

  it("the sandbox rejects a structurally incomplete document", async () => {
    const adapter = sandboxAdapter();
    expect((await adapter.submit({ reference: "A", kind: "invoice", xml: "<Invoice></Invoice>" })).status).toBe("rejected");
    const ok = buildUbl({ kind: "invoice", number: "X-1", issuedAt: new Date(), currency: "AED", subtotal: 100, tax: 5, total: 105, lines: [{ description: "d", qty: 1, unit_minor: 100, net_minor: 100, tax_minor: 5, tax_code: "SR5" }] },
      { name: "S", legal_name: "S", tax_id: "100000000000003", address_line: "a", city: "c", country: "AE" }, { name: "B", tax_id: null, country: "AE" }, {});
    expect((await adapter.submit({ reference: "B", kind: "invoice", xml: ok })).status).toBe("accepted");
  });
});
