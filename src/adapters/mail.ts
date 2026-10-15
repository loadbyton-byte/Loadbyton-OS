import type { Db } from "../db/client.js";
import { config } from "../config.js";
import { baseUrl, sha256 } from "../lib/util.js";
import type { OutboxHandlers } from "../platform/outbox.js";
import { decryptSecret } from "../lib/encryption.js";

export interface MailMessage { to: string; subject: string; text: string; html: string }
export interface Mailer { send(m: MailMessage): Promise<{ id?: string }> }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Development / "no provider yet": prints one line (never the body: invitation links are credentials). */
export const logMailer: Mailer = {
  async send(m) { if (process.env.NODE_ENV !== "test") console.log(`[mail:log] to=${m.to.replace(/^(.).*(@.*)$/, "$1***$2")} subject="${m.subject}"`); return {}; },
};

export function resendMailer(cfg: Pick<typeof config.mail, "provider" | "resendApiKey" | "from" | "apiBase"> = config.mail, fetchImpl: Fetch = fetch): Mailer {
  return {
    async send(m) {
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.apiBase}/emails`, {
          method: "POST", headers: { authorization: `Bearer ${cfg.resendApiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from: cfg.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }), signal: AbortSignal.timeout(15_000),
        });
      } catch (e) { throw new Error(`mail provider unreachable: ${(e as Error).message}`); }   // retried by the outbox
      const out: any = await res.json().catch(() => ({}));
      if (res.status >= 500 || res.status === 429) throw new Error(`mail provider ${res.status}`);          // transient: retry
      if (!res.ok) throw new PermanentMailError(`mail provider rejected the message (${res.status}): ${out?.message ?? out?.name ?? "unknown"}`);
      return { id: out.id };
    },
  };
}
/** A 4xx other than 429 will not succeed on retry (bad address, unverified domain, bad key): the row goes to the staff-visible dead queue promptly. */
export class PermanentMailError extends Error { permanent = true; }

/** SMTP relay (Amazon SES, or any provider). Connection errors and 4xx replies are retried by the outbox; 5xx rejections are permanent. */
export function smtpMailer(cfg = config.mail): Mailer {
  let transport: any;
  return {
    async send(m) {
      transport ??= (await import("nodemailer")).default.createTransport({ host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure, requireTLS: !cfg.smtp.secure, auth: { user: cfg.smtp.user, pass: cfg.smtp.pass }, connectionTimeout: 15_000, socketTimeout: 20_000 });
      try {
        const r = await transport.sendMail({ from: cfg.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
        return { id: String(r.messageId ?? "") || undefined };
      } catch (e: any) {
        const code = Number(e?.responseCode ?? 0);
        if (code >= 500 && code < 600) throw new PermanentMailError(`SMTP relay rejected the message (${code}): ${String(e.response ?? e.message).slice(0, 200)}`);
        throw new Error(`SMTP relay unavailable: ${e?.message ?? e}`);
      }
    },
  };
}

export const defaultMailer = (): Mailer => (config.mail.provider === "resend" ? resendMailer() : config.mail.provider === "smtp" ? smtpMailer() : logMailer);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const wrap = (title: string, paras: string[], cta?: { label: string; href: string }) => {
  const sig = config.seller.legalName ? `\n\n— ${config.seller.tradeName || config.seller.legalName}` : "\n\n— LOAD|BY|TON.store";
  const text = `${title}\n\n${paras.join("\n\n")}${cta ? `\n\n${cta.label}: ${cta.href}` : ""}${sig}`;
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#172536;max-width:560px;margin:auto"><h2 style="color:#071D35">${esc(title)}</h2>${paras.map((p) => `<p>${esc(p)}</p>`).join("")}${
    cta ? `<p><a href="${esc(cta.href)}" style="display:inline-block;background:#D81724;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:700">${esc(cta.label)}</a></p><p style="font-size:12px;color:#5b6b7c">If the button does not work, paste this address into your browser:<br>${esc(cta.href)}</p>` : ""}<p style="color:#5b6b7c;font-size:13px">${esc(sig.trim())}</p></div>`;
  return { text, html };
};

/** Pure templates: (payload facts) → subject/body. Unknown templates are never sent (the row is dead-lettered so a human sees the gap). */
export const templates: Record<string, (d: Record<string, any>) => { subject: string; text: string; html: string }> = {
  password_recovery: (d) => ({ subject: 'Reset your LOAD|BY|TON.store password', ...wrap('Reset your password', ['A password reset was requested for your account. This link expires in one hour and works once. If you did not request it, you can ignore this email.'], d.link ? { label: 'Reset password', href: d.link } : undefined) }),
  email_verification: (d) => ({ subject: "Confirm your email address for LOAD|BY|TON.store", ...wrap("Confirm your email address", ["Confirm this address to continue verifying your company. The link works once and expires in 24 hours. If you did not register, ignore this email."], d.link ? { label: "Confirm email address", href: d.link } : undefined) }),
  kyc_decision: (d) => ({ subject: d.decision === "verified" ? "Your company is verified" : d.decision === "rejected" ? "We could not verify your company" : "Your company verification needs attention", ...wrap(d.decision === "verified" ? "Your company is verified" : d.decision === "rejected" ? "We could not verify your company" : "Your company is back in review", [d.decision === "verified" ? "Your workspace is now active." : d.decision === "rejected" ? "Your workspace stays read-only." : "Our team is looking at your company details again.", `Note from our team: ${String(d.note ?? "").slice(0, 500)}`], d.link ? { label: "Open your workspace", href: d.link } : undefined) }),
  invitation: (d) => ({ subject: "You have been invited to LOAD|BY|TON.store", ...wrap("You have been invited", ["Someone on your team invited you to their workspace. Set your own password to join — the link works for 7 days."], d.link ? { label: "Accept the invitation", href: d.link } : undefined) }),
  payment_received: (d) => ({ subject: `Payment received · ${d.reference}`, ...wrap("Payment received", [`We received payment ${d.reference}. Your plan is being activated; you will get another email when your workspace is ready.`], d.link ? { label: "Open plan & billing", href: d.link } : undefined) }),
  chat_started: (d) => ({ subject: `New live chat: ${String(d.name ?? "A visitor").slice(0, 60)}`, ...wrap("New live chat", [`${d.name ?? "A visitor"}${d.email ? ` (${d.email})` : ""} started a chat${d.page ? ` on ${d.page}` : ""}.`, `First message: ${d.first ?? ""}`], d.link ? { label: "Open the conversation", href: d.link } : undefined) }),
  workspace_ready: (d) => ({ subject: "Your workspace is ready", ...wrap("Your workspace is ready", ["Your upgraded workspace has been activated and checked. Everything you had before is still there."], d.link ? { label: "Open your workspace", href: d.link } : undefined) }),
};

/** Email handler for the outbox: resolves recipients from the database, renders a template, sends through the configured provider. */
export function mailHandlers(db: Db, mailer: Mailer = defaultMailer()): OutboxHandlers {
  const owners = async (tenantId: string | null) => tenantId
    ? (await db.query<any>(`SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.active AND 'owner'=ANY(m.roles)`, [tenantId])).rows.map((r) => r.email as string) : [];
  return {
    async email(row) {
      const p = row.payload ?? {}, tpl = templates[p.template];
      if (!tpl) throw new PermanentMailError(`no email template "${p.template}"`);
      let to: string[] = [], d: Record<string, any> = { ...p };
      if (p.template === "invitation") {
        to = [String(p.email ?? "")];
        // The raw invitation token is stored encrypted in the queue; the link is built only at send time.
        if (p.tokenEncrypted) d = { ...p, link: `${baseUrl()}/invite/${decryptSecret(p.tokenEncrypted)}` };
        else if (!p.link) throw new PermanentMailError("Legacy invitation requires an owner to revoke and reissue a secure link");
      }
      else if (p.template === 'password_recovery') {
        if (!p.tokenEncrypted) throw new PermanentMailError('Recovery token is unavailable');
        const token = decryptSecret(p.tokenEncrypted);
        const recovery = (await db.query<any>(`SELECT u.email FROM password_recoveries r JOIN users u ON u.id=r.user_id WHERE r.token_hash=$1 AND r.user_id=$2 AND r.consumed_at IS NULL AND r.expires_at>now()`, [sha256(token), p.userId])).rows[0];
        // Expired or replaced requests are intentionally completed without delivery.
        if (!recovery) return {};
        to = [recovery.email];
        d = { ...p, link: `${baseUrl()}/reset-password?token=${encodeURIComponent(token)}` };
      }
      else if (p.template === "email_verification") {
        if (!p.tokenEncrypted) throw new PermanentMailError("Verification token is unavailable");
        const token = decryptSecret(p.tokenEncrypted);
        const u = (await db.query<any>(`SELECT u.email FROM email_verifications v JOIN users u ON u.id=v.user_id WHERE v.token_hash=$1 AND v.user_id=$2 AND v.consumed_at IS NULL AND v.expires_at>now()`, [sha256(token), p.userId])).rows[0];
        if (!u) return {};                                     // replaced or already used: completed without delivery
        to = [u.email]; d = { ...p, link: `${baseUrl()}/verify-email?token=${encodeURIComponent(token)}` };
      }
      else if (p.template === "kyc_decision") { to = await owners(row.tenant_id); d = { ...p, link: `${baseUrl()}/app/verify` }; }
      else if (p.template === "payment_received") {
        const o = (await db.query<any>(`SELECT o.reference, u.email FROM orders o LEFT JOIN users u ON u.id=o.created_by WHERE o.id=$1`, [p.orderId])).rows[0];
        if (!o) throw new PermanentMailError("order not found");
        d = { ...p, reference: o.reference, link: `${baseUrl()}/app/billing` };
        to = o.email ? [o.email] : await owners(row.tenant_id);
      } else if (p.template === "chat_started") { to = [config.contact.emails.support]; d = { ...p, link: `${baseUrl()}/admin/chats/${p.threadId}` }; }
      else if (p.template === "workspace_ready") { to = await owners(row.tenant_id); d = { ...p, link: `${baseUrl()}/app` }; }
      to = [...new Set(to.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))];
      if (!to.length) throw new PermanentMailError("no recipient");
      const msg = tpl(d);
      let id: string | undefined;
      for (const addr of to) id = (await mailer.send({ to: addr, ...msg })).id ?? id;
      return { externalId: id };
    },
  };
}
