// Code 128 (code set B: ASCII 32–126), rendered as an inline SVG for printable waybill labels.
// PATTERNS[v] is the run-length encoding (bar, space, bar, space, bar, space) of symbol value v; 103–105 are the start codes A/B/C.
// The table was generated from an independent implementation (python-barcode) and is verified by tests (11 modules per symbol, checksum, round-trip decode).
export const PATTERNS = ["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321","112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121","313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111","314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212","124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141","114131","311141","411131","211412","211214","211232"];
export const STOP = "2331112";   // 13 modules incl. the final 2-module bar

export function code128B(text: string): number[] {
  const vals = [104];                                               // Start B
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`character ${JSON.stringify(ch)} cannot be encoded in Code 128 set B`);
    vals.push(c - 32);
  }
  let sum = vals[0];
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103);
  return vals;
}

/** Module widths for the whole symbol including quiet-zone-free start/stop, alternating bar/space starting with a bar. */
export function runs(text: string): number[] {
  return [...code128B(text).flatMap((v) => [...PATTERNS[v]].map(Number)), ...[...STOP].map(Number)];
}

/** Decode a run list back to text (used by tests to prove the encoder round-trips). */
export function decodeRuns(r: number[]): string {
  const syms: number[] = [];
  for (let i = 0; i + 6 <= r.length - 7; i += 6) {
    const k = r.slice(i, i + 6).join("");
    const v = PATTERNS.indexOf(k);
    if (v < 0) throw new Error("unknown symbol " + k);
    syms.push(v);
  }
  if (r.slice(r.length - 7).join("") !== STOP) throw new Error("missing stop");
  if (syms[0] !== 104) throw new Error("not code set B");
  const check = syms.pop()!;
  let sum = syms[0];
  for (let i = 1; i < syms.length; i++) sum += syms[i] * i;
  if (sum % 103 !== check) throw new Error("bad checksum");
  return syms.slice(1).map((v) => String.fromCharCode(v + 32)).join("");
}

/** SVG barcode, `module` px per module, 10-module quiet zones. Black on white; scales with CSS width. */
export function barcodeSvg(text: string, opts: { module?: number; height?: number } = {}): string {
  const m = opts.module ?? 2, h = opts.height ?? 60, r = runs(text);
  const total = r.reduce((a, b) => a + b, 0) + 20;
  let x = 10, bars = "";
  r.forEach((w, i) => { if (i % 2 === 0) bars += `<rect x="${x * m}" y="0" width="${w * m}" height="${h}"/>`; x += w; });
  const esc = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total * m} ${h}" width="${total * m}" height="${h}" role="img" aria-label="Barcode ${esc}" preserveAspectRatio="none"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${bars}</g></svg>`;
}
