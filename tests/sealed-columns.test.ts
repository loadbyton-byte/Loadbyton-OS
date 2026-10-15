import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("session-secret rotation covers every sealed column", () => {
  it("lists each *_sealed column that a migration creates", () => {
    const dir = path.join(__dirname, "../src/db/migrations");
    const found = new Set<string>();
    for (const f of fs.readdirSync(dir)) {
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      // a table's own definition, or ALTER TABLE ... ADD COLUMN, naming a *_sealed column
      for (const m of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) for (const c of m[2].matchAll(/\b(\w*_sealed)\b\s+text/g)) found.add(`${m[1]}.${c[1]}`);
      for (const m of sql.matchAll(/ALTER TABLE (\w+)([^;]*);/g)) for (const c of m[2].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?(\w*_sealed)/g)) found.add(`${m[1]}.${c[1]}`);
    }
    const rotation = fs.readFileSync(path.join(__dirname, "../src/platform/secret-rotation.ts"), "utf8");
    const covered = new Set([...rotation.matchAll(/table: "(\w+)"[^}]*column: "(\w+)"/g)].map((m) => `${m[1]}.${m[2]}`));
    expect(found.size).toBeGreaterThan(5);
    expect([...found].filter((x) => !covered.has(x))).toEqual([]);
  });
});
