import { Hono } from "hono";
import { formatDate } from "../lib/util.js";
import { addAwbStock, airJobs, getMessage, issueFwb, listMessages, listStock, markHandedOver, voidMessage } from "../ops/eawb.js";
import { act, appPage, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

export const eawb = new Hono<Env>();
const U = "/app/freight/air-waybills";
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;
eawb.get(U, async (c) => {
  need(c, "doc.write");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ msgs: await listMessages(cn), stock: await listStock(cn), jobs: await airJobs(cn) }));
  return appPage(c, "Air waybills", <>
    <PageHead title="Air waybills" sub="Number stock from your airline allocation, and an electronic air waybill (FWB) message built from an air job." />
    <div class="alert warn">This builds and keeps the message; it does not send it. Sending needs the airline's or handler's own agreement and channel. The format has not been checked against any airline's validator: have the receiving party check the first message. Hand the file over yourself and record that you did.</div>
    <Table head={["Air waybill", "Job", "Status", "Created", ""]} empty="No messages yet.">
      {d.msgs.map((m: any) => <tr><td>{m.awb_no}</td><td>{m.job_no}</td><td><Badge s={m.status === "handed_over" ? "good" : m.status === "void" ? "closed" : "warn"} label={m.status.replace("_", " ")} />{m.handed_over_note ? <div class="small mute">{m.handed_over_note}</div> : null}{m.void_reason ? <div class="small mute">{m.void_reason}</div> : null}</td><td class="small">{formatDate(m.created_at)}</td>
        <td>{m.status !== "void" ? <a class="btn ghost sm" href={`${U}/${m.id}/file`}>Download</a> : null}
          {m.status === "issued" ? <form method="post" action={`${U}/${m.id}/handed`} class="inline-form"><Csrf t={csrf} /><input name="note" placeholder="Handed to whom, how" required /><button class="btn ghost sm">Handed over</button></form> : null}
          {m.status !== "void" ? <form method="post" action={`${U}/${m.id}/void`} class="inline-form"><Csrf t={csrf} /><input name="reason" placeholder="Reason" required /><button class="btn ghost sm">Void</button></form> : null}</td></tr>)}</Table>
    <Table head={["Airline", "Prefix", "Range", "Left"]} empty="No number stock.">{d.stock.map((s: any) => <tr><td>{s.airline}</td><td>{s.prefix}</td><td>{s.first_serial}–{s.last_serial}</td><td>{s.remaining}</td></tr>)}</Table>
    <form class="card" method="post" action={`${U}/stock`}><Csrf t={csrf} /><h2>Add number stock</h2>{field("airline", "Airline", { required: true })}{field("prefix", "3-digit prefix", { required: true, pattern: "[0-9]{3}" })}{field("first_serial", "First serial", { type: "number", required: true })}{field("last_serial", "Last serial", { type: "number", required: true })}<button class="btn">Add</button></form>
    {d.jobs.length ? <form class="card" method="post" action={U}><Csrf t={csrf} /><h2>Build a message</h2>
      <div class="field"><label for="job_id">Air job</label><select id="job_id" name="job_id">{d.jobs.map((j: any) => <option value={j.id}>{j.no} {j.origin} → {j.destination}</option>)}</select></div>
      <div class="field"><label for="stock_id">Number from stock (or type one below)</label><select id="stock_id" name="stock_id"><option value="">Type a number</option>{d.stock.filter((s: any) => s.remaining > 0).map((s: any) => <option value={s.id}>{s.airline} ({s.remaining} left)</option>)}</select></div>
      {field("awb", "Air waybill number (if not from stock)")}{field("origin", "Origin airport (3 letters)", { required: true })}{field("destination", "Destination airport (3 letters)", { required: true })}
      {field("pieces", "Pieces", { type: "number", required: true })}{field("weight_kg", "Gross weight kg", { type: "number", step: "0.1", required: true })}{field("volume_cbm", "Volume m³", { type: "number", step: "0.01" })}
      {field("flight_carrier", "Flight carrier code (2 letters)")}{field("flight_number", "Flight number")}{field("flight_day", "Day of month")}
      {["shipper", "consignee"].map((k) => <fieldset><legend>{k}</legend>{field(`${k}_name`, "Name", { required: true })}{field(`${k}_street`, "Street", { required: true })}{field(`${k}_place`, "City", { required: true })}{field(`${k}_country`, "Country (2 letters)", { required: true })}{field(`${k}_postcode`, "Postcode")}</fieldset>)}
      {field("currency", "Currency", { value: "AED" })}
      <div class="field"><label for="charges">Charges</label><select id="charges" name="charges"><option value="prepaid">Prepaid</option><option value="collect">Collect</option></select></div>
      {field("goods", "Nature of goods", { value: "GENERAL CARGO" })}{field("rate_amount", "Rate per kg")}{field("chargeable_kg", "Chargeable weight kg")}
      <button class="btn">Build and keep</button></form> : null}
  </>);
});
eawb.post(U, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => issueFwb(cn, ctx, str(b.job_id), b)); return { to: U, ok: "Message built and kept." }; }); });
eawb.post(`${U}/stock`, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => addAwbStock(cn, ctx, b)); return { to: U, ok: "Stock added." }; }); });
eawb.post(`${U}/:id/handed`, async (c) => { const b = await formBody(c), id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => markHandedOver(cn, ctx, id, str(b.note))); return { to: U, ok: "Recorded." }; }); });
eawb.post(`${U}/:id/void`, async (c) => { const b = await formBody(c), id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => voidMessage(cn, ctx, id, str(b.reason))); return { to: U, ok: "Voided." }; }); });
eawb.get(`${U}/:id/file`, async (c) => {
  need(c, "doc.write");
  const m = await withT(c, (cn) => getMessage(cn, c.req.param("id")));
  c.header("Content-Type", "text/plain; charset=us-ascii"); c.header("Content-Disposition", `attachment; filename="FWB-${m.awb_no.replace("-", "")}.txt"`); c.header("Cache-Control", "private, no-store");
  return c.body(m.body);
});
