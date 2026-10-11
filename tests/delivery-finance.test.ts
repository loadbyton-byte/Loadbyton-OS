import { describe, it, expect, beforeAll } from "vitest";
import type { Db, Conn } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import { permsFor, type Ctx } from "../src/lib/perms.js";
import { createParty } from "../src/ops/crm.js";
import { createDriver } from "../src/ops/transport.js";
import { invite, acceptInvite } from "../src/ops/team.js";
import { applyRiderEvent, closeRun, createRemittance, createRun, createShipment, decideSettlement, payRemittance, settleRider, startRun, type RiderEvent } from "../src/ops/delivery.js";
import { autoMatchBankLines, bankReconciliation, decideWriteOff, getCashPolicy, ignoreBankLine, importBankStatement, liabilityReport, matchBankLine, proposeWriteOff, setCashPolicy, unmatchBankLine, writeOffsCsv } from "../src/ops/delivery-finance.js";
import { verifyInvariants } from "../src/platform/invariants.js";
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
const parcel = (s: Site, f: Record<string, any> = {}) => run(s, (c) => createShipment(c, s.t.ctx, { merchant_id: s.shop, consignee_name: "Aisha K", consignee_phone: "0501234567", address: "Villa 4", emirate: "Dubai", ...f }));
const ev = (id: string, kind: RiderEvent["kind"], payload: Record<string, any> = {}, over: Partial<RiderEvent> = {}): RiderEvent =>
  ({ client_event_id: `ev-${Math.random().toString(36).slice(2)}-${Date.now()}`, shipment_id: id, kind, device_time: iso(), payload, ...over });
/** Rider takes a COD parcel out and delivers it, leaving uncounted cash. */
async function delivered(s: Site, cod: string, rider = s.rider, ctx = s.riderCtx, over: Partial<RiderEvent> = {}) {
  const p = await parcel(s, { cod });
  const r = await run(s, async (c) => { const x = await createRun(c, s.t.ctx, { driver_id: rider, shipment_ids: [p.id] }); await startRun(c, s.t.ctx, x.id); return x; });
  const res = await run(s, (c) => applyRiderEvent(c, ctx, ev(p.id, "deliver", { name: "Aisha", cash: cod }, over)));
  expect(res.outcome).toBe("applied");
  return { ...p, runId: r.id };
}
const exceptions = async (s: Site) => (await run(s, (c) => c.query<any>(`SELECT title FROM job_exceptions`))).rows.map((r: any) => r.title as string);

describe("offline cash controls", () => {
  it("blocks a new run while a rider holds too much or too-old cash, allows a recorded supervisor override, and clears after counting", async () => {
    const s = await site();
    const finance = await staff(s.t.tenantId, "finance"), coord = await staff(s.t.tenantId, "coordinator");
    await expect(run(s, (c) => setCashPolicy(c, finance, { max_unsettled: "50", max_unsettled_hours: 24, max_offline_hours: 12, writeoff_owner_above: "10" }))).rejects.toThrow(/owner/);
    await run(s, (c) => setCashPolicy(c, s.t.ctx, { max_unsettled: "50", max_unsettled_hours: 24, max_offline_hours: 12, writeoff_owner_above: "10" }));
    const first = await delivered(s, "70");
    expect(await exceptions(s)).toContain("Cash limit exceeded: Rashid");
    await run(s, (c) => closeRun(c, s.t.ctx, first.runId));
    const p2 = await parcel(s);
    const r2 = await run(s, (c) => createRun(c, s.t.ctx, { driver_id: s.rider, shipment_ids: [p2.id] }));
    await expect(run(s, (c) => startRun(c, s.t.ctx, r2.id))).rejects.toThrow(/uncounted cash/);
    await expect(run(s, (c) => startRun(c, ctxFor(s.t.userId, s.t.tenantId, ["warehouse"]), r2.id, "need it"))).rejects.toThrow();
    await run(s, (c) => startRun(c, coord, r2.id, "Supervisor accepts the risk: cash desk closed on Friday"));
    await run(s, (c) => applyRiderEvent(c, s.riderCtx, ev(p2.id, "deliver", { name: "Aisha" })));
    expect(Number((await run(s, (c) => c.query<any>(`SELECT count(*) n FROM audit_log WHERE action='dlv_run.cash_hold_overridden'`))).rows[0].n)).toBe(1);
    await run(s, (c) => closeRun(c, s.t.ctx, r2.id));
    await run(s, (c) => settleRider(c, finance, s.rider, { counted: "70" }));
    const p3 = await parcel(s);
    const r3 = await run(s, (c) => createRun(c, s.t.ctx, { driver_id: s.rider, shipment_ids: [p3.id] }));
    await run(s, (c) => startRun(c, s.t.ctx, r3.id));                                      // no hold any more
    await noViolations();
  });

  it("flags events that reach the server long after they happened", async () => {
    const s = await site();
    await run(s, (c) => setCashPolicy(c, s.t.ctx, { max_unsettled: "5000", max_unsettled_hours: 48, max_offline_hours: 6, writeoff_owner_above: "500" }));
    await delivered(s, "20", s.rider, s.riderCtx, { device_time: iso(-60 * 8) });          // 8 h old, window 6 h
    expect((await exceptions(s)).some((t) => t.startsWith("Late offline sync"))).toBe(true);
    expect((await run(s, (c) => getCashPolicy(c))).max_offline_hours).toBe(6);
  });
});

describe("bank statement matching", () => {
  async function settled(s: Site, finance: Ctx, approver: Ctx) {
    await delivered(s, "40");
    const h = await run(s, (c) => settleRider(c, finance, s.rider, { counted: "40" }));
    const rem = await run(s, (c) => createRemittance(c, approver, s.shop));
    await run(s, (c) => payRemittance(c, s.t.ctx, rem.id, { reference: "TRF-889201" }));
    return { h, rem };
  }
  it("matches exact document numbers and amounts, leaves the rest to people, refuses re-imports, and keeps lines immutable", async () => {
    const s = await site();
    const finance = await staff(s.t.tenantId, "finance"), coord = await staff(s.t.tenantId, "coordinator");
    const { h, rem } = await settled(s, finance, finance);
    const csv = [`date,amount,reference,description`,
      `2026-03-02,40.00,DEP ${h.no},Cash deposit branch 4`,
      `2026-03-03,-40.00,payout,Transfer TRF-889201 Souq Shop`,
      `05/03/2026,-3.50,FEE,Monthly account fee`,
      `2026-03-06,12.00,UNKNOWN,Customer refund reversal`].join("\n");
    const r = await run(s, (c) => importBankStatement(c, finance, "March", csv));
    expect(r).toMatchObject({ lines: 4, matched: 2 });
    await expect(run(s, (c) => importBankStatement(c, finance, "March again", csv))).rejects.toThrow(/already imported/);
    await expect(run(s, (c) => importBankStatement(c, finance, "Bad", "date,amount\n2026-13-45,5"))).rejects.toThrow(/date/);
    const rec = await run(s, (c) => bankReconciliation(c));
    expect(rec.unmatchedLines.map((l: any) => Number(l.amount_minor)).sort((a: number, b: number) => a - b)).toEqual([-350, 1200]);
    const fee = rec.unmatchedLines.find((l: any) => Number(l.amount_minor) === -350);
    await expect(run(s, (c) => matchBankLine(c, finance, fee.id, { remittance_id: rem.id }))).rejects.toThrow(/already|debit/);
    await run(s, (c) => ignoreBankLine(c, finance, fee.id, "bank_fee", "March account fee"));
    await expect(run(s, (c) => ignoreBankLine(c, finance, fee.id, "other", "again"))).rejects.toThrow(/already/);
    const line = (await run(s, (c) => c.query<any>(`SELECT id FROM dlv_bank_lines WHERE settlement_id=$1`, [h.id]))).rows[0].id;
    await expect(db.query(`UPDATE dlv_bank_lines SET amount_minor=1 WHERE id=$1`, [line])).rejects.toThrow(/immutable/);
    await run(s, (c) => unmatchBankLine(c, coord, line, "Deposit slip belongs to another run"));
    expect((await run(s, (c) => autoMatchBankLines(c, finance)))).toBe(1);                 // re-matches the same exact pair
    await noViolations();
  });
  it("manual matches must equal the counted amount", async () => {
    const s = await site();
    const finance = await staff(s.t.tenantId, "finance");
    const { h } = await settled(s, finance, finance);
    await run(s, (c) => importBankStatement(c, finance, "Short deposit", `date,amount,reference\n2026-04-01,39.00,cash drop`));
    const line = (await run(s, (c) => c.query<any>(`SELECT id FROM dlv_bank_lines`))).rows[0].id;
    await expect(run(s, (c) => matchBankLine(c, finance, line, { settlement_id: h.id }))).rejects.toThrow(/counted/);
  });
});

describe("approved shortage write-offs", () => {
  it("caps at the counted shortage, needs another approver, sends big amounts to the owner and feeds the liability report", async () => {
    const s = await site();
    const finance = await staff(s.t.tenantId, "finance"), coord = await staff(s.t.tenantId, "coordinator"), coord2 = await staff(s.t.tenantId, "coordinator");
    await run(s, (c) => setCashPolicy(c, s.t.ctx, { max_unsettled: "5000", max_unsettled_hours: 48, max_offline_hours: 24, writeoff_owner_above: "15" }));
    await delivered(s, "100");
    const h = await run(s, (c) => settleRider(c, finance, s.rider, { counted: "70", note: "Rider says a customer short-paid" }));
    await run(s, (c) => decideSettlement(c, coord, h.id, true));
    await expect(run(s, (c) => proposeWriteOff(c, finance, { settlement_id: h.id, amount: "31", reason: "Too much" }))).rejects.toThrow(/At most AED 30.00/);
    const w1 = await run(s, (c) => proposeWriteOff(c, finance, { settlement_id: h.id, amount: "10", reason: "Unrecoverable after two calls" }));
    await expect(run(s, (c) => decideWriteOff(c, finance, w1.id, true, "self"))).rejects.toThrow(/proposed it/);
    await run(s, (c) => decideWriteOff(c, coord2, w1.id, true, "Approved"));
    const w2 = await run(s, (c) => proposeWriteOff(c, finance, { settlement_id: h.id, amount: "20", reason: "Remainder" }));
    await expect(run(s, (c) => decideWriteOff(c, coord2, w2.id, true, "ok"))).rejects.toThrow(/owner/);
    await run(s, (c) => decideWriteOff(c, s.t.ctx, w2.id, false, "Keep recovering from the rider"));
    const rep = (await run(s, (c) => liabilityReport(c)))[0];
    expect(rep).toMatchObject({ shortage_minor: 3000, written_off_minor: 1000, outstanding_minor: 2000 });
    const csv = await run(s, (c) => writeOffsCsv(c, s.t.ctx));
    expect(csv.split("\n").length).toBe(2);
    expect(csv).toContain("10.00");
    await expect(db.query(`UPDATE dlv_writeoffs SET amount_minor=1 WHERE id=$1`, [w1.id])).rejects.toThrow(/immutable/);
    await noViolations();
  });
});
