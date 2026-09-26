#!/usr/bin/env node

/**
 * Development-only quality audit for persisted YouTube assignments.
 *
 * This tool reads the catalog and the local verification store only. It does
 * not call YouTube, download media, change the catalog, or promote anything.
 * Metadata findings are deliberately kept separate from playback findings.
 */

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DEFAULT_CATALOG_PATH = "data/songs.sample.json";
export const DEFAULT_VERIFICATION_PATH = "tools/youtube-verification.json";
export const DEFAULT_OUTPUT_PATH = "tools/youtube-quality-audit.json";
export const DEFAULT_MARKDOWN_PATH = "tools/youtube-quality-audit.md";
export const AUDIT_VERSION = 2;
export const AUDIT_CLASSIFICATIONS = Object.freeze({
  STRONG_EXPERIENCE: "KEEP — STRONG EXPERIENCE",
  ACCEPTABLE: "KEEP — ACCEPTABLE",
  AUDIO_UNRESOLVED: "KEEP — AUDIO QUALITY UNRESOLVED",
  VISUAL_UNRESOLVED: "KEEP — VISUAL QUALITY UNRESOLVED",
  REVIEW_LISTENING: "REVIEW — LISTENING REQUIRED",
  REVIEW_VISUAL: "REVIEW — VISUAL INSPECTION REQUIRED",
  REPLACEMENT_FOUND: "REPLACE — CLEARLY SUPERIOR VERIFIED CANDIDATE",
  NO_SAFE_REPLACEMENT: "REPLACEMENT NEEDED — NO SAFE BETTER CANDIDATE YET",
  // Backward-compatible names for callers of the previous audit API.
  QUALITY_VERIFIED: "KEEP — STRONG EXPERIENCE",
  REVIEW_REQUIRED: "REVIEW — LISTENING REQUIRED"
});

export const EVIDENCE_STATUS = Object.freeze({
  VERIFIED: "VERIFIED",
  INDICATION_ONLY: "METADATA INDICATION ONLY",
  UNRESOLVED: "UNRESOLVED",
  NOT_PERFORMED: "NOT_PERFORMED"
});

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const INDICATORS = [
  { key: "alteredKey", pattern: /\blower key\b|\bhigher key\b|\bfemale key\b|\bmale key\b|\bkey change\b|[+-]\s*\d+\s*(?:key|semitone)/i, label: "altered-key wording" },
  { key: "genderKey", pattern: /\b(?:male|female)\s*(?:key|part|version)\b/i, label: "male/female key or part wording" },
  { key: "live", pattern: /\blive\b|\bconcert\b|\bperformance\b/i, label: "live/performance wording" },
  { key: "remix", pattern: /\bremix\b/i, label: "remix wording" },
  { key: "cover", pattern: /\bcover(?:ed)?\b/i, label: "cover wording" },
  { key: "lyricsOnly", pattern: /\blyric(?:s| video)?\b|\bwith lyrics\b/i, label: "lyrics-only wording" },
  { key: "originalAudio", pattern: /\boriginal audio\b|\bfull song\b/i, label: "original/full-audio wording" },
  { key: "acoustic", pattern: /\bacoustic\b/i, label: "acoustic wording" },
  { key: "guideVocal", pattern: /\bguide vocal\b|\bwith vocals?\b|\bvocal guide\b/i, label: "guide-vocal wording" },
  { key: "partOnly", pattern: /\b(?:male|female)\s+part\b|\bpart\s*[12]\b/i, label: "single-part wording" },
  { key: "shortened", pattern: /\bshort(?:ened)?\b|\bshort version\b|\bedit version\b/i, label: "shortened/edit wording" },
  { key: "speedChanged", pattern: /\bslowed(?:ed)?\b|\bsped up\b|\bfaster\b|\bspeed(?:ed)?\b/i, label: "speed-change wording" },
  { key: "medley", pattern: /\bmedley\b/i, label: "medley wording" },
  { key: "visualizer", pattern: /\bvisualizer\b|\bmusic video\b|\bofficial video\b/i, label: "non-karaoke video wording" }
];

const POSITIVE_KARAOKE_PATTERN = /\bkaraoke\b|\binstrumental\b|\bbacking track\b|\bminus one\b|\bsing along\b/i;
const HARD_REVIEW_KEYS = new Set([
  "alteredKey", "genderKey", "live", "remix", "cover", "lyricsOnly",
  "originalAudio", "acoustic", "guideVocal", "partOnly", "shortened",
  "speedChanged", "medley", "visualizer"
]);

const FLAGGED_INVESTIGATIONS = Object.freeze({
  "sample-004": {
    currentWarning: "Video title contains 'with Lyrics On Screen'.",
    identityResult: "KEEP — catalog title and artist match the stored video title.",
    karaokeMetadataResult: "The title explicitly says Karaoke Version; lyrics on screen are normal karaoke presentation evidence, not proof of original-vocal audio.",
    keyEvidence: "No altered-key wording found; original/standard key is not confirmed.",
    versionEvidence: "No live, remix, acoustic, medley, part-only, or shortened indicator found in stored metadata.",
    technicalVerification: "Persisted verification confirms API match, embeddable=true, madeForKids=false, manualMatch=true, karaokeSuitable=true.",
    alternativeCandidatesConsidered: [
      { videoId: "WHayJZ3eMcE", title: "ABBA - Dancing Queen (Karaoke Version)", channel: "Sing King", result: "NOT SELECTED — discovery metadata only; local technical verification and playback comparison not performed." },
      { videoId: "7fCMws3U2zE", title: "Dancing Queen - ABBA | Karaoke Version", channel: "KaraFun Karaoke", result: "NOT SELECTED — description exposes a low-volume vocal guide; not clearly superior for a default karaoke assignment." }
    ],
    decision: "KEEP — LISTENING REVIEW",
    exactReason: "Lyrics-on-screen wording alone does not establish unsuitability. No confirmed failure and no clearly superior technically verified replacement are available.",
    remainingUncertainty: ["actual instrumental/backing quality", "guide vocals", "key and pitch", "completeness"]
  },
  "sample-006": {
    currentWarning: "Video title contains 'with lyrics'.",
    identityResult: "KEEP — catalog title and artist match the stored video title.",
    karaokeMetadataResult: "The title says HQ Karaoke Version with lyrics; lyrics display is compatible with karaoke and does not prove that the commercial master is used.",
    keyEvidence: "No altered-key wording found; original/standard key is not confirmed.",
    versionEvidence: "No live, remix, acoustic, medley, part-only, or shortened indicator found in stored metadata.",
    technicalVerification: "Persisted verification confirms API match, embeddable=true, madeForKids=false, manualMatch=true, karaokeSuitable=true.",
    alternativeCandidatesConsidered: [
      { videoId: "AP7dam8_orI", title: "The Scientist - Coldplay (Karaoke Version)", channel: "KaraokeyTV", result: "NOT SELECTED — discovery metadata describes an instrumental cover, but local technical verification and playback comparison were not performed." },
      { videoId: "J4zf2q3hFO0", title: "THE SCIENTIST - COLDPLAY (KARAOKE VERSION)", channel: "Unresolved from discovery metadata", result: "NOT SELECTED — not technically verified in the local store." }
    ],
    decision: "KEEP — LISTENING REVIEW",
    exactReason: "With-lyrics wording is expected for karaoke and is not concrete evidence of an unsuitable vocal track. No confirmed failure and no clearly superior technically verified replacement are available.",
    remainingUncertainty: ["actual instrumental/backing quality", "guide vocals", "key and pitch", "completeness"]
  },
  "sample-022": {
    currentWarning: "Channel name contains 'COVER'.",
    identityResult: "KEEP — catalog title and artist match the stored video title.",
    karaokeMetadataResult: "The video title says KARAOKE; 'COVER' appears in the channel name only. That is not proof that the upload contains cover vocals.",
    keyEvidence: "No altered-key wording found; original/standard key is not confirmed.",
    versionEvidence: "No live, remix, acoustic, medley, part-only, or shortened indicator found in stored metadata.",
    technicalVerification: "Persisted verification confirms API match, embeddable=true, madeForKids=false, manualMatch=true, karaokeSuitable=true.",
    alternativeCandidatesConsidered: [
      { videoId: "IvIvCzMlB8Y", title: "The Itchyworms - Beer (Karaoke Version)", channel: "Sing King", result: "NOT SELECTED — stronger karaoke wording in discovery metadata, but local technical verification and playback comparison were not performed." }
    ],
    decision: "KEEP — LISTENING REVIEW",
    exactReason: "A channel-name token is insufficient to establish cover vocals or poor backing audio. No confirmed failure and no clearly superior technically verified replacement are available.",
    remainingUncertainty: ["whether audio is fully instrumental", "guide vocals", "backing quality", "key and completeness"]
  },
  "sample-044": {
    currentWarning: "Video title spells the song 'SPOLARIUM' rather than catalog 'Spoliarium'.",
    identityResult: "KEEP — likely uploader/karaoke-title spelling variation; artist matches, but exact title identity remains a metadata indication rather than a fully normalized match.",
    karaokeMetadataResult: "Title says HD Karaoke; no separate suitability red flag found.",
    keyEvidence: "No altered-key wording found; original/standard key is not confirmed.",
    versionEvidence: "The spelling difference alone does not establish a wrong version. No live, remix, acoustic, medley, part-only, or shortened indicator found in stored metadata.",
    technicalVerification: "Persisted verification confirms API match, embeddable=true, madeForKids=false, manualMatch=true, karaokeSuitable=true.",
    alternativeCandidatesConsidered: [
      { videoId: "Feeva5IaB8U", title: "Spoliarium (Eraserheads)", channel: "KARAOKE MUSIC LOUNGE", result: "NOT SELECTED — external karaoke reference only; not locally API-verified and no playback comparison." },
      { videoId: "ak4nBfqG6Fk", title: "Spolarium - Eraserheads", channel: "YenJohn HD Karaoke", result: "NOT SELECTED — external karaoke reference uses the same spelling variant; not locally API-verified and no playback comparison." }
    ],
    decision: "KEEP — LISTENING REVIEW",
    exactReason: "External references use both Spoliarium and Spolarium; the current title spelling is not proof of a wrong song. Keep the verified ID and confirm identity/audio during playback review.",
    remainingUncertainty: ["exact title/version identity", "actual backing quality", "key and pitch", "completeness"]
  }
});

export function isValidVideoId(value) {
  return typeof value === "string" && VIDEO_ID_PATTERN.test(value.trim());
}

export function normalizeIdentity(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/s2pid/g, "stupid")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function artistAnchors(artist) {
  return String(artist || "")
    .split(/\bfeat(?:uring)?\.?\b|&|,|\bx\b|\band\b/gi)
    .map(normalizeIdentity)
    .filter((value) => value.length >= 3);
}

function identityAssessment(song, record) {
  const videoText = normalizeIdentity(record.videoTitle);
  const title = normalizeIdentity(song?.title);
  const titleMatch = Boolean(title && videoText.includes(title));
  const anchors = artistAnchors(song?.artist);
  const matchingAnchors = anchors.filter((anchor) => videoText.includes(anchor));
  const artistMatch = anchors.length > 0 && matchingAnchors.length >= Math.ceil(anchors.length / 2);

  if (titleMatch && artistMatch) {
    return {
      status: "MATCHED_METADATA",
      detail: "Video title contains the catalog song title and enough catalog artist anchors.",
      titleMatch,
      artistMatch
    };
  }
  if ((titleMatch || artistMatch) && record.videoTitle) {
    return {
      status: "METADATA_INDICATION_ONLY",
      detail: "Only part of the catalog title/artist identity is present in the stored video title.",
      titleMatch,
      artistMatch
    };
  }
  return {
    status: "UNRESOLVED",
    detail: "Stored metadata does not establish the catalog title and artist identity.",
    titleMatch,
    artistMatch
  };
}

export function detectMetadataIndicators(record) {
  const fields = [record.videoTitle, record.channelTitle, record.description].filter(Boolean);
  const text = fields.join(" ");
  const matches = {};
  const labels = [];
  for (const indicator of INDICATORS) {
    if (indicator.pattern.test(text)) {
      matches[indicator.key] = true;
      labels.push(indicator.label);
    }
  }
  return { matches, labels, textAvailable: fields.length > 0 };
}

function technicalAssessment(record) {
  const valid = Boolean(
    record &&
    isValidVideoId(record.candidateVideoId) &&
    record.status === "verified" &&
    record.apiVerified === true &&
    record.embeddable === true &&
    record.madeForKids === false
  );
  return valid ? "VERIFIED" : "REVIEW_REQUIRED";
}

function evidence(type, claim, detail) {
  return { type, claim, detail };
}

function presentationAssessment(record) {
  const inspection = record?.presentationInspection;
  const hasRepresentativeEvidence = Boolean(
    inspection &&
    inspection.method === "representative-frames" &&
    Array.isArray(inspection.evidence) &&
    inspection.evidence.length > 0
  );
  if (!hasRepresentativeEvidence) {
    return {
      status: EVIDENCE_STATUS.UNRESOLVED,
      inspectionStatus: EVIDENCE_STATUS.NOT_PERFORMED,
      detail: "No representative playback-frame inspection was available; visual quality, lyric readability, synchronization, and resolution remain unresolved."
    };
  }
  const status = inspection.status === "strong"
    ? AUDIT_CLASSIFICATIONS.STRONG_EXPERIENCE
    : inspection.status === "acceptable"
      ? AUDIT_CLASSIFICATIONS.ACCEPTABLE
      : inspection.status === "issue"
        ? "ISSUE_CONFIRMED"
        : EVIDENCE_STATUS.UNRESOLVED;
  return {
    status,
    inspectionStatus: status === EVIDENCE_STATUS.UNRESOLVED ? EVIDENCE_STATUS.NOT_PERFORMED : "COMPLETED",
    detail: String(inspection.detail || "Representative playback frames were inspected.")
  };
}

function audioAssessment(record) {
  const inspection = record?.audioInspection;
  if (!inspection || inspection.method !== "playback-listening" || !Array.isArray(inspection.evidence) || inspection.evidence.length === 0) {
    return {
      status: EVIDENCE_STATUS.UNRESOLVED,
      inspectionStatus: EVIDENCE_STATUS.NOT_PERFORMED,
      detail: "This environment did not listen to the YouTube playback; key, pitch, speed, guide vocals, backing quality, and completeness remain unresolved."
    };
  }
  return {
    status: inspection.status === "acceptable" ? EVIDENCE_STATUS.VERIFIED : "ISSUE_CONFIRMED",
    inspectionStatus: "COMPLETED",
    detail: String(inspection.detail || "Playback listening evidence was recorded.")
  };
}

function overallClassification({ technicalStatus, identityStatus, indicators, duplicateVideoId, song, presentation, audio }) {
  if (presentation.status === "ISSUE_CONFIRMED") return AUDIT_CLASSIFICATIONS.REVIEW_VISUAL;
  if (technicalStatus !== "VERIFIED" || duplicateVideoId || identityStatus !== "MATCHED_METADATA") return AUDIT_CLASSIFICATIONS.REVIEW_LISTENING;
  if (Object.keys(indicators.matches).some((key) => HARD_REVIEW_KEYS.has(key))) return AUDIT_CLASSIFICATIONS.REVIEW_LISTENING;
  if (!song) return AUDIT_CLASSIFICATIONS.REVIEW_LISTENING;
  if (presentation.status === AUDIT_CLASSIFICATIONS.STRONG_EXPERIENCE && audio.status === EVIDENCE_STATUS.VERIFIED) return AUDIT_CLASSIFICATIONS.STRONG_EXPERIENCE;
  if (presentation.status === AUDIT_CLASSIFICATIONS.ACCEPTABLE && audio.status === EVIDENCE_STATUS.VERIFIED) return AUDIT_CLASSIFICATIONS.ACCEPTABLE;
  return AUDIT_CLASSIFICATIONS.AUDIO_UNRESOLVED;
}

function recommendationsFor(classification, row) {
  if (classification === AUDIT_CLASSIFICATIONS.REPLACEMENT_FOUND) return "Replace only with the recorded verified candidate after an atomic catalog write.";
  if (classification === AUDIT_CLASSIFICATIONS.NO_SAFE_REPLACEMENT) return "Remove from production only after preserving history; continue candidate review.";
  if (classification === AUDIT_CLASSIFICATIONS.REVIEW_LISTENING) return "Human review (listening) required before treating this assignment as production-quality.";
  if (classification === AUDIT_CLASSIFICATIONS.REVIEW_VISUAL) return "Human review (visual inspection) required before treating this assignment as production-quality.";
  return row.audioQualityStatus === EVIDENCE_STATUS.UNRESOLVED
    ? "Listen to the official embed and record playback findings before production sign-off."
    : "No further action indicated by stored metadata.";
}

export function validateReplacement({
  oldVideoId,
  newCandidate,
  replacementReason,
  comparisonEvidence = [],
  identityEvidence = [],
  visualEvidence = [],
  audioEvidence = [],
  visualInspectionPerformed = false,
  knownMusicalRegression = false,
  existingVideoIds = []
} = {}) {
  const errors = [];
  const reason = typeof replacementReason === "string" ? replacementReason.trim() : "";
  const newVideoId = newCandidate?.candidateVideoId?.trim();
  if (!isValidVideoId(oldVideoId)) errors.push("old video ID is invalid");
  if (!reason) errors.push("replacement reason is required");
  if (!Array.isArray(comparisonEvidence) || comparisonEvidence.length === 0) errors.push("evidence that the replacement is superior is required");
  if (!Array.isArray(identityEvidence) || identityEvidence.length === 0) errors.push("strict song/artist identity evidence is required");
  if (visualInspectionPerformed !== true || !Array.isArray(visualEvidence) || visualEvidence.length === 0) errors.push("representative visual inspection evidence is required");
  if (!Array.isArray(audioEvidence) || audioEvidence.length === 0) errors.push("musical/version evidence is required");
  if (knownMusicalRegression === true) errors.push("replacement has a known musical or version regression");
  if (!isValidVideoId(newVideoId)) errors.push("replacement video ID is invalid");
  if (newVideoId && newVideoId === oldVideoId) errors.push("replacement must use a different video ID");
  if (newCandidate?.status !== "verified") errors.push("replacement candidate is not verified");
  if (newCandidate?.apiVerified !== true) errors.push("replacement candidate lacks API verification");
  if (newCandidate?.embeddable !== true) errors.push("replacement candidate is not embeddable");
  if (newCandidate?.madeForKids !== false) errors.push("replacement candidate has an unacceptable Made-for-Kids status");
  if (!newCandidate?.verifiedAt) errors.push("replacement candidate has no verification timestamp");
  if (newVideoId && existingVideoIds.some((videoId) => videoId === newVideoId && videoId !== oldVideoId)) errors.push("replacement video ID is already assigned to another song");
  return { allowed: errors.length === 0, errors };
}

export function auditPromotedAssignments(catalog, verificationStore, options = {}) {
  const songs = Array.isArray(catalog) ? catalog : [];
  const records = Array.isArray(verificationStore?.records) ? verificationStore.records : [];
  const bySongId = new Map(songs.map((song) => [String(song?.id || "").toLowerCase(), song]));
  const promotedRecords = records.filter((record) => (
    record?.status === "verified" &&
    isValidVideoId(record?.candidateVideoId) &&
    bySongId.has(String(record?.songId || "").toLowerCase())
  ));
  const videoOwners = new Map();
  for (const record of promotedRecords) {
    const videoId = record.candidateVideoId.trim();
    const owners = videoOwners.get(videoId) || [];
    owners.push(record.songId || null);
    videoOwners.set(videoId, owners);
  }

  const rows = promotedRecords.map((record) => {
    const catalogId = String(record.songId || "");
    const song = bySongId.get(catalogId.toLowerCase());
    const metadata = detectMetadataIndicators(record);
    const identity = identityAssessment(song, record);
    const technicalStatus = technicalAssessment(record);
    const audio = audioAssessment(record);
    const presentation = presentationAssessment(record);
    const removedByProductQuality = record.unassignmentProvenance === "user-product-quality-decision";
    const duplicateVideoId = (videoOwners.get(record.candidateVideoId.trim()) || []).length > 1;
    const assignmentState = removedByProductQuality && song?.youtubeVideoId == null
      ? "UNASSIGNED_BY_PRODUCT_QUALITY_DECISION"
      : song?.youtubeVideoId === record.candidateVideoId
        ? "PUBLIC_CATALOG"
      : song?.youtubeVideoId == null
          ? "PERSISTED_NOT_YET_PUBLIC"
          : "CATALOG_ID_MISMATCH";
    const keyIndicator = metadata.matches.alteredKey || metadata.matches.genderKey;
    const keyStatus = keyIndicator ? "ALTERED KEY INDICATOR" : "NO ALTERED-KEY INDICATOR FOUND";
    const hasKaraokeWording = POSITIVE_KARAOKE_PATTERN.test([record.videoTitle, record.channelTitle, record.description].filter(Boolean).join(" "));
    const karaokeSuitabilityStatus = metadata.matches.lyricsOnly || metadata.matches.originalAudio || metadata.matches.guideVocal
      ? "REVIEW_REQUIRED"
      : hasKaraokeWording ? "METADATA INDICATION ONLY" : "UNRESOLVED";
    const classification = overallClassification({
      technicalStatus,
      identityStatus: identity.status,
      indicators: metadata,
      duplicateVideoId,
      song,
      presentation,
      audio
    });
    const previousRow = options.previousReport?.assignments?.find((item) => item.catalogId?.toLowerCase() === catalogId.toLowerCase());
    const replacementHistory = Array.isArray(previousRow?.replacementHistory) ? previousRow.replacementHistory : [];
    const previousVideoId = previousRow && previousRow.currentVideoId && previousRow.currentVideoId !== record.candidateVideoId
      ? previousRow.currentVideoId
      : previousRow?.previousVideoId || null;
    const flaggedInvestigation = FLAGGED_INVESTIGATIONS[catalogId] || previousRow?.flaggedInvestigation || null;
    const remainingUncertainty = [
      "original/standard key",
      "pitch and speed",
      "instrumental quality and guide vocals",
      "audio quality",
      "completeness and arrangement",
      "lyric readability and synchronization",
      "presentation quality and apparent resolution"
    ];
    if (song?.performanceType === "duet") remainingUncertainty.push("intended duet parts and arrangement");
    const reasons = [];
    if (assignmentState === "UNASSIGNED_BY_PRODUCT_QUALITY_DECISION") reasons.push(`Public assignment was intentionally removed: ${record.unassignmentReason || "recorded user product-quality decision"}.`);
    if (assignmentState === "PERSISTED_NOT_YET_PUBLIC") reasons.push("Persisted verified assignment is not yet present in the public catalog.");
    if (assignmentState === "CATALOG_ID_MISMATCH") reasons.push("Catalog contains a different video ID for this song.");
    if (duplicateVideoId) reasons.push("Video ID is assigned to more than one catalog song.");
    if (identity.status !== "MATCHED_METADATA") reasons.push(`Identity metadata is ${identity.status.toLowerCase().replaceAll("_", " ")}; confirm the intended song and artist before sign-off.`);
    if (metadata.labels.length > 0) reasons.push(`Metadata indicators: ${metadata.labels.join(", ")}.`);
    if (hasKaraokeWording) reasons.push("Video metadata includes karaoke/instrumental wording; this does not prove audio quality.");
    if (!record.description || !record.duration) reasons.push("Description and duration evidence are not present in the persisted verification record.");
    reasons.push(audio.detail);
    reasons.push(presentation.detail);

    const row = {
      catalogId,
      songTitle: song?.title || record.catalogTitle || null,
      artist: song?.artist || record.catalogArtist || null,
      currentVideoId: record.candidateVideoId,
      videoId: record.candidateVideoId,
      publicCatalogVideoId: song?.youtubeVideoId || null,
      previousVideoId,
      assignmentState,
      productQualityStatus: removedByProductQuality ? "REMOVED BY USER PRODUCT-QUALITY DECISION" : "NOT_REMOVED",
      unassignmentReason: removedByProductQuality ? record.unassignmentReason || null : null,
      unassignedAt: removedByProductQuality ? record.unassignedAt || null : null,
      unassignmentProvenance: removedByProductQuality ? record.unassignmentProvenance : null,
      verificationProvenance: record.provenance || (record.manuallyMatched ? "legacy-record-with-manual-approval" : "unclassified-persisted-record"),
      technicalStatus,
      identityStatus: identity.status,
      karaokeSuitabilityStatus,
      keyStatus,
      pitchSpeedStatus: "UNRESOLVED",
      vocalInstrumentalStatus: metadata.matches.guideVocal ? "GUIDE-VOCAL INDICATOR" : "UNRESOLVED",
      instrumentalVocalStatus: metadata.matches.guideVocal ? "GUIDE-VOCAL INDICATOR" : "UNRESOLVED",
      versionArrangementStatus: metadata.labels.length > 0 ? "REVIEW_REQUIRED" : "NO METADATA RED FLAG FOUND",
      arrangementStatus: metadata.labels.length > 0 ? "REVIEW_REQUIRED" : "UNRESOLVED",
      completenessStatus: metadata.matches.partOnly || metadata.matches.shortened || metadata.matches.medley ? "REVIEW_REQUIRED" : "UNRESOLVED",
      audioQualityStatus: audio.status,
      audioInspectionStatus: audio.inspectionStatus,
      presentationQualityStatus: presentation.status,
      visualInspectionStatus: presentation.inspectionStatus,
      presentationQualityDetail: presentation.detail,
      duetSuitability: song?.performanceType === "duet" ? "UNRESOLVED" : "NOT_APPLICABLE",
      overallAuditClassification: classification,
      replacementAction: removedByProductQuality ? "UNASSIGNED_BY_PRODUCT_QUALITY_DECISION" : "NONE",
      replacementReason: null,
      replacementHistory,
      flaggedInvestigation,
      remainingUncertainty,
      evidence: [
        evidence("FACT", "Video ID and technical gate state", `Persisted record says status=${record.status}, apiVerified=${record.apiVerified}, embeddable=${record.embeddable}, madeForKids=${record.madeForKids}.`),
        ...(removedByProductQuality ? [evidence("QUALITY DECISION", "Public assignment status", `The technically valid video was intentionally unassigned by a user product-quality decision: ${record.unassignmentReason || "reason not recorded"}.`)] : []),
        evidence(identity.status === "MATCHED_METADATA" ? "METADATA INDICATION" : "UNRESOLVED", "Song identity", identity.detail),
        evidence(hasKaraokeWording ? "METADATA INDICATION" : "UNRESOLVED", "Karaoke suitability", hasKaraokeWording ? "Stored title/channel metadata contains karaoke or instrumental wording." : "No karaoke wording is available in the stored metadata."),
        evidence(keyIndicator ? "METADATA INDICATION" : "UNRESOLVED", "Original key", keyIndicator ? "Stored metadata contains an altered-key indicator." : "No altered-key indicator was found; original key is not confirmed."),
        evidence(audio.status === EVIDENCE_STATUS.UNRESOLVED ? "UNRESOLVED" : "PLAYBACK EVIDENCE", "Audio quality", audio.detail),
        evidence(presentation.status === EVIDENCE_STATUS.UNRESOLVED ? "UNRESOLVED" : "VISUAL EVIDENCE", "Presentation quality", presentation.detail),
        evidence("UNRESOLVED", "Completeness and arrangement", "Stored verification data does not establish full length, arrangement, or absence of a medley."),
        ...(song?.performanceType === "duet" ? [evidence("UNRESOLVED", "Duet arrangement", "The intended duet parts were not verified by listening.")] : [])
      ],
      evidenceReasons: reasons,
      recommendedAction: recommendationsFor(classification, { audioQualityStatus: audio.status }),
      source: {
        videoTitle: record.videoTitle || null,
        channelTitle: record.channelTitle || null,
        descriptionAvailable: Boolean(record.description),
        durationAvailable: Boolean(record.duration)
      }
    };
    return row;
  }).sort((left, right) => left.catalogId.localeCompare(right.catalogId, undefined, { numeric: true }));

  const counts = {
    [AUDIT_CLASSIFICATIONS.STRONG_EXPERIENCE]: rows.filter((row) => row.overallAuditClassification === AUDIT_CLASSIFICATIONS.STRONG_EXPERIENCE).length,
    [AUDIT_CLASSIFICATIONS.ACCEPTABLE]: rows.filter((row) => row.overallAuditClassification === AUDIT_CLASSIFICATIONS.ACCEPTABLE).length,
    [AUDIT_CLASSIFICATIONS.AUDIO_UNRESOLVED]: rows.filter((row) => row.overallAuditClassification === AUDIT_CLASSIFICATIONS.AUDIO_UNRESOLVED).length,
    [AUDIT_CLASSIFICATIONS.VISUAL_UNRESOLVED]: rows.filter((row) => row.overallAuditClassification === AUDIT_CLASSIFICATIONS.VISUAL_UNRESOLVED).length,
    [AUDIT_CLASSIFICATIONS.REVIEW_LISTENING]: rows.filter((row) => row.overallAuditClassification === AUDIT_CLASSIFICATIONS.REVIEW_LISTENING).length,
    [AUDIT_CLASSIFICATIONS.REVIEW_VISUAL]: rows.filter((row) => row.overallAuditClassification === AUDIT_CLASSIFICATIONS.REVIEW_VISUAL).length,
    [AUDIT_CLASSIFICATIONS.REPLACEMENT_FOUND]: rows.filter((row) => row.overallAuditClassification === AUDIT_CLASSIFICATIONS.REPLACEMENT_FOUND).length,
    [AUDIT_CLASSIFICATIONS.NO_SAFE_REPLACEMENT]: rows.filter((row) => row.overallAuditClassification === AUDIT_CLASSIFICATIONS.NO_SAFE_REPLACEMENT).length
  };
  const duplicateVideoIds = [...videoOwners.entries()].filter(([, owners]) => owners.length > 1).map(([videoId, owners]) => ({ videoId, songIds: owners }));
  const unassignedSongs = songs.filter((song) => !song?.youtubeVideoId).map((song) => song.id).filter(Boolean);
  const qualityUnassignments = rows.filter((row) => row.productQualityStatus === "REMOVED BY USER PRODUCT-QUALITY DECISION").map((row) => ({
    catalogId: row.catalogId,
    songTitle: row.songTitle,
    artist: row.artist,
    oldVideoId: row.currentVideoId,
    oldTitle: row.source.videoTitle,
    oldChannel: row.source.channelTitle,
    previousProvenance: row.verificationProvenance,
    reason: row.unassignmentReason,
    unassignedAt: row.unassignedAt,
    unassignmentProvenance: row.unassignmentProvenance
  }));
  return {
    version: AUDIT_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    scope: "Persisted verified YouTube assignments; identity, karaoke metadata, audio evidence, presentation evidence, public catalog state, and replacement history are recorded per row.",
    auditedCount: rows.length,
    counts,
    inspectionSummary: {
      visualInspectedCount: rows.filter((row) => row.visualInspectionStatus === "COMPLETED").length,
      visualUnresolvedCount: rows.filter((row) => row.presentationQualityStatus === EVIDENCE_STATUS.UNRESOLVED).length,
      audioListenedCount: rows.filter((row) => row.audioInspectionStatus === "COMPLETED").length,
      audioUnresolvedCount: rows.filter((row) => row.audioQualityStatus === EVIDENCE_STATUS.UNRESOLVED).length,
      presentationQuality: rows.every((row) => row.presentationQualityStatus === EVIDENCE_STATUS.UNRESOLVED) ? "UNRESOLVED" : "MIXED"
    },
    unassignedCatalogSongIds: unassignedSongs,
    qualityUnassignments,
    qualityUnassignmentCount: qualityUnassignments.length,
    limitations: {
      playbackAvailable: false,
      visualInspectionAvailable: false,
      apiRequestsMade: 0,
      message: "This audit did not listen to YouTube playback, inspect representative video frames, or make network requests. Audio and presentation quality remain unresolved unless explicit, separately recorded evidence is present."
    },
    duplicateVideoIds,
    replacementHistory: Array.isArray(options.previousReport?.replacementHistory) ? options.previousReport.replacementHistory : [],
    replacementsMade: 0,
    assignments: rows
  };
}

function tableValue(value) {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderMarkdownReport(report) {
  const lines = [
    "# KantaCue YouTube Quality Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Audited assignments: ${report.auditedCount}`,
    `${AUDIT_CLASSIFICATIONS.STRONG_EXPERIENCE}: ${report.counts[AUDIT_CLASSIFICATIONS.STRONG_EXPERIENCE]} · ${AUDIT_CLASSIFICATIONS.ACCEPTABLE}: ${report.counts[AUDIT_CLASSIFICATIONS.ACCEPTABLE]} · ${AUDIT_CLASSIFICATIONS.AUDIO_UNRESOLVED}: ${report.counts[AUDIT_CLASSIFICATIONS.AUDIO_UNRESOLVED]} · ${AUDIT_CLASSIFICATIONS.VISUAL_UNRESOLVED}: ${report.counts[AUDIT_CLASSIFICATIONS.VISUAL_UNRESOLVED]} · ${AUDIT_CLASSIFICATIONS.REVIEW_LISTENING}: ${report.counts[AUDIT_CLASSIFICATIONS.REVIEW_LISTENING]} · ${AUDIT_CLASSIFICATIONS.REVIEW_VISUAL}: ${report.counts[AUDIT_CLASSIFICATIONS.REVIEW_VISUAL]} · ${AUDIT_CLASSIFICATIONS.REPLACEMENT_FOUND}: ${report.counts[AUDIT_CLASSIFICATIONS.REPLACEMENT_FOUND]} · ${AUDIT_CLASSIFICATIONS.NO_SAFE_REPLACEMENT}: ${report.counts[AUDIT_CLASSIFICATIONS.NO_SAFE_REPLACEMENT]}`,
    "",
    `Visual frames inspected: ${report.inspectionSummary.visualInspectedCount} · Audio-listened: ${report.inspectionSummary.audioListenedCount} · Presentation quality: ${report.inspectionSummary.presentationQuality}`,
    `Unassigned catalog songs: ${report.unassignedCatalogSongIds.length}`,
    `Removed by user product-quality decision: ${report.qualityUnassignmentCount}`,
    "",
    `Limitation: ${report.limitations.message}`,
    "",
    "| Catalog ID | Song | Artist | Current video | Public catalog video | Previous video | Provenance | Product decision | Identity | Technical | Karaoke | Key | Audio | Presentation | Pitch/speed | Instrumental/vocal | Arrangement | Completeness | Duet | Overall | Replacement action | Remaining uncertainty |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const row of report.assignments) {
    lines.push(`| ${tableValue(row.catalogId)} | ${tableValue(row.songTitle)} | ${tableValue(row.artist)} | ${tableValue(row.currentVideoId)} | ${tableValue(row.publicCatalogVideoId)} | ${tableValue(row.previousVideoId)} | ${tableValue(row.verificationProvenance)} | ${tableValue(row.productQualityStatus)} | ${tableValue(row.identityStatus)} | ${tableValue(row.technicalStatus)} | ${tableValue(row.karaokeSuitabilityStatus)} | ${tableValue(row.keyStatus)} | ${tableValue(row.audioQualityStatus)} | ${tableValue(row.presentationQualityStatus)} | ${tableValue(row.pitchSpeedStatus)} | ${tableValue(row.instrumentalVocalStatus)} | ${tableValue(row.arrangementStatus)} | ${tableValue(row.completenessStatus)} | ${tableValue(row.duetSuitability)} | ${tableValue(row.overallAuditClassification)} | ${tableValue(row.replacementAction)} | ${tableValue(row.remainingUncertainty.join(", "))} |`);
  }
  if (report.qualityUnassignments.length > 0) {
    lines.push("", "## Removed by user product-quality decision", "", "| Catalog ID | Song | Artist | Old video ID | Old title | Old channel | Previous provenance | Reason | Unassigned at |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    report.qualityUnassignments.forEach((item) => lines.push(`| ${tableValue(item.catalogId)} | ${tableValue(item.songTitle)} | ${tableValue(item.artist)} | ${tableValue(item.oldVideoId)} | ${tableValue(item.oldTitle)} | ${tableValue(item.oldChannel)} | ${tableValue(item.previousProvenance)} | ${tableValue(item.reason)} | ${tableValue(item.unassignedAt)} |`));
  }
  const flaggedRows = report.assignments.filter((row) => row.flaggedInvestigation);
  if (flaggedRows.length > 0) {
    lines.push("", "## Flagged-assignment investigations", "");
    for (const row of flaggedRows) {
      const investigation = row.flaggedInvestigation;
      lines.push(
        `### ${tableValue(row.catalogId)} — ${tableValue(row.songTitle)} — ${tableValue(row.artist)}`,
        `- Current video: \`${tableValue(row.currentVideoId)}\``,
        `- Warning: ${tableValue(investigation.currentWarning)}`,
        `- Identity result: ${tableValue(investigation.identityResult)}`,
        `- Karaoke metadata result: ${tableValue(investigation.karaokeMetadataResult)}`,
        `- Key evidence: ${tableValue(investigation.keyEvidence)}`,
        `- Version evidence: ${tableValue(investigation.versionEvidence)}`,
        `- Technical verification: ${tableValue(investigation.technicalVerification)}`,
        `- Decision: **${tableValue(investigation.decision)}**`,
        `- Reason: ${tableValue(investigation.exactReason)}`,
        `- Remaining uncertainty: ${tableValue(investigation.remainingUncertainty.join(", "))}`,
        "- Alternatives considered:",
        ...investigation.alternativeCandidatesConsidered.map((candidate) => `  - \`${candidate.videoId}\` — ${tableValue(candidate.title)} — ${tableValue(candidate.channel)}. ${tableValue(candidate.result)}`),
        ""
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function parseArguments(argv) {
  const options = {
    catalog: DEFAULT_CATALOG_PATH,
    verification: DEFAULT_VERIFICATION_PATH,
    output: DEFAULT_OUTPUT_PATH,
    markdown: DEFAULT_MARKDOWN_PATH,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--catalog") options.catalog = requireValue(argv, ++index, argument);
    else if (argument === "--verification" || argument === "--file") options.verification = requireValue(argv, ++index, argument);
    else if (argument === "--output") options.output = requireValue(argv, ++index, argument);
    else if (argument === "--markdown") options.markdown = requireValue(argv, ++index, argument);
    else throw new Error(`Unknown option "${argument}". Use --help for usage.`);
  }
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

export async function runAudit(options) {
  const catalog = JSON.parse(await readFile(options.catalog, "utf8"));
  const verification = JSON.parse(await readFile(options.verification, "utf8"));
  let previousReport = null;
  try {
    previousReport = JSON.parse(await readFile(options.output, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const report = auditPromotedAssignments(catalog, verification, { previousReport });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(options.markdown, renderMarkdownReport(report), "utf8");
  console.log(`Audited ${report.auditedCount} persisted verified assignments.`);
  console.log(`${AUDIT_CLASSIFICATIONS.STRONG_EXPERIENCE}: ${report.counts[AUDIT_CLASSIFICATIONS.STRONG_EXPERIENCE]}`);
  console.log(`${AUDIT_CLASSIFICATIONS.ACCEPTABLE}: ${report.counts[AUDIT_CLASSIFICATIONS.ACCEPTABLE]}`);
  console.log(`${AUDIT_CLASSIFICATIONS.AUDIO_UNRESOLVED}: ${report.counts[AUDIT_CLASSIFICATIONS.AUDIO_UNRESOLVED]}`);
  console.log(`${AUDIT_CLASSIFICATIONS.VISUAL_UNRESOLVED}: ${report.counts[AUDIT_CLASSIFICATIONS.VISUAL_UNRESOLVED]}`);
  console.log(`${AUDIT_CLASSIFICATIONS.REVIEW_LISTENING}: ${report.counts[AUDIT_CLASSIFICATIONS.REVIEW_LISTENING]}`);
  console.log(`${AUDIT_CLASSIFICATIONS.REVIEW_VISUAL}: ${report.counts[AUDIT_CLASSIFICATIONS.REVIEW_VISUAL]}`);
  console.log(`${AUDIT_CLASSIFICATIONS.REPLACEMENT_FOUND}: ${report.counts[AUDIT_CLASSIFICATIONS.REPLACEMENT_FOUND]}`);
  console.log(`${AUDIT_CLASSIFICATIONS.NO_SAFE_REPLACEMENT}: ${report.counts[AUDIT_CLASSIFICATIONS.NO_SAFE_REPLACEMENT]}`);
  console.log(`Visual frames inspected: ${report.inspectionSummary.visualInspectedCount}`);
  console.log(`Audio-listened assignments: ${report.inspectionSummary.audioListenedCount}`);
  console.log(`Removed by user product-quality decision: ${report.qualityUnassignmentCount}`);
  console.log(`JSON report: ${options.output}`);
  console.log(`Markdown report: ${options.markdown}`);
  console.log("No network requests were made; playback/listening claims remain unresolved.");
  return report;
}

function printUsage() {
  console.log([
    "KantaCue local YouTube quality audit",
    "",
    "Usage:",
    "  node tools/audit-youtube.mjs",
    "  node tools/audit-youtube.mjs --catalog data/songs.sample.json --verification tools/youtube-verification.json",
    "",
    "The audit reads persisted metadata only. It never searches YouTube, calls the API, downloads media, changes the catalog, or promotes IDs.",
    "It separates metadata indications from unresolved playback/listening checks."
  ].join("\n"));
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) return printUsage();
  return runAudit(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}
