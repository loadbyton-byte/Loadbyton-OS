import crypto from "node:crypto";
import path from "node:path";
import type { Conn } from "../db/client.js";
import { scanWithClamav } from "../adapters/clamav.js";
import { audit } from "../lib/audit.js";
import { findPrivateData, privateDataMessage } from "../lib/private-data.js";
import { storage } from "../lib/storage.js";
import { HttpError, badRequest, sha256 } from "../lib/util.js";
import { markBrandReady } from "./requests.js";

/**
 * The brand kit is what we need to make the delivered system look like the client's company: a name, colours, a footer line and a logo.
 * It deliberately has no field for a tax number, bank account or password; the client types those into their own admin panel.
 */
export interface BrandKit {
  tenant_id: string; display_name: string; tagline: string | null; website: string | null; primary_colour: string | null; secondary_colour: string | null;
  doc_footer: string | null; notes: string | null; no_logo: boolean; confirmed_at: string | null; updated_at: string;
}
export interface BrandAsset { id: string; tenant_id: string; kind: AssetKind; filename: string; mime: string; size_bytes: number; sha256: string; storage_key: string; created_at: string }

export const ASSET_KINDS = { logo: "Logo", logo_dark: "Logo for dark backgrounds", icon: "Icon or favicon", guidelines: "Brand guidelines", other: "Other brand file" } as const;
export type AssetKind = keyof typeof ASSET_KINDS;
const LOGO_KINDS: AssetKind[] = ["logo", "logo_dark", "icon"];
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_ASSETS = 10;

const TYPES: Record<string, { mime: string; magic: (b: Buffer) => boolean }> = {
  png: { mime: "image/png", magic: (b) => b[0] === 0x89 && b.subarray(1, 4).toString() === "PNG" },
  jpg: { mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  jpeg: { mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  webp: { mime: "image/webp", magic: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  pdf: { mime: "application/pdf", magic: (b) => b.subarray(0, 4).toString() === "%PDF" },
  svg: { mime: "image/svg+xml", magic: (b) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(b.subarray(0, 2048).toString("utf8")) },
};
export const ASSET_TYPES_LABEL = "PNG, JPG, WebP, SVG or PDF, up to 5 MB each";

/** An SVG is a document that can carry script. We only ever hand it to staff as a download, but we refuse the dangerous parts anyway. */
const unsafeSvg = (b: Buffer) => /<\s*(script|foreignObject|iframe|embed|object)\b|\son[a-z]+\s*=|javascript:|data:text\/html|<!ENTITY/i.test(b.toString("utf8"));

export interface AssetFile { filename: string; data: Buffer; kind: string }

/** Everything that can be decided without a tenant: type, size, content, malware. Run before any account is created. */
export async function checkAssetFile(f: AssetFile) {
  const kind = (f.kind in ASSET_KINDS ? f.kind : "logo") as AssetKind;
  const ext = path.extname(f.filename).slice(1).toLowerCase();
  const t = TYPES[ext];
  if (!t) throw badRequest(`.${ext || "?"} files are not accepted. Send ${ASSET_TYPES_LABEL}.`);
  if (!f.data.length) throw badRequest("That file is empty.");
  if (f.data.length > MAX_ASSET_BYTES) throw badRequest(`Files are limited to ${MAX_ASSET_BYTES / 1048576} MB. Send a smaller or exported copy.`);
  if (!t.magic(f.data)) throw badRequest("The file's content doesn't match its name. Export it again as a normal PNG, JPG, WebP, SVG or PDF.");
  if (ext === "svg" && unsafeSvg(f.data)) throw badRequest("That SVG contains scripts or embedded objects. Export a plain SVG, or send a PNG.");
  await scanWithClamav(f.data);
  return { kind, ext, mime: t.mime, filename: path.basename(f.filename).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || `logo.${ext}` };
}

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
const colour = (s: unknown, label: string) => {
  const v = clean(s, 7);
  if (!v) return null;
  if (!/^#[0-9A-Fa-f]{6}$/.test(v)) throw badRequest(`${label} must be a colour like #0F2B3D.`);
  return v.toUpperCase();
};

export interface BrandInput { displayName: string; tagline?: string; website?: string; primaryColour?: string; secondaryColour?: string; docFooter?: string; notes?: string; noLogo?: boolean }

/** Pure validation of the text fields. The footer and notes are refused if they contain a private number: it would end up printed on documents. */
export function checkBrandInput(i: BrandInput) {
  const displayName = clean(i.displayName, 120);
  if (!displayName) throw badRequest("Enter the company name as it should appear on your documents.");
  const website = clean(i.website, 200);
  if (website && !/^(https?:\/\/)?[^\s/$.?#][^\s]*\.[^\s]{2,}$/i.test(website)) throw badRequest("That website address doesn't look right.");
  const out = {
    displayName, tagline: clean(i.tagline, 160) || null, website: website || null,
    primaryColour: colour(i.primaryColour, "Main colour"), secondaryColour: colour(i.secondaryColour, "Second colour"),
    docFooter: clean(i.docFooter, 300) || null, notes: clean(i.notes, 2000) || null, noLogo: !!i.noLogo,
  };
  for (const v of [out.tagline, out.docFooter, out.notes]) {
    const hit = v && findPrivateData(v);
    if (hit) throw badRequest(privateDataMessage(hit));
  }
  return out;
}

export async function getBrand(c: Conn) {
  const kit = (await c.query<BrandKit>(`SELECT * FROM brand_kits`)).rows[0] ?? null;
  const assets = (await c.query<BrandAsset>(`SELECT * FROM brand_assets WHERE removed_at IS NULL ORDER BY created_at`)).rows;
  return { kit, assets };
}

/** Complete = a name, and either a logo file or the client saying they have none yet. */
export const brandReady = (kit: BrandKit | null, assets: Pick<BrandAsset, "kind">[]) =>
  !!kit && (kit.no_logo || assets.some((a) => LOGO_KINDS.includes(a.kind)));

export async function saveBrandKit(c: Conn, tenantId: string, userId: string, input: BrandInput) {
  const v = checkBrandInput(input);
  await c.query(
    `INSERT INTO brand_kits(tenant_id,display_name,tagline,website,primary_colour,secondary_colour,doc_footer,notes,no_logo,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (tenant_id) DO UPDATE SET display_name=$2,tagline=$3,website=$4,primary_colour=$5,secondary_colour=$6,doc_footer=$7,notes=$8,no_logo=$9,updated_at=now()`,
    [tenantId, v.displayName, v.tagline, v.website, v.primaryColour, v.secondaryColour, v.docFooter, v.notes, v.noLogo]);
  await audit(c, tenantId, { kind: "user", userId }, "brand.saved", "brand_kit", tenantId);
}

/** Store a checked file. The kit row must exist (a name is the minimum). */
export async function addBrandAsset(c: Conn, tenantId: string, userId: string, f: AssetFile) {
  const v = await checkAssetFile(f);
  const n = Number((await c.query<{ n: number }>(`SELECT count(*)::int n FROM brand_assets WHERE removed_at IS NULL`)).rows[0].n);
  if (n >= MAX_ASSETS) throw badRequest(`You can keep up to ${MAX_ASSETS} files. Remove one first.`);
  const key = `${tenantId}/brand/${crypto.randomUUID()}`;
  await storage.put(key, f.data);
  const r = await c.query<{ id: string }>(
    `INSERT INTO brand_assets(tenant_id,kind,filename,mime,size_bytes,sha256,storage_key,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [tenantId, v.kind, v.filename, v.mime, f.data.length, sha256(f.data), key, userId]);
  await audit(c, tenantId, { kind: "user", userId }, "brand.asset_added", "brand_asset", r.rows[0].id, { kind: v.kind, sha256: sha256(f.data) });
  return r.rows[0].id;
}

export async function removeBrandAsset(c: Conn, tenantId: string, userId: string, id: string) {
  const r = await c.query(`UPDATE brand_assets SET removed_at=now() WHERE id=$1 AND removed_at IS NULL RETURNING id`, [id]);
  if (!r.rows.length) throw new HttpError(404, "File not found", "not_found");
  await audit(c, tenantId, { kind: "user", userId }, "brand.asset_removed", "brand_asset", id);
}

/** The client says the kit is complete. That is what lets the delivery clock start on every request that was waiting for it. */
export async function confirmBrandKit(c: Conn, tenantId: string, userId: string) {
  const { kit, assets } = await getBrand(c);
  if (!kit) throw badRequest("Save your company name first.");
  if (!brandReady(kit, assets)) throw badRequest("Add a logo file, or tick “I don't have a logo yet”, then confirm.");
  await c.query(`UPDATE brand_kits SET confirmed_at=coalesce(confirmed_at, now()), updated_at=now() WHERE tenant_id=$1`, [tenantId]);
  await audit(c, tenantId, { kind: "user", userId }, "brand.confirmed", "brand_kit", tenantId);
  return markBrandReady(c, tenantId);
}

/** Reads a stored file after checking it belongs to the tenant and has not been altered. */
export async function readBrandAsset(a: Pick<BrandAsset, "storage_key" | "sha256">, tenantId: string): Promise<Buffer> {
  if (!a.storage_key.startsWith(`${tenantId}/`)) throw new HttpError(403, "Not permitted", "forbidden");
  const buf = await storage.get(a.storage_key);
  if (sha256(buf) !== a.sha256) throw new Error("Stored brand file failed its integrity check");
  return buf;
}

/** What staff apply when they customise a build: the kit as data (JSON) and as CSS variables. Values were validated on the way in; the name is stripped of anything that could close a CSS string. */
export function brandTheme(kit: Pick<BrandKit, "display_name" | "tagline" | "website" | "primary_colour" | "secondary_colour" | "doc_footer">, assets: Pick<BrandAsset, "kind" | "filename">[]) {
  const safe = (v: string | null) => (v ?? "").replace(/[^\p{L}\p{N} .,&@()+_-]/gu, "").replace(/\s+/g, " ").trim();
  const json = { name: kit.display_name, tagline: kit.tagline, website: kit.website, colours: { primary: kit.primary_colour, secondary: kit.secondary_colour }, documentFooter: kit.doc_footer, files: assets.map((a) => ({ kind: a.kind, filename: a.filename })) };
  const css = `/* Brand theme for ${safe(kit.display_name)} */\n:root{\n  --brand-name:"${safe(kit.display_name)}";\n${kit.primary_colour ? `  --brand-primary:${kit.primary_colour};\n` : ""}${kit.secondary_colour ? `  --brand-secondary:${kit.secondary_colour};\n` : ""}  --brand-footer:"${safe(kit.doc_footer)}";\n}\n`;
  return { json, css };
}
