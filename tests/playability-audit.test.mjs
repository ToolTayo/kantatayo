import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildPlayabilityAudit, hashCatalog } from "../tools/build-playability-audit.mjs";
import { applyValidatedControlGate, classifyPlaybackStartFailure, classifyPlayerErrorIdentity, evaluateSustainedPlayback, isTerminalStatus, PLAYABILITY_STATUSES, resultStatusForError, summarizeAuditEntries, SUSTAINED_PLAYBACK_MS } from "../src/playability-audit.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("playability manifest covers the current catalog without claiming iframe playback", async () => {
  const catalogBefore = await read("data/songs.sample.json");
  const report = await buildPlayabilityAudit({ outputPath: null, generatedAt: "2026-09-27T00:00:00.000Z" });
  assert.equal(report.catalogCount, 1067);
  assert.equal(report.entries.length, 1067);
  assert.equal(report.auditStatus, "PENDING_BROWSER_AUDIT");
  assert.equal(report.counts.confirmedPlayable, 0);
  assert.equal(report.counts.unavailable, 67);
  assert.equal(report.entries.filter((entry) => entry.iframeStatus === "UNAVAILABLE").length, 67);
  assert.equal(report.entries.filter((entry) => entry.iframeStatus === "UNTESTED").length, 1000);
  assert.equal(new Set(report.entries.map((entry) => entry.songId)).size, 1067);
  assert.equal(report.entries.find((entry) => entry.title === "Ere")?.videoId, null);
  assert.equal(await read("data/songs.sample.json"), catalogBefore);
});

test("the browser harness exposes conservative player classifications", async () => {
  const [html, script, pure, runner, youtube] = await Promise.all([read("youtube-playability-audit.html"), read("src/full-playability-audit.js"), read("src/playability-audit.js"), read("tools/run-playability-audit.mjs"), read("src/youtube.js")]);
  assert.match(html, /data-youtube-mount/);
  assert.match(html, /assets\/icon-192\.svg/);
  assert.match(html, /Test next untested/);
  assert.match(script, /createYouTubePlayerController/);
  assert.match(script, /SUSTAINED_PLAYBACK_MS/);
  assert.match(script, /playback-sample/);
  assert.match(script, /iframeVideoId/);
  assert.match(runner, /CONTROL_RUNS_REQUIRED = 3/);
  assert.match(runner, /independentBrowserContext: true/);
  assert.match(runner, /chromium\.launch\(launchOptions\)/);
  assert.match(runner, /--control-only/);
  assert.match(runner, /validateControlEvidence/);
  assert.match(script, /getCurrentTime/);
  assert.match(youtube, /getCurrentTime/);
  assert.match(script, /localStorage/);
  assert.match(runner, /CONTROL_ID = "sample-029"/);
  assert.match(runner, /CONTROL_GATE_FAILED/);
  assert.match(runner, /applyValidatedControlGate/);
  assert.match(runner, /control-\$\{runIndex \+ 1\}/);
  assert.match(runner, /Date\.parse\(result\?\.testedAt/);
  assert.match(script, /isTerminalStatus\(currentStatus\(\)\)/);
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

test("READY without PLAYING is not mislabeled as an autoplay-policy failure", () => {
  assert.deepEqual(classifyPlaybackStartFailure(3), {
    failureClassification: "PLAYER_BUFFERING_BEFORE_PLAYING",
    note: "The official player remained in BUFFERING without reporting PLAYING during the startup grace window."
  });
  assert.equal(classifyPlaybackStartFailure(2).failureClassification, "PLAYER_PAUSED_BEFORE_PLAYING");
  assert.equal(classifyPlaybackStartFailure(-1).failureClassification, "PLAYBACK_NOT_STARTED");
});

test("a player error is not attributed to a candidate when the loaded video identity is stale", () => {
  const mismatch = classifyPlayerErrorIdentity(150, "candidate123", "previous123");
  assert.equal(mismatch.status, "INCONCLUSIVE");
  assert.equal(mismatch.errorCode, 150);
  assert.equal(mismatch.failureClassification, "PLAYER_VIDEO_ID_MISMATCH");
  assert.equal(classifyPlayerErrorIdentity(150, "candidate123", "candidate123").status, "ERROR 150");
});

test("terminal runtime results are protected from late player callbacks", () => {
  assert.equal(isTerminalStatus("PASS"), true);
  assert.equal(isTerminalStatus("ERROR 150"), true);
  assert.equal(isTerminalStatus("PLAYING WITHOUT PROGRESSION"), true);
  assert.equal(isTerminalStatus("READY-ONLY"), true);
  assert.equal(isTerminalStatus("PLAYING"), false);
});

test("sustained playback requires visible time progression and matching player identity across a 15-second window", () => {
  const samples = Array.from({ length: 16 }, (_, index) => ({ elapsedMs: index * 1000, currentTime: 20 + index, visibilityState: "visible", playerVideoId: "candidate123", loadedVideoId: "candidate123", playerReady: true, iframeConnected: true }));
  const result = evaluateSustainedPlayback({ elapsedMs: SUSTAINED_PLAYBACK_MS, samples, visibilityTrace: ["visible"], expectedVideoId: "candidate123" });
  assert.equal(result.status, "PASS");
  assert.match(result.reason, /15 seconds|15\.0 seconds|seconds of advancement/);
});

test("PLAYING without currentTime progression is distinct from a player error", () => {
  const samples = Array.from({ length: 16 }, (_, index) => ({ elapsedMs: index * 1000, currentTime: 0, visibilityState: "visible" }));
  const result = evaluateSustainedPlayback({ elapsedMs: SUSTAINED_PLAYBACK_MS, samples, visibilityTrace: ["visible"] });
  assert.equal(result.status, "PLAYING WITHOUT PROGRESSION");
  assert.match(result.reason, /0\.0 seconds/);
});

test("time advancing in a stale previous iframe can never qualify the requested candidate", () => {
  const samples = Array.from({ length: 16 }, (_, index) => ({ elapsedMs: index * 1000, currentTime: 20 + index, visibilityState: "visible", playerVideoId: "previous123", loadedVideoId: "previous123", playerReady: true, iframeConnected: true }));
  const result = evaluateSustainedPlayback({ elapsedMs: SUSTAINED_PLAYBACK_MS, samples, visibilityTrace: ["visible"], expectedVideoId: "candidate123" });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.match(result.reason, /requested video ID candidate123/);
});

test("a single large time jump cannot masquerade as sustained progression", () => {
  const samples = Array.from({ length: 16 }, (_, index) => ({ elapsedMs: index * 1000, currentTime: index < 8 ? 10 : 40, visibilityState: "visible" }));
  const result = evaluateSustainedPlayback({ elapsedMs: SUSTAINED_PLAYBACK_MS, samples, visibilityTrace: ["visible"] });
  assert.equal(result.status, "PLAYING WITHOUT PROGRESSION");
  assert.equal(result.reason.includes("advancing intervals"), true);
  assert.equal(result.status, "PLAYING WITHOUT PROGRESSION");
});

test("early playback followed by a freeze cannot pass the sustained-window check", () => {
  const samples = Array.from({ length: 16 }, (_, index) => ({ elapsedMs: index * 1000, currentTime: Math.min(index, 8), visibilityState: "visible" }));
  const result = evaluateSustainedPlayback({ elapsedMs: SUSTAINED_PLAYBACK_MS, samples, visibilityTrace: ["visible"] });
  assert.equal(result.status, "PLAYING WITHOUT PROGRESSION");
  assert.match(result.reason, /final five seconds/);
});

test("missing time samples, short windows, and backgrounded pages remain inconclusive", () => {
  const samples = Array.from({ length: 16 }, (_, index) => ({ elapsedMs: index * 1000, currentTime: index, visibilityState: "visible" }));
  assert.equal(evaluateSustainedPlayback({ elapsedMs: 10_000, samples, visibilityTrace: ["visible"] }).status, "INCONCLUSIVE");
  assert.equal(evaluateSustainedPlayback({ elapsedMs: SUSTAINED_PLAYBACK_MS, samples: [], visibilityTrace: ["visible"] }).status, "INCONCLUSIVE");
  assert.equal(evaluateSustainedPlayback({ elapsedMs: SUSTAINED_PLAYBACK_MS, samples, visibilityTrace: ["visible", "hidden", "visible"] }).status, "INCONCLUSIVE");
});

test("summary counts do not mistake metadata for actual playback", () => {
  const summary = summarizeAuditEntries([
    { metadataStatus: "VALID", apiEmbeddable: true, iframeStatus: "UNTESTED" },
    { metadataStatus: "VALID", apiEmbeddable: true, iframeStatus: "PASS" },
    { metadataStatus: "VALID", apiEmbeddable: true, iframeStatus: "ERROR 150" },
    { metadataStatus: "VALID", apiEmbeddable: false, iframeStatus: "READY-ONLY" },
    { metadataStatus: "VALID", apiEmbeddable: true, iframeStatus: "PLAYING WITHOUT PROGRESSION" }
  ]);
  assert.equal(summary.metadataValid, 5);
  assert.equal(summary.apiEmbeddable, 4);
  assert.equal(summary.confirmedPlayable, 1);
  assert.equal(summary.confirmedEmbeddingFailures, 1);
  assert.equal(summary.readyOnly, 1);
  assert.equal(summary.autoplayPolicyOnly, 0);
  assert.equal(summary.playingWithoutProgression, 1);
  assert.equal(summary.ambiguous, 2);
});

test("the runtime summary counts a control only after all independent runs pass", () => {
  const entries = [
    { songId: "sample-029", videoId: "QBb9wO3Bj0k", iframeStatus: "UNTESTED" },
    { songId: "candidate", videoId: "candidate123", iframeStatus: "ERROR 150" }
  ];
  const controlGate = {
    status: "PASS",
    requiredIndependentRuns: 3,
    runs: Array.from({ length: 3 }, (_, index) => ({
      songId: "sample-029",
      videoId: "QBb9wO3Bj0k",
      testedAt: `2026-10-07T00:00:0${index}Z`,
      validation: { status: "PASS" }
    }))
  };
  const merged = applyValidatedControlGate(entries, controlGate, "sample-029", "QBb9wO3Bj0k");
  assert.equal(merged[0].iframeStatus, "PASS");
  assert.equal(merged[0].failureClassification, "THREE_RUN_CONTROL_GATE");
  assert.match(merged[0].note, /3 independent/);
  assert.equal(merged[1], entries[1]);
  assert.deepEqual(summarizeAuditEntries(merged), {
    total: 2, metadataValid: 0, apiEmbeddable: 0, apiNotEmbeddable: 0,
    playerReady: 1, confirmedPlayable: 1, confirmedEmbeddingFailures: 1,
    unavailable: 0, timeouts: 0, playingWithoutProgression: 0,
    environmentFailures: 0, controlFailures: 0, ambiguous: 0, readyOnly: 0,
    autoplayPolicyOnly: 0, errors: 1
  });

  const failed = applyValidatedControlGate(entries, { ...controlGate, runs: controlGate.runs.slice(0, 2) }, "sample-029", "QBb9wO3Bj0k");
  assert.equal(failed[0].iframeStatus, "CONTROL FAILURE");
  const wrongVideo = applyValidatedControlGate(entries, {
    ...controlGate,
    runs: controlGate.runs.map((run, index) => index === 0 ? { ...run, videoId: "wrongVideo01" } : run)
  }, "sample-029", "QBb9wO3Bj0k");
  assert.equal(wrongVideo[0].iframeStatus, "CONTROL FAILURE");
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
