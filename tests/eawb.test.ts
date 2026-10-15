import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, convertedJob } from "./helpers.js";
import { addAwbStock, allocateAwb, buildFwb, getMessage, issueFwb, listMessages, markHandedOver, voidMessage } from "../src/ops/eawb.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const party = (n: string) => ({ name: n, street: "1 Marina Walk", place: "Dubai", country: "AE" });
const base = { awb: "176-12345675", origin: "DXB", destination: "LHR", pieces: 3, weightKg: 125.46, volumeCbm: 0.8, shipper: party("Acme Trading LLC"), consignee: { ...party("Thames Imports"), country: "GB", place: "London", postcode: "TW6 2GA" }, currency: "AED", chargesPrepaid: true, goods: "Garments" };

describe("e-AWB", () => {
  it("builds a deterministic FWB message and refuses bad numbers and parties", () => {
    const m = buildFwb({ ...base, flight: { carrier: "EK", number: "0001", day: "15" }, rate: { amount: 12.5, chargeable: 130 } });
    expect(m).toBe(buildFwb({ ...base, flight: { carrier: "EK", number: "0001", day: "15" }, rate: { amount: 12.5, chargeable: 130 } }));
    expect(m.split("\n").slice(0, 3)).toEqual(["FWB/16", "176-12345675DXBLHR/T3K125.5MC0.80", "FLT/EK0001/15"]);
    expect(m).toContain("SHP\n/ACME TRADING LLC\n/1 MARINA WALK\n/DUBAI\n/AE"); expect(m).toContain("/GB/TW6 2GA"); expect(m).toContain("CVD/AED//PP/NVD/NCV/XXX"); expect(m).toContain("T1625.00");
    expect(() => buildFwb({ ...base, awb: "176-12345670" })).toThrow(/check digit/);
    expect(() => buildFwb({ ...base, destination: "DXB" })).toThrow(/same/);
    expect(() => buildFwb({ ...base, consignee: { ...base.consignee, country: "G" } })).toThrow(/Consignee/);
  });
  it("allocates numbers with check digits from stock, never twice, and keeps ranges apart", async () => {
    const t = await newTenant(db);
    const stock = await db.tenant(t.tenantId, (c) => addAwbStock(c, t.ctx, { prefix: "176", airline: "Emirates SkyCargo", first_serial: 1234567, last_serial: 1234568 }));
    const [a, b] = await db.tenant(t.tenantId, async (c) => [await allocateAwb(c, t.ctx, stock), await allocateAwb(c, t.ctx, stock)]);
    expect(a).toBe("176-12345675"); expect(b).toBe("176-12345686");
    await expect(db.tenant(t.tenantId, (c) => allocateAwb(c, t.ctx, stock))).rejects.toThrow(/used up/);
    await expect(db.tenant(t.tenantId, (c) => addAwbStock(c, t.ctx, { prefix: "176", airline: "x", first_serial: 1234568, last_serial: 1234600 }))).rejects.toThrow(/overlaps/);
  });
  it("issues from an air job once, records hand-over, voids and re-issues", async () => {
    const t = await newTenant(db);
    const j = await convertedJob(db, t);                                               // the helper builds an ocean job
    await expect(db.tenant(t.tenantId, (c) => issueFwb(c, t.ctx, j.jobId, { awb: "176-12345675" }))).rejects.toThrow(/air jobs/);
    await db.query(`UPDATE jobs SET mode='air' WHERE id=$1`, [j.jobId]);
    const f = { awb: "176-12345675", origin: "DXB", destination: "LHR", pieces: 3, weight_kg: 125.4, shipper_name: "Acme", shipper_street: "1 Marina", shipper_place: "Dubai", shipper_country: "AE", consignee_name: "Thames", consignee_street: "2 High St", consignee_place: "London", consignee_country: "GB", goods: "Garments" };
    const r = await db.tenant(t.tenantId, (c) => issueFwb(c, t.ctx, j.jobId, f));
    expect(r.body.startsWith("FWB/16")).toBe(true);
    await expect(db.tenant(t.tenantId, (c) => issueFwb(c, t.ctx, j.jobId, f))).rejects.toThrow(/already exists/);
    await expect(db.tenant(t.tenantId, (c) => markHandedOver(c, t.ctx, r.id, "x"))).rejects.toThrow(/at least/);
    await db.tenant(t.tenantId, (c) => markHandedOver(c, t.ctx, r.id, "Sent to handler by e-mail"));
    expect((await db.tenant(t.tenantId, (c) => getMessage(c, r.id))).status).toBe("handed_over");
    await db.tenant(t.tenantId, (c) => voidMessage(c, t.ctx, r.id, "Wrong consignee"));
    await db.tenant(t.tenantId, (c) => issueFwb(c, t.ctx, j.jobId, f));
    expect((await db.tenant(t.tenantId, (c) => listMessages(c))).map((m: any) => m.status).sort()).toEqual(["issued", "void"]);
    const other = await newTenant(db);
    expect(await db.tenant(other.tenantId, (c) => listMessages(c))).toEqual([]);
  });
});
