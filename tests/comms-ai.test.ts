import { describe, it, expect, beforeAll } from "vitest";
import zlib from "node:zlib";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant, ctxFor, convertedJob } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { uploadDocument } from "../src/ops/documents.js";
import { approveReply, acceptConversation, draftReply } from "../src/ops/workspace.js";
import {
  channelUrl, claimConversation, createChannel, discardUnmatched, latestConsent, listUnmatched, normaliseAddress, parseEmailRelay, parseTwilio, parseWhatsAppCloud, recordConsent, recordManualReply,
  resolveUnmatched, setChannelStatus, signRelay, twilioSignature, verifyIdentity,
} from "../src/ops/inbound.js";
import { applyExtractionToJob, decideExtraction, extractFields, extractFromDocument, iso6346Valid } from "../src/ops/doc-extract.js";
import { extractText } from "../src/lib/text-extract.js";
import { explainReport } from "../src/ops/report-explain.js";
import { ASSISTANT_RESOURCES, generateAssistantDraft, assistantWorkspace, type AssistantSettings } from "../src/ops/assistant.js";
import { createLocation, createOrder, createSku } from "../src/ops/fulfilment.js";
import { DRAFT_FORMS, diffTemplates, generateDocumentDraft, publishDocumentTemplate, republishTemplate, templateStatus } from "../src/ops/document-drafts.js";
import { processDataMinimisation, setRetentionPolicy } from "../src/ops/privacy-retention.js";
import crypto from "node:crypto";
import { encryptWithKey, decryptWithKey } from "../src/lib/encryption.js";
import { rotateEncryptionKey } from "../src/platform/key-rotation.js";
import { verifyInvariants } from "../src/platform/invariants.js";
import { randomUUID } from "node:crypto";
import { resetThrottle } from "../src/platform/auth.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });
let n = 0;
async function member(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`ca-${role}-${++n}-${Date.now()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
const post = (url: string, body: string, headers: Record<string, string>) => app.request(new URL(url).pathname, { method: "POST", body, headers });
const clean = async () => expect(await verifyInvariants(db)).toEqual([]);

describe("parsers and signatures", () => {
  it("normalises addresses and reads WhatsApp, email and Twilio payloads", () => {
    expect(normaliseAddress("email", "Acme Buyer <Buyer@Acme.COM>")).toBe("buyer@acme.com");
    expect(normaliseAddress("whatsapp", "whatsapp:+971 50-123 4567")).toBe("+971501234567");
    expect(normaliseAddress("telephony", "00971501234567")).toBe("+971501234567");
    const wa = parseWhatsAppCloud({ entry: [{ changes: [{ value: { contacts: [{ wa_id: "971501234567", profile: { name: "Sara" } }], messages: [{ id: "wamid.1", from: "971501234567", type: "text", text: { body: "Where is my cargo?" } }, { id: "wamid.2", from: "971501234567", type: "image" }], statuses: [{ id: "x" }] } }] }] });
    expect(wa).toHaveLength(2); expect(wa[0]).toMatchObject({ provider_id: "wamid.1", sender_name: "Sara", body: "Where is my cargo?" }); expect(wa[1].body).toContain("image message");
    expect(parseEmailRelay({ message_id: "<a@b>", from: "A <a@b.com>", subject: "Hi", html: "<p>Hello <b>there</b></p>" })[0]).toMatchObject({ subject: "Hi", body: "Hello there" });
    expect(parseEmailRelay({ from: "x@y.com" })).toEqual([]);
    expect(parseTwilio({ MessageSid: "SM1", From: "whatsapp:+971501234567", Body: "STOP" })[0]).toMatchObject({ provider_id: "SM1", body: "STOP" });
    expect(parseTwilio({ CallSid: "CA1", From: "+971501234567", To: "+97141234567", CallStatus: "completed", CallDuration: "42" })[0].body).toContain("(42s)");
    expect(parseTwilio({ CallSid: "CA2", From: "+9715", CallStatus: "ringing" })).toEqual([]);
  });
  it("computes Twilio's documented signature and the relay HMAC with a replay window", () => {
    // Twilio's published validation example
    expect(twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", { Digits: "1234", To: "+18005551212", From: "+14158675310", Caller: "+14158675310", CallSid: "CA1234567890ABCDE" })).toBe("GvWf1cFY/Q7PnoempGyD5oXAezc=");
    const sig = signRelay("sec", "{}", 1_000_000);
    expect(sig).toMatch(/^t=1000000,v1=[0-9a-f]{64}$/);
  });
});

describe("signed inbound channels end to end", () => {
  it("creates conversations from verified senders, queues unknown ones, de-duplicates, and refuses bad signatures", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const party = await db.tenant(t.tenantId, (c) => createParty(c, t.ctx, { kind: "customer", name: "Importer LLC", email: "buyer@importer.test", phone: "+971 50 111 2222" }));
    const ch = await db.tenant(t.tenantId, (c) => createChannel(c, t.ctx, { kind: "email", label: "Support mailbox", sla_minutes: 120 }));
    expect(ch.url).toContain("/webhooks/inbound/"); expect(ch.secret).toBeTruthy();
    const send = (payload: object, secret = ch.secret!, url = ch.url, t0 = Math.floor(Date.now() / 1000)) => { const raw = JSON.stringify(payload); return post(url, raw, { "content-type": "application/json", "x-lbt-signature": signRelay(secret, raw, t0) }); };
    const msg = { message_id: "<m1@mail>", from: "Buyer <buyer@importer.test>", subject: "Where is shipment JOB-1?", text: "Please advise." };

    expect((await send(msg, "wrong-secret")).status).toBe(401);
    expect((await send(msg, ch.secret!, ch.url, Math.floor(Date.now() / 1000) - 3600)).status).toBe(401);            // replayed
    expect((await post(ch.url.replace(/.$/, "x"), JSON.stringify(msg), {})).status).toBe(404);                         // unknown token
    let r = await send(msg);
    expect(r.status).toBe(200);
    expect((await r.json() as any).results).toEqual(["conversation"]);
    expect(((await (await send(msg)).json()) as any).results).toEqual(["duplicate"]);
    expect(((await (await send({ ...msg, text: "Changed text" })).json()) as any).results).toEqual(["conflict"]);

    const conv = (await db.query<any>(`SELECT * FROM conversations WHERE tenant_id=$1`, [t.tenantId])).rows[0];
    expect(conv).toMatchObject({ party_id: party, source: "email", identity_state: "unverified", owner_id: null, email_consent: false });
    expect(conv.channel_id).toBeTruthy();
    // a reply in the same thread appends rather than opening a second conversation
    await send({ message_id: "<m2@mail>", from: "buyer@importer.test", subject: "Re: Where is shipment JOB-1?", text: "Any update?", in_reply_to: "<m1@mail>" });
    expect((await db.query<any>(`SELECT count(*)::int n FROM conversations WHERE tenant_id=$1`, [t.tenantId])).rows[0].n).toBe(1);
    expect((await db.query<any>(`SELECT count(*)::int n FROM conversation_messages WHERE conversation_id=$1 AND direction='inbound'`, [conv.id])).rows[0].n).toBe(2);

    // an unknown sender waits for a person; discard erases the content
    expect(((await (await send({ message_id: "<u1@mail>", from: "stranger@elsewhere.test", subject: "Quote?", text: "Hello, I need a quote" })).json()) as any).results).toEqual(["unmatched"]);
    await send({ message_id: "<u2@mail>", from: "stranger2@elsewhere.test", subject: "Spam", text: "Buy now" });
    const queue = await db.tenant(t.tenantId, (c) => listUnmatched(c));
    expect(queue).toHaveLength(2);
    const spam = queue.find((x: any) => x.subject === "Spam")!, real = queue.find((x: any) => x.subject === "Quote?")!;
    await db.tenant(t.tenantId, (c) => discardUnmatched(c, t.ctx, spam.id, "Spam"));
    expect((await db.query<any>(`SELECT body, subject, status FROM inbound_events WHERE id=$1`, [spam.id])).rows[0]).toMatchObject({ body: null, subject: null, status: "ignored" });
    const convId = await db.tenant(t.tenantId, (c) => resolveUnmatched(c, t.ctx, real.id, party));
    expect((await db.query<any>(`SELECT identity_state FROM conversations WHERE id=$1`, [convId])).rows[0].identity_state).toBe("unverified");

    // pausing the channel makes it vanish
    await db.tenant(t.tenantId, (c) => setChannelStatus(c, t.ctx, ch.id, "paused"));
    expect((await send({ message_id: "<m9@mail>", from: "buyer@importer.test", text: "hi" })).status).toBe(404);
    await db.tenant(t.tenantId, (c) => setChannelStatus(c, t.ctx, ch.id, "active"));
    await clean();
  });

  it("holds email replies until the sender is verified and honours opt-outs; threads are owned by one person", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const staff = await member(t.tenantId, "sales");
    const party = await db.tenant(t.tenantId, (c) => createParty(c, t.ctx, { kind: "customer", name: "Buyer Co", email: "ops@buyer.test" }));
    const ch = await db.tenant(t.tenantId, (c) => createChannel(c, t.ctx, { kind: "email", label: "Mail", thread_reply_implied: "1" }));
    const raw = JSON.stringify({ message_id: "<t1@x>", from: "ops@buyer.test", subject: "Status?", text: "Where is it?" });
    await post(ch.url, raw, { "x-lbt-signature": signRelay(ch.secret!, raw) });
    const conv = (await db.query<any>(`SELECT * FROM conversations WHERE tenant_id=$1`, [t.tenantId])).rows[0];
    expect(conv.email_consent).toBe(true);                                                  // owner opted in to implied thread consent
    await db.tenant(t.tenantId, (c) => claimConversation(c, staff, conv.id));
    await expect(db.tenant(t.tenantId, (c) => claimConversation(c, t.ctx, conv.id))).rejects.toThrow(/Unassigned/);
    const draft = await db.tenant(t.tenantId, (c) => draftReply(c, staff, conv.id, "Your cargo is on the water.", "R1"));
    await expect(db.tenant(t.tenantId, (c) => approveReply(c, t.ctx, draft))).rejects.toThrow(/Verify who the sender is/);
    await expect(db.tenant(t.tenantId, (c) => verifyIdentity(c, staff, party, "email", "ops@buyer.test", "callback", "called"))).rejects.toThrow(/Your role/);
    await db.tenant(t.tenantId, (c) => verifyIdentity(c, t.ctx, party, "email", "ops@buyer.test", "Called back the number on file", "Spoke to the named contact"));
    // an opt-out recorded later blocks the email even though the thread is verified
    await db.tenant(t.tenantId, (c) => recordConsent(c, t.ctx, party, "email", "opt_out", "phone call", "Asked us to stop"));
    await expect(db.tenant(t.tenantId, (c) => approveReply(c, t.ctx, draft))).rejects.toThrow(/opted out/);
    await expect(db.tenant(t.tenantId, (c) => recordConsent(c, t.ctx, party, "email", "opt_in", "web form"))).rejects.toThrow(/Evidence of consent/);
    await db.tenant(t.tenantId, (c) => recordConsent(c, t.ctx, party, "email", "opt_in", "web form", "Form submission 2026-10-11 10:14"));
    expect(await db.tenant(t.tenantId, (c) => latestConsent(c, party, "email"))).toBe("opt_in");
    await db.tenant(t.tenantId, (c) => approveReply(c, t.ctx, draft));
    await expect(db.query(`UPDATE channel_consents SET status='opt_in'`)).rejects.toThrow();
    await clean();
  });

  it("verifies Meta's handshake and signature, treats STOP as an opt-out, and records WhatsApp replies only after verification and consent", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const staff = await member(t.tenantId, "sales");
    const party = await db.tenant(t.tenantId, (c) => createParty(c, t.ctx, { kind: "customer", name: "WA Customer", phone: "+971 55 000 1111" }));
    const ch = await db.tenant(t.tenantId, (c) => createChannel(c, t.ctx, { kind: "whatsapp", label: "WhatsApp", provider_secret: "meta-app-secret" }));
    expect(ch.verify_token).toBeTruthy();
    const path = new URL(ch.url).pathname;
    expect((await app.request(`${path}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc`)).status).toBe(404);
    const hs = await app.request(`${path}?hub.mode=subscribe&hub.verify_token=${ch.verify_token}&hub.challenge=abc123`);
    expect(hs.status).toBe(200); expect(await hs.text()).toBe("abc123");
    const body = (id: string, text: string) => JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from: "971550001111", type: "text", text: { body: text } }] } }] }] });
    const sign = (raw: string, secret = "meta-app-secret") => "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const raw = body("wamid.A", "Is my parcel out?");
    expect((await post(ch.url, raw, { "x-hub-signature-256": sign(raw, "other") })).status).toBe(401);
    expect(((await (await post(ch.url, raw, { "x-hub-signature-256": sign(raw) })).json()) as any).results).toEqual(["conversation"]);
    const conv = (await db.query<any>(`SELECT * FROM conversations WHERE tenant_id=$1`, [t.tenantId])).rows[0];
    expect(conv).toMatchObject({ source: "whatsapp", identity_state: "unverified" });
    // a follow-up joins the same open WhatsApp thread
    const raw2 = body("wamid.B", "Hello?"); await post(ch.url, raw2, { "x-hub-signature-256": sign(raw2) });
    expect((await db.query<any>(`SELECT count(*)::int n FROM conversations WHERE tenant_id=$1`, [t.tenantId])).rows[0].n).toBe(1);
    await db.tenant(t.tenantId, async (c) => { await claimConversation(c, staff, conv.id); });
    await expect(db.tenant(t.tenantId, (c) => recordManualReply(c, staff, conv.id, "It is out for delivery.", "wamid.out1"))).rejects.toThrow(/Verify who the sender is/);
    await db.tenant(t.tenantId, (c) => verifyIdentity(c, t.ctx, party, "whatsapp", "+971550001111", "Called back", "Confirmed"));
    await db.tenant(t.tenantId, (c) => recordManualReply(c, staff, conv.id, "It is out for delivery.", "wamid.out1"));
    // STOP records an opt-out and creates no new message in the thread
    const stop = body("wamid.C", "STOP"); expect(((await (await post(ch.url, stop, { "x-hub-signature-256": sign(stop) })).json()) as any).results).toEqual(["opted_out"]);
    expect(await db.tenant(t.tenantId, (c) => latestConsent(c, party, "whatsapp"))).toBe("opt_out");
    await expect(db.tenant(t.tenantId, (c) => recordManualReply(c, staff, conv.id, "Another note", "wamid.out2"))).rejects.toThrow(/opted out/);
    await clean();
  });

  it("verifies Twilio's signature over the full URL and parameters", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const party = await db.tenant(t.tenantId, (c) => createParty(c, t.ctx, { kind: "customer", name: "Caller", phone: "+971 4 555 0000" }));
    const ch = await db.tenant(t.tenantId, (c) => createChannel(c, t.ctx, { kind: "telephony", label: "Voice", provider_secret: "twilio-auth-token" }));
    const params = { CallSid: "CA777", From: "+97145550000", To: "+97141112222", CallStatus: "completed", CallDuration: "30" };
    const body = new URLSearchParams(params).toString();
    const good = twilioSignature("twilio-auth-token", ch.url, params);
    expect((await post(ch.url, body, { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "bad" })).status).toBe(401);
    expect(((await (await post(ch.url, body, { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": good })).json()) as any).results).toEqual(["conversation"]);
    expect((await db.query<any>(`SELECT subject, party_id FROM conversations WHERE tenant_id=$1`, [t.tenantId])).rows[0]).toMatchObject({ subject: "Phone call", party_id: party });
    void channelUrl;
  });

  it("minimises inbound message copies under the owner's retention policy and protects channel secrets through key rotation", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const ch = await db.tenant(t.tenantId, (c) => createChannel(c, t.ctx, { kind: "email", label: "Retention mailbox" }));
    const raw = JSON.stringify({ message_id: "<r1@x>", from: "unknown@nowhere.test", subject: "Old", text: "Old text" });
    await post(ch.url, raw, { "x-lbt-signature": signRelay(ch.secret!, raw) });
    await db.query(`UPDATE inbound_events SET received_at=now()-interval '400 days' WHERE tenant_id=$1`, [t.tenantId]);
    await db.tenant(t.tenantId, (c) => setRetentionPolicy(c, t.ctx, { subject: "inbound_messages", retain_days: 365, reason: "Policy 7.2" }));
    await processDataMinimisation(db, 50);
    expect((await db.query<any>(`SELECT body, sender, status FROM inbound_events WHERE tenant_id=$1`, [t.tenantId])).rows[0]).toMatchObject({ body: null, sender: null, status: "ignored" });
  });

  it("key rotation covers channel signing secrets and verify tokens", async () => {
    const db2 = await freshDb();
    const t = await newTenant(db2);
    const old = "fixture-only-previous-encryption-key-32", next = "fixture-only-current-encryption-key-32";
    const ch = await db2.system((c) => c.query<any>(
      `INSERT INTO inbound_channels(tenant_id,kind,label,token_hash,scheme,secret_enc,verify_token_enc,created_by) VALUES ($1,'whatsapp','WA','h1','meta_sha256',$2,$3,$4) RETURNING id`,
      [t.tenantId, encryptWithKey("relay-secret", old), encryptWithKey("verify-me", old), t.userId]));
    const dry = await rotateEncryptionKey(db2, next, old);
    expect(dry.counts["inbound_channels:secret_enc"].pending).toBe(1); expect(dry.counts["inbound_channels:verify_token_enc"].pending).toBe(1);
    await rotateEncryptionKey(db2, next, old, true);
    const row = (await db2.query<any>(`SELECT secret_enc, verify_token_enc FROM inbound_channels WHERE id=$1`, [ch.rows[0].id])).rows[0];
    expect(decryptWithKey(row.secret_enc, next)).toBe("relay-secret"); expect(decryptWithKey(row.verify_token_enc, next)).toBe("verify-me");
  });
});

describe("deterministic document extraction", () => {
  it("validates container numbers, air waybills and dates, and reads simple PDFs", () => {
    expect(iso6346Valid("CSQU3054383")).toBe(true);
    expect(iso6346Valid("CSQU3054384")).toBe(false);
    const text = `COMMERCIAL INVOICE
Invoice No: INV-2026/0412  Invoice Date: 05/10/2026
Seller TRN: 100234567890003   Incoterm: CIF Jebel Ali
HS Code: 8501.10.00  Container CSQU 305438 3 and TGHU1234560
AWB No: 176-12345675  Bill of lading no MSCUAB123456
24 cartons  Gross weight: 1,250.5 kg  Volume: 12.4 cbm
Grand Total USD 18,450.00`;
    const f = Object.fromEntries(extractFields(text).map((x) => [x.key + (x.key === "container_number" ? ":" + x.value : ""), x]));
    expect(f.invoice_number).toMatchObject({ value: "INV-2026/0412", valid: true });
    expect(f.invoice_date).toMatchObject({ value: "2026-10-05", valid: true });
    expect(f.invoice_date.note).toMatch(/day\/month/);
    expect(f.total_amount.value).toBe("18450"); expect(f.currency.value).toBe("USD");
    expect(f.incoterm.value).toBe("CIF"); expect(f.hs_code).toMatchObject({ value: "85011000", valid: true });
    expect(f["container_number:CSQU3054383"].valid).toBe(true);
    expect(f["container_number:TGHU1234560"].valid).toBe(false);                    // bad check digit is flagged, not trusted
    expect(f.awb_number).toMatchObject({ value: "176-12345675", valid: true });
    expect(f.packages.value).toBe("24"); expect(f.gross_weight_kg.value).toBe("1250.5"); expect(f.volume_cbm.value).toBe("12.4");
    expect(f.tax_registration.value).toBe("100234567890003");
    expect(extractFields(text)).toEqual(extractFields(text));                       // deterministic
    const pdf = (content: string, compress: boolean) => {
      const data = compress ? zlib.deflateSync(Buffer.from(content)) : Buffer.from(content);
      return Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${data.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`), data, Buffer.from("\nendstream\nendobj\n%%EOF")]);
    };
    const content = "BT /F1 12 Tf 72 720 Td (Invoice No: PDF-77 \\(copy\\)) Tj T* [(Total) -300 (USD 500.00)] TJ ET";
    for (const compress of [false, true]) {
      const r = extractText(pdf(content, compress), "application/pdf");
      expect(r.readable).toBe(true); expect(r.text).toContain("Invoice No: PDF-77 (copy)"); expect(r.text).toContain("Total USD 500.00");
    }
    const scanned = extractText(pdf("BT <0102030405060708090A> Tj ET", false), "application/pdf");
    expect(scanned.readable).toBe(false); expect(scanned.note).toMatch(/manually/);
    expect(extractText(Buffer.from([1, 2, 3]), "image/png").readable).toBe(false);
  });

  it("proposes, needs a person's decision, and applies only checked fields to the job it belongs to", async () => {
    const t = await newTenant(db);
    const j = await convertedJob(db, t);
    const ids = await db.tenant(t.tenantId, async (c) => {
      const text = "AIR WAYBILL\nAWB No: 176-12345675\nGross weight: 100 kg\n";
      const doc = await uploadDocument(c, t.ctx, { kind: "other", title: "Airline AWB", issuer: "Airline", filename: "awb.txt", data: Buffer.from(text), job_id: j.jobId } as any);
      const bad = await uploadDocument(c, t.ctx, { kind: "other", title: "Bad AWB", issuer: "Airline", filename: "bad.txt", data: Buffer.from("AWB No: 176-12345670"), job_id: j.jobId } as any);
      return { doc, bad };
    });
    const x = await db.tenant(t.tenantId, (c) => extractFromDocument(c, t.ctx, ids.doc));
    expect(x.status).toBe("proposed"); expect((x.fields as any[]).find((f) => f.key === "awb_number").valid).toBe(true);
    expect((await db.tenant(t.tenantId, (c) => extractFromDocument(c, t.ctx, ids.doc))).id).toBe(x.id);              // same text, same result, no duplicate
    await expect(db.tenant(t.tenantId, (c) => applyExtractionToJob(c, t.ctx, x.id, j.jobId, ["awb_number"]))).rejects.toThrow(/Accept the extraction/);
    await db.tenant(t.tenantId, (c) => decideExtraction(c, t.ctx, x.id, true));
    await expect(db.tenant(t.tenantId, (c) => applyExtractionToJob(c, t.ctx, x.id, j.jobId, ["gross_weight_kg"]))).rejects.toThrow(/cannot be applied/);
    await db.tenant(t.tenantId, (c) => applyExtractionToJob(c, t.ctx, x.id, j.jobId, ["awb_number"]));
    expect((await db.query<any>(`SELECT master_ref FROM jobs WHERE id=$1`, [j.jobId])).rows[0].master_ref).toBe("176-12345675");
    const bad = await db.tenant(t.tenantId, (c) => extractFromDocument(c, t.ctx, ids.bad));
    expect(bad.warnings.join(" ")).toMatch(/failed its IATA check/);
    await db.tenant(t.tenantId, (c) => decideExtraction(c, t.ctx, bad.id, true));
    await expect(db.tenant(t.tenantId, (c) => applyExtractionToJob(c, t.ctx, bad.id, j.jobId, ["awb_number"], true))).rejects.toThrow(/passing check/);
    await expect(db.tenant(t.tenantId, (c) => decideExtraction(c, t.ctx, x.id, false, "late"))).rejects.toThrow(/already accepted/);
  });
});

describe("report explanations, wider-sector retrieval and template versions", () => {
  it("explains a report with fixed rules that cite their own figures", () => {
    const report: any = {
      asOf: "x", sales: [{ status: "new", records: 4 }], lost: [{ reason: "Price", records: 3 }, { reason: "Timing", records: 1 }],
      finance: [{ currency: "AED", invoices: 8, issued: "1000000", collected: "300000", outstanding: "700000", overdue: "500000", unsynchronized: 2 }],
      transport: [{ status: "done", trips: 10, actual_km: 900, distance_missing: 3 }], warehouse: [{ owner: "Acme", stock: "100", reserved: "0", over_90_days: "40" }],
      utilization: [{ name: "W", code: "A-01", capacity_units: 10, used: 10 }], accuracy: { approved_lines: 20, exact_lines: 18, absolute_variance: 3 }, service: { open: 5, unaccepted: 2, overdue: 1 }, specialist: [{ sector: "x", status: "hold", cases: 2 }],
    };
    const out = explainReport(report);
    const text = out.map((i) => i.text).join("\n");
    expect(text).toMatch(/71\.4% of the AED 7,000\.00 outstanding is past its due date/);
    expect(text).toMatch(/Only 30% of the AED 10,000\.00 invoiced has been collected/);
    expect(text).toMatch(/3 of 10 trips have no recorded actual distance/);
    expect(text).toMatch(/40% of Acme's stock/);
    expect(text).toMatch(/accuracy is 90%/);
    expect(out[0].severity).toBe("attention");
    expect(explainReport(report)).toEqual(out);
    expect(explainReport({ ...report, finance: [], lost: [], sales: [], transport: [], warehouse: [], utilization: [], accuracy: { approved_lines: 0, exact_lines: 0 }, service: { open: 0, unaccepted: 0, overdue: 0 }, specialist: [] })).toEqual([]);
  });

  it("drafts from fulfilment records using counts only, and refuses sectors the workspace does not have", async () => {
    const off: AssistantSettings = { enabled: false, key: "", model: "deterministic", reviewed: false, inputMicroUsd: 0, outputMicroUsd: 0, monthlyBudget: 0, pricingNote: "" };
    const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
    const orderId = await db.tenant(t.tenantId, async (c) => {
      const merchant = await createParty(c, t.ctx, { kind: "customer", name: "Shop" });
      await createLocation(c, t.ctx, { code: "A-1" });
      await createSku(c, t.ctx, { party_id: merchant, code: "TEE", name: "Tee" });
      const o = await createOrder(c, t.ctx, { party_id: merchant, external_ref: "ORD-1", ship_to_name: "Private Person Name", ship_to_address: "Secret Address 5", ship_to_phone: "0501234567", lines: "TEE, 3" });
      return (o as any).id as string;
    });
    expect((await db.tenant(t.tenantId, (c) => assistantWorkspace(c, t.ctx))).allowed).toEqual(["fulfil_order"]);
    const d = await generateAssistantDraft(db, t.ctx, { resource: "fulfil_order", source_id: orderId, purpose: "summary", reference: randomUUID() }, off);
    expect(d.output.text).toMatch(/Recorded fulfilment order state/);
    expect(JSON.stringify(d.source_snapshot)).not.toMatch(/Private Person|Secret Address|0501234567/);
    expect(d.source_snapshot.facts.units_ordered).toBe(3);
    const reply = await generateAssistantDraft(db, t.ctx, { resource: "fulfil_order", source_id: orderId, purpose: "reply", reference: randomUUID() }, off);
    expect(reply.output.text).toMatch(/Our team will verify/);
    await expect(generateAssistantDraft(db, t.ctx, { resource: "cus_case", source_id: randomUUID(), purpose: "summary", reference: randomUUID() }, off)).rejects.toThrow(/not selected|Your role|cannot access/);
    await expect(generateAssistantDraft(db, t.ctx, { resource: "fulfil_order", source_id: orderId, purpose: "classification", reference: randomUUID() }, off)).rejects.toThrow();
    expect(Object.keys(ASSISTANT_RESOURCES)).toContain("transport_order");
  });

  it("blocks drafts from superseded or stale templates, republishes with confirmation, and diffs versions", async () => {
    const t = await newTenant(db);
    const j = await convertedJob(db, t);
    const terms = { kind: "packing_list", title: "Packing list", footer: "Reviewed footer text", reference: randomUUID() };
    const v1 = await db.tenant(t.tenantId, (c) => publishDocumentTemplate(c, t.ctx, terms));
    const doc = await db.tenant(t.tenantId, (c) => uploadDocument(c, t.ctx, { kind: "other", title: "Source", issuer: "Shipper", filename: "s.txt", data: Buffer.from("packing"), job_id: j.jobId } as any));
    const f = { shipper: "S", consignee: "C", contents: "Goods", packages: "2", gross_kg: "10", net_kg: "9", volume_cbm: "1", marks: "none", job_id: j.jobId, source_document_id: doc, template_id: v1, reference: randomUUID() };
    await db.tenant(t.tenantId, (c) => generateDocumentDraft(c, t.ctx, f));                                          // newest and current: allowed
    // the platform's standard form gained a field after v1 was published: simulate by inserting a stale v2 (immutable rows cannot be edited)
    const stale = DRAFT_FORMS.packing_list.fields.filter((x) => x.key !== "marks");
    const v2 = (await db.system((c) => c.query<any>(`INSERT INTO document_templates(tenant_id,reference,kind,version,title,footer,fields,created_by) VALUES ($1,$2,'packing_list',2,'Packing list','Reviewed footer text',$3,$4) RETURNING id`, [t.tenantId, randomUUID(), JSON.stringify(stale), t.userId]))).rows[0].id;
    await expect(db.tenant(t.tenantId, (c) => generateDocumentDraft(c, t.ctx, { ...f, reference: randomUUID() }))).rejects.toThrow(/newer reviewed version \(v2\)/);
    await expect(db.tenant(t.tenantId, (c) => generateDocumentDraft(c, t.ctx, { ...f, template_id: v2, reference: randomUUID() }))).rejects.toThrow(/predates a change to the standard form fields/);
    const status = (await db.tenant(t.tenantId, (c) => templateStatus(c, t.ctx))).find((k) => k.kind === "packing_list")!;
    expect(status.outdated).toBe(true); expect(status.versions.map((v) => [v.version, v.superseded, v.drafts])).toEqual([[2, false, 0], [1, true, 1]]);
    await expect(db.tenant(t.tenantId, (c) => republishTemplate(c, t.ctx, { kind: "packing_list", reference: randomUUID() }))).rejects.toThrow(/Confirm that you re-read/);
    await expect(db.tenant(t.tenantId, (c) => republishTemplate(c, ctxFor(t.userId, t.tenantId, ["sales"]), { kind: "packing_list", reference: randomUUID(), confirm_reviewed: "1" }))).rejects.toThrow(/Your role/);
    const v3 = await db.tenant(t.tenantId, (c) => republishTemplate(c, t.ctx, { kind: "packing_list", reference: randomUUID(), confirm_reviewed: "1" }));
    await expect(db.tenant(t.tenantId, (c) => republishTemplate(c, t.ctx, { kind: "packing_list", reference: randomUUID(), confirm_reviewed: "1" }))).rejects.toThrow(/already matches/);
    const diff = await db.tenant(t.tenantId, (c) => diffTemplates(c, t.ctx, v2, v3));
    expect(diff).toMatchObject({ from: 2, to: 3, added: ["marks"], removed: [], footer_changed: false });
    await db.tenant(t.tenantId, (c) => generateDocumentDraft(c, t.ctx, { ...f, template_id: v3, reference: randomUUID() }));
  });
});
