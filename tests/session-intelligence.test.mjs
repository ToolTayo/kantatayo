import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeCatalog } from "../src/catalog.js";
import { getRecommendations } from "../src/recommendations.js";
import {
  createDefaultSessionState,
  getSessionSummary,
  loadSessionState,
  persistSessionState,
  pruneSessionState,
  recordSessionCompleted,
  recordSessionOpened,
  SESSION_STORAGE_KEY
} from "../src/session.js";
import { createDefaultUserState } from "../src/state.js";

const NOW = Date.parse("2026-09-22T00:00:00.000Z");
const catalog = normalizeCatalog(
  JSON.parse(await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8")),
  { logger: { warn() {} } }
).songs;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
}

test("session records distinguish opened from completed and deduplicate recency", () => {
  const session = createDefaultSessionState(NOW);
  recordSessionOpened(session, "sample-001", { now: NOW + 1 });
  recordSessionOpened(session, "sample-001", { now: NOW + 2 });
  recordSessionCompleted(session, "sample-001", { now: NOW + 3 });

  assert.equal(session.opened.length, 1);
  assert.equal(session.completed.length, 1);
  assert.equal(session.opened[0].id, "sample-001");
  assert.equal(session.opened[0].openedAt, new Date(NOW + 2).toISOString());
  assert.equal(session.completed[0].completedAt, new Date(NOW + 3).toISOString());
});

test("session state survives reload through sessionStorage without changing durable user state", () => {
  const storage = memoryStorage();
  const session = createDefaultSessionState(NOW);
  recordSessionOpened(session, "sample-002", { now: NOW + 1 });
  recordSessionCompleted(session, "sample-003", { now: NOW + 2 });
  assert.equal(persistSessionState(session, { storage }), true);

  const reloaded = loadSessionState({ storage, now: NOW + 3 });
  assert.deepEqual(reloaded, session);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY) !== null, true);
  assert.deepEqual(createDefaultUserState().favorites, []);
});

test("a new tab starts a fresh session while the existing tab can reload its own", () => {
  const previousTabStorage = memoryStorage();
  const previousTab = createDefaultSessionState(NOW);
  recordSessionCompleted(previousTab, "sample-001", { now: NOW + 1 });
  persistSessionState(previousTab, { storage: previousTabStorage });

  const newTabStorage = memoryStorage();
  const newTab = loadSessionState({ storage: newTabStorage, now: NOW + 2 });
  assert.equal(newTab.startedAt, new Date(NOW + 2).toISOString());
  assert.deepEqual(newTab.completed, []);
  assert.equal(loadSessionState({ storage: previousTabStorage, now: NOW + 2 }).completed.length, 1);
});

test("malformed, stale, unavailable, and duplicate session records fail safely", () => {
  const storage = memoryStorage({
    [SESSION_STORAGE_KEY]: JSON.stringify({
      version: 99,
      startedAt: "bad",
      opened: [
        { id: "sample-001", openedAt: "2026-09-22T00:00:00.000Z" },
        { id: "SAMPLE-001", openedAt: "2026-09-22T01:00:00.000Z" },
        { id: "missing", openedAt: "bad" }
      ],
      completed: "not-an-array"
    })
  });
  const session = loadSessionState({ storage, now: NOW });
  assert.equal(session.version, 1);
  assert.equal(session.opened.length, 1);
  assert.equal(session.opened[0].id, "SAMPLE-001");
  assert.deepEqual(session.completed, []);

  const changed = pruneSessionState(session, [
    { id: "sample-001", youtubeVideoId: "video000001" },
    { id: "sample-004", youtubeVideoId: null }
  ]);
  assert.equal(changed, false);
  recordSessionCompleted(session, "sample-004", { now: NOW });
  assert.equal(pruneSessionState(session, [{ id: "sample-001", youtubeVideoId: "video000001" }]), true);
  assert.deepEqual(session.completed, []);
});

test("session-aware recommendations suppress completed songs and soften artist saturation", () => {
  const repeatedArtist = "Sarah Geronimo";
  const completed = catalog.filter((song) => song.artist === repeatedArtist && song.youtubeVideoId).slice(0, 3);
  assert.equal(completed.length, 3);
  const session = createDefaultSessionState(NOW);
  completed.forEach((song, index) => recordSessionCompleted(session, song.id, { now: NOW - (index + 1) * 60_000 }));
  const userState = createDefaultUserState();
  userState.favorites = completed.map((song) => song.id);
  userState.likedSongs = completed.map((song) => song.id);

  const recommendations = getRecommendations(catalog, userState, { now: NOW, limit: 5, session });
  assert.equal(recommendations.some(({ song }) => completed.some((done) => done.id === song.id)), false);
  assert.equal(recommendations.some(({ song }) => song.artist === repeatedArtist), false);
  assert.ok(new Set(recommendations.map(({ song }) => song.artist)).size >= 4);
  assert.ok(recommendations.every(({ signals }) => signals.sessionArtistRepeatPenalty === 0));
});

test("session summary exposes only real completed metadata", () => {
  const session = createDefaultSessionState(NOW);
  recordSessionCompleted(session, "sample-001", { now: NOW });
  recordSessionCompleted(session, "sample-019", { now: NOW + 1 });
  recordSessionOpened(session, "missing", { now: NOW + 2 });

  const summary = getSessionSummary(catalog, session);
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.language, "OPM");
  assert.ok(summary.descriptors.includes("OPM"));
  assert.ok(summary.era);
  assert.doesNotMatch(summary.descriptors.join(" "), /missing/i);
});

test("queue and current-song exclusions remain separate from session intelligence", () => {
  const state = createDefaultUserState();
  state.queue = catalog.slice(0, 10).map((song) => song.id);
  state.currentSongId = state.queue[0];
  const session = createDefaultSessionState(NOW);
  recordSessionOpened(session, state.currentSongId, { now: NOW });
  const recommendations = getRecommendations(catalog, state, { now: NOW, limit: 12, session });
  const excluded = new Set(state.queue.map((id) => id.toLowerCase()));
  assert.equal(recommendations.some(({ song }) => excluded.has(song.id.toLowerCase())), false);
});

test("session implementation is deterministic and has no uncontrolled randomness", async () => {
  const source = await readFile(new URL("../src/session.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Math\.random/);
  const session = createDefaultSessionState(NOW);
  recordSessionCompleted(session, "sample-001", { now: NOW });
  const userState = createDefaultUserState();
  const first = getRecommendations(catalog, userState, { now: NOW, limit: 8, session });
  const second = getRecommendations(catalog, userState, { now: NOW, limit: 8, session });
  assert.deepEqual(first.map(({ song }) => song.id), second.map(({ song }) => song.id));
});

test("application integrates session context only at meaningful playback and completion boundaries", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /recordSessionOpened\(sessionState, song\.id\)/);
  assert.match(app, /recordSessionCompleted\(sessionState, song\.id\)/);
  assert.match(app, /getRecommendations\(state\.searchIndex\.map\(\(entry\) => entry\.song\), state\.user, \{ limit: 12, session: sessionState \}\)/);
  assert.doesNotMatch(app, /recordSessionOpened\(sessionState, song\.id\).*addToQueue/s);
});
