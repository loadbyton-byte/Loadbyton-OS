import { Hono } from "hono";
import { z } from "zod";
import { getCookie } from "hono/cookie";
import type { Db } from "../db/client.js";
import { config } from "../config.js";
import { HttpError, badRequest } from "../lib/util.js";
import { registerCompany } from "../platform/tenants.js";
import { SECTORS } from "../platform/catalog.js";
import { completeMfa, endSession, login, newSession } from "../platform/auth.js";
import { paymentAdapter } from "../adapters/payments.js";
import { acceptInvite, inviteInfo } from "../ops/team.js";
import { buildMockEvent, processPaymentEvent, signPayload, verifySignature, type PaymentEvent } from "../platform/billing.js";
import { SESSION_COOKIE, arr, clearSessionCookie, formBody, safeNext, setSessionCookie, str, type Env } from "./mw.js";
import { Csrf, PublicShell, type Page } from "./ui.js";

export const auth = new Hono<Env>();
const pg = (c: any, title: string): Page => ({
  title, csrf: c.get("csrf"), path: c.req.path, user: c.get("session") ? { name: c.get("session").name } : null,
  ok: c.req.query("ok"), err: c.req.query("err"),
});
const Alerts = ({ p }: { p: Page }) => (<>
  {p.err ? <div class="alert err" role="alert"><strong>Problem.</strong> {p.err}</div> : null}
  {p.ok ? <div class="alert ok" role="status">{p.ok}</div> : null}
</>);

const EMIRATES = ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"];
const GOALS = ["Stop losing margin on jobs", "Get quotes and enquiries out of WhatsApp and spreadsheets", "Invoice faster and chase collections", "Control supplier costs", "Give customers a portal", "Just exploring"];

auth.get("/start", (c) => {
  const p = pg(c, "Start free");
  const pre = new URL(c.req.url).searchParams.getAll("sector");
  const plan = c.req.query("plan") ?? "";
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="wrap" style="max-width:720px">
        <h1>Start free</h1>
        <p>You get a real, empty workspace on the permanent Free plan. Examples live in a separate demo environment, never mixed with your data. No trade documents are needed to explore.</p>
        <Alerts p={p} />
        <form method="post" action="/start">
          <Csrf t={p.csrf} />
          <input type="hidden" name="plan" value={plan} />
          <div class="row">
            <div class="field"><label for="company">Company name</label><input id="company" name="company" type="text" required autocomplete="organization" /></div>
            <div class="field"><label for="contact">Your name</label><input id="contact" name="contact" type="text" required autocomplete="name" /></div>
          </div>
          <div class="row">
            <div class="field"><label for="email">Work email</label><input id="email" name="email" type="email" required autocomplete="email" /></div>
            <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" required minlength={10} autocomplete="new-password" /><div class="hint">At least 10 characters.</div></div>
          </div>
          <div class="row">
            <div class="field"><label for="country">Country</label><select id="country" name="country"><option value="AE">United Arab Emirates</option></select></div>
            <div class="field"><label for="emirate">Emirate</label><select id="emirate" name="emirate">{EMIRATES.map((e) => <option>{e}</option>)}</select></div>
          </div>
          <fieldset><legend>Sectors you operate in</legend>
            <p class="hint">Free includes one sector. Pick more and we will record your interest. Sectors marked Planned are not released yet.</p>
            <div class="checks">{SECTORS.map((s) => (
              <label class="check"><input type="checkbox" name="sector" value={s.slug} checked={pre.includes(s.slug) || (!pre.length && s.slug === "freight-forwarding")} /><span>{s.name}<br /><span class="small mute">{s.availability === "planned" ? "Planned" : "Pilot"}</span></span></label>
            ))}</div>
          </fieldset>
          <div class="field"><label for="goal">What do you most want to fix first?</label><select id="goal" name="goal">{GOALS.map((g) => <option>{g}</option>)}</select></div>
          <p class="small mute">By creating an account you agree to the <a href="/legal/terms">Terms</a> and acknowledge the <a href="/legal/privacy">Privacy notice</a>.</p>
          <button class="btn red" type="submit">Create my free workspace</button>
        </form>
        <p class="small">Already registered? <a href="/login">Sign in</a>.</p>
      </div></section>
    </PublicShell>,
  );
});

auth.post("/start", async (c) => {
  const b = await formBody(c);
  const db = c.get("db");
  try {
    const r = await registerCompany(db, {
      company: str(b.company), contactName: str(b.contact), email: str(b.email), password: str(b.password),
      country: str(b.country), emirate: str(b.emirate), sectors: arr(b.sector), goal: str(b.goal),
    });
    const s = await newSession(db, r.userId, r.tenantId);
    setSessionCookie(c, s.token);
    const plan = str(b.plan);
    return c.redirect(plan && plan !== "free" ? `/app/billing?plan=${encodeURIComponent(plan)}` : "/app?ok=" + encodeURIComponent("Workspace created. Start with the checklist below."));
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return c.redirect("/start?err=" + encodeURIComponent(e.message));
    throw e;
  }
});

auth.get("/login", (c) => {
  const p = pg(c, "Sign in");
  const next = c.req.query("next") ?? "";
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="auth card">
        <h1>Sign in</h1>
        <Alerts p={p} />
        <form method="post" action="/login">
          <Csrf t={p.csrf} />
          <input type="hidden" name="next" value={next} />
          <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username" /></div>
          <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" required autocomplete="current-password" /></div>
          <button class="btn" type="submit">Sign in</button>
        </form>
        <p class="small" style="margin-top:14px">New here? <a href="/start">Start free</a>.</p>
      </div></section>
    </PublicShell>,
  );
});

auth.post("/login", async (c) => {
  const b = await formBody(c);
  const db = c.get("db");
  try {
    const r = await login(db, str(b.email), str(b.password), c.req.header("x-forwarded-for") ?? "");
    setSessionCookie(c, r.token);
    if (r.staff) return c.redirect("/admin/mfa");
    return c.redirect(safeNext(str(b.next), "/app"));
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return c.redirect("/login?err=" + encodeURIComponent(e.message));
    throw e;
  }
});

auth.post("/logout", async (c) => {
  const t = getCookie(c, SESSION_COOKIE);
  if (t) await endSession(c.get("db"), t);
  clearSessionCookie(c);
  return c.redirect("/?ok=" + encodeURIComponent("Signed out."));
});

auth.get("/invite/:token", async (c) => {
  const inv = await inviteInfo(c.get("db"), c.req.param("token"));
  const p = pg(c, "Join workspace");
  if (!inv) throw new HttpError(410, "This invitation is invalid or has expired.", "gone");
  const existing = (await c.get("db").query<any>(`SELECT 1 FROM users WHERE email=$1`, [inv.email])).rows.length > 0;
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="auth card">
        <h1>Join {inv.tenant_name}</h1>
        <p>Invitation for <strong>{inv.email}</strong> as {inv.roles.join(", ")}. Accounts are individual — no shared passwords.</p>
        <Alerts p={p} />
        <form method="post" action={`/invite/${c.req.param("token")}`}>
          <Csrf t={p.csrf} />
          {existing ? <><p class="alert info">Enter your existing account password to add this workspace.</p><div class="field"><label for="pw">Account password</label><input id="pw" name="password" type="password" required autocomplete="current-password"/></div></> : (<>
            <div class="field"><label for="n">Your name</label><input id="n" name="name" type="text" required /></div>
            <div class="field"><label for="pw">Choose a password</label><input id="pw" name="password" type="password" required minlength={10} autocomplete="new-password" /></div>
          </>)}
          <button class="btn red" type="submit">Accept invitation</button>
        </form>
      </div></section>
    </PublicShell>,
  );
});
auth.post("/invite/:token", async (c) => {
  const b = await formBody(c);
  const db = c.get("db");
  try {
    const r = await acceptInvite(db, c.req.param("token"), { name: str(b.name), password: str(b.password) });
    const s = await newSession(db, r.userId, r.tenantId);
    setSessionCookie(c, s.token);
    return c.redirect("/app?ok=" + encodeURIComponent("Welcome aboard."));
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return c.redirect(`/invite/${c.req.param("token")}?err=` + encodeURIComponent(e.message));
    throw e;
  }
});

// ── platform staff second factor
auth.get("/admin/mfa", (c) => {
  const s = c.get("session");
  if (!s || !s.isStaff) throw new HttpError(403, "Platform staff only.", "forbidden");
  if (s.mfaOk) return c.redirect("/admin");
  const p = pg(c, "Verify it’s you");
  return c.html(
    <PublicShell p={p}>
      <section class="block"><div class="auth card">
        <h1>Two-step verification</h1>
        <Alerts p={p} />
        <form method="post" action="/admin/mfa">
          <Csrf t={p.csrf} />
          <div class="field"><label for="code">6-digit code from your authenticator app</label><input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required /></div>
          <button class="btn" type="submit">Verify</button>
        </form>
      </div></section>
    </PublicShell>,
  );
});
auth.post("/admin/mfa", async (c) => {
  const b = await formBody(c);
  try {
    await completeMfa(c.get("db"), getCookie(c, SESSION_COOKIE)!, str(b.code));
    return c.redirect("/admin");
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return c.redirect("/admin/mfa?err=" + encodeURIComponent(e.message));
    throw e;
  }
});

// ── payment webhook (authenticated by signature, not by cookie/CSRF)
const EventSchema = z.object({
  event_id: z.string().min(3).max(120),
  type: z.enum(["payment.succeeded", "payment.failed", "payment.refunded", "payment.review"]),
  order_id: z.string().uuid(),
  reference: z.string().min(3).max(120),
  amount_minor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  provider_session: z.string().max(200).optional(),
});
export async function handlePaymentWebhook(db: Db, provider: string, raw: string, sigHeader: string | null | undefined, eventId?: string) {
  if (raw.length > 256_000) return { status: 413, body: { error: 'payload too large' } };
  let decoded: unknown;
  if(provider==='mock') {
    if(config.isProd || !verifySignature(raw,sigHeader)) return {status:401,body:{error:'invalid signature'}};
    try { decoded=JSON.parse(raw); } catch { return {status:400,body:{error:'invalid payload'}}; }
  } else {
    try { decoded=await paymentAdapter(provider).decode(raw,sigHeader??'',eventId); }
    catch(e) { return {status:e instanceof HttpError?e.status:e instanceof SyntaxError?400:503,body:{error:e instanceof HttpError&&e.status===401?'invalid signature':'provider event could not be verified'}}; }
    if(decoded===null) return {status:200,body:{outcome:'ignored'}};
  }
  let parsed: PaymentEvent;
  try { parsed = EventSchema.parse(decoded); } catch { return { status: 400, body: { error: "invalid payload" } }; }
  const r = await processPaymentEvent(db, provider, parsed);
  return { status: r.outcome === "rejected" ? 422 : 200, body: r };
}
auth.post("/webhooks/payments/:provider", async (c) => {
  if (!config.enabledPaymentProviders.includes(c.req.param("provider"))) throw new HttpError(404, "Unknown provider");
  const raw = await c.req.text();
  const p=c.req.param('provider');
  const r = await handlePaymentWebhook(c.get("db"), p, raw, c.req.header(p==='stripe'?'stripe-signature':p==='razorpay'?'x-razorpay-signature':'x-lbt-signature'),c.req.header('x-razorpay-event-id'));
  return c.json(r.body, r.status as any);
});

export { buildMockEvent, signPayload };
