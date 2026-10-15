import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import { buildApp } from "../src/app.js";
import { freshDb } from "./helpers.js";

let app: ReturnType<typeof buildApp>;
beforeAll(async () => { app = buildApp(await freshDb()); });

describe("driver offline shell", () => {
  it("serves the service worker, manifest and offline page without a session or tenant data", async () => {
    const sw = await app.request("/app/driver/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("content-type")).toMatch(/javascript/);
    expect(sw.headers.get("service-worker-allowed")).toBe("/app/driver");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    const text = await sw.text();
    expect(text).toContain("/app/driver/offline");
    expect(text).toMatch(/type === "clear"/);                       // sign-out removes saved pages
    expect(text).toContain('req.method !== "GET"');                     // writes are never cached by the worker
    const manifest = await app.request("/app/driver/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect((await manifest.json()).scope).toBe("/app/driver");
    const off = await app.request("/app/driver/offline");
    expect(off.status).toBe(200);
    expect(await off.text()).toContain("No signal");
  });
  it("the shipped worker precaches only files that exist", () => {
    const list = fs.readFileSync("public/driver-sw.js", "utf8").match(/var PRECACHE = (\[[^\]]+\])/)![1];
    for (const p of JSON.parse(list) as string[]) {
      if (p.startsWith("/app/driver/")) continue;                    // served by the application itself
      expect(fs.existsSync(`public${p}`), p).toBe(true);
    }
  });
  it("position uploads need a signed header token and a session", async () => {
    const res = await app.request("/app/driver/positions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trip_id: "x", points: [] }) });
    expect([302, 403]).toContain(res.status);
  });
});
