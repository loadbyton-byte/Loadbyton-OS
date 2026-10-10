import crypto from "node:crypto";
import { Hono } from "hono";
import { HttpError, formatDate, formatDay } from "../lib/util.js";
import { TAX_CODES } from "../lib/util.js";
import {
  allocateOrder, allocateWaiting, cancelFulfilOrder, cancelInbound, cancelReturn, closeInbound, closeReturn, closeShort, createInbound, createLocation, createOrder,
  createReturn, createSku, decideAdjustment, fulfilmentOverview, getFulfilOrder, getInbound, getReturn, importOrders, importSkus, listAdjustments, listFulfilOrders,
  listInbound, listLocations, listReturns, listSkus, pickList, pickOrder, packScan, receiveInbound, receiveReturn, requestAdjustment, resetPacking, setLocationActive,
  shipOrder, skuLedger, stockByLocation, stockOverview, transferStock, updateSku,
} from "../ops/fulfilment.js";
import { RATE_CODES, billingSummary, invoiceMerchant, listRates, runStorageCharges, setRate, unbilledForParty } from "../ops/fulfil-billing.js";
import { listParties } from "../ops/crm.js";
import { formBody, str, type Env } from "./mw.js";
import { act, appPage, can, Confirm, need, PageHead, PostBtn, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table } from "./ui.js";

export const fulfil = new Hono<Env>();
const F = "/app/fulfilment";
const dt = (v: any) => (v ? formatDate(v) : "—");
const tok = () => crypto.randomUUID();
const CARRIERS = ["Aramex", "DHL", "FedEx", "SMSA", "Emirates Post", "Fetchr", "Own fleet", "Other"];
const STATUS_LABEL: Record<string, string> = { new: "new", backordered: "waiting for stock", allocated: "ready to pick", picking: "picking", picked: "picked", packed: "packed", shipped: "shipped", cancelled: "cancelled" };
const OSt = ({ s }: { s: string }) => <Badge s={s === "backordered" ? "warn" : s === "shipped" ? "delivered" : s} label={STATUS_LABEL[s] ?? s} />;

const summarise = (r: { created: number; duplicates: string[]; rejected: { line: number; reason: string }[] }, dry: boolean) =>
  [`${dry ? "Would create" : "Created"} ${r.created}`, r.duplicates.length ? `${r.duplicates.length} already known, skipped` : "",
    r.rejected.length ? `${r.rejected.length} row(s) rejected (${r.rejected.slice(0, 3).map((x) => `line ${x.line}: ${x.reason}`).join("; ")})` : ""].filter(Boolean).join(" · ") + ".";

// ───────── board
fulfil.get(F, async (c) => {
  const d = await withT(c, (cn) => fulfilmentOverview(cn));
  const s = d.byStatus, n = (k: string) => s[k] ?? 0;
  return appPage(c, "Fulfilment board", (<>
    <PageHead title="Fulfilment board" sub="What is waiting at each stage — and what is late.">
      {can(c, "wh.write") ? <><a class="btn red sm" href={`${F}/orders/new`}>New order</a><a class="btn sm" href={`${F}/inbound/new`}>Expect a delivery</a></> : null}
    </PageHead>
    <div class="grid g4">
      <div class="card"><h3>Waiting for stock</h3><div class={`kpi ${n("backordered") ? "bad" : "good"}`}>{n("backordered")}</div></div>
      <div class="card"><h3>Ready to pick</h3><div class="kpi">{n("allocated") + n("picking")}</div></div>
      <div class="card"><h3>To pack</h3><div class="kpi">{d.toPack}</div></div>
      <div class="card"><h3>Ready to ship</h3><div class="kpi">{n("packed")}</div></div>
    </div>
    <div class="grid g4" style="margin-top:16px">
      <div class="card"><h3>Late vs ship-by</h3><div class={`kpi ${d.late.length ? "bad" : "good"}`}>{d.late.length}</div></div>
      <div class="card"><h3>Counts to approve</h3><div class="kpi">{d.pendingAdjustments}</div></div>
      <div class="card"><h3>Returns open</h3><div class="kpi">{d.returnsOpen}</div></div>
      <div class="card"><h3>Units in quarantine</h3><div class="kpi">{d.quarantineUnits}</div></div>
    </div>
    {d.openExceptions ? <div class="alert warn" style="margin-top:16px"><strong>{d.openExceptions} short pick(s)</strong> are open: stock was missing at a bin. Count the bin on the <a href={`${F}/stock`}>Stock</a> page and raise an adjustment.</div> : null}
    <div class="grid g2w" style="margin-top:20px">
      <section><Table caption="Late orders" head={["Order", "Merchant", "Ship by", "Status"]} empty={d.late.length ? undefined : "Nothing is late."}>
        {d.late.map((o: any) => <tr><td><a href={`${F}/orders/${o.id}`}>{o.no}</a></td><td>{o.party}</td><td>{dt(o.ship_by)}</td><td><OSt s={o.status} /></td></tr>)}</Table></section>
      <section><Table caption="Waiting for stock (oldest first)" head={["Order", "Merchant", "Ordered"]} empty={d.backordered.length ? undefined : "No backorders."}>
        {d.backordered.map((o: any) => <tr><td><a href={`${F}/orders/${o.id}`}>{o.no}</a></td><td>{o.party}</td><td>{dt(o.ordered_at)}</td></tr>)}</Table>
        {d.backordered.length && can(c, "wh.write") ? <PostBtn action={`${F}/allocate-waiting`} csrf={c.get("csrf")} label="Try to allocate waiting orders" cls="ghost sm" /> : null}</section>
      <section><Table caption="Deliveries expected" head={["Inbound", "Merchant", "Expected", "Status"]} empty={d.inbound.length ? undefined : "None expected."}>
        {d.inbound.map((i: any) => <tr><td><a href={`${F}/inbound/${i.id}`}>{i.no}</a></td><td>{i.party}</td><td>{dt(i.expected_at)}</td><td><Badge s={i.status === "receiving" ? "warn" : "info"} label={i.status} /></td></tr>)}</Table></section>
      <section><Table caption="At or below reorder point" head={["SKU", "Merchant", ["Available", "num"], ["Reorder at", "num"], ["Incoming", "num"]]} empty={d.low.length ? undefined : "No SKU is low."}>
        {d.low.map((x: any) => <tr><td><a href={`${F}/stock/${x.id}`}>{x.code}</a></td><td>{x.party_name}</td><td class="num">{x.available}</td><td class="num">{x.reorder_point}</td><td class="num">{x.incoming}</td></tr>)}</Table></section>
    </div>
    <p class="small mute" style="margin-top:18px">Unbilled activity: <Money v={d.unbilled} /> (ex-VAT). <a href={`${F}/billing`}>Billing activity</a></p>
  </>));
});
fulfil.post(`${F}/allocate-waiting`, async (c) => act(c, F, async () => {
  const r = await withT(c, (cn, ctx) => allocateWaiting(cn, ctx));
  return { to: F, ok: r.units ? `Allocated ${r.units} unit(s) across ${r.orders} order(s).` : "No waiting order could be allocated yet." };
}));

// ───────── orders
fulfil.get(`${F}/orders`, async (c) => {
  const q = c.req.query("q") ?? "", st = c.req.query("status") ?? "";
  const rows = await withT(c, (cn) => listFulfilOrders(cn, { status: st || null, q }));
  return appPage(c, "Fulfilment orders", (<>
    <PageHead title="Orders" sub="Each order reserves stock the moment it is entered, or waits — it never half-reserves unless the merchant allows partial shipment.">
      {can(c, "wh.write") ? <><a class="btn red sm" href={`${F}/orders/new`}>New order</a><a class="btn sm" href={`${F}/orders/import`}>Import CSV</a></> : null}
    </PageHead>
    <form method="get" class="inline-form no-print" style="margin-bottom:12px"><input name="q" type="search" placeholder="Order no., reference, recipient, tracking" value={q} style="min-width:280px" />
      <select name="status"><option value="">All statuses</option>{Object.keys(STATUS_LABEL).map((k) => <option value={k} selected={k === st}>{STATUS_LABEL[k]}</option>)}</select><button class="btn ghost sm" type="submit">Filter</button></form>
    <Table head={["Order", "Merchant", "Reference", "Recipient", ["Units", "num"], "Ship by", "Status", "Tracking"]} empty={rows.length ? undefined : "No orders match."}>
      {rows.map((o: any) => <tr><td><a href={`${F}/orders/${o.id}`}>{o.no}</a></td><td>{o.party_name}</td><td class="small">{o.external_ref}<div class="mute">{o.channel}</div></td><td class="small">{o.ship_to_name}<div class="mute">{o.ship_to_city ?? ""}</div></td>
        <td class="num">{o.units}</td><td class="small">{dt(o.ship_by)} {o.late ? <Badge s="bad" label="late" /> : null}</td><td><OSt s={o.status} /></td><td class="small">{o.tracking_no ? `${o.carrier} ${o.tracking_no}` : "—"}</td></tr>)}
    </Table>
  </>));
});

fulfil.get(`${F}/orders/new`, async (c) => {
  need(c, "wh.write");
  const merchants = await withT(c, (cn) => listParties(cn, "customer"));
  const csrf = c.get("csrf");
  return appPage(c, "New fulfilment order", (<>
    <PageHead title="New order" sub="Marketplace and store connectors are planned; enter orders here or import a CSV." />
    <form method="post" action={`${F}/orders`} class="card" style="max-width:860px"><Csrf t={csrf} />
      <div class="row"><div class="field"><label for="mp">Merchant</label><select id="mp" name="party_id" required><option value="">— select —</option>{merchants.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <div class="field"><label for="er">Merchant’s order number</label><input id="er" name="external_ref" type="text" required /></div>
        <div class="field"><label for="ch">Channel</label><input id="ch" name="channel" type="text" placeholder="shopify, noon, amazon…" /></div></div>
      <div class="field"><label for="ln">Items — one per line: SKU code, quantity</label><textarea id="ln" name="lines" rows={4} required placeholder={"TSHIRT-BLK-M, 2\nMUG-WHT, 1"}></textarea></div>
      <div class="row"><div class="field"><label for="sn">Recipient name</label><input id="sn" name="ship_to_name" type="text" required /></div><div class="field"><label for="sp">Phone</label><input id="sp" name="ship_to_phone" type="text" /></div></div>
      <div class="field"><label for="sa">Delivery address</label><input id="sa" name="ship_to_address" type="text" required /></div>
      <div class="row"><div class="field"><label for="sc">City / emirate</label><input id="sc" name="ship_to_city" type="text" /></div><div class="field"><label for="sb">Ship by</label><input id="sb" name="ship_by" type="datetime-local" /></div></div>
      <label class="check" style="max-width:520px"><input type="checkbox" name="allow_partial" value="1" /><span>Allow a partial shipment if only some items are in stock</span></label>
      <button class="btn red" style="margin-top:12px" type="submit">Save and reserve stock</button><p class="hint">Times are Gulf Standard Time (UTC+4). Recipient details are personal data: keep them to what delivery needs.</p>
    </form>
  </>));
});
fulfil.post(`${F}/orders`, async (c) => {
  need(c, "wh.write");
  const b = await formBody(c);
  return act(c, `${F}/orders/new`, async () => {
    const r = await withT(c, (cn, ctx) => createOrder(cn, ctx, { ...b, lines: str(b.lines), allow_partial: str(b.allow_partial) }));
    return { to: `${F}/orders/${r.id}`, ok: r.blocked ? `Order ${r.no} saved — waiting for stock; it will reserve automatically when stock arrives.` : `Order ${r.no} saved; ${r.allocated} unit(s) reserved.` };
  });
});

fulfil.get(`${F}/orders/import`, async (c) => {
  need(c, "wh.write");
  const merchants = await withT(c, (cn) => listParties(cn, "customer"));
  const csrf = c.get("csrf");
  return appPage(c, "Import orders", (<>
    <PageHead title="Import orders (CSV)" />
    <section class="card" style="max-width:760px">
      <p class="small mute">One row per order line. Required columns: <code>external_ref,sku,qty,ship_to_name,ship_to_address</code>. Optional: <code>channel,ship_to_phone,ship_to_city,ship_to_country,ship_by</code>.
        Rows with the same <code>external_ref</code> form one order. Known references are skipped, so re-uploading is safe. An order with any bad row is rejected whole. Max 2,000 rows.</p>
      <form method="post" action={`${F}/orders/import`} enctype="multipart/form-data"><Csrf t={csrf} />
        <div class="field"><label for="im">Merchant</label><select id="im" name="party_id" required><option value="">— select —</option>{merchants.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <div class="field"><input name="file" type="file" accept=".csv,text/csv" required /></div>
        <label class="check" style="max-width:420px"><input type="checkbox" name="dry_run" /><span>Preview only (dry run, nothing saved)</span></label>
        <button class="btn ghost sm" style="margin-top:10px" type="submit">Import</button></form></section>
  </>));
});
fulfil.post(`${F}/orders/import`, async (c) => {
  need(c, "wh.write");
  const b = await formBody(c);
  return act(c, `${F}/orders/import`, async () => {
    const f = b.file;
    if (!(f instanceof File)) throw new HttpError(400, "Choose a CSV file.");
    if (f.size > 1_000_000) throw new HttpError(400, "CSV files are limited to 1 MB.");
    const dry = b.dry_run === "on", text = Buffer.from(await f.arrayBuffer()).toString("utf8");
    const r = await withT(c, (cn, ctx) => importOrders(cn, ctx, str(b.party_id), text, dry));
    return { to: dry ? `${F}/orders/import` : `${F}/orders`, ok: summarise(r, dry) };
  });
});

fulfil.get(`${F}/orders/:id`, async (c) => {
  const id = c.req.param("id");
  const d = await withT(c, (cn) => getFulfilOrder(cn, id));
  const o = d.order, csrf = c.get("csrf"), floor = can(c, "wh.floor"), wr = can(c, "wh.write");
  const live = ["new", "backordered", "allocated", "picking", "picked", "packed"].includes(o.status);
  const waiting = d.lines.reduce((a: number, l: any) => a + l.waiting, 0);
  const open = d.allocs.filter((a: any) => a.remaining > 0);
  return appPage(c, o.no, (<>
    <PageHead title={`${o.no} · ${o.party_name}`} sub={`${o.channel} · ${o.external_ref}`}>
      <OSt s={o.status} />
      {o.status === "shipped" ? <a class="btn ghost sm" href={`${F}/orders/${id}/slip`}>Packing slip</a> : null}
      {live && wr && waiting > 0 ? <PostBtn action={`${F}/orders/${id}/allocate`} csrf={csrf} label="Allocate again" cls="sm" /> : null}
      {live && wr ? <Confirm action={`${F}/orders/${id}/cancel`} csrf={csrf} label="Cancel order" confirm="Cancel this order? Reservations are released and picked stock goes back to its bin." /> : null}
    </PageHead>
    <div class="card"><p style="margin:0"><strong>{o.ship_to_name}</strong>{o.ship_to_phone ? ` · ${o.ship_to_phone}` : ""} — {o.ship_to_address}{o.ship_to_city ? `, ${o.ship_to_city}` : ""} ({o.ship_to_country}) · ordered {dt(o.ordered_at)} · ship by {dt(o.ship_by)}{o.allow_partial ? " · partial shipment allowed" : " · ships complete"}</p></div>
    {o.status === "backordered" ? <div class="alert warn" style="margin-top:12px">Not enough unreserved stock. This order reserves automatically when stock is received, returned or counted in — oldest orders first. Nothing is partially reserved.</div> : null}
    <h3 style="margin-top:20px">Items</h3>
    <Table head={["SKU", "Product", ["Ordered", "num"], ["Reserved", "num"], ["Picked", "num"], ["Packed", "num"], ["Shipped", "num"], ["Given up", "num"], ["Waiting", "num"]]}>
      {d.lines.map((l: any) => <tr><td><strong>{l.code}</strong></td><td class="small">{l.name}</td><td class="num">{l.qty}</td><td class="num">{l.allocated_qty}</td><td class="num">{l.picked_qty}</td><td class="num">{l.packed_qty}</td><td class="num">{l.shipped_qty}</td><td class="num">{l.closed_qty}</td><td class="num">{l.waiting ? <Badge s="warn" label={String(l.waiting)} /> : 0}</td></tr>)}</Table>
    {live && wr && waiting > 0 && d.allocs.some((a: any) => a.picked_qty > 0 || a.qty > 0) ? (
      <form method="post" action={`${F}/orders/${id}/close-short`} class="inline-form" style="margin-top:10px"><Csrf t={csrf} /><input name="reason" type="text" placeholder="Why the missing units are being given up" required style="min-width:300px" /><button class="btn ghost sm" type="submit">Close short</button></form>) : null}

    {["allocated", "picking"].includes(o.status) && floor && open.length ? (<>
      <h3 style="margin-top:22px">Pick</h3>
      <p class="small mute">Enter what you actually found. Anything below the listed quantity is a short pick: the units are released and a task is raised to count that bin.</p>
      <form method="post" action={`${F}/orders/${id}/pick`}><Csrf t={csrf} />
        <Table head={["Bin", "SKU", "Scan code", ["To pick", "num"], ["Found", "num"]]}>
          {open.map((a: any) => <tr><td><strong>{a.location}</strong></td><td>{a.sku_code}</td><td class="small mute">{d.lines.find((l: any) => l.sku_id === a.sku_id)?.barcode ?? "—"}</td><td class="num">{a.remaining}</td>
            <td class="num"><input name={`q_${a.id}`} type="number" min="0" max={a.remaining} step="1" value={a.remaining} style="max-width:90px" aria-label={`Found ${a.sku_code} at ${a.location}`} /></td></tr>)}</Table>
        <button class="btn red" style="margin-top:10px" type="submit">Confirm picks</button></form></>) : null}

    {["picking", "picked", "packed"].includes(o.status) && floor ? (<>
      <h3 style="margin-top:22px">Pack</h3>
      <form method="post" action={`${F}/orders/${id}/pack`} class="inline-form"><Csrf t={csrf} /><input name="code" type="text" placeholder="Scan barcode or type SKU" required autofocus autocomplete="off" aria-label="Scan barcode or SKU" /><input name="qty" type="number" min="1" step="1" value="1" style="max-width:80px" aria-label="Quantity" /><button class="btn sm" type="submit">Add to carton</button></form>
      <p class="small mute">The code must be a SKU on this order and cannot exceed what was picked.</p>
      {d.lines.some((l: any) => l.packed_qty > 0) ? <PostBtn action={`${F}/orders/${id}/pack-reset`} csrf={csrf} label="Reset packing" cls="ghost sm" /> : null}</>) : null}

    {o.status === "packed" && floor ? (<>
      <h3 style="margin-top:22px">Ship</h3>
      {waiting > 0 ? <div class="alert warn">{waiting} unit(s) are not reserved. Allocate again when stock arrives, or close the order short — it cannot ship incomplete otherwise.</div> : (
        <form method="post" action={`${F}/orders/${id}/ship`} class="card" style="max-width:720px"><Csrf t={csrf} />
          <div class="row"><div class="field"><label for="ca">Carrier</label><select id="ca" name="carrier">{CARRIERS.map((x) => <option>{x}</option>)}</select></div>
            <div class="field"><label for="tn">Tracking number</label><input id="tn" name="tracking_no" type="text" required /></div></div>
          <div class="row"><div class="field"><label for="cn">Cartons</label><input id="cn" name="cartons" type="number" min="1" value="1" /></div><div class="field"><label for="wg">Weight (g)</label><input id="wg" name="weight_g" type="number" min="1" /></div></div>
          <button class="btn red" type="submit">Dispatch</button><p class="hint">Carrier label printing and live tracking APIs are not built: enter the tracking number from the carrier.</p></form>)}</>) : null}

    {d.shipment ? <div class="card" style="margin-top:20px"><h3>Shipment</h3><p style="margin:0">{d.shipment.carrier} · <strong>{d.shipment.tracking_no}</strong> · {d.shipment.cartons} carton(s){d.shipment.weight_g ? ` · ${d.shipment.weight_g} g` : ""} · {dt(d.shipment.shipped_at)}</p></div> : null}
    {d.charges.length ? <><h3 style="margin-top:22px">Billable activity</h3><Table head={["Activity", ["Qty", "num"], ["Rate", "num"], "Invoiced"]}>{d.charges.map((x: any) => <tr><td class="small">{x.description}</td><td class="num">{x.qty}</td><td class="num"><Money v={x.unit_minor} /></td><td>{x.invoice_id ? <Badge s="invoiced" /> : <Badge s="open" label="not yet" />}</td></tr>)}</Table></> : null}
    {d.returns.length ? <><h3 style="margin-top:22px">Returns</h3><Table head={["Return", "Status"]}>{d.returns.map((r: any) => <tr><td><a href={`${F}/returns/${r.id}`}>{r.no}</a></td><td><Badge s={r.status} /></td></tr>)}</Table></> : null}
  </>));
});
const O = (id: string) => `${F}/orders/${id}`;
fulfil.post(`${F}/orders/:id/allocate`, async (c) => { const id = c.req.param("id"); return act(c, O(id), async () => { const r = await withT(c, (cn, ctx) => allocateOrder(cn, ctx, id)); return { to: O(id), ok: r.allocated ? `Reserved ${r.allocated} unit(s).` : "Nothing more could be reserved yet." }; }); });
fulfil.post(`${F}/orders/:id/cancel`, async (c) => { const id = c.req.param("id"); return act(c, O(id), async () => { await withT(c, (cn, ctx) => cancelFulfilOrder(cn, ctx, id)); return { to: O(id), ok: "Order cancelled; stock released." }; }); });
fulfil.post(`${F}/orders/:id/close-short`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, O(id), async () => { await withT(c, (cn, ctx) => closeShort(cn, ctx, id, str(b.reason))); return { to: O(id), ok: "Missing units given up; the rest can ship." }; }); });
fulfil.post(`${F}/orders/:id/pick`, async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  const entries: Record<string, number> = {};
  for (const [k, v] of Object.entries(b)) if (k.startsWith("q_")) entries[k.slice(2)] = Number(str(v));
  return act(c, O(id), async () => {
    const r = await withT(c, (cn, ctx) => pickOrder(cn, ctx, id, entries));
    return { to: O(id), ok: r.shorts ? `Picked ${r.picked} unit(s). ${r.shorts} short pick(s) — a count task was raised.` : `Picked ${r.picked} unit(s).` };
  });
});
fulfil.post(`${F}/orders/:id/pack`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, O(id), async () => { const r = await withT(c, (cn, ctx) => packScan(cn, ctx, id, { code: str(b.code), qty: str(b.qty) })); return { to: O(id), ok: `${r.sku}: ${r.packed} of ${r.picked} packed.` }; }); });
fulfil.post(`${F}/orders/:id/pack-reset`, async (c) => { const id = c.req.param("id"); return act(c, O(id), async () => { await withT(c, (cn, ctx) => resetPacking(cn, ctx, id)); return { to: O(id), ok: "Packing reset." }; }); });
fulfil.post(`${F}/orders/:id/ship`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, O(id), async () => { const r = await withT(c, (cn, ctx) => shipOrder(cn, ctx, id, b)); return { to: O(id), ok: `Dispatched ${r.units} unit(s).` }; }); });

fulfil.get(`${F}/orders/:id/slip`, async (c) => {
  const id = c.req.param("id");
  const d = await withT(c, (cn) => getFulfilOrder(cn, id));
  const o = d.order;
  return appPage(c, `Packing slip ${o.no}`, (<>
    <PageHead title={`Packing slip ${o.no}`}><button class="btn ghost sm" data-print="1" type="button">Print</button></PageHead>
    <div class="print-doc card"><h2>{o.party_name}</h2>
      <p><strong>Deliver to:</strong> {o.ship_to_name}{o.ship_to_phone ? `, ${o.ship_to_phone}` : ""}<br />{o.ship_to_address}{o.ship_to_city ? `, ${o.ship_to_city}` : ""} ({o.ship_to_country})</p>
      <p>Order {o.external_ref} · {o.no}{d.shipment ? ` · ${d.shipment.carrier} ${d.shipment.tracking_no}` : ""}</p>
      <Table head={["SKU", "Item", ["Qty", "num"]]}>{d.lines.filter((l: any) => l.packed_qty > 0 || l.shipped_qty > 0).map((l: any) => <tr><td>{l.code}</td><td>{l.name}</td><td class="num">{l.shipped_qty || l.packed_qty}</td></tr>)}</Table></div>
  </>));
});

// ───────── pick list
fulfil.get(`${F}/pick`, async (c) => {
  const rows = await withT(c, (cn) => pickList(cn));
  const orders = [...new Map(rows.map((r: any) => [r.order_id, r.order_no])).entries()];
  const csrf = c.get("csrf");
  return appPage(c, "Pick list", (<>
    <PageHead title="Pick list" sub="All reserved, unpicked items in walking order (by bin). Open an order to record shortages."><button class="btn ghost sm" data-print="1" type="button">Print</button></PageHead>
    <div class="print-doc">
    <Table head={["Bin", "SKU", "Product", "Scan code", ["Qty", "num"], "Order", "Ship by"]} empty={rows.length ? undefined : "Nothing to pick."}>
      {rows.map((r: any) => <tr><td><strong>{r.location}</strong></td><td>{r.sku}</td><td class="small">{r.sku_name}</td><td class="small mute">{r.barcode ?? "—"}</td><td class="num"><strong>{r.remaining}</strong></td><td><a href={O(r.order_id)}>{r.order_no}</a></td><td class="small">{dt(r.ship_by)}</td></tr>)}</Table></div>
    {orders.length && can(c, "wh.floor") ? (<section class="no-print" style="margin-top:20px"><h3>Confirm a whole order exactly as listed</h3>
      <div class="inline-form">{orders.map(([id, no]) => <PostBtn action={`${F}/pick/${id}/confirm`} csrf={csrf} label={`${no} all picked`} cls="ghost sm" />)}</div>
      <p class="small mute">Use only when everything was found; for shortages open the order and enter the quantities.</p></section>) : null}
  </>));
});
fulfil.post(`${F}/pick/:id/confirm`, async (c) => { const id = c.req.param("id"); return act(c, `${F}/pick`, async () => { const r = await withT(c, (cn, ctx) => pickOrder(cn, ctx, id)); return { to: `${F}/pick`, ok: `Picked ${r.picked} unit(s).` }; }); });

// ───────── inbound
fulfil.get(`${F}/inbound`, async (c) => {
  const rows = await withT(c, (cn) => listInbound(cn));
  return appPage(c, "Inbound", (<>
    <PageHead title="Inbound deliveries" sub="Tell the warehouse what is coming; receive against it to put stock on the shelf."><a class="btn red sm" href={`${F}/inbound/new`}>Expect a delivery</a></PageHead>
    <Table head={["Inbound", "Merchant", "Reference", "Expected", ["Units expected", "num"], ["Received", "num"], "Status"]} empty={rows.length ? undefined : "Nothing yet."}>
      {rows.map((i: any) => <tr><td><a href={`${F}/inbound/${i.id}`}>{i.no}</a></td><td>{i.party_name}</td><td class="small">{i.reference ?? "—"}</td><td class="small">{dt(i.expected_at)}</td><td class="num">{i.expected}</td><td class="num">{i.received}</td><td><Badge s={i.status === "received" ? "ok" : i.status} /></td></tr>)}</Table>
  </>));
});
fulfil.get(`${F}/inbound/new`, async (c) => {
  need(c, "wh.write");
  const merchants = await withT(c, (cn) => listParties(cn, "customer"));
  const csrf = c.get("csrf");
  return appPage(c, "Expect a delivery", (<>
    <PageHead title="Expect a delivery" />
    <form method="post" action={`${F}/inbound`} class="card" style="max-width:760px"><Csrf t={csrf} />
      <div class="row"><div class="field"><label for="ip">Merchant</label><select id="ip" name="party_id" required><option value="">— select —</option>{merchants.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <div class="field"><label for="ir">Reference (carrier / PO)</label><input id="ir" name="reference" type="text" /></div><div class="field"><label for="ie">Expected</label><input id="ie" name="expected_at" type="datetime-local" /></div></div>
      <div class="field"><label for="il">Items — one per line: SKU code, quantity</label><textarea id="il" name="lines" rows={5} required placeholder={"TSHIRT-BLK-M, 120\nMUG-WHT, 48"}></textarea></div>
      <div class="field"><label for="in">Notes</label><input id="in" name="notes" type="text" /></div>
      <button class="btn red" type="submit">Save</button></form>
  </>));
});
fulfil.post(`${F}/inbound`, async (c) => { need(c, "wh.write"); const b = await formBody(c); return act(c, `${F}/inbound/new`, async () => { const r = await withT(c, (cn, ctx) => createInbound(cn, ctx, { ...b, lines: str(b.lines) })); return { to: `${F}/inbound/${r.id}`, ok: `Inbound ${r.no} saved.` }; }); });
fulfil.get(`${F}/inbound/:id`, async (c) => {
  const id = c.req.param("id");
  const d = await withT(c, async (cn) => ({ ...(await getInbound(cn, id)), locations: (await listLocations(cn)).filter((l: any) => l.active && ["bin", "receiving"].includes(l.kind)) }));
  const csrf = c.get("csrf"), i = d.inb, canRecv = can(c, "wh.floor") && ["expected", "receiving"].includes(i.status);
  return appPage(c, i.no, (<>
    <PageHead title={`${i.no} · ${i.party_name}`} sub={`${i.reference ?? "no reference"} · expected ${dt(i.expected_at)}`}>
      <Badge s={i.status === "received" ? "ok" : i.status} />
      {can(c, "wh.write") && ["expected", "receiving", "received"].includes(i.status) && d.lines.some((l: any) => l.received_qty + l.damaged_qty > 0) ? <Confirm action={`${F}/inbound/${id}/close`} csrf={csrf} label="Close" confirm="Close this inbound? Any shortage stays on record." cls="ghost sm" /> : null}
      {can(c, "wh.write") && i.status === "expected" ? <Confirm action={`${F}/inbound/${id}/cancel`} csrf={csrf} label="Cancel" confirm="Cancel this inbound?" /> : null}
    </PageHead>
    <Table head={["SKU", "Product", ["Expected", "num"], ["Good", "num"], ["Damaged", "num"], ["Difference", "num"], canRecv ? "Receive" : ""]}>
      {d.lines.map((l: any) => { const diff = l.received_qty + l.damaged_qty - l.expected_qty; return (
        <tr><td><strong>{l.code}</strong></td><td class="small">{l.name}</td><td class="num">{l.expected_qty}</td><td class="num">{l.received_qty}</td><td class="num">{l.damaged_qty}</td>
          <td class="num">{diff === 0 ? "—" : <Badge s={diff < 0 ? "warn" : "info"} label={diff > 0 ? `+${diff}` : String(diff)} />}</td>
          <td>{canRecv ? (
            <form method="post" action={`${F}/inbound/${id}/receive`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="line_id" value={l.id} /><input type="hidden" name="token" value={tok()} />
              <input name="good" type="number" min="0" step="1" placeholder="Good" style="max-width:80px" aria-label={`Good ${l.code}`} /><input name="damaged" type="number" min="0" step="1" placeholder="Damaged" style="max-width:90px" aria-label={`Damaged ${l.code}`} />
              <select name="location_id" aria-label="Into location">{d.locations.map((x: any) => <option value={x.id}>{x.code}</option>)}</select>
              <label class="check" style="border:0;padding:0"><input type="checkbox" name="accept_over" value="1" /><span class="small">accept over-receipt</span></label>
              <button class="btn sm" type="submit">Receive</button></form>) : null}</td></tr>); })}</Table>
    {canRecv ? <p class="small mute">Good units go to the chosen location; damaged units go to quarantine (not sellable). Receiving reserves stock for waiting orders, oldest first. Submitting twice is safe.</p> : null}
    {d.receipts.length ? <><h3 style="margin-top:22px">Receiving log</h3><Table head={["When", "SKU", ["Good", "num"], ["Damaged", "num"], "Into", "By"]}>{d.receipts.map((r: any) => <tr><td class="small">{dt(r.created_at)}</td><td>{r.code}</td><td class="num">{r.good_qty}</td><td class="num">{r.damaged_qty}</td><td>{r.location}</td><td>{r.who ?? "—"}</td></tr>)}</Table></> : null}
  </>));
});
fulfil.post(`${F}/inbound/:id/receive`, async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `${F}/inbound/${id}`, async () => {
    const r = await withT(c, (cn, ctx) => receiveInbound(cn, ctx, id, { line_id: str(b.line_id), good: str(b.good), damaged: str(b.damaged), location_id: str(b.location_id), token: str(b.token), accept_over: str(b.accept_over) }));
    if (r.duplicate) return { to: `${F}/inbound/${id}`, ok: "Already recorded — nothing was added twice." };
    return { to: `${F}/inbound/${id}`, ok: `Received ${r.good} good, ${r.damaged} damaged.${r.allocated.units ? ` ${r.allocated.units} unit(s) reserved for waiting orders.` : ""}` };
  });
});
fulfil.post(`${F}/inbound/:id/close`, async (c) => { const id = c.req.param("id"); return act(c, `${F}/inbound/${id}`, async () => { await withT(c, (cn, ctx) => closeInbound(cn, ctx, id)); return { to: `${F}/inbound/${id}`, ok: "Inbound closed." }; }); });
fulfil.post(`${F}/inbound/:id/cancel`, async (c) => { const id = c.req.param("id"); return act(c, `${F}/inbound/${id}`, async () => { await withT(c, (cn, ctx) => cancelInbound(cn, ctx, id)); return { to: `${F}/inbound`, ok: "Inbound cancelled." }; }); });

// ───────── stock
fulfil.get(`${F}/stock`, async (c) => {
  const d = await withT(c, async (cn) => ({ stock: await stockOverview(cn), locations: await listLocations(cn), pending: (await listAdjustments(cn, "pending")).length }));
  const csrf = c.get("csrf"), floor = can(c, "wh.floor");
  const skuOpts = d.stock.filter((s: any) => s.active).map((s: any) => <option value={s.id}>{s.party_name} · {s.code}</option>);
  const locOpts = (kinds: string[]) => d.locations.filter((l: any) => l.active && kinds.includes(l.kind)).map((l: any) => <option value={l.id}>{l.code}{l.kind !== "bin" ? ` (${l.kind})` : ""}</option>);
  return appPage(c, "Stock", (<>
    <PageHead title="Stock" sub="Available = units in active bins that no order has reserved. Every change is written to an immutable movement ledger.">
      <a class="btn sm" href={`${F}/adjustments`}>Count adjustments{d.pending ? ` (${d.pending} waiting)` : ""}</a></PageHead>
    <Table head={["Merchant", "SKU", "Product", ["Available", "num"], ["Reserved", "num"], ["In bins", "num"], ["Receiving", "num"], ["Staged", "num"], ["Quarantine", "num"], ["Incoming", "num"], ["Waiting", "num"]]} empty={d.stock.length ? undefined : "No SKUs yet. Add them in Catalogue."}>
      {d.stock.map((s: any) => <tr><td>{s.party_name}</td><td><a href={`${F}/stock/${s.id}`}>{s.code}</a>{!s.active ? <> <Badge s="info" label="inactive" /></> : null}</td><td class="small">{s.name}</td>
        <td class="num">{s.active && s.reorder_point > 0 && s.available <= s.reorder_point ? <Badge s="bad" label={`${s.available} · low`} /> : s.available}</td><td class="num">{s.reserved}</td><td class="num">{s.in_bins}</td><td class="num">{s.receiving}</td><td class="num">{s.staged}</td><td class="num">{s.quarantine}</td><td class="num">{s.incoming}</td><td class="num">{s.backordered || "—"}</td></tr>)}</Table>
    {floor && d.stock.length ? (<div class="grid g2" style="margin-top:22px">
      <section class="card"><h3>Move stock</h3><p class="small mute">Putaway from receiving, replenishment, or release from quarantine. Reserved units cannot be moved away from their order.</p>
        <form method="post" action={`${F}/stock/transfer`}><Csrf t={csrf} />
          <div class="field"><label for="ts">SKU</label><select id="ts" name="sku_id" required>{skuOpts}</select></div>
          <div class="row"><div class="field"><label for="tf">From</label><select id="tf" name="from_location">{locOpts(["bin", "receiving", "quarantine"])}</select></div><div class="field"><label for="tt">To</label><select id="tt" name="to_location">{locOpts(["bin", "receiving", "quarantine"])}</select></div>
            <div class="field"><label for="tq">Quantity</label><input id="tq" name="qty" type="number" min="1" step="1" required /></div></div>
          <button class="btn ghost sm" type="submit">Move</button></form></section>
      <section class="card"><h3>Count a bin</h3><p class="small mute">A difference raises an adjustment that someone else must approve; nothing changes until then.</p>
        <form method="post" action={`${F}/stock/count`}><Csrf t={csrf} />
          <div class="field"><label for="cs">SKU</label><select id="cs" name="sku_id" required>{skuOpts}</select></div>
          <div class="row"><div class="field"><label for="cl">Location</label><select id="cl" name="location_id">{locOpts(["bin", "receiving", "quarantine"])}</select></div><div class="field"><label for="cq">Counted</label><input id="cq" name="counted_qty" type="number" min="0" step="1" required /></div></div>
          <div class="field"><label for="cr">Reason if different</label><input id="cr" name="reason" type="text" placeholder="e.g. damaged, mis-shelved, miscounted at receipt" /></div>
          <button class="btn ghost sm" type="submit">Submit count</button></form></section></div>) : null}
  </>));
});
fulfil.post(`${F}/stock/transfer`, async (c) => { const b = await formBody(c); return act(c, `${F}/stock`, async () => { const r = await withT(c, (cn, ctx) => transferStock(cn, ctx, b)); return { to: `${F}/stock`, ok: `Moved.${r.allocated.units ? ` ${r.allocated.units} unit(s) reserved for waiting orders.` : ""}` }; }); });
fulfil.post(`${F}/stock/count`, async (c) => {
  const b = await formBody(c);
  return act(c, `${F}/stock`, async () => {
    const r = await withT(c, (cn, ctx) => requestAdjustment(cn, ctx, { ...b, reason: str(b.reason) || "Count difference" }));
    return { to: r.verified ? `${F}/stock` : `${F}/adjustments`, ok: r.verified ? "Count matches the system." : `Difference of ${r.variance > 0 ? "+" : ""}${r.variance} raised for approval.` };
  });
});
fulfil.get(`${F}/stock/:id`, async (c) => {
  const id = c.req.param("id");
  const d = await withT(c, async (cn) => ({ sku: (await listSkus(cn)).find((s: any) => s.id === id), loc: await stockByLocation(cn, id), ledger: await skuLedger(cn, id) }));
  if (!d.sku) throw new HttpError(404, "SKU not found", "not_found");
  return appPage(c, d.sku.code, (<>
    <PageHead title={`${d.sku.code} · ${d.sku.name}`} sub={`${d.sku.party_name}${d.sku.barcode ? ` · barcode ${d.sku.barcode}` : ""}`}><a class="btn ghost sm" href={`${F}/stock`}>Back to stock</a></PageHead>
    <Table caption="Where it is" head={["Location", "Kind", ["On hand", "num"], ["Reserved", "num"], ["Available", "num"]]} empty={d.loc.length ? undefined : "No stock."}>
      {d.loc.map((l: any) => <tr><td><strong>{l.code}</strong></td><td>{l.kind}</td><td class="num">{l.on_hand}</td><td class="num">{l.reserved}</td><td class="num">{l.available}</td></tr>)}</Table>
    <h3 style="margin-top:22px">Movement ledger (latest 100)</h3>
    <Table head={["When", "Movement", "Location", ["Change", "num"], "Note", "By"]} empty={d.ledger.length ? undefined : "No movements."}>
      {d.ledger.map((m: any) => <tr><td class="small nowrap">{dt(m.created_at)}</td><td>{m.kind.replace(/_/g, " ")}</td><td>{m.location}</td><td class="num">{m.delta > 0 ? `+${m.delta}` : m.delta}</td><td class="small">{m.note ?? ""}</td><td class="small">{m.who ?? "—"}</td></tr>)}</Table>
  </>));
});

fulfil.get(`${F}/adjustments`, async (c) => {
  const rows = await withT(c, (cn) => listAdjustments(cn));
  const csrf = c.get("csrf"), appr = can(c, "wh.approve");
  return appPage(c, "Count adjustments", (<>
    <PageHead title="Count adjustments" sub="Nothing changes on the shelf until a different person approves. If stock moved after the count, the count is voided and must be repeated."><a class="btn ghost sm" href={`${F}/stock`}>Stock</a></PageHead>
    <Table head={["Requested", "SKU", "Bin", ["System", "num"], ["Counted", "num"], ["Change", "num"], "Reason", "By", "Status", ""]} empty={rows.length ? undefined : "No adjustments."}>
      {rows.map((a: any) => <tr><td class="small nowrap">{dt(a.requested_at)}</td><td>{a.sku_code}<div class="small mute">{a.party_name}</div></td><td>{a.loc_code}</td><td class="num">{a.system_qty}</td><td class="num">{a.counted_qty}</td><td class="num">{a.counted_qty - a.system_qty > 0 ? "+" : ""}{a.counted_qty - a.system_qty}</td><td class="small">{a.reason}{a.decision_note ? <div class="mute">{a.decision_note}</div> : null}</td><td class="small">{a.requester ?? "—"}</td>
        <td><Badge s={a.status === "applied" ? "ok" : a.status === "pending" ? "warn" : a.status === "stale" ? "bad" : a.status} /></td>
        <td>{a.status === "pending" && appr ? <><PostBtn action={`${F}/adjustments/${a.id}`} csrf={csrf} label="Approve" fields={{ decision: "approve" }} /><PostBtn action={`${F}/adjustments/${a.id}`} csrf={csrf} label="Reject" cls="ghost sm" fields={{ decision: "reject" }} /></> : null}</td></tr>)}</Table>
  </>));
});
fulfil.post(`${F}/adjustments/:id`, async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `${F}/adjustments`, async () => {
    const r = await withT(c, (cn, ctx) => decideAdjustment(cn, ctx, id, str(b.decision) === "approve"));
    const msg = r.status === "applied" ? `Applied.${r.released ? ` ${r.released} reserved unit(s) released from orders.` : ""}` : r.status === "stale" ? "Stock moved since the count — the adjustment was voided. Count again." : "Rejected.";
    return { to: `${F}/adjustments`, ok: msg };
  });
});

// ───────── catalogue
fulfil.get(`${F}/catalog`, async (c) => {
  const d = await withT(c, async (cn) => ({ skus: await listSkus(cn), merchants: await listParties(cn, "customer") }));
  const csrf = c.get("csrf"), wr = can(c, "wh.write");
  return appPage(c, "Catalogue", (<>
    <PageHead title="Catalogue" sub="Each SKU belongs to one merchant; stock is never mixed between merchants." />
    <Table head={["Merchant", "SKU", "Product", "Barcode", ["Reorder at", "num"], "Status", ""]} empty={d.skus.length ? undefined : "No SKUs yet."}>
      {d.skus.map((s: any) => <tr><td>{s.party_name}</td><td><a href={`${F}/stock/${s.id}`}>{s.code}</a></td><td class="small">{s.name}</td><td class="small">{s.barcode ?? "—"}</td><td class="num">{s.reorder_point}</td><td><Badge s={s.active ? "ok" : "info"} label={s.active ? "active" : "inactive"} /></td>
        <td>{wr ? <PostBtn action={`${F}/catalog/${s.id}`} csrf={csrf} label={s.active ? "Deactivate" : "Activate"} cls="ghost sm" fields={{ active: s.active ? "0" : "1" }} /> : null}</td></tr>)}</Table>
    {wr ? (<div class="grid g2" style="margin-top:22px">
      <section class="card"><h3>Add a SKU</h3>
        <form method="post" action={`${F}/catalog`}><Csrf t={csrf} />
          <div class="field"><label for="sm">Merchant</label><select id="sm" name="party_id" required><option value="">— select —</option>{d.merchants.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
          <div class="row"><div class="field"><label for="sc2">SKU code</label><input id="sc2" name="code" type="text" required /></div><div class="field"><label for="sb2">Barcode</label><input id="sb2" name="barcode" type="text" /></div></div>
          <div class="field"><label for="sn2">Product name</label><input id="sn2" name="name" type="text" required /></div>
          <div class="row"><div class="field"><label for="sw">Unit weight (g)</label><input id="sw" name="unit_weight_g" type="number" min="1" /></div><div class="field"><label for="sr">Reorder point</label><input id="sr" name="reorder_point" type="number" min="0" value="0" /></div></div>
          <button class="btn red" type="submit">Save SKU</button></form></section>
      <section class="card"><h3>Import SKUs (CSV)</h3><p class="small mute">Columns: <code>code,name</code> (optional <code>barcode,unit_weight_g,reorder_point</code>). Existing codes/barcodes are skipped. Max 5,000 rows.</p>
        <form method="post" action={`${F}/catalog/import`} enctype="multipart/form-data"><Csrf t={csrf} />
          <div class="field"><label for="im2">Merchant</label><select id="im2" name="party_id" required><option value="">— select —</option>{d.merchants.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
          <div class="field"><input name="file" type="file" accept=".csv,text/csv" required /></div>
          <label class="check"><input type="checkbox" name="dry_run" /><span>Preview only</span></label>
          <button class="btn ghost sm" style="margin-top:10px" type="submit">Import</button></form></section></div>) : null}
  </>));
});
fulfil.post(`${F}/catalog`, async (c) => { need(c, "wh.write"); const b = await formBody(c); return act(c, `${F}/catalog`, async () => { await withT(c, (cn, ctx) => createSku(cn, ctx, b)); return { to: `${F}/catalog`, ok: "SKU saved." }; }); });
fulfil.post(`${F}/catalog/import`, async (c) => {
  need(c, "wh.write");
  const b = await formBody(c);
  return act(c, `${F}/catalog`, async () => {
    const f = b.file;
    if (!(f instanceof File)) throw new HttpError(400, "Choose a CSV file.");
    if (f.size > 1_000_000) throw new HttpError(400, "CSV files are limited to 1 MB.");
    const dry = b.dry_run === "on", text = Buffer.from(await f.arrayBuffer()).toString("utf8");
    const r = await withT(c, (cn, ctx) => importSkus(cn, ctx, str(b.party_id), text, dry));
    return { to: `${F}/catalog`, ok: summarise(r, dry) };
  });
});
fulfil.post(`${F}/catalog/:id`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, `${F}/catalog`, async () => { await withT(c, (cn, ctx) => updateSku(cn, ctx, id, { active: str(b.active) })); return { to: `${F}/catalog`, ok: "Updated." }; }); });

// ───────── locations
fulfil.get(`${F}/locations`, async (c) => {
  const rows = await withT(c, (cn) => listLocations(cn));
  const csrf = c.get("csrf"), wr = can(c, "wh.write");
  return appPage(c, "Locations", (<>
    <PageHead title="Locations" sub="Only bins are sold from. Receiving, staging (picked, not yet shipped) and quarantine are system areas created automatically." />
    <Table head={["Code", "Kind", ["Units", "num"], ["SKUs", "num"], "Note", "Status", ""]} empty={rows.length ? undefined : "No bins yet — add your first bin below."}>
      {rows.map((l: any) => <tr><td><strong>{l.code}</strong></td><td>{l.kind}</td><td class="num">{l.units}</td><td class="num">{l.skus}</td><td class="small">{l.note ?? ""}</td><td><Badge s={l.active ? "ok" : "info"} label={l.active ? "active" : "off"} /></td>
        <td>{wr && l.kind === "bin" ? <PostBtn action={`${F}/locations/${l.id}`} csrf={csrf} label={l.active ? "Switch off" : "Switch on"} cls="ghost sm" fields={{ active: l.active ? "0" : "1" }} /> : null}</td></tr>)}</Table>
    {wr ? <form method="post" action={`${F}/locations`} class="inline-form" style="margin-top:12px"><Csrf t={csrf} /><input name="code" type="text" placeholder="Bin code, e.g. A-01-02" required /><input name="note" type="text" placeholder="Note (optional)" /><button class="btn ghost sm" type="submit">Add bin</button></form> : null}
  </>));
});
fulfil.post(`${F}/locations`, async (c) => { need(c, "wh.write"); const b = await formBody(c); return act(c, `${F}/locations`, async () => { await withT(c, (cn, ctx) => createLocation(cn, ctx, b)); return { to: `${F}/locations`, ok: "Bin added." }; }); });
fulfil.post(`${F}/locations/:id`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, `${F}/locations`, async () => { await withT(c, (cn, ctx) => setLocationActive(cn, ctx, id, str(b.active) === "1")); return { to: `${F}/locations`, ok: "Updated." }; }); });

// ───────── returns
fulfil.get(`${F}/returns`, async (c) => {
  const rows = await withT(c, (cn) => listReturns(cn));
  return appPage(c, "Returns", (<>
    <PageHead title="Returns" sub="Expect a return, inspect on arrival, then restock, quarantine or dispose."><a class="btn red sm" href={`${F}/returns/new`}>Expect a return</a></PageHead>
    <Table head={["Return", "Merchant", "Order", "Reason", ["Units", "num"], "Status"]} empty={rows.length ? undefined : "No returns."}>
      {rows.map((r: any) => <tr><td><a href={`${F}/returns/${r.id}`}>{r.no}</a></td><td>{r.party_name}</td><td>{r.order_no ?? "—"}</td><td class="small">{r.reason ?? "—"}</td><td class="num">{r.handled} / {r.expected}</td><td><Badge s={r.status === "received" ? "ok" : r.status} /></td></tr>)}</Table>
  </>));
});
fulfil.get(`${F}/returns/new`, async (c) => {
  need(c, "wh.write");
  const merchants = await withT(c, (cn) => listParties(cn, "customer"));
  const csrf = c.get("csrf");
  return appPage(c, "Expect a return", (<>
    <PageHead title="Expect a return" />
    <form method="post" action={`${F}/returns`} class="card" style="max-width:760px"><Csrf t={csrf} />
      <div class="row"><div class="field"><label for="rm">Merchant</label><select id="rm" name="party_id" required><option value="">— select —</option>{merchants.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <div class="field"><label for="ro">Original order no. (optional)</label><input id="ro" name="order_no" type="text" placeholder="FUL-2026-00001" /></div></div>
      <div class="field"><label for="rl">Items — one per line: SKU code, quantity</label><textarea id="rl" name="lines" rows={3} required></textarea></div>
      <div class="field"><label for="rr">Reason</label><input id="rr" name="reason" type="text" /></div>
      <button class="btn red" type="submit">Save</button><p class="hint">A return against an order cannot exceed what was shipped on it.</p></form>
  </>));
});
fulfil.post(`${F}/returns`, async (c) => { need(c, "wh.write"); const b = await formBody(c); return act(c, `${F}/returns/new`, async () => { const r = await withT(c, (cn, ctx) => createReturn(cn, ctx, { ...b, lines: str(b.lines) })); return { to: `${F}/returns/${r.id}`, ok: `Return ${r.no} saved.` }; }); });
fulfil.get(`${F}/returns/:id`, async (c) => {
  const id = c.req.param("id");
  const d = await withT(c, async (cn) => ({ ...(await getReturn(cn, id)), locations: (await listLocations(cn)).filter((l: any) => l.active && ["bin", "receiving"].includes(l.kind)) }));
  const csrf = c.get("csrf"), r = d.ret, canRecv = can(c, "wh.floor") && ["expected", "received"].includes(r.status);
  return appPage(c, r.no, (<>
    <PageHead title={`${r.no} · ${r.party_name}`} sub={`${r.order_no ? `against ${r.order_no} · ` : ""}${r.reason ?? ""}`}>
      <Badge s={r.status === "received" ? "ok" : r.status} />
      {can(c, "wh.write") && ["expected", "received"].includes(r.status) ? <Confirm action={`${F}/returns/${id}/close`} csrf={csrf} label="Close" confirm="Close this return?" cls="ghost sm" /> : null}
      {can(c, "wh.write") && r.status === "expected" && d.lines.every((l: any) => l.restocked_qty + l.quarantined_qty + l.disposed_qty === 0) ? <Confirm action={`${F}/returns/${id}/cancel`} csrf={csrf} label="Cancel" confirm="Cancel this return?" /> : null}
    </PageHead>
    <Table head={["SKU", "Product", ["Expected", "num"], ["Restocked", "num"], ["Quarantined", "num"], ["Disposed", "num"], canRecv ? "Inspect & receive" : ""]}>
      {d.lines.map((l: any) => { const left = l.expected_qty - l.restocked_qty - l.quarantined_qty - l.disposed_qty; return (
        <tr><td><strong>{l.code}</strong></td><td class="small">{l.name}</td><td class="num">{l.expected_qty}</td><td class="num">{l.restocked_qty}</td><td class="num">{l.quarantined_qty}</td><td class="num">{l.disposed_qty}</td>
          <td>{canRecv && left > 0 ? (
            <form method="post" action={`${F}/returns/${id}/receive`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="line_id" value={l.id} /><input type="hidden" name="token" value={tok()} />
              <input name="qty" type="number" min="1" max={left} step="1" value={left} style="max-width:80px" aria-label={`Quantity ${l.code}`} />
              <select name="disposition" aria-label="Disposition"><option value="restock">Restock (resellable)</option><option value="quarantine">Quarantine (inspect)</option><option value="dispose">Dispose</option></select>
              <select name="location_id" aria-label="Restock into">{d.locations.map((x: any) => <option value={x.id}>{x.code}</option>)}</select>
              <button class="btn sm" type="submit">Receive</button></form>) : null}</td></tr>); })}</Table>
    {d.receipts.length ? <><h3 style="margin-top:22px">Receiving log</h3><Table head={["When", "SKU", ["Qty", "num"], "Disposition", "Location"]}>{d.receipts.map((x: any) => <tr><td class="small">{dt(x.created_at)}</td><td>{x.code}</td><td class="num">{x.qty}</td><td>{x.disposition}</td><td>{x.location ?? "—"}</td></tr>)}</Table></> : null}
  </>));
});
fulfil.post(`${F}/returns/:id/receive`, async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `${F}/returns/${id}`, async () => {
    const r = await withT(c, (cn, ctx) => receiveReturn(cn, ctx, id, { line_id: str(b.line_id), qty: str(b.qty), disposition: str(b.disposition), location_id: str(b.location_id), token: str(b.token) }));
    return { to: `${F}/returns/${id}`, ok: r.duplicate ? "Already recorded — nothing was added twice." : "Received." };
  });
});
fulfil.post(`${F}/returns/:id/close`, async (c) => { const id = c.req.param("id"); return act(c, `${F}/returns/${id}`, async () => { await withT(c, (cn, ctx) => closeReturn(cn, ctx, id)); return { to: `${F}/returns/${id}`, ok: "Return closed." }; }); });
fulfil.post(`${F}/returns/:id/cancel`, async (c) => { const id = c.req.param("id"); return act(c, `${F}/returns/${id}`, async () => { await withT(c, (cn, ctx) => cancelReturn(cn, ctx, id)); return { to: `${F}/returns`, ok: "Return cancelled." }; }); });

// ───────── billing activity
fulfil.get(`${F}/billing`, async (c) => {
  const d = await withT(c, async (cn) => ({ summary: await billingSummary(cn), rates: await listRates(cn), merchants: await listParties(cn, "customer"), recent: await unbilledForParty(cn) }));
  const csrf = c.get("csrf"), rates = can(c, "wh.rates"), fin = can(c, "finance.write");
  const month = new Date().toISOString().slice(0, 7);
  return appPage(c, "Billing activity", (<>
    <PageHead title="Billing activity" sub="Activity is priced from each merchant’s rate card at the moment it happens. Invoices group it by activity type; nothing bills twice." />
    <h3>Unbilled by merchant</h3>
    <Table head={["Merchant", "Activity", ["Qty", "num"], ["Rate", "num"], ["Amount", "num"]]} empty={d.summary.length ? undefined : "Nothing waiting to be invoiced."}>
      {d.summary.flatMap((m: any) => m.lines.map((l: any, i: number) => <tr><td>{i === 0 ? <strong>{m.party_name}</strong> : ""}</td><td class="small">{RATE_CODES[l.code as keyof typeof RATE_CODES] ?? l.code}</td><td class="num">{l.qty}</td><td class="num"><Money v={l.unit_minor} /></td><td class="num"><Money v={l.net} /></td></tr>))}</Table>
    {fin && d.summary.length ? <div class="inline-form" style="margin-top:10px">{d.summary.map((m: any) => <PostBtn action={`${F}/billing/invoice`} csrf={csrf} label={`Invoice ${m.party_name} (ex-VAT AED ${(m.total / 100).toFixed(2)})`} cls="red sm" fields={{ party_id: m.party_id }} />)}</div> : null}
    <h3 style="margin-top:26px">Rate cards</h3>
    <Table head={["Merchant", "Activity", ["Rate", "num"], "Tax"]} empty={d.rates.length ? undefined : "No rates agreed yet — activity is not billed until a rate exists."}>
      {d.rates.map((r: any) => <tr><td>{r.party_name}</td><td>{RATE_CODES[r.code as keyof typeof RATE_CODES]}</td><td class="num"><Money v={r.unit_minor} /></td><td>{r.tax_code}</td></tr>)}</Table>
    {rates ? (<div class="grid g2" style="margin-top:14px">
      <form method="post" action={`${F}/billing/rate`} class="card"><Csrf t={csrf} /><h3>Set a rate</h3><p class="small mute">Applies to activity from now on; charges already created keep their rate. A rate of 0 stops billing that activity.</p>
        <div class="field"><label for="rp">Merchant</label><select id="rp" name="party_id" required>{d.merchants.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <div class="row"><div class="field"><label for="rc">Activity</label><select id="rc" name="code">{Object.entries(RATE_CODES).map(([k, v]) => <option value={k}>{v}</option>)}</select></div>
          <div class="field"><label for="ra2">Rate (AED, ex-VAT)</label><input id="ra2" name="amount" type="number" min="0" step="0.01" required /></div>
          <div class="field"><label for="rt2">Tax code</label><select id="rt2" name="tax_code">{Object.entries(TAX_CODES).map(([k, v]) => <option value={k}>{k} · {v.label}</option>)}</select></div></div>
        <button class="btn ghost sm" type="submit">Save rate</button></form>
      <form method="post" action={`${F}/billing/storage`} class="card"><Csrf t={csrf} /><h3>Storage charge for a month</h3><p class="small mute"><strong>Snapshot, not daily accrual:</strong> counts the locations holding each merchant’s stock when you run it. Safe to repeat — a merchant is billed once per month.</p>
        <div class="field"><label for="sm2">Month</label><input id="sm2" name="month" type="month" value={month} max={month} required /></div>
        <button class="btn ghost sm" type="submit">Create storage charges</button></form></div>) : null}
  </>));
});
fulfil.post(`${F}/billing/rate`, async (c) => { need(c, "wh.rates"); const b = await formBody(c); return act(c, `${F}/billing`, async () => { await withT(c, (cn, ctx) => setRate(cn, ctx, b)); return { to: `${F}/billing`, ok: "Rate saved." }; }); });
fulfil.post(`${F}/billing/invoice`, async (c) => { const b = await formBody(c); return act(c, `${F}/billing`, async () => { const r = await withT(c, (cn, ctx) => invoiceMerchant(cn, ctx, str(b.party_id))); return { to: `/app/invoices/${r.id}`, ok: `Invoice ${r.no} issued.` }; }); });
fulfil.post(`${F}/billing/storage`, async (c) => {
  const b = await formBody(c);
  return act(c, `${F}/billing`, async () => {
    const r = await withT(c, (cn, ctx) => runStorageCharges(cn, ctx, str(b.month)));
    return { to: `${F}/billing`, ok: `Storage: ${r.created} charge(s) created${r.already ? `, ${r.already} already billed for this month` : ""}${r.noRate ? `, ${r.noRate} merchant(s) have no storage rate` : ""}.` };
  });
});
