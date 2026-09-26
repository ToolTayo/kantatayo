import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCatalog } from "../src/catalog.js";

const catalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
const report = JSON.parse(await readFile("tools/karaokeytv-expansion-report.json", "utf8"));

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function songKey(song) {
  return `${normalize(song.title)}\u0000${normalize(song.artist)}`;
}

test("KaraokeyTV report records 50 ordered new additions", () => {
  assert.equal(report.source.channelHandle, "@karaokeytv0618");
  assert.equal(report.source.listing, "Public channel Videos > Popular");
  assert.equal(report.entries.length, 50);
  assert.deepEqual(report.entries.map((entry) => entry.rank), [...report.entries].map((entry) => entry.rank).sort((a, b) => a - b));
  assert.deepEqual(report.entries.map((entry) => entry.decision), Array(50).fill("NEW — ADDED"));
});

test("KaraokeyTV additions are unique against the prior 211-song catalog", () => {
  const previous = catalog.slice(0, report.catalogBefore);
  const additions = catalog.filter((song) => {
    const number = Number(song.id.replace("sample-", ""));
    return number >= 231 && number <= 280;
  });
  const previousKeys = new Set(previous.map(songKey));
  const additionKeys = additions.map(songKey);
  const additionVideoIds = additions.map((song) => song.youtubeVideoId);

  assert.equal(report.catalogBefore, 211);
  assert.equal(additions.length, 50);
  assert.deepEqual(additions.map((song) => song.id), Array.from({ length: 50 }, (_, index) => `sample-${String(index + 231).padStart(3, "0")}`));
  assert.ok(additionKeys.every((key) => !previousKeys.has(key)));
  assert.equal(new Set(additionKeys).size, additions.length);
  assert.equal(new Set(additionVideoIds).size, additions.length);
  assert.deepEqual(additions.map((song) => song.youtubeVideoId), report.entries.map((entry) => entry.videoId));
});

test("expanded catalog remains fully valid and playable", () => {
  const normalized = normalizeCatalog(catalog, { logger: { warn() {} } });
  assert.equal(catalog.length, 361);
  assert.equal(normalized.songs.length, 361);
  assert.equal(normalized.rejectedRecords, 0);
  assert.deepEqual(normalized.warnings, []);
  assert.equal(catalog.filter((song) => song.youtubeVideoId).length, 361);
  assert.equal(catalog.filter((song) => song.youtubeVideoId === null).length, 0);
  assert.equal(new Set(catalog.map((song) => song.id)).size, 361);
  assert.equal(new Set(catalog.map((song) => song.youtubeVideoId)).size, 361);
});
