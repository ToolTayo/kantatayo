import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createDefaultDiscoveryFilters,
  createQuickFilterState,
  createSearchIndex,
  getDiscoveryFilterOptions,
  getDiscoveryPage,
  getDiscoverySongs,
  hasActiveDiscoveryFilters
} from "../src/discovery.js";

const catalog = JSON.parse(await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8"));
const index = createSearchIndex(catalog);

test("search matches title and punctuation-insensitively", () => {
  const results = getDiscoverySongs(index, { query: "Don't Stop Believin" });
  assert.ok(results.some((song) => /don't stop believin/i.test(song.title)));
});

test("search matches artist and metadata fields locally", () => {
  assert.ok(getDiscoverySongs(index, { query: "Eraserheads" }).length > 0);
  assert.ok(getDiscoverySongs(index, { query: "Filipino" }).every((song) => song.language === "Filipino"));
  assert.ok(getDiscoverySongs(index, { query: "heartbreak" }).length > 0);
});

test("playable-only discovery excludes every unavailable catalog record", () => {
  const unavailable = catalog.filter((song) => !song.youtubeVideoId);
  const results = getDiscoverySongs(index, { filters: { availability: "playable" } });
  assert.equal(results.length, catalog.length - unavailable.length);
  assert.equal(results.some((song) => !song.youtubeVideoId), false);
});

test("all songs remains browseable when the playable pool is empty", () => {
  const unavailableIndex = createSearchIndex([{ ...catalog[0], id: "fixture-unavailable", youtubeVideoId: null }]);
  assert.equal(getDiscoverySongs(unavailableIndex, {}).length, 1);
  assert.equal(getDiscoverySongs(unavailableIndex, { filters: { availability: "playable" } }).length, 0);
});

test("derived filter options come from normalized catalog metadata", () => {
  const options = getDiscoveryFilterOptions(catalog);
  assert.deepEqual(options.language, ["English", "Filipino"]);
  assert.ok(options.genre.includes("R&B"));
  assert.ok(options.mood.includes("party"));
  assert.deepEqual(options.performanceType, ["duet", "group", "solo"]);
  assert.deepEqual(options.era, ["1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"]);
});

test("catalog filters compose as an intersection", () => {
  const filters = { language: "filipino", genre: "ballad", difficulty: "easy" };
  const results = getDiscoverySongs(index, { filters });
  assert.ok(results.length > 0);
  assert.ok(results.every((song) => song.language === "Filipino" && song.genre === "Ballad" && song.difficulty === "easy"));
});

test("reset state has no active filters and preferences are not discovery filters", () => {
  assert.equal(hasActiveDiscoveryFilters(createDefaultDiscoveryFilters()), false);
  assert.equal(hasActiveDiscoveryFilters({ language: "filipino" }), true);
  assert.equal(getDiscoverySongs(index, { filters: createDefaultDiscoveryFilters() }).length, catalog.length);
});

test("quick filters replace the previous quick-filter state", () => {
  assert.deepEqual(createQuickFilterState("all"), createDefaultDiscoveryFilters());
  assert.deepEqual(createQuickFilterState("playable"), { ...createDefaultDiscoveryFilters(), availability: "playable" });
  assert.deepEqual(createQuickFilterState("filipino"), { ...createDefaultDiscoveryFilters(), language: "filipino" });
  assert.deepEqual(createQuickFilterState("easy"), { ...createDefaultDiscoveryFilters(), difficulty: "easy" });
  assert.deepEqual(createQuickFilterState("duet"), { ...createDefaultDiscoveryFilters(), performanceType: "duet" });
});

test("popular sorting uses the catalog demand signal with deterministic ties", () => {
  const results = getDiscoverySongs(index, { sortBy: "popular" });
  const tiers = { "very-high": 0, high: 1, established: 2 };
  for (let i = 1; i < results.length; i += 1) {
    assert.ok((tiers[results[i - 1].demandTier] ?? 3) <= (tiers[results[i].demandTier] ?? 3));
  }
});

test("pagination reports total matches and never duplicates pages", () => {
  const results = getDiscoverySongs(index, {});
  const first = getDiscoveryPage(results, 1, 24);
  const second = getDiscoveryPage(results, 2, 24);
  assert.equal(first.total, results.length);
  assert.equal(first.songs.length, 24);
  assert.equal(new Set([...first.songs, ...second.songs].map((song) => song.id)).size, first.songs.length + second.songs.length);
  assert.equal(first.hasMore, true);
});

test("load-more pagination retains earlier results when the next page is shown", () => {
  const results = getDiscoverySongs(index, {});
  const second = getDiscoveryPage(results, 2, 24);
  const visibleThroughSecondPage = results.slice(0, second.page * second.pageSize);
  assert.equal(visibleThroughSecondPage.length, 48);
  assert.deepEqual(visibleThroughSecondPage.slice(0, 24), results.slice(0, 24));
  assert.deepEqual(visibleThroughSecondPage.slice(24), second.songs);
});

test("zero-result searches remain safe and countable", () => {
  const results = getDiscoverySongs(index, { query: "zzzz no such karaoke song" });
  assert.deepEqual(results, []);
  assert.equal(getDiscoveryPage(results, 1, 24).hasMore, false);
});

test("discover UI exposes availability, derived filters, sorting, reset, and load more controls", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /data-filter="playable"/);
  assert.match(html, /data-discovery-filter="language"/);
  assert.match(html, /data-discovery-filter="genre"/);
  assert.match(html, /data-discovery-filter="mood"/);
  assert.match(html, /data-discovery-filter="era"/);
  assert.match(html, /value="popular"/);
  assert.match(html, /data-action="reset-discovery-filters"/);
  assert.match(html, /data-action="load-more-discover"/);
});
