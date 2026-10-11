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
// ── fourth demo company: e-commerce fulfilment (merchant orders, reservation, pick/pack/ship, returns, counts, activity billing)
const fEmail = "fulfilment@loadbyton.example";
const fr = await registerCompany(db, { company: "DEMO Souq Fulfilment", contactName: "Demo Warehouse Manager", email: fEmail, password: "demo-password-123", sectors: ["ecommerce-fulfilment"], goal: "Just exploring" });
const fctx = { userId: fr.userId, tenantId: fr.tenantId, roles: ["owner"], perms: permsFor(["owner"]), partyId: null, driverId: null, readOnly: false, supportStaffId: null };
await db.tenant(fr.tenantId, async (c) => {
  const threads = await createParty(c, fctx, { kind: "customer", name: "DEMO Desert Threads (apparel)" });
  const oud = await createParty(c, fctx, { kind: "customer", name: "DEMO Oud & Co (fragrance)" });
  const bin: Record<string, string> = {};
  for (const code of ["A-01", "A-02", "A-03", "B-01", "B-02"]) bin[code] = await fulCreateLocation(c, fctx, { code, note: code.startsWith("A") ? "Apparel aisle" : "Fragrance cage" });
  for (const party of [threads, oud]) for (const [code, amount] of [["receive_unit", "0.60"], ["pick_order", "2.50"], ["pick_unit", "0.40"], ["pack_order", "1.80"], ["return_unit", "1.50"], ["storage_location_month", "45"]])
    await fulSetRate(c, fctx, { party_id: party, code, amount, tax_code: "SR5" });
  await fulCreateSku(c, fctx, { party_id: threads, code: "TEE-BLK-M", name: "Black tee, M", barcode: "6290000100011", reorder_point: 10 });
  await fulCreateSku(c, fctx, { party_id: threads, code: "TEE-BLK-L", name: "Black tee, L", barcode: "6290000100028", reorder_point: 10 });
  await fulCreateSku(c, fctx, { party_id: threads, code: "HOODIE-GRY-M", name: "Grey hoodie, M", barcode: "6290000100035", reorder_point: 5 });
  await fulCreateSku(c, fctx, { party_id: oud, code: "OUD-50", name: "Oud attar 50 ml", barcode: "6290000200012", reorder_point: 8 });
  await fulCreateSku(c, fctx, { party_id: oud, code: "OUD-100", name: "Oud attar 100 ml", barcode: "6290000200029", reorder_point: 5 });
  const receive = async (party: string, lines: [string, number, number, string][]) => {
    const inb = await fulCreateInbound(c, fctx, { party_id: party, reference: `PO-${Math.floor(Math.random() * 9000 + 1000)}`, lines: lines.map(([code, exp]) => `${code}, ${exp}`).join("\n") });
    const d = await fulGetInbound(c, inb.id);
    for (const [code, , good, loc] of lines) await receiveInbound(c, fctx, inb.id, { line_id: d.lines.find((l: any) => l.code === code).id, good, damaged: code === "HOODIE-GRY-M" ? 1 : 0, location_id: bin[loc], token: eid() + eid() });
  };
  await receive(threads, [["TEE-BLK-M", 40, 40, "A-01"], ["TEE-BLK-L", 25, 25, "A-02"], ["HOODIE-GRY-M", 12, 10, "A-03"]]);
  await receive(oud, [["OUD-50", 30, 30, "B-01"], ["OUD-100", 4, 4, "B-02"]]);
  await fulCreateInbound(c, fctx, { party_id: oud, reference: "PO-RESTOCK-OUD100", expected_at: hrs(20), lines: "OUD-100, 24" });   // arrives tomorrow: the backorder below will fill itself

  const ord = (party: string, ref: string, lines: string, extra: Record<string, any> = {}) =>
    createFulfilOrder(c, fctx, { party_id: party, external_ref: ref, channel: "shopify", lines, ship_to_name: extra.name ?? "Aisha Rahman", ship_to_phone: "+971 50 000 1111", ship_to_address: extra.address ?? "Marina Walk 12, Dubai Marina", ship_to_city: "Dubai", ...extra });
  const flow = async (id: string, upTo: "pick" | "pack" | "ship", tracking = "") => {
    await pickOrder(c, fctx, id);
    if (upTo === "pick") return;
    for (const l of (await getFulfilOrder(c, id)).lines) await packScan(c, fctx, id, { code: l.code, qty: l.picked_qty });
    if (upTo === "pack") return;
    await shipOrder(c, fctx, id, { carrier: "Aramex", tracking_no: tracking, cartons: 1, weight_g: 700 });
  };
  const shipped = await ord(threads, "SHOP-5001", "TEE-BLK-M, 2", { name: "Khalid Al Suwaidi", address: "Al Nahda 2, Sharjah" });
  await flow(shipped.id, "ship", "DEMO-AX-1001");
  const ready = await ord(threads, "SHOP-5002", "HOODIE-GRY-M, 1\nTEE-BLK-L, 1");
  await flow(ready.id, "pack");
  const picking = await ord(threads, "SHOP-5003", "TEE-BLK-M, 3", { name: "Omar Haddad", address: "JLT Cluster D, Dubai" });
  await pickOrder(c, fctx, picking.id);
  await ord(oud, "NOON-7001", "OUD-50, 2", { channel: "noon", name: "Sara Bin Zayed", address: "Khalifa City, Abu Dhabi" });
  await ord(oud, "NOON-7002", "OUD-50, 1", { channel: "noon", ship_by: hrs(-2), name: "Mariam Al Ali", address: "Mirdif, Dubai" });             // late
  await ord(oud, "NOON-7003", "OUD-100, 6", { channel: "noon", name: "Yousef Karim", address: "Al Ain" });                                        // waits for the delivery
  // a return against the shipped order: one resellable, one for inspection
  const ret = await createReturn(c, fctx, { party_id: threads, order_no: (await getFulfilOrder(c, shipped.id)).order.no, reason: "Wrong size", lines: "TEE-BLK-M, 2" });
  const rl = (await getReturn(c, ret.id)).lines[0].id;
  await receiveReturn(c, fctx, ret.id, { line_id: rl, qty: 1, disposition: "restock", location_id: bin["A-01"], token: eid() + eid() });
  await receiveReturn(c, fctx, ret.id, { line_id: rl, qty: 1, disposition: "quarantine", token: eid() + eid() });
  // a cycle count that disagrees with the system, waiting for approval
  const lSku = (await c.query<any>(`SELECT id FROM skus WHERE code='TEE-BLK-L'`)).rows[0].id;
  await requestAdjustment(c, fctx, { sku_id: lSku, location_id: bin["A-02"], counted_qty: 23, reason: "Two units water-damaged in the aisle" });
  await runStorageCharges(c, fctx, new Date().toISOString().slice(0, 7));
});


// ── third demo company: contract warehouse / 3PL (customer-owned stock, FIFO dispatch, a counted variance, activity billing)
const wEmail = "warehouse@loadbyton.example";
const wr = await registerCompany(db, { company: "DEMO Jebel Ali 3PL", contactName: "Demo Warehouse Manager", email: wEmail, password: "demo-password-123", sectors: ["contract-warehouse-3pl"], goal: "Bill every activity" });
const wctx = { userId: wr.userId, tenantId: wr.tenantId, roles: ["owner"], perms: permsFor(["owner"]), partyId: null, driverId: null, readOnly: false, supportStaffId: null };
await db.tenant(wr.tenantId, async (c) => {
  const food = await createParty(c, wctx, { kind: "customer", name: "DEMO Al Safa Foods" });
  const fash = await createParty(c, wctx, { kind: "customer", name: "DEMO Marina Fashion" });
  const wh = await createWarehouse(c, wctx, { code: "JA1", name: "Jebel Ali Warehouse 1", address: "Jebel Ali Free Zone, Dubai" });
  const L = {
    rec: await createLocation(c, wctx, { warehouse_id: wh, code: "REC-1", kind: "receiving" }),
    a1: await createLocation(c, wctx, { warehouse_id: wh, code: "A-01-01", kind: "storage", capacity_units: 400 }),
    a2: await createLocation(c, wctx, { warehouse_id: wh, code: "A-01-02", kind: "storage", capacity_units: 400 }),
    qrn: await createLocation(c, wctx, { warehouse_id: wh, code: "QRN-1", kind: "quarantine" }),
  };
  const rice = await createSku(c, wctx, { owner_id: food, code: "RICE-5KG", description: "Basmati rice 5 kg", uom: "carton" });
  const oil = await createSku(c, wctx, { owner_id: food, code: "OIL-1L", description: "Sunflower oil 1 L", uom: "carton" });
  const tee = await createSku(c, wctx, { owner_id: fash, code: "TEE-M-BLK", description: "T-shirt M black", uom: "piece" });
  for (const [owner, type, amt] of [[food, "storage_unit_day", "0.40"], [food, "handling_in_unit", "1.50"], [food, "handling_out_unit", "2.00"], [food, "outbound_order", "20.00"],
    [fash, "storage_unit_day", "0.15"], [fash, "handling_in_unit", "0.60"], [fash, "handling_out_unit", "0.80"], [fash, "outbound_order", "15.00"]] as const) {
    await setRate(c, wctx, { owner_id: owner, charge_type: type, amount: amt, effective_from: day(-30) });
  }
  const receive = async (owner: string, sku: string, qty: number, loc: string, extra: Record<string, any> = {}) => {
    const i = await createInbound(c, wctx, { owner_id: owner, warehouse_id: wh, customer_ref: `PO-${Math.floor(Math.random() * 9000 + 1000)}`, lines: [{ sku_id: sku, qty }] });
    await receiveLine(c, wctx, (await getInbound(c, i.id)).lines[0].id, { qty, location_id: loc, lot: "L2610", ...extra });
    await closeInbound(c, wctx, i.id);
  };
  await receive(food, rice, 240, L.a1); await receive(food, rice, 160, L.a2); await receive(food, oil, 120, L.a1);
  await receive(fash, tee, 500, L.rec);
  await receive(food, oil, 6, L.qrn, { condition: "damaged" });                           // damaged on arrival → quarantine
  await createInbound(c, wctx, { owner_id: fash, warehouse_id: wh, customer_ref: "ASN-0042", expected_on: day(2), lines: [{ sku_id: tee, qty: 300 }] });   // still expected
  const o = await createOutbound(c, wctx, { owner_id: food, warehouse_id: wh, ship_to: "Carrefour DC, Al Quoz", customer_ref: "SO-7781", lines: [{ sku_id: rice, qty: 200 }, { sku_id: oil, qty: 40 }] });
  await allocateOutbound(c, wctx, o.id); await confirmPick(c, wctx, o.id, {}); await dispatchOutbound(c, wctx, o.id, { carrier_ref: "DXB K 4471" });
  const o2 = await createOutbound(c, wctx, { owner_id: food, warehouse_id: wh, ship_to: "Spinneys, Umm Suqeim", required_by: new Date(Date.now() + 5 * 3600_000 + 4 * 3600_000).toISOString().slice(0, 16), lines: [{ sku_id: rice, qty: 60 }] });
  await allocateOutbound(c, wctx, o2.id);                                                   // allocated, waiting to be picked
  await createOutbound(c, wctx, { owner_id: food, warehouse_id: wh, ship_to: "Choithrams, JLT", lines: [{ sku_id: rice, qty: 900 }] });   // more than we hold: will not allocate
  await accrueStorage(c, wctx, { now: new Date(Date.now() + 86400_000) });
});
// a counted variance awaiting an independent decision: a counter (warehouse role) and the owner as approver
const counterId = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ('counter@loadbyton.example','Demo Counter','x') RETURNING id`))).rows[0].id;
await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,'{warehouse}')`, [wr.tenantId, counterId]));
const counter = { ...wctx, userId: counterId, roles: ["warehouse"], perms: permsFor(["warehouse"]) };
await db.tenant(wr.tenantId, async (c) => {
  const wh = (await c.query<any>(`SELECT id FROM warehouses LIMIT 1`)).rows[0].id, loc = (await c.query<any>(`SELECT id FROM warehouse_locations WHERE code='A-01-02'`)).rows[0].id;
  const k = await startCount(c, counter, { warehouse_id: wh, location_id: loc });
  for (const l of (await getCount(c, k.id)).lines) await recordCount(c, counter, l.id, Number(l.system_qty) - 4);   // 4 cartons short
  await submitCount(c, counter, k.id);
});

// ── fourth demo company: courier / last mile with cash on delivery (one run delivered, cash counted in, one failed attempt, one shortage waiting for a decision)
const kEmail = "delivery@loadbyton.example";
const kr = await registerCompany(db, { company: "DEMO Falcon Express Couriers", contactName: "Demo Dispatcher", email: kEmail, password: "demo-password-123", sectors: ["courier-last-mile"], goal: "Know where every dirham of COD is" });
const kctx = { userId: kr.userId, tenantId: kr.tenantId, roles: ["owner"], perms: permsFor(["owner"]), partyId: null, driverId: null, readOnly: false, supportStaffId: null };
const riderToken = await db.tenant(kr.tenantId, async (c) => {
  const shop = await createParty(c, kctx, { kind: "customer", name: "DEMO Souq Gadgets" });
  const abaya = await createParty(c, kctx, { kind: "customer", name: "DEMO Noor Abayas" });
  await dlvSetRate(c, kctx, { merchant_id: shop, delivery: "12", intercity: "6", return: "8", cod_fee_pct: "2.5", cod_fee_min: "3", effective_from: day(-60) });
  const rider = await createRider(c, kctx, { name: "Rashid Ali", phone: "+971 50 000 0101" });
  const rider2 = await createRider(c, kctx, { name: "Sami Khan", phone: "+971 50 000 0102" });
  const tokR = await invite(c, kctx, { email: "rider1@loadbyton.example", roles: ["driver"], driver_id: rider });
  const tokR2 = await invite(c, kctx, { email: "rider2@loadbyton.example", roles: ["driver"], driver_id: rider2 });
  return { shop, abaya, rider, rider2, tokR, tokR2 };
});
const accR = await acceptInvite(db, riderToken.tokR, { name: "Rashid Ali", password: "demo-password-123" });
await acceptInvite(db, riderToken.tokR2, { name: "Sami Khan", password: "demo-password-123" });
const rctx = { userId: accR.userId, tenantId: kr.tenantId, roles: ["driver"], perms: permsFor(["driver"]), partyId: null, driverId: riderToken.rider, readOnly: false, supportStaffId: null };
const evId = () => `seed-${Math.random().toString(36).slice(2)}-${Date.now()}`;
await db.tenant(kr.tenantId, async (c) => {
  const { shop, abaya, rider } = riderToken;
  const mk = (merchant_id: string, ref: string, name: string, emirate: string, cod?: string, extra: Record<string, any> = {}) =>
    createShipment(c, kctx, { merchant_id, external_ref: ref, consignee_name: name, consignee_phone: "+971 55 000 0000", address: `${name}'s flat, ${emirate}`, emirate, cod, ...extra });
  const a = await mk(shop, "SG-1001", "Aisha Al Zaabi", "Dubai", "249.00");
  const b = await mk(shop, "SG-1002", "Omar Hassan", "Sharjah", "89.50", { require_code: "1" });
  const d = await mk(abaya, "NA-2001", "Mariam Saeed", "Abu Dhabi", "320.00");
  const e = await mk(shop, "SG-1003", "Fahad Khalid", "Dubai");                                       // prepaid
  const f = await mk(shop, "SG-1004", "Layla Nasser", "Dubai", "59.00");                              // will fail (nobody home)
  await mk(abaya, "NA-2002", "Huda Rahman", "Ajman", "150.00");                                        // still waiting for dispatch
  const run = await createRun(c, kctx, { driver_id: rider, shipment_ids: [a.id, b.id, d.id, e.id, f.id] });
  await startRun(c, kctx, run.id);
  const code = (await c.query<any>(`SELECT delivery_code FROM dlv_shipments WHERE id=$1`, [b.id])).rows[0].delivery_code;
  const ev = (id: string, kind: any, payload: Record<string, any>) => applyRiderEvent(c, rctx, { client_event_id: evId(), shipment_id: id, kind, device_time: new Date().toISOString(), payload });
  await ev(a.id, "deliver", { name: "Aisha", cash: "249" });
  await ev(b.id, "deliver", { name: "Omar", cash: "89.5", code });
  await ev(d.id, "deliver", { name: "Mariam", cash: "320" });
  await ev(e.id, "deliver", { name: "Fahad" });
  await ev(f.id, "fail", { reason: "not_home", note: "Door locked, phone off" });
  // cash desk: a counted-in handover for what is owed, then the merchant is paid net of fees
  await settleRider(c, kctx, rider, { counted: "658.50" });
  await dlvRemit(c, kctx, shop, { net_fees: true });
});
// a second rider whose cash is SHORT: waiting for an independent decision
const accR2 = await db.system((cn) => cn.query<any>(`SELECT user_id FROM memberships WHERE driver_id=$1`, [riderToken.rider2])).then((x) => x.rows[0].user_id);
const r2ctx = { userId: accR2, tenantId: kr.tenantId, roles: ["driver"], perms: permsFor(["driver"]), partyId: null, driverId: riderToken.rider2, readOnly: false, supportStaffId: null };
await db.tenant(kr.tenantId, async (c) => {
  const x = await createShipment(c, kctx, { merchant_id: riderToken.abaya, external_ref: "NA-2003", consignee_name: "Reem Yousef", address: "Al Nahda, Sharjah", emirate: "Sharjah", cod: "200.00" });
  const run = await createRun(c, kctx, { driver_id: riderToken.rider2, shipment_ids: [x.id] });
  await startRun(c, kctx, run.id);
  await applyRiderEvent(c, r2ctx, { client_event_id: evId(), shipment_id: x.id, kind: "deliver", device_time: new Date().toISOString(), payload: { name: "Reem", cash: "200" } });
  const cashier = { ...kctx, roles: ["owner"] };
  await settleRider(c, cashier, riderToken.rider2, { counted: "190", note: "Customer paid with a torn note that was refused at the desk" });
});
// ── fifth demo company: customs brokerage (one case approved and handed over, one assessed, one still collecting documents, one deposit held)
const cEmail = "customs@loadbyton.example";
const cr = await registerCompany(db, { company: "DEMO Gulf Customs Services", contactName: "Demo Broker", email: cEmail, password: "demo-password-123", sectors: ["customs-brokerage"], goal: "Never lodge a declaration with a missing document" });
const cctx = { userId: cr.userId, tenantId: cr.tenantId, roles: ["owner"], perms: permsFor(["owner"]), partyId: null, driverId: null, readOnly: false, supportStaffId: null };
await db.tenant(cr.tenantId, async (c) => {
  const acme = await createParty(c, cctx, { kind: "customer", name: "DEMO Acme Imports LLC" });
  const mk = (ref: string, over: Record<string, any> = {}) => cusCreate(c, cctx, { party_id: acme, direction: "import", mode: "sea", customs_office: "Jebel Ali", origin_country: "CN", destination_country: "AE", incoterm: "cif", currency: "USD", fx_rate: "3.6725", freight: "400", insurance: "40", transport_ref: ref, ...over });
  const line = { description: "Laptops", hs_code: "8471.30.10", origin_country: "CN", qty: 10, net_kg: 25, gross_kg: 30, value: "1000.00", duty_pct: 5, vat_pct: 5 };
  const ready = async (id: string) => {
    await cusAddLine(c, cctx, id, line);
    for (const it of (await cusGet(c, id)).checklist.filter((x: any) => x.mandatory && x.status === "missing"))
      await cusAttach(c, cctx, id, { item_id: it.id, kind: it.kind, title: it.label, filename: `${it.kind}.pdf`, data: Buffer.from(`%PDF-1.4 demo ${id} ${it.id}`) });
  };
  const a = await mk("MAEU-DEMO-1"); await ready(a.id); await cusReview(c, cctx, a.id); await cusApprove(c, cctx, a.id);
  const b = await mk("MAEU-DEMO-2"); await ready(b.id); await cusReview(c, cctx, b.id); await cusApprove(c, cctx, b.id);
  await cusSubmit(c, cctx, b.id, { channel: "dubai_trade", declaration_no: "DT-DEMO-2001" });
  await cusAssess(c, cctx, b.id, { duty: "190.00", vat: "199.50" });
  const d = await mk("MAEU-DEMO-3"); await cusAddLine(c, cctx, d.id, line);                            // still collecting documents
  await cusDeposit(c, cctx, { party_id: acme, kind: "cash_deposit", amount: "5000", reference: "DEP-DEMO-1" });
});
console.log(`Demo seeded.\n  Freight owner : ${email} / demo-password-123\n  Transport owner: ${tEmail} / demo-password-123\n  Driver (phone) : driver1@loadbyton.example / demo-password-123\n  Fulfilment owner: ${fEmail} / demo-password-123\n  Warehouse owner: ${wEmail} / demo-password-123\n  Delivery owner : ${kEmail} / demo-password-123\n  Customs owner  : ${cEmail} / demo-password-123\n  Rider (phone)  : rider1@loadbyton.example / demo-password-123`);
await db.close();
