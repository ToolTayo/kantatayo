import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getContinueSingingSongs, getDailyChallenge } from "../src/engagement.js";
import { addSongToQueue, completeDailyChallenge, createDefaultUserState, loadUserState, markSung, saveUserState, toggleFavorite, recordSongPlayed } from "../src/state.js";

const songs = Array.from({ length: 10 }, (_, index) => ({
  id: `continue-${String(index + 1).padStart(3, "0")}`,
  title: `Song ${index + 1}`,
  artist: `Artist ${index + 1}`,
  youtubeVideoId: `video${String(index + 1).padStart(6, "0")}`
}));

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
}

test("meaningful opens create one unfinished entry and refresh its recency", () => {
  const state = createDefaultUserState();
  recordSongPlayed(state, songs[0].id, { now: "2026-09-25T01:00:00Z" });
  recordSongPlayed(state, songs[1].id, { now: "2026-09-25T02:00:00Z" });
  recordSongPlayed(state, songs[0].id, { now: "2026-09-25T03:00:00Z" });
  assert.deepEqual(getContinueSingingSongs(songs, state, 10).map((song) => song.id), [songs[0].id, songs[1].id]);
  assert.equal(state.recentlyPlayed.length, 2);
});

test("queue-only, favorite-only, search-only, and view-only activity does not create Continue Singing", async () => {
  const state = createDefaultUserState();
  addSongToQueue(state, songs[0].id);
  toggleFavorite(state, songs[1].id);
  assert.deepEqual(getContinueSingingSongs(songs, state), []);

  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /function startSong\(song, launcher = null\)/);
  assert.match(app, /recordSongPlayed\(state\.user, song\.id\)/);
  assert.match(app, /if \(action === "add-queue" && song\) addToQueue\(song\)/);
});

test("Sang It resolves the current unfinished entry, while reopening starts a new unfinished session", () => {
  const state = createDefaultUserState();
  recordSongPlayed(state, songs[0].id, { now: "2026-09-25T01:00:00Z" });
  assert.deepEqual(getContinueSingingSongs(songs, state).map((song) => song.id), [songs[0].id]);
  markSung(state, songs[0].id, { now: "2026-09-25T02:00:00Z" });
  assert.deepEqual(getContinueSingingSongs(songs, state), []);

  recordSongPlayed(state, songs[0].id, { now: "2026-09-25T03:00:00Z" });
  assert.deepEqual(getContinueSingingSongs(songs, state).map((song) => song.id), [songs[0].id]);
});

test("daily challenge completion removes unfinished content without removing streak state", () => {
  const state = createDefaultUserState();
  const now = new Date(2026, 8, 25, 18);
  const challenge = getDailyChallenge(songs, state, { now });
  recordSongPlayed(state, challenge.song.id, { now });
  assert.deepEqual(getContinueSingingSongs(songs, state).map((song) => song.id), [challenge.song.id]);
  markSung(state, challenge.song.id, { now: new Date(now.getTime() + 1000) });
  assert.equal(completeDailyChallenge(state, challenge.dateKey, challenge.song.id, { now, expectedSongId: challenge.song.id }), true);
  assert.deepEqual(getContinueSingingSongs(songs, state), []);
  assert.deepEqual(getDailyChallenge(songs, state, { now }), { dateKey: challenge.dateKey, song: challenge.song, completed: true, currentStreak: 1, longestStreak: 1 });
});

test("reload preserves bounded unfinished activity and ignores malformed or deleted IDs", () => {
  const state = createDefaultUserState();
  songs.forEach((song, index) => recordSongPlayed(state, song.id, { now: new Date(2026, 8, 25, 0, index) }));
  state.recentlyPlayed.push({ id: "deleted-song", playedAt: "2026-09-25T23:00:00Z" }, { id: "bad", playedAt: "not-a-date" });
  const storage = memoryStorage();
  saveUserState(state, { storage });
  const reloaded = loadUserState({ storage });
  assert.equal(reloaded.recentlyPlayed.length, 8);
  const unfinished = getContinueSingingSongs(songs, reloaded, 20);
  assert.equal(unfinished.some((song) => song.id === "deleted-song"), false);
  assert.equal(unfinished.length, 7);
  assert.equal(getContinueSingingSongs(songs.filter((song) => song.id !== songs[0].id), reloaded, 20).some((song) => song.id === songs[0].id), false);

  const duplicateStorage = memoryStorage({
    "kantatayo:user-state": JSON.stringify({ ...createDefaultUserState(), recentlyPlayed: [
      { id: songs[0].id, playedAt: "2026-09-25T01:00:00Z" },
      { id: songs[0].id, playedAt: "2026-09-25T04:00:00Z" }
    ] })
  });
  assert.equal(loadUserState({ storage: duplicateStorage }).recentlyPlayed[0].playedAt, "2026-09-25T04:00:00Z");
});

test("Continue Singing is hidden when empty and retains shared bounded card sizing", async () => {
  const [html, ui, css] = await Promise.all([
    readFile("index.html", "utf8"),
    readFile("src/ui.js", "utf8"),
    readFile("styles/main.css", "utf8")
  ]);
  assert.match(html, /data-section="continue"[^>]*hidden/);
  assert.match(ui, /sectionElement\.hidden = isRecommended \? false : songs\.length === 0/);
  assert.match(css, /\.song-grid,\s*\.compact-grid[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 16rem\), 20rem\)\)/);
});
