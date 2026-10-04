import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeCatalog } from "../src/catalog.js";
import { createDefaultUserState } from "../src/state.js";
import { getHomeShelves } from "../src/discovery.js";
import { getRecommendations } from "../src/recommendations.js";
import { FIND_SONG_MODES, formatFindSongReason, getFindSongModeOptions, getFindSongRecommendations, matchesFindSongMode, toggleFindSongModeSelection } from "../src/find-song.js";

const catalog = normalizeCatalog(
  JSON.parse(await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8")),
  { logger: { warn() {} } }
).songs;

const NOW = Date.parse("2026-10-04T00:00:00.000Z");

test("Find My Song choices are derived from playable catalog metadata", () => {
  const options = getFindSongModeOptions(catalog);
  assert.deepEqual(Object.fromEntries(options.map(({ id, count }) => [id, count])), {
    easy: 69,
    love: 377,
    power: 4,
    opm: 604,
    throwback: 850,
    duet: 25,
    popular: 74
  });
  assert.ok(options.every((option) => !option.matches || typeof option.matches === "function"));
});

test("mode labels are backed only by their stated catalog signals", () => {
  const base = { id: "mode-song", title: "Mode Song", artist: "Mode Artist", youtubeVideoId: "abcdefghijk", tags: [], mood: [] };
  assert.equal(matchesFindSongMode({ ...base, difficulty: "easy" }, "easy"), true);
  assert.equal(matchesFindSongMode({ ...base, mood: ["love"] }, "love"), true);
  assert.equal(matchesFindSongMode({ ...base, mood: ["empowering"] }, "power"), false);
  assert.equal(matchesFindSongMode({ ...base, tags: ["power-vocal"] }, "power"), true);
  assert.equal(matchesFindSongMode({ ...base, language: "English", tags: ["OPM"] }, "opm"), true);
  assert.equal(matchesFindSongMode({ ...base, era: "2000s" }, "throwback"), true);
  assert.equal(matchesFindSongMode({ ...base, era: "2010s" }, "throwback"), false);
  assert.equal(matchesFindSongMode({ ...base, performanceType: "duet" }, "duet"), true);
  assert.equal(matchesFindSongMode({ ...base, tags: ["popular", "crowd"] }, "popular"), false);
  assert.equal(matchesFindSongMode({ ...base, demandTier: "established" }, "popular"), true);
  assert.equal(matchesFindSongMode({ ...base, demandTier: "unverified-popular" }, "popular"), false);
});

test("Find My Song is deterministic, local, playable-only, and returns a small set", () => {
  const state = createDefaultUserState();
  const first = getFindSongRecommendations(catalog, state, { modes: ["opm", "easy"], now: NOW, limit: 3 });
  const second = getFindSongRecommendations([...catalog].reverse(), state, { modes: ["opm", "easy"], now: NOW, limit: 3 });

  assert.equal(first.length, 3);
  assert.deepEqual(first.map((item) => item.song.id), second.map((item) => item.song.id));
  assert.ok(first.every((item) => item.song.youtubeVideoId));
  assert.ok(first.every((item) => matchesFindSongMode(item.song, "opm") || matchesFindSongMode(item.song, "easy")));
  assert.ok(first.every((item) => item.reason.includes("OPM") || item.reason.includes("Easy")));
  assert.ok(new Set(first.map((item) => item.song.id)).size === first.length);
  assert.ok(new Set(first.map((item) => item.song.artist)).size >= 2);
});

test("Find My Song preserves queue, current, and Not for Me exclusions", () => {
  const state = createDefaultUserState();
  const candidates = catalog.filter((song) => matchesFindSongMode(song, "duet")).slice(0, 3);
  state.queue = [candidates[0].id];
  state.currentSongId = candidates[1].id;
  state.dislikedSongs = [candidates[2].id];
  const results = getFindSongRecommendations(catalog, state, { modes: ["duet"], now: NOW, limit: 3 });
  assert.ok(results.every(({ song }) => !state.queue.includes(song.id)));
  assert.ok(results.every(({ song }) => song.id !== state.currentSongId));
  assert.ok(results.every(({ song }) => !state.dislikedSongs.includes(song.id)));
});

test("Find My Song handles sparse and empty catalogs without inventing a result", () => {
  const state = createDefaultUserState();
  const unavailable = { id: "missing", title: "Missing", artist: "Unknown", youtubeVideoId: null };
  assert.deepEqual(getFindSongRecommendations([], state), []);
  assert.deepEqual(getFindSongModeOptions([unavailable]), []);
  assert.deepEqual(getFindSongRecommendations([unavailable], state, { modes: ["easy"] }), []);
});

test("Find My Song reasons describe only selected, real signals", () => {
  assert.equal(formatFindSongReason(["opm", "easy"]), "Matches your OPM + Easy");
  assert.equal(formatFindSongReason(["unknown"]), "A strong playable pick");
  assert.deepEqual(FIND_SONG_MODES.filter((mode) => mode.id === "opm").map((mode) => mode.label), ["OPM"]);
});

test("Find My Song reports only cues each result actually matches", () => {
  const modes = ["opm", "easy"];
  const picks = getFindSongRecommendations(catalog, createDefaultUserState(), { modes, now: NOW, limit: 3 });
  assert.equal(picks.length, 3);
  for (const pick of picks) {
    const actualMatches = modes.filter((mode) => matchesFindSongMode(pick.song, mode));
    assert.ok(actualMatches.length > 0);
    assert.deepEqual(pick.matchedModes, actualMatches);
    assert.equal(pick.reason, formatFindSongReason(actualMatches));
  }
});

test("a sparse cue combination or fully excluded pool returns no invented song", () => {
  const state = createDefaultUserState();
  const easyOrPower = catalog.filter((song) => matchesFindSongMode(song, "easy") || matchesFindSongMode(song, "power"));
  state.queue = easyOrPower.map((song) => song.id);
  assert.deepEqual(getFindSongRecommendations(catalog, state, { modes: ["easy", "power"], now: NOW }), []);

  state.queue = [];
  const matching = catalog.filter((song) => matchesFindSongMode(song, "duet"));
  state.queue = matching.map((song) => song.id);
  assert.deepEqual(getFindSongRecommendations(catalog, state, { modes: ["duet"], now: NOW }), []);
});

test("rapid cue selection keeps two choices and announces the replaced cue", () => {
  const easy = toggleFindSongModeSelection([], "easy");
  const opm = toggleFindSongModeSelection(easy.modes, "opm");
  const duet = toggleFindSongModeSelection(opm.modes, "duet");
  assert.deepEqual(duet.modes, ["opm", "duet"]);
  assert.equal(duet.replacedModeId, "easy");
  assert.deepEqual(toggleFindSongModeSelection(duet.modes, "opm"), { modes: ["duet"], replacedModeId: "" });
  assert.deepEqual(toggleFindSongModeSelection(duet.modes, "unknown"), { modes: ["opm", "duet"], replacedModeId: "" });
});

test("Find My Song picks do not repeat on another Home shelf", () => {
  const state = createDefaultUserState();
  const recommendations = getRecommendations(catalog, state, { limit: 12, now: NOW });
  const picks = getFindSongRecommendations(catalog, state, { baseline: recommendations, now: NOW, limit: 3 });
  const pickIds = new Set(picks.map(({ song }) => song.id.toLowerCase()));
  const shelves = getHomeShelves(catalog, recommendations, state, { excludeIds: [...pickIds] });
  const otherHomeIds = Object.values(shelves).flat().map((song) => song.id.toLowerCase());
  assert.ok([...pickIds].every((id) => !otherHomeIds.includes(id)));
  assert.equal(new Set(otherHomeIds).size, otherHomeIds.length);
});

test("Home exposes the consolidated Find My Song surface without duplicate cards or a second player", async () => {
  const [html, app, ui, demand] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/ui.js", import.meta.url), "utf8"),
    readFile(new URL("../data/song-demand.json", import.meta.url), "utf8")
  ]);
  assert.match(html, /data-find-song/);
  assert.match(html, /What feels right\?/);
  assert.match(html, /data-find-song-guidance|id="find-song-guidance"/);
  assert.match(html, /data-find-song-scroll-hint/);
  assert.match(html, /role="region" aria-label="Find My Song picks"/);
  assert.match(html, /data-find-song-status[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /Picks can match either cue; songs matching both get an extra boost\./);
  assert.match(app, /toggle-find-song-mode/);
  assert.match(app, /toggleFindSongModeSelection/);
  assert.match(ui, /This session/);
  assert.doesNotMatch(ui, /Tonight ·/);
  assert.match(ui, /findSongResultIds/);
  assert.match(ui, /scrollHintTarget\.hidden = results\.length < 2/);
  assert.match(ui, /excludeIds: reservedIds/);
  assert.match(html, /Popular karaoke picks/);
  assert.match(demand, /karaoke-app play rankings or public karaoke-provider video-view rankings/);
  assert.match(ui, /getFindSongRecommendations/);
  assert.equal((html.match(/data-youtube-mount/g) || []).length, 1);
  assert.doesNotMatch(ui, /fetch\(/);
});
