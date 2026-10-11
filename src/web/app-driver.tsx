import { Hono } from "hono";
import crypto from "node:crypto";
import { HttpError, formatDate } from "../lib/util.js";
import { applyDriverEvent, getTrip, listTrips, syncDriverEvents, type DriverEvent } from "../ops/transport.js";
import { storeDocument } from "../ops/documents.js";
import {uploadExpenseReceipt} from '../ops/expense-receipts.js';
import { formBody, str, type Env } from "./mw.js";
import { appPage, ctxOf, need, withT, back, PageHead } from "./appkit.js";
import { Badge, Csrf } from "./ui.js";

export const driver = new Hono<Env>();
const D = "/app/driver";
const newId = () => crypto.randomUUID();

// Large-touch-target driver surface. Works without JavaScript (plain forms); with JavaScript, actions are queued on the
// phone when offline and synced later under their client-generated ids (assets/driver.js).
driver.get(D, async (c) => {
  need(c, "driver.act");
  const ctx = ctxOf(c);
  const trips = await withT(c, (cn) => listTrips(cn, { driverId: ctx.driverId, activeOnly: true }));
  return appPage(c, "My trips", (<>
    <PageHead title="My trips">{c.get("tenant")!.sectors.includes("courier-last-mile") ? <a class="btn red big" href="/app/driver/deliveries">My parcels</a> : null}</PageHead>
    <div id="offline-banner" class="alert warn" hidden>Saved on this phone — will sync when you are back online.</div>
    {trips.length ? trips.map((t: any) => (
      <a class="card driver-card" href={`${D}/trips/${t.id}`}>
        <h2>{t.no} <Badge s={t.status} /></h2>
        <p>{t.legs_done} of {t.legs} stops done · starts {formatDate(t.planned_start)}</p>
        <span class="btn red big">Open trip</span>
      </a>)) : <div class="card"><p>No trips assigned to you right now.</p></div>}
  </>));
});

driver.get(`${D}/trips/:id`, async (c) => {
  need(c, "driver.act");
  const ctx = ctxOf(c), id = c.req.param("id");
  const d = await withT(c, (cn) => getTrip(cn, id));
  if (d.trip.driver_id !== ctx.driverId) throw new HttpError(404, "Trip not found");
  const csrf = c.get("csrf");
  const live = ["dispatched", "in_progress"].includes(d.trip.status);
  const next = d.legs.find((l: any) => l.status !== "done");
  const form = (kind: string, leg: any, label: string, cls: string, extra?: any) => (
    <form method="post" action={`${D}/trips/${id}/event`} data-driver-form="1" class="driver-form">
      <Csrf t={csrf} /><input type="hidden" name="kind" value={kind} /><input type="hidden" name="leg_id" value={leg?.id ?? ""} />
      <input type="hidden" name="trip_id" value={id} /><input type="hidden" name="client_event_id" value={newId()} /><input type="hidden" name="device_time" value="" />
      {extra}<button class={`btn big ${cls}`} type="submit">{label}</button>
    </form>);
  return appPage(c, d.trip.no, (<>
    <PageHead title={`Trip ${d.trip.no}`} sub={d.trip.reg_no}><a class="btn ghost sm" href={D}>← My trips</a></PageHead>
    <div id="offline-banner" class="alert warn" hidden>Saved on this phone — will sync when you are back online.</div>
    {!live ? <div class="alert info">This trip is {d.trip.status}. {d.trip.status === "planned" ? "Wait for dispatch." : ""}</div> : null}
    {d.legs.map((l: any) => (
      <section class={`card leg ${l.status === "done" ? "done" : l === next ? "current" : ""}`}>
        <h2>{l.seq}. {l.kind === "pickup" ? "Pick up" : "Deliver"} · {l.order_no}</h2>
        <p class="addr">{l.address}</p><p class="mute small">{l.customer}{l.planned_at ? ` · by ${formatDate(l.planned_at)}` : ""}</p>
        <p>{l.arrived_at ? <>Arrived {formatDate(l.arrived_at)} </> : null}{l.departed_at ? <>· Left {formatDate(l.departed_at)}</> : null}{l.pod_name ? <> · Received by <strong>{l.pod_name}</strong></> : null}</p>
        {live && l.status !== "done" && l === next ? (<>
          {!l.arrived_at ? form("arrive", l, "I have arrived", "red") : null}
          {l.arrived_at && l.kind === "delivery" && !l.pod_name ? form("pod", l, "Record proof of delivery", "red", (
            <div class="field"><label for={`n${l.id}`}>Who received the goods? (name)</label><input id={`n${l.id}`} name="p_name" type="text" required autocomplete="off" /></div>)) : null}
          {l.arrived_at && (l.kind === "pickup" || l.pod_name) ? form("depart", l, "I am leaving", "red") : null}
          {l.kind === "delivery" && l.arrived_at && !l.pod_name ? (
            <form method="post" action={`${D}/trips/${id}/photo`} enctype="multipart/form-data" class="driver-form"><Csrf t={csrf} /><input type="hidden" name="leg_id" value={l.id} />
              <div class="field"><label for={`p${l.id}`}>Photo of delivery note (needs signal)</label><input id={`p${l.id}`} name="file" type="file" accept="image/*" capture="environment" required /></div>
              <button class="btn big ghost" type="submit">Upload photo</button></form>) : null}
        </>) : null}
      </section>))}
    {live ? (<>
      <section class="card"><h2>Fuel or toll</h2>
        {form("expense", null, "Save expense", "ghost", (<div class="row">
          <div class="field"><label for="xk">Type</label><select id="xk" name="p_kind"><option value="fuel">Fuel</option><option value="toll">Toll (Salik)</option><option value="parking">Parking</option><option value="other">Other</option></select></div>
          <div class="field"><label for="xa">Amount (AED)</label><input id="xa" name="p_amount" type="number" inputmode="decimal" min="0.01" step="0.01" required /></div></div>))}
        <p class="small mute">Your office approves expenses before they count as cost.</p></section>
      <section class="card"><h2>Report a problem</h2>
        {form("exception", null, "Send to dispatcher", "danger", (<div class="field"><label for="xt">What happened?</label><input id="xt" name="p_text" type="text" required /></div>))}</section>
    </>) : null}
    {d.expenses.filter(x=>x.recorded_by===ctx.userId).length?<section class="card"><h2>Expense receipts</h2><p>Upload the actual supplier receipt when connected. The office must independently approve it before the expense counts as trip cost.</p>{d.expenses.filter(x=>x.recorded_by===ctx.userId).map(x=><div><p>{x.kind} · AED {(Number(x.amount_minor)/100).toFixed(2)} · {x.status}</p>{x.receipt_document_id?<a href={`/app/documents/${x.receipt_document_id}/download`}>Receipt evidence</a>:null}{x.status==='recorded'?<form method="post" action={`${D}/expenses/${x.id}/receipt`} enctype="multipart/form-data"><Csrf t={csrf}/><input type="hidden" name="reference" value={newId()}/><label>Actual supplier name printed on receipt<input name="issuer" required maxlength={200}/></label><label>Receipt photo or PDF (needs signal)<input name="file" type="file" accept="image/*,.pdf" required/></label><button class="btn big ghost">Upload expense receipt</button></form>:null}</div>)}</section>:null}
    <p class="small mute">Actions are timestamped on your phone and saved there if you lose signal, then synced automatically. Open this page once while online before going into a low-signal area.</p>
  </>));
});

const toEvent = (b: Record<string, any>): DriverEvent => {
  const payload: Record<string, any> = {};
  for (const [k, v] of Object.entries(b)) if (k.startsWith("p_")) payload[k.slice(2)] = String(v);
  return {
    client_event_id: str(b.client_event_id), trip_id: str(b.trip_id), leg_id: str(b.leg_id) || null,
    kind: str(b.kind) as any, device_time: str(b.device_time) || new Date().toISOString(), payload,
  };
};

// plain form post (no-JS path / online path)
driver.post(`${D}/trips/:id/event`, async (c) => {
  need(c, "driver.act");
  const id = c.req.param("id"), b = await formBody(c);
  const ev = toEvent({ ...b, trip_id: id });
  const r = await withT(c, (cn, ctx) => applyDriverEvent(cn, ctx, ev));
  const msg = r.outcome === "applied" ? "Saved." : r.outcome === "duplicate" ? "Already saved." : null;
  return back(c, `${D}/trips/${id}`, msg ?? undefined, msg ? undefined : r.reason ?? "That could not be applied.");
});

// JSON batch sync from the offline queue. CSRF is the signed double-submit token sent as a header (see mw.ts).
driver.post(`${D}/sync`, async (c) => {
  need(c, "driver.act");
  let body: any;
  try { body = await c.req.json(); } catch { throw new HttpError(400, "Invalid JSON"); }
  const events: DriverEvent[] = Array.isArray(body?.events) ? body.events.map((e: any) => ({ ...e, payload: e.payload ?? {} })) : [];
  const results = await withT(c, (cn, ctx) => syncDriverEvents(cn, ctx, events));
  return c.json({ results });
});
driver.post(`${D}/expenses/:id/receipt`,async c=>{
 need(c,'driver.act');const b=await formBody(c);try{const file=b.file;if(!(file instanceof File))throw new HttpError(400,'Choose the actual receipt.');const data=Buffer.from(await file.arrayBuffer());
 const trip=await withT(c,async(cn,ctx)=>{await uploadExpenseReceipt(cn,ctx,c.req.param('id'),{filename:file.name,data,issuer:str(b.issuer)},str(b.reference));return (await cn.query<any>(`SELECT trip_id FROM trip_expenses WHERE id=$1`,[c.req.param('id')])).rows[0].trip_id;});return back(c,`${D}/trips/${trip}`,'Receipt stored for independent office review.');
 }catch(e){if(e instanceof HttpError&&e.status<500)return back(c,D,undefined,e.message);throw e;}
});

// POD / delivery-note photo (multipart, online only)
driver.post(`${D}/trips/:id/photo`, async (c) => {
  need(c, "driver.act");
  const ctx = ctxOf(c), id = c.req.param("id"), b = await formBody(c);
  try {
    const f = b.file;
    if (!(f instanceof File)) throw new HttpError(400, "Choose a photo.");
    const data = Buffer.from(await f.arrayBuffer());
    await withT(c, async (cn, cx) => {
      const leg = (await cn.query<any>(`SELECT l.*, t.driver_id FROM trip_legs l JOIN trips t ON t.id=l.trip_id WHERE l.id=$1 AND l.trip_id=$2`, [str(b.leg_id), id])).rows[0];
      if (!leg || leg.driver_id !== cx.driverId) throw new HttpError(404, "Stop not found");
      await storeDocument(cn, cx, { trip_id: id, transport_order_id: leg.order_id, kind: "pod", title: `Delivery photo ${leg.seq}`, filename: f.name || "photo.jpg", data });
    });
    return back(c, `${D}/trips/${id}`, "Photo uploaded.");
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return back(c, `${D}/trips/${id}`, undefined, e.message);
    throw e;
  }
});
