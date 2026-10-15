import { Hono } from "hono";
import { bookAndDispatch, carrierLabel, clearUnknownBooking, createCarrierAccount, listCarrierAccounts, packedOrders, retireCarrierAccount } from "../ops/carrier-booking.js";
import { act, appPage, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

export const carrierBooking = new Hono<Env>();
const U = "/app/fulfilment/carrier-labels";
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;

carrierBooking.get(U, async (c) => {
  need(c, "wh.floor");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ accounts: await listCarrierAccounts(cn), orders: await packedOrders(cn) }));
  const canManage = (await withT(c, async (_cn, x) => x)).perms.has("settings.manage");
  const active = d.accounts.filter((a: any) => a.status === "active");
  return appPage(c, "Carrier labels", <>
    <PageHead title="Carrier labels" sub="Book a DHL Express domestic parcel for a packed order, keep the label and tracking number, and dispatch the order in one step." />
    <div class="alert warn">This connection has not been exercised against DHL's live service. Test it with a DHL sandbox account first. Only domestic parcels are supported; international shipments need customs data this page does not collect.</div>
    <Table head={["Packed order", "Recipient", "City", "Booking", ""]} empty="No packed orders.">
      {d.orders.map((o: any) => <tr><td>{o.no}<div class="small mute">{o.external_ref}</div></td><td>{o.party_name}</td><td>{o.ship_to_city}</td>
        <td>{o.booking === "booked" ? <><Badge s="good" label="booked" /> <span class="small">{o.tracking_no}</span></> : o.booking === "requested" ? <Badge s="warn" label="outcome unknown" /> : "—"}</td>
        <td>{o.booking === "booked" ? <a class="btn ghost sm" href={`${U}/${o.id}/label`}>Label</a> : o.booking === "requested" ? (
            <form method="post" action={`${U}/${o.id}/clear`} class="inline-form"><Csrf t={csrf} /><input name="note" placeholder="What you checked with DHL" required /><button class="btn ghost sm">Clear</button></form>
          ) : active.length ? (
            <form method="post" action={`${U}/${o.id}/book`} class="inline-form"><Csrf t={csrf} />
              <select name="account_id">{active.map((a: any) => <option value={a.id}>{a.label} ({a.environment})</option>)}</select>
              <input name="weight_kg" type="number" step="0.01" min="0.01" max="70" placeholder="kg" required style="width:5rem" />
              <button class="btn sm">Book and dispatch</button></form>
          ) : <span class="small mute">Add an account first</span>}</td></tr>)}</Table>
    {canManage ? <>
      <Table head={["Account", "Environment", "Shipper", "Status", ""]} empty="No carrier accounts.">
        {d.accounts.map((a: any) => <tr><td>{a.label}</td><td>{a.environment}</td><td>{a.company}, {a.city}</td><td>{a.status}</td>
          <td>{a.status === "active" ? <form method="post" action={`${U}/accounts/${a.id}/retire`}><Csrf t={csrf} /><button class="btn ghost sm">Retire</button></form> : null}</td></tr>)}</Table>
      <form class="card" method="post" action={`${U}/accounts`}><Csrf t={csrf} /><h2>Add a DHL Express account</h2>
        <input type="hidden" name="carrier" value="dhl_express" />
        {field("label", "Name", { required: true })}
        <div class="field"><label for="environment">Environment</label><select id="environment" name="environment"><option value="test">Test (sandbox)</option><option value="live">Live</option></select></div>
        {field("account_number", "DHL account number (9 or 10 digits)", { required: true })}{field("username", "DHL API username", { required: true, autocomplete: "off" })}{field("password", "DHL API password", { type: "password", required: true, autocomplete: "off" })}
        {field("product_domestic", "Domestic product code", { value: "N", maxlength: 1 })}
        {field("company", "Pickup company", { required: true })}{field("contact", "Contact name", { required: true })}{field("phone", "Phone", { required: true })}{field("email", "Email")}
        {field("address1", "Pickup address", { required: true })}{field("address2", "Address line 2")}{field("city", "City", { required: true })}{field("country", "Country (2 letters)", { value: "AE" })}{field("postal", "Postal code")}
        <button class="btn">Save account</button></form></> : null}
  </>);
});
carrierBooking.post(`${U}/accounts`, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => createCarrierAccount(cn, ctx, b)); return { to: U, ok: "Account saved. The password is stored encrypted." }; }); });
carrierBooking.post(`${U}/accounts/:id/retire`, async (c) => { await formBody(c); const id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => retireCarrierAccount(cn, ctx, id)); return { to: U, ok: "Retired." }; }); });
carrierBooking.post(`${U}/:id/book`, async (c) => {
  const b = await formBody(c), id = c.req.param("id");
  need(c, "wh.floor");
  return act(c, U, async () => {
    const ctx = await withT(c, async (_cn, x) => x);
    const r = await bookAndDispatch(c.get("db"), ctx, id, { account_id: str(b.account_id), weight_kg: b.weight_kg });
    return { to: U, ok: r.message };
  });
});
carrierBooking.post(`${U}/:id/clear`, async (c) => { const b = await formBody(c), id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => clearUnknownBooking(cn, ctx, id, str(b.note))); return { to: U, ok: "Cleared. You can book again." }; }); });
carrierBooking.get(`${U}/:id/label`, async (c) => {
  need(c, "wh.floor");
  const l = await withT(c, (cn) => carrierLabel(cn, c.req.param("id")));
  c.header("Content-Type", "application/pdf"); c.header("Content-Disposition", `attachment; filename="${l.tracking.replace(/[^A-Za-z0-9_-]/g, "")}.pdf"`); c.header("Cache-Control", "private, no-store");
  return c.body(l.data as any);
});
