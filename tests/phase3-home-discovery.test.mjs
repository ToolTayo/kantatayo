import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getHomeShelves, hasMeaningfulUserSignals, isInternationalSong, isOpmSong } from "../src/discovery.js";

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

test("cold-start top picks balance playable OPM and international demand", () => {
  const catalog = [
    song("intl-1", { demandTier: "very-high", language: "English", tags: ["international"] }),
    song("opm-1", { demandTier: "very-high", language: "Filipino", tags: ["opm"] }),
    song("intl-2", { demandTier: "high", language: "English", tags: ["international"] }),
    song("opm-2", { demandTier: "high", language: "Filipino", tags: ["opm"] }),
    song("intl-3", { demandTier: "established", language: "English", tags: ["international"] }),
    song("unavailable", { demandTier: "very-high", language: "Filipino", tags: ["opm"], youtubeVideoId: null })
  ];
  const recommendations = catalog.filter((item) => item.youtubeVideoId).map((item) => ({ song: item, reason: "Popular karaoke pick" }));
  const shelves = getHomeShelves(catalog, recommendations);
  const topIds = new Set(shelves.recommended.map((item) => item.id));

  assert.equal(shelves.recommended.length, 5);
  assert.ok(shelves.recommended.every((item) => item.youtubeVideoId));
  assert.ok(shelves.recommended.filter(isOpmSong).length >= 2);
  assert.ok(shelves.recommended.filter(isInternationalSong).length >= 2);
  assert.equal(topIds.has("unavailable"), false);
});

test("meaningful signals unlock a non-duplicating Made for you shelf", () => {
  const catalog = Array.from({ length: 10 }, (_, index) => song(`personal-${index}`, {
    language: index % 2 ? "Filipino" : "English",
    tags: index % 2 ? ["opm"] : ["international"]
  }));
  const recommendations = catalog.map((item) => ({ song: item, reason: "Matches your preferences" }));
  const userState = { preferences: { languages: ["filipino"] }, likedSongs: ["personal-1"], favorites: [], dislikedSongs: [], sungHistory: [] };
  const shelves = getHomeShelves(catalog, recommendations, userState);
  const recommendedIds = new Set(shelves.recommended.map((item) => item.id));

  assert.equal(hasMeaningfulUserSignals(userState), true);
  assert.equal(shelves.madeForYou.length, 4);
  assert.ok(shelves.madeForYou.every((item) => !recommendedIds.has(item.id)));
  assert.ok(shelves.madeForYou.every((item) => item.youtubeVideoId));
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

test("all primary Home shelves exclude unavailable songs", () => {
  const unavailable = song("unavailable", { youtubeVideoId: null, demandTier: "very-high", language: "Filipino", tags: ["opm"] });
  const playable = song("playable", { demandTier: "very-high", language: "Filipino", tags: ["opm"] });
  const shelves = getHomeShelves([unavailable, playable], [{ song: playable }]);

  Object.entries(shelves).forEach(([name, items]) => {
    if (name === "recent") return;
    assert.ok(items.every((item) => item.youtubeVideoId), `${name} contains an unavailable song`);
  });
});

test("Home and mobile navigation expose karaoke search and Preferences", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(html, /Find your next <em>karaoke song\.<\/em>/);
  assert.match(html, /placeholder="Search a song, artist, mood, or era"/);
  assert.match(html, /class="mobile-more-menu"[^>]*data-mobile-more/);
  assert.match(html, /data-action="toggle-mobile-more"[^>]*aria-controls="mobile-more-menu"/);
  assert.match(html, /href="#preferences-panel" data-view="preferences"/);
  assert.match(html, /data-section="madeForYou"/);
  assert.match(html, /data-home-filter="filipino"/);
  assert.match(html, /Explore OPM/);
  assert.match(app, /action === "toggle-mobile-more"/);
  assert.match(app, /\.mobile-more-menu a/);
});
