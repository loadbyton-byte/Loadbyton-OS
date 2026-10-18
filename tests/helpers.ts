import crypto from "node:crypto";
import pg from "pg";
import { afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.js";
import { permsFor, type Ctx } from "../src/lib/perms.js";
import { registerCompany } from "../src/platform/tenants.js";
import { createParty } from "../src/ops/crm.js";
import { createEnquiry } from "../src/ops/crm.js";
import { createQuote, submitQuote, sendQuote, acceptQuote } from "../src/ops/quotes.js";
import { buildMockEvent, createOrder, processPaymentEvent } from "../src/platform/billing.js";
import { processProvisioningQueue } from "../src/platform/provisioning.js";
import { addBrandAsset, confirmBrandKit, saveBrandKit } from "../src/platform/brand-kit.js";

/** TEST_POSTGRES_URL must point to a disposable test cluster with database-creation permission.
 * Each freshDb gets its own database, so the same acceptance suites can exercise real pooled connections.
 */
const databaseCleanups: (() => Promise<void>)[] = [];
afterAll(async () => { for (const cleanup of databaseCleanups.reverse()) await cleanup(); });

export async function freshDb(): Promise<Db> {
  const testUrl = process.env.TEST_POSTGRES_URL;
  if (!testUrl) {
    const db = await openDb({ dir: null });
    databaseCleanups.push(() => db.close());
    return db;
  }
  const name = `lbt_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: testUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
  const url = new URL(testUrl); url.pathname = `/${name}`;
  const db = await openDb({ url: url.toString() });
  databaseCleanups.push(async () => {
    await db.close();
    const cleanup = new pg.Client({ connectionString: testUrl });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`); } finally { await cleanup.end(); }
  });
  return db;
}

export const ctxFor = (userId: string, tenantId: string, roles = ["owner"]): Ctx => ({
  userId, tenantId, roles, perms: permsFor(roles), partyId: null, driverId: null, readOnly: false, supportStaffId: null,
});

let n = 0;
export async function newTenant(db: Db, name = `Acme Freight ${++n}`, sectors = ["freight-forwarding"]) {
  const r = await registerCompany(db, { company: name, contactName: "Owner", email: `owner${n}-${Date.now()}@example.com`, password: "correct horse battery", sectors });
  return { ...r, ctx: ctxFor(r.userId, r.tenantId) };
}

export const future = (days = 30) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/** customer + supplier + enquiry → approved/sent quote, ready to accept. */
export async function sentQuote(db: Db, t: { tenantId: string; ctx: Ctx }, sellMinor = 100000, costMinor = 70000) {
  return db.tenant(t.tenantId, async (c) => {
    const cust = await createParty(c, t.ctx, { kind: "customer", name: `Cust ${++n}` });
    const sup = await createParty(c, t.ctx, { kind: "supplier", name: `Sup ${n}` });
    const enq = await createEnquiry(c, t.ctx, { party_id: cust, mode: "ocean", origin: "Shanghai", destination: "Jebel Ali", cargo_desc: "Machinery", weight_kg: 1000, ready_date: future(5), external_ref: `x${n}` });
    const q = await createQuote(c, t.ctx, { enquiry_id: enq.id, party_id: cust, valid_until: future(), lines: [{ description: "Ocean freight", qty: 1, unit_sell: sellMinor, unit_cost: costMinor, supplier_id: sup }] });
    const s = await submitQuote(c, t.ctx, q.id);
    return { quoteId: q.id, customerId: cust, supplierId: sup, enquiryId: enq.id, submit: s };
  });
}

export async function convertedJob(db: Db, t: { tenantId: string; ctx: Ctx }, sell = 100000, cost = 70000) {
  const q = await sentQuote(db, t, sell, cost);
  const jobId = await db.tenant(t.tenantId, async (c) => {
    await sendQuote(c, t.ctx, q.quoteId);
    return (await acceptQuote(c, t.ctx, q.quoteId)).jobId;
  });
  return { ...q, jobId };
}

export async function payFor(db: Db, t: { tenantId: string; userId: string }, plan = "starter") {
  const o = await createOrder(db, t.tenantId, t.userId, plan);
  const order = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
  const ev = buildMockEvent(order);
  const res = await processPaymentEvent(db, "mock", ev);
  await processProvisioningQueue(db);
  return { order, ev, res };
}

/** A minimal valid PNG: enough for the brand-kit file checks. */
export const TINY_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/** Give a client a confirmed brand kit (name + logo), so their requests have a delivery clock from the moment they are submitted. */
export async function confirmBrand(db: Db, t: { tenantId: string; userId: string }, name = "Acme Freight LLC") {
  await db.tenant(t.tenantId, async (c) => {
    await saveBrandKit(c, t.tenantId, t.userId, { displayName: name, primaryColour: "#0f2b3d" });
    await addBrandAsset(c, t.tenantId, t.userId, { filename: "logo.png", data: TINY_PNG, kind: "logo" });
    await confirmBrandKit(c, t.tenantId, t.userId);
  });
}
