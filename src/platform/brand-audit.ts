/**
 * Brand asset audit. A vector master is the source from which every size and format is cut; PNG-only brand files cannot be scaled or re-cut
 * without redrawing. This reports what is in the brand folder and whether the vector master the readiness gate requires is present.
 */
export interface BrandFile { name: string; bytes: Buffer }
export interface BrandFinding { level: "pass" | "warn" | "fail"; message: string }
const png = (b: Buffer) => b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const dims = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

export function auditBrand(files: BrandFile[]): { findings: BrandFinding[]; vectorMaster: boolean; rasterOnly: string[] } {
  const f: BrandFinding[] = [];
  const svgs = files.filter((x) => /\.svg$/i.test(x.name)), pdfs = files.filter((x) => /\.(pdf|ai|eps)$/i.test(x.name));
  const genuine = svgs.filter((s) => { const t = s.bytes.toString("utf8"); return /<svg[\s>]/.test(t) && /<(path|rect|circle|polygon|polyline|ellipse|text|line)\b/.test(t) && !/<image\b/.test(t); });
  const embedded = svgs.filter((s) => /<image\b/.test(s.bytes.toString("utf8")));
  for (const s of embedded) f.push({ level: "fail", message: `${s.name} is an SVG that wraps a raster image; it is not a vector master.` });
  const vectorMaster = genuine.length > 0 || pdfs.length > 0;
  f.push(vectorMaster ? { level: "pass", message: `Vector master present: ${[...genuine, ...pdfs].map((x) => x.name).join(", ")}.` } : { level: "fail", message: "No vector master (SVG with real paths, or PDF/AI/EPS). Brand files are raster only." });
  const rasters = files.filter((x) => png(x.bytes));
  const rasterOnly = vectorMaster ? [] : rasters.map((x) => x.name);
  for (const r of rasters) {
    const { w, h } = dims(r.bytes);
    if (/logo/i.test(r.name) && w < 1000) f.push({ level: "warn", message: `${r.name} is ${w}×${h}px; logos used on print or large screens should be cut from a vector master.` });
  }
  const ico = files.find((x) => /favicon\.ico$/i.test(x.name));
  f.push(ico ? { level: "pass", message: "favicon.ico present." } : { level: "warn", message: "favicon.ico is missing." });
  for (const need of [32, 192]) if (!rasters.some((r) => /mark/i.test(r.name) && dims(r.bytes).w === need)) f.push({ level: "warn", message: `No ${need}px mark found.` });
  return { findings: f, vectorMaster, rasterOnly };
}
