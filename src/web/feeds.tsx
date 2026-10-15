import { Hono } from "hono";
import { config } from "../config.js";
import { completeConsent, createFeedConnection, listFeeds, pullFeed, setFeedActive, startConsent, withdrawConsent } from "../ops/live-feeds.js";
import { act, appPage, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

export const feeds = new Hono<Env>();
const U = "/app/settings/feeds";
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;

feeds.get(U, async (c) => {
  need(c, "settings.manage");
  const csrf = c.get("csrf");
  const list = await withT(c, (cn) => listFeeds(cn));
  const enabled = config.liveFeeds.allowedHosts.length > 0;
  return appPage(c, "Statement feeds", <>
    <PageHead title="Statement feeds" sub="Pull bank, card-settlement, fuel-card and Salik transactions from your provider's API into the same import and matching you use for CSV files." />
    {enabled ? <p class="small mute">Permitted provider hosts on this installation: {config.liveFeeds.allowedHosts.join(", ")}. Feeds are pulled about every {config.liveFeeds.intervalMinutes} minutes. Nothing is posted to your books automatically: bank lines wait for matching and fuel / Salik lines still need receipt-evidence approval.</p>
      : <div class="alert warn">Live feeds are not enabled on this installation. The administrator must list permitted provider hosts first.</div>}
    <Table head={["Feed", "Kind", "Status", "Last pull", "Added", ""]} empty="No feeds yet.">
      {list.map((f: any) => <tr><td>{f.label}<div class="small mute">{f.url}</div></td><td>{f.kind}</td><td>{f.last_status ? <Badge s={f.last_status === "ok" ? "good" : "bad"} label={f.last_status} /> : "—"}{f.last_error ? <div class="small">{f.last_error}</div> : null}</td>
        <td>{f.last_pull_at ? new Date(f.last_pull_at).toISOString().slice(0, 16).replace("T", " ") : "never"}</td><td>{f.last_added}</td>
        <td>{f.auth_scheme === "oauth2_authcode" ? (f.consented ? <><span class="small mute">Consent until {String(f.consent_expires_at).slice(0, 10)} </span><form method="post" action={`${U}/${f.id}/withdraw`} class="inline-form"><Csrf t={csrf} /><button class="btn ghost sm">Withdraw consent</button></form> </> : <form method="post" action={`${U}/${f.id}/consent`} class="inline-form"><Csrf t={csrf} /><button class="btn sm">Connect account</button></form>) : null}<form method="post" action={`${U}/${f.id}/pull`}><Csrf t={csrf} /><button class="btn ghost sm">Pull now</button></form> <form method="post" action={`${U}/${f.id}/active`}><Csrf t={csrf} /><input type="hidden" name="active" value={f.active ? "0" : "1"} /><button class="btn ghost sm">{f.active ? "Pause" : "Resume"}</button></form></td></tr>)}</Table>
    {enabled ? <form class="card" method="post" action={U}><Csrf t={csrf} /><h2>Add a feed</h2>
      {field("label", "Name", { required: true })}
      <div class="field"><label for="kind">Kind</label><select id="kind" name="kind"><option value="bank">Bank or card settlement</option><option value="fuel">Fuel card</option><option value="salik">Salik</option></select></div>
      {field("url", "Provider address (https)", { type: "url", required: true })}
      <div class="field"><label for="auth_scheme">Authentication</label><select id="auth_scheme" name="auth_scheme"><option value="bearer">Bearer token</option><option value="header">Named header</option><option value="oauth2_client">OAuth2 client credentials (credential as client_id:client_secret)</option><option value="oauth2_authcode">Account-holder consent at the bank (credential as client_id:client_secret)</option></select></div>
      {field("authorize_url", "Consent address (account-holder consent only)", { type: "url" })}
      {field("token_url", "Token address (OAuth2 only)", { type: "url" })}{field("token_scope", "Scope (OAuth2, optional)")}
      {field("auth_header", "Header name (if a named header)")}{field("secret", "Credential from your provider", { type: "password", required: true, autocomplete: "off" })}
      {field("items_path", "Where the list of transactions is in the answer (blank = the answer itself)")}{field("since_param", "Date parameter name", { value: "since" })}
      <div class="field"><label for="response_format">Answer format</label><select id="response_format" name="response_format"><option value="json">JSON</option><option value="csv">CSV (column names are used as field names)</option></select></div>
      <div class="field"><label for="page_mode">Paging</label><select id="page_mode" name="page_mode"><option value="none">One answer</option><option value="page">Page number</option><option value="cursor">Cursor in the answer</option><option value="link">Link header (rel="next")</option></select></div>
      {field("page_param", "Paging parameter name (page / cursor)")}{field("next_path", "Where the next cursor is in the answer (cursor paging)")}{field("max_pages", "Most pages per pull", { type: "number", value: "10", min: "1", max: "50" })}
      <details><summary>Field names in the provider's answer (leave blank if they are id, date, amount, reference, description, plate, litres, direction)</summary>
        {["id", "date", "amount", "reference", "description", "plate", "litres", "direction"].map((k) => field(`map_${k}`, k))}{field("debit_values", "Direction values that mean a debit (comma list)")}
        <div class="field"><label for="amount_unit">Amounts are in</label><select id="amount_unit" name="amount_unit"><option value="major">AED (e.g. 12.50)</option><option value="minor">fils (e.g. 1250)</option></select></div></details>
      <button class="btn">Save feed</button></form> : null}</>);
});
feeds.post(U, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => createFeedConnection(cn, ctx, b)); return { to: U, ok: "Feed saved. It is pulled on the next cycle, or use Pull now." }; }); });
feeds.post(`${U}/:id/consent`, async (c) => {
  need(c, "settings.manage");
  const id = c.req.param("id");
  try { return c.redirect(await withT(c, (cn, ctx) => startConsent(cn, ctx, id))); }
  catch (e: any) { if (e?.status && e.status < 500) { const { back } = await import("./appkit.js"); return back(c, U, undefined, e.message); } throw e; }
});
feeds.get(`${U}/callback`, async (c) => {
  need(c, "settings.manage");
  const q = { code: c.req.query("code"), state: c.req.query("state"), error: c.req.query("error") };
  const { back } = await import("./appkit.js");
  let r: Awaited<ReturnType<typeof completeConsent>>;
  try { r = await withT(c, (cn, ctx) => completeConsent(cn, ctx, q)); }
  catch (e: any) { if (e?.status && e.status < 500) return back(c, U, undefined, e.message); throw e; }
  if (!r.ok) return back(c, U, undefined, r.message);
  return back(c, U, "Account connected. The feed is pulled on the next cycle, or use Pull now.");
});
feeds.post(`${U}/:id/withdraw`, async (c) => { const id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => withdrawConsent(cn, ctx, id)); return { to: U, ok: "Consent withdrawn. The stored tokens were erased and the feed switched off." }; }); });
feeds.post(`${U}/:id/active`, async (c) => { const b = await formBody(c); const id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => setFeedActive(cn, ctx, id, str(b.active) === "1")); return { to: U, ok: "Feed updated." }; }); });
feeds.post(`${U}/:id/pull`, async (c) => {
  need(c, "settings.manage");
  const id = c.req.param("id");
  return act(c, U, async () => {
    const tenantId = await withT(c, async (_cn, ctx) => ctx.tenantId);
    const r = await pullFeed(c.get("db"), tenantId, id);
    if (r.error) throw new (await import("../lib/util.js")).HttpError(400, r.error, "bad_request");
    return { to: U, ok: `Pulled: ${r.added} new line${r.added === 1 ? "" : "s"}.` };
  });
});
