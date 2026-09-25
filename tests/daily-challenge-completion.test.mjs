import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getDailyChallenge, getStreakStats } from "../src/engagement.js";
import { completeDailyChallenge, createDefaultUserState, loadUserState, saveUserState } from "../src/state.js";

const songs = ["One", "Two", "Three", "Four", "Five"].map((title, index) => ({
  id: `challenge-${index + 1}`,
  title,
  artist: index % 2 ? "Artist B" : "Artist A",
  language: "English",
  youtubeVideoId: `abcde${String(index).padStart(6, "0")}`
}));

const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
};

test("first completion is intentional, exact-song, and idempotent", () => {
  const state = createDefaultUserState();
  const now = new Date(2026, 8, 25, 20);
  const challenge = getDailyChallenge(songs, state, { now });

  assert.equal(completeDailyChallenge(state, challenge.dateKey, challenge.song.id, { now, expectedSongId: challenge.song.id }), true);
  assert.equal(completeDailyChallenge(state, challenge.dateKey, challenge.song.id, { now, expectedSongId: challenge.song.id }), false);
  assert.equal(completeDailyChallenge(state, challenge.dateKey, songs.find((song) => song.id !== challenge.song.id).id, { now, expectedSongId: challenge.song.id }), false);
  assert.deepEqual(state.dailyChallenge.completedDates, [challenge.dateKey]);
  assert.equal(state.dailyChallenge.lastCompletedSongId, challenge.song.id);
  assert.deepEqual(getDailyChallenge(songs, state, { now }), { dateKey: challenge.dateKey, song: challenge.song, completed: true, currentStreak: 1, longestStreak: 1 });
});

test("completion must be for today and survives reload without copying a song", () => {
  const state = createDefaultUserState();
  const now = new Date(2026, 8, 25, 10);
  const challenge = getDailyChallenge(songs, state, { now });
  assert.equal(completeDailyChallenge(state, "2026-09-24", challenge.song.id, { now }), false);
  assert.equal(completeDailyChallenge(state, challenge.dateKey, challenge.song.id, { now }), false);

  const storage = memoryStorage();
  saveUserState(state, { storage });
  const reloaded = loadUserState({ storage });
  assert.deepEqual(reloaded.dailyChallenge.completedDates, []);

  assert.equal(completeDailyChallenge(reloaded, challenge.dateKey, challenge.song.id, { now, expectedSongId: challenge.song.id }), true);
  saveUserState(reloaded, { storage });
  const afterReload = loadUserState({ storage });
  assert.equal(afterReload.dailyChallenge.lastCompletedSongId, challenge.song.id);
  assert.equal(Object.keys(afterReload.dailyChallenge).includes("song"), false);
});

test("consecutive dates, missed days, month/year boundaries, and leap days are calendar-safe", () => {
  assert.deepEqual(getStreakStats(["2026-02-28", "2026-03-01"], "2026-03-01"), { currentStreak: 2, longestStreak: 2 });
  assert.deepEqual(getStreakStats(["2025-12-31", "2026-01-01"], "2026-01-01"), { currentStreak: 2, longestStreak: 2 });
  assert.deepEqual(getStreakStats(["2024-02-28", "2024-02-29", "2024-03-01"], "2024-03-01"), { currentStreak: 3, longestStreak: 3 });
  assert.deepEqual(getStreakStats(["2026-03-01", "2026-03-03"], "2026-03-03"), { currentStreak: 1, longestStreak: 1 });
  assert.deepEqual(getStreakStats(["2026-09-24"], "2026-09-25"), { currentStreak: 1, longestStreak: 1 });
});

test("future and malformed completion dates are ignored", () => {
  assert.deepEqual(getStreakStats(["bad", "2026-09-24", "2026-09-25T00:00:00", "2026-12-31"], "2026-09-25"), { currentStreak: 1, longestStreak: 1 });
});

test("version 3 state migrates while preserving existing user data", () => {
  const storage = memoryStorage({
    "kantatayo:user-state": JSON.stringify({
      version: 3,
      favorites: ["challenge-1"],
      likedSongs: ["challenge-2"],
      queue: ["challenge-3"],
      dailyChallenge: { completedDates: ["2026-09-24"] }
    })
  });
  const state = loadUserState({ storage });
  assert.equal(state.version, 4);
  assert.deepEqual(state.favorites, ["challenge-1"]);
  assert.deepEqual(state.likedSongs, ["challenge-2"]);
  assert.deepEqual(state.queue, ["challenge-3"]);
  assert.deepEqual(state.dailyChallenge, { completedDates: ["2026-09-24"], lastCompletedDate: null, lastCompletedSongId: null });
});

test("the completion path remains in the existing Sang It action and does not add a second player", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /action === "mark-sung"/);
  assert.match(app, /completeDailyChallenge\(state\.user, challenge\.dateKey, song\.id/);
});
