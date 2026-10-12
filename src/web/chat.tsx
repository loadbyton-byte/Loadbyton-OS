import { Hono } from "hono";
import type { Db } from "../db/client.js";
import { config } from "../config.js";
import { HttpError, baseUrl, randomToken, sha256 } from "../lib/util.js";
import { rateLimit } from "../lib/ratelimit.js";
import { currentPlans } from "../platform/catalog.js";
import { answer } from "../platform/knowledge.js";
import { chatStaffed } from "./brand.js";
import { AdminShell, Badge, Csrf, type Page } from "./ui.js";
import { Icon } from "./experience.js";
import { clientIp, formBody, requireStaff, str, type C, type Env } from "./mw.js";
import { audit } from "../lib/audit.js";

/** Public chat endpoints (assistant + live chat) and the staff inbox in the control console. */
export const chat = new Hono<Env>();

const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

async function json(c: C): Promise<Record<string, any>> {
  if (!(c.req.header("content-type") ?? "").includes("application/json")) throw new HttpError(415, "Unsupported content type");
  try { const b = await c.req.json(); return b && typeof b === "object" ? b : {}; } catch { throw new HttpError(400, "Invalid request"); }
}
const visitorToken = (c: C) => {
  const t = c.req.header("x-chat-token") ?? "";
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(t)) throw new HttpError(401, "Chat session missing");
  return t;
};
const who = (c: C) => clientIp(c) || "local";

const publicMsg = (m: any) => ({ id: Number(m.id), from: m.sender, name: m.staff_name ?? undefined, text: m.body, at: m.created_at });

// ── assistant: stateless, answers from the product knowledge base
chat.post("/chat/bot", async (c) => {
  await rateLimit(`chatbot:${who(c)}`, 40, 60, "You are asking quickly. Please wait a moment.");
  const b = await json(c);
  const plans = await currentPlans(c.get("db"));
  return c.json(answer(clean(b.q, 500), plans));
});

// ── live chat: visitor side. The browser holds a random secret; only its hash is stored.
async function threadFor(db: Db, token: string) {
  return (await db.query<any>(`SELECT * FROM chat_threads WHERE visitor_hash=$1`, [sha256(token)])).rows[0] as any | undefined;
}
async function state(db: Db, t: any, after = 0) {
  const msgs = (await db.query<any>(`SELECT id,sender,staff_name,body,created_at FROM chat_messages WHERE thread_id=$1 AND id>$2 ORDER BY id LIMIT 200`, [t.id, after])).rows;
  if (msgs.some((m) => m.sender !== "visitor")) await db.query(`UPDATE chat_threads SET visitor_unread=0 WHERE id=$1`, [t.id]);
  return { thread: { status: t.status, staffed: chatStaffed() }, messages: msgs.map(publicMsg) };
}

chat.post("/chat/live/send", async (c) => {
  const db = c.get("db"), token = visitorToken(c);
  await rateLimit(`chat-send:${sha256(token).slice(0, 16)}`, 20, 60, "You are sending messages quickly. Please wait a moment.");
  await rateLimit(`chat-ip:${who(c)}`, 60, 600, "Too many chat messages from this connection. Please try again later.");
  const b = await json(c);
  const body = clean(b.message, 2000);
  if (!body) throw new HttpError(400, "Write a message first.");
  let t = await threadFor(db, token);
  if (!t) {
    const name = clean(b.name, 120) || null, email = clean(b.email, 254).toLowerCase() || null;
    if (email && !validEmail(email)) throw new HttpError(400, "That email address does not look right.");
    t = (await db.query<any>(`INSERT INTO chat_threads(visitor_hash,name,email,page) VALUES ($1,$2,$3,$4) RETURNING *`, [sha256(token), name, email, clean(b.page, 200) || null])).rows[0];
    await db.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES (NULL,'email',$1,$2) ON CONFLICT DO NOTHING`, [`chat-started:${t.id}`, JSON.stringify({ template: "chat_started", threadId: t.id, name: name ?? "A visitor", email, page: clean(b.page, 200), first: body.slice(0, 600) })]);
  } else if (t.status === "closed") {
    await db.query(`UPDATE chat_threads SET status='open', closed_at=NULL WHERE id=$1`, [t.id]);
  }
  await db.query(`INSERT INTO chat_messages(thread_id,sender,body) VALUES ($1,'visitor',$2)`, [t.id, body]);
  await db.query(`UPDATE chat_threads SET status='open', staff_unread=staff_unread+1, last_visitor_at=now(), updated_at=now() WHERE id=$1`, [t.id]);
  t = await threadFor(db, token);
  return c.json(await state(db, t, Number(b.after) || 0));
});

chat.get("/chat/live/poll", async (c) => {
  const db = c.get("db"), token = visitorToken(c);
  await rateLimit(`chat-poll:${sha256(token).slice(0, 16)}`, 60, 60, "Polling too quickly.");
  const t = await threadFor(db, token);
  if (!t) return c.json({ thread: null, messages: [], staffed: chatStaffed() });
  return c.json({ ...(await state(db, t, Number(c.req.query("after")) || 0)), staffed: chatStaffed() });
});

// ── staff inbox
chat.use("/admin/chats", requireStaff);
chat.use("/admin/chats/*", requireStaff);
const pg = (c: C, title: string): Page => ({ title, csrf: c.get("csrf"), path: c.req.path, user: { name: c.get("session")!.name }, ok: c.req.query("ok"), err: c.req.query("err") });
const ago = (d: any) => { if (!d) return "—"; const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000); return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

chat.get("/admin/chats", async (c) => {
  const db = c.get("db");
  const rows = (await db.query<any>(`SELECT t.*, (SELECT body FROM chat_messages m WHERE m.thread_id=t.id ORDER BY id DESC LIMIT 1) AS last_body FROM chat_threads t ORDER BY (t.status='closed'), t.updated_at DESC LIMIT 100`)).rows;
  const open = rows.filter((r) => r.status !== "closed").length, unread = rows.reduce((n, r) => n + (r.staff_unread > 0 ? 1 : 0), 0);
  return c.html(
    <AdminShell p={pg(c, "Live chats")}>
      <header class="page"><div><h1>Live chats</h1><p class="mute small">Visitors on the public site. {chatStaffed() ? "Chat is currently shown as staffed." : "Chat is currently outside staffed hours; visitors are told to leave a message."}</p></div></header>
      <div class="grid g3" style="margin-bottom:18px">
        <div class="card"><h3>Open conversations</h3><div class="kpi">{open}</div></div>
        <div class="card"><h3>Waiting for a reply</h3><div class={`kpi ${unread ? "bad" : "good"}`}>{unread}</div></div>
        <div class="card"><h3>Staffed hours</h3><div class="kpi" style="font-size:1.1rem;white-space:normal">{config.contact.chatFromHour}:00–{config.contact.chatToHour}:00 {config.contact.chatTz}</div></div>
      </div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Visitor</th><th>Last message</th><th>Page</th><th>Status</th><th>Updated</th></tr></thead>
        <tbody>
          {rows.length === 0 ? <tr><td colspan={5} class="mute">No conversations yet. They appear here when a visitor starts a live chat.</td></tr> : rows.map((r) => (
            <tr><td><a href={`/admin/chats/${r.id}`}><strong>{r.name || "Visitor"}</strong></a>{r.email ? <div class="small mute">{r.email}</div> : null}</td>
              <td>{String(r.last_body ?? "").slice(0, 90)}{r.staff_unread ? <> <span class="badge bad">{r.staff_unread} new</span></> : null}</td>
              <td class="small mute">{r.page ?? "—"}</td><td><Badge s={r.status === "closed" ? "closed" : r.status === "answered" ? "ok" : "open"} label={r.status} /></td><td class="small mute">{ago(r.updated_at)}</td></tr>))}
        </tbody></table></div>
    </AdminShell>,
  );
});

chat.get("/admin/chats/:id", async (c) => {
  const db = c.get("db"), id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Not found");
  const t = (await db.query<any>(`SELECT * FROM chat_threads WHERE id=$1`, [id])).rows[0];
  if (!t) throw new HttpError(404, "Conversation not found");
  await db.query(`UPDATE chat_threads SET staff_unread=0 WHERE id=$1`, [id]);
  const msgs = (await db.query<any>(`SELECT * FROM chat_messages WHERE thread_id=$1 ORDER BY id`, [id])).rows;
  const p = pg(c, "Live chat");
  return c.html(
    <AdminShell p={p}>
      <header class="page"><div><h1>{t.name || "Visitor"}</h1><p class="mute small">{t.email ?? "No email given"} · started {ago(t.created_at)}{t.page ? ` on ${t.page}` : ""} · <Badge s={t.status === "closed" ? "closed" : "open"} label={t.status} /></p></div><div class="spacer"></div>
        <a class="btn ghost sm" href="/admin/chats"><Icon name="arrowLeft" size={16} />All chats</a>
        {t.email ? <a class="btn ghost sm" href={`mailto:${t.email}`}><Icon name="mail" size={16} />Email</a> : null}
        {t.status !== "closed" ? <form method="post" action={`/admin/chats/${id}/close`} class="inline"><Csrf t={p.csrf} /><button class="btn sm" type="submit">Close</button></form> : null}</header>
      <div class="card" style="display:grid;gap:10px;max-width:820px">
        {msgs.map((m) => (
          <div style={`display:flex;justify-content:${m.sender === "visitor" ? "flex-start" : "flex-end"}`}>
            <div class={`msg ${m.sender === "visitor" ? "bot" : "me"}`} style="animation:none"><div class="small" style="opacity:.7;margin-bottom:2px">{m.sender === "visitor" ? t.name || "Visitor" : m.staff_name || "Staff"} · {ago(m.created_at)}</div>{m.body}</div>
          </div>))}
        <form method="post" action={`/admin/chats/${id}/reply`} style="display:grid;gap:10px;margin-top:10px">
          <Csrf t={p.csrf} />
          <label class="sr-only" for="reply">Reply</label>
          <textarea id="reply" name="message" required maxlength={2000} placeholder="Write a reply. The visitor sees it in their chat window within a few seconds."></textarea>
          <div><button class="btn red" type="submit">Send reply <Icon name="send" size={16} /></button></div>
        </form>
      </div>
    </AdminShell>,
  );
});

chat.post("/admin/chats/:id/reply", async (c) => {
  const db = c.get("db"), id = c.req.param("id"), s = c.get("session")!;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Not found");
  const body = clean(str((await formBody(c)).message), 2000);
  if (!body) return c.redirect(`/admin/chats/${id}?err=${encodeURIComponent("Write a reply first.")}`);
  const t = (await db.query<any>(`SELECT id FROM chat_threads WHERE id=$1`, [id])).rows[0];
  if (!t) throw new HttpError(404, "Conversation not found");
  await db.query(`INSERT INTO chat_messages(thread_id,sender,staff_name,body) VALUES ($1,'staff',$2,$3)`, [id, s.name.split(" ")[0], body]);
  await db.query(`UPDATE chat_threads SET status='answered', visitor_unread=visitor_unread+1, staff_unread=0, last_staff_at=now(), updated_at=now() WHERE id=$1`, [id]);
  await audit(db as any, null, { kind: "platform_staff", userId: s.userId }, "chat.reply", "chat_thread", id);
  return c.redirect(`/admin/chats/${id}?ok=${encodeURIComponent("Reply sent.")}`);
});

chat.post("/admin/chats/:id/close", async (c) => {
  const db = c.get("db"), id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Not found");
  await db.query(`UPDATE chat_threads SET status='closed', closed_at=now(), updated_at=now() WHERE id=$1`, [id]);
  await db.query(`INSERT INTO chat_messages(thread_id,sender,body) VALUES ($1,'system','This conversation was closed. Send a message any time to reopen it.')`, [id]);
  return c.redirect(`/admin/chats?ok=${encodeURIComponent("Conversation closed.")}`);
});

export { baseUrl, randomToken };
