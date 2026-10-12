import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb } from "./helpers.js";
import { createStaff } from "../src/platform/admin.js";
import { totp } from "../src/lib/util.js";
import { resetThrottle } from "../src/platform/auth.js";
import { resetRateLimits } from "../src/lib/ratelimit.js";
import { answer, tokens } from "../src/platform/knowledge.js";
import { PLAN_SEEDS } from "../src/platform/catalog.js";
import { brandHtml, WORDMARK_HTML } from "../src/lib/brand-html.js";
import { activeOffer, chatStaffed, waLink } from "../src/web/brand.js";

const plans: any[] = PLAN_SEEDS.map((p) => ({ plan_code: p.code, name: p.name, monthly_minor: p.monthly, setup_minor: p.setup, contact_sales: !!p.contact, limits: p.limits }));

describe("wordmark rendering", () => {
  it("draws LOAD|BY|TON as the logo does in visible text only", () => {
    const out = brandHtml('<title>LOAD|BY|TON.store</title><p>Welcome to LOAD|BY|TON.</p><input value="LOAD|BY|TON"><script>var a="LOAD|BY|TON"</script><code>LOAD|BY|TON</code><a title="LOAD|BY|TON">x</a>');
    expect(out).toContain("<title>LOAD|BY|TON.store</title>");
    expect(out).toContain(`<p>Welcome to ${WORDMARK_HTML}.</p>`);
    expect(out).toContain('<input value="LOAD|BY|TON">');
    expect(out).toContain('<script>var a="LOAD|BY|TON"</script>');
    expect(out).toContain("<code>LOAD|BY|TON</code>");
    expect(out).toContain('title="LOAD|BY|TON"');
  });
  it("leaves pages without the word untouched", () => { const h = "<p>No brand here</p>"; expect(brandHtml(h)).toBe(h); });
});

describe("contact points and offer", () => {
  it("builds WhatsApp links from the configured number", () => { expect(waLink("hi there")).toBe("https://wa.me/919661053007?text=hi%20there"); });
  it("only shows an offer with a real, future end date", () => {
    const o = activeOffer(new Date("2026-10-12T10:00:00Z"))!;
    expect(new Date(o.endsAt).getTime()).toBeGreaterThan(new Date("2026-10-12T10:00:00Z").getTime());
    expect(o.endsLabel).toContain("October 2026");
  });
  it("staffed hours follow the configured time zone", () => {
    expect(chatStaffed(new Date("2026-10-12T06:30:00Z"))).toBe(true);    // 12:00 IST
    expect(chatStaffed(new Date("2026-10-12T20:30:00Z"))).toBe(false);   // 02:00 IST
  });
});

describe("assistant knowledge", () => {
  const cases: [string, string][] = [
    ["how much does the starter plan cost?", "plan-starter"], ["do you support cold chain?", "sector-cold-chain"], ["is my data safe", "security"],
    ["can I use it in arabic", "arabic"], ["do you integrate with zoho", "integrations"], ["whatsapp number", "support"], ["do you file customs declarations", "customs"],
    ["does it do einvoicing", "einvoice"], ["how do drivers work offline", "driver"], ["can I import customers from excel", "import"], ["do you have a discount", "offer"],
    ["what happens when i exceed my jobs limit", "limits"], ["how long does activation take", "activation"], ["free plan limits", "free"], ["who built this", "about"],
  ];
  for (const [q, id] of cases) it(`answers "${q}" from ${id}`, () => expect(answer(q, plans).entry).toBe(id));
  it("quotes prices from the live plans, not from memory", () => {
    expect(answer("price of the business plan", plans).answer).toContain("AED 349");
    const changed = plans.map((p) => p.plan_code === "business" ? { ...p, monthly_minor: 41200 } : p);
    expect(answer("price of the business plan", changed).answer).toContain("AED 412");
  });
  it("says it does not know instead of guessing, and offers a person", () => {
    const r = answer("zxqv blorp frobnicate", plans);
    expect(r.entry).toBeUndefined(); expect(r.handoff).toBe(true); expect(r.answer).toMatch(/rather not guess/);
  });
  it("hands over when asked for a human", () => { expect(answer("can I talk to a human", plans).handoff).toBe(true); });
  it("tokenises with synonyms", () => { expect(tokens("Pricing and costs")).toContain("price"); });
});

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });

class B {
  jar = new Map<string, string>();
  async req(path: string, init: RequestInit = {}) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie } });
    for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  }
  async csrf() { await this.req("/login"); return this.jar.get("lbt_csrf")!; }
  async form(path: string, fields: Record<string, string>) {
    const body = new URLSearchParams({ _csrf: await this.csrf(), ...fields });
    return this.req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  async json(path: string, data: unknown, token: string, method = "POST") {
    const csrf = await this.csrf();
    return this.req(path, { method, body: method === "GET" ? undefined : JSON.stringify(data), headers: { "content-type": "application/json", "x-csrf-token": csrf, "x-chat-token": token } });
  }
}

describe("public pages", () => {
  it("serve with the wordmark drawn and the contact points present", async () => {
    for (const path of ["/", "/features", "/pricing", "/about", "/blog", "/security", "/compliance", "/industries", "/trust", "/for-forwarders", "/for-transporters", "/contact", "/sectors", "/products"]) {
      const r = await app.request(path); expect(r.status, path).toBe(200);
      const h = await r.text();
      expect(h, path).toContain("919661053007");
      expect(h, path).toContain("contact@loadbyton.com");
      expect(h, path).toContain('class="lbt"');
    }
    expect((await app.request("/terms")).status).toBe(301);
  });
  it("describes the subsidiary relationship without naming people", async () => {
    const h = await (await app.request("/about")).text();
    expect(h).toContain("subsidiary"); expect(h).toContain("Udyam"); expect(h).toContain("two");
  });
});

describe("chat", () => {
  const token = "T".repeat(43);
  it("the assistant answers JSON questions and needs the CSRF header", async () => {
    resetRateLimits();
    const b = new B();
    const ok = await b.json("/chat/bot", { q: "how much does it cost" }, token);
    expect(ok.status).toBe(200); expect((await ok.json() as any).answer).toContain("AED");
    const bad = await b.req("/chat/bot", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(403);
  });
  it("a visitor can start a chat, staff can reply, and the visitor receives it", async () => {
    resetRateLimits(); resetThrottle();
    const b = new B();
    const start = await b.json("/chat/live/send", { message: "Need a demo for my fleet", name: "Asha", email: "asha@example.com", page: "/pricing" }, token);
    expect(start.status).toBe(200);
    const s = await start.json() as any; expect(s.messages).toHaveLength(1); expect(s.messages[0].from).toBe("visitor");
    const t = (await db.query<any>(`SELECT id,status,staff_unread,visitor_hash FROM chat_threads`)).rows[0];
    expect(t.staff_unread).toBe(1); expect(t.visitor_hash).not.toContain(token);
    expect(Number((await db.query<any>(`SELECT count(*) n FROM outbox WHERE key=$1`, [`chat-started:${t.id}`])).rows[0].n)).toBe(1);

    // anonymous callers cannot read the inbox
    expect((await new B().req("/admin/chats")).status).toBe(302);
    const st = await createStaff(db, `chat-${Date.now()}@loadbyton.test`, "Priya Shah", "a-very-long-staff-password", "support");
    const email = (await db.query<any>(`SELECT email FROM users WHERE id=$1`, [st.userId])).rows[0].email;
    const sb = new B();
    expect((await sb.form("/login", { email, password: "a-very-long-staff-password" })).headers.get("location")).toBe("/admin/mfa");
    expect((await sb.form("/admin/mfa", { code: totp(st.totpSecret) })).headers.get("location")).toBe("/admin");
    const list = await (await sb.req("/admin/chats")).text(); expect(list).toContain("Asha");
    expect(await (await sb.req(`/admin/chats/${t.id}`)).text()).toContain("Need a demo for my fleet");
    expect((await sb.form(`/admin/chats/${t.id}/reply`, { message: "Happy to help — what size is the fleet?" })).headers.get("location")).toContain("ok=");

    const poll = await (await b.json(`/chat/live/poll?after=0`, undefined, token, "GET")).json() as any;
    expect(poll.messages.map((m: any) => m.from)).toEqual(["visitor", "staff"]);
    expect(poll.messages[1].name).toBe("Priya"); expect(poll.messages[1].text).toContain("fleet");
    // another browser cannot read this thread
    const other = await (await new B().json(`/chat/live/poll?after=0`, undefined, "O".repeat(43), "GET")).json() as any;
    expect(other.messages).toHaveLength(0);
  });
  it("rejects malformed tokens and empty messages", async () => {
    resetRateLimits();
    const b = new B();
    expect((await b.json("/chat/live/send", { message: "hi" }, "short")).status).toBe(401);
    expect((await b.json("/chat/live/send", { message: "   " }, "Z".repeat(43))).status).toBe(400);
  });
});
