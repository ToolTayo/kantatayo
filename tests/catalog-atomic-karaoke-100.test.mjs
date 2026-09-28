import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const catalog = JSON.parse(fs.readFileSync("data/songs.sample.json", "utf8"));
const report = JSON.parse(fs.readFileSync("tools/atomic-karaoke-expansion-100-report.json", "utf8"));

function normalized(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function songKey(song) {
  return `${normalized(song.title)}\u0000${normalized(song.artist)}`;
}

test("Atomic expansion report records exactly 100 official-channel additions", () => {
  assert.equal(report.source.channelId, "UCutZyApGOjqhOS-pp7yAj4Q");
  assert.equal(report.source.channelHandle, "@AtomicKaraoke");
  assert.equal(report.catalogBefore, 361);
  assert.equal(report.targetAdditions, 100);
  assert.equal(report.selectedCount, 100);
  assert.equal(report.catalogAfter, 461);
  assert.equal(report.shortfall, 0);
  assert.equal(report.selected.length, 100);
  assert.equal(new Set(report.selected.map((entry) => entry.videoId)).size, 100);
  assert.ok(report.selected.every((entry) => entry.sourceChannelId === report.source.channelId));
  assert.ok(report.selected.every((entry) => entry.embeddable === true));
  assert.ok(report.selected.every((entry) => entry.madeForKids === false));
  assert.ok(report.selected.every((entry) => entry.definition === "hd"));
  assert.ok(report.selected.every((entry) => /karaoke/i.test(entry.videoTitle)));
});

test("Atomic expansion is appended without duplicate IDs, videos, or song pairs", () => {
  const additions = catalog.slice(361, 461);
  assert.equal(additions.length, 100);
  assert.deepEqual(additions.map((song) => song.id), Array.from({ length: 100 }, (_, index) => `sample-${381 + index}`));
  assert.ok(additions.every((song) => song.language === "Filipino"));
  assert.ok(additions.every((song) => song.tags.includes("atomic-karaoke")));
  assert.equal(additions.filter((song) => /^[A-Za-z0-9_-]{11}$/.test(song.youtubeVideoId || "")).length, 96);
  assert.equal(new Set(catalog.map((song) => song.id)).size, catalog.length);
  assert.equal(new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean)).size, 594);
  assert.equal(new Set(catalog.map(songKey)).size, catalog.length);
  assert.equal(catalog.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
});
