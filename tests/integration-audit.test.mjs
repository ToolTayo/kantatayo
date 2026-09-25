import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  addSongToQueue,
  createAppState,
  createDefaultUserState,
  loadUserState,
  markSung,
  removeSongFromQueue,
  saveUserState,
  setCatalog,
  setCurrentSong,
  setPreferenceValues,
  toggleDislike,
  toggleFavorite,
  toggleLike
} from "../src/state.js";

test("catalog reconciliation removes newly unavailable songs from persisted queue without deleting catalog identity", () => {
  const appState = createAppState({ ...createDefaultUserState(), queue: ["sample-010", "sample-011"], currentSongId: "sample-010" });
  setCatalog(appState, [
    { id: "sample-010", title: "No Scrubs", artist: "TLC", youtubeVideoId: null },
    { id: "sample-011", title: "Kahit Kailan", artist: "South Border", youtubeVideoId: "aaaaaaaaaaa" }
  ], []);
  assert.deepEqual(appState.user.queue, ["sample-011"]);
  assert.equal(appState.user.currentSongId, null);
});

test("durable feedback transitions keep positive and negative signals consistent", () => {
  const userState = createDefaultUserState();

  assert.equal(toggleFavorite(userState, "sample-001"), true);
  assert.equal(toggleLike(userState, "sample-001"), true);
  assert.deepEqual(userState.favorites, ["sample-001"]);
  assert.deepEqual(userState.likedSongs, ["sample-001"]);

  assert.equal(toggleDislike(userState, "sample-001"), true);
  assert.deepEqual(userState.likedSongs, []);
  assert.deepEqual(userState.dislikedSongs, ["sample-001"]);
  assert.deepEqual(userState.favorites, ["sample-001"], "dislike must not erase a favorite");

  assert.equal(toggleLike(userState, "sample-001"), true);
  assert.deepEqual(userState.dislikedSongs, []);
  assert.deepEqual(userState.likedSongs, ["sample-001"]);
});

test("queue and current-song transitions remain recoverable after removals", () => {
  const userState = createDefaultUserState();
  assert.equal(addSongToQueue(userState, "sample-001"), true);
  assert.equal(addSongToQueue(userState, "sample-002"), true);
  assert.equal(setCurrentSong(userState, "sample-001"), true);

  assert.equal(removeSongFromQueue(userState, "sample-001"), true);
  assert.deepEqual(userState.queue, ["sample-002"]);
  assert.equal(userState.currentSongId, "sample-002");

  assert.equal(removeSongFromQueue(userState, "sample-002"), true);
  assert.deepEqual(userState.queue, []);
  assert.equal(userState.currentSongId, null);
  assert.equal(addSongToQueue(userState, "sample-001"), true, "removed songs can be queued again");
});

test("rapid repeated Sang it actions do not duplicate history, but later performances do", () => {
  const userState = createDefaultUserState();
  const now = Date.parse("2026-09-22T00:00:00.000Z");

  assert.equal(markSung(userState, "sample-001", { now }).added, true);
  assert.equal(markSung(userState, "sample-001", { now: now + 1000 }).added, false);
  assert.equal(markSung(userState, "sample-001", { now: now + 3000 }).added, true);
  assert.equal(userState.sungHistory.length, 2);
});

test("persisted state reload preserves preferences and durable collections", () => {
  const storage = createMemoryStorage();
  const userState = createDefaultUserState();
  setPreferenceValues(userState, "languages", ["Filipino"]);
  setPreferenceValues(userState, "difficulties", ["easy", "medium"]);
  userState.favorites = ["sample-001"];
  userState.likedSongs = ["sample-002"];
  userState.sungHistory = [{ id: "sample-003", sungAt: "2026-09-22T00:00:00.000Z" }];
  userState.queue = ["sample-001", "sample-002"];
  userState.currentSongId = "sample-002";

  assert.equal(saveUserState(userState, { storage }), true);
  const reloaded = loadUserState({ storage });
  assert.deepEqual(reloaded.preferences.languages, ["filipino"]);
  assert.deepEqual(reloaded.preferences.difficulties, ["easy", "medium"]);
  assert.deepEqual(reloaded.favorites, ["sample-001"]);
  assert.deepEqual(reloaded.likedSongs, ["sample-002"]);
  assert.deepEqual(reloaded.sungHistory, userState.sungHistory);
  assert.deepEqual(reloaded.queue, userState.queue);
  assert.equal(reloaded.currentSongId, "sample-002");
});

test("malformed persisted fields degrade to safe defaults without losing valid fields", () => {
  const loaded = loadUserState({
    storage: createMemoryStorage({
      "kantatayo:user-state": JSON.stringify({
        version: 1,
        favorites: [" sample-001 ", 42, "sample-001"],
        preferences: { languages: "Filipino", genres: [" Pop ", null, "pop"] },
        queue: "not-an-array",
        currentSongId: "sample-001",
        sungHistory: [{ id: "sample-002", sungAt: "not-a-date" }]
      })
    })
  });

  assert.deepEqual(loaded.favorites, ["sample-001"]);
  assert.deepEqual(loaded.preferences.languages, []);
  assert.deepEqual(loaded.preferences.genres, ["pop"]);
  assert.deepEqual(loaded.queue, []);
  assert.equal(loaded.currentSongId, null);
  assert.deepEqual(loaded.sungHistory, []);
});

test("Step 10 UI resilience hooks are present without changing catalog or player boundaries", async () => {
  const [html, app, ui] = await Promise.all([
    readFile("index.html", "utf8"),
    readFile("src/app.js", "utf8"),
    readFile("src/ui.js", "utf8")
  ]);

  assert.match(html, /data-catalog-loading/);
  assert.match(html, /data-section-empty/);
  assert.match(html, /data-discover-empty/);
  assert.match(html, /data-player-status/);
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Karaoke queue"/);
  assert.match(html, /data-youtube-shell/);
  assert.match(html, /data-youtube-mount/);
  assert.match(app, /event\.key !== "Escape"/);
  assert.match(app, /focusSongActionOrQueue/);
  assert.match(ui, /return document\.activeElement === target/);
});

test("directed product shell keeps desktop and mobile navigation structurally distinct", async () => {
  const [html, css, app, ui] = await Promise.all([
    readFile("index.html", "utf8"),
    readFile("styles/main.css", "utf8"),
    readFile("src/app.js", "utf8"),
    readFile("src/ui.js", "utf8")
  ]);

  assert.match(html, /class="topbar-search" data-search-form/);
  assert.match(html, /class="app-sidebar"/);
  assert.match(html, /class="mobile-nav"/);
  assert.match(html, /data-section="favorites"/);
  assert.match(html, /data-mini-player/);
  assert.match(html, /main\.css\?v=15/);
  assert.match(html, /app\.js\?v=15/);
  assert.match(html, /data-view-panel="home"/);
  assert.match(html, /data-view-panel="discover"/);
  assert.match(css, /\.app-sidebar \{ display: none !important; \}/);
  assert.match(css, /\.app-sidebar \{ background:/);
  assert.match(css, /\.mobile-nav \{ display: none !important; \}/);
  assert.match(css, /\.skip-link:focus \{ top:/);
  assert.match(ui, /song-more-menu/);
  assert.match(ui, /data-mini-player/);
  assert.match(app, /action === "clear-search"/);
  assert.match(app, /action === "open-player"/);
});

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}
