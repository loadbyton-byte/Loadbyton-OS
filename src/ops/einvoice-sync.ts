import crypto from "node:crypto";
import type { Conn, Db } from "../db/client.js";
import { mapAigentrixStatus } from "../adapters/einvoice-aigentrix.js";
import { mapWafeqResult } from "../adapters/einvoice-wafeq.js";
import type { EInvoiceResult } from "../adapters/einvoice.js";
import { audit } from "../lib/audit.js";
import { decryptSecret } from "../lib/encryption.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, TAX_CODES, badRequest, forbidden } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { enterBill } from "./finance-bridge.js";
import { adapterForDocument, sendDocument } from "./einvoice.js";
import { routeFor, SERVICE_PROVIDERS } from "./einvoice-service.js";
import { must, recordId } from "./common.js";

// ───────── retries
/** Sends again the documents an earlier provider outage left waiting. Each runs in its own workspace transaction; one failure never blocks the rest. */
export async function processEInvoiceRetries(db: Db, fetchImpl?: typeof fetch) {
  const due = (await db.query<any>(`SELECT id, tenant_id FROM einvoice_documents WHERE status='generated' AND next_retry_at IS NOT NULL AND next_retry_at <= now() AND queued_by IS NOT NULL ORDER BY next_retry_at LIMIT 20`)).rows;
  let sent = 0, failed = 0;
  for (const row of due) {
    try {
      await db.tenant(row.tenant_id, async (c) => {
        const d = (await c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1 FOR UPDATE`, [row.id])).rows[0];
        if (!d || d.status !== "generated" || !d.next_retry_at) return;                       // someone else already dealt with it
        await sendDocument(c, { userId: d.queued_by, actor: { kind: "system" } }, row.tenant_id, d, undefined, fetchImpl);
        sent++;
      });
    } catch (e: any) {
      failed++;                                                                                // e.g. suspended, or credentials removed: look again in an hour, and say why
      await db.system((c) => c.query(`UPDATE einvoice_documents SET next_retry_at=now() + interval '1 hour', last_error=$2 WHERE id=$1 AND status='generated'`, [row.id, String(e?.message ?? e).slice(0, 300)]));
    }
  }
  return { due: due.length, sent, failed };
}

// ───────── webhooks (Standard Webhooks: webhook-id, webhook-timestamp, webhook-signature)
export function verifyStandardWebhook(secrets: string[], h: { id?: string; timestamp?: string; signature?: string }, raw: string, nowMs = Date.now(), toleranceSec = 300): boolean {
  const ts = Number(h.timestamp);
  if (!h.id || !h.signature || !Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return false;
  for (const secret of secrets) {
    const expected = crypto.createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${h.id}.${h.timestamp}.${raw}`).digest();
    for (const part of h.signature.split(" ")) {
      const [ver, val] = part.split(",");
      if (ver !== "v1" || !val) continue;
      const got = Buffer.from(val, "base64");
      if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return true;
    }
  }
  return false;
}

const text = (v: unknown, max = 200) => (v == null || v === "" ? null : String(v).slice(0, max));

const SYSTEM = { kind: "system" as const };

/** Applies a provider's verdict to a document we sent. A decision is made once (only from 'submitted'); the FTA reporting state may keep advancing. */
async function applyProviderState(c: Conn, tenantId: string, d: any, r: EInvoiceResult, via: string) {
  if (d.status === "submitted" && (r.status === "accepted" || r.status === "rejected")) {
    await c.query(`UPDATE einvoice_documents SET status=$2, provider_response=$3, decided_at=now() WHERE id=$1`, [d.id, r.status, JSON.stringify({ reasons: r.reasons, sandbox: d.provider_response?.sandbox === true, via })]);
    await audit(c, tenantId, SYSTEM, "einvoice.provider_decision", d.kind, d.invoice_id ?? d.credit_note_id, { status: r.status, via });
  }
  if (r.reporting && r.reporting !== d.tdd_status) {
    await c.query(`UPDATE einvoice_documents SET tdd_status=$2 WHERE id=$1`, [d.id, r.reporting]);
    await audit(c, tenantId, SYSTEM, "einvoice.reporting_state", d.kind, d.invoice_id ?? d.credit_note_id, { reporting: r.reporting });
  }
}

/** The document an event is about. Events can outrun our own save of the send response: ask for a brief retry, then let it go (it may be someone else's document). */
async function documentFor(c: Conn, tenantId: string, provider: string, ref: string, occurredAt: unknown) {
  const d = (await c.query<any>(`SELECT * FROM einvoice_documents WHERE tenant_id=$1 AND provider=$2 AND provider_ref=$3 FOR UPDATE`, [tenantId, provider, ref])).rows[0];
  if (d) return d;
  const age = Date.now() - Date.parse(String(occurredAt ?? ""));
  if (Number.isFinite(age) && age < 10 * 60_000) throw new HttpError(503, "document not recorded yet");
  return null;
}

async function recordInbound(c: Conn, tenantId: string, provider: string, ref: string, basic: { number?: string | null; sender?: string | null; currency?: string | null }, fetchImpl?: typeof fetch) {
  await c.query(`INSERT INTO einvoice_inbound(tenant_id,provider,provider_doc_id,number,sender_name,currency) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,provider,provider_doc_id) DO NOTHING`,
    [tenantId, provider, ref, text(basic.number, 64), text(basic.sender, 200), text(basic.currency, 3)]);
  await enrichInbound(c, tenantId, ref, fetchImpl);
  await audit(c, tenantId, SYSTEM, "einvoice.inbound_received", "einvoice_inbound", undefined, { provider });
}

/** Applies one signed Wafeq event. Delivery is at least once and unordered, so each event is recorded once and applied idempotently. */
export async function handleWafeqWebhook(db: Db, req: { raw: string; header(n: string): string | undefined }, secrets: string[], fetchImpl?: typeof fetch): Promise<{ status: number; body: unknown }> {
  if (!secrets.length) return { status: 503, body: { error: "webhooks are not configured" } };
  if (!verifyStandardWebhook(secrets, { id: req.header("webhook-id"), timestamp: req.header("webhook-timestamp"), signature: req.header("webhook-signature") }, req.raw)) return { status: 401, body: { error: "invalid signature" } };
  let ev: any; try { ev = JSON.parse(req.raw); } catch { return { status: 400, body: { error: "not JSON" } }; }
  const id = text(ev?.id, 200), type = text(ev?.type, 80);
  if (!id || !type) return { status: 400, body: { error: "missing event id or type" } };
  if (ev.test === true) return { status: 200, body: { test: true } };
  try {
    return await db.system(async (c) => {
      if (!(await c.query(`INSERT INTO einvoice_webhook_events(provider,event_id) VALUES ('wafeq',$1) ON CONFLICT DO NOTHING RETURNING event_id`, [id])).rows.length) return { status: 200, body: { duplicate: true } };
      const data = ev.data ?? {}, taxpayer = text(data.taxpayer_id) ?? text(ev.taxpayer_id);
      const svc = taxpayer ? (await c.query<any>(`SELECT tenant_id, state FROM einvoice_service WHERE provider='wafeq' AND taxpayer_ref=$1`, [taxpayer])).rows[0] : null;
      if (!svc) return { status: 200, body: { ignored: "taxpayer is not one of ours" } };
      const tenantId: string = svc.tenant_id, system = SYSTEM;

      if (type === "document.sent" || type === "document.status" || type === "document.reported") {
        const ref = text(data.document_id) ?? text(data.id);
        const d = ref ? await documentFor(c, tenantId, "wafeq", ref, ev.created_at) : null;
        if (!d) return { status: 200, body: { ignored: "unknown document" } };
        await applyProviderState(c, tenantId, d, mapWafeqResult(data, ref!), "webhook");
      } else if (type === "document.received") {
        const ref = text(data.document_id) ?? text(data.id);
        if (ref) await recordInbound(c, tenantId, "wafeq", ref, { number: data.invoice_number, sender: data.seller_name, currency: data.currency }, fetchImpl);
      } else if (type === "taxpayer.deleted" && (svc.state === "active" || svc.state === "onboarding")) {
        // the client revoked access (or we disconnected): stop acting for them until someone reconnects and reactivates
        await c.query(`UPDATE einvoice_service SET state='suspended', updated_at=now() WHERE tenant_id=$1`, [tenantId]);
        await audit(c, tenantId, system, "einvoice.taxpayer_disconnected", "tenant", tenantId, { event: type });
      }
      return { status: 200, body: { ok: true } };
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 503) return { status: 503, body: { error: e.message } };
    throw e;
  }
}

/** Fills in a received document's header facts from the provider. Failure is not an error: the row exists and can be enriched later. */
async function enrichInbound(c: Conn, tenantId: string, ref: string, fetchImpl?: typeof fetch) {
  try {
    const svc = (await c.query<any>(`SELECT provider FROM einvoice_service WHERE tenant_id=$1`, [tenantId])).rows[0];
    const cred = (await c.query<any>(`SELECT credentials_enc FROM einvoice_credentials WHERE tenant_id=$1`, [tenantId])).rows[0];
    const def = svc && SERVICE_PROVIDERS[svc.provider];
    if (!def || !cred) return;
    const info = await def.build(JSON.parse(decryptSecret(cred.credentials_enc)), fetchImpl).describeDocument?.(ref);
    if (!info) return;
    await c.query(`UPDATE einvoice_inbound SET number=coalesce($3,number), sender_name=coalesce($4,sender_name), currency=coalesce($5,currency), total_minor=coalesce($6,total_minor), issued_on=coalesce($7::date,issued_on)
      WHERE tenant_id=$1 AND provider_doc_id=$2`, [tenantId, ref, info.number, info.senderName, info.currency, info.totalMinor, info.issuedOn]);
  } catch { /* leave the basic row */ }
}

// ───────── workspace reads
export async function listInbound(c: Conn) {
  return (await c.query<any>(`SELECT id, provider, number, sender_name, currency, total_minor, issued_on, received_at, status, bill_id FROM einvoice_inbound ORDER BY received_at DESC LIMIT 100`)).rows;
}

/** The provider's archived UBL for a received supplier invoice. */
export async function inboundXml(c: Conn, id: string): Promise<{ number: string; xml: string }> {
  const row = await must(c.query<any>(`SELECT * FROM einvoice_inbound WHERE id=$1`, [recordId(id, "Received invoice")]), "Received invoice");
  const route = await routeFor(c, undefined, true);
  if (!route?.adapter.downloadXml) throw badRequest("The provider does not offer a download for this document.");
  return { number: row.number ?? row.provider_doc_id, xml: await route.adapter.downloadXml(row.provider_doc_id, { inbound: true }) };
}

/** The provider's own archived copy of a document we sent (the version it reported), when it offers one. */
export async function archivedXml(c: Conn, d: any): Promise<string> {
  if (!d.provider_ref) throw badRequest("This document has not been sent to a provider.");
  const adapter = await adapterForDocument(c, d);
  if (!adapter?.downloadXml) throw forbidden("The provider does not offer a download for this document.");
  return adapter.downloadXml(d.provider_ref);
}

// ───────── Aigentrix webhooks: `X-Aigentrix-Signature: t=<epoch>,v1=<hex hmacSHA256(secret, t + "." + body)>`, one signing secret per subscription (held with the client's credentials)
export function verifyAigentrixSignature(secret: string, header: string | undefined, raw: string, nowMs = Date.now(), toleranceSec = 300): boolean {
  const t = header?.match(/t=([^,]+)/)?.[1], v1 = header?.match(/v1=([^,]+)/)?.[1];
  if (!secret || !t || !v1 || !Number.isFinite(Number(t)) || Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false;
  const want = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return v1.length === want.length && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(want));
}

/**
 * Applies one Aigentrix event. The company is read from the (still unverified) body only to find which secret to verify with; nothing is acted on until the signature checks.
 * A failure to identify the sender looks the same as a bad signature. Events carry the real environment: if it differs from what staff configured, sending is stopped,
 * because documents would otherwise be going to the live network labelled as tests (or the reverse).
 */
export async function handleAigentrixWebhook(db: Db, req: { raw: string; header(n: string): string | undefined }, fetchImpl?: typeof fetch): Promise<{ status: number; body: unknown }> {
  const deny = { status: 401, body: { error: "invalid signature" } };
  let ev: any; try { ev = JSON.parse(req.raw); } catch { return deny; }
  const companyId = text(ev?.companyId, 20);
  if (!companyId) return deny;
  const found = await db.system(async (c) => {
    const svc = (await c.query<any>(`SELECT tenant_id, state, environment FROM einvoice_service WHERE provider='aigentrix' AND taxpayer_ref=$1`, [companyId])).rows[0];
    const cred = svc && (await c.query<any>(`SELECT credentials_enc FROM einvoice_credentials WHERE tenant_id=$1`, [svc.tenant_id])).rows[0];
    let secret: string | undefined; try { secret = cred && JSON.parse(decryptSecret(cred.credentials_enc)).webhookSecret; } catch { /* unreadable */ }
    return svc && secret ? { svc, secret } : null;
  });
  if (!found || !verifyAigentrixSignature(found.secret, req.header("x-aigentrix-signature"), req.raw)) return deny;
  const type = text(ev.eventType, 80), eventId = text(ev.eventId, 200) ?? req.header("x-aigentrix-event-id");
  if (type === "webhook.verification") {                                                  // the subscription handshake: echo the challenge and sign it
    const challenge = String(ev?.data?.challenge ?? "");
    return { status: 200, body: { challenge, signature: crypto.createHmac("sha256", found.secret).update(challenge).digest("hex") } };
  }
  if (!type || !eventId) return { status: 400, body: { error: "missing event id or type" } };
  if (type === "webhook.test") return { status: 200, body: { test: true } };
  try {
    return await db.system(async (c) => {
      if (!(await c.query(`INSERT INTO einvoice_webhook_events(provider,event_id) VALUES ('aigentrix',$1) ON CONFLICT DO NOTHING RETURNING event_id`, [eventId])).rows.length) return { status: 200, body: { duplicate: true } };
      const tenantId: string = found.svc.tenant_id, seen = String(ev.environment ?? "").toLowerCase();
      if (seen && seen !== found.svc.environment) {
        if (found.svc.state === "active" || found.svc.state === "onboarding") await c.query(`UPDATE einvoice_service SET state='suspended', updated_at=now() WHERE tenant_id=$1`, [tenantId]);
        await audit(c, tenantId, SYSTEM, "einvoice.environment_mismatch", "tenant", tenantId, { configured: found.svc.environment, reported: seen });
        return { status: 200, body: { ignored: "environment mismatch; service suspended" } };
      }
      const ref = text(ev.entryId, 40);
      if (type === "invoice.received" && ref) await recordInbound(c, tenantId, "aigentrix", ref, { number: ev.invoiceNumber }, fetchImpl);
      else if (type === "invoice.status_updated" && ref && ev.type !== "INBOUND") {
        const d = await documentFor(c, tenantId, "aigentrix", ref, ev.occurredAt);
        if (!d) return { status: 200, body: { ignored: "unknown document" } };
        const reasons = ev.rejectionReason ? [String(ev.rejectionReason).slice(0, 300)] : [];
        await applyProviderState(c, tenantId, d, ev.changedField === "taxStatus" ? { providerRef: ref, status: "submitted", reasons: [], reporting: String(ev.newValue) } : mapAigentrixStatus(ev.newValue, ref, undefined, reasons), "webhook");
      }
      return { status: 200, body: { ok: true } };
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 503) return { status: 503, body: { error: e.message } };
    throw e;
  }
}

// ───────── polling: a fallback for lost webhooks
/** Asks the provider about documents still waiting for a decision. Webhooks are the normal path; this catches the ones that never arrived. */
export async function pollSubmittedDocuments(db: Db, fetchImpl?: typeof fetch) {
  const rows = (await db.query<any>(`SELECT id, tenant_id FROM einvoice_documents WHERE status='submitted' AND provider_ref IS NOT NULL AND provider <> 'sandbox'
      AND submitted_at < now() - interval '2 minutes' AND submitted_at > now() - interval '7 days' AND (polled_at IS NULL OR polled_at < now() - interval '10 minutes') ORDER BY polled_at NULLS FIRST LIMIT 20`)).rows;
  let checked = 0, failed = 0;
  for (const row of rows) {
    try {
      await db.tenant(row.tenant_id, async (c) => {
        const d = (await c.query<any>(`SELECT * FROM einvoice_documents WHERE id=$1 FOR UPDATE`, [row.id])).rows[0];
        if (!d || d.status !== "submitted") return;
        await c.query(`UPDATE einvoice_documents SET polled_at=now() WHERE id=$1`, [d.id]);
        const adapter = await adapterForDocument(c, d, fetchImpl);
        if (!adapter) return;
        await applyProviderState(c, row.tenant_id, d, await adapter.status(d.provider_ref), "poll");
        checked++;
      });
    } catch { failed++; await db.system((c) => c.query(`UPDATE einvoice_documents SET polled_at=now() WHERE id=$1`, [row.id])); }
  }
  return { due: rows.length, checked, failed };
}

// ───────── forwarding a received supplier invoice into purchasing
/**
 * Turns a received supplier invoice into a DRAFT supplier bill (approval, payment and reconciliation stay with the normal bill workflow). The bill must equal the received
 * invoice's total to the fils, in its own currency: by default a single line at the chosen tax code, or the lines the person enters. A received invoice becomes a bill once.
 */
export async function forwardInboundToBill(c: Conn, ctx: Ctx, inboundId: string, f: { supplier_id: string; due_date: string; tax_code?: string; lines?: { description: string; net: number | string; tax_code?: string }[] }) {
  require(ctx, "finance.write");
  await assertWritable(c, ctx.tenantId);
  const inv = await must(c.query<any>(`SELECT * FROM einvoice_inbound WHERE id=$1 FOR UPDATE`, [recordId(inboundId, "Received invoice")]), "Received invoice");
  if (inv.status !== "received") throw badRequest(inv.status === "billed" ? "This invoice has already been entered as a bill." : "This invoice was dismissed.");
  if (!inv.number || !inv.currency || inv.total_minor === null || !inv.issued_on) throw badRequest("The provider has not yet supplied this invoice's number, currency, date and total. Try again shortly, or enter the bill by hand.");
  const total = Number(inv.total_minor);
  let lines = f.lines;
  if (!lines?.length) {
    const code = f.tax_code && TAX_CODES[f.tax_code] ? f.tax_code : "SR5", bps = TAX_CODES[code].bps;
    const net = Math.round((total * 10_000) / (10_000 + bps));
    lines = [{ description: `Supplier invoice ${inv.number}${inv.sender_name ? ` from ${inv.sender_name}` : ""}`, net, tax_code: code }];
  }
  const issued = new Date(inv.issued_on).toISOString().slice(0, 10);
  const bill = await enterBill(c, ctx, { supplier_id: f.supplier_id, supplier_ref: inv.number, currency: inv.currency, bill_date: issued, due_date: f.due_date, lines });
  const made = await must(c.query<any>(`SELECT total_minor FROM vendor_bills WHERE id=$1`, [bill.id]), "Bill");
  if (Number(made.total_minor) !== total) throw badRequest(`The bill would total ${(Number(made.total_minor) / 100).toFixed(2)} but the received invoice is ${(total / 100).toFixed(2)} ${inv.currency}. Enter the lines and tax codes as they appear on the invoice.`);
  await c.query(`UPDATE einvoice_inbound SET status='billed', bill_id=$2, handled_by=$3, handled_at=now() WHERE id=$1`, [inv.id, bill.id, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "einvoice.inbound_billed", "einvoice_inbound", inv.id, { bill: bill.no });
  return bill;
}
export async function dismissInbound(c: Conn, ctx: Ctx, inboundId: string, reason: string) {
  require(ctx, "finance.write");
  const inv = await must(c.query<any>(`SELECT status FROM einvoice_inbound WHERE id=$1 FOR UPDATE`, [recordId(inboundId, "Received invoice")]), "Received invoice");
  if (inv.status !== "received") throw badRequest("This invoice has already been handled.");
  const why = String(reason ?? "").trim();
  if (why.length < 5 || why.length > 300) throw badRequest("Give a reason of 5–300 characters.");
  await c.query(`UPDATE einvoice_inbound SET status='dismissed', dismiss_reason=$2, handled_by=$3, handled_at=now() WHERE id=$1`, [inboundId, why, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "einvoice.inbound_dismissed", "einvoice_inbound", inboundId);
}
