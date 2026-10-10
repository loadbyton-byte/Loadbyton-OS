import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsStorage, s3Storage, signV4 } from "../src/lib/storage.js";
import { validateConfig, config } from "../src/config.js";

describe("AWS Signature V4", () => {
  it("reproduces AWS's published GET Object example exactly", () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const r = signV4({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { Range: "bytes=0-9" }, payloadHash: empty,
      region: "us-east-1", service: "s3", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", amzDate: "20130524T000000Z",
    });
    expect(r.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(r.headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });
});

describe("S3-compatible storage", () => {
  const cfg = { endpoint: "https://ns.compat.objectstorage.me-dubai-1.oraclecloud.com", region: "me-dubai-1", bucket: "lbt-docs", accessKeyId: "AK", secretAccessKey: "SK", pathStyle: true };
  const fake = () => {
    const objs = new Map<string, Buffer>(), calls: { method: string; url: string; headers: Record<string, string> }[] = [];
    const f = (async (url: string, init: any) => {
      calls.push({ method: init.method, url, headers: init.headers });
      if (init.method === "PUT") { objs.set(url, Buffer.from(init.body)); return new Response("", { status: 200 }); }
      const o = objs.get(url); return o ? new Response(o as any, { status: 200 }) : new Response("<Error/>", { status: 404 });
    }) as any;
    return { f, calls, objs };
  };
  const t0 = new Date("2026-10-10T10:11:12.345Z");

  it("stores and reads back bytes with a signed, tenant-prefixed, path-style request", async () => {
    const { f, calls } = fake();
    const s = s3Storage(cfg, f, () => t0);
    const data = Buffer.from("%PDF-1.4 hello");
    await s.put("11111111-1111-4111-8111-111111111111/abc-def", data);
    expect(calls[0].url).toBe("https://ns.compat.objectstorage.me-dubai-1.oraclecloud.com/lbt-docs/11111111-1111-4111-8111-111111111111/abc-def");
    expect(calls[0].headers["x-amz-date"]).toBe("20261010T101112Z");
    expect(calls[0].headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(data).digest("hex"));
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261010\/me-dubai-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(calls[0].headers.authorization).not.toContain("SK");
    expect((await s.get("11111111-1111-4111-8111-111111111111/abc-def")).equals(data)).toBe(true);
  });

  it("supports virtual-hosted style, and turns provider failures into safe messages (404 stays a 404)", async () => {
    const { f, calls } = fake();
    await s3Storage({ ...cfg, endpoint: "https://s3.example.com", bucket: "b", pathStyle: false }, f, () => t0).put("t/k", Buffer.from("x"));
    expect(calls[0].url).toBe("https://b.s3.example.com/t/k");
    const s = s3Storage(cfg, f, () => t0);
    await expect(s.get("t/missing")).rejects.toMatchObject({ status: 404 });
    const err = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = s3Storage(cfg, (async () => new Response("<Error>SecretAccessKey SK</Error>", { status: 403 })) as any, () => t0);
    await expect(bad.put("t/k", Buffer.from("x"))).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining("SK") });
    const down = s3Storage(cfg, (async () => { throw new Error("ECONNRESET"); }) as any, () => t0);
    await expect(down.get("t/k")).rejects.toMatchObject({ status: 502 });
    err.mockRestore();
  });
});

describe("local storage", () => {
  it("round-trips and refuses keys that escape the root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lbt-store-"));
    const s = fsStorage(root);
    await s.put("tenant/doc-1", Buffer.from("abc"));
    expect((await s.get("tenant/doc-1")).toString()).toBe("abc");
    await expect(s.get("../../etc/passwd")).rejects.toMatchObject({ status: 403 });
    await expect(s.put("../escape", Buffer.from("x"))).rejects.toMatchObject({ status: 403 });
    fs.rmSync(root, { recursive: true });
  });
  it("configuration is validated", () => {
    const base = { ...config, storage: { driver: "s3", s3: { endpoint: "https://x.com", region: "auto", bucket: "b", accessKeyId: "a", secretAccessKey: "s", pathStyle: true } } };
    expect(() => validateConfig(base as any, false)).not.toThrow();
    expect(() => validateConfig({ ...base, storage: { ...base.storage, s3: { ...base.storage.s3, bucket: "" } } } as any, false)).toThrow(/S3_BUCKET/);
    expect(() => validateConfig({ ...base, storage: { ...base.storage, s3: { ...base.storage.s3, endpoint: "http://x" } } } as any, false)).toThrow(/https/);
    expect(() => validateConfig({ ...base, storage: { ...base.storage, driver: "ftp" } } as any, false)).toThrow(/STORAGE_DRIVER/);
  });
});
