import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb } from "./helpers.js";
import { createStaff } from "../src/platform/admin.js";
import { SECTORS, sectorGateKey, withLiveAvailability } from "../src/platform/catalog.js";
import { accept, assignOwner, releasedSectors, seedGates, submitEvidence, waive } from "../src/platform/readiness.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); await seedGates(db); });
const plus = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const staff = async (role: string, n: string) => { const s = await createStaff(db, `sr-${n}-${Date.now()}@loadbyton.test`, n, "a-very-long-staff-password", role); return { userId: s.userId, role }; };

describe("sector release gates drive the public label", () => {
  it("has one gate per sector and shows Available only after independent acceptance", async () => {
    expect(SECTORS).toHaveLength(18);
    expect(new Set(SECTORS.map((s) => sectorGateKey(s.slug))).size).toBe(18);
    expect((await releasedSectors(db)).size).toBe(0);
    expect(SECTORS.every((s) => s.availability !== "available")).toBe(true);   // no acceptance evidence means no unrestricted availability

    const eng = await staff("engineer", "e"), aud = await staff("auditor", "a");
    const key = sectorGateKey("cold-chain");
    await assignOwner(db, eng, key, "Cold chain lead");
    await submitEvidence(db, eng, key, "Qualified review and 12 live cases reconciled", "ref-1");
    await waive(db, aud, sectorGateKey("distribution"), "Deferred", plus(30));
    expect((await releasedSectors(db)).size).toBe(0);               // submitted evidence and waivers do not release a sector
    await accept(db, aud, key, "Reviewed", plus(90));
    const live = withLiveAvailability(await releasedSectors(db));
    expect(live.find((s) => s.slug === "cold-chain")?.availability).toBe("available");
    expect(live.find((s) => s.slug === "distribution")?.availability).toBe("planned");
  });
});
