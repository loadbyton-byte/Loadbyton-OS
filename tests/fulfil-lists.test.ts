import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createLocation, createSku, listLocations, listSkus, lowStock, resolveLocation, resolveSku, stockOverview } from "../src/ops/fulfilment.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

describe("fulfilment list pagination and code lookups", () => {
  it("pages SKUs, stock and locations with a look-ahead row, filters by search, and resolves codes", async () => {
    const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
    await db.tenant(t.tenantId, async (c) => {
      const a = await createParty(c, t.ctx, { kind: "customer", name: "Alpha" }), b = await createParty(c, t.ctx, { kind: "customer", name: "Beta" });
      for (let i = 0; i < 55; i++) await createSku(c, t.ctx, { party_id: a, code: `S${String(i).padStart(3, "0")}`, name: `Item ${i}`, reorder_point: 1 });
      await createSku(c, t.ctx, { party_id: b, code: "S000", name: "Same code other merchant" });
      for (let i = 0; i < 52; i++) await createLocation(c, t.ctx, { code: `L-${String(i).padStart(2, "0")}` });

      const p1 = await listSkus(c, null, 1), p2 = await listSkus(c, null, 2);
      expect(p1.length).toBe(51);                       // 50 + look-ahead
      expect(p2.length).toBe(6);
      expect(new Set([...p1.slice(0, 50), ...p2].map((r: any) => r.id)).size).toBe(56);
      expect((await listSkus(c, null, 1, "item 5")).length).toBe(6);           // Item 5, Item 50–54
      expect((await stockOverview(c, null, 2)).length).toBe(6);
      expect((await listLocations(c, 1)).length).toBe(51);
      expect((await listLocations(c, 1, "l-5")).length).toBe(2);              // L-50, L-51 (L-5x), the page filter is case-insensitive
      expect((await lowStock(c)).length).toBe(20);                               // capped, never the whole catalogue

      await expect(resolveSku(c, { sku_code: "s000" })).rejects.toThrow(/several merchants/);
      expect((await resolveSku(c, { sku_code: "s000", party_id: b })).party_name).toBe("Beta");
      await expect(resolveSku(c, { sku_code: "nope" })).rejects.toThrow(/No SKU/);
      expect((await resolveLocation(c, { location_code: " l-07 " })).code).toBe("L-07");
      await expect(resolveLocation(c, { location_code: "ZZ" })).rejects.toThrow(/not found/);
    });
  });
});
