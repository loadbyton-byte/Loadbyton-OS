import { describe, expect, it } from "vitest";
import { aspAdapter, registerConfiguredAsp } from "../src/adapters/einvoice-asp.js";
import { PROVIDERS, adapterFor } from "../src/adapters/einvoice.js";
import { config, validateConfig } from "../src/config.js";

const cfg = { ...config.einvoiceAsp, name: "acme-asp", baseUrl: "https://asp.example.test/api/", apiKey: "k-123", tenantId: "T9" };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("configurable e-invoicing provider adapter", () => {
  it("submits base64 UBL with an idempotency key, bearer auth and maps the provider vocabulary", async () => {
    const seen: any[] = [];
    const a = aspAdapter(cfg, async (url, init) => { seen.push({ url, init }); return reply(200, { id: "P-1", status: "Delivered", errors: [] }); });
    const r = await a.submit({ reference: "T1-INV-1", kind: "invoice", xml: "<Invoice/>" });
    expect(r).toEqual({ providerRef: "P-1", status: "accepted", reasons: [] });
    expect(seen[0].url).toBe("https://asp.example.test/api/documents");
    expect(seen[0].init.headers.authorization).toBe("Bearer k-123");
    expect(seen[0].init.headers["x-tenant-id"]).toBe("T9");
    expect(seen[0].init.headers["idempotency-key"]).toBe("T1-INV-1");
    expect(JSON.parse(seen[0].init.body)).toMatchObject({ reference: "T1-INV-1", kind: "invoice", encoding: "base64", document: Buffer.from("<Invoice/>").toString("base64") });
  });
  it("sends raw XML and a custom auth header when configured", async () => {
    const seen: any[] = [];
    const a = aspAdapter({ ...cfg, bodyFormat: "xml", authScheme: "header", authHeader: "x-key" }, async (url, init) => { seen.push({ url, init }); return reply(202, { id: "P-2", status: "queued" }); });
    const r = await a.submit({ reference: "R", kind: "credit_note", xml: "<CreditNote/>" });
    expect(r.status).toBe("submitted");                                   // an unrecognised state is never read as accepted
    expect(seen[0].init.body).toBe("<CreditNote/>"); expect(seen[0].init.headers["x-key"]).toBe("k-123"); expect(seen[0].init.headers.authorization).toBeUndefined();
  });
  it("treats provider validation answers as rejections, and outages and bad credentials as thrown errors", async () => {
    const rej = await aspAdapter(cfg, async () => reply(422, { errors: ["BR-CO-15 total mismatch"] })).submit({ reference: "R", kind: "invoice", xml: "x" });
    expect(rej).toMatchObject({ status: "rejected", reasons: ["BR-CO-15 total mismatch"] });
    await expect(aspAdapter(cfg, async () => reply(503, {})).submit({ reference: "R", kind: "invoice", xml: "x" })).rejects.toThrow(/503/);
    await expect(aspAdapter(cfg, async () => reply(401, {})).submit({ reference: "R", kind: "invoice", xml: "x" })).rejects.toThrow(/credentials/);
    await expect(aspAdapter(cfg, async () => { throw new Error("ECONNRESET"); }).submit({ reference: "R", kind: "invoice", xml: "x" })).rejects.toThrow(/unreachable/);
  });
  it("polls status by encoded reference", async () => {
    let url = "";
    const r = await aspAdapter(cfg, async (u) => { url = u; return reply(200, { id: "a/b", status: "rejected", errors: [{ code: "X" }] }); }).status("a/b");
    expect(url).toBe("https://asp.example.test/api/documents/a%2Fb");
    expect(r.status).toBe("rejected"); expect(r.reasons[0]).toContain("X");
  });
  it("registers only when fully configured, and validates configuration", () => {
    delete PROVIDERS["acme-asp"];
    registerConfiguredAsp({ ...cfg, apiKey: "" }); expect(adapterFor("acme-asp")).toBeNull();
    registerConfiguredAsp(cfg); expect(adapterFor("acme-asp")?.name).toBe("acme-asp"); delete PROVIDERS["acme-asp"];
    expect(() => validateConfig({ ...config, einvoiceAsp: { ...cfg, baseUrl: "http://x" } } as any, false)).toThrow(/https/);
    expect(() => validateConfig({ ...config, einvoiceAsp: cfg } as any, false)).not.toThrow();
  });
});
