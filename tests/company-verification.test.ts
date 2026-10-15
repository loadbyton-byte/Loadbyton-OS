import { describe, it, expect, beforeAll, afterEach } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { decryptSecret } from "../src/lib/encryption.js";
import { ctxFor } from "./helpers.js";
import { freshDb } from "./helpers.js";
import { registerCompany } from "../src/platform/tenants.js";
import { canonicalEmail, decideKyc, kycState, nameKey, normalizePhone, resendEmailVerification, sendPhoneCode, submitLicence, verifyEmail, verifyPhoneCode } from "../src/platform/kyc.js";
import { createParty } from "../src/ops/crm.js";
import { resetThrottle } from "../src/platform/auth.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });
const saved = { ...config.kyc };
afterEach(() => { Object.assign(config.kyc, saved); });
const on = () => { config.kyc.required = true; };
let n = 0;
const reg = (over: Record<string, any> = {}, kyc: Record<string, any> = {}) => {
  const i = ++n;
  return registerCompany(db, { company: `Gulf Haulage ${i} LLC`, contactName: "Owner", email: `owner${i}-${Date.now()}@gulfhaulage${i}.ae`, password: "correct horse battery", sectors: ["freight-forwarding"],
    kyc: { phone: `+97150${String(1000000 + i)}`, licenceNo: `CN-${100000 + i}`, licenceAuthority: "Dubai DET", ...kyc }, ...over });
};
const lastEmailToken = async (userId: string) => decryptSecret((await db.query<any>(`SELECT payload FROM outbox WHERE topic='email' AND payload->>'userId'=$1 AND payload->>'template'='email_verification' ORDER BY created_at DESC, id DESC LIMIT 1`, [userId])).rows[0].payload.tokenEncrypted);
const lastCode = async (tenantId: string) => decryptSecret((await db.query<any>(`SELECT payload FROM outbox WHERE topic='kyc.sms' AND tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, [tenantId])).rows[0].payload.codeEncrypted);
const pdf = Buffer.from("%PDF-1.4 trade licence");
const staff = async () => ({ userId: (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'Staff','x') RETURNING id`, [`staff-${++n}-${Date.now()}@example.com`]))).rows[0].id as string, role: "commercial_admin" });

describe("identity normalisation", () => {
  it("collapses email aliases, company-name noise and phone formats", () => {
    expect(canonicalEmail("A.B+promo@Gmail.com")).toBe("ab@gmail.com"); expect(canonicalEmail("a.b@googlemail.com")).toBe("ab@gmail.com"); expect(canonicalEmail("x+1@acme.ae")).toBe("x@acme.ae");
    expect(nameKey("The Gulf Haulage L.L.C")).toBe(nameKey("GULF  HAULAGE llc")); expect(nameKey("Gulf Haulage")).not.toBe(nameKey("Gulf Freight"));
    expect(normalizePhone("050 123 4567")).toBe("+971501234567"); expect(normalizePhone("00971501234567")).toBe("+971501234567"); expect(normalizePhone("501234567")).toBe("+971501234567");
    expect(() => normalizePhone("04 123 4567")).toThrow(/country code|mobile/); expect(() => normalizePhone("+97141234567")).toThrow(/mobile/); expect(() => normalizePhone("abc")).toThrow(/country code/);
  });
});

describe("company verification at registration", () => {
  it("refuses disposable and personal mailboxes, bad identities, and anything missing when verification is required", async () => {
    on();
    await expect(reg({ email: "x@mailinator.com" })).rejects.toThrow(/Disposable/);
    await expect(reg({ email: "boss@gmail.com" })).rejects.toThrow(/business email/);
    await expect(reg({}, { phone: "123" })).rejects.toThrow(/country code/);
    await expect(reg({}, { licenceNo: "!" })).rejects.toThrow(/trade licence number/);
    await expect(reg({}, { licenceAuthority: "" })).rejects.toThrow(/authority/);
    await expect(reg({}, { trn: "12345" })).rejects.toThrow(/15 digits/);
    await expect(registerCompany(db, { company: "NoKyc LLC", contactName: "O", email: `nk${Date.now()}@nokyc.ae`, password: "correct horse battery" })).rejects.toThrow(/needs your mobile number/);
    config.kyc.allowFreeMail = true;
    const r = await reg({ email: `free${Date.now()}@gmail.com` });
    expect((await db.query<any>(`SELECT risk_flags FROM tenants WHERE id=$1`, [r.tenantId])).rows[0].risk_flags.map((f: any) => f.code)).toContain("free_mail");
  });

  it("allows one workspace per licence, tax number, mobile number and mailbox — even after rejection, and through email aliases", async () => {
    on();
    const first = await reg({}, { trn: "100123456789012" });
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [first.userId])).rows[0].email as string;
    const k = (await db.query<any>(`SELECT licence_no, licence_authority, phone_e164 FROM tenant_kyc WHERE tenant_id=$1`, [first.tenantId])).rows[0];
    await expect(reg({}, { licenceNo: k.licence_no.toLowerCase().replace("-", " "), licenceAuthority: "dubai det" })).rejects.toThrow(/already registered/);     // same licence typed differently
    await expect(reg({}, { trn: "100123456789012" })).rejects.toThrow(/already registered/);
    await expect(reg({}, { phone: k.phone_e164 })).rejects.toThrow(/already registered/);
    const [local, domain] = email.split("@");
    await expect(reg({ email: `${local}+second@${domain}` })).rejects.toThrow(/already registered/);                                                                   // plus-alias of the same mailbox
    // rejection keeps the identity reserved
    const s = await staff();
    await decideKyc(db, s, first.tenantId, "reject", "Licence does not match the company");
    await expect(reg({}, { licenceNo: k.licence_no, licenceAuthority: k.licence_authority })).rejects.toThrow(/already registered/);
    // a different licence at the same licensing authority is fine
    await expect(reg()).resolves.toBeTruthy();
  });

  it("flags look-alike names, reused domains and repeated networks for the reviewer instead of blocking", async () => {
    on();
    const a = await reg({ company: "Blue Sea Logistics LLC" }, {});
    const dom = (await db.query<any>(`SELECT email_domain FROM tenant_kyc WHERE tenant_id=$1`, [a.tenantId])).rows[0].email_domain;
    const b = await reg({ company: "Blue Sea Logistics", email: `second${Date.now()}@${dom}` }, { ip: "203.0.113.9" });
    const c = await reg({}, { ip: "203.0.113.9" });
    const codes = async (id: string) => (await db.query<any>(`SELECT risk_flags, risk_score FROM tenants WHERE id=$1`, [id])).rows[0];
    expect((await codes(b.tenantId)).risk_flags.map((f: any) => f.code)).toEqual(expect.arrayContaining(["similar_company_name", "domain_reuse", "no_trn"]));
    expect((await codes(c.tenantId)).risk_flags.map((f: any) => f.code)).toContain("ip_repeat");
    expect((await codes(b.tenantId)).risk_score).toBeGreaterThan(60);
  });
});

describe("the read-only gate and the verification steps", () => {
  it("blocks writes until email, mobile and licence are in, then waits for staff, then opens", async () => {
    on();
    const r = await reg();
    const ctx = ctxFor(r.userId, r.tenantId);
    await expect(db.tenant(r.tenantId, (c) => createParty(c, ctx, { kind: "customer", name: "First customer" }))).rejects.toMatchObject({ status: 403, code: "unverified" });
    expect((await kycState(db, r.tenantId))).toMatchObject({ status: "unverified", emailOk: false, phoneOk: false, licenceOk: false });

    // email
    await expect(verifyEmail(db, "x".repeat(43))).rejects.toMatchObject({ status: 410 });
    const token = await lastEmailToken(r.userId);
    await verifyEmail(db, token);
    await expect(verifyEmail(db, token)).rejects.toMatchObject({ status: 410 });                      // single use
    await expect(resendEmailVerification(db, r.userId)).rejects.toThrow(/already confirmed/);
    // mobile
    await expect(verifyPhoneCode(db, r.tenantId, "123456")).rejects.toThrow(/expired|not right/);
    await sendPhoneCode(db, r.tenantId);
    const code = await lastCode(r.tenantId);
    const wrong = code === "000000" ? "111111" : "000000";
    await expect(verifyPhoneCode(db, r.tenantId, wrong)).rejects.toThrow(/not right/);
    await verifyPhoneCode(db, r.tenantId, code);
    await expect(verifyPhoneCode(db, r.tenantId, code)).rejects.toThrow(/expired/);                   // code is spent
    expect((await kycState(db, r.tenantId))).toMatchObject({ emailOk: true, phoneOk: true, licenceOk: false, status: "unverified" });
    // licence
    await expect(submitLicence(db, ctx, { filename: "licence.exe", data: pdf })).rejects.toThrow(/PDF, PNG or JPEG/);
    await expect(submitLicence(db, ctx, { filename: "licence.pdf", data: Buffer.from("not a pdf") })).rejects.toThrow(/does not match/);
    await submitLicence(db, ctx, { filename: "licence.pdf", data: pdf });
    expect((await kycState(db, r.tenantId))).toMatchObject({ status: "in_review", licenceOk: true });
    await expect(db.tenant(r.tenantId, (c) => createParty(c, ctx, { kind: "customer", name: "Still blocked" }))).rejects.toMatchObject({ code: "unverified" });

    // staff
    const s = await staff();
    await expect(decideKyc(db, s, r.tenantId, "approve", "ok")).rejects.toThrow(/5–500/);
    await decideKyc(db, s, r.tenantId, "approve", "Licence checked against the Dubai DET register");
    expect((await kycState(db, r.tenantId))).toMatchObject({ status: "verified" });
    await expect(db.tenant(r.tenantId, (c) => createParty(c, ctx, { kind: "customer", name: "Now allowed" }))).resolves.toBeTruthy();
    await expect(decideKyc(db, s, r.tenantId, "approve", "Approved twice")).rejects.toThrow(/in review/);
    const log = (await db.query<any>(`SELECT kind FROM kyc_events WHERE tenant_id=$1 ORDER BY id`, [r.tenantId])).rows.map((e: any) => e.kind);
    expect(log).toEqual(["registered", "email_verified", "phone_code_sent", "phone_verified", "licence_uploaded", "submitted_for_review", "decision_approve"]);
    await expect(db.system((c) => c.query(`DELETE FROM kyc_events`))).rejects.toThrow();
  });

  it("limits code attempts, cannot approve an incomplete workspace, and lets staff reject and reopen", async () => {
    on();
    const r = await reg();
    const s = await staff();
    await expect(decideKyc(db, s, r.tenantId, "approve", "Looks fine to me")).rejects.toThrow(/in review/);
    await sendPhoneCode(db, r.tenantId);
    const code = await lastCode(r.tenantId), wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(verifyPhoneCode(db, r.tenantId, wrong)).rejects.toThrow(/not right/);
    await expect(verifyPhoneCode(db, r.tenantId, code)).rejects.toThrow(/Too many wrong codes/);
    await decideKyc(db, s, r.tenantId, "reject", "Details do not match any licence on the register");
    expect((await kycState(db, r.tenantId))).toMatchObject({ status: "rejected" });
    await expect(sendPhoneCode(db, r.tenantId)).resolves.toBeUndefined();                                 // allowed, but the workspace stays read-only
    await decideKyc(db, s, r.tenantId, "reopen", "Owner sent a corrected licence by email");
    expect((await kycState(db, r.tenantId))).toMatchObject({ status: "in_review" });
  });

  it("keeps verification off for installations that do not require it, and existing workspaces stay open", async () => {
    config.kyc.required = false;
    const r = await registerCompany(db, { company: "Legacy Co", contactName: "O", email: `legacy${Date.now()}@legacy.ae`, password: "correct horse battery" });
    expect((await kycState(db, r.tenantId))).toMatchObject({ status: "verified", hasRecord: false });
    await expect(db.tenant(r.tenantId, (c) => createParty(c, ctxFor(r.userId, r.tenantId), { kind: "customer", name: "Fine" }))).resolves.toBeTruthy();
  });
});

describe("over HTTP", () => {
  class Browser {
    jar = new Map<string, string>();
    private ch() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
    async req(path: string, init: RequestInit = {}) {
      const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie: this.ch() } });
      for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); }
      return res;
    }
    async post(path: string, fields: Record<string, string>) {
      await this.req("/login");
      const body = new URLSearchParams({ _csrf: this.jar.get("lbt_csrf")!, ...fields });
      return this.req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    }
    async upload(path: string, file: File) {
      await this.req("/login");
      const fd = new FormData(); fd.set("_csrf", this.jar.get("lbt_csrf")!); fd.set("file", file);
      return this.req(path, { method: "POST", body: fd });
    }
  }
  it("signs up with identity details, sees only the checklist, and completes it through the forms", async () => {
    on(); resetThrottle();
    const b = new Browser();
    const i = ++n, email = `http${i}-${Date.now()}@httpco${i}.ae`;
    const bad = await b.post("/start", { company: "HTTP Co", contact: "O", email, password: "correct horse battery", sector: "freight-forwarding", country: "AE", emirate: "Dubai", goal: "Just exploring", phone: "", licence: "", authority: "" });
    expect(bad.headers.get("location")).toMatch(/err=.*mobile%20number/);
    const ok = await b.post("/start", { company: "HTTP Co", contact: "O", email, password: "correct horse battery", sector: "freight-forwarding", country: "AE", emirate: "Dubai", goal: "Just exploring", phone: `050 ${2000000 + i}`, licence: `HTTP-${900000 + i}`, authority: "Dubai DET" });
    expect(ok.headers.get("location")).toMatch(/^\/app\/verify/);
    expect((await b.req("/app")).headers.get("location")).toBe("/app/verify");                       // home goes to the checklist
    const page = await (await b.req("/app/verify")).text();
    expect(page).toContain("Verify your company"); expect(page).toContain("Company not verified yet");
    const write = await b.post("/app/parties", { kind: "customer", name: "Blocked" });
    expect(write.headers.get("location")).toMatch(/^\/app\/verify\?err=/);                            // writes anywhere are bounced
    const user = (await db.query<any>(`SELECT id FROM users WHERE email=$1`, [email])).rows[0].id, tenant = (await db.query<any>(`SELECT tenant_id FROM memberships WHERE user_id=$1`, [user])).rows[0].tenant_id;
    expect((await b.req(`/verify-email?token=${encodeURIComponent(await lastEmailToken(user))}`)).headers.get("location")!).toMatch(/\/app\/verify\?ok=/);
    expect((await b.post("/app/verify/phone/send", {})).headers.get("location")).toMatch(/ok=/);
    expect((await b.post("/app/verify/phone/check", { code: await lastCode(tenant) })).headers.get("location")).toMatch(/ok=.*confirmed/);
    expect((await b.upload("/app/verify/licence", new File([pdf], "licence.pdf", { type: "application/pdf" }))).headers.get("location")).toMatch(/ok=/);
    expect((await kycState(db, tenant))!.status).toBe("in_review");
    expect(await (await b.req("/app/verify")).text()).toContain("Everything is submitted");
  });
});
