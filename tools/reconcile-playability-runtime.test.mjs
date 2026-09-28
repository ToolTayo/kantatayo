import test from "node:test";
import assert from "node:assert/strict";
import { reconcileRuntimeReport } from "./reconcile-playability-runtime.mjs";

const baseEntry = (songId, videoId, iframeStatus) => ({ songId, title: songId, artist: "Artist", videoId, iframeStatus, metadataStatus: "VALID", apiEmbeddable: true });

test("reconciliation converts only confirmed Error 150 records to unavailable", () => {
  const catalog = [
    { id: "sample-001", title: "Playable", artist: "Artist", youtubeVideoId: "aaaaaaaaaaa" },
    { id: "sample-002", title: "Unavailable", artist: "Artist", youtubeVideoId: null }
  ];
  const report = reconcileRuntimeReport(
    catalog,
    { entries: [baseEntry("sample-001", "aaaaaaaaaaa", "PASS"), baseEntry("sample-002", "bbbbbbbbbbb", "ERROR 150")] },
    { unavailable: [{ songId: "sample-002", oldVideoId: "bbbbbbbbbbb", reason: "confirmed Error 150" }] },
    { generatedAt: "2026-09-28T00:00:00.000Z" }
  );
  assert.equal(report.counts.confirmedPlayable, 1);
  assert.equal(report.counts.unavailable, 1);
  assert.equal(report.entries.find((entry) => entry.songId === "sample-002").iframeStatus, "UNAVAILABLE");
  assert.equal(report.entries.find((entry) => entry.songId === "sample-002").videoId, null);
});

test("reconciliation refuses to rewrite a retained non-PASS assignment", () => {
  assert.throws(() => reconcileRuntimeReport(
    [{ id: "sample-001", title: "Song", artist: "Artist", youtubeVideoId: "aaaaaaaaaaa" }],
    { entries: [baseEntry("sample-001", "aaaaaaaaaaa", "INCONCLUSIVE")] },
    { unavailable: [] }
  ), /retained assignment does not match a prior runtime PASS/);
});
