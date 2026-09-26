import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCatalog } from "../src/catalog.js";

const catalog = JSON.parse(fs.readFileSync("data/songs.sample.json", "utf8"));
const report = JSON.parse(fs.readFileSync("tools/atomic-karaoke-expansion-report.json", "utf8"));
const demand = JSON.parse(fs.readFileSync("data/song-demand.json", "utf8"));

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

const previous = catalog.slice(0, 261);
const additions = catalog.filter((song) => {
  const number = Number(song.id.replace("sample-", ""));
  return number >= 281 && number <= 330;
});

test("Atomic report is official Popular ordering with exactly 50 additions", () => {
  assert.equal(report.source.channelHandle, "@AtomicKaraoke");
  assert.equal(report.source.listing, "Public channel Videos > Popular");
  assert.equal(report.catalogBefore, 261);
  assert.equal(report.catalogAfter, 311);
  assert.equal(report.entries.length, 70);
  assert.deepEqual(report.entries.map((entry) => entry.rank), Array.from({ length: 70 }, (_, index) => index + 1));
  assert.equal(report.entries.filter((entry) => entry.decision === "ADDED").length, 50);
  assert.equal(new Set(report.entries.map((entry) => entry.videoId)).size, report.entries.length);
});

test("Atomic additions match audited IDs and do not duplicate the protected 261", () => {
  const added = report.entries.filter((entry) => entry.decision === "ADDED");
  const previousKeys = new Set(previous.map(songKey));
  assert.deepEqual(additions.map((song) => song.id), Array.from({ length: 50 }, (_, index) => `sample-${String(index + 281).padStart(3, "0")}`));
  assert.deepEqual(
    additions.map((song) => song.youtubeVideoId).sort(),
    added.map((entry) => entry.videoId).sort()
  );
  assert.ok(additions.every((song) => !previousKeys.has(songKey(song))));
  assert.equal(new Set(additions.map(songKey)).size, additions.length);
  assert.equal(new Set(additions.map((song) => song.youtubeVideoId)).size, additions.length);
});

test("the original 261 production records remain semantically unchanged", () => {
  const protectedHash = crypto.createHash("sha256").update(JSON.stringify(previous)).digest("hex");
  assert.equal(protectedHash, "2588afb51c2499c37cacaf100a66a4cc61f7ad390ef4e6d742ce173504907e54");
  assert.equal(catalog.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
});

test("expanded production catalog is valid, playable, unique, and has no dangling references", () => {
  const normalized = normalizeCatalog(catalog, { logger: { warn() {} } });
  const catalogIds = new Set(catalog.map((song) => song.id));
  assert.equal(catalog.length, 361);
  assert.equal(normalized.songs.length, 361);
  assert.equal(normalized.rejectedRecords, 0);
  assert.deepEqual(normalized.warnings, []);
  assert.equal(catalog.filter((song) => /^[A-Za-z0-9_-]{11}$/.test(song.youtubeVideoId || "")).length, 361);
  assert.equal(catalog.filter((song) => song.youtubeVideoId === null).length, 0);
  assert.equal(new Set(catalog.map((song) => song.id)).size, 361);
  assert.equal(new Set(catalog.map((song) => song.youtubeVideoId)).size, 361);
  assert.equal(new Set(catalog.map(songKey)).size, 361);
  assert.ok(demand.signals.every((signal) => catalogIds.has(signal.songId)));
  assert.equal(fs.existsSync("data/songs.exclusive.json"), false);
});
