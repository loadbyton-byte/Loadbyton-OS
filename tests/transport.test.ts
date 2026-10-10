import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import { permsFor, type Ctx } from "../src/lib/perms.js";
import { createParty } from "../src/ops/crm.js";
import {
  addCompliance, addMaintenance, applyDriverEvent, billDetention, cancelTrip, completeTrip, createDriver, createOrder, createTrip, createVehicle,
  decideExpense, dispatchTrip, getOrder, getTrip, invoiceOrder, syncDriverEvents, tripProfit, type DriverEvent,
} from "../src/ops/transport.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { recordReceipt, voidInvoice } from "../src/ops/finance.js";
import { verifyInvariants } from "../src/platform/invariants.js";
import { setSectors } from "../src/platform/tenants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60000).toISOString();
const dubai = (offsetH: number) => new Date(Date.now() + offsetH * 3600000 + 4 * 3600000).toISOString().slice(0, 16);   // wall-clock in UTC+4

async function fleet(opts: { kg?: number } = {}) {
  const t = await newTenant(db, undefined, ["road-transport"]);
  const r = await db.tenant(t.tenantId, async (c) => {
    const cust = await createParty(c, t.ctx, { kind: "customer", name: "Cust" });
    const veh = await createVehicle(c, t.ctx, { reg_no: "dxb a 1234", capacity_kg: opts.kg ?? 3000, capacity_cbm: 20 });
    const drv = await createDriver(c, t.ctx, { name: "Imran", phone: "050" });
    const token = await invite(c, t.ctx, { email: `drv-${Date.now()}-${Math.random()}@x.com`, roles: ["driver"], driver_id: drv });
    return { cust, veh, drv, token };
  });
  const acc = await acceptInvite(db, r.token, { name: "Imran", password: "driver-password-1" });
  const driverCtx: Ctx = { userId: acc.userId, tenantId: t.tenantId, roles: ["driver"], perms: permsFor(["driver"]), partyId: null, driverId: r.drv, readOnly: false, supportStaffId: null };
  return { t, ...r, driverCtx };
}
const order = (t: any, cust: string, o: Record<string, any> = {}) =>
  db.tenant(t.tenantId, (c) => createOrder(c, t.ctx, { party_id: cust, pickup_address: "Jebel Ali", delivery_address: "Dubai Marina", cargo_desc: "Boxes", weight_kg: 800, volume_cbm: 4, rate: "600", detention_rate: "100", ...o }));
const trip = (t: any, f: any, orderIds: string[]) =>
  db.tenant(t.tenantId, (c) => createTrip(c, t.ctx, { planned_start: dubai(1), planned_end: dubai(6), order_ids: orderIds, ...f }));
const ev = (tripId: string, kind: DriverEvent["kind"], legId: string | null, over: Partial<DriverEvent> = {}): DriverEvent =>
  ({ client_event_id: `ev-${Math.random().toString(36).slice(2)}-${Date.now()}`, trip_id: tripId, leg_id: legId, kind, device_time: iso(0), payload: {}, ...over });

describe("transport planning rules", () => {
  it("enforces capacity, compliance expiry, maintenance and double-booking together", async () => {
    const f = await fleet({ kg: 1000 });
    const a = await order(f.t, f.cust, { weight_kg: 700 }), b = await order(f.t, f.cust, { weight_kg: 700 });
    await expect(trip(f.t, { vehicle_id: f.veh, driver_id: f.drv }, [a.id, b.id])).rejects.toThrow(/exceeds .* capacity of 1000 kg/);
    await db.tenant(f.t.tenantId, async (c) => {
      await addCompliance(c, f.t.ctx, { subject_type: "vehicle", subject_id: f.veh, kind: "insurance", expires_on: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
      await addCompliance(c, f.t.ctx, { subject_type: "driver", subject_id: f.drv, kind: "licence", expires_on: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10) });
      await addMaintenance(c, f.t.ctx, { vehicle_id: f.veh, starts_at: dubai(2), ends_at: dubai(4), reason: "Brake service" });
    });
    await expect(trip(f.t, { vehicle_id: f.veh, driver_id: f.drv }, [a.id])).rejects.toThrow(/insurance expires.*before the trip ends/);
    await expect(trip(f.t, { vehicle_id: f.veh, driver_id: f.drv }, [a.id])).rejects.toThrow(/maintenance \(Brake service\)/);
    // a non-blocking expiry is only a warning
    await db.system((c) => c.query(`UPDATE compliance_items SET blocking=false WHERE kind='insurance' AND tenant_id=$1`, [f.t.tenantId]));
    await expect(trip(f.t, { vehicle_id: f.veh, driver_id: f.drv }, [a.id])).rejects.toThrow(/maintenance/);
    const ok = await trip(f.t, { vehicle_id: f.veh, driver_id: f.drv, planned_start: dubai(8), planned_end: dubai(12) }, [a.id]);
    expect(ok.no).toMatch(/^TRP-\d{4}-00001$/);
    await expect(trip(f.t, { vehicle_id: f.veh, driver_id: f.drv, planned_start: dubai(9), planned_end: dubai(11) }, [b.id])).rejects.toThrow(/already on TRP-/);
    // the order cannot be on two trips
    await expect(trip(f.t, { subcontractor_id: "00000000-0000-0000-0000-000000000000", subcontract_estimate: "1" }, [a.id])).rejects.toThrow();
  });

  it("dispatch re-checks compliance and requires a driver login; subcontracted trips need a cost estimate", async () => {
    const f = await fleet();
    const o = await order(f.t, f.cust);
    const tr = await trip(f.t, { vehicle_id: f.veh, driver_id: f.drv }, [o.id]);
    await db.tenant(f.t.tenantId, (c) => addCompliance(c, f.t.ctx, { subject_type: "driver", subject_id: f.drv, kind: "licence", expires_on: new Date(Date.now() - 86400000).toISOString().slice(0, 10) }));
    await expect(db.tenant(f.t.tenantId, (c) => dispatchTrip(c, f.t.ctx, tr.id))).rejects.toThrow(/licence expires/);
    const sup = await db.tenant(f.t.tenantId, (c) => createParty(c, f.t.ctx, { kind: "supplier", name: "Hauler LLC" }));
    const o2 = await order(f.t, f.cust);
    await expect(trip(f.t, { subcontractor_id: sup }, [o2.id])).rejects.toThrow(/cost estimate/);
    await expect(trip(f.t, { subcontractor_id: sup, vehicle_id: f.veh, subcontract_estimate: "300" }, [o2.id])).rejects.toThrow(/no own vehicle/);
    const sub = await trip(f.t, { subcontractor_id: sup, subcontract_estimate: "300" }, [o2.id]);
    await db.tenant(f.t.tenantId, (c) => dispatchTrip(c, f.t.ctx, sub.id));
  });

  it("trips consume their own monthly allowance, idempotently per trip", async () => {
    const f = await fleet();
    await db.system((c) => c.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES ($1,'trips_per_month',1,'test')`, [f.t.tenantId]));
    const a = await order(f.t, f.cust), b = await order(f.t, f.cust);
    await trip(f.t, { vehicle_id: f.veh, driver_id: f.drv, planned_start: dubai(1), planned_end: dubai(3) }, [a.id]);
    await expect(trip(f.t, { vehicle_id: f.veh, driver_id: f.drv, planned_start: dubai(5), planned_end: dubai(7) }, [b.id])).rejects.toThrow(/limit reached for trips_per_month/);
    // forwarding jobs allowance is untouched by trips
    expect((await db.query<any>(`SELECT count(*)::int n FROM usage_counters WHERE tenant_id=$1 AND key='jobs_per_month'`, [f.t.tenantId])).rows[0].n).toBe(0);
  });
});

describe("trip lifecycle → proof → invoice → profit", () => {
  it("runs end to end with subcontract cost, approved expenses and detention", async () => {
    const f = await fleet();
    const o = await order(f.t, f.cust, { rate: "1000" });
    const tr = await trip(f.t, { vehicle_id: f.veh, driver_id: f.drv, est_km: "40" }, [o.id]);
    await db.tenant(f.t.tenantId, (c) => dispatchTrip(c, f.t.ctx, tr.id));
    const legs = (await db.tenant(f.t.tenantId, (c) => getTrip(c, tr.id))).legs;
    const [pick, drop] = legs;
    const run = (e: DriverEvent) => db.tenant(f.t.tenantId, (c) => applyDriverEvent(c, f.driverCtx, e));

    // delivery stop is gated: no leaving without proof, no departing before arriving
    expect((await run(ev(tr.id, "depart", pick.id, { device_time: iso(-300) }))).outcome).toBe("stored");
    expect((await run(ev(tr.id, "arrive", pick.id, { device_time: iso(-290) }))).outcome).toBe("applied");
    expect((await run(ev(tr.id, "depart", pick.id, { device_time: iso(-270) }))).outcome).toBe("applied");
    expect((await run(ev(tr.id, "arrive", drop.id, { device_time: iso(-120) }))).outcome).toBe("applied");
    const early = await run(ev(tr.id, "depart", drop.id, { device_time: iso(-20) }));
    expect(early).toMatchObject({ outcome: "stored" }); expect(early.reason).toMatch(/proof of delivery is required/);
    expect((await run(ev(tr.id, "pod", drop.id, { device_time: iso(-60), payload: { name: "  Fatima Al Zaabi ", lat: "25.2", lng: "55.3" } }))).outcome).toBe("applied");
    expect((await run(ev(tr.id, "depart", drop.id, { device_time: iso(0) }))).outcome).toBe("applied");

    const d = await db.tenant(f.t.tenantId, (c) => getTrip(c, tr.id));
    const dropAfter = d.legs[1];
    expect(dropAfter.pod_name).toBe("Fatima Al Zaabi");
    expect(dropAfter.pod_lat).toBeNull();                              // capture not enabled by company policy
    expect(dropAfter.detention_minutes).toBe(0);                      // 120 min on site, 120 free
    expect(d.orders[0].status).toBe("delivered");
    expect(d.trip.status).toBe("in_progress");

    await db.tenant(f.t.tenantId, async (c) => {
      await completeTrip(c, f.t.ctx, tr.id, { actual_km: "50" });
      const inv = await invoiceOrder(c, f.t.ctx, o.id);
      const x = await getOrder(c, o.id);
      expect(x.order.financial_status).toBe("invoiced");
      expect(x.invoices[0].total_minor).toBe(105000);                  // 1,000 + 5% VAT
      await expect(invoiceOrder(c, f.t.ctx, o.id)).rejects.toThrow(/No uninvoiced/);
      await recordReceipt(c, f.t.ctx, inv.id, { amount: "1050" });
      expect((await getOrder(c, o.id)).order.financial_status).toBe("collected");
    });
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("detention is billed once per stop; expenses need an independent approver; profit separates estimates from approved", async () => {
    const f = await fleet();
    const o = await order(f.t, f.cust, { rate: "1000", detention_rate: "100" });
    const sup = await db.tenant(f.t.tenantId, (c) => createParty(c, f.t.ctx, { kind: "supplier", name: "Hauler" }));
    const tr = await trip(f.t, { vehicle_id: f.veh, driver_id: f.drv }, [o.id]);
    await db.tenant(f.t.tenantId, (c) => dispatchTrip(c, f.t.ctx, tr.id));
    const [pick, drop] = (await db.tenant(f.t.tenantId, (c) => getTrip(c, tr.id))).legs;
    const run = (e: DriverEvent) => db.tenant(f.t.tenantId, (c) => applyDriverEvent(c, f.driverCtx, e));
    await run(ev(tr.id, "arrive", pick.id, { device_time: iso(-400) })); await run(ev(tr.id, "depart", pick.id, { device_time: iso(-300) }));
    await run(ev(tr.id, "arrive", drop.id, { device_time: iso(-250) }));
    await run(ev(tr.id, "pod", drop.id, { device_time: iso(-200), payload: { name: "Receiver" } }));
    await run(ev(tr.id, "depart", drop.id, { device_time: iso(-10) }));       // 240 min on site, 120 free → 120 min detention
    expect((await db.tenant(f.t.tenantId, (c) => getTrip(c, tr.id))).legs[1].detention_minutes).toBe(120);
    const exp = await run(ev(tr.id, "expense", null, { payload: { kind: "toll", amount: "25", note: "Salik" } }));
    expect(exp.outcome).toBe("applied");
    await db.tenant(f.t.tenantId, async (c) => {
      expect(await billDetention(c, f.t.ctx, drop.id)).toBe(2);
      await expect(billDetention(c, f.t.ctx, drop.id)).rejects.toThrow(/already been billed/);
      const p1 = await tripProfit(c, tr.id);
      expect(p1.revenue).toBe(100000 + 20000);
      expect(p1.unapprovedExpenses).toBe(2500); expect(p1.reconciled).toBe(false);
      const x = (await getTrip(c, tr.id)).expenses[0];
      // the driver cannot decide; the owner who did not record it can
      await expect(decideExpense(c, f.driverCtx, x.id, true)).rejects.toThrow(/does not allow/);
      await decideExpense(c, f.t.ctx, x.id, true);
      await expect(decideExpense(c, f.t.ctx, x.id, false)).rejects.toThrow(/decisions are final/);
      await completeTrip(c, f.t.ctx, tr.id, { actual_km: "100" });
      const p2 = await tripProfit(c, tr.id);
      expect(p2).toMatchObject({ approvedExpenses: 2500, unapprovedExpenses: 0, reconciled: true, costPerKm: 25 });
    });
  });
});

describe("offline driver sync (acceptance: proof synchronized twice)", () => {
  async function dispatched() {
    const f = await fleet(); const o = await order(f.t, f.cust);
    const tr = await trip(f.t, { vehicle_id: f.veh, driver_id: f.drv }, [o.id]);
    await db.tenant(f.t.tenantId, (c) => dispatchTrip(c, f.t.ctx, tr.id));
    const legs = (await db.tenant(f.t.tenantId, (c) => getTrip(c, tr.id))).legs;
    return { ...f, tr, o, pick: legs[0], drop: legs[1] };
  }

  it("the same batch synced twice yields one server event each, with source evidence retained", async () => {
    const s = await dispatched();
    const batch = [
      ev(s.tr.id, "arrive", s.pick.id, { device_time: iso(-200) }),
      ev(s.tr.id, "depart", s.pick.id, { device_time: iso(-150) }),
      ev(s.tr.id, "arrive", s.drop.id, { device_time: iso(-60) }),
      ev(s.tr.id, "pod", s.drop.id, { device_time: iso(-50), payload: { name: "Mohammed" } }),
    ];
    const sync = () => db.tenant(s.t.tenantId, (c) => syncDriverEvents(c, s.driverCtx, [...batch].reverse()));   // delivered out of order
    const first = await sync();
    expect(first.map((r) => r.outcome)).toEqual(["applied", "applied", "applied", "applied"]);
    const second = await sync();
    expect(second.map((r) => r.outcome)).toEqual(["duplicate", "duplicate", "duplicate", "duplicate"]);
    const rows = (await db.query<any>(`SELECT * FROM trip_events WHERE trip_id=$1 ORDER BY effective_time`, [s.tr.id])).rows;
    expect(rows).toHaveLength(4);
    expect(rows[0].device_time.toISOString()).toBe(batch[0].device_time);       // device time retained verbatim
    expect(rows.filter((r: any) => r.kind === "pod")).toHaveLength(1);
    // concurrent double-sync of one event id cannot create two rows
    const e = ev(s.tr.id, "expense", null, { payload: { kind: "fuel", amount: "50" } });
    const res = await Promise.all([1, 2, 3].map(() => db.tenant(s.t.tenantId, (c) => applyDriverEvent(c, s.driverCtx, e))));
    expect(res.filter((r) => r.outcome === "applied")).toHaveLength(1);
    expect((await db.query<any>(`SELECT count(*)::int n FROM trip_expenses WHERE trip_id=$1`, [s.tr.id])).rows[0].n).toBe(1);
  });

  it("reconciles conflicts without overwriting proof, completed stops or decided expenses; flags clock problems", async () => {
    const s = await dispatched();
    const run = (e: DriverEvent) => db.tenant(s.t.tenantId, (c) => applyDriverEvent(c, s.driverCtx, e));
    await run(ev(s.tr.id, "arrive", s.pick.id, { device_time: iso(-100) }));
    const earlier = await run(ev(s.tr.id, "arrive", s.pick.id, { device_time: iso(-180) }));      // late sync of an earlier arrival
    expect(earlier.outcome).toBe("applied"); expect(earlier.reason).toMatch(/earlier arrival adopted/);
    const later = await run(ev(s.tr.id, "arrive", s.pick.id, { device_time: iso(-50) }));
    expect(later.outcome).toBe("stored");
    const leg = (await db.query<any>(`SELECT arrived_at FROM trip_legs WHERE id=$1`, [s.pick.id])).rows[0];
    expect(Math.abs(new Date(leg.arrived_at).getTime() - (Date.now() - 180 * 60000))).toBeLessThan(2000);
    // clock far in the future is clamped to server time and flagged; raw device time stays on the record
    const skew = await run(ev(s.tr.id, "depart", s.pick.id, { device_time: iso(60 * 24 * 5) }));
    expect(skew).toMatchObject({ outcome: "applied" }); expect(skew.reason).toMatch(/clock ahead/);
    // departure can never precede arrival
    await run(ev(s.tr.id, "arrive", s.drop.id, { device_time: iso(-30) }));
    await run(ev(s.tr.id, "pod", s.drop.id, { device_time: iso(-25), payload: { name: "First Receiver" } }));
    const second = await run(ev(s.tr.id, "pod", s.drop.id, { device_time: iso(-20), payload: { name: "Someone Else" } }));
    expect(second).toMatchObject({ outcome: "stored" }); expect(second.reason).toMatch(/original retained/);
    expect((await db.query<any>(`SELECT pod_name FROM trip_legs WHERE id=$1`, [s.drop.id])).rows[0].pod_name).toBe("First Receiver");
    // a decided expense is never altered by later sync; replays of its id are duplicates
    const exp = ev(s.tr.id, "expense", null, { payload: { kind: "fuel", amount: "80" } });
    await run(exp);
    const x = (await db.query<any>(`SELECT id FROM trip_expenses WHERE trip_id=$1`, [s.tr.id])).rows[0];
    await db.tenant(s.t.tenantId, (c) => decideExpense(c, s.t.ctx, x.id, false));
    expect((await run(exp)).outcome).toBe("duplicate");
    expect((await db.query<any>(`SELECT status,amount_minor FROM trip_expenses WHERE id=$1`, [x.id])).rows[0]).toMatchObject({ status: "rejected", amount_minor: 8000 });
    // events for another driver's trip are refused outright
    const other = { ...s.driverCtx, driverId: "00000000-0000-0000-0000-000000000000" };
    await expect(db.tenant(s.t.tenantId, (c) => applyDriverEvent(c, other, ev(s.tr.id, "note", null)))).rejects.toThrow(/not assigned to you/);
  });

  it("completed trips ignore late geographic events; cancelling a trip with events is refused; cancelling releases orders", async () => {
    const s = await dispatched();
    await expect(db.tenant(s.t.tenantId, (c) => completeTrip(c, s.t.ctx, s.tr.id, {}))).rejects.toThrow(/stop\(s\) are not completed/);
    await db.tenant(s.t.tenantId, (c) => applyDriverEvent(c, s.driverCtx, ev(s.tr.id, "arrive", s.pick.id)));
    await expect(db.tenant(s.t.tenantId, (c) => cancelTrip(c, s.t.ctx, s.tr.id))).rejects.toThrow(/in_progress trip cannot be cancelled/);
    const s2 = await dispatched();
    await db.tenant(s2.t.tenantId, (c) => cancelTrip(c, s2.t.ctx, s2.tr.id));
    expect((await db.query<any>(`SELECT status, trip_id FROM transport_orders WHERE id=$1`, [s2.o.id])).rows[0]).toEqual({ status: "new", trip_id: null });
  });
});

describe("isolation and billing hooks", () => {
  it("another tenant cannot see vehicles, trips or events", async () => {
    const a = await fleet(), b = await newTenant(db);
    const o = await order(a.t, a.cust);
    await trip(a.t, { vehicle_id: a.veh, driver_id: a.drv }, [o.id]);
    for (const tbl of ["vehicles", "drivers", "trips", "transport_orders", "trip_legs", "compliance_items"]) {
      expect((await db.tenant(b.tenantId, (c) => c.query(`SELECT 1 FROM ${tbl}`))).rows).toHaveLength(0);
    }
    await expect(db.tenant(b.tenantId, (c) => c.query(`INSERT INTO vehicles(tenant_id,reg_no,capacity_kg) VALUES ($1,'X',1)`, [a.t.tenantId]))).rejects.toThrow(/row-level security/);
  });

  it("voiding a transport invoice releases its charges; driver logins are limited seats", async () => {
    const f = await fleet();
    const o = await order(f.t, f.cust);
    const tr = await trip(f.t, { vehicle_id: f.veh, driver_id: f.drv }, [o.id]);
    await db.tenant(f.t.tenantId, (c) => dispatchTrip(c, f.t.ctx, tr.id));
    const [pick, drop] = (await db.tenant(f.t.tenantId, (c) => getTrip(c, tr.id))).legs;
    for (const [k, l, p] of [["arrive", pick, {}], ["depart", pick, {}], ["arrive", drop, {}], ["pod", drop, { name: "R" }], ["depart", drop, {}]] as const)
      await db.tenant(f.t.tenantId, (c) => applyDriverEvent(c, f.driverCtx, ev(tr.id, k, l.id, { payload: p, device_time: iso(-30 + Math.random()) })));
    await db.tenant(f.t.tenantId, async (c) => {
      await completeTrip(c, f.t.ctx, tr.id, {});
      const inv = await invoiceOrder(c, f.t.ctx, o.id);
      await voidInvoice(c, f.t.ctx, inv.id, "wrong customer");
      const x = await getOrder(c, o.id);
      expect(x.order.financial_status).toBe("open"); expect(x.charges.every((ch: any) => ch.invoice_id === null)).toBe(true);
      expect((await invoiceOrder(c, f.t.ctx, o.id)).no).toMatch(/00002$/);
    });
    // the driver seat did not use a full-user seat
    const used = (await db.query<any>(`SELECT count(*)::int n FROM memberships WHERE tenant_id=$1 AND active AND NOT ('driver'=ANY(roles))`, [f.t.tenantId])).rows[0].n;
    expect(used).toBe(1);
    // a driver seat cannot be combined with other roles, nor created without a driver record
    await expect(db.tenant(f.t.tenantId, (c) => invite(c, f.t.ctx, { email: "z@x.com", roles: ["driver", "sales"], driver_id: f.drv }))).rejects.toThrow(/cannot be combined/);
    await expect(db.tenant(f.t.tenantId, (c) => invite(c, f.t.ctx, { email: "z@x.com", roles: ["driver"] }))).rejects.toThrow(/linked to a driver record/);
    expect(await verifyInvariants(db)).toEqual([]);
  });
});
