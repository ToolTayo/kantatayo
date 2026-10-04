import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getMedleyPlayerSuggestions, getSongPlayerSuggestions } from "../src/player-suggestions.js";

const [html, app, ui, css] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/ui.js", import.meta.url), "utf8"),
  readFile(new URL("../styles/main.css", import.meta.url), "utf8")
]);

const song = (id, videoId, title = id) => ({
  id,
  title,
  artist: "Test artist",
  language: "English",
  genre: "Pop",
  era: "2000s",
  mood: ["uplifting"],
  difficulty: "easy",
  vocalRange: "medium",
  performanceType: "solo",
  youtubeVideoId: videoId,
  tags: ["karaoke"]
});

test("song suggestions reuse recommendation order and exclude current, queued, unavailable, and duplicate videos", () => {
  const recommendations = [
    { song: song("current", "CurrntVid01A"), reason: "Current" },
    { song: song("queued", "QueuedVid01"), reason: "Queued" },
    { song: song("unavailable", null), reason: "Unavailable" },
    { song: song("first", "FirstVid01A", "First") , reason: "Matches your genre preferences" },
    { song: song("duplicate-video", "FirstVid01A", "Duplicate video"), reason: "Duplicate" },
    { song: song("second", "SecondVid01", "Second"), reason: "A popular karaoke pick" },
    { song: song("third", "ThirdVid01A", "Third"), reason: "A playable karaoke pick" }
  ];
  const result = getSongPlayerSuggestions(recommendations, {
    currentId: "current",
    queuedIds: ["queued"],
    limit: 3
  });
  assert.deepEqual(result.map((item) => item.song.id), ["first", "second", "third"]);
  assert.equal(result[0].reason, "Matches your genre preferences");
});

test("song suggestions safely support zero, one, and two eligible choices without mutating inputs", () => {
  const recommendations = [{ song: song("one", "OneVid0001A") }, { song: song("two", "TwoVid0001A") }];
  const snapshot = JSON.stringify(recommendations);
  assert.deepEqual(getSongPlayerSuggestions([], { currentId: "missing" }), []);
  assert.equal(getSongPlayerSuggestions(recommendations, { limit: 1 }).length, 1);
  assert.equal(getSongPlayerSuggestions(recommendations, { limit: 2 }).length, 2);
  assert.equal(JSON.stringify(recommendations), snapshot);
  assert.deepEqual(getSongPlayerSuggestions(null), []);
});

test("song suggestions rebind to canonical playable catalog records and exclude medley video collisions", () => {
  const canonical = song("canonical", "CanonVid01A");
  const recommendations = [
    { song: { ...canonical, title: "Untrusted title", youtubeVideoId: "OtherVid01A" } },
    { song: song("medley-collision", "MedlyVid01A") },
    { song: song("canonical", "CanonVid01A", "Duplicate reference") },
    { song: song("safe", "SafeVid01AB") }
  ];
  const result = getSongPlayerSuggestions(recommendations, {
    catalogSongs: [canonical, song("safe", "SafeVid01AB")],
    excludeVideoIds: ["MedlyVid01A", "OtherVid01A"]
  });
  assert.deepEqual(result.map((item) => item.song.id), ["canonical", "safe"]);
  assert.equal(result[0].song.title, "canonical");
});

test("medley suggestions stay separate, deterministic, playable, and exclude queued/current medleys", async () => {
  const data = JSON.parse(await readFile(new URL("../data/medleys.sample.json", import.meta.url), "utf8"));
  const current = data.medleys[0];
  const result = getMedleyPlayerSuggestions(current, data.medleys, { excludeIds: [data.medleys[1].id] });
  assert.equal(result.length, 4);
  assert.ok(result.every((item) => item.type === "medley" && item.medley.id !== current.id));
  assert.equal(result.some((item) => item.medley.id === data.medleys[1].id), false);
  assert.ok(result.every((item) => item.medley.verification.status));
  assert.deepEqual(result.map((item) => item.medley.id), getMedleyPlayerSuggestions(current, data.medleys, { excludeIds: [data.medleys[1].id] }).map((item) => item.medley.id));
});

test("malformed medleys, unavailable medleys, duplicate IDs, and duplicate video IDs are ignored", () => {
  const current = { id: "medley-current", provider: "Provider", language: "English", theme: "Party" };
  const playable = (id, videoId) => ({
    id,
    title: id,
    provider: "Provider",
    language: "English",
    theme: "Party",
    sectionStatus: "known",
    verification: { status: "verified-for-release" },
    videoId
  });
  const result = getMedleyPlayerSuggestions(current, [
    playable("medley-one", "OneVid0001A"),
    playable("medley-one", "TwoVid0001A"),
    playable("medley-two", "OneVid0001A"),
    { id: "bad", videoId: null }
  ]);
  assert.deepEqual(result.map((item) => item.medley.id), ["medley-one"]);
});

test("visual end-screen suggestions render inside the former player surface and use existing playback routes", () => {
  assert.match(html, /data-player-end-screen hidden/);
  assert.match(html, /data-player-end-screen-grid/);
  assert.match(html, /data-player-pre-end-status hidden/);
  assert.doesNotMatch(html, /data-player-suggestions/);
  assert.doesNotMatch(html, /data-player-up-next|Recommended next/);
  assert.doesNotMatch(ui, /Recommended next|Not added until you choose Sing next/);
  assert.match(ui, /player-suggestion-song/);
  assert.match(ui, /player-suggestion-medley/);
  assert.match(app, /action === "player-suggestion-song"[\s\S]*?startSong\(suggestedSong, actionTarget\)/);
  assert.match(app, /action === "player-suggestion-medley"[\s\S]*?startMedley\(suggestedMedley, actionTarget\)/);
  assert.match(app, /const songSuggestions = getSongPlayerSuggestions\(recommendationSnapshot/);
  assert.match(app, /const suggestions = \[\.\.\.medleySuggestions, \.\.\.songSuggestions\]\.slice\(0, 4\)/);
  assert.doesNotMatch(ui, /player-end-card[\s\S]*?<iframe/);
  assert.match(ui, /player-end-card-action/);
  assert.match(ui, /activePlayerSuggestions/);
  assert.doesNotMatch(ui, /youtube\.com|youtu\.be|window\.open/);
});

test("visual suggestions remain keyboard/touch friendly and bounded on mobile", () => {
  assert.match(css, /\.player-end-card\s*\{[\s\S]*?min-height:\s*6rem/);
  assert.match(css, /\.player-end-card:focus-visible/);
  assert.match(css, /\.player-end-card-action[^}]*min-height:\s*2\.75rem/);
  assert.match(css, /@media \(max-width: 619px\)[\s\S]*?\.player-end-screen-grid\s*\{\s*grid-template-columns:\s*repeat\(2/);
  assert.match(css, /@media \(max-width: 359px\)/);
});

test("player suggestion integration keeps recommendations and iframe ownership centralized", () => {
  assert.match(app, /getSongPlayerSuggestions\(recommendationSnapshot/);
  assert.match(app, /getMedleyPlayerSuggestions\(snapshot\.currentMedley, medleys/);
  assert.match(ui, /renderPlayerSuggestions\(metadata\.suggestions/);
  assert.equal((html.match(/data-youtube-mount/g) || []).length, 1);
  assert.doesNotMatch(app, /YOUTUBE_API_KEY|youtubeDataApi|apiKey/i);
});
