import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { config } from "../src/config.js";
import { freshDb, newTenant } from "./helpers.js";
import { createFeedConnection, pullFeed } from "../src/ops/live-feeds.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, body: typeof body === "string" ? body : JSON.stringify(body), headers });
const withHosts = async <T,>(fn: () => Promise<T>) => { const s = config.liveFeeds.allowedHosts; config.liveFeeds.allowedHosts = ["fuel.example.test"]; try { return await fn(); } finally { config.liveFeeds.allowedHosts = s; } };
const base = { kind: "fuel", url: "https://fuel.example.test/v2/tx" };
const fuel = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `F${i + 1}`, date: "2026-10-01T08:00:00Z", plate: "D 12345", amount: "10.00", litres: 5 }));

describe("statement feeds beyond a single JSON list", () => {
  it("signs in with OAuth2 client credentials, then follows cursor paging until the cursor runs out", async () => {
    const t = await newTenant(db, undefined, ["freight-forwarding", "road-transport"]);
    await withHosts(async () => {
      const id = await db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...base, label: "OAuth fuel", auth_scheme: "oauth2_client", token_url: "https://fuel.example.test/oauth/token", token_scope: "transactions", secret: "cid:s3cret:with:colons",
        items_path: "data", page_mode: "cursor", page_param: "after", next_path: "meta.next" }));
      const tokenCalls: any[] = [], urls: string[] = [], auth: string[] = [];
      const deps = {
        post: async (url: string, body: string, headers: Record<string, string>, o: any) => { tokenCalls.push({ url, body, headers, ct: o?.contentType }); return reply(200, { access_token: "tok-1", expires_in: 300 }); },
        get: async (url: string, headers: Record<string, string>) => {
          urls.push(url); auth.push(headers.authorization);
          const after = new URL(url).searchParams.get("after");
          return !after ? reply(200, { data: fuel(2), meta: { next: "c2" } }) : after === "c2" ? reply(200, { data: [{ ...fuel(3)[2] }], meta: { next: null } }) : reply(200, { data: [] });
        },
      };
      const r = await pullFeed(db, t.tenantId, id, deps);
      expect(r).toMatchObject({ added: 3 });
      expect(tokenCalls).toHaveLength(1);
      expect(tokenCalls[0].ct).toBe("application/x-www-form-urlencoded");
      expect(tokenCalls[0].body).toContain("grant_type=client_credentials"); expect(tokenCalls[0].body).toContain("scope=transactions");
      expect(tokenCalls[0].headers.authorization).toBe(`Basic ${Buffer.from("cid:s3cret:with:colons").toString("base64")}`);
      expect(auth).toEqual(["Bearer tok-1", "Bearer tok-1"]);
      expect(urls.map((u) => new URL(u).searchParams.get("after"))).toEqual([null, "c2"]);
      // a refused sign-in is a clear, recorded failure
      const bad = await pullFeed(db, t.tenantId, id, { ...deps, post: async () => reply(401, { error: "invalid_client" }) });
      expect(bad.error).toMatch(/refused the client credentials/);
    });
  });

  it("pages by number and by Link header, reads CSV answers by column name, and never follows a next address off the allowed host", async () => {
    const t = await newTenant(db, undefined, ["freight-forwarding", "road-transport"]);
    await withHosts(async () => {
      const pageId = await db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...base, label: "Paged", secret: "k", page_mode: "page", max_pages: 3 }));
      const seen: string[] = [];
      await pullFeed(db, t.tenantId, pageId, { get: async (u) => { seen.push(new URL(u).searchParams.get("page") ?? "1"); const p = Number(new URL(u).searchParams.get("page") ?? 1); return reply(200, p < 3 ? [{ ...fuel(9)[p * 3], id: `P${p}` }] : []); } });
      expect(seen).toEqual(["1", "2", "3"]);

      const csvId = await db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...base, label: "CSV fuel", secret: "k", response_format: "csv", map_id: "txn", map_date: "when", map_plate: "vehicle", map_amount: "aed", map_litres: "ltr" }));
      const r = await pullFeed(db, t.tenantId, csvId, { get: async () => reply(200, "txn,when,vehicle,aed,ltr\nC1,2026-10-02T09:00:00Z,D 777,55.50,20\nC2,2026-10-02T10:00:00Z,D 777,60.00,22\n") });
      expect(r.added).toBe(2);
      expect((await db.query<any>(`SELECT amount_minor FROM transport_feed_lines WHERE tenant_id=$1 AND reference='C1'`, [t.tenantId])).rows[0].amount_minor).toBe(5550);

      const linkId = await db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...base, label: "Link", secret: "k", page_mode: "link" }));
      const hits: string[] = [];
      const lr = await pullFeed(db, t.tenantId, linkId, { get: async (u) => { hits.push(u); return hits.length === 1 ? reply(200, [{ ...fuel(1)[0], id: "L1" }], { link: '<https://evil.example.test/steal>; rel="next"' }) : reply(200, []); } });
      expect(lr.error).toMatch(/not a permitted|could not be reached/);
      expect(hits).toHaveLength(1);                                           // the foreign address was never requested
    });
  });

  it("rejects malformed paging or OAuth set-up", async () => {
    const t = await newTenant(db);
    await withHosts(async () => {
      await expect(db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...base, label: "x", secret: "k", auth_scheme: "oauth2_client", token_url: "https://fuel.example.test/t" }))).rejects.toThrow(/client_id:client_secret/);
      await expect(db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...base, label: "x", secret: "a:b", auth_scheme: "oauth2_client", token_url: "https://other.example.test/t" }))).rejects.toThrow(/Token address/);
      await expect(db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...base, label: "x", secret: "k", page_mode: "cursor" }))).rejects.toThrow(/next cursor/);
      await expect(db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...base, label: "x", secret: "k", page_mode: "link", response_format: "csv" }))).rejects.toThrow(/page number only/);
    });
  });
});
