// PiggyNest Service Worker - Offline Caching Infrastructure
const CACHE_NAME = "piggynest-v1";

const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=8",
  "./js/app.js?v=8",
  "./js/db.js",
  "./js/calc.js",
  "./js/savings.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
];

// Install: precache application shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up older caches and claim clients immediately
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.map((name) => {
            if (name !== CACHE_NAME) {
              return caches.delete(name);
            }
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: Stale-While-Revalidate caching strategy with network fallback
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Non-GET requests should always go directly to the network
  if (req.method !== "GET") {
    return;
  }

  const url = new URL(req.url);

  // Firestore and Auth APIs bypass the service worker cache
  if (
    url.hostname.includes("firestore.googleapis.com") ||
    url.hostname.includes("identitytoolkit.googleapis.com") ||
    url.hostname.includes("securetoken.googleapis.com")
  ) {
    return;
  }

  // Only handle http / https schemes
  if (!url.protocol.startsWith("http")) {
    return;
  }

  // Static requests: serve cached response if present, revalidate in background
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            (networkResponse.type === "basic" || networkResponse.type === "cors")
          ) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(req, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch((err) => {
          // If offline and request is navigation, fallback to index.html
          if (!cachedResponse && req.mode === "navigate") {
            return caches.match("./index.html");
          }
          if (!cachedResponse) {
            throw err;
          }
        });

      return cachedResponse || fetchPromise;
    })
  );
});
