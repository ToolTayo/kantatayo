import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getContinueSingingSongs, getDailyChallenge, getLocalStats, getRecentlyAddedSongs, getStreakStats, getTrendingSongs } from "../src/engagement.js";
import { completeDailyChallenge, createDefaultUserState, loadUserState, recordSongPlayed, saveUserState } from "../src/state.js";

const songs = JSON.parse(await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8"));
const playable = songs.filter((song) => /^[A-Za-z0-9_-]{11}$/.test(song.youtubeVideoId || ""));

test("daily challenge is deterministic, playable, and local-date based", () => {
  const userState = createDefaultUserState();
  const first = getDailyChallenge(songs, userState, { now: new Date(2026, 8, 25) });
  const repeat = getDailyChallenge(songs, userState, { now: new Date(2026, 8, 25, 21) });
  assert.ok(first.song);
  assert.ok(playable.some((song) => song.id === first.song.id));
  assert.equal(first.song.id, repeat.song.id);
  assert.equal(first.completed, false);
});

test("daily streaks distinguish current and longest runs", () => {
  assert.deepEqual(getStreakStats(["2026-09-20", "2026-09-21", "2026-09-23", "2026-09-24", "2026-09-25"], "2026-09-25"), {
    currentStreak: 3,
    longestStreak: 3
  });
  assert.deepEqual(getStreakStats(["2026-09-20", "2026-09-21", "2026-09-23"], "2026-09-25"), {
    currentStreak: 0,
    longestStreak: 2
  });
});

test("continue singing combines recent plays and sung history without duplicate records", () => {
  const state = createDefaultUserState();
  recordSongPlayed(state, playable[0].id, { now: "2026-09-25T01:00:00Z" });
  recordSongPlayed(state, playable[1].id, { now: "2026-09-25T02:00:00Z" });
  state.sungHistory = [{ id: playable[1].id, sungAt: "2026-09-24T02:00:00Z" }, { id: playable[2].id, sungAt: "2026-09-23T02:00:00Z" }];
  assert.deepEqual(getContinueSingingSongs(songs, state, 3).map((song) => song.id), [playable[1].id, playable[0].id, playable[2].id]);
});

test("recently added shelf follows appended catalog order and trending waits for real local activity", () => {
  const recent = getRecentlyAddedSongs(songs, 3);
  assert.equal(recent.length, 3);
  assert.equal(recent[0].id, "sample-190");
  const state = createDefaultUserState();
  assert.deepEqual(getTrendingSongs(songs, state), []);
  state.favorites = [playable[0].id];
  assert.deepEqual(getTrendingSongs(songs, state, 1).map((song) => song.id), [playable[0].id]);
});

test("local stats remain derived from history and survive state persistence", () => {
  const state = createDefaultUserState();
  state.sungHistory = [
    { id: songs.find((song) => song.language.toLowerCase() === "filipino" && song.youtubeVideoId)?.id, sungAt: "2026-09-25T01:00:00Z" },
    { id: songs.find((song) => song.language.toLowerCase() === "english" && song.youtubeVideoId)?.id, sungAt: "2026-09-24T01:00:00Z" }
  ];
  completeDailyChallenge(state, "2026-09-25");
  const stats = getLocalStats(songs, state, { now: new Date(2026, 8, 25) });
  assert.equal(stats.songsSung, 2);
  assert.equal(stats.opm, 1);
  assert.equal(stats.international, 1);
  assert.equal(stats.currentStreak, 1);

  const storage = new Map();
  const adapter = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  saveUserState(state, { storage: adapter });
  const reloaded = loadUserState({ storage: adapter });
  assert.deepEqual(reloaded.dailyChallenge.completedDates, ["2026-09-25"]);
  assert.deepEqual(reloaded.sungHistory, state.sungHistory);
});

test("malformed engagement fields degrade safely during migration", () => {
  const storage = new Map([["kantatayo:user-state", JSON.stringify({ version: 1, favorites: ["sample-001"], recentlyPlayed: "bad", dailyChallenge: { completedDates: ["not-a-date", 4] } })]]);
  const adapter = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const state = loadUserState({ storage: adapter });
  assert.equal(state.version, 3);
  assert.deepEqual(state.recentlyPlayed, []);
  assert.deepEqual(state.dailyChallenge.completedDates, []);
  assert.deepEqual(state.favorites, ["sample-001"]);
});
