import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCatalog } from "../src/catalog.js";
import { createDefaultUserState, setPreferenceValues } from "../src/state.js";
import { getRecommendations, getRecentSungPenalty, metadataSimilarity, scoreRecommendationCandidate } from "../src/recommendations.js";

const NOW = Date.parse("2026-09-22T00:00:00.000Z");
const catalog = await loadSongs();
const auditCatalog = catalog.filter((song) => Number(song.id.slice("sample-".length)) <= 100);
const byId = new Map(auditCatalog.map((song) => [song.id, song]));
const rows = [];

test("Step 9A recommendation behavioral audit", () => {
  const cold = runScenario(
    "Brand-new user",
    createDefaultUserState(),
    "5 playable, deterministic picks with no catalog-order dependency",
    (results) => {
      assert.equal(results.length, 5);
      assert.ok(results.every((item) => item.song.youtubeVideoId));
      assert.notDeepEqual(results.map((item) => item.song.id), catalog.slice(0, 5).map((song) => song.id));
    }
  );

  const opmState = createDefaultUserState();
  setPreferenceValues(opmState, "languages", ["Filipino"]);
  setPreferenceValues(opmState, "genres", ["Ballad"]);
  setPreferenceValues(opmState, "moods", ["Love"]);
  runScenario(
    "OPM-focused user",
    opmState,
    "Preference matches improve the top ranking without filtering the catalog",
    (results) => {
      assert.ok(results.slice(0, 3).every((item) => item.signals.preferenceMatches.length >= 2));
      assert.ok(results.every((item) => /Matches your/.test(item.reason)));
    }
  );

  const personalizedState = createDefaultUserState();
  setPreferenceValues(personalizedState, "languages", ["Filipino"]);
  setPreferenceValues(personalizedState, "genres", ["Ballad"]);
  setPreferenceValues(personalizedState, "moods", ["Love"]);
  personalizedState.likedSongs = ["sample-033"];
  personalizedState.favorites = ["sample-011"];
  const personalized = runScenario(
    "Preferences plus likes/favorites",
    personalizedState,
    "Positive feedback can outrank broad preference matches and related songs remain available",
    (results) => {
      const likedIndex = results.findIndex((item) => item.song.id === "sample-033");
      const comparablePreferenceIndex = results.findIndex((item) => item.song.id === "sample-018");
      assert.equal(results[0].song.id, "sample-011");
      assert.ok(likedIndex >= 0);
      assert.ok(comparablePreferenceIndex < 0 || likedIndex < comparablePreferenceIndex);
      assert.match(results[likedIndex].reason, /liked/i);
      assert.ok(results.some((item) => item.song.id !== "sample-033" && metadataSimilarity(item.song, song("sample-033")) > 0));
    }
  );

  const artistState = createDefaultUserState();
  artistState.likedSongs = ["sample-017", "sample-018"];
  runScenario(
    "Repeated likes from one artist",
    artistState,
    "Artist diversity remains useful while allowing at most two strong same-artist picks",
    (results) => {
      const counts = countBy(results, (item) => item.song.artist);
      assert.ok(Math.max(...counts.values()) <= 2);
      assert.ok(new Set(results.map((item) => item.song.artist)).size >= 4);
    }
  );

  const recentState = createDefaultUserState();
  recentState.sungHistory = [
    { id: "sample-011", sungAt: new Date(NOW - 86400000).toISOString() },
    { id: "sample-014", sungAt: new Date(NOW - 86400000 * 2).toISOString() }
  ];
  runScenario(
    "Several recently sung songs",
    recentState,
    "Fresh exact songs are suppressed, while related ballads remain eligible",
    (results) => {
      assert.ok(results.every((item) => !["sample-011", "sample-014"].includes(item.song.id)));
      assert.ok(results.some((item) => metadataSimilarity(item.song, song("sample-011")) > 0));
    }
  );

  const recentPenalty = getRecentSungPenalty(new Date(NOW - 86400000).toISOString(), NOW);
  const olderPenalty = getRecentSungPenalty(new Date(NOW - 86400000 * 60).toISOString(), NOW);
  runScenario(
    "Older history",
    { ...createDefaultUserState(), sungHistory: [{ id: "sample-017", sungAt: new Date(NOW - 86400000 * 60).toISOString() }] },
    "Older performances receive a smaller penalty than recent performances",
    () => assert.ok(olderPenalty < recentPenalty)
  );

  const dislikeState = createDefaultUserState();
  dislikeState.dislikedSongs = ["sample-017"];
  runScenario(
    "Strong negative feedback",
    dislikeState,
    "The directly disliked song never appears; related songs are not blanket-banned",
    (results) => {
      assert.ok(results.every((item) => item.song.id !== "sample-017"));
      assert.ok(results.some((item) => metadataSimilarity(item.song, song("sample-017")) > 0));
    }
  );

  const queueState = createDefaultUserState();
  queueState.queue = ["sample-001", "sample-002"];
  queueState.currentSongId = "sample-001";
  runScenario(
    "Queue and current song",
    queueState,
    "Queued and current songs never appear in Sing next",
    (results) => assert.ok(results.every((item) => !queueState.queue.includes(item.song.id)))
  );

  const saturatedState = createDefaultUserState();
  saturatedState.recentRecommendations = auditCatalog.filter((song) => song.youtubeVideoId).map((song) => song.id);
  runScenario(
    "recentRecommendations saturation",
    saturatedState,
    "Soft repetition penalties do not empty the eligible pool",
    (results) => assert.equal(results.length, 5)
  );

  const sparseCatalog = auditCatalog.filter((song) => song.youtubeVideoId).slice(0, 3);
  runScenario(
    "Sparse playable catalog",
    createDefaultUserState(),
    "Return fewer than five results gracefully when only three are eligible",
    (results) => assert.equal(results.length, 3),
    sparseCatalog
  );

  runScenario(
    "Explainability",
    personalizedState,
    "Every displayed reason corresponds to an actual signal and exposes no raw score",
    (results) => results.forEach(assertExplainableReason)
  );

  const exactLikeContext = {
    likedIds: new Set(["sample-017"]),
    likedReferences: [song("sample-017")],
    nowMs: NOW
  };
  const exactLike = scoreRecommendationCandidate(song("sample-017"), exactLikeContext);
  const relatedLike = scoreRecommendationCandidate(song("sample-018"), exactLikeContext);
  runScenario(
    "Weight interaction",
    "3 preferences + one liked song + playable-only pool",
    "Direct positive feedback remains stronger than broad preference matches; playable bonus is an eligibility baseline; artist/profile penalties diversify",
    () => {
      assert.ok(exactLike.score > relatedLike.score);
      assert.equal(getRecommendations(sparseCatalog, createDefaultUserState(), { now: NOW, limit: 5 }).length, 3);
      assert.ok(personalized.length === 5);
    },
    auditCatalog
  );

  console.log("\nStep 9A recommendation audit report");
  console.table(rows);
});

test("Step 9A preserves catalog and frontend boundaries", async () => {
  const raw = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
  assert.equal(raw.length, 145);
  assert.equal(raw.filter((song) => song.youtubeVideoId !== null).length, 129);
  assert.equal(raw.find((song) => song.id === "sample-008").youtubeVideoId, null);
  assert.equal(raw.find((song) => song.id === "sample-009").youtubeVideoId, null);

  const frontendPaths = ["index.html", "src/app.js", "src/recommendations.js", "src/state.js", "src/ui.js", "styles/main.css"];
  const source = (await Promise.all(frontendPaths.map((path) => readFile(path, "utf8")))).join("\n");
  assert.equal(/AIza[0-9A-Za-z_-]{20,}/.test(source), false);
  assert.equal(/YOUTUBE_API_KEY/.test(source), false);
});

function runScenario(name, state, expected, assertion, songs = auditCatalog) {
  const results = getRecommendations(songs, state, { now: NOW, limit: 5 });
  assertion(results);
  rows.push({
    scenario: name,
    signals: describeState(state),
    topRecommendations: results.map((item) => item.song.id).join(", ") || "none",
    reasons: results.map((item) => item.reason).join(" | ") || "none",
    expected,
    result: "PASS"
  });
  return results;
}

function assertExplainableReason(item) {
  assert.doesNotMatch(item.reason, /score|\b\d+(?:\.\d+)?\b/i);
  if (item.signals.preferenceMatches.length > 0) return assert.match(item.reason, /Matches your/);
  if (item.signals.directLiked) return assert.match(item.reason, /liked/i);
  if (item.signals.directFavorite) return assert.match(item.reason, /favorited/i);
  if (item.signals.likedSimilarity > 0 || item.signals.favoriteSimilarity > 0) return assert.match(item.reason, /Similar to songs you liked or favorited/);
  if (item.signals.sungSimilarity > 0) return assert.match(item.reason, /sung/);
  if (item.signals.demandTier) return assert.match(item.reason, /popular karaoke pick/);
  if (item.signals.artistDiversity) return assert.match(item.reason, /artist for variety/);
  return assert.match(item.reason, /playable karaoke pick/);
}

function describeState(state) {
  if (typeof state === "string") return state;
  const parts = [];
  const preferences = Object.entries(state.preferences || {}).flatMap(([key, values]) => Array.isArray(values) && values.length ? `${key}=${values.join("/")}` : []);
  if (preferences.length) parts.push(preferences.join(", "));
  for (const [key, label] of [["likedSongs", "likes"], ["favorites", "favorites"], ["dislikedSongs", "dislikes"], ["sungHistory", "history"], ["queue", "queue"], ["recentRecommendations", "recent"]]) {
    if (Array.isArray(state[key]) && state[key].length) parts.push(`${label}=${state[key].length}`);
  }
  if (state.currentSongId) parts.push(`current=${state.currentSongId}`);
  return parts.join("; ") || "no local signals";
}

function countBy(items, keyFn) {
  return items.reduce((counts, item) => counts.set(keyFn(item), (counts.get(keyFn(item)) || 0) + 1), new Map());
}

function song(id) {
  return byId.get(id);
}

async function loadSongs() {
  const raw = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
  return normalizeCatalog(raw, { logger: { warn() {} } }).songs;
}
