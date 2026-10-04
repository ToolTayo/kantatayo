const CACHE_PREFIX = "kantacue-";
const LEGACY_CACHE_PREFIX = "kantatayo-";
const CACHE_NAME = "kantacue-shell-v106";
const INDEX_URL = new URL("./index.html", self.location.href).href;
const APP_SHELL_URLS = [
  "./",
  "./index.html",
  "./styles/main.css",
  "./styles/main.css?v=46",
  "./src/app.js",
  "./src/app.js?v=59",
  "./src/catalog.js?v=3",
  "./src/catalog.js",
  "./src/discovery.js",
  "./src/discovery.js?v=5",
  "./src/discovery.js?v=6",
  "./src/engagement.js",
  "./src/engagement.js?v=6",
  "./src/daily-challenge.js?v=2",
  "./src/daily-challenge.js",
  "./src/collections.js",
  "./src/collections.js?v=1",
  "./src/preferences.js",
  "./src/recommendations.js",
  "./src/party.js",
  "./src/party.js?v=2",
  "./src/state.js",
  "./src/state.js?v=7",
  "./src/state.js?v=8",
  "./src/storage.js",
  "./src/ui.js",
  "./src/ui.js?v=43",
  "./src/install.js",
  "./src/share.js",
  "./src/session.js?v=2",
  "./src/session.js",
  "./src/find-song.js",
  "./src/find-song.js?v=2",
  "./src/focus.js",
  "./src/utils.js",
  "./src/view.js",
  "./src/view.js?v=2",
  "./src/view.js?v=4",
  "./src/youtube.js",
  "./src/medleys.js",
  "./src/medleys.js?v=7",
  "./src/player-suggestions.js",
  "./src/player-suggestions.js?v=3",
  "./src/player-timing.js",
  "./src/player-timing.js?v=1",
  "./data/songs.sample.json",
  "./data/songs.sample.json?v=14",
  "./data/medleys.sample.json",
  "./data/medleys.sample.json?v=7",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-192.svg",
  "./assets/icon-512.svg",
  "./assets/brand/kantacue-mark.svg",
  "./assets/brand/kantacue-mark-small.svg",
  "./assets/brand/kantacue-logo.svg",
];
const APP_SHELL_PATHS = new Set(APP_SHELL_URLS.map((path) => new URL(path, self.location.href).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => (key.startsWith(CACHE_PREFIX) || key.startsWith(LEGACY_CACHE_PREFIX)) && key !== CACHE_NAME)
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
    }).catch(() => caches.match(request).then((cached) => cached || caches.match(INDEX_URL))));
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
