// Website chat: a product assistant (answers from our own knowledge base) and live chat with the team. No third-party service involved.
(function () {
  "use strict";
  var host = document.getElementById("lbt-chat"); if (!host) return;
  var LBT = window.LBT = window.LBT || {};
  var store = LBT.store || { get: function () { return null; }, set: function () {}, sget: function () { return null; }, sset: function () {} };
  var esc = LBT.esc || function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || host.getAttribute("data-csrf") || "";
  var WA = host.getAttribute("data-wa"), PHONE = host.getAttribute("data-phone"), TEL = host.getAttribute("data-tel");
  var staffed = host.getAttribute("data-staffed") === "1";
  var hours = host.getAttribute("data-from") + ":00–" + host.getAttribute("data-to") + ":00 " + host.getAttribute("data-tz");

  function token() { var t = store.get("lbt-chat-token"); if (!t || !/^[A-Za-z0-9_-]{32,64}$/.test(t)) { var a = new Uint8Array(32); (window.crypto || window.msCrypto).getRandomValues(a); t = btoa(String.fromCharCode.apply(null, a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); store.set("lbt-chat-token", t); } return t; }
  function api(path, body, method) {
    var h = { "x-csrf-token": csrf, "x-chat-token": token() };
    var o = { method: method || "POST", headers: h, credentials: "same-origin" };
    if (body !== undefined) { h["content-type"] = "application/json"; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || j.message || "Something went wrong"); e.status = r.status; throw e; } return j; }); });
  }
  var ICON = {
    send: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11.5L20 4l-6.5 16-2.5-6.5z"/></svg>',
    wa: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z"/></svg>'
  };

  host.innerHTML =
    '<div class="chat-launch"><button class="chat-fab" type="button" aria-label="Open chat" aria-expanded="false" aria-controls="lbt-chat-panel"><img src="/brand/lbt-chat-avatar.png" alt="" width="62" height="62"><span class="badge-n" aria-hidden="true"></span></button></div>' +
    '<dialog class="chat-panel" id="lbt-chat-panel" aria-label="Chat with LOAD|BY|TON">' +
    '<div class="chat-head"><div class="who"><span class="av"><img src="/brand/lbt-chat-avatar.png" alt="" width="46" height="46"></span><div><b>' + brand("LOAD|BY|TON") + ' assistant</b><small><i class="' + (staffed ? "" : "off") + '"></i><span data-status></span></small></div></div>' +
    '<button class="cx" type="button" aria-label="Close chat">×</button>' +
    '<div class="chat-tabs" role="tablist"><button type="button" role="tab" data-tab="bot" aria-selected="true">Ask the assistant</button><button type="button" role="tab" data-tab="live" aria-selected="false">Live chat</button><button type="button" role="tab" data-tab="wa" aria-selected="false">WhatsApp</button></div></div>' +
    '<div class="chat-body" data-body aria-live="polite"></div><div class="chat-suggest" data-suggest></div><div class="chat-join" data-join hidden></div>' +
    '<form class="chat-form" data-form autocomplete="off"><label class="sr-only" for="lbt-chat-input">Message</label><input id="lbt-chat-input" type="text" maxlength="500" placeholder="Ask about plans, sectors, security…" required><button type="submit" aria-label="Send">' + ICON.send + "</button></form>" +
    '<div class="chat-foot">Assistant answers come from our product notes. Live chat reaches a person.</div></dialog>';

  var fab = host.querySelector(".chat-fab"), panel = host.querySelector(".chat-panel"), body = host.querySelector("[data-body]"), sug = host.querySelector("[data-suggest]"), join = host.querySelector("[data-join]"),
    form = host.querySelector("[data-form]"), input = host.querySelector("#lbt-chat-input"), statusEl = host.querySelector("[data-status]"), badge = host.querySelector(".badge-n"), launch = host.querySelector(".chat-launch");
  var navigation = document.querySelector(".head-cta");
  if (navigation) navigation.insertBefore(launch, navigation.firstChild);
  var tab = "bot", opened = false, lastId = 0, liveStarted = false, poller = null, unread = 0, busy = false, botHist = [];

  function brand(h) { return h.split("LOAD|BY|TON").join('<span class="lbt">LOAD<span class="by"><i></i><b><span>B</span><span>Y</span></b><i></i></span>TON</span>'); }
  function linkify(t) { return brand(esc(t)).replace(/(^|[\s(])(\/[a-z0-9][a-z0-9\-\/?=&]*)/g, function (m, a, p) { return a + '<a href="' + p + '">' + p + "</a>"; }); }
  function add(kind, html, raw) { var d = document.createElement("div"); d.className = "msg " + kind; if (raw) d.innerHTML = brand(esc(html)); else d.innerHTML = html; body.appendChild(d); body.scrollTop = body.scrollHeight; return d; }
  function typing() { var d = document.createElement("div"); d.className = "typing"; d.innerHTML = "<i></i><i></i><i></i>"; body.appendChild(d); body.scrollTop = body.scrollHeight; return d; }
  function acts(links, extra) {
    var h = ""; (links || []).forEach(function (l) { h += '<a href="' + esc(l[1]) + '"' + (/^https?:/.test(l[1]) ? ' target="_blank" rel="noopener"' : "") + (/wa\.me/.test(l[1]) ? ' class="wa"' : "") + ">" + (/wa\.me/.test(l[1]) ? ICON.wa + " " : "") + esc(l[0]) + "</a>"; });
    if (extra) h += extra; return h ? '<div class="acts">' + h + "</div>" : "";
  }
  function setSug(list) { sug.innerHTML = ""; (list || []).forEach(function (s) { var b = document.createElement("button"); b.type = "button"; b.textContent = s; b.addEventListener("click", function () { if (/talk to a person/i.test(s)) { setTab("live"); return; } ask(s); }); sug.appendChild(b); }); }

  function greet() {
    body.innerHTML = ""; botHist = [];
    add("bot", "Hi, I am the LOAD|BY|TON assistant. I can answer questions about plans, sectors, security and getting started. For anything else, switch to Live chat and a person will reply.", true);
    setSug(["What is LOAD|BY|TON.store?", "How much does it cost?", "Which sectors do you cover?", "Is my data secure?", "Talk to a person"]);
  }
  function ask(q) {
    if (busy) return; busy = true; add("me", q, true); setSug([]);
    var t = typing(), t0 = Date.now();
    api("/chat/bot", { q: q }).then(function (r) {
      var wait = Math.max(0, 550 - (Date.now() - t0));
      setTimeout(function () {
        t.remove(); var d = add("bot", linkify(r.answer) + acts(r.links, r.handoff ? '<a href="#" data-go-live class="ghost">Start live chat</a>' : ""));
        var g = d.querySelector("[data-go-live]"); if (g) g.addEventListener("click", function (e) { e.preventDefault(); setTab("live"); });
        setSug(r.suggestions); busy = false; botHist.push([q, r.answer]);
      }, wait);
    }).catch(function (e) { t.remove(); busy = false; add("bot", (e && e.message) || "I could not reach the server. You can still message us on WhatsApp " + PHONE + ".", true); });
  }

  function statusText() {
    statusEl.textContent = tab === "live" ? (staffed ? "Team online · replies in minutes" : "Outside staffed hours · leave a message") : "Instant answers · always on";
  }
  function setTab(t) {
    if (t === "wa") { window.open(WA, "_blank", "noopener"); return; }
    tab = t;
    host.querySelectorAll("[data-tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-tab") === t)); });
    statusText(); body.innerHTML = ""; sug.innerHTML = ""; join.hidden = true; form.hidden = false;
    if (t === "bot") { input.placeholder = "Ask about plans, sectors, security…"; input.maxLength = 500; greet(); input.focus(); stopPoll(); return; }
    input.placeholder = "Write to the team…"; input.maxLength = 2000;
    body.innerHTML = '<div class="msg sys">Connecting…</div>';
    api("/chat/live/poll?after=0", undefined, "GET").then(function (r) {
      body.innerHTML = "";
      if (r.thread && r.messages.length) { liveStarted = true; lastId = 0; render(r.messages); startPoll(); input.focus(); }
      else showJoin();
    }).catch(function () { body.innerHTML = ""; showJoin(); });
  }
  function showJoin() {
    liveStarted = false; form.hidden = true; join.hidden = false;
    var info = staffed ? "Our team is online now. Tell us who you are (optional) and what you need." : "We are outside staffed hours (" + hours + "). Leave a message and we will reply next working morning. Add your email so we can reach you.";
    body.innerHTML = '<div class="msg bot">' + esc(info) + '</div>';
    join.innerHTML = '<input type="text" id="lc-name" placeholder="Your name (optional)" maxlength="120" autocomplete="name"><input type="email" id="lc-email" placeholder="Email (optional, for replies)" maxlength="254" autocomplete="email"><textarea id="lc-msg" rows="3" maxlength="2000" placeholder="How can we help?" required></textarea><button class="btn red" type="button" data-start>Start chat</button><p class="small mute" style="margin:0">Prefer WhatsApp? <a href="' + esc(WA) + '" target="_blank" rel="noopener">' + esc(PHONE) + "</a> · or call <a href=\"" + esc(TEL) + '">' + esc(PHONE) + "</a></p>";
    join.querySelector("[data-start]").addEventListener("click", function () {
      var m = join.querySelector("#lc-msg").value.trim(); if (!m) { join.querySelector("#lc-msg").focus(); return; }
      send(m, join.querySelector("#lc-name").value.trim(), join.querySelector("#lc-email").value.trim());
    });
  }
  function render(msgs) {
    msgs.forEach(function (m) {
      if (m.id <= lastId) return; lastId = Math.max(lastId, m.id);
      if (m.from === "visitor") add("me", m.text, true);
      else if (m.from === "staff") { add("agent", (m.name ? m.name + ": " : "") + m.text, true); if (!opened || tab !== "live") bump(); }
      else add("sys", m.text, true);
    });
  }
  function send(text, name, email) {
    if (busy) return; busy = true;
    api("/chat/live/send", { message: text, name: name, email: email, page: location.pathname, after: lastId }).then(function (r) {
      busy = false; store.set("lbt-chat-live", "1"); join.hidden = true; form.hidden = false; body.innerHTML = ""; liveStarted = true; lastId = 0; render(r.messages); startPoll();
      if (!staffed) add("sys", "Outside staffed hours. We will reply next working morning" + (email ? " and email you." : "."), true);
      else add("sys", "Message sent. A person will reply here shortly.", true);
      input.focus();
    }).catch(function (e) { busy = false; add("sys", (e && e.message) || "Could not send. Please try again, or use WhatsApp.", true); });
  }
  function startPoll() { stopPoll(); poller = setInterval(poll, opened && tab === "live" ? 4000 : 25000); poll(); }
  function stopPoll() { if (poller) clearInterval(poller); poller = null; }
  function poll() {
    if (!liveStarted && !store.get("lbt-chat-live")) return;
    api("/chat/live/poll?after=" + lastId, undefined, "GET").then(function (r) { staffed = !!r.staffed; if (r.messages && r.messages.length) { if (tab === "live" && opened) render(r.messages); else { r.messages.forEach(function (m) { if (m.from === "staff" && m.id > lastId) { bump(); LBT.toast && LBT.toast({ img: "/brand/lbt-chat-avatar.png", title: "Reply from the team", text: m.text.slice(0, 110), actionLabel: "Open chat", action: function () { open("live"); }, ms: 12000 }); lastId = Math.max(lastId, m.id); } }); } } }).catch(function () { /* quiet */ });
  }
  function bump() { unread++; badge.textContent = unread > 9 ? "9+" : String(unread); badge.classList.add("on"); }
  function clearBump() { unread = 0; badge.classList.remove("on"); }

  function open(t) {
    if (document.querySelector("dialog[open]") && !panel.open) return;
    opened = true; if (!panel.open) panel.showModal(); panel.classList.add("open"); fab.setAttribute("aria-expanded", "true"); clearBump();
    var nudge = launch.querySelector(".chat-nudge"); if (nudge) nudge.remove(); store.sset("lbt-nudged", "1");
    if (!body.childNodes.length || (t && t !== tab)) setTab(t || tab);
    else if (tab === "live" && liveStarted) startPoll();
    setTimeout(function () { input.focus(); }, 60);
  }
  function close() { opened = false; panel.close(); panel.classList.remove("open"); fab.setAttribute("aria-expanded", "false"); if (liveStarted) startPoll(); fab.focus(); }
  panel.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
  panel.addEventListener("click", function (e) { var b = panel.getBoundingClientRect(); if (e.target === panel && (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom)) close(); });
  LBT.openChat = open;

  fab.addEventListener("click", function () { opened ? close() : open(); });
  host.querySelector(".cx").addEventListener("click", close);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && opened && !document.querySelector("dialog[open]")) close(); });
  host.querySelectorAll("[data-tab]").forEach(function (b) { b.addEventListener("click", function () { setTab(b.getAttribute("data-tab")); }); });
  document.addEventListener("click", function (e) { var t = e.target instanceof Element && e.target.closest("[data-open-chat]"); if (t) { e.preventDefault(); open(t.getAttribute("data-open-chat") || undefined); } });
  form.addEventListener("submit", function (e) {
    e.preventDefault(); var v = input.value.trim(); if (!v) return; input.value = "";
    if (tab === "bot") ask(v); else send(v, "", "");
  });
  statusText();
  // returning visitor with an open conversation: show unread replies on the launcher
  if (store.get("lbt-chat-token") && store.get("lbt-chat-live")) { liveStarted = true; startPoll(); }

  // The optional invitation uses the same in-flow notice region as other notices.
  if (!store.sget("lbt-nudged")) setTimeout(function () {
    if (opened || store.sget("lbt-nudged") || document.querySelector("dialog[open], .toast, .site-head.is-open") || document.activeElement.matches("input, textarea, select")) return;
    store.sset("lbt-nudged", "1");
    if (LBT.toast) LBT.toast({ title: "Questions?", text: "Ask the assistant, or chat with the team.", img: "/brand/lbt-chat-avatar.png", action: function () { open(); }, actionLabel: "Open chat" });
  }, 28000);
})();
