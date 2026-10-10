import { Hono } from "hono";
import crypto from "node:crypto";
import { HttpError, formatDate, fmtMoney } from "../lib/util.js";
import { FAIL_REASONS, applyRiderEvent, getRun, riderHome, syncRiderEvents, type RiderEvent } from "../ops/delivery.js";
import { applyDriverEvent, getTrip, listTrips, syncDriverEvents, type DriverEvent } from "../ops/transport.js";
import { storeDocument } from "../ops/documents.js";
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
  const home = c.get("tenant")!.sectors.includes("courier-last-mile") ? await withT(c, (cn) => riderHome(cn, ctx.driverId!)) : null;
  return appPage(c, "My work", (<>
    <PageHead title="My work" />
    <div id="offline-banner" class="alert warn" hidden>Saved on this phone — will sync when you are back online.</div>
    {home ? (<>
      {home.cash.parcels ? <div class="alert info"><strong>Cash on you: {fmtMoney(home.cash.amount_minor)}</strong> from {home.cash.parcels} parcel(s). Hand it in at the cash desk at the end of your run.</div> : null}
      {home.runs.map((r: any) => (
        <a class="card driver-card" href={`${D}/runs/${r.id}`}>
          <h2>{r.no} <Badge s={r.status === "out" ? "info" : "draft"} label={r.status === "out" ? "out" : "not started"} /></h2>
          <p>{r.delivered} of {r.parcels} delivered · cash to collect {fmtMoney(r.cod_minor)}</p>
          <span class="btn red big">Open run</span>
        </a>))}
    </>) : null}
    {trips.length ? trips.map((t: any) => (
      <a class="card driver-card" href={`${D}/trips/${t.id}`}>
        <h2>{t.no} <Badge s={t.status} /></h2>
        <p>{t.legs_done} of {t.legs} stops done · starts {formatDate(t.planned_start)}</p>
        <span class="btn red big">Open trip</span>
      </a>)) : (home && (home.runs.length || home.cash.parcels)) ? null : <div class="card"><p>Nothing assigned to you right now.</p></div>}
  </>));
});

// ───────── delivery runs
driver.get(`${D}/runs/:id`, async (c) => {
  need(c, "driver.act");
  const ctx = ctxOf(c), id = c.req.param("id");
  const d = await withT(c, (cn) => getRun(cn, id));
  if (d.run.driver_id !== ctx.driverId) throw new HttpError(404, "Run not found");
  const csrf = c.get("csrf"), live = d.run.status === "out";
  if (!live && d.run.status !== "closed") d.shipments = [];          // consignee details and cash amounts are shown only once the office has sent the rider out
  const open = d.shipments.filter((s: any) => ["out_for_delivery", "undelivered"].includes(s.status) && live);
  const form = (kind: string, s: any, label: string, cls: string, extra?: any) => (
    <form method="post" action={`${D}/parcels/${s.id}/event`} data-driver-form="1" class="driver-form">
      <Csrf t={csrf} /><input type="hidden" name="kind" value={kind} /><input type="hidden" name="shipment_id" value={s.id} />
      <input type="hidden" name="client_event_id" value={newId()} /><input type="hidden" name="device_time" value="" />
      {extra}<button class={`btn big ${cls}`} type="submit">{label}</button>
    </form>);
  return appPage(c, d.run.no, (<>
    <PageHead title={`Run ${d.run.no}`} sub={live ? `${open.length} to deliver` : undefined}><a class="btn ghost sm" href={D}>← My work</a></PageHead>
    <div id="offline-banner" class="alert warn" hidden>Saved on this phone — will sync when you are back online.</div>
    {!live ? <div class="alert info">This run is {d.run.status === "planned" ? "not started yet. Wait for the office to send you out." : d.run.status}.</div> : null}
    {d.shipments.map((s: any) => {
      const cod = Number(s.cod_minor), canAct = live && ["out_for_delivery", "undelivered"].includes(s.status);
      return (
        <section class={`card leg ${s.status === "delivered" ? "done" : canAct ? "current" : ""}`}>
          <h2>{s.no} <Badge s={s.status === "out_for_delivery" ? "info" : s.status === "undelivered" ? "warn" : s.status} label={s.status.replace(/_/g, " ")} /></h2>
          <p><strong>{s.consignee_name}</strong>{s.consignee_phone ? <> · <a href={`tel:${s.consignee_phone}`}>{s.consignee_phone}</a></> : null}</p>
          <p class="addr">{s.address}, {s.emirate}</p>
          <p>{cod ? <strong>Collect {fmtMoney(cod)} in cash</strong> : <span class="mute">Prepaid — take no cash</span>}{s.attempts ? <span class="mute"> · attempt {s.attempts} of {s.max_attempts} used</span> : null}</p>
          {s.last_failure && s.status === "undelivered" ? <p class="small mute">Last time: {s.last_failure}</p> : null}
          {s.status === "delivered" ? <p>Received by <strong>{s.delivered_to}</strong> · {formatDate(s.delivered_at)}</p> : null}
          {canAct ? (<>
            {form("deliver", s, cod ? `Delivered — I collected ${fmtMoney(cod)}` : "Delivered", "red", (<>
              <div class="field"><label for={`n${s.id}`}>Who received it? (name)</label><input id={`n${s.id}`} name="p_name" type="text" required autocomplete="off" /></div>
              {cod ? <div class="field"><label for={`c${s.id}`}>Cash collected (AED) — must match exactly</label><input id={`c${s.id}`} name="p_cash" type="number" inputmode="decimal" step="0.01" min="0" required autocomplete="off" /></div> : null}
              {s.require_code ? <div class="field"><label for={`k${s.id}`}>Delivery code (ask the customer)</label><input id={`k${s.id}`} name="p_code" type="text" inputmode="numeric" pattern="[0-9]{4}" maxlength={4} required autocomplete="off" /></div> : null}
            </>))}
            {form("fail", s, "Could not deliver", "ghost", (<>
              <div class="field"><label for={`r${s.id}`}>Why not?</label><select id={`r${s.id}`} name="p_reason">{Object.entries(FAIL_REASONS).map(([k, v]) => <option value={k}>{v}</option>)}</select></div>
              <div class="field"><label for={`t${s.id}`}>Note (optional)</label><input id={`t${s.id}`} name="p_note" type="text" autocomplete="off" /></div></>))}
            <form method="post" action={`${D}/parcels/${s.id}/photo`} enctype="multipart/form-data" class="driver-form"><Csrf t={csrf} /><input type="hidden" name="run_id" value={id} />
              <div class="field"><label for={`p${s.id}`}>Photo of the parcel at the door (needs signal)</label><input id={`p${s.id}`} name="file" type="file" accept="image/*" capture="environment" required /></div>
              <button class="btn big ghost" type="submit">Upload photo</button></form>
          </>) : null}
        </section>);
    })}
    <p class="small mute">Never hand over a COD parcel without the exact cash. If the customer cannot pay, choose “Could not deliver”. Actions are timestamped on your phone and synced automatically if you lose signal.</p>
  </>));
});

const toRiderEvent = (b: Record<string, any>): RiderEvent => {
  const payload: Record<string, any> = {};
  for (const [k, v] of Object.entries(b)) if (k.startsWith("p_")) payload[k.slice(2)] = String(v);
  return { client_event_id: str(b.client_event_id), shipment_id: str(b.shipment_id), kind: str(b.kind) as any, device_time: str(b.device_time) || new Date().toISOString(), payload };
};
driver.post(`${D}/parcels/:id/event`, async (c) => {
  need(c, "driver.act");
  const id = c.req.param("id"), b = await formBody(c);
  const ev = toRiderEvent({ ...b, shipment_id: id });
  const runId = await withT(c, async (cn) => (await cn.query<any>(`SELECT run_id FROM dlv_shipments WHERE id=$1`, [id])).rows[0]?.run_id);
  const back2 = runId ? `${D}/runs/${runId}` : D;
  try {
    const r = await withT(c, (cn, ctx) => applyRiderEvent(cn, ctx, ev));
    const msg = r.outcome === "applied" ? "Saved." : r.outcome === "duplicate" ? "Already saved." : null;
    return back(c, back2, msg ?? undefined, msg ? undefined : r.reason ?? "That could not be applied.");
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return back(c, back2, undefined, e.message);
    throw e;
  }
});
driver.post(`${D}/parcels/:id/photo`, async (c) => {
  need(c, "driver.act");
  const id = c.req.param("id"), b = await formBody(c), runId = str(b.run_id);
  try {
    const f = b.file;
    if (!(f instanceof File)) throw new HttpError(400, "Choose a photo.");
    const data = Buffer.from(await f.arrayBuffer());
    await withT(c, async (cn, cx) => {
      const s = (await cn.query<any>(`SELECT s.no, r.driver_id FROM dlv_shipments s JOIN dlv_runs r ON r.id=s.run_id WHERE s.id=$1`, [id])).rows[0];
      if (!s || s.driver_id !== cx.driverId) throw new HttpError(404, "Parcel not found");
      await storeDocument(cn, cx, { dlv_shipment_id: id, kind: "pod", title: `Delivery photo ${s.no}`, filename: f.name || "photo.jpg", data });
    });
    return back(c, `${D}/runs/${runId}`, "Photo uploaded.");
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return back(c, `${D}/runs/${runId}`, undefined, e.message);
    throw e;
  }
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
  const all: any[] = Array.isArray(body?.events) ? body.events.map((e: any) => ({ ...e, payload: e.payload ?? {} })) : [];
  if (all.length > 100) throw new HttpError(400, "Send between 1 and 100 events per sync.");
  const parcelEvents: RiderEvent[] = all.filter((e) => e.shipment_id), tripEvents: DriverEvent[] = all.filter((e) => !e.shipment_id);
  const results = await withT(c, async (cn, ctx) => [
    ...(tripEvents.length ? await syncDriverEvents(cn, ctx, tripEvents) : []),
    ...(parcelEvents.length ? await syncRiderEvents(cn, ctx, parcelEvents) : []),
  ]);
  return c.json({ results });
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
