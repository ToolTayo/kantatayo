import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderMedleyCard } from "../src/ui.js";
import { isPlayableMedley, normalizeMedleys } from "../src/medleys.js";
import {
  EVIDENCE_REPORT_FILES,
  RUNTIME_REPORT_FILES,
  buildReviewCandidates
} from "../tools/medley-review-core.mjs";
import { buildOwnerAuthorizedPreview } from "../tools/promote-owner-authorized-medleys.mjs";

const readJson = async (relativePath) => JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
const [release, researchReport, medleyData, primarySongs, ...sources] = await Promise.all([
  readJson("tools/owner-authorized-medley-release.json"),
  readJson("tools/medley-expansion-research-v5.json"),
  readJson("data/medleys.sample.json"),
  readJson("data/songs.sample.json"),
  ...RUNTIME_REPORT_FILES.map(async (name) => ({ name, data: await readJson(`tools/${name}`) })),
  ...EVIDENCE_REPORT_FILES.map(async (name) => ({ name, data: await readJson(`tools/${name}`) }))
]);
const runtimeReports = sources.slice(0, RUNTIME_REPORT_FILES.length);
const evidenceReports = sources.slice(RUNTIME_REPORT_FILES.length);
const candidates = buildReviewCandidates({ researchReport, runtimeReports, evidenceReports, existingMedleys: medleyData.medleys.slice(0, 11), primarySongs });
const buildPreview = (overrides = {}) => buildOwnerAuthorizedPreview({
  release,
  candidates: overrides.candidates || candidates,
  runtimeReports: overrides.runtimeReports || runtimeReports,
  existingMedleys: overrides.existingMedleys || medleyData.medleys.slice(0, 11),
  primarySongs: overrides.primarySongs || primarySongs
});

test("explicit owner authorization creates a separate provisional path for 20 of 22 candidates", () => {
  const preview = buildPreview();
  assert.equal(preview.ok, true, preview.errors?.join("; "));
  assert.deepEqual([preview.currentMedleyCount, preview.acceptedCount, preview.excludedCount, preview.finalMedleyCount], [11, 20, 2, 31]);
  assert.deepEqual(new Set(preview.decisions.filter((item) => item.decision === "included").map((item) => item.videoId)), new Set(release.decisions.filter((item) => item.decision === "include").map((item) => item.videoId)));
  assert.deepEqual(preview.decisions.filter((item) => item.decision === "excluded").map((item) => item.videoId).sort(), ["-D1irYqKIog", "vcHCtqnU6A4"].sort());
  for (const record of preview.additions) {
    assert.equal(record.verification.status, "owner-authorized-provisional");
    assert.equal(record.verification.manualQuality, "unknown");
    assert.equal(record.verification.ownerAuthorization.humanAudioPresentationReview, "not-performed");
    assert.ok(!JSON.stringify(record).includes("human-review-approved"));
  }
});

test("preview is safely idempotent after the exact authorized records are applied", () => {
  const preview = buildPreview({ existingMedleys: medleyData.medleys });
  assert.equal(preview.ok, true, preview.errors?.join("; "));
  assert.deepEqual([preview.currentMedleyCount, preview.acceptedCount, preview.alreadyAppliedCount, preview.excludedCount, preview.finalMedleyCount], [31, 0, 20, 2, 31]);
  assert.equal(preview.decisions.filter((item) => item.decision === "already-applied").length, 20);

  const alteredExisting = structuredClone(medleyData.medleys);
  alteredExisting.find((item) => item.videoId === "BIvD7IJQyME").verification.manualQuality = "approved";
  const conflict = buildPreview({ existingMedleys: alteredExisting });
  assert.equal(conflict.ok, false);
  assert.match(conflict.errors.join(" "), /does not exactly match the authorized provisional record/i);
});

test("each of the 22 candidates has candidate-specific sustained evidence and a passing independent control gate", () => {
  const preview = buildPreview();
  assert.equal(preview.ok, true, preview.errors?.join("; "));
  assert.equal(preview.decisions.length, 22);
  for (const decision of preview.decisions) {
    assert.equal(decision.runtimeProof.ok, true, decision.videoId);
    assert.ok(decision.runtimeProof.sampleCount >= 8);
    assert.ok(decision.runtimeProof.playbackSeconds >= 15);
    assert.ok(decision.runtimeProof.advancementSeconds >= 8);
  }
});

test("provisional path rejects mismatched candidate identity and a failed control gate", () => {
  const candidate = candidates.find((item) => item.videoId === "BIvD7IJQyME");
  const reportIndex = runtimeReports.findIndex((report) => report.name === candidate.runtimeReport);
  const badIdentityReports = structuredClone(runtimeReports);
  const badEntry = badIdentityReports[reportIndex].data.entries.find((entry) => entry.videoId === candidate.videoId);
  badEntry.trace.find((entry) => entry.kind === "playback-sample").loadedVideoId = "WrongVideo01";
  const identityResult = buildPreview({ runtimeReports: badIdentityReports });
  assert.equal(identityResult.ok, false);
  assert.match(identityResult.errors.join(" "), /different player or loaded video ID/i);

  const badControlReports = structuredClone(runtimeReports);
  badControlReports[reportIndex].data.runtime.controlGate.runs[0].validation.playerIdentityMatched = false;
  const controlResult = buildPreview({ runtimeReports: badControlReports });
  assert.equal(controlResult.ok, false);
  assert.match(controlResult.errors.join(" "), /three-run sample-029 control gate/i);
});

test("the release path requires explicit owner authorization and never manufactures review ratings", () => {
  const unauthorized = buildOwnerAuthorizedPreview({ release: { ...release, authorization: { ...release.authorization, status: "not-authorized" } }, candidates, runtimeReports, existingMedleys: medleyData.medleys.slice(0, 11), primarySongs });
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.errors.join(" "), /explicit owner authorization/i);
  assert.equal(release.authorization.humanAudioPresentationReview, "not-performed");
  assert.equal(release.decisions.length, 22);
  assert.ok(release.decisions.every((row) => row.reason));
});

test("normalizer accepts only explicitly authorized provisional records and preserves honest status", () => {
  const preview = buildPreview();
  const normalized = normalizeMedleys({ medleys: [...medleyData.medleys.slice(0, 11), ...preview.additions] }, { logger: { warn() {} } });
  assert.equal(normalized.warnings.length, 0);
  assert.equal(normalized.medleys.length, 31);
  assert.ok(normalized.medleys.slice(11).every((item) => isPlayableMedley(item)
    && item.verification.status === "owner-authorized-provisional"
    && item.verification.manualQuality === "unknown"
    && item.verification.ownerAuthorization?.humanAudioPresentationReview === "not-performed"));
  const missingAuthorization = normalizeMedleys({ medleys: [{ ...preview.additions[0], verification: { ...preview.additions[0].verification, ownerAuthorization: undefined } }] }, { logger: { warn() {} } });
  assert.equal(missingAuthorization.medleys.length, 0);
  assert.ok(missingAuthorization.warnings.some((warning) => /owner authorization/i.test(warning)));
});

test("public provisional card clearly discloses unreviewed quality and preserves play/queue/share actions", () => {
  const preview = buildPreview();
  const html = renderMedleyCard(preview.additions[0]);
  assert.match(html, /Provisional release · audio and presentation have not been human-reviewed/);
  assert.match(html, /data-action="play-medley"/);
  assert.match(html, /data-action="add-medley-queue"/);
  assert.match(html, /data-action="share-medley"/);
  assert.doesNotMatch(html, /human-approved|Tier [SAB]|quality verified/i);
});

test("owner expansion preserves the original 11 medleys and all 1067 primary records", () => {
  const original = medleyData.medleys.slice(0, 11);
  assert.equal(createHash("sha256").update(JSON.stringify(original)).digest("hex"), "3f092a8a45d57841482c852fac9cd69226d36f0b90561059b07c5a6d4e4ff998");
  assert.equal(primarySongs.length, 1067);
  assert.equal(primarySongs.filter((song) => song.youtubeVideoId).length, 1000);
  assert.equal(primarySongs.filter((song) => !song.youtubeVideoId).length, 67);
  assert.equal(primarySongs.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
  const allVideos = [...primarySongs.map((song) => song.youtubeVideoId).filter(Boolean), ...medleyData.medleys.map((medley) => medley.videoId)];
  assert.equal(new Set(allVideos).size, allVideos.length);
  assert.equal(new Set(medleyData.medleys.map((medley) => medley.id)).size, medleyData.medleys.length);
  assert.equal(new Set(medleyData.medleys.map((medley) => medley.videoId)).size, medleyData.medleys.length);
});

test("human-review approval path remains separate and local review workspace data is not written", async () => {
  const [tool, reviewCore, reviewUi] = await Promise.all([
    readFile(new URL("../tools/promote-owner-authorized-medleys.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/medley-review-core.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/medley-review.js", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(tool, /REVIEW_STORAGE_KEY|localStorage|buildPromotionPreview|human-review-approved/);
  assert.match(reviewCore, /QUALITY_CHECKS\.every/);
  assert.match(reviewCore, /record\.decision === "approved"/);
  assert.match(reviewCore, /kantacue\.medley-review\.v1/);
  assert.match(reviewUi, /localStorage\.setItem\(REVIEW_STORAGE_KEY/);
});
