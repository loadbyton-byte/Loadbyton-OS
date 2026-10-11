import { describe, it, expect, beforeAll } from "vitest";
import type { Db, Conn } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant, ctxFor, future } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { uploadDocument } from "../src/ops/documents.js";
import { approveSpecialistReview, createSpecialistCase, getSpecialistCase, recordSpecialistEvent, transitionSpecialistCase } from "../src/ops/specialists.js";
import { bindDevice, caseMonitor, deviceOverview, importLoggerCsv, meanKineticTemp, registerDevice, retireDevice, unbindDevice } from "../src/ops/device-feed.js";
import { signRelay } from "../src/ops/inbound.js";
import { verifyInvariants } from "../src/platform/invariants.js";
import { resetThrottle } from "../src/platform/auth.js";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

async function coldCase(calibrate = true) {
  const t = await newTenant(db, undefined, ["cold-chain"]);
  const run = <T>(fn: (c: Conn) => Promise<T>) => db.tenant(t.tenantId, fn);
  const party = await run((c) => createParty(c, t.ctx, { kind: "customer", name: "Pharma Customer" }));
  const doc = await run((c) => uploadDocument(c, t.ctx, { kind: "other", title: "Reviewed evidence", issuer: "Qualified reviewer", filename: "e.pdf", data: Buffer.from("%PDF-1.4 evidence") }));
  await run((c) => approveSpecialistReview(c, t.ctx, "cold-chain", "Qualified reviewer", doc, future()));
  const p = await run((c) => createSpecialistCase(c, t.ctx, "cold-chain", { party_id: party, external_ref: "CC-1", subject_ref: "SUBJECT-1", fee: "0", tax_code: "SR5", sensor_ref: "LOGGER-1", minimum_c: 2, maximum_c: 8 }));
  let n = 0;
  const event = (kind: string, a: Record<string, any>, ctx = t.ctx) => run((c) => recordSpecialistEvent(c, ctx, p.id, kind, a, "Verified evidence", `ev-${++n}`, doc));
  await event("evidence", { evidence_kind: "handling_protocol" });
  if (calibrate) await event("calibration", { valid_until: future(), reference: "CAL1" });
  await run((c) => transitionSpecialistCase(c, t.ctx, p.id, "ready", "Approved by responsible operator"));
  if (calibrate) await run((c) => transitionSpecialistCase(c, t.ctx, p.id, "active", "Approved by responsible operator"));
  return { t, run, p, event, doc };
}
const push = (url: string, secret: string, body: object, t0 = Math.floor(Date.now() / 1000), sig?: string) => {
  const raw = JSON.stringify(body);
  return app.request(new URL(url).pathname, { method: "POST", body: raw, headers: { "x-lbt-signature": sig ?? signRelay(secret, raw, t0) } });
};

describe("temperature logger feeds", () => {
  it("rejects what it cannot trust, keeps every reading, and turns an excursion into a hold that a person resolves", async () => {
    resetThrottle();
    const { t, run, p, event } = await coldCase();
    const dev = await run((c) => registerDevice(c, t.ctx, { label: "Truck logger", serial: "LG-1001", interval_minutes: 5 }));
    await expect(run((c) => registerDevice(c, t.ctx, { label: "Dup", serial: "LG-1001" }))).rejects.toThrow(/already registered/);
    const readings = (r: any[]) => ({ readings: r });
    expect((await push(dev.url, "wrong", readings([{ id: "a", at: iso(1), celsius: 4 }]))).status).toBe(401);
    expect((await push(dev.url, dev.secret, readings([{ id: "a", at: iso(1), celsius: 4 }]), Math.floor(Date.now() / 1000) - 3600)).status).toBe(401);
    expect((await push(dev.url.slice(0, -1) + "x", dev.secret, readings([]))).status).toBe(404);
    expect((await push(dev.url, dev.secret, readings([]))).status).toBe(400);

    // not bound yet: the reading is kept as rejected
    let r = await (await push(dev.url, dev.secret, readings([{ id: "pre", at: iso(1), celsius: 4.1 }]))).json() as any;
    expect(r).toMatchObject({ received: 1, ingested: 0, rejected: 1 }); expect(r.rejections[0].reason).toMatch(/not bound/);
    await expect(run((c) => bindDevice(c, t.ctx, dev.id, p.id, "2020-01-01T00:00:00Z"))).rejects.toThrow(/up to 30 days/);
    await run((c) => bindDevice(c, t.ctx, dev.id, p.id, iso(180)));
    await expect(run((c) => bindDevice(c, t.ctx, dev.id, p.id))).rejects.toThrow(/already bound/);

    r = await (await push(dev.url, dev.secret, readings([
      { id: "r1", at: iso(30), celsius: 4.0 }, { id: "r2", at: iso(25), celsius: 4.4 }, { id: "bad1", at: iso(20), celsius: 300 }, { id: "bad2", at: "not a date", celsius: 4 },
      { id: "fut", at: new Date(Date.now() + 3600_000).toISOString(), celsius: 4 }, { id: "old", at: iso(60 * 24), celsius: 4 }, { id: "r1", at: iso(30), celsius: 4.0 },
    ]))).json() as any;
    expect(r).toMatchObject({ received: 7, ingested: 2, rejected: 4, duplicates: 1 });
    expect(r.rejections.map((x: any) => x.reason).join(" | ")).toMatch(/outside −100…100/);
    expect(r.rejections.map((x: any) => x.reason).join(" | ")).toMatch(/not a valid date/);
    expect(r.rejections.map((x: any) => x.reason).join(" | ")).toMatch(/future/);
    expect(r.rejections.map((x: any) => x.reason).join(" | ")).toMatch(/predates/);
    expect((await run((c) => getSpecialistCase(c, p.id))).row.status).toBe("active");

    // out of range → the case goes on hold exactly as a manual reading would
    r = await (await push(dev.url, dev.secret, readings([{ id: "hot", at: iso(10), celsius: 11.5 }, { id: "r3", at: iso(5), celsius: 5 }]))).json() as any;
    expect(r.ingested).toBe(2);
    expect((await run((c) => getSpecialistCase(c, p.id))).row.status).toBe("hold");
    // the person who set the logger up is not the service identity: a qualified second person decides the excursion
    const other = await newTenant(db);
    await db.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES($1,$2,ARRAY['specialist'])`, [t.tenantId, other.userId]);
    const hotRef = (await db.query<any>(`SELECT client_ref FROM specialist_events WHERE case_id=$1 AND kind='temperature' AND (attributes->>'celsius')::float8>8`, [p.id])).rows[0].client_ref;
    await event("excursion_resolution", { event_ref: hotRef, decision: "Product assessed by QA" }, ctxFor(other.userId, t.tenantId, ["specialist"]));
    await run((c) => transitionSpecialistCase(c, t.ctx, p.id, "active", "Approved by responsible operator"));

    // the raw record keeps everything, including what was refused
    const counts = (await db.query<any>(`SELECT outcome, count(*)::int n FROM device_readings WHERE tenant_id=$1 GROUP BY 1 ORDER BY 1`, [t.tenantId])).rows;
    expect(counts).toEqual([{ outcome: "ingested", n: 4 }, { outcome: "rejected", n: 5 }]);
    await expect(db.query(`UPDATE device_readings SET celsius=1`)).rejects.toThrow();
    const m = await run((c) => caseMonitor(c, p.id));
    expect(m.stats).toMatchObject({ n: 4, min: 4, max: 11.5, excursions: 1 });
    expect(m.points.filter((x) => x.device)).toHaveLength(4);
    expect(m.rejected.length).toBeGreaterThanOrEqual(3);
    expect(m.rejected.map((x: any) => x.reason).join(" ")).toMatch(/predates|future|outside/);
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("will not accept readings without current calibration, honours unbinding, and imports logger CSV idempotently", async () => {
    resetThrottle();
    const { t, run, p, event } = await coldCase(false);
    const dev = await run((c) => registerDevice(c, t.ctx, { label: "Box logger", serial: "LG-2002", interval_minutes: 10 }));
    await run((c) => bindDevice(c, t.ctx, dev.id, p.id, iso(180)));
    let r = await (await push(dev.url, dev.secret, { readings: [{ id: "x1", at: iso(2), celsius: 5 }] })).json() as any;
    expect(r.rejections[0].reason).toMatch(/calibration/i);
    await event("calibration", { valid_until: future(), reference: "CAL9" });
    // the same reading, resent now that calibration exists, is accepted: a fixable refusal is not permanent
    r = await (await push(dev.url, dev.secret, { readings: [{ id: "x1", at: iso(2), celsius: 5 }] })).json() as any;
    expect(r).toMatchObject({ ingested: 1, rejected: 0 });
    expect((await db.query<any>(`SELECT attempt, outcome FROM device_readings WHERE reading_ref='x1' ORDER BY attempt`)).rows).toEqual([{ attempt: 1, outcome: "rejected" }, { attempt: 2, outcome: "ingested" }]);
    // a CSV download with a header, a comma decimal, a bad row and a repeat
    const csv = `time,temperature\n${iso(9)},4.5\n${iso(8)},"4,8"\n${iso(7)},abc\n${iso(9)},4.5\n`;
    const a = await importLoggerCsv(db, t.ctx, dev.id, csv);
    expect(a).toMatchObject({ rows: 4, ingested: 2, rejected: 1, duplicates: 1 });
    const b = await importLoggerCsv(db, t.ctx, dev.id, csv);
    expect(b).toMatchObject({ ingested: 0, duplicates: 4, rejected: 0 });                       // re-import adds nothing, and an unreadable row is not retried
    await expect(importLoggerCsv(db, t.ctx, dev.id, "when,what\n1,2")).rejects.toThrow(/time column/);
    await run((c) => unbindDevice(c, t.ctx, dev.id));
    r = await (await push(dev.url, dev.secret, { readings: [{ id: "after", at: new Date(Date.now() + 30_000).toISOString(), celsius: 5 }] })).json() as any;
    expect(r.rejections[0].reason).toMatch(/unbound/);
    await run((c) => retireDevice(c, t.ctx, dev.id));
    expect((await push(dev.url, dev.secret, { readings: [{ id: "z", at: iso(0.1), celsius: 5 }] })).status).toBe(404);   // a retired logger disappears
    await expect(run((c) => bindDevice(c, t.ctx, dev.id, p.id, iso(180)))).rejects.toThrow(/retired/);
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("flags a silent logger and computes mean kinetic temperature", async () => {
    resetThrottle();
    const { t, run, p } = await coldCase();
    const dev = await run((c) => registerDevice(c, t.ctx, { label: "Silent", serial: "LG-3003", interval_minutes: 5 }));
    await run((c) => bindDevice(c, t.ctx, dev.id, p.id, iso(180)));
    await push(dev.url, dev.secret, { readings: [{ id: "one", at: iso(2), celsius: 5 }] });
    expect((await run((c) => deviceOverview(c))).find((d: any) => d.id === dev.id)).toMatchObject({ bound: true, silent: false, ingested: 1 });
    await db.query(`UPDATE specialist_devices SET last_seen=now()-interval '2 hours' WHERE id=$1`, [dev.id]);
    expect((await run((c) => deviceOverview(c))).find((d: any) => d.id === dev.id)?.silent).toBe(true);
    expect(meanKineticTemp([5, 5, 5])).toBe(5);
    expect(meanKineticTemp([])).toBeNull();
    const mkt = meanKineticTemp([2, 8, 5, 25])!;
    expect(mkt).toBeGreaterThan((2 + 8 + 5 + 25) / 4);                 // MKT weights warm excursions more than the arithmetic mean
    expect(mkt).toBeLessThan(25);
  });
});

import { identifierChecks, imoValid, vinCheckApplies, vinCheckValid } from "../src/ops/identifiers.js";
import { iso6346Valid } from "../src/ops/doc-extract.js";
describe("advisory identifier checks", () => {
  it("applies the published check digits and only where they are defined", () => {
    expect(imoValid("9074729")).toBe(true); expect(imoValid("9074728")).toBe(false); expect(imoValid("907472")).toBe(false);
    expect(vinCheckValid("1M8GDM9AXKP042788")).toBe(true); expect(vinCheckValid("1M8GDM9A1KP042788")).toBe(false);
    expect(vinCheckApplies("1M8GDM9AXKP042788")).toBe(true); expect(vinCheckApplies("WVWZZZ1JZXW000001")).toBe(false);
    expect(identifierChecks("container-depot", { container_ref: "CSQU3054383" })).toEqual([{ label: "Container number", value: "CSQU3054383", valid: true, rule: "ISO 6346 check digit" }]);
    expect(identifierChecks("container-depot", { container_ref: "MSCU1234567" })[0].valid).toBe(iso6346Valid("MSCU1234567"));
    expect(identifierChecks("aviation-logistics", { airwaybill: "176-12345675" })[0].valid).toBe(true);
    expect(identifierChecks("aviation-logistics", { airwaybill: "176-12345670" })[0].valid).toBe(false);
    expect(identifierChecks("aviation-logistics", { airwaybill: "AWB1" })).toEqual([]);                                        // not an air waybill number: nothing to check
    expect(identifierChecks("marine-agency", { vessel_ref: "IMO 9074729" })[0]).toMatchObject({ value: "9074729", valid: true });
    expect(identifierChecks("automotive-logistics", { vin: "WVWZZZ1JZXW000001" })).toEqual([]);                               // check digit is not defined outside North America
    expect(identifierChecks("cold-chain", {})).toEqual([]);
  });
});
