#!/usr/bin/env node

/**
 * Development-only production assignment audit and explicit decision application.
 *
 * This command searches and technically checks alternatives for already
 * promoted catalog songs. Discovery remains read-only. Replacements are only
 * applied through an explicit, reviewed decision file whose candidates must
 * already have passed the persisted technical and ranking gates.
 */

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  isValidVideoId,
  normalizeVerificationStore,
  PARTY_TYME_CHANNEL_PATTERN,
  rankSearchCandidates,
  requestSearchResults,
  requestVideoBatch,
  atomicWriteJson
} from "./verify-youtube.mjs";
import { normalizeCatalog } from "../src/catalog.js";

export const DEFAULT_CATALOG_PATH = "data/songs.sample.json";
export const DEFAULT_VERIFICATION_PATH = "tools/youtube-verification.json";
export const DEFAULT_DEMAND_PATH = "data/song-demand.json";
export const DEFAULT_OUTPUT_PATH = "tools/youtube-production-audit.json";
export const DEFAULT_MARKDOWN_PATH = "tools/youtube-production-audit.md";
export const DEFAULT_REVIEW_PATH = "tools/youtube-review.json";
export const DEFAULT_DECISIONS_PATH = "tools/youtube-production-decisions.json";
export const DEFAULT_FIRST_ID = 101;
export const DEFAULT_LAST_ID = 145;
export const DEFAULT_QUERY_COUNT = 3;
export const DEFAULT_MAX_RESULTS = 5;

const VIDEO_BATCH_SIZE = 50;
const SEARCH_QUERY_BUILDERS = [
  (song) => `${song.title} ${song.artist} karaoke`,
  (song) => `${song.title} ${song.artist} karaoke version`,
  (song) => `${song.title} ${song.artist} HD karaoke`
];

export async function auditProductionAssignments(options = {}, dependencies = {}) {
  const catalogPath = options.catalog || DEFAULT_CATALOG_PATH;
  const verificationPath = options.verification || DEFAULT_VERIFICATION_PATH;
  const demandPath = options.demand || DEFAULT_DEMAND_PATH;
  const outputPath = options.output || DEFAULT_OUTPUT_PATH;
  const markdownPath = options.markdown || DEFAULT_MARKDOWN_PATH;
  const catalog = normalizeCatalog(JSON.parse(await readFile(catalogPath, "utf8")), { logger: { warn() {} } }).songs;
  const verification = normalizeVerificationStore(JSON.parse(await readFile(verificationPath, "utf8")), { tolerateMalformed: true });
  const demand = await readDemand(demandPath);
  const firstId = Number.isInteger(options.firstId) ? options.firstId : DEFAULT_FIRST_ID;
  const lastId = Number.isInteger(options.lastId) ? options.lastId : DEFAULT_LAST_ID;
  const requestedSongIds = Array.isArray(options.songIds) && options.songIds.length > 0 ? new Set(options.songIds.map((id) => id.toLowerCase())) : null;
  const queryCount = clampInteger(options.queryCount ?? DEFAULT_QUERY_COUNT, 1, SEARCH_QUERY_BUILDERS.length);
  const maxResults = clampInteger(options.maxResults ?? DEFAULT_MAX_RESULTS, 1, 5);
  const songs = catalog.filter((song) => {
    const numericId = Number(String(song.id).replace(/^sample-/, ""));
    return numericId >= firstId && numericId <= lastId && isValidVideoId(song.youtubeVideoId) && (!requestedSongIds || requestedSongIds.has(song.id.toLowerCase()));
  });
  const recordsByKey = new Map(verification.records.map((record) => [`${record.songId || ""}::${record.candidateVideoId || ""}`, record]));
  const fetchImplementation = dependencies.fetchImplementation || fetch;
  const apiKey = dependencies.apiKey || getApiKey();
  const searchUrl = dependencies.searchApiUrl || "https://www.googleapis.com/youtube/v3/search";
  const videoUrl = dependencies.videoApiUrl || "https://www.googleapis.com/youtube/v3/videos";
  const requestConfig = { ...(dependencies.requestConfig || {}), videoDefinition: "high" };
  const searchCache = new Map();
  const searchErrors = [];
  const candidateRows = [];
  const candidateIds = new Set(songs.map((song) => song.youtubeVideoId));
  let quotaExhausted = false;

  for (const song of songs) {
    const seen = new Set();
    const candidates = [];
    for (const buildQuery of SEARCH_QUERY_BUILDERS.slice(0, queryCount)) {
      const query = normalizeQuery(buildQuery(song));
      const cacheKey = query.toLowerCase();
      try {
        let results = searchCache.get(cacheKey);
        if (!results) {
          results = await requestSearchResults(query, maxResults, apiKey, fetchImplementation, searchUrl, requestConfig);
          searchCache.set(cacheKey, results);
        }
        results.forEach((candidate) => {
          if (!candidate.videoId || seen.has(candidate.videoId)) return;
          seen.add(candidate.videoId);
          candidateIds.add(candidate.videoId);
          candidates.push({ ...candidate, query });
        });
      } catch (error) {
        searchErrors.push({ songId: song.id, query, error: error.message, quota: error.quotaExhausted === true });
        if (error.quotaExhausted) {
          quotaExhausted = true;
          break;
        }
      }
    }
    candidateRows.push({ song, candidates });
    if (quotaExhausted) break;
  }

  const technicalById = new Map();
  const technicalIds = [...candidateIds];
  const checkedAt = new Date().toISOString();
  const videoErrors = [];
  for (let index = 0; index < technicalIds.length; index += VIDEO_BATCH_SIZE) {
    const batch = technicalIds.slice(index, index + VIDEO_BATCH_SIZE);
    try {
      const records = await requestVideoBatch(batch, apiKey, checkedAt, fetchImplementation, videoUrl, requestConfig);
      records.forEach((record) => technicalById.set(record.candidateVideoId, record));
    } catch (error) {
      videoErrors.push({ ids: batch, error: error.message, quota: error.quotaExhausted === true });
      if (error.quotaExhausted) break;
    }
  }

  const assignments = songs.map((song) => {
    const currentRecord = technicalById.get(song.youtubeVideoId) || recordsByKey.get(`${song.id}::${song.youtubeVideoId}`) || { candidateVideoId: song.youtubeVideoId };
    const current = enrichTechnicalCandidate(currentRecord, song.youtubeVideoId);
    const row = candidateRows.find((item) => item.song.id === song.id) || { candidates: [] };
    const comparisonCandidates = [
      current,
      ...row.candidates.map((candidate) => ({ ...candidate, ...(technicalById.get(candidate.videoId) || {}) }))
    ].filter((candidate, index, all) => all.findIndex((item) => item.videoId === candidate.videoId) === index);
    const ranked = rankSearchCandidates(song, comparisonCandidates);
    const currentRank = ranked.find((candidate) => candidate.videoId === song.youtubeVideoId) || null;
    const technicalCandidates = ranked.filter((candidate) => candidate.videoId !== song.youtubeVideoId).map((candidate) => ({
      ...candidate,
      technical: technicalStatus(technicalById.get(candidate.videoId)),
      hdStatus: exactHdStatus(technicalById.get(candidate.videoId)),
      automaticEligible: isSafeAlternative(candidate, technicalById.get(candidate.videoId))
    }));
    const alternatives = technicalCandidates;
    const safeAlternatives = alternatives.filter((candidate) => candidate.automaticEligible);
    const bestAlternative = safeAlternatives[0] || null;
    const currentTechnical = technicalStatus(currentRecord);
    const assignmentSearchErrors = searchErrors.filter((error) => error.songId === song.id);
    const currentHardIssue = currentRank?.hardBlocked === true || PARTY_TYME_CHANNEL_PATTERN.test(current.channelTitle || "") || currentTechnical !== "PASS";
    const materiallyBetter = Boolean(bestAlternative && currentRank && bestAlternative.score >= currentRank.score + 12);
    let decision = "KEEP — NO CLEARER SAFE REPLACEMENT";
    if (currentHardIssue) decision = "REVIEW — CURRENT ASSIGNMENT HAS A HARD METADATA/TECHNICAL WARNING";
    else if (materiallyBetter) decision = "REVIEW — POSSIBLE SUPERIOR CANDIDATE; NO AUTOMATIC REPLACEMENT";
    if (assignmentSearchErrors.length > 0) decision = "REVIEW — SEARCH INCOMPLETE (API ERROR)";
    const demandSignal = demand.get(song.id) || null;
    return {
      songId: song.id,
      catalogTitle: song.title,
      catalogArtist: song.artist,
      demandTier: demandSignal?.demandTier || null,
      demandRank: demandSignal?.rank || null,
      currentVideoId: song.youtubeVideoId,
      current: summarizeCandidate(current, currentRank, currentRecord),
      alternatives: alternatives.slice(0, maxResults).map((candidate) => ({
        ...summarizeCandidate(candidate, candidate, technicalById.get(candidate.videoId)),
        query: candidate.query || null,
        automaticEligible: candidate.automaticEligible
      })),
      bestSafeAlternative: bestAlternative ? {
        ...summarizeCandidate(bestAlternative, bestAlternative, technicalById.get(bestAlternative.videoId)),
        automaticEligible: true
      } : null,
      decision,
      replacementApplied: false,
      searchErrors: assignmentSearchErrors,
      replacementReason: assignmentSearchErrors.length > 0
        ? "One or more discovery queries failed; rerun the read-only audit before making a quality decision."
        : currentHardIssue
        ? "No replacement was applied: API metadata cannot prove audio arrangement, exact key, completeness, or visual presentation."
        : materiallyBetter
          ? "A metadata-based alternative scored higher, but replacement requires human playback comparison and explicit quality evidence."
          : "Current assignment remains the safer choice on available evidence.",
      visualInspection: "UNVERIFIED",
      audioInspection: "UNVERIFIED",
      exact1080p: "UNVERIFIED"
    };
  });

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    scope: { firstId, lastId, songIds: requestedSongIds ? [...requestedSongIds] : null, auditedCount: songs.length, queryCount, maxResults },
    methodology: {
      search: "YouTube Data API search.list with type=video, videoEmbeddable=true, videoDefinition=high; ranking applies correctness and hard safety gates first, then HD metadata, provider evidence, and bounded age-aware view popularity. Like counts are retained as supplementary evidence when available.",
      technicalVerification: "YouTube Data API videos.list is authoritative for existence, embeddability, Made-for-Kids, definition, duration, publication, view count, and like count when available.",
      limitations: "The API does not prove the actual backing arrangement, key, guide vocals, completeness, or rendered resolution. No exact 1080p claim is made; no playback media was downloaded.",
      mutationPolicy: "Read-only audit. No catalog IDs, verification approvals, candidates, or promotions were changed."
    },
    assignments,
    errors: { search: searchErrors, video: videoErrors, quotaExhausted },
    summary: summarize(assignments, searchErrors, videoErrors)
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(report), "utf8");
  printReport(report);
  return report;
}

export async function rerankProductionAuditReport(reportPath = DEFAULT_OUTPUT_PATH, options = {}) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (!Array.isArray(report.assignments)) throw new Error("Production audit report has no assignments array.");
  const assignments = report.assignments.map((row) => {
    const song = { title: row.catalogTitle, artist: row.catalogArtist };
    const currentCandidate = reportCandidate(row.current, row.currentVideoId);
    const candidates = [currentCandidate, ...(Array.isArray(row.alternatives) ? row.alternatives.map((candidate) => reportCandidate(candidate, candidate.videoId)) : [])]
      .filter((candidate, index, all) => all.findIndex((item) => item.videoId === candidate.videoId) === index);
    const ranked = rankSearchCandidates(song, candidates);
    const currentRank = ranked.find((candidate) => candidate.videoId === row.currentVideoId) || null;
    const currentRecord = reportTechnicalRecord(currentCandidate);
    const alternatives = ranked.filter((candidate) => candidate.videoId !== row.currentVideoId).map((candidate) => ({
      ...summarizeCandidate(candidate, candidate, reportTechnicalRecord(candidate)),
      query: candidate.query || null,
      automaticEligible: isSafeAlternative(candidate, reportTechnicalRecord(candidate))
    }));
    const bestAlternative = alternatives.find((candidate) => candidate.automaticEligible) || null;
    const currentTechnical = technicalStatus(currentRecord);
    const currentHardIssue = currentRank?.hardBlocked === true || PARTY_TYME_CHANNEL_PATTERN.test(currentCandidate.channelTitle || "") || currentTechnical !== "PASS";
    const materiallyBetter = Boolean(bestAlternative && currentRank && bestAlternative.score >= currentRank.score + 12);
    const searchErrors = Array.isArray(row.searchErrors) ? row.searchErrors : [];
    let decision = "KEEP — NO CLEARER SAFE REPLACEMENT";
    if (currentHardIssue) decision = "REVIEW — CURRENT ASSIGNMENT HAS A HARD METADATA/TECHNICAL WARNING";
    else if (materiallyBetter) decision = "REVIEW — POSSIBLE SUPERIOR CANDIDATE; NO AUTOMATIC REPLACEMENT";
    if (searchErrors.length > 0) decision = "REVIEW — SEARCH INCOMPLETE (API ERROR)";
    return {
      ...row,
      current: summarizeCandidate(currentCandidate, currentRank, currentRecord),
      alternatives,
      bestSafeAlternative: bestAlternative ? { ...bestAlternative, automaticEligible: true } : null,
      decision,
      replacementApplied: false,
      replacementReason: searchErrors.length > 0
        ? "One or more discovery queries failed; rerun the read-only audit before making a quality decision."
        : currentHardIssue
          ? "No replacement was applied: API metadata cannot prove audio arrangement, exact key, completeness, or visual presentation."
          : materiallyBetter
            ? "A metadata-based alternative scored higher, but replacement requires human playback comparison and explicit quality evidence."
            : "Current assignment remains the safer choice on available evidence."
    };
  });
  const nextReport = {
    ...report,
    assignments,
    rankingReevaluatedAt: new Date().toISOString(),
    methodology: {
      ...report.methodology,
      ranking: "Re-ranked from persisted API evidence without another network request. Hard gates precede HD, relative age-aware popularity, provider, and experience signals; qualified SD candidates are suppressed when a qualified HD alternative exists."
    },
    summary: summarize(assignments, report.errors?.search || [], report.errors?.video || [])
  };
  const markdownPath = options.markdown || DEFAULT_MARKDOWN_PATH;
  await writeFile(reportPath, `${JSON.stringify(nextReport, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(nextReport), "utf8");
  printReport(nextReport);
  return nextReport;
}

export async function applyProductionDecisions(decisionsPath = DEFAULT_DECISIONS_PATH, options = {}) {
  const catalogPath = options.catalog || DEFAULT_CATALOG_PATH;
  const reportPath = options.report || DEFAULT_OUTPUT_PATH;
  const markdownPath = options.markdown || DEFAULT_MARKDOWN_PATH;
  const reviewPath = options.review || DEFAULT_REVIEW_PATH;
  const decisionsFile = JSON.parse(await readFile(decisionsPath, "utf8"));
  if (decisionsFile?.version !== 1 || !Array.isArray(decisionsFile.decisions)) {
    throw new Error("Decision file must contain version 1 and a decisions array.");
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (!Array.isArray(report.assignments)) throw new Error("Production audit report has no assignments array.");
  const rawCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!Array.isArray(rawCatalog)) throw new Error("Public catalog must be a top-level array.");
  const catalog = normalizeCatalog(rawCatalog, { logger: { warn() {} } }).songs;
  const catalogById = new Map(catalog.map((song) => [song.id.toLowerCase(), song]));
  const rawById = new Map(rawCatalog.map((song) => [String(song?.id || "").toLowerCase(), song]));
  const reportById = new Map(report.assignments.map((row) => [String(row.songId || "").toLowerCase(), row]));
  const decisions = decisionsFile.decisions;
  const decisionIds = new Set();
  const promotedOwners = new Map(rawCatalog.filter((song) => song?.youtubeVideoId).map((song) => [song.youtubeVideoId, song.id]));
  const now = new Date().toISOString();
  const catalogChanges = [];

  for (const decision of decisions) {
    const songId = String(decision?.songId || "").trim();
    const key = songId.toLowerCase();
    const action = String(decision?.action || "").trim().toLowerCase();
    const reason = String(decision?.reason || "").trim();
    if (!songId || decisionIds.has(key)) throw new Error(`Decision file contains a missing or duplicate song ID: ${songId || "(empty)"}.`);
    if (!new Set(["keep", "replace", "unassign"]).has(action)) throw new Error(`Unsupported decision action for ${songId}: ${action || "(empty)"}.`);
    if (!reason) throw new Error(`Decision for ${songId} requires a reason.`);
    const song = catalogById.get(key);
    const rawSong = rawById.get(key);
    const row = reportById.get(key);
    if (!song || !rawSong || !row) throw new Error(`Decision references a song outside the audited report: ${songId}.`);
    if (decisionIds.has(key)) throw new Error(`Duplicate decision for ${songId}.`);
    decisionIds.add(key);
    if (!String(row.decision || "").startsWith("REVIEW")) throw new Error(`Refusing to change non-review assignment ${songId}.`);
    if (rawSong.youtubeVideoId !== row.currentVideoId) throw new Error(`Catalog/report mismatch for ${songId}; no files were changed.`);

    let selected = null;
    if (action === "replace") {
      const videoId = String(decision.videoId || "").trim();
      selected = [row.bestSafeAlternative, ...(Array.isArray(row.alternatives) ? row.alternatives : [])]
        .find((candidate) => candidate?.videoId === videoId) || null;
      if (!selected) throw new Error(`Replacement for ${songId} is not present in the persisted audit evidence.`);
      if (selected.automaticEligible !== true || selected.technicalStatus !== "PASS" || selected.definition !== "hd" || selected.embeddable !== true || selected.madeForKids !== false || (selected.warnings || []).length > 0) {
        throw new Error(`Replacement for ${songId} does not pass every persisted technical/ranking gate.`);
      }
      const owner = promotedOwners.get(videoId);
      if (owner && owner.toLowerCase() !== song.id.toLowerCase()) throw new Error(`Replacement ${videoId} is already promoted for ${owner}.`);
      if (videoId === rawSong.youtubeVideoId) throw new Error(`Replacement for ${songId} is already the current video.`);
      rawSong.youtubeVideoId = videoId;
      promotedOwners.set(videoId, song.id);
      catalogChanges.push({ songId: song.id, action, from: row.currentVideoId, to: videoId });
    } else if (action === "unassign") {
      if (!rawSong.youtubeVideoId) throw new Error(`Cannot unassign ${songId}; it is already unavailable.`);
      rawSong.youtubeVideoId = null;
      catalogChanges.push({ songId: song.id, action, from: row.currentVideoId, to: null });
    }

    const history = Array.isArray(row.decisionHistory) ? row.decisionHistory : [];
    row.decisionHistory = [...history, {
      decidedAt: now,
      action,
      reason,
      previousVideoId: row.currentVideoId,
      selectedVideoId: selected?.videoId || null,
      evidence: selected ? {
        videoTitle: selected.videoTitle,
        channelTitle: selected.channelTitle,
        viewCount: selected.viewCount,
        likeCount: selected.likeCount,
        definition: selected.definition,
        technicalStatus: selected.technicalStatus,
        warnings: selected.warnings || []
      } : null
    }];
    row.finalDecision = action === "replace" ? "REPLACE" : action === "unassign" ? "REVIEW REQUIRED" : "KEEP";
    row.finalDecisionReason = reason;
    row.replacementApplied = action === "replace";
    row.unassignedApplied = action === "unassign";
    row.replacementReason = reason;
    if (action === "replace") {
      row.previousCurrent = row.current;
      row.previousVideoId = row.currentVideoId;
      row.currentVideoId = selected.videoId;
      row.current = { ...selected, exact1080p: selected.exact1080p || "HD (exact 1080p unverified)" };
      row.bestSafeAlternative = null;
      row.decision = "REPLACE";
    } else if (action === "unassign") {
      row.previousCurrent = row.current;
      row.previousVideoId = row.currentVideoId;
      row.currentVideoId = null;
      row.current = { videoId: null, videoTitle: null, channelTitle: null, publishedAt: null, viewCount: null, likeCount: null, definition: null, exact1080p: "UNAVAILABLE", embeddable: null, madeForKids: null, technicalStatus: "UNAVAILABLE", score: null, confidence: null, selectable: false, warnings: ["warning: no qualified clean candidate available"], popularityPoints: 0, providerEvidence: false, karaokeWording: [] };
      row.bestSafeAlternative = null;
      row.decision = "REVIEW REQUIRED";
    } else {
      row.decision = "KEEP";
    }
  }

  const reviewStore = await readReviewStoreForDecision(reviewPath);
  const flagsBySong = new Map(reviewStore.flags.map((flag) => [String(flag.songId || "").toLowerCase(), flag]));
  for (const decision of decisions) {
    const key = String(decision.songId).toLowerCase();
    if (decision.action === "unassign") {
      const reportRow = reportById.get(key);
      flagsBySong.set(key, { songId: decision.songId, status: "quality-excluded", reason: decision.reason, updatedAt: now, candidateVideoId: reportRow?.previousVideoId || reportRow?.currentVideoId || null, attemptCount: 0, lastAttemptAt: null, nextEligibleAt: null, httpStatus: null, httpClassification: null, retryAfterMs: null });
    } else {
      flagsBySong.delete(key);
    }
  }

  if (catalogChanges.length > 0) await atomicWriteJson(catalogPath, rawCatalog);
  await atomicWriteJson(reviewPath, { version: 1, flags: [...flagsBySong.values()] });
  report.finalizedAt = now;
  report.finalizedDecisionCount = decisions.length;
  report.summary = summarize(report.assignments, report.errors?.search || [], report.errors?.video || []);
  report.summary.replacementsApplied = report.assignments.filter((row) => row.replacementApplied === true).length;
  report.summary.unassignedApplied = report.assignments.filter((row) => row.unassignedApplied === true).length;
  await atomicWriteJson(reportPath, report);
  await writeFile(markdownPath, renderMarkdown(report), "utf8");
  console.log(`Applied ${decisions.length} explicit production decision(s): ${catalogChanges.length} catalog change(s).`);
  catalogChanges.forEach((change) => console.log(`${change.songId} | ${change.action} | ${change.from || "none"} -> ${change.to || "none"}`));
  return { report, catalogChanges };
}

async function readReviewStoreForDecision(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return { version: 1, flags: Array.isArray(value?.flags) ? value.flags : [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, flags: [] };
    throw error;
  }
}

export async function refreshProductionAuditStatistics(reportPath = DEFAULT_OUTPUT_PATH, dependencies = {}) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const ids = report.assignments.map((row) => row.currentVideoId).filter(isValidVideoId);
  const apiKey = dependencies.apiKey || getApiKey();
  const fetchImplementation = dependencies.fetchImplementation || fetch;
  const videoUrl = dependencies.videoApiUrl || "https://www.googleapis.com/youtube/v3/videos";
  const records = await requestVideoBatch(ids, apiKey, new Date().toISOString(), fetchImplementation, videoUrl, dependencies.requestConfig || {});
  const byId = new Map(records.map((record) => [record.candidateVideoId, record]));
  report.assignments.forEach((row) => {
    const record = byId.get(row.currentVideoId);
    if (!record) return;
    row.current = {
      ...row.current,
      publishedAt: record.publishedAt || row.current.publishedAt || null,
      viewCount: record.viewCount ?? row.current.viewCount ?? null,
      likeCount: record.likeCount ?? row.current.likeCount ?? null,
      definition: record.definition || row.current.definition || null,
      exact1080p: exactHdStatus(record),
      embeddable: record.embeddable,
      madeForKids: record.madeForKids,
      technicalStatus: technicalStatus(record)
    };
  });
  report.statisticsRefreshedAt = new Date().toISOString();
  report.statisticsRefreshErrors = ids.filter((id) => !byId.has(id));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return rerankProductionAuditReport(reportPath, dependencies);
}

export async function renderProductionAuditReport(reportPath = DEFAULT_OUTPUT_PATH, markdownPath = DEFAULT_MARKDOWN_PATH) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  await writeFile(markdownPath, renderMarkdown(report), "utf8");
  return report;
}

function reportCandidate(candidate, videoId) {
  return {
    ...candidate,
    videoId: videoId || candidate?.videoId || null,
    viewCount: candidate?.viewCount ?? null,
    likeCount: candidate?.likeCount ?? null,
    definition: candidate?.definition || null,
    publishedAt: candidate?.publishedAt || null
  };
}

function reportTechnicalRecord(candidate) {
  return {
    candidateVideoId: candidate?.videoId || null,
    apiVerified: candidate?.technicalStatus === "PASS" || candidate?.technicalStatus === "UNKNOWN",
    embeddable: candidate?.embeddable ?? null,
    madeForKids: candidate?.madeForKids ?? null,
    definition: candidate?.definition || null,
    viewCount: candidate?.viewCount ?? null,
    likeCount: candidate?.likeCount ?? null,
    publishedAt: candidate?.publishedAt || null,
    videoTitle: candidate?.videoTitle || null,
    channelTitle: candidate?.channelTitle || null
  };
}

function enrichTechnicalCandidate(record, videoId) {
  return {
    videoId,
    videoTitle: record?.videoTitle || "",
    channelTitle: record?.channelTitle || "",
    publishedAt: record?.publishedAt || null,
    viewCount: record?.viewCount ?? null,
    likeCount: record?.likeCount ?? null,
    definition: record?.definition || null,
    description: record?.description || "",
    apiVerified: record?.apiVerified,
    embeddable: record?.embeddable,
    madeForKids: record?.madeForKids
  };
}

function technicalStatus(record) {
  if (!record) return "UNKNOWN";
  if (record.apiVerified !== true) return "MISSING";
  if (record.embeddable !== true) return "NOT_EMBEDDABLE";
  if (record.madeForKids !== false) return "MADE_FOR_KIDS_OR_UNKNOWN";
  return "PASS";
}

function exactHdStatus(record) {
  return record?.definition === "hd" ? "HD (exact 1080p unverified)" : record?.definition === "sd" ? "SD" : "UNVERIFIED";
}

function isSafeAlternative(candidate, record) {
  return Boolean(
    candidate?.selectable === true &&
    candidate?.partyTymeProvider !== true &&
    candidate?.hardBlocked !== true &&
    candidate?.definition === "hd" &&
    technicalStatus(record) === "PASS"
  );
}

function summarizeCandidate(candidate, rank, record) {
  return {
    videoId: candidate?.videoId || record?.candidateVideoId || null,
    videoTitle: candidate?.videoTitle || record?.videoTitle || null,
    channelTitle: candidate?.channelTitle || record?.channelTitle || null,
    publishedAt: candidate?.publishedAt || record?.publishedAt || null,
    viewCount: candidate?.viewCount ?? record?.viewCount ?? null,
    likeCount: candidate?.likeCount ?? record?.likeCount ?? null,
    definition: candidate?.definition || record?.definition || null,
    exact1080p: exactHdStatus(record || candidate),
    embeddable: record?.embeddable ?? null,
    madeForKids: record?.madeForKids ?? null,
    technicalStatus: technicalStatus(record),
    score: rank?.score ?? null,
    confidence: rank?.confidence || null,
    selectable: rank?.selectable === true,
    warnings: rank?.reasons?.filter((reason) => reason.startsWith("warning:")) || [],
    popularityPoints: rank?.popularityPoints || 0,
    providerEvidence: rank?.providerEvidence === true,
    karaokeWording: rank?.reasons?.filter((reason) => ["karaoke", "instrumental", "backing track", "minus one", "sing along"].includes(reason)) || []
  };
}

async function readDemand(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return new Map((Array.isArray(value?.signals) ? value.signals : []).map((signal) => [signal.songId, {
      demandTier: signal.demandTier,
      rank: Array.isArray(signal.evidence) && signal.evidence.length > 0 ? signal.evidence[0].rank : null
    }]));
  } catch {
    return new Map();
  }
}

function summarize(assignments, searchErrors, videoErrors) {
  return {
    audited: assignments.length,
    keep: assignments.filter((row) => row.decision.startsWith("KEEP")).length,
    review: assignments.filter((row) => row.decision.startsWith("REVIEW")).length,
    replacementsApplied: assignments.filter((row) => row.replacementApplied).length,
    hdCurrent: assignments.filter((row) => row.current.definition === "hd").length,
    exact1080pVerified: 0,
    searchErrors: searchErrors.length,
    videoBatchErrors: videoErrors.length
  };
}

function renderMarkdown(report) {
  const lines = [
    "# KantaTayo production YouTube quality audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Scope: sample-${report.scope.firstId} through sample-${report.scope.lastId}; audited promoted songs: ${report.scope.auditedCount}`,
    "",
    report.methodology.limitations,
    "",
    "| Song | Demand | Previous video | Final video | Final channel | Final HD | Decision | Selected/best evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.assignments.map((row) => {
      const history = Array.isArray(row.decisionHistory) ? row.decisionHistory.at(-1) : null;
      const selectedId = history?.selectedVideoId || row.bestSafeAlternative?.videoId || "none";
      const selectedTitle = row.bestSafeAlternative?.videoTitle || history?.evidence?.videoTitle || "";
      return `| ${row.songId} ${escapePipe(row.catalogTitle)} — ${escapePipe(row.catalogArtist)} | ${row.demandTier || "—"} | ${row.previousVideoId || "—"} | ${row.currentVideoId || "unavailable"} | ${escapePipe(row.current.channelTitle || "unknown")} | ${row.current.exact1080p} | ${escapePipe(row.finalDecision || row.decision)} | ${selectedId === "none" ? "none" : `${selectedId} (${escapePipe(selectedTitle)})`} |`;
    }),
    "",
    "## Summary",
    "",
    "```json",
    JSON.stringify(report.summary, null, 2),
    "```",
    "",
    "No public catalog or promotion state was changed by this audit."
  ];
  return `${lines.join("\n")}\n`;
}

function printReport(report) {
  console.log("SONG ID | CATALOG SONG | DEMAND | CURRENT VIDEO | CHANNEL | VIEWS | HD | DECISION | BEST SAFE ALTERNATIVE");
  report.assignments.forEach((row) => console.log([
    row.songId,
    `${row.catalogTitle} — ${row.catalogArtist}`,
    row.demandTier || "unknown",
    row.currentVideoId,
    row.current.channelTitle || "unknown",
    row.current.viewCount ?? "unknown",
    row.current.exact1080p,
    row.decision,
    row.bestSafeAlternative?.videoId || "none"
  ].join(" | ")));
  console.log(`Production audit complete: ${report.summary.audited} audited, ${report.summary.review} review flag(s), ${report.summary.replacementsApplied} replacement(s) applied.`);
  console.log(`Reports: ${DEFAULT_OUTPUT_PATH} and ${DEFAULT_MARKDOWN_PATH}`);
  if (report.errors.search.length || report.errors.video.length) console.log(`API errors: ${report.errors.search.length} search, ${report.errors.video.length} video batch.`);
}

function normalizeQuery(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function clampInteger(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`value must be an integer from ${minimum} to ${maximum}`);
  return number;
}
function escapePipe(value) { return String(value || "").replace(/\|/g, "\\|"); }
function getApiKey() {
  if (!process.env.YOUTUBE_API_KEY || !process.env.YOUTUBE_API_KEY.trim()) throw new Error("YOUTUBE_API_KEY is missing. Set it only in the local environment.");
  return process.env.YOUTUBE_API_KEY;
}

export function parseArguments(argv) {
  const options = {};
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--catalog") options.catalog = requireValue(args, arg);
    else if (arg === "--verification") options.verification = requireValue(args, arg);
    else if (arg === "--demand") options.demand = requireValue(args, arg);
    else if (arg === "--output") options.output = requireValue(args, arg);
    else if (arg === "--markdown") options.markdown = requireValue(args, arg);
    else if (arg === "--decisions") options.decisions = requireValue(args, arg);
    else if (arg === "--rerank-report") options.rerankReport = requireValue(args, arg);
    else if (arg === "--refresh-stats") options.refreshStats = requireValue(args, arg);
    else if (arg === "--render-report") options.renderReport = requireValue(args, arg);
    else if (arg === "--from") options.firstId = parseSampleNumber(requireValue(args, arg), arg);
    else if (arg === "--to") options.lastId = parseSampleNumber(requireValue(args, arg), arg);
    else if (arg === "--song-ids") options.songIds = requireValue(args, arg).split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "--queries") options.queryCount = clampInteger(requireValue(args, arg), 1, SEARCH_QUERY_BUILDERS.length);
    else if (arg === "--max-results") options.maxResults = clampInteger(requireValue(args, arg), 1, 5);
    else throw new Error(`Unknown option "${arg}".`);
  }
  return options;
}
function parseSampleNumber(value, option) {
  const match = /^(?:sample-)?(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error(`${option} must be a sample number such as sample-101.`);
  return Number(match[1]);
}
function requireValue(args, option) {
  const value = args.shift();
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}
function printUsage() {
  console.log([
    "KantaTayo production YouTube quality audit",
    "",
    "  node tools/production-quality-audit.mjs [options]",
    "",
    "Audits currently promoted assignments using multiple discovery queries and videos.list metadata.",
    "It never promotes, replaces, or modifies catalog/verification/candidate state.",
    "",
    "Options:",
    "  --from sample-101  First catalog ID number (default: 101)",
    "  --to sample-145    Last catalog ID number (default: 145)",
    "  --song-ids IDS     Comma-separated promoted IDs for a focused audit",
    "  --queries N        Query variants per song, 1-3 (default: 3)",
    "  --max-results N    Results per query, 1-5 (default: 5)",
    "  --output PATH      JSON report path",
    "  --markdown PATH    Markdown report path",
    "  --decisions PATH   Apply an explicit reviewed decision file to the audit/catalog",
    "  --rerank-report PATH  Re-rank an existing report without API requests",
    "  --refresh-stats PATH  Refresh current-video statistics with one videos.list request, then re-rank",
    "  --render-report PATH  Regenerate Markdown from an existing report without API requests",
    "  --help             Show this help"
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) printUsage();
    else if (options.decisions) await applyProductionDecisions(options.decisions, options);
    else if (options.renderReport) await renderProductionAuditReport(options.renderReport, options.markdown || DEFAULT_MARKDOWN_PATH);
    else if (options.rerankReport) await rerankProductionAuditReport(options.rerankReport, options);
    else if (options.refreshStats) await refreshProductionAuditStatistics(options.refreshStats);
    else await auditProductionAssignments(options);
  } catch (error) {
    console.error(`Production audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}
