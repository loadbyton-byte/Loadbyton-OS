// Timed notices, the offer countdown and the offer popup. Everything shown is real: the offer date is fixed server-side, nothing is a fake "someone just signed up".
// Frequency is capped (session and per day), nothing appears while a dialog or the chat is open, and two dismissals silence the session.
(function () {
  "use strict";
  var LBT = window.LBT; if (!LBT || !LBT.toast) return;
  var doc = document, store = LBT.store, path = location.pathname, reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var bar = doc.querySelector("[data-offer]");
  var chatHost = doc.getElementById("lbt-chat"); if (!chatHost) return;             // quiet pages (sign-in, recovery) have no chat and no notices
  var WA = chatHost.getAttribute("data-wa");
  var csrf = (doc.querySelector('meta[name="csrf-token"]') || {}).content || "";

  /* ── offer bar + countdown ── */
  var offer = null;
  if (bar) {
    var ends = new Date(bar.getAttribute("data-ends")).getTime();
    offer = { ends: ends, code: bar.getAttribute("data-code") || "ONBOARD", title: bar.getAttribute("data-title") || "", detail: bar.getAttribute("data-detail") || "", label: bar.getAttribute("data-label") || "" };
    if (store.sget("lbt-offer-bar-closed")) bar.remove();
    else {
      var cd = bar.querySelector("[data-cd]"), x = bar.querySelector("[data-offer-close]");
      var left = function () { var ms = ends - Date.now(); if (ms <= 0) { bar.remove(); offer = null; return ""; } var d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4), s = Math.floor(ms % 6e4 / 1e3); return (d ? d + "d " : "") + String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"); };
      var upd = function () { if (cd) { cd.textContent = left(); } };
      upd(); setInterval(upd, 1000);
      if (x) { x.hidden = false; x.addEventListener("click", function () { store.sset("lbt-offer-bar-closed", "1"); bar.remove(); }); }
    }
  }
  var daysLeft = function () { return offer ? Math.max(0, Math.ceil((offer.ends - Date.now()) / 864e5)) : 0; };

  /* ── world clock chips in the hero ── */
  var wc = doc.querySelector("[data-world-clock]");
  if (wc) {
    var fmt = function (tz) { try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()); } catch (e) { return ""; } };
    var tick = function () { wc.innerHTML = "Dubai <b>" + fmt("Asia/Dubai") + "</b> · India <b>" + fmt("Asia/Kolkata") + "</b> · " + (chatHost.getAttribute("data-staffed") === "1" ? '<span style="color:#59E0A0">team online</span>' : "team back in the morning"); };
    tick(); setInterval(tick, 20000);
  }

  /* ── scheduled notices ── */
  var PAGE = {
    "/pricing": { title: "Not sure which plan fits?", text: "Pick your sectors and we recommend one, with the net price.", href: "/find-my-bundle", cta: "Find my bundle" },
    "/sectors": { title: "Tell us what you move", text: "We will point you to the right sector pack in one message.", action: function () { LBT.openChat && LBT.openChat("bot"); }, actionLabel: "Ask the assistant" },
    "/features": { title: "See it with your own data", text: "The Free plan is a real workspace. Add one customer and one enquiry to feel the flow.", href: "/start", cta: "Start free" },
    "/about": { title: "Talk to the builders", text: "Two engineers wrote this. Message us on WhatsApp and one of us replies.", href: WA, cta: "WhatsApp", ext: true },
    "/security": { title: "Security questions?", text: "Ask for the data processing terms or the readiness register. We send them.", action: function () { LBT.openChat && LBT.openChat("live"); }, actionLabel: "Chat with us" }
  };
  var QUEUE = [
    { at: 16, id: "free", icon: "gift", banner: "/assets/photo/product/onboarding-800.webp", badge: "FREE", title: "The Free plan is free", text: "A real, empty workspace. No card, no trial clock. Upgrade only when you need more.", href: "/start", cta: "Start free" },
    { at: 50, id: "wa", title: "Prefer to talk it through?", text: "Message us on WhatsApp. A person answers, usually within minutes in staffed hours.", href: WA, cta: "Open WhatsApp", ext: true },
    { at: 105, id: "offer", needsOffer: true },
    { at: 175, id: "bundle", title: "Which sectors do you run?", text: "Find my bundle recommends a plan and shows the net price in AED.", href: "/find-my-bundle", cta: "Find my bundle" },
    { at: 260, id: "page" },
    { at: 500, id: "chat", title: "Quick question?", text: "The assistant answers from our product notes, and Live chat reaches a person.", action: function () { LBT.openChat && LBT.openChat("bot"); }, actionLabel: "Ask now" },
    { at: 760, id: "offer2", needsOffer: true }
  ];
  var MAX_SESSION = 6, MAX_DAY = 10;
  var day = new Date().toISOString().slice(0, 10), dayKey = "lbt-toasts-" + day;
  var shownDay = +(store.get(dayKey) || 0), shownSession = +(store.sget("lbt-toasts") || 0), dismissed = +(store.sget("lbt-toast-x") || 0), lastAt = 0, elapsed = +(store.sget("lbt-elapsed") || 0), fired = JSON.parse(store.sget("lbt-fired") || "[]");
  var chatOpen = function () { var p = doc.querySelector(".chat-panel.open"); return !!p; };
  var blocked = function () { return doc.hidden || doc.querySelector("dialog[open]") || chatOpen(); };
  var money = function () { return ""; };

  function show(q) {
    var o;
    if (q.id === "page") { o = PAGE[path] || PAGE[Object.keys(PAGE).filter(function (k) { return path.indexOf(k) === 0; })[0]]; if (!o) o = { title: "Built in India, priced for the UAE", text: "Plans are published in AED and export is free on every plan.", href: "/pricing", cta: "See pricing" }; }
    else if (q.needsOffer) { if (!offer) return false; var d = daysLeft(); o = { icon: "gift", title: offer.title || "Onboarding offer", text: (d <= 1 ? "Ends today." : "Ends in " + d + " days (" + offer.label + ").") + " Start this month and we set it up with you.", href: "/start?offer=" + encodeURIComponent(offer.code), cta: "Claim it" }; }
    else o = q;
    var t = { banner: o.banner, badge: o.badge, title: o.title, text: o.text, href: o.href, cta: o.cta, ext: o.ext, action: o.action, actionLabel: o.actionLabel, icon: o.icon === "gift" ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16v4H4zM6 13h12v8H6zM12 9v12M12 9c-2 0-4-1-4-2.5S9.5 4 12 6c2.5-2 4-.5 4 .5S14 9 12 9z"/></svg>' : undefined, img: o.icon ? undefined : "/brand/lbt-chat-avatar.png", ms: 11000,
      onClose: function () { dismissed++; store.sset("lbt-toast-x", String(dismissed)); } };
    LBT.toast(t); return true;
  }
  function tickQ() {
    if (blocked()) return; elapsed++; store.sset("lbt-elapsed", String(elapsed));
    if (shownSession >= MAX_SESSION || shownDay >= MAX_DAY || dismissed >= 2) return;
    if (Date.now() - lastAt < 45000) return;
    for (var i = 0; i < QUEUE.length; i++) {
      var q = QUEUE[i]; if (fired.indexOf(q.id) > -1 || elapsed < q.at) continue;
      fired.push(q.id); store.sset("lbt-fired", JSON.stringify(fired));
      if (show(q)) { lastAt = Date.now(); shownSession++; shownDay++; store.sset("lbt-toasts", String(shownSession)); store.set(dayKey, String(shownDay)); }
      return;
    }
  }
  setInterval(tickQ, 1000);

  /* ── offer popup: exit intent on desktop, long dwell elsewhere; at most once every three days ── */
  var POP_KEY = "lbt-offer-popup", POP_GAP = 3 * 864e5, popShown = false, dwell = 0;
  var scrolledPast = function (f) { var h = doc.documentElement; return (h.scrollTop + h.clientHeight) / h.scrollHeight > f; };
  function popup() {
    if (popShown || !offer || blocked()) return; popShown = true; store.set(POP_KEY, String(Date.now()));
    var d = doc.createElement("dialog"); d.className = "offer-dialog"; d.setAttribute("aria-labelledby", "offer-h");
    var wa = WA + (WA.indexOf("?") > -1 ? "&" : "?") + "text=" + encodeURIComponent("Hi, I would like the " + offer.code + " offer: " + offer.title);
    d.innerHTML = '<div class="offer-sheet"><button class="x" type="button" aria-label="Close">×</button>' +
      '<div class="offer-art"><img class="bg" src="/assets/photo/product/onboarding-800.webp" alt="" width="800" height="450" decoding="async"><img class="ic" src="/brand/lbt-iconmark-crop.png" alt="" width="84" height="84"><div><div class="big">FREE<small>setup</small></div><p>Onboarding call and customer import</p></div></div>' +
      '<div class="offer-body"><span class="eyebrow" style="margin:0">LIMITED TIME · ENDS ' + LBT.esc(offer.label.toUpperCase()) + '</span><h2 id="offer-h">' + LBT.esc(offer.title) + '</h2><p>' + LBT.esc(offer.detail) + '</p><div class="cd" data-pcd></div>' +
      '<form data-form><input type="email" name="email" placeholder="Work email" required autocomplete="email" maxlength="254" aria-label="Work email"><input type="text" name="name" placeholder="Your name" required autocomplete="name" maxlength="120" aria-label="Your name"><button class="btn red" type="submit">Claim the offer</button></form>' +
      '<a class="btn wa" href="' + LBT.esc(wa) + '" target="_blank" rel="noopener">Or claim it on WhatsApp</a><p class="fine">We use your details only to arrange the call. One email, no list.</p></div></div>';
    doc.body.appendChild(d); d.showModal(); var fi = d.querySelector('input'); if (fi) fi.focus();
    var pc = d.querySelector("[data-pcd]"), t = setInterval(function () { var ms = offer ? offer.ends - Date.now() : 0; if (ms <= 0) { pc.textContent = ""; return; } pc.textContent = "Ends in " + Math.floor(ms / 864e5) + "d " + Math.floor(ms % 864e5 / 36e5) + "h " + Math.floor(ms % 36e5 / 6e4) + "m"; }, 1000);
    var closeIt = function () { clearInterval(t); d.close(); d.remove(); };
    d.querySelector(".x").addEventListener("click", closeIt);
    d.addEventListener("click", function (e) { if (e.target === d) closeIt(); });
    d.addEventListener("cancel", function () { clearInterval(t); });
    d.querySelector("[data-form]").addEventListener("submit", function (e) {
      e.preventDefault(); var f = e.target, btn = f.querySelector("button"); btn.disabled = true;
      var body = new URLSearchParams({ _csrf: csrf, name: f.name.value, email: f.email.value, company: "", message: "Offer " + offer.code + ": " + offer.title, source: "offer" });
      fetch("/contact", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body, credentials: "same-origin" })
        .then(function (r) { if (!r.ok) throw new Error(); f.outerHTML = '<div class="alert ok" role="status"><span><strong>Thanks.</strong> We will email you today to set the call.</span></div>'; })
        .catch(function () { btn.disabled = false; btn.textContent = "Try again"; });
    });
  }
  if (offer && !/^\/(start|login)/.test(path)) {
    var last = +(store.get(POP_KEY) || 0), eligible = Date.now() - last > POP_GAP;
    if (eligible) {
      doc.addEventListener("mouseout", function (e) { if (!e.relatedTarget && e.clientY <= 0 && dwell >= 25 && !popShown) popup(); });
      setInterval(function () { if (doc.hidden) return; dwell++; if (dwell >= 95 && scrolledPast(0.3) && !popShown) popup(); }, 1000);
    }
  }
})();
