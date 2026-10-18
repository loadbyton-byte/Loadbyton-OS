import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { TINY_PNG, freshDb } from "./helpers.js";
import { createStaff } from "../src/platform/admin.js";
import { totp } from "../src/lib/util.js";
import { SECTORS } from "../src/platform/catalog.js";
import { SECTOR_CONTENT } from "../src/platform/sector-content.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { config.brochureMode = true; db = await freshDb(); app = buildApp(db); });
afterAll(() => { config.brochureMode = false; });

class Browser {
  jar = new Map<string, string>();
  private cookies() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(path: string, init: RequestInit = {}) {
    const res = await app.request(path, { ...init, redirect: "manual", headers: { ...(init.headers as any), cookie: this.cookies() } });
    for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  }
  get(path: string) { return this.req(path); }
  async post(path: string, fields: Record<string, string | string[]> = {}) {
    await this.get("/login");
    const body = new URLSearchParams({ _csrf: this.jar.get("lbt_csrf")! });
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return this.req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  async postForm(path: string, form: FormData) {
    await this.get("/login");
    form.append("_csrf", this.jar.get("lbt_csrf")!);
    return this.req(path, { method: "POST", body: form });
  }
  /** Page text with the few HTML entities the templates emit turned back into characters. */
  async text(path: string) { return (await (await this.get(path)).text()).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"); }
}
const loc = (r: Response) => decodeURIComponent((r.headers.get("location") ?? "").replace(/\+/g, " "));
const base = { category: "free", sector: "freight-forwarding", title: "Freight pack", requirements: "Branding plus our own quote layout.", demo_reviewed: "yes", contact: "Bea", password: "correct horse battery" };
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function register(over: Record<string, string> = {}, logo = true) {
  const b = new Browser(), id = stamp();
  const f = new FormData();
  for (const [k, v] of Object.entries({ ...base, company: `Portal Co ${id}`, email: `portal-${id}@example.com`, ...over })) f.append(k, v);
  if (logo) f.append("logo", new Blob([TINY_PNG], { type: "image/png" }), "logo.png");
  const res = await b.postForm("/start", f);
  return { b, res, id, email: `portal-${id}@example.com` };
}
async function staffBrowser(role = "support") {
  const email = `portal-staff-${stamp()}@lbt.test`;
  const st = await createStaff(db, email, "Sam Support", "a-very-long-staff-password", role);
  const ops = new Browser();
  await ops.post("/login", { email, password: "a-very-long-staff-password" });
  await ops.post("/admin/mfa", { code: totp(st.totpSecret) });
  return ops;
}
const requestIdOf = async (title: string, email: string) => (await db.query<any>(`SELECT r.id FROM service_requests r JOIN users u ON u.id=r.requested_by WHERE r.title=$1 AND u.email=$2`, [title, email])).rows[0].id as string;

describe("the public brochure", () => {
  it("explains the product and gives every one of the 18 sectors a full page", async () => {
    const b = new Browser();
    const home = await b.text("/");
    expect(home).toContain("WHAT IT IS");
    expect(home).toContain("Six steps");
    expect(home).toContain("What we will never ask you for");
    expect(home).not.toMatch(/Paid plans from|Start free\b/);   // the self-serve SaaS pitch is not the brochure's
    expect((home.match(/class="sector-card"/g) ?? []).length).toBe(18);
    const how = await b.text("/how-it-works");
    expect(how).toContain("When the clock starts");
    expect(how).toContain("Add your private details yourself");
    for (const s of SECTORS) {
      const page = await b.get(`/sectors/${s.slug}`);
      expect(page.status, s.slug).toBe(200);
      const html = (await page.text()).replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      for (const h of SECTOR_CONTENT[s.slug].highlights) expect(html, `${s.slug}: ${h}`).toContain(h);
      expect(html).toContain("What you get free");
      expect(html).toContain("What you enter yourself");
      expect(html).toContain("Documents");
      expect(html).not.toMatch(/Indicative fit|Starter<\/strong> plan/);
    }
    expect((await b.get("/sectors/nope")).status).toBe(404);
    const pricing = await b.text("/pricing");
    expect(pricing).toContain("Zoho Books invoice bridge");
    expect(pricing).toContain("AED 349");
    expect(pricing).toContain("Customisation we do for you");
    const find = await b.get("/find-my-bundle");
    expect([find.status, find.headers.get("location")]).toEqual([302, "/sectors"]);
  });

  it("asks for a brand and reminds the visitor what not to send, on the registration form", async () => {
    const html = await new Browser().text("/start");
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="logo"');
    expect(html).toContain("Please don't send us private numbers");
  });
});

describe("registering with a brand kit", () => {
  it("starts the clock at once when a logo comes with the request, and stores the logo privately", async () => {
    const { b, res, email } = await register();
    expect(res.status).toBe(302);
    expect(loc(res)).toMatch(/^\/app\/requests\/[0-9a-f-]{36}\?ok=Request received\. Delivery is due within 24 hours/);
    const id = await requestIdOf("Freight pack", email);
    const r = (await db.query<any>(`SELECT clock_started_at, brand_ready_at FROM service_requests WHERE id=$1`, [id])).rows[0];
    expect(r.clock_started_at).toBeTruthy();
    const brand = await b.text("/app/brand");
    expect(brand).toContain("Confirmed");
    expect(brand).toContain("logo.png");
    const asset = (await db.query<any>(`SELECT id FROM brand_assets WHERE uploaded_by=(SELECT id FROM users WHERE email=$1)`, [email])).rows[0];
    const file = await b.get(`/app/brand/assets/${asset.id}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await file.arrayBuffer()).equals(TINY_PNG)).toBe(true);
    // another client cannot fetch it, and a visitor is sent to sign in
    const other = (await register()).b;
    expect((await other.get(`/app/brand/assets/${asset.id}`)).status).toBe(404);
    expect((await new Browser().get(`/app/brand/assets/${asset.id}`)).status).toBe(302);
  });

  it("holds the clock when there is no brand yet, then starts it on confirmation", async () => {
    const { b, res, email } = await register({}, false);
    expect(loc(res)).toMatch(/^\/app\/brand\?ok=Request received\. Add your logo or colours/);
    const id = await requestIdOf("Freight pack", email);
    const waiting = await b.text(`/app/requests/${id}`);
    expect(waiting).toContain("The 24-hour clock has not started");
    expect(waiting).toContain("Waiting for your brand kit");
    const confirm = await b.post("/app/brand/confirm");
    // a name is already saved from registration; a logo or an honest "no logo yet" is still needed
    expect(loc(confirm)).toMatch(/\/app\/brand\?err=.*logo/i);
    await b.post("/app/brand", { display_name: "Portal Co", no_logo: "yes", primary_colour: "#0F2B3D" });
    const ok = await b.post("/app/brand/confirm");
    expect(loc(ok)).toMatch(/^\/app\?ok=Brand kit confirmed\. 1 request was waiting/);
    expect((await db.query<any>(`SELECT clock_started_at FROM service_requests WHERE id=$1`, [id])).rows[0].clock_started_at).toBeTruthy();
    const detail = await b.text(`/app/requests/${id}`);
    expect(detail).toMatch(/\d+h \d\dm left/);
  });

  it("refuses a bad logo before any account exists", async () => {
    const id = stamp(), email = `badlogo-${id}@example.com`;
    const b = new Browser(), f = new FormData();
    for (const [k, v] of Object.entries({ ...base, company: `Bad Logo ${id}`, email })) f.append(k, v);
    f.append("logo", new Blob(["MZ this is a program"], { type: "image/png" }), "logo.png");
    const res = await b.postForm("/start", f);
    expect(loc(res)).toMatch(/^\/start\?err=.*doesn't match/);
    expect((await db.query(`SELECT 1 FROM users WHERE email=$1`, [email])).rows).toHaveLength(0);
  });
});

describe("the dashboard", () => {
  it("shows the journey, what we provide for the chosen sector and the next step", async () => {
    const { b } = await register();
    const home = await b.text("/app");
    for (const t of ["Where you are", "Registered", "Send your brand kit", "We customise and deliver within 24 hours", "Add your private details yourself", "Need more? Add features", "What we provide for you", "Free: customisation we do for you", "Paid: monthly add-ons"]) expect(home, t).toContain(t);
    expect(home).toContain("Message our team");
    expect(home).toContain("Apply for a free service");
    for (const p of ["/app/requests", "/app/features", "/app/brand", "/app/messages", "/app/guide", "/app/plan"]) expect((await b.get(p)).status, p).toBe(200);
    expect((await b.get("/app/requests/new")).status).toBe(200);
    // billing, usage and operating pages stay fenced off
    for (const p of ["/app/billing", "/app/jobs", "/app/settings"]) expect([p, (await b.get(p)).headers.get("location")]).toEqual([p, "/app"]);
  });

  it("walks a client through adding their own private details, with progress", async () => {
    const { b } = await register();
    const guide = await b.text("/app/guide");
    expect(guide).toContain("Settings → Legal entity & finance");
    expect(guide).toContain("0 of");
    await b.post("/app/guide/tick", { code: "tax-id", done: "yes" });
    expect(await b.text("/app/guide")).toMatch(/1 of \d+ done/);
    await b.post("/app/guide/tick", { code: "tax-id", done: "" });
    expect(await b.text("/app/guide")).toContain("0 of");
    expect(loc(await b.post("/app/guide/tick", { code: "nonsense", done: "yes" }))).toContain("err=Unknown step");
  });
});

describe("messages between a client and our team", () => {
  it("is a private thread with unread badges both ways, and never carries a private number", async () => {
    const { b, email } = await register();
    const id = await requestIdOf("Freight pack", email);
    const sent = await b.post(`/app/requests/${id}/messages`, { body: "Can the invoice also show our Arabic company name?" });
    expect(loc(sent)).toContain("ok=Message sent");
    const refused = await b.post(`/app/requests/${id}/messages`, { body: "our TRN is 100123456789003" });
    expect(loc(refused)).toMatch(/err=.*tax registration number.*Please don't send it to us/);
    expect((await db.query<any>(`SELECT count(*)::int n FROM request_messages WHERE request_id=$1`, [id])).rows[0].n).toBe(1);

    const ops = await staffBrowser();
    expect(await ops.text("/admin/requests")).toContain('title="Unread client messages"');
    const detail = await ops.text(`/admin/requests/${id}`);
    expect(detail).toContain("Can the invoice also show our Arabic company name?");
    expect(detail).toContain("logo.png");                       // staff can see the brand kit next to the request
    const reply = await ops.post(`/admin/requests/${id}/messages`, { body: "Yes. Send the Arabic spelling here and we will add it." });
    expect(loc(reply)).toContain("Reply sent");
    expect(await ops.text("/admin/requests")).not.toContain('title="Unread client messages"');
    const staffRefused = await ops.post(`/admin/requests/${id}/messages`, { body: "please send IBAN AE070331234567890123456" });
    expect(loc(staffRefused)).toMatch(/err=.*bank account/);

    const home = await b.text("/app");
    expect(home).toContain('class="pill-count">1<');             // unread badge on the Messages tab
    expect(home).toContain("1 new");
    const thread = await b.text(`/app/requests/${id}`);
    expect(thread).toContain("Yes. Send the Arabic spelling here");
    expect(await b.text("/app")).not.toContain('class="pill-count"');   // reading the thread cleared it
  });

  it("keeps the staff queue and brand files away from clients", async () => {
    const { b, email } = await register();
    const id = await requestIdOf("Freight pack", email);
    expect((await b.get("/admin/requests")).status).toBeGreaterThanOrEqual(300);
    expect((await b.get(`/admin/requests/${id}`)).status).toBeGreaterThanOrEqual(300);
    const asset = (await db.query<any>(`SELECT id FROM brand_assets WHERE uploaded_by=(SELECT id FROM users WHERE email=$1)`, [email])).rows[0];
    expect((await b.get(`/admin/brand-assets/${asset.id}`)).status).toBeGreaterThanOrEqual(300);
    const ops = await staffBrowser();
    const dl = await ops.get(`/admin/brand-assets/${asset.id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
  });
});

describe("extra features and the monthly plan", () => {
  it("adds free features straight away and sends paid ones through a monthly plan payment", async () => {
    const { b } = await register();
    const page = await b.text("/app/features");
    expect(page).toContain("Your words on screen");
    expect(page).toContain("Zoho Books invoice bridge");
    expect(page).toContain("Needs the Business plan");
    expect(page).not.toContain("Shopify and WooCommerce");          // does not apply to freight forwarding

    const free = await b.post("/app/features", { sector: "freight-forwarding", feature: ["field-labels", "bilingual"] });
    expect(loc(free)).toMatch(/^\/app\/requests\/[0-9a-f-]{36}\?ok=Request received\. Free features are delivered within 24 hours/);

    const paid = await b.post("/app/features", { sector: "freight-forwarding", feature: ["einvoice", "field-labels"] });
    expect(loc(paid)).toMatch(/needs the Business plan|need the Business plan/i);
    const path = loc(paid).split("?")[0];
    const reqPage = await b.text(path);
    expect(reqPage).toContain("Pay for your monthly plan to start");
    expect(reqPage).toContain("Waiting for your plan payment");
    expect(reqPage).toContain("Business</strong> monthly plan");
    const id = path.split("/").pop()!;

    const pay = await b.post(`/app/requests/${id}/pay`, { provider: "mock" });
    expect(loc(pay)).toMatch(/^\/app\/billing\/pay\/[0-9a-f-]{36}$/);
    const checkout = await b.text(loc(pay));
    expect(checkout).toContain("Total payable");
    expect((await db.query<any>(`SELECT clock_started_at FROM service_requests WHERE id=$1`, [id])).rows[0].clock_started_at).toBeNull();   // opening checkout starts nothing

    const done = await b.post(loc(pay), { outcome: "success" });
    expect(loc(done)).toMatch(/^\/app\/plan\?ok=Payment verified\. Your monthly plan is active/);
    const after = await b.text(path);
    expect(after).toMatch(/\d+h \d\dm left/);
    expect(after).toContain("Business monthly plan paid");
    const plan = await b.text("/app/plan");
    expect(plan).toContain("Receipt");
    expect(plan).toContain("Business");
  });

  it("will not take a feature that doesn't apply, or an empty selection", async () => {
    const { b } = await register();
    expect(loc(await b.post("/app/features", { sector: "freight-forwarding", feature: "storefront-connectors" }))).toMatch(/err=.*doesn't apply/);
    expect(loc(await b.post("/app/features", { sector: "freight-forwarding" }))).toMatch(/err=.*at least one feature/);
  });
});
