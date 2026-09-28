import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildPlayabilityAudit, hashCatalog } from "../tools/build-playability-audit.mjs";
import { PLAYABILITY_STATUSES, resultStatusForError, summarizeAuditEntries } from "../src/playability-audit.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("playability manifest covers the current catalog without claiming iframe playback", async () => {
  const catalogBefore = await read("data/songs.sample.json");
  const report = await buildPlayabilityAudit({ outputPath: null, generatedAt: "2026-09-27T00:00:00.000Z" });
  assert.equal(report.catalogCount, 661);
  assert.equal(report.entries.length, 661);
  assert.equal(report.auditStatus, "PENDING_BROWSER_AUDIT");
  assert.equal(report.counts.confirmedPlayable, 0);
  assert.equal(report.counts.unavailable, 67);
  assert.equal(report.entries.filter((entry) => entry.iframeStatus === "UNAVAILABLE").length, 67);
  assert.equal(report.entries.filter((entry) => entry.iframeStatus === "UNTESTED").length, 594);
  assert.equal(new Set(report.entries.map((entry) => entry.songId)).size, 661);
  assert.equal(report.entries.find((entry) => entry.title === "Ere")?.videoId, null);
  assert.equal(await read("data/songs.sample.json"), catalogBefore);
});

test("the browser harness exposes conservative player classifications", async () => {
  const [html, script, pure, runner, youtube] = await Promise.all([read("youtube-playability-audit.html"), read("src/full-playability-audit.js"), read("src/playability-audit.js"), read("tools/run-playability-audit.mjs"), read("src/youtube.js")]);
  assert.match(html, /data-youtube-mount/);
  assert.match(html, /Test next untested/);
  assert.match(script, /createYouTubePlayerController/);
  assert.match(script, /15_000/);
  assert.match(script, /getCurrentTime/);
  assert.match(youtube, /getCurrentTime/);
  assert.match(script, /localStorage/);
  assert.match(runner, /CONTROL_IDS/);
  assert.match(runner, /CONTROL_GATE_FAILED/);
  assert.match(runner, /chromium\.launch/);
  assert.match(runner, /youtube-playability-audit\.html/);
  assert.match(html, /Export report/);
  assert.doesNotMatch(`${html}\n${script}`, /YOUTUBE_API_KEY|youtube-data-api/i);
  for (const status of PLAYABILITY_STATUSES) assert.match(pure, new RegExp(status.replace(/[\s]/g, "\\s+")));
});

test("known YouTube player errors remain distinct", () => {
  assert.equal(resultStatusForError(100), "ERROR 100");
  assert.equal(resultStatusForError(101), "ERROR 101");
  assert.equal(resultStatusForError(150), "ERROR 150");
  assert.equal(resultStatusForError(153), "ERROR 153");
  assert.equal(resultStatusForError(999), "INCONCLUSIVE");
});

test("summary counts do not mistake metadata for actual playback", () => {
  const summary = summarizeAuditEntries([
    { metadataStatus: "VALID", apiEmbeddable: true, iframeStatus: "UNTESTED" },
    { metadataStatus: "VALID", apiEmbeddable: true, iframeStatus: "PASS" },
    { metadataStatus: "VALID", apiEmbeddable: true, iframeStatus: "ERROR 150" },
    { metadataStatus: "VALID", apiEmbeddable: false, iframeStatus: "AUTOPLAY POLICY ONLY" }
  ]);
  assert.equal(summary.metadataValid, 4);
  assert.equal(summary.apiEmbeddable, 3);
  assert.equal(summary.confirmedPlayable, 1);
  assert.equal(summary.confirmedEmbeddingFailures, 1);
  assert.equal(summary.autoplayPolicyOnly, 1);
  assert.equal(summary.ambiguous, 1);
});

test("unavailable catalog records remain auditable without being treated as iframe playback", async () => {
  const report = await buildPlayabilityAudit({ outputPath: null });
  const unavailable = report.entries.filter((entry) => entry.iframeStatus === "UNAVAILABLE");
  assert.equal(unavailable.length, 67);
  assert.equal(unavailable.every((entry) => entry.metadataStatus === "VALID_NO_VIDEO" && entry.videoId === null), true);
  assert.equal(report.counts.confirmedPlayable, 0);
});

test("catalog hash changes when an assignment changes, enabling stale-result protection", () => {
  const first = [{ id: "sample-001", youtubeVideoId: "aaaaaaaaaaa" }];
  const second = [{ id: "sample-001", youtubeVideoId: "bbbbbbbbbbb" }];
  assert.notEqual(hashCatalog(first), hashCatalog(second));
});
