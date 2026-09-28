import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("./repair-youtube-embeds.mjs", import.meta.url), "utf8");
const auditRunner = await readFile(new URL("./run-playability-audit.mjs", import.meta.url), "utf8");
const auditPage = await readFile(new URL("../src/full-playability-audit.js", import.meta.url), "utf8");

test("repair workflow is resumable and separates prepare/test/apply", () => {
  for (const command of ["prepare", "test", "apply", "repair", "report"]) assert.match(workflow, new RegExp(`options\\.command === \\"${command}\\"`));
  assert.match(workflow, /youtube-embed-repair\.json/);
  assert.match(workflow, /selectedReplacement/);
  assert.match(workflow, /candidate\.runtimeStatus === "PASS"/);
  assert.match(workflow, /if \(entry\.selectedReplacement\) continue/);
  assert.match(workflow, /previouslyApplied/);
  assert.match(workflow, /recordedAppliedSongs/);
  assert.match(workflow, /await atomicWriteJson\(CATALOG_PATH, catalog\)/);
});

test("repair workflow enforces API and duplicate gates before runtime testing", () => {
  assert.match(workflow, /candidate\.apiVerified === true/);
  assert.match(workflow, /candidate\.embeddable === true/);
  assert.match(workflow, /candidate\.madeForKids === false/);
  assert.match(workflow, /candidate\.technicalGatePass/);
  assert.match(workflow, /!usedForRanking\.has\(candidate\.videoId\)/);
  assert.match(workflow, /requestVideoBatch\(batch/);
});

test("repair runner supports isolated page manifests and checkpoints", () => {
  assert.match(auditRunner, /--page-manifest PATH/);
  assert.match(auditRunner, /--checkpoint PATH/);
  assert.match(auditRunner, /args\.pageManifest[\s\S]*manifest=/);
  assert.match(auditRunner, /checkpointPath/);
});

test("audit page accepts only a bounded same-origin development manifest override", () => {
  assert.match(auditPage, /DEFAULT_REPORT_URL/);
  assert.ok(auditPage.includes("^tools\\/[A-Za-z0-9._/-]+\\.json$"));
  assert.match(auditPage, /fetch\(getReportUrl\(\)/);
});

test("repair workflow contains no catalog expansion or API-key persistence", () => {
  assert.doesNotMatch(workflow, /YOUTUBE_API_KEY\s*[:=]\s*["'`]/);
  assert.match(workflow, /No command downloads media/);
  assert.match(workflow, /catalog\.length !== 561/);
  assert.match(workflow, /expectedBroken/);
  assert.match(workflow, /options\.secondPass/);
});

test("second pass preserves the first-pass report and uses a deeper identity query", () => {
  assert.match(workflow, /--second-pass/);
  assert.match(workflow, /SECOND_PASS_MAX_RESULTS/);
  assert.match(workflow, /buildSecondPassQuery/);
  assert.match(workflow, /youtube-data-api-second-pass/);
  assert.match(workflow, /collectAttemptedIds/);
  assert.match(workflow, /attemptedIds\.has\(candidate\.videoId\)/);
  assert.match(workflow, /67 current Error 150 assignments/);
  assert.match(workflow, /retry-rate-limited/);
  assert.match(workflow, /HTTP 429/);
  assert.match(workflow, /--mark-unavailable/);
  assert.match(workflow, /confirmed Error 150 with no runtime-verified replacement/);
  assert.match(workflow, /song\.youtubeVideoId = null/);
});
