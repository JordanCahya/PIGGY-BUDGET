// PiggyNest Service Worker - Offline Caching Infrastructure
const CACHE_NAME = "piggynest-v11";

const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=18",
  "./js/app.js?v=18",
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

// Message: listen for skipWaiting command from client update prompt
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Fetch: Network-First for navigation, Stale-While-Revalidate for static assets
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

  const isNavigation =
    req.mode === "navigate" ||
    (req.headers.get("accept") && req.headers.get("accept").includes("text/html")) ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html");

  if (isNavigation) {
    // Network-First strategy with timeout fallback for navigation
    event.respondWith(
      new Promise((resolve) => {
        let timedOut = false;
        const timeoutId = setTimeout(() => {
          timedOut = true;
          caches.match(req).then((cached) => {
            if (cached) resolve(cached);
            else caches.match("./index.html").then((fallback) => resolve(fallback || caches.match("./")));
          });
        }, 2500);

        fetch(req)
          .then((networkResponse) => {
            clearTimeout(timeoutId);
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
            if (!timedOut) resolve(networkResponse);
          })
          .catch(() => {
            clearTimeout(timeoutId);
            caches.match(req).then((cached) => {
              if (cached) resolve(cached);
              else caches.match("./index.html").then((fallback) => resolve(fallback || caches.match("./")));
            });
          });
      })
    );
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
        .catch(() => {
          return cachedResponse;
        });

      return cachedResponse || fetchPromise;
    })
  );
});
