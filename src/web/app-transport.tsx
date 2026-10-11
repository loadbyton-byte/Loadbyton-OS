import { Hono } from "hono";
import {randomUUID} from "node:crypto";
import {linkExpenseReceipt,uploadExpenseReceipt} from "../ops/expense-receipts.js";
import { HttpError, fmtMoney, formatDate, formatDay, baseUrl } from "../lib/util.js";
import { TAX_CODES } from "../lib/util.js";
import {
  addCompliance, addMaintenance, addOrderCharge, billDetention, cancelOrder, cancelTrip, completeTrip, createDriver, createOrder, createTrip,
  createVehicle, decideExpense, dispatchTrip, getOrder, getTrip, invoiceOrder, listCompliance, listDrivers, listMaintenance, listOrders,
  listTrips, listVehicles, setSubcontractActual, transportOverview,
} from "../ops/transport.js";
import { listParties } from "../ops/crm.js";
import { invite } from "../ops/team.js";
import { arr, formBody, str, type Env } from "./mw.js";
import { act, appPage, can, Confirm, need, PageHead, PostBtn, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table } from "./ui.js";

export const transport = new Hono<Env>();
const T = "/app/transport";
const dt = (v: any) => (v ? formatDate(v) : "—");
const bps = (b: number) => `${(b / 100).toFixed(1)}%`;

// ───────── planning board
transport.get(T, async (c) => {
  const d = await withT(c, (cn) => transportOverview(cn));
  return appPage(c, "Transport planning", (<>
    <PageHead title="Transport planning" sub="What needs a trip, what is moving, and what blocks assignment.">
      <a class="btn red sm" href={`${T}/orders/new`}>New order</a><a class="btn sm" href={`${T}/trips/new`}>Plan a trip</a>
    </PageHead>
    <div class="grid g4">
      <div class="card"><h3>Unplanned orders</h3><div class="kpi">{d.unplanned.length}</div></div>
      <div class="card"><h3>Trips moving</h3><div class="kpi">{d.active.length}</div></div>
      <div class="card"><h3>Late deliveries</h3><div class={`kpi ${d.lateDeliveries ? "bad" : "good"}`}>{d.lateDeliveries}</div></div>
      <div class="card"><h3>Expenses to approve</h3><div class="kpi">{d.pendingExpenses}</div></div>
    </div>
    {d.conflicts ? <div class="alert warn" style="margin-top:16px"><strong>{d.conflicts} driver event(s)</strong> were stored but not applied in the last 7 days (duplicates of a recorded stop, out-of-order, or clock problems). Review them on the trip pages.</div> : null}
    <div class="grid g2" style="margin-top:20px">
      <section><Table caption="Orders waiting for a trip" head={["Order", "Customer", "Route", "Deliver by"]} empty={d.unplanned.length ? undefined : "Nothing waiting."}>
        {d.unplanned.map((o: any) => <tr><td><a href={`${T}/orders/${o.id}`}>{o.no}</a></td><td>{o.party}</td><td class="small">{o.pickup_address} → {o.delivery_address}</td><td>{dt(o.deliver_by)}</td></tr>)}</Table></section>
      <section><Table caption="Moving now" head={["Trip", "Who", "Progress"]} empty={d.active.length ? undefined : "No trips in progress."}>
        {d.active.map((t: any) => <tr><td><a href={`${T}/trips/${t.id}`}>{t.no}</a></td><td>{t.subcontractor_name ?? `${t.reg_no} · ${t.driver_name}`}</td><td>{t.legs_done}/{t.legs} stops <Badge s={t.status} /></td></tr>)}</Table></section>
      <section><Table caption="Compliance expiring within 30 days (or expired)" head={["Subject", "Item", "Expires", ""]} empty={d.expiring.length ? undefined : "Nothing expiring."}>
        {d.expiring.map((x: any) => <tr><td>{x.subject_name}</td><td>{x.kind}</td><td>{formatDay(x.expires_on)}</td><td>{Number(x.days_left) < 0 ? <Badge s="bad" label={x.blocking ? "expired · blocks assignment" : "expired"} /> : <Badge s="warn" label={`${x.days_left} days`} />}</td></tr>)}</Table></section>
      <section><Table caption="Delivered but not yet invoiced" head={["Order", "Customer"]} empty={d.unbilled.length ? undefined : "All delivered orders are invoiced."}>
        {d.unbilled.map((o: any) => <tr><td><a href={`${T}/orders/${o.id}`}>{o.no}</a></td><td>{o.party}</td></tr>)}</Table></section>
    </div>
  </>));
});

// ───────── orders
transport.get(`${T}/orders`, async (c) => {
  const rows = await withT(c, (cn) => listOrders(cn));
  return appPage(c, "Transport orders", (<>
    <PageHead title="Transport orders" sub="One customer order = one pickup and one delivery. Orders become stops on a trip."><a class="btn red sm" href={`${T}/orders/new`}>New order</a></PageHead>
    <Table head={["Order", "Customer", "Route", ["Weight", "num"], ["Charge", "num"], "Trip", "Status", "Money"]} empty={rows.length ? undefined : "No orders yet."}>
      {rows.map((o: any) => <tr><td><a href={`${T}/orders/${o.id}`}>{o.no}</a></td><td>{o.party_name}</td><td class="small">{o.pickup_address} → {o.delivery_address}</td><td class="num">{Number(o.weight_kg)} kg</td><td class="num"><Money v={o.sell_minor} /></td>
        <td>{o.trip_no ?? "—"}</td><td><Badge s={o.status} /></td><td><Badge s={o.financial_status} /></td></tr>)}
    </Table>
  </>));
});
transport.get(`${T}/orders/new`, async (c) => {
  need(c, "transport.write");
  const customers = await withT(c, (cn) => listParties(cn, "customer"));
  const csrf = c.get("csrf");
  return appPage(c, "New transport order", (<>
    <PageHead title="New transport order" />
    <form method="post" action={`${T}/orders`} class="card" style="max-width:860px"><Csrf t={csrf} />
      <div class="row"><div class="field"><label for="pa">Customer</label><select id="pa" name="party_id" required><option value="">— select —</option>{customers.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <div class="field"><label for="rt">Agreed charge (AED, ex-VAT)</label><input id="rt" name="rate" type="number" min="0.01" step="0.01" required /></div>
        <div class="field"><label for="tc">Tax code</label><select id="tc" name="tax_code">{Object.entries(TAX_CODES).map(([k, v]) => <option value={k}>{k} · {v.label}</option>)}</select></div></div>
      <div class="row"><div class="field"><label for="pu">Pickup address</label><input id="pu" name="pickup_address" type="text" required /></div><div class="field"><label for="de">Delivery address</label><input id="de" name="delivery_address" type="text" required /></div></div>
      <div class="field"><label for="cd">Cargo</label><input id="cd" name="cargo_desc" type="text" /></div>
      <div class="row"><div class="field"><label for="wk">Weight (kg)</label><input id="wk" name="weight_kg" type="number" min="0" step="0.1" /></div><div class="field"><label for="vc">Volume (cbm)</label><input id="vc" name="volume_cbm" type="number" min="0" step="0.01" /></div>
        <div class="field"><label for="ra">Ready from</label><input id="ra" name="ready_at" type="datetime-local" /></div><div class="field"><label for="db">Deliver by</label><input id="db" name="deliver_by" type="datetime-local" /></div>
        <div class="field"><label for="dr">Detention rate (AED / hour beyond 2 h free)</label><input id="dr" name="detention_rate" type="number" min="0" step="0.01" /></div></div>
      <button class="btn red" type="submit">Save order</button><p class="hint">Times are Gulf Standard Time (UTC+4).</p>
    </form>
  </>));
});
transport.post(`${T}/orders`, async (c) => {
  need(c, "transport.write");
  const b = await formBody(c);
  return act(c, `${T}/orders/new`, async () => { const r = await withT(c, (cn, ctx) => createOrder(cn, ctx, b)); return { to: `${T}/orders/${r.id}`, ok: `Order ${r.no} saved.` }; });
});
transport.get(`${T}/orders/:id`, async (c) => {
  const id = c.req.param("id");
  const d = await withT(c, (cn) => getOrder(cn, id));
  const o = d.order, csrf = c.get("csrf");
  const uninv = d.charges.filter((x: any) => !x.invoice_id);
  return appPage(c, o.no, (<>
    <PageHead title={`${o.no} · ${o.party_name}`} sub={`${o.pickup_address} → ${o.delivery_address}`}>
      <Badge s={o.status} /><Badge s={o.financial_status} />
      {o.trip_no && o.trip_id ? <a class="btn sm" href={`${T}/trips/${o.trip_id}`}>Trip {o.trip_no}</a> : null}
      {o.status === "new" && can(c, "transport.write") ? <Confirm action={`${T}/orders/${id}/cancel`} csrf={csrf} label="Cancel order" confirm="Cancel this order?" /> : null}
      {o.status === "delivered" && uninv.length && can(c, "finance.write") ? <PostBtn action={`${T}/orders/${id}/invoice`} csrf={csrf} label="Invoice order" cls="red sm" /> : null}
    </PageHead>
    <div class="card"><p style="margin:0">{o.cargo_desc ?? "—"} · {Number(o.weight_kg)} kg · {Number(o.volume_cbm)} cbm · ready {dt(o.ready_at)} · deliver by {dt(o.deliver_by)}{Number(o.detention_rate_minor) ? ` · detention ${fmtMoney(o.detention_rate_minor)}/h` : ""}</p></div>
    <h3 style="margin-top:20px">Charges</h3>
    <Table head={["Description", ["Qty", "num"], ["Unit", "num"], "Tax", "Invoiced"]}>
      {d.charges.map((x: any) => <tr><td>{x.description}</td><td class="num">{Number(x.qty)}</td><td class="num"><Money v={x.unit_minor} /></td><td>{x.tax_code}</td><td>{x.invoice_id ? <Badge s="invoiced" /> : <Badge s="open" label="not yet" />}</td></tr>)}</Table>
    {can(c, "transport.write") ? <form method="post" action={`${T}/orders/${id}/charge`} class="inline-form" style="margin-top:10px"><Csrf t={csrf} /><input name="description" type="text" placeholder="Extra charge (e.g. offloading)" required /><input name="qty" type="number" step="0.001" min="0.001" value="1" style="max-width:90px" /><input name="amount" type="number" step="0.01" min="0.01" placeholder="Unit AED" required /><select name="tax_code">{Object.keys(TAX_CODES).map((k) => <option>{k}</option>)}</select><button class="btn ghost sm" type="submit">Add charge</button></form> : null}
    <h3 style="margin-top:20px">Stops</h3>
    <Table head={["#", "Kind", "Address", "Arrived", "Left", "Proof of delivery", "Detention"]} empty={d.legs.length ? undefined : "Not on a trip yet."}>
      {d.legs.map((l: any) => <tr><td>{l.seq}</td><td>{l.kind}</td><td class="small">{l.address}</td><td>{dt(l.arrived_at)}</td><td>{dt(l.departed_at)}</td><td>{l.pod_name ? `${l.pod_name} · ${formatDate(l.pod_at)}` : "—"}</td>
        <td>{l.detention_minutes ? <>{l.detention_minutes} min {can(c, "transport.write") ? <PostBtn action={`${T}/legs/${l.id}/detention`} csrf={csrf} label="Bill" cls="ghost sm" fields={{ order: id }} /> : null}</> : "—"}</td></tr>)}</Table>
    {d.invoices.length ? <><h3 style="margin-top:20px">Invoices</h3><Table head={["Invoice", "Due", ["Total", "num"], "Status"]}>{d.invoices.map((i: any) => <tr><td><a href={`/app/invoices/${i.id}`}>{i.no}</a></td><td>{formatDay(i.due_at)}</td><td class="num"><Money v={i.total_minor} /></td><td><Badge s={i.status} /></td></tr>)}</Table></> : null}
  </>));
});
transport.post(`${T}/orders/:id/cancel`, async (c) => { const id = c.req.param("id"); return act(c, `${T}/orders/${id}`, async () => { await withT(c, (cn, ctx) => cancelOrder(cn, ctx, id)); return { to: `${T}/orders`, ok: "Order cancelled." }; }); });
transport.post(`${T}/orders/:id/charge`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, `${T}/orders/${id}`, async () => { await withT(c, (cn, ctx) => addOrderCharge(cn, ctx, id, b)); return { to: `${T}/orders/${id}`, ok: "Charge added." }; }); });
transport.post(`${T}/orders/:id/invoice`, async (c) => { const id = c.req.param("id"); return act(c, `${T}/orders/${id}`, async () => { const r = await withT(c, (cn, ctx) => invoiceOrder(cn, ctx, id)); return { to: `/app/invoices/${r.id}`, ok: `Invoice ${r.no} issued.` }; }); });
transport.post(`${T}/legs/:id/detention`, async (c) => { const b = await formBody(c), o = str(b.order); return act(c, `${T}/orders/${o}`, async () => { const h = await withT(c, (cn, ctx) => billDetention(cn, ctx, c.req.param("id"))); return { to: `${T}/orders/${o}`, ok: `Detention billed: ${h} hour(s).` }; }); });

// ───────── trips
transport.get(`${T}/trips`, async (c) => {
  const rows = await withT(c, (cn) => listTrips(cn));
  return appPage(c, "Trips", (<>
    <PageHead title="Trips" sub="Each trip is one billable unit against your monthly trip allowance."><a class="btn red sm" href={`${T}/trips/new`}>Plan a trip</a></PageHead>
    <Table head={["Trip", "Vehicle / subcontractor", "Driver", "Planned", "Stops", "Status"]} empty={rows.length ? undefined : "No trips yet."}>
      {rows.map((t: any) => <tr><td><a href={`${T}/trips/${t.id}`}>{t.no}</a></td><td>{t.subcontractor_name ? <>{t.subcontractor_name} <Badge s="info" label="subcontract" /></> : t.reg_no}</td><td>{t.driver_name ?? "—"}</td><td class="small">{dt(t.planned_start)}</td><td>{t.legs_done}/{t.legs}</td><td><Badge s={t.status} /></td></tr>)}
    </Table>
  </>));
});
transport.get(`${T}/trips/new`, async (c) => {
  need(c, "transport.write");
  const d = await withT(c, async (cn) => ({ orders: (await listOrders(cn)).filter((o: any) => o.status === "new"), vehicles: (await listVehicles(cn)).filter((v: any) => v.status === "active"), drivers: await listDrivers(cn), suppliers: await listParties(cn, "supplier") }));
  const csrf = c.get("csrf"), pre = new URL(c.req.url).searchParams.getAll("order");
  return appPage(c, "Plan a trip", (<>
    <PageHead title="Plan a trip" sub="Capacity, availability, maintenance blocks and compliance expiry are checked together." />
    <form method="post" action={`${T}/trips`} style="max-width:960px"><Csrf t={csrf} />
      <fieldset><legend>Orders to carry</legend>
        {d.orders.length ? <div class="checks">{d.orders.map((o: any) => <label class="check"><input type="checkbox" name="order_id" value={o.id} checked={pre.includes(o.id)} /><span><strong>{o.no}</strong> · {o.party_name}<br /><span class="small mute">{o.pickup_address} → {o.delivery_address}<br />{Number(o.weight_kg)} kg · {Number(o.volume_cbm)} cbm</span></span></label>)}</div> : <p class="mute">No unplanned orders. <a href={`${T}/orders/new`}>Create one</a>.</p>}</fieldset>
      <div class="row"><div class="field"><label for="ps">Planned start</label><input id="ps" name="planned_start" type="datetime-local" required /></div><div class="field"><label for="pe">Planned end</label><input id="pe" name="planned_end" type="datetime-local" required /></div><div class="field"><label for="ek">Estimated km</label><input id="ek" name="est_km" type="number" min="0" step="0.1" /></div></div>
      <fieldset><legend>Own fleet</legend><div class="row">
        <div class="field"><label for="ve">Vehicle</label><select id="ve" name="vehicle_id"><option value="">—</option>{d.vehicles.map((v: any) => <option value={v.id}>{v.reg_no} · {Number(v.capacity_kg)} kg{v.expired ? " · COMPLIANCE EXPIRED" : ""}</option>)}</select></div>
        <div class="field"><label for="dr">Driver</label><select id="dr" name="driver_id"><option value="">—</option>{d.drivers.map((x: any) => <option value={x.id}>{x.name}{x.expired ? " · COMPLIANCE EXPIRED" : ""}{x.login_email ? "" : " · no login"}</option>)}</select></div></div></fieldset>
      <fieldset><legend>…or a subcontractor</legend><div class="row">
        <div class="field"><label for="su">Supplier</label><select id="su" name="subcontractor_id"><option value="">—</option>{d.suppliers.map((s: any) => <option value={s.id}>{s.name}</option>)}</select></div>
        <div class="field"><label for="se">Agreed cost estimate (AED)</label><input id="se" name="subcontract_estimate" type="number" min="0" step="0.01" /></div></div></fieldset>
      <div class="field"><label for="nt">Notes</label><input id="nt" name="notes" type="text" /></div>
      <button class="btn red" type="submit">Create trip</button><p class="hint">Times are Gulf Standard Time (UTC+4). Route optimisation and live GPS are not part of this release.</p>
    </form>
  </>));
});
transport.post(`${T}/trips`, async (c) => {
  need(c, "transport.write");
  const b = await formBody(c);
  return act(c, `${T}/trips/new`, async () => {
    const r = await withT(c, (cn, ctx) => createTrip(cn, ctx, {
      vehicle_id: str(b.vehicle_id) || undefined, driver_id: str(b.driver_id) || undefined, subcontractor_id: str(b.subcontractor_id) || undefined,
      subcontract_estimate: str(b.subcontract_estimate), planned_start: str(b.planned_start), planned_end: str(b.planned_end), est_km: str(b.est_km), notes: str(b.notes), order_ids: arr(b.order_id),
    }));
    return { to: `${T}/trips/${r.id}`, ok: `Trip ${r.no} created.` };
  });
});
transport.get(`${T}/trips/:id`, async (c) => {
  const id = c.req.param("id");
  const d = await withT(c, (cn) => getTrip(cn, id));
  const t = d.trip, p = d.profit, csrf = c.get("csrf");
  const docs = await withT(c, async (cn) => (await cn.query<any>(`SELECT * FROM documents WHERE trip_id=$1 ORDER BY created_at DESC`, [id])).rows);
  const canWrite = can(c, "transport.write");
  const stageIdx = d.legs.findIndex((l: any) => l.status !== "done");
  return appPage(c, t.no, (<>
    <PageHead title={`${t.no} · ${t.subcontractor_name ?? `${t.reg_no} / ${t.driver_name}`}`} sub={`Planned ${dt(t.planned_start)} → ${dt(t.planned_end)} · load ${d.loadKg} kg${t.reg_no ? ` of ${Number(t.capacity_kg)} kg` : ""}${t.est_km ? ` · est. ${Number(t.est_km)} km` : ""}`}>
      <Badge s={t.status} />
      {t.status === "planned" && canWrite ? <PostBtn action={`${T}/trips/${id}/dispatch`} csrf={csrf} label="Dispatch" cls="red sm" /> : null}
      {["planned", "dispatched"].includes(t.status) && canWrite ? <Confirm action={`${T}/trips/${id}/cancel`} csrf={csrf} label="Cancel trip" confirm="Cancel this trip and release its orders?" /> : null}
    </PageHead>
    <ol class="stages">{d.legs.map((l: any, i: number) => <li class={l.status === "done" ? "done" : i === stageIdx ? "now" : ""}>{l.seq}. {l.kind} · {l.order_no}</li>)}</ol>
    <div class="grid g4">
      <div class="card"><h3>Revenue</h3><div class="kpi"><Money v={p.revenue} /></div><p class="small mute">{d.orders.length} order(s)</p></div>
      <div class="card"><h3>Cost</h3><div class="kpi"><Money v={p.cost} /></div><p class="small mute">{p.subcontract ? <>Subcontract <Money v={p.subcontract} />{p.subcontractEstimated ? " (estimate)" : ""} · </> : null}approved exp. <Money v={p.approvedExpenses} />{p.unapprovedExpenses ? <> · <Badge s="warn" label="unapproved" /> <Money v={p.unapprovedExpenses} /></> : null}</p></div>
      <div class={`card ${p.margin < 0 ? "flag" : ""}`}><h3>Trip margin</h3><div class={`kpi ${p.margin < 0 ? "bad" : ""}`}>{bps(p.marginBps)}</div><p class="small mute"><Money v={p.margin} /> · {p.reconciled ? "reconciled" : "not final: estimates included"}</p></div>
      <div class="card"><h3>Cost per km</h3><div class="kpi">{p.costPerKm ? <Money v={p.costPerKm} /> : "—"}</div><p class="small mute">{t.actual_km ? `${Number(t.actual_km)} km actual` : "set actual km on completion"}</p></div>
    </div>
    <h3 style="margin-top:24px">Stops</h3>
    <Table head={["#", "Stop", "Order", "Arrived", "Left", "Proof of delivery", "Detention"]}>
      {d.legs.map((l: any) => <tr><td>{l.seq}</td><td><strong>{l.kind}</strong><div class="small mute">{l.address}</div></td><td>{l.order_no}<div class="small mute">{l.customer}</div></td><td>{dt(l.arrived_at)}</td><td>{dt(l.departed_at)}</td>
        <td>{l.kind === "delivery" ? (l.pod_name ? <>{l.pod_name}<div class="small mute">{formatDate(l.pod_at)}{l.pod_lat ? ` · ${l.pod_lat}, ${l.pod_lng}` : ""}</div></> : <Badge s="open" label="awaiting" />) : "—"}</td>
        <td>{l.detention_minutes ? `${l.detention_minutes} min` : "—"}</td></tr>)}</Table>
    {["dispatched", "in_progress"].includes(t.status) && canWrite ? (
      <form method="post" action={`${T}/trips/${id}/complete`} class="inline-form" style="margin-top:12px"><Csrf t={csrf} /><input name="actual_km" type="number" step="0.1" min="0" placeholder="Actual km" />{t.subcontractor_id ? <input name="subcontract_actual" type="number" step="0.01" min="0" placeholder="Subcontract invoice AED (if known)" /> : null}<button class="btn sm" type="submit">Complete trip</button></form>) : null}
    {t.subcontractor_id && can(c, "transport.expense") && t.subcontract_actual_minor == null ? (
      <form method="post" action={`${T}/trips/${id}/subcontract`} class="inline-form" style="margin-top:12px"><Csrf t={csrf} /><input name="amount" type="number" step="0.01" min="0" placeholder="Reconcile subcontractor invoice (AED)" required /><button class="btn ghost sm" type="submit">Reconcile</button></form>) : null}

    <h3 style="margin-top:24px">Expenses (fuel, tolls)</h3>
    <Table head={["Kind", "Note", ["Amount", "num"], "Recorded by", "Status", "Receipt / review"]} empty={d.expenses.length ? undefined : "No expenses."}>
      {d.expenses.map((x: any) => <tr><td>{x.kind}</td><td class="small">{x.note ?? ""}</td><td class="num"><Money v={x.amount_minor} /></td><td>{x.recorder ?? "—"}</td><td><Badge s={x.status === "recorded" ? "pending" : x.status} label={x.status === "recorded" ? "awaiting approval" : x.status} /></td>
        <td>{x.receipt_document_id?<a href={`/app/documents/${x.receipt_document_id}/download`}>Receipt source</a>:x.evidence_required?'Receipt required before approval':'Legacy expense: evidence review pending'}{x.status==='recorded'&&(can(c,'doc.write')||can(c,'transport.expense'))?<><form method="post" action={`${T}/expenses/${x.id}/receipt`} enctype="multipart/form-data"><Csrf t={csrf}/><input type="hidden" name="reference" value={randomUUID()}/><label>Actual receipt issuer<input name="issuer" required maxlength={200}/></label><input type="file" name="file" aria-label="Actual expense receipt" required/><button class="btn ghost sm">Upload receipt</button></form><form method="post" action={`${T}/expenses/${x.id}/receipt-link`}><Csrf t={csrf}/><input type="hidden" name="reference" value={randomUUID()}/><select name="document_id" aria-label="Issued receipt for this trip" required>{docs.filter(d=>d.status==='issued'&&!d.hold&&['other','supplier_invoice'].includes(d.kind)).map(d=><option value={d.id}>{d.title}</option>)}</select><button class="btn ghost sm">Link issued receipt</button></form></>:null}{x.status === "recorded" && can(c, "transport.expense") ? <><PostBtn action={`${T}/expenses/${x.id}`} csrf={csrf} label="Approve" fields={{ trip: id, decision: "approve" }} /><PostBtn action={`${T}/expenses/${x.id}`} csrf={csrf} label="Reject" cls="ghost sm" fields={{ trip: id, decision: "reject" }} /></> : null}</td></tr>)}</Table>

    <h3 style="margin-top:24px">Driver event log</h3>
    <p class="small mute">Device time is kept as reported. Events stored but not applied are shown with the reason.</p>
    <Table head={["Device time", "Synced", "Kind", "Detail", "Result"]} empty={d.events.length ? undefined : "No driver events yet."}>
      {d.events.map((e: any) => <tr><td class="small nowrap">{formatDate(e.device_time)}</td><td class="small nowrap">{formatDate(e.server_time)}</td><td>{e.kind}{e.leg_kind ? ` (${e.leg_kind})` : ""}</td><td class="small">{Object.entries(e.payload ?? {}).filter(([k]) => !["lat", "lng"].includes(k)).map(([k, v]) => `${k}: ${v}`).join(" · ")}</td>
        <td>{e.applied ? <Badge s="ok" label="applied" /> : <Badge s="warn" label="not applied" />}{e.resolution ? <div class="small mute">{e.resolution}</div> : null}</td></tr>)}</Table>
    <h3 style="margin-top:24px">Trip documents</h3>
    <Table head={["Title", "Kind", ""]} empty={docs.length ? undefined : "No documents."}>{docs.map((x: any) => <tr><td>{x.title}</td><td>{x.kind}</td><td><a href={`/app/documents/${x.id}/download`}>Download</a></td></tr>)}</Table>
  </>));
});
transport.post(`${T}/trips/:id/dispatch`, async (c) => { const id = c.req.param("id"); return act(c, `${T}/trips/${id}`, async () => { await withT(c, (cn, ctx) => dispatchTrip(cn, ctx, id)); return { to: `${T}/trips/${id}`, ok: "Dispatched. The driver can now see it." }; }); });
transport.post(`${T}/trips/:id/cancel`, async (c) => { const id = c.req.param("id"); return act(c, `${T}/trips/${id}`, async () => { await withT(c, (cn, ctx) => cancelTrip(cn, ctx, id)); return { to: `${T}/trips`, ok: "Trip cancelled; orders released." }; }); });
transport.post(`${T}/trips/:id/complete`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, `${T}/trips/${id}`, async () => { await withT(c, (cn, ctx) => completeTrip(cn, ctx, id, { actual_km: str(b.actual_km), subcontract_actual: str(b.subcontract_actual) })); return { to: `${T}/trips/${id}`, ok: "Trip completed." }; }); });
transport.post(`${T}/trips/:id/subcontract`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, `${T}/trips/${id}`, async () => { await withT(c, (cn, ctx) => setSubcontractActual(cn, ctx, id, str(b.amount))); return { to: `${T}/trips/${id}`, ok: "Subcontractor invoice reconciled." }; }); });
transport.post(`${T}/expenses/:id`, async (c) => { const b = await formBody(c), trip = str(b.trip); return act(c, `${T}/trips/${trip}`, async () => { await withT(c, (cn, ctx) => decideExpense(cn, ctx, c.req.param("id"), str(b.decision) === "approve")); return { to: `${T}/trips/${trip}`, ok: "Decision recorded." }; }); });

// ───────── fleet, drivers, compliance, maintenance
transport.get(`${T}/fleet`, async (c) => {
  const d = await withT(c, async (cn) => ({ vehicles: await listVehicles(cn), drivers: await listDrivers(cn), compliance: await listCompliance(cn), maintenance: await listMaintenance(cn) }));
  const csrf = c.get("csrf"), link = c.req.query("link"), w = can(c, "transport.write");
  const subjects = [...d.vehicles.map((v: any) => ({ id: v.id, type: "vehicle", name: v.reg_no })), ...d.drivers.map((x: any) => ({ id: x.id, type: "driver", name: x.name }))];
  return appPage(c, "Fleet & drivers", (<>
    <PageHead title="Fleet & drivers" sub="Expired blocking compliance items prevent assignment; maintenance blocks hold a vehicle out of service." />
    {link ? <div class="alert info"><strong>Driver invitation link (shown once):</strong><br /><code>{baseUrl()}/invite/{link}</code></div> : null}
    <h3>Vehicles</h3>
    <Table head={["Registration", "Type", ["Capacity", "num"], "Compliance", ""]} empty={d.vehicles.length ? undefined : "No vehicles."}>{d.vehicles.map((v: any) => <tr><td>{v.reg_no}</td><td>{v.kind}</td><td class="num">{Number(v.capacity_kg)} kg{v.capacity_cbm ? ` · ${Number(v.capacity_cbm)} cbm` : ""}</td><td>{v.expired ? <Badge s="bad" label="expired" /> : v.next_expiry ? `next ${formatDay(v.next_expiry)}` : "—"}</td><td></td></tr>)}</Table>
    {w ? <form method="post" action={`${T}/fleet/vehicle`} class="inline-form" style="margin:10px 0 22px"><Csrf t={csrf} /><input name="reg_no" type="text" placeholder="Registration" required /><input name="kind" type="text" placeholder="Type (truck, van…)" /><input name="capacity_kg" type="number" min="1" step="0.1" placeholder="Capacity kg" required /><input name="capacity_cbm" type="number" min="0" step="0.01" placeholder="cbm" /><button class="btn ghost sm" type="submit">Add vehicle</button></form> : null}
    <h3>Drivers</h3>
    <Table head={["Name", "Phone", "Licence", "Login", "Compliance"]} empty={d.drivers.length ? undefined : "No drivers."}>{d.drivers.map((x: any) => <tr><td>{x.name}</td><td>{x.phone ?? "—"}</td><td>{x.licence_no ?? "—"}</td>
      <td>{x.login_email ?? (can(c, "team.manage") ? <form method="post" action={`${T}/fleet/driver-login`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="driver_id" value={x.id} /><input name="email" type="email" placeholder="driver@email" required /><button class="btn ghost sm" type="submit">Invite</button></form> : <Badge s="warn" label="no login" />)}</td><td>{x.expired ? <Badge s="bad" label="expired" /> : "ok"}</td></tr>)}</Table>
    {w ? <form method="post" action={`${T}/fleet/driver`} class="inline-form" style="margin:10px 0 22px"><Csrf t={csrf} /><input name="name" type="text" placeholder="Driver name" required /><input name="phone" type="text" placeholder="Phone" /><input name="licence_no" type="text" placeholder="Licence no." /><button class="btn ghost sm" type="submit">Add driver</button></form> : null}
    <h3>Compliance items</h3>
    <Table head={["Subject", "Item", "Expires", "Blocks assignment", ""]} empty={d.compliance.length ? undefined : "None recorded."}>{d.compliance.map((x: any) => <tr><td>{x.subject_name}</td><td>{x.kind}</td><td>{formatDay(x.expires_on)}</td><td>{x.blocking ? "yes" : "no"}</td><td>{Number(x.days_left) < 0 ? <Badge s="bad" label="expired" /> : Number(x.days_left) <= 30 ? <Badge s="warn" label={`${x.days_left} days`} /> : <Badge s="ok" label="valid" />}</td></tr>)}</Table>
    {w && subjects.length ? <form method="post" action={`${T}/fleet/compliance`} class="inline-form" style="margin:10px 0 22px"><Csrf t={csrf} />
      <select name="subject" required>{subjects.map((s) => <option value={`${s.type}:${s.id}`}>{s.type === "vehicle" ? "🚚" : "👤"} {s.name}</option>)}</select><input name="kind" type="text" placeholder="registration / insurance / licence…" required /><input name="expires_on" type="date" required /><select name="blocking"><option value="1">Blocks assignment</option><option value="0">Warning only</option></select><button class="btn ghost sm" type="submit">Add item</button></form> : null}
    <h3>Maintenance blocks</h3>
    <Table head={["Vehicle", "From", "To", "Reason"]} empty={d.maintenance.length ? undefined : "None."}>{d.maintenance.map((m: any) => <tr><td>{m.reg_no}</td><td>{dt(m.starts_at)}</td><td>{dt(m.ends_at)}</td><td>{m.reason}</td></tr>)}</Table>
    {w && d.vehicles.length ? <form method="post" action={`${T}/fleet/maintenance`} class="inline-form" style="margin-top:10px"><Csrf t={csrf} /><select name="vehicle_id">{d.vehicles.map((v: any) => <option value={v.id}>{v.reg_no}</option>)}</select><input name="starts_at" type="datetime-local" required /><input name="ends_at" type="datetime-local" required /><input name="reason" type="text" placeholder="Reason" required /><button class="btn ghost sm" type="submit">Block vehicle</button></form> : null}
  </>));
});
const F = `${T}/fleet`;
transport.post(`${F}/vehicle`, async (c) => { const b = await formBody(c); return act(c, F, async () => { await withT(c, (cn, ctx) => createVehicle(cn, ctx, b)); return { to: F, ok: "Vehicle added." }; }); });
transport.post(`${F}/driver`, async (c) => { const b = await formBody(c); return act(c, F, async () => { await withT(c, (cn, ctx) => createDriver(cn, ctx, b)); return { to: F, ok: "Driver added." }; }); });
transport.post(`${F}/driver-login`, async (c) => { const b = await formBody(c); return act(c, F, async () => { const tok = await withT(c, (cn, ctx) => invite(cn, ctx, { email: str(b.email), roles: ["driver"], driver_id: str(b.driver_id) })); return { to: `${F}?link=${tok}`, ok: "Driver invitation created." }; }); });
transport.post(`${F}/compliance`, async (c) => { const b = await formBody(c); const [type, id] = str(b.subject).split(":"); return act(c, F, async () => { await withT(c, (cn, ctx) => addCompliance(cn, ctx, { subject_type: type, subject_id: id, kind: str(b.kind), expires_on: str(b.expires_on), blocking: str(b.blocking) })); return { to: F, ok: "Compliance item recorded." }; }); });
transport.post(`${F}/maintenance`, async (c) => { const b = await formBody(c); return act(c, F, async () => { await withT(c, (cn, ctx) => addMaintenance(cn, ctx, b)); return { to: F, ok: "Vehicle blocked for maintenance." }; }); });

transport.post(`${T}/expenses/:id/receipt`,async c=>{const b=await formBody(c);return act(c,`${T}/trips`,async()=>{const file=b.file;if(!(file instanceof File))throw new HttpError(400,'Choose the actual receipt.');const data=Buffer.from(await file.arrayBuffer());const trip=await withT(c,async(cn,ctx)=>{await uploadExpenseReceipt(cn,ctx,c.req.param('id'),{filename:file.name,data,issuer:str(b.issuer)},str(b.reference));return (await cn.query<any>(`SELECT trip_id FROM trip_expenses WHERE id=$1`,[c.req.param('id')])).rows[0].trip_id;});return {to:`${T}/trips/${trip}`,ok:'Receipt evidence stored for independent finance review.'};});});
transport.post(`${T}/expenses/:id/receipt-link`,async c=>{const b=await formBody(c);return act(c,`${T}/trips`,async()=>{const trip=await withT(c,async(cn,ctx)=>{await linkExpenseReceipt(cn,ctx,c.req.param('id'),str(b.document_id),str(b.reference));return (await cn.query<any>(`SELECT trip_id FROM trip_expenses WHERE id=$1`,[c.req.param('id')])).rows[0].trip_id;});return {to:`${T}/trips/${trip}`,ok:'Issued receipt linked; independent finance approval remains required.'};});});
