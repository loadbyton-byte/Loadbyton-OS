import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { createInbound, createLocation, createOrder, createSku, getInbound, receiveInbound, allocateOrder, pickOrder, packScan, shipOrder, cancelFulfilOrder } from "../src/ops/fulfilment.js";
import { cancelShipment, createShipment } from "../src/ops/delivery.js";
import { approveErasurePlan, executeErasure, placeLegalHold, prepareErasurePlan, processDataMinimisation, releaseLegalHold, retentionWorkspace, setRetentionPolicy, setRetentionStatus } from "../src/ops/privacy-retention.js";
import { decideDataRequest, requestDataAction } from "../src/ops/privacy.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
const uid = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`;
async function user(label: string) { return (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`pr-${label}-${uid()}@example.com`, label]))).rows[0].id as string; }
async function staff(tenantId: string, role: string) { const id = await user(role); await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]])); return ctxFor(id, tenantId, [role]); }

async function world() {
  const t = await newTenant(db, undefined, ["ecommerce-fulfilment", "delivery-cod"]);
  const f = await db.tenant(t.tenantId, async (c) => {
    const m1 = await createParty(c, t.ctx, { kind: "customer", name: "Held Merchant", email: "h@example.com", phone: "0500000001" }), m2 = await createParty(c, t.ctx, { kind: "customer", name: "Free Merchant" });
    const A = await createLocation(c, t.ctx, { code: "a-01" });
    await createSku(c, t.ctx, { party_id: m1, code: "tee", name: "Tee" }); await createSku(c, t.ctx, { party_id: m2, code: "tee", name: "Tee" });
    const mk = async (merchant: string) => {
      const inb = await createInbound(c, t.ctx, { party_id: merchant, lines: "TEE, 2" });
      await receiveInbound(c, t.ctx, inb.id, { line_id: (await getInbound(c, inb.id)).lines[0].id, good: 2, damaged: 0, location_id: A, token: `tok-${uid()}` });
      const o = await createOrder(c, t.ctx, { party_id: merchant, external_ref: `O-${uid()}`, ship_to_name: "Aisha Khan", ship_to_phone: "0501234567", ship_to_address: "Marina 12", ship_to_city: "Dubai", lines: "TEE, 1" });
      await pickOrder(c, t.ctx, o.id); await packScan(c, t.ctx, o.id, { code: "TEE" }); await shipOrder(c, t.ctx, o.id, { carrier: "Aramex", tracking_no: `T${uid()}` });
      return o.id as string;
    };
    return { m1, m2, o1: await mk(m1), o2: await mk(m2), p: await createShipment(c, t.ctx, { merchant_id: m2, consignee_name: "Rider Target", consignee_phone: "0509999999", address: "Villa 3", emirate: "Dubai" }) };
  });
  await db.tenant(t.tenantId, (c) => cancelShipment(c, t.ctx, f.p.id));
  await db.system((c) => c.query(`UPDATE fulfil_orders SET shipped_at = now() - interval '200 days' WHERE tenant_id=$1`, [t.tenantId]));
  await db.system((c) => c.query(`UPDATE dlv_shipments SET created_at = now() - interval '200 days' WHERE tenant_id=$1`, [t.tenantId]));
  return { t, ...f };
}
const row = (id: string) => db.query<any>(`SELECT ship_to_name, ship_to_phone, ship_to_address, anonymised_at FROM fulfil_orders WHERE id=$1`, [id]).then((r) => r.rows[0]);

describe("scheduled data minimisation", () => {
  it("is owner-only, bounded, hold-aware and leaves financial and stock records untouched", async () => {
    const w = await world();
    const clerk = await staff(w.t.tenantId, "warehouse");
    await expect(db.tenant(w.t.tenantId, (c) => setRetentionPolicy(c, clerk, { subject: "fulfil_recipient", retain_days: 90, reason: "x" }))).rejects.toThrow();
    await expect(db.tenant(w.t.tenantId, (c) => setRetentionPolicy(c, w.t.ctx, { subject: "fulfil_recipient", retain_days: 10, reason: "policy" }))).rejects.toThrow(/30 to 3650/);
    await db.tenant(w.t.tenantId, (c) => setRetentionPolicy(c, w.t.ctx, { subject: "fulfil_recipient", retain_days: 90, reason: "Merchant DPA §4: 90 days after dispatch" }));
    await db.tenant(w.t.tenantId, (c) => setRetentionPolicy(c, w.t.ctx, { subject: "delivery_consignee", retain_days: 90, reason: "Merchant DPA §4" }));
    const hold = await db.tenant(w.t.tenantId, (c) => placeLegalHold(c, w.t.ctx, { party_id: w.m1, reason: "Dispute matter 17" }));
    const ws = await db.tenant(w.t.tenantId, (c) => retentionWorkspace(c, w.t.ctx));
    expect(ws.policies.find((p: any) => p.subject === "fulfil_recipient").eligible).toBe(1);   // only the un-held merchant's order
    const r = await processDataMinimisation(db);
    expect(r.failed).toBe(0);
    expect(await row(w.o1)).toMatchObject({ ship_to_name: "Aisha Khan", anonymised_at: null });
    expect(await row(w.o2)).toMatchObject({ ship_to_name: "Anonymised", ship_to_phone: null, ship_to_address: "Anonymised" });
    const dlv = (await db.query<any>(`SELECT consignee_name, consignee_phone, address FROM dlv_shipments WHERE id=$1`, [w.p.id])).rows[0];
    expect(dlv).toEqual({ consignee_name: "Anonymised", consignee_phone: null, address: "Anonymised" });
    expect((await db.query<any>(`SELECT count(*)::int n FROM stock_movements WHERE tenant_id=$1`, [w.t.tenantId])).rows[0].n).toBeGreaterThan(0);
    await db.tenant(w.t.tenantId, (c) => releaseLegalHold(c, w.t.ctx, hold, "Matter closed"));
    await expect(db.system((c) => c.query(`UPDATE privacy_legal_holds SET reason='x' WHERE id=$1`, [hold]))).rejects.toThrow(/immutable/);
    await processDataMinimisation(db);
    expect((await row(w.o1)).ship_to_name).toBe("Anonymised");
    const runs = (await db.tenant(w.t.tenantId, (c) => retentionWorkspace(c, w.t.ctx))).runs;
    expect(runs.reduce((a: number, x: any) => a + x.rows_anonymised, 0)).toBe(3);
    expect((await processDataMinimisation(db)).anonymised).toBe(0);                      // idempotent
    const audit = JSON.stringify((await db.query<any>(`SELECT data FROM audit_log WHERE action='privacy.minimised'`)).rows);
    expect(audit).not.toContain("Aisha");
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("a paused policy does nothing, and young or returning records are kept", async () => {
    const w = await world();
    const pid = await db.tenant(w.t.tenantId, (c) => setRetentionPolicy(c, w.t.ctx, { subject: "fulfil_recipient", retain_days: 365, reason: "Longer retention agreed" }));
    await processDataMinimisation(db);
    expect((await row(w.o2)).anonymised_at).toBeNull();                                   // 200 days < 365
    await db.tenant(w.t.tenantId, (c) => setRetentionPolicy(c, w.t.ctx, { subject: "fulfil_recipient", retain_days: 30, reason: "Shortened" }));
    await db.tenant(w.t.tenantId, (c) => setRetentionStatus(c, w.t.ctx, pid, false));
    await processDataMinimisation(db);
    expect((await row(w.o2)).anonymised_at).toBeNull();
    await db.tenant(w.t.tenantId, (c) => setRetentionStatus(c, w.t.ctx, pid, true));
    await db.system((c) => c.query(`INSERT INTO fulfil_returns(tenant_id,no,party_id,order_id,reason,created_by) VALUES ($1,$2,$3,$4,'open',$5)`, [w.t.tenantId, `RMA-${uid()}`, w.m2, w.o2, w.t.userId]));
    await processDataMinimisation(db);
    expect((await row(w.o2)).anonymised_at).toBeNull();                                   // open return keeps the contact
  });
});

describe("reviewed tenant erasure", () => {
  it("needs an approved deletion, a clean workspace, two different staff and re-checks at execution", async () => {
    const w = await world();
    const reqId = await db.tenant(w.t.tenantId, (c) => requestDataAction(c, w.t.ctx, "deletion", "Closing the business; erase personal data"));
    const s1 = await user("staff1"), s2 = await user("staff2");
    await expect(prepareErasurePlan(db, s1, reqId)).rejects.toThrow(/approved deletion/);
    for (const [next, why] of [["reviewing", "Identity verified"], ["approved", "No outstanding legal hold"]]) await decideDataRequest(db, s1, reqId, next, why);
    const plan = await prepareErasurePlan(db, s1, reqId);
    expect(plan.steps.fulfil_orders).toBeGreaterThanOrEqual(2);
    expect(plan.retained.join(" ")).toMatch(/Issued invoices/);
    await expect(approveErasurePlan(db, s1, reqId)).rejects.toThrow(/second person/);
    await db.tenant(w.t.tenantId, async (c) => { await placeLegalHold(c, w.t.ctx, { reason: "Regulator enquiry" }); });
    const blocked = await prepareErasurePlan(db, s1, reqId);
    expect(blocked.blockers.join(" ")).toMatch(/legal holds/);
    await expect(approveErasurePlan(db, s2, reqId)).rejects.toThrow(/Resolve before approval/);
    const hold = (await db.query<any>(`SELECT id FROM privacy_legal_holds WHERE tenant_id=$1 AND released_at IS NULL`, [w.t.tenantId])).rows[0].id;
    await db.tenant(w.t.tenantId, (c) => releaseLegalHold(c, w.t.ctx, hold, "Enquiry closed"));
    await prepareErasurePlan(db, s1, reqId);
    await expect(executeErasure(db, s1, reqId)).rejects.toThrow(/approval first/);
    await approveErasurePlan(db, s2, reqId);
    // new work after approval invalidates it
    await db.tenant(w.t.tenantId, async (c) => { await createShipment(c, w.t.ctx, { merchant_id: w.m2, consignee_name: "New", address: "Z", emirate: "Dubai" }); });
    await expect(executeErasure(db, s2, reqId)).rejects.toThrow(/appeared after approval/);
    await db.system((c) => c.query(`UPDATE dlv_shipments SET status='cancelled', run_id=NULL WHERE tenant_id=$1 AND status='new'`, [w.t.tenantId]));
    await prepareErasurePlan(db, s1, reqId); await approveErasurePlan(db, s2, reqId);
    const result = await executeErasure(db, s2, reqId);
    expect(result.fulfil_orders).toBeGreaterThanOrEqual(2);
    expect((await row(w.o1)).ship_to_name).toBe("Anonymised");
    const party = (await db.query<any>(`SELECT name, email, phone FROM parties WHERE id=$1`, [w.m1])).rows[0];
    expect(party).toEqual({ name: "Held Merchant", email: null, phone: null });          // legal-entity name retained for invoices
    expect((await db.query<any>(`SELECT status FROM data_requests WHERE id=$1`, [reqId])).rows[0].status).toBe("completed");
    await expect(executeErasure(db, s2, reqId)).rejects.toThrow(/Already executed/);
    expect(await verifyInvariants(db)).toEqual([]);
  });
});

describe("per-field authorisation in exports", () => {
  it("auditors and finance see no consignee, driver or party contact personal data; owners and dispatchers do", async () => {
    const { exportTenantData } = await import("../src/ops/exporter.js");
    const w = await world();
    await db.tenant(w.t.tenantId, (c) => createShipment(c, w.t.ctx, { merchant_id: w.m2, consignee_name: "Visible Person", consignee_phone: "0507777777", address: "Villa 9", emirate: "Dubai" }));
    const auditor = await staff(w.t.tenantId, "auditor"), finance = await staff(w.t.tenantId, "finance");
    const asOwner = await db.tenant(w.t.tenantId, (c) => exportTenantData(c, w.t.ctx)) as any;
    expect(asOwner.dlv_shipments.some((s: any) => s.consignee_name === "Visible Person" && s.consignee_phone === "0507777777")).toBe(true);
    expect(asOwner.parties.find((p: any) => p.id === w.m1).email).toBe("h@example.com");
    for (const who of [auditor, finance]) {
      const out = await db.tenant(w.t.tenantId, (c) => exportTenantData(c, who)) as any;
      const s = out.dlv_shipments.find((x: any) => x.consignee_phone !== undefined);
      expect(JSON.stringify(out.dlv_shipments)).not.toContain("0507777777");
      expect(s.consignee_name).toBe("Restricted");
    }
    const aud = await db.tenant(w.t.tenantId, (c) => exportTenantData(c, auditor)) as any;
    expect(aud.parties.find((p: any) => p.id === w.m1)).toMatchObject({ email: null, phone: null });
    const fin = await db.tenant(w.t.tenantId, (c) => exportTenantData(c, finance)) as any;
    expect(fin.parties.find((p: any) => p.id === w.m1).email).toBe("h@example.com");     // finance needs invoice contacts
  });
});
