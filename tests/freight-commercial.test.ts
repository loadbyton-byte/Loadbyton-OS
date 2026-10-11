import { describe, it, expect, beforeAll } from "vitest";
import type { Db, Conn } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor, convertedJob, future } from "./helpers.js";
import { createParty, createEnquiry, createRate } from "../src/ops/crm.js";
import { createQuote, submitQuote, sendQuote } from "../src/ops/quotes.js";
import { addCost, createJobFromQuote } from "../src/ops/jobs.js";
import {
  addLane, addMasterCost, allocateMasterCost, attachHouse, cancelMaster, closeMaster, createMaster, createOpportunity, createSupplierContract, detachHouse, linkQuote,
  manifestCsv, masterSummary, moveOpportunity, pipelineReport, priceRate, setContractStatus, setRateTiers, setSupplierPolicy, splitProportionally, supplierProblems, validateAwb, getOpportunity,
} from "../src/ops/freight-commercial.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
let n = 0;
async function member(tenantId: string, role: string) {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`fc-${role}-${++n}-${Date.now()}@example.com`, role]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
const clean = async () => expect(await verifyInvariants(db)).toEqual([]);
const exp = (d = 365) => future(d);

describe("rate tiers", () => {
  it("applies the highest break reached to the whole quantity, honours the minimum, and fixes the breaks once set", async () => {
    const t = await newTenant(db);
    await db.tenant(t.tenantId, async (c) => {
      const sup = await createParty(c, t.ctx, { kind: "supplier", name: "Airline" });
      const rate = await createRate(c, t.ctx, { supplier_id: sup, mode: "air", origin: "DXB", destination: "LHR", charge_name: "Air freight", basis: "per_kg", unit_cost: "10.00", minimum: "250.00", valid_from: future(-1), valid_to: exp() });
      await expect(setRateTiers(c, t.ctx, rate, [{ from_qty: 0, unit_cost: "10" }])).rejects.toThrow(/at least two/);
      await expect(setRateTiers(c, t.ctx, rate, [{ from_qty: 1, unit_cost: "10" }, { from_qty: 100, unit_cost: "9" }])).rejects.toThrow(/start at 0/);
      await expect(setRateTiers(c, t.ctx, rate, [{ from_qty: 0, unit_cost: "10" }, { from_qty: 100, unit_cost: "11" }])).rejects.toThrow(/must not cost more/);
      await setRateTiers(c, t.ctx, rate, [{ from_qty: 0, unit_cost: "10" }, { from_qty: 100, unit_cost: "8.50" }, { from_qty: 500, unit_cost: "7" }]);
      await expect(setRateTiers(c, t.ctx, rate, [{ from_qty: 0, unit_cost: "9" }, { from_qty: 50, unit_cost: "8" }])).rejects.toThrow(/fixed/);
      expect(await priceRate(c, rate, 10)).toMatchObject({ unit_minor: 1000, total_minor: 25000, minimum_applied: true, tier_from: 0 });
      expect(await priceRate(c, rate, 99.5)).toMatchObject({ unit_minor: 1000, total_minor: 99500 });
      expect(await priceRate(c, rate, 100)).toMatchObject({ unit_minor: 850, total_minor: 85000, tier_from: 100 });
      expect(await priceRate(c, rate, 600)).toMatchObject({ unit_minor: 700, total_minor: 420000, tier_from: 500 });
      await expect(c.query(`UPDATE rate_tiers SET unit_cost_minor=1`)).rejects.toThrow();
    });
  });

  it("flags a quote line whose cost disagrees with its rate for approval", async () => {
    const t = await newTenant(db);
    const r = await db.tenant(t.tenantId, async (c) => {
      const cust = await createParty(c, t.ctx, { kind: "customer", name: "Buyer" });
      const sup = await createParty(c, t.ctx, { kind: "supplier", name: "Line" });
      const rate = await createRate(c, t.ctx, { supplier_id: sup, mode: "ocean", origin: "Shanghai", destination: "Jebel Ali", charge_name: "O/F", basis: "per_cbm", unit_cost: "50", valid_from: future(-1), valid_to: exp() });
      await setRateTiers(c, t.ctx, rate, [{ from_qty: 0, unit_cost: "50" }, { from_qty: 20, unit_cost: "40" }]);
      const mk = (cost: string) => createQuote(c, t.ctx, { party_id: cust, valid_until: future(), lines: [{ description: "Ocean", qty: 25, unit_sell: "80", unit_cost: cost, supplier_id: sup, rate_id: rate }] });
      return { good: await submitQuote(c, t.ctx, (await mk("40")).id), bad: await submitQuote(c, t.ctx, (await mk("30")).id) };
    });
    expect(r.good.status).toBe("approved");
    expect(r.bad.status).toBe("pending_approval");
    expect(r.bad.reasons.join(" ")).toMatch(/differs from its supplier rate/);
  });
});

describe("supplier contract restrictions", () => {
  it("blocks work outside a supplier's contract, lets an approver override with a reason, and honours blocks", async () => {
    const t = await newTenant(db);
    const { jobId, supplierId } = await convertedJob(db, t);   // ocean Shanghai → Jebel Ali
    const approver = await member(t.tenantId, "owner");
    const acct = await member(t.tenantId, "finance");
    await db.tenant(t.tenantId, async (c) => {
      expect(await supplierProblems(c, supplierId, { mode: "ocean" })).toEqual([]);              // unrestricted until contracted
      const k = await createSupplierContract(c, t.ctx, { supplier_id: supplierId, reference: "CT-1", valid_from: future(-5), valid_to: exp(), modes: "air", origins: "Dubai", max_cost: "1000" });
      expect((await supplierProblems(c, supplierId, { mode: "ocean", origin: "Shanghai", destination: "Jebel Ali", amountMinor: 5000 })).join()).toMatch(/mode ocean is not covered/);
      await expect(addCost(c, acct, jobId, { supplier_id: supplierId, description: "Extra", estimated: "10" })).rejects.toThrow(/An approver must authorise/);
      await expect(addCost(c, approver, jobId, { supplier_id: supplierId, description: "Extra", estimated: "10" })).rejects.toThrow(/override reason/);
      await addCost(c, approver, jobId, { supplier_id: supplierId, description: "Extra", estimated: "10", contract_override: "Spot cover, agreed by phone with ops director" });
      expect((await c.query<any>(`SELECT contract_override FROM job_costs WHERE description='Extra'`)).rows[0].contract_override).toMatch(/Spot cover/);
      await setContractStatus(c, approver, k, "ended");
      const k2 = await createSupplierContract(c, t.ctx, { supplier_id: supplierId, reference: "CT-2", valid_from: future(-5), valid_to: exp(), modes: "ocean", origins: "shanghai", destinations: "jebel ali", max_cost: "100" });
      expect(await supplierProblems(c, supplierId, { mode: "ocean", origin: "Shanghai, CN", destination: "Jebel Ali", amountMinor: 9000 })).toEqual([]);
      expect((await supplierProblems(c, supplierId, { mode: "ocean", origin: "Shanghai", destination: "Jebel Ali", amountMinor: 20000 })).join()).toMatch(/exceeds/);
      await setContractStatus(c, approver, k2, "suspended");
      await setSupplierPolicy(c, approver, supplierId, { contract_required: true });
      expect((await supplierProblems(c, supplierId, { mode: "ocean" })).join()).toMatch(/requires an active contract/);
      await expect(setSupplierPolicy(c, approver, supplierId, { blocked: true })).rejects.toThrow(/Reason for blocking/);
      await setSupplierPolicy(c, approver, supplierId, { blocked: true, blocked_reason: "Failed audit" });
      expect((await supplierProblems(c, supplierId, { mode: "ocean" })).join()).toMatch(/blocked: Failed audit/);
    });
  });

  it("raises a quote for approval when a line uses a restricted supplier", async () => {
    const t = await newTenant(db);
    const res = await db.tenant(t.tenantId, async (c) => {
      const cust = await createParty(c, t.ctx, { kind: "customer", name: "Buyer 2" });
      const sup = await createParty(c, t.ctx, { kind: "supplier", name: "Restricted" });
      await setSupplierPolicy(c, t.ctx, sup, { blocked: true, blocked_reason: "Sanctions screening pending" });
      const q = await createQuote(c, t.ctx, { party_id: cust, valid_until: future(), lines: [{ description: "Freight", qty: 1, unit_sell: "500", unit_cost: "100", supplier_id: sup }] });
      return submitQuote(c, t.ctx, q.id);
    });
    expect(res.status).toBe("pending_approval");
    expect(res.reasons.join()).toMatch(/Sanctions screening pending/);
  });
});

describe("opportunities and tenders", () => {
  it("runs bid/no-bid under separation of duties, needs a sent quote to submit, and records the outcome", async () => {
    const t = await newTenant(db);
    const approver = await member(t.tenantId, "owner");
    const sales = await member(t.tenantId, "sales");
    const { cust, quote } = await db.tenant(t.tenantId, async (c) => {
      const cust = await createParty(c, t.ctx, { kind: "customer", name: "Ministry Logistics" });
      const quote = await createQuote(c, t.ctx, { party_id: cust, valid_until: future(), lines: [{ description: "Annual lane", qty: 1, unit_sell: "10000", unit_cost: "5000" }] });
      return { cust, quote: quote.id };
    });
    await db.tenant(t.tenantId, async (c) => {
      const o = await createOpportunity(c, sales, { kind: "tender", party_id: cust, title: "Annual freight tender 2027", source_ref: "T-2027/14", est_value: "250000", win_pct: 30, clarification_by: future(5), submission_by: future(10) });
      await addLane(c, sales, o.id, { mode: "ocean", origin: "Shanghai", destination: "Jebel Ali", volume: 120, unit: "teu" });
      await expect(createOpportunity(c, sales, { kind: "tender", party_id: cust, title: "x", clarification_by: future(9), submission_by: future(3) })).rejects.toThrow(/Clarifications/);
      await moveOpportunity(c, sales, o.id, "bid_review");
      await expect(moveOpportunity(c, sales, o.id, "bidding", { note: "we should bid" })).rejects.toThrow(/Your role/);          // sales cannot decide
      await expect(moveOpportunity(c, approver, o.id, "bidding", {})).rejects.toThrow(/rationale/);
      await moveOpportunity(c, approver, o.id, "bidding", { note: "Strong lane fit, margin acceptable" });
      await expect(moveOpportunity(c, approver, o.id, "won", { note: "x" })).rejects.toThrow(/cannot move/);
      await expect(moveOpportunity(c, sales, o.id, "submitted")).rejects.toThrow(/sent to the customer/);
      await linkQuote(c, sales, o.id, quote);
      await expect(moveOpportunity(c, sales, o.id, "submitted")).rejects.toThrow(/sent to the customer/);       // linked but still a draft
      await submitQuote(c, t.ctx, quote); await sendQuote(c, t.ctx, quote);
      await moveOpportunity(c, sales, o.id, "submitted", { note: "Uploaded to the portal" });
      await expect(moveOpportunity(c, sales, o.id, "lost", {})).rejects.toThrow(/Reason lost/);
      await moveOpportunity(c, sales, o.id, "won", { note: "Award letter AL-221" });
      const d = await getOpportunity(c, o.id);
      expect(d.opp.closed_at).toBeTruthy();
      expect(d.events.map((e: any) => e.to_stage)).toEqual(["identified", "bid_review", "bidding", "submitted", "won"]);
      await expect(moveOpportunity(c, sales, o.id, "lost", { lost_reason: "x" })).rejects.toThrow(/cannot move/);
      // a no-bid and a loss feed the report
      const o2 = await createOpportunity(c, sales, { kind: "rfq", party_id: cust, title: "Spot RFQ", est_value: "1000", submission_by: future(-1) });
      const o3 = await createOpportunity(c, t.ctx, { kind: "renewal", party_id: cust, title: "Renewal", est_value: "5000" });
      await moveOpportunity(c, approver, o3.id, "no_bid", { note: "Below minimum margin" });
      const rep = await pipelineReport(c);
      expect(rep.won).toBeGreaterThanOrEqual(1);
      expect(rep.due.find((x: any) => x.id === o2.id)?.overdue).toBe(true);
      expect(rep.stages.find((s: any) => s.stage === "identified")?.value).toBeDefined();
    });
    await expect(db.tenant(t.tenantId, (c) => c.query(`UPDATE opportunity_events SET note='x'`))).rejects.toThrow();
    await clean();
  });
});

describe("master and house shipments", () => {
  it("validates air waybills, attaches houses, allocates a carrier charge exactly, and refuses edits afterwards", async () => {
    expect(validateAwb("176-12345675")).toBe("176-12345675");           // 1234567 mod 7 = 5
    expect(() => validateAwb("176-12345676")).toThrow(/check digit/);
    expect(() => validateAwb("17-1234")).toThrow(/11 digits/);
    expect(Array.from(splitProportionally(100, [{ key: "a", w: 1 }, { key: "b", w: 1 }, { key: "c", w: 1 }]).values()).sort()).toEqual([33, 33, 34]);

    const t = await newTenant(db);
    const j = [await convertedJob(db, t), await convertedJob(db, t), await convertedJob(db, t)];
    const extra = [await convertedJob(db, t), await convertedJob(db, t)];
    const ops = await member(t.tenantId, "owner");
    await db.tenant(t.tenantId, async (c) => {
      for (const [i, x] of j.entries()) await c.query(`UPDATE jobs SET pieces=$2, weight_kg=$3, volume_cbm=$4 WHERE id=$1`, [x.jobId, 10 * (i + 1), [100, 200, 700][i], [1, 2, 7][i]]);
      await expect(createMaster(c, t.ctx, { mode: "ocean", master_ref: "", origin: "Shanghai", destination: "Jebel Ali" })).rejects.toThrow();
      const m = await createMaster(c, t.ctx, { mode: "ocean", master_ref: "MSCU1234567", carrier: "MSC", origin: "Shanghai", destination: "Jebel Ali", vessel_or_flight: "MSC Aurora", etd: future(2), eta: future(20) });
      await expect(createMaster(c, t.ctx, { mode: "ocean", master_ref: "mscu1234567", origin: "a", destination: "b" })).rejects.toThrow(/already exists/);
      await expect(attachHouse(c, t.ctx, m.id, j[0].jobId, "")).rejects.toThrow(/House reference/);
      await attachHouse(c, t.ctx, m.id, j[0].jobId, "HBL-001");
      await expect(attachHouse(c, t.ctx, m.id, j[0].jobId, "HBL-001")).rejects.toThrow(/already on a master/);
      await expect(attachHouse(c, t.ctx, m.id, j[1].jobId, "hbl-001")).rejects.toThrow(/already on this master/);
      await attachHouse(c, t.ctx, m.id, j[1].jobId, "HBL-002");
      await attachHouse(c, t.ctx, m.id, j[2].jobId, "HBL-003");
      const air = await createMaster(c, t.ctx, { mode: "air", master_ref: "176-12345675", origin: "DXB", destination: "LHR" });
      await expect(attachHouse(c, t.ctx, air.id, extra[0].jobId, "H1")).rejects.toThrow(/ocean job/);
      await cancelMaster(c, t.ctx, air.id);
      const s = await masterSummary(c, m.id);
      expect(s.totals).toMatchObject({ houses: 3, pieces: 60, weight_kg: 1000, volume_cbm: 10, chargeable: null });
      const cost = await addMasterCost(c, ops, m.id, { description: "Ocean freight MSCU1234567", amount: "1000.01" });
      await expect(allocateMasterCost(c, ops, cost, "chargeable_weight")).rejects.toThrow(/chargeable-weight assessment/);
      await expect(closeMaster(c, t.ctx, m.id)).rejects.toThrow(/Allocate 1 master charge/);
      await allocateMasterCost(c, ops, cost, "weight");
      const al = (await c.query<any>(`SELECT j.house_ref, a.amount_minor::int AS amt, k.estimated_minor::int AS est FROM freight_master_allocations a JOIN jobs j ON j.id=a.job_id JOIN job_costs k ON k.id=a.job_cost_id ORDER BY j.house_ref`)).rows;
      expect(al.map((r: any) => r.amt)).toEqual([10000, 20000, 70001]);                      // 100:200:700 of 100001: the odd minor unit goes to the largest fractional remainder (70000.7)
      expect(al.reduce((a: number, r: any) => a + r.amt, 0)).toBe(100001);
      expect(al.every((r: any) => r.amt === r.est)).toBe(true);
      await expect(allocateMasterCost(c, ops, cost, "weight")).rejects.toThrow(/final/);
      await expect(detachHouse(c, t.ctx, m.id, j[0].jobId)).rejects.toThrow(/allocated/);
      expect(await manifestCsv(c, m.id)).toMatch(/MSCU1234567","HBL-001"/);
      await closeMaster(c, t.ctx, m.id);
      await expect(attachHouse(c, t.ctx, m.id, extra[1].jobId, "HBL-9")).rejects.toThrow(/closed/);
      await expect(c.query(`UPDATE freight_master_allocations SET amount_minor=1`)).rejects.toThrow();
    });
    await clean();
  });
});
void createJobFromQuote; void createEnquiry; void addLane;
