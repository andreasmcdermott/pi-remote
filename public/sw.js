const CACHE_NAME = "pi-remote-v1";
const SHELL = ["/", "/index.html", "/style.css", "/client.js", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (evt) => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
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

self.addEventListener("fetch", (evt) => {
  // Only cache GET requests for same-origin non-WebSocket resources
  if (evt.request.method !== "GET") return;
  const url = new URL(evt.request.url);
  if (url.protocol === "ws:" || url.protocol === "wss:") return;

  evt.respondWith(
    caches.match(evt.request).then((cached) => {
      if (cached) return cached;
      return fetch(evt.request).then((resp) => {
        if (resp && resp.status === 200 && resp.type === "basic") {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(evt.request, clone));
        }
        return resp;
      });
    })
  );
});
