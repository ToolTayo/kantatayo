import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getHomeShelves, isInternationalSong, isOpmSong } from "../src/discovery.js";

const playableId = (suffix) => `aaaaaaaaaa${suffix}`;

function song(id, overrides = {}) {
  return {
    id,
    title: id,
    artist: "Test Artist",
    language: "English",
    genre: "Pop",
    era: "2020s",
    mood: ["feel-good"],
    difficulty: "medium",
    vocalRange: "medium",
    performanceType: "solo",
    youtubeVideoId: playableId(id.slice(-1)),
    tags: [],
    demandTier: null,
    ...overrides
  };
}

test("Popular now uses demand evidence, prefers playable songs, and stays bounded", () => {
  const catalog = [
    song("recommended", { demandTier: "very-high" }),
    song("very-high", { demandTier: "very-high" }),
    song("high", { demandTier: "high" }),
    song("established", { demandTier: "established" }),
    song("unavailable", { demandTier: "very-high", youtubeVideoId: null })
  ];
  const shelves = getHomeShelves(catalog, [{ song: catalog[0], reason: "recommended" }]);

  assert.deepEqual(shelves.popular.map((item) => item.id), ["very-high", "high", "established", "recommended"]);
  assert.ok(shelves.popular.every((item) => item.youtubeVideoId));
  assert.ok(shelves.popular.length <= 5);
});

test("OPM and International shelves follow explicit catalog metadata", () => {
  const opm = song("opm", { language: "Filipino", tags: ["opm"] });
  const taggedOpm = song("tagged-opm", { language: "English", tags: ["opm"] });
  const international = song("international", { language: "English", tags: ["international"] });
  const ambiguous = song("ambiguous", { language: "English", tags: [] });
  const filipinoWithoutOpm = song("filipino", { language: "Filipino", tags: [] });

  assert.equal(isOpmSong(opm), true);
  assert.equal(isOpmSong(taggedOpm), true);
  assert.equal(isInternationalSong(international), true);
  assert.equal(isInternationalSong(ambiguous), true, "English is an explicit catalog language");
  assert.equal(isInternationalSong(filipinoWithoutOpm), false);
});

test("Home shelves use difficulty evidence for Easy to sing", () => {
  const easy = song("easy", { difficulty: "easy" });
  const medium = song("medium", { difficulty: "medium" });
  const unavailableEasy = song("unavailable-easy", { difficulty: "easy", youtubeVideoId: null });
  const shelves = getHomeShelves([easy, medium, unavailableEasy]);

  assert.deepEqual(shelves.easy.map((item) => item.id), ["easy"]);
  assert.ok(!shelves.easy.some((item) => item.difficulty !== "easy"));
});

test("Duets require performanceType metadata rather than artist punctuation", () => {
  const duet = song("duet", { artist: "Artist A & Artist B", performanceType: "duet" });
  const solo = song("solo-with-ampersand", { artist: "Artist A & Artist B", performanceType: "solo" });
  const shelves = getHomeShelves([duet, solo]);

  assert.deepEqual(shelves.duets.map((item) => item.id), ["duet"]);
});

test("Home shelf ordering is deterministic and avoids duplicate IDs within shelves", () => {
  const catalog = [
    song("b-opm", { language: "Filipino", tags: ["opm"] }),
    song("a-opm", { language: "Filipino", tags: ["opm"] }),
    song("popular", { demandTier: "very-high", tags: ["international"] }),
    song("popular-2", { demandTier: "high", tags: ["international"] })
  ];
  const first = getHomeShelves(catalog);
  const second = getHomeShelves(catalog);

  assert.deepEqual(first, second);
  for (const shelf of Object.values(first)) {
    const ids = shelf.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test("Sparse catalogs omit unsupported shelves without manufacturing songs", () => {
  const unavailable = song("unavailable", { youtubeVideoId: null, difficulty: "easy", performanceType: "duet" });
  const shelves = getHomeShelves([unavailable]);

  assert.deepEqual(shelves.popular, []);
  assert.deepEqual(shelves.easy, []);
  assert.deepEqual(shelves.duets, []);
  assert.deepEqual(shelves.international, []);
  assert.deepEqual(shelves.opm, []);
});

test("Home and mobile navigation expose karaoke search and Preferences", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(html, /Find your next <em>karaoke song\.<\/em>/);
  assert.match(html, /placeholder="Search a song, artist, mood, or era"/);
  assert.match(html, /class="mobile-more-menu"[^>]*data-mobile-more/);
  assert.match(html, /data-action="toggle-mobile-more"[^>]*aria-controls="mobile-more-menu"/);
  assert.match(html, /href="#preferences-panel" data-view="preferences"/);
  assert.match(app, /action === "toggle-mobile-more"/);
  assert.match(app, /\.mobile-more-menu a/);
});
