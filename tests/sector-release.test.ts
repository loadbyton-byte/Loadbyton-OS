import { describe, it, expect, afterEach } from "vitest";
import { config } from "../src/config.js";
import { SECTORS, withLiveAvailability } from "../src/platform/catalog.js";
import { buildApp } from "../src/app.js";
import { freshDb } from "./helpers.js";

afterEach(() => { config.sectorRelease = "gated"; });

describe("operator-declared sector release (SECTOR_RELEASE=all)", () => {
  it("by default a sector is Available only when its own gate is accepted", () => {
    expect(withLiveAvailability(new Set()).every((s) => s.availability === "pilot")).toBe(true);
    const one = withLiveAvailability(new Set(["road-transport"]));
    expect(one.filter((s) => s.availability === "available").map((s) => s.slug)).toEqual(["road-transport"]);
  });

  it("when declared, all eighteen are live, and the ones without an accepted gate say so", () => {
    config.sectorRelease = "all";
    const live = withLiveAvailability(new Set(["road-transport"]));
    expect(live).toHaveLength(SECTORS.length);
    expect(live.every((s) => s.availability === "available")).toBe(true);
    expect(live.find((s) => s.slug === "road-transport")!.declared).toBeUndefined();
    expect(live.filter((s) => s.declared)).toHaveLength(17);
    // specialist sectors stay flagged as needing subject-matter review
    expect(live.filter((s) => s.specialist).map((s) => s.slug).sort()).toEqual(["aviation-logistics", "cold-chain", "customs-brokerage", "dangerous-cargo"]);
  });

  it("the public sector page tells the truth about a declared release and keeps the specialist warning", async () => {
    config.sectorRelease = "all";
    const app = buildApp(await freshDb());
    const html = await (await app.request("/sectors/dangerous-cargo")).text();
    expect(html).toContain("This sector pack is live");
    expect(html).toContain("We released it ourselves");
    expect(html).toContain("not a certification to handle regulated cargo");
    config.sectorRelease = "gated";
    expect(await (await app.request("/sectors/dangerous-cargo")).text()).toContain("in <strong>pilot</strong>");
  });
});
