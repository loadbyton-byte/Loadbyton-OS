import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { config } from "../src/config.js";
import { freshDb, newTenant } from "./helpers.js";
import { completeConsent, consentRedirectUri, createFeedConnection, listFeeds, pullFeed, startConsent, withdrawConsent } from "../src/ops/live-feeds.js";
import { resealSessionSecrets } from "../src/platform/secret-rotation.js";
import { seal, unseal } from "../src/lib/seal.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const reply = (status: number, body: unknown) => ({ status, body: typeof body === "string" ? body : JSON.stringify(body) });
const withHosts = async <T,>(fn: () => Promise<T>) => { const s = config.liveFeeds.allowedHosts; config.liveFeeds.allowedHosts = ["bank.example.test"]; try { return await fn(); } finally { config.liveFeeds.allowedHosts = s; } };
const spec = { kind: "bank", label: "Open banking", url: "https://bank.example.test/v1/tx", secret: "client-1:s3cret", auth_scheme: "oauth2_authcode", authorize_url: "https://bank.example.test/authorize", token_url: "https://bank.example.test/token", token_scope: "accounts transactions" };

async function connect() {
  const t = await newTenant(db);
  const run = <T,>(fn: (c: any) => Promise<T>) => db.tenant(t.tenantId, fn);
  const id = await run((c) => createFeedConnection(c, t.ctx, spec));
  return { t, run, id };
}
const stateOf = (u: string) => new URL(u).searchParams.get("state")!;

describe("account-holder consent for statement feeds", () => {
  it("sends the account holder to the bank with PKCE, exchanges the code once, and pulls with the stored token", async () => {
    await withHosts(async () => {
      const { t, run, id } = await connect();
      const url = await run((c) => startConsent(c, t.ctx, id));
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe("https://bank.example.test/authorize");
      expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: "code", client_id: "client-1", redirect_uri: consentRedirectUri(), code_challenge_method: "S256", scope: "accounts transactions" });
      const posts: any[] = [];
      const deps = { post: async (_u: string, body: string, _h: any, o: any) => { posts.push({ form: Object.fromEntries(new URLSearchParams(body)), ct: o?.contentType }); return reply(200, { access_token: "AT-1", refresh_token: "RT-1", expires_in: 3600 }); } };
      await expect(run((c) => completeConsent(c, t.ctx, { code: "abc", state: "wrong" }, deps))).rejects.toThrow(/expired or was not started/);
      expect(await run((c) => completeConsent(c, t.ctx, { code: "abc", state: stateOf(url) }, deps))).toEqual({ ok: true, id });
      // the verifier matches the challenge that was sent
      const verifier = posts[0].form.code_verifier;
      expect(crypto.createHash("sha256").update(verifier).digest("base64url")).toBe(u.searchParams.get("code_challenge"));
      expect(posts[0].form).toMatchObject({ grant_type: "authorization_code", code: "abc", client_id: "client-1", client_secret: "s3cret", redirect_uri: consentRedirectUri() });
      expect(posts[0].ct).toBe("application/x-www-form-urlencoded");
      // single-use state
      await expect(run((c) => completeConsent(c, t.ctx, { code: "abc", state: stateOf(url) }, deps))).rejects.toThrow(/expired or was not started/);
      // tokens are sealed, listing never exposes them
      const row = (await db.query<any>(`SELECT token_sealed, consented_at, consent_expires_at FROM feed_connections WHERE id=$1`, [id])).rows[0];
      expect(row.token_sealed).not.toContain("AT-1"); expect(row.consented_at).toBeTruthy();
      expect(JSON.stringify(await run((c) => listFeeds(c)))).not.toContain("AT-1");
      expect((await run((c) => listFeeds(c)))[0]).toMatchObject({ consented: true, auth_scheme: "oauth2_authcode" });

      let sentAuth = "";
      const get = async (_u: string, h: Record<string, string>) => { sentAuth = h.authorization; return reply(200, [{ id: "B1", date: "2026-10-01", amount: "10.00", description: "x" }]); };
      expect((await pullFeed(db, t.tenantId, id, { get })).added).toBe(1);
      expect(sentAuth).toBe("Bearer AT-1");
    });
  });

  it("refreshes an expired access token, stores the new one, and stops cleanly when consent is expired, refused or withdrawn", async () => {
    await withHosts(async () => {
      const { t, run, id } = await connect();
      const url = await run((c) => startConsent(c, t.ctx, id));
      await run((c) => completeConsent(c, t.ctx, { code: "c", state: stateOf(url) }, { post: async () => reply(200, { access_token: "AT-old", refresh_token: "RT-1", expires_in: 1 }) }));
      const refreshes: any[] = [];
      const post = async (_u: string, body: string) => { refreshes.push(Object.fromEntries(new URLSearchParams(body))); return reply(200, { access_token: "AT-new", expires_in: 3600 }); };
      let auth = "";
      const get = async (_u: string, h: Record<string, string>) => { auth = h.authorization; return reply(200, [{ id: "N1", date: "2026-10-02", amount: "5.00" }]); };
      expect((await pullFeed(db, t.tenantId, id, { get, post })).added).toBe(1);
      expect(refreshes[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT-1" }); expect(auth).toBe("Bearer AT-new");
      // the fresh token is reused without another refresh
      await pullFeed(db, t.tenantId, id, { get, post }); expect(refreshes).toHaveLength(1);

      // the bank stops honouring the refresh token: the stored tokens are erased and the failure says what to do
      await db.query(`UPDATE feed_connections SET token_sealed=$2 WHERE id=$1`, [id, seal(JSON.stringify({ access_token: "x", refresh_token: "RT-1", expires_at: Date.now() - 1000 }))]);
      const bad = await pullFeed(db, t.tenantId, id, { get, post: async () => reply(400, { error: "invalid_grant" }) });
      expect(bad.error).toMatch(/no longer accepts this consent.*Connect the account again/);
      expect((await db.query<any>(`SELECT token_sealed FROM feed_connections WHERE id=$1`, [id])).rows[0].token_sealed).toBeNull();
      expect((await pullFeed(db, t.tenantId, id, { get, post })).error).toMatch(/Consent has not been given/);

      // consent past its expiry is refused without contacting the bank
      await db.query(`UPDATE feed_connections SET token_sealed=$2, consent_expires_at=now() - interval '1 day' WHERE id=$1`, [id, seal(JSON.stringify({ access_token: "x", refresh_token: "r", expires_at: Date.now() + 99999 }))]);
      let called = false;
      expect((await pullFeed(db, t.tenantId, id, { get: async () => { called = true; return reply(200, []); }, post })).error).toMatch(/consent has expired/);
      expect(called).toBe(false);
    });
  });

  it("records a refusal at the bank, erases tokens on withdrawal and re-seals them under a new session secret", async () => {
    await withHosts(async () => {
      const { t, run, id } = await connect();
      const url = await run((c) => startConsent(c, t.ctx, id));
      expect(await run((c) => completeConsent(c, t.ctx, { error: "access_denied", state: stateOf(url) }))).toEqual({ ok: false, message: expect.stringMatching(/not given at the provider/) });
      await expect(run((c) => completeConsent(c, t.ctx, { code: "x", state: stateOf(url) }))).rejects.toThrow(/expired or was not started/);   // the state was spent by the refusal
      expect((await run((c) => listFeeds(c)))[0]).toMatchObject({ consented: false, last_status: "error" });
      const url2 = await run((c) => startConsent(c, t.ctx, id));
      await run((c) => completeConsent(c, t.ctx, { code: "c", state: stateOf(url2) }, { post: async () => reply(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600 }) }));
      // rotation: values sealed under the previous secret are re-sealed, none is left unreadable
      const oldSecret = "old-secret-old-secret-old-secret-0000", cur = config.sessionSecret;
      await db.query(`UPDATE feed_connections SET secret_sealed=$2, token_sealed=$3 WHERE id=$1`, [id, seal("client-1:s3cret", oldSecret), seal("{}", oldSecret)]);
      const dry = await resealSessionSecrets(db, cur, oldSecret, false);
      expect(dry.counts["feed_connections.secret_sealed"].pending).toBe(1); expect(dry.counts["feed_connections.token_sealed"].pending).toBe(1);
      await resealSessionSecrets(db, cur, oldSecret, true);
      expect(unseal((await db.query<any>(`SELECT secret_sealed s FROM feed_connections WHERE id=$1`, [id])).rows[0].s)).toBe("client-1:s3cret");

      await run((c) => withdrawConsent(c, t.ctx, id));
      expect((await db.query<any>(`SELECT token_sealed, active FROM feed_connections WHERE id=$1`, [id])).rows[0]).toEqual({ token_sealed: null, active: false });
    });
  });

  it("only takes bank addresses on the permitted host list", async () => {
    const t = await newTenant(db);
    await withHosts(async () => {
      await expect(db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...spec, authorize_url: "https://evil.example.test/a" }))).rejects.toThrow(/Consent address/);
      await expect(db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...spec, secret: "no-colon" }))).rejects.toThrow(/client_id:client_secret/);
    });
  });
});
