import { Hono } from "hono";
import { config } from "../config.js";
import { formatDate } from "../lib/util.js";
import { listParties } from "../ops/crm.js";
import { createOrderPull, listOrderPulls, pullOrders, recentPullEvents, setOrderPullActive } from "../ops/order-pull.js";
import { act, appPage, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

export const orderPulls = new Hono<Env>();
const U = "/app/fulfilment/order-pulls";
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;

orderPulls.get(U, async (c) => {
  need(c, "settings.manage");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ pulls: await listOrderPulls(cn), events: await recentPullEvents(cn), merchants: (await listParties(cn, "customer")) as any[] }));
  const enabled = config.liveFeeds.allowedHosts.length > 0;
  return appPage(c, "Order pulls", <>
    <PageHead title="Order pulls" sub="Pull a merchant's orders from a marketplace or shop that offers a REST list of orders. You map its field names; each order becomes a fulfilment order once, and a cancelled order is cancelled here while it has not shipped." />
    {enabled ? <p class="small mute">Permitted provider hosts on this installation: {config.liveFeeds.allowedHosts.join(", ")}. Pulled about every 15 minutes.</p> : <div class="alert warn">No provider hosts are permitted on this installation. The administrator must set FEED_ALLOWED_HOSTS first.</div>}
    <Table head={["Name", "Merchant", "Channel", "Status", "Last pull", "Added", ""]} empty="No pulls yet.">
      {d.pulls.map((p: any) => <tr><td>{p.label}<div class="small mute">{p.url}</div></td><td>{p.party_name}</td><td>{p.channel}</td>
        <td>{p.last_status ? <Badge s={p.last_status === "ok" ? "good" : p.last_status === "attention" ? "warn" : "bad"} label={p.last_status} /> : "—"}{p.last_error ? <div class="small mute">{p.last_error}</div> : null}{p.active ? null : <Badge s="closed" label="off" />}</td>
        <td class="small">{p.last_pull_at ? formatDate(p.last_pull_at) : "never"}</td><td>{p.last_added}</td>
        <td><div class="inline-form"><form method="post" action={`${U}/${p.id}/pull`}><Csrf t={csrf} /><button class="btn ghost sm">Pull now</button></form>
          <form method="post" action={`${U}/${p.id}/active`}><Csrf t={csrf} /><input type="hidden" name="active" value={p.active ? "0" : "1"} /><button class="btn ghost sm">{p.active ? "Switch off" : "Switch on"}</button></form></div></td></tr>)}</Table>
    {enabled && d.merchants.length ? <form class="card" method="post" action={U}><Csrf t={csrf} /><h2>Add an order pull</h2>
      {field("label", "Name", { required: true })}
      <div class="field"><label for="party_id">Merchant</label><select id="party_id" name="party_id">{d.merchants.map((m: any) => <option value={m.id}>{m.name}</option>)}</select></div>
      {field("channel", "Channel name shown on orders", { value: "marketplace" })}{field("url", "Orders address (https)", { type: "url", required: true })}
      <div class="field"><label for="auth_scheme">Authentication</label><select id="auth_scheme" name="auth_scheme"><option value="bearer">Bearer token</option><option value="header">Named header</option><option value="oauth2_client">OAuth2 client credentials (client_id:client_secret)</option></select></div>
      {field("auth_header", "Header name (named header)")}{field("token_url", "Token address (OAuth2)", { type: "url" })}{field("secret", "Credential", { type: "password", required: true, autocomplete: "off" })}
      {field("items_path", "Where the list of orders is in the answer (blank = the answer itself)")}{field("since_param", "Date parameter name", { value: "since" })}
      <div class="field"><label for="page_mode">Paging</label><select id="page_mode" name="page_mode"><option value="none">One answer</option><option value="page">Page number</option><option value="cursor">Cursor in the answer</option><option value="link">Link header</option></select></div>
      {field("page_param", "Paging parameter name")}{field("next_path", "Next-cursor field (cursor paging)")}
      <details open><summary>Field names in each order (dots reach into nested fields; commas join several fields)</summary>
        {field("map_ref", "Order reference", { required: true })}{field("map_name", "Recipient name (e.g. shipping.first_name,shipping.last_name)", { required: true })}{field("map_phone", "Phone")}
        {field("map_address", "Address (e.g. shipping.line1,shipping.line2)", { required: true })}{field("map_city", "City")}{field("map_country", "Country (2 letters)")}
        {field("map_lines_path", "Where the order's lines are", { required: true })}{field("map_sku", "SKU inside a line", { required: true })}{field("map_qty", "Quantity inside a line", { required: true })}
        {field("map_status", "Status field")}{field("accept_values", "Statuses that mean 'ship this' (comma list; blank = all)")}{field("cancel_values", "Statuses that mean cancelled (comma list)")}{field("map_time", "Updated-at field (limits later pulls)")}</details>
      <button class="btn">Save pull</button></form> : null}
    <section class="card"><h2>Recent results</h2><Table head={["Time", "Pull", "Order", "Result", "Detail"]} empty="Nothing yet.">
      {d.events.map((e: any) => <tr><td class="small">{formatDate(e.created_at)}</td><td>{e.label}</td><td>{e.order_ref}</td><td><Badge s={e.outcome === "rejected" ? "bad" : "ok"} label={e.outcome} /></td><td class="small">{e.reason ?? ""}</td></tr>)}</Table></section>
  </>);
});
orderPulls.post(U, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => createOrderPull(cn, ctx, b)); return { to: U, ok: "Pull saved. It runs on the next cycle, or use Pull now." }; }); });
orderPulls.post(`${U}/:id/active`, async (c) => { const b = await formBody(c), id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => setOrderPullActive(cn, ctx, id, str(b.active) === "1")); return { to: U, ok: "Saved." }; }); });
orderPulls.post(`${U}/:id/pull`, async (c) => {
  need(c, "settings.manage");
  const id = c.req.param("id");
  return act(c, U, async () => {
    const tenantId = await withT(c, async (_cn, ctx) => ctx.tenantId);
    const r = await pullOrders(c.get("db"), tenantId, id);
    if (r.error) throw new (await import("../lib/util.js")).HttpError(400, r.error, "bad_request");
    return { to: U, ok: `Pulled: ${r.added} new order(s), ${r.cancelled} cancelled, ${r.rejected} need attention.` };
  });
});
