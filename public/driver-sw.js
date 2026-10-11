// LOAD|BY|TON.store driver service worker. Scope: /app/driver/ only.
// - The application shell (CSS/JS, offline page) is precached so the app opens with no signal after one online visit.
// - Driver pages are network-first and kept on the phone only for offline viewing of the last-seen trip/run; they are removed on sign-out.
// - Writes are never cached or replayed here: the page queues them (assets/driver.js) and the server de-duplicates by client event id.
var SHELL = "lbt-driver-shell-v2", PAGES = "lbt-driver-pages-v2", MAX_PAGES = 30;
var PRECACHE = ["/app/driver/offline", "/assets/app.css", "/assets/app.js", "/assets/driver.js", "/app/driver/manifest.webmanifest", "/brand/by-mark-192.png"];
self.addEventListener("install", function (e) { e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(PRECACHE); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== SHELL && k !== PAGES; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("message", function (e) {
  if (e.data && e.data.type === "clear") e.waitUntil(caches.delete(PAGES));
});
function trim(cache) {
  return cache.keys().then(function (keys) { return keys.length > MAX_PAGES ? Promise.all(keys.slice(0, keys.length - MAX_PAGES).map(function (k) { return cache.delete(k); })) : null; });
}
function pageKey(url) { var u = new URL(url); return u.origin + u.pathname; }
self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/assets/") === 0 || url.pathname.indexOf("/brand/") === 0) {
    e.respondWith(caches.open(SHELL).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (r) { if (r && r.ok) c.put(req, r.clone()); return r; }).catch(function () { return hit; });
        return hit || net;
      });
    }));
    return;
  }
  if (url.pathname.indexOf("/app/driver") !== 0 || /\/(sync|positions|sw\.js)$/.test(url.pathname)) return;
  if (url.pathname === "/app/driver/offline" || url.pathname === "/app/driver/manifest.webmanifest") { e.respondWith(caches.match(req).then(function (h) { return h || fetch(req); })); return; }
  e.respondWith(
    fetch(req).then(function (r) {
      // only keep real driver pages: not login redirects, errors or downloads
      if (r && r.ok && !r.redirected && (r.headers.get("content-type") || "").indexOf("text/html") === 0) {
        var copy = r.clone();
        caches.open(PAGES).then(function (c) { return c.put(pageKey(req.url), copy).then(function () { return trim(c); }); });
      }
      return r;
    }).catch(function () {
      return caches.open(PAGES).then(function (c) { return c.match(pageKey(req.url)); }).then(function (hit) {
        return hit || caches.open(PAGES).then(function (c) { return c.match(pageKey("/app/driver")); }).then(function (home) { return home || caches.match("/app/driver/offline"); });
      });
    })
  );
});
