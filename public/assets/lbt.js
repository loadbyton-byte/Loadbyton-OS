// LOAD|BY|TON interface layer. Progressive enhancement only: every page, form and link works without it.
(function () {
  "use strict";
  var doc = document, reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };

  /* ── small public API for other scripts (engage.js, chat.js) ── */
  var LBT = window.LBT = window.LBT || {};
  var esc = LBT.esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  LBT.store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    sget: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    sset: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };
  var tray;
  LBT.toast = function (o) {
    // Notices occupy their own row: never cover navigation, copy or form controls.
    if (!tray) { tray = doc.createElement("div"); tray.className = "toasts"; tray.setAttribute("role", "region"); tray.setAttribute("aria-label", "Notifications"); var main = doc.getElementById("main") || doc.body; main.insertBefore(tray, main.firstChild); }
    while (tray.firstChild) tray.removeChild(tray.firstChild);
    var t = doc.createElement("div"); t.className = "toast" + (o.image ? " toast-photo" : ""); t.setAttribute("role", "status");
    var icon = o.image ? '<img class="notice-photo" src="' + esc(o.image) + '" alt="' + esc(o.imageAlt || "") + '" width="800" height="450" decoding="async">' : o.img ? '<span class="ti"><img src="' + esc(o.img) + '" alt="" width="40" height="40" decoding="async"></span>' : '<span class="ti red">' + (o.icon || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>') + "</span>";
    var acts = "";
    if (o.href) acts += '<a href="' + esc(o.href) + '"' + (o.ext ? ' target="_blank" rel="noopener"' : "") + ">" + esc(o.cta || "Open") + "</a>";
    if (o.action) acts += '<button type="button" data-act>' + esc(o.actionLabel || "Open") + "</button>";
    if (acts) acts = '<div class="ta">' + acts + "</div>";
    t.innerHTML = icon + "<div><b>" + esc(o.title || "") + '</b><span class="tx">' + esc(o.text || "") + "</span>" + acts + '</div><button class="x" type="button" aria-label="Dismiss">×</button>';
    var close = function () { if (!t.parentNode) return; t.classList.add("out"); setTimeout(function () { t.parentNode && t.parentNode.removeChild(t); }, 360); };
    t.querySelector(".x").addEventListener("click", function () { close(); o.onClose && o.onClose(); });
    var a = t.querySelector("[data-act]"); if (a) a.addEventListener("click", function () { o.action(); close(); });
    var link = t.querySelector(".ta a"); if (link) link.addEventListener("click", function () { o.onOpen && o.onOpen(); });
    tray.appendChild(t);
    if (o.ms !== 0) setTimeout(close, o.ms || 9000);
    return close;
  };

  /* ── generic document handlers (carried over: print, repeated rows, confirm, autosubmit) ── */
  doc.addEventListener("click", function (e) {
    var t = e.target; if (!(t instanceof Element)) return;
    if (t.closest("[data-print]")) { window.print(); return; }
    var add = t.closest("[data-add-row]");
    if (add) { var tpl = doc.getElementById(add.getAttribute("data-add-row")); if (tpl && tpl.content) tpl.parentNode.insertBefore(tpl.content.cloneNode(true), tpl); }
    var rm = t.closest("[data-remove-row]");
    if (rm) { var row = rm.closest(".line-row"); if (row && doc.querySelectorAll(".line-row").length > 1) row.remove(); }
  });
  doc.addEventListener("submit", function (e) {
    var f = e.target;
    if (f instanceof HTMLFormElement && f.hasAttribute("data-confirm") && !window.confirm(f.getAttribute("data-confirm"))) e.preventDefault();
  });
  doc.addEventListener("change", function (e) {
    var s = e.target; if (s instanceof HTMLSelectElement && s.hasAttribute("data-autosubmit") && s.form) s.form.submit();
  });

  /* ── scroll reveal with stagger ── */
  if ("IntersectionObserver" in window && !reduced) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("is-visible"); io.unobserve(en.target); } }); }, { threshold: 0.08, rootMargin: "0px 0px -4% 0px" });
    $$("[data-reveal]").forEach(function (el, i) {
      if (el.getBoundingClientRect().top < window.innerHeight) { el.classList.add("is-visible"); }
      var sib = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
      el.style.setProperty("--d", Math.min(sib, 6) * 0.07 + "s");
      el.classList.add("reveal-ready"); io.observe(el);
    });
    /* count-up numbers */
    var cio = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        if (!en.isIntersecting) return; cio.unobserve(en.target);
        var el = en.target, to = parseFloat(el.getAttribute("data-count")), dec = +(el.getAttribute("data-dec") || 0), pre = el.getAttribute("data-pre") || "", suf = el.getAttribute("data-suf") || "", t0 = null;
        (function step(ts) { t0 = t0 || ts; var p = Math.min((ts - t0) / 1400, 1), v = to * (1 - Math.pow(1 - p, 4)); el.textContent = pre + v.toFixed(dec) + suf; if (p < 1) requestAnimationFrame(step); })(performance.now());
      });
    }, { threshold: 0.4 });
    $$("[data-count]").forEach(function (el) { cio.observe(el); });
  }

  /* ── scroll progress + header state ── */
  var bar = doc.createElement("div"); bar.className = "scroll-progress"; if ($(".public-experience")) doc.body.appendChild(bar);
  var head = $(".site-head"), hero = $(".hero-film, .page-hero");
  function onScroll() {
    var h = doc.documentElement, max = h.scrollHeight - h.clientHeight;
    bar.style.transform = "scaleX(" + (max > 0 ? h.scrollTop / max : 0) + ")";
    if (head) {
      head.classList.toggle("scrolled", h.scrollTop > 12);
      var dark = hero ? hero.getBoundingClientRect().bottom > 90 : false; head.classList.toggle("on-dark", dark);
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  var mt = $("[data-site-menu]");
  if (mt && head) { mt.addEventListener("click", function () { var o = head.classList.toggle("is-open"); mt.setAttribute("aria-expanded", String(o)); }); }

  /* ── pointer effects: 3D tilt, spotlight ── */
  if (!reduced && window.matchMedia("(hover: hover)").matches) {
    $$("[data-tilt]").forEach(function (el) {
      var max = +(el.getAttribute("data-tilt") || 8);
      el.addEventListener("pointermove", function (e) { var b = el.getBoundingClientRect(), x = (e.clientX - b.left) / b.width - .5, y = (e.clientY - b.top) / b.height - .5; el.style.transform = "perspective(900px) rotateX(" + (-y * max).toFixed(2) + "deg) rotateY(" + (x * max).toFixed(2) + "deg) translateZ(0)"; });
      el.addEventListener("pointerleave", function () { el.style.transform = ""; });
    });
    $$(".plan-card").forEach(function (el) {
      el.addEventListener("pointermove", function (e) { var b = el.getBoundingClientRect(); el.style.setProperty("--rx", (-(e.clientY - b.top - b.height / 2) / b.height * 8).toFixed(2) + "deg"); el.style.setProperty("--ry", ((e.clientX - b.left - b.width / 2) / b.width * 8).toFixed(2) + "deg"); });
      el.addEventListener("pointerleave", function () { el.style.setProperty("--rx", "0deg"); el.style.setProperty("--ry", "0deg"); });
    });
    $$(".spot").forEach(function (el) {
      el.addEventListener("pointermove", function (e) { var b = el.getBoundingClientRect(); el.style.setProperty("--mx", (e.clientX - b.left) + "px"); el.style.setProperty("--my", (e.clientY - b.top) + "px"); });
    });
    /* magnetic primary buttons */
    $$(".public-experience .btn.mag").forEach(function (el) {
      el.addEventListener("pointermove", function (e) { var b = el.getBoundingClientRect(); el.style.transform = "translate(" + ((e.clientX - b.left - b.width / 2) * .12).toFixed(1) + "px," + ((e.clientY - b.top - b.height / 2) * .22 - 1).toFixed(1) + "px)"; });
      el.addEventListener("pointerleave", function () { el.style.transform = ""; });
    });
  }

  /* ── tabs (product demo) ── */
  $$("[data-tabs]").forEach(function (root) {
    var tabs = $$("[role=tab]", root), panels = $$("[role=tabpanel]", root);
    function pick(i) { tabs.forEach(function (t, k) { t.setAttribute("aria-selected", String(k === i)); t.tabIndex = k === i ? 0 : -1; }); panels.forEach(function (p, k) { p.hidden = k !== i; }); }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { pick(i); });
      t.addEventListener("keydown", function (e) { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { var n = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length; pick(n); tabs[n].focus(); } });
    });
    pick(0);
  });

  /* ── sector filter chips ── */
  $$("[data-filter-group]").forEach(function (root) {
    var chips = $$("[data-filter]", root), items = $$("[data-cat]", doc);
    chips.forEach(function (c) { c.addEventListener("click", function () { var f = c.getAttribute("data-filter"); chips.forEach(function (x) { x.setAttribute("aria-pressed", String(x === c)); }); items.forEach(function (it) { it.hidden = !(f === "all" || it.getAttribute("data-cat").split(" ").indexOf(f) > -1); }); }); });
  });

  /* ── password visibility on the sign-in form ── */
  var login = $('form[action="/login"]');
  if (login) {
    var pw = $("input[type=password]", login);
    if (pw) {
      var wrap = doc.createElement("div"); wrap.className = "password-wrap"; pw.parentNode.insertBefore(wrap, pw); wrap.appendChild(pw);
      var tg = doc.createElement("button"); tg.type = "button"; tg.className = "password-toggle";
      var ar = doc.documentElement.lang === "ar";
      tg.textContent = ar ? "إظهار" : "Show"; tg.setAttribute("aria-label", ar ? "إظهار كلمة المرور" : "Show password"); tg.setAttribute("aria-pressed", "false"); tg.setAttribute("aria-controls", pw.id); wrap.appendChild(tg);
      tg.addEventListener("click", function () { var s = pw.type === "password"; pw.type = s ? "text" : "password"; tg.textContent = ar ? (s ? "إخفاء" : "إظهار") : (s ? "Hide" : "Show"); tg.setAttribute("aria-label", ar ? (s ? "إخفاء كلمة المرور" : "إظهار كلمة المرور") : (s ? "Hide password" : "Show password")); tg.setAttribute("aria-pressed", String(s)); });
    }
  }

  /* ── command palette (Ctrl/Cmd+K) ── */
  var dlg = $("[data-command-dialog]"), triggers = $$("[data-command-open]");
  if (dlg && typeof dlg.showModal === "function") {
    var q = $("input", dlg), links = $$(".command-results a", dlg), empty = $(".command-empty", dlg);
    var filter = function () { var tx = q.value.trim().toLocaleLowerCase(); links.forEach(function (l) { l.hidden = !l.textContent.toLocaleLowerCase().includes(tx); }); empty.hidden = links.some(function (l) { return !l.hidden; }); };
    var open = function () { if (!dlg.open) { q.value = ""; filter(); dlg.showModal(); q.focus(); } };
    triggers.forEach(function (t) { t.hidden = false; t.addEventListener("click", open); });
    $("[data-command-close]", dlg).addEventListener("click", function () { dlg.close(); });
    q.addEventListener("input", filter);
    q.addEventListener("keydown", function (e) { if (e.key === "Enter") { var f = links.find(function (l) { return !l.hidden; }); if (f) { e.preventDefault(); f.click(); } } if (e.key === "ArrowDown") { var f2 = links.find(function (l) { return !l.hidden; }); if (f2) { e.preventDefault(); f2.focus(); } } });
    dlg.addEventListener("click", function (e) { var b = dlg.getBoundingClientRect(); if (e.target === dlg && (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom)) dlg.close(); });
    doc.addEventListener("keydown", function (e) {
      if (dlg.open && e.key === "Escape") { e.preventDefault(); dlg.close(); return; }
      var editing = e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable=true]");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !editing) { e.preventDefault(); open(); }
    });
  }

  /* ── workspace popups from the rail ── */
  $$("[data-workspace-open]").forEach(function (a) {
    var d = doc.getElementById(a.getAttribute("data-workspace-open"));
    if (!d || typeof d.showModal !== "function") return;
    a.addEventListener("click", function (e) { e.preventDefault(); d.showModal(); });
  });
  $$("dialog.workspace-popup").forEach(function (d) {
    d.addEventListener("click", function (e) { if (e.target === d || (e.target instanceof Element && e.target.closest("[data-close]"))) d.close(); });
  });

  /* ── popovers (account, notifications) ── */
  var openPop = null;
  function closePop() { if (openPop) { openPop.hidden = true; var b = $("[data-pop-toggle]", openPop.parentNode); b && b.setAttribute("aria-expanded", "false"); openPop = null; } }
  $$("[data-pop-toggle]").forEach(function (b) {
    var pop = $("[data-pop]", b.parentNode); if (!pop) return;
    b.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (openPop === pop) { closePop(); return; } closePop(); pop.hidden = false; b.setAttribute("aria-expanded", "true"); openPop = pop;
      var topbar = b.closest(".topbar"), anchor = b.getBoundingClientRect(), y = (topbar ? topbar.getBoundingClientRect().bottom : anchor.bottom) + 8;
      var viewport = window.visualViewport, vh = viewport ? viewport.height : window.innerHeight;
      pop.style.position = "fixed"; pop.style.top = y + "px"; pop.style.left = Math.max(12, Math.min(anchor.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 12)) + "px"; pop.style.right = "auto";
      pop.style.maxHeight = Math.max(100, vh - y - 12) + "px";
      if (b.hasAttribute("data-alerts")) loadAlerts(pop);
    });
  });
  doc.addEventListener("click", function (e) { if (openPop && !openPop.contains(e.target)) closePop(); });
  doc.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });
  window.addEventListener("resize", closePop);
  function loadAlerts(pop) {
    var list = $(".list", pop); if (!list) return;
    fetch("/app/alerts.json", { credentials: "same-origin", headers: { accept: "application/json" } }).then(function (r) { return r.ok ? r.json() : { alerts: [] }; }).then(function (d) { renderAlerts(list, d.alerts || []); }).catch(function () { list.innerHTML = '<div class="empty">Could not load alerts. Open the dashboard instead.</div>'; });
  }
  var ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
  function renderAlerts(list, alerts) {
    if (!alerts.length) { list.innerHTML = '<div class="empty"><b>You are all caught up.</b><br>Nothing is overdue or waiting on you.</div>'; return; }
    list.innerHTML = alerts.map(function (a) { return '<a class="item" data-level="' + esc(a.level) + '" href="' + esc(a.href) + '"><span class="di">' + ICON + "</span><span><b>" + esc(a.title) + "</b><span>" + esc(a.text) + "</span></span></a>"; }).join("");
  }
  var cnt = $("[data-alert-count]");
  if (cnt) fetch("/app/alerts.json", { credentials: "same-origin", headers: { accept: "application/json" } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d && d.alerts && d.alerts.length) { cnt.textContent = d.alerts.length > 9 ? "9+" : String(d.alerts.length); cnt.classList.add("on"); } }).catch(function () { /* ignore */ });

  /* ── back button, theme, clock, mobile ── */
  $$("[data-back]").forEach(function (b) {
    b.addEventListener("click", function (e) { if (history.length > 1 && doc.referrer && new URL(doc.referrer).origin === location.origin) { e.preventDefault(); history.back(); } });
  });
  var th = $("[data-theme-toggle]");
  if (th) { th.hidden = false; th.addEventListener("click", function () { var de = doc.documentElement, dark = de.getAttribute("data-theme") === "dark"; if (dark) de.removeAttribute("data-theme"); else de.setAttribute("data-theme", "dark"); LBT.store.set("lbt-theme", dark ? "light" : "dark"); LBT.store.set("lbt-theme-auto", "off"); th.setAttribute("aria-pressed", String(!dark)); }); }
  var clock = $("[data-clock]");
  if (clock) { var tick = function () { try { clock.textContent = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(",", "") + " · Asia/Dubai"; } catch (e) { /* ignore */ } }; tick(); setInterval(tick, 15000); }

  /* ── hero film: three scenes, one load record. Auto-advances, pauses on hover/focus/hidden tab, fully manual under reduced motion ── */
  var film = $("[data-film]");
  if (film) {
    var scenes = $$(".film-scene", film), faces = $$(".lr-face", film), tabs = $$(".film-tab", film), rec = $(".load-record", film), ctl = $(".film-controls", film), tog = $("[data-film-toggle]", film), stage = $(".film-stage", film);
    var STAGES = [3, 4, 5], DWELL = 8000, TRANS = reduced ? 0 : 1500, cur = 0, timer = null, busy = false, remain = DWELL, t0 = 0, userPaused = reduced, offscreen = false;
    ctl.style.setProperty("--dwell", DWELL + "ms");
    if (userPaused) { ctl.classList.add("is-static"); tog.setAttribute("aria-pressed", "true"); tog.setAttribute("aria-label", "Resume scene changes"); }
    var arm = function (ms) { clearTimeout(timer); remain = ms; t0 = Date.now(); timer = setTimeout(function () { go((cur + 1) % scenes.length); }, ms); };
    var hold = function () { if (!timer) return; clearTimeout(timer); timer = null; remain = Math.max(400, remain - (Date.now() - t0)); ctl.classList.add("is-held"); };
    var release = function () { if (timer || userPaused || offscreen || doc.hidden) return; ctl.classList.remove("is-held"); arm(remain); };
    var go = function (n) {
      if (n === cur || busy) return; busy = true;
      var from = scenes[cur], to = scenes[n];
      to.classList.add("is-entering"); from.classList.add("is-leaving");
      if (!reduced) { stage.classList.remove("is-cutting"); void stage.offsetWidth; stage.classList.add("is-cutting"); }
      faces[cur].classList.remove("is-active"); faces[cur].setAttribute("aria-hidden", "true"); faces[n].classList.add("is-active"); faces[n].removeAttribute("aria-hidden");
      rec.setAttribute("data-stage", String(STAGES[n]));
      tabs.forEach(function (t, k) { t.classList.toggle("is-active", k === n); t.setAttribute("aria-pressed", String(k === n)); });
      setTimeout(function () { from.classList.remove("is-active", "is-leaving"); to.classList.remove("is-entering"); to.classList.add("is-active"); cur = n; busy = false; }, TRANS);
      if (!userPaused && !offscreen && !doc.hidden) { ctl.classList.remove("is-held"); arm(DWELL); } else { clearTimeout(timer); timer = null; remain = DWELL; }
    };
    tabs.forEach(function (t, i) { t.addEventListener("click", function () { go(i); }); });
    tog.addEventListener("click", function () {
      userPaused = !userPaused; tog.setAttribute("aria-pressed", String(userPaused)); tog.setAttribute("aria-label", userPaused ? "Resume scene changes" : "Pause scene changes");
      if (userPaused) { hold(); } else { ctl.classList.remove("is-static"); release(); }
    });
    ["pointerenter", "focusin"].forEach(function (ev) { ctl.addEventListener(ev, hold); });
    ["pointerleave", "focusout"].forEach(function (ev) { ctl.addEventListener(ev, release); });
    doc.addEventListener("visibilitychange", function () { if (doc.hidden) hold(); else release(); });
    if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { offscreen = !es[0].isIntersecting; if (offscreen) hold(); else release(); }, { threshold: 0.25 }).observe(film);
    if (!userPaused) arm(DWELL);
    /* dolly out: the picture pushes in slowly while the copy lifts away as the hero leaves the screen */
    if (!reduced) {
      var ticking = false;
      window.addEventListener("scroll", function () {
        if (ticking) return; ticking = true;
        requestAnimationFrame(function () { var p = Math.min(1, Math.max(0, window.scrollY / (film.offsetHeight * 0.85))); film.style.setProperty("--p", p.toFixed(3)); ticking = false; });
      }, { passive: true });
    }
  }
})();
