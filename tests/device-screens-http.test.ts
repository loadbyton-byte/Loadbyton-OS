import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { future } from "./helpers.js";
import { uploadDocument } from "../src/ops/documents.js";
import { approveSpecialistReview, createSpecialistCase, recordSpecialistEvent, transitionSpecialistCase } from "../src/ops/specialists.js";
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
const iso = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("Temperature logger screens", () => {
  it("registers a logger, binds it, takes a signed push and shows the trace with its statistics", async () => {
    resetThrottle();
    const t = await newTenant(db, undefined, ["cold-chain"]);
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [t.userId])).rows[0].email;
    const caseId = await db.tenant(t.tenantId, async (c) => {
      const party = await createParty(c, t.ctx, { kind: "customer", name: "Pharma" });
      const doc = await uploadDocument(c, t.ctx, { kind: "other", title: "Evidence", issuer: "Reviewer", filename: "e.pdf", data: Buffer.from("%PDF-1.4 e") });
      await approveSpecialistReview(c, t.ctx, "cold-chain", "Reviewer", doc, future());
      const p = await createSpecialistCase(c, t.ctx, "cold-chain", { party_id: party, external_ref: "C1", subject_ref: "S1", fee: "0", tax_code: "SR5", sensor_ref: "L1", minimum_c: 2, maximum_c: 8 });
      await recordSpecialistEvent(c, t.ctx, p.id, "evidence", { evidence_kind: "handling_protocol" }, "ok", "e1", doc);
      await recordSpecialistEvent(c, t.ctx, p.id, "calibration", { valid_until: future(), reference: "CAL" }, "ok", "e2", doc);
      await transitionSpecialistCase(c, t.ctx, p.id, "ready", "Approved");
      await transitionSpecialistCase(c, t.ctx, p.id, "active", "Approved");
      return p.id as string;
    });
    const b = new Browser();
    expect((await b.login(email, "correct horse battery")).status).toBe(302);
    expect((await b.page("/app/cold-chain/devices")).status).toBe(200);
    const reg = await b.post("/app/cold-chain/devices", { label: "Screen logger", serial: "SCR-1", interval_minutes: "5" });
    expect(reg.status).toBe(200);
    const html = await reg.text();
    const url = /(https?:\/\/[^<\s]*\/webhooks\/devices\/[A-Za-z0-9_-]+)/.exec(html)![1];
    const secret = /Signing secret<\/strong><br\/?><code>([^<]+)</.exec(html)![1];
    expect((await b.page("/app/cold-chain/devices")).html).not.toContain(secret);
    const devId = (await db.query<any>(`SELECT id FROM specialist_devices WHERE tenant_id=$1`, [t.tenantId])).rows[0].id;
    expect(flash((await b.post(`/app/cold-chain/devices/${devId}/bind`, { case_id: caseId, since: new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 16) })).headers.get("location"))).toMatch(/bound/);
    const raw = JSON.stringify({ readings: [3, 2.5, 4, 9.5, 5, 4.5].map((c, i) => ({ id: `s${i}`, at: iso(60 - i * 10), celsius: c })) });
    const res = await app.request(new URL(url).pathname, { method: "POST", body: raw, headers: { "x-lbt-signature": signRelay(secret, raw) } });
    expect(((await res.json()) as any).ingested).toBe(6);
    const mon = await b.page(`/app/cold-chain/cases/${caseId}`);
    expect(mon.status).toBe(200);
    expect(mon.html).toContain("<svg"); expect(mon.html).toContain("Mean kinetic temp."); expect(mon.html).toContain("9.5");
    const imp = await b.post("/app/cold-chain/devices/import", { device_id: devId, csv: `time,celsius\n${iso(5)},4.1\n${iso(4)},x\n` });
    expect(flash(imp.headers.get("location"))).toMatch(/2 rows: 1 accepted, 1 rejected/);
    expect(flash((await b.post(`/app/cold-chain/devices/${devId}/unbind`, {})).headers.get("location"))).toMatch(/unbound/);
    expect(await verifyInvariants(db)).toEqual([]);
  });
});
