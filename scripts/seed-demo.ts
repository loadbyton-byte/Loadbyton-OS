// Populates a SEPARATE demo database with a realistic sample company. Never run against production data:
// real workspaces start empty (blueprint §10). Usage: DATABASE_URL=<demo db> npm run seed-demo
import { openDb } from "../src/db/client.js";
import { registerCompany } from "../src/platform/tenants.js";
import { ensureCatalog } from "../src/platform/catalog.js";
import { permsFor } from "../src/lib/perms.js";
import { createEnquiry, createParty, createRate } from "../src/ops/crm.js";
import { acceptQuote, approveQuote, createQuote, sendQuote, submitQuote } from "../src/ops/quotes.js";
import { getJob, recordMilestone } from "../src/ops/jobs.js";
import { invoiceJob } from "../src/ops/finance.js";
import { acceptInvite, invite } from "../src/ops/team.js";
import { addCompliance, addMaintenance, applyDriverEvent, completeTrip, createDriver, createOrder, createTrip, createVehicle, dispatchTrip, getTrip } from "../src/ops/transport.js";

if (process.env.NODE_ENV === "production") { console.error("Refusing to seed demo data in production."); process.exit(1); }
const db = await openDb();
await db.system((c) => ensureCatalog(c));
const email = "demo@loadbyton.example";
if ((await db.query(`SELECT 1 FROM users WHERE email=$1`, [email])).rows.length) { console.log("Demo already seeded."); await db.close(); process.exit(0); }
const r = await registerCompany(db, { company: "DEMO Gulf Gate Freight", contactName: "Demo Owner", email, password: "demo-password-123", sectors: ["freight-forwarding"], goal: "Stop losing margin on jobs" });
const ctx = { userId: r.userId, tenantId: r.tenantId, roles: ["owner"], perms: permsFor(["owner"]), partyId: null, driverId: null, readOnly: false, supportStaffId: null };
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
await db.tenant(r.tenantId, async (c) => {
  const cust = await createParty(c, ctx, { kind: "customer", name: "DEMO Desert Trading FZE", credit_limit: "50000", email: "ops@desert.example" });
  const cust2 = await createParty(c, ctx, { kind: "customer", name: "DEMO Marina Retail LLC", credit_limit: "20000" });
  const line = await createParty(c, ctx, { kind: "supplier", name: "DEMO Ocean Line" });
  const truck = await createParty(c, ctx, { kind: "supplier", name: "DEMO Trucking Co" });
  await createRate(c, ctx, { supplier_id: line, mode: "ocean", origin: "Shanghai", destination: "Jebel Ali", charge_name: "Ocean freight 40HC", basis: "per_container", unit_cost: "6500", valid_from: day(-10), valid_to: day(20) });
  for (const [party, o, d, sell, cost] of [[cust, "Shanghai", "Jebel Ali", "9000", "6500"], [cust2, "Hamburg", "Jebel Ali", "5200", "4100"]] as const) {
    const e = await createEnquiry(c, ctx, { party_id: party, mode: "ocean", origin: o, destination: d, cargo_desc: "Palletised goods", weight_kg: 3000, ready_date: day(6), external_ref: `demo-${o}` });
    const q = await createQuote(c, ctx, { enquiry_id: e.id, party_id: party, valid_until: day(14), lines: [{ description: `Ocean freight ${o}–${d}`, qty: 1, unit_sell: sell, unit_cost: cost, supplier_id: line, tax_code: "ZR0" }, { description: "Inland haulage", qty: 1, unit_sell: "600", unit_cost: "420", supplier_id: truck }] });
    const s = await submitQuote(c, ctx, q.id);
    if (s.status === "pending_approval") await approveQuote(c, ctx, q.id);
    await sendQuote(c, ctx, q.id);
    const { jobId } = await acceptQuote(c, ctx, q.id);
    if (party === cust) {
      const j = await getJob(c, jobId);
      for (const m of j.milestones.filter((x: any) => x.code !== "delivered")) await recordMilestone(c, ctx, m.id);
    }
    if (party === cust2) { /* leave planned */ }
  }
});

// ── second demo company: road transport (separate sector, separate tenant)
const tEmail = "transport@loadbyton.example";
const tr = await registerCompany(db, { company: "DEMO Al Noor Transport", contactName: "Demo Dispatcher", email: tEmail, password: "demo-password-123", sectors: ["road-transport"], goal: "Control supplier costs" });
const tctx = { userId: tr.userId, tenantId: tr.tenantId, roles: ["owner"], perms: permsFor(["owner"]), partyId: null, driverId: null, readOnly: false, supportStaffId: null };
const hrs = (h: number) => new Date(Date.now() + h * 3600_000 + 4 * 3600_000).toISOString().slice(0, 16);
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const eid = () => `seed-${Math.random().toString(36).slice(2)}-${Date.now()}`;
let driverToken = "", tripIds = { done: "", moving: "" };
await db.tenant(tr.tenantId, async (c) => {
  const cust = await createParty(c, tctx, { kind: "customer", name: "DEMO Emirates Retail LLC" });
  const cust2 = await createParty(c, tctx, { kind: "customer", name: "DEMO Gulf Building Supplies" });
  const hauler = await createParty(c, tctx, { kind: "supplier", name: "DEMO Sharjah Haulage" });
  const truck1 = await createVehicle(c, tctx, { reg_no: "DXB K 4471", kind: "3-ton truck", capacity_kg: 3000, capacity_cbm: 18 });
  const truck2 = await createVehicle(c, tctx, { reg_no: "SHJ P 2208", kind: "10-ton truck", capacity_kg: 10000, capacity_cbm: 40 });
  const d1 = await createDriver(c, tctx, { name: "Imran Khan", phone: "+971 50 000 0001", licence_no: "DL-1001" });
  const d2 = await createDriver(c, tctx, { name: "Saeed Al Mazrouei", phone: "+971 50 000 0002", licence_no: "DL-1002" });
  const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  await addCompliance(c, tctx, { subject_type: "vehicle", subject_id: truck1, kind: "registration", expires_on: day(400) });
  await addCompliance(c, tctx, { subject_type: "vehicle", subject_id: truck1, kind: "insurance", expires_on: day(18) });
  await addCompliance(c, tctx, { subject_type: "vehicle", subject_id: truck2, kind: "inspection", expires_on: day(200) });
  await addCompliance(c, tctx, { subject_type: "driver", subject_id: d1, kind: "licence", expires_on: day(300) });
  await addCompliance(c, tctx, { subject_type: "driver", subject_id: d2, kind: "licence", expires_on: day(25) });
  await addMaintenance(c, tctx, { vehicle_id: truck2, starts_at: hrs(48), ends_at: hrs(72), reason: "Annual service" });
  const tok = await invite(c, tctx, { email: "driver1@loadbyton.example", roles: ["driver"], driver_id: d1 });
  driverToken = tok;
  const mk = (party: string, p: string, d: string, kg: number, rate: string) => createOrder(c, tctx, { party_id: party, pickup_address: p, delivery_address: d, cargo_desc: "Palletised goods", weight_kg: kg, volume_cbm: kg / 200, rate, detention_rate: "120", ready_at: hrs(0), deliver_by: hrs(8) });
  const o1 = await mk(cust, "Jebel Ali Free Zone, Dubai", "Dubai Mall service yard", 900, "650");
  const o2 = await mk(cust, "Jebel Ali Free Zone, Dubai", "Mirdif City Centre dock 3", 700, "600");
  const o3 = await mk(cust2, "Sharjah Industrial Area 12", "Al Ain Industrial Area", 4200, "1800");
  await mk(cust2, "Ras Al Khor, Dubai", "Fujairah Port", 1500, "1400");
  const done = await createTrip(c, tctx, { vehicle_id: truck1, driver_id: d1, planned_start: hrs(-30), planned_end: hrs(-24), est_km: "62", order_ids: [o1.id] });
  const moving = await createTrip(c, tctx, { vehicle_id: truck1, driver_id: d1, planned_start: hrs(-1), planned_end: hrs(7), est_km: "90", order_ids: [o2.id] });
  await createTrip(c, tctx, { subcontractor_id: hauler, subcontract_estimate: "1250", planned_start: hrs(2), planned_end: hrs(9), est_km: "160", order_ids: [o3.id] });
  tripIds = { done: done.id, moving: moving.id };
});
const acc = await acceptInvite(db, driverToken, { name: "Imran Khan", password: "demo-password-123" });
const dctx = { userId: acc.userId, tenantId: tr.tenantId, roles: ["driver"], perms: permsFor(["driver"]), partyId: null, driverId: (await db.query<any>(`SELECT id FROM drivers WHERE tenant_id=$1 AND name='Imran Khan'`, [tr.tenantId])).rows[0].id, readOnly: false, supportStaffId: null };
const { done, moving } = tripIds;
await db.tenant(tr.tenantId, async (c) => {
  await dispatchTrip(c, tctx, done); await dispatchTrip(c, tctx, moving);
  const run = (trip: string, leg: any, kind: any, mins: number, payload: any = {}) => applyDriverEvent(c, dctx, { client_event_id: eid(), trip_id: trip, leg_id: leg?.id ?? null, kind, device_time: ago(mins), payload });
  const L1 = (await getTrip(c, done)).legs;
  await run(done, L1[0], "arrive", 1700); await run(done, L1[0], "depart", 1670); await run(done, L1[1], "arrive", 1600);
  await run(done, L1[1], "pod", 1585, { name: "Khalid Al Suwaidi" }); await run(done, L1[1], "depart", 1550);
  await run(done, null, "expense", 1600, { kind: "toll", amount: "16", note: "Salik x4" });
  await completeTrip(c, tctx, done, { actual_km: "64" });
  const L2 = (await getTrip(c, moving)).legs;
  await run(moving, L2[0], "arrive", 50); await run(moving, L2[0], "depart", 30);
});
console.log(`Demo seeded.\n  Freight owner : ${email} / demo-password-123\n  Transport owner: ${tEmail} / demo-password-123\n  Driver (phone) : driver1@loadbyton.example / demo-password-123`);
await db.close();
