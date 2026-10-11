import { describe, it, expect, beforeAll } from "vitest";
import type { Db, Conn } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor, payFor } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { uploadDocument } from "../src/ops/documents.js";
import { createLocation, createSku, moveStock } from "../src/ops/fulfilment.js";
import { createLocation as whLocation, createSku as whSku, createWarehouse, listStock } from "../src/ops/warehouse.js";
import { applyStockMigration, stageStockMigration } from "../src/ops/stock-migration.js";
import { createStaff } from "../src/platform/admin.js";
import { accrueCommission, createPartner, decidePayout, partnerBalances, recordReferral, requestPayout } from "../src/platform/partners.js";
import { processPaymentEvent } from "../src/platform/billing.js";
import { buildMockEvent } from "../src/platform/billing.js";
import { addToCohort, createCohort, isReleased, removeFromCohort, setFlag } from "../src/platform/rollout.js";
import { churnSummary, cohortRetention, revenueMovement, tenantContribution } from "../src/platform/reports.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
async function member(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`sc-${role}-${++n}-${Date.now()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
const csvDoc = (c: Conn, ctx: any, csv: string) => uploadDocument(c, ctx, { kind: "other", title: `Snapshot ${++n}`, issuer: "Old system", filename: "s.csv", data: Buffer.from(csv) });
const clean = async () => expect(await verifyInvariants(db)).toEqual([]);

describe("stock opening balances and final delta", () => {
  it("fulfilment: reconciles to a control total, needs a second approver, adjusts only the difference, and blocks drift", async () => {
    const t = await newTenant(db, undefined, ["ecommerce-fulfilment"]);
    const approver = await member(t.tenantId, "owner");
    const { sku, loc } = await db.tenant(t.tenantId, async (c) => {
      const m = await createParty(c, t.ctx, { kind: "customer", name: "Shop" });
      const sku = await createSku(c, t.ctx, { party_id: m, code: "TEE", name: "Tee" });
      await createSku(c, t.ctx, { party_id: m, code: "CAP", name: "Cap" });
      const loc = await createLocation(c, t.ctx, { code: "A-1" });
      return { sku, loc };
    });
    const q = (s: string, p?: any[]) => db.tenant(t.tenantId, (c) => c.query<any>(s, p));
    // wrong control total is an error that cannot be applied
    const bad = await db.tenant(t.tenantId, async (c) => { const d = await csvDoc(c, t.ctx, "sku_code,location_code,qty\nTEE,A-1,10\nCAP,A-1,5\n"); return stageStockMigration(c, t.ctx, "fulfilment", d, "Opening load", 99); });
    await expect(db.tenant(t.tenantId, (c) => applyStockMigration(c, approver, bad, "x"))).rejects.toThrow(/Resolve the snapshot errors/);
    const id = await db.tenant(t.tenantId, async (c) => { const d = await csvDoc(c, t.ctx, "sku_code,location_code,qty\nTEE,A-1,10\nCAP,A-1,5\n"); return stageStockMigration(c, t.ctx, "fulfilment", d, "Opening load", 15); });
    expect((await q(`SELECT status FROM stock_migrations WHERE id=$1`, [bad])).rows[0].status).toBe("superseded");
    await expect(db.tenant(t.tenantId, (c) => applyStockMigration(c, t.ctx, id, "ok"))).rejects.toThrow(/second person/);
    const sum = await db.tenant(t.tenantId, (c) => applyStockMigration(c, approver, id, "Counted and signed off; fallback retained"));
    expect(sum.posted).toBe(2);
    expect(Number((await q(`SELECT on_hand FROM stock_levels WHERE sku_id=$1 AND location_id=$2`, [sku, loc])).rows[0].on_hand)).toBe(10);
    // idempotent retry
    await db.tenant(t.tenantId, (c) => applyStockMigration(c, approver, id, "retry"));
    expect((await q(`SELECT count(*)::int n FROM stock_movements WHERE ref_type='stock_migration'`)).rows[0].n).toBe(2);
    // final delta: only TEE changed in the old system since
    const d2 = await db.tenant(t.tenantId, async (c) => { const d = await csvDoc(c, t.ctx, "sku_code,location_code,qty\nTEE,A-1,7\nCAP,A-1,5\n"); return stageStockMigration(c, t.ctx, "fulfilment", d, "Final delta", 12); });
    const st = (await q(`SELECT summary FROM stock_migrations WHERE id=$1`, [d2])).rows[0].summary;
    expect(st.changes).toBe(1); expect(st.net_delta).toBe(-3);
    // stock moves between validation and approval → must restage
    await db.tenant(t.tenantId, (c) => moveStock(c, t.ctx, { skuId: sku, locationId: loc, delta: 1, kind: "adjust", note: "found one" }));
    await expect(db.tenant(t.tenantId, (c) => applyStockMigration(c, approver, d2, "go"))).rejects.toThrow(/Stock moved/);
    await clean();
  });

  it("custody: loads owner/lot positions and refuses duplicates and unknown positions", async () => {
    const t = await newTenant(db, undefined, ["contract-warehouse-3pl"]);
    const approver = await member(t.tenantId, "owner");
    const ids = await db.tenant(t.tenantId, async (c) => {
      const owner = await createParty(c, t.ctx, { kind: "customer", name: "Acme Foods" });
      const wh = await createWarehouse(c, t.ctx, { code: "W1", name: "W1" });
      await whLocation(c, t.ctx, { warehouse_id: wh, code: "A-01", kind: "storage" });
      const sku = await whSku(c, t.ctx, { owner_id: owner, code: "RICE", description: "Rice" });
      return { owner, sku };
    });
    const stage = (csv: string, units: number) => db.tenant(t.tenantId, async (c) => stageStockMigration(c, t.ctx, "custody", await csvDoc(c, t.ctx, csv), "Opening", units));
    const dup = await stage("owner,sku_code,location_code,lot,qty\nAcme Foods,RICE,A-01,,4\nAcme Foods,RICE,A-01,,4\n", 8);
    expect((await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT summary FROM stock_migrations WHERE id=$1`, [dup]))).rows[0].summary.errors.join(" ")).toMatch(/duplicate/);
    const unk = await stage("owner,sku_code,location_code,lot,qty\nAcme Foods,NOPE,A-01,,4\n", 4);
    expect((await db.tenant(t.tenantId, (c) => c.query<any>(`SELECT summary FROM stock_migrations WHERE id=$1`, [unk]))).rows[0].summary.errors.join(" ")).toMatch(/SKU/);
    const ok = await stage("owner,sku_code,location_code,lot,qty\nAcme Foods,RICE,A-01,,40\n", 40);
    await db.tenant(t.tenantId, (c) => applyStockMigration(c, approver, ok, "Counted; signed off"));
    const rows = await db.tenant(t.tenantId, (c) => listStock(c, {}));
    expect(rows.reduce((a: number, r: any) => a + Number(r.qty_on_hand), 0)).toBe(40);
    void ids;
    await clean();
  });
});

describe("partner commission and refund ledger", () => {
  it("accrues on paid orders inside the window, reverses exactly on refund, and pays out under dual control", async () => {
    const staffA = (await createStaff(db, `sa-${Date.now()}@example.com`, "A", "Passw0rd!pass", "commercial_admin")).userId;
    const staffB = (await createStaff(db, `sb-${Date.now()}@example.com`, "B", "Passw0rd!pass", "commercial_admin")).userId;
    const t = await newTenant(db);
    const partner = await db.system((c) => createPartner(c, { userId: staffA }, { name: `Gulf Advisers ${Date.now()}`, commission_bps: 1000, commission_months: 12, agreement_ref: "AGR-1" }));
    await expect(db.system((c) => createPartner(c, { userId: staffA }, { name: "x", commission_bps: 9000, commission_months: 12, agreement_ref: "a" }))).rejects.toThrow(/0–50%/);
    await db.system((c) => recordReferral(c, { userId: staffA }, partner, t.tenantId, "Intro email 2026-01-04"));
    await expect(db.system((c) => recordReferral(c, { userId: staffA }, partner, t.tenantId, "again"))).rejects.toThrow(/already/);
    const { order, ev } = await payFor(db, t);
    const led = () => db.system((c) => c.query<any>(`SELECT * FROM partner_ledger WHERE partner_id=$1 ORDER BY created_at, kind`, [partner])).then((r) => r.rows);
    let rows = await led();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount_minor)).toBe(Math.round(Number(order.total_minor) * 0.1));
    // a repeated delivery never double-accrues
    await processPaymentEvent(db, "mock", ev);
    await db.system((c) => accrueCommission(c, order));
    expect(await led()).toHaveLength(1);
    // refund reverses exactly
    await processPaymentEvent(db, "mock", buildMockEvent(order, "payment.refunded"));
    rows = await led();
    expect(rows.map((r: any) => r.kind).sort()).toEqual(["commission", "reversal"]);
    expect(rows.reduce((s: number, r: any) => s + Number(r.amount_minor), 0)).toBe(0);
    await clean();
    // a second paid order accrues, then a payout needs a different person
    const t2 = await newTenant(db);
    await db.system((c) => recordReferral(c, { userId: staffA }, partner, t2.tenantId, "Intro 2"));
    const paid2 = await payFor(db, t2);
    const owed = Math.round(Number(paid2.order.total_minor) * 0.1);
    await expect(db.system((c) => requestPayout(c, { userId: staffA }, partner, paid2.order.currency, owed + 1))).rejects.toThrow(/exceed/);
    const pid = await db.system((c) => requestPayout(c, { userId: staffA }, partner, paid2.order.currency, owed));
    await expect(db.system((c) => decidePayout(c, { userId: staffA }, pid, true, "TRF1"))).rejects.toThrow(/second person/);
    await db.system((c) => decidePayout(c, { userId: staffB }, pid, true, "TRF1"));
    const bal = (await db.system((c) => partnerBalances(c))).find((b: any) => b.id === partner && b.currency === paid2.order.currency);
    expect(Number(bal.owed)).toBe(0);
    await expect(db.system((c) => c.query(`UPDATE partner_ledger SET amount_minor=1`))).rejects.toThrow();
    await clean();
  });
});

describe("rollout cohorts and flags", () => {
  it("is off by default, follows cohort membership, and releases to everyone only on request", async () => {
    const staff = (await createStaff(db, `sr-${Date.now()}@example.com`, "R", "Passw0rd!pass", "engineer")).userId;
    const s = { userId: staff };
    const a = await newTenant(db), b = await newTenant(db);
    const key = `new-picking-${Date.now()}`;
    const chk = (tid: string) => db.system((c) => isReleased(c, key, tid));
    expect(await chk(a.tenantId)).toBe(false);            // unknown flag
    const cohort = await db.system((c) => createCohort(c, s, `Pilot ${Date.now()}`, "design partners"));
    await db.system((c) => addToCohort(c, s, cohort, a.tenantId));
    await expect(db.system((c) => setFlag(c, s, key, "cohorts", [], "x"))).rejects.toThrow(/at least one cohort/);
    await expect(db.system((c) => setFlag(c, s, "Bad Key", "all", []))).rejects.toThrow(/Flag keys/);
    await db.system((c) => setFlag(c, s, key, "cohorts", [cohort], "pilot"));
    expect(await chk(a.tenantId)).toBe(true);
    expect(await chk(b.tenantId)).toBe(false);
    await db.system((c) => removeFromCohort(c, s, cohort, a.tenantId));
    expect(await chk(a.tenantId)).toBe(false);
    await db.system((c) => setFlag(c, s, key, "all", []));
    expect(await chk(b.tenantId)).toBe(true);
    await db.system((c) => setFlag(c, s, key, "off", []));
    expect(await chk(b.tenantId)).toBe(false);
  });
});

describe("retention, churn and contribution reports", () => {
  it("reports cohorts, state, revenue movement and contribution net of refunds and commission", async () => {
    const staff = (await createStaff(db, `sx-${Date.now()}@example.com`, "X", "Passw0rd!pass", "commercial_admin")).userId;
    const t = await newTenant(db);
    const partner = await db.system((c) => createPartner(c, { userId: staff }, { name: `Reporter ${Date.now()}`, commission_bps: 2000, commission_months: 6, agreement_ref: "AGR-R" }));
    await db.system((c) => recordReferral(c, { userId: staff }, partner, t.tenantId, "Intro"));
    const { order } = await payFor(db, t);
    const mine = (await tenantContribution(db)).find((r) => r.tenant_id === t.tenantId)!;
    expect(mine.revenue).toBe(Number(order.total_minor));
    expect(mine.partner_commission).toBe(Math.round(Number(order.total_minor) * 0.2));
    expect(mine.contribution).toBe(mine.revenue - mine.partner_commission);
    expect(mine.ai_cost_usd_micro).toBe(0);
    const coh = await cohortRetention(db);
    const row = coh.find((r) => r.signup === new Date().toISOString().slice(0, 7))!;
    expect(row.paid).toBeGreaterThan(0);
    expect(row.active).toBeGreaterThan(0);
    const mov = (await revenueMovement(db)).filter((r) => r.month === new Date().toISOString().slice(0, 7));
    expect(mov.reduce((s, r) => s + r.gross, 0)).toBeGreaterThanOrEqual(Number(order.total_minor));
    expect((await churnSummary(db)).active.count).toBeGreaterThan(0);
  });
});
