import { describe, it, expect } from "vitest";
import { PATTERNS, STOP, barcodeSvg, code128B, decodeRuns, runs } from "../src/lib/code128.js";

describe("Code 128", () => {
  it("has a well-formed symbol table", () => {
    expect(PATTERNS).toHaveLength(106);
    expect(new Set(PATTERNS).size).toBe(106);
    for (const p of PATTERNS) { expect(p).toHaveLength(6); expect([...p].reduce((a, c) => a + Number(c), 0)).toBe(11); expect([...p].every((c) => +c >= 1 && +c <= 4)).toBe(true); }
    expect([...STOP].reduce((a, c) => a + Number(c), 0)).toBe(13);
  });
  it("matches the vector that an independent decoder (ZXing-C++) read back as \"DLV-2026-00001\"", () => {
    const frozen = "110100100001011000100010001101110111010110001001101110011001110010100111011001100111001011001110100100110111001001110110010011101100100111011001001110110010011100110101000011001100011101011";
    let bits = "", bar = true;
    for (const w of runs("DLV-2026-00001")) { bits += (bar ? "1" : "0").repeat(w); bar = !bar; }
    expect(bits).toBe(frozen);
    expect(code128B("PJJ123C").at(-1)).toBe((104 + 48 * 1 + 42 * 2 + 42 * 3 + 17 * 4 + 18 * 5 + 19 * 6 + 35 * 7) % 103);   // checksum arithmetic
  });
  it("round-trips every waybill-shaped string and every printable character", () => {
    for (const t of ["DLV-2026-00001", "DLV-2026-99999", "A", "0123456789", " ~!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}", "lbt:ref/ABC 9"]) expect(decodeRuns(runs(t))).toBe(t);
    const all = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
    expect(decodeRuns(runs(all))).toBe(all);
  });
  it("refuses characters it cannot encode and detects corruption", () => {
    expect(() => code128B("café")).toThrow(/cannot be encoded/);
    const r = runs("DLV-1"); r[10] = r[10] === 1 ? 2 : 1;
    expect(() => decodeRuns(r)).toThrow();
  });
  it("renders an SVG whose bar widths match the run list and escapes the label", () => {
    const svg = barcodeSvg("DLV-2026-00001", { module: 2, height: 40 });
    const total = runs("DLV-2026-00001").reduce((a, b) => a + b, 0) + 20;
    expect(svg).toContain(`viewBox="0 0 ${total * 2} 40"`);
    expect((svg.match(/<rect x=/g) ?? []).length).toBe(Math.ceil(runs("DLV-2026-00001").length / 2));
    expect(barcodeSvg('"><x', {})).not.toContain('"><x');
  });
});
