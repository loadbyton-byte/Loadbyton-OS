import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, convertedJob } from "./helpers.js";
import { importParties, parseCsv } from "../src/ops/importer.js";
import { verifyInvariants } from "../src/platform/invariants.js";
import { invoiceJob, recordReceipt } from "../src/ops/finance.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

describe("CSV import", () => {
  it("parses quoted fields and CRLF", () => {
    expect(parseCsv('name,email\r\n"Acme, Inc.","a@x.com"\r\n"Say ""hi""",b@x.com\r\n')).toEqual([["name", "email"], ["Acme, Inc.", "a@x.com"], ['Say "hi"', "b@x.com"]]);
  });
  it("creates, skips duplicates, rejects bad rows, supports dry run", async () => {
    const t = await newTenant(db);
    const csv = "name,kind,email\nAlpha Co,customer,a@x.com\nalpha co,customer,\nBeta Ltd,supplier,not-an-email\nGamma,wizard,\nDelta,supplier,d@x.com\n";
    const dry = await db.tenant(t.tenantId, (c) => importParties(c, t.ctx, csv, true));
    expect(dry).toMatchObject({ created: 2 });
    expect((await db.tenant(t.tenantId, (c) => c.query(`SELECT 1 FROM parties`))).rows).toHaveLength(0);
    const r = await db.tenant(t.tenantId, (c) => importParties(c, t.ctx, csv));
    expect(r.created).toBe(2); expect(r.duplicates).toEqual(["alpha co"]); expect(r.rejected.map((x) => x.line)).toEqual([4, 5]);
    const again = await db.tenant(t.tenantId, (c) => importParties(c, t.ctx, csv));
    expect(again.created).toBe(0);
  });
});

describe("invariants", () => {
  it("hold after a normal quote-to-cash cycle and detect tampering", async () => {
    const t = await newTenant(db);
    const j = await convertedJob(db, t);
    await db.tenant(t.tenantId, async (c) => { const i = await invoiceJob(c, t.ctx, j.jobId); await recordReceipt(c, t.ctx, i.id, { amount: "100" }); });
    expect(await verifyInvariants(db)).toEqual([]);
    await db.system((c) => c.query(`UPDATE invoices SET paid_minor = paid_minor + 5 WHERE tenant_id=$1`, [t.tenantId]));
    const v = await verifyInvariants(db);
    expect(v.map((x) => x.check)).toContain("paid = sum of receipts that have not been reversed");
    await db.system((c) => c.query(`UPDATE invoices SET paid_minor = paid_minor - 5 WHERE tenant_id=$1`, [t.tenantId]));
    expect(await verifyInvariants(db)).toEqual([]);
  });
});
