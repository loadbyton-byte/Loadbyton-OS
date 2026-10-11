import { Hono } from "hono";
import { formatDate } from "../lib/util.js";
import {
  claimConversation, conversationChannelInfo, createChannel, discardUnmatched, handleInbound, listChannels, listUnmatched, recordConsent, recordManualReply, resolveUnmatched, setChannelStatus, verifyIdentity,
} from "../ops/inbound.js";
import { act, appPage, can, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

/** Public, signed, tenant-less entry point. Never reads a session; CSRF does not apply to /webhooks/. */
export const inboundHooks = new Hono<Env>();
inboundHooks.all("/webhooks/inbound/:token", async (c) => {
  const raw = c.req.method === "POST" ? await c.req.text() : "";
  const r = await handleInbound(c.get("db"), c.req.param("token"), { method: c.req.method, raw, header: (n) => c.req.header(n), query: (n) => c.req.query(n) });
  if (r.text !== undefined) return c.text(r.text, r.status as any);
  return c.json(r.body as any, r.status as any);
});

export const inboundUi = new Hono<Env>();
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;

/** Rendered inside the conversation page. */
export async function channelPanel(c: any, id: string, url: string, csrf: string, mine: boolean, open: boolean) {
  const info = await withT(c, (cn) => conversationChannelInfo(cn, id));
  if (!info) return null;
  const email = info.kind === "whatsapp" || info.kind === "telephony" ? false : true;
  return <section class="card">
    <h2>Sender and consent</h2>
    <p class="small">{info.label ? `Arrived through ${info.label}. ` : "Captured by staff. "}Identity: <Badge s={info.identity_state === "verified" ? "ok" : "warn"} label={info.identity_state} />
      {info.identity_state === "unverified" ? " — matched to this customer by address only. Verify who is writing before sending any account information." : ""}</p>
    <p class="small">Consent on record — email: {info.consent.email ?? "none"} · WhatsApp: {info.consent.whatsapp ?? "none"} · SMS: {info.consent.sms ?? "none"} · phone: {info.consent.phone ?? "none"}</p>
    {!info.owner_id && open && can(c, "inbox.write") ? <form method="post" action={`${url}/claim`}><Csrf t={csrf} /><button class="btn sm">Take this conversation</button></form> : null}
    {info.identity_state === "unverified" && can(c, "inbox.approve") && info.addresses.length ? <form method="post" action={`${url}/verify`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="party_id" value={info.party_id} />
      <select name="address">{info.addresses.map((a: any) => <option value={`${a.channel ?? "email"}|${a.address}`}>{a.address}</option>)}</select>
      <input name="method" placeholder="Method (e.g. called back number on file)" required /><input name="note" placeholder="What you checked" required /><button class="btn sm">Mark verified</button></form> : null}
    {can(c, "inbox.write") ? <form method="post" action={`${url}/consent`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="party_id" value={info.party_id} />
      <select name="channel"><option>email</option><option>whatsapp</option><option>sms</option><option>phone</option></select><select name="status"><option value="opt_in">Opted in</option><option value="opt_out">Opted out</option></select>
      <input name="source" placeholder="Source (form, call, contract)" required /><input name="evidence" placeholder="Evidence (required for opt-in)" /><button class="btn ghost sm">Record consent</button></form> : null}
    {!email && mine && open && info.accepted_at ? <form method="post" action={`${url}/manual-reply`} class="card"><Csrf t={csrf} /><h3>Record a reply sent from the {info.kind === "whatsapp" ? "WhatsApp Business app" : "phone"}</h3>
      <textarea name="body" required maxlength={8000} placeholder="What was said or sent"></textarea><input name="evidence" placeholder="Provider message id or call reference" required /><button class="btn sm">Record reply</button></form> : null}
  </section>;
}
const post = (path: string, run: (cn: any, ctx: any, id: string, b: Record<string, any>) => Promise<unknown>, ok: string) =>
  inboundUi.post(`/app/inbox/:id/${path}`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, `/app/inbox/${id}`, async () => { await withT(c, (cn, ctx) => run(cn, ctx, id, b)); return { to: `/app/inbox/${id}`, ok }; }); });
post("claim", (cn, ctx, id) => claimConversation(cn, ctx, id), "You now own this conversation.");
post("verify", (cn, ctx, _id, b) => { const [channel, address] = str(b.address).split("|"); return verifyIdentity(cn, ctx, str(b.party_id), channel as any, address, str(b.method), str(b.note)); }, "Identity recorded as verified.");
post("consent", (cn, ctx, _id, b) => recordConsent(cn, ctx, str(b.party_id), str(b.channel), str(b.status) as any, str(b.source), str(b.evidence)), "Consent recorded.");
post("manual-reply", (cn, ctx, id, b) => recordManualReply(cn, ctx, id, str(b.body), str(b.evidence)), "Reply recorded.");

inboundUi.get("/app/inbox-channels", async (c) => {
  need(c, "settings.manage");
  const csrf = c.get("csrf"), rows = await withT(c, (cn) => listChannels(cn));
  return appPage(c, "Inbound channels", <>
    <PageHead title="Inbound channels" sub="Signed webhooks that turn customer email, WhatsApp and calls into conversations. Messages from unknown senders wait in a queue for a person; nothing is answered automatically." />
    <Table head={["Channel", "Type", "Signature", "Target", "Status", "Received", "Unmatched", ""]} empty={rows.length ? undefined : "No channels yet."}>
      {rows.map((r: any) => <tr><td>{r.label}</td><td>{r.kind}</td><td>{r.scheme.replace("_", " ")}</td><td>{r.sla_minutes} business min</td><td><Badge s={r.status} /></td><td>{r.received}</td><td>{r.unmatched ? <a href="/app/inbox-unmatched">{r.unmatched}</a> : 0}</td>
        <td><form method="post" action={`/app/inbox-channels/${r.id}/status`}><Csrf t={csrf} /><button class="btn ghost sm" name="status" value={r.status === "active" ? "paused" : "active"}>{r.status === "active" ? "Pause" : "Resume"}</button></form></td></tr>)}</Table>
    <form class="card" method="post" action="/app/inbox-channels"><Csrf t={csrf} /><h2>Add a channel</h2>
      <div class="field"><label for="kind">Type</label><select id="kind" name="kind"><option value="email">Email relay (signed JSON)</option><option value="whatsapp">WhatsApp Business (Meta Cloud API)</option><option value="telephony">Telephony (Twilio)</option></select></div>
      {field("label", "Name", { required: true })}{field("sla_minutes", "Response target (business minutes)", { type: "number", value: "240", min: "1" })}
      {field("provider_secret", "Meta app secret / Twilio auth token (not needed for an email relay)", { type: "password", autocomplete: "off" })}
      <label class="check"><input type="checkbox" name="thread_reply_implied" value="1" />Treat a customer's own email thread as consent to reply to it (your legal decision; off by default)</label>
      <button class="btn">Create channel</button></form>
    <section class="card"><h2>How channels connect</h2>
      <p class="small">Each channel gets a secret URL shown once. <strong>WhatsApp</strong>: paste the URL as the webhook callback in your Meta app with the verify token shown; Meta signs each request with your app secret. <strong>Telephony</strong>: set the URL as the Twilio messaging / call status webhook; Twilio signs with your auth token. <strong>Email</strong>: your mail relay posts JSON <code>{'{message_id, from, subject, text, in_reply_to}'}</code> with <code>X-LBT-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")</code>. Provider accounts, templates and approvals are yours to obtain; replies to WhatsApp and phone are recorded after you send them from the provider's own app.</p></section>
  </>);
});
inboundUi.post("/app/inbox-channels", async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  try {
    const r = await withT(c, (cn, ctx) => createChannel(cn, ctx, { kind: str(b.kind), label: str(b.label), sla_minutes: str(b.sla_minutes), provider_secret: str(b.provider_secret), thread_reply_implied: str(b.thread_reply_implied) }));
    return appPage(c, "Channel created", <>
      <PageHead title="Channel created" sub="Copy these now. They are not shown again." />
      <section class="card"><p><strong>Webhook URL</strong><br /><code>{r.url}</code></p>{r.secret ? <p><strong>Signing secret</strong><br /><code>{r.secret}</code></p> : <p class="small">Signed with the provider secret you entered.</p>}
        {r.verify_token ? <p><strong>Verify token</strong> (Meta webhook setup)<br /><code>{r.verify_token}</code></p> : null}</section>
      <p><a class="btn" href="/app/inbox-channels">Back to channels</a></p>
      </>);
  } catch (e: any) { if (e?.status && e.status < 500) { const { back } = await import("./appkit.js"); return back(c, "/app/inbox-channels", undefined, e.message); } throw e; }
});
inboundUi.post("/app/inbox-channels/:id/status", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/inbox-channels", async () => { await withT(c, (cn, ctx) => setChannelStatus(cn, ctx, c.req.param("id"), str(b.status) as any)); return { to: "/app/inbox-channels", ok: "Channel updated." }; });
});
inboundUi.get("/app/inbox-unmatched", async (c) => {
  need(c, "inbox.write");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ rows: await listUnmatched(cn), parties: (await cn.query<any>(`SELECT id,name FROM parties WHERE kind='customer' ORDER BY name`)).rows }));
  return appPage(c, "Unmatched messages", <>
    <PageHead title="Unmatched messages" sub="These senders could not be matched to exactly one customer. Link one to a customer, or discard it (the content is erased)." />
    {d.rows.length ? d.rows.map((r: any) => <section class="card"><h2>{r.sender_name ? `${r.sender_name} · ` : ""}{r.sender}</h2><p class="small">{r.label} ({r.kind}) · {formatDate(r.received_at)}{r.subject ? ` · ${r.subject}` : ""}</p><p style="white-space:pre-wrap">{r.body}</p>
      <form method="post" action={`/app/inbox-unmatched/${r.id}/resolve`} class="inline-form"><Csrf t={csrf} /><select name="party_id">{d.parties.map((p: any) => <option value={p.id}>{p.name}</option>)}</select><button class="btn sm">Link to customer</button></form>
      <form method="post" action={`/app/inbox-unmatched/${r.id}/discard`} class="inline-form"><Csrf t={csrf} /><input name="reason" placeholder="Reason" required /><button class="btn ghost sm">Discard and erase</button></form></section>) : <p>Nothing waiting.</p>}
  </>);
});
inboundUi.post("/app/inbox-unmatched/:id/resolve", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/inbox-unmatched", async () => { const conv = await withT(c, (cn, ctx) => resolveUnmatched(cn, ctx, c.req.param("id"), str(b.party_id))); return { to: `/app/inbox/${conv}`, ok: "Linked. The conversation starts unverified." }; });
});
inboundUi.post("/app/inbox-unmatched/:id/discard", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/inbox-unmatched", async () => { await withT(c, (cn, ctx) => discardUnmatched(cn, ctx, c.req.param("id"), str(b.reason))); return { to: "/app/inbox-unmatched", ok: "Discarded and erased." }; });
});
