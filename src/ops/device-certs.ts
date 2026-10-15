import type { Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest, forbidden } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";

const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
/** Record a certificate that an accredited laboratory or the maker issued. Nothing here grants certification; it is a register that a second person approves. */
export async function recordCertificate(c: Conn, ctx: Ctx, deviceId: string, f: Record<string, any>) {
  require(ctx, "specialist.write");
  await assertWritable(c, ctx.tenantId);
  const dev = await must(c.query<any>(`SELECT id FROM specialist_devices WHERE id=$1`, [recordId(deviceId, "Device")]), "Device");
  const kind = String(f.kind ?? "");
  if (!["calibration", "qualification", "type_approval"].includes(kind)) throw badRequest("Choose calibration, qualification or type approval.");
  if (!isDate(f.issued_on) || !isDate(f.valid_until)) throw badRequest("Give the issue and expiry dates as YYYY-MM-DD.");
  if (f.valid_until <= f.issued_on) throw badRequest("The certificate must expire after it was issued.");
  if (f.issued_on > new Date().toISOString().slice(0, 10)) throw badRequest("The issue date is in the future.");
  const r = await c.query<any>(`INSERT INTO device_certificates(tenant_id,device_id,kind,certificate_no,issuer,accreditation_ref,issued_on,valid_until,evidence_ref,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, dev.id, kind, reqStr(f.certificate_no, "Certificate number", 80), reqStr(f.issuer, "Issuer", 120), String(f.accreditation_ref ?? "").trim().slice(0, 80) || null, f.issued_on, f.valid_until, reqStr(f.evidence_ref, "Where the certificate document is kept", 200), ctx.userId])
    .catch((e) => { if (/unique/i.test(String(e.message))) throw badRequest("That certificate is already recorded for this device."); throw e; });
  await audit(c, ctx.tenantId, actorOf(ctx), "device_certificate.recorded", "specialist_device", dev.id, { kind });
  return r.rows[0].id as string;
}
export async function approveCertificate(c: Conn, ctx: Ctx, certId: string) {
  require(ctx, "specialist.approve");
  const cert = await must(c.query<any>(`SELECT id, status, recorded_by, device_id FROM device_certificates WHERE id=$1 FOR UPDATE`, [recordId(certId, "Certificate")]), "Certificate");
  if (cert.status !== "pending") throw badRequest(`This certificate is ${cert.status}.`);
  if (cert.recorded_by === ctx.userId) throw forbidden("A different person must approve a certificate you recorded.");
  await c.query(`UPDATE device_certificates SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1`, [cert.id, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "device_certificate.approved", "specialist_device", cert.device_id);
}
export async function revokeCertificate(c: Conn, ctx: Ctx, certId: string, reason: string) {
  require(ctx, "specialist.approve");
  const why = String(reason ?? "").trim();
  if (why.length < 5) throw badRequest("Say why the certificate is revoked (at least 5 characters).");
  const cert = await must(c.query<any>(`UPDATE device_certificates SET status='revoked', revoked_reason=$2 WHERE id=$1 AND status IN ('pending','approved') RETURNING device_id`, [recordId(certId, "Certificate"), why.slice(0, 300)]), "Certificate");
  await audit(c, ctx.tenantId, actorOf(ctx), "device_certificate.revoked", "specialist_device", cert.device_id);
}
export async function setRequireCertificate(c: Conn, ctx: Ctx, deviceId: string, on: boolean) {
  require(ctx, "specialist.approve");
  await must(c.query(`UPDATE specialist_devices SET require_certificate=$2 WHERE id=$1 RETURNING id`, [recordId(deviceId, "Device"), on]), "Device");
  await audit(c, ctx.tenantId, actorOf(ctx), on ? "device.certificate_required" : "device.certificate_optional", "specialist_device", deviceId);
}
/** True when an approved certificate covers this moment (its dates are inclusive). */
export async function certificateCovers(c: Conn, deviceId: string, at: Date): Promise<boolean> {
  const day = at.toISOString().slice(0, 10);
  return (await c.query(`SELECT 1 FROM device_certificates WHERE device_id=$1 AND status='approved' AND issued_on <= $2::date AND valid_until >= $2::date LIMIT 1`, [deviceId, day])).rows.length > 0;
}
export const listCertificates = (c: Conn) => c.query<any>(
  `SELECT x.*, d.label, d.serial, d.require_certificate, ru.name AS recorded_name, au.name AS approved_name FROM device_certificates x JOIN specialist_devices d ON d.id=x.device_id JOIN users ru ON ru.id=x.recorded_by LEFT JOIN users au ON au.id=x.approved_by ORDER BY x.valid_until DESC LIMIT 300`).then((r) => r.rows);
export const devicesForCertificates = (c: Conn) => c.query<any>(`SELECT id, label, serial, sector, require_certificate FROM specialist_devices WHERE status='active' ORDER BY label`).then((r) => r.rows);
