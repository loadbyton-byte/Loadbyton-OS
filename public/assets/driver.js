// Offline-tolerant driver actions. Each action gets a client event id (rendered by the server) and the phone's clock time.
// If the network fails the action is queued in localStorage and re-sent later; the server dedupes on the client event id,
// so retries and double syncs are harmless.
(function () {
  var KEY = "lbt_driver_queue_v1";
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
      var done = {}; res.results.forEach(function (r) { done[r.client_event_id] = true; });
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
  banner(); flush();
})();
