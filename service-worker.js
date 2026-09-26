const CACHE_PREFIX = "kantatayo-";
const CACHE_NAME = "kantatayo-shell-v42";
const INDEX_URL = new URL("./index.html", self.location.href).href;
const APP_SHELL_URLS = [
  "./",
  "./index.html",
  "./styles/main.css",
  "./styles/main.css?v=23",
  "./src/app.js",
  "./src/app.js?v=30",
  "./src/catalog.js?v=1",
  "./src/catalog.js?v=2",
  "./src/catalog.js",
  "./src/discovery.js",
  "./src/discovery.js?v=4",
  "./src/engagement.js",
  "./src/engagement.js?v=4",
  "./src/daily-challenge.js?v=2",
  "./src/daily-challenge.js",
  "./src/collections.js",
  "./src/collections.js?v=1",
  "./src/preferences.js",
  "./src/recommendations.js",
  "./src/party.js",
  "./src/party.js?v=1",
  "./src/state.js",
  "./src/state.js?v=5",
  "./src/storage.js",
  "./src/ui.js",
  "./src/ui.js?v=23",
  "./src/install.js",
  "./src/share.js",
  "./src/focus.js",
  "./src/utils.js",
  "./src/view.js",
  "./src/view.js?v=2",
  "./src/youtube.js",
  "./data/songs.sample.json",
  "./data/songs.sample.json?v=1",
  "./data/songs.exclusive.json",
  "./data/songs.exclusive.json?v=1",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-192.svg",
  "./assets/icon-512.svg",
  "./assets/kantatayo-stage-bg.png"
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
