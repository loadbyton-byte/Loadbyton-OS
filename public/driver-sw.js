// Offline shell only. Authenticated HTML must never be shared between drivers on a phone.
// Actions remain queued per driver by driver.js; reconnection requires a fresh authenticated page.
var SHELL = "lbt-driver-shell-v3";
var PRECACHE = ["/app/driver/offline", "/assets/lbt.css", "/assets/desk.css", "/assets/lbt.js", "/assets/driver.js", "/app/driver/manifest.webmanifest", "/brand/by-mark-192.png"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(PRECACHE); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return /^lbt-driver-/.test(k) && k !== SHELL; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("message", function (e) {
  if (e.data && e.data.type === "clear") e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return /^lbt-driver-pages-/.test(k); }).map(function (k) { return caches.delete(k); })); }));
});
self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  var isShell = PRECACHE.some(function (path) { return url.pathname === path; });
  if (isShell) {
    e.respondWith(caches.open(SHELL).then(function (c) {
      return c.match(url.pathname).then(function (hit) { return hit || fetch(req); });
    }));
    return;
  }
  if (req.mode === "navigate" && /^\/app\/driver(?:\/|$)/.test(url.pathname)) {
    e.respondWith(fetch(req).catch(function () { return caches.match("/app/driver/offline"); }));
  }
});
