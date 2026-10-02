import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CONTINUE_SINGING_MAX_AGE_DAYS, getContinueSingingSongs, getDailyChallenge, getLocalStats, getMostSungSongs, getQualifyingSungHistory, getRecentlyAddedSongs, getStreakStats } from "../src/engagement.js";
import { completeDailyChallenge, createDefaultUserState, loadUserState, recordSongPlayed, saveUserState } from "../src/state.js";

const songs = JSON.parse(await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8"));
const playable = songs.filter((song) => /^[A-Za-z0-9_-]{11}$/.test(song.youtubeVideoId || ""));
const filipinoSong = playable.find((song) => song.language.toLowerCase() === "filipino");
const englishSong = playable.find((song) => song.language.toLowerCase() === "english");
const unavailableSong = songs.find((song) => !song.youtubeVideoId);
const atLocalDay = (day, hour = 12) => new Date(2026, 8, day, hour).toISOString();

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
  assert.deepEqual(getContinueSingingSongs(songs, state, 3).map((song) => song.id), [playable[1].id, playable[0].id]);
  state.sungHistory.unshift({ id: playable[1].id, sungAt: "2026-09-25T03:00:00Z" });
  assert.deepEqual(getContinueSingingSongs(songs, state, 3).map((song) => song.id), [playable[0].id]);
});

test("continue singing suppresses stale and future activity without deleting local history", () => {
  const state = createDefaultUserState();
  const now = Date.parse("2026-09-25T12:00:00Z");
  const old = new Date(now - (CONTINUE_SINGING_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const future = new Date(now + 60 * 60 * 1000).toISOString();
  state.recentlyPlayed = [
    { id: playable[0].id, playedAt: old },
    { id: playable[1].id, playedAt: recent },
    { id: playable[2].id, playedAt: future }
  ];

  assert.deepEqual(getContinueSingingSongs(songs, state, 10, { now }), [playable[1]]);
  assert.equal(state.recentlyPlayed.length, 3, "suppression must not erase the underlying activity record");
});

test("recently added shelf follows appended catalog order and most-sung waits for real local activity", () => {
  const recent = getRecentlyAddedSongs(songs, 3);
  assert.equal(recent.length, 3);
  assert.equal(recent[0].id, songs.at(-1).id);
  const state = createDefaultUserState();
  assert.deepEqual(getMostSungSongs(songs, state), []);
  state.favorites = [playable[0].id];
  state.likedSongs = [playable[1].id];
  assert.deepEqual(getMostSungSongs(songs, state), []);
  state.sungHistory = [
    { id: playable[1].id, sungAt: "2026-09-25T02:00:00Z" },
    { id: playable[0].id, sungAt: "2026-09-25T01:00:00Z" },
    { id: playable[1].id, sungAt: "2026-09-24T02:00:00Z" }
  ];
  assert.deepEqual(getMostSungSongs(songs, state, 2).map((song) => song.id), [playable[1].id, playable[0].id]);
});

test("local stats remain derived from history and survive state persistence", () => {
  const state = createDefaultUserState();
  state.sungHistory = [
    { id: songs.find((song) => song.language.toLowerCase() === "filipino" && song.youtubeVideoId)?.id, sungAt: "2026-09-25T01:00:00Z" },
    { id: songs.find((song) => song.language.toLowerCase() === "english" && song.youtubeVideoId)?.id, sungAt: "2026-09-24T01:00:00Z" }
  ];
  const challengeSong = songs.find((song) => song.youtubeVideoId);
  completeDailyChallenge(state, "2026-09-25", challengeSong.id, { now: new Date(2026, 8, 25), expectedSongId: challengeSong.id });
  const stats = getLocalStats(songs, state, { now: new Date(2026, 8, 25, 23) });
  assert.equal(stats.songsSung, 2);
  assert.equal(stats.opm, 1);
  assert.equal(stats.international, 1);
  assert.equal(stats.currentStreak, 2);
  assert.equal(stats.longestStreak, 2);

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
  assert.equal(state.version, 4);
  assert.deepEqual(state.recentlyPlayed, []);
  assert.deepEqual(state.dailyChallenge.completedDates, []);
  assert.deepEqual(state.favorites, ["sample-001"]);
});

test("local stats start empty and ignore malformed, future, unknown, and unavailable history", () => {
  const state = createDefaultUserState();
  state.favorites = [filipinoSong.id, filipinoSong.id, "deleted-song"];
  state.sungHistory = [
    { id: unavailableSong.id, sungAt: atLocalDay(25) },
    { id: "deleted-song", sungAt: atLocalDay(25) },
    { id: filipinoSong.id, sungAt: atLocalDay(26) },
    { id: filipinoSong.id, sungAt: atLocalDay(26) },
    { id: filipinoSong.id, sungAt: atLocalDay(27) },
    { id: filipinoSong.id, sungAt: atLocalDay(28) },
    { id: filipinoSong.id, sungAt: atLocalDay(28) },
    { id: englishSong.id, sungAt: "not-a-date" },
    { id: englishSong.id, sungAt: atLocalDay(30) }
  ];
  const stats = getLocalStats(songs, state, { now: new Date(2026, 8, 28, 23) });
  assert.equal(stats.songsSung, 3);
  assert.equal(stats.favorites, 1);
  assert.equal(stats.opm, 3);
  assert.equal(stats.international, 0);
  assert.equal(stats.currentStreak, 3);
  assert.equal(stats.longestStreak, 3);
  assert.deepEqual(stats.topArtists[0], { artist: filipinoSong.artist, count: 3 });
});

test("favorite statistics follow the current favorite list", () => {
  const state = createDefaultUserState();
  state.favorites = [filipinoSong.id];
  assert.equal(getLocalStats(songs, state).favorites, 1);
  state.favorites = [];
  assert.equal(getLocalStats(songs, state).favorites, 0);
});

test("singing activity creates calendar streaks independently of Daily Challenge completion", () => {
  const state = createDefaultUserState();
  state.sungHistory = [
    { id: filipinoSong.id, sungAt: atLocalDay(20) },
    { id: englishSong.id, sungAt: atLocalDay(21) },
    { id: filipinoSong.id, sungAt: atLocalDay(21, 21) },
    { id: filipinoSong.id, sungAt: atLocalDay(23) }
  ];

  const day21 = getLocalStats(songs, state, { now: new Date(2026, 8, 21, 23) });
  assert.equal(day21.songsSung, 3);
  assert.equal(day21.currentStreak, 2);
  assert.equal(day21.longestStreak, 2);

  const afterMissedDay = getLocalStats(songs, state, { now: new Date(2026, 8, 23, 23) });
  assert.equal(afterMissedDay.currentStreak, 1);
  assert.equal(afterMissedDay.longestStreak, 2);
  assert.equal(afterMissedDay.opm, 3);
  assert.equal(afterMissedDay.international, 1);
});

test("duplicate completion callbacks do not double-count one persisted event", () => {
  const state = createDefaultUserState();
  state.sungHistory = [
    { id: filipinoSong.id, sungAt: atLocalDay(25) },
    { id: filipinoSong.id, sungAt: atLocalDay(25) },
    { id: filipinoSong.id, sungAt: atLocalDay(25, 1) }
  ];
  const qualifying = getQualifyingSungHistory(songs, state, { now: new Date(2026, 8, 25, 23) });
  const stats = getLocalStats(songs, state, { now: new Date(2026, 8, 25, 23) });
  assert.equal(qualifying.length, 2);
  assert.equal(stats.songsSung, 2);
  assert.equal(stats.currentStreak, 1);
});
