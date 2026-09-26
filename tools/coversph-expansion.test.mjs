import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyCandidates, loadExpansionAudit, normalizeText, songKey } from "./coversph-expansion.mjs";

const report = JSON.parse(await readFile("tools/coversph-top-50-report.json", "utf8"));
const catalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
const prePromotionCatalog = catalog.filter((song) => Number(song.id.replace("sample-", "")) <= 190);
const coversPhSongs = catalog.filter((song) => {
  const number = Number(song.id.replace("sample-", ""));
  return number >= 191 && number <= 230;
});
const promotedRanks = new Set([1, 2, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 29, 30, 31, 32, 33, 35, 37, 39, 40, 41, 42, 43, 45, 46, 47, 48, 49, 50]);

test("persisted report is the official CoversPH Popular source and contains 50 ordered records", () => {
  assert.equal(report.source.channel, "CoversPH");
  assert.equal(report.source.channelHandle, "@CoversPH");
  assert.equal(report.source.ordering, "Videos > Popular");
  assert.equal(report.entries.length, 50);
  assert.deepEqual(report.entries.map((entry) => entry.rank), Array.from({ length: 50 }, (_, index) => index + 1));
  assert.equal(new Set(report.entries.map((entry) => entry.videoId)).size, 50);
  assert.ok(report.entries.every((entry) => /^[A-Za-z0-9_-]{11}$/.test(entry.videoId)));
  assert.ok(report.entries.every((entry) => /KARAOKE/i.test(entry.sourceTitle || `${entry.title} ${entry.artist} KARAOKE VERSION`)));
});

test("CoversPH decisions preserve duplicate protection and do not promote untested candidates", () => {
  const entries = classifyCandidates(report.entries, prePromotionCatalog);
  const skipped = entries.filter((entry) => entry.decision.startsWith("SKIPPED"));
  const pending = entries.filter((entry) => entry.decision === "PENDING MANUAL EMBED TEST");
  assert.equal(skipped.length, 10);
  assert.equal(pending.length, 40);
  assert.ok(skipped.every((entry) => entry.matchedCatalogId));
  assert.ok(pending.every((entry) => !prePromotionCatalog.some((song) => song.youtubeVideoId === entry.videoId)));
});

test("CoversPH promotion adds exactly the 40 approved report candidates", () => {
  const promoted = report.entries.filter((entry) => promotedRanks.has(entry.rank));
  assert.equal(promoted.length, 40);
  assert.deepEqual(promoted.map((entry) => entry.videoId), coversPhSongs.map((song) => song.youtubeVideoId));
  assert.deepEqual(coversPhSongs.map((song) => song.id), Array.from({ length: 40 }, (_, index) => `sample-${String(index + 191).padStart(3, "0")}`));
  for (const entry of promoted) {
    const song = catalog.find((candidate) => candidate.youtubeVideoId === entry.videoId);
    assert.deepEqual([song?.title, song?.artist], [entry.title, entry.artist], entry.videoId);
  }
  assert.equal(catalog.filter((song) => promotedRanks.has(report.entries.find((entry) => entry.videoId === song.youtubeVideoId)?.rank)).length, 40);
});

test("the nine catalog duplicates and Torete variant remain skipped", () => {
  const skippedRanks = new Set([3, 4, 7, 24, 27, 28, 34, 36, 38, 44]);
  const promotedIds = new Set(coversPhSongs.map((song) => song.youtubeVideoId));
  assert.equal(report.entries.filter((entry) => skippedRanks.has(entry.rank) && !promotedIds.has(entry.videoId)).length, 10);
  assert.equal(catalog.filter((song) => song.title === "TORETE" && song.artist === "Moira Dela Torre").length, 0);
});

test("primary catalog remains the playable production baseline", () => {
  assert.equal(catalog.length, 361);
  assert.equal(catalog.filter((song) => song.youtubeVideoId).length, 361);
  assert.equal(catalog.filter((song) => !song.youtubeVideoId).length, 0);
  assert.equal(catalog.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
  assert.equal(new Set(catalog.map((song) => song.id)).size, catalog.length);
  assert.equal(new Set(catalog.map((song) => song.youtubeVideoId)).size, catalog.length);
  assert.equal(new Set(catalog.map((song) => songKey(song.title, song.artist))).size, catalog.length);
});

test("normalization is deterministic and accent-safe for duplicate comparison", () => {
  assert.equal(normalizeText("Janine Teñoso"), "janine tenoso");
  assert.equal(songKey("Kahit Kailan", "South Border"), songKey("KAHIT KAILAN", "South Border"));
});

test("audit loader preserves the persisted report and current catalog without network access", async () => {
  const audit = await loadExpansionAudit();
  assert.equal(audit.entries.length, 50);
  assert.equal(audit.catalog.length, 361);
});
