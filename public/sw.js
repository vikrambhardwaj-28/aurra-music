/* Aura Music service worker — required for real Install (not only shortcut) */
const CACHE = "aura-music-v3";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(["/", "/manifest.json", "/logo-192.png", "/logo-512.png", "/logo.png"]).catch(() => {})
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  // App shell: network first, cache fallback
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("/") || caches.match(req))
    );
    return;
  }

  // Static assets: cache first
  if (/\.(?:js|css|png|svg|json|ico|woff2?|webp)$/i.test(url.pathname) ||
      url.pathname === "/manifest.json") {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetching = fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached);
        return cached || fetching;
      })
    );
  }
});
