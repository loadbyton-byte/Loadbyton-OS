import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant, convertedJob } from "./helpers.js";
import { uploadDocument } from "../src/ops/documents.js";
import { extractFromDocument } from "../src/ops/doc-extract.js";
import { googleVisionOcr, selfHostedOcr, type OcrAdapter } from "../src/adapters/ocr.js";
import { config, validateConfig } from "../src/config.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const cfg = { provider: "google-vision", apiKey: "KEY-SECRET", apiBase: "https://vision.test", maxPages: 5, reviewed: true };

describe("OCR for scanned documents", () => {
  it("calls Vision for images and PDFs, and never puts the key in an error", async () => {
    const calls: { url: string; body: any }[] = [];
    const mk = (status: number, body: unknown) => googleVisionOcr(cfg, (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify(body), { status }); }) as any);
    const img = await mk(200, { responses: [{ fullTextAnnotation: { text: "AWB No: 176-12345675\n" } }] }).recognise(Buffer.from("png"), "image/png");
    expect(img).toEqual({ text: "AWB No: 176-12345675", pages: 1 });
    expect(calls[0].url).toBe("https://vision.test/v1/images:annotate?key=KEY-SECRET"); expect(calls[0].body.requests[0].image.content).toBe(Buffer.from("png").toString("base64"));
    const pdf = await mk(200, { responses: [{ responses: [{ fullTextAnnotation: { text: "Page one" } }, { fullTextAnnotation: { text: "Page two" } }] }] }).recognise(Buffer.from("%PDF"), "application/pdf");
    expect(pdf).toEqual({ text: "Page one\nPage two", pages: 2 });
    expect(calls[1].url).toContain("files:annotate"); expect(calls[1].body.requests[0].pages).toEqual([1, 2, 3, 4, 5]);
    for (const status of [401, 429, 503, 400]) {
      const e = await mk(status, {}).recognise(Buffer.from("x"), "image/png").catch((x) => x as Error) as Error;
      expect(e.message).not.toContain("KEY-SECRET");
    }
    const unreachable = await googleVisionOcr(cfg, (async () => { throw new Error("connect ECONNREFUSED ?key=KEY-SECRET"); }) as any).recognise(Buffer.from("x"), "image/png").catch((x) => x as Error) as Error;
    expect(unreachable.message).not.toContain("KEY-SECRET");
  });

  it("a scanned upload yields a labelled OCR proposal that still needs the usual checks; without OCR it stays manual", async () => {
    const t = await newTenant(db);
    const j = await convertedJob(db, t);
    const doc = await db.tenant(t.tenantId, (c) => uploadDocument(c, t.ctx, { kind: "other", title: "Scanned AWB", issuer: "Airline", filename: "scan.png", mime: "image/png", data: Buffer.from("89504e470d0a1a0a", "hex"), job_id: j.jobId } as any));
    const none = await db.tenant(t.tenantId, (c) => extractFromDocument(c, t.ctx, doc));
    expect(none.readable).toBe(false); expect(none.warnings.join(" ")).toMatch(/manually/);
    const ocr: OcrAdapter = { name: "fake", recognise: async () => ({ text: "AIR WAYBILL\nAWB No: 176-12345670\n", pages: 1 }) };
    const x = await db.tenant(t.tenantId, (c) => extractFromDocument(c, t.ctx, doc, ocr));
    expect(x.readable).toBe(true); expect(x.warnings.join(" ")).toMatch(/recognised by OCR/);
    expect(x.warnings.join(" ")).toMatch(/failed its IATA check/);                                // OCR text gets exactly the same validation (this check digit is wrong)
    const down: OcrAdapter = { name: "fake", recognise: async () => { throw new Error("The OCR service is unavailable (503)."); } };
    const doc2 = await db.tenant(t.tenantId, (c) => uploadDocument(c, t.ctx, { kind: "other", title: "Scan 2", issuer: "Airline", filename: "scan2.png", mime: "image/png", data: Buffer.from("89504e470d0a1a0b", "hex"), job_id: j.jobId } as any));
    const y = await db.tenant(t.tenantId, (c) => extractFromDocument(c, t.ctx, doc2, down));
    expect(y.readable).toBe(false); expect(y.warnings.join(" ")).toMatch(/unavailable/);
  });

  it("requires a reviewed-processing flag and a key", () => {
    expect(() => validateConfig({ ...config, ocr: { ...cfg, reviewed: false } } as any, false)).toThrow(/OCR_DATA_PROCESSING_REVIEWED/);
    expect(() => validateConfig({ ...config, ocr: { ...cfg, apiKey: "" } } as any, false)).toThrow(/OCR_API_KEY/);
    expect(() => validateConfig({ ...config, ocr: cfg } as any, false)).not.toThrow();
  });
});

describe("self-hosted OCR sidecar", () => {
  const scfg = { provider: "self-hosted", apiKey: "", apiBase: "http://ocr:8080", maxPages: 5, reviewed: false };
  it("posts the file as-is to /ocr and returns the sidecar's text, mapping failures to plain messages", async () => {
    let seen: { url: string; type: string; len: number } | null = null;
    const mk = (status: number, body: unknown) => selfHostedOcr(scfg, (async (url: string, init: RequestInit) => { seen = { url, type: (init.headers as any)["content-type"], len: (init.body as Buffer).length }; return new Response(JSON.stringify(body), { status }); }) as any);
    expect(await mk(200, { text: " AWB 176-12345675 \n", pages: 2 }).recognise(Buffer.from("%PDF-1.4 xx"), "application/pdf")).toEqual({ text: "AWB 176-12345675", pages: 2 });
    expect(seen).toEqual({ url: "http://ocr:8080/ocr", type: "application/pdf", len: 11 });
    await expect(mk(415, {}).recognise(Buffer.from("x"), "image/png")).rejects.toThrow(/file type/);
    await expect(mk(503, {}).recognise(Buffer.from("x"), "image/png")).rejects.toThrow(/unavailable/);
    await expect(mk(422, {}).recognise(Buffer.from("x"), "image/png")).rejects.toThrow(/could not read/);
    await expect(mk(200, { nope: 1 }).recognise(Buffer.from("x"), "image/png")).rejects.toThrow(/unexpected answer/);
    await expect(selfHostedOcr(scfg, (async () => { throw new Error("ECONNREFUSED"); }) as any).recognise(Buffer.from("x"), "image/png")).rejects.toThrow(/could not be reached/);
  });
  it("is accepted by configuration without the third-party review flag, but needs a sidecar address", () => {
    expect(() => validateConfig({ ...config, ocr: scfg } as any, false)).not.toThrow();
    expect(() => validateConfig({ ...config, ocr: { ...scfg, apiBase: "ocr:8080" } } as any, false)).toThrow(/OCR_API_BASE/);
  });
});
