import { openDb, type Db } from "../src/db/client.js";
import { permsFor, type Ctx } from "../src/lib/perms.js";
import { registerCompany } from "../src/platform/tenants.js";
import { createParty } from "../src/ops/crm.js";
import { createEnquiry } from "../src/ops/crm.js";
import { createQuote, submitQuote, sendQuote, acceptQuote } from "../src/ops/quotes.js";
import { buildMockEvent, createOrder, processPaymentEvent } from "../src/platform/billing.js";
import { processProvisioningQueue } from "../src/platform/provisioning.js";

export async function freshDb(): Promise<Db> { return openDb({ dir: null }); }

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
