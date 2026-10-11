import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { browseMedleys, browseLibrary, getQueueableLibrarySongs, suggestCatalogSearch } from "../src/library-browse.js";
import { createDefaultUserState, addSongToQueue } from "../src/state.js";
import { renderSongSections } from "../src/ui.js";
import { createSearchIndex } from "../src/discovery.js";

const songs = [
  { id: "s-1", title: "Bohemian Rhapsody", artist: "Queen", youtubeVideoId: "abcdefghijk" },
  { id: "s-2", title: "Buwan", artist: "Juan Karlos", youtubeVideoId: "bcdefghijkl" },
  { id: "s-3", title: "Unavailable", artist: "Queen", youtubeVideoId: null }
];
const medleys = [
  { id: "m-1", title: "OPM Love Songs", provider: "One", language: "Filipino", theme: "Love", videoId: "abcdefghijk", publicViews: 10, includedSongs: [{ title: "Kahit Kailan", artist: "South Border" }] },
  { id: "m-2", title: "Rock", provider: "Two", language: "English", theme: "Rock", videoId: "bcdefghijkl", publicViews: 100 },
  { id: "m-3", title: "Unknown", provider: "One", language: "Unknown", theme: "Various", videoId: "cdefghijklm" }
];

test("medley search matches real title, theme, provider and documented sections", () => {
  assert.equal(browseMedleys(medleys).length, 3);
  assert.deepEqual(browseMedleys(medleys, { query: "south kahit" }).map(item => item.id), ["m-1"]);
  assert.deepEqual(browseMedleys(medleys, { query: "rock two" }).map(item => item.id), ["m-2"]);
  assert.equal(browseMedleys(medleys, { query: "<script>" }).length, 0);
});
test("combined medley filters intersect, exclude unknown language and recover when cleared", () => {
  assert.deepEqual(browseMedleys(medleys, { category: "opm" }).map(item => item.id), ["m-1"]);
  assert.deepEqual(browseMedleys(medleys, { category: "international" }).map(item => item.id), ["m-2"]);
  assert.equal(browseMedleys(medleys, { category: "opm", provider: "Two" }).length, 0);
  assert.equal(browseMedleys(medleys, {}).length, 3);
});
test("view sorting uses recorded evidence, stable ties, and never mutates data", () => {
  const before = JSON.stringify(medleys);
  assert.deepEqual(browseMedleys(medleys, { sort: "views" }).map(item => item.id), ["m-2", "m-1", "m-3"]);
  assert.deepEqual(browseMedleys(medleys, { sort: "title" }).map(item => item.id), ["m-1", "m-2", "m-3"]);
  assert.equal(JSON.stringify(medleys), before);
  assert.equal(browseMedleys([null, {}, { id: "bad", videoId: null }]).length, 0);
});
test("favorites are recent-first, searchable, deduplicated and ignore deleted references", () => {
  const user = { favorites: ["s-1", "s-2", "s-1", "deleted", null] };
  assert.deepEqual(browseLibrary(songs, user).map(song => song.id), ["s-2", "s-1"]);
  assert.deepEqual(browseLibrary(songs, user, "favorites", { query: "juan" }).map(song => song.id), ["s-2"]);
  assert.equal(browseLibrary(songs, user, "favorites", { query: "unknown" }).length, 0);
  assert.deepEqual(browseLibrary(songs, user, "favorites", { sort: "title" }).map(song => song.id), ["s-1", "s-2"]);
});
test("Recently Sung preserves actual completion ordering rather than playback history", () => {
  const user = { sungHistory: [{ id: "s-2" }, { id: "s-1" }, { id: "s-2" }], recentlyPlayed: [{ id: "s-3" }] };
  assert.deepEqual(browseLibrary(songs, user, "recent").map(song => song.id), ["s-2", "s-1"]);
});
test("batch queue excludes unavailable and queued songs without playback or history changes", () => {
  const user = createDefaultUserState(); user.favorites = ["s-1", "s-2", "s-3"];
  addSongToQueue(user, "s-1");
  const matches = getQueueableLibrarySongs(songs, user, "favorites", {});
  assert.deepEqual(matches.map(song => song.id), ["s-2"]);
  for (const song of matches) addSongToQueue(user, song.id);
  assert.deepEqual(getQueueableLibrarySongs(songs, user, "favorites", {}), []);
  assert.equal(user.currentSongId, null);
  assert.deepEqual(user.sungHistory, []);
  assert.deepEqual(user.recentlyPlayed, []);
});
test("explicit typo recovery uses only playable metadata and bounded meaningful matches", () => {
  assert.deepEqual(suggestCatalogSearch(songs, "bohimian"), ["Bohemian Rhapsody"]);
  assert.deepEqual(suggestCatalogSearch(songs, "buawn"), ["Buwan"]);
  assert.deepEqual(suggestCatalogSearch(songs, "unavailble"), []);
  assert.deepEqual(suggestCatalogSearch(songs, "xyzzzzz"), []);
  assert.deepEqual(suggestCatalogSearch(songs, "a"), []);
  assert.deepEqual(suggestCatalogSearch(songs, "x".repeat(1000)), []);
});
test("Recently Sung empty view is visible without rendering or mutating hidden Home grids", () => {
  const previous = globalThis.document;
  const elements = new Map();
  const node = selector => { if (!elements.has(selector)) elements.set(selector, { hidden: true, innerHTML: "untouched", textContent: "", setAttribute() {} }); return elements.get(selector); };
  globalThis.document = { body: { dataset: {} }, querySelector: node, querySelectorAll: () => [] };
  try {
    renderSongSections(createSearchIndex(songs), "", "all", "relevance", {}, [], "recent");
    assert.equal(node("[data-recent-view-empty]").hidden, false);
    assert.equal(elements.has('[data-grid="recommended"]'), false);
    assert.equal(elements.has("[data-recent-empty]"), false);
  } finally { globalThis.document = previous; }
});
test("browse controls are accessible, ephemeral and cached with the first-party shell", async () => {
  const [html, app, worker] = await Promise.all(["index.html", "src/app.js", "service-worker.js"].map(file => readFile(file, "utf8")));
  assert.match(html, /data-collection-tabs role="group"/);
  assert.match(html, /data-active-filters role="group"/);
  assert.match(html, /<label class="browse-search"><span>Find a medley<\/span><input type="search"/);
  assert.match(app, /if \(currentView === "collections"\) renderCollections/);
  assert.match(app, /if \(currentView === "preferences"\) renderPreferences/);
  assert.match(worker, /library-browse\.js\?v=1/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^\n]*(?:libraryBrowse|medleyBrowse)/);
});
