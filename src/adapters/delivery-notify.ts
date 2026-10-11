import crypto from "node:crypto";
import type { Db } from "../db/client.js";
import { config } from "../config.js";
import { postJson, type PostOptions, type PostResult } from "../lib/safe-http.js";
import { unseal } from "../lib/seal.js";
import type { OutboxHandlers } from "../platform/outbox.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export class Permanent extends Error { permanent = true; }

// ───────────────────────── SMS
export interface SmsSender { send(to: string, body: string): Promise<{ id?: string }> }
export const logSms: SmsSender = { async send(to) { if (process.env.NODE_ENV !== "test") console.log(`[sms:log] to=${to.slice(0, 7)}*****`); return {}; } };
export function twilioSms(cfg = config.sms, fetchImpl: Fetch = fetch): SmsSender {
  return {
    async send(to, body) {
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.apiBase}/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
          method: "POST",
          headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ To: to, From: cfg.from, Body: body }).toString(), signal: AbortSignal.timeout(15_000),
        });
      } catch (e) { throw new Error(`sms provider unreachable: ${(e as Error).message}`); }
      const out: any = await res.json().catch(() => ({}));
      if (res.status >= 500 || res.status === 429) throw new Error(`sms provider ${res.status}`);
      if (!res.ok) throw new Permanent(`sms provider rejected the message (${res.status}${out?.code ? ` code ${out.code}` : ""})`);
      return { id: out.sid };
    },
  };
}
export const defaultSms = (): SmsSender => (config.sms.provider === "twilio" ? twilioSms() : logSms);

// ───────────────────────── WhatsApp (Meta Cloud API) — pre-approved templates only
export interface WhatsAppSender { sendTemplate(to: string, template: string, language: string, params: string[]): Promise<{ id?: string }> }
export const logWhatsApp: WhatsAppSender = { async sendTemplate(to) { if (process.env.NODE_ENV !== "test") console.log(`[whatsapp:log] to=${to.slice(0, 7)}*****`); return {}; } };
export function cloudWhatsApp(cfg = config.whatsapp, fetchImpl: Fetch = fetch): WhatsAppSender {
  return {
    async sendTemplate(to, template, language, params) {
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.apiBase}/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
          method: "POST", headers: { authorization: `Bearer ${cfg.accessToken}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/^\+/, ""), type: "template",
            template: { name: template, language: { code: language }, components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text: text.replace(/[\r\n\t]+/g, " ").slice(0, 1000) })) }] } }),
        });
      } catch (e) { throw new Error(`whatsapp provider unreachable: ${(e as Error).message}`); }
      const out: any = await res.json().catch(() => ({}));
      if (res.status >= 500 || res.status === 429) throw new Error(`whatsapp provider ${res.status}`);
      // 4xx: bad template/parameters, number not on WhatsApp, or the recipient cannot be messaged — retrying does not help
      if (!res.ok) throw new Permanent(`whatsapp provider rejected the message (${res.status}${out?.error?.code ? ` code ${out.error.code}` : ""})`);
      return { id: out?.messages?.[0]?.id };
    },
  };
}
export const defaultWhatsApp = (): WhatsAppSender => (config.whatsapp.provider === "cloud" ? cloudWhatsApp() : logWhatsApp);

// ───────────────────────── merchant webhooks
export const signWebhook = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

export interface NotifyDeps { sms?: SmsSender; whatsapp?: WhatsAppSender; post?: (url: string, body: string, headers: Record<string, string>, o?: PostOptions) => Promise<PostResult>; postOptions?: PostOptions }

export function deliveryNotifyHandlers(db: Db, deps: NotifyDeps = {}): OutboxHandlers {
  const sms = deps.sms ?? defaultSms(), whatsapp = deps.whatsapp ?? defaultWhatsApp(), post = deps.post ?? postJson;
  return {
    async "merchant.webhook"(row) {
      const p = row.payload;
      const s = (await db.query<any>(`SELECT webhook_url, webhook_secret_sealed, webhook_active FROM dlv_merchant_settings WHERE tenant_id=$1 AND merchant_id=$2`, [row.tenant_id, p.merchant_id])).rows[0];
      if (!s?.webhook_active) return;                                  // switched off since the event was queued: nothing to deliver
      const body = JSON.stringify({ id: row.id, type: p.type, created: new Date().toISOString(), data: p.data });
      let res: PostResult;
      try {
        res = await post(s.webhook_url, body, { "lbt-signature": signWebhook(unseal(s.webhook_secret_sealed), body), "lbt-event-id": row.id, "user-agent": "LOADBYTON-Webhooks/1" }, deps.postOptions);
      } catch (e: any) {
        if (e?.permanent) throw new Permanent(`webhook address refused: ${e.message}`);
        throw new Error(`webhook delivery failed: ${e?.message ?? e}`);
      }
      if (res.status === 410) throw new Permanent("the endpoint answered 410 Gone");
      if (res.status < 200 || res.status >= 300) throw new Error(`webhook endpoint answered ${res.status}`);
    },
    async whatsapp(row) {
      const { to, template, language, params } = row.payload ?? {};
      if (!to || !template || !Array.isArray(params)) throw new Permanent("whatsapp row has no recipient or template");
      const r = await whatsapp.sendTemplate(String(to), String(template), String(language || config.whatsapp.templateLanguage), params.map(String));
      return { externalId: r.id };
    },
    async sms(row) {
      const { to, body } = row.payload ?? {};
      if (!to || !body) throw new Permanent("sms row has no recipient or text");
      const r = await sms.send(String(to), String(body));
      return { externalId: r.id };
    },
  };
}
