import crypto from "node:crypto";
import { describe, expect, it, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, convertedJob } from "./helpers.js";
import { ProviderError } from "../src/adapters/einvoice.js";
import { mapWafeqResult, validateWafeqCredentials, wafeqAdapter, wafeqBody, wafeqEnvironment } from "../src/adapters/einvoice-wafeq.js";
import { invoiceJob } from "../src/ops/finance.js";
import { generateEInvoice, sendDocument, submitEInvoice, updateEntityDetails, updatePartyDetails } from "../src/ops/einvoice.js";
import { getService, requestActivation, staffConfigure, staffSetState } from "../src/ops/einvoice-service.js";
import { handleWafeqWebhook, listInbound, processEInvoiceRetries, verifyStandardWebhook } from "../src/ops/einvoice-sync.js";

const reply = (status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const KEY = "pk_test_abc123", TXP = "txpay_0123abc";
/** Each workspace has its own provider account; the same one cannot be attached twice. */
const own = (tenantId: string) => `txpay_${tenantId.replace(/-/g, "").slice(0, 12)}`;
let db: Db, n = 0;
beforeAll(async () => { db = await freshDb(); });

describe("Wafeq adapter", () => {
  it("validates credentials, and tells Sandbox keys from Live keys", () => {
    expect(() => validateWafeqCredentials({ apiKey: "sk_x", taxpayerId: TXP })).toThrow(/pk_test_ or pk_live_/);
    expect(() => validateWafeqCredentials({ apiKey: KEY, taxpayerId: "100123456789012" })).toThrow(/txpay_/);
    expect(() => validateWafeqCredentials({ apiKey: KEY, taxpayerId: TXP, baseUrl: "http://insecure" })).toThrow(/https/);
    expect(wafeqEnvironment("pk_live_zzz")).toBe("live"); expect(wafeqEnvironment(KEY)).toBe("sandbox");
  });

  const doc = { number: "INV-1", issueDate: "2026-10-01", dueDate: "2026-10-31", currency: "AED", supplier: { name: "S", legalName: "S LLC", trn: "100000000000003", street: "a", city: "Dubai", emirate: "Dubai", country: "AE" },
    buyer: { name: "B", legalName: "Buyer LLC", trn: "100999999999003", peppolId: "0235:1009999999", street: "Warehouse 4", city: "Dubai", emirate: "Dubai", country: "AE" },
    lines: [{ description: "Freight", quantity: 2, unitPrice: 100, taxCategory: "S", taxPercent: 5 }, { description: "Docs", quantity: 1, unitPrice: 50, taxCategory: "E", taxPercent: 0, exemptionReason: "Exempt supply" }] };

  it("sends an invoice as JSON with the organisation key, taxpayer header and a stable idempotency key", async () => {
    const seen: any[] = [];
    const a = wafeqAdapter({ apiKey: KEY, taxpayerId: TXP }, async (url, init) => { seen.push({ url, init }); return reply(200, { success: true, invoice_id: "x", document_id: "inv_AAA", status: "sent" }); });
    const r = await a.submit({ reference: "T1-INV-1-ab12 cd", kind: "invoice", xml: "<Invoice/>", doc });
    expect(r).toEqual({ providerRef: "inv_AAA", status: "submitted", reasons: [] });
    expect(seen[0].url).toBe("https://api.wafeq.com/ae/v1/invoices");
    expect(seen[0].init.headers).toMatchObject({ authorization: `Api-Key ${KEY}`, "x-ae-taxpayer-id": TXP, "idempotency-key": "T1-INV-1-ab12_cd" });
    const body = JSON.parse(seen[0].init.body);
    expect(body).toMatchObject({ invoice_number: "INV-1", due_date: "2026-10-31", currency: "AED", customer: { name: "Buyer LLC", vat_number: "100999999999003", id: "0235:1009999999", address: { street: "Warehouse 4", city: "Dubai", country: "AE", country_subentity: "DXB" } } });
    expect(body.line_items[0]).toMatchObject({ quantity: 2, unit_price: 100, tax_category: "S", tax_percent: 5 });
    expect(body.line_items[1]).toMatchObject({ tax_category: "E", tax_exemption_reason: "Exempt supply" });
  });

  it("builds a credit note that points at the original: by provider id when it issued it, by number otherwise", () => {
    expect(wafeqBody("credit_note", { ...doc, number: "CN-1", precedingProviderRef: "inv_AAA", precedingNumber: "INV-1" }, "s")).toMatchObject({ credit_note_number: "CN-1", previous_invoice_source: "ap", previous_document_id: "inv_AAA" });
    expect(wafeqBody("credit_note", { ...doc, number: "CN-1", precedingNumber: "INV-1" }, "s")).toMatchObject({ previous_invoice_source: "external", previous_invoice_number: "INV-1" });
  });

  it("reads only an explicit delivered/accepted state as accepted, and keeps reporting state separate", () => {
    expect(mapWafeqResult({ document_id: "inv_1", delivery_status: "delivered", tdd_status: "REPORTED" }, "r")).toEqual({ providerRef: "inv_1", status: "accepted", reasons: [], reporting: "REPORTED" });
    expect(mapWafeqResult({ document_id: "inv_1", status: "weird_new_state" }, "r").status).toBe("submitted");   // never trusted
    expect(mapWafeqResult({ success: false, invoice_id: "i", validation_errors: [{ message: "BR-CO-15 total mismatch" }] }, "r")).toMatchObject({ status: "rejected", reasons: ["BR-CO-15 total mismatch"] });
  });

  it("treats validation answers as rejections, outages as retryable and refused credentials or a missing subscription as final", async () => {
    const d = { reference: "R", kind: "invoice" as const, xml: "x", doc };
    expect(await wafeqAdapter({ apiKey: KEY, taxpayerId: TXP }, async () => reply(422, { detail: [{ msg: "customer.address.city required" }] })).submit(d)).toMatchObject({ status: "rejected", reasons: ["customer.address.city required"] });
    for (const code of [503, 429, 409]) await expect(wafeqAdapter({ apiKey: KEY, taxpayerId: TXP }, async () => reply(code, {})).submit(d)).rejects.toMatchObject({ retryable: true });
    await expect(wafeqAdapter({ apiKey: KEY, taxpayerId: TXP }, async () => reply(401, {})).submit(d)).rejects.toMatchObject({ retryable: false });
    await expect(wafeqAdapter({ apiKey: KEY, taxpayerId: TXP }, async () => reply(402, { detail: { code: "subscription_required" } })).submit(d)).rejects.toThrow(/subscription/);
    await expect(wafeqAdapter({ apiKey: KEY, taxpayerId: TXP }, async () => { throw new Error("ECONNRESET"); }).submit(d)).rejects.toBeInstanceOf(ProviderError);
  });

  it("downloads the archived XML and describes a received document", async () => {
    const a = wafeqAdapter({ apiKey: KEY, taxpayerId: TXP }, async (url) => url.endsWith("/xml") ? reply(200, "<Invoice/>", { "content-type": "application/xml" }) : reply(200, { id: "inv_9", invoice_number: "S-77", seller_name: "Supplier LLC", currency: "AED", total: 1050.5, issue_date: "2026-09-30T00:00:00Z" }));
    expect(await a.downloadXml!("inv_9")).toBe("<Invoice/>");
    expect(await a.describeDocument!("inv_9")).toEqual({ providerDocId: "inv_9", number: "S-77", senderName: "Supplier LLC", currency: "AED", totalMinor: 105050, issuedOn: "2026-09-30" });
  });
});

async function staffUser(role = "commercial_admin") {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'staff','x') RETURNING id`, [`svc-staff-${++n}-${Date.now()}@example.com`]))).rows[0].id;
  return { userId: id as string, role };
}
/** A workspace with complete data and a generated, submittable e-invoice, ready to send through its provider. */
async function readyWorkspace() {
  const t = await newTenant(db), j = await convertedJob(db, t, 100000, 60000);
  const inv = await db.tenant(t.tenantId, async (c) => { await c.query(`UPDATE job_charges SET approved=true WHERE job_id=$1`, [j.jobId]); return invoiceJob(c, t.ctx, j.jobId); });
  await db.tenant(t.tenantId, async (c) => {
    await updateEntityDetails(c, t.ctx, { tax_id: "100234567890003", address_line: "Office 12", city: "Dubai", emirate: "Dubai", country: "AE" });
    await c.query(`UPDATE entities SET legal_name='Managed Logistics LLC'`);
    await updatePartyDetails(c, t.ctx, j.customerId, { tax_id: "100987654321003", address_line: "Warehouse 4", city: "Dubai", emirate: "Dubai", country: "AE" });
  });
  return { t, inv, j };
}
const generate = (t: any, invId: string) => db.tenant(t.tenantId, (c) => generateEInvoice(c, t.ctx, "invoice", invId));
const send = (t: any, docId: string, f: typeof fetch) => db.tenant(t.tenantId, async (c) => {
  const d = (await c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1 FOR UPDATE`, [docId])).rows[0];
  return sendDocument(c, { userId: t.ctx.userId, actor: { kind: "user", userId: t.ctx.userId } }, t.tenantId, d, undefined, f);
});
const ok = (id = "inv_AAA") => async () => reply(200, { success: true, invoice_id: "x", document_id: id, status: "sent" });

describe("e-invoicing as an add-on", () => {
  it("moves Not activated → Onboarding by request, and only platform staff can configure, activate or suspend", async () => {
    const { t } = await readyWorkspace(), staff = await staffUser();
    expect((await db.tenant(t.tenantId, (c) => getService(c))).state).toBe("not_activated");
    await expect(db.tenant(t.tenantId, (c) => requestActivation(c, t.ctx, "enterprise"))).rejects.toThrow(/packages/);
    await db.tenant(t.tenantId, (c) => requestActivation(c, t.ctx, "start"));
    expect(await db.tenant(t.tenantId, (c) => getService(c))).toMatchObject({ state: "onboarding", package: "start", provider: null });

    // the workspace cannot activate itself, attach a provider or edit its allowance, even by writing the table directly
    await expect(db.tenant(t.tenantId, (c) => c.query(`UPDATE einvoice_service SET state='active'`))).rejects.toThrow(/platform staff/);
    await expect(db.tenant(t.tenantId, (c) => c.query(`UPDATE einvoice_service SET used_docs=0, allowance_docs=99999`))).rejects.toThrow(/platform staff/);
    await expect(db.tenant(t.tenantId, (c) => c.query(`INSERT INTO einvoice_credentials(tenant_id,provider,credentials_enc,updated_by) VALUES ($1,'wafeq','x',$2)`, [t.tenantId, t.ctx.userId]))).rejects.toThrow();

    await expect(staffConfigure(db, { userId: staff.userId, role: "auditor" }, t.tenantId, { provider: "wafeq", api_key: KEY, taxpayer_id: own(t.tenantId) })).rejects.toThrow(/cannot configure/);
    await expect(staffConfigure(db, staff, t.tenantId, { provider: "nonesuch", api_key: KEY, taxpayer_id: own(t.tenantId) })).rejects.toThrow(/adapter is installed/);
    await expect(staffConfigure(db, staff, t.tenantId, { provider: "wafeq", api_key: "nope", taxpayer_id: own(t.tenantId) })).rejects.toThrow(/pk_test_/);
    await staffConfigure(db, staff, t.tenantId, { provider: "wafeq", api_key: KEY, taxpayer_id: own(t.tenantId), allowance_docs: "2" });
    await expect(staffSetState(db, { userId: staff.userId, role: "support" }, t.tenantId, "active", "paid")).rejects.toThrow(/commercial administrator/);
    await expect(staffSetState(db, staff, t.tenantId, "active", " ")).rejects.toThrow(/payment reference/);
    await staffSetState(db, staff, t.tenantId, "active", "Invoice 2026-114 paid");
    expect(await db.tenant(t.tenantId, (c) => getService(c))).toMatchObject({ state: "active", provider: "wafeq", environment: "sandbox", taxpayer_ref: own(t.tenantId), allowance_docs: 2 });
    await expect(db.tenant(t.tenantId, (c) => requestActivation(c, t.ctx, "start"))).rejects.toThrow(/already set up/);
    await staffSetState(db, staff, t.tenantId, "suspended", "Client asked to pause");
    expect((await db.tenant(t.tenantId, (c) => getService(c))).state).toBe("suspended");
  });

  it("stores the provider key encrypted and never exposes it", async () => {
    const { t } = await readyWorkspace(), staff = await staffUser();
    await db.tenant(t.tenantId, (c) => requestActivation(c, t.ctx, "start"));
    await staffConfigure(db, staff, t.tenantId, { provider: "wafeq", api_key: KEY, taxpayer_id: own(t.tenantId) });
    const stored = (await db.query<any>(`SELECT credentials_enc FROM einvoice_credentials WHERE tenant_id=$1`, [t.tenantId])).rows[0].credentials_enc as string;
    expect(stored).not.toContain(KEY); expect(stored).not.toContain(own(t.tenantId));
    const readBack = await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT credentials_enc FROM einvoice_credentials`));
    expect(readBack.rows[0].credentials_enc).toBe(stored);                                 // the workspace sees only ciphertext
    await staffConfigure(db, staff, t.tenantId, { provider: "wafeq", allowance_docs: "10" });   // blank key keeps the stored one
    expect((await db.query<any>(`SELECT credentials_enc FROM einvoice_credentials WHERE tenant_id=$1`, [t.tenantId])).rows[0].credentials_enc).toBe(stored);
  });

  it("sends through the client's own provider account in Sandbox while onboarding, refuses Live until activated, and does not send twice", async () => {
    const { t, inv } = await readyWorkspace(), staff = await staffUser();
    await db.tenant(t.tenantId, (c) => requestActivation(c, t.ctx, "start"));
    await staffConfigure(db, staff, t.tenantId, { provider: "wafeq", api_key: "pk_live_abc123", taxpayer_id: own(t.tenantId) });
    const doc = await generate(t, inv.id);
    expect(doc.submittable).toBe(true);                                                    // a managed provider holds the supplier's network identity, so those blockers do not apply
    expect(doc.payload_json).toMatchObject({ number: inv.no, currency: "AED", buyer: { trn: "100987654321003" } });
    await expect(send(t, doc.id, ok())).rejects.toThrow(/once support has activated/);     // Live key, not yet active
    await staffConfigure(db, staff, t.tenantId, { provider: "wafeq", api_key: KEY, taxpayer_id: own(t.tenantId) });
    let calls = 0;
    const sent = await send(t, doc.id, async (u, i) => { calls++; return ok()(); });
    expect(sent).toMatchObject({ status: "submitted", provider: "wafeq", provider_ref: "inv_AAA" }); expect(sent.provider_response.sandbox).toBe(true);
    expect((await db.tenant(t.tenantId, (c) => getService(c))).used_docs).toBe(0);         // Sandbox never spends the paid allowance
    const again = await db.tenant(t.tenantId, async (c) => submitEInvoice(c, t.ctx, doc.id));
    expect(again.status).toBe("submitted"); expect(calls).toBe(1);                         // not sent a second time
    await expect(db.query(`UPDATE einvoice_documents SET status='accepted', provider_ref='inv_BBB' WHERE id=$1`, [doc.id]).then(() => db.query(`UPDATE einvoice_documents SET provider_ref='inv_CCC' WHERE id=$1`, [doc.id]))).rejects.toThrow(/final/);
  });

  it("counts Live documents against the allowance and stops when it is used up", async () => {
    const { t, inv } = await readyWorkspace(), staff = await staffUser();
    await db.tenant(t.tenantId, (c) => requestActivation(c, t.ctx, "start"));
    await staffConfigure(db, staff, t.tenantId, { provider: "wafeq", api_key: "pk_live_abc123", taxpayer_id: own(t.tenantId), allowance_docs: "0" });
    await staffSetState(db, staff, t.tenantId, "active", "paid");
    const doc = await generate(t, inv.id);
    await expect(send(t, doc.id, ok())).rejects.toThrow(/used its e-invoicing allowance/);
    await staffConfigure(db, staff, t.tenantId, { provider: "wafeq", allowance_docs: "1" });
    const sent = await send(t, doc.id, ok("inv_LIVE1"));
    expect(sent).toMatchObject({ status: "submitted", provider_ref: "inv_LIVE1" }); expect(sent.provider_response.sandbox).toBe(false);
    expect(await db.tenant(t.tenantId, (c) => getService(c))).toMatchObject({ used_docs: 1, allowance_docs: 1 });
    await expect(db.tenant(t.tenantId, (c) => c.query(`SELECT einvoice_consume_allowance()`))).rejects.toThrow(/used up/);   // the counter cannot be pushed past the allowance
  });

  it("keeps a document through an outage and retries it automatically; gives up on refused credentials", async () => {
    const { t, inv } = await readyWorkspace(), staff = await staffUser();
    await db.tenant(t.tenantId, (c) => requestActivation(c, t.ctx, "start"));
    await staffConfigure(db, staff, t.tenantId, { provider: "wafeq", api_key: KEY, taxpayer_id: own(t.tenantId) });
    const doc = await generate(t, inv.id);
    const down = await send(t, doc.id, async () => reply(503, {}));
    expect(down).toMatchObject({ status: "generated", attempts: 1 }); expect(down.next_retry_at).toBeTruthy(); expect(down.last_error).toMatch(/503/);
    expect((await processEInvoiceRetries(db, ok("inv_RETRY"))).due).toBe(0);              // not due yet
    await db.system((c) => c.query(`UPDATE einvoice_documents SET next_retry_at = now() - interval '1 minute' WHERE id=$1`, [doc.id]));
    expect(await processEInvoiceRetries(db, ok("inv_RETRY"))).toMatchObject({ due: 1, sent: 1, failed: 0 });
    expect((await db.query<any>(`SELECT status, provider_ref, next_retry_at FROM einvoice_documents WHERE id=$1`, [doc.id])).rows[0]).toMatchObject({ status: "submitted", provider_ref: "inv_RETRY", next_retry_at: null });

    // refused credentials are not retried
    const w2 = await readyWorkspace();
    await db.tenant(w2.t.tenantId, (c) => requestActivation(c, w2.t.ctx, "start"));
    await staffConfigure(db, staff, w2.t.tenantId, { provider: "wafeq", api_key: KEY, taxpayer_id: own(w2.t.tenantId) });
    const d2 = await generate(w2.t, w2.inv.id);
    const refused = await send(w2.t, d2.id, async () => reply(403, {}));
    expect(refused).toMatchObject({ status: "error", next_retry_at: null }); expect(refused.last_error).toMatch(/refused the credentials/);
  });
});

describe("provider webhooks", () => {
  const secretBytes = crypto.randomBytes(24), SECRET = `whsec_${secretBytes.toString("base64")}`;
  const signed = (event: Record<string, unknown>, opts: { id?: string; ts?: number; secret?: Buffer } = {}) => {
    const raw = JSON.stringify(event), id = opts.id ?? String(event.id), ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac("sha256", opts.secret ?? secretBytes).update(`${id}.${ts}.${raw}`).digest("base64");
    return { raw, header: (name: string) => ({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` } as Record<string, string>)[name] };
  };
  const onboarded = async () => {
    const w = await readyWorkspace(), staff = await staffUser(), tp = `txpay_${crypto.randomBytes(6).toString("hex")}`;
    await db.tenant(w.t.tenantId, (c) => requestActivation(c, w.t.ctx, "start"));
    await staffConfigure(db, staff, w.t.tenantId, { provider: "wafeq", api_key: KEY, taxpayer_id: tp });
    await staffSetState(db, staff, w.t.tenantId, "active", "paid");
    return { ...w, tp };
  };

  it("verifies Standard Webhooks signatures, rejecting forgeries, stale timestamps and wrong secrets", () => {
    const e = signed({ id: "evt_1", type: "document.status" });
    const h = { id: "evt_1", timestamp: e.header("webhook-timestamp"), signature: e.header("webhook-signature") };
    expect(verifyStandardWebhook([SECRET], h, e.raw)).toBe(true);
    expect(verifyStandardWebhook([SECRET], h, e.raw + " ")).toBe(false);
    expect(verifyStandardWebhook(["whsec_" + crypto.randomBytes(24).toString("base64"), SECRET], h, e.raw)).toBe(true);   // rotation overlap
    expect(verifyStandardWebhook(["whsec_" + crypto.randomBytes(24).toString("base64")], h, e.raw)).toBe(false);
    expect(verifyStandardWebhook([SECRET], h, e.raw, Date.now() + 3_600_000)).toBe(false);
  });

  it("refuses unsigned or unconfigured deliveries", async () => {
    const e = signed({ id: "evt_x", type: "document.status", data: {} });
    expect((await handleWafeqWebhook(db, e, [])).status).toBe(503);
    expect((await handleWafeqWebhook(db, { raw: e.raw, header: () => undefined }, [SECRET])).status).toBe(401);
    expect((await handleWafeqWebhook(db, signed({ id: "evt_y", type: "document.status" }, { secret: crypto.randomBytes(24) }), [SECRET])).status).toBe(401);
  });

  it("applies a delivered/reported event once, then ignores replays", async () => {
    const { t, inv, tp } = await onboarded();
    const doc = await generate(t, inv.id);
    await send(t, doc.id, ok("inv_WH1"));
    const evt = { id: "evt_status_1", type: "document.status", created_at: new Date().toISOString(), data: { taxpayer_id: tp, document_id: "inv_WH1", delivery_status: "delivered", tdd_status: "REPORTED" } };
    expect(await handleWafeqWebhook(db, signed(evt), [SECRET])).toEqual({ status: 200, body: { ok: true } });
    expect((await db.query<any>(`SELECT status, tdd_status FROM einvoice_documents WHERE id=$1`, [doc.id])).rows[0]).toEqual({ status: "accepted", tdd_status: "REPORTED" });
    expect(await handleWafeqWebhook(db, signed(evt), [SECRET])).toEqual({ status: 200, body: { duplicate: true } });
    // reporting can still advance on an accepted document, but its decision cannot change
    await handleWafeqWebhook(db, signed({ ...evt, id: "evt_status_2", data: { ...evt.data, delivery_status: "rejected", tdd_status: "REPORTING_CONFIRMED" } }), [SECRET]);
    expect((await db.query<any>(`SELECT status, tdd_status FROM einvoice_documents WHERE id=$1`, [doc.id])).rows[0]).toEqual({ status: "accepted", tdd_status: "REPORTING_CONFIRMED" });
  });

  it("asks for a retry when an event outruns our own record of the document, and records a rejection", async () => {
    const { t, inv, tp } = await onboarded();
    const early = { id: "evt_early", type: "document.status", created_at: new Date().toISOString(), data: { taxpayer_id: tp, document_id: "inv_LATE", delivery_status: "rejected" } };
    expect((await handleWafeqWebhook(db, signed(early), [SECRET])).status).toBe(503);
    const doc = await generate(t, inv.id); await send(t, doc.id, ok("inv_LATE"));
    expect((await handleWafeqWebhook(db, signed(early), [SECRET])).status).toBe(200);     // the same event is processed on redelivery
    expect((await db.query<any>(`SELECT status FROM einvoice_documents WHERE id=$1`, [doc.id])).rows[0].status).toBe("rejected");
  });

  it("records a received supplier invoice, and suspends the service when the client disconnects", async () => {
    const { t, tp } = await onboarded();
    const recv = { id: "evt_recv", type: "document.received", created_at: new Date().toISOString(), data: { taxpayer_id: tp, document_id: "inv_IN1", invoice_number: "S-9", seller_name: "Supplier LLC", currency: "AED" } };
    const f = async () => reply(200, { id: "inv_IN1", invoice_number: "S-9", seller_name: "Supplier LLC", currency: "AED", total: 210, issue_date: "2026-10-02" });
    expect((await handleWafeqWebhook(db, signed(recv), [SECRET], f)).status).toBe(200);
    expect(await db.tenant(t.tenantId, (c) => listInbound(c))).toEqual([expect.objectContaining({ number: "S-9", sender_name: "Supplier LLC", provider: "wafeq" })]);
    expect(Number((await db.tenant(t.tenantId, (c) => listInbound(c)))[0].total_minor)).toBe(21000);
    expect((await handleWafeqWebhook(db, signed({ id: "evt_unknown", type: "document.received", data: { taxpayer_id: "txpay_nobody", document_id: "inv_X" } }), [SECRET])).body).toMatchObject({ ignored: expect.any(String) });
    await handleWafeqWebhook(db, signed({ id: "evt_gone", type: "taxpayer.deleted", data: { taxpayer_id: tp } }), [SECRET]);
    expect((await db.tenant(t.tenantId, (c) => getService(c))).state).toBe("suspended");
  });
});
