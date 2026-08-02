// Makes the portal installable and fast to reopen.
//
// The hard rule here: never show a client stale code. An installed web app on
// iOS is lazy about checking for a new service worker, so a client can keep
// running an old copy for days without knowing. Everything below is arranged
// so the newest version wins as soon as it exists, and the cache is only ever
// a fallback for being genuinely offline.
//
// Bump CACHE on every shell change. The old one is deleted on activate.
const CACHE = "home-portal-v3";
const SHELL = ["./", "./index.html", "./manifest.json", "./text.html"];

self.addEventListener("install", (e) => {
  // Fetch fresh copies rather than whatever the browser already had.
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Let the page ask us to hand over immediately after an update.
self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Supabase or fonts

  // Pages always come from the network when the network is there, so a client
  // cannot be left looking at an old version of the portal.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
