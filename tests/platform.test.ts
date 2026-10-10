import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, payFor, convertedJob, ctxFor } from "./helpers.js";
import { buildMockEvent, createOrder, processPaymentEvent, signPayload, verifySignature, scheduleDowngrade, applyDueSubscriptionChanges } from "../src/platform/billing.js";
import { processProvisioningQueue, runProvisioningJob, type ProvisionAdapters, simulatedAdapters } from "../src/platform/provisioning.js";
import { consumeQuota, getLimit } from "../src/platform/entitlements.js";
import { createParty, createEnquiry } from "../src/ops/crm.js";
import { requestCustomDomain, verifyCustomDomain, removeDomain } from "../src/platform/admin.js";
import { totp, verifyTotp, newTotpSecret } from "../src/lib/util.js";
import { recommendBundle } from "../src/platform/catalog.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

describe("tenant isolation (acceptance: cross-tenant access denied)", () => {
  it("runtime role sees only its own tenant's rows and cannot write another tenant's", async () => {
    const a = await newTenant(db), b = await newTenant(db);
    await db.tenant(a.tenantId, (c) => createParty(c, a.ctx, { kind: "customer", name: "Only A" }));
    await db.tenant(b.tenantId, (c) => createParty(c, b.ctx, { kind: "customer", name: "Only B" }));
    const seenByA = await db.tenant(a.tenantId, (c) => c.query(`SELECT name FROM parties`));
    expect(seenByA.rows.map((r: any) => r.name)).toEqual(["Only A"]);
    const tenantsSeen = await db.tenant(a.tenantId, (c) => c.query(`SELECT id FROM tenants`));
    expect(tenantsSeen.rows).toHaveLength(1);
    await expect(db.tenant(a.tenantId, (c) => c.query(`INSERT INTO parties(tenant_id,kind,name) VALUES ($1,'customer','evil')`, [b.tenantId]))).rejects.toThrow(/row-level security/);
    // edited ID: A asking for B's party by id gets nothing
    const bParty = (await db.query<any>(`SELECT id FROM parties WHERE tenant_id=$1`, [b.tenantId])).rows[0].id;
    expect((await db.tenant(a.tenantId, (c) => c.query(`SELECT * FROM parties WHERE id=$1`, [bParty]))).rows).toHaveLength(0);
  });
  it("composite foreign keys stop a child from referencing another tenant's parent", async () => {
    const a = await newTenant(db), b = await newTenant(db);
    const bParty = await db.tenant(b.tenantId, (c) => createParty(c, b.ctx, { kind: "customer", name: "B cust" }));
    await expect(db.system((c) => c.query(`INSERT INTO enquiries(tenant_id,no,party_id,dedupe_key,mode) VALUES ($1,'E1',$2,'k','air')`, [a.tenantId, bParty]))).rejects.toThrow();
  });
  it("tenant cannot read global users table or hashes", async () => {
    const a = await newTenant(db);
    await expect(db.tenant(a.tenantId, (c) => c.query(`SELECT password_hash FROM users`))).rejects.toThrow();
  });
});

describe("payments, entitlements, provisioning", () => {
  it("rejects bad/expired signatures", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifySignature(body, signPayload(body))).toBe(true);
    expect(verifySignature(body + " ", signPayload(body))).toBe(false);
    expect(verifySignature(body, signPayload(body, "x".repeat(40)))).toBe(false);
    expect(verifySignature(body, signPayload(body, undefined, Math.floor(Date.now() / 1000) - 3600))).toBe(false);
  });

  it("replayed payment success → one entitlement transition and one provisioning order", async () => {
    const t = await newTenant(db);
    const o = await createOrder(db, t.tenantId, t.userId, "starter");
    const order = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
    const ev = buildMockEvent(order);
    expect((await processPaymentEvent(db, "mock", ev)).outcome).toBe("applied");
    expect((await processPaymentEvent(db, "mock", ev)).outcome).toBe("duplicate");
    // same business event under a *new* provider event id (provider replay) must also be ignored
    expect((await processPaymentEvent(db, "mock", { ...ev, event_id: "evt_other" })).outcome).toBe("ignored");
    const jobs = await db.query(`SELECT * FROM provision_jobs WHERE tenant_id=$1`, [t.tenantId]);
    expect(jobs.rows).toHaveLength(1);
    const ents = await db.query(`SELECT * FROM entitlements WHERE tenant_id=$1 AND source=$2`, [t.tenantId, `order:${o.orderId}`]);
    expect(ents.rows).toHaveLength(11);   // exactly one row per allowance key (users, branches, jobs, trips, fulfilment orders, warehouse orders, parcels, customs cases, storage, sectors, entities) — a replay adds none
    expect(await db.tenant(t.tenantId, (c) => getLimit(c, t.tenantId, "jobs_per_month"))).toBe(150);
  });

  it("rejects wrong amount/currency/reference and never grants from them", async () => {
    const t = await newTenant(db);
    const o = await createOrder(db, t.tenantId, t.userId, "business");
    const order = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
    expect((await processPaymentEvent(db, "mock", { ...buildMockEvent(order), amount_minor: 1 })).outcome).toBe("rejected");
    expect((await processPaymentEvent(db, "mock", { ...buildMockEvent(order), reference: "nope" })).outcome).toBe("rejected");
    expect((await processPaymentEvent(db, "mock", { ...buildMockEvent(order), currency: "USD" })).outcome).toBe("rejected");
    expect((await db.query<any>(`SELECT status FROM orders WHERE id=$1`, [o.orderId])).rows[0].status).toBe("pending");
    expect(await db.tenant(t.tenantId, (c) => getLimit(c, t.tenantId, "max_users"))).toBe(2);
  });

  it("failure arriving after success is ignored (out-of-order delivery)", async () => {
    const t = await newTenant(db);
    const { order } = await payFor(db, t);
    const r = await processPaymentEvent(db, "mock", buildMockEvent(order, "payment.failed"));
    expect(r.outcome).toBe("ignored");
    expect((await db.query<any>(`SELECT status FROM orders WHERE id=$1`, [order.id])).rows[0].status).toBe("paid");
  });

  it("provisioning interrupted after slug assignment resumes safely with no duplicate tenant/mapping", async () => {
    const t = await newTenant(db);
    const o = await createOrder(db, t.tenantId, t.userId, "starter");
    const order = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
    await db.query(`UPDATE entities SET legal_name='Acme LLC' WHERE tenant_id=$1`, [t.tenantId]);
    await processPaymentEvent(db, "mock", buildMockEvent(order));
    let failures = 0;
    const flaky: ProvisionAdapters = { ...simulatedAdapters, async verifyTls() { if (failures++ < 1) throw new Error("tls provider timeout"); } };
    const job = (await db.query<any>(`SELECT id FROM provision_jobs WHERE tenant_id=$1`, [t.tenantId])).rows[0];
    expect(await runProvisioningJob(db, job.id, flaky)).toBe("retry");
    expect((await db.query<any>(`SELECT state FROM provision_jobs WHERE id=$1`, [job.id])).rows[0].state).toBe("provisioning");
    expect(await runProvisioningJob(db, job.id, flaky)).toBe("onboarding");
    const j = (await db.query<any>(`SELECT * FROM provision_jobs WHERE id=$1`, [job.id])).rows[0];
    expect(j.state).toBe("onboarding");
    expect(j.ready_at).toBeTruthy();
    expect((await db.query(`SELECT 1 FROM provision_steps WHERE job_id=$1`, [job.id])).rows).toHaveLength(9);
    expect((await db.query(`SELECT 1 FROM tenants WHERE slug=(SELECT slug FROM tenants WHERE id=$1)`, [t.tenantId])).rows).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM domain_mappings WHERE tenant_id=$1 AND kind='standard' AND status<>'removed'`, [t.tenantId])).rows).toHaveLength(1);
    // re-running a finished job is a no-op
    expect(await runProvisioningJob(db, job.id)).toBe("onboarding");
    expect((await db.query(`SELECT 1 FROM outbox WHERE key=$1`, [`ready:${job.id}`])).rows).toHaveLength(1);
  });

  it("waits in information_pending until minimum setup info exists, then queues", async () => {
    const t = await newTenant(db);
    const o = await createOrder(db, t.tenantId, t.userId, "starter");
    const order = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
    await processPaymentEvent(db, "mock", buildMockEvent(order));
    expect((await db.query<any>(`SELECT state FROM provision_jobs WHERE tenant_id=$1`, [t.tenantId])).rows[0].state).toBe("information_pending");
    await processProvisioningQueue(db);
    expect((await db.query<any>(`SELECT state FROM provision_jobs WHERE tenant_id=$1`, [t.tenantId])).rows[0].state).toBe("information_pending");
  });

  it("free → paid upgrade keeps existing data, links and owner access (same tenant reused)", async () => {
    const t = await newTenant(db);
    const j = await convertedJob(db, t);
    const before = await db.tenant(t.tenantId, (c) => c.query(`SELECT id FROM jobs`));
    const { order } = await payFor(db, t, "business");
    const after = await db.tenant(t.tenantId, (c) => c.query(`SELECT id FROM jobs`));
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0].id).toBe(j.jobId);
    expect((await db.query(`SELECT 1 FROM tenants`)).rows.length).toBeGreaterThan(0);
    expect((await db.query<any>(`SELECT count(*)::int n FROM memberships WHERE tenant_id=$1 AND 'owner'=ANY(roles)`, [t.tenantId])).rows[0].n).toBe(1);
    expect(order.status).toBe("pending"); // snapshot before webhook; live row is now paid
    expect((await db.query<any>(`SELECT status FROM orders WHERE id=$1`, [order.id])).rows[0].status).toBe("paid");
  });

  it("net incremental pricing credits setup already paid", async () => {
    const t = await newTenant(db);
    await payFor(db, t, "starter");
    const o = await createOrder(db, t.tenantId, t.userId, "business");
    const row = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
    expect(row.lines.find((l: any) => l.kind === "setup").amount_minor).toBe(39900 - 19900);
  });

  it("quota is enforced transactionally and consumption is idempotent per reference", async () => {
    const t = await newTenant(db);
    await db.system((c) => c.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES ($1,'jobs_per_month',2,'test')`, [t.tenantId]));
    await db.tenant(t.tenantId, (c) => consumeQuota(c, t.tenantId, "jobs_per_month", "a"));
    expect((await db.tenant(t.tenantId, (c) => consumeQuota(c, t.tenantId, "jobs_per_month", "a"))) as any).toMatchObject({ duplicate: true });
    await db.tenant(t.tenantId, (c) => consumeQuota(c, t.tenantId, "jobs_per_month", "b"));
    await expect(db.tenant(t.tenantId, (c) => consumeQuota(c, t.tenantId, "jobs_per_month", "c"))).rejects.toThrow(/limit reached/);
    // concurrent attempts cannot exceed the limit
    await db.system((c) => c.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES ($1,'jobs_per_month',4,'test2')`, [t.tenantId]));
    const res = await Promise.allSettled(["d", "e", "f", "g"].map((r) => db.tenant(t.tenantId, (c) => consumeQuota(c, t.tenantId, "jobs_per_month", r))));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });

  it("downgrade above capacity: previews, keeps read/export, blocks excess creation", async () => {
    const t = await newTenant(db);
    await payFor(db, t, "business");
    await db.system(async (c) => {
      for (let i = 0; i < 3; i++) {
        const u = (await c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'x','x') RETURNING id`, [`m${i}-${Date.now()}@x.com`])).rows[0];
        await c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,'{sales}')`, [t.tenantId, u.id]);
      }
    });
    const preview = await scheduleDowngrade(db, t.tenantId, t.userId, "free");
    expect(preview.issues.join()).toMatch(/max users: using 4, Free Forever allows 2/);
    await db.query(`UPDATE subscriptions SET period_end = now() - interval '1 day' WHERE tenant_id=$1`, [t.tenantId]);
    await applyDueSubscriptionChanges(db);
    expect(await db.tenant(t.tenantId, (c) => getLimit(c, t.tenantId, "max_users"))).toBe(2);
    // read still works; creating another user is blocked
    expect((await db.tenant(t.tenantId, (c) => c.query(`SELECT * FROM team_members`))).rows.length).toBe(4);
    const { invite } = await import("../src/ops/team.js");
    await expect(db.tenant(t.tenantId, (c) => invite(c, t.ctx, { email: "n@x.com", roles: ["sales"] }))).rejects.toThrow(/limit reached/);
  });

  it("restricted subscription is read-only but data remains exportable", async () => {
    const t = await newTenant(db);
    await db.system((c) => c.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`, [t.tenantId]));
    await expect(db.tenant(t.tenantId, (c) => createParty(c, t.ctx, { kind: "customer", name: "Late" }))).rejects.toThrow(/read-only/);
    const { exportTenantData } = await import("../src/ops/exporter.js");
    const out: any = await db.tenant(t.tenantId, (c) => exportTenantData(c, t.ctx));
    expect(out.tenant_id).toBe(t.tenantId);
  });

  it("domain: ownership verified, one live mapping per hostname, removal frees it without exposing data", async () => {
    const a = await newTenant(db), b = await newTenant(db);
    const token = await requestCustomDomain(db, a.tenantId, a.userId, "Track.Acme-Freight.com");
    await expect(requestCustomDomain(db, b.tenantId, b.userId, "track.acme-freight.com")).rejects.toThrow(/already mapped/);
    const id = (await db.query<any>(`SELECT id FROM domain_mappings WHERE tenant_id=$1 AND kind='custom'`, [a.tenantId])).rows[0].id;
    await expect(verifyCustomDomain(db, a.tenantId, id, async () => [])).rejects.toThrow(/not found yet/);
    await expect(verifyCustomDomain(db, b.tenantId, id, async () => [token])).rejects.toThrow(/not found/); // b cannot verify a's mapping
    await verifyCustomDomain(db, a.tenantId, id, async () => [token]);
    const { tenantForHost } = await import("../src/platform/admin.js");
    expect(await tenantForHost(db, "track.acme-freight.com")).toBeTruthy();
    await removeDomain(db, a.tenantId, a.userId, id);
    expect(await tenantForHost(db, "track.acme-freight.com")).toBeNull();
    const t2 = await requestCustomDomain(db, b.tenantId, b.userId, "track.acme-freight.com"); // re-assignment requires fresh verification
    const id2 = (await db.query<any>(`SELECT id FROM domain_mappings WHERE tenant_id=$1 AND kind='custom'`, [b.tenantId])).rows[0].id;
    expect(await tenantForHost(db, "track.acme-freight.com")).toBeNull();
    await expect(verifyCustomDomain(db, b.tenantId, id2, async () => [token])).rejects.toThrow(/not found yet/); // old token useless
    await verifyCustomDomain(db, b.tenantId, id2, async () => [t2]);
  });
});

describe("immutability and misc", () => {
  it("published plan versions and audit log cannot be altered", async () => {
    await newTenant(db);
    await expect(db.query(`UPDATE plan_versions SET monthly_minor=1`)).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE audit_log SET action='x'`)).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow(/immutable/);
  });
  it("TOTP matches RFC 6238 SHA1 test vector and rejects wrong codes", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
    expect(totp(secret, 59_000)).toBe("287082");
    expect(verifyTotp(secret, "287082", 59_000)).toBe(true);
    expect(verifyTotp(secret, "000000", 59_000)).toBe(false);
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });
  it("bundle recommendation follows the plan rules", () => {
    expect(recommendBundle(["freight-forwarding"]).plan).toBe("starter");
    expect(recommendBundle(["customs-brokerage"]).plan).toBe("business");
    expect(recommendBundle(["freight-forwarding", "customs-brokerage"]).plan).toBe("operations");
    expect(recommendBundle(["freight-forwarding", "cold-chain"]).plan).toBe("enterprise");
    expect(recommendBundle([]).plan).toBe("free");
  });
  it("enquiry intake dedupes on external reference and on content", async () => {
    const t = await newTenant(db);
    await db.tenant(t.tenantId, async (c) => {
      const a = await createEnquiry(c, t.ctx, { mode: "air", origin: "DXB", destination: "LHR", cargo_desc: "Parts", source: "email", external_ref: "msg-1" });
      const b = await createEnquiry(c, t.ctx, { mode: "air", origin: "DXB", destination: "LHR", cargo_desc: "Parts", source: "email", external_ref: "msg-1" });
      expect(b.duplicate).toBe(true); expect(b.id).toBe(a.id);
      expect((a as any).missing).toContain("customer");
      const x = await createEnquiry(c, t.ctx, { mode: "air", origin: "DXB ", destination: "lhr", cargo_desc: "parts" });
      const y = await createEnquiry(c, t.ctx, { mode: "air", origin: "dxb", destination: "LHR", cargo_desc: "Parts" });
      expect(y.duplicate).toBe(true); expect(y.id).toBe(x.id);
    });
  });
});
