/* Offline support: while online every load fetches the latest deploy from the
   network; the cache is only a fallback for when the network is unreachable.
   Tickets live in localStorage, which the service worker never touches. */
var VERSION = "event-lottery-v5";
var ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./lottery.js",
  "./effects.js",
  "./scan.js",
  "./app.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== VERSION; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* Network-first: reloads always see the newest deploy while online.
   Only when the network fails do we serve the cached copy. */
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(VERSION).then(function (c) { return c.put(req, copy); }).catch(function () {});
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        if (req.mode === "navigate") return caches.match("./index.html");
        return Promise.reject(new Error("offline"));
      });
    })
  );
});
