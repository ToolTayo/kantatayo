import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCatalog } from "../src/catalog.js";
import { normalizeView } from "../src/view.js";

const primary = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
const rawExclusive = JSON.parse(await readFile("data/songs.exclusive.json", "utf8"));
const exclusive = normalizeCatalog(rawExclusive, { logger: { warn() {} } });

test("Exclusive collection contains the five supplied public karaoke videos", () => {
  assert.equal(primary.length, 171);
  assert.equal(exclusive.songs.length, 5);
  assert.equal(exclusive.warnings.length, 0);
  assert.deepEqual(exclusive.songs.map((song) => [song.id, song.title, song.artist, song.youtubeVideoId]), [
    ["exclusive-001", "Gratitude", "Brandon Lake", "D5cwJW650eU"],
    ["exclusive-002", "10,000 Reasons (Bless The Lord)", "Matt Redman", "vWdqDmjQuaE"],
    ["exclusive-003", "Holy Forever", "CeCe Winans", "GBSvbXkXxc8"],
    ["exclusive-004", "Goodness of God", "CeCe Winans", "1sntrHM1Oak"],
    ["exclusive-005", "You Raise Me Up", "Josh Groban", "btwJm_mV-84"]
  ]);
});

test("Exclusive records do not duplicate the production catalog", () => {
  const primaryIds = new Set(primary.map((song) => song.id.toLowerCase()));
  const primaryPairs = new Set(primary.map((song) => `${song.title.trim().toLowerCase()}|${song.artist.trim().toLowerCase()}`));
  assert.equal(new Set(exclusive.songs.map((song) => song.id.toLowerCase())).size, exclusive.songs.length);
  assert.ok(exclusive.songs.every((song) => !primaryIds.has(song.id.toLowerCase())));
  assert.ok(exclusive.songs.every((song) => !primaryPairs.has(`${song.title.trim().toLowerCase()}|${song.artist.trim().toLowerCase()}`)));
  assert.ok(exclusive.songs.every((song) => typeof song.youtubeVideoId === "string" && song.youtubeVideoId.length === 11));
});

test("Exclusive page uses the existing route and playback architecture", async () => {
  const [html, app, ui] = await Promise.all([
    readFile("index.html", "utf8"),
    readFile("src/app.js", "utf8"),
    readFile("src/ui.js", "utf8")
  ]);
  assert.equal(normalizeView("exclusive"), "exclusive");
  assert.match(html, /href="#exclusive"[^>]*data-view="exclusive"/);
  assert.match(html, /data-view-panel="exclusive"/);
  assert.match(html, /data-grid="exclusive"/);
  assert.match(ui, /data-action="play" data-song-id/);
  assert.match(app, /action === "play"/);
  assert.match(app, /setCatalog\(state, allSongs/);
});
