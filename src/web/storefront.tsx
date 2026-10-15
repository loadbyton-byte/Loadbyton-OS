import { Hono } from "hono";
import { formatDate } from "../lib/util.js";
import { listParties } from "../ops/crm.js";
import { PLATFORMS, handleStorefront, listStorefronts, recentStorefrontEvents, registerStorefront, setStorefrontStatus } from "../ops/storefront.js";
import { act, appPage, can, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

/** Signed storefront order webhooks: public, tenant-less, no session. */
export const storefrontHooks = new Hono<Env>();
storefrontHooks.all("/webhooks/storefront/:token", async (c) => {
  const raw = c.req.method === "POST" ? await c.req.text() : "";
  const r = await handleStorefront(c.get("db"), c.req.param("token"), { method: c.req.method, raw, header: (n) => c.req.header(n) });
  return c.json(r.body as any, r.status as any);
});

export const storefrontUi = new Hono<Env>();
const U = "/app/fulfilment/connectors";

storefrontUi.get(U, async (c) => {
  need(c, "settings.manage");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ conns: await listStorefronts(cn), events: await recentStorefrontEvents(cn), merchants: (await listParties(cn, "customer")) as any[] }));
  return appPage(c, "Storefront connectors", <>
    <PageHead title="Storefront connectors" sub="Connect a merchant's Shopify or WooCommerce store. Paid and cash-on-delivery orders arrive as fulfilment orders, each exactly once; cancellations cancel the order while it has not shipped." />
    <Table head={["Name", "Merchant", "Platform", "Last order event", "Orders", "Refused", "State", ""]} empty={d.conns.length ? undefined : "No stores connected."}>
      {d.conns.map((x: any) => <tr><td>{x.label}</td><td>{x.party_name}</td><td>{PLATFORMS[x.platform as keyof typeof PLATFORMS].name}</td><td class="small">{x.last_seen ? formatDate(x.last_seen) : "none yet"}</td><td>{x.ingested}</td><td>{x.rejected}</td>
        <td>{x.status === "active" ? <Badge s="ok" label="active" /> : x.status === "paused" ? <Badge s="warn" label="paused" /> : <Badge s="closed" label="retired" />}</td>
        <td>{x.status !== "retired" && can(c, "settings.manage") ? <div class="inline-form">
          <form method="post" action={`${U}/${x.id}/${x.status === "active" ? "pause" : "resume"}`}><Csrf t={csrf} /><button class="btn ghost sm">{x.status === "active" ? "Pause" : "Resume"}</button></form>
          <form method="post" action={`${U}/${x.id}/retire`}><Csrf t={csrf} /><button class="btn ghost sm">Retire</button></form></div> : null}</td></tr>)}</Table>
    <form class="card" method="post" action={U}><Csrf t={csrf} /><h2>Connect a store</h2>
      <div class="field"><label for="platform">Platform</label><select id="platform" name="platform">{Object.entries(PLATFORMS).map(([k, v]) => <option value={k}>{v.name}</option>)}</select></div>
      <div class="field"><label for="party_id">Merchant</label><select id="party_id" name="party_id">{d.merchants.map((m: any) => <option value={m.id}>{m.name}</option>)}</select></div>
      <div class="field"><label for="label">Name</label><input id="label" name="label" required /></div>
      <div class="field"><label for="secret">Webhook signing secret</label><input id="secret" name="secret" type="password" autocomplete="off" required minlength={8} /></div>
      <button class="btn">Create connection</button></form>
    <section class="card"><h2>How a store is set up</h2>
      {Object.values(PLATFORMS).map((p) => <p class="small"><strong>{p.name}.</strong> {p.hint}</p>)}
      <p class="small">Each order line is matched to the merchant's catalogue by <strong>SKU</strong>; an unknown SKU is refused and, on Shopify, redelivered automatically once you add it. Stock levels are not sent back to the store.</p></section>
    <section class="card"><h2>Recent deliveries</h2>
      <Table head={["Time", "Connection", "Event", "Result", "Detail"]} empty={d.events.length ? undefined : "No deliveries yet."}>
        {d.events.map((e: any) => <tr><td class="small">{formatDate(e.received_at)}</td><td>{e.label}</td><td class="small">{e.event_ref} <span class="mute">({e.topic})</span></td>
          <td>{e.outcome === "rejected" ? <Badge s="bad" label={e.recoverable ? "refused, redeliverable" : "refused"} /> : <Badge s="ok" label={e.outcome} />}</td><td class="small">{e.reason ?? ""}</td></tr>)}</Table></section>
  </>);
});
storefrontUi.post(U, async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  try {
    const r = await withT(c, (cn, ctx) => registerStorefront(cn, ctx, { platform: str(b.platform), party_id: str(b.party_id), label: str(b.label), secret: str(b.secret) }));
    return appPage(c, "Store connected", <><PageHead title="Store connected" sub="Paste this address into the store's webhook settings. It is not shown again." />
      <section class="card"><p><strong>Webhook URL</strong><br /><code>{r.url}</code></p></section><p><a class="btn" href={U}>Back to connectors</a></p></>);
  } catch (e: any) { if (e?.status && e.status < 500) { const { back } = await import("./appkit.js"); return back(c, U, undefined, e.message); } throw e; }
});
const sp = (path: string, status: "active" | "paused" | "retired", ok: string) =>
  storefrontUi.post(`${U}/:id/${path}`, async (c) => { const id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => setStorefrontStatus(cn, ctx, id, status)); return { to: U, ok }; }); });
sp("pause", "paused", "Connection paused. The store will redeliver when you resume.");
sp("resume", "active", "Connection resumed.");
sp("retire", "retired", "Connection retired.");
