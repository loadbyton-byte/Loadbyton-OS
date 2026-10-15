import { Hono } from "hono";
import { formatDate } from "../lib/util.js";
import { TRACKING_STATUSES, handleCarrierFeed, listCarrierFeeds, openShipments, registerCarrierFeed, setCarrierFeedStatus } from "../ops/carrier-tracking.js";
import { act, appPage, can, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

/** Signed carrier status pushes: public, tenant-less, no session. */
export const carrierHooks = new Hono<Env>();
carrierHooks.all("/webhooks/carrier/:token", async (c) => {
  const raw = c.req.method === "POST" ? await c.req.text() : "";
  const r = await handleCarrierFeed(c.get("db"), c.req.param("token"), { method: c.req.method, raw, header: (n) => c.req.header(n) });
  return c.json(r.body as any, r.status as any);
});

export const carrierUi = new Hono<Env>();
const U = "/app/fulfilment/carriers";
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;

carrierUi.get(U, async (c) => {
  need(c, "settings.manage");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ feeds: await listCarrierFeeds(cn), open: await openShipments(cn) }));
  return appPage(c, "Carrier tracking", <>
    <PageHead title="Carrier tracking" sub="Receive a carrier's (or tracking aggregator's) status events for the tracking numbers you enter at dispatch. You map the payload field names and the carrier's status words; nothing is hard-wired to one carrier." />
    <Table head={["Name", "Carrier", "Last event", "Events", "State", ""]} empty={d.feeds.length ? undefined : "No carrier feeds yet."}>
      {d.feeds.map((x: any) => <tr><td>{x.label}</td><td>{x.carrier}</td><td class="small">{x.last_seen ? formatDate(x.last_seen) : "none yet"}</td><td>{x.events}</td>
        <td>{x.status === "active" ? <Badge s="ok" label="active" /> : x.status === "paused" ? <Badge s="warn" label="paused" /> : <Badge s="closed" label="retired" />}</td>
        <td>{x.status !== "retired" && can(c, "settings.manage") ? <div class="inline-form">
          <form method="post" action={`${U}/${x.id}/${x.status === "active" ? "pause" : "resume"}`}><Csrf t={csrf} /><button class="btn ghost sm">{x.status === "active" ? "Pause" : "Resume"}</button></form>
          <form method="post" action={`${U}/${x.id}/retire`}><Csrf t={csrf} /><button class="btn ghost sm">Retire</button></form></div> : null}</td></tr>)}</Table>
    <section class="card"><h2>Shipped, not yet delivered</h2>
      <Table head={["Order", "Carrier", "Tracking", "Shipped", "Carrier status"]} empty="Nothing in transit.">
        {d.open.map((o: any) => <tr><td><a href={`/app/fulfilment/orders/${o.id}`}>{o.no}</a></td><td>{o.carrier}</td><td>{o.tracking_no}</td><td class="small">{formatDate(o.shipped_at)}</td>
          <td>{o.carrier_status ? <><Badge s={o.carrier_status === "exception" || o.carrier_status === "returned" ? "bad" : "info"} label={String(o.carrier_status).replace(/_/g, " ")} /><div class="small mute">{formatDate(o.carrier_time)}{o.location ? ` · ${o.location}` : ""}</div></> : <span class="mute">no carrier event yet</span>}</td></tr>)}</Table></section>
    <form class="card" method="post" action={U}><Csrf t={csrf} /><h2>Connect a carrier feed</h2>
      {field("label", "Name", { required: true })}{field("carrier", "Carrier name exactly as typed at dispatch (for example Aramex)", { required: true })}{field("secret", "Signing secret", { type: "password", required: true, minlength: 8, autocomplete: "off" })}
      {field("signature_header", "Header that carries the signature", { required: true, placeholder: "x-signature" })}
      <div class="field"><label for="signature_encoding">Signature is the HMAC-SHA256 of the raw body, written as</label><select id="signature_encoding" name="signature_encoding"><option value="hex">hex</option><option value="base64">base64</option></select></div>
      {field("events_path", "Where the list of events is (blank = the body is one event, or a list)")}{field("tracking_path", "Tracking number field", { required: true, placeholder: "tracking_number" })}{field("status_path", "Status field", { required: true, placeholder: "status" })}
      {field("time_path", "Event time field (ISO 8601; blank = time of receipt)")}{field("location_path", "Location field (optional)")}
      <div class="field"><label for="status_map">Carrier status words → our status, one per line as <code>word = status</code> (our statuses: {TRACKING_STATUSES.join(", ")}). Common wording is understood without this.</label><textarea id="status_map" name="status_map" rows={4}></textarea></div>
      <button class="btn">Create feed</button></form>
  </>);
});
carrierUi.post(U, async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  try {
    const r = await withT(c, (cn, ctx) => registerCarrierFeed(cn, ctx, b));
    return appPage(c, "Carrier feed created", <><PageHead title="Carrier feed created" sub="Give this address and your signing secret to the carrier. It is not shown again." />
      <section class="card"><p><strong>Webhook URL</strong><br /><code>{r.url}</code></p></section><p><a class="btn" href={U}>Back to carrier tracking</a></p></>);
  } catch (e: any) { if (e?.status && e.status < 500) { const { back } = await import("./appkit.js"); return back(c, U, undefined, e.message); } throw e; }
});
const cp = (path: string, status: "active" | "paused" | "retired", ok: string) =>
  carrierUi.post(`${U}/:id/${path}`, async (c) => { const id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => setCarrierFeedStatus(cn, ctx, id, status)); return { to: U, ok }; }); });
cp("pause", "paused", "Feed paused."); cp("resume", "active", "Feed resumed."); cp("retire", "retired", "Feed retired.");
