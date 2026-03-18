const CACHE_NAME = "pi-remote-v3";
const PRECACHE_ASSETS = ["/", "/index.html", "/style.css", "/client.js", "/manifest.json", "/icon.svg"];
const NETWORK_FIRST_PATHS = new Set(["/", "/index.html", "/client.js", "/style.css", "/manifest.json"]);

self.addEventListener("install", (evt) => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (evt) => {
  evt.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === "basic") {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error("Network unavailable and no cache entry");
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.status === 200 && response.type === "basic") {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (evt) => {
  // Only cache GET requests for same-origin non-WebSocket resources
  if (evt.request.method !== "GET") return;
  const url = new URL(evt.request.url);
  if (url.protocol === "ws:" || url.protocol === "wss:") return;
  if (url.origin !== self.location.origin) return;

  const strategy = NETWORK_FIRST_PATHS.has(url.pathname) ? networkFirst : cacheFirst;
  evt.respondWith(strategy(evt.request));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text?.() ?? "" };
  }

  const title = data.title || "pi remote";
  const options = {
    body: data.body || "LLM finished working.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.tag || "pi-remote",
    renotify: true,
    data: { url: "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = allClients.find((c) => c.url.includes(self.location.origin));
    if (existing) {
      existing.focus();
      return;
    }
    await self.clients.openWindow(event.notification?.data?.url || "/");
  })());
});
