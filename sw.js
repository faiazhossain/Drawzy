/* Simple offline cache: app shell is served cache-first after first load. */
var VERSION = "event-lottery-v1";
var ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./lottery.js",
  "./effects.js",
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

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { return c.put(req, copy); }).catch(function () {});
        return res;
      }).catch(function () {
        if (req.mode === "navigate") return caches.match("./index.html");
        return Promise.reject(new Error("offline"));
      });
    })
  );
});
