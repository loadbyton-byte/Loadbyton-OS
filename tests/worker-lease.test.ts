import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb } from "./helpers.js";
import { acquireLease, releaseLease } from "../src/platform/worker-lease.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

describe("worker leases", () => {
  it("lets one instance hold a job at a time, renews for the holder, and hands over on release or expiry", async () => {
    expect(await acquireLease(db, "outbox", 60000, "a")).toBe(true);
    expect(await acquireLease(db, "outbox", 60000, "b")).toBe(false);
    expect(await acquireLease(db, "outbox", 60000, "a")).toBe(true);          // renewal
    expect(await acquireLease(db, "ledger", 60000, "b")).toBe(true);          // a different job is independent
    await releaseLease(db, "outbox", "b");                                      // not the holder: no effect
    expect(await acquireLease(db, "outbox", 60000, "b")).toBe(false);
    await releaseLease(db, "outbox", "a");
    expect(await acquireLease(db, "outbox", 60000, "b")).toBe(true);
    await db.system((c) => c.query(`UPDATE worker_leases SET expires_at = now() - interval '1 second' WHERE name='outbox'`));
    expect(await acquireLease(db, "outbox", 60000, "a")).toBe(true);          // crashed holder's lease lapsed
  });
  it("runs a job once when two callers race", async () => {
    const wins = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireLease(db, "race", 60000, `h${i}`)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
});
