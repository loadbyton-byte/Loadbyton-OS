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

if (process.env.NODE_ENV === "production") { console.error("Refusing to seed demo data in production."); process.exit(1); }
const db = await openDb();
await db.system((c) => ensureCatalog(c));
const email = "demo@loadbyton.example";
if ((await db.query(`SELECT 1 FROM users WHERE email=$1`, [email])).rows.length) { console.log("Demo already seeded."); await db.close(); process.exit(0); }
const r = await registerCompany(db, { company: "DEMO Gulf Gate Freight", contactName: "Demo Owner", email, password: "demo-password-123", sectors: ["freight-forwarding"], goal: "Stop losing margin on jobs" });
const ctx = { userId: r.userId, tenantId: r.tenantId, roles: ["owner"], perms: permsFor(["owner"]), partyId: null, readOnly: false, supportStaffId: null };
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
console.log(`Demo seeded. Sign in as ${email} / demo-password-123`);
await db.close();
