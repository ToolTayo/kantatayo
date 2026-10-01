import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyCandidate,
  normalizeIdentityPart,
  selectRuntimeCandidates,
  songIdentityKey
} from "./karaokeytv-expansion-100.mjs";

const catalog = JSON.parse(await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8"));
const reportAvailable = existsSync(new URL("./karaokeytv-expansion-100-runtime-report.json", import.meta.url));
const runtimeAvailable = existsSync(new URL("./karaokeytv-expansion-100-runtime.json", import.meta.url));
const auditArtifactsAvailable = reportAvailable && runtimeAvailable;
const report = auditArtifactsAvailable ? JSON.parse(await readFile(new URL("./karaokeytv-expansion-100-runtime-report.json", import.meta.url), "utf8")) : null;
const runtime = auditArtifactsAvailable ? JSON.parse(await readFile(new URL("./karaokeytv-expansion-100-runtime.json", import.meta.url), "utf8")) : { entries: [] };
const runtimeByVideo = new Map((runtime.entries || []).map((entry) => [entry.videoId, entry]));

const localOnly = (name, callback) => test(name, { skip: auditArtifactsAvailable ? false : "local runtime audit artifacts are not present" }, callback);

localOnly("KaraokeyTV discovery is official, public-page based, and does not use API results", () => {
  assert.equal(report.source.handle, "@karaokeytv0618");
  assert.equal(report.source.channelId, "UCNbFgUCJj2Ls6LVzBbL8fqA");
  assert.match(report.source.listing, /Popular/i);
  assert.equal(report.source.method, "Playwright Chromium DOM extraction");
  assert.equal(report.candidatesDiscovered, 463);
});

localOnly("control gate and candidate runtime evidence are conservative", () => {
  assert.equal(runtimeByVideo.get("QBb9wO3Bj0k")?.iframeStatus, "PASS");
  const candidates = selectRuntimeCandidates(report.entries);
  assert.ok(candidates.length >= 100);
  assert.equal(candidates.some((entry) => runtimeByVideo.get(entry.videoId)?.iframeStatus === "PLAYING"), true);
  assert.equal(candidates.some((entry) => runtimeByVideo.get(entry.videoId)?.iframeStatus === "ERROR 150"), true);
  assert.equal(candidates.every((entry) => runtimeByVideo.has(entry.videoId)), true);
  const passOnly = candidates.filter((entry) => runtimeByVideo.get(entry.videoId)?.iframeStatus === "PASS");
  assert.ok(passOnly.length >= 100);
  assert.equal(new Set(passOnly.map((entry) => entry.videoId)).size, passOnly.length);
  assert.equal(new Set(passOnly.map((entry) => normalizeIdentityPart(entry.title))).size, passOnly.length);
});

localOnly("the persisted production selection contains only exact runtime PASS rows", () => {
  assert.equal(report.selectedForProduction?.length, 100);
  assert.equal(report.selectedForProduction.every((entry) => runtimeByVideo.get(entry.videoId)?.iframeStatus === "PASS"), true);
  assert.equal(report.selectedForProduction.every((entry) => entry.metadataStatus === "VALID"), true);
  assert.equal(new Set(report.selectedForProduction.map((entry) => entry.videoId)).size, 100);
  assert.equal(new Set(report.selectedForProduction.map((entry) => songIdentityKey(entry.title, entry.artist))).size, 100);
});

test("ambiguous metadata and title-only duplicates are rejected before runtime promotion", () => {
  const official = "UCNbFgUCJj2Ls6LVzBbL8fqA";
  const existing = [{ id: "sample-x", title: "Example Song", artist: "Original Artist", youtubeVideoId: "aaaaaaaaaaa" }];
  const duplicate = classifyCandidate({ videoId: "bbbbbbbbbbb", videoTitle: "Example Song - Different Singer Karaoke", channelId: official }, existing, official);
  assert.notEqual(duplicate.decision, "NEW_CANDIDATE");
  const malformed = classifyCandidate({ videoId: "ccccccccccc", videoTitle: "Song | Artist Karaoke", channelId: official }, existing, official);
  assert.notEqual(malformed.decision, "NEW_CANDIDATE");
});

test("current catalog stays internally unique after KaraokeyTV additions", () => {
  assert.equal(catalog.length, 859);
  assert.equal(catalog.filter((song) => song.youtubeVideoId).length, 792);
  assert.equal(catalog.filter((song) => song.youtubeVideoId === null).length, 67);
  assert.equal(new Set(catalog.map((song) => song.id)).size, catalog.length);
  assert.equal(new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean)).size, 792);
  assert.equal(new Set(catalog.map((song) => songIdentityKey(song.title, song.artist))).size, catalog.length);
  assert.equal(catalog.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
  assert.equal(catalog.filter((song) => song.tags.includes("karaokeytv")).length, 150);
});
