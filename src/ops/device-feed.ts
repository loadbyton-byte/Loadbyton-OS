import type { Conn, Db } from "../db/client.js";
import { rateLimit } from "../adapters/rate-limit.js";
import { audit } from "../lib/audit.js";
import { decryptSecret, encryptSecret } from "../lib/encryption.js";
import { actorOf, require, type Ctx, type Perm } from "../lib/perms.js";
import { HttpError, badRequest, forbidden, randomToken, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";
import { parseCsv } from "./importer.js";
import { channelUrl, verifyInbound } from "./inbound.js";
import { recordSpecialistEvent } from "./specialists.js";

/**
 * Temperature-logger feeds for cold-chain cases. Every reading that arrives — signed push or logger CSV — is kept as an immutable raw record with
 * the outcome. A reading becomes a case event only when the device is bound to an open case, its time is plausible, and the case's own rules
 * (current calibration evidence, open status) accept it; otherwise it stays as a rejected reading with the reason. An out-of-range reading
 * puts the case on hold through the same path as a manual one; a person with approval authority decides the excursion.
 */
/** What each sector's devices report. A reading becomes the named case event, subject to that sector's own rules in recordSpecialistEvent. */
export const FEED_SECTORS = {
  "cold-chain": { event: "temperature", noun: "logger", measure: "temperature" },
  "automotive-logistics": { event: "yard", noun: "yard scanner", measure: "location" },
  "aviation-logistics": { event: "milestone", noun: "flight / ULD tracker", measure: "air milestone" },
  "distribution": { event: "dispatch", noun: "dispatch scanner", measure: "dispatch" },
  "moving-relocation": { event: "packed", noun: "packing scanner", measure: "packing" },
} as const;
/** Sectors whose readings are structured scans rather than a temperature or a yard location: the keys a reading must carry and how they are checked. */
type GenericField = { key: string; kind: "text" | "number" | "choice"; choices?: string[] };
export const GENERIC_FEEDS: Record<string, { event: string; fields: GenericField[]; attrs: (d: Record<string, any>, at: Date) => Record<string, any> }> = {
  "aviation-logistics": { event: "milestone", fields: [{ key: "stage", kind: "choice", choices: ["booked", "departed", "arrived", "released"] }, { key: "reference", kind: "text" }], attrs: (d, at) => ({ stage: d.stage, observed_at: at.toISOString(), reference: d.reference }) },
  "distribution": { event: "dispatch", fields: [{ key: "sku", kind: "text" }, { key: "qty", kind: "number" }], attrs: (d) => ({ sku: d.sku, qty: d.qty }) },
  "moving-relocation": { event: "packed", fields: [{ key: "item_ref", kind: "text" }, { key: "qty", kind: "number" }], attrs: (d) => ({ item_ref: d.item_ref, qty: d.qty }) },
};
/** The checked values of a generic reading, or the reason it cannot be used. */
export function checkGeneric(sector: string, raw: Record<string, any> | undefined): { ok: true; data: Record<string, any> } | { ok: false; reason: string } {
  const spec = GENERIC_FEEDS[sector];
  if (!spec) return { ok: false, reason: "This device kind has no structured readings." };
  const data: Record<string, any> = {};
  for (const f of spec.fields) {
    const v = raw?.[f.key];
    if (f.kind === "number") { const n = Number(v); if (v === undefined || v === "" || !Number.isFinite(n) || n <= 0 || n > 1_000_000) return { ok: false, reason: `${f.key} must be a number above zero.` }; data[f.key] = n; }
    else if (f.kind === "choice") { const t = String(v ?? "").trim().toLowerCase(); if (!f.choices!.includes(t)) return { ok: false, reason: `${f.key} must be one of ${f.choices!.join(", ")}.` }; data[f.key] = t; }
    else { const t = String(v ?? "").trim(); if (!t || t.length > 120) return { ok: false, reason: `${f.key} is missing or longer than 120 characters.` }; data[f.key] = t; }
  }
  return { ok: true, data };
}
type FeedSector = keyof typeof FEED_SECTORS;
const isSector = (v: unknown): v is FeedSector => typeof v === "string" && v in FEED_SECTORS;
export const deviceUrl = (token: string) => channelUrl(token).replace("/webhooks/inbound/", "/webhooks/devices/");

async function gate(c: Conn, ctx: Ctx, sector: FeedSector, perm: Perm = "specialist.write") {
  require(ctx, perm);
  await assertWritable(c, ctx.tenantId);
  if (!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector=$1`, [sector])).rows.length) throw forbidden(`The ${sector} sector is not selected.`);
}
/** Gate for an operation on an existing device: its own sector decides. */
async function gateDevice(c: Conn, ctx: Ctx, deviceId: string) {
  require(ctx, "specialist.write");
  const d = await must(c.query<any>(`SELECT sector FROM specialist_devices WHERE id=$1`, [recordId(deviceId, "Device")]), "Device");
  await gate(c, ctx, d.sector);
  return d.sector as FeedSector;
}

export async function registerDevice(c: Conn, ctx: Ctx, f: Record<string, any>) {
  const sector = (f.sector ?? "cold-chain") as string;
  if (!isSector(sector)) throw badRequest(`Choose a sector with device feeds: ${Object.keys(FEED_SECTORS).join(", ")}.`);
  await gate(c, ctx, sector);
  const interval = Number(f.interval_minutes ?? 15);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1440) throw badRequest("The logging interval is 1–1440 minutes.");
  const serial = reqStr(f.serial, "Logger serial number", 80), token = randomToken(24), secret = randomToken(32);
  const dup = await c.query(`SELECT 1 FROM specialist_devices WHERE serial=$1`, [serial]);
  if (dup.rows.length) throw badRequest("A device with that serial number is already registered.");
  const id = (await c.query<any>(`INSERT INTO specialist_devices(tenant_id,label,serial,interval_minutes,token_hash,secret_enc,created_by,sector) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, reqStr(f.label, "Label", 80), serial, interval, sha256(token), encryptSecret(secret), ctx.userId, sector])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "device.registered", "specialist_device", id, { serial });
  return { id: id as string, url: deviceUrl(token), secret };        // shown once
}
export async function bindDevice(c: Conn, ctx: Ctx, deviceId: string, caseId: string, since?: string) {
  await gateDevice(c, ctx, deviceId);
  const d = await must(c.query<any>(`SELECT * FROM specialist_devices WHERE id=$1 FOR UPDATE`, [recordId(deviceId, "Logger")]), "Logger");
  if (d.status !== "active") throw badRequest("This logger is retired.");
  if (d.case_id && !d.unbound_at) throw badRequest("This logger is already bound to a case. Unbind it first.");
  const k = await must(c.query<any>(`SELECT id, sector, status FROM specialist_cases WHERE id=$1`, [recordId(caseId, "Case")]), "Case");
  if (k.sector !== d.sector) throw badRequest(`A ${FEED_SECTORS[d.sector as FeedSector].noun} is bound to ${d.sector} cases.`);
  if (!["ready", "active", "hold"].includes(k.status)) throw badRequest(`A ${k.status} case does not take readings.`);
  // monitoring starts when the goods and logger were loaded together, which may be a little before the binding is recorded
  let from = new Date();
  if (since) { from = new Date(since); if (Number.isNaN(from.getTime()) || from.getTime() > Date.now() + 60_000 || from.getTime() < Date.now() - 30 * 86400_000) throw badRequest("Monitoring can start up to 30 days ago, and not in the future."); }
  await c.query(`UPDATE specialist_devices SET case_id=$2, bound_at=$3, unbound_at=NULL WHERE id=$1`, [d.id, k.id, from.toISOString()]);
  await audit(c, ctx.tenantId, actorOf(ctx), "device.bound", "specialist_device", d.id, { case: k.id, from: from.toISOString() });
}
export async function unbindDevice(c: Conn, ctx: Ctx, deviceId: string) {
  await gateDevice(c, ctx, deviceId);
  await must(c.query(`UPDATE specialist_devices SET unbound_at=now() WHERE id=$1 AND case_id IS NOT NULL AND unbound_at IS NULL RETURNING id`, [recordId(deviceId, "Logger")]), "Bound logger");
  await audit(c, ctx.tenantId, actorOf(ctx), "device.unbound", "specialist_device", deviceId);
}
export async function retireDevice(c: Conn, ctx: Ctx, deviceId: string) {
  await gateDevice(c, ctx, deviceId);
  await must(c.query(`UPDATE specialist_devices SET status='retired', unbound_at=CASE WHEN case_id IS NOT NULL AND unbound_at IS NULL THEN now() ELSE unbound_at END WHERE id=$1 RETURNING id`, [recordId(deviceId, "Logger")]), "Logger");
}

export interface Reading { ref?: string; at: string; celsius?: number; location?: string; data?: Record<string, any> }
export interface Outcome { ref: string; outcome: "ingested" | "rejected" | "duplicate"; reason?: string }

/** Events from devices are recorded by a per-workspace service identity that can write readings and nothing else. */
export async function serviceUser(db: Db, tenantId: string): Promise<string> {
  const email = `device-feed-${tenantId}@service.invalid`;
  const row = (await db.system((c) => c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,'Device feed','!') ON CONFLICT (email) DO UPDATE SET name=users.name RETURNING id`, [email]))).rows[0];
  return row.id;
}
const feedCtx = (tenantId: string, userId: string): Ctx => ({ userId, tenantId, roles: ["specialist"], perms: new Set<Perm>(["read", "specialist.write"]), partyId: null, driverId: null, readOnly: false, supportStaffId: null });

export async function ingestReading(c: Conn, device: any, svc: Ctx, r: Reading, source: "push" | "csv"): Promise<Outcome> {
  const at = new Date(r.at);
  const ref = (r.ref ?? (Number.isNaN(at.getTime()) ? String(r.at) : at.toISOString())).slice(0, 120);
  // a reading that was accepted, or refused for a reason that cannot change, is final; one refused for a fixable reason (calibration not yet
  // recorded, case not yet open, logger not yet bound) is evaluated again when the logger resends it
  const prior = (await c.query<any>(`SELECT outcome, recoverable, attempt FROM device_readings WHERE device_id=$1 AND reading_ref=$2 ORDER BY attempt DESC LIMIT 1`, [device.id, ref])).rows[0];
  if (prior && (prior.outcome === "ingested" || !prior.recoverable)) return { ref, outcome: "duplicate" };
  const attempt = prior ? prior.attempt + 1 : 1;
  const yard = device.sector === "automotive-logistics", gen = GENERIC_FEEDS[device.sector];
  const insert = async (outcome: "ingested" | "rejected", reason: string | null, caseId: string | null, eventId: string | null, recoverable = false): Promise<Outcome> => {
    const t = yard || gen ? null : Number.isFinite(Number(r.celsius)) ? Math.max(-999, Math.min(999, Number(r.celsius))) : 0;
    await c.query(`INSERT INTO device_readings(tenant_id,device_id,reading_ref,observed_at,celsius,outcome,reason,case_id,event_id,source,attempt,recoverable,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [device.tenant_id, device.id, ref, Number.isNaN(at.getTime()) ? new Date(0) : at, t, outcome, reason, caseId, eventId, source, attempt, recoverable, yard ? String(r.location ?? "").slice(0, 100) : gen ? JSON.stringify(r.data ?? {}).slice(0, 300) : null]);
    return { ref, outcome, reason: reason ?? undefined };
  };
  if (Number.isNaN(at.getTime())) return insert("rejected", "The reading time is not a valid date.", null, null);
  if (yard) { if (typeof r.location !== "string" || !r.location.trim() || r.location.length > 100) return insert("rejected", "The yard location is missing or longer than 100 characters.", null, null); }
  else if (gen) { const v = checkGeneric(device.sector, r.data); if (!v.ok) return insert("rejected", v.reason, null, null); }
  else if (typeof r.celsius !== "number" || !Number.isFinite(r.celsius) || r.celsius < -100 || r.celsius > 100) return insert("rejected", "The temperature is missing or outside −100…100 °C.", null, null);
  const live = (await c.query<any>(`SELECT case_id, bound_at, unbound_at, status FROM specialist_devices WHERE id=$1`, [device.id])).rows[0];
  if (live.status !== "active") return insert("rejected", "The logger is retired.", null, null);
  if (!live.case_id) return insert("rejected", "The logger is not bound to a case.", null, null, true);
  if (at.getTime() < new Date(live.bound_at).getTime() - 1000) return insert("rejected", "The reading predates the logger being bound to this case.", live.case_id, null, true);
  if (live.unbound_at && at.getTime() > new Date(live.unbound_at).getTime()) return insert("rejected", "The logger was unbound from the case before this reading.", live.case_id, null);
  if (at.getTime() > Date.now() + 300_000) return insert("rejected", "The reading time is in the future.", live.case_id, null);
  await c.query("SAVEPOINT reading");
  try {
    const checked = gen ? checkGeneric(device.sector, r.data) : null;
    const eventId = gen && checked?.ok
      ? await recordSpecialistEvent(c, svc, live.case_id, gen.event, gen.attrs(checked.data, at), `${FEED_SECTORS[device.sector as FeedSector].noun} ${device.serial} at ${at.toISOString()}`, `dev:${device.serial}:${ref}`.slice(0, 120))
      : yard
      ? await recordSpecialistEvent(c, svc, live.case_id, "yard", { location: String(r.location).trim(), reference: `${device.serial}@${at.toISOString()}`.slice(0, 120) }, `Yard scanner ${device.serial} at ${at.toISOString()}`, `dev:${device.serial}:${ref}`.slice(0, 120))
      : await recordSpecialistEvent(c, svc, live.case_id, "temperature", { celsius: Math.round(r.celsius! * 100) / 100, observed_at: at.toISOString() }, `Logger ${device.serial}`, `dev:${device.serial}:${ref}`.slice(0, 120));
    await c.query("RELEASE SAVEPOINT reading");
    return insert("ingested", null, live.case_id, eventId);
  } catch (e: any) {
    await c.query("ROLLBACK TO SAVEPOINT reading");
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    return insert("rejected", e.message.slice(0, 300), live.case_id, null, true);
  }
}

export async function processReadings(db: Db, device: any, readings: Reading[], source: "push" | "csv"): Promise<Outcome[]> {
  const svc = feedCtx(device.tenant_id, await serviceUser(db, device.tenant_id));
  return db.tenant(device.tenant_id, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${device.tenant_id}:device:${device.id}`]);
    const out: Outcome[] = [];
    for (const r of readings) out.push(await ingestReading(c, device, svc, r, source));
    const seen = readings.map((r) => new Date(r.at).getTime()).filter((t) => Number.isFinite(t));
    await c.query(`UPDATE specialist_devices SET last_seen=greatest(coalesce(last_seen,'epoch'::timestamptz), $2::timestamptz) WHERE id=$1`, [device.id, new Date(Math.min(Math.max(...seen, 0), Date.now())).toISOString()]);
    return out;
  });
}

export interface FeedRequest { method: string; raw: string; header: (n: string) => string | undefined }
export async function handleDeviceFeed(db: Db, token: string, req: FeedRequest): Promise<{ status: number; body: unknown }> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token) || req.method !== "POST") return { status: 404, body: { error: "not found" } };
  const device = (await db.system((c) => c.query<any>(`SELECT * FROM specialist_devices WHERE token_hash=$1`, [sha256(token)]))).rows[0];
  if (!device || device.status !== "active") return { status: 404, body: { error: "not found" } };
  await rateLimit(`device:${device.id}`, 120, 60);
  if (req.raw.length > 262_144) return { status: 400, body: { error: "payload too large" } };
  if (!verifyInbound("lbt_hmac", decryptSecret(device.secret_enc), { raw: req.raw, header: req.header, url: "" })) return { status: 401, body: { error: "invalid signature" } };
  let readings: Reading[];
  try {
    const p = JSON.parse(req.raw);
    const list = Array.isArray(p?.readings) ? p.readings : [];
    if (!list.length || list.length > 500) throw new Error("count");
    readings = list.map((x: any) => ({ ref: x.id != null ? String(x.id) : undefined, at: String(x.at ?? x.time ?? ""), celsius: typeof x.celsius === "number" ? x.celsius : typeof x.c === "number" ? x.c : NaN, location: typeof x.location === "string" ? x.location : undefined, data: GENERIC_FEEDS[device.sector] ? Object.fromEntries(GENERIC_FEEDS[device.sector].fields.map((f) => [f.key, x[f.key] ?? x.data?.[f.key]])) : undefined }));
  } catch { return { status: 400, body: { error: GENERIC_FEEDS[device.sector] ? `send {"readings":[{"id","at",${GENERIC_FEEDS[device.sector].fields.map((f) => `"${f.key}"`).join(",")}}]} with 1–500 readings` : device.sector === "automotive-logistics" ? "send {\"readings\":[{\"id\",\"at\",\"location\"}]} with 1–500 readings" : "send {\"readings\":[{\"id\",\"at\",\"celsius\"}]} with 1–500 readings" } }; }
  const results = await processReadings(db, device, readings, "push");
  return { status: 200, body: { received: results.length, ingested: results.filter((r) => r.outcome === "ingested").length, rejected: results.filter((r) => r.outcome === "rejected").length, duplicates: results.filter((r) => r.outcome === "duplicate").length,
    rejections: results.filter((r) => r.outcome === "rejected").slice(0, 20).map((r) => ({ ref: r.ref, reason: r.reason })) } };
}

/** A logger's downloaded CSV (UTC ISO times). Re-importing the same file adds nothing: readings are keyed by device and time. */
export async function importLoggerCsv(db: Db, ctx: Ctx, deviceId: string, csv: string) {
  const device = await db.tenant(ctx.tenantId, async (c) => { await gateDevice(c, ctx, deviceId); return must(c.query<any>(`SELECT * FROM specialist_devices WHERE id=$1`, [recordId(deviceId, "Logger")]), "Logger"); });
  const rows = parseCsv(csv).filter((r) => r.some((x) => x.trim()));
  if (rows.length < 2) throw badRequest("The file has no readings.");
  if (rows.length > 20001) throw badRequest("Import up to 20,000 readings at a time.");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const yard = device.sector === "automotive-logistics";
  const ti = head.findIndex((h) => ["time", "timestamp", "datetime", "at"].includes(h));
  const gspec = GENERIC_FEEDS[device.sector];
  if (gspec) {
    const gi = gspec.fields.map((f) => head.indexOf(f.key));
    if (ti < 0 || gi.some((i) => i < 0)) throw badRequest(`The file needs a time column (UTC, ISO 8601) and ${gspec.fields.map((f) => f.key).join(", ")} columns.`);
    const greadings: Reading[] = rows.slice(1).map((r) => ({ at: (r[ti] ?? "").trim(), data: Object.fromEntries(gspec.fields.map((f, k) => [f.key, (r[gi[k]] ?? "").trim()])) }));
    const gout: Outcome[] = [];
    for (let i = 0; i < greadings.length; i += 500) gout.push(...await processReadings(db, device, greadings.slice(i, i + 500), "csv"));
    await db.tenant(ctx.tenantId, (c) => audit(c, ctx.tenantId, actorOf(ctx), "device.csv_imported", "specialist_device", device.id, { rows: greadings.length }));
    return { rows: greadings.length, ingested: gout.filter((o) => o.outcome === "ingested").length, rejected: gout.filter((o) => o.outcome === "rejected").length, duplicates: gout.filter((o) => o.outcome === "duplicate").length, rejections: gout.filter((o) => o.outcome === "rejected").slice(0, 10) };
  }
  const ci = head.findIndex((h) => (yard ? ["location", "yard", "zone", "bay"] : ["celsius", "temperature", "temp", "temp_c", "c"]).includes(h));
  if (ti < 0 || ci < 0) throw badRequest(yard ? "The file needs a time column (UTC, ISO 8601) and a location column." : "The file needs a time column (UTC, ISO 8601) and a temperature column in °C.");
  const readings: Reading[] = rows.slice(1).map((r) => yard ? ({ at: (r[ti] ?? "").trim(), location: (r[ci] ?? "").trim() }) : ({ at: (r[ti] ?? "").trim(), celsius: Number((r[ci] ?? "").replace(",", ".")) }));
  const out: Outcome[] = [];
  for (let i = 0; i < readings.length; i += 500) out.push(...await processReadings(db, device, readings.slice(i, i + 500), "csv"));
  await db.tenant(ctx.tenantId, (c) => audit(c, ctx.tenantId, actorOf(ctx), "device.csv_imported", "specialist_device", device.id, { rows: readings.length }));
  return { rows: readings.length, ingested: out.filter((o) => o.outcome === "ingested").length, rejected: out.filter((o) => o.outcome === "rejected").length, duplicates: out.filter((o) => o.outcome === "duplicate").length, rejections: out.filter((o) => o.outcome === "rejected").slice(0, 10) };
}

// ───────── monitoring
/** Mean kinetic temperature: the single temperature that would cause the same thermal degradation as the recorded profile (ΔH/R = 10,000 K, the pharmacopoeial convention). */
export function meanKineticTemp(celsius: number[]): number | null {
  if (!celsius.length) return null;
  const sum = celsius.reduce((a, t) => a + Math.exp(-10000 / (t + 273.15)), 0);
  return Math.round((10000 / -Math.log(sum / celsius.length) - 273.15) * 100) / 100;
}
export async function caseMonitor(c: Conn, caseId: string) {
  const k = await must(c.query<any>(`SELECT id, no, status, attributes FROM specialist_cases WHERE id=$1 AND sector='cold-chain'`, [recordId(caseId, "Case")]), "Cold-chain case");
  const lo = Number(k.attributes.minimum_c), hi = Number(k.attributes.maximum_c);
  const pts = (await c.query<any>(`SELECT (attributes->>'observed_at')::timestamptz AS at, (attributes->>'celsius')::float8 AS celsius, client_ref FROM specialist_events WHERE case_id=$1 AND kind='temperature' ORDER BY 1`, [k.id])).rows
    .map((p: any) => ({ at: new Date(p.at), celsius: Number(p.celsius), ref: p.client_ref as string, device: String(p.client_ref).startsWith("dev:"), out: Number(p.celsius) < lo || Number(p.celsius) > hi }));
  const devices = (await c.query<any>(`SELECT id,label,serial,interval_minutes,last_seen,bound_at,unbound_at FROM specialist_devices WHERE case_id=$1`, [k.id])).rows;
  // refusals still standing: the latest attempt of each reading, where that attempt was a refusal
  const rejected = (await c.query<any>(`SELECT x.observed_at, x.celsius::float8 AS celsius, x.reason, d.serial FROM (SELECT DISTINCT ON (device_id, reading_ref) * FROM device_readings ORDER BY device_id, reading_ref, attempt DESC) x JOIN specialist_devices d ON d.id=x.device_id WHERE x.outcome='rejected' AND (x.case_id=$1 OR d.case_id=$1) ORDER BY x.observed_at DESC LIMIT 50`, [k.id])).rows;
  let outMs = 0;
  const cap = Math.max(60, ...devices.map((d: any) => Number(d.interval_minutes) * 2)) * 60_000;
  for (let i = 0; i < pts.length - 1; i++) if (pts[i].out) outMs += Math.min(pts[i + 1].at.getTime() - pts[i].at.getTime(), cap);
  const gaps: { from: Date; to: Date; minutes: number }[] = [];
  const expected = Math.min(...devices.map((d: any) => Number(d.interval_minutes)), 1440);
  if (devices.length) for (let i = 0; i < pts.length - 1; i++) { const m = (pts[i + 1].at.getTime() - pts[i].at.getTime()) / 60000; if (m > expected * 3) gaps.push({ from: pts[i].at, to: pts[i + 1].at, minutes: Math.round(m) }); }
  const temps = pts.map((p) => p.celsius);
  return {
    case: k, range: { lo, hi }, points: pts, devices, rejected, gaps,
    stats: temps.length ? { n: temps.length, min: Math.min(...temps), max: Math.max(...temps), mean: Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 100) / 100, mkt: meanKineticTemp(temps), excursions: pts.filter((p) => p.out).length, minutes_out_of_range: Math.round(outMs / 60000) } : null,
  };
}
export async function deviceOverview(c: Conn) {
  const now = Date.now();
  return (await c.query<any>(`SELECT d.*, k.no AS case_no, (SELECT count(*) FROM device_readings r WHERE r.device_id=d.id AND r.outcome='ingested')::int AS ingested, (SELECT count(*) FROM device_readings r WHERE r.device_id=d.id AND r.outcome='rejected')::int AS rejected FROM specialist_devices d LEFT JOIN specialist_cases k ON k.id=d.case_id ORDER BY d.created_at DESC`)).rows
    .map((d: any) => {
      const active = d.case_id && !d.unbound_at && d.status === "active";
      const minutes = d.last_seen ? Math.round((now - new Date(d.last_seen).getTime()) / 60000) : null;
      return { ...d, bound: !!active, silent: !!active && (minutes == null || minutes > d.interval_minutes * 3), minutes_since: minutes };
    });
}
