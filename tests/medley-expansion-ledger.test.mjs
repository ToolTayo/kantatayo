import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (relativePath) => JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
const ledger = await readJson("tools/medley-expansion-runtime-ledger.json");
const report = await readJson("tools/medley-expansion-research-v4.json");
const v3 = await readJson("tools/medley-expansion-runtime-v3.json");
const v4 = await readJson("tools/medley-expansion-runtime-v4.json");
const researchV5 = await readJson("tools/medley-expansion-research-v5.json");
const catalogText = await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8");
const catalog = JSON.parse(catalogText);
const medleyData = await readJson("data/medleys.sample.json");

test("medley runtime ledger reconciles every tested candidate to its raw batch report", () => {
  assert.equal(ledger.entries.length, 33);
  assert.equal(new Set(ledger.entries.map((entry) => entry.videoId)).size, 33);
  for (const [path, source] of [["tools/medley-expansion-runtime-v3.json", v3], ["tools/medley-expansion-runtime-v4.json", v4]]) {
    const rawEntries = source.entries.filter((entry) => entry.provider !== "Control");
    const ledgerEntries = ledger.entries.filter((entry) => entry.resultFile === path);
    assert.equal(ledgerEntries.length, rawEntries.length);
    for (const raw of rawEntries) {
      const record = ledgerEntries.find((entry) => entry.videoId === raw.videoId);
      assert.ok(record, `missing ledger row for ${raw.videoId}`);
      assert.equal(record.status, raw.iframeStatus);
      if (raw.iframeStatus === "ERROR 150") assert.equal(record.errorCode, 150);
      if (raw.iframeStatus === "PASS") assert.equal(record.progressSeconds, 15);
    }
  }
  assert.deepEqual(ledger.summary, { uniqueCandidateVideosTested: 33, pass: 12, error150: 21, otherErrors: 0, timeouts: 0, inconclusive: 0, productionAdditions: 0 });
});

test("research report preserves the no-promotion quality gate and exact production baseline", () => {
  assert.equal(report.researchUniverse.previousDistinctCandidates + report.researchUniverse.newDistinctCandidatesThisPass, 69);
  assert.equal(report.newCandidates.length, 30);
  assert.equal(report.productionDecision.medleysAdded, 0);
  assert.equal(report.productionDecision.publicMedleysBefore, 11);
  assert.equal(report.productionDecision.publicMedleysAfter, 11);
  assert.deepEqual(report.qualityTierCountsAcrossReconciledResearchUniverse, {
    S: 0,
    A: 0,
    B: 0,
    C_human_review_required: 12,
    rejected_embedding_disabled: 21,
    deferred_or_not_runtime_graded: 36,
    note: "No S/A/B grade is defensible without actual audio/presentation review. The 12 C records are technical runtime passes only; the other 36 have no unique runtime qualification and include weak, incomplete, or semantically redundant leads rather than 36 presumed viable additions."
  });
  assert.ok(report.newCandidates.filter((candidate) => candidate.runtime.startsWith("PASS")).every((candidate) => candidate.tier === "C — human review"));
  assert.equal(report.verifier.v5Attempt.status, "NOT RUN");
});

test("medley expansion artifacts preserve all primary songs and existing medleys", () => {
  const sha256 = createHash("sha256").update(catalogText, "utf8").digest("hex");
  assert.equal(sha256, "547796d68ab2b7d09c3bddb8fb3fbd0285323fd913d2e070357352eff132e5b7");
  assert.equal(catalog.length, 1067);
  assert.equal(catalog.filter((song) => song.youtubeVideoId).length, 1000);
  assert.equal(catalog.filter((song) => !song.youtubeVideoId).length, 67);
  assert.equal(catalog.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
  const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const pairKeys = catalog.map((song) => `${normalize(song.title)}${String.fromCharCode(0)}${normalize(song.artist)}`);
  assert.equal(new Set(pairKeys).size, catalog.length);
  assert.equal(new Set(catalog.map((song) => song.id)).size, catalog.length);
  const videoIds = catalog.map((song) => song.youtubeVideoId).filter(Boolean);
  assert.equal(new Set(videoIds).size, videoIds.length);
  assert.equal(medleyData.medleys.length, 31);
  const primaryVideoIds = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  assert.ok(medleyData.medleys.every((medley) => !primaryVideoIds.has(medley.videoId)));
  assert.equal(new Set(medleyData.medleys.map((medley) => medley.id)).size, medleyData.medleys.length);
  assert.equal(new Set(medleyData.medleys.map((medley) => medley.videoId)).size, medleyData.medleys.length);
});

test("Phase 2 research totals reconcile to valid raw runtime batches without counting controls", async () => {
  const validBatchFiles = ["v3", "v4", "v5", "v6", "v7", "v8", "v10", "v11", "v13"];
  const rows = (await Promise.all(validBatchFiles.map((version) => readJson(`tools/medley-expansion-runtime-${version}.json`))))
    .flatMap((batch) => batch.entries);
  const byVideoId = new Map(rows.map((entry) => [entry.videoId, entry]));
  const controlId = "QBb9wO3Bj0k";
  const controlRows = rows.filter((entry) => entry.videoId === controlId);
  const candidates = [...byVideoId.values()].filter((entry) => entry.videoId !== controlId);
  const statusCounts = candidates.reduce((counts, entry) => {
    counts[entry.iframeStatus] = (counts[entry.iframeStatus] ?? 0) + 1;
    return counts;
  }, {});
  const sorted = (values) => [...values].sort();

  assert.equal(controlRows.length, validBatchFiles.length);
  assert.ok(controlRows.every((entry) => entry.iframeStatus === "PASS"));
  assert.equal(candidates.length, 51);
  assert.deepEqual(statusCounts, { PASS: 22, "ERROR 150": 28, INCONCLUSIVE: 1 });
  assert.equal(researchV5.reconciledUniverse.currentReportedDistinctCandidates, 85);
  assert.equal(researchV5.runtimeResults.uniqueCandidatesTested, candidates.length);
  assert.equal(researchV5.runtimeResults.PASS, statusCounts.PASS);
  assert.equal(researchV5.runtimeResults.ERROR_150, statusCounts["ERROR 150"]);
  assert.equal(researchV5.runtimeResults.INCONCLUSIVE, statusCounts.INCONCLUSIVE);
  assert.deepEqual(
    sorted(researchV5.strongestTechnicalPassPoolByDemandSnapshot.map((candidate) => candidate.videoId)),
    sorted(candidates.filter((entry) => entry.iframeStatus === "PASS").map((entry) => entry.videoId))
  );
  assert.deepEqual(
    sorted(researchV5.error150RejectedVideoIds),
    sorted(candidates.filter((entry) => entry.iframeStatus === "ERROR 150").map((entry) => entry.videoId))
  );
  assert.deepEqual(
    sorted(researchV5.inconclusiveCandidates.map((candidate) => candidate.videoId)),
    sorted(candidates.filter((entry) => entry.iframeStatus === "INCONCLUSIVE").map((entry) => entry.videoId))
  );
  assert.ok(researchV5.strongestTechnicalPassPoolByDemandSnapshot.every((candidate) => candidate.quality.startsWith("C —")));
  assert.equal(researchV5.productionDecision.songsChanged, 0);
  assert.equal(researchV5.productionDecision.medleysAdded, 0);
  assert.equal(researchV5.verifier.proof.validCandidateBatches.length, validBatchFiles.length);
});
