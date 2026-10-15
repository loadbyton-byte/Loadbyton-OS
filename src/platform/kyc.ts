import crypto from "node:crypto";
import type { Conn, Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { config } from "../config.js";
import { encryptSecret } from "../lib/encryption.js";
import { HttpError, badRequest, randomToken, sha256 } from "../lib/util.js";
import { rateLimit } from "../lib/ratelimit.js";
import { storeDocument, type Scanner, basicScan } from "../ops/documents.js";
import { gateMessage } from "./kyc-messages.js";
import { permsFor, type Ctx } from "../lib/perms.js";

/**
 * Company verification. Registration collects the business's identity (trade licence, optional tax number, mobile number) and refuses a second workspace for an identity that
 * already has one. The workspace stays read-only until the owner has confirmed their email and mobile number, uploaded the trade licence, and a member of platform staff has
 * reviewed it. Identity keys stay reserved after a rejection. Every step is recorded in an immutable event log. Software cannot check a licence against the issuing authority:
 * that step is the staff review, and the review screen shows what the checks found.
 */
export const DISPOSABLE_DOMAINS = new Set(`mailinator.com guerrillamail.com guerrillamail.net guerrillamail.org sharklasers.com grr.la 10minutemail.com 10minutemail.net temp-mail.org tempmail.com tempmail.net tempmail.dev
  tempail.com tempr.email throwawaymail.com trashmail.com trashmail.net yopmail.com yopmail.net yopmail.fr getnada.com nada.email dispostable.com fakeinbox.com maildrop.cc mailnesia.com mintemail.com
  spamgourmet.com mohmal.com emailondeck.com burnermail.io discard.email discardmail.com getairmail.com harakirimail.com inboxkitten.com mailcatch.com mytemp.email moakt.com tmpmail.org
  tmpmail.net temporary-mail.net luxusmail.org fakemail.net fakemailgenerator.com instantemailaddress.com jetable.org mail-temporary.com mailforspam.com mailtemp.info mvrht.com
  spambox.us spam4.me trbvm.com zetmail.com emailfake.com fexbox.org cs.email wegwerfmail.de einrot.com mail7.io 1secmail.com 1secmail.net 1secmail.org dropmail.me crazymailing.com`.split(/\s+/).filter(Boolean));
export const FREE_MAIL_DOMAINS = new Set(`gmail.com googlemail.com yahoo.com yahoo.co.uk yahoo.in ymail.com outlook.com hotmail.com hotmail.co.uk live.com msn.com icloud.com me.com mac.com aol.com
  proton.me protonmail.com pm.me gmx.com gmx.net mail.com zoho.com yandex.com yandex.ru rediffmail.com qq.com 163.com 126.com`.split(/\s+/).filter(Boolean));

export const canonicalEmail = (email: string) => {
  const [localRaw, domain] = email.trim().toLowerCase().split("@");
  let local = localRaw.split("+")[0];
  const d = domain === "googlemail.com" ? "gmail.com" : domain;
  if (d === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${d}`;
};
export const nameKey = (n: string) => n.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\b(llc|l\.l\.c|fze|fzco|fz-llc|ltd|limited|inc|co|company|trading|est|establishment|pvt|private|general|group|the)\b/g, " ").replace(/[^a-z0-9؀-ۿ]+/g, "");
export const licenceKey = (l: string) => l.toUpperCase().replace(/[^A-Z0-9]/g, "");
export function normalizePhone(input: string, country = config.kyc.phoneCountry): string {
  const raw = String(input ?? "").replace(/[\s().-]/g, "");
  let e = "";
  if (raw.startsWith("+")) e = raw; else if (raw.startsWith("00")) e = "+" + raw.slice(2);
  else if (country === "AE" && /^0\d{9}$/.test(raw)) e = "+971" + raw.slice(1); else if (country === "AE" && /^5\d{8}$/.test(raw)) e = "+971" + raw;
  if (!/^\+[1-9]\d{7,14}$/.test(e)) throw badRequest("Enter your mobile number with its country code, for example +971 50 123 4567.");
  if (e.startsWith("+971") && !/^\+9715\d{8}$/.test(e)) throw badRequest("A UAE number must be a mobile number (+971 5x xxx xxxx) so a code can be sent to it.");
  return e;
}

export { gateMessage };
export interface KycInput { phone: string; licenceNo: string; licenceAuthority: string; trn?: string; ip?: string }
export interface KycPrepared { phone: string; licenceNo: string; licenceKey: string; licenceAuthority: string; trn: string | null; ipHash: string | null; flags: { code: string; points: number; detail: string }[]; score: number }
const taken = () => badRequest("A workspace is already registered for this business identity. Sign in to it, or contact support if you believe this is a mistake.");

/** The checks that run when a company registers. Hard failures throw; softer signals are returned as flags with points for the reviewer. */
export async function prepareKyc(c: Conn, company: string, email: string, input: KycInput): Promise<KycPrepared> {
  const domain = email.split("@")[1];
  if (DISPOSABLE_DOMAINS.has(domain)) throw badRequest("Disposable email addresses cannot be used to register a company. Use your business email address.");
  const free = FREE_MAIL_DOMAINS.has(domain);
  if (free && !config.kyc.allowFreeMail) throw badRequest("Register with your business email address (at your company's own domain), not a personal mailbox.");
  const phone = normalizePhone(input.phone);
  const licenceNo = String(input.licenceNo ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ./-]{2,39}$/.test(licenceNo)) throw badRequest("Enter your trade licence number exactly as printed (3–40 letters, digits, spaces, dots, slashes or hyphens).");
  const authority = String(input.licenceAuthority ?? "").trim();
  if (authority.length < 2 || authority.length > 80) throw badRequest("Enter the authority that issued the licence (for example Dubai DET, ADDED, a free zone).");
  const trn = String(input.trn ?? "").replace(/\s/g, "") || null;
  if (trn && !/^\d{15}$/.test(trn)) throw badRequest("A tax registration number (TRN) has 15 digits.");
  const lk = licenceKey(licenceNo);
  if ((await c.query(`SELECT 1 FROM tenant_kyc WHERE licence_key=$1 AND lower(licence_authority)=lower($2)`, [lk, authority])).rows.length) throw taken();
  if (trn && (await c.query(`SELECT 1 FROM tenant_kyc WHERE trn_key=$1`, [trn])).rows.length) throw taken();
  if ((await c.query(`SELECT 1 FROM tenant_kyc WHERE phone_e164=$1`, [phone])).rows.length) throw taken();
  if ((await c.query(`SELECT 1 FROM tenant_kyc WHERE email_canonical=$1`, [canonicalEmail(email)])).rows.length) throw taken();
  const flags: KycPrepared["flags"] = [];
  const nk = nameKey(company);
  if (nk && (await c.query(`SELECT 1 FROM tenant_kyc WHERE name_key=$1`, [nk])).rows.length) flags.push({ code: "similar_company_name", points: 40, detail: "Another workspace is registered under the same company name with a different licence." });
  if (!free && (await c.query(`SELECT 1 FROM tenant_kyc WHERE email_domain=$1`, [domain])).rows.length) flags.push({ code: "domain_reuse", points: 25, detail: `Another workspace was registered with an @${domain} address.` });
  const ipHash = input.ip ? sha256(`${input.ip}:${config.sessionSecret}`) : null;
  if (ipHash && Number((await c.query<any>(`SELECT count(*) n FROM tenant_kyc WHERE signup_ip_hash=$1 AND created_at > now() - interval '24 hours'`, [ipHash])).rows[0].n) >= 1) flags.push({ code: "ip_repeat", points: 20, detail: "More than one registration from the same network address in 24 hours." });
  if (free) flags.push({ code: "free_mail", points: 20, detail: "Registered with a personal mailbox." });
  if (!trn) flags.push({ code: "no_trn", points: 5, detail: "No tax registration number given." });
  return { phone, licenceNo, licenceKey: lk, licenceAuthority: authority, trn, ipHash, flags, score: flags.reduce((a, f) => a + f.points, 0) };
}
export async function recordKyc(c: Conn, tenantId: string, userId: string, company: string, email: string, k: KycPrepared) {
  await c.query(`INSERT INTO tenant_kyc(tenant_id,owner_user_id,legal_name,name_key,licence_no,licence_key,licence_authority,trn,trn_key,phone_e164,email_canonical,email_domain,signup_ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12)`,
    [tenantId, userId, company, nameKey(company), k.licenceNo, k.licenceKey, k.licenceAuthority, k.trn, k.phone, canonicalEmail(email), email.split("@")[1], k.ipHash]);
  await c.query(`UPDATE tenants SET verification_status='unverified', risk_score=$2, risk_flags=$3 WHERE id=$1`, [tenantId, k.score, JSON.stringify(k.flags)]);
  await c.query(`UPDATE users SET email_verified_at=NULL WHERE id=$1`, [userId]);
  await event(c, tenantId, `user:${userId}`, "registered", { flags: k.flags.map((f) => f.code), score: k.score });
  await issueEmailVerification(c, userId);
}
async function event(c: Conn, tenantId: string, actor: string, kind: string, detail: Record<string, unknown> = {}) {
  await c.query(`INSERT INTO kyc_events(tenant_id,actor,kind,detail) VALUES ($1,$2,$3,$4)`, [tenantId, actor, kind, JSON.stringify(detail)]);
}

// ───────── email
export async function issueEmailVerification(c: Conn, userId: string) {
  const token = randomToken(32), hash = sha256(token);
  await c.query(`DELETE FROM email_verifications WHERE user_id=$1 AND consumed_at IS NULL`, [userId]);
  await c.query(`INSERT INTO email_verifications(token_hash,user_id,expires_at) VALUES ($1,$2, now() + interval '24 hours')`, [hash, userId]);
  await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES (NULL,'email',$1,$2)`, [`email-verification:${hash}`, JSON.stringify({ template: "email_verification", userId, tokenEncrypted: encryptSecret(token) })]);
}
export async function resendEmailVerification(db: Db, userId: string) {
  await rateLimit(`verify-email:${userId}`, 3, 3600, "Too many requests. Try again in an hour.");
  await db.system(async (c) => {
    if ((await c.query<any>(`SELECT email_verified_at FROM users WHERE id=$1`, [userId])).rows[0]?.email_verified_at) throw badRequest("Your email address is already confirmed.");
    await issueEmailVerification(c, userId);
  });
}
export async function verifyEmail(db: Db, token: string): Promise<{ tenantId: string | null }> {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new HttpError(410, "This confirmation link is invalid or has expired. Request a new one from your workspace.");
  return db.system(async (c) => {
    const r = (await c.query<any>(`UPDATE email_verifications SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING user_id`, [sha256(token)])).rows[0];
    if (!r) throw new HttpError(410, "This confirmation link is invalid or has expired. Request a new one from your workspace.");
    await c.query(`UPDATE users SET email_verified_at=coalesce(email_verified_at, now()) WHERE id=$1`, [r.user_id]);
    const k = (await c.query<any>(`SELECT tenant_id FROM tenant_kyc WHERE owner_user_id=$1`, [r.user_id])).rows[0];
    if (k) { await event(c, k.tenant_id, `user:${r.user_id}`, "email_verified"); await progress(c, k.tenant_id); }
    return { tenantId: k?.tenant_id ?? null };
  });
}

// ───────── mobile number
const OTP_TTL_MIN = 10, OTP_MAX_ATTEMPTS = 5;
export async function sendPhoneCode(db: Db, tenantId: string) {
  await rateLimit(`kyc-otp:${tenantId}`, 5, 3600, "Too many codes requested. Try again in an hour.");
  await db.system(async (c) => {
    const k = (await c.query<any>(`SELECT phone_e164, phone_verified_at FROM tenant_kyc WHERE tenant_id=$1`, [tenantId])).rows[0];
    if (!k) throw badRequest("This workspace has no verification record.");
    if (k.phone_verified_at) throw badRequest("Your mobile number is already confirmed.");
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    await c.query(`UPDATE phone_codes SET consumed_at=now() WHERE tenant_id=$1 AND consumed_at IS NULL`, [tenantId]);
    const id = (await c.query<any>(`INSERT INTO phone_codes(tenant_id,code_hash,expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval) RETURNING id`, [tenantId, sha256(`${tenantId}:${code}`), String(OTP_TTL_MIN)])).rows[0].id;
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'kyc.sms',$2,$3)`, [tenantId, `kyc-sms:${id}`, JSON.stringify({ phoneEncrypted: encryptSecret(k.phone_e164), codeEncrypted: encryptSecret(code) })]);
    await event(c, tenantId, "system", "phone_code_sent", { last4: k.phone_e164.slice(-4) });
  });
}
export async function verifyPhoneCode(db: Db, tenantId: string, code: string) {
  const clean = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) throw badRequest("Enter the 6-digit code.");
  // A wrong guess must be COUNTED even though the request fails, so the outcome is decided inside the transaction and the error is raised after it commits.
  const problem = await db.system(async (c): Promise<string | null> => {
    const row = (await c.query<any>(`SELECT * FROM phone_codes WHERE tenant_id=$1 AND consumed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE`, [tenantId])).rows[0];
    if (!row || new Date(row.expires_at).getTime() < Date.now()) return "That code has expired. Request a new one.";
    if (row.attempts >= OTP_MAX_ATTEMPTS) { await c.query(`UPDATE phone_codes SET consumed_at=now() WHERE id=$1`, [row.id]); return "Too many wrong codes. Request a new one."; }
    if (sha256(`${tenantId}:${clean}`) !== row.code_hash) { await c.query(`UPDATE phone_codes SET attempts=attempts+1 WHERE id=$1`, [row.id]); return "That code is not right."; }
    await c.query(`UPDATE phone_codes SET consumed_at=now() WHERE id=$1`, [row.id]);
    await c.query(`UPDATE tenant_kyc SET phone_verified_at=now() WHERE tenant_id=$1 AND phone_verified_at IS NULL`, [tenantId]);
    await event(c, tenantId, "system", "phone_verified");
    await progress(c, tenantId);
    return null;
  });
  if (problem) throw badRequest(problem);
}

// ───────── trade licence
export async function submitLicence(db: Db, ctx: Ctx, f: { filename: string; data: Buffer }, scan: Scanner = basicScan) {
  if (!/\.(pdf|png|jpe?g)$/i.test(f.filename)) throw badRequest("Upload the licence as a PDF, PNG or JPEG.");
  const st = (await db.query<any>(`SELECT t.verification_status FROM tenants t WHERE t.id=$1`, [ctx.tenantId])).rows[0];
  if (!st || !["unverified", "in_review"].includes(st.verification_status)) throw badRequest("This workspace is not waiting for documents.");
  const docId = await db.tenant(ctx.tenantId, async (c) => {
    const owner = { ...ctx, perms: permsFor(["owner"]) };
    return String(await storeDocument(c, owner, { kind: "other", title: "Trade licence (verification)", filename: f.filename, data: f.data }, scan, { skipVerification: true }));
  });
  await db.system(async (c) => {
    await c.query(`UPDATE tenant_kyc SET licence_document_id=$2, licence_uploaded_at=now() WHERE tenant_id=$1`, [ctx.tenantId, docId]);
    await event(c, ctx.tenantId, `user:${ctx.userId}`, "licence_uploaded", { document: docId });
    await progress(c, ctx.tenantId);
  });
}

/** When email, mobile and licence are all in, the workspace moves to staff review. */
async function progress(c: Conn, tenantId: string) {
  const r = (await c.query<any>(
    `SELECT t.verification_status, k.phone_verified_at, k.licence_document_id, u.email_verified_at FROM tenants t JOIN tenant_kyc k ON k.tenant_id=t.id JOIN users u ON u.id=k.owner_user_id WHERE t.id=$1`, [tenantId])).rows[0];
  if (!r || r.verification_status !== "unverified" || !r.phone_verified_at || !r.licence_document_id || !r.email_verified_at) return;
  await c.query(`UPDATE tenants SET verification_status='in_review' WHERE id=$1`, [tenantId]);
  await event(c, tenantId, "system", "submitted_for_review");
}

export async function kycState(db: Db, tenantId: string) {
  const r = (await db.query<any>(
    `SELECT t.verification_status AS status, t.verification_note AS note, k.phone_e164, k.phone_verified_at, k.licence_document_id, k.licence_uploaded_at, u.email, u.email_verified_at
       FROM tenants t LEFT JOIN tenant_kyc k ON k.tenant_id=t.id LEFT JOIN users u ON u.id=k.owner_user_id WHERE t.id=$1`, [tenantId])).rows[0];
  return r ? { status: r.status as string, note: r.note as string | null, email: r.email as string | null, emailOk: !!r.email_verified_at, phone: r.phone_e164 ? `${String(r.phone_e164).slice(0, 4)}•••••${String(r.phone_e164).slice(-3)}` : null, phoneOk: !!r.phone_verified_at, licenceOk: !!r.licence_document_id, hasRecord: !!r.phone_e164 } : null;
}
// ───────── staff review
export async function listKycQueue(db: Db, status: string[] = ["in_review", "unverified", "rejected"]) {
  return (await db.query<any>(
    `SELECT t.id, t.name, t.slug, t.verification_status AS status, t.risk_score, t.risk_flags, t.created_at, k.licence_no, k.licence_authority, k.phone_verified_at, k.licence_document_id, u.email, u.email_verified_at,
       (SELECT p.plan_code FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id WHERE s.tenant_id=t.id) AS plan
       FROM tenants t JOIN tenant_kyc k ON k.tenant_id=t.id JOIN users u ON u.id=k.owner_user_id WHERE t.verification_status = ANY($1::text[])
       ORDER BY (t.verification_status='in_review') DESC, t.risk_score DESC, t.created_at LIMIT 300`, [status])).rows;
}
export async function kycDetail(db: Db, tenantId: string) {
  const t = (await db.query<any>(`SELECT t.*, k.*, u.email, u.name AS owner_name, u.email_verified_at FROM tenants t JOIN tenant_kyc k ON k.tenant_id=t.id JOIN users u ON u.id=k.owner_user_id WHERE t.id=$1`, [tenantId])).rows[0];
  if (!t) throw new HttpError(404, "No verification record.", "not_found");
  const same = (await db.query<any>(
    `SELECT t2.id, t2.name, t2.verification_status AS status, k2.licence_no FROM tenant_kyc k2 JOIN tenants t2 ON t2.id=k2.tenant_id
      WHERE t2.id<>$1 AND (k2.name_key=$2 OR (k2.email_domain=$3 AND $3 <> ALL($4::text[])) OR (k2.signup_ip_hash IS NOT NULL AND k2.signup_ip_hash=$5)) LIMIT 20`, [tenantId, t.name_key, t.email_domain, [...FREE_MAIL_DOMAINS], t.signup_ip_hash])).rows;
  const events = (await db.query<any>(`SELECT * FROM kyc_events WHERE tenant_id=$1 ORDER BY id`, [tenantId])).rows;
  return { t, related: same, events };
}
export async function decideKyc(db: Db, staff: { userId: string; role: string }, tenantId: string, decision: "approve" | "reject" | "reopen", note: string) {
  if (!["commercial_admin", "auditor"].includes(staff.role)) throw new HttpError(403, "Only authorised reviewers can decide company verification.");
  const why = String(note ?? "").trim();
  if (why.length < 5 || why.length > 500) throw badRequest("Give a reason of 5–500 characters.");
  await db.system(async (c) => {
    const t = (await c.query<any>(`SELECT verification_status FROM tenants WHERE id=$1 FOR UPDATE`, [tenantId])).rows[0];
    if (!t) throw new HttpError(404, "Workspace not found.", "not_found");
    const from = t.verification_status as string;
    const to = decision === "approve" ? "verified" : decision === "reject" ? "rejected" : "in_review";
    if (decision === "approve" && from !== "in_review") throw badRequest("Only a workspace in review can be approved: email, mobile and licence must all be done first.");
    if (decision === "reject" && !["in_review", "unverified"].includes(from)) throw badRequest("Only a workspace that is not yet verified can be rejected.");
    if (decision === "reopen" && from !== "rejected") throw badRequest("Only a rejected workspace can be reopened.");
    if (decision === "approve") {
      const evidence = (await c.query<any>(`SELECT u.email_verified_at, k.phone_verified_at, d.id AS licence
        FROM tenant_kyc k JOIN users u ON u.id=k.owner_user_id
        LEFT JOIN documents d ON d.id=k.licence_document_id AND d.tenant_id=k.tenant_id AND NOT d.hold
        WHERE k.tenant_id=$1`, [tenantId])).rows[0];
      if (!evidence?.email_verified_at || !evidence.phone_verified_at || !evidence.licence)
        throw badRequest("Email, mobile and an available trade licence must all be verified before approval.");
    }
    await c.query(`UPDATE tenants SET verification_status=$2, verification_note=$3, verification_decided_by=$4, verification_decided_at=now() WHERE id=$1`, [tenantId, to, why, staff.userId]);
    await event(c, tenantId, `staff:${staff.userId}`, `decision_${decision}`, { from, to, note: why });
    await audit(c, tenantId, { kind: "platform_staff", userId: staff.userId }, `kyc.${decision}`, "tenant", tenantId, { from, to });
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email',$2,$3)`, [tenantId, `kyc-decision:${tenantId}:${Date.now()}`, JSON.stringify({ template: "kyc_decision", decision: to, note: why })]);
  });
}
