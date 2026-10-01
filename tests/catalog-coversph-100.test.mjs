import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCatalog } from "../src/catalog.js";

const catalog = JSON.parse(fs.readFileSync("data/songs.sample.json", "utf8"));
const report = JSON.parse(fs.readFileSync("tools/coversph-expansion-100-report.json", "utf8"));

function normalized(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .replace(/ +/g, " ")
    .trim()
    .replace(/ /g, "");
}

function songKey(song) {
  return `${normalized(song.title)}\u0000${normalized(song.artist)}`;
}

test("CoversPH report records exactly 100 official, technically qualified additions", () => {
  assert.equal(report.source.channelId, "UCaPwSXblS8F0owlKHGc6huw");
  assert.equal(report.source.channelHandle, "@CoversPH");
  assert.equal(report.catalogBefore, 461);
  assert.equal(report.targetAdditions, 100);
  assert.equal(report.selectedCount, 100);
  assert.equal(report.catalogAfter, 561);
  assert.equal(report.shortfall, 0);
  assert.equal(report.selected.length, 100);
  assert.ok(report.selected.every((entry) => entry.decision === "NEW CANDIDATE"));
  assert.ok(report.selected.every((entry) => entry.sourceChannelId === report.source.channelId));
  assert.ok(report.selected.every((entry) => entry.embeddable === true));
  assert.ok(report.selected.every((entry) => entry.madeForKids === false));
  assert.ok(report.selected.every((entry) => entry.definition === "hd"));
  assert.equal(new Set(report.selected.map((entry) => entry.videoId)).size, 100);
});

test("CoversPH additions are unique against the 461-song baseline and remain validator-safe", () => {
  const additions = catalog.filter((song) => {
    const number = Number(song.id.replace("sample-", ""));
    return number >= 481 && number <= 580;
  });
  const normalized = normalizeCatalog(catalog, { logger: { warn() {} } });
  assert.equal(catalog.length, 761);
  assert.equal(additions.length, 100);
  assert.deepEqual(additions.map((song) => song.id), Array.from({ length: 100 }, (_, index) => `sample-${481 + index}`));
  assert.equal(normalized.rejectedRecords, 0);
  assert.equal(normalized.songs.length, 761);
  assert.ok(additions.every((song) => song.tags.includes("coversph")));
  assert.equal(additions.filter((song) => /^[A-Za-z0-9_-]{11}$/.test(song.youtubeVideoId || "")).length, 96);
  assert.equal(new Set(catalog.map((song) => song.id)).size, 761);
  assert.equal(new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean)).size, 694);
  assert.equal(new Set(catalog.map(songKey)).size, 761);
  assert.equal(catalog.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
  assert.equal(catalog.filter((song) => !song.youtubeVideoId).length, 67);
});

test("Atomic and previous CoversPH records remain present after the new append", () => {
  assert.equal(catalog.slice(361, 461).every((song) => song.tags.includes("atomic-karaoke")), true);
  assert.equal(catalog.filter((song) => song.tags.includes("coversph")).length >= 140, true);
  assert.equal(catalog.find((song) => song.id === "sample-191")?.youtubeVideoId, null);
  assert.equal(catalog.find((song) => song.id === "sample-230")?.youtubeVideoId, "bEm1r-tvL5E");
});
