import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant } from "./helpers.js";
import { createParty } from "../src/ops/crm.js";
import { dismissInbound, forwardInboundToBill, listInbound } from "../src/ops/einvoice-sync.js";
import { approveBill, getBill } from "../src/ops/finance-bridge.js";
import { ctxFor } from "./helpers.js";
import { permsFor } from "../src/lib/perms.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const today = new Date().toISOString().slice(0, 10), later = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);

async function setup(total = 10500, over: Record<string, any> = {}) {
  const t = await newTenant(db);
  const run = <T,>(fn: (c: any) => Promise<T>) => db.tenant(t.tenantId, fn);
  const supplier = await run((c) => createParty(c, t.ctx, { kind: "supplier", name: "Gulf Hauliers LLC" }));
  const base = (await db.query<any>(`SELECT currency FROM entities WHERE tenant_id=$1 LIMIT 1`, [t.tenantId])).rows[0]?.currency ?? "AED";
  const row = { number: "GH-2041", currency: base, total_minor: total, issued_on: today, sender_name: "Gulf Hauliers LLC", ...over };
  const id = (await db.system((c) => c.query<any>(`INSERT INTO einvoice_inbound(tenant_id,provider,provider_doc_id,number,sender_name,currency,total_minor,issued_on) VALUES ($1,'wafeq',$2,$3,$4,$5,$6,$7) RETURNING id`,
    [t.tenantId, `doc-${Math.random()}`, row.number, row.sender_name, row.currency, row.total_minor, row.issued_on]))).rows[0].id as string;
  return { t, run, supplier, id, ccy: base };
}

describe("received supplier invoices → purchasing", () => {
  it("creates one draft bill equal to the received total, exactly once, which then follows the normal bill approval", async () => {
    const s = await setup(10500);
    const bill = await s.run((c) => forwardInboundToBill(c, s.t.ctx, s.id, { supplier_id: s.supplier, due_date: later }));
    const b = await s.run((c) => getBill(c, bill.id));
    expect(b.bill ?? b).toMatchObject({ supplier_ref: "GH-2041", total_minor: 10500, subtotal_minor: 10000, tax_minor: 500, status: "draft" });
    expect((await s.run((c) => listInbound(c)))[0]).toMatchObject({ status: "billed", bill_id: bill.id });
    await expect(s.run((c) => forwardInboundToBill(c, s.t.ctx, s.id, { supplier_id: s.supplier, due_date: later }))).rejects.toThrow(/already been entered/);
    await expect(s.run((c) => dismissInbound(c, s.t.ctx, s.id, "not ours at all"))).rejects.toThrow(/already been handled/);
    // approval still needs a second person
    await expect(s.run((c) => approveBill(c, s.t.ctx, bill.id))).rejects.toThrow();
    expect(await verifyInvariants(db)).toEqual([]);
  });

  it("refuses a total it cannot reproduce and leaves no bill behind; accepts explicit lines that match", async () => {
    const s = await setup(10510);                 // 10510 does not round-trip through 5%
    await expect(s.run((c) => forwardInboundToBill(c, s.t.ctx, s.id, { supplier_id: s.supplier, due_date: later }))).rejects.toThrow(/would total/);
    expect((await db.query<any>(`SELECT count(*)::int n FROM vendor_bills WHERE tenant_id=$1`, [s.t.tenantId])).rows[0].n).toBe(0);
    expect((await s.run((c) => listInbound(c)))[0].status).toBe("received");
    const bill = await s.run((c) => forwardInboundToBill(c, s.t.ctx, s.id, { supplier_id: s.supplier, due_date: later, lines: [{ description: "Haulage", net: 10000, tax_code: "SR5" }, { description: "Exempt fee", net: 10, tax_code: "ZR0" }] }));
    expect(bill.no).toBeTruthy();
  });

  it("waits for the provider's facts, refuses customers as suppliers and callers without finance rights, and can be dismissed with a reason", async () => {
    const s = await setup(10500, {});
    await db.system((c) => c.query(`UPDATE einvoice_inbound SET total_minor=NULL WHERE id=$1`, [s.id]));
    await expect(s.run((c) => forwardInboundToBill(c, s.t.ctx, s.id, { supplier_id: s.supplier, due_date: later }))).rejects.toThrow(/not yet supplied/);
    await db.system((c) => c.query(`UPDATE einvoice_inbound SET total_minor=10500 WHERE id=$1`, [s.id]));
    const cust = await s.run((c) => createParty(c, s.t.ctx, { kind: "customer", name: "A customer" }));
    await expect(s.run((c) => forwardInboundToBill(c, s.t.ctx, s.id, { supplier_id: cust, due_date: later }))).rejects.toThrow(/suppliers and agents/);
    const viewer = ctxFor(s.t.ctx.userId, s.t.tenantId, ["viewer"]);
    expect(permsFor(["viewer"]).has("finance.write")).toBe(false);
    await expect(s.run((c) => forwardInboundToBill(c, viewer, s.id, { supplier_id: s.supplier, due_date: later }))).rejects.toThrow();
    await expect(s.run((c) => dismissInbound(c, s.t.ctx, s.id, "no"))).rejects.toThrow(/reason/);
    await s.run((c) => dismissInbound(c, s.t.ctx, s.id, "Duplicate of an invoice we already hold"));
    expect((await s.run((c) => listInbound(c)))[0].status).toBe("dismissed");
    await expect(s.run((c) => forwardInboundToBill(c, s.t.ctx, s.id, { supplier_id: s.supplier, due_date: later }))).rejects.toThrow(/dismissed/);
  });
});
