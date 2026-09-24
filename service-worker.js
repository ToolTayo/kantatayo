const CACHE_PREFIX = "kantatayo-";
const CACHE_NAME = "kantatayo-shell-v20";
const INDEX_URL = new URL("./index.html", self.location.href).href;
const APP_SHELL_URLS = [
  "./",
  "./index.html",
  "./styles/main.css",
  "./styles/main.css?v=14",
  "./src/app.js",
  "./src/app.js?v=14",
  "./src/catalog.js",
  "./src/discovery.js",
  "./src/discovery.js?v=2",
  "./src/preferences.js",
  "./src/recommendations.js",
  "./src/party.js",
  "./src/state.js",
  "./src/storage.js",
  "./src/ui.js",
  "./src/ui.js?v=11",
  "./src/focus.js",
  "./src/utils.js",
  "./src/view.js",
  "./src/youtube.js",
  "./data/songs.sample.json",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-192.svg",
  "./assets/icon-512.svg"
];
const APP_SHELL_PATHS = new Set(APP_SHELL_URLS.map((path) => new URL(path, self.location.href).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      if (!response.ok) throw new Error("Navigation request failed.");
      return response;
    }).catch(() => caches.match(INDEX_URL)));
    return;
  }

  if (!APP_SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (!response.ok) return response;
    return caches.open(CACHE_NAME).then((cache) => {
      cache.put(request, response.clone());
      return response;
    });
  })));
});
