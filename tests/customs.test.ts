import { describe, it, expect, beforeAll } from "vitest";
import type { Db, Conn } from "../src/db/client.js";
import { freshDb, newTenant, ctxFor } from "./helpers.js";
import type { Ctx } from "../src/lib/perms.js";
import { createParty } from "../src/ops/crm.js";
import {
  CHECKLIST_TEMPLATES, addCharge, addInspection, addLine, allocate, answerQuery, approveCase, attachEvidence, billDisbursements, cancelCase, closeCase, closeInspection, createCase, depositBalance,
  getCase, handoverPack, invoiceCase, linesCsv, listCases, listDeposits, markSeen, normalizeHs, portalCases, raiseQuery, readinessIssues, receiveDeposit, recordAssessment, recordPayment, recordRejection,
  recordSubmission, refundDeposit, releaseCase, removeLine, reopenAfterRejection, reopenCase, resetItem, returnForChanges, submitForReview, updateCase, updateLine, varianceOf, waiveItem, customsOverview,
  type LineInput,
} from "../src/ops/customs.js";
import { getInvoice, voidInvoice } from "../src/ops/finance.js";
import { verifyInvariants } from "../src/platform/invariants.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

let n = 0;
async function staff(tenantId: string, role: string): Promise<Ctx> {
  const id = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`cus-${role}-${++n}-${Date.now()}@example.com`, `${role} ${n}`]))).rows[0].id;
  await db.system((c) => c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [tenantId, id, [role]]));
  return ctxFor(id, tenantId, [role]);
}
const PDF = () => Buffer.from(`%PDF-1.4\n1 0 obj\n<<>>\nendobj\n% ${Math.random()}\n`);

async function site() {
  const t = await newTenant(db, undefined, ["customs-brokerage"]);
  const maker = await staff(t.tenantId, "customs"), checker = await staff(t.tenantId, "customs"), finance = await staff(t.tenantId, "finance");
  const r = await db.tenant(t.tenantId, async (c) => ({
    acme: await createParty(c, t.ctx, { kind: "customer", name: "Acme Imports LLC" }),
    zed: await createParty(c, t.ctx, { kind: "customer", name: "Zed Trading" }),
  }));
  return { t, maker, checker, finance, ...r };
}
type Site = Awaited<ReturnType<typeof site>>;
const run = <T>(s: Site, fn: (c: Conn) => Promise<T>) => db.tenant(s.t.tenantId, fn);
const noViolations = async () => expect(await verifyInvariants(db)).toEqual([]);

const baseCase = (s: Site, over: Record<string, any> = {}) => ({ party_id: s.acme, direction: "import", mode: "sea", customs_office: "Jebel Ali", origin_country: "CN", destination_country: "AE", incoterm: "cif", currency: "USD", fx_rate: "3.6725", freight: "400", insurance: "40", transport_ref: "MAEU1234567", ...over });
const lineA: LineInput = { description: "Laptops", hs_code: "8471.30.10", origin_country: "CN", qty: 10, net_kg: 25, gross_kg: 30, value: "1000.00", duty_pct: 5, vat_pct: 5 };
const lineB: LineInput = { description: "Cables", hs_code: "854442", origin_country: "CN", qty: 100, net_kg: 40, gross_kg: 45, value: "3000.00", duty_pct: 0, vat_pct: 5 };

/** A case filled in with two lines and all mandatory evidence, left collecting. */
async function ready(s: Site, over: Record<string, any> = {}) {
  const k = await run(s, (c) => createCase(c, s.maker, baseCase(s, over)));
  await run(s, async (c) => { await addLine(c, s.maker, k.id, lineA); await addLine(c, s.maker, k.id, lineB); });
  const items = (await run(s, (c) => getCase(c, k.id))).checklist.filter((x: any) => x.mandatory);
  for (const it of items) await run(s, (c) => attachEvidence(c, s.maker, k.id, { item_id: it.id, kind: it.kind, title: it.label, filename: "doc.pdf", data: PDF() }));
  return k;
}
const toApproved = async (s: Site, over: Record<string, any> = {}) => {
  const k = await ready(s, over);
  await run(s, (c) => submitForReview(c, s.maker, k.id));
  await run(s, (c) => approveCase(c, s.checker, k.id));
  return k;
};
let decl = 0;
const submitted = async (s: Site, over: Record<string, any> = {}) => {
  const k = await toApproved(s, over);
  await run(s, (c) => recordSubmission(c, s.maker, k.id, { channel: "dubai_trade", declaration_no: `DT-2026-${String(++decl).padStart(6, "0")}` }));
  return k;
};
const status = async (s: Site, id: string) => (await run(s, (c) => getCase(c, id))).case.status;

describe("valuation arithmetic", () => {
  it("allocates exactly: parts always sum to the total, in proportion, with the largest remainders rounded up", () => {
    expect(allocate(440_00, [100000, 300000])).toEqual([110_00, 330_00]);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]); expect(allocate(50, [])).toEqual([]); expect(allocate(50, [0, 0])).toEqual([0, 0]);
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 300; i++) {
      const w = Array.from({ length: 1 + (rnd() % 9) }, () => 1 + (rnd() % 5_000_000)), total = rnd() % 900_000_000;
      const a = allocate(total, w);
      expect(a.reduce((x, y) => x + y, 0)).toBe(total);
      a.forEach((x, j) => { const exact = (total * w[j]) / w.reduce((p, q) => p + q, 0); expect(Math.abs(x - exact)).toBeLessThan(1); });
    }
    expect(allocate(9_000_000_000_000, [9_000_000_000, 1_000_000_000]).reduce((x, y) => x + y, 0)).toBe(9_000_000_000_000);   // no precision loss above 2^53 intermediates
  });

  it("estimates CIF, duty and VAT from the broker's own rates (worked example, half-up rounding) and recomputes on every change", async () => {
    const s = await site();
    const k = await run(s, (c) => createCase(c, s.maker, baseCase(s)));
    const a = await run(s, (c) => addLine(c, s.maker, k.id, lineA));
    expect(a.totals).toMatchObject({ value: 100000, alloc: 44000, cifAed: 528840, duty: 26442, vat: 27764 });     // with one line it carries all of freight and insurance: 1440.00 × 3.6725 = 5288.40
    await run(s, (c) => addLine(c, s.maker, k.id, lineB));
    const d = await run(s, (c) => getCase(c, k.id));
    const [A, B] = d.lines;
    expect(Number(A.alloc_minor)).toBe(11000); expect(Number(B.alloc_minor)).toBe(33000);                                            // 440.00 split 1000:3000
    expect(Number(A.cif_aed_minor)).toBe(407648);                                                                                    // 1110.00 × 3.6725 = 4076.475 → 4076.48
    expect(Number(A.duty_minor)).toBe(20382); expect(Number(A.vat_minor)).toBe(21402);                                               // 5% duty; VAT on CIF + duty
    expect(Number(B.cif_aed_minor)).toBe(1222943); expect(Number(B.duty_minor)).toBe(0); expect(Number(B.vat_minor)).toBe(61147);
    expect(d.totals).toMatchObject({ duty: 20382, vat: 82549, value: 400000, alloc: 44000 });
    await run(s, (c) => updateCase(c, s.maker, k.id, { freight: "0", insurance: "0" }));                                               // header change re-allocates every line
    const e = await run(s, (c) => getCase(c, k.id));
    expect(e.totals.alloc).toBe(0); expect(Number(e.lines[0].cif_aed_minor)).toBe(367250);
    await run(s, (c) => updateLine(c, s.maker, A.id, { ...lineA, duty_pct: 10 }));
    expect(Number((await run(s, (c) => getCase(c, k.id))).lines[0].duty_minor)).toBe(36725);
    await noViolations();
  });

  it("validates codes, countries, currency and rates; HS codes are format-checked only", async () => {
    expect(normalizeHs("8471.30.10")).toBe("84713010"); expect(normalizeHs(" 8471 30 ")).toBe("847130"); expect(normalizeHs("8471-3010-00")).toBe("8471301000");
    for (const bad of ["12345", "8471.3x", "", "1234567890123"]) expect(() => normalizeHs(bad)).toThrow(/6 to 12 digits/);
    const s = await site();
    const mk = (o: Record<string, any>) => run(s, (c) => createCase(c, s.maker, baseCase(s, o)));
    await expect(mk({ origin_country: "China" })).rejects.toThrow(/2-letter country code/);
    await expect(mk({ currency: "DOLLARS" })).rejects.toThrow(/3-letter code/);
    await expect(mk({ fx_rate: "0" })).rejects.toThrow(/positive number/);
    await expect(mk({ currency: "AED", fx_rate: "3.67" })).rejects.toThrow(/exchange rate is 1/);
    await expect(mk({ direction: "smuggle" })).rejects.toThrow(/Choose import/);
    await expect(mk({ mode: "teleport" })).rejects.toThrow(/Choose sea, air or road/);
    await expect(mk({ party_id: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/not found/);
    const k = await mk({});
    const bad = (o: Partial<LineInput>) => run(s, (c) => addLine(c, s.maker, k.id, { ...lineA, ...o }));
    await expect(bad({ value: "0" })).rejects.toThrow(/above zero/); await expect(bad({ duty_pct: 150 })).rejects.toThrow(/between 0% and 100%/);
    await expect(bad({ vat_pct: 30 })).rejects.toThrow(/between 0% and 25%/); await expect(bad({ net_kg: 10, gross_kg: 5 })).rejects.toThrow(/Gross weight/);
    await expect(bad({ restricted: true })).rejects.toThrow(/permit or specialist handling/); await expect(bad({ description: " " })).rejects.toThrow(/Description is required/);
  });

  it("numbers cases without gaps, counts them against the plan and stops at the allowance", async () => {
    const s = await site();
    const a = await run(s, (c) => createCase(c, s.maker, baseCase(s)));
    await expect(run(s, (c) => createCase(c, s.maker, baseCase(s, { direction: "nope" })))).rejects.toThrow();
    const b = await run(s, (c) => createCase(c, s.maker, baseCase(s)));
    expect(a.no).toMatch(/^CUS-\d{4}-00001$/); expect(b.no).toMatch(/-00002$/);
    expect((await db.query<any>(`SELECT limits FROM plan_versions WHERE plan_code='free' AND version=6`)).rows[0].limits.cus_cases_per_month).toBe(5);
    await db.system((c) => c.query(`UPDATE usage_counters SET used=5 WHERE tenant_id=$1 AND key='cus_cases_per_month'`, [s.t.tenantId]));
    await expect(run(s, (c) => createCase(c, s.maker, baseCase(s)))).rejects.toThrow(/limit reached for cus_cases_per_month/);
    expect((await run(s, (c) => listCases(c))).length).toBe(2);
  });
});

describe("evidence checklist", () => {
  it("starts from a suggested list per direction, which the broker can edit, and flags restricted goods with a mandatory permit item", async () => {
    const s = await site();
    for (const dir of ["import", "export", "re_export", "transit"]) {
      const k = await run(s, (c) => createCase(c, s.maker, baseCase(s, { direction: dir })));
      const d = await run(s, (c) => getCase(c, k.id));
      expect(d.checklist.map((x: any) => x.label).sort()).toEqual(CHECKLIST_TEMPLATES[dir].map((x) => x.label).sort());
    }
    const k = await run(s, (c) => createCase(c, s.maker, baseCase(s)));
    const l = await run(s, (c) => addLine(c, s.maker, k.id, { ...lineA, restricted: true, restriction_note: "Telecom equipment needs a type approval" }));
    const withPermit = (await run(s, (c) => getCase(c, k.id))).checklist.find((x: any) => x.source === "restricted_goods");
    expect(withPermit).toMatchObject({ mandatory: true, status: "missing", kind: "import_permit" });
    await run(s, (c) => addLine(c, s.maker, k.id, { ...lineB, restricted: true, restriction_note: "also" }));
    expect((await run(s, (c) => getCase(c, k.id))).checklist.filter((x: any) => x.source === "restricted_goods")).toHaveLength(1);       // never duplicated
    await run(s, (c) => updateLine(c, s.maker, l.id, { ...lineA, restricted: false }));
    expect((await run(s, (c) => getCase(c, k.id))).checklist.some((x: any) => x.source === "restricted_goods")).toBe(true);             // still one restricted line left
    const lines = (await run(s, (c) => getCase(c, k.id))).lines;
    await run(s, (c) => removeLine(c, s.maker, lines[1].id));
    expect((await run(s, (c) => getCase(c, k.id))).checklist.some((x: any) => x.source === "restricted_goods")).toBe(false);             // nothing restricted any more: the untouched item goes
    expect((await run(s, (c) => getCase(c, k.id))).lines.map((x: any) => x.line_no)).toEqual([1]);                                      // numbering closes up
  });

  it("evidence uploads are stored as documents and tick the item; 'seen' needs a note; waiving needs approval rights and a written reason", async () => {
    const s = await site();
    const k = await run(s, (c) => createCase(c, s.maker, baseCase(s)));
    const items = (await run(s, (c) => getCase(c, k.id))).checklist;
    const inv = items.find((x: any) => x.kind === "commercial_invoice"), coo = items.find((x: any) => x.kind === "certificate_of_origin"), dorder = items.find((x: any) => x.kind === "delivery_order");
    const docId = await run(s, (c) => attachEvidence(c, s.maker, k.id, { item_id: inv.id, kind: "commercial_invoice", title: "Invoice INV-77", filename: "inv77.pdf", data: PDF() }));
    const d1 = await run(s, (c) => getCase(c, k.id));
    expect(d1.checklist.find((x: any) => x.id === inv.id)).toMatchObject({ status: "received", document_id: docId, doc_title: "Invoice INV-77" });
    expect((await db.query<any>(`SELECT cus_case_id, storage_key FROM documents WHERE id=$1`, [docId])).rows[0]).toMatchObject({ cus_case_id: k.id });
    await expect(run(s, (c) => attachEvidence(c, s.maker, k.id, { item_id: inv.id, kind: "other", title: "x", filename: "evil.exe", data: Buffer.from("MZ") }))).rejects.toThrow(/not allowed/);
    await expect(run(s, (c) => markSeen(c, s.maker, dorder.id, " "))).rejects.toThrow(/note saying where/);
    await run(s, (c) => markSeen(c, s.maker, dorder.id, "Original DO seen at the shipping line counter"));
    await expect(run(s, (c) => waiveItem(c, s.maker, coo.id, ""))).rejects.toThrow(/reason/);
    const warehouse = await staff(s.t.tenantId, "warehouse");
    await expect(run(s, (c) => waiveItem(c, warehouse, coo.id, "not needed"))).rejects.toThrow(/does not allow/);
    await run(s, (c) => waiveItem(c, s.checker, coo.id, "Origin treatment is not claimed on this consignment"));
    expect((await run(s, (c) => getCase(c, k.id))).checklist.find((x: any) => x.id === coo.id)).toMatchObject({ status: "waived", waived_reason: expect.stringContaining("not claimed") });
    await expect(run(s, (c) => attachEvidence(c, s.maker, k.id, { item_id: coo.id, kind: "certificate_of_origin", title: "x", filename: "c.pdf", data: PDF() }))).rejects.toThrow(/waived/);
    await run(s, (c) => resetItem(c, s.maker, coo.id));
    expect((await run(s, (c) => getCase(c, k.id))).checklist.find((x: any) => x.id === coo.id)!.status).toBe("missing");
    await noViolations();
  });

  it("will not go to review until everything is in order, and says everything that is wrong at once", async () => {
    const s = await site();
    const k = await run(s, (c) => createCase(c, s.maker, baseCase(s, { transport_ref: "", customs_office: "", origin_country: "" })));
    const err = await run(s, (c) => submitForReview(c, s.maker, k.id)).catch((e) => e.message as string);
    for (const part of ["bill of lading", "customs office", "goods line", "country of origin", "Missing: Commercial invoice", "Missing: Packing list", "Missing: Delivery order"]) expect(err).toContain(part);
    expect(await status(s, k.id)).toBe("collecting");
    await run(s, (c) => updateCase(c, s.maker, k.id, { transport_ref: "BL-1", customs_office: "Jebel Ali", origin_country: "CN" }));
    expect((await run(s, (c) => readinessIssues(c, k.id))).length).toBe(5);              // lines + 4 mandatory evidence items remain
  });
});

describe("independent approval and handover", () => {
  it("the preparer cannot approve; a second customs officer can; the owner may approve their own; the estimate is frozen at approval", async () => {
    const s = await site();
    const k = await ready(s);
    await run(s, (c) => submitForReview(c, s.maker, k.id));
    expect(await status(s, k.id)).toBe("in_review");
    await expect(run(s, (c) => approveCase(c, s.maker, k.id))).rejects.toThrow(/person who prepared it/);
    const sales = await staff(s.t.tenantId, "sales");
    await expect(run(s, (c) => approveCase(c, sales, k.id))).rejects.toThrow(/does not allow/);
    await run(s, (c) => approveCase(c, s.checker, k.id));
    const d = await run(s, (c) => getCase(c, k.id));
    expect(d.case).toMatchObject({ status: "approved", approved_by: s.checker.userId, prepared_by: s.maker.userId, estimated_duty_minor: 20382, estimated_vat_minor: 82549 });
    // single-user company: the owner prepares and approves
    const solo = await run(s, (c) => createCase(c, s.t.ctx, baseCase(s)));
    await run(s, async (c) => { await addLine(c, s.t.ctx, solo.id, lineA); });
    for (const it of (await run(s, (c) => getCase(c, solo.id))).checklist.filter((x: any) => x.mandatory)) await run(s, (c) => markSeen(c, s.t.ctx, it.id, "seen"));
    await run(s, (c) => submitForReview(c, s.t.ctx, solo.id));
    await run(s, (c) => approveCase(c, s.t.ctx, solo.id));
    expect(await status(s, solo.id)).toBe("approved");
    await noViolations();
  });

  it("editing during review sends the case back; an approved case is frozen until it is reopened with a reason; returned cases keep their history", async () => {
    const s = await site();
    const k = await ready(s);
    await run(s, (c) => submitForReview(c, s.maker, k.id));
    await run(s, (c) => updateCase(c, s.maker, k.id, { incoterm: "FOB" }));
    expect(await status(s, k.id)).toBe("collecting");
    await run(s, (c) => submitForReview(c, s.maker, k.id));
    await expect(run(s, (c) => returnForChanges(c, s.checker, k.id, " "))).rejects.toThrow(/Reason is required/);
    await run(s, (c) => returnForChanges(c, s.checker, k.id, "HS code on line 2 looks wrong"));
    await run(s, (c) => submitForReview(c, s.maker, k.id));
    await run(s, (c) => approveCase(c, s.checker, k.id));
    const lineId = (await run(s, (c) => getCase(c, k.id))).lines[0].id;
    await expect(run(s, (c) => updateLine(c, s.maker, lineId, lineA))).rejects.toThrow(/reopen it first/);
    await expect(run(s, (c) => addLine(c, s.maker, k.id, lineA))).rejects.toThrow(/approved .* cannot be edited/);
    await expect(run(s, (c) => reopenCase(c, s.maker, k.id, "changed my mind"))).resolves.toBeUndefined();   // the customs role also holds approval rights
    const d = await run(s, (c) => getCase(c, k.id));
    expect(d.case).toMatchObject({ status: "collecting", approved_by: null, estimated_duty_minor: null, reopen_count: 1 });
    expect(d.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["created", "sent_for_review", "edited_during_review", "returned_for_changes", "approved", "reopened"]));
    await noViolations();
  });

  it("records the official declaration number once; refuses duplicates in the same channel, bad numbers and future times; a handed-over case is no longer editable", async () => {
    const s = await site();
    const k1 = await toApproved(s), k2 = await toApproved(s);
    await expect(run(s, (c) => recordSubmission(c, s.finance, k1.id, { channel: "dubai_trade", declaration_no: "DT-1" }))).rejects.toThrow(/does not allow/);
    for (const bad of ["", "ab", "has space!", "x".repeat(60)]) await expect(run(s, (c) => recordSubmission(c, s.maker, k1.id, { channel: "dubai_trade", declaration_no: bad }))).rejects.toThrow(/declaration number/);
    await expect(run(s, (c) => recordSubmission(c, s.maker, k1.id, { channel: "fax", declaration_no: "DT-100" }))).rejects.toThrow(/official channel/);
    await expect(run(s, (c) => recordSubmission(c, s.maker, k1.id, { channel: "mirsal2", declaration_no: "DT-100", submitted_at: new Date(Date.now() + 3600_000).toISOString() }))).rejects.toThrow(/not valid/);
    await run(s, (c) => recordSubmission(c, s.maker, k1.id, { channel: "dubai_trade", declaration_no: "dt 2026 000777" }));
    expect((await run(s, (c) => getCase(c, k1.id))).case).toMatchObject({ status: "submitted", declaration_no: "DT2026000777", channel: "dubai_trade", submitted_by: s.maker.userId });
    await expect(run(s, (c) => recordSubmission(c, s.maker, k2.id, { channel: "dubai_trade", declaration_no: "DT2026000777" }))).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already recorded on another case") });
    expect(await status(s, k2.id)).toBe("approved");                                              // the failed attempt changed nothing
    await run(s, (c) => recordSubmission(c, s.maker, k2.id, { channel: "mirsal2", declaration_no: "DT2026000777" }));   // same number in another channel is a different declaration
    await expect(run(s, (c) => updateCase(c, s.maker, k1.id, { incoterm: "EXW" }))).rejects.toThrow(/submitted .* cannot be edited/);
    await expect(run(s, (c) => cancelCase(c, s.maker, k1.id, "x"))).rejects.toThrow(/handed over/);
    await expect(run(s, (c) => recordSubmission(c, s.maker, k1.id, { channel: "mirsal2", declaration_no: "NEW-1" }))).rejects.toThrow(/Only an approved case/);
    await noViolations();
  });

  it("the handover pack exists only after approval, carries the evidence fingerprints and approvals, and the CSV is safe to open in a spreadsheet", async () => {
    const s = await site();
    const k = await ready(s, { transport_ref: "BL-1" });
    await expect(run(s, (c) => handoverPack(c, k.id))).rejects.toThrow(/once the case has been approved/);
    await run(s, (c) => addLine(c, s.maker, k.id, { ...lineA, description: '=HYPERLINK("http://evil","x"),"quoted"' }));
    await run(s, (c) => submitForReview(c, s.maker, k.id)); await run(s, (c) => approveCase(c, s.checker, k.id));
    const pack = await run(s, (c) => handoverPack(c, k.id));
    expect(pack.checklist.filter((x: any) => x.mandatory).every((x: any) => /^[0-9a-f]{64}$/.test(x.sha256))).toBe(true);
    expect(pack.case).toMatchObject({ prepared_name: expect.any(String), approved_name: expect.any(String) });
    const csv = linesCsv(pack);
    const rows = csv.trim().split("\r\n");
    expect(rows[0]).toBe("line,description,hs_code,origin,qty,uom,net_kg,gross_kg,value_USD,freight_insurance_other_alloc,cif_aed,duty_rate_pct_entered,est_duty_aed,vat_rate_pct_entered,est_vat_aed,restricted");
    expect(rows).toHaveLength(4);
    expect(csv).toContain('"\'=HYPERLINK(""http://evil"",""x""),""quoted"""');        // a leading = is neutralised and quotes are escaped
    expect(csv).toContain("84713010"); expect(csv).toContain("3995.68");                    // three lines: 1000+88 allocated = 1088.00 × 3.6725
  });
});

describe("after submission: assessment, inspections, queries, payment, release", () => {
  it("compares the assessment with the frozen estimate and flags a material difference (≥ AED 100 and ≥ 5%)", async () => {
    expect(varianceOf(10_000, 0, 10_000, 0)).toMatchObject({ diff: 0, pct: 0, flagged: false });
    expect(varianceOf(100_000, 0, 104_000, 0)).toMatchObject({ diff: 4000, pct: 4, flagged: false });          // 4% and AED 40
    expect(varianceOf(100_000, 0, 106_000, 0)).toMatchObject({ pct: 6, flagged: false });                      // 6% but only AED 60
    expect(varianceOf(1_000_000, 0, 1_060_000, 0)).toMatchObject({ pct: 6, flagged: true });                   // AED 600 and 6%
    expect(varianceOf(0, 0, 500, 0)).toMatchObject({ pct: 100 });
    const s = await site();
    const k = await submitted(s);
    await expect(run(s, (c) => recordAssessment(c, s.finance, k.id, { duty: "1", vat: "1" }))).rejects.toThrow(/does not allow/);
    const v = await run(s, (c) => recordAssessment(c, s.maker, k.id, { duty: "260.00", vat: "850.00" }));        // estimate 203.82 + 825.49 = 1029.31 → assessed 1110.00
    expect(v).toMatchObject({ estimated: 102931, assessed: 111000, diff: 8069, flagged: false });
    const d = await run(s, (c) => getCase(c, k.id));
    expect(d.case).toMatchObject({ status: "assessed", assessed_duty_minor: 26000, assessed_vat_minor: 85000 });
    expect(d.variance).toMatchObject({ pct: 7.84 });
    const k2 = await submitted(s);
    expect((await run(s, (c) => recordAssessment(c, s.maker, k2.id, { duty: "900.00", vat: "1500.00" }))).flagged).toBe(true);
    await expect(run(s, (c) => recordAssessment(c, s.maker, (k as any).id, { duty: "-1", vat: "1" }))).rejects.toThrow(/valid amount/);
  });

  it("release needs the duty paid in full, inspections closed and queries answered — and tells you every reason", async () => {
    const s = await site();
    const k = await submitted(s);
    await expect(run(s, (c) => releaseCase(c, s.maker, k.id, { release_ref: "GP-1" }))).rejects.toThrow(/Only an assessed case/);
    await run(s, (c) => recordAssessment(c, s.maker, k.id, { duty: "203.82", vat: "825.49" }));
    await run(s, (c) => addInspection(c, s.maker, k.id, { kind: "physical", location: "Gate 4" }));
    expect(await status(s, k.id)).toBe("inspection");
    const q = await run(s, (c) => raiseQuery(c, s.maker, k.id, { text: "Provide the manufacturer's certificate", due_on: "2030-01-01" }));
    const tasks = await run(s, (c) => c.query<any>(`SELECT title, status FROM job_exceptions WHERE title LIKE 'Customs query%'`));
    expect(tasks.rows).toEqual([{ title: expect.stringContaining(`[Q:${q.slice(0, 8)}]`), status: "open" }]);
    await run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "duty", amount: "203.82", method: "bank", reference: "BANK-1" }));
    const msg = await run(s, (c) => releaseCase(c, s.maker, k.id, { release_ref: "GP-1" })).catch((e) => e.message as string);
    expect(msg).toMatch(/not fully paid \(203\.82 recorded\)/); expect(msg).toMatch(/1 inspection\(s\) are still open/); expect(msg).toMatch(/1 customs query\(ies\) are unanswered/);
    const ins = (await run(s, (c) => getCase(c, k.id))).inspections[0];
    await expect(run(s, (c) => closeInspection(c, s.maker, ins.id, { result: "passed", findings: " " }))).rejects.toThrow(/Findings is required/);
    await run(s, (c) => closeInspection(c, s.maker, ins.id, { result: "passed_with_conditions", findings: "Seal re-applied" }));
    expect(await status(s, k.id)).toBe("assessed");
    await expect(run(s, (c) => closeInspection(c, s.maker, ins.id, { result: "passed", findings: "again" }))).rejects.toThrow(/already closed/);
    await run(s, (c) => answerQuery(c, s.maker, q, "Certificate uploaded to the portal"));
    expect((await run(s, (c) => c.query<any>(`SELECT status FROM job_exceptions WHERE title LIKE 'Customs query%'`))).rows[0].status).toBe("resolved");
    await expect(run(s, (c) => answerQuery(c, s.maker, q, "x"))).rejects.toThrow(/already answered/);
    await expect(run(s, (c) => releaseCase(c, s.maker, k.id, { release_ref: "GP-1" }))).rejects.toThrow(/not fully paid/);
    await run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "vat", amount: "825.49", method: "bank", reference: "BANK-2" }));
    await expect(run(s, (c) => releaseCase(c, s.maker, k.id, { release_ref: " " }))).rejects.toThrow(/reference is required/);
    await run(s, (c) => releaseCase(c, s.maker, k.id, { release_ref: "GP-2026-1" }));
    expect((await run(s, (c) => getCase(c, k.id))).case).toMatchObject({ status: "released", release_ref: "GP-2026-1", released_by: s.maker.userId });
    await run(s, (c) => closeCase(c, s.maker, k.id));
    await noViolations();
  });

  it("a failed inspection or a customs rejection takes the case out of the flow; preparing it again clears the declaration but keeps the history", async () => {
    const s = await site();
    const k = await submitted(s);
    const first = (await run(s, (c) => getCase(c, k.id))).case.declaration_no;
    await run(s, (c) => addInspection(c, s.maker, k.id, { kind: "lab" }));
    const ins = (await run(s, (c) => getCase(c, k.id))).inspections[0];
    await run(s, (c) => closeInspection(c, s.maker, ins.id, { result: "failed", findings: "Sample does not match the declared goods" }));
    const d = await run(s, (c) => getCase(c, k.id));
    expect(d.case).toMatchObject({ status: "rejected", rejection_reason: expect.stringContaining("Inspection failed") });
    expect((await run(s, (c) => c.query<any>(`SELECT title FROM job_exceptions WHERE title LIKE '%inspection failed'`))).rows).toHaveLength(1);
    await run(s, (c) => reopenAfterRejection(c, s.maker, k.id));
    const e = await run(s, (c) => getCase(c, k.id));
    expect(e.case).toMatchObject({ status: "collecting", declaration_no: null, channel: null, approved_by: null, reopen_count: 1 });
    expect(e.events.find((x: any) => x.kind === "prepared_again").detail).toMatchObject({ previous_declaration_no: first });
    // the old number is free to be reused only because it no longer belongs to this case; a fresh case can't take a still-active number
    const k2 = await submitted(s);
    await run(s, (c) => recordRejection(c, s.maker, k2.id, "Declared value inconsistent with the invoice"));
    expect(await status(s, k2.id)).toBe("rejected");
    await expect(run(s, (c) => recordRejection(c, s.maker, k2.id, "again"))).rejects.toThrow(/Only a submitted case/);
    // duty already paid blocks re-preparing
    const k3 = await submitted(s);
    await run(s, (c) => recordAssessment(c, s.maker, k3.id, { duty: "10", vat: "10" }));
    await run(s, (c) => recordPayment(c, s.finance, k3.id, { kind: "duty", amount: "10", method: "bank", reference: "B" }));
    await run(s, (c) => recordRejection(c, s.maker, k3.id, "Rejected after assessment"));
    await expect(run(s, (c) => reopenAfterRejection(c, s.maker, k3.id))).rejects.toThrow(/already paid/);
    await noViolations();
  });
});

describe("client money: deposits, guarantees and duty payments", () => {
  async function assessed(s: Site, duty = "300.00", vat = "700.00", over: Record<string, any> = {}) {
    const k = await submitted(s, over);
    await run(s, (c) => recordAssessment(c, s.maker, k.id, { duty, vat }));
    return k;
  }
  it("applies a deposit to duty once, never beyond its balance, never to another customer's case, and never after a guarantee expires", async () => {
    const s = await site();
    const k = await assessed(s);
    const dep = await run(s, (c) => receiveDeposit(c, s.finance, { party_id: s.acme, kind: "cash_deposit", amount: "800.00", reference: "DEP-1" }));
    await run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "duty", amount: "300.00", method: "deposit", deposit_id: dep, reference: "PAY-1" }));
    expect(await run(s, (c) => depositBalance(c, dep))).toBe(50000);
    await expect(run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "vat", amount: "700.00", method: "deposit", deposit_id: dep, reference: "PAY-2" }))).rejects.toThrow(/only 500\.00 available/);
    await expect(run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "duty", amount: "0.01", method: "deposit", deposit_id: dep, reference: "PAY-3" }))).rejects.toThrow(/against an assessment of 300\.00/);
    const other = await run(s, (c) => receiveDeposit(c, s.finance, { party_id: s.zed, kind: "cash_deposit", amount: "5000", reference: "ZED-1" }));
    await expect(run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "vat", amount: "500.00", method: "deposit", deposit_id: other, reference: "PAY-4" }))).rejects.toThrow(/different customer/);
    const expired = await run(s, (c) => receiveDeposit(c, s.finance, { party_id: s.acme, kind: "bank_guarantee", amount: "10000", reference: "BG-1", expires_on: "2020-01-01" }));
    await expect(run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "vat", amount: "100.00", method: "deposit", deposit_id: expired, reference: "PAY-5" }))).rejects.toThrow(/expired/);
    await expect(run(s, (c) => receiveDeposit(c, s.finance, { party_id: s.acme, kind: "bank_guarantee", amount: "1", reference: "BG-2" }))).rejects.toThrow(/expiry date/);
    await expect(run(s, (c) => receiveDeposit(c, s.maker, { party_id: s.acme, kind: "cash_deposit", amount: "1", reference: "x" }))).rejects.toThrow(/does not allow/);
    const list = await run(s, (c) => listDeposits(c, s.acme));
    expect(list.find((d: any) => d.id === dep)).toMatchObject({ balance_minor: 50000, applied_minor: 30000, expired: false });
    expect(list.find((d: any) => d.id === expired)).toMatchObject({ expired: true });
    await noViolations();
  });

  it("two simultaneous payments cannot spend the same deposit twice; a repeated payment key is idempotent", async () => {
    const s = await site();
    const k1 = await assessed(s, "600.00", "0.00"), k2 = await assessed(s, "600.00", "0.00");
    const dep = await run(s, (c) => receiveDeposit(c, s.finance, { party_id: s.acme, kind: "cash_deposit", amount: "700.00", reference: "DEP-9" }));
    const pay = (id: string, key: string) => run(s, (c) => recordPayment(c, s.finance, id, { kind: "duty", amount: "600.00", method: "deposit", deposit_id: dep, reference: key, idem_key: key }));
    const res = await Promise.allSettled([pay(k1.id, "race-1"), pay(k2.id, "race-2")]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await run(s, (c) => depositBalance(c, dep))).toBe(10000);
    const k3 = await assessed(s, "50.00", "0.00");
    const a = await run(s, (c) => recordPayment(c, s.finance, k3.id, { kind: "duty", amount: "50.00", method: "bank", reference: "B-1", idem_key: "idem-77" }));
    const b = await run(s, (c) => recordPayment(c, s.finance, k3.id, { kind: "duty", amount: "50.00", method: "bank", reference: "B-1", idem_key: "idem-77" }));
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    await expect(run(s, (c) => recordPayment(c, s.finance, k3.id, { kind: "duty", amount: "49.00", method: "bank", reference: "B-1", idem_key: "idem-77" }))).rejects.toMatchObject({ status: 409 });
    await noViolations();
  });

  it("returning client money needs a second person and only the unused part; payments are immutable in the database", async () => {
    const s = await site();
    const dep = await run(s, (c) => receiveDeposit(c, s.finance, { party_id: s.acme, kind: "cash_deposit", amount: "1000.00", reference: "DEP-R" }));
    await expect(run(s, (c) => refundDeposit(c, s.finance, dep))).rejects.toThrow(/person who received it/);
    const fin2 = await staff(s.t.tenantId, "finance");
    await expect(run(s, (c) => refundDeposit(c, fin2, dep, "1500"))).rejects.toThrow(/Only 1000\.00 is unused/);
    await run(s, (c) => refundDeposit(c, fin2, dep, "400.00"));
    expect(await run(s, (c) => depositBalance(c, dep))).toBe(60000);
    await run(s, (c) => refundDeposit(c, s.t.ctx, dep));                                    // the owner may return the remainder
    expect(await run(s, (c) => depositBalance(c, dep))).toBe(0);
    const k = await assessed(s, "10.00", "0.00");
    const p = await run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "duty", amount: "10.00", method: "bank", reference: "B" }));
    await expect(db.system((c) => c.query(`UPDATE cus_payments SET amount_minor=1 WHERE id=$1`, [p.id]))).rejects.toThrow();
    await expect(db.system((c) => c.query(`DELETE FROM cus_payments WHERE id=$1`, [p.id]))).rejects.toThrow();
    await expect(db.system((c) => c.query(`UPDATE cus_events SET kind='x'`))).rejects.toThrow();
    await expect(db.system((c) => c.query(`UPDATE cus_cases SET status='approved', approved_by=NULL WHERE id=$1`, [k.id]))).rejects.toThrow();            // a case past review must carry its approver
    await expect(db.system((c) => c.query(`UPDATE cus_cases SET declaration_no=NULL WHERE id=$1`, [k.id]))).rejects.toThrow();                         // …and its declaration number
    await noViolations();
  });

  it("validates payments by kind and stage", async () => {
    const s = await site();
    const early = await submitted(s);
    await expect(run(s, (c) => recordPayment(c, s.finance, early.id, { kind: "duty", amount: "1", method: "bank", reference: "x" }))).rejects.toThrow(/after the official assessment/);
    const k = await assessed(s, "100.00", "50.00");
    const pay = (o: Record<string, any>) => run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "duty", amount: "10", method: "bank", reference: "R", ...o }));
    await expect(pay({ kind: "gift" })).rejects.toThrow(/duty, VAT, fine or refund/); await expect(pay({ method: "crypto" })).rejects.toThrow(/how it was paid/);
    await expect(pay({ amount: "0" })).rejects.toThrow(/above zero/); await expect(pay({ reference: " " })).rejects.toThrow(/reference is required/);
    await expect(pay({ kind: "refund" })).rejects.toThrow(/after release/); await expect(pay({ method: "deposit" })).rejects.toThrow(/Deposit not found/);
    await expect(pay({ amount: "100.01" })).rejects.toThrow(/against an assessment of 100\.00/);
    await pay({ amount: "100.00" }); await pay({ kind: "vat", amount: "50.00" });
    await run(s, (c) => releaseCase(c, s.maker, k.id, { release_ref: "GP-9" }));
    await run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "refund", amount: "5.00", method: "bank", reference: "REF-1" }));
    await expect(run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "refund", amount: "5.00", method: "deposit", deposit_id: "00000000-0000-0000-0000-000000000000", reference: "REF-2" }))).rejects.toThrow(/goes back to the bank/);
    await noViolations();
  });
});

describe("billing the customer", () => {
  it("bills the broker fee (VAT-able) and the duty paid on the customer's behalf (out of scope) on one invoice; duty paid from the customer's own deposit is not re-billed; voiding releases everything", async () => {
    const s = await site();
    const k = await submitted(s);
    await run(s, (c) => recordAssessment(c, s.maker, k.id, { duty: "200.00", vat: "300.00" }));
    const dep = await run(s, (c) => receiveDeposit(c, s.finance, { party_id: s.acme, kind: "cash_deposit", amount: "200.00", reference: "DEP" }));
    await run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "duty", amount: "200.00", method: "deposit", deposit_id: dep, reference: "P1" }));
    await run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "vat", amount: "300.00", method: "bank", reference: "P2" }));
    await expect(run(s, (c) => billDisbursements(c, s.finance, k.id))).rejects.toThrow(/after release/);
    await run(s, (c) => releaseCase(c, s.maker, k.id, { release_ref: "GP-1" }));
    await run(s, (c) => addCharge(c, s.maker, k.id, { kind: "broker_fee", description: "Customs clearance fee", amount: "250.00" }));
    expect(await run(s, (c) => billDisbursements(c, s.finance, k.id))).toEqual({ added: 1 });
    expect(await run(s, (c) => billDisbursements(c, s.finance, k.id))).toEqual({ added: 0 });          // once per payment
    await expect(run(s, (c) => invoiceCase(c, s.maker, k.id))).rejects.toThrow(/does not allow/);
    const inv = await run(s, (c) => invoiceCase(c, s.finance, k.id));
    const d = await run(s, (c) => getInvoice(c, inv.id));
    expect(d.inv.job_no).toBe("Customs case");
    expect(Number(d.inv.subtotal_minor)).toBe(25000 + 30000); expect(Number(d.inv.tax_minor)).toBe(1250);                // 5% only on the broker fee
    expect(d.lines.map((l: any) => l.description).join("|")).toMatch(/Import VAT paid to customs · declaration DT-2026/);
    await expect(run(s, (c) => invoiceCase(c, s.finance, k.id))).rejects.toThrow(/no uninvoiced charges/);
    await noViolations();
    await run(s, (c) => voidInvoice(c, s.t.ctx, inv.id, "wrong fee"));
    expect((await run(s, (c) => c.query<any>(`SELECT count(*)::int n FROM cus_charges WHERE invoice_id IS NULL`))).rows[0].n).toBe(2);
    await run(s, (c) => invoiceCase(c, s.finance, k.id));
    await noViolations();
  });

  it("a refund on the case means disbursements must be added by hand", async () => {
    const s = await site();
    const k = await submitted(s);
    await run(s, (c) => recordAssessment(c, s.maker, k.id, { duty: "10.00", vat: "0" }));
    await run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "duty", amount: "10.00", method: "bank", reference: "B" }));
    await run(s, (c) => releaseCase(c, s.maker, k.id, { release_ref: "G" }));
    await run(s, (c) => recordPayment(c, s.finance, k.id, { kind: "refund", amount: "2.00", method: "bank", reference: "R" }));
    await expect(run(s, (c) => billDisbursements(c, s.finance, k.id))).rejects.toThrow(/add the disbursement lines by hand/);
    await run(s, (c) => addCharge(c, s.maker, k.id, { kind: "disbursement", description: "Customs duty (net of refund)", amount: "8.00" }));
    expect((await run(s, (c) => invoiceCase(c, s.finance, k.id))).no).toBeTruthy();
  });
});

describe("isolation, roles and the customer view", () => {
  it("another company never sees or touches a case; roles without customs rights are refused", async () => {
    const a = await site(), b = await site();
    const k = await ready(a);
    expect(await run(b, (c) => listCases(c))).toEqual([]);
    await expect(run(b, (c) => getCase(c, k.id))).rejects.toThrow(/not found/i);
    await expect(run(b, (c) => submitForReview(c, b.maker, k.id))).rejects.toThrow(/not found/i);
    await expect(run(b, (c) => createCase(c, b.maker, baseCase(a)))).rejects.toThrow(/not found/i);               // the other company's customer
    await expect(db.tenant(b.t.tenantId, (c) => c.query(`INSERT INTO cus_checklist(tenant_id,case_id,kind,label) VALUES ($1,$2,'x','x')`, [b.t.tenantId, k.id]))).rejects.toThrow();
    for (const role of ["warehouse", "sales", "dispatcher", "auditor", "hr"]) {
      const u = await staff(a.t.tenantId, role);
      await expect(run(a, (c) => createCase(c, u, baseCase(a)))).rejects.toThrow(/does not allow/);
    }
    const auditor = await staff(a.t.tenantId, "auditor");
    expect((await run(a, (c) => getCase(c, k.id))).case.no).toBe(k.no);                                         // reading is not gated on role
    await expect(run(a, (c) => cancelCase(c, { ...a.maker, readOnly: true }, k.id, "x"))).rejects.toThrow(/read-only/);
    void auditor;
  });

  it("the customer sees status and which documents are still wanted — nothing else", async () => {
    const s = await site();
    const k = await run(s, (c) => createCase(c, s.maker, baseCase(s)));
    await run(s, (c) => addLine(c, s.maker, k.id, lineA));
    await run(s, (c) => createCase(c, s.maker, baseCase(s, { party_id: s.zed })));
    const mine = await run(s, (c) => portalCases(c, s.acme));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ no: k.no, status: "collecting", wanted: ["Bill of lading / airway bill / CMR", "Commercial invoice", "Delivery order (carrier release)", "Packing list"] });
    expect(Object.keys(mine[0]).sort()).toEqual(["declaration_no", "direction", "id", "no", "released_at", "status", "transport_ref", "wanted"]);   // no rates, estimates, notes or lines
    const cancelled = await run(s, (c) => createCase(c, s.maker, baseCase(s)));
    await run(s, (c) => cancelCase(c, s.maker, cancelled.id, "Customer withdrew"));
    expect((await run(s, (c) => portalCases(c, s.acme))).map((x: any) => x.no)).not.toContain(cancelled.no);
  });

  it("the board counts what needs attention, and a tampered approval is caught by the verifier", async () => {
    const s = await site();
    const waiting = await ready(s); await run(s, (c) => submitForReview(c, s.maker, waiting.id));
    const toHand = await toApproved(s);
    const sub = await submitted(s);
    await run(s, (c) => raiseQuery(c, s.maker, sub.id, { text: "Explain the origin", due_on: "2020-01-01" }));
    await run(s, (c) => recordAssessment(c, s.maker, sub.id, { duty: "100", vat: "0" }));
    const o = await run(s, (c) => customsOverview(c));
    expect(o.toApprove.map((x: any) => x.no)).toContain(waiting.no); expect(o.toHandOver.map((x: any) => x.no)).toContain(toHand.no);
    expect(o.openQueries[0]).toMatchObject({ late: true }); expect(o.awaitingPayment[0]).toMatchObject({ due_minor: 10000, paid_minor: 0 });
    expect(o.byStatus).toMatchObject({ in_review: 1, approved: 1, assessed: 1 });
    await db.system((c) => c.query(`UPDATE cus_cases SET approved_by=prepared_by WHERE id=$1`, [toHand.id]));
    const v = (await verifyInvariants(db)).map((x) => x.check);
    expect(v).toContain("an approved case was approved by someone other than its preparer (owner excepted)");
    await db.system((c) => c.query(`UPDATE cus_cases SET approved_by=$2 WHERE id=$1`, [toHand.id, s.checker.userId]));
    await db.system((c) => c.query(`UPDATE cus_lines SET alloc_minor=alloc_minor+1 WHERE id=(SELECT id FROM cus_lines WHERE case_id=$1 LIMIT 1)`, [toHand.id]));
    expect((await verifyInvariants(db)).map((x) => x.check)).toContain("freight, insurance and other charges are allocated to lines exactly");
    await db.system((c) => c.query(`UPDATE cus_lines SET alloc_minor=alloc_minor-1 WHERE id=(SELECT id FROM cus_lines WHERE case_id=$1 LIMIT 1)`, [toHand.id]));
    await noViolations();
  });
});
