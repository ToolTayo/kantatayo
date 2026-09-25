import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCatalog } from "./catalog.js";
import { createDefaultUserState, setPreferenceValues } from "./state.js";
import { getRecommendations, getRecentSungPenalty, metadataSimilarity, scoreRecommendationCandidate } from "./recommendations.js";

const NOW = Date.parse("2026-09-22T00:00:00.000Z");
const catalog = await loadSongs();

test("cold-start recommendations are deterministic, playable, and not catalog order", () => {
  const state = createDefaultUserState();
  const first = getRecommendations(catalog, state, { now: NOW, limit: 5 });
  const second = getRecommendations(catalog, state, { now: NOW, limit: 5 });

  assert.deepEqual(first.map((item) => item.song.id), second.map((item) => item.song.id));
  assert.equal(first.length, 5);
  assert.ok(first.every((item) => item.song.youtubeVideoId));
  assert.notDeepEqual(first.map((item) => item.song.id), catalog.slice(0, 5).map((song) => song.id));
});

test("demand signal improves cold-start ordering while direct feedback remains stronger", () => {
  const coldDemand = scoreRecommendationCandidate(song("sample-016"), { nowMs: NOW });
  const coldNeutral = scoreRecommendationCandidate(song("sample-003"), { nowMs: NOW });
  assert.equal(coldDemand.signals.demandTier, "very-high");
  assert.ok(coldDemand.score > coldNeutral.score);
  assert.match(coldDemand.reason, /popular karaoke pick/);

  const likedNeutral = scoreRecommendationCandidate(song("sample-003"), {
    likedIds: new Set(["sample-003"]),
    nowMs: NOW
  });
  assert.ok(likedNeutral.score > coldDemand.score);
  assert.match(likedNeutral.reason, /liked/i);
});

test("preference matches improve a relevant song score", () => {
  const state = createDefaultUserState();
  setPreferenceValues(state, "languages", ["Filipino"]);
  setPreferenceValues(state, "difficulties", ["easy"]);
  const context = { preferences: state.preferences, nowMs: NOW };
  const filipino = scoreRecommendationCandidate(song("sample-019"), context);
  const international = scoreRecommendationCandidate(song("sample-005"), context);

  assert.ok(filipino.score > international.score);
  assert.match(filipino.reason, /Filipino/);
  assert.ok(filipino.signals.preferenceMatches.some((match) => match.key === "languages"));
});

test("likes and favorites influence metadata-similar songs", () => {
  const state = createDefaultUserState();
  state.likedSongs = ["sample-011"];
  state.favorites = ["sample-014"];
  const context = {
    likedIds: new Set(state.likedSongs),
    favoriteIds: new Set(state.favorites),
    likedReferences: [song("sample-011")],
    favoriteReferences: [song("sample-014")],
    nowMs: NOW
  };
  const similar = scoreRecommendationCandidate(song("sample-017"), context);
  const unrelated = scoreRecommendationCandidate(song("fixture-unrelated"), context);

  assert.ok(metadataSimilarity(song("sample-017"), song("sample-011")) > 0);
  assert.ok(similar.score > unrelated.score);
  assert.match(similar.reason, /similar to songs you liked or favorited/i);
});

test("Not for Me is a hard exclusion and feedback updates recommendations", () => {
  const state = createDefaultUserState();
  const initial = getRecommendations(catalog, state, { now: NOW, limit: 5 });
  const dislikedId = initial[0].song.id;
  state.dislikedSongs = [dislikedId];
  const updated = getRecommendations(catalog, state, { now: NOW, limit: 5 });

  assert.ok(updated.every((item) => item.song.id !== dislikedId));
});

test("recent history is penalized strongly and decays over time", () => {
  const recent = getRecentSungPenalty(new Date(NOW - 86400000).toISOString(), NOW);
  const older = getRecentSungPenalty(new Date(NOW - 86400000 * 60).toISOString(), NOW);
  assert.ok(recent > older);

  const recentScore = scoreRecommendationCandidate(song("sample-020"), {
    history: [{ id: "sample-020", sungAt: new Date(NOW - 86400000).toISOString() }],
    nowMs: NOW
  });
  const oldScore = scoreRecommendationCandidate(song("sample-020"), {
    history: [{ id: "sample-020", sungAt: new Date(NOW - 86400000 * 60).toISOString() }],
    nowMs: NOW
  });
  assert.ok(oldScore.score > recentScore.score);
});

test("queue songs and the current song are excluded", () => {
  const state = createDefaultUserState();
  state.queue = ["sample-001", "sample-002"];
  state.currentSongId = "sample-001";
  const results = getRecommendations(catalog, state, { now: NOW, limit: 5 });
  assert.ok(results.every((item) => !state.queue.includes(item.song.id)));
});

test("recent recommendations reduce repetition without emptying the pool", () => {
  const state = createDefaultUserState();
  const initial = getRecommendations(catalog, state, { now: NOW, limit: 5 });
  state.recentRecommendations = initial.map((item) => item.song.id);
  const refreshed = getRecommendations(catalog, state, { now: NOW, limit: 5 });

  assert.equal(refreshed.length, 5);
  assert.ok(refreshed.some((item) => !state.recentRecommendations.includes(item.song.id)));
});

test("selection applies artist diversity deterministically", () => {
  const results = getRecommendations(catalog, createDefaultUserState(), { now: NOW, limit: 5 });
  assert.ok(new Set(results.map((item) => item.song.artist)).size >= 4);
});

test("malformed partial state is safe and unplayable songs are excluded", () => {
  const malformed = getRecommendations(catalog, {
    preferences: null,
    likedSongs: "not-an-array",
    dislikedSongs: [null, "sample-001"],
    queue: 42,
    currentSongId: { bad: true },
    sungHistory: [{ id: "sample-002", sungAt: "not-a-date" }],
    recentRecommendations: "not-an-array"
  }, { now: NOW, limit: 5 });
  assert.equal(malformed.some((item) => item.song.id === "sample-001"), false);
  assert.equal(malformed.length, 5);

  const unplayable = getRecommendations(catalog.filter((song) => song.youtubeVideoId === null), createDefaultUserState(), { now: NOW });
  assert.deepEqual(unplayable, []);
});

test("recommendation reasons expose real signals without raw scoring", () => {
  const state = createDefaultUserState();
  setPreferenceValues(state, "genres", ["Ballad"]);
  const result = getRecommendations(catalog, state, { now: NOW, limit: 5 });
  const preferenceResult = result.find((item) => item.signals.preferenceMatches.some((match) => match.key === "genres"));
  assert.ok(preferenceResult);
  assert.match(preferenceResult.reason, /Ballad/);
  assert.doesNotMatch(preferenceResult.reason, /score|\d+/i);
});

test("catalog playability and protected IDs remain unchanged", () => {
  const promoted = catalog.filter((song) => song.youtubeVideoId !== null);
  assert.equal(catalog.length, 171);
  assert.equal(promoted.length, 171);
  assert.equal(catalog.filter((item) => item.youtubeVideoId === null).length, 0);
  assert.equal(song("sample-029").youtubeVideoId, "QBb9wO3Bj0k");
});

test("recommendation implementation introduces no frontend API keys or secrets", async () => {
  const paths = ["index.html", "src/app.js", "src/state.js", "src/storage.js", "src/preferences.js", "src/recommendations.js", "src/ui.js", "styles/main.css"];
  const contents = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const source = contents.join("\n");
  assert.equal(/AIza[0-9A-Za-z_-]{20,}/.test(source), false);
  assert.equal(/YOUTUBE_API_KEY/.test(source), false);
});

function song(id) {
  return catalog.find((item) => item.id === id);
}

async function loadSongs() {
  const raw = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
  return normalizeCatalog(raw, { logger: { warn() {} } }).songs;
}
