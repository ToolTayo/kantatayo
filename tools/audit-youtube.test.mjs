import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUDIT_CLASSIFICATIONS,
  auditPromotedAssignments,
  detectMetadataIndicators,
  parseArguments,
  renderMarkdownReport,
  validateReplacement
} from "./audit-youtube.mjs";

function song(id, title, artist, youtubeVideoId, performanceType = "solo") {
  return { id, title, artist, performanceType, youtubeVideoId };
}

function record(songId, videoId, videoTitle, overrides = {}) {
  return {
    songId,
    candidateVideoId: videoId,
    status: "verified",
    apiVerified: true,
    embeddable: true,
    madeForKids: false,
    videoTitle,
    channelTitle: "Karaoke Channel",
    provenance: "auto-high-confidence",
    ...overrides
  };
}

test("audits every valid promoted record exactly once and excludes null catalog videos", () => {
  const catalog = [
    song("sample-001", "Tadhana", "Up Dharma Down", "aaaaaaaaaaa"),
    song("sample-002", "Unassigned", "Artist", null)
  ];
  const report = auditPromotedAssignments(catalog, {
    records: [record("sample-001", "aaaaaaaaaaa", "TADHANA - Up Dharma Down (KARAOKE VERSION)")]
  }, { generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(report.auditedCount, 1);
  assert.deepEqual(report.assignments.map((row) => row.catalogId), ["sample-001"]);
  assert.equal(report.assignments[0].assignmentState, "PUBLIC_CATALOG");
});

test("detects duplicate video IDs and does not classify them as a clean pass", () => {
  const catalog = [song("sample-001", "One", "Artist One", "aaaaaaaaaaa"), song("sample-002", "Two", "Artist Two", null)];
  const report = auditPromotedAssignments(catalog, {
    records: [
      record("sample-001", "aaaaaaaaaaa", "ONE - Artist One Karaoke"),
      record("sample-002", "aaaaaaaaaaa", "TWO - Artist Two Karaoke")
    ]
  }, { generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(report.duplicateVideoIds.length, 1);
  assert.ok(report.assignments.every((row) => row.overallAuditClassification === AUDIT_CLASSIFICATIONS.REVIEW_REQUIRED));
});

test("detects altered-key, gender-key, live, remix, cover, and lyrics indicators", () => {
  const metadata = detectMetadataIndicators({
    videoTitle: "Song - Artist Karaoke -2 Key Female Part Live Remix Cover With Lyrics",
    channelTitle: "Channel",
    description: ""
  });
  assert.equal(metadata.matches.alteredKey, true);
  assert.equal(metadata.matches.genderKey, true);
  assert.equal(metadata.matches.live, true);
  assert.equal(metadata.matches.remix, true);
  assert.equal(metadata.matches.cover, true);
  assert.equal(metadata.matches.lyricsOnly, true);
});

test("detects guide vocal, shortened, part-only, and medley indicators", () => {
  const metadata = detectMetadataIndicators({
    videoTitle: "Song Karaoke Guide Vocal Female Part Short Version Medley",
    channelTitle: "Channel"
  });
  assert.equal(metadata.matches.guideVocal, true);
  assert.equal(metadata.matches.partOnly, true);
  assert.equal(metadata.matches.shortened, true);
  assert.equal(metadata.matches.medley, true);
});

test("keeps playback-dependent audio claims unresolved", () => {
  const report = auditPromotedAssignments(
    [song("sample-001", "Song", "Artist", "aaaaaaaaaaa")],
    { records: [record("sample-001", "aaaaaaaaaaa", "Song - Artist Karaoke")] },
    { generatedAt: "2026-01-01T00:00:00.000Z" }
  );
  const row = report.assignments[0];
  assert.equal(row.overallAuditClassification, AUDIT_CLASSIFICATIONS.AUDIO_UNRESOLVED);
  assert.equal(row.keyStatus, "NO ALTERED-KEY INDICATOR FOUND");
  assert.equal(row.audioQualityStatus, "UNRESOLVED");
  assert.equal(row.presentationQualityStatus, "UNRESOLVED");
  assert.equal(row.visualInspectionStatus, "NOT_PERFORMED");
  assert.ok(row.evidence.some((item) => item.type === "UNRESOLVED" && item.claim === "Audio quality"));
  assert.ok(row.evidence.some((item) => item.type === "UNRESOLVED" && item.claim === "Presentation quality"));
});

test("classifies explicit unsuitable metadata as review required", () => {
  const report = auditPromotedAssignments(
    [song("sample-001", "Song", "Artist", "aaaaaaaaaaa")],
    { records: [record("sample-001", "aaaaaaaaaaa", "Song - Artist Karaoke Lower Key -2 Karaoke")] },
    { generatedAt: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(report.assignments[0].overallAuditClassification, AUDIT_CLASSIFICATIONS.REVIEW_REQUIRED);
  assert.match(report.assignments[0].recommendedAction, /Human review/);
});

test("classifies partial song identity evidence as review required", () => {
  const report = auditPromotedAssignments(
    [song("sample-001", "Spoliarium", "Eraserheads", "aaaaaaaaaaa")],
    { records: [record("sample-001", "aaaaaaaaaaa", "SPOLARIUM - Eraserheads Karaoke")] },
    { generatedAt: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(report.assignments[0].identityStatus, "METADATA_INDICATION_ONLY");
  assert.equal(report.assignments[0].overallAuditClassification, AUDIT_CLASSIFICATIONS.REVIEW_REQUIRED);
});

test("records the four flagged investigations without changing IDs or selecting unverified alternatives", () => {
  const catalog = [
    song("sample-004", "Dancing Queen", "ABBA", "aaaaaaaaaaa"),
    song("sample-006", "The Scientist", "Coldplay", "bbbbbbbbbbb"),
    song("sample-022", "Beer", "Itchyworms", "ccccccccccc"),
    song("sample-044", "Spoliarium", "Eraserheads", "ddddddddddd")
  ];
  const verification = {
    records: [
      record("sample-004", "aaaaaaaaaaa", "ABBA - Dancing Queen (Karaoke Version) with Lyrics On Screen"),
      record("sample-006", "bbbbbbbbbbb", "THE SCIENTIST - Coldplay (HQ KARAOKE VERSION with lyrics)"),
      record("sample-022", "ccccccccccc", "Beer - Itchyworms (KARAOKE)", { channelTitle: "PRO music COVER" }),
      record("sample-044", "ddddddddddd", "SPOLARIUM - Eraserheads (HD Karaoke)")
    ]
  };
  const report = auditPromotedAssignments(catalog, verification, { generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(report.replacementsMade, 0);
  assert.deepEqual(report.assignments.map((row) => row.currentVideoId), ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]);
  for (const row of report.assignments) {
    assert.equal(row.flaggedInvestigation.decision, "KEEP — LISTENING REVIEW");
    assert.ok(row.flaggedInvestigation.alternativeCandidatesConsidered.length > 0);
    assert.ok(row.flaggedInvestigation.alternativeCandidatesConsidered.every((candidate) => /NOT SELECTED/.test(candidate.result)));
  }
});

test("replacement requires a recorded failure reason, comparison evidence, and a verified candidate", () => {
  const candidate = {
    candidateVideoId: "bbbbbbbbbbb",
    status: "verified",
    apiVerified: true,
    embeddable: true,
    madeForKids: false,
    verifiedAt: "2026-01-01T00:00:00.000Z"
  };
  assert.equal(validateReplacement({ oldVideoId: "aaaaaaaaaaa", newCandidate: candidate }).allowed, false);
  const accepted = validateReplacement({
    oldVideoId: "aaaaaaaaaaa",
    newCandidate: candidate,
    replacementReason: "Current video is confirmed incomplete.",
    comparisonEvidence: ["Replacement duration and arrangement were verified."],
    identityEvidence: ["Catalog title and artist match the replacement metadata."],
    visualEvidence: ["Representative middle-song frames show readable synchronized lyrics."],
    audioEvidence: ["Playback review found no key, pitch, speed, guide-vocal, or arrangement regression."],
    visualInspectionPerformed: true,
    existingVideoIds: ["aaaaaaaaaaa"]
  });
  assert.equal(accepted.allowed, true);
  const duplicate = validateReplacement({
    oldVideoId: "aaaaaaaaaaa",
    newCandidate: candidate,
    replacementReason: "Confirmed failure.",
    comparisonEvidence: ["Verified comparison."],
    identityEvidence: ["Exact song and artist match."],
    visualEvidence: ["Representative frames inspected."],
    audioEvidence: ["No musical regression found."],
    visualInspectionPerformed: true,
    existingVideoIds: ["bbbbbbbbbbb"]
  });
  assert.equal(duplicate.allowed, false);
  assert.match(duplicate.errors.join(" "), /already assigned/);
});

test("replacement rejects a prettier candidate with altered key, wrong version, or no visual inspection", () => {
  const candidate = {
    candidateVideoId: "bbbbbbbbbbb",
    status: "verified",
    apiVerified: true,
    embeddable: true,
    madeForKids: false,
    verifiedAt: "2026-01-01T00:00:00.000Z"
  };
  const result = validateReplacement({
    oldVideoId: "aaaaaaaaaaa",
    newCandidate: candidate,
    replacementReason: "The current presentation is confirmed crude.",
    comparisonEvidence: ["Candidate has cleaner lyric presentation."],
    identityEvidence: ["Title and artist match."],
    audioEvidence: ["Candidate is explicitly marked female key +2; musical regression is known."],
    knownMusicalRegression: true,
    visualEvidence: [],
    visualInspectionPerformed: false
  });
  assert.equal(result.allowed, false);
  assert.match(result.errors.join(" "), /representative visual inspection evidence/);
  assert.match(result.errors.join(" "), /known musical or version regression/);
});

test("metadata alone cannot claim visual or audio inspection", () => {
  const report = auditPromotedAssignments(
    [song("sample-001", "Song", "Artist", "aaaaaaaaaaa")],
    { records: [record("sample-001", "aaaaaaaaaaa", "Song - Artist Karaoke") ] },
    { generatedAt: "2026-01-01T00:00:00.000Z" }
  );
  const row = report.assignments[0];
  assert.equal(row.presentationQualityStatus, "UNRESOLVED");
  assert.equal(row.visualInspectionStatus, "NOT_PERFORMED");
  assert.equal(row.audioInspectionStatus, "NOT_PERFORMED");
  assert.equal(report.inspectionSummary.visualInspectedCount, 0);
  assert.equal(report.inspectionSummary.audioListenedCount, 0);
  assert.match(renderMarkdownReport(report), /Visual frames inspected: 0/);
  assert.match(renderMarkdownReport(report), /Presentation quality: UNRESOLVED/);
});

test("the production catalog audits all historical assignments exactly once and records quality removals", () => {
  const catalog = JSON.parse(readFileSync("data/songs.sample.json", "utf8"));
  const verification = JSON.parse(readFileSync("tools/youtube-verification.json", "utf8"));
  const report = auditPromotedAssignments(catalog, verification, { generatedAt: "2026-01-01T00:00:00.000Z" });
  const catalogIds = report.assignments.map((row) => row.catalogId);
  assert.equal(catalog.length, 145);
  assert.equal(report.auditedCount, 137);
  assert.equal(new Set(catalogIds).size, 137);
  assert.equal(report.qualityUnassignmentCount, 8);
  const expectedNullIds = [
    "sample-008", "sample-009", "sample-010", "sample-042", "sample-072", "sample-078", "sample-084", "sample-088", "sample-091", "sample-092", "sample-093", "sample-095", "sample-096",
    "sample-121", "sample-143", "sample-145"
  ];
  assert.deepEqual(catalog.filter((song) => song.youtubeVideoId === null).map((song) => song.id), expectedNullIds);
  assert.equal(report.unassignedCatalogSongIds.length, 16);
  assert.equal(report.duplicateVideoIds.length, 0);
});

test("audit output is deterministic when generatedAt is fixed", () => {
  const input = [song("sample-001", "Song", "Artist", "aaaaaaaaaaa")];
  const verification = { records: [record("sample-001", "aaaaaaaaaaa", "Song - Artist Karaoke")] };
  const first = auditPromotedAssignments(input, verification, { generatedAt: "2026-01-01T00:00:00.000Z" });
  const second = auditPromotedAssignments(input, verification, { generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(first, second);
  assert.match(renderMarkdownReport(first), /KEEP — AUDIO QUALITY UNRESOLVED/);
});

test("CLI options use local files and provide clear defaults", () => {
  const options = parseArguments(["--catalog", "catalog.json", "--file", "verification.json", "--output", "audit.json"]);
  assert.equal(options.catalog, "catalog.json");
  assert.equal(options.verification, "verification.json");
  assert.equal(options.output, "audit.json");
  assert.throws(() => parseArguments(["--output"]), /--output requires a value/);
});
