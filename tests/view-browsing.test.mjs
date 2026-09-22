import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCatalog } from "../src/catalog.js";
import { createSearchIndex, getDiscoverySongs } from "../src/discovery.js";
import { renderSongCard } from "../src/ui.js";
import { normalizeView, viewHash } from "../src/view.js";

const catalog = normalizeCatalog(JSON.parse(await readFile("data/songs.sample.json", "utf8")));
const index = createSearchIndex(catalog.songs);
const emptyInteraction = { favoriteIds: new Set(), likedIds: new Set(), dislikedIds: new Set() };

test("view state maps Home and catalog routes without changing the catalog", () => {
  assert.equal(normalizeView("#top"), "home");
  assert.equal(normalizeView("discover"), "discover");
  assert.equal(normalizeView("unknown"), "home");
  assert.equal(viewHash("favorites"), "#favorites");
  assert.equal(getDiscoverySongs(index, { filter: "all" }).length, 145);
  assert.equal(getDiscoverySongs(index, { filter: "english" }).length > 0, true);
});

test("Discover keeps unavailable catalog songs browseable but removes playback affordance", () => {
  const unavailable = catalog.songs.find((song) => song.youtubeVideoId === null);
  const playable = catalog.songs.find((song) => song.youtubeVideoId);
  const unavailableCard = renderSongCard(unavailable, emptyInteraction, { catalogView: true });
  const playableCard = renderSongCard(playable, emptyInteraction, { catalogView: true });
  assert.match(unavailableCard, /Karaoke unavailable/);
  assert.doesNotMatch(unavailableCard, /data-action="play"/);
  assert.match(unavailableCard, /<button class="add-button" type="button" disabled/);
  assert.match(playableCard, /data-action="play"/);
});

test("Home and Discover are separate UI surfaces with a complete-catalog CTA", async () => {
  const [html, app, ui] = await Promise.all([
    readFile("index.html", "utf8"),
    readFile("src/app.js", "utf8"),
    readFile("src/ui.js", "utf8")
  ]);
  assert.match(html, /data-view-panel="home"/);
  assert.match(html, /data-view-panel="discover"/);
  assert.match(html, /Browse all songs/);
  assert.match(html, /data-grid="discover"/);
  assert.match(html, /data-filter="filipino"/);
  assert.match(html, /data-filter="english"/);
  assert.match(app, /closest\("\.primary-nav a, \.mobile-nav a, \.brand, \.sidebar-brand, a\[data-view\]"\)/);
  assert.doesNotMatch(app, /closest\("[^\"]*,\s*\[data-view\][^\"]*"\)/);
  assert.match(ui, /sidebar-brand, a\[data-view\]/);
  assert.doesNotMatch(ui, /sidebar-brand, \[data-view\],/);
});
