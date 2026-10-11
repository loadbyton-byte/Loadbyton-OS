import { describe, expect, it } from "vitest";
import { auditBrand } from "../src/platform/brand-audit.js";
import { auditDomain, challengeFor, type Resolver } from "../src/platform/domain-audit.js";

const pngBytes = (w: number, h: number) => { const b = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const notFound = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
const resolver = (z: Partial<Record<string, any>>): Resolver => {
  const get = (k: string) => (name: string) => (z[`${k}:${name}`] !== undefined ? Promise.resolve(z[`${k}:${name}`]) : notFound());
  return { resolveTxt: get("txt"), resolveMx: get("mx"), resolveNs: get("ns"), resolve4: get("a"), resolve6: get("aaaa"), resolveCname: get("cname"), resolveCaa: get("caa") } as Resolver;
};

describe("brand audit", () => {
  it("fails without a vector master and flags small logos", () => {
    const r = auditBrand([{ name: "logo-navy.png", bytes: pngBytes(400, 100) }, { name: "favicon.ico", bytes: Buffer.alloc(10) }, { name: "by-mark-32.png", bytes: pngBytes(32, 32) }, { name: "by-mark-192.png", bytes: pngBytes(192, 192) }]);
    expect(r.vectorMaster).toBe(false);
    expect(r.rasterOnly).toContain("logo-navy.png");
    expect(r.findings.some((f) => f.level === "fail")).toBe(true);
    expect(r.findings.some((f) => /400×100/.test(f.message))).toBe(true);
  });
  it("accepts a real SVG but rejects one that wraps a bitmap", () => {
    const fake = Buffer.from(`<svg xmlns="x"><image href="data:image/png;base64,AAA"/></svg>`);
    expect(auditBrand([{ name: "logo.svg", bytes: fake }]).vectorMaster).toBe(false);
    const real = Buffer.from(`<svg xmlns="x"><path d="M0 0L10 10"/></svg>`);
    expect(auditBrand([{ name: "logo.svg", bytes: real }]).vectorMaster).toBe(true);
  });
});

describe("domain audit", () => {
  const secret = "s".repeat(32);
  it("proves DNS control only when the challenge record matches", async () => {
    const d = "example.com", ch = challengeFor(d, secret);
    expect(challengeFor(d, secret)).toBe(ch);
    expect(challengeFor(d, "other" + secret)).not.toBe(ch);
    const base = { [`ns:${d}`]: ["a.ns", "b.ns"], [`a:${d}`]: ["1.2.3.4"], [`txt:${d}`]: [["v=spf1 include:x -all"]], [`txt:_dmarc.${d}`]: [["v=DMARC1; p=reject"]] };
    const no = await auditDomain(d, { secret, resolver: resolver(base) });
    expect(no.controlProven).toBe(false);
    expect(no.checks.find((c) => c.id === "spf")?.level).toBe("pass");
    expect(no.checks.find((c) => c.id === "dmarc")?.level).toBe("pass");
    expect(no.checks.find((c) => c.id === "mx")?.level).toBe("warn");
    const yes = await auditDomain(d, { secret, resolver: resolver({ ...base, [`txt:_lbt-challenge.${d}`]: [[ch]] }) });
    expect(yes.controlProven).toBe(true);
  });
  it("flags duplicate SPF, missing NS and rejects bad names", async () => {
    const r = await auditDomain("bad.example", { secret, resolver: resolver({ "txt:bad.example": [["v=spf1 -all"], ["v=spf1 ~all"]] }) });
    expect(r.checks.find((c) => c.id === "spf")?.level).toBe("fail");
    expect(r.checks.find((c) => c.id === "ns")?.level).toBe("fail");
    await expect(auditDomain("not a domain", { secret, resolver: resolver({}) })).rejects.toThrow();
  });
});
