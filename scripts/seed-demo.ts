// Populates a SEPARATE demo database with realistic sample companies. Never run against production data:
// real workspaces start empty (blueprint §10). Usage: DATABASE_URL=<demo db> npm run seed-demo
//
// Eight sign-ins to explore (all demo-password-123):
//   showcase@…  one workspace with EVERY built sector, the Enterprise plan, a full team, a customer-portal login, two phone logins and build requests
//   six single-sector companies (freight, transport, fulfilment, warehouse, delivery, customs) as a client on one pack would see them
//   admin@… / auditor@…  platform staff for /admin (MFA: the seed prints the authenticator secrets once)
// Run the demo environment with BROCHURE_MODE=false so the operating screens are reachable; with the default brochure mode a client sees only the request tracker.
import { openDb } from "../src/db/client.js";
import { config } from "../src/config.js";
import { registerCompany } from "../src/platform/tenants.js";
import { currentPlans, ensureCatalog } from "../src/platform/catalog.js";
import { applyPlanEntitlements } from "../src/platform/entitlements.js";
import { createStaff, requestGrant } from "../src/platform/admin.js";
import { createRequest, staffUpdateRequest, type NewRequest } from "../src/platform/requests.js";
import { buildMockEvent, createOrder as createCheckoutOrder, processPaymentEvent } from "../src/platform/billing.js";
import { enabledProviders } from "../src/platform/payments/index.js";
import { processProvisioningQueue } from "../src/platform/provisioning.js";
import { permsFor, type Ctx } from "../src/lib/perms.js";
import { createEnquiry, createParty, createRate } from "../src/ops/crm.js";
import { acceptQuote, approveQuote, createQuote, sendQuote, submitQuote } from "../src/ops/quotes.js";
import { getJob, recordMilestone } from "../src/ops/jobs.js";
import { acceptInvite, invite } from "../src/ops/team.js";
import { addLine as cusAddLine, approveCase as cusApprove, attachEvidence as cusAttach, createCase as cusCreate, getCase as cusGet, receiveDeposit as cusDeposit, recordAssessment as cusAssess, recordSubmission as cusSubmit, submitForReview as cusReview } from "../src/ops/customs.js";
import { createInbound as fulCreateInbound, createLocation as fulCreateLocation, createOrder as createFulfilOrder, createReturn, createSku as fulCreateSku, getFulfilOrder, getInbound as fulGetInbound, getReturn, packScan, pickOrder, receiveInbound, receiveReturn, requestAdjustment, shipOrder } from "../src/ops/fulfilment.js";
import { runStorageCharges, setRate as fulSetRate } from "../src/ops/fulfil-billing.js";

import {
  accrueStorage, addFoundLine, allocateOutbound, closeInbound, confirmPick, createInbound, createLocation, createOutbound, createSku, createWarehouse,
  decideCountLine, dispatchOutbound, getCount, getInbound, receiveLine, recordCount, setRate, startCount, submitCount,
} from "../src/ops/warehouse.js";
import {
  applyRiderEvent, createRemittance as dlvRemit, createRider, createRun, createShipment, setRate as dlvSetRate, settleRider, startRun,
} from "../src/ops/delivery.js";
import { addCompliance, addMaintenance, applyDriverEvent, completeTrip, createDriver, createOrder, createTrip, createVehicle, dispatchTrip, getTrip } from "../src/ops/transport.js";

if (process.env.NODE_ENV === "production") { console.error("Refusing to seed demo data in production."); process.exit(1); }
const db = await openDb();
await db.system((c) => ensureCatalog(c));

const PASSWORD = "demo-password-123";
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const hrs = (h: number) => new Date(Date.now() + h * 3600_000 + 4 * 3600_000).toISOString().slice(0, 16);
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const eid = () => `seed-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const userExists = async (email: string) => (await db.query(`SELECT 1 FROM users WHERE email=$1`, [email])).rows.length > 0;

interface CompanySpec { company: string; contact: string; email: string; sectors: string[]; goal: string }
/** A workspace to fill. `mail` names the phone/team logins so two workspaces never fight over one address. */
interface Target { tenantId: string; userId: string; ctx: Ctx; mail: (local: string) => string }
const ownerCtx = (tenantId: string, userId: string): Ctx => ({ userId, tenantId, roles: ["owner"], perms: permsFor(["owner"]), partyId: null, driverId: null, readOnly: false, supportStaffId: null });
async function openCompany(spec: CompanySpec, prefix = ""): Promise<Target> {
  const r = await registerCompany(db, { company: spec.company, contactName: spec.contact, email: spec.email, password: PASSWORD, sectors: spec.sectors, goal: spec.goal });
  return { tenantId: r.tenantId, userId: r.userId, ctx: ownerCtx(r.tenantId, r.userId), mail: (local) => `${prefix}${local}@loadbyton.example` };
}

// ── freight forwarding: two enquiries become quotes and jobs; one job is worked through its milestones, the other left planned
async function seedFreight(t: Target) {
  const { ctx } = t;
  await db.tenant(t.tenantId, async (c) => {
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
}

// ── road transport: one trip finished, one on the road, one subcontracted; compliance deadlines and a maintenance window; a driver phone login
async function seedTransport(t: Target) {
  const { ctx } = t;
  let driverToken = "", tripIds = { done: "", moving: "" };
  await db.tenant(t.tenantId, async (c) => {
    const cust = await createParty(c, ctx, { kind: "customer", name: "DEMO Emirates Retail LLC" });
    const cust2 = await createParty(c, ctx, { kind: "customer", name: "DEMO Gulf Building Supplies" });
    const hauler = await createParty(c, ctx, { kind: "supplier", name: "DEMO Sharjah Haulage" });
    const truck1 = await createVehicle(c, ctx, { reg_no: "DXB K 4471", kind: "3-ton truck", capacity_kg: 3000, capacity_cbm: 18 });
    const truck2 = await createVehicle(c, ctx, { reg_no: "SHJ P 2208", kind: "10-ton truck", capacity_kg: 10000, capacity_cbm: 40 });
    const d1 = await createDriver(c, ctx, { name: "Imran Khan", phone: "+971 50 000 0001", licence_no: "DL-1001" });
    const d2 = await createDriver(c, ctx, { name: "Saeed Al Mazrouei", phone: "+971 50 000 0002", licence_no: "DL-1002" });
    await addCompliance(c, ctx, { subject_type: "vehicle", subject_id: truck1, kind: "registration", expires_on: day(400) });
    await addCompliance(c, ctx, { subject_type: "vehicle", subject_id: truck1, kind: "insurance", expires_on: day(18) });
    await addCompliance(c, ctx, { subject_type: "vehicle", subject_id: truck2, kind: "inspection", expires_on: day(200) });
    await addCompliance(c, ctx, { subject_type: "driver", subject_id: d1, kind: "licence", expires_on: day(300) });
    await addCompliance(c, ctx, { subject_type: "driver", subject_id: d2, kind: "licence", expires_on: day(25) });
    await addMaintenance(c, ctx, { vehicle_id: truck2, starts_at: hrs(48), ends_at: hrs(72), reason: "Annual service" });
    driverToken = await invite(c, ctx, { email: t.mail("driver1"), roles: ["driver"], driver_id: d1 });
    const mk = (party: string, p: string, d: string, kg: number, rate: string) => createOrder(c, ctx, { party_id: party, pickup_address: p, delivery_address: d, cargo_desc: "Palletised goods", weight_kg: kg, volume_cbm: kg / 200, rate, detention_rate: "120", ready_at: hrs(0), deliver_by: hrs(8) });
    const o1 = await mk(cust, "Jebel Ali Free Zone, Dubai", "Dubai Mall service yard", 900, "650");
    const o2 = await mk(cust, "Jebel Ali Free Zone, Dubai", "Mirdif City Centre dock 3", 700, "600");
    const o3 = await mk(cust2, "Sharjah Industrial Area 12", "Al Ain Industrial Area", 4200, "1800");
    await mk(cust2, "Ras Al Khor, Dubai", "Fujairah Port", 1500, "1400");
    const done = await createTrip(c, ctx, { vehicle_id: truck1, driver_id: d1, planned_start: hrs(-30), planned_end: hrs(-24), est_km: "62", order_ids: [o1.id] });
    const moving = await createTrip(c, ctx, { vehicle_id: truck1, driver_id: d1, planned_start: hrs(-1), planned_end: hrs(7), est_km: "90", order_ids: [o2.id] });
    await createTrip(c, ctx, { subcontractor_id: hauler, subcontract_estimate: "1250", planned_start: hrs(2), planned_end: hrs(9), est_km: "160", order_ids: [o3.id] });
    tripIds = { done: done.id, moving: moving.id };
  });
  const acc = await acceptInvite(db, driverToken, { name: "Imran Khan", password: PASSWORD });
  const dctx: Ctx = { userId: acc.userId, tenantId: t.tenantId, roles: ["driver"], perms: permsFor(["driver"]), partyId: null, driverId: (await db.query<any>(`SELECT id FROM drivers WHERE tenant_id=$1 AND name='Imran Khan'`, [t.tenantId])).rows[0].id, readOnly: false, supportStaffId: null };
  const { done, moving } = tripIds;
  await db.tenant(t.tenantId, async (c) => {
    await dispatchTrip(c, ctx, done); await dispatchTrip(c, ctx, moving);
    const run = (trip: string, leg: any, kind: any, mins: number, payload: any = {}) => applyDriverEvent(c, dctx, { client_event_id: eid(), trip_id: trip, leg_id: leg?.id ?? null, kind, device_time: ago(mins), payload });
    const L1 = (await getTrip(c, done)).legs;
    await run(done, L1[0], "arrive", 1700); await run(done, L1[0], "depart", 1670); await run(done, L1[1], "arrive", 1600);
    await run(done, L1[1], "pod", 1585, { name: "Khalid Al Suwaidi" }); await run(done, L1[1], "depart", 1550);
    await run(done, null, "expense", 1600, { kind: "toll", amount: "16", note: "Salik x4" });
    await completeTrip(c, ctx, done, { actual_km: "64" });
    const L2 = (await getTrip(c, moving)).legs;
    await run(moving, L2[0], "arrive", 50); await run(moving, L2[0], "depart", 30);
  });
}

// ── e-commerce fulfilment: merchant orders, reservation, pick/pack/ship, returns, counts, activity billing
async function seedFulfilment(t: Target) {
  const { ctx } = t;
  await db.tenant(t.tenantId, async (c) => {
    const threads = await createParty(c, ctx, { kind: "customer", name: "DEMO Desert Threads (apparel)" });
    const oud = await createParty(c, ctx, { kind: "customer", name: "DEMO Oud & Co (fragrance)" });
    const bin: Record<string, string> = {};
    for (const code of ["A-01", "A-02", "A-03", "B-01", "B-02"]) bin[code] = await fulCreateLocation(c, ctx, { code, note: code.startsWith("A") ? "Apparel aisle" : "Fragrance cage" });
    for (const party of [threads, oud]) for (const [code, amount] of [["receive_unit", "0.60"], ["pick_order", "2.50"], ["pick_unit", "0.40"], ["pack_order", "1.80"], ["return_unit", "1.50"], ["storage_location_month", "45"]])
      await fulSetRate(c, ctx, { party_id: party, code, amount, tax_code: "SR5" });
    await fulCreateSku(c, ctx, { party_id: threads, code: "TEE-BLK-M", name: "Black tee, M", barcode: "6290000100011", reorder_point: 10 });
    await fulCreateSku(c, ctx, { party_id: threads, code: "TEE-BLK-L", name: "Black tee, L", barcode: "6290000100028", reorder_point: 10 });
    await fulCreateSku(c, ctx, { party_id: threads, code: "HOODIE-GRY-M", name: "Grey hoodie, M", barcode: "6290000100035", reorder_point: 5 });
    await fulCreateSku(c, ctx, { party_id: oud, code: "OUD-50", name: "Oud attar 50 ml", barcode: "6290000200012", reorder_point: 8 });
    await fulCreateSku(c, ctx, { party_id: oud, code: "OUD-100", name: "Oud attar 100 ml", barcode: "6290000200029", reorder_point: 5 });
    const receive = async (party: string, lines: [string, number, number, string][]) => {
      const inb = await fulCreateInbound(c, ctx, { party_id: party, reference: `PO-${Math.floor(Math.random() * 9000 + 1000)}`, lines: lines.map(([code, exp]) => `${code}, ${exp}`).join("\n") });
      const d = await fulGetInbound(c, inb.id);
      for (const [code, , good, loc] of lines) await receiveInbound(c, ctx, inb.id, { line_id: d.lines.find((l: any) => l.code === code).id, good, damaged: code === "HOODIE-GRY-M" ? 1 : 0, location_id: bin[loc], token: eid() + eid() });
    };
    await receive(threads, [["TEE-BLK-M", 40, 40, "A-01"], ["TEE-BLK-L", 25, 25, "A-02"], ["HOODIE-GRY-M", 12, 10, "A-03"]]);
    await receive(oud, [["OUD-50", 30, 30, "B-01"], ["OUD-100", 4, 4, "B-02"]]);
    await fulCreateInbound(c, ctx, { party_id: oud, reference: "PO-RESTOCK-OUD100", expected_at: hrs(20), lines: "OUD-100, 24" });   // arrives tomorrow: the backorder below will fill itself

    const ord = (party: string, ref: string, lines: string, extra: Record<string, any> = {}) =>
      createFulfilOrder(c, ctx, { party_id: party, external_ref: ref, channel: "shopify", lines, ship_to_name: extra.name ?? "Aisha Rahman", ship_to_phone: "+971 50 000 1111", ship_to_address: extra.address ?? "Marina Walk 12, Dubai Marina", ship_to_city: "Dubai", ...extra });
    const flow = async (id: string, upTo: "pick" | "pack" | "ship", tracking = "") => {
      await pickOrder(c, ctx, id);
      if (upTo === "pick") return;
      for (const l of (await getFulfilOrder(c, id)).lines) await packScan(c, ctx, id, { code: l.code, qty: l.picked_qty });
      if (upTo === "pack") return;
      await shipOrder(c, ctx, id, { carrier: "Aramex", tracking_no: tracking, cartons: 1, weight_g: 700 });
    };
    const shipped = await ord(threads, "SHOP-5001", "TEE-BLK-M, 2", { name: "Khalid Al Suwaidi", address: "Al Nahda 2, Sharjah" });
    await flow(shipped.id, "ship", "DEMO-AX-1001");
    const ready = await ord(threads, "SHOP-5002", "HOODIE-GRY-M, 1\nTEE-BLK-L, 1");
    await flow(ready.id, "pack");
    const picking = await ord(threads, "SHOP-5003", "TEE-BLK-M, 3", { name: "Omar Haddad", address: "JLT Cluster D, Dubai" });
    await pickOrder(c, ctx, picking.id);
    await ord(oud, "NOON-7001", "OUD-50, 2", { channel: "noon", name: "Sara Bin Zayed", address: "Khalifa City, Abu Dhabi" });
    await ord(oud, "NOON-7002", "OUD-50, 1", { channel: "noon", ship_by: hrs(-2), name: "Mariam Al Ali", address: "Mirdif, Dubai" });             // late
    await ord(oud, "NOON-7003", "OUD-100, 6", { channel: "noon", name: "Yousef Karim", address: "Al Ain" });                                        // waits for the delivery
    // a return against the shipped order: one resellable, one for inspection
    const ret = await createReturn(c, ctx, { party_id: threads, order_no: (await getFulfilOrder(c, shipped.id)).order.no, reason: "Wrong size", lines: "TEE-BLK-M, 2" });
    const rl = (await getReturn(c, ret.id)).lines[0].id;
    await receiveReturn(c, ctx, ret.id, { line_id: rl, qty: 1, disposition: "restock", location_id: bin["A-01"], token: eid() + eid() });
    await receiveReturn(c, ctx, ret.id, { line_id: rl, qty: 1, disposition: "quarantine", token: eid() + eid() });
    // a cycle count that disagrees with the system, waiting for approval
    const lSku = (await c.query<any>(`SELECT id FROM skus WHERE code='TEE-BLK-L'`)).rows[0].id;
    await requestAdjustment(c, ctx, { sku_id: lSku, location_id: bin["A-02"], counted_qty: 23, reason: "Two units water-damaged in the aisle" });
    await runStorageCharges(c, ctx, new Date().toISOString().slice(0, 7));
  });
}

// ── contract warehouse / 3PL: customer-owned stock, FIFO dispatch, a counted variance, activity billing
async function seedWarehouse(t: Target) {
  const { ctx } = t;
  await db.tenant(t.tenantId, async (c) => {
    const food = await createParty(c, ctx, { kind: "customer", name: "DEMO Al Safa Foods" });
    const fash = await createParty(c, ctx, { kind: "customer", name: "DEMO Marina Fashion" });
    const wh = await createWarehouse(c, ctx, { code: "JA1", name: "Jebel Ali Warehouse 1", address: "Jebel Ali Free Zone, Dubai" });
    const L = {
      rec: await createLocation(c, ctx, { warehouse_id: wh, code: "REC-1", kind: "receiving" }),
      a1: await createLocation(c, ctx, { warehouse_id: wh, code: "A-01-01", kind: "storage", capacity_units: 400 }),
      a2: await createLocation(c, ctx, { warehouse_id: wh, code: "A-01-02", kind: "storage", capacity_units: 400 }),
      qrn: await createLocation(c, ctx, { warehouse_id: wh, code: "QRN-1", kind: "quarantine" }),
    };
    const rice = await createSku(c, ctx, { owner_id: food, code: "RICE-5KG", description: "Basmati rice 5 kg", uom: "carton" });
    const oil = await createSku(c, ctx, { owner_id: food, code: "OIL-1L", description: "Sunflower oil 1 L", uom: "carton" });
    const tee = await createSku(c, ctx, { owner_id: fash, code: "TEE-M-BLK", description: "T-shirt M black", uom: "piece" });
    for (const [owner, type, amt] of [[food, "storage_unit_day", "0.40"], [food, "handling_in_unit", "1.50"], [food, "handling_out_unit", "2.00"], [food, "outbound_order", "20.00"],
      [fash, "storage_unit_day", "0.15"], [fash, "handling_in_unit", "0.60"], [fash, "handling_out_unit", "0.80"], [fash, "outbound_order", "15.00"]] as const) {
      await setRate(c, ctx, { owner_id: owner, charge_type: type, amount: amt, effective_from: day(-30) });
    }
    const receive = async (owner: string, sku: string, qty: number, loc: string, extra: Record<string, any> = {}) => {
      const i = await createInbound(c, ctx, { owner_id: owner, warehouse_id: wh, customer_ref: `PO-${Math.floor(Math.random() * 9000 + 1000)}`, lines: [{ sku_id: sku, qty }] });
      await receiveLine(c, ctx, (await getInbound(c, i.id)).lines[0].id, { qty, location_id: loc, lot: "L2610", ...extra });
      await closeInbound(c, ctx, i.id);
    };
    await receive(food, rice, 240, L.a1); await receive(food, rice, 160, L.a2); await receive(food, oil, 120, L.a1);
    await receive(fash, tee, 500, L.rec);
    await receive(food, oil, 6, L.qrn, { condition: "damaged" });                           // damaged on arrival → quarantine
    await createInbound(c, ctx, { owner_id: fash, warehouse_id: wh, customer_ref: "ASN-0042", expected_on: day(2), lines: [{ sku_id: tee, qty: 300 }] });   // still expected
    const o = await createOutbound(c, ctx, { owner_id: food, warehouse_id: wh, ship_to: "Carrefour DC, Al Quoz", customer_ref: "SO-7781", lines: [{ sku_id: rice, qty: 200 }, { sku_id: oil, qty: 40 }] });
    await allocateOutbound(c, ctx, o.id); await confirmPick(c, ctx, o.id, {}); await dispatchOutbound(c, ctx, o.id, { carrier_ref: "DXB K 4471" });
    const o2 = await createOutbound(c, ctx, { owner_id: food, warehouse_id: wh, ship_to: "Spinneys, Umm Suqeim", required_by: new Date(Date.now() + 5 * 3600_000 + 4 * 3600_000).toISOString().slice(0, 16), lines: [{ sku_id: rice, qty: 60 }] });
    await allocateOutbound(c, ctx, o2.id);                                                   // allocated, waiting to be picked
    await createOutbound(c, ctx, { owner_id: food, warehouse_id: wh, ship_to: "Choithrams, JLT", lines: [{ sku_id: rice, qty: 900 }] });   // more than we hold: will not allocate
    await accrueStorage(c, ctx, { now: new Date(Date.now() + 86400_000) });
  });
  // a counted variance awaiting an independent decision: a counter (warehouse role) and the owner as approver
  const counterId = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'Demo Counter','x') RETURNING id`, [t.mail("counter")]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,'{warehouse}')`, [t.tenantId, counterId]));
  const counter: Ctx = { ...ctx, userId: counterId, roles: ["warehouse"], perms: permsFor(["warehouse"]) };
  await db.tenant(t.tenantId, async (c) => {
    const wh = (await c.query<any>(`SELECT id FROM warehouses LIMIT 1`)).rows[0].id, loc = (await c.query<any>(`SELECT id FROM warehouse_locations WHERE code='A-01-02'`)).rows[0].id;
    const k = await startCount(c, counter, { warehouse_id: wh, location_id: loc });
    for (const l of (await getCount(c, k.id)).lines) await recordCount(c, counter, l.id, Number(l.system_qty) - 4);   // 4 cartons short
    await submitCount(c, counter, k.id);
  });
}

// ── courier / last mile with cash on delivery: one run delivered, cash counted in, one failed attempt, one shortage waiting for a decision
async function seedDelivery(t: Target) {
  const { ctx } = t;
  const seed = await db.tenant(t.tenantId, async (c) => {
    const shop = await createParty(c, ctx, { kind: "customer", name: "DEMO Souq Gadgets" });
    const abaya = await createParty(c, ctx, { kind: "customer", name: "DEMO Noor Abayas" });
    await dlvSetRate(c, ctx, { merchant_id: shop, delivery: "12", intercity: "6", return: "8", cod_fee_pct: "2.5", cod_fee_min: "3", effective_from: day(-60) });
    const rider = await createRider(c, ctx, { name: "Rashid Ali", phone: "+971 50 000 0101" });
    const rider2 = await createRider(c, ctx, { name: "Sami Khan", phone: "+971 50 000 0102" });
    const tokR = await invite(c, ctx, { email: t.mail("rider1"), roles: ["driver"], driver_id: rider });
    const tokR2 = await invite(c, ctx, { email: t.mail("rider2"), roles: ["driver"], driver_id: rider2 });
    return { shop, abaya, rider, rider2, tokR, tokR2 };
  });
  const accR = await acceptInvite(db, seed.tokR, { name: "Rashid Ali", password: PASSWORD });
  await acceptInvite(db, seed.tokR2, { name: "Sami Khan", password: PASSWORD });
  const rctx: Ctx = { userId: accR.userId, tenantId: t.tenantId, roles: ["driver"], perms: permsFor(["driver"]), partyId: null, driverId: seed.rider, readOnly: false, supportStaffId: null };
  await db.tenant(t.tenantId, async (c) => {
    const { shop, abaya, rider } = seed;
    const mk = (merchant_id: string, ref: string, name: string, emirate: string, cod?: string, extra: Record<string, any> = {}) =>
      createShipment(c, ctx, { merchant_id, external_ref: ref, consignee_name: name, consignee_phone: "+971 55 000 0000", address: `${name}'s flat, ${emirate}`, emirate, cod, ...extra });
    const a = await mk(shop, "SG-1001", "Aisha Al Zaabi", "Dubai", "249.00");
    const b = await mk(shop, "SG-1002", "Omar Hassan", "Sharjah", "89.50", { require_code: "1" });
    const d = await mk(abaya, "NA-2001", "Mariam Saeed", "Abu Dhabi", "320.00");
    const e = await mk(shop, "SG-1003", "Fahad Khalid", "Dubai");                                       // prepaid
    const f = await mk(shop, "SG-1004", "Layla Nasser", "Dubai", "59.00");                              // will fail (nobody home)
    await mk(abaya, "NA-2002", "Huda Rahman", "Ajman", "150.00");                                        // still waiting for dispatch
    const run = await createRun(c, ctx, { driver_id: rider, shipment_ids: [a.id, b.id, d.id, e.id, f.id] });
    await startRun(c, ctx, run.id);
    const code = (await c.query<any>(`SELECT delivery_code FROM dlv_shipments WHERE id=$1`, [b.id])).rows[0].delivery_code;
    const ev = (id: string, kind: any, payload: Record<string, any>) => applyRiderEvent(c, rctx, { client_event_id: eid(), shipment_id: id, kind, device_time: new Date().toISOString(), payload });
    await ev(a.id, "deliver", { name: "Aisha", cash: "249" });
    await ev(b.id, "deliver", { name: "Omar", cash: "89.5", code });
    await ev(d.id, "deliver", { name: "Mariam", cash: "320" });
    await ev(e.id, "deliver", { name: "Fahad" });
    await ev(f.id, "fail", { reason: "not_home", note: "Door locked, phone off" });
    // cash desk: a counted-in handover for what is owed, then the merchant is paid net of fees
    await settleRider(c, ctx, rider, { counted: "658.50" });
    await dlvRemit(c, ctx, shop, { net_fees: true });
  });
  // a second rider whose cash is SHORT: waiting for an independent decision
  const accR2 = await db.system((cn) => cn.query<any>(`SELECT user_id FROM memberships WHERE driver_id=$1`, [seed.rider2])).then((x) => x.rows[0].user_id);
  const r2ctx: Ctx = { userId: accR2, tenantId: t.tenantId, roles: ["driver"], perms: permsFor(["driver"]), partyId: null, driverId: seed.rider2, readOnly: false, supportStaffId: null };
  await db.tenant(t.tenantId, async (c) => {
    const x = await createShipment(c, ctx, { merchant_id: seed.abaya, external_ref: "NA-2003", consignee_name: "Reem Yousef", address: "Al Nahda, Sharjah", emirate: "Sharjah", cod: "200.00" });
    const run = await createRun(c, ctx, { driver_id: seed.rider2, shipment_ids: [x.id] });
    await startRun(c, ctx, run.id);
    await applyRiderEvent(c, r2ctx, { client_event_id: eid(), shipment_id: x.id, kind: "deliver", device_time: new Date().toISOString(), payload: { name: "Reem", cash: "200" } });
    const cashier = { ...ctx, roles: ["owner"] };
    await settleRider(c, cashier, seed.rider2, { counted: "190", note: "Customer paid with a torn note that was refused at the desk" });
  });
}

// ── customs brokerage: one case approved and handed over, one assessed, one still collecting documents, one deposit held
async function seedCustoms(t: Target) {
  const { ctx } = t;
  await db.tenant(t.tenantId, async (c) => {
    const acme = await createParty(c, ctx, { kind: "customer", name: "DEMO Acme Imports LLC" });
    const mk = (ref: string, over: Record<string, any> = {}) => cusCreate(c, ctx, { party_id: acme, direction: "import", mode: "sea", customs_office: "Jebel Ali", origin_country: "CN", destination_country: "AE", incoterm: "cif", currency: "USD", fx_rate: "3.6725", freight: "400", insurance: "40", transport_ref: ref, ...over });
    const line = { description: "Laptops", hs_code: "8471.30.10", origin_country: "CN", qty: 10, net_kg: 25, gross_kg: 30, value: "1000.00", duty_pct: 5, vat_pct: 5 };
    const ready = async (id: string) => {
      await cusAddLine(c, ctx, id, line);
      for (const it of (await cusGet(c, id)).checklist.filter((x: any) => x.mandatory && x.status === "missing"))
        await cusAttach(c, ctx, id, { item_id: it.id, kind: it.kind, title: it.label, filename: `${it.kind}.pdf`, data: Buffer.from(`%PDF-1.4 demo ${id} ${it.id}`) });
    };
    const a = await mk("MAEU-DEMO-1"); await ready(a.id); await cusReview(c, ctx, a.id); await cusApprove(c, ctx, a.id);
    const b = await mk("MAEU-DEMO-2"); await ready(b.id); await cusReview(c, ctx, b.id); await cusApprove(c, ctx, b.id);
    await cusSubmit(c, ctx, b.id, { channel: "dubai_trade", declaration_no: "DT-DEMO-2001" });
    await cusAssess(c, ctx, b.id, { duty: "190.00", vat: "199.50" });
    const d = await mk("MAEU-DEMO-3"); await cusAddLine(c, ctx, d.id, line);                            // still collecting documents
    await cusDeposit(c, ctx, { party_id: acme, kind: "cash_deposit", amount: "5000", reference: "DEP-DEMO-1" });
  });
}

// ───────── the six single-sector companies, each as a client on one pack sees it
const SINGLE: { key: string; spec: CompanySpec; seed: (t: Target) => Promise<void> }[] = [
  { key: "freight", spec: { company: "DEMO Gulf Gate Freight", contact: "Demo Owner", email: "demo@loadbyton.example", sectors: ["freight-forwarding"], goal: "Stop losing margin on jobs" }, seed: seedFreight },
  { key: "transport", spec: { company: "DEMO Al Noor Transport", contact: "Demo Dispatcher", email: "transport@loadbyton.example", sectors: ["road-transport"], goal: "Control supplier costs" }, seed: seedTransport },
  { key: "fulfilment", spec: { company: "DEMO Souq Fulfilment", contact: "Demo Warehouse Manager", email: "fulfilment@loadbyton.example", sectors: ["ecommerce-fulfilment"], goal: "Just exploring" }, seed: seedFulfilment },
  { key: "warehouse", spec: { company: "DEMO Jebel Ali 3PL", contact: "Demo Warehouse Manager", email: "warehouse@loadbyton.example", sectors: ["contract-warehouse-3pl"], goal: "Bill every activity" }, seed: seedWarehouse },
  { key: "delivery", spec: { company: "DEMO Falcon Express Couriers", contact: "Demo Dispatcher", email: "delivery@loadbyton.example", sectors: ["courier-last-mile"], goal: "Know where every dirham of COD is" }, seed: seedDelivery },
  { key: "customs", spec: { company: "DEMO Gulf Customs Services", contact: "Demo Broker", email: "customs@loadbyton.example", sectors: ["customs-brokerage"], goal: "Never lodge a declaration with a missing document" }, seed: seedCustoms },
];
const targets: Record<string, Target> = {};
const SHOWCASE_EMAIL = "showcase@loadbyton.example", STAFF_EMAIL = "admin@loadbyton.example", AUDITOR_EMAIL = "auditor@loadbyton.example";
const newlySeeded: string[] = [];

if (await userExists(SINGLE[0].spec.email)) console.log("Single-sector demo companies already seeded.");
else {
  for (const s of SINGLE) { targets[s.key] = await openCompany(s.spec); await s.seed(targets[s.key]); }
  newlySeeded.push("single");
}

// ───────── showcase: every built sector in one workspace, on the Enterprise plan (scoped with our team, so set here rather than bought at checkout)
const BUILT_SECTORS = SINGLE.flatMap((s) => s.spec.sectors);
let showcase: Target | null = null;
if (await userExists(SHOWCASE_EMAIL)) console.log("Showcase workspace already seeded.");
else {
  showcase = await openCompany({ company: "DEMO Gulf Logistics Group", contact: "Demo Group Owner", email: SHOWCASE_EMAIL, sectors: [], goal: "See every feature in one workspace" }, "showcase.");
  await db.system(async (c) => {
    const plan = (await currentPlans(c)).find((p) => p.plan_code === "enterprise")!;
    await c.query(`UPDATE subscriptions SET plan_version_id=$2, status='active', period_start=now(), period_end=now() + interval '5 years', updated_at=now() WHERE tenant_id=$1`, [showcase!.tenantId, plan.id]);
    await applyPlanEntitlements(c, showcase!.tenantId, plan, "demo-seed");
    for (const sector of BUILT_SECTORS) await c.query(`INSERT INTO tenant_sectors(tenant_id,sector) VALUES ($1,$2)`, [showcase!.tenantId, sector]);
  });
  for (const s of SINGLE) await s.seed(showcase);
  // a full team and a customer-portal login, so role-specific screens can be tried
  const portalParty = (await db.tenant(showcase.tenantId, (c) => c.query<any>(`SELECT id FROM parties WHERE name='DEMO Desert Trading FZE'`))).rows[0].id;
  const roster: [string, string, string[], string?][] = [
    ["sales", "Demo Sales", ["sales"]], ["pricing", "Demo Pricing Analyst", ["pricing"]], ["coordinator", "Demo Coordinator", ["coordinator"]], ["dispatcher", "Demo Dispatcher", ["dispatcher"]],
    ["finance", "Demo Finance Controller", ["finance"]], ["customs", "Demo Customs Officer", ["customs"]], ["auditor", "Demo Auditor", ["auditor"]], ["portal", "Demo Customer Portal", ["portal"], portalParty],
  ];
  for (const [local, name, roles, party] of roster) {
    const token = await db.tenant(showcase.tenantId, (c) => invite(c, showcase!.ctx, { email: showcase!.mail(local), roles, party_id: party }));
    await acceptInvite(db, token, { name, password: PASSWORD });
  }
  newlySeeded.push("showcase");
}

// ───────── platform staff for /admin (random authenticator secrets, printed once; re-running never resets an existing staff login)
const staffOut: string[] = [];
const staff: Record<string, { userId: string }> = {};
for (const [email, name, role] of [[STAFF_EMAIL, "Demo Platform Admin", "commercial_admin"], [AUDITOR_EMAIL, "Demo Auditor (platform)", "auditor"]] as const) {
  const existing = (await db.query<any>(`SELECT u.id FROM users u JOIN platform_staff s ON s.user_id=u.id WHERE u.email=$1`, [email])).rows[0];
  if (existing) { staff[role] = { userId: existing.id }; continue; }
  const r = await createStaff(db, email, name, PASSWORD, role);
  staff[role] = { userId: r.userId };
  staffOut.push(`  ${email} (${role})\n    authenticator: ${r.otpauth}`);
}

// ───────── what the platform console shows: build requests at every stage, paid orders, an unpaid order, leads, a pending support grant
if (showcase) {
  const sc = showcase, eng = { userId: staff["commercial_admin"].userId, role: "commercial_admin" };
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  const req = (r: Partial<NewRequest> & Pick<NewRequest, "category" | "sectors" | "title" | "requirements">, submittedHoursAgo: number) =>
    db.tenant(sc.tenantId, (c) => createRequest(c, sc.tenantId, sc.userId, { demoReviewed: true, backendNotes: "Node + Postgres on our own VPS", ...r }, hoursAgo(submittedHoursAgo)));
  await req({ category: "free", sectors: ["freight-forwarding"], title: "Freight pack with our quotation layout", requirements: "Our logo, AED/USD quotation layout and the milestone names our team uses." }, 5);
  const dueSoon = await req({ category: "free", sectors: ["customs-brokerage"], title: "Customs checklist for our broker desk", requirements: "Add our own mandatory-document list for chemicals and food imports." }, 21);
  await staffUpdateRequest(db, eng, dueSoon.id, { status: "in_build", note: "Checklist fields agreed with the client." });
  await req({ category: "free", sectors: ["road-transport"], title: "Transport pack with Salik import", requirements: "Import our monthly Salik statement and match tolls to trips." }, 30);          // overdue: left untouched
  await req({ category: "paid", sectors: ["freight-forwarding", "road-transport", "cold-chain"], title: "Freight + transport + cold chain (bespoke)", requirements: "One workspace for forwarding and trucking, plus a temperature-excursion workflow for pharma." }, 3);   // waiting for a quote
  const quoted = await req({ category: "paid", sectors: ["contract-warehouse-3pl", "courier-last-mile"], title: "3PL with a COD cash desk", requirements: "Link stock dispatch to courier runs and reconcile rider cash against merchant remittance." }, 8);
  await staffUpdateRequest(db, eng, quoted.id, { status: "in_build", quoteNote: "AED 6,000 one-off, agreed by email", note: "Quote agreed; the delivery clock starts now." });
  const delivered = await req({ category: "free", sectors: ["ecommerce-fulfilment"], title: "Fulfilment pack with a Shopify field map", requirements: "Map our Shopify order export columns and print our own pick list." }, 40);
  await staffUpdateRequest(db, eng, delivered.id, { status: "delivered", deliveryUrl: "https://handoff.loadbyton.example/showcase/fulfilment-pack.zip", deliveryNotes: "Unzip, run the migrations, then import the Shopify map from the README.", note: "Delivered." });
  await requestGrant(db, staff["commercial_admin"].userId, sc.tenantId, "Demo: helping the owner with a customs checklist question");   // the owner approves it in the workspace
}
if (newlySeeded.includes("single")) {
  // commerce history for the admin screens (only when the mock provider is enabled; a real provider cannot be driven from a seed)
  if (enabledProviders().includes("mock")) {
    for (const [key, plan] of [["transport", "starter"], ["warehouse", "business"]] as const) {
      const o = await createCheckoutOrder(db, targets[key].tenantId, targets[key].userId, plan, "mock");
      const order = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
      await processPaymentEvent(db, "mock", buildMockEvent(order));
    }
    await processProvisioningQueue(db);
    await createCheckoutOrder(db, targets["fulfilment"].tenantId, targets["fulfilment"].userId, "starter", "mock");   // left unpaid: shows as a pending order
  } else console.log("Mock payments are not enabled: skipping sample orders.");
  await db.system((c) => c.query(
    `INSERT INTO platform_leads(name,company,email,sectors,source,message) VALUES
       ('Layla Haddad','DEMO Pearl Shipping','layla@pearl.example','{marine-agency}','contact','Do you plan a marine agency pack?'),
       ('Omar Nasser','DEMO Nasser Cold Stores','omar@nasser.example','{cold-chain,contract-warehouse-3pl}','find-my-bundle','Temperature logging with 3PL billing.')`));
}

const lines = [
  "Demo seeded." + (newlySeeded.length ? "" : " (nothing new: everything was already there)"),
  `  Showcase owner (ALL sectors, Enterprise plan): ${SHOWCASE_EMAIL} / ${PASSWORD}`,
  `    team logins in that workspace: showcase.{sales,pricing,coordinator,dispatcher,finance,customs,auditor,portal}@loadbyton.example`,
  `    phone views: showcase.driver1@loadbyton.example (driver) · showcase.rider1@loadbyton.example (rider)`,
  "  Single-sector companies:",
  "    Freight owner   : demo@loadbyton.example",
  "    Transport owner : transport@loadbyton.example   (driver phone view: driver1@loadbyton.example)",
  "    Fulfilment owner: fulfilment@loadbyton.example",
  "    Warehouse owner : warehouse@loadbyton.example",
  "    Delivery owner  : delivery@loadbyton.example    (rider phone view: rider1@loadbyton.example)",
  "    Customs owner   : customs@loadbyton.example",
  `  Everyone above signs in at /login with ${PASSWORD}; platform staff reach /admin after the authenticator code.`,
];
if (staffOut.length) lines.push("  Platform staff (add each authenticator link to an authenticator app now: it is not shown again):", ...staffOut);
if (config.brochureMode) lines.push("  Note: BROCHURE_MODE is on, so clients see only the request tracker. Start the demo with BROCHURE_MODE=false to open the operating screens.");
console.log(lines.join("\n"));
await db.close();
