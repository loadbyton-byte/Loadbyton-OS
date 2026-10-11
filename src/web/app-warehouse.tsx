import { Hono } from "hono";
import crypto from "node:crypto";
import { TAX_CODES, formatDate, formatDay } from "../lib/util.js";
import {
  accrueStorage, addFoundLine, allocateOutbound, billingSummary, cancelCount, cancelInbound, cancelOutbound, closeInbound, confirmPick, CHARGE_LABEL,
  createInbound, createLocation, createOutbound, createSku, createWarehouse, decideCountLine, dispatchOutbound, getCount, getInbound, getOutbound,
  invoiceOwner, listCounts, listInbound, listLocations, listMovements, listOutbound, listRates, listSkus, listStock, listWarehouses, moveStock,
  receiveLine, recordCount, setRate, startCount, submitCount, warehouseOverview, dubaiDay,
} from "../ops/warehouse.js";
import { listParties } from "../ops/crm.js";
import { arr, formBody, str, type Env } from "./mw.js";
import { act, appPage, can, Confirm, need, PageHead, PostBtn, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table } from "./ui.js";

export const warehouse = new Hono<Env>();
const W = "/app/warehouse";
const dt = (v: any) => (v ? formatDate(v) : "—");
const q = (v: any) => String(Number(v));
const rid = () => crypto.randomUUID();      // per-render scan/retry key: a double-click or resubmit posts once

// ───────── board
warehouse.get(W, async (c) => {
  need(c, "read");
  const d = await withT(c, (cn) => warehouseOverview(cn));
  return appPage(c, "Warehouse", (<>
    <PageHead title="Warehouse" sub="Customer-owned stock in your custody: what to receive, what to ship, what is held, what is unbilled.">
      {can(c, "wh.write") ? <><a class="btn sm" href={`${W}/inbound/new`}>Expect a delivery</a><a class="btn red sm" href={`${W}/outbound/new`}>New dispatch order</a></> : null}
    </PageHead>
    <div class="grid g4">
      <div class="card"><h3>Units in custody</h3><div class="kpi">{q(d.unitsOnHand)}</div><p class="small mute">{q(d.quarantined)} in quarantine</p></div>
      <div class="card"><h3>Inbound open</h3><div class="kpi">{d.inboundOpen}</div></div>
      <div class="card"><h3>Dispatch open</h3><div class="kpi">{d.outboundOpen}</div></div>
      <div class="card"><h3>Late dispatches</h3><div class={`kpi ${d.outboundLate ? "bad" : "good"}`}>{d.outboundLate}</div></div>
    </div>
    {d.toDecide ? <div class="alert warn" style="margin-top:16px"><strong>{d.toDecide} count variance(s)</strong> are waiting for an independent decision. <a href={`${W}/counts`}>Open counts</a></div> : null}
    {d.unrated ? <div class="alert warn" style="margin-top:16px"><strong>{d.unrated} billable activity line(s) have no rate card.</strong> They are kept and will be priced when the rate is set. <a href={`${W}/billing`}>Billing</a></div> : null}
    <div class="grid g2" style="margin-top:20px;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr))">
      <section><Table caption="Deliveries expected" head={["Notice", "Customer", "Expected", ""]} empty={d.inbound.length ? undefined : "Nothing expected."}>
        {d.inbound.map((i: any) => <tr><td><a href={`${W}/inbound/${i.id}`}>{i.no}</a></td><td>{i.owner}</td><td>{i.expected_on ? formatDay(i.expected_on) : "—"}</td><td><Badge s={i.status} /></td></tr>)}</Table></section>
      <section><Table caption="Dispatch to work" head={["Order", "Customer", "Required by", ""]} empty={d.outbound.length ? undefined : "Nothing to dispatch."}>
        {d.outbound.map((o: any) => <tr><td><a href={`${W}/outbound/${o.id}`}>{o.no}</a></td><td>{o.owner}</td><td>{dt(o.required_by)} {o.late ? <Badge s="bad" label="late" /> : null}</td><td><Badge s={o.status} /></td></tr>)}</Table></section>
      <section><Table caption="Held in quarantine" head={["Customer", "SKU", "Location", ["Units", "num"]]} empty={d.held.length ? undefined : "Nothing on hold."}>
        {d.held.map((h: any) => <tr><td>{h.owner}</td><td>{h.sku_code}</td><td>{h.loc_code}</td><td class="num">{q(h.qty_on_hand)}</td></tr>)}</Table></section>
      <section><Table caption="Units held per customer" head={["Customer", ["Units", "num"]]} empty={d.owners.length ? undefined : "No stock yet."}>
        {d.owners.map((o: any) => <tr><td>{o.name}</td><td class="num">{q(o.units)}</td></tr>)}</Table></section>
    </div>
    {can(c, "wh.bill") ? <p class="small mute" style="margin-top:14px">Unbilled, rated activity: <strong><Money v={d.unbilledMinor} /></strong></p> : null}
  </>));
});

// ───────── inbound
warehouse.get(`${W}/inbound`, async (c) => {
  need(c, "read");
  const rows = await withT(c, (cn) => listInbound(cn));
  return appPage(c, "Inbound", (<>
    <PageHead title="Inbound" sub="An advance notice from the customer, received line by line into a location."><a class="btn red sm" href={`${W}/inbound/new`}>Expect a delivery</a></PageHead>
    <Table head={["Notice", "Customer", "Warehouse", "Customer ref", "Expected", ["Units", "num"], "Status"]} empty={rows.length ? undefined : "No notices yet."}>
      {rows.map((i: any) => <tr><td><a href={`${W}/inbound/${i.id}`}>{i.no}</a></td><td>{i.owner_name}</td><td>{i.warehouse_code}</td><td>{i.customer_ref ?? "—"}</td><td>{i.expected_on ? formatDay(i.expected_on) : "—"}</td><td class="num">{q(i.received)} / {q(i.expected)}</td><td><Badge s={i.status} /></td></tr>)}
    </Table>
  </>));
});
warehouse.get(`${W}/inbound/new`, async (c) => {
  need(c, "wh.write");
  const owner = c.req.query("owner") ?? "", wh = c.req.query("warehouse") ?? "";
  const d = await withT(c, async (cn) => ({ customers: await listParties(cn, "customer"), warehouses: await listWarehouses(cn), skus: owner ? await listSkus(cn, owner) : [] }));
  const csrf = c.get("csrf");
  return appPage(c, "Expect a delivery", (<>
    <PageHead title="Expect a delivery" />
    {!owner || !wh ? (
      <form method="get" action={`${W}/inbound/new`} class="card" style="max-width:640px">
        <div class="row"><div class="field"><label for="ow">Customer (owner of the goods)</label><select id="ow" name="owner" required><option value="">— select —</option>{d.customers.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
          <div class="field"><label for="wh">Warehouse</label><select id="wh" name="warehouse" required><option value="">— select —</option>{d.warehouses.map((w: any) => <option value={w.id}>{w.code} · {w.name}</option>)}</select></div></div>
        {d.warehouses.length ? null : <p class="hint">Add a warehouse and locations under <a href={`${W}/setup`}>Setup</a> first.</p>}
        <button class="btn red" type="submit">Next: expected SKUs</button>
      </form>
    ) : (
      <form method="post" action={`${W}/inbound`} class="card" style="max-width:860px"><Csrf t={csrf} />
        <input type="hidden" name="owner_id" value={owner} /><input type="hidden" name="warehouse_id" value={wh} />
        <div class="row"><div class="field"><label for="cr">Customer reference (ASN / PO)</label><input id="cr" name="customer_ref" type="text" /></div><div class="field"><label for="ex">Expected on</label><input id="ex" name="expected_on" type="date" /></div></div>
        {d.skus.length ? null : <p class="alert warn">This customer has no SKUs yet. Add them under <a href={`${W}/setup`}>Setup</a>.</p>}
        <fieldset><legend>Expected SKUs</legend>
          {[0, 1, 2, 3, 4, 5].map(() => <div class="row tight" style="margin-bottom:8px"><div class="field"><select name="sku_id" aria-label="SKU"><option value="">—</option>{d.skus.map((s: any) => <option value={s.id}>{s.code} · {s.description}</option>)}</select></div><div class="field"><input name="qty" type="number" min="0.001" step="0.001" placeholder="Quantity" aria-label="Quantity" /></div></div>)}
        </fieldset>
        <div class="field"><label for="nt">Notes</label><input id="nt" name="notes" type="text" /></div>
        <button class="btn red" type="submit">Save notice</button>
      </form>
    )}
  </>));
});
warehouse.post(`${W}/inbound`, async (c) => {
  need(c, "wh.write");
  const b = await formBody(c), skus = arr(b.sku_id), qtys = arr(b.qty);
  return act(c, `${W}/inbound/new?owner=${str(b.owner_id)}&warehouse=${str(b.warehouse_id)}`, async () => {
    const r = await withT(c, (cn, ctx) => createInbound(cn, ctx, {
      owner_id: str(b.owner_id), warehouse_id: str(b.warehouse_id), customer_ref: str(b.customer_ref), expected_on: str(b.expected_on), notes: str(b.notes),
      lines: skus.map((s, i) => ({ sku_id: s, qty: qtys[i] ?? "" })).filter((l) => l.sku_id),
    }));
    return { to: `${W}/inbound/${r.id}`, ok: `Notice ${r.no} saved.` };
  });
});
warehouse.get(`${W}/inbound/:id`, async (c) => {
  need(c, "read");
  const id = c.req.param("id");
  const d = await withT(c, (cn) => getInbound(cn, id));
  const i = d.inbound, csrf = c.get("csrf"), w = can(c, "wh.write"), open = ["expected", "receiving"].includes(i.status);
  return appPage(c, i.no, (<>
    <PageHead title={`${i.no} · ${i.owner_name}`} sub={`${i.warehouse_code}${i.customer_ref ? ` · ref ${i.customer_ref}` : ""}${i.expected_on ? ` · expected ${formatDay(i.expected_on)}` : ""}`}>
      <Badge s={i.status} />
      {i.status === "receiving" && w ? <PostBtn action={`${W}/inbound/${id}/close`} csrf={csrf} label="Close receipt" cls="red sm" /> : null}
      {i.status === "expected" && w ? <Confirm action={`${W}/inbound/${id}/cancel`} csrf={csrf} label="Cancel notice" confirm="Cancel this notice? Nothing has been received." /> : null}
    </PageHead>
    <Table head={["SKU", "Description", ["Expected", "num"], ["Received", "num"], ["Damaged", "num"], "Variance"]}>
      {d.lines.map((l: any) => { const got = Number(l.qty_received) + Number(l.qty_damaged), v = Math.round((got - Number(l.qty_expected)) * 1000) / 1000;
        return <tr><td>{l.sku_code}</td><td>{l.sku_desc}</td><td class="num">{q(l.qty_expected)} {l.uom}</td><td class="num">{q(l.qty_received)}</td><td class="num">{q(l.qty_damaged)}</td>
          <td>{i.status === "received" || got > 0 ? (v === 0 ? <Badge s="ok" label="matches" /> : <Badge s={v < 0 ? "warn" : "info"} label={v < 0 ? `${-v} short` : `${v} over`} />) : "—"}</td></tr>; })}
    </Table>
    {open && w ? <>
      <h3 style="margin-top:24px">Receive</h3>
      <p class="small mute">Good goods go to a receiving or storage location; damaged goods go to quarantine. A repeat submit of the same form posts once.</p>
      {d.lines.map((l: any) => (
        <form method="post" action={`${W}/inbound/line/${l.id}/receive`} class="card" style="margin-bottom:12px"><Csrf t={csrf} /><input type="hidden" name="client_ref" value={`rcv-${rid()}`} /><input type="hidden" name="inbound" value={id} />
          <strong>{l.sku_code}</strong> <span class="mute small">{l.sku_desc} · {q(Number(l.qty_expected) - Number(l.qty_received) - Number(l.qty_damaged))} still expected</span>
          <div class="row" style="margin-top:8px">
            <div class="field"><label>Quantity</label><input name="qty" type="number" min="0.001" step="0.001" required /></div>
            <div class="field"><label>Condition</label><select name="condition"><option value="good">Good</option><option value="damaged">Damaged (quarantine)</option></select></div>
            <div class="field"><label>Location</label><select name="location_id" required>{d.locations.map((x: any) => <option value={x.id}>{x.code} · {x.kind}</option>)}</select></div>
            <div class="field"><label>Lot / batch</label><input name="lot" type="text" /></div>
          </div>
          <label class="small"><input type="checkbox" name="accept_over" value="1" /> accept over-receipt</label> <button class="btn sm" type="submit">Receive</button>
        </form>))}
    </> : null}
    {d.moves.length ? <><h3 style="margin-top:24px">Receipts posted</h3>
      <Table head={["When", "SKU", "Location", "Lot", ["Units", "num"], "Note"]}>{d.moves.map((m: any) => <tr><td class="small nowrap">{dt(m.created_at)}</td><td>{m.sku_code}</td><td>{m.loc_code}</td><td>{m.lot || "—"}</td><td class="num">{q(m.qty_delta)}</td><td class="small">{m.reason ?? ""}</td></tr>)}</Table></> : null}
  </>));
});
warehouse.post(`${W}/inbound/line/:id/receive`, async (c) => {
  need(c, "wh.write");
  const b = await formBody(c), back = `${W}/inbound/${str(b.inbound)}`;
  return act(c, back, async () => {
    const r = await withT(c, (cn, ctx) => receiveLine(cn, ctx, c.req.param("id"), { qty: str(b.qty), location_id: str(b.location_id), lot: str(b.lot), condition: str(b.condition), client_ref: str(b.client_ref), accept_over: str(b.accept_over) }));
    return { to: back, ok: r.duplicate ? "That receipt was already recorded; nothing was added twice." : "Received." };
  });
});
warehouse.post(`${W}/inbound/:id/close`, async (c) => { const id = c.req.param("id"); return act(c, `${W}/inbound/${id}`, async () => { const r = await withT(c, (cn, ctx) => closeInbound(cn, ctx, id)); return { to: `${W}/inbound/${id}`, ok: r.variances.length ? `Receipt closed with ${r.variances.length} variance(s) recorded.` : "Receipt closed; everything matched." }; }); });
warehouse.post(`${W}/inbound/:id/cancel`, async (c) => { const id = c.req.param("id"); return act(c, `${W}/inbound/${id}`, async () => { await withT(c, (cn, ctx) => cancelInbound(cn, ctx, id)); return { to: `${W}/inbound`, ok: "Notice cancelled." }; }); });

// ───────── outbound
warehouse.get(`${W}/outbound`, async (c) => {
  need(c, "read");
  const rows = await withT(c, (cn) => listOutbound(cn));
  return appPage(c, "Dispatch", (<>
    <PageHead title="Dispatch" sub="Allocate oldest stock first, confirm the pick, then dispatch. Dispatch posts exactly what was picked."><a class="btn red sm" href={`${W}/outbound/new`}>New dispatch order</a></PageHead>
    <Table head={["Order", "Customer", "Ship to", "Required by", ["Units", "num"], "Status"]} empty={rows.length ? undefined : "No dispatch orders yet."}>
      {rows.map((o: any) => <tr><td><a href={`${W}/outbound/${o.id}`}>{o.no}</a></td><td>{o.owner_name}</td><td class="small">{o.ship_to}</td><td>{dt(o.required_by)} {o.late ? <Badge s="bad" label="late" /> : null}</td><td class="num">{q(o.dispatched)} / {q(o.ordered)}</td><td><Badge s={o.status} /></td></tr>)}
    </Table>
  </>));
});
warehouse.get(`${W}/outbound/new`, async (c) => {
  need(c, "wh.write");
  const owner = c.req.query("owner") ?? "", wh = c.req.query("warehouse") ?? "";
  const d = await withT(c, async (cn) => ({ customers: await listParties(cn, "customer"), warehouses: await listWarehouses(cn), skus: owner ? await listSkus(cn, owner) : [] }));
  const csrf = c.get("csrf");
  return appPage(c, "New dispatch order", (<>
    <PageHead title="New dispatch order" />
    {!owner || !wh ? (
      <form method="get" action={`${W}/outbound/new`} class="card" style="max-width:640px">
        <div class="row"><div class="field"><label for="ow">Customer (owner of the goods)</label><select id="ow" name="owner" required><option value="">— select —</option>{d.customers.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
          <div class="field"><label for="wh">Ship from</label><select id="wh" name="warehouse" required><option value="">— select —</option>{d.warehouses.map((w: any) => <option value={w.id}>{w.code} · {w.name}</option>)}</select></div></div>
        <button class="btn red" type="submit">Next: SKUs to ship</button>
      </form>
    ) : (
      <form method="post" action={`${W}/outbound`} class="card" style="max-width:860px"><Csrf t={csrf} />
        <input type="hidden" name="owner_id" value={owner} /><input type="hidden" name="warehouse_id" value={wh} />
        <div class="field"><label for="st">Ship to</label><input id="st" name="ship_to" type="text" required /></div>
        <div class="row"><div class="field"><label for="cr">Customer reference</label><input id="cr" name="customer_ref" type="text" /></div><div class="field"><label for="rb">Required by</label><input id="rb" name="required_by" type="datetime-local" /></div></div>
        <fieldset><legend>SKUs to ship</legend>
          {[0, 1, 2, 3, 4, 5].map(() => <div class="row tight" style="margin-bottom:8px"><div class="field"><select name="sku_id" aria-label="SKU"><option value="">—</option>{d.skus.map((s: any) => <option value={s.id}>{s.code} · {s.description}</option>)}</select></div><div class="field"><input name="qty" type="number" min="0.001" step="0.001" placeholder="Quantity" aria-label="Quantity" /></div></div>)}
        </fieldset>
        <button class="btn red" type="submit">Save order</button><p class="hint">Times are Gulf Standard Time (UTC+4).</p>
      </form>
    )}
  </>));
});
warehouse.post(`${W}/outbound`, async (c) => {
  need(c, "wh.write");
  const b = await formBody(c), skus = arr(b.sku_id), qtys = arr(b.qty);
  return act(c, `${W}/outbound/new?owner=${str(b.owner_id)}&warehouse=${str(b.warehouse_id)}`, async () => {
    const r = await withT(c, (cn, ctx) => createOutbound(cn, ctx, {
      owner_id: str(b.owner_id), warehouse_id: str(b.warehouse_id), ship_to: str(b.ship_to), customer_ref: str(b.customer_ref), required_by: str(b.required_by),
      lines: skus.map((s, i) => ({ sku_id: s, qty: qtys[i] ?? "" })).filter((l) => l.sku_id),
    }));
    return { to: `${W}/outbound/${r.id}`, ok: `Order ${r.no} saved.` };
  });
});
warehouse.get(`${W}/outbound/:id`, async (c) => {
  need(c, "read");
  const id = c.req.param("id");
  const d = await withT(c, (cn) => getOutbound(cn, id));
  const o = d.order, csrf = c.get("csrf"), w = can(c, "wh.write");
  const stages = ["new", "allocated", "picked", "dispatched"], idx = stages.indexOf(o.status);
  const reserved = d.allocations.filter((a: any) => a.status === "reserved");
  return appPage(c, o.no, (<>
    <PageHead title={`${o.no} · ${o.owner_name}`} sub={`${o.warehouse_code} → ${o.ship_to}${o.customer_ref ? ` · ref ${o.customer_ref}` : ""} · required ${dt(o.required_by)}`}>
      <Badge s={o.status} />
      {o.status === "new" && w ? <><PostBtn action={`${W}/outbound/${id}/allocate`} csrf={csrf} label="Allocate stock" cls="red sm" /><PostBtn action={`${W}/outbound/${id}/allocate`} csrf={csrf} label="Allocate what is available" cls="ghost sm" fields={{ partial: "1" }} /></> : null}
      {["new", "allocated", "picked"].includes(o.status) && w ? <Confirm action={`${W}/outbound/${id}/cancel`} csrf={csrf} label="Cancel order" confirm="Cancel this order and release its reserved stock?" /> : null}
    </PageHead>
    {o.status !== "cancelled" ? <ol class="stages">{stages.map((s, i) => <li class={i < idx || o.status === "dispatched" ? "done" : i === idx ? "now" : ""}>{s}</li>)}</ol> : null}
    <Table head={["SKU", "Description", ["Ordered", "num"], ["Allocated", "num"], ["Picked", "num"], ["Dispatched", "num"]]}>
      {d.lines.map((l: any) => <tr><td>{l.sku_code}</td><td>{l.sku_desc}</td><td class="num">{q(l.qty_ordered)} {l.uom}</td><td class="num">{q(l.qty_allocated)}</td><td class="num">{q(l.qty_picked)}</td><td class="num">{q(l.qty_dispatched)}</td></tr>)}
    </Table>
    {o.status === "allocated" && w ? (
      <form method="post" action={`${W}/outbound/${id}/pick`} style="margin-top:20px"><Csrf t={csrf} />
        <h3>Pick list (oldest stock first)</h3>
        <p class="small mute">Enter what was actually picked. Anything short is released immediately — and is a reason to count that location.</p>
        <Table head={["SKU", "Location", "Lot", ["Reserved", "num"], "Picked"]}>
          {reserved.map((a: any) => <tr><td>{a.sku_code}</td><td>{a.loc_code}</td><td>{a.lot || "—"}</td><td class="num">{q(a.qty)}</td><td><input name={`pick_${a.id}`} type="number" min="0" step="0.001" value={q(a.qty)} style="max-width:120px" aria-label={`Picked ${a.sku_code} ${a.loc_code}`} /></td></tr>)}
        </Table>
        <button class="btn red" type="submit" style="margin-top:10px">Confirm pick</button>
      </form>) : null}
    {o.status === "picked" && w ? (
      <form method="post" action={`${W}/outbound/${id}/dispatch`} class="inline-form" style="margin-top:20px"><Csrf t={csrf} />
        <input name="carrier_ref" type="text" placeholder="Carrier / vehicle / delivery note ref" /><button class="btn red" type="submit">Dispatch</button></form>) : null}
    {o.status === "dispatched" ? <p class="small mute" style="margin-top:14px">Dispatched {dt(o.dispatched_at)}{o.carrier_ref ? ` · ${o.carrier_ref}` : ""}. Any unshipped remainder is closed; backorders are not tracked.</p> : null}
    {d.allocations.length ? <><h3 style="margin-top:24px">Allocations</h3>
      <Table head={["SKU", "Location", "Lot", ["Units", "num"], "Status"]}>{d.allocations.map((a: any) => <tr><td>{a.sku_code}</td><td>{a.loc_code}</td><td>{a.lot || "—"}</td><td class="num">{q(a.qty)}</td><td><Badge s={a.status === "shipped" ? "delivered" : a.status === "released" ? "cancelled" : a.status} /></td></tr>)}</Table></> : null}
  </>));
});
warehouse.post(`${W}/outbound/:id/allocate`, async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  return act(c, `${W}/outbound/${id}`, async () => {
    const r = await withT(c, (cn, ctx) => allocateOutbound(cn, ctx, id, { allowPartial: str(b.partial) === "1" }));
    return { to: `${W}/outbound/${id}`, ok: r.short.length ? `Partly allocated — ${r.short.join(", ")}.` : "Stock allocated." };
  });
});
warehouse.post(`${W}/outbound/:id/pick`, async (c) => {
  const id = c.req.param("id"), b = await formBody(c);
  const picks: Record<string, string> = {};
  for (const [k, v] of Object.entries(b)) if (k.startsWith("pick_")) picks[k.slice(5)] = str(v);
  return act(c, `${W}/outbound/${id}`, async () => {
    const r = await withT(c, (cn, ctx) => confirmPick(cn, ctx, id, picks));
    return { to: `${W}/outbound/${id}`, ok: r.short ? "Pick confirmed with shortages released. Consider counting the affected locations." : "Pick confirmed." };
  });
});
warehouse.post(`${W}/outbound/:id/dispatch`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, `${W}/outbound/${id}`, async () => { await withT(c, (cn, ctx) => dispatchOutbound(cn, ctx, id, { carrier_ref: str(b.carrier_ref) })); return { to: `${W}/outbound/${id}`, ok: "Dispatched. Stock has left your custody." }; }); });
warehouse.post(`${W}/outbound/:id/cancel`, async (c) => { const id = c.req.param("id"); return act(c, `${W}/outbound/${id}`, async () => { await withT(c, (cn, ctx) => cancelOutbound(cn, ctx, id)); return { to: `${W}/outbound`, ok: "Order cancelled; reservations released." }; }); });

// ───────── stock + ledger
warehouse.get(`${W}/stock`, async (c) => {
  need(c, "read");
  const owner = c.req.query("owner") || null;
  const d = await withT(c, async (cn) => ({ rows: await listStock(cn, { ownerId: owner }), customers: await listParties(cn, "customer"), locations: await listLocations(cn) }));
  const csrf = c.get("csrf"), w = can(c, "wh.write");
  return appPage(c, "Stock", (<>
    <PageHead title="Stock in custody" sub="Every row belongs to exactly one customer. Reserved stock is promised to a dispatch order and cannot be moved or removed.">
      <form method="get" action={`${W}/stock`} class="inline-form"><select name="owner" aria-label="Customer" data-autosubmit><option value="">All customers</option>{d.customers.map((p: any) => <option value={p.id} selected={p.id === owner}>{p.name}</option>)}</select><button class="btn ghost sm" type="submit">Filter</button></form>
      <a class="btn ghost sm" href={`${W}/stock/ledger${owner ? `?owner=${owner}` : ""}`}>Movement ledger</a>
    </PageHead>
    <Table head={["Customer", "SKU", "Location", "Lot", ["On hand", "num"], ["Reserved", "num"], ["Free", "num"], "Move"]} empty={d.rows.length ? undefined : "No stock held."}>
      {d.rows.map((s: any) => (
        <tr><td>{s.owner_name}</td><td>{s.sku_code}<div class="small mute">{s.sku_desc}</div></td><td>{s.loc_code} {s.loc_kind === "quarantine" ? <Badge s="warn" label="quarantine" /> : s.loc_kind === "receiving" ? <Badge s="info" label="receiving" /> : null}</td><td>{s.lot || "—"}</td>
          <td class="num">{q(s.qty_on_hand)}</td><td class="num">{q(s.qty_reserved)}</td><td class="num">{q(s.qty_free)}</td>
          <td>{w && Number(s.qty_free) > 0 ? (
            <form method="post" action={`${W}/stock/${s.id}/move`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="client_ref" value={`mv-${rid()}`} />
              <select name="to_location_id" aria-label="To location">{d.locations.filter((l: any) => l.warehouse_code === s.warehouse_code).filter((l: any) => l.id !== s.location_id).map((l: any) => <option value={l.id}>{l.code} · {l.kind}</option>)}</select>
              <input name="qty" type="number" min="0.001" step="0.001" max={q(s.qty_free)} value={q(s.qty_free)} style="max-width:90px" aria-label="Quantity" /><button class="btn ghost sm" type="submit">Move</button></form>) : "—"}</td></tr>))}
    </Table>
  </>));
});
warehouse.post(`${W}/stock/:id/move`, async (c) => {
  const b = await formBody(c);
  return act(c, `${W}/stock`, async () => {
    const r = await withT(c, (cn, ctx) => moveStock(cn, ctx, { stock_id: c.req.param("id"), to_location_id: str(b.to_location_id), qty: str(b.qty), client_ref: str(b.client_ref) }));
    return { to: `${W}/stock`, ok: r.duplicate ? "That move was already recorded." : "Stock moved." };
  });
});
warehouse.get(`${W}/stock/ledger`, async (c) => {
  need(c, "read");
  const owner = c.req.query("owner") || null;
  const rows = await withT(c, (cn) => listMovements(cn, { ownerId: owner, limit: 200 }));
  return appPage(c, "Movement ledger", (<>
    <PageHead title="Movement ledger" sub="Immutable. Every balance is the sum of these rows; corrections are new rows, never edits."><a class="btn ghost sm" href={`${W}/stock`}>Back to stock</a></PageHead>
    <Table head={["When", "Customer", "SKU", "Location", "Lot", ["Δ units", "num"], "Kind", "Reason", "By"]} empty={rows.length ? undefined : "No movements yet."}>
      {rows.map((m: any) => <tr><td class="small nowrap">{dt(m.created_at)}</td><td>{m.owner_name}</td><td>{m.sku_code}</td><td>{m.loc_code}</td><td>{m.lot || "—"}</td><td class="num">{Number(m.qty_delta) > 0 ? "+" : ""}{q(m.qty_delta)}</td><td>{m.kind.replace(/_/g, " ")}</td><td class="small">{m.reason ?? ""}</td><td class="small">{m.by_name ?? "—"}</td></tr>)}
    </Table>
  </>));
});

// ───────── counts
warehouse.get(`${W}/counts`, async (c) => {
  need(c, "read");
  const d = await withT(c, async (cn) => ({ counts: await listCounts(cn), warehouses: await listWarehouses(cn), locations: await listLocations(cn) }));
  const csrf = c.get("csrf");
  return appPage(c, "Counts", (<>
    <PageHead title="Cycle counts" sub="Counters do not see the system quantity. A different person approves each variance, and only if the stock has not moved since the sheet was cut."><a class="btn ghost sm" href={`${W}/count-schedules`}>Reviewed count schedules</a></PageHead>
    <Table head={["Count", "Warehouse", "Scope", ["Lines", "num"], ["Variances", "num"], "Status", "Started"]} empty={d.counts.length ? undefined : "No counts yet."}>
      {d.counts.map((k: any) => <tr><td><a href={`${W}/counts/${k.id}`}>{k.no}</a></td><td>{k.warehouse_code}</td><td>{k.loc_code ?? "whole warehouse"}</td><td class="num">{k.lines}</td><td class="num">{k.status === "open" ? "—" : k.variances}</td><td><Badge s={k.status} /></td><td class="small">{dt(k.created_at)}</td></tr>)}</Table>
    {can(c, "wh.write") && d.warehouses.length ? (
      <form method="post" action={`${W}/counts`} class="inline-form" style="margin-top:16px"><Csrf t={csrf} />
        <select name="warehouse_id" aria-label="Warehouse" required>{d.warehouses.map((w: any) => <option value={w.id}>{w.code}</option>)}</select>
        <select name="location_id" aria-label="Location"><option value="">Whole warehouse</option>{d.locations.map((l: any) => <option value={l.id}>{l.warehouse_code} · {l.code}</option>)}</select>
        <button class="btn red sm" type="submit">Start a count</button></form>) : null}
  </>));
});
warehouse.post(`${W}/counts`, async (c) => {
  const b = await formBody(c);
  return act(c, `${W}/counts`, async () => { const r = await withT(c, (cn, ctx) => startCount(cn, ctx, { warehouse_id: str(b.warehouse_id), location_id: str(b.location_id) || undefined })); return { to: `${W}/counts/${r.id}`, ok: `Count ${r.no} started.` }; });
});
warehouse.get(`${W}/counts/:id`, async (c) => {
  need(c, "read");
  const id = c.req.param("id");
  const d = await withT(c, async (cn) => ({ ...(await getCount(cn, id)), skus: await listSkus(cn), locations: await listLocations(cn) }));
  const k = d.count, csrf = c.get("csrf"), w = can(c, "wh.write"), approver = can(c, "wh.approve");
  const showSystem = k.status !== "open" && approver;   // blind while counting
  const locs = d.locations.filter((l: any) => l.warehouse_code === k.warehouse_code && (!k.location_id || l.id === k.location_id));
  return appPage(c, k.no, (<>
    <PageHead title={`${k.no} · ${k.warehouse_code}`} sub={k.loc_code ? `Location ${k.loc_code}` : "Whole warehouse"}>
      <Badge s={k.status} />
      {k.status === "open" && w ? <><PostBtn action={`${W}/counts/${id}/submit`} csrf={csrf} label="Submit for approval" cls="red sm" /><Confirm action={`${W}/counts/${id}/cancel`} csrf={csrf} label="Cancel count" confirm="Cancel this count? Nothing will be adjusted." /></> : null}
    </PageHead>
    {k.assigned_to?<p>Assigned counter: {k.assigned_counter??'Ask an owner to review the assignment'}.</p>:null}
    <Table head={["Customer", "SKU", "Location", "Lot", ...(showSystem ? [["System", "num"] as [string, string]] : []), ["Counted", "num"], ...(showSystem ? [["Variance", "num"] as [string, string]] : []), "Status", ""]}>
      {d.lines.map((l: any) => { const v = l.counted_qty == null ? null : Math.round((Number(l.counted_qty) - Number(l.system_qty)) * 1000) / 1000;
        return <tr><td>{l.owner_name}</td><td>{l.sku_code}<div class="small mute">{l.sku_desc}</div></td><td>{l.loc_code}</td><td>{l.lot || "—"}</td>
          {showSystem ? <td class="num">{q(l.system_qty)}</td> : null}
          <td class="num">{k.status === "open" && w && ["pending", "counted"].includes(l.status) ? (
            <form method="post" action={`${W}/counts/line/${l.id}`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="count" value={id} /><input name="qty" type="number" min="0" step="0.001" value={l.counted_qty == null ? "" : q(l.counted_qty)} required style="max-width:110px" aria-label={`Counted ${l.sku_code} ${l.loc_code}`} /><button class="btn ghost sm" type="submit">Save</button></form>) : l.counted_qty == null ? "—" : q(l.counted_qty)}</td>
          {showSystem ? <td class="num">{v == null ? "—" : v === 0 ? "0" : <strong>{v > 0 ? `+${v}` : v}</strong>}</td> : null}
          <td><Badge s={l.status === "counted" ? "pending" : l.status === "stale" ? "warn" : l.status} label={l.status === "counted" ? (k.status === "submitted" ? "awaiting decision" : "counted") : l.status} />{l.counted_by_name ? <div class="small mute">{l.counted_by_name}</div> : null}</td>
          <td>{k.status === "submitted" && l.status === "counted" && approver ? <><PostBtn action={`${W}/counts/line/${l.id}/decide`} csrf={csrf} label="Approve adjustment" fields={{ count: id, decision: "approve" }} /><PostBtn action={`${W}/counts/line/${l.id}/decide`} csrf={csrf} label="Reject" cls="ghost sm" fields={{ count: id, decision: "reject" }} /></> : null}</td></tr>; })}
    </Table>
    {k.status === "open" && w ? (
      <form method="post" action={`${W}/counts/${id}/found`} class="inline-form" style="margin-top:14px"><Csrf t={csrf} />
        <select name="sku_id" aria-label="SKU found" required><option value="">Stock found: SKU…</option>{d.skus.map((s: any) => <option value={s.id}>{s.owner_name} · {s.code}</option>)}</select>
        <select name="location_id" aria-label="Where found" required>{locs.map((l: any) => <option value={l.id}>{l.code}</option>)}</select>
        <input name="lot" type="text" placeholder="Lot" style="max-width:110px" /><input name="qty" type="number" min="0.001" step="0.001" placeholder="Qty" required style="max-width:110px" /><button class="btn ghost sm" type="submit">Add found stock</button></form>) : null}
    {k.status === "submitted" && !approver ? <p class="small mute" style="margin-top:12px">Waiting for an approver. Your role can count but not decide variances.</p> : null}
  </>));
});
warehouse.post(`${W}/counts/line/:id`, async (c) => { const b = await formBody(c), cid = str(b.count); return act(c, `${W}/counts/${cid}`, async () => { await withT(c, (cn, ctx) => recordCount(cn, ctx, c.req.param("id"), str(b.qty))); return { to: `${W}/counts/${cid}`, ok: "Count saved." }; }); });
warehouse.post(`${W}/counts/:id/found`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, `${W}/counts/${id}`, async () => { await withT(c, (cn, ctx) => addFoundLine(cn, ctx, id, { sku_id: str(b.sku_id), location_id: str(b.location_id), lot: str(b.lot), qty: str(b.qty) })); return { to: `${W}/counts/${id}`, ok: "Found stock added to the sheet." }; }); });
warehouse.post(`${W}/counts/:id/submit`, async (c) => { const id = c.req.param("id"); return act(c, `${W}/counts/${id}`, async () => { await withT(c, (cn, ctx) => submitCount(cn, ctx, id)); return { to: `${W}/counts/${id}`, ok: "Count submitted. Matching lines are confirmed; variances await an approver." }; }); });
warehouse.post(`${W}/counts/:id/cancel`, async (c) => { const id = c.req.param("id"); return act(c, `${W}/counts/${id}`, async () => { await withT(c, (cn, ctx) => cancelCount(cn, ctx, id)); return { to: `${W}/counts`, ok: "Count cancelled." }; }); });
warehouse.post(`${W}/counts/line/:id/decide`, async (c) => {
  const b = await formBody(c), cid = str(b.count);
  return act(c, `${W}/counts/${cid}`, async () => {
    const r = await withT(c, (cn, ctx) => decideCountLine(cn, ctx, c.req.param("id"), str(b.decision) === "approve"));
    const ok = r.outcome === "stale" ? "Stock moved since this sheet was cut, so the count no longer proves the balance. The line goes back for a recount; nothing was adjusted."
      : r.outcome === "approved" ? (r.delta ? `Adjustment of ${r.delta > 0 ? "+" : ""}${r.delta} posted to the ledger.` : "Confirmed; no adjustment needed.") : "Variance rejected; stock left unchanged.";
    return { to: `${W}/counts/${cid}`, ok };
  });
});

// ───────── setup
warehouse.get(`${W}/setup`, async (c) => {
  need(c, "read");
  const d = await withT(c, async (cn) => ({ warehouses: await listWarehouses(cn), locations: await listLocations(cn), skus: await listSkus(cn), customers: await listParties(cn, "customer") }));
  const csrf = c.get("csrf"), w = can(c, "wh.write");
  return appPage(c, "Warehouse setup", (<>
    <PageHead title="Warehouse setup" sub="Warehouses and locations, and each customer's SKUs. A SKU belongs to one customer; stock is never mixed across owners." />
    <h3>Warehouses</h3>
    <Table head={["Code", "Name", "Address"]} empty={d.warehouses.length ? undefined : "No warehouses yet."}>{d.warehouses.map((x: any) => <tr><td>{x.code}</td><td>{x.name}</td><td class="small">{x.address ?? "—"}</td></tr>)}</Table>
    {w ? <form method="post" action={`${W}/setup/warehouse`} class="inline-form" style="margin:10px 0 22px"><Csrf t={csrf} /><input name="code" type="text" placeholder="Code (e.g. JAFZA1)" required /><input name="name" type="text" placeholder="Name" required /><input name="address" type="text" placeholder="Address" /><button class="btn ghost sm" type="submit">Add warehouse</button></form> : null}
    <h3>Locations</h3>
    <Table head={["Warehouse", "Location", "Kind", ["Capacity", "num"], ["Units in place", "num"]]} empty={d.locations.length ? undefined : "No locations yet."}>{d.locations.map((l: any) => <tr><td>{l.warehouse_code}</td><td>{l.code}</td><td>{l.kind === "quarantine" ? <Badge s="warn" label="quarantine" /> : l.kind}</td><td class="num">{l.capacity_units == null ? "—" : q(l.capacity_units)}</td><td class="num">{q(l.units)}</td></tr>)}</Table>
    {w && d.warehouses.length ? <form method="post" action={`${W}/setup/location`} class="inline-form" style="margin:10px 0 22px"><Csrf t={csrf} />
      <select name="warehouse_id" aria-label="Warehouse">{d.warehouses.map((x: any) => <option value={x.id}>{x.code}</option>)}</select><input name="code" type="text" placeholder="Location code" required />
      <select name="kind" aria-label="Kind"><option value="storage">Storage</option><option value="receiving">Receiving</option><option value="quarantine">Quarantine (damaged / on hold)</option></select>
      <input name="capacity_units" type="number" min="0.001" step="0.001" placeholder="Capacity (units, optional)" /><button class="btn ghost sm" type="submit">Add location</button></form> : null}
    <h3>SKUs</h3>
    <Table head={["Customer", "SKU", "Description", "Unit"]} empty={d.skus.length ? undefined : "No SKUs yet."}>{d.skus.map((s: any) => <tr><td>{s.owner_name}</td><td>{s.code}</td><td>{s.description}</td><td>{s.uom}</td></tr>)}</Table>
    {w && d.customers.length ? <form method="post" action={`${W}/setup/sku`} class="inline-form" style="margin-top:10px"><Csrf t={csrf} />
      <select name="owner_id" aria-label="Customer">{d.customers.map((p: any) => <option value={p.id}>{p.name}</option>)}</select><input name="code" type="text" placeholder="SKU code" required /><input name="description" type="text" placeholder="Description" required /><input name="uom" type="text" placeholder="Unit (carton, pallet…)" /><select name="rotation" aria-label="Stock rotation"><option value="fifo">FIFO</option><option value="fefo">FEFO (expiry required)</option></select><select name="tracking" aria-label="Tracking"><option value="none">Untracked</option><option value="lot">Lot / batch</option><option value="serial">Individual serial</option></select><button class="btn ghost sm" type="submit">Add SKU</button></form> : null}
    {w && !d.customers.length ? <p class="hint">Add a customer under <a href="/app/parties">Customers &amp; suppliers</a> to hold stock for them.</p> : null}
  </>));
});
const S = `${W}/setup`;
warehouse.post(`${S}/warehouse`, async (c) => { const b = await formBody(c); return act(c, S, async () => { await withT(c, (cn, ctx) => createWarehouse(cn, ctx, b)); return { to: S, ok: "Warehouse added." }; }); });
warehouse.post(`${S}/location`, async (c) => { const b = await formBody(c); return act(c, S, async () => { await withT(c, (cn, ctx) => createLocation(cn, ctx, b)); return { to: S, ok: "Location added." }; }); });
warehouse.post(`${S}/sku`, async (c) => { const b = await formBody(c); return act(c, S, async () => { await withT(c, (cn, ctx) => createSku(cn, ctx, b)); return { to: S, ok: "SKU added." }; }); });

// ───────── billing
warehouse.get(`${W}/billing`, async (c) => {
  need(c, "wh.bill");
  const d = await withT(c, async (cn) => ({ summary: await billingSummary(cn), rates: await listRates(cn), customers: await listParties(cn, "customer") }));
  const csrf = c.get("csrf"), fin = can(c, "finance.write");
  return appPage(c, "Warehouse billing", (<>
    <PageHead title="Activity billing" sub="Handling in/out, outbound order fees and daily storage are accrued once per event and invoiced per customer. Activity without a rate is kept, never billed at zero.">
      <PostBtn action={`${W}/billing/storage`} csrf={csrf} label="Accrue storage to yesterday" cls="ghost sm" />
    </PageHead>
    <Table head={["Customer", ["Ready to invoice", "num"], ["Lines", "num"], "Unrated", ""]} empty={d.summary.length ? undefined : "No billable activity yet."}>
      {d.summary.map((s: any) => <tr><td>{s.name}</td><td class="num"><Money v={s.rated_minor} /></td><td class="num">{s.rated_lines}</td><td>{s.unrated_lines ? <Badge s="warn" label={`${s.unrated_lines} need a rate`} /> : "—"}</td>
        <td>{fin && s.rated_lines ? <PostBtn action={`${W}/billing/invoice`} csrf={csrf} label="Invoice" cls="red sm" fields={{ owner_id: s.id }} /> : null}</td></tr>)}</Table>
    <h3 style="margin-top:24px">Rate cards</h3>
    <Table head={["Customer", "Charge", ["Rate", "num"], "Tax", "Effective from"]} empty={d.rates.length ? undefined : "No rates set. Activity will accrue as unrated until you add them."}>
      {d.rates.map((r: any) => <tr><td>{r.owner_name}</td><td>{CHARGE_LABEL[r.charge_type]}</td><td class="num"><Money v={r.unit_minor} /></td><td>{r.tax_code}</td><td>{formatDay(r.effective_from)}</td></tr>)}</Table>
    {d.customers.length ? <form method="post" action={`${W}/billing/rate`} class="inline-form" style="margin-top:10px"><Csrf t={csrf} />
      <select name="owner_id" aria-label="Customer">{d.customers.map((p: any) => <option value={p.id}>{p.name}</option>)}</select>
      <select name="charge_type" aria-label="Charge">{Object.entries(CHARGE_LABEL).map(([k, v]) => <option value={k}>{v}</option>)}</select>
      <input name="amount" type="number" min="0" step="0.01" placeholder="AED per unit" required /><select name="tax_code" aria-label="Tax">{Object.keys(TAX_CODES).map((k) => <option>{k}</option>)}</select>
      <input name="effective_from" type="date" value={dubaiDay()} aria-label="Effective from" /><button class="btn ghost sm" type="submit">Set rate</button></form> : null}
    <p class="hint">Rates apply from their effective date. A rate already in effect cannot be edited — add a new one from a later date. Storage is billed per unit per completed day, from the movement ledger.</p>
  </>));
});
warehouse.post(`${W}/billing/storage`, async (c) => { return act(c, `${W}/billing`, async () => { const r = await withT(c, (cn, ctx) => accrueStorage(cn, ctx)); return { to: `${W}/billing`, ok: `Storage accrued through ${r.through}: ${r.days} customer-day(s) added.` }; }); });
warehouse.post(`${W}/billing/rate`, async (c) => { const b = await formBody(c); return act(c, `${W}/billing`, async () => { const r = await withT(c, (cn, ctx) => setRate(cn, ctx, b)); return { to: `${W}/billing`, ok: r.priced ? `Rate saved; ${r.priced} earlier unrated line(s) priced.` : "Rate saved." }; }); });
warehouse.post(`${W}/billing/invoice`, async (c) => { const b = await formBody(c); return act(c, `${W}/billing`, async () => { const r = await withT(c, (cn, ctx) => invoiceOwner(cn, ctx, str(b.owner_id))); return { to: `/app/invoices/${r.id}`, ok: `Invoice ${r.no} issued from ${r.charges} activity line(s).${r.warnings.length ? " " + r.warnings.join(" ") : ""}` }; }); });
