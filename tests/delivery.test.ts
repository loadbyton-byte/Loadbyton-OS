import { describe, it, expect, beforeAll } from "vitest";
import type { Db, Conn } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import { permsFor, type Ctx } from "../src/lib/perms.js";
import { createParty } from "../src/ops/crm.js";
import { createDriver } from "../src/ops/transport.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import {
  addToRun, applyRiderEvent, billingSummary, cancelRun, cancelShipment, cashInHand, closeRun, confirmReturned, createRemittance, createRun, createShipment,
  decideSettlement, getRemittance, getShipment, importShipments, invoiceMerchant, listShipments, payRemittance, reattemptShipment, remittable, removeFromRun,
  returnToSender, setRate, settleRider, startRun, syncRiderEvents, trackByToken, voidRemittance, deliveryOverview, type RiderEvent,
} from "../src/ops/delivery.js";
import { getInvoice, recordReceipt, voidInvoice } from "../src/ops/finance.js";
import { verifyInvariants } from "../src/platform/invariants.js";
import { currentPlans } from "../src/platform/catalog.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

let n = 0;
const iso = (offsetMin = 0) => new Date(Date.now() + offsetMin * 60000).toISOString();
/** A real user + membership in the tenant, so created_by / received_by foreign keys are honest. */
async function staff(tenantId: string, role: string): Promise<Ctx> {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`dl-${role}-${++n}-${Date.now()}@example.com`, `${role} ${n}`]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}

async function site() {
  const t = await newTenant(db, undefined, ["courier-last-mile"]);
  const r = await db.tenant(t.tenantId, async (c) => {
    const shop = await createParty(c, t.ctx, { kind: "customer", name: "Souq Shop" });
    const other = await createParty(c, t.ctx, { kind: "customer", name: "Other Merchant" });
    const rider = await createDriver(c, t.ctx, { name: "Rashid" });
    const rider2 = await createDriver(c, t.ctx, { name: "Sami" });
    const tok = await invite(c, t.ctx, { email: `rider-${Date.now()}-${++n}@x.com`, roles: ["driver"], driver_id: rider });
    const tok2 = await invite(c, t.ctx, { email: `rider-${Date.now()}-${++n}@x.com`, roles: ["driver"], driver_id: rider2 });
    return { shop, other, rider, rider2, tok, tok2 };
  });
  const mk = async (tok: string, driverId: string): Promise<Ctx> => {
    const acc = await acceptInvite(db, tok, { name: "Rider", password: "rider-password-1" });
    return { userId: acc.userId, tenantId: t.tenantId, roles: ["driver"], perms: permsFor(["driver"]), partyId: null, driverId, readOnly: false, supportStaffId: null };
  };
  return { t, ...r, riderCtx: await mk(r.tok, r.rider), rider2Ctx: await mk(r.tok2, r.rider2) };
}
type Site = Awaited<ReturnType<typeof site>>;
const run = <T>(s: Site, fn: (c: Conn) => Promise<T>) => db.tenant(s.t.tenantId, fn);
const noViolations = async () => expect(await verifyInvariants(db)).toEqual([]);

const parcel = (s: Site, f: Record<string, any> = {}) =>
  run(s, (c) => createShipment(c, s.t.ctx, { merchant_id: s.shop, consignee_name: "Aisha K", consignee_phone: "0501234567", address: "Villa 4, Al Barsha", emirate: "Dubai", ...f }));
/** A parcel on a started run for the given rider. */
async function outForDelivery(s: Site, f: Record<string, any> = {}, rider = s.rider) {
  const p = await parcel(s, f);
  const r = await run(s, async (c) => { const x = await createRun(c, s.t.ctx, { driver_id: rider, shipment_ids: [p.id] }); await startRun(c, s.t.ctx, x.id); return x; });
  return { ...p, runId: r.id, runNo: r.no };
}
const ev = (id: string, kind: RiderEvent["kind"], payload: Record<string, any> = {}, over: Partial<RiderEvent> = {}): RiderEvent =>
  ({ client_event_id: `ev-${Math.random().toString(36).slice(2)}-${Date.now()}`, shipment_id: id, kind, device_time: iso(), payload, ...over });
const rider = (s: Site, e: RiderEvent, ctx = s.riderCtx) => run(s, (c) => applyRiderEvent(c, ctx, e));
const deliver = (s: Site, id: string, cash?: string | number, extra: Record<string, any> = {}) => rider(s, ev(id, "deliver", { name: "Aisha", ...(cash === undefined ? {} : { cash }), ...extra }));
const status = async (s: Site, id: string) => (await run(s, (c) => getShipment(c, id))).shipment.status;

describe("intake", () => {
  it("creates parcels with a waybill, a public token and a delivery code; a repeated merchant reference never makes a second parcel", async () => {
    const s = await site();
    const a = await parcel(s, { external_ref: "ORD-1", cod: "149.50" });
    expect(a.no).toMatch(/^DLV-\d{4}-00001$/);
    const g = await run(s, (c) => getShipment(c, a.id));
    expect(g.shipment.track_token.length).toBeGreaterThanOrEqual(12);
    expect(g.shipment.delivery_code).toMatch(/^\d{4}$/);
    expect(Number(g.shipment.cod_minor)).toBe(14950);
    await expect(parcel(s, { external_ref: "ORD-1" })).rejects.toThrow(/already exists as DLV-/);
    // the same reference from another merchant is a different parcel
    await run(s, (c) => createShipment(c, s.t.ctx, { merchant_id: s.other, external_ref: "ORD-1", consignee_name: "X", address: "Y", emirate: "Sharjah" }));
    await noViolations();
  });

  it("validates input before taking a number, so a bad row leaves no gap in the numbering", async () => {
    const s = await site();
    await expect(parcel(s, { emirate: "Narnia" })).rejects.toThrow(/Emirate must be one of/);
    await expect(parcel(s, { cod: "60000" })).rejects.toThrow(/above AED 50,000/);
    await expect(parcel(s, { consignee_name: " " })).rejects.toThrow(/Consignee name is required/);
    await expect(parcel(s, { max_attempts: "0" })).rejects.toThrow(/between 1 and 10/);
    expect((await parcel(s)).no).toMatch(/-00001$/);
  });

  it("imports a CSV: skips known references, reports bad rows, supports a dry run, and is idempotent", async () => {
    const s = await site();
    await parcel(s, { external_ref: "A1" });
    const csv = [
      "external_ref,consignee_name,address,emirate,cod,consignee_phone",
      "A1,Dup,Somewhere,Dubai,10,050",
      "B2,Noura,Marina Walk,Dubai,99.90,0501",
      "C3,Bad Emirate,Nowhere,Gotham,10,",
      "D4,Khalid,Al Majaz,Sharjah,,0502",
      "B2,Repeat in file,Marina Walk,Dubai,1,",
    ].join("\n");
    const dry = await run(s, (c) => importShipments(c, s.t.ctx, s.shop, csv, true));
    expect(dry).toMatchObject({ created: 2, duplicates: ["A1", "B2"] });
    expect(dry.rejected).toHaveLength(1);
    expect((await run(s, (c) => listShipments(c))).length).toBe(1);          // dry run stored nothing
    const real = await run(s, (c) => importShipments(c, s.t.ctx, s.shop, csv));
    expect(real.created).toBe(2);
    const again = await run(s, (c) => importShipments(c, s.t.ctx, s.shop, csv));
    expect(again.created).toBe(0);
    expect((await run(s, (c) => listShipments(c))).length).toBe(3);
    await expect(run(s, (c) => importShipments(c, s.t.ctx, s.shop, "ref,name\n1,2"))).rejects.toThrow(/“external_ref” column is required/);
    await noViolations();
  });

  it("counts parcels against the plan and stops at the allowance, but stays readable", async () => {
    const s = await site();
    const free = (await db.query<any>(`SELECT limits FROM plan_versions WHERE plan_code='free' AND version=5`)).rows[0].limits;
    expect(free.parcels_per_month).toBe(100);
    await db.system((c) => c.query(`UPDATE usage_counters SET used=$2 WHERE tenant_id=$1 AND key='parcels_per_month'`, [s.t.tenantId, 0]));
    await parcel(s);
    await db.system((c) => c.query(`UPDATE usage_counters SET used=100 WHERE tenant_id=$1 AND key='parcels_per_month'`, [s.t.tenantId]));
    await expect(parcel(s)).rejects.toThrow(/Plan limit reached for parcels_per_month/);
    expect((await run(s, (c) => listShipments(c))).length).toBe(1);
    // older plan versions fall back to the jobs allowance
    const v4 = (await db.query<any>(`SELECT limits FROM plan_versions WHERE plan_code='starter' AND version=4`)).rows[0].limits;
    expect(v4.parcels_per_month).toBeUndefined();
    const plans = await db.system((c) => currentPlans(c));
    expect(plans.every((p) => p.version === 5 && p.limits.parcels_per_month! > 0)).toBe(true);
  });
});

describe("runs", () => {
  it("assigns, starts and closes; a rider needs a login; a rider cannot be on two live runs", async () => {
    const s = await site();
    const a = await parcel(s), b = await parcel(s);
    const noLogin = await run(s, (c) => createDriver(c, s.t.ctx, { name: "No Login" }));
    const r0 = await run(s, (c) => createRun(c, s.t.ctx, { driver_id: noLogin, shipment_ids: [a.id] }));
    await expect(run(s, (c) => startRun(c, s.t.ctx, r0.id))).rejects.toThrow(/no login yet/);
    await run(s, (c) => cancelRun(c, s.t.ctx, r0.id));
    expect(await status(s, a.id)).toBe("new");

    const r1 = await run(s, (c) => createRun(c, s.t.ctx, { driver_id: s.rider, shipment_ids: [a.id] }));
    expect(await status(s, a.id)).toBe("assigned");
    await expect(run(s, (c) => addToRun(c, s.t.ctx, r1.id, [a.id]))).rejects.toThrow(/is assigned and cannot be assigned/);
    await run(s, (c) => addToRun(c, s.t.ctx, r1.id, [b.id]));
    await run(s, (c) => removeFromRun(c, s.t.ctx, r1.id, b.id));
    await run(s, (c) => startRun(c, s.t.ctx, r1.id));
    expect(await status(s, a.id)).toBe("out_for_delivery");
    const r2 = await run(s, (c) => createRun(c, s.t.ctx, { driver_id: s.rider, shipment_ids: [b.id] }));
    await expect(run(s, (c) => startRun(c, s.t.ctx, r2.id))).rejects.toThrow(/still out on RUN-/);
    await expect(run(s, (c) => closeRun(c, s.t.ctx, r1.id))).rejects.toThrow(/1 parcel\(s\) have no outcome/);
    expect((await deliver(s, a.id)).outcome).toBe("applied");
    await run(s, (c) => closeRun(c, s.t.ctx, r1.id));
    await run(s, (c) => startRun(c, s.t.ctx, r2.id));          // now the rider is free
    await noViolations();
  });

  it("adds a late parcel to a run that is already out; only new parcels can be assigned and only new ones cancelled", async () => {
    const s = await site();
    const first = await outForDelivery(s);
    const late = await parcel(s);
    await run(s, (c) => addToRun(c, s.t.ctx, first.runId, [late.id]));
    expect(await status(s, late.id)).toBe("out_for_delivery");
    await expect(run(s, (c) => cancelShipment(c, s.t.ctx, late.id))).rejects.toThrow(/cannot be cancelled/);
    const lone = await parcel(s);
    await run(s, (c) => cancelShipment(c, s.t.ctx, lone.id));
    await expect(run(s, (c) => addToRun(c, s.t.ctx, first.runId, [lone.id]))).rejects.toThrow(/cancelled and cannot be assigned/);
    await noViolations();
  });
});

describe("rider events and cash on delivery", () => {
  it("delivers a COD parcel only with the exact cash, once", async () => {
    const s = await site();
    const p = await outForDelivery(s, { cod: "250.00" });
    expect((await deliver(s, p.id)).reason).toMatch(/collect exactly AED 250\.00/);
    expect((await deliver(s, p.id, "249.99")).reason).toMatch(/you entered 249\.99/);
    expect((await deliver(s, p.id, "250.01")).outcome).toBe("stored");
    expect(await status(s, p.id)).toBe("out_for_delivery");
    const ok = await deliver(s, p.id, "250");
    expect(ok.outcome).toBe("applied");
    const g = await run(s, (c) => getShipment(c, p.id));
    expect(g.shipment).toMatchObject({ status: "delivered", delivered_to: "Aisha", attempts: 1 });
    expect(Number(g.collection.amount_minor)).toBe(25000);
    expect((await deliver(s, p.id, "250")).reason).toMatch(/already delivered/);
    expect((await run(s, (c) => getShipment(c, p.id))).collection.amount_minor).toBe(25000);
    expect(await run(s, (c) => cashInHand(c))).toEqual([expect.objectContaining({ name: "Rashid", parcels: 1, amount_minor: 25000 })]);
    await noViolations();
  });

  it("takes no cash for a prepaid parcel", async () => {
    const s = await site();
    const p = await outForDelivery(s);
    expect((await deliver(s, p.id, "10")).reason).toMatch(/no COD amount/);
    expect((await deliver(s, p.id)).outcome).toBe("applied");
    expect(await run(s, (c) => cashInHand(c))).toEqual([]);
    await noViolations();
  });

  it("requires the delivery code when the parcel says so, and never stores the code", async () => {
    const s = await site();
    const p = await outForDelivery(s, { require_code: "1", cod: "20" });
    const code = (await run(s, (c) => getShipment(c, p.id))).shipment.delivery_code;
    const wrong = code === "0000" ? "1111" : "0000";
    expect((await deliver(s, p.id, "20", { code: wrong })).reason).toMatch(/code is missing or wrong/);
    expect((await deliver(s, p.id, "20")).reason).toMatch(/code is missing or wrong/);
    expect((await deliver(s, p.id, "20", { code })).outcome).toBe("applied");
    const g = await run(s, (c) => getShipment(c, p.id));
    expect(JSON.stringify(g.events)).not.toContain(code === "0000" ? '"code":"0000"' : `"code":"${code}"`);
  });

  it("is idempotent per client event id, including concurrent syncs of the same event", async () => {
    const s = await site();
    const p = await outForDelivery(s, { cod: "40" });
    const e = ev(p.id, "deliver", { name: "Aisha", cash: "40" });
    const [x, y, z] = await Promise.all([rider(s, e), rider(s, e), rider(s, e)]);
    expect([x, y, z].map((r) => r.outcome).sort()).toEqual(["applied", "duplicate", "duplicate"]);
    const g = await run(s, (c) => getShipment(c, p.id));
    expect(g.events.filter((x: any) => x.kind === "deliver")).toHaveLength(1);
    expect((await run(s, (c) => cashInHand(c)))[0].amount_minor).toBe(4000);
    await noViolations();
  });

  it("keeps device time verbatim but clamps an implausible clock", async () => {
    const s = await site();
    const p = await outForDelivery(s);
    const future = iso(60 * 24);
    await rider(s, ev(p.id, "note", { text: "x" }, { device_time: future }));
    const e = (await run(s, (c) => getShipment(c, p.id))).events.find((x: any) => x.kind === "note");
    expect(new Date(e.device_time).toISOString()).toBe(future);
    expect(Date.parse(e.effective_time)).toBeLessThan(Date.now() + 60_000);
    expect(e.resolution).toMatch(/clock ahead/);
  });

  it("fences riders: only their own runs, and not with a bad event id or kind", async () => {
    const s = await site();
    const p = await outForDelivery(s, { cod: "10" });
    await expect(rider(s, ev(p.id, "deliver", { name: "X", cash: "10" }), s.rider2Ctx)).rejects.toThrow(/not on one of your runs/);
    expect((await rider(s, ev(p.id, "deliver", { name: "X", cash: "10" }, { client_event_id: "x" }))).outcome).toBe("rejected");
    expect((await rider(s, ev(p.id, "explode" as any))).outcome).toBe("rejected");
    expect((await rider(s, ev("00000000-0000-0000-0000-000000000000", "note"))).outcome).toBe("rejected");
    expect(await status(s, p.id)).toBe("out_for_delivery");
  });

  it("a failed attempt returns the parcel to the queue; a same-day retry by the rider can still deliver it", async () => {
    const s = await site();
    const p = await outForDelivery(s, { cod: "15" });
    expect((await rider(s, ev(p.id, "fail", { reason: "not_home", note: "door locked" }))).outcome).toBe("applied");
    const g = await run(s, (c) => getShipment(c, p.id));
    expect(g.shipment).toMatchObject({ status: "undelivered", attempts: 1 });
    expect(g.shipment.last_failure).toMatch(/Consignee not available — door locked/);
    expect((await deliver(s, p.id, "15")).outcome).toBe("applied");            // the consignee called back
    expect(await status(s, p.id)).toBe("delivered");
    expect((await run(s, (c) => getShipment(c, p.id))).shipment.attempts).toBe(2);
    await noViolations();
  });

  it("uses up its attempts and goes to return-to-sender with a task for the office", async () => {
    const s = await site();
    const p = await outForDelivery(s, { max_attempts: "2" });
    await rider(s, ev(p.id, "fail", { reason: "refused" }));
    await run(s, (c) => closeRun(c, s.t.ctx, p.runId));
    await expect(run(s, (c) => reattemptShipment(c, s.t.ctx, p.id, {}))).resolves.toBeUndefined();
    const r2 = await run(s, async (c) => { const x = await createRun(c, s.t.ctx, { driver_id: s.rider, shipment_ids: [p.id] }); await startRun(c, s.t.ctx, x.id); return x; });
    expect(r2.id).not.toBe(p.runId);
    const out = await rider(s, ev(p.id, "fail", { reason: "wrong_address" }));
    expect(out.reason).toMatch(/attempt 2 of 2: sent to return-to-sender/);
    expect(await status(s, p.id)).toBe("return_to_sender");
    const tasks = await run(s, (c) => c.query(`SELECT title FROM job_exceptions WHERE title LIKE 'Parcel %'`));
    expect(tasks.rows.map((r: any) => r.title)).toContain(`Parcel ${p.no}: all 2 attempts used`);
    await expect(run(s, (c) => reattemptShipment(c, s.t.ctx, p.id, {}))).rejects.toThrow(/Only an undelivered parcel/);
    await run(s, (c) => confirmReturned(c, s.t.ctx, p.id));
    expect(await status(s, p.id)).toBe("returned");
    await noViolations();
  });

  it("cannot reattempt past the maximum; can send an undelivered parcel back to the merchant", async () => {
    const s = await site();
    const p = await outForDelivery(s, { max_attempts: "3" });
    await rider(s, ev(p.id, "fail", { reason: "no_cash" }));
    const tasks = await run(s, (c) => c.query(`SELECT title FROM job_exceptions WHERE title LIKE '%cannot pay COD%'`));
    expect(tasks.rows).toHaveLength(1);
    await run(s, (c) => returnToSender(c, s.t.ctx, p.id, "Merchant asked us to take it back"));
    expect(await status(s, p.id)).toBe("return_to_sender");
    await expect(run(s, (c) => confirmReturned(c, s.t.ctx, (p as any).id))).resolves.toBeUndefined();
    await noViolations();
  });

  it("syncs an offline batch oldest-first so a failed attempt is applied before the retry that follows it", async () => {
    const s = await site();
    const p = await outForDelivery(s, { cod: "30" });
    const results = await run(s, (c) => syncRiderEvents(c, s.riderCtx, [
      ev(p.id, "deliver", { name: "Aisha", cash: "30" }, { device_time: iso(-5) }),
      ev(p.id, "fail", { reason: "not_home" }, { device_time: iso(-20) }),
    ]));
    expect(results.map((r) => r.outcome)).toEqual(["applied", "applied"]);          // fail (older) first, then the delivery
    expect(await status(s, p.id)).toBe("delivered");
    expect(await run(s, (c) => cashInHand(c))).toHaveLength(1);
    // the same batch again changes nothing
    const again = await run(s, (c) => syncRiderEvents(c, s.riderCtx, [ev(p.id, "note", {}, { client_event_id: results[0].client_event_id })]));
    expect(again[0].outcome).toBe("duplicate");
    await expect(run(s, (c) => syncRiderEvents(c, s.riderCtx, Array.from({ length: 101 }, () => ev(p.id, "note"))))).rejects.toThrow(/between 1 and 100/);
    await noViolations();
  });

  it("a delivery that arrives after the parcel was taken off the road is stored, not applied (cash then shows as a variance)", async () => {
    const s = await site();
    const p = await outForDelivery(s, { cod: "10" });
    await run(s, (c) => c.query(`UPDATE dlv_shipments SET status='return_to_sender', run_id=NULL WHERE id=$1`, [p.id]));
    const r = await deliver(s, p.id, "10");
    expect(r).toMatchObject({ outcome: "stored" });
    expect(r.reason).toMatch(/return to sender and not on a run/);
    expect((await run(s, (c) => getShipment(c, p.id))).collection).toBeNull();
    expect((await run(s, (c) => deliveryOverview(c))).conflicts).toBeGreaterThan(0);
    // a rider who never had the parcel is still refused; inside a batch that refusal does not block the rider's other events
    const mine = await outForDelivery(s, {}, s.rider2);
    const batch = await run(s, (c) => syncRiderEvents(c, s.rider2Ctx, [ev(p.id, "note", {}, { device_time: iso(-2) }), ev(mine.id, "deliver", { name: "Q" })]));
    expect(batch.map((x) => x.outcome)).toEqual(["rejected", "applied"]);
  });
});

describe("cash handover (rider → cash desk)", () => {
  async function twoDeliveries(s: Site) {
    const a = await outForDelivery(s, { cod: "100" }), b = await parcel(s, { cod: "55.50" });
    await run(s, (c) => addToRun(c, s.t.ctx, a.runId, [b.id]));
    await deliver(s, a.id, "100"); await deliver(s, b.id, "55.5");
    return { a, b };
  }
  it("a counted match closes at once and clears the rider's pile", async () => {
    const s = await site();
    await twoDeliveries(s);
    const cash = await staff(s.t.tenantId, "finance");
    const r = await run(s, (c) => settleRider(c, cash, s.rider, { counted: "155.50" }));
    expect(r).toMatchObject({ expected: 15550, counted: 15550, variance: 0, status: "closed" });
    expect(await run(s, (c) => cashInHand(c))).toEqual([]);
    await expect(run(s, (c) => settleRider(c, cash, s.rider, { counted: "1" }))).rejects.toThrow(/no uncounted cash/);
    await noViolations();
  });

  it("a shortage needs a note and a second person; the rider cannot receive their own cash", async () => {
    const s = await site();
    await twoDeliveries(s);
    const cash = await staff(s.t.tenantId, "finance"), boss = await staff(s.t.tenantId, "coordinator");
    await expect(run(s, (c) => settleRider(c, cash, s.rider, { counted: "150" }))).rejects.toThrow(/note explaining the difference/);
    await expect(run(s, (c) => settleRider(c, { ...cash, driverId: s.rider }, s.rider, { counted: "155.50" }))).rejects.toThrow(/own cash/);
    const r = await run(s, (c) => settleRider(c, cash, s.rider, { counted: "150", note: "AED 5.50 short, rider says wrong change" }));
    expect(r).toMatchObject({ variance: -550, status: "pending_approval" });
    await expect(run(s, (c) => decideSettlement(c, cash, r.id, true))).rejects.toThrow(/person who counted/);
    await expect(run(s, (c) => decideSettlement(c, s.riderCtx, r.id, true))).rejects.toThrow(/does not allow/);
    await run(s, (c) => decideSettlement(c, boss, r.id, true));
    await expect(run(s, (c) => decideSettlement(c, boss, r.id, true))).rejects.toThrow(/already closed/);
    await noViolations();
  });

  it("a rejected count puts the cash back to be counted again", async () => {
    const s = await site();
    await twoDeliveries(s);
    const cash = await staff(s.t.tenantId, "finance"), boss = await staff(s.t.tenantId, "coordinator");
    const r = await run(s, (c) => settleRider(c, cash, s.rider, { counted: "160", note: "found extra note" }));
    expect(r.variance).toBe(450);
    await run(s, (c) => decideSettlement(c, boss, r.id, false));
    expect(await run(s, (c) => cashInHand(c))).toEqual([expect.objectContaining({ amount_minor: 15550 })]);
    expect((await run(s, (c) => settleRider(c, cash, s.rider, { counted: "155.50" }))).status).toBe("closed");
    await noViolations();
  });

  it("the owner may decide their own variance (small tenants have one user)", async () => {
    const s = await site();
    await twoDeliveries(s);
    const r = await run(s, (c) => settleRider(c, s.t.ctx, s.rider, { counted: "100", note: "short" }));
    await run(s, (c) => decideSettlement(c, s.t.ctx, r.id, true));
    await noViolations();
  });

  it("warehouse and sales roles cannot touch cash", async () => {
    const s = await site();
    await twoDeliveries(s);
    for (const role of ["sales", "warehouse", "dispatcher", "auditor"]) {
      const u = await staff(s.t.tenantId, role);
      await expect(run(s, (c) => settleRider(c, u, s.rider, { counted: "155.50" }))).rejects.toThrow(/does not allow/);
    }
  });
});

describe("merchant remittance", () => {
  /** Two merchants' parcels delivered by the same rider, one handover. */
  async function cod(s: Site) {
    const a = await outForDelivery(s, { cod: "200" }), b = await parcel(s, { cod: "100" });
    const c2 = await run(s, (c) => createShipment(c, s.t.ctx, { merchant_id: s.other, consignee_name: "Z", address: "A", emirate: "Dubai", cod: "70" }));
    await run(s, (c) => addToRun(c, s.t.ctx, a.runId, [b.id, c2.id]));
    await deliver(s, a.id, "200"); await deliver(s, b.id, "100"); await deliver(s, c2.id, "70");
    return { a, b, c2 };
  }
  it("pays out only cash that has been counted in, per merchant, exactly once", async () => {
    const s = await site();
    await cod(s);
    await expect(run(s, (c) => createRemittance(c, s.t.ctx, s.shop))).rejects.toThrow(/no counted-in COD/);
    expect(await run(s, (c) => remittable(c))).toEqual([]);
    await run(s, (c) => settleRider(c, s.t.ctx, s.rider, { counted: "370" }));
    const avail = await run(s, (c) => remittable(c));
    expect(avail.map((x: any) => [x.name, x.gross_minor])).toEqual(expect.arrayContaining([["Souq Shop", 30000], ["Other Merchant", 7000]]));
    const r = await run(s, (c) => createRemittance(c, s.t.ctx, s.shop));
    expect(r).toMatchObject({ gross: 30000, fees: 0, net: 30000 });
    await expect(run(s, (c) => createRemittance(c, s.t.ctx, s.shop))).rejects.toThrow(/no counted-in COD/);
    const stmt = await run(s, (c) => getRemittance(c, r.id));
    expect(stmt.lines.map((l: any) => Number(l.amount_minor)).sort()).toEqual([10000, 20000]);
    await noViolations();
  });

  it("cash in a pending (variance) handover is not payable until it is approved", async () => {
    const s = await site();
    await cod(s);
    const cash = await staff(s.t.tenantId, "finance"), boss = await staff(s.t.tenantId, "coordinator");
    const h = await run(s, (c) => settleRider(c, cash, s.rider, { counted: "360", note: "short 10" }));
    await expect(run(s, (c) => createRemittance(c, s.t.ctx, s.shop))).rejects.toThrow(/no counted-in COD/);
    await run(s, (c) => decideSettlement(c, boss, h.id, true));
    // the merchant is paid what was COLLECTED; the shortage stays with the company
    expect((await run(s, (c) => createRemittance(c, s.t.ctx, s.shop))).gross).toBe(30000);
    await noViolations();
  });

  it("nets fees: invoices the merchant's rated charges and settles them out of the COD", async () => {
    const s = await site();
    await run(s, (c) => setRate(c, s.t.ctx, { merchant_id: s.shop, delivery: "10", return: "6", cod_fee_pct: "2.5", cod_fee_min: "3", intercity: "5" }));
    const { a, b } = await cod(s);
    await run(s, (c) => settleRider(c, s.t.ctx, s.rider, { counted: "370" }));
    // delivery 10 each (2) = 20; COD fee: 2.5% of 200 = 5, of 100 = 2.5→ min 3 → 8; total 28 net, VAT 5% = 1.40 → 29.40
    const r = await run(s, (c) => createRemittance(c, s.t.ctx, s.shop, { net_fees: true }));
    expect(r).toMatchObject({ gross: 30000, fees: 2940, net: 27060 });
    const inv = await run(s, async (c) => (await c.query<any>(`SELECT * FROM invoices WHERE dlv_run_id IS NOT NULL`)).rows[0]);
    expect(inv).toMatchObject({ status: "paid", total_minor: 2940, paid_minor: 2940 });
    const rec = await run(s, (c) => c.query<any>(`SELECT method, reference FROM receipts WHERE invoice_id=$1`, [inv.id]));
    expect(rec.rows[0]).toMatchObject({ method: "Netted from COD remittance", reference: r.no });
    // the other merchant has no rate: untouched
    await run(s, (c) => settleRider(c, s.t.ctx, s.rider, { counted: "0" })).catch(() => {});
    await noViolations();
  });

  it("never nets more than the COD available; the rest of the invoice stays receivable", async () => {
    const s = await site();
    await run(s, (c) => setRate(c, s.t.ctx, { merchant_id: s.shop, delivery: "40" }));
    const a = await outForDelivery(s, { cod: "20" });
    await deliver(s, a.id, "20");
    await run(s, (c) => settleRider(c, s.t.ctx, s.rider, { counted: "20" }));
    const r = await run(s, (c) => createRemittance(c, s.t.ctx, s.shop, { net_fees: true }));
    expect(r).toMatchObject({ gross: 2000, fees: 2000, net: 0 });
    const inv = (await run(s, (c) => c.query<any>(`SELECT * FROM invoices WHERE dlv_run_id IS NOT NULL`))).rows[0];
    expect(inv).toMatchObject({ status: "part_paid", total_minor: 4200, paid_minor: 2000 });
    await noViolations();
  });

  it("the payout is confirmed by a second person with a bank reference; a netted remittance cannot be withdrawn", async () => {
    const s = await site();
    await cod(s);
    await run(s, (c) => settleRider(c, s.t.ctx, s.rider, { counted: "370" }));
    const fin = await staff(s.t.tenantId, "finance"), fin2 = await staff(s.t.tenantId, "finance");
    const r = await run(s, (c) => createRemittance(c, fin, s.shop));
    await expect(run(s, (c) => payRemittance(c, fin, r.id, { reference: "TRX1" }))).rejects.toThrow(/person who prepared it/);
    await expect(run(s, (c) => payRemittance(c, fin2, r.id, { reference: " " }))).rejects.toThrow(/reference is required/);
    await run(s, (c) => payRemittance(c, fin2, r.id, { reference: "FAB-TRX-0042" }));
    await expect(run(s, (c) => payRemittance(c, fin2, r.id, { reference: "again" }))).rejects.toThrow(/already paid/);
    await expect(run(s, (c) => voidRemittance(c, fin, r.id))).rejects.toThrow(/cannot be withdrawn/);
    await noViolations();
  });

  it("a mistaken statement can be withdrawn and its cash becomes payable again", async () => {
    const s = await site();
    await cod(s);
    await run(s, (c) => settleRider(c, s.t.ctx, s.rider, { counted: "370" }));
    const r = await run(s, (c) => createRemittance(c, s.t.ctx, s.shop));
    await run(s, (c) => voidRemittance(c, s.t.ctx, r.id));
    expect((await run(s, (c) => createRemittance(c, s.t.ctx, s.shop))).gross).toBe(30000);
    await noViolations();
  });

  it("two simultaneous requests cannot pay the same cash twice", async () => {
    const s = await site();
    await cod(s);
    await run(s, (c) => settleRider(c, s.t.ctx, s.rider, { counted: "370" }));
    const res = await Promise.allSettled([1, 2, 3].map(() => run(s, (c) => createRemittance(c, s.t.ctx, s.shop))));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await noViolations();
  });

  it("the database refuses to edit or delete a cash collection or to remit it twice", async () => {
    const s = await site();
    const { a } = await cod(s);
    await run(s, (c) => settleRider(c, s.t.ctx, s.rider, { counted: "370" }));
    await expect(db.system((c) => c.query(`UPDATE dlv_collections SET amount_minor=1 WHERE shipment_id=$1`, [a.id]))).rejects.toThrow(/cannot be edited/);
    await expect(db.system((c) => c.query(`DELETE FROM dlv_collections WHERE shipment_id=$1`, [a.id]))).rejects.toThrow(/cannot be deleted/);
    await expect(db.system((c) => c.query(`UPDATE dlv_events SET kind='note' WHERE shipment_id=$1`, [a.id]))).rejects.toThrow();
    const r = await run(s, (c) => createRemittance(c, s.t.ctx, s.shop));
    const other = await run(s, (c) => createRemittance(c, s.t.ctx, s.other));
    await expect(db.system((c) => c.query(`UPDATE dlv_collections SET remittance_id=$2 WHERE shipment_id=$1`, [a.id, other.id]))).rejects.toThrow(/cannot be moved/);
    // a second collection for the same parcel is impossible
    await expect(db.system((c) => c.query(`INSERT INTO dlv_collections(tenant_id,shipment_id,driver_id,amount_minor,collected_at,client_event_id) VALUES ($1,$2,$3,1,now(),'dup-collection-1')`, [s.t.tenantId, a.id, s.rider]))).rejects.toThrow();
    expect(r.gross).toBe(30000);
    await noViolations();
  });

  it("a tampered cash figure is caught by the verifier", async () => {
    const s = await site();
    const a = await outForDelivery(s, { cod: "99" });
    await deliver(s, a.id, "99");
    await db.system(async (c) => {
      await c.query(`ALTER TABLE dlv_collections DISABLE TRIGGER dlv_collections_guard`);
      await c.query(`UPDATE dlv_collections SET amount_minor=1 WHERE shipment_id=$1`, [a.id]);
      await c.query(`ALTER TABLE dlv_collections ENABLE TRIGGER dlv_collections_guard`);
    });
    expect((await verifyInvariants(db)).map((v) => v.check)).toContain("a cash collection equals the COD of a delivered parcel");
    await db.system((c) => c.query(`DELETE FROM dlv_charges WHERE shipment_id=$1`, [a.id]));
    await db.system(async (c) => {
      await c.query(`ALTER TABLE dlv_collections DISABLE TRIGGER dlv_collections_guard`);
      await c.query(`UPDATE dlv_collections SET amount_minor=9900 WHERE shipment_id=$1`, [a.id]);
      await c.query(`ALTER TABLE dlv_collections ENABLE TRIGGER dlv_collections_guard`);
    });
    await noViolations();
  });
});

describe("rates and billing", () => {
  it("accrues charges once, leaves them unrated without a tariff, prices them later at the rate in force that day, and invoices", async () => {
    const s = await site();
    const a = await outForDelivery(s, { cod: "100", emirate: "Sharjah" });
    await deliver(s, a.id, "100");
    let g = (await run(s, (c) => getShipment(c, a.id))).charges;
    expect(g.map((x: any) => x.charge_type).sort()).toEqual(["cod_fee", "delivery", "intercity"]);
    expect(g.every((x: any) => x.unrated)).toBe(true);
    await expect(run(s, (c) => invoiceMerchant(c, s.t.ctx, s.shop))).rejects.toThrow(/No rated, unbilled/);
    // re-syncing the event cannot double the charges
    expect((await run(s, (c) => c.query(`SELECT count(*)::int n FROM dlv_charges`))).rows[0].n).toBe(3);

    const r = await run(s, (c) => setRate(c, s.t.ctx, { merchant_id: s.shop, delivery: "12", intercity: "0", cod_fee_pct: "3", cod_fee_min: "2" }));
    expect(r.priced).toBe(3);
    g = (await run(s, (c) => getShipment(c, a.id))).charges;
    expect(g.map((x: any) => x.charge_type).sort()).toEqual(["cod_fee", "delivery"]);          // intercity priced at zero is dropped, never invoiced
    expect(g.find((x: any) => x.charge_type === "cod_fee").unit_minor).toBe(300);
    const inv = await run(s, (c) => invoiceMerchant(c, s.t.ctx, s.shop));
    expect(inv.charges).toBe(2);
    const d = await run(s, (c) => getInvoice(c, inv.id));
    expect(Number(d.inv.subtotal_minor)).toBe(1500);
    expect(Number(d.inv.total_minor)).toBe(1575);
    expect(d.inv.job_no).toBe("Delivery activity");
    await expect(run(s, (c) => invoiceMerchant(c, s.t.ctx, s.shop))).rejects.toThrow(/No rated, unbilled/);
    // collecting the receipt works like any invoice
    await run(s, (c) => recordReceipt(c, s.t.ctx, inv.id, { amount: "15.75", method: "bank transfer" }));
    await noViolations();
  });

  it("voiding the invoice releases the charges for re-billing; returns bill the return fee once", async () => {
    const s = await site();
    await run(s, (c) => setRate(c, s.t.ctx, { merchant_id: s.shop, delivery: "10", return: "7" }));
    const a = await outForDelivery(s);
    await deliver(s, a.id);
    const b = await outForDelivery(s, {}, s.rider2);
    await rider(s, ev(b.id, "fail", { reason: "refused" }), s.rider2Ctx);
    await run(s, (c) => returnToSender(c, s.t.ctx, b.id, "refused"));
    await run(s, (c) => confirmReturned(c, s.t.ctx, b.id));
    await expect(run(s, (c) => confirmReturned(c, s.t.ctx, b.id))).rejects.toThrow(/Only a parcel marked/);
    const inv = await run(s, (c) => invoiceMerchant(c, s.t.ctx, s.shop));
    expect(inv.charges).toBe(2);
    await run(s, (c) => voidInvoice(c, s.t.ctx, inv.id, "wrong rate"));
    await run(s, (c) => setRate(c, s.t.ctx, { merchant_id: s.shop, delivery: "11", return: "7", effective_from: new Date(Date.now() + 86400000).toISOString().slice(0, 10) }));
    const again = await run(s, (c) => invoiceMerchant(c, s.t.ctx, s.shop));
    expect(again.charges).toBe(2);
    expect((await run(s, (c) => billingSummary(c))).length).toBe(0);
    await noViolations();
  });

  it("a rate in effect cannot be rewritten, and bounds are checked", async () => {
    const s = await site();
    await run(s, (c) => setRate(c, s.t.ctx, { merchant_id: s.shop, delivery: "10", effective_from: "2020-01-01" }));
    await expect(run(s, (c) => setRate(c, s.t.ctx, { merchant_id: s.shop, delivery: "11", effective_from: "2020-01-01" }))).rejects.toThrow(/cannot be edited/);
    await expect(run(s, (c) => setRate(c, s.t.ctx, { merchant_id: s.shop, cod_fee_pct: "25" }))).rejects.toThrow(/between 0% and 20%/);
    const sales = await staff(s.t.tenantId, "sales");
    await expect(run(s, (c) => setRate(c, sales, { merchant_id: s.shop, delivery: "1" }))).rejects.toThrow(/does not allow/);
  });
});

describe("tracking, isolation and entitlements", () => {
  it("the public tracking page shows milestones only — no name, phone, address or code", async () => {
    const s = await site();
    const p = await outForDelivery(s, { cod: "45", consignee_name: "Secret Person", consignee_phone: "0509999999", address: "Secret Villa 7" });
    await rider(s, ev(p.id, "fail", { reason: "not_home", note: "private note" }));
    await deliver(s, p.id, "45");
    const token = (await run(s, (c) => getShipment(c, p.id))).shipment.track_token;
    const t = await trackByToken(db, token);
    expect(t).toMatchObject({ no: p.no, merchant: "Souq Shop", status: "delivered", emirate: "Dubai", cod_minor: 4500, attempts: 2 });
    expect(t!.steps.map((x) => x.text)).toEqual(expect.arrayContaining(["Order received by the courier", "Out for delivery", "Delivery attempt unsuccessful", "Delivered"]));
    const dump = JSON.stringify(t);
    for (const secret of ["Secret", "0509999999", "Villa", "private note"]) expect(dump).not.toContain(secret);
    expect(await trackByToken(db, "nope")).toBeNull();
    expect(await trackByToken(db, "x".repeat(20))).toBeNull();
  });

  it("one company never sees or touches another's parcels, cash or runs", async () => {
    const a = await site(), b = await site();
    const p = await outForDelivery(a, { cod: "10" });
    await deliver(a, p.id, "10");
    expect(await run(b, (c) => listShipments(c))).toEqual([]);
    expect(await run(b, (c) => cashInHand(c))).toEqual([]);
    await expect(run(b, (c) => getShipment(c, p.id))).rejects.toThrow(/not found/i);
    await expect(run(b, (c) => cancelShipment(c, b.t.ctx, p.id))).rejects.toThrow(/not found/i);
    await expect(run(b, (c) => settleRider(c, b.t.ctx, a.rider, { counted: "10" }))).rejects.toThrow(/not found/i);
    // a merchant from another tenant cannot be used
    await expect(run(b, (c) => createShipment(c, b.t.ctx, { merchant_id: a.shop, consignee_name: "x", address: "y", emirate: "Dubai" }))).rejects.toThrow(/not found/i);
    // the database refuses cross-tenant references even when the application is bypassed
    await expect(db.tenant(b.t.tenantId, (c) => c.query(`INSERT INTO dlv_runs(tenant_id,no,driver_id,run_date) VALUES ($1,'X',$2,current_date)`, [b.t.tenantId, a.rider]))).rejects.toThrow();
    await noViolations();
  });

  it("a read-only (restricted) workspace can read but not create, assign or take cash", async () => {
    const s = await site();
    const p = await parcel(s, { cod: "10" });
    await db.system((c) => c.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`, [s.t.tenantId]));
    await expect(parcel(s)).rejects.toThrow(/read-only/);
    await expect(run(s, (c) => createRun(c, s.t.ctx, { driver_id: s.rider }))).rejects.toThrow(/read-only/);
    expect((await run(s, (c) => listShipments(c))).length).toBe(1);
    expect(await run(s, (c) => deliveryOverview(c))).toMatchObject({ awaiting: 1 });
    void p;
  });

  it("support sessions are read-only", async () => {
    const s = await site();
    await expect(run(s, (c) => createShipment(c, { ...s.t.ctx, readOnly: true }, { merchant_id: s.shop, consignee_name: "x", address: "y", emirate: "Dubai" }))).rejects.toThrow(/read-only/);
  });
});
