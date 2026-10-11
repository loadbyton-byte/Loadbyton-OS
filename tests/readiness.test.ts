import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb } from "./helpers.js";
import { createStaff } from "../src/platform/admin.js";
import { GATES, accept, assignOwner, gateHistory, readinessSummary, reopen, seedGates, submitEvidence, waive } from "../src/platform/readiness.js";
import { totp } from "../src/lib/util.js";
import { resetThrottle } from "../src/platform/auth.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); await seedGates(db); });
const plus = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const staff = async (role: string, n: string) => { const s = await createStaff(db, `rg-${n}-${Date.now()}@loadbyton.test`, n, "a-very-long-staff-password", role); return { userId: s.userId, role, s }; };

describe("release readiness register", () => {
  it("seeds every gate as not started, and nothing is ready until a different person accepts submitted evidence", async () => {
    let s = await readinessSummary(db);
    expect(s.total).toBe(GATES.length); expect(s.done).toBe(0); expect(s.ready).toBe(false);
    expect(s.gates.every((g) => g.effective === "not_started")).toBe(true);
    const eng = await staff("engineer", "eng"), com = await staff("commercial_admin", "com"), aud = await staff("auditor", "aud");
    const key = "brand_master";
    await expect(submitEvidence(db, eng, key, "Master file attached", "ticket-1")).rejects.toThrow(/Name an owner/);
    await assignOwner(db, eng, key, "Head of brand");
    await expect(accept(db, com, key, "ok", plus(90))).rejects.toThrow(/Evidence must be submitted/);
    await submitEvidence(db, eng, key, "Vector master (SVG + PDF) approved by the owner", "https://example.test/brand");
    await expect(accept(db, eng, key, "ok", plus(90))).rejects.toThrow(/Your staff role|Gates are accepted by/);
    await expect(accept(db, { ...com, userId: eng.userId }, key, "ok", plus(90))).rejects.toThrow(/someone other/);   // submitter cannot accept their own evidence
    await expect(accept(db, aud, key, "Reviewed", plus(900))).rejects.toThrow(/within the next 400 days/);
    await expect(accept(db, aud, key, "Reviewed", plus(-1))).rejects.toThrow(/within the next 400 days/);
    await accept(db, aud, key, "Master verified against the approved brand book", plus(120));
    s = await readinessSummary(db);
    expect(s.gates.find((g) => g.key === key)).toMatchObject({ effective: "accepted", owner_name: "Head of brand" });
    expect(s.done).toBe(1);
    await expect(submitEvidence(db, eng, key, "more", "x")).rejects.toThrow(/already decided/);
    await reopen(db, eng, key, "Brand refresh");
    expect((await readinessSummary(db)).gates.find((g) => g.key === key)?.effective).toBe("in_progress");
    const hist = await gateHistory(db, key);
    expect(hist.map((h: any) => h.action).reverse()).toEqual(["owner_assigned", "evidence_submitted", "accepted", "reopened"]);
    await expect(db.query(`UPDATE release_gate_events SET note='x'`)).rejects.toThrow();
  });

  it("acceptance expires into 'due for review', waivers are short and reasoned, and advisory gates do not block", async () => {
    const eng = await staff("engineer", "eng2"), aud = await staff("auditor", "aud2");
    await assignOwner(db, eng, "google_pay", "Payments lead");
    await waive(db, aud, "google_pay", "Not offered in the pilot market", plus(60));
    await expect(waive(db, aud, "google_pay", "x", plus(400))).rejects.toThrow(/at most 200 days/);
    await assignOwner(db, eng, "domain_ownership", "Operations");
    await submitEvidence(db, eng, "domain_ownership", "Registrar record with the entity as registrant", "reg-1");
    await accept(db, aud, "domain_ownership", "Verified at the registrar", plus(30));
    await db.query(`UPDATE release_gates SET valid_until=current_date - 1 WHERE key='domain_ownership'`);
    const s = await readinessSummary(db);
    expect(s.gates.find((g) => g.key === "domain_ownership")?.effective).toBe("due_for_review");
    expect(s.gates.find((g) => g.key === "google_pay")?.effective).toBe("waived");
    expect(s.blockers.map((g) => g.key)).not.toContain("google_pay");
    expect(s.blockers.map((g) => g.key)).toContain("domain_ownership");
    await expect(db.query(`UPDATE release_gates SET status='accepted' WHERE key='unit_economics'`)).rejects.toThrow();        // acceptance needs evidence and a decision
  });

  it("is reachable only by authenticated staff and decided over HTTP with the same rules", async () => {
    resetThrottle();
    expect((await app.request("/admin/readiness")).status).toBe(302);
    const eng = await staff("engineer", "web-eng"), aud = await staff("auditor", "web-aud");
    const login = async (st: typeof eng, email: string) => {
      const jar = new Map<string, string>();
      const call = async (path: string, init: RequestInit = {}) => {
        const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
        for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
        return res;
      };
      await call("/login");
      const post = async (path: string, f: Record<string, string>) => { await call("/login"); const body = new URLSearchParams({ _csrf: jar.get("lbt_csrf")!, ...f }); return call(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }); };
      await post("/login", { email, password: "a-very-long-staff-password" });
      await post("/admin/mfa", { code: totp(st.s.totpSecret) });
      return { call, post };
    };
    const emailOf = async (id: string) => (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [id])).rows[0].email;
    const e = await login(eng, await emailOf(eng.userId)), a = await login(aud, await emailOf(aud.userId));
    const page = await e.call("/admin/readiness?gate=support_coverage");
    expect(page.status).toBe(200); expect(await page.text()).toContain("Support coverage and escalation owners");
    const flash = (r: Response) => decodeURIComponent(new URL(r.headers.get("location")!, "http://x").searchParams.get("ok") ?? new URL(r.headers.get("location")!, "http://x").searchParams.get("err") ?? "");
    expect(flash(await e.post("/admin/readiness/support_coverage/owner", { owner_name: "Support manager" }))).toMatch(/Owner assigned/);
    expect(flash(await e.post("/admin/readiness/support_coverage/evidence", { note: "Rota and escalation path tested", ref: "wiki/support" }))).toMatch(/Evidence submitted/);
    expect(flash(await e.post("/admin/readiness/support_coverage/accept", { note: "ok", valid_until: plus(60) }))).toMatch(/accepted by a commercial administrator or an auditor/);
    expect(flash(await a.post("/admin/readiness/support_coverage/accept", { note: "Tested the call tree", valid_until: plus(60) }))).toMatch(/Gate accepted/);
  });
});
