import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "../config.js";
import { HttpError } from "../lib/util.js";
import { login, endSession } from "../platform/auth.js";
import { receiveGrantEvent, reconcileFromCom, signInWithLoadbyton, finishSignIn, linkExistingAccount } from "../platform/ecosystem.js";
import { beginLogin, completeLogin, oidcConfigured, seal, unseal, type LoadbytonClaims } from "../platform/oidc-client.js";
import { rateLimit } from "../lib/ratelimit.js";
import { AuthFrame, Icon } from "./experience.js";
import { Csrf, PublicShell, type Page } from "./ui.js";
import { clientIp, formBody, safeNext, setSessionCookie, str, type Env } from "./mw.js";

/**
 * loadbyton.com link: the signed entitlement webhook and "Continue with Loadbyton" sign-in.
 *   POST /webhooks/loadbyton            signed event from loadbyton.com (no cookies, exempt from form CSRF like every /webhooks/ route)
 *   GET  /auth/loadbyton                start sign-in (redirects to loadbyton.com)
 *   GET  /auth/loadbyton/callback       return from loadbyton.com
 *   GET/POST /auth/loadbyton/link       prove control of an existing local account before linking it
 */
export const ecosystem = new Hono<Env>();

const FLOW_COOKIE = "lbt_oidc";
const LINK_COOKIE = "lbt_oidc_link";
const cookieOpts = { httpOnly: true, sameSite: "Lax" as const, secure: config.isProd, path: "/auth/loadbyton" };

const page = (c: any, title: string): Page => ({
  title, csrf: c.get("csrf"), path: c.req.path, user: c.get("session") ? { name: c.get("session").name } : null,
  ok: c.req.query("ok"), err: c.req.query("err"), heroDark: true, quiet: true,
});
const fail = (c: any, message: string) => c.redirect(`/login?err=${encodeURIComponent(message)}`);

ecosystem.post("/webhooks/loadbyton", async (c) => {
  const raw = await c.req.text();
  const r = await receiveGrantEvent(c.get("db"), raw, c.req.header("lbt-signature"));
  return c.json({ ok: true, outcome: r.outcome });
});

ecosystem.get("/auth/loadbyton", async (c) => {
  if (!oidcConfigured()) return fail(c, "Sign-in with Loadbyton is not available.");
  try {
    await rateLimit(`oidc-start:${clientIp(c) || "x"}`, 30, 600, "Too many sign-in attempts. Try again in a few minutes.");
    const f = await beginLogin(safeNext(c.req.query("next"), "/app"));
    setCookie(c, FLOW_COOKIE, f.cookie, { ...cookieOpts, maxAge: 600 });
    return c.redirect(f.url);
  } catch (e) {
    if (e instanceof HttpError && e.status < 600) return fail(c, e.message);
    throw e;
  }
});

const reconcile = (db: any) => () => reconcileFromCom(db);

ecosystem.get("/auth/loadbyton/callback", async (c) => {
  const flow = getCookie(c, FLOW_COOKIE);
  deleteCookie(c, FLOW_COOKIE, { path: cookieOpts.path });
  const q = c.req.query();
  if (q.error) return fail(c, q.error === "access_denied" ? "Loadbyton did not allow this account to sign in here." : "Sign-in with Loadbyton was not completed.");
  try {
    const { claims, next } = await completeLogin({ code: q.code, state: q.state, iss: q.iss }, flow);
    const db = c.get("db");
    const r = await signInWithLoadbyton(db, claims, { reconcile: reconcile(db) });
    if (r.kind === "session") {
      setSessionCookie(c, r.token);
      return c.redirect(safeNext(next, "/app"));
    }
    if (r.kind === "needs_link") {
      setCookie(c, LINK_COOKIE, seal({ claims, next }, 900), { ...cookieOpts, maxAge: 900 });
      return c.redirect("/auth/loadbyton/link");
    }
    return fail(c, r.message);
  } catch (e) {
    if (e instanceof HttpError && e.status < 600) return fail(c, e.message);
    throw e;
  }
});

ecosystem.get("/auth/loadbyton/link", (c) => {
  const pending = unseal<{ claims: LoadbytonClaims }>(getCookie(c, LINK_COOKIE));
  if (!pending) return fail(c, "That link request expired. Start again.");
  const p = page(c, "Link your account");
  const email = pending.claims.email;
  return c.html(
    <PublicShell p={p}>
      <AuthFrame>
        <span class="eyebrow">LINK YOUR ACCOUNT</span>
        <h1>Link your existing account</h1>
        <p class="mute">An account for <strong>{email}</strong> already exists here. Enter its password to link it to your Loadbyton sign-in. We never link accounts on the email address alone.</p>
        {p.err ? <div class="alert err" role="alert"><Icon name="alert" /><span><strong>Problem.</strong> {p.err}</span></div> : null}
        <form method="post" action="/auth/loadbyton/link">
          <Csrf t={p.csrf} />
          <div class="field"><label for="e">Email</label><input id="e" type="email" value={email} readonly /></div>
          <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" required autocomplete="current-password" /></div>
          <button class="btn red auth-submit" type="submit">Link and continue</button>
        </form>
        <p class="small" style="margin-top:14px"><a href="/login">Cancel</a></p>
      </AuthFrame>
    </PublicShell>,
  );
});

ecosystem.post("/auth/loadbyton/link", async (c) => {
  const pending = unseal<{ claims: LoadbytonClaims; next: string }>(getCookie(c, LINK_COOKIE));
  if (!pending) return fail(c, "That link request expired. Start again.");
  const b = await formBody(c);
  const db = c.get("db");
  try {
    // login() applies the same throttling and timing protections as the sign-in form.
    const r = await login(db, pending.claims.email, str(b.password), clientIp(c));
    await endSession(db, r.token);
    if (r.staff) return fail(c, "Platform staff sign in with their password and authenticator code.");
    await linkExistingAccount(db, r.userId, pending.claims);
    const done = await finishSignIn(db, r.userId, pending.claims, reconcile(db));
    deleteCookie(c, LINK_COOKIE, { path: cookieOpts.path });
    if (done.kind !== "session") return fail(c, done.kind === "message" ? done.message : "Could not complete sign-in.");
    setSessionCookie(c, done.token);
    return c.redirect(safeNext(pending.next, "/app"));
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return c.redirect(`/auth/loadbyton/link?err=${encodeURIComponent(e.message)}`);
    throw e;
  }
});
