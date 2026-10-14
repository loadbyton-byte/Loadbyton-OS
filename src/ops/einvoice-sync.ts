import crypto from "node:crypto";
import type { Conn, Db } from "../db/client.js";
import { mapWafeqResult } from "../adapters/einvoice-wafeq.js";
import { audit } from "../lib/audit.js";
import { decryptSecret } from "../lib/encryption.js";
import { HttpError, badRequest, forbidden } from "../lib/util.js";
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
      const tenantId: string = svc.tenant_id, system = { kind: "system" as const };

      if (type === "document.sent" || type === "document.status" || type === "document.reported") {
        const ref = text(data.document_id) ?? text(data.id);
        const d = ref ? (await c.query<any>(`SELECT * FROM einvoice_documents WHERE tenant_id=$1 AND provider='wafeq' AND provider_ref=$2 FOR UPDATE`, [tenantId, ref])).rows[0] : null;
        if (!d) {                                                                                // the event can outrun our own save of the send response: ask for a retry, but only briefly
          const age = Date.now() - Date.parse(String(ev.created_at ?? ""));
          if (Number.isFinite(age) && age < 10 * 60_000) throw new HttpError(503, "document not recorded yet");
          return { status: 200, body: { ignored: "unknown document" } };
        }
        const r = mapWafeqResult(data, ref!);
        if (d.status === "submitted" && (r.status === "accepted" || r.status === "rejected")) {
          await c.query(`UPDATE einvoice_documents SET status=$2, provider_response=$3, decided_at=now() WHERE id=$1`, [d.id, r.status, JSON.stringify({ reasons: r.reasons, sandbox: d.provider_response?.sandbox === true, via: "webhook" })]);
          await audit(c, tenantId, system, "einvoice.provider_decision", d.kind, d.invoice_id ?? d.credit_note_id, { status: r.status, event: type });
        }
        if (r.reporting && r.reporting !== d.tdd_status) {
          await c.query(`UPDATE einvoice_documents SET tdd_status=$2 WHERE id=$1`, [d.id, r.reporting]);
          await audit(c, tenantId, system, "einvoice.reporting_state", d.kind, d.invoice_id ?? d.credit_note_id, { reporting: r.reporting });
        }
      } else if (type === "document.received") {
        const ref = text(data.document_id) ?? text(data.id);
        if (ref) {
          await c.query(
            `INSERT INTO einvoice_inbound(tenant_id,provider,provider_doc_id,number,sender_name,currency) VALUES ($1,'wafeq',$2,$3,$4,$5) ON CONFLICT (tenant_id,provider,provider_doc_id) DO NOTHING`,
            [tenantId, ref, text(data.invoice_number, 64), text(data.seller_name, 200), text(data.currency, 3)]);
          await enrichInbound(c, tenantId, ref, fetchImpl);
          await audit(c, tenantId, system, "einvoice.inbound_received", "einvoice_inbound", undefined, { provider: "wafeq" });
        }
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
  return (await c.query<any>(`SELECT id, provider, number, sender_name, currency, total_minor, issued_on, received_at FROM einvoice_inbound ORDER BY received_at DESC LIMIT 100`)).rows;
}

/** The provider's archived UBL for a received supplier invoice. */
export async function inboundXml(c: Conn, id: string): Promise<{ number: string; xml: string }> {
  const row = await must(c.query<any>(`SELECT * FROM einvoice_inbound WHERE id=$1`, [recordId(id, "Received invoice")]), "Received invoice");
  const route = await routeFor(c, undefined, true);
  if (!route?.adapter.downloadXml) throw badRequest("The provider does not offer a download for this document.");
  return { number: row.number ?? row.provider_doc_id, xml: await route.adapter.downloadXml(row.provider_doc_id) };
}

/** The provider's own archived copy of a document we sent (the version it reported), when it offers one. */
export async function archivedXml(c: Conn, d: any): Promise<string> {
  if (!d.provider_ref) throw badRequest("This document has not been sent to a provider.");
  const adapter = await adapterForDocument(c, d);
  if (!adapter?.downloadXml) throw forbidden("The provider does not offer a download for this document.");
  return adapter.downloadXml(d.provider_ref);
}
