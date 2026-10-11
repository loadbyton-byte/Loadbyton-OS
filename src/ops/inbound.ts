import crypto from "node:crypto";
import type { Conn, Db } from "../db/client.js";
import { rateLimit } from "../adapters/rate-limit.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { decryptSecret, encryptSecret } from "../lib/encryption.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, hmac, randomToken, safeEqual, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, optStr, recordId, reqStr } from "./common.js";
import { Calendar, DEFAULT_CALENDAR, businessDeadline } from "./workspace.js";

/**
 * Signed inbound channels. A message arrives as a signed HTTP request to a per-channel secret URL; nothing is trusted until the signature
 * verifies. Arrival creates a conversation (or an entry in the unmatched queue) and nothing else: no reply, no record change, no action.
 * Document text, email bodies and call notes are data — they cannot approve, assign or change anything.
 */
export type ChannelKind = "email" | "whatsapp" | "telephony";
export type Scheme = "lbt_hmac" | "meta_sha256" | "twilio";
const SCHEMES: Record<ChannelKind, Scheme[]> = { email: ["lbt_hmac"], whatsapp: ["meta_sha256"], telephony: ["twilio", "lbt_hmac"] };
const CONSENT_CHANNEL: Record<ChannelKind, "email" | "whatsapp" | "phone"> = { email: "email", whatsapp: "whatsapp", telephony: "phone" };
const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*[.!]*\s*$/i;

export interface Inbound { provider_id: string; sender: string; sender_name?: string; subject?: string; body: string; in_reply_to?: string }

// ───────── address normalisation and parsers (pure)
export function normaliseAddress(kind: ChannelKind, raw: string): string {
  const s = String(raw ?? "").trim();
  if (kind === "email") { const m = /<([^>]+)>/.exec(s); return (m ? m[1] : s).trim().toLowerCase(); }
  const digits = s.replace(/^whatsapp:/i, "").replace(/[^\d+]/g, "");
  return digits.startsWith("00") ? `+${digits.slice(2)}` : digits.startsWith("+") ? digits : `+${digits}`;
}
const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);

export function parseWhatsAppCloud(payload: any): Inbound[] {
  const out: Inbound[] = [];
  for (const e of payload?.entry ?? []) for (const ch of e?.changes ?? []) {
    const v = ch?.value, names = new Map<string, string>((v?.contacts ?? []).map((x: any) => [String(x.wa_id), String(x.profile?.name ?? "")]));
    for (const m of v?.messages ?? []) {
      if (!m?.id || !m?.from) continue;
      const body = m.type === "text" ? clean(m.text?.body, 8000) : `[${clean(m.type, 30) || "unsupported"} message — open it in the WhatsApp Business app]`;
      out.push({ provider_id: String(m.id), sender: String(m.from), sender_name: names.get(String(m.from)) || undefined, body: body || "[empty message]" });
    }
  }
  return out;
}
export function parseEmailRelay(payload: any): Inbound[] {
  if (!payload?.message_id || !payload?.from) return [];
  const body = clean(payload.text ?? "", 8000) || clean(String(payload.html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 8000);
  return [{ provider_id: String(payload.message_id).slice(0, 240), sender: String(payload.from), sender_name: /^([^<]+)</.exec(String(payload.from))?.[1]?.trim() || undefined,
    subject: clean(payload.subject, 200) || "(no subject)", body: body || "[empty message]", in_reply_to: payload.in_reply_to ? String(payload.in_reply_to).slice(0, 240) : undefined }];
}
export function parseTwilio(p: Record<string, string>): Inbound[] {
  if (p.MessageSid && p.From) return [{ provider_id: p.MessageSid, sender: p.From, body: clean(p.Body, 8000) || "[empty message]" }];
  if (p.CallSid && p.From) {
    if (p.CallStatus && !["completed", "no-answer", "busy", "failed", "canceled"].includes(p.CallStatus)) return [];
    const note = [`Call from ${p.From}`, p.To ? `to ${p.To}` : "", p.CallStatus ? `— ${p.CallStatus}` : "", p.CallDuration ? `(${p.CallDuration}s)` : ""].filter(Boolean).join(" ");
    return [{ provider_id: `${p.CallSid}`, sender: p.From, subject: "Phone call", body: clean(p.TranscriptionText ? `${note}\nTranscript: ${p.TranscriptionText}` : note, 8000) }];
  }
  return [];
}

// ───────── signatures
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", authToken).update(data).digest("base64");
}
export function verifyInbound(scheme: Scheme, secret: string, req: { raw: string; header: (n: string) => string | undefined; url: string; form?: Record<string, string> }, now = Date.now()): boolean {
  if (scheme === "meta_sha256") {
    const h = req.header("x-hub-signature-256") ?? "";
    return h.startsWith("sha256=") && safeEqual(h.slice(7), hmac(secret, req.raw));
  }
  if (scheme === "twilio") {
    const h = req.header("x-twilio-signature");
    return !!h && !!req.form && safeEqual(h, twilioSignature(secret, req.url, req.form));
  }
  const header = req.header("x-lbt-signature");
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  return !!t && !!parts.v1 && Math.abs(now / 1000 - t) <= 300 && safeEqual(parts.v1, hmac(secret, `${t}.${req.raw}`));
}
export const signRelay = (secret: string, raw: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${hmac(secret, `${t}.${raw}`)}`;

// ───────── channel management
export const channelUrl = (token: string) => `${config.baseUrl}/webhooks/inbound/${token}`;
export async function createChannel(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  const kind = f.kind as ChannelKind;
  if (!SCHEMES[kind]) throw badRequest("Choose email, WhatsApp or telephony.");
  const scheme = (f.scheme || SCHEMES[kind][0]) as Scheme;
  if (!SCHEMES[kind].includes(scheme)) throw badRequest("That signature scheme is not available for this channel.");
  const sla = f.sla_minutes ? Number(f.sla_minutes) : 240;
  if (!Number.isInteger(sla) || sla < 1 || sla > 10000) throw badRequest("The response target is 1–10,000 business minutes.");
  // WhatsApp (app secret) and Twilio (auth token) secrets are issued by the provider and entered here; relay secrets are generated
  const provided = optStr(f.provider_secret, 200);
  if ((scheme === "meta_sha256" || scheme === "twilio") && !provided) throw badRequest(scheme === "meta_sha256" ? "Enter the Meta app secret." : "Enter the Twilio auth token.");
  const secret = provided ?? randomToken(32), token = randomToken(24), verify = scheme === "meta_sha256" ? randomToken(18) : null;
  const id = (await c.query<any>(
    `INSERT INTO inbound_channels(tenant_id,kind,label,token_hash,scheme,secret_enc,verify_token_enc,sla_minutes,thread_reply_implied,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, kind, reqStr(f.label, "Channel name", 80), sha256(token), scheme, encryptSecret(secret), verify ? encryptSecret(verify) : null, sla, f.thread_reply_implied === true || f.thread_reply_implied === "1", ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "inbound.channel_created", "inbound_channel", id, { kind, scheme });
  // the URL, relay secret and verify token are shown once; they are not retrievable later
  return { id: id as string, url: channelUrl(token), secret: provided ? undefined : secret, verify_token: verify ?? undefined };
}
export async function setChannelStatus(c: Conn, ctx: Ctx, id: string, status: "active" | "paused") {
  require(ctx, "settings.manage");
  if (!["active", "paused"].includes(status)) throw badRequest("Choose active or paused.");
  await must(c.query(`UPDATE inbound_channels SET status=$2 WHERE id=$1 RETURNING id`, [recordId(id, "Channel"), status]), "Channel");
  await audit(c, ctx.tenantId, actorOf(ctx), "inbound.channel_status", "inbound_channel", id, { status });
}
export async function listChannels(c: Conn) {
  return (await c.query<any>(
    `SELECT ch.id, ch.kind, ch.label, ch.scheme, ch.sla_minutes, ch.thread_reply_implied, ch.status, ch.created_at,
            (SELECT count(*) FROM inbound_events e WHERE e.channel_id=ch.id)::int AS received, (SELECT count(*) FROM inbound_events e WHERE e.channel_id=ch.id AND e.status='unmatched')::int AS unmatched
       FROM inbound_channels ch ORDER BY ch.created_at DESC`)).rows;
}

// ───────── consent and identity
export async function latestConsent(c: Conn, partyId: string, channel: string): Promise<"opt_in" | "opt_out" | null> {
  return (await c.query<any>(`SELECT status FROM channel_consents WHERE party_id=$1 AND channel=$2 ORDER BY id DESC LIMIT 1`, [partyId, channel])).rows[0]?.status ?? null;
}
async function syncEmailConsent(c: Conn, partyId: string) {
  const s = await latestConsent(c, partyId, "email");
  if (s === "opt_in") await c.query(`UPDATE conversations SET email_consent=true WHERE party_id=$1 AND status='open'`, [partyId]);
  if (s === "opt_out") await c.query(`UPDATE conversations SET email_consent=false WHERE party_id=$1 AND status='open'`, [partyId]);
}
export async function recordConsent(c: Conn, ctx: Ctx, partyId: string, channel: string, status: "opt_in" | "opt_out", source: string, evidence?: string) {
  require(ctx, "inbox.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1`, [recordId(partyId, "Customer")]), "Customer");
  if (!["email", "whatsapp", "sms", "phone"].includes(channel) || !["opt_in", "opt_out"].includes(status)) throw badRequest("Choose a channel and an opt-in or opt-out.");
  const ev = status === "opt_in" ? reqStr(evidence, "Evidence of consent (how and when it was given)", 1000) : optStr(evidence, 1000);
  await c.query(`INSERT INTO channel_consents(tenant_id,party_id,channel,status,source,evidence,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ctx.tenantId, partyId, channel, status, reqStr(source, "Source", 120), ev, ctx.userId]);
  if (channel === "email") await syncEmailConsent(c, partyId);
  await audit(c, ctx.tenantId, actorOf(ctx), "consent.recorded", "party", partyId, { channel, status });
}
export async function verifyIdentity(c: Conn, ctx: Ctx, partyId: string, channel: "email" | "whatsapp" | "phone", address: string, method: string, note: string) {
  require(ctx, "inbox.approve");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM parties WHERE id=$1`, [recordId(partyId, "Customer")]), "Customer");
  if (!["email", "whatsapp", "phone"].includes(channel)) throw badRequest("Choose a channel.");
  const addr = normaliseAddress(channel === "email" ? "email" : "telephony", address);
  const why = reqStr(note, "How the person was verified (e.g. called back the number on file)", 500), how = reqStr(method, "Verification method", 80);
  await c.query(
    `INSERT INTO contact_identities(tenant_id,party_id,channel,address,verified_at,verified_by,method,note,created_by) VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$5)
     ON CONFLICT (tenant_id,channel,address) DO UPDATE SET verified_at=now(), verified_by=$5, method=$6, note=$7 WHERE contact_identities.party_id=$2`, [ctx.tenantId, partyId, channel, addr, ctx.userId, how, why]);
  const row = (await c.query<any>(`SELECT party_id FROM contact_identities WHERE channel=$1 AND address=$2`, [channel, addr])).rows[0];
  if (row.party_id !== partyId) throw badRequest("That address is already linked to a different customer.");
  await c.query(`UPDATE conversations v SET identity_state='verified' WHERE v.party_id=$1 AND v.status='open' AND v.identity_state='unverified' AND EXISTS (SELECT 1 FROM inbound_events e WHERE e.conversation_id=v.id AND e.sender_norm=$2)`, [partyId, addr]);
  await audit(c, ctx.tenantId, actorOf(ctx), "identity.verified", "party", partyId, { channel, method: how });
}

// ───────── ingestion
async function resolveParty(c: Conn, channel: any, norm: string): Promise<{ partyId: string; state: "verified" | "unverified" } | null> {
  const ch = CONSENT_CHANNEL[channel.kind as ChannelKind];
  const known = (await c.query<any>(`SELECT party_id, verified_at FROM contact_identities WHERE channel=$1 AND address=$2`, [ch, norm])).rows[0];
  if (known) return { partyId: known.party_id, state: known.verified_at ? "verified" : "unverified" };
  const rows = ch === "email"
    ? (await c.query<any>(`SELECT id FROM parties WHERE lower(email)=$1 AND kind='customer' LIMIT 3`, [norm])).rows
    : (await c.query<any>(`SELECT id FROM parties WHERE regexp_replace(coalesce(phone,''),'[^0-9]','','g')<>'' AND regexp_replace(phone,'[^0-9]','','g')=regexp_replace($1,'[^0-9]','','g') AND kind='customer' LIMIT 3`, [norm])).rows;
  if (rows.length !== 1) return null;                       // none, or ambiguous: a person decides
  await c.query(`INSERT INTO contact_identities(tenant_id,party_id,channel,address,created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [channel.tenant_id, rows[0].id, ch, norm, channel.created_by]);
  return { partyId: rows[0].id, state: "unverified" };
}

async function openConversationFor(c: Conn, channel: any, partyId: string, m: Inbound, state: string, norm: string): Promise<string> {
  if (channel.kind === "email" && m.in_reply_to) {
    const hit = (await c.query<any>(`SELECT v.id FROM conversation_messages x JOIN conversations v ON v.id=x.conversation_id WHERE x.provider_id=$1 AND v.party_id=$2 AND v.status='open'`, [m.in_reply_to, partyId])).rows[0];
    if (hit) return hit.id;
  }
  if (channel.kind !== "email") {
    const hit = (await c.query<any>(`SELECT id FROM conversations WHERE party_id=$1 AND channel_id=$2 AND status='open' ORDER BY created_at DESC LIMIT 1`, [partyId, channel.id])).rows[0];
    if (hit) return hit.id;
  }
  const calendar = (await c.query<Calendar>(`SELECT * FROM business_calendars`)).rows[0] ?? DEFAULT_CALENDAR;
  const consent = await latestConsent(c, partyId, CONSENT_CHANNEL[channel.kind as ChannelKind] === "phone" ? "email" : CONSENT_CHANNEL[channel.kind as ChannelKind]);
  const emailConsent = channel.kind === "email" && consent !== "opt_out" && (consent === "opt_in" || channel.thread_reply_implied);
  const subject = m.subject || (channel.kind === "whatsapp" ? "WhatsApp message" : "Phone call");
  return (await c.query<any>(
    `INSERT INTO conversations(tenant_id,party_id,subject,source,external_ref,owner_id,accepted_at,priority,due_at,email_consent,created_by,channel_id,identity_state) VALUES ($1,$2,$3,$4,$5,NULL,NULL,'normal',$6,$7,$8,$9,$10) RETURNING id`,
    [channel.tenant_id, partyId, clean(subject, 200), channel.kind, `${channel.kind}:${m.provider_id}`.slice(0, 120), businessDeadline(new Date(), channel.sla_minutes, calendar), emailConsent, channel.created_by, channel.id, state])).rows[0].id;
  void norm;
}

export async function ingestMessage(c: Conn, channel: any, m: Inbound): Promise<{ status: string; conversationId?: string }> {
  const norm = normaliseAddress(channel.kind, m.sender), hash = sha256(JSON.stringify([m.provider_id, norm, m.subject ?? "", m.body]));
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${channel.tenant_id}:inbound:${channel.id}:${m.provider_id}`]);
  const dup = (await c.query<any>(`SELECT status, conversation_id, payload_hash FROM inbound_events WHERE channel_id=$1 AND provider_id=$2`, [channel.id, m.provider_id])).rows[0];
  if (dup) return { status: dup.payload_hash === hash ? "duplicate" : "conflict", conversationId: dup.conversation_id };
  const party = await resolveParty(c, channel, norm);
  const optOut = channel.kind !== "email" && OPT_OUT.test(m.body);
  const base = [channel.tenant_id, channel.id, m.provider_id, m.sender.slice(0, 200), norm, m.sender_name?.slice(0, 120) ?? null, m.subject ?? null, m.body, hash];
  if (optOut && party) {
    await c.query(`INSERT INTO channel_consents(tenant_id,party_id,channel,status,source,evidence) VALUES ($1,$2,$3,'opt_out',$4,$5)`, [channel.tenant_id, party.partyId, CONSENT_CHANNEL[channel.kind as ChannelKind] === "phone" ? "sms" : "whatsapp", `inbound ${channel.kind} keyword`, `Message ${m.provider_id}`]);
    await c.query(`INSERT INTO inbound_events(tenant_id,channel_id,provider_id,sender,sender_norm,sender_name,subject,body,payload_hash,status,party_id,identity_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'opted_out',$10,$11)`, [...base, party.partyId, party.state]);
    return { status: "opted_out" };
  }
  if (!party) {
    await c.query(`INSERT INTO inbound_events(tenant_id,channel_id,provider_id,sender,sender_norm,sender_name,subject,body,payload_hash,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unmatched')`, base);
    return { status: "unmatched" };
  }
  const convId = await openConversationFor(c, channel, party.partyId, m, party.state, norm);
  await c.query(`INSERT INTO conversation_messages(tenant_id,conversation_id,direction,body,reference,status,created_by,provider_id) VALUES ($1,$2,'inbound',$3,$4,'captured',$5,$6) ON CONFLICT (tenant_id,conversation_id,reference) DO NOTHING`,
    [channel.tenant_id, convId, m.body, `in:${m.provider_id}`.slice(0, 120), channel.created_by, m.provider_id]);
  if (party.state === "unverified") await c.query(`UPDATE conversations SET identity_state='unverified' WHERE id=$1 AND identity_state='verified' AND NOT EXISTS (SELECT 1 FROM contact_identities WHERE party_id=$2 AND address=$3 AND verified_at IS NOT NULL)`, [convId, party.partyId, norm]);
  await c.query(`INSERT INTO inbound_events(tenant_id,channel_id,provider_id,sender,sender_norm,sender_name,subject,body,payload_hash,status,conversation_id,party_id,identity_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'conversation',$10,$11,$12)`, [...base, convId, party.partyId, party.state]);
  await audit(c, channel.tenant_id, { kind: "system" }, "inbox.received", "conversation", convId, { channel: channel.kind, identity: party.state });
  return { status: "conversation", conversationId: convId };
}

export interface HookRequest { method: string; raw: string; header: (n: string) => string | undefined; query: (n: string) => string | undefined }
/** Entry point for `/webhooks/inbound/:token`. Unknown, paused and badly signed requests all look the same from outside. */
export async function handleInbound(db: Db, token: string, req: HookRequest): Promise<{ status: number; body: unknown; text?: string }> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { status: 404, body: { error: "not found" } };
  const ch = (await db.system((c) => c.query<any>(`SELECT * FROM inbound_channels WHERE token_hash=$1`, [sha256(token)]))).rows[0];
  if (!ch || ch.status !== "active") return { status: 404, body: { error: "not found" } };
  await rateLimit(`inbound:${ch.id}`, 600, 60);
  const secret = decryptSecret(ch.secret_enc);
  if (req.method === "GET") {
    if (ch.scheme === "meta_sha256" && req.query("hub.mode") === "subscribe" && ch.verify_token_enc && safeEqual(req.query("hub.verify_token") ?? "", decryptSecret(ch.verify_token_enc))) return { status: 200, body: null, text: req.query("hub.challenge") ?? "" };
    return { status: 404, body: { error: "not found" } };
  }
  if (req.method !== "POST" || req.raw.length > 262_144) return { status: 400, body: { error: "bad request" } };
  const url = channelUrl(token);
  const form = ch.scheme === "twilio" ? Object.fromEntries(new URLSearchParams(req.raw)) as Record<string, string> : undefined;
  if (!verifyInbound(ch.scheme, secret, { raw: req.raw, header: req.header, url, form })) return { status: 401, body: { error: "invalid signature" } };
  let messages: Inbound[];
  try {
    messages = ch.kind === "whatsapp" ? parseWhatsAppCloud(JSON.parse(req.raw)) : ch.kind === "email" ? parseEmailRelay(JSON.parse(req.raw))
      : ch.scheme === "twilio" ? parseTwilio(form!) : parseEmailRelay(JSON.parse(req.raw)).map((m) => ({ ...m, subject: m.subject ?? "Phone call" }));
  } catch { return { status: 400, body: { error: "invalid payload" } }; }
  const results: string[] = [];
  for (const m of messages.slice(0, 50)) {
    try { results.push((await db.tenant(ch.tenant_id, async (c) => { await assertWritable(c, ch.tenant_id); return ingestMessage(c, ch, m); })).status); }
    catch (e) { if (e instanceof HttpError && e.status === 402) { results.push("workspace_read_only"); continue; } throw e; }
  }
  return { status: 200, body: { received: results.length, results } };
}

// ───────── triage
export async function listUnmatched(c: Conn) {
  return (await c.query<any>(`SELECT e.id, e.sender, e.sender_name, e.subject, e.body, e.received_at, ch.kind, ch.label FROM inbound_events e JOIN inbound_channels ch ON ch.id=e.channel_id WHERE e.status='unmatched' ORDER BY e.received_at LIMIT 100`)).rows;
}
export async function resolveUnmatched(c: Conn, ctx: Ctx, eventId: string, partyId: string) {
  require(ctx, "inbox.write");
  await assertWritable(c, ctx.tenantId);
  const e = await must(c.query<any>(`SELECT * FROM inbound_events WHERE id=$1 AND status='unmatched' FOR UPDATE`, [recordId(eventId, "Message")]), "Unmatched message");
  const party = await must(c.query<any>(`SELECT id FROM parties WHERE id=$1 AND kind='customer'`, [recordId(partyId, "Customer")]), "Customer");
  const ch = await must(c.query<any>(`SELECT * FROM inbound_channels WHERE id=$1`, [e.channel_id]), "Channel");
  await c.query(`INSERT INTO contact_identities(tenant_id,party_id,channel,address,created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [ctx.tenantId, party.id, CONSENT_CHANNEL[ch.kind as ChannelKind], e.sender_norm, ctx.userId]);
  const linked = (await c.query<any>(`SELECT party_id FROM contact_identities WHERE channel=$1 AND address=$2`, [CONSENT_CHANNEL[ch.kind as ChannelKind], e.sender_norm])).rows[0];
  if (linked.party_id !== party.id) throw badRequest("That address already belongs to a different customer.");
  const conv = await openConversationFor(c, ch, party.id, { provider_id: e.provider_id, sender: e.sender, subject: e.subject ?? undefined, body: e.body }, "unverified", e.sender_norm);
  await c.query(`INSERT INTO conversation_messages(tenant_id,conversation_id,direction,body,reference,status,created_by,provider_id) VALUES ($1,$2,'inbound',$3,$4,'captured',$5,$6) ON CONFLICT (tenant_id,conversation_id,reference) DO NOTHING`, [ctx.tenantId, conv, e.body, `in:${e.provider_id}`.slice(0, 120), ctx.userId, e.provider_id]);
  await c.query(`UPDATE conversations SET identity_state='unverified' WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM contact_identities WHERE party_id=$2 AND address=$3 AND verified_at IS NOT NULL)`, [conv, party.id, e.sender_norm]);
  await c.query(`UPDATE inbound_events SET status='resolved', conversation_id=$2, party_id=$3, identity_state='unverified', resolved_by=$4, resolved_at=now() WHERE id=$1`, [e.id, conv, party.id, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "inbox.unmatched_resolved", "conversation", conv);
  return conv as string;
}
export async function discardUnmatched(c: Conn, ctx: Ctx, eventId: string, reason: string) {
  require(ctx, "inbox.write");
  const e = await must(c.query<any>(`SELECT id FROM inbound_events WHERE id=$1 AND status='unmatched' FOR UPDATE`, [recordId(eventId, "Message")]), "Unmatched message");
  // the content is personal data nobody is acting on: it is erased, leaving only the evidence that it arrived and was discarded
  await c.query(`UPDATE inbound_events SET status='ignored', body=NULL, subject=NULL, sender=NULL, sender_name=NULL, resolved_by=$2, resolved_at=now() WHERE id=$1`, [e.id, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "inbox.unmatched_discarded", "inbound_event", e.id, { reason: reqStr(reason, "Reason", 300) });
}
export async function claimConversation(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "inbox.write");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`UPDATE conversations SET owner_id=$2, accepted_at=now() WHERE id=$1 AND owner_id IS NULL AND status='open' RETURNING id`, [recordId(id, "Conversation"), ctx.userId]), "Unassigned open conversation");
  await audit(c, ctx.tenantId, actorOf(ctx), "inbox.claimed", "conversation", id);
}
/** WhatsApp and phone replies are sent from the provider's own app; this records that the owner did so, with the evidence, after the same identity and consent checks. */
export async function recordManualReply(c: Conn, ctx: Ctx, conversationId: string, body: string, evidence: string) {
  require(ctx, "inbox.write");
  await assertWritable(c, ctx.tenantId);
  const v = await must(c.query<any>(`SELECT v.*, ch.kind FROM conversations v LEFT JOIN inbound_channels ch ON ch.id=v.channel_id WHERE v.id=$1 FOR UPDATE OF v`, [recordId(conversationId, "Conversation")]), "Conversation");
  if (v.status !== "open" || v.owner_id !== ctx.userId || !v.accepted_at) throw badRequest("Accept the conversation before recording a reply.");
  if (v.kind !== "whatsapp" && v.kind !== "telephony") throw badRequest("Email replies go through the reviewed draft and approval flow.");
  if (v.identity_state !== "verified") throw badRequest("Verify who the sender is before replying with account information.");
  const ch = CONSENT_CHANNEL[v.kind as ChannelKind];
  if ((await latestConsent(c, v.party_id, ch === "phone" ? "sms" : ch)) === "opt_out") throw badRequest("This customer has opted out of this channel.");
  const text = reqStr(body, "What was sent or said", 8000), proof = reqStr(evidence, "Evidence (provider message id, call reference)", 300);
  const id = (await c.query<any>(`INSERT INTO conversation_messages(tenant_id,conversation_id,direction,body,reference,status,created_by,sent_at,external_id) VALUES ($1,$2,'outbound',$3,$4,'sent',$5,now(),$6) RETURNING id`, [ctx.tenantId, v.id, text, `manual:${crypto.randomUUID()}`, ctx.userId, proof])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "inbox.manual_reply_recorded", "message", id);
  return id as string;
}

/** Everything the conversation page needs to show who is writing, whether they are verified, and what they have agreed to. */
export async function conversationChannelInfo(c: Conn, conversationId: string) {
  const v = (await c.query<any>(`SELECT v.party_id, v.identity_state, v.owner_id, v.accepted_at, ch.kind, ch.label FROM conversations v LEFT JOIN inbound_channels ch ON ch.id=v.channel_id WHERE v.id=$1`, [recordId(conversationId, "Conversation")])).rows[0];
  if (!v) return null;
  const addresses = (await c.query<any>(`SELECT DISTINCT e.sender_norm AS address, i.channel, (i.verified_at IS NOT NULL) AS verified FROM inbound_events e LEFT JOIN contact_identities i ON i.party_id=e.party_id AND i.address=e.sender_norm WHERE e.conversation_id=$1`, [conversationId])).rows;
  const consent: Record<string, string | null> = {};
  for (const ch of ["email", "whatsapp", "sms", "phone"]) consent[ch] = await latestConsent(c, v.party_id, ch);
  return { ...v, addresses, consent };
}
