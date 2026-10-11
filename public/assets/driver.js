// Offline-tolerant driver actions. Each action gets a client event id (rendered by the server) and the phone's clock time.
// If the network fails the action is queued in localStorage and re-sent later; the server dedupes on the client event id,
// so retries and double syncs are harmless.
(function () {
  var scopeMeta = document.querySelector("meta[name=driver-scope]"), SCOPE = scopeMeta ? scopeMeta.getAttribute("content") : "";
  // queues are per signed-in driver, so a shared phone never replays one driver's actions under another's login
  var KEY = "lbt_driver_queue_v2:" + SCOPE, GPS_KEY = "lbt_driver_gps_v1:" + SCOPE;
  try { var legacy = localStorage.getItem("lbt_driver_queue_v1"); if (legacy && SCOPE && !localStorage.getItem(KEY)) { localStorage.setItem(KEY, legacy); } localStorage.removeItem("lbt_driver_queue_v1"); } catch (e) {}
  function csrf() { var m = document.querySelector("meta[name=csrf-token]"); return m ? m.getAttribute("content") : ""; }
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
  function save(q) { try { localStorage.setItem(KEY, JSON.stringify(q)); } catch (e) {} }
  function banner() { var b = document.getElementById("offline-banner"); if (b) b.hidden = load().length === 0; }
  function post(events) {
    return fetch("/app/driver/sync", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ events: events }) })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); });
  }
  function flush() {
    var q = load(); if (!q.length) { banner(); return Promise.resolve(false); }
    return post(q).then(function (res) {
      var done = {}, msgs = [];
      res.results.forEach(function (r) { done[r.client_event_id] = true; if (r.outcome === "stored" || r.outcome === "rejected") msgs.push(r.reason || "That could not be applied."); });
      if (msgs.length) { try { sessionStorage.setItem("lbt_driver_msg", msgs.join(" ")); } catch (e) {} }
      save(load().filter(function (e) { return !done[e.client_event_id]; })); banner(); return true;
    }).catch(function () { banner(); return false; });
  }
  function eventFrom(form) {
    var ev = { payload: {} }, fd = new FormData(form);
    fd.forEach(function (v, k) {
      if (k === "_csrf") return;
      if (k.indexOf("p_") === 0) ev.payload[k.slice(2)] = String(v);
      else ev[k] = String(v);
    });
    ev.device_time = new Date().toISOString();
    return ev;
  }
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!(f instanceof HTMLFormElement) || !f.hasAttribute("data-driver-form")) return;
    e.preventDefault();
    var btn = f.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
    var ev = eventFrom(f), q = load(); q.push(ev); save(q);
    flush().then(function (ok) { if (ok) window.location.reload(); else { banner(); if (btn) { btn.textContent = "Saved on phone"; } } });
  });
  window.addEventListener("online", function () { flush().then(function (ok) { if (ok) window.location.reload(); }); });
  function showMsg() {
    var m = null; try { m = sessionStorage.getItem("lbt_driver_msg"); sessionStorage.removeItem("lbt_driver_msg"); } catch (e) {}
    if (!m) return;
    var main = document.getElementById("main"); if (!main) return;
    var d = document.createElement("div"); d.className = "alert err"; d.setAttribute("role", "alert"); d.textContent = "Not applied: " + m; main.insertBefore(d, main.firstChild);
  }
  showMsg(); banner(); flush();

  // ── offline first-open: the service worker keeps the shell and last-seen driver pages on this phone
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/app/driver/sw.js", { scope: "/app/driver/" }).catch(function () {});
    document.addEventListener("submit", function (e) {
      var f = e.target;
      if (f instanceof HTMLFormElement && /\/logout$/.test(f.getAttribute("action") || "")) {
        try { localStorage.removeItem(GPS_KEY); } catch (x) {}
        if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: "clear" });
      }
    }, true);
  }

  // ── GPS: only on a live trip page, only after the driver switched sharing on; buffered offline and sent in batches
  var gps = document.getElementById("gps");
  if (gps && gps.getAttribute("data-consent") === "1" && "geolocation" in navigator) {
    var tripId = gps.getAttribute("data-trip"), last = 0;
    var loadG = function () { try { return JSON.parse(localStorage.getItem(GPS_KEY) || "[]"); } catch (e) { return []; } };
    var saveG = function (q) { try { localStorage.setItem(GPS_KEY, JSON.stringify(q.slice(-400))); } catch (e) {} };
    var sendG = function () {
      var q = loadG().filter(function (p) { return p.trip_id === tripId; }); if (!q.length) return;
      fetch("/app/driver/positions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ trip_id: tripId, points: q.slice(0, 100) }) })
        .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
        .then(function () { var sent = {}; q.slice(0, 100).forEach(function (p) { sent[p.device_time] = true; }); saveG(loadG().filter(function (p) { return !(p.trip_id === tripId && sent[p.device_time]); })); })
        .catch(function () {});
    };
    navigator.geolocation.watchPosition(function (pos) {
      var now = Date.now(); if (now - last < 20000) return; last = now;
      var q = loadG(); q.push({ trip_id: tripId, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: Math.round(pos.coords.accuracy || 0), speed_kmh: pos.coords.speed != null ? Math.round(pos.coords.speed * 3.6) : undefined, device_time: new Date(pos.timestamp || now).toISOString() });
      saveG(q);
    }, function () {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
    setInterval(sendG, 60000); window.addEventListener("online", sendG); sendG();
  }
})();
