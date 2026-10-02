import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeManifest, classifyRawCandidate, songIdentityKey } from "./kantacue-milestone.mjs";

const catalog = [{
  id: "sample-029", title: "Sa Aking Puso", artist: "Kaye Cal", language: "Filipino", genre: "Ballad", era: "2000s",
  mood: ["love"], difficulty: "medium", vocalRange: "medium", performanceType: "solo", tags: ["opm"], youtubeVideoId: "QBb9wO3Bj0k"
}];

test("milestone identity normalization protects title/artist duplicates", () => {
  assert.equal(songIdentityKey("My Song (Karaoke)", "A & B"), songIdentityKey("my-song", "A and B"));
});

test("milestone preflight keeps technical and content gates strict", () => {
  const profiles = new Map();
  const valid = classifyRawCandidate({ title: "New Song", artist: "New Artist", videoId: "bbbbbbbbbbb", videoTitle: "New Song - New Artist (HD Karaoke)", embeddable: true, madeForKids: false, definition: "hd" }, catalog, profiles, "Atomic Karaoke", { requireTechnicalEvidence: true });
  assert.deepEqual(valid.reasons, []);
  const blocked = classifyRawCandidate({ title: "New Song", artist: "New Artist", videoId: "ccccccccccc", videoTitle: "New Song - New Artist (LIVE Karaoke)", embeddable: true, madeForKids: false, definition: "hd" }, catalog, profiles, "Atomic Karaoke", { requireTechnicalEvidence: true });
  assert.ok(blocked.reasons.some((reason) => /unsuitable/i.test(reason)));
  const technical = classifyRawCandidate({ title: "Another Song", artist: "Another Artist", videoId: "ddddddddddd", videoTitle: "Another Song - Another Artist (HD Karaoke)", embeddable: false, madeForKids: false, definition: "hd" }, catalog, profiles, "Atomic Karaoke", { requireTechnicalEvidence: true });
  assert.ok(technical.reasons.some((reason) => /technical/i.test(reason)));
});

test("runtime manifest always contains the protected sample-029 control", () => {
  const report = { catalogHash: "hash", runtimeCandidates: [{ title: "New Song", artist: "New Artist", videoId: "bbbbbbbbbbb", provider: "Atomic Karaoke", channel: "Atomic Karaoke", embeddable: true, madeForKids: false, definition: "hd", publicViews: "100000", runtimeStatus: "UNTESTED", runtimeEvidence: null }] };
  const manifest = buildRuntimeManifest(report, catalog);
  assert.equal(manifest.entries[0].songId, "sample-029");
  assert.equal(manifest.entries[0].videoId, "QBb9wO3Bj0k");
  assert.equal(manifest.entries.length, 2);
});
