import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidateReport, buildRuntimeManifest, songIdentityKey } from "./kantacue-expansion-100.mjs";

const baseSong = (overrides = {}) => ({
  id: "sample-001", title: "Existing Song", artist: "Existing Artist", language: "English", genre: "Pop", era: "2020s",
  mood: ["feel-good"], difficulty: "medium", vocalRange: "medium", performanceType: "solo", tags: [],
  youtubeVideoId: "aaaaaaaaaaa", ...overrides
});

const candidate = (overrides = {}) => ({
  decision: "NEW CANDIDATE", title: "New Song", artist: "New Artist", videoId: "bbbbbbbbbbb",
  videoTitle: "New Song - New Artist (KARAOKE VERSION)", publicViews: "100000", sourceChannelId: "channel",
  embeddable: true, madeForKids: false, definition: "hd",
  metadata: { language: "English", genre: "Pop", era: "2020s", mood: ["feel-good"], difficulty: "medium",
    vocalRange: "medium", performanceType: "solo", tags: ["international"] },
  ...overrides
});

test("candidate preparation deduplicates catalog identities and rejects unsafe versions", () => {
  const source = { provider: "CoversPH", file: "persisted.json", report: { all: [
    candidate(),
    candidate({ title: "Existing Song", artist: "Existing Artist", videoId: "ccccccccccc" }),
    candidate({ title: "Blocked", artist: "Artist", videoId: "ddddddddddd", videoTitle: "Blocked - Artist (LIVE KARAOKE VERSION)" })
  ] } };
  const report = buildCandidateReport([baseSong()], [source], { poolSize: 250 });
  assert.equal(report.runtimeCandidates.length, 1);
  assert.equal(report.runtimeCandidates[0].videoId, "bbbbbbbbbbb");
  assert.ok(report.entries.some((entry) => entry.decision === "EXISTING_PLAYABLE_SONG"));
  assert.ok(report.entries.some((entry) => entry.decision === "REJECTED_PREFILTER"));
});

test("identity normalization treats punctuation and karaoke suffixes as duplicates", () => {
  assert.equal(songIdentityKey("My Song (Karaoke)", "A & B"), songIdentityKey("my-song", "A and B"));
});

test("runtime manifest includes protected sample-029 control without changing catalog data", () => {
  const control = baseSong({ id: "sample-029", title: "Sa Aking Puso", artist: "Kaye Cal", youtubeVideoId: "QBb9wO3Bj0k" });
  const source = { provider: "CoversPH", file: "persisted.json", report: { all: [candidate()] } };
  const report = buildCandidateReport([control], [source], { poolSize: 250 });
  const manifest = buildRuntimeManifest(report, [control]);
  assert.equal(manifest.entries[0].videoId, "QBb9wO3Bj0k");
  assert.equal(manifest.entries.length, 2);
  assert.equal(control.youtubeVideoId, "QBb9wO3Bj0k");
});

