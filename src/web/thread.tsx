import { formatDate } from "../lib/util.js";
import { Csrf } from "./ui.js";

/** A message thread, shared by the client portal and the staff console. */
export const Thread = ({ messages }: { messages: { author_kind: string; author_name: string; body: string; created_at: string; request_title?: string }[] }) => (
  <div class="thread" role="log" aria-label="Messages">
    {messages.length ? messages.map((m) => (
      <div class={`msg ${m.author_kind}`}>
        <div class="msg-meta">{m.author_kind === "staff" ? "LOAD|BY|TON team" : m.author_name} · {formatDate(m.created_at)}{m.request_title ? <> · <span class="mute">{m.request_title}</span></> : null}</div>
        <p style="white-space:pre-wrap">{m.body}</p>
      </div>)) : <p class="mute" style="margin:0">No messages yet. Write to us below: a person answers, usually the same working day.</p>}
  </div>
);
export const MessageForm = ({ csrf, action, requests }: { csrf: string; action: string; requests?: { id: string; title: string }[] }) => (
  <form method="post" action={action} class="msg-form card">
    <Csrf t={csrf} />
    {requests ? <div class="field"><label for="m-req">About</label><select id="m-req" name="request_id">{requests.map((r) => <option value={r.id}>{r.title}</option>)}</select></div> : null}
    <div class="field"><label for="m-body">Your message</label><textarea id="m-body" name="body" rows={4} maxlength={4000} required placeholder="Ask a question, send wording for your documents, or tell us what changed."></textarea>
      <div class="hint">Please don't type your tax number, bank account, card or any password. Those go into your own admin panel (see the <a href="/app/guide">guide</a>).</div></div>
    <button class="btn red" type="submit">Send</button>
  </form>
);
