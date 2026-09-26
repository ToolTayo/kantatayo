import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { normalizeCatalog } from "../src/catalog.js";

const catalog = JSON.parse(fs.readFileSync("data/songs.sample.json", "utf8"));
const report = JSON.parse(fs.readFileSync("tools/pro-music-cover-expansion-report.json", "utf8"));

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(feat\.?|ft\.?|featuring)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function songKey(song) {
  return `${normalize(song.title)}\u0000${normalize(song.artist)}`;
}

const additions = catalog.filter((song) => {
  const number = Number(song.id.replace("sample-", ""));
  return number >= 331 && number <= 380;
});
const previous = catalog.slice(0, 311);

test("PRO music COVER report is ordered public Popular evidence with exactly 50 additions", () => {
  assert.equal(report.source.channel, "PRO music COVER");
  assert.equal(report.source.handle, "@PROmusicCOVER");
  assert.equal(report.source.surface, "Videos > Popular");
  assert.equal(report.catalogBefore, 311);
  assert.equal(report.catalogAfter, 361);
  assert.equal(report.addedCount, 50);
  assert.equal(report.entries.length, 68);
  assert.deepEqual(report.entries.map((entry) => entry.rank), Array.from({ length: 68 }, (_, index) => index + 1));
  assert.equal(report.entries.filter((entry) => entry.decision === "ADDED").length, 50);
  assert.equal(new Set(report.entries.map((entry) => entry.videoId)).size, report.entries.length);
});

test("PRO additions match the report, append after sample-330, and avoid prior songs", () => {
  const previousKeys = new Set(previous.map(songKey));
  const addedReport = report.entries.filter((entry) => entry.decision === "ADDED");
  assert.deepEqual(additions.map((song) => song.id), Array.from({ length: 50 }, (_, index) => `sample-${String(index + 331).padStart(3, "0")}`));
  assert.deepEqual(additions.map((song) => song.youtubeVideoId).sort(), addedReport.map((entry) => entry.videoId).sort());
  assert.ok(additions.every((song) => song.tags.includes("pro-music-cover")));
  assert.ok(additions.every((song) => !previousKeys.has(songKey(song))));
  assert.equal(new Set(additions.map(songKey)).size, additions.length);
  assert.equal(new Set(additions.map((song) => song.youtubeVideoId)).size, additions.length);
});

test("the protected 311-song catalog remains semantically unchanged", () => {
  const protectedHash = crypto.createHash("sha256").update(JSON.stringify(previous)).digest("hex");
  assert.equal(protectedHash, "36c45cb77ff172ccdc6331ed3ae3f621d056e46f211d0f1f023f38b77508b1c4");
  assert.equal(catalog.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
});

test("expanded PRO catalog is valid, playable, unique, and keeps Exclusive removed", () => {
  const normalized = normalizeCatalog(catalog, { logger: { warn() {} } });
  assert.equal(catalog.length, 361);
  assert.equal(normalized.songs.length, 361);
  assert.equal(normalized.rejectedRecords, 0);
  assert.deepEqual(normalized.warnings, []);
  assert.equal(catalog.filter((song) => /^[A-Za-z0-9_-]{11}$/.test(song.youtubeVideoId || "")).length, 361);
  assert.equal(catalog.filter((song) => song.youtubeVideoId === null).length, 0);
  assert.equal(new Set(catalog.map((song) => song.id)).size, 361);
  assert.equal(new Set(catalog.map((song) => song.youtubeVideoId)).size, 361);
  assert.equal(new Set(catalog.map(songKey)).size, 361);
  assert.equal(fs.existsSync("data/songs.exclusive.json"), false);
});
