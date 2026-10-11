import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, payFor } from "./helpers.js";
import { PermanentMailError, mailHandlers, resendMailer, templates, type MailMessage, type Mailer } from "../src/adapters/mail.js";
import { drainOutbox } from "../src/platform/outbox.js";
import { invite } from "../src/ops/team.js";
import { validateConfig, config } from "../src/config.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const capture = () => { const sent: MailMessage[] = []; const m: Mailer = { async send(x) { sent.push(x); return { id: `msg_${sent.length}` }; } }; return { sent, m }; };
const drain = async (m: Mailer) => { await db.query(`UPDATE outbox SET next_at=now() WHERE topic='email' AND status='pending'`); return drainOutbox(db, mailHandlers(db, m)); };

describe("transactional email", () => {
  it("sends the invitation with its link, then removes the link from the database", async () => {
    const t = await newTenant(db);
    const token = await db.tenant(t.tenantId, (c) => invite(c, t.ctx, { email: "New.Person@Example.com", roles: ["sales"] }));
    const before = (await db.query<any>(`SELECT payload FROM outbox WHERE topic='email' AND tenant_id=$1 ORDER BY created_at DESC LIMIT 1`, [t.tenantId])).rows[0].payload;
    expect(before.link).toBeUndefined();   // the raw token is never queued in clear: only its encrypted form
    expect(JSON.stringify(before)).not.toContain(token);expect(before.tokenEncrypted).toBeTruthy();
    const { sent, m } = capture();
    await drain(m);
    const msg = sent.find((x) => x.to === "new.person@example.com")!;
    expect(msg.subject).toMatch(/invited/); expect(msg.text).toContain(`/invite/${token}`); expect(msg.html).toContain(`/invite/${token}`);
    const after = (await db.query<any>(`SELECT payload, status FROM outbox WHERE key LIKE 'invite:%' AND tenant_id=$1`, [t.tenantId])).rows[0];
    expect(after.status).toBe("sent");
    expect(JSON.stringify(after.payload)).not.toContain(token);                                      // a one-time credential does not stay readable
  });

  it("emails the payer when a payment arrives and the owners when the workspace is ready; each is sent once", async () => {
    const t = await newTenant(db);
    await payFor(db, t);
    await db.system((c) => c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email','ready:test-1',$2)`, [t.tenantId, JSON.stringify({ template: "workspace_ready" })]));
    const { sent, m } = capture();
    await drain(m); await drain(m);
    const subjects = sent.map((x) => x.subject);
    expect(subjects.filter((s) => /^Payment received · LBT-/.test(s))).toHaveLength(1);
    expect(subjects.filter((s) => s === "Your workspace is ready")).toHaveLength(1);
    expect(sent.every((x) => /^[^\s@]+@[^\s@]+$/.test(x.to))).toBe(true);
  });

  it("an unknown template or a missing recipient goes straight to the staff-visible dead queue; a transient provider error is retried", async () => {
    const t = await newTenant(db);
    await db.system(async (c) => {
      await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email','bad-tpl',$2),($1,'email','no-rcpt',$3),($1,'email','flaky',$4)`,
        [t.tenantId, JSON.stringify({ template: "nope" }), JSON.stringify({ template: "invitation", email: "" }), JSON.stringify({ template: "invitation", email: "a@b.co", link: "https://x/invite/t" })]);
    });
    let calls = 0;
    const flaky: Mailer = { async send() { if (++calls === 1) throw new Error("mail provider 503"); return { id: "ok" }; } };
    await drain(flaky);
    const st = async (k: string) => (await db.query<any>(`SELECT status, attempts FROM outbox WHERE key=$1`, [k])).rows[0];
    expect(await st("bad-tpl")).toMatchObject({ status: "dead", attempts: 1 });
    expect(await st("no-rcpt")).toMatchObject({ status: "dead", attempts: 1 });
    expect(await st("flaky")).toMatchObject({ status: "pending", attempts: 1 });
    await drain(flaky);
    expect(await st("flaky")).toMatchObject({ status: "sent" });
  });

  it("the Resend adapter posts the message with the key and classifies failures", async () => {
    const calls: any[] = [];
    const mk = (status: number, body: unknown) => resendMailer({ provider: "resend", resendApiKey: "re_key", from: "LBT <noreply@x.com>", apiBase: "https://api.resend.test" }, (async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); }) as any);
    const msg = { to: "a@b.co", subject: "S", text: "T", html: "<p>H</p>" };
    expect(await mk(200, { id: "em_1" }).send(msg)).toEqual({ id: "em_1" });
    expect(calls[0].url).toBe("https://api.resend.test/emails");
    expect(calls[0].init.headers.authorization).toBe("Bearer re_key");
    expect(JSON.parse(calls[0].init.body)).toEqual({ from: "LBT <noreply@x.com>", to: ["a@b.co"], subject: "S", text: "T", html: "<p>H</p>" });
    await expect(mk(503, {}).send(msg)).rejects.not.toBeInstanceOf(PermanentMailError);
    await expect(mk(429, {}).send(msg)).rejects.not.toBeInstanceOf(PermanentMailError);
    await expect(mk(422, { message: "domain not verified" }).send(msg)).rejects.toBeInstanceOf(PermanentMailError);
  });

  it("templates escape their inputs and validate configuration", () => {
    const evil = templates.invitation({ link: 'https://x/"><script>alert(1)</script>' });
    expect(evil.html).not.toContain("<script>");
    expect(() => validateConfig({ ...config, mail: { ...config.mail, provider: "resend", resendApiKey: "", from: "" } } as any, false)).toThrow(/RESEND_API_KEY/);
    expect(() => validateConfig({ ...config, mail: { ...config.mail, provider: "smtp" } } as any, false)).toThrow(/MAIL_PROVIDER/);
    expect(() => validateConfig({ ...config, mail: { ...config.mail, provider: "resend", resendApiKey: "re_x", from: "LBT <noreply@x.com>" } } as any, false)).not.toThrow();
  });
});

describe("retry budgets", () => {
  it("merchant webhooks and email keep trying longer than the default before dead-lettering", async () => {
    const { MAX_ATTEMPTS } = await import("../src/platform/outbox.js");
    expect(MAX_ATTEMPTS["merchant.webhook"]).toBe(12); expect(MAX_ATTEMPTS.email).toBe(8);
    const t = await newTenant(db);
    await db.system((c) => c.query(`INSERT INTO outbox(tenant_id,topic,key,payload,attempts) VALUES ($1,'merchant.webhook','retry-budget',$2,6)`, [t.tenantId, JSON.stringify({ merchant_id: t.tenantId, type: "ping", data: {} })]));
    await db.query(`UPDATE outbox SET next_at=now() WHERE key='retry-budget'`);
    await drainOutbox(db, { "merchant.webhook": async () => { throw new Error("endpoint down"); } });
    expect((await db.query<any>(`SELECT status, attempts FROM outbox WHERE key='retry-budget'`)).rows[0]).toEqual({ status: "pending", attempts: 7 });   // the default budget of 6 would have given up here
  });
});
