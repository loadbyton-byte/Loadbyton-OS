import crypto from "node:crypto";
import { describe, expect, it, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, convertedJob } from "./helpers.js";
import { ProviderError, type StructuredDoc } from "../src/adapters/einvoice.js";
import { aigentrixAdapter, aigentrixBody, mapAigentrixStatus, validateAigentrixCredentials } from "../src/adapters/einvoice-aigentrix.js";
import { invoiceJob } from "../src/ops/finance.js";
import { creditReasonCode, generateEInvoice, sendDocument, updateEntityDetails, updatePartyDetails } from "../src/ops/einvoice.js";
import { getService, requestActivation, staffConfigure, staffSetState } from "../src/ops/einvoice-service.js";
import { handleAigentrixWebhook, listInbound, pollSubmittedDocuments, verifyAigentrixSignature } from "../src/ops/einvoice-sync.js";

const reply = (status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const KEY = "agx_test_key_0123456789abcdef", CO = "20", SECRET = "whsec-aigentrix-fixture-0123456789";
let db: Db, n = 0;
beforeAll(async () => { db = await freshDb(); });

const doc: StructuredDoc = { number: "INV-1", issueDate: "2026-10-01", dueDate: "2026-10-31", currency: "AED",
  supplier: { name: "S", legalName: "S LLC", trn: "100000000000003", street: "a", city: "Dubai", emirate: "Dubai", country: "AE" },
  buyer: { name: "B", legalName: "Buyer LLC", trn: "100999999999003", peppolId: "0235:1009999999", street: "Warehouse 4", city: "Dubai", emirate: "Dubai", country: "AE" },
  lines: [{ description: "Freight", quantity: 2, unitPrice: 100, taxCategory: "S", taxPercent: 5, netAmount: 200, taxAmount: 10 }, { description: "Docs", quantity: 1, unitPrice: 50, taxCategory: "E", taxPercent: 0, exemptionReason: "Exempt supply", netAmount: 50, taxAmount: 0 }],
  totals: { net: 250, tax: 10, total: 260 } };
const creds = { apiKey: KEY, taxpayerId: CO, environment: "sandbox" };
const adapter = (f: typeof fetch) => aigentrixAdapter(validateAigentrixCredentials(creds), f);

/** A fake Aigentrix keyed by "METHOD /path"; every call is logged. */
const fake = (log: any[], over: Record<string, (init?: RequestInit, url?: URL) => Response> = {}): typeof fetch => (async (url: string, init?: RequestInit) => {
  const u = new URL(url), key = `${init?.method ?? "GET"} ${u.pathname.replace("/external/api/v1", "")}`;
  log.push({ key, url: u, init });
  const h = over[key];
  if (h) return h(init, u);
  if (key === "GET /eInvoiceEntry") return reply(200, { content: [] });
  if (key === "POST /eInvoiceEntry/createFull") return reply(200, { success: true, entryId: 777, documentId: "INV-1" });
  if (key === "PUT /eInvoiceEntry/777") return reply(200, { id: 777, documentIdEN: "INV-1", status: "SUBMITTED" });
  return reply(404, {});
}) as typeof fetch;

describe("Aigentrix adapter", () => {
  it("validates credentials", () => {
    expect(() => validateAigentrixCredentials({ ...creds, apiKey: "short" })).toThrow(/API key/);
    expect(() => validateAigentrixCredentials({ ...creds, taxpayerId: "100123456789012x" })).toThrow(/company ID/);
    expect(() => validateAigentrixCredentials({ ...creds, environment: "staging" })).toThrow(/Sandbox or Live/);
    expect(() => validateAigentrixCredentials({ ...creds, baseUrl: "http://x" })).toThrow(/https/);
    expect(validateAigentrixCredentials({ ...creds, environment: "LIVE" })).toMatchObject({ companyId: CO, environment: "live" });
  });

  it("builds the invoice body: no seller block, our own totals with the difference in rounding, exemption text, ZZZ payment means", () => {
    const b: any = aigentrixBody("invoice", doc, CO);
    expect(b).toMatchObject({ companyId: 20, documentId: "INV-1", invoiceTypeCode: "380", invoiceTransactionType: "00000000", documentCurrencyCode: "AED", paymentDueDate: "2026-10-31", buyerVatTrn: "100999999999003", buyerCountrySubdivision: "DXB", buyerCountryCode: "AE", customerParticipantId: "0235:1009999999" });
    expect(Object.keys(b).some((k) => k.startsWith("seller"))).toBe(false);
    expect(b).toMatchObject({ lineExtensionTotal: 250, taxAmount: 10, totalIncludingTax: 260, roundingAmount: 0, payableAmount: 260, payments: [{ paymentMeansCode: "ZZZ" }] });
    expect(b.lines[1]).toMatchObject({ taxCategory: "E", vatExemptReasonText: "Exempt supply", lineNetAmount: 50 });
    // the provider computes tax once per breakdown; a difference from the invoice's own total lands in roundingAmount
    const odd: any = aigentrixBody("invoice", { ...doc, lines: [{ description: "x", quantity: 3, unitPrice: 0.33, taxCategory: "S", taxPercent: 5, netAmount: 0.99, taxAmount: 0.05 }], totals: { net: 0.99, tax: 0.05, total: 1.04 } }, CO);
    expect(odd).toMatchObject({ lineExtensionTotal: 0.99, taxAmount: 0.05, totalIncludingTax: 1.04, roundingAmount: 0, payableAmount: 1.04 });
    const skewed: any = aigentrixBody("invoice", { ...doc, lines: [{ description: "x", quantity: 1, unitPrice: 10.1, taxCategory: "S", taxPercent: 5, netAmount: 10.1, taxAmount: 0.51 }], totals: { net: 10.1, tax: 0.51, total: 10.61 } }, CO);
    expect(skewed.payableAmount).toBe(10.61); expect(skewed.roundingAmount).toBeCloseTo(10.61 - skewed.totalIncludingTax, 2);
  });

  it("builds a credit note that points at the original, carries the FTA reason code and no payment means", () => {
    const b: any = aigentrixBody("credit_note", { ...doc, number: "CN-1", precedingNumber: "INV-1", precedingIssueDate: "2026-10-01", reasonCode: "DL8.61.1.D" }, CO);
    expect(b).toMatchObject({ invoiceTypeCode: "381", documentId: "CN-1", originalInvoiceReference: "INV-1", originalInvoiceReferenceDate: "2026-10-01", creditNoteReasonCode: "DL8.61.1.D", payments: [] });
    expect(b.paymentDueDate).toBeUndefined();
  });

  it("reads FTA credit-note reasons from explicit codes first, then plain wording", () => {
    expect(creditReasonCode("Short delivery [DL8.61.1.d]")).toBe("DL8.61.1.D");
    expect(creditReasonCode("voluntary disclosure VD")).toBe("VD");
    expect(creditReasonCode("Goods returned")).toBe("DL8.61.1.D"); expect(creditReasonCode("Order cancelled")).toBe("DL8.61.1.A");
    expect(creditReasonCode("Typing error on the invoice")).toBe("DL8.61.1.E"); expect(creditReasonCode("Price reduced after negotiation")).toBe("DL8.61.1.C");
    expect(creditReasonCode("Customer unhappy")).toBeUndefined();
  });

  it("creates the draft, then submits it, with the organisation key; the result waits on the provider's decision", async () => {
    const log: any[] = [];
    const r = await adapter(fake(log)).submit({ reference: "T-INV-1", kind: "invoice", xml: "<Invoice/>", doc });
    expect(r).toEqual({ providerRef: "777", status: "submitted", reasons: [] });
    expect(log.map((l) => l.key)).toEqual(["GET /eInvoiceEntry", "POST /eInvoiceEntry/createFull", "PUT /eInvoiceEntry/777"]);
    expect(log[1].init.headers["x-api-key"]).toBe(KEY);
    expect(JSON.parse(log[1].init.body)).toMatchObject({ companyId: 20, documentId: "INV-1" });
    expect(JSON.parse(log[2].init.body)).toEqual({ id: 777, status: "SUBMITTED" });
    expect(log[0].url.searchParams.get("companyId")).toBe("20"); expect(log[0].url.searchParams.get("searchString")).toBe("INV-1");
  });

  it("adopts an entry that was already sent instead of creating it twice, but overwrites one that failed", async () => {
    const sent: any[] = [];
    const a = await adapter(fake(sent, { "GET /eInvoiceEntry": () => reply(200, { content: [{ id: 555, documentIdEN: "INV-1", status: "DELIVERED" }] }) })).submit({ reference: "r", kind: "invoice", xml: "x", doc });
    expect(a).toMatchObject({ providerRef: "555", status: "accepted" }); expect(sent.map((l) => l.key)).toEqual(["GET /eInvoiceEntry"]);
    const failed: any[] = [];
    const b = await adapter(fake(failed, { "GET /eInvoiceEntry": () => reply(200, { content: [{ id: 555, documentIdEN: "INV-1", status: "VALIDATION_FAILED" }] }) })).submit({ reference: "r", kind: "invoice", xml: "x", doc });
    expect(b.providerRef).toBe("777"); expect(failed.map((l) => l.key)).toContain("POST /eInvoiceEntry/createFull");
    const other = await adapter(fake([], { "GET /eInvoiceEntry": () => reply(200, { content: [{ id: 9, documentIdEN: "INV-10", status: "DELIVERED" }] }) })).submit({ reference: "r", kind: "invoice", xml: "x", doc });
    expect(other.providerRef).toBe("777");                                                  // a different document number is not ours
  });

  it("treats a business refusal as a rejection, an account problem as final, and an outage as retryable", async () => {
    const rejected = await adapter(fake([], { "POST /eInvoiceEntry/createFull": () => reply(200, { success: false, error: "[ibr-167-ae] Line 2: vatExemptReasonCode is mandatory when taxCategory is 'E'." }) })).submit({ reference: "r", kind: "invoice", xml: "x", doc });
    expect(rejected).toMatchObject({ status: "rejected", reasons: [expect.stringContaining("ibr-167-ae")] });
    await expect(adapter(fake([], { "POST /eInvoiceEntry/createFull": () => reply(200, { success: false, errorKey: "document.limit.exist" }) })).submit({ reference: "r", kind: "invoice", xml: "x", doc })).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("limit") });
    await expect(adapter(fake([], { "POST /eInvoiceEntry/createFull": () => reply(200, { success: false, errorKey: "document.plan.missing" }) })).submit({ reference: "r", kind: "invoice", xml: "x", doc })).rejects.toMatchObject({ retryable: false });
    await expect(adapter(fake([], { "GET /eInvoiceEntry": () => reply(401, { errorKey: "API key missing" }) })).submit({ reference: "r", kind: "invoice", xml: "x", doc })).rejects.toMatchObject({ retryable: false });
    await expect(adapter(fake([], { "PUT /eInvoiceEntry/777": () => reply(503, {}) })).submit({ reference: "r", kind: "invoice", xml: "x", doc })).rejects.toMatchObject({ retryable: true });
    await expect(adapter((async () => { throw new Error("ECONNRESET"); }) as any).submit({ reference: "r", kind: "invoice", xml: "x", doc })).rejects.toBeInstanceOf(ProviderError);
  });

  it("refuses a credit note with no FTA reason code before contacting the provider", async () => {
    const log: any[] = [];
    const r = await adapter(fake(log)).submit({ reference: "r", kind: "credit_note", xml: "x", doc: { ...doc, number: "CN-1", precedingNumber: "INV-1" } });
    expect(r.status).toBe("rejected"); expect(r.reasons[0]).toMatch(/reason code/); expect(log).toEqual([]);
  });

  it("maps delivery and reporting separately, never reading a pending state as accepted, and fetches the reasons for a failure", async () => {
    expect(mapAigentrixStatus("SENDING", "7")).toMatchObject({ status: "submitted" });
    expect(mapAigentrixStatus("DELIVERED", "7", "REPORTING_INITIATED")).toEqual({ providerRef: "7", status: "accepted", reasons: [], reporting: "REPORTING_INITIATED" });
    expect(mapAigentrixStatus("TRANSMISSION_FAILED", "7")).toMatchObject({ status: "submitted", reasons: [expect.stringMatching(/retrying/)] });
    const ok = await adapter(fake([], { "GET /eInvoiceEntry/777": () => reply(200, { id: 777, status: "ACKNOWLEDGED", taxStatus: "REPORTING_CONFIRMED" }) })).status("777");
    expect(ok).toEqual({ providerRef: "777", status: "accepted", reasons: [], reporting: "REPORTING_CONFIRMED" });
    const bad = await adapter(fake([], { "GET /eInvoiceEntry/777": () => reply(200, { id: 777, status: "VALIDATION_FAILED" }), "GET /eInvoiceEntry/777/validationErrors": () => reply(200, { errors: ["[BR-CO-15] Amount due mismatch"], warnings: [] }) })).status("777");
    expect(bad).toMatchObject({ status: "rejected", reasons: ["[BR-CO-15] Amount due mismatch"] });
  });

  it("downloads the exact sent or received XML and describes a received document", async () => {
    const log: any[] = [];
    const a = adapter(fake(log, { "GET /print/orgxml/9": () => reply(200, "<Invoice/>", { "content-type": "application/xml" }), "GET /eInvoiceEntry/9": () => reply(200, { id: 9, documentIdEN: "S-77", supplyPartyNameEN: "Supplier LLC", documentCurrencyCode: "AED", legalFinalPayableEN: 1050.5, issueDateEN: "2026-09-30T00:00:00" }) }));
    expect(await a.downloadXml!("9")).toBe("<Invoice/>"); await a.downloadXml!("9", { inbound: true });
    expect(log.map((l) => l.url.searchParams.get("fileName"))).toEqual(["outbound_sent", "inbound_receive"]);
    expect(await a.describeDocument!("9")).toEqual({ providerDocId: "9", number: "S-77", senderName: "Supplier LLC", currency: "AED", totalMinor: 105050, issuedOn: "2026-09-30" });
  });
});

async function staffUser(role = "commercial_admin") {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'staff','x') RETURNING id`, [`agx-staff-${++n}-${Date.now()}@example.com`]))).rows[0].id;
  return { userId: id as string, role };
}
let companySeq = 1000;
async function onboarded(environment = "sandbox") {
  const t = await newTenant(db), j = await convertedJob(db, t, 100000, 60000), staff = await staffUser(), companyId = String(++companySeq);
  const inv = await db.tenant(t.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]); return invoiceJob(c, t.ctx, j.jobId); });
  await db.tenant(t.tenantId, async (c) => {
    await updateEntityDetails(c, t.ctx, { tax_id: "100234567890003", address_line: "Office 12", city: "Dubai", emirate: "Dubai", country: "AE" });
    await c.query(`UPDATE entities SET legal_name='Managed Logistics LLC'`);
    await updatePartyDetails(c, t.ctx, j.customerId, { tax_id: "100987654321003", address_line: "Warehouse 4", city: "Dubai", emirate: "Dubai", country: "AE" });
    await requestActivation(c, t.ctx, "start");
  });
  await staffConfigure(db, staff, t.tenantId, { provider: "aigentrix", api_key: KEY, taxpayer_id: companyId, environment, webhook_secret: SECRET });
  return { t, inv, staff, companyId };
}
const send = (t: any, docId: string, f: typeof fetch) => db.tenant(t.tenantId, async (c) => {
  const d = (await c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1 FOR UPDATE`, [docId])).rows[0];
  return sendDocument(c, { userId: t.ctx.userId, actor: { kind: "user", userId: t.ctx.userId } }, t.tenantId, d, undefined, f);
});
const sign = (body: unknown, opts: { secret?: string; t?: number } = {}) => {
  const raw = JSON.stringify(body), ts = String(opts.t ?? Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${raw}`).digest("hex");
  return { raw, header: (name: string) => (name === "x-aigentrix-signature" ? `t=${ts},v1=${sig}` : undefined) };
};
const evt = (companyId: string, over: Record<string, unknown>) => ({ eventId: crypto.randomUUID(), eventType: "invoice.status_updated", environment: "SANDBOX", occurredAt: new Date().toISOString(), entryId: 777, invoiceNumber: "X", companyId: Number(companyId), organisationId: 1, type: "OUTBOUND", changedField: "status", previousValue: "SENDING", newValue: "DELIVERED", ...over });

describe("Aigentrix as a managed provider", () => {
  it("is attached by staff, with the key and webhook secret stored encrypted and each company claimed by one workspace only", async () => {
    const { t, companyId, staff } = await onboarded();
    const stored = (await db.query<any>(`SELECT credentials_enc FROM einvoice_credentials WHERE tenant_id=$1`, [t.tenantId])).rows[0].credentials_enc as string;
    expect(stored).not.toContain(KEY); expect(stored).not.toContain(SECRET);
    expect(await db.tenant(t.tenantId, (c) => getService(c))).toMatchObject({ provider: "aigentrix", environment: "sandbox", taxpayer_ref: companyId });
    await staffConfigure(db, staff, t.tenantId, { provider: "aigentrix", environment: "live" });          // blank key and company keep what is stored
    expect(await db.tenant(t.tenantId, (c) => getService(c))).toMatchObject({ environment: "live", taxpayer_ref: companyId });
    const other = await onboarded();
    await expect(staffConfigure(db, staff, other.t.tenantId, { provider: "aigentrix", taxpayer_id: companyId })).rejects.toThrow(/already attached/);
    await expect(staffConfigure(db, staff, t.tenantId, { provider: "aigentrix", environment: "staging" })).rejects.toThrow(/Sandbox or Live/);
  });

  it("sends an invoice through the client's company, records the entry, and keeps Sandbox off the paid allowance", async () => {
    const { t, inv } = await onboarded();
    const d = await db.tenant(t.tenantId, (c) => generateEInvoice(c, t.ctx, "invoice", inv.id));
    expect(d.submittable).toBe(true);
    const log: any[] = [];
    const sent = await send(t, d.id, fake(log));
    expect(sent).toMatchObject({ status: "submitted", provider: "aigentrix", provider_ref: "777" }); expect(sent.provider_response.sandbox).toBe(true);
    expect(JSON.parse(log.find((l) => l.key === "POST /eInvoiceEntry/createFull").init.body)).toMatchObject({ documentId: inv.no, payableAmount: 1050, taxAmount: 50 });
    expect((await db.tenant(t.tenantId, (c) => getService(c))).used_docs).toBe(0);
  });

  it("applies signed delivery and reporting events once, and ignores replays, forgeries, stale timestamps and strangers", async () => {
    const { t, inv, companyId } = await onboarded();
    const d = await db.tenant(t.tenantId, (c) => generateEInvoice(c, t.ctx, "invoice", inv.id)); await send(t, d.id, fake([]));
    const row = () => db.query<any>(`SELECT status, tdd_status FROM einvoice_documents WHERE id=$1`, [d.id]).then((r) => r.rows[0]);
    const delivered = evt(companyId, { newValue: "DELIVERED" });
    expect(await handleAigentrixWebhook(db, sign(delivered))).toEqual({ status: 200, body: { ok: true } });
    expect(await row()).toEqual({ status: "accepted", tdd_status: null });
    expect(await handleAigentrixWebhook(db, sign(delivered))).toEqual({ status: 200, body: { duplicate: true } });
    await handleAigentrixWebhook(db, sign(evt(companyId, { changedField: "taxStatus", newValue: "REPORTING_CONFIRMED" })));
    expect(await row()).toEqual({ status: "accepted", tdd_status: "REPORTING_CONFIRMED" });
    await handleAigentrixWebhook(db, sign(evt(companyId, { newValue: "REJECTED" })));                  // a decision is never changed afterwards
    expect((await row()).status).toBe("accepted");
    expect((await handleAigentrixWebhook(db, sign(evt(companyId, {}), { secret: "wrong-secret-wrong-secret-xx" }))).status).toBe(401);
    expect((await handleAigentrixWebhook(db, sign(evt(companyId, {}), { t: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
    expect((await handleAigentrixWebhook(db, sign(evt("999999", {})))).status).toBe(401);              // unknown company looks the same as a bad signature
    expect((await handleAigentrixWebhook(db, { raw: "not json", header: () => undefined })).status).toBe(401);
    expect(verifyAigentrixSignature(SECRET, undefined, "{}")).toBe(false);
  });

  it("records a rejection with the provider's reason, and answers the subscription handshake with a signed challenge", async () => {
    const { t, inv, companyId } = await onboarded();
    const d = await db.tenant(t.tenantId, (c) => generateEInvoice(c, t.ctx, "invoice", inv.id)); await send(t, d.id, fake([]));
    await handleAigentrixWebhook(db, sign(evt(companyId, { newValue: "REJECTED", rejectionReason: "Buyer not registered for e-invoicing" })));
    expect((await db.query<any>(`SELECT status, provider_response FROM einvoice_documents WHERE id=$1`, [d.id])).rows[0]).toMatchObject({ status: "rejected", provider_response: { reasons: ["Buyer not registered for e-invoicing"] } });
    const hs = await handleAigentrixWebhook(db, sign({ eventId: "h1", eventType: "webhook.verification", environment: "SANDBOX", companyId: Number(companyId), data: { challenge: "abc123" } }));
    expect(hs).toEqual({ status: 200, body: { challenge: "abc123", signature: crypto.createHmac("sha256", SECRET).update("abc123").digest("hex") } });
  });

  it("asks for a retry when an event outruns our own record of the entry", async () => {
    const { t, inv, companyId } = await onboarded();
    const early = evt(companyId, { entryId: 888 });
    expect((await handleAigentrixWebhook(db, sign(early))).status).toBe(503);
    const d = await db.tenant(t.tenantId, (c) => generateEInvoice(c, t.ctx, "invoice", inv.id));
    await send(t, d.id, fake([], { "POST /eInvoiceEntry/createFull": () => reply(200, { success: true, entryId: 888 }), "PUT /eInvoiceEntry/888": () => reply(200, { id: 888, status: "SUBMITTED" }) }));
    expect((await handleAigentrixWebhook(db, sign(early))).status).toBe(200);
    expect((await db.query<any>(`SELECT status FROM einvoice_documents WHERE id=$1`, [d.id])).rows[0].status).toBe("accepted");
  });

  it("suspends the service if events come from a different environment than staff configured", async () => {
    const { t, companyId } = await onboarded("sandbox");
    const r = await handleAigentrixWebhook(db, sign(evt(companyId, { environment: "LIVE" })));
    expect(r.body).toMatchObject({ ignored: expect.stringMatching(/environment mismatch/) });
    expect((await db.tenant(t.tenantId, (c) => getService(c))).state).toBe("suspended");
    expect((await db.query<any>(`SELECT 1 FROM audit_log WHERE action='einvoice.environment_mismatch' AND tenant_id=$1`, [t.tenantId])).rows).toHaveLength(1);
  });

  it("records a received supplier invoice with its details", async () => {
    const { t, companyId } = await onboarded();
    const f = fake([], { "GET /eInvoiceEntry/4040": () => reply(200, { id: 4040, documentIdEN: "S-9", supplyPartyNameEN: "Supplier LLC", documentCurrencyCode: "AED", legalFinalPayableEN: 210, issueDateEN: "2026-10-02T00:00:00" }) });
    expect((await handleAigentrixWebhook(db, sign(evt(companyId, { eventType: "invoice.received", type: "INBOUND", entryId: 4040, invoiceNumber: "S-9" })), f)).status).toBe(200);
    const rows = await db.tenant(t.tenantId, (c) => listInbound(c));
    expect(rows).toEqual([expect.objectContaining({ provider: "aigentrix", number: "S-9", sender_name: "Supplier LLC", currency: "AED" })]);
    expect(Number(rows[0].total_minor)).toBe(21000);
  });

  it("catches a lost webhook by polling documents still awaiting a decision", async () => {
    const { t, inv } = await onboarded("live");
    await staffSetState(db, { userId: (await staffUser()).userId, role: "commercial_admin" }, t.tenantId, "active", "paid");
    const d = await db.tenant(t.tenantId, (c) => generateEInvoice(c, t.ctx, "invoice", inv.id)); await send(t, d.id, fake([]));
    expect((await pollSubmittedDocuments(db, fake([]))).due).toBe(0);                                  // too recent
    await db.system((c) => c.query(`UPDATE einvoice_documents SET submitted_at = now() - interval '5 minutes' WHERE id=$1`, [d.id]));
    const r = await pollSubmittedDocuments(db, fake([], { "GET /eInvoiceEntry/777": () => reply(200, { id: 777, status: "DELIVERED", taxStatus: "REPORTING_INITIATED" }) }));
    expect(r).toMatchObject({ due: 1, checked: 1 });
    expect((await db.query<any>(`SELECT status, tdd_status FROM einvoice_documents WHERE id=$1`, [d.id])).rows[0]).toEqual({ status: "accepted", tdd_status: "REPORTING_INITIATED" });
    expect((await pollSubmittedDocuments(db, fake([]))).due).toBe(0);                                  // nothing left to ask about
  });
});
