import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.webmanifest", "utf8"));
const serviceWorker = await readFile("service-worker.js", "utf8");
const app = await readFile("src/app.js", "utf8");
const ui = await readFile("src/ui.js", "utf8");

test("manifest is installable and references existing original icons", async () => {
  assert.equal(manifest.name, "KantaTayo");
  assert.equal(manifest.short_name, "KantaTayo");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#0b0f1a");
  assert.equal(manifest.background_color, "#080c15");
  assert.ok(Array.isArray(manifest.icons));
  assert.deepEqual(manifest.icons.filter((icon) => icon.type === "image/png").map((icon) => icon.sizes), ["192x192", "512x512"]);

  for (const icon of manifest.icons) {
    const iconBuffer = await readFile(icon.src);
    assert.ok(iconBuffer.length > 100);
    if (icon.type === "image/svg+xml") {
      assert.match(iconBuffer.toString("utf8"), /<svg\b/);
    } else {
      assert.deepEqual([...iconBuffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    }
  }
});

test("service worker caches only the explicit first-party app shell", () => {
  const expectedResources = [
    "./",
    "./index.html",
    "./styles/main.css",
    "./src/app.js",
    "./src/catalog.js",
    "./src/discovery.js",
    "./src/preferences.js",
    "./src/recommendations.js",
    "./src/party.js",
    "./src/state.js",
    "./src/storage.js",
    "./src/ui.js",
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

  for (const resource of expectedResources) assert.match(serviceWorker, new RegExp(`"${resource.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"`));
  assert.match(serviceWorker, /"\.\/styles\/main\.css\?v=14"/);
  assert.match(serviceWorker, /"\.\/src\/app\.js\?v=14"/);
  assert.match(serviceWorker, /"\.\/src\/discovery\.js\?v=2"/);
  assert.match(serviceWorker, /"\.\/src\/ui\.js\?v=11"/);
  assert.match(serviceWorker, /"\.\/src\/focus\.js"/);
  assert.match(serviceWorker, /CACHE_NAME = "kantatayo-shell-v20"/);
  assert.match(serviceWorker, /url\.origin !== self\.location\.origin/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /key\.startsWith\(CACHE_PREFIX\)/);
  assert.match(serviceWorker, /caches\.match\(INDEX_URL\)/);
  assert.doesNotMatch(serviceWorker, /https?:\/\//i);
  assert.doesNotMatch(serviceWorker, /youtube\.com|ytimg\.com|\.(?:mp4|webm|m4a|mp3)(?:["'])/i);
});

test("app registers the service worker safely and keeps offline playback explicit", () => {
  assert.match(app, /"serviceWorker" in navigator/);
  assert.match(app, /navigator\.serviceWorker\.register\("\.\/service-worker\.js"/);
  assert.match(app, /navigator\.onLine === false/);
  assert.match(app, /showPlayerOffline\(\)/);
  assert.match(ui, /Karaoke videos need an internet connection/);
});

test("PWA boundaries preserve the local catalog and protected video assignments", async () => {
  const songs = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
    assert.equal(songs.length, 170);
  assert.equal(songs.filter((song) => song.youtubeVideoId !== null).length, 151);
    assert.deepEqual(songs.map((song) => song.id), Array.from({ length: 170 }, (_, index) => `sample-${String(index + 1).padStart(3, "0")}`));
    assert.equal(new Set(songs.map((song) => song.id)).size, 170);
    assert.equal(new Set(songs.map((song) => `${song.title.toLocaleLowerCase()}\u0000${song.artist.toLocaleLowerCase()}`)).size, 170);
  assert.equal(songs.find((song) => song.id === "sample-008").youtubeVideoId, null);
  assert.equal(songs.find((song) => song.id === "sample-009").youtubeVideoId, null);
  assert.equal(songs.find((song) => song.id === "sample-029").youtubeVideoId, "QBb9wO3Bj0k");
});
