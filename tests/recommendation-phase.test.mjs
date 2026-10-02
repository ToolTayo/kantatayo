import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeCatalog } from "../src/catalog.js";
import { createDefaultUserState } from "../src/state.js";
import { buildReason, getRecommendations, scoreRecommendationCandidate } from "../src/recommendations.js";

const NOW = Date.parse("2026-09-22T00:00:00.000Z");
const rawCatalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
const catalog = normalizeCatalog(rawCatalog, { logger: { warn() {} } }).songs;
const byId = new Map(catalog.map((song) => [song.id, song]));

const allPreferences = {
  languages: ["Filipino"],
  genres: ["Ballad"],
  moods: ["Love"],
  difficulties: ["hard"],
  vocalRanges: ["high"],
  performanceTypes: ["solo"],
  eras: ["2000s"]
};

test("explicit like/favorite signals are not overwhelmed by broad preference matches", () => {
  const likedState = createDefaultUserState();
  likedState.preferences = allPreferences;
  likedState.likedSongs = ["sample-003"];
  const liked = getRecommendations(catalog, likedState, { now: NOW, limit: 5 });

  const favoriteState = createDefaultUserState();
  favoriteState.preferences = allPreferences;
  favoriteState.favorites = ["sample-003"];
  const favorite = getRecommendations(catalog, favoriteState, { now: NOW, limit: 5 });

  assert.equal(liked[0].song.id, "sample-003");
  assert.equal(favorite[0].song.id, "sample-003");
  assert.match(liked[0].reason, /liked/i);
  assert.match(favorite[0].reason, /favorited/i);
  const broadPreferenceCandidate = scoreRecommendationCandidate(byId.get("sample-102"), {
    preferences: allPreferences,
    nowMs: NOW
  });
  assert.equal(broadPreferenceCandidate.signals.preferenceSignal, 32, "preference matches are capped transparently");
});

test("artist affinity discovers related songs without becoming an artist lock-in", () => {
  const favorite = byId.get("sample-017");
  const related = byId.get("sample-018");
  const candidate = scoreRecommendationCandidate(related, {
    favoriteIds: new Set([favorite.id]),
    favoriteReferences: [favorite],
    nowMs: NOW
  });

  assert.equal(candidate.signals.artistAffinity.favorite, true);
  assert.match(candidate.reason, /artist you liked or favorited/i);

  const results = getRecommendations(catalog, {
    ...createDefaultUserState(),
    favorites: ["sample-017", "sample-018"]
  }, { now: NOW, limit: 5 });
  const artistCounts = new Map();
  results.forEach(({ song }) => artistCounts.set(song.artist, (artistCounts.get(song.artist) || 0) + 1));
  assert.ok(Math.max(...artistCounts.values()) <= 2);
  assert.ok(new Set(results.map(({ song }) => song.artist)).size >= 4);
});

test("recently opened songs receive only a light novelty penalty, never a fake like", () => {
  const baseline = getRecommendations(catalog, createDefaultUserState(), { now: NOW, limit: 5 });
  const topId = baseline[0].song.id;
  const state = createDefaultUserState();
  state.recentlyPlayed = [{ id: topId, playedAt: new Date(NOW - 60 * 60 * 1000).toISOString() }];
  const refreshed = getRecommendations(catalog, state, { now: NOW, limit: 5 });
  const opened = scoreRecommendationCandidate(byId.get(topId), {
    recentlyPlayed: state.recentlyPlayed,
    nowMs: NOW
  });

  assert.notEqual(refreshed[0].song.id, topId);
  assert.ok(opened.signals.recentPlayedPenalty > 0);
  assert.equal(opened.signals.directLiked, false);
  assert.equal(opened.signals.directFavorite, false);
  assert.equal(opened.signals.sungSimilarity, 0);
});

test("latest sung timestamp wins even when legacy history is out of order", () => {
  const song = byId.get("sample-020");
  const older = { id: song.id, sungAt: "2026-01-01T00:00:00.000Z" };
  const recent = { id: song.id, sungAt: "2026-09-21T00:00:00.000Z" };
  const outOfOrder = scoreRecommendationCandidate(song, { history: [older, recent], nowMs: NOW });
  const oldOnly = scoreRecommendationCandidate(song, { history: [older], nowMs: NOW });

  assert.ok(outOfOrder.signals.recentSungPenalty > oldOnly.signals.recentSungPenalty);
  assert.ok(outOfOrder.score < oldOnly.score);
});

test("party completions suppress immediate repetition without becoming personal artist affinity", () => {
  const personal = createDefaultUserState();
  personal.sungHistory = [{ id: "sample-017", sungAt: "2026-09-21T00:00:00.000Z" }];
  const party = createDefaultUserState();
  party.sungHistory = [{ id: "sample-017", sungAt: "2026-09-21T00:00:00.000Z", source: "party" }];

  const pairCatalog = [byId.get("sample-017"), byId.get("sample-018")];
  const personalRelated = getRecommendations(pairCatalog, personal, { now: NOW, limit: pairCatalog.length })
    .find((item) => item.song.id === "sample-018");
  const partyRelated = getRecommendations(pairCatalog, party, { now: NOW, limit: pairCatalog.length })
    .find((item) => item.song.id === "sample-018");

  assert.ok(personalRelated);
  assert.ok(partyRelated);
  assert.equal(personalRelated.signals.artistAffinity.sung, true);
  assert.equal(partyRelated.signals.artistAffinity.sung, false);
  assert.ok(partyRelated.signals.recentSungPenalty >= 0);
});

test("stale optional state stays local and cannot make unavailable or unknown songs eligible", () => {
  const state = {
    preferences: null,
    favorites: ["missing-song", "sample-003"],
    likedSongs: "not-an-array",
    dislikedSongs: ["missing-song", "sample-004"],
    sungHistory: [{ id: "missing-song", sungAt: "2026-09-21T00:00:00.000Z" }, { id: "sample-004", sungAt: "bad" }],
    recentlyPlayed: [{ id: "missing-song", playedAt: "2026-09-21T00:00:00.000Z" }],
    queue: ["missing-song"],
    currentSongId: "missing-song",
    recentRecommendations: ["missing-song"]
  };
  const results = getRecommendations(catalog, state, { now: NOW, limit: 5 });

  assert.equal(results.length, 5);
  assert.ok(results.every(({ song }) => song.youtubeVideoId && !["missing-song", "sample-004"].includes(song.id)));
});

test("recommendation computation preserves catalog records", () => {
  const before = JSON.stringify(catalog);
  const state = createDefaultUserState();
  state.sungHistory = catalog.slice(0, 50).map((song, index) => ({
    id: song.id,
    sungAt: new Date(NOW - index * 86400000).toISOString()
  }));
  const results = getRecommendations(catalog, state, { now: NOW, limit: 12 });

  assert.equal(results.length, 12);
  assert.equal(JSON.stringify(catalog), before);
});

test("recommendations remain safe with adversarially oversized local activity", () => {
  const state = createDefaultUserState();
  state.sungHistory = Array.from({ length: 1000 }, (_, index) => ({
    id: catalog[index % catalog.length].id,
    sungAt: new Date(NOW - index * 86400000).toISOString()
  }));
  state.recentlyPlayed = Array.from({ length: 1000 }, (_, index) => ({
    id: catalog[index % catalog.length].id,
    playedAt: new Date(NOW - index * 3600000).toISOString()
  }));

  const results = getRecommendations(catalog, state, { now: NOW, limit: 12 });
  assert.equal(results.length, 12);
  assert.ok(results.every((item) => item.song.youtubeVideoId));
});

test("popularity reasons require a supported demand tier", () => {
  const supported = catalog.find((song) => song.demandTier);
  assert.ok(supported, "the catalog should contain at least one evidence-backed demand tier");
  const scored = scoreRecommendationCandidate(supported, { nowMs: NOW });
  assert.equal(scored.signals.demandTier, supported.demandTier);
  assert.equal(scored.reason, "A popular karaoke pick");

  const unsupported = scoreRecommendationCandidate({ ...supported, demandTier: "viral" }, { nowMs: NOW });
  assert.equal(unsupported.signals.demandTier, "");
  assert.notEqual(unsupported.reason, "A popular karaoke pick");
  assert.notEqual(buildReason({ demandTier: "viral" }), "A popular karaoke pick");
});

test("cold-start Home copy does not claim every recommendation is popular", async () => {
  const ui = await readFile("src/ui.js", "utf8");
  const html = await readFile("index.html", "utf8");
  assert.match(ui, /Playable picks to get your night moving\./);
  assert.doesNotMatch(ui, /Popular, playable picks to get your night moving\./);
  assert.match(ui, /title: "OPM picks"/);
  assert.match(ui, /title: "International picks"/);
  assert.match(html, />Playable picks to get your night moving\.<\/p>/);
  assert.doesNotMatch(html, />Popular, playable picks to get your night moving\.<\/p>/);
  assert.match(html, /Start with a song from the catalog/);
  assert.doesNotMatch(html, /Start with a crowd favorite/);
});
