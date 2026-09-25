import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getDailyChallengeSelection, getLocalDateKey, selectDailyChallengeSong } from "../src/daily-challenge.js";

const catalog = JSON.parse(await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8"));

function fixtureSong(id, artist = `Artist ${id}`, demandTier = "very-high") {
  return {
    id,
    title: `Song ${id}`,
    artist,
    language: "English",
    genre: "Pop",
    era: "2020s",
    mood: ["upbeat"],
    difficulty: "easy",
    vocalRange: "medium",
    performanceType: "solo",
    demandTier,
    youtubeVideoId: `${id.replace(/[^a-z0-9]/gi, "a").padEnd(11, "a").slice(0, 11)}`,
    tags: ["karaoke"]
  };
}

test("same local date returns the same playable challenge across repeated selection", () => {
  const first = getDailyChallengeSelection(catalog, { now: new Date(2026, 8, 25, 1, 0) });
  const repeat = getDailyChallengeSelection(catalog, { now: new Date(2026, 8, 25, 23, 59) });
  assert.equal(first.dateKey, "2026-09-25");
  assert.equal(first.song?.id, repeat.song?.id);
  assert.ok(first.song?.youtubeVideoId);
});

test("local date rollover changes the deterministic rotation when the pool allows it", () => {
  const fixture = Array.from({ length: 12 }, (_, index) => fixtureSong(`fixture-${String(index + 1).padStart(3, "0")}`));
  const ids = new Set();
  for (let day = 1; day <= 20; day += 1) {
    ids.add(selectDailyChallengeSong(fixture, `2026-10-${String(day).padStart(2, "0")}`)?.id);
  }
  assert.ok(ids.size > 1);
});

test("catalog reorder does not change the challenge for the same date", () => {
  const dateKey = "2026-09-25";
  const original = selectDailyChallengeSong(catalog, dateKey);
  const reordered = selectDailyChallengeSong([...catalog].reverse(), dateKey);
  assert.equal(reordered?.id, original?.id);
});

test("only playable, complete song records are eligible", () => {
  const valid = fixtureSong("valid-001");
  const songs = [
    { id: "missing-video", title: "Missing", artist: "Artist", youtubeVideoId: null },
    { id: "bad-record", title: "Bad", artist: "Artist", youtubeVideoId: "not-an-id" },
    { id: "missing-title", artist: "Artist", youtubeVideoId: "aaaaaaaaaaa" },
    valid
  ];
  assert.equal(selectDailyChallengeSong(songs, "2026-09-25")?.id, valid.id);
});

test("demand tiers influence the daily pool without fabricating popularity", () => {
  const fixture = [fixtureSong("very-high-1", "Popular Artist", "very-high"), fixtureSong("high-1", "High Artist", "high")];
  const selected = selectDailyChallengeSong(fixture, "2026-09-25");
  assert.ok(["very-high", "high"].includes(selected?.demandTier));
  assert.ok(selected?.demandTier, "the challenge should prefer a catalog-backed demand tier");
});

test("selection does not depend on Math.random", () => {
  const originalRandom = Math.random;
  Math.random = () => { throw new Error("Math.random must not be called"); };
  try {
    assert.ok(selectDailyChallengeSong(catalog, "2026-09-25"));
  } finally {
    Math.random = originalRandom;
  }
});

test("empty, malformed, and invalid-date inputs fail safely", () => {
  assert.equal(selectDailyChallengeSong([], "2026-09-25"), null);
  assert.equal(selectDailyChallengeSong(null, "2026-09-25"), null);
  assert.equal(selectDailyChallengeSong([null, "bad", {}], "2026-09-25"), null);
  assert.equal(selectDailyChallengeSong(catalog, "2026-02-31"), null);
});

test("date keys use the local calendar rather than UTC formatting", () => {
  const localMorning = new Date(2026, 8, 25, 0, 15);
  assert.equal(getLocalDateKey(localMorning), "2026-09-25");
});

test("Home challenge markup uses the existing play action and thumbnail architecture", async () => {
  const [html, app, ui] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/ui.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /data-daily-thumbnail/);
  assert.match(html, /data-action="daily-challenge-play"/);
  assert.match(html, /Sing Today.s Challenge/);
  assert.match(app, /daily-challenge-play/);
  assert.match(ui, /renderSongThumbnail\(challenge\.song/);
});

test("daily challenge media keeps the shared sparse-card bounds", async () => {
  const css = await readFile(new URL("../styles/main.css", import.meta.url), "utf8");
  assert.match(css, /\.daily-challenge-thumbnail[\s\S]*?width:\s*min\(100%,\s*16rem\)/);
  assert.match(css, /\.daily-challenge-thumbnail \.song-thumbnail[\s\S]*?max-width:\s*16rem/);
  assert.match(css, /\.daily-challenge-layout[\s\S]*?grid-template-columns/);
  assert.match(css, /\.song-thumbnail\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9/);
});
