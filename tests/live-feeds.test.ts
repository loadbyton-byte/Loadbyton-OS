import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { config } from "../src/config.js";
import { freshDb, newTenant } from "./helpers.js";
import { createFeedConnection, listFeeds, pullDueFeeds, pullFeed, setFeedActive, toCsv } from "../src/ops/live-feeds.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const reply = (status: number, body: unknown) => ({ status, body: typeof body === "string" ? body : JSON.stringify(body) });
const withHosts = async <T,>(fn: () => Promise<T>) => { const s = config.liveFeeds.allowedHosts; config.liveFeeds.allowedHosts = ["bank.example.test"]; try { return await fn(); } finally { config.liveFeeds.allowedHosts = s; } };

describe("live statement feeds", () => {
  it("maps provider JSON to the importer's CSV, signs debits, and reports what it cannot use", () => {
    const r = toCsv("bank", [
      { txn: "A1", booked: "2026-10-01", value: 1250, dir: "CREDIT", narrative: "INV-1 payment" },
      { txn: "A2", booked: "2026-10-02", value: 300, dir: "DBIT", narrative: "fee" },
      { txn: "", booked: "2026-10-02", value: 5 }, { txn: "A4", booked: "2026-10-03", value: 0 },
    ], { id: "txn", date: "booked", amount: "value", direction: "dir", description: "narrative", amount_unit: "minor", debit_values: ["dbit"] });
    expect(r.csv.split("\n")).toEqual(["date,amount,reference,description", "2026-10-01,12.50,A1,INV-1 payment", "2026-10-02,-3.00,A2,fee"]);
    expect(r.ids).toEqual(["A1", "A2"]); expect(r.latest).toBe("2026-10-02"); expect(r.skipped).toHaveLength(2);
    const f = toCsv("fuel", [{ id: "F1", date: "2026-10-01T08:00:00Z", plate: "A 12345", amount: "88.40", litres: 40 }, { id: "F2", date: "2026-10-01", amount: "5" }], {});
    expect(f.csv.split("\n")[1]).toBe("F1,2026-10-01T08:00:00Z,A 12345,88.40,40,"); expect(f.skipped[0]).toContain("no vehicle plate");
  });

  it("is refused until the installation lists the provider host, and the credential is sealed", async () => {
    const t = await newTenant(db);
    const f = { kind: "bank", label: "Main account", url: "https://bank.example.test/v1/tx", secret: "tok-123" };
    await expect(db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, f))).rejects.toThrow(/not enabled on this installation/);
    await withHosts(async () => {
      await expect(db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...f, url: "https://evil.example.test/x" }))).rejects.toThrow(/not a permitted/);
      await expect(db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...f, url: "http://bank.example.test/x" }))).rejects.toThrow(/https/);
      await db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, f));
    });
    const row = (await db.query<any>(`SELECT secret_sealed FROM feed_connections WHERE tenant_id=$1`, [t.tenantId])).rows[0];
    expect(row.secret_sealed).not.toContain("tok-123");
    expect(JSON.stringify(await db.tenant(t.tenantId, (c) => listFeeds(c)))).not.toContain("tok-123");
  });

  it("pulls into the bank importer, remembers transaction ids so overlapping pulls add nothing, and records failures without throwing", async () => {
    const t = await newTenant(db);
    await withHosts(async () => {
      const id = await db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { kind: "bank", label: "Card settlements", url: "https://bank.example.test/v1/tx?acct=1", secret: "tok", items_path: "data.items", amount_unit: "major" }));
      const calls: { url: string; headers: Record<string, string> }[] = [];
      let payload: any = { data: { items: [{ id: "T1", date: "2026-10-01", amount: "500.00", description: "COD remittance 1" }, { id: "T2", date: "2026-10-02", amount: "-12.00", description: "fee" }] } };
      let status = 200;
      const deps = { get: async (url: string, headers: Record<string, string>) => { calls.push({ url, headers }); return reply(status, payload); } };
      const r1 = await pullFeed(db, t.tenantId, id, deps);
      expect(r1.added).toBe(2); expect(calls[0].headers.authorization).toBe("Bearer tok"); expect(calls[0].url).toBe("https://bank.example.test/v1/tx?acct=1");
      expect((await db.query<any>(`SELECT count(*)::int n FROM dlv_bank_lines WHERE tenant_id=$1`, [t.tenantId])).rows[0].n).toBe(2);
      // the same window again, plus one new transaction: only the new one is imported, and the date filter reaches back three days from the cursor
      payload = { data: { items: [...payload.data.items, { id: "T3", date: "2026-10-03", amount: "40.00", description: "COD remittance 2" }] } };
      const r2 = await pullFeed(db, t.tenantId, id, deps);
      expect(r2.added).toBe(1); expect(new URL(calls[1].url).searchParams.get("since")).toBe("2026-09-29");
      expect((await db.query<any>(`SELECT count(*)::int n FROM dlv_bank_lines WHERE tenant_id=$1`, [t.tenantId])).rows[0].n).toBe(3);
      expect((await pullFeed(db, t.tenantId, id, deps)).added).toBe(0);
      // failures are recorded on the connection
      status = 401; expect((await pullFeed(db, t.tenantId, id, deps)).error).toMatch(/refused the credential/);
      status = 200; payload = { nope: true }; expect((await pullFeed(db, t.tenantId, id, deps)).error).toMatch(/expected list/);
      const f = (await db.tenant(t.tenantId, (c) => listFeeds(c)))[0];
      expect(f.last_status).toBe("error");
      await db.tenant(t.tenantId, (c) => setFeedActive(c, t.ctx, id, false));
      expect((await pullFeed(db, t.tenantId, id, deps)).error).toMatch(/switched off/);
    });
    // the host list is re-checked at pull time: removing a host stops an existing feed
    const rows = (await db.query<any>(`SELECT id FROM feed_connections WHERE tenant_id=$1`, [t.tenantId])).rows;
    await db.query(`UPDATE feed_connections SET active=true WHERE id=$1`, [rows[0].id]);
    expect((await pullFeed(db, t.tenantId, rows[0].id, { get: async () => reply(200, []) })).error).toMatch(/not enabled|not a permitted/);
  });

  it("fuel-card pulls go through the fuel importer (unmatched plates stay visible) and the scheduler pulls only due, active feeds", async () => {
    const t = await newTenant(db, undefined, ["freight-forwarding", "road-transport"]);
    await withHosts(async () => {
      const id = await db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { kind: "fuel", label: "Fuel card", url: "https://bank.example.test/fuel", secret: "k", auth_scheme: "header", auth_header: "X-Api-Key" }));
      let seen: Record<string, string> = {};
      const deps = { get: async (_u: string, h: Record<string, string>) => { seen = h; return reply(200, [{ id: "F1", date: "2026-10-01T08:00:00Z", plate: "D 12345", amount: "88.40", litres: 40 }]); } };
      const r = await pullFeed(db, t.tenantId, id, deps);
      expect(r.added).toBe(1); expect(seen["X-Api-Key"]).toBe("k");
      expect((await db.query<any>(`SELECT status, amount_minor FROM transport_feed_lines WHERE tenant_id=$1`, [t.tenantId])).rows).toEqual([{ status: "unmatched", amount_minor: 8840 }]);
      await db.query(`UPDATE feed_connections SET active=false WHERE id<>$1`, [id]);                  // other tests' feeds are not part of this scenario
      const first = await pullDueFeeds(db, deps);
      expect(first.pulled).toBe(0);                                                                  // pulled moments ago: not due
      await db.query(`UPDATE feed_connections SET last_pull_at = now() - interval '2 hours' WHERE id=$1`, [id]);
      expect((await pullDueFeeds(db, deps)).pulled).toBe(1);
    });
  });
});
