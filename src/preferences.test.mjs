import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCatalog } from "./catalog.js";
import { createSearchIndex, getDiscoverySongs } from "./discovery.js";
import { getCatalogPreferenceOptions } from "./preferences.js";
import { clearPreferences, createDefaultUserState, loadUserState, saveUserState, setPreferenceValues } from "./state.js";

test("preferences save and reload through the existing versioned storage key", () => {
  const storage = createMemoryStorage();
  const userState = createDefaultUserState();
  setPreferenceValues(userState, "languages", ["Filipino"]);
  setPreferenceValues(userState, "difficulties", ["easy"]);
  setPreferenceValues(userState, "performanceTypes", ["duet"]);

  assert.equal(saveUserState(userState, { storage }), true);
  const reloaded = loadUserState({ storage });
  assert.deepEqual(reloaded.preferences, {
    languages: ["filipino"],
    genres: [],
    moods: [],
    difficulties: ["easy"],
    vocalRanges: [],
    performanceTypes: ["duet"],
    eras: []
  });
  assert.equal(JSON.parse(storage.getItem("kantatayo:user-state")).version, 4);
});

test("multiple preference categories normalize safely", () => {
  const userState = createDefaultUserState();
  setPreferenceValues(userState, "genres", [" Ballad ", "ballad", "Pop Rock"]);
  setPreferenceValues(userState, "moods", ["Love", "party"]);
  setPreferenceValues(userState, "vocalRanges", ["High"]);
  setPreferenceValues(userState, "eras", ["1990s"]);

  assert.deepEqual(userState.preferences.genres, ["ballad", "pop rock"]);
  assert.deepEqual(userState.preferences.moods, ["love", "party"]);
  assert.deepEqual(userState.preferences.vocalRanges, ["high"]);
  assert.deepEqual(userState.preferences.eras, ["1990s"]);
});

test("clearing preferences preserves the rest of the user state", () => {
  const userState = createDefaultUserState();
  userState.favorites = ["sample-001"];
  userState.likedSongs = ["sample-002"];
  userState.dislikedSongs = ["sample-003"];
  userState.sungHistory = [{ id: "sample-004", sungAt: "2026-09-22T00:00:00.000Z" }];
  userState.queue = ["sample-001", "sample-004"];
  userState.currentSongId = "sample-004";
  setPreferenceValues(userState, "languages", ["English"]);

  assert.equal(clearPreferences(userState), true);
  assert.deepEqual(userState.preferences, createDefaultUserState().preferences);
  assert.deepEqual(userState.favorites, ["sample-001"]);
  assert.deepEqual(userState.likedSongs, ["sample-002"]);
  assert.deepEqual(userState.dislikedSongs, ["sample-003"]);
  assert.deepEqual(userState.sungHistory, [{ id: "sample-004", sungAt: "2026-09-22T00:00:00.000Z" }]);
  assert.deepEqual(userState.queue, ["sample-001", "sample-004"]);
  assert.equal(userState.currentSongId, "sample-004");
});

test("older and malformed saved states load without losing durable collections", () => {
  const storage = createMemoryStorage({
    "kantatayo:user-state": JSON.stringify({
      version: 1,
      favorites: ["sample-001"],
      likedSongs: ["sample-002"],
      queue: ["sample-001"],
      currentSongId: "sample-001",
      preferences: { languages: "not-an-array", genres: [" Pop ", 42, "pop"] }
    })
  });

  const loaded = loadUserState({ storage });
  assert.deepEqual(loaded.preferences.languages, []);
  assert.deepEqual(loaded.preferences.genres, ["pop"]);
  assert.deepEqual(loaded.favorites, ["sample-001"]);
  assert.deepEqual(loaded.likedSongs, ["sample-002"]);
  assert.deepEqual(loaded.queue, ["sample-001"]);
  assert.equal(loaded.currentSongId, "sample-001");

  const migrated = loadUserState({ storage: createMemoryStorage({
    "kantatayo:user-state": JSON.stringify({ version: 0, favorites: ["sample-003"], preferences: null })
  }) });
  assert.deepEqual(migrated.preferences, createDefaultUserState().preferences);
  assert.deepEqual(migrated.favorites, ["sample-003"]);
});

test("preference options are derived from catalog metadata", async () => {
  const raw = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
  const catalog = normalizeCatalog(raw, { logger: { warn() {} } }).songs;
  const options = getCatalogPreferenceOptions(catalog);
  const metadataLanguages = new Set(catalog.map((song) => song.language));
  const metadataMoods = new Set(catalog.flatMap((song) => song.mood));

  assert.deepEqual(new Set(options.languages), metadataLanguages);
  assert.deepEqual(new Set(options.moods), metadataMoods);
  assert.deepEqual(options.difficulties, ["easy", "medium", "hard"]);
  assert.ok(options.performanceTypes.includes("solo"));
  assert.ok(options.eras.includes("1990s"));
});

test("preferences do not filter local discovery results", async () => {
  const raw = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
  const catalog = normalizeCatalog(raw, { logger: { warn() {} } }).songs;
  const index = createSearchIndex(catalog);
  const allSongs = getDiscoverySongs(index, { query: "", filter: "all" });
  const withPreferencesStillAllSongs = getDiscoverySongs(index, { query: "", filter: "all", preferences: { languages: ["filipino"], difficulties: ["easy"] } });
  assert.equal(withPreferencesStillAllSongs.length, allSongs.length);
});

test("promoted IDs and catalog playability remain unchanged", async () => {
  const raw = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
  const promoted = raw.filter((song) => song.youtubeVideoId !== null);
  assert.equal(promoted.length, 361);
  assert.equal(raw.filter((song) => song.youtubeVideoId === null).length, 0);
  assert.equal(raw.find((song) => song.id === "sample-029").youtubeVideoId, "QBb9wO3Bj0k");
});

test("preference implementation introduces no frontend API keys or secrets", async () => {
  const paths = ["index.html", "src/app.js", "src/state.js", "src/storage.js", "src/preferences.js", "src/ui.js", "styles/main.css"];
  const contents = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const source = contents.join("\n");
  assert.equal(/AIza[0-9A-Za-z_-]{20,}/.test(source), false);
  assert.equal(/YOUTUBE_API_KEY/.test(source), false);
});

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}
