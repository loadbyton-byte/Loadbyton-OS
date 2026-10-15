import { Hono } from "hono";
import { formatDate } from "../lib/util.js";
import { approveCertificate, devicesForCertificates, listCertificates, recordCertificate, revokeCertificate, setRequireCertificate } from "../ops/device-certs.js";
import { act, appPage, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

export const deviceCerts = new Hono<Env>();
const U = "/app/devices/certificates";
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;
deviceCerts.get(U, async (c) => {
  need(c, "specialist.write");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ certs: await listCertificates(cn), devices: await devicesForCertificates(cn) }));
  return appPage(c, "Device certificates", <>
    <PageHead title="Device certificates" sub="Record the calibration, qualification or type-approval certificate that an accredited laboratory or the maker issued for a device. A second person approves it. A device set to require a certificate has its readings refused while no approved, in-date certificate covers them." />
    <div class="alert warn">This register records certificates; it does not certify anything. Calibration certificates come from an accredited laboratory.</div>
    <Table head={["Device", "Certificate", "Valid", "Status", ""]} empty="No certificates recorded.">
      {d.certs.map((x: any) => <tr><td>{x.label}<div class="small mute">{x.serial}</div></td><td>{x.kind.replace("_", " ")} {x.certificate_no}<div class="small mute">{x.issuer}{x.accreditation_ref ? ` (${x.accreditation_ref})` : ""}; kept: {x.evidence_ref}</div></td>
        <td class="small">{formatDate(x.issued_on)} – {formatDate(x.valid_until)}</td>
        <td><Badge s={x.status === "approved" ? "good" : x.status === "pending" ? "warn" : "bad"} label={x.status} />{x.revoked_reason ? <div class="small mute">{x.revoked_reason}</div> : null}</td>
        <td>{x.status === "pending" ? <form method="post" action={`${U}/${x.id}/approve`}><Csrf t={csrf} /><button class="btn ghost sm">Approve</button></form> : null}
          {x.status !== "revoked" ? <form method="post" action={`${U}/${x.id}/revoke`} class="inline-form"><Csrf t={csrf} /><input name="reason" placeholder="Reason" required /><button class="btn ghost sm">Revoke</button></form> : null}</td></tr>)}</Table>
    <Table head={["Device", "Readings need a certificate", ""]} empty="No active devices.">
      {d.devices.map((v: any) => <tr><td>{v.label}<div class="small mute">{v.serial}</div></td><td>{v.require_certificate ? "yes" : "no"}</td>
        <td><form method="post" action={`${U}/devices/${v.id}/require`}><Csrf t={csrf} /><input type="hidden" name="on" value={v.require_certificate ? "0" : "1"} /><button class="btn ghost sm">{v.require_certificate ? "Stop requiring" : "Require"}</button></form></td></tr>)}</Table>
    {d.devices.length ? <form class="card" method="post" action={U}><Csrf t={csrf} /><h2>Record a certificate</h2>
      <div class="field"><label for="device_id">Device</label><select id="device_id" name="device_id">{d.devices.map((v: any) => <option value={v.id}>{v.label} ({v.serial})</option>)}</select></div>
      <div class="field"><label for="kind">Kind</label><select id="kind" name="kind"><option value="calibration">Calibration</option><option value="qualification">Qualification</option><option value="type_approval">Type approval</option></select></div>
      {field("certificate_no", "Certificate number", { required: true })}{field("issuer", "Issued by", { required: true })}{field("accreditation_ref", "Laboratory accreditation reference")}
      {field("issued_on", "Issued on", { type: "date", required: true })}{field("valid_until", "Valid until", { type: "date", required: true })}{field("evidence_ref", "Where the certificate document is kept", { required: true })}
      <button class="btn">Record</button></form> : null}
  </>);
});
deviceCerts.post(U, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => recordCertificate(cn, ctx, str(b.device_id), b)); return { to: U, ok: "Recorded. A second person must approve it." }; }); });
deviceCerts.post(`${U}/:id/approve`, async (c) => { await formBody(c); const id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => approveCertificate(cn, ctx, id)); return { to: U, ok: "Approved." }; }); });
deviceCerts.post(`${U}/:id/revoke`, async (c) => { const b = await formBody(c), id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => revokeCertificate(cn, ctx, id, str(b.reason))); return { to: U, ok: "Revoked." }; }); });
deviceCerts.post(`${U}/devices/:id/require`, async (c) => { const b = await formBody(c), id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => setRequireCertificate(cn, ctx, id, str(b.on) === "1")); return { to: U, ok: "Saved." }; }); });
