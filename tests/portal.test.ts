import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { config } from "../src/config.js";
import { TINY_PNG, confirmBrand, freshDb, newTenant } from "./helpers.js";
import { createStaff } from "../src/platform/admin.js";
import { buildMockEvent, createOrder, processPaymentEvent } from "../src/platform/billing.js";
import { processProvisioningQueue } from "../src/platform/provisioning.js";
import { findPrivateData } from "../src/lib/private-data.js";
import { FEATURES, checkFeatureChoice, featuresForSectors, planForFeatures } from "../src/platform/features.js";
import { SECTORS } from "../src/platform/catalog.js";
import { SECTOR_CONTENT } from "../src/platform/sector-content.js";
import { SECTOR_DEMOS } from "../src/web/sector-demo.js";
import { checkAssetFile, confirmBrandKit, getBrand, saveBrandKit, removeBrandAsset, brandReady } from "../src/platform/brand-kit.js";
import { clockOf, createFeatureRequest, createRequest, requestDetail, requestStats, staffUpdateRequest, waitingFor } from "../src/platform/requests.js";
import { payForRequest } from "../src/platform/request-plan.js";
import { clientThread, markClientRead, markStaffRead, postClientMessage, postStaffMessage, staffThread, unreadForClient } from "../src/platform/messages.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

const png = TINY_PNG;
const good = { category: "free", sectors: ["freight-forwarding"], title: "Freight pack with our layout", requirements: "Our quotation layout and AED/USD invoices", demoReviewed: true };
const bad = (m: string) => new Error(m);

const withBrand = (t: { tenantId: string; userId: string }) => confirmBrand(db, t);
const staffOf = async (role = "support") => {
  const s = await createStaff(db, `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@lbt.test`, "Sam Support", "a-very-long-staff-password", role as any);
  return { userId: s.userId, name: "Sam Support", role };
};

describe("private details are never collected", () => {
  it("catches the obvious shapes and leaves ordinary text alone", () => {
    expect(findPrivateData("our TRN is 100123456789003")).toBe("trn");
    expect(findPrivateData("TRN 1001 2345 6789 003")).toBe("trn");
    expect(findPrivateData("pay into AE070331234567890123456 please")).toBe("iban");
    expect(findPrivateData("card 4111 1111 1111 1111")).toBe("card");
    expect(findPrivateData("the password is hunter2hunter2")).toBe("secret");
    expect(findPrivateData("api key: sk_live_abcdef123456")).toBe("secret");
    expect(findPrivateData("Call me on +971 50 123 4567 about invoice 20261018 for AED 12,500.00")).toBeNull();
    expect(findPrivateData("We ship 40 pallets a week from Jebel Ali to Mumbai")).toBeNull();
  });
});

describe("feature catalogue and plans", () => {
  it("only offers what applies to a sector, and prices paid features by the smallest plan that covers them", () => {
    expect(planForFeatures(["brand-documents", "field-labels"])).toBeNull();
    expect(planForFeatures(["accounting-bridge"])).toMatchObject({ plan: "starter", monthlyMinor: 14900 });
    expect(planForFeatures(["accounting-bridge", "einvoice"])).toMatchObject({ plan: "business", monthlyMinor: 34900 });
    expect(planForFeatures(["einvoice", "live-routing"])).toMatchObject({ plan: "operations" });
    const cold = featuresForSectors(["cold-chain"]).map((f) => f.code);
    expect(cold).toContain("device-feeds");
    expect(cold).not.toContain("storefront-connectors");
    expect(FEATURES.filter((f) => f.tier === "paid").every((f) => f.minPlan)).toBe(true);
  });

  it("keeps free selections free, makes one paid add-on a paid request, and rejects what doesn't apply", () => {
    expect(checkFeatureChoice(["freight-forwarding"], ["field-labels", "bilingual"], bad)).toMatchObject({ category: "free", plan: null });
    expect(checkFeatureChoice(["freight-forwarding"], ["field-labels", "einvoice"], bad)).toMatchObject({ category: "paid", plan: { plan: "business" } });
    expect(() => checkFeatureChoice(["freight-forwarding"], ["storefront-connectors"], bad)).toThrow(/doesn't apply/);
    expect(() => checkFeatureChoice(["freight-forwarding", "road-transport"], ["field-labels"], bad)).toThrow(/one sector/);
    expect(() => checkFeatureChoice(["freight-forwarding"], ["nope"], bad)).toThrow(/no longer exists/);
    expect(() => checkFeatureChoice([], ["field-labels"], bad)).toThrow(/sector/);
  });

  it("describes all eighteen sectors in full", () => {
    expect(SECTORS).toHaveLength(18);
    for (const s of SECTORS) {
      const c = SECTOR_CONTENT[s.slug];
      expect(c, s.slug).toBeTruthy();
      expect(c.highlights.length, s.slug).toBeGreaterThanOrEqual(4);
      expect(c.yours.length, s.slug).toBeGreaterThanOrEqual(3);
      expect(SECTOR_DEMOS[s.slug], s.slug).toBeTruthy();
    }
  });
});

describe("brand kit", () => {
  it("accepts a real logo and refuses everything else", async () => {
    await expect(checkAssetFile({ filename: "logo.png", data: png, kind: "logo" })).resolves.toMatchObject({ mime: "image/png", kind: "logo" });
    await expect(checkAssetFile({ filename: "logo.exe", data: png, kind: "logo" })).rejects.toThrow(/not accepted/);
    await expect(checkAssetFile({ filename: "logo.png", data: Buffer.from("MZ not an image"), kind: "logo" })).rejects.toThrow(/doesn't match/);
    await expect(checkAssetFile({ filename: "logo.png", data: Buffer.alloc(0), kind: "logo" })).rejects.toThrow(/empty/);
    await expect(checkAssetFile({ filename: "big.png", data: Buffer.concat([png, Buffer.alloc(6 * 1048576)]), kind: "logo" })).rejects.toThrow(/limited/);
    await expect(checkAssetFile({ filename: "x.svg", data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), kind: "logo" })).rejects.toThrow(/scripts/);
    await expect(checkAssetFile({ filename: "x.svg", data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>'), kind: "logo" })).rejects.toThrow(/scripts/);
    await expect(checkAssetFile({ filename: "ok.svg", data: Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), kind: "logo" })).resolves.toMatchObject({ mime: "image/svg+xml" });
  });

  it("will not store a tax number or bank account in the footer or notes", async () => {
    const t = await newTenant(db);
    await expect(db.tenant(t.tenantId, (c) => saveBrandKit(c, t.tenantId, t.userId, { displayName: "Acme", docFooter: "TRN 100123456789003 · Dubai" }))).rejects.toThrow(/tax registration/);
    await expect(db.tenant(t.tenantId, (c) => saveBrandKit(c, t.tenantId, t.userId, { displayName: "Acme", notes: "Bank AE070331234567890123456" }))).rejects.toThrow(/bank account/);
    await expect(db.tenant(t.tenantId, (c) => saveBrandKit(c, t.tenantId, t.userId, { displayName: "Acme", primaryColour: "navy" }))).rejects.toThrow(/colour/);
  });

  it("is complete with a logo or an honest 'no logo yet', and is private per client", async () => {
    const a = await newTenant(db), b = await newTenant(db);
    await expect(db.tenant(a.tenantId, (c) => confirmBrandKit(c, a.tenantId, a.userId))).rejects.toThrow(/company name/);
    await db.tenant(a.tenantId, (c) => saveBrandKit(c, a.tenantId, a.userId, { displayName: "Acme" }));
    await expect(db.tenant(a.tenantId, (c) => confirmBrandKit(c, a.tenantId, a.userId))).rejects.toThrow(/logo/);
    await db.tenant(a.tenantId, (c) => saveBrandKit(c, a.tenantId, a.userId, { displayName: "Acme", noLogo: true }));
    await db.tenant(a.tenantId, (c) => confirmBrandKit(c, a.tenantId, a.userId));
    const got = await db.tenant(a.tenantId, getBrand);
    expect(got.kit?.confirmed_at).toBeTruthy();
    expect(brandReady(got.kit, got.assets)).toBe(true);
    expect((await db.tenant(b.tenantId, getBrand)).kit).toBeNull();
    // a file can be removed; it then no longer counts
    await withBrand(b);
    const gb = await db.tenant(b.tenantId, getBrand);
    expect(gb.assets).toHaveLength(1);
    await db.tenant(b.tenantId, (c) => removeBrandAsset(c, b.tenantId, b.userId, gb.assets[0].id));
    expect((await db.tenant(b.tenantId, getBrand)).assets).toHaveLength(0);
    await expect(db.tenant(a.tenantId, (c) => removeBrandAsset(c, a.tenantId, a.userId, gb.assets[0].id))).rejects.toThrow(/not found/i);
  });
});

describe("the delivery clock", () => {
  it("waits for the brand kit, then runs for the promised hours", async () => {
    const t = await newTenant(db);
    const r = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, good));
    expect(r.clock_started_at).toBeNull();
    expect(waitingFor(r)).toEqual(["brand"]);
    expect(clockOf(r)).toMatchObject({ open: true, waiting: ["brand"], late: false });
    expect(clockOf(r, new Date(Date.now() + 90 * 86400_000)).late).toBe(false);   // nothing is late before it starts
    await withBrand(t);
    const after = (await db.tenant(t.tenantId, (c) => requestDetail(c, r.id))).request;
    expect(after.clock_started_at).toBeTruthy();
    expect(waitingFor(after)).toEqual([]);
    const hours = (new Date(after.due_at).getTime() - new Date(after.clock_started_at!).getTime()) / 3600_000;
    expect(Math.round(hours)).toBe(config.deliveryHours);
    const { events } = await db.tenant(t.tenantId, (c) => requestDetail(c, r.id));
    expect(events.map((e: any) => e.note).join(" | ")).toMatch(/Brand kit received.*window has started/);
  });

  it("starts at once when the brand kit is already in", async () => {
    const t = await newTenant(db);
    await withBrand(t);
    const r = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, good));
    expect(r.clock_started_at).toBeTruthy();
    expect(clockOf(r, new Date(Date.now() + 2 * 86400_000)).late).toBe(true);
  });

  it("needs a quote as well for a bespoke paid request, and the queue counts what each is waiting for", async () => {
    const t = await newTenant(db);
    const eng = await staffOf("engineer");
    const paid = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, { ...good, category: "paid", sectors: ["freight-forwarding", "road-transport"] }));
    expect(waitingFor(paid)).toEqual(["brand", "quote"]);
    const s0 = await requestStats(db);
    expect(s0.awaitingQuote).toBeGreaterThan(0);
    expect(s0.awaitingBrand).toBeGreaterThan(0);
    await withBrand(t);
    let cur = (await db.tenant(t.tenantId, (c) => requestDetail(c, paid.id))).request;
    expect(waitingFor(cur)).toEqual(["quote"]);
    await staffUpdateRequest(db, eng, paid.id, { status: "in_build", quoteNote: "AED 4,500 one-off, agreed by email" });
    cur = (await db.tenant(t.tenantId, (c) => requestDetail(c, paid.id))).request;
    expect(cur.clock_started_at).toBeTruthy();
    expect(waitingFor(cur)).toEqual([]);
  });
});

describe("additional features", () => {
  it("delivers free features as a free request", async () => {
    const t = await newTenant(db);
    await withBrand(t);
    const { request, plan } = await db.tenant(t.tenantId, (c) => createFeatureRequest(c, t.tenantId, t.userId, { sectors: ["freight-forwarding"], features: ["field-labels", "bilingual"] }));
    expect(plan).toBeNull();
    expect(request).toMatchObject({ category: "free", features: ["field-labels", "bilingual"], plan_code: null });
    expect(request.clock_started_at).toBeTruthy();
    expect(request.title).toMatch(/Additional features/);
    expect(request.requirements.length).toBeGreaterThanOrEqual(10);
  });

  it("asks for a monthly plan for a paid add-on and starts the window only once it is paid", async () => {
    const t = await newTenant(db);
    await withBrand(t);
    const { request, plan } = await db.tenant(t.tenantId, (c) => createFeatureRequest(c, t.tenantId, t.userId, { sectors: ["freight-forwarding"], features: ["einvoice", "field-labels"] }));
    expect(plan?.plan).toBe("business");
    expect(request).toMatchObject({ category: "paid", plan_code: "business", clock_started_at: null });
    expect(waitingFor(request)).toEqual(["payment"]);
    expect((await requestStats(db)).awaitingPayment).toBeGreaterThan(0);

    const o = await payForRequest(db, t.tenantId, t.userId, request.id, "mock");
    const linked = (await db.tenant(t.tenantId, (c) => requestDetail(c, request.id))).request;
    expect(linked.order_id).toBe(o.orderId);
    expect(linked.clock_started_at).toBeNull();                    // opening checkout starts nothing

    const order = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
    expect((await processPaymentEvent(db, "mock", buildMockEvent(order))).outcome).toBe("applied");
    await processProvisioningQueue(db);
    const paid = (await db.tenant(t.tenantId, (c) => requestDetail(c, request.id))).request;
    expect(paid.clock_started_at).toBeTruthy();
    expect(paid.quote_note).toMatch(/Business monthly plan paid/);
    // paying again is refused
    await expect(payForRequest(db, t.tenantId, t.userId, request.id, "mock")).rejects.toThrow(/already paid/);
  });

  it("does not ask twice: a plan the client already pays for covers a smaller add-on", async () => {
    const t = await newTenant(db);
    await withBrand(t);
    const o = await createOrder(db, t.tenantId, t.userId, "business", "mock");
    const order = (await db.query<any>(`SELECT * FROM orders WHERE id=$1`, [o.orderId])).rows[0];
    await processPaymentEvent(db, "mock", buildMockEvent(order));
    await processProvisioningQueue(db);
    const { request } = await db.tenant(t.tenantId, (c) => createFeatureRequest(c, t.tenantId, t.userId, { sectors: ["freight-forwarding"], features: ["accounting-bridge"] }));
    expect(request.quote_note).toMatch(/Covered by your current Starter monthly plan/);
    expect(request.clock_started_at).toBeTruthy();
    // a bigger add-on than the plan is not covered
    const bigger = await db.tenant(t.tenantId, (c) => createFeatureRequest(c, t.tenantId, t.userId, { sectors: ["freight-forwarding", "road-transport"], features: ["extra-sector"] }));
    expect(bigger.request.clock_started_at).toBeNull();
    expect(bigger.request.plan_code).toBe("operations");
  });
});

describe("messages", () => {
  it("is a private thread per client, with replies, unread counts and no edits", async () => {
    const a = await newTenant(db), b = await newTenant(db);
    const ra = await db.tenant(a.tenantId, (c) => createRequest(c, a.tenantId, a.userId, good));
    const rb = await db.tenant(b.tenantId, (c) => createRequest(c, b.tenantId, b.userId, good));
    const sam = await staffOf("support");

    const m = await db.tenant(a.tenantId, (c) => postClientMessage(c, a.tenantId, { id: a.userId, name: "Owner" }, ra.id, "Can the invoice show our Arabic name too?"));
    expect(m.author_kind).toBe("client");
    expect((await requestStats(db)).unread).toBeGreaterThan(0);
    expect((await staffThread(db, ra.id)).map((x) => x.body)).toEqual(["Can the invoice show our Arabic name too?"]);

    await postStaffMessage(db, sam, ra.id, "Yes, send us the Arabic spelling and we will add it.");
    expect(await db.tenant(a.tenantId, unreadForClient)).toBe(1);
    expect(await db.tenant(b.tenantId, unreadForClient)).toBe(0);
    expect(await db.tenant(b.tenantId, (c) => clientThread(c))).toEqual([]);
    await expect(db.tenant(b.tenantId, (c) => postClientMessage(c, b.tenantId, { id: b.userId, name: "B" }, ra.id, "hello"))).rejects.toThrow(/not found/i);
    await db.tenant(a.tenantId, (c) => markClientRead(c, ra.id));
    expect(await db.tenant(a.tenantId, unreadForClient)).toBe(0);
    await markStaffRead(db, ra.id);
    expect((await db.query<any>(`SELECT count(*)::int n FROM request_messages WHERE read_by_staff_at IS NULL AND author_kind='client' AND request_id=$1`, [ra.id])).rows[0].n).toBe(0);
    expect((await db.tenant(a.tenantId, (c) => clientThread(c, ra.id))).map((x) => x.author_kind)).toEqual(["client", "staff"]);

    // a sent message cannot be edited or removed, by anyone
    await expect(db.system((c) => c.query(`UPDATE request_messages SET body='changed' WHERE id=$1`, [m.id]))).rejects.toThrow(/cannot be edited/);
    await expect(db.system((c) => c.query(`DELETE FROM request_messages WHERE id=$1`, [m.id]))).rejects.toThrow(/cannot be deleted/);
    await expect(db.tenant(a.tenantId, (c) => c.query(`UPDATE request_messages SET body='changed' WHERE id=$1`, [m.id]))).rejects.toThrow();
    expect(rb.id).not.toBe(ra.id);
  });

  it("refuses private numbers from either side, and an empty or non-staff reply", async () => {
    const t = await newTenant(db);
    const r = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, good));
    const sam = await staffOf("support");
    await expect(db.tenant(t.tenantId, (c) => postClientMessage(c, t.tenantId, { id: t.userId, name: "O" }, r.id, "our TRN is 100123456789003"))).rejects.toThrow(/Please don't send it to us/);
    await expect(db.tenant(t.tenantId, (c) => postClientMessage(c, t.tenantId, { id: t.userId, name: "O" }, r.id, "   "))).rejects.toThrow(/Write a message/);
    await expect(postStaffMessage(db, sam, r.id, "please send the IBAN AE070331234567890123456")).rejects.toThrow(/bank account/);
    await expect(postStaffMessage(db, { ...sam, role: "viewer" }, r.id, "hello")).rejects.toThrow(/needs one of/);
  });

  it("queues a notification email that carries no message text", async () => {
    const t = await newTenant(db);
    const r = await db.tenant(t.tenantId, (c) => createRequest(c, t.tenantId, t.userId, good));
    const m = await db.tenant(t.tenantId, (c) => postClientMessage(c, t.tenantId, { id: t.userId, name: "O" }, r.id, "A very private question about pricing"));
    const row = (await db.query<any>(`SELECT payload FROM outbox WHERE key=$1`, [`request-message:${m.id}`])).rows[0];
    expect(row.payload.template).toBe("client_message");
    expect(JSON.stringify(row.payload)).not.toMatch(/pricing/);
  });
});
