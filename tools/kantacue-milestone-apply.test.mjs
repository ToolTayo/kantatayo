import assert from "node:assert/strict";
import test from "node:test";
import { chooseSelection, validateRuntimeEvidence } from "./kantacue-milestone-apply.mjs";

const catalog = [{ id: "sample-029", title: "Control", artist: "Known Artist", youtubeVideoId: "QBb9wO3Bj0k" }];
const candidate = (artist, videoId, views = "1000000", overrides = {}) => ({
  title: `${artist} Song`, artist, videoId, provider: "Atomic Karaoke", publicViews: views,
  metadata: { language: "English", genre: "Pop", era: "2000s", mood: ["feel-good"], difficulty: "medium", vocalRange: "medium", performanceType: "solo", tags: ["international"] },
  ...overrides
});

test("selection keeps artist concentration bounded before relaxing the cap", () => {
  const pool = [
    candidate("A", "aaaaaaaaaaa", "9000000"), candidate("A", "bbbbbbbbbbb", "8000000"), candidate("A", "ccccccccccc", "7000000"), candidate("A", "ddddddddddd", "6000000"),
    candidate("B", "eeeeeeeeeee", "5000000"), candidate("C", "fffffffffff", "4000000")
  ];
  const result = chooseSelection(pool, catalog, 6);
  assert.equal(result.selected.length, 6);
  assert.ok(result.artistCounts.get("a") <= 4);
});

test("selection keeps a high-volume provider from consuming the whole milestone", () => {
  const pool = [];
  for (let index = 0; index < 100; index += 1) pool.push(candidate(`Atomic Artist ${index}`, `${String(index).padStart(10, "a")}a`, `${1000000 - index}`));
  for (let index = 0; index < 30; index += 1) pool.push(candidate(`Covers Artist ${index}`, `${String(index).padStart(10, "b")}b`, `${900000 - index}`, { provider: "CoversPH" }));
  const result = chooseSelection(pool, catalog, 108);
  assert.equal(result.selected.length, 108);
  assert.equal(result.providerCounts.get("CoversPH"), 24);
  assert.equal(result.providerCounts.get("Atomic Karaoke"), 84);
});

test("runtime evidence requires the exact control PASS", () => {
  const report = { catalogHash: "hash", runtimeCandidates: [{ videoId: "aaaaaaaaaaa" }] };
  const runtime = { entries: [{ songId: "sample-029", videoId: "QBb9wO3Bj0k", iframeStatus: "PASS" }, { videoId: "aaaaaaaaaaa", iframeStatus: "PASS" }] };
  assert.throws(() => validateRuntimeEvidence(report, runtime, catalog), /Catalog changed/);
});
