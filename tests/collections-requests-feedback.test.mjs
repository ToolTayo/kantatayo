import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getCollectionSongs, getFeaturedCollectionId, LOCAL_COLLECTIONS } from "../src/collections.js";
import { addSongRequest, createDefaultUserState, loadUserState, recordPlaybackFeedback, saveUserState, setPreferenceValues } from "../src/state.js";

const songs = JSON.parse(await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8"));

test("local collections derive from catalog metadata and only show playable songs", () => {
  assert.equal(LOCAL_COLLECTIONS.length, 5);
  for (const collection of LOCAL_COLLECTIONS) {
    const matches = getCollectionSongs(collection.id, songs, 10);
    assert.ok(matches.length > 0, `${collection.id} should have sample coverage`);
    assert.ok(matches.every((song) => /^[A-Za-z0-9_-]{11}$/.test(song.youtubeVideoId || "")));
  }
  assert.equal(getCollectionSongs("easy-tonight", songs).every((song) => song.difficulty === "easy"), true);
  assert.equal(getCollectionSongs("duets-two", songs).every((song) => song.performanceType === "duet"), true);
  assert.equal(getFeaturedCollectionId(new Date("2026-09-25T12:00:00")), "friday-night");
});

test("song requests are local, normalized, bounded, and duplicate-safe", () => {
  const state = createDefaultUserState();
  assert.equal(addSongRequest(state, "  New   Song ", "  Artist ", { now: "2026-09-25T12:00:00Z" }).added, true);
  assert.equal(addSongRequest(state, "new song", "artist").reason, "duplicate");
  assert.equal(addSongRequest(state, "", "Artist").reason, "missing-title-or-artist");
  assert.equal(state.songRequests[0].title, "New Song");
});

test("playback feedback keeps controlled reasons and persists with the existing state record", () => {
  const state = createDefaultUserState();
  assert.equal(recordPlaybackFeedback(state, "sample-001", "good", null, { now: "2026-09-25T12:00:00Z" }).recorded, true);
  assert.equal(recordPlaybackFeedback(state, "sample-001", "problem", "poor-quality", { now: "2026-09-25T12:01:00Z" }).recorded, true);
  assert.equal(recordPlaybackFeedback(state, "sample-002", "problem", "not-a-reason").recorded, false);
  assert.deepEqual(state.playbackFeedback.map((item) => [item.songId, item.rating, item.reason]), [["sample-001", "problem", "poor-quality"]]);
  const storage = memoryStorage();
  assert.equal(saveUserState(state, { storage }), true);
  assert.equal(loadUserState({ storage }).playbackFeedback[0].reason, "poor-quality");
});

test("version 2 state migrates without losing queue, preferences, or new local fields", () => {
  const storage = memoryStorage({
    "kantatayo:user-state": JSON.stringify({ version: 2, queue: ["sample-001"], favorites: ["sample-002"], preferences: { languages: ["filipino"] }, songRequests: [{ title: "Song", artist: "Artist", requestedAt: "2026-09-25T12:00:00Z" }] })
  });
  const loaded = loadUserState({ storage });
  assert.equal(loaded.version, 3);
  assert.deepEqual(loaded.queue, ["sample-001"]);
  assert.deepEqual(loaded.preferences.languages, ["filipino"]);
  assert.equal(loaded.songRequests.length, 1);
  assert.deepEqual(loaded.playbackFeedback, []);
});

test("malformed request and feedback records degrade safely", () => {
  const storage = memoryStorage({
    "kantatayo:user-state": JSON.stringify({ version: 3, songRequests: "bad", playbackFeedback: [{ songId: "sample-001", rating: "problem", reason: "bad" }, { songId: "sample-002", rating: "good", createdAt: "2026-09-25T12:00:00Z" }] })
  });
  const loaded = loadUserState({ storage });
  assert.deepEqual(loaded.songRequests, []);
  assert.deepEqual(loaded.playbackFeedback, [{ songId: "sample-002", rating: "good", reason: null, createdAt: "2026-09-25T12:00:00.000Z" }]);
});

test("new engagement controls stay local and preserve catalog/video boundaries", async () => {
  const [html, app, collections] = await Promise.all([
    readFile("index.html", "utf8"),
    readFile("src/app.js", "utf8"),
    readFile("src/collections.js", "utf8")
  ]);
  assert.match(html, /data-action="surprise-me"/);
  assert.match(html, /data-song-request-form/);
  assert.match(html, /data-action="feedback-good"/);
  assert.match(app, /recordPlaybackFeedback/);
  assert.doesNotMatch(`${app}\n${collections}`, /YOUTUBE_API_KEY|fetch\(|XMLHttpRequest|apiKey/i);
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}
