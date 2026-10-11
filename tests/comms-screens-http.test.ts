import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { convertedJob } from "./helpers.js";
import { uploadDocument } from "../src/ops/documents.js";
import { signRelay } from "../src/ops/inbound.js";
import { resetThrottle } from "../src/platform/auth.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });

class Browser {
  jar = new Map<string, string>();
  private cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(path: string, init: RequestInit = {}) {
    const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie: this.cookieHeader() } });
    for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  }
  get(path: string) { return this.req(path); }
  async csrf() { await this.get("/login"); return this.jar.get("lbt_csrf")!; }
  async post(path: string, fields: Record<string, string | string[]>, withCsrf = true) {
    const body = new URLSearchParams();
    if (withCsrf) body.set("_csrf", await this.csrf());
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return this.req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  async upload(path: string, fields: Record<string, string>, file: { name: string; text: string }) {
    const fd = new FormData();
    fd.set("_csrf", await this.csrf());
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("file", new File([file.text], file.name, { type: "text/csv" }));
    return this.req(path, { method: "POST", body: fd });
  }
  async login(email: string, password: string) { return this.post("/login", { email, password }); }
  async page(path: string) { const r = await this.get(path); return { status: r.status, html: await r.text(), location: r.headers.get("location") }; }
}

const flash = (loc: string | null) => decodeURIComponent(new URL(loc!, "http://x").searchParams.get("ok") ?? new URL(loc!, "http://x").searchParams.get("err") ?? "");

describe("Communications and AI screens", () => {
  it("channels, triage, sender verification, extraction, template versions and report notes work over HTTP", async () => {
    resetThrottle();
    const t = await newTenant(db);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const party = await db.tenant(t.tenantId, (c) => createParty(c, t.ctx, { kind: "customer", name: "Screen Buyer", email: "known@buyer.test" }));
    const j = await convertedJob(db, t);
    const b = new Browser();
    expect((await b.login(email, "correct horse battery")).status).toBe(302);
    for (const p of ["/app/inbox-channels", "/app/inbox-unmatched", "/app/extractions", "/app/document-drafts/versions", "/app/management-reports", "/app/assistant"]) expect((await b.page(p)).status, p).toBe(200);

    // create a channel; the secret URL appears once on the response page
    const created = await b.post("/app/inbox-channels", { kind: "email", label: "Screen mailbox", sla_minutes: "60" });
    expect(created.status).toBe(200);
    const html = await created.text();
    const url = /(https?:\/\/[^<\s]*\/webhooks\/inbound\/[A-Za-z0-9_-]+)/.exec(html)![1];
    const secret = /Signing secret<\/strong><br\/?><code>([^<]+)</.exec(html)![1];
    expect((await b.page("/app/inbox-channels")).html).not.toContain(secret);

    const send = async (payload: object) => { const raw = JSON.stringify(payload); return app.request(new URL(url).pathname, { method: "POST", body: raw, headers: { "x-lbt-signature": signRelay(secret, raw) } }); };
    await send({ message_id: "<h1@x>", from: "known@buyer.test", subject: "Where is it", text: "Status please" });
    await send({ message_id: "<h2@x>", from: "unknown@else.test", subject: "Need a quote", text: "Hello" });
    const q = await b.page("/app/inbox-unmatched");
    expect(q.html).toContain("Need a quote");
    const evId = (await db.query<any>(`SELECT id FROM inbound_events WHERE tenant_id=$1 AND status='unmatched'`, [t.tenantId])).rows[0].id;
    const r = await b.post(`/app/inbox-unmatched/${evId}/resolve`, { party_id: party });
    expect(flash(r.headers.get("location"))).toMatch(/Linked/);

    // the matched conversation is unassigned and unverified; take it, verify the sender
    const conv = (await db.query<any>(`SELECT id FROM conversations WHERE tenant_id=$1 AND subject='Where is it'`, [t.tenantId])).rows[0].id;
    let page = await b.page(`/app/inbox/${conv}`);
    expect(page.html).toContain("Sender and consent"); expect(page.html).toContain("Take this conversation");
    expect(flash((await b.post(`/app/inbox/${conv}/claim`, {})).headers.get("location"))).toMatch(/now own/);
    expect(flash((await b.post(`/app/inbox/${conv}/verify`, { party_id: party, address: "email|known@buyer.test", method: "Called back", note: "Confirmed contact" })).headers.get("location"))).toMatch(/verified/);
    expect((await b.page(`/app/inbox/${conv}`)).html).toContain("verified");
    expect(flash((await b.post(`/app/inbox/${conv}/consent`, { party_id: party, channel: "email", status: "opt_in", source: "form" })).headers.get("location"))).toMatch(/Evidence of consent/);

    // extraction
    const docId = await db.tenant(t.tenantId, (c) => uploadDocument(c, t.ctx, { kind: "other", title: "Booking AWB", issuer: "Airline", filename: "awb.txt", data: Buffer.from("AWB No: 176-12345675\nGross weight: 55 kg"), job_id: j.jobId } as any));
    let rr = await b.post("/app/extractions/run", { document_id: docId });
    expect(flash(rr.headers.get("location"))).toMatch(/ready for review/);
    const xid = rr.headers.get("location")!.split("/").pop()!.split("?")[0];
    expect((await b.page(`/app/extractions/${xid}`)).html).toContain("176-12345675");
    expect(flash((await b.post(`/app/extractions/${xid}/decide`, { decision: "accept" })).headers.get("location"))).toMatch(/Decision recorded/);
    expect((await b.page(`/app/extractions/${xid}`)).html).toContain("Fill job references");
    expect(flash((await b.post(`/app/extractions/${xid}/apply`, { job_id: j.jobId, key: "awb_number" })).headers.get("location"))).toMatch(/updated/);
    expect((await db.query<any>(`SELECT master_ref FROM jobs WHERE id=$1`, [j.jobId])).rows[0].master_ref).toBe("176-12345675");

    // management report carries the fixed-rule notes
    expect((await b.page("/app/management-reports")).html).toContain("What stands out");
    expect(await verifyInvariants(db)).toEqual([]);
  });
});
