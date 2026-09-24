#!/usr/bin/env node

/**
 * Development-only verification workflow for known YouTube video IDs.
 *
 * This script uses YouTube Data API metadata endpoints only. It does not
 * download media, modify the public catalog during discovery/verification,
 * or print credentials.
 */

import { access, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { normalizeCatalog } from "../src/catalog.js";

const API_URL = "https://www.googleapis.com/youtube/v3/videos";
const SEARCH_API_URL = "https://www.googleapis.com/youtube/v3/search";
const DEFAULT_RECORD_PATH = "tools/youtube-verification.json";
const DEFAULT_CATALOG_PATH = "data/songs.sample.json";
const DEFAULT_CANDIDATE_PATH = "tools/youtube-candidates.json";
const DEFAULT_REVIEW_PATH = "tools/youtube-review.json";
const VERIFICATION_VERSION = 1;
const CANDIDATE_VERSION = 1;
const REVIEW_VERSION = 1;
const MAX_IDS_PER_REQUEST = 50;
const DEFAULT_SEARCH_RESULTS = 5;
const DEFAULT_SEARCH_SONG_LIMIT = 10;
const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 10000;
const DEFAULT_DEFERRED_COOLDOWN_MS = 60000;
const MAX_DEFERRED_COOLDOWN_MS = 3600000;
const ATOMIC_RENAME_RETRY_LIMIT = 5;
const ATOMIC_RENAME_BASE_DELAY_MS = 25;
const ATOMIC_RENAME_MAX_DELAY_MS = 250;
const ATOMIC_STALE_ARTIFACT_MS = 5 * 60 * 1000;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const VALID_STATUSES = new Set(["unassigned", "candidate", "verified", "rejected", "unavailable"]);
const VALID_PROVENANCE = new Set(["human-reviewed", "auto-high-confidence", "technically-verified-only", "review-required", "deferred-rate-limit", "quota-deferred"]);
const VALID_REVIEW_STATUSES = new Set(["unresolved", "review-required", "quality-excluded", "deferred-rate-limit", "quota-deferred"]);
export const QUALITY_EXCLUSION_STATUS = "quality-excluded";
export const QUALITY_UNASSIGNMENT_PROVENANCE = "user-product-quality-decision";
export const PARTY_TYME_CHANNEL_PATTERN = /\bparty\s+tyme\s+karaoke(?:\s+channel)?\b/i;
export const PARTY_TYME_UNASSIGNMENT_REASON = "user quality decision — Party Tyme presentation does not meet the desired KantaTayo visual experience standard";
export const QUALITY_KARAOKE_PROVIDER_PATTERN = /\b(?:atomic karaoke|karaokeytv|zoom karaoke|karaoke media|sing king|my all time karaoke|easy karaoke|cc karaoke)\b/i;
const BUILTIN_REVIEW_FLAGS = new Map([
  ["sample-008", { status: "unresolved", reason: "No acceptable standard duet candidate is currently selected." }],
  ["sample-009", { status: "unresolved", reason: "No acceptable standard duet candidate is currently selected." }],
  ["sample-042", { status: "review-required", reason: "Catalog metadata needs human review: search results associate Mr. Suave with a different artist." }]
]);
const SEARCH_POSITIVE_TERMS = ["karaoke", "instrumental", "backing track", "minus one", "sing along"];
const SEARCH_HARD_NEGATIVES = [
  { pattern: /\bofficial(?:\s+(?:music\s+)?)?video\b|\bmusic video\b/i, label: "official/music video" },
  { pattern: /\blyric(?:s| video)?\b|\bwith lyrics\b/i, label: "lyrics-only" },
  { pattern: /\boriginal audio\b|\bfull song\b/i, label: "original audio" },
  { pattern: /\bvisualizer\b/i, label: "visualizer" },
  { pattern: /\blive\b|\bconcert\b|\bperformance\b/i, label: "live performance" },
  { pattern: /\bguide\s+(?:vocal|melody)|\bwith\s+vocals?\b|\bvocal\s+guide\b/i, label: "guide-vocal" },
  { pattern: /\bcover\b|\bcovered\b/i, label: "cover" }
];
const SEARCH_KEY_PENALTIES = [
  { pattern: /\blower key\b|\bhigher key\b|\bmale key\b|\bfemale key\b|\bkey change\b|\b[+-]\s*\d+\s*(?:key|semitone)/i, label: "altered key" }
];
const DUET_PART_PATTERN = /\b(?:male|female)\s*(?:part|version|key)\b/i;
const NON_STANDARD_VERSION_PATTERN = /\b(?:acoustic|unplugged|remix|medley|short version|slow(?:ed)?|fast(?:er)?|piano(?:[- ]only)?|伴奏)\b/i;
const LEGACY_CLOSE_SCORE_REASON = "multiple acceptable candidates are too close in score";
const RETRYABLE_API_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "tooManyRequests"]);
const QUOTA_API_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "dailyLimitExceededUnreg"]);

export function isValidVideoId(value) {
  return typeof value === "string" && VIDEO_ID_PATTERN.test(value.trim());
}

export function createEmptyVerificationStore() {
  return { version: VERIFICATION_VERSION, records: [] };
}

export function createEmptyReviewStore() {
  return { version: REVIEW_VERSION, flags: [] };
}

export function createVerificationRecord(values = {}) {
  const record = {
    songId: stringOrNull(values.songId),
    candidateVideoId: stringOrNull(values.candidateVideoId),
    catalogTitle: stringOrNull(values.catalogTitle),
    catalogArtist: stringOrNull(values.catalogArtist),
    status: VALID_STATUSES.has(values.status) ? values.status : "unassigned",
    apiVerified: values.apiVerified === true,
    embeddable: booleanOrNull(values.embeddable),
    madeForKids: booleanOrNull(values.madeForKids),
    videoTitle: stringOrNull(values.videoTitle),
    channelTitle: stringOrNull(values.channelTitle),
    publishedAt: stringOrNull(values.publishedAt),
    description: stringOrNull(values.description),
    definition: values.definition === "hd" || values.definition === "sd" ? values.definition : null,
    duration: stringOrNull(values.duration),
    viewCount: nonNegativeIntegerOrNull(values.viewCount),
    likeCount: nonNegativeIntegerOrNull(values.likeCount),
    manuallyMatched: values.manuallyMatched === true,
    karaokeSuitable: values.karaokeSuitable === true,
    provenance: VALID_PROVENANCE.has(values.provenance) ? values.provenance : null,
    autoChecksPassed: values.autoChecksPassed === true,
    decisionReasons: stringArray(values.decisionReasons),
    reviewReason: stringOrNull(values.reviewReason),
    decisionAt: stringOrNull(values.decisionAt),
    checkedAt: stringOrNull(values.checkedAt),
    verifiedAt: stringOrNull(values.verifiedAt),
    lastError: stringOrNull(values.lastError),
    attemptCount: nonNegativeIntegerOrZero(values.attemptCount),
    lastAttemptAt: stringOrNull(values.lastAttemptAt),
    nextEligibleAt: stringOrNull(values.nextEligibleAt),
    httpStatus: validHttpStatus(values.httpStatus),
    httpClassification: validHttpClassification(values.httpClassification),
    retryAfterMs: nonNegativeIntegerOrNull(values.retryAfterMs)
  };
  if (values.unassignmentReason !== undefined || values.unassignedAt !== undefined || values.unassignmentProvenance !== undefined) {
    record.unassignmentReason = stringOrNull(values.unassignmentReason);
    record.unassignedAt = stringOrNull(values.unassignedAt);
    record.unassignmentProvenance = stringOrNull(values.unassignmentProvenance);
  }
  return record;
}

export function parseVideoResponse(payload, requestedIds, checkedAt = new Date().toISOString()) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const byId = new Map(items.map((item) => [typeof item?.id === "string" ? item.id : "", item]));

  return requestedIds.map((requestedId) => {
    const item = byId.get(requestedId);
    if (!item) {
      return createVerificationRecord({
        candidateVideoId: requestedId,
        status: "unavailable",
        checkedAt,
        lastError: "video-not-found"
      });
    }

    const embeddable = typeof item.status?.embeddable === "boolean" ? item.status.embeddable : null;
    const madeForKids = typeof item.status?.madeForKids === "boolean" ? item.status.madeForKids : null;
    const apiVerified = item.id === requestedId;

    return createVerificationRecord({
      candidateVideoId: requestedId,
      status: apiVerified ? "candidate" : "rejected",
      apiVerified,
      embeddable,
      madeForKids,
      videoTitle: stringOrNull(item.snippet?.title),
      channelTitle: stringOrNull(item.snippet?.channelTitle),
      publishedAt: stringOrNull(item.snippet?.publishedAt),
      description: stringOrNull(item.snippet?.description),
      definition: item.contentDetails?.definition === "hd" || item.contentDetails?.definition === "sd" ? item.contentDetails.definition : null,
      duration: stringOrNull(item.contentDetails?.duration),
      viewCount: nonNegativeIntegerOrNull(item.statistics?.viewCount),
      likeCount: nonNegativeIntegerOrNull(item.statistics?.likeCount),
      checkedAt,
      lastError: apiVerified ? null : "returned-id-mismatch"
    });
  });
}

export function canPromote(record) {
  const technicalChecksPass = Boolean(
    record &&
    isValidVideoId(record.candidateVideoId) &&
    record.apiVerified === true &&
    record.embeddable === true &&
    record.madeForKids === false &&
    record.checkedAt &&
    record.verifiedAt
  );
  if (!technicalChecksPass || record.status !== "verified" || PARTY_TYME_CHANNEL_PATTERN.test(record.channelTitle || "")) return false;
  const humanPath = record.manuallyMatched === true && record.karaokeSuitable === true && (record.provenance === null || record.provenance === "human-reviewed");
  const automatedPath = record.provenance === "auto-high-confidence" && record.autoChecksPassed === true && record.manuallyMatched !== true && record.karaokeSuitable !== true;
  return humanPath || automatedPath;
}

export function normalizeVerificationStore(value, options = {}) {
  const tolerant = options.tolerateMalformed === true;
  const compatibleVersion = value?.version === undefined || value?.version === VERIFICATION_VERSION;
  const hasRecordsArray = value?.records === undefined || Array.isArray(value.records);
  if (!isPlainObject(value) || !compatibleVersion || !hasRecordsArray) {
    if (!tolerant) throw new Error("Verification file must contain version 1 and a records array.");
    options.onIssue?.("verification store header or records array was malformed; usable records were retained");
  }

  const seen = new Set();
  const records = (Array.isArray(value?.records) ? value.records : []).map((record, index) => {
    const normalized = createVerificationRecord(record);
    const key = `${normalized.songId || ""}::${normalized.candidateVideoId || ""}`;
    if (!normalized.candidateVideoId || (seen.has(key) && options.allowDuplicateKeys !== true)) {
      if (!tolerant) throw new Error(`Verification record ${index + 1} has a missing or duplicate candidate key.`);
      options.onIssue?.(`verification record ${index + 1} was skipped because its candidate key was missing or duplicated`);
      return null;
    }
    seen.add(key);
    return normalized;
  }).filter(Boolean);
  return { version: VERIFICATION_VERSION, records };
}

export function normalizeReviewStore(value, options = {}) {
  const tolerant = options.tolerateMalformed === true;
  const compatibleVersion = value?.version === undefined || value?.version === REVIEW_VERSION;
  const hasFlagsArray = value?.flags === undefined || Array.isArray(value.flags);
  if (!isPlainObject(value) || !compatibleVersion || !hasFlagsArray) {
    if (!tolerant) throw new Error(`Review flag file must contain version ${REVIEW_VERSION} and a flags array.`);
    options.onIssue?.("review store header or flags array was malformed; usable flags were retained");
  }

  const seen = new Set();
  const flags = (Array.isArray(value?.flags) ? value.flags : []).map((flag, index) => {
    const songId = stringOrNull(flag?.songId);
    const status = stringOrNull(flag?.status);
    const reason = stringOrNull(flag?.reason);
    if (!songId || !VALID_REVIEW_STATUSES.has(status) || !reason) {
      if (!tolerant) throw new Error(`Review flag ${index + 1} is invalid.`);
      options.onIssue?.(`review flag ${index + 1} was skipped because its song, status, or reason was invalid`);
      return null;
    }
    const key = songId.toLowerCase();
    if (seen.has(key)) {
      if (!tolerant) throw new Error(`Review flag ${index + 1} duplicates song ID "${songId}".`);
      options.onIssue?.(`review flag ${index + 1} was skipped because song ID "${songId}" was duplicated`);
      return null;
    }
    seen.add(key);
    return {
      songId,
      status,
      reason,
      updatedAt: stringOrNull(flag?.updatedAt),
      candidateVideoId: isValidVideoId(flag?.candidateVideoId) ? flag.candidateVideoId.trim() : null,
      attemptCount: nonNegativeIntegerOrZero(flag?.attemptCount),
      lastAttemptAt: stringOrNull(flag?.lastAttemptAt),
      nextEligibleAt: stringOrNull(flag?.nextEligibleAt),
      httpStatus: validHttpStatus(flag?.httpStatus),
      httpClassification: validHttpClassification(flag?.httpClassification),
      retryAfterMs: nonNegativeIntegerOrNull(flag?.retryAfterMs)
    };
  }).filter(Boolean);
  return { version: REVIEW_VERSION, flags };
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) return printUsageWithQuery();
  if (options.command === "verify") return verifyCandidates(options);
  if (options.command === "search-candidates") return searchCandidates(options);
  if (options.command === "set-candidate") return setCandidate(options);
  if (options.command === "batch-verify") return batchVerifyCandidates(options);
  if (options.command === "auto-batch") return autoBatch(options);
  if (options.command === "auto-complete") return autoComplete(options);
  if (options.command === "report") return report(options);
  if (options.command === "mark-verified") return markVerified(options);
  if (options.command === "approve-batch") return approveBatch(options);
  if (options.command === "promote") return promote(options);
  if (options.command === "promote-all-verified") return promoteAllVerified(options);
  if (options.command === "unassign-party-tyme") return unassignPartyTymeAssignments(options);
  if (options.command === "review-flag") return reviewFlag(options);
  if (options.command === "review-unflag") return reviewUnflag(options);
  if (options.command === "cleanup-verification") return cleanupVerification(options);
  throw new Error(`Unknown command "${options.command}". Use --help for usage.`);
}

async function verifyCandidates(options) {
  const ids = unique(options.ids);
  if (ids.length === 0) throw new Error("Supply one or more candidate video IDs.");
  if (options.songId && ids.length !== 1) throw new Error("--song-id can be used with exactly one candidate ID.");
  const invalidIds = ids.filter((id) => !isValidVideoId(id));
  if (invalidIds.length > 0) throw new Error(`Invalid YouTube video ID format: ${invalidIds.join(", ")}`);

  const apiKey = getApiKey();
  let catalogSong = null;
  if (options.songId) {
    const catalog = await readCatalog(options.catalog);
    catalogSong = findCatalogSong(catalog, options.songId);
    if (!catalogSong) throw new Error(`Song ID "${options.songId}" was not found in the public catalog.`);
  }

  const checkedAt = new Date().toISOString();
  const url = new URL(API_URL);
  url.searchParams.set("part", "snippet,status,statistics,contentDetails");
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("key", apiKey.trim());

  let response;
  try { response = await fetch(url); } catch { throw new Error("YouTube Data API request failed. Check the network connection and try again."); }
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw formatApiError(response.status, payload);

  const records = parseVideoResponse(payload, ids, checkedAt).map((record) => ({
    ...record,
    songId: catalogSong?.id || null,
    catalogTitle: catalogSong?.title || null,
    catalogArtist: catalogSong?.artist || null,
    provenance: catalogSong ? "technically-verified-only" : null
  }));
  if (catalogSong) {
    const store = await readVerificationStore(options.file);
    await writeVerificationStore(options.file, upsertRecords(store, records));
  }
  records.forEach(printVerificationResult);
  if (catalogSong) console.log(`Saved ${records.length} verification record${records.length === 1 ? "" : "s"} to ${options.file}.`);
  else console.log("No catalog song was supplied; the API result was not saved to prevent an orphan verification record.");
  console.log("API verification does not approve the song match; manual review is still required.");
}

export async function searchCandidates(options, dependencies = {}) {
  const catalog = await readCatalog(options.catalog);
  const songs = selectSearchSongs(catalog, options);
  if (songs.length === 0) {
    console.log(options.all ? "No catalog songs with null youtubeVideoId remain in the selected range." : "No searchable song was selected.");
    return { results: [], errors: [] };
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !apiKey.trim()) throw new Error("YOUTUBE_API_KEY is missing. Set it only in the local environment.");

  const fetchImplementation = dependencies.fetchImplementation || fetch;
  const requestUrl = dependencies.apiUrl || SEARCH_API_URL;
  const requestConfig = getRequestConfig(options, dependencies);
  const cache = new Map();
  const results = [];
  const errors = [];

  for (const song of songs) {
    const query = options.query !== undefined ? options.query : buildSearchQuery(song);
    const cacheKey = query.toLowerCase();
    try {
      let candidates = cache.get(cacheKey);
      if (!candidates) {
        candidates = await requestSearchResults(query, options.maxResults, apiKey, fetchImplementation, requestUrl, requestConfig);
        cache.set(cacheKey, candidates);
      }
      candidates.forEach((candidate) => results.push({ song, query, candidate }));
    } catch (error) {
      errors.push({ song, query, message: error.message });
      console.error(`SEARCH_ERROR | ${song.id} | ${error.message}`);
      if (options.all) break;
    }
  }

  printSearchTable(songs, results, errors);
  console.log(`Search complete: ${songs.length} song${songs.length === 1 ? "" : "s"} requested, ${results.length} result${results.length === 1 ? "" : "s"}, ${errors.length} error${errors.length === 1 ? "" : "s"}.`);
  if (errors.length > 0) process.exitCode = 1;
  return { results, errors };
}

export async function setCandidate(options) {
  requireOption(options.songId, "--song-id");
  requireOption(options.videoId, "--video-id");
  if (!isValidVideoId(options.videoId)) throw new Error("--video-id must be an 11-character YouTube video ID.");

  const catalog = await readCatalog(options.catalog);
  const song = catalog.find((item) => item.id.toLowerCase() === options.songId.trim().toLowerCase());
  if (!song) throw new Error(`Song ID "${options.songId}" was not found in the public catalog.`);
  if (song.youtubeVideoId) throw new Error(`Candidate selection refused: ${song.id} already has a promoted YouTube video ID.`);

  const candidateFile = await readCandidateFile(options.candidates);
  const normalized = normalizeCandidateMappings(candidateFile, catalog);
  if (normalized.rejected.length > 0) {
    throw new Error("Candidate mapping file contains invalid, unknown, duplicate, or conflicting records; fix it before adding another candidate.");
  }
  const videoId = options.videoId.trim();
  const existing = normalized.candidates.find((candidate) => candidate.candidateVideoId === videoId && candidate.songId.toLowerCase() === song.id.toLowerCase());
  if (existing) {
    console.log(`Candidate already present: ${song.id} | ${videoId}`);
    return;
  }
  const conflicting = normalized.candidates.find((candidate) => candidate.candidateVideoId === videoId && candidate.songId.toLowerCase() !== song.id.toLowerCase());
  if (conflicting) throw new Error(`Candidate selection refused: ${videoId} is already mapped to ${conflicting.songId}.`);

  const next = {
    version: CANDIDATE_VERSION,
    candidates: [
      ...normalized.candidates.map((candidate) => ({ songId: candidate.songId, candidateVideoId: candidate.candidateVideoId })),
      { songId: song.id, candidateVideoId: videoId }
    ]
  };
  await atomicWriteJson(resolve(options.candidates), next);
  console.log(`Selected candidate: ${song.id} | ${videoId}`);
  console.log(`Only ${options.candidates} was modified. The public catalog was not changed.`);
}

function selectSearchSongs(catalog, options) {
  if (options.query !== undefined && options.all) throw new Error("--query can only be used with search-candidates --song-id, not --all.");
  if (options.query !== undefined && !options.songId) throw new Error("--query requires search-candidates --song-id SONG_ID.");
  if (options.all && options.songId) throw new Error("Use either --song-id or --all, not both.");
  if (!options.all && !options.songId) throw new Error("search-candidates requires --song-id SONG_ID or --all.");
  if (options.songId) {
    const song = catalog.find((item) => item.id.toLowerCase() === options.songId.trim().toLowerCase());
    if (!song) throw new Error(`Song ID "${options.songId}" was not found in the public catalog.`);
    if (song.youtubeVideoId) throw new Error(`Search skipped: ${song.id} already has a promoted YouTube video ID.`);
    return [song];
  }

  const start = options.offset;
  const remaining = catalog.filter((song) => !song.youtubeVideoId);
  return remaining.slice(start, start + options.maxSongs);
}

function buildSearchQuery(song) {
  return `${song.title} ${song.artist} karaoke`.replace(/\s+/g, " ").trim();
}

export async function requestSearchResults(query, maxResults, apiKey, fetchImplementation, requestUrl = SEARCH_API_URL, requestConfig = {}) {
  const url = new URL(requestUrl);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "video");
  url.searchParams.set("order", "relevance");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("videoEmbeddable", "true");
  if (requestConfig.videoDefinition === "high" || requestConfig.videoDefinition === "standard") {
    url.searchParams.set("videoDefinition", requestConfig.videoDefinition);
  }
  url.searchParams.set("key", apiKey.trim());

  const payload = await requestJsonWithRetry(url, fetchImplementation, requestConfig, "search");

  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.map((item) => ({
    videoId: stringOrNull(item?.id?.videoId),
    videoTitle: stringOrNull(item?.snippet?.title),
    channelTitle: stringOrNull(item?.snippet?.channelTitle),
    publishedAt: stringOrNull(item?.snippet?.publishedAt)
  })).filter((candidate) => isValidVideoId(candidate.videoId));
}

async function requestJsonWithRetry(url, fetchImplementation, requestConfig = {}, requestKind = "API") {
  const retryLimit = Number.isInteger(requestConfig.retryLimit) ? requestConfig.retryLimit : DEFAULT_RETRY_LIMIT;
  const baseDelayMs = Number.isFinite(requestConfig.baseDelayMs) ? Math.max(0, requestConfig.baseDelayMs) : DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = Number.isFinite(requestConfig.maxDelayMs) ? Math.max(0, requestConfig.maxDelayMs) : DEFAULT_RETRY_MAX_DELAY_MS;
  const sleep = requestConfig.sleep || ((delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)));
  const random = requestConfig.random || Math.random;

  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImplementation(url);
    } catch {
      const error = new Error(`YouTube Data API ${requestKind} request failed. Check the network connection and try again.`);
      error.retryable = true;
      error.retryExhausted = attempt >= retryLimit;
      if (attempt < retryLimit) {
        await sleep(calculateRetryDelay(null, attempt, baseDelayMs, maxDelayMs, random));
        continue;
      }
      throw error;
    }

    let payload = null;
    try { payload = await response.json(); } catch { /* handled below */ }
    if (response.ok) return payload;

    const error = formatApiError(response.status, payload);
    error.retryAfterMs = parseRetryAfter(response.headers);
    if (error.quotaExhausted) throw error;
    if (!error.retryable || attempt >= retryLimit) {
      if (error.retryable) error.retryExhausted = true;
      throw error;
    }
    await sleep(calculateRetryDelay(error.retryAfterMs, attempt, baseDelayMs, maxDelayMs, random));
  }
}

function calculateRetryDelay(retryAfterMs, attempt, baseDelayMs, maxDelayMs, random) {
  if (Number.isFinite(retryAfterMs)) return Math.min(Math.max(0, retryAfterMs), maxDelayMs);
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
  const jitter = exponential > 0 ? Math.floor(random() * Math.max(1, Math.floor(exponential * 0.25))) : 0;
  return Math.min(maxDelayMs, exponential + jitter);
}

function parseRetryAfter(headers) {
  if (!headers) return null;
  let value = null;
  if (typeof headers.get === "function") value = headers.get("retry-after");
  else if (typeof headers === "object") value = headers["retry-after"] ?? headers["Retry-After"];
  if (typeof value !== "string" || !value.trim()) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now());
}

export function rankSearchCandidates(song, candidates) {
  const scored = candidates
    .map((candidate) => scoreSearchCandidate(song, candidate))
  const hasQualifiedHd = scored.some((candidate) => candidate.selectable && candidate.technicalGatePass && !candidate.hardBlocked && candidate.hdDefinition);
  const qualified = scored.filter((candidate) => candidate.selectable && candidate.technicalGatePass && !candidate.hardBlocked && candidate.popularityMetric > 0 && (!hasQualifiedHd || !candidate.sdDefinition));
  const maxPopularityMetric = Math.max(0, ...qualified.map((candidate) => candidate.popularityMetric));
  const minPopularityMetric = qualified.length > 1 ? Math.min(...qualified.map((candidate) => candidate.popularityMetric)) : 0;
  const useRelativePopularity = qualified.length > 1
    && maxPopularityMetric >= 100000
    && minPopularityMetric > 0
    && maxPopularityMetric / minPopularityMetric >= 4;

  return scored
    .map((candidate) => {
      const relativePopularityPoints = useRelativePopularity
        ? getRelativePopularityPoints(candidate.popularityMetric, minPopularityMetric, maxPopularityMetric)
        : 0;
      const sdSuppressed = hasQualifiedHd && candidate.sdDefinition && candidate.selectable;
      const score = candidate.score + relativePopularityPoints - (sdSuppressed ? 40 : 0);
      const reasons = [...candidate.reasons];
      if (relativePopularityPoints > 0) reasons.push("relative popularity signal");
      if (sdSuppressed) reasons.push("warning: SD suppressed because a qualified HD alternative exists");
      return {
        ...candidate,
        score,
        selectable: candidate.selectable && !sdSuppressed,
        confidence: candidate.selectable && !sdSuppressed && score >= 90 ? "high" : candidate.selectable && !sdSuppressed ? "medium" : "low",
        popularityPoints: candidate.popularityPoints + relativePopularityPoints,
        relativePopularityPoints,
        reasons: [...new Set(reasons)]
      };
    })
    .sort((left, right) => right.score - left.score || left.videoId.localeCompare(right.videoId));
}

export function scoreSearchCandidate(song, candidate) {
  const videoTitle = stringOrNull(candidate.videoTitle) || "";
  const channelTitle = stringOrNull(candidate.channelTitle) || "";
  const titleText = normalizeSearchText(videoTitle);
  const channelText = normalizeSearchText(channelTitle);
  const partyTymeProvider = PARTY_TYME_CHANNEL_PATTERN.test(channelTitle);
  const searchableText = `${titleText} ${channelText}`;
  const titleTokens = meaningfulTokens(song.title);
  const artistTokens = meaningfulTokens(song.artist);
  const candidateTokens = meaningfulTokens(videoTitle);
  const titleMatches = titleTokens.filter((token) => candidateTokens.includes(token));
  const artistMatches = artistTokens.filter((token) => candidateTokens.includes(token));
  const titleComplete = titleTokens.length > 0 && titleMatches.length === titleTokens.length;
  const titlePhraseMatch = titleText.includes(normalizeSearchText(song.title));
  const normalizedArtist = normalizeSearchText(song.artist);
  const distinctArtistMatches = artistMatches.filter((token) => !titleTokens.includes(token));
  const artistMatched = titleText.includes(normalizedArtist) || (artistTokens.length > 1 && artistMatches.length === artistTokens.length && distinctArtistMatches.length === artistTokens.length);
  const positiveTerms = SEARCH_POSITIVE_TERMS.filter((term) => titleText.includes(term));
  const standardVersion = /\b(?:full|standard|original)\s+(?:karaoke|version)\b|\bkaraoke\s+version\b/i.test(titleText);
  const qualityKaraoke = /\b(?:hd|hq)\s+karaoke\b/i.test(titleText);
  const normalKey = /\b(?:original|normal)\s+key\b/i.test(titleText);
  const instrumentalOnly = /\binstrumental(?:\s+only)?\b/i.test(titleText) && !/\b(?:karaoke|backing track|minus one)\b/i.test(titleText);
  const partOnly = DUET_PART_PATTERN.test(searchableText);
  const nonStandardVersion = NON_STANDARD_VERSION_PATTERN.test(searchableText);
  const hdDefinition = candidate.definition === "hd";
  const sdDefinition = candidate.definition === "sd";
  const providerEvidence = QUALITY_KARAOKE_PROVIDER_PATTERN.test(channelTitle);
  const technicalFailures = getTechnicalGateFailures(candidate);
  const warnings = [];
  let score = 0;

  if (titleComplete || titlePhraseMatch) score += 45;
  else if (titleTokens.length > 0) score += Math.round((titleMatches.length / titleTokens.length) * 30);
  if (artistMatched) score += 25;
  if (titleText.includes(normalizedArtist)) score += 5;
  if (positiveTerms.length > 0) score += positiveTerms.includes("karaoke") ? 25 : 15;
  if (standardVersion) score += 8;
  if (qualityKaraoke) score += 3;
  if (normalKey) score += 3;
  if (channelText.includes("karaoke")) score += 5;
  if (positiveTerms.includes("instrumental") || positiveTerms.includes("backing track") || positiveTerms.includes("minus one")) score += 4;
  if (hdDefinition) score += 10;
  if (sdDefinition) score -= 8;
  if (providerEvidence) score += 3;
  if (partyTymeProvider) {
    score -= 100;
    warnings.push("quality-excluded provider: Party Tyme Karaoke");
  }

  const hardNegatives = SEARCH_HARD_NEGATIVES.filter(({ pattern }) => pattern.test(searchableText));
  hardNegatives.forEach(({ label }) => {
    score -= label === "cover" ? 35 : 45;
    warnings.push(label);
  });
  const keyPenalties = SEARCH_KEY_PENALTIES.filter(({ pattern }) => pattern.test(searchableText));
  keyPenalties.forEach(({ label }) => {
    score -= 20;
    warnings.push(label);
  });
  if (partOnly) {
    score -= 35;
    warnings.push("part-only");
  }
  if (instrumentalOnly) {
    score -= 25;
    warnings.push("instrumental-only");
  }
  if (nonStandardVersion) {
    score -= 25;
    warnings.push("non-standard version");
  }
  if (!titleComplete && !titlePhraseMatch) warnings.push("title match is incomplete");
  if (!artistMatched) warnings.push("artist match is not clear");
  if (positiveTerms.length === 0) warnings.push("karaoke suitability is not clear from title/channel metadata");

  const hardBlocked = hardNegatives.length > 0 || keyPenalties.length > 0 || partOnly || instrumentalOnly || nonStandardVersion || partyTymeProvider || technicalFailures.length > 0;
  technicalFailures.forEach((failure) => warnings.push(failure));
  const popularityPoints = !hardBlocked && titleComplete && artistMatched && positiveTerms.length > 0
    ? getPopularityPoints(candidate.viewCount, candidate.publishedAt)
    : 0;
  if (popularityPoints > 0) score += popularityPoints;
  const positiveQualityReasons = [];
  if (hdDefinition) positiveQualityReasons.push("HD metadata");
  if (sdDefinition) warnings.push("API definition=sd");
  if (providerEvidence) positiveQualityReasons.push("known karaoke provider signal");
  if (popularityPoints > 0) positiveQualityReasons.push("bounded popularity signal");
  const selectable = titleComplete && artistMatched && positiveTerms.length > 0 && !hardBlocked && score >= 70;
  const confidence = selectable && score >= 90 ? "high" : selectable ? "medium" : "low";
  const reasons = [];
  if (titleComplete || titlePhraseMatch) reasons.push("title match");
  if (artistMatched) reasons.push("artist match");
  if (positiveTerms.length > 0) reasons.push(positiveTerms[0]);
  reasons.push(...positiveQualityReasons);
  if (warnings.length > 0) reasons.push(...warnings.map((warning) => `warning: ${warning}`));

  return {
    ...candidate,
    score,
    confidence,
    selectable,
    partyTymeProvider,
    hardBlocked,
    hardBlockReasons: [
      ...hardNegatives.map(({ label }) => label),
      ...keyPenalties.map(({ label }) => label),
      ...(partOnly ? ["part-only"] : []),
      ...(instrumentalOnly ? ["instrumental-only"] : []),
      ...(nonStandardVersion ? ["non-standard version"] : []),
      ...technicalFailures
    ],
    technicalGatePass: technicalFailures.length === 0,
    hdDefinition,
    sdDefinition,
    providerEvidence,
    popularityPoints,
    popularityMetric: getPopularityMetric(candidate.viewCount, candidate.publishedAt),
    relativePopularityPoints: 0,
    reasons: [...new Set(reasons)]
  };
}

export function getPopularityPoints(viewCount, publishedAt, now = Date.now()) {
  const popularityMetric = getPopularityMetric(viewCount, publishedAt, now);
  if (popularityMetric <= 0) return 0;
  return Math.min(24, Math.max(0, Math.round((Math.log10(popularityMetric) - 2) * 4)));
}

export function getPopularityMetric(viewCount, publishedAt, now = Date.now()) {
  const views = Number(viewCount);
  if (!Number.isFinite(views) || views <= 0) return 0;
  const publishedMs = Date.parse(publishedAt || "");
  const ageYears = Number.isFinite(publishedMs)
    ? Math.max(0.5, (now - publishedMs) / (365.25 * 86400000))
    : 3;
  return views / (ageYears ** 0.35);
}

function getRelativePopularityPoints(popularityMetric, minimum, maximum) {
  if (!Number.isFinite(popularityMetric) || popularityMetric <= 0 || maximum <= minimum) return 0;
  const range = Math.log10(maximum) - Math.log10(minimum);
  if (range <= 0) return 0;
  const position = (Math.log10(popularityMetric) - Math.log10(minimum)) / range;
  return Math.min(14, Math.max(0, Math.round(position * 14)));
}

function getTechnicalGateFailures(candidate) {
  const failures = [];
  if (candidate?.apiVerified === false) failures.push("video unavailable");
  if (candidate?.embeddable === false) failures.push("not embeddable");
  if (candidate?.madeForKids === true) failures.push("Made-for-Kids policy failure");
  if (candidate?.qualityExcluded === true) failures.push("quality-excluded provider");
  return failures;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value) {
  const stopWords = new Set(["a", "an", "and", "as", "by", "for", "in", "it", "of", "on", "or", "the", "to", "with"]);
  return [...new Set(normalizeSearchText(value).split(" ").filter((token) => token.length > 1 && !stopWords.has(token)))];
}

function printSearchTable(songs, results, errors) {
  console.log("SONG ID | CATALOG SONG | VIDEO ID | YOUTUBE TITLE | CHANNEL | PUBLISHED");
  songs.forEach((song) => {
    const songResults = results.filter((result) => result.song.id === song.id);
    if (songResults.length === 0 && !errors.some((error) => error.song.id === song.id)) {
      console.log(`${song.id} | ${tableValue(`${song.title} — ${song.artist}`)} | (no results)`);
      return;
    }
    songResults.forEach(({ candidate }) => {
      console.log([
        song.id,
        tableValue(`${song.title} — ${song.artist}`),
        candidate.videoId,
        tableValue(candidate.videoTitle || "unknown"),
        tableValue(candidate.channelTitle || "unknown"),
        formatPublishedDate(candidate.publishedAt)
      ].join(" | "));
    });
  });
}

export async function autoBatch(options, dependencies = {}) {
  const catalog = await readCatalog(options.catalog);
  const reviewStore = await readReviewStore(options.review);
  const reviewFlags = getReviewFlags(reviewStore);
  const candidateFile = await readCandidateFile(options.candidates);
  const normalizedCandidates = normalizeCandidateMappings(candidateFile, catalog);
  const candidateBySong = new Map(normalizedCandidates.candidates.map((candidate) => [candidate.songId.toLowerCase(), candidate]));
  const eligibleSongs = catalog.filter((song) => !song.youtubeVideoId).slice(options.offset, options.offset + options.maxSongs);
  const apiKey = dependencies.apiKey || getApiKey();
  const fetchImplementation = dependencies.fetchImplementation || fetch;
  const searchRequestUrl = dependencies.searchApiUrl || SEARCH_API_URL;
  const requestConfig = getRequestConfig(options, dependencies);
  const rows = [];
  const selected = [];
  const newMappings = [];
  const searchCache = new Map();

  for (const song of eligibleSongs) {
    const flag = reviewFlags.get(song.id.toLowerCase());
    if (flag) {
      rows.push({ song, selected: null, confidence: "skipped", reasons: [`${flag.status}: ${flag.reason}`], warning: flag.reason });
      continue;
    }

    const existing = candidateBySong.get(song.id.toLowerCase());
    if (existing) {
      selected.push(existing);
      rows.push({ song, selected: existing, confidence: "existing", reasons: ["existing candidate mapping reused"], warning: null });
      continue;
    }

    const query = buildSearchQuery(song);
    try {
      let searchResults = searchCache.get(query.toLowerCase());
      if (!searchResults) {
        searchResults = await requestSearchResults(query, options.maxResults, apiKey, fetchImplementation, searchRequestUrl, requestConfig);
        searchCache.set(query.toLowerCase(), searchResults);
      }
      const ranked = rankSearchCandidates(song, searchResults);
      const best = ranked.find((candidate) => candidate.selectable) || null;
      if (!best) {
        rows.push({ song, selected: null, confidence: "none", reasons: ranked[0]?.reasons || ["no conservative candidate passed the selection gate"], warning: "No candidate was automatically selected." });
        continue;
      }
      const mapped = { songId: song.id, candidateVideoId: best.videoId, song };
      const conflicting = normalizedCandidates.candidates.find((candidate) => candidate.candidateVideoId === best.videoId && candidate.songId.toLowerCase() !== song.id.toLowerCase()) || newMappings.find((candidate) => candidate.candidateVideoId === best.videoId && candidate.songId.toLowerCase() !== song.id.toLowerCase());
      if (conflicting) {
        rows.push({ song, selected: null, confidence: best.confidence, reasons: best.reasons, warning: `Candidate video is already bound to ${conflicting.songId}.` });
        continue;
      }
      selected.push(mapped);
      newMappings.push(mapped);
      rows.push({ song, selected: { ...mapped, ...best }, confidence: best.confidence, reasons: best.reasons, warning: null });
    } catch (error) {
      rows.push({ song, selected: null, confidence: "error", reasons: ["search failed"], warning: error.message, error: true });
    }
  }

  if (!options.dryRun && newMappings.length > 0) {
    await atomicWriteJson(resolve(options.candidates), {
      version: CANDIDATE_VERSION,
      candidates: [
        ...normalizedCandidates.candidates.map((candidate) => ({ songId: candidate.songId, candidateVideoId: candidate.candidateVideoId })),
        ...newMappings.map((candidate) => ({ songId: candidate.songId, candidateVideoId: candidate.candidateVideoId }))
      ]
    });
  }

  let verification = { records: [], failedBatches: 0, haltReason: null, deferredVideoIds: [] };
  if (!options.dryRun && selected.length > 0) {
    verification = await verifyMappedCandidates(options, selected, dependencies);
  }

  const verifiedByKey = new Map(verification.records.map((record) => [`${record.songId}::${record.candidateVideoId}`, record]));
  rows.forEach((row) => {
    if (!row.selected) return;
    const key = `${row.selected.songId}::${row.selected.candidateVideoId}`;
    const verified = verifiedByKey.get(key);
    if (verified) {
      row.verification = verified;
      if (technicalStatus(verified) !== "pass" && !row.warning) row.warning = `Technical verification failed: ${technicalStatus(verified)}.`;
    }
  });
  printAutoBatchTable(rows);
  printSummary(catalog, normalizedCandidates.candidates.concat(newMappings), await readVerificationStore(options.file), reviewFlags);
  console.log(`Auto-batch complete: ${rows.length} song${rows.length === 1 ? "" : "s"} considered, ${newMappings.length} candidate${newMappings.length === 1 ? "" : "s"} selected, ${verification.records.length} technically checked, ${verification.failedBatches} API batch failure${verification.failedBatches === 1 ? "" : "s"}.`);
  console.log("No public catalog video ID was changed. Human song-match and karaoke-suitability approval is still required.");
  if (rows.some((row) => row.error) || normalizedCandidates.rejected.length > 0 || verification.failedBatches > 0) process.exitCode = 1;
  return { rows, selected, newMappings, verification, reviewFlags };
}

export function evaluateAutoHighConfidence(song, rankedCandidates, technicalRecord) {
  const selectable = rankedCandidates.filter((candidate) => candidate.selectable);
  const candidate = selectable[0] || rankedCandidates[0] || null;
  const reasons = [];
  if (!candidate) reasons.push("no search candidate passed the deterministic ranking rules");
  if (candidate && candidate.confidence !== "high") reasons.push("candidate confidence is below high");
  if (candidate && candidate.reasons.some((reason) => reason.startsWith("warning:"))) reasons.push(...candidate.reasons.filter((reason) => reason.startsWith("warning:")));
  if (!technicalRecord || technicalRecord.apiVerified !== true) reasons.push("video was not returned by videos.list");
  if (technicalRecord && technicalRecord.embeddable !== true) reasons.push(`embeddable=${formatBoolean(technicalRecord.embeddable)}`);
  if (technicalRecord && technicalRecord.madeForKids !== false) reasons.push(`madeForKids=${formatBoolean(technicalRecord.madeForKids)}`);
  const definition = technicalRecord?.definition || candidate?.definition || null;
  if (definition === "sd") reasons.push("video definition is SD; automatic promotion requires an HD candidate when available");
  if (candidate && !candidate.reasons.includes("title match")) reasons.push("title match is not exact or strongly normalized");
  if (candidate && !candidate.reasons.includes("artist match")) reasons.push("expected artist is not clearly represented");
  if (candidate && !candidate.reasons.some((reason) => ["karaoke", "instrumental", "backing track", "minus one", "sing along"].includes(reason))) reasons.push("karaoke wording is missing from the video title");
  const uniqueReasons = [...new Set(reasons)];
  return {
    passed: uniqueReasons.length === 0,
    candidate,
    reasons: uniqueReasons.length > 0 ? uniqueReasons : ["exact title and artist match, clear karaoke wording, strict API checks passed"],
    reason: uniqueReasons.length > 0 ? uniqueReasons.join("; ") : "high-confidence automated match"
  };
}

function requiresCandidateReevaluation(record) {
  if (!record) return false;
  const reasons = stringArray(record.decisionReasons);
  return record.provenance === "review-required"
    || record.reviewReason === LEGACY_CLOSE_SCORE_REASON
    || reasons.includes(LEGACY_CLOSE_SCORE_REASON);
}

export async function unassignPartyTymeAssignments(options, dependencies = {}) {
  const catalog = await readCatalog(options.catalog);
  const rawCatalog = await readJson(resolve(options.catalog), "public catalog");
  if (!Array.isArray(rawCatalog)) throw new Error("Public catalog must be a top-level array.");
  const store = await readVerificationStore(options.file);
  const songsById = new Map(catalog.map((song) => [song.id.toLowerCase(), song]));
  const affected = [];
  const seenSongIds = new Set();

  for (const record of store.records) {
    if (record.status !== "verified" || !PARTY_TYME_CHANNEL_PATTERN.test(record.channelTitle || "") || !record.songId || !isValidVideoId(record.candidateVideoId)) continue;
    const song = songsById.get(record.songId.toLowerCase());
    if (!song || song.youtubeVideoId !== record.candidateVideoId) continue;
    if (seenSongIds.has(song.id.toLowerCase())) throw new Error(`Multiple current Party Tyme records found for ${song.id}; no catalog changes were made.`);
    seenSongIds.add(song.id.toLowerCase());
    affected.push({
      song,
      songId: song.id,
      videoId: record.candidateVideoId,
      videoTitle: record.videoTitle || null,
      channelTitle: record.channelTitle || null,
      provenance: record.provenance || null
    });
  }
  affected.sort((left, right) => left.songId.localeCompare(right.songId, undefined, { numeric: true }));

  console.log("CONFIRMED PARTY TYME ASSIGNMENTS");
  if (affected.length === 0) console.log("(none)");
  affected.forEach((item) => console.log(`${item.songId} | ${tableValue(item.song.title)} — ${tableValue(item.song.artist)} | ${item.videoId} | ${tableValue(item.channelTitle || "(unknown)")}`));
  if (options.dryRun || affected.length === 0) {
    console.log(options.dryRun ? "Dry run: no catalog, verification, or review files were changed." : "No current Party Tyme assignments required unassignment.");
    return { affected, changed: false };
  }

  const now = typeof dependencies.now === "function" ? dependencies.now() : new Date();
  const unassignedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const affectedByKey = new Map(affected.map((item) => [item.songId.toLowerCase(), item]));
  const nextRecords = store.records.map((record) => {
    const item = affectedByKey.get(record.songId?.toLowerCase());
    if (!item || record.candidateVideoId !== item.videoId) return record;
    return {
      ...record,
      unassignmentReason: PARTY_TYME_UNASSIGNMENT_REASON,
      unassignedAt,
      unassignmentProvenance: QUALITY_UNASSIGNMENT_PROVENANCE
    };
  });
  const reviewStore = await readReviewStore(options.review);
  const reviewBySong = new Map(reviewStore.flags.map((flag) => [flag.songId.toLowerCase(), flag]));
  affected.forEach((item) => {
    reviewBySong.set(item.songId.toLowerCase(), {
      songId: item.songId,
      status: QUALITY_EXCLUSION_STATUS,
      reason: PARTY_TYME_UNASSIGNMENT_REASON,
      updatedAt: unassignedAt,
      candidateVideoId: item.videoId
    });
  });
  const nextCatalog = rawCatalog.map((song) => affectedByKey.has(String(song?.id || "").toLowerCase()) ? { ...song, youtubeVideoId: null } : song);

  // Persist the historical decision before removing the public assignment. If
  // the final catalog write is interrupted, the old verified evidence remains
  // recoverable and the command can be safely rerun.
  await writeVerificationStore(options.file, { version: VERIFICATION_VERSION, records: nextRecords });
  await atomicWriteJson(resolve(options.review), { version: REVIEW_VERSION, flags: [...reviewBySong.values()] });
  await atomicWriteJson(resolve(options.catalog), nextCatalog);
  console.log(`Unassigned ${affected.length} Party Tyme assignment(s) by product-quality decision.`);
  return { affected, changed: true, unassignedAt };
}

export async function autoComplete(options, dependencies = {}) {
  const diagnostic = { phase: "initialization", songId: null };
  try {
    return await autoCompleteRun(options, dependencies, diagnostic);
  } catch (error) {
    if (!error.phase) error.phase = diagnostic.phase;
    if (!error.songId && diagnostic.songId) error.songId = diagnostic.songId;
    throw error;
  }
}

async function autoCompleteRun(options, dependencies = {}, diagnostic = { phase: "initialization", songId: null }) {
  diagnostic.phase = "loading persisted state";
  const catalog = await readCatalog(options.catalog);
  const normalizationIssues = { verification: [], candidates: [], review: [] };
  const tolerant = (kind) => ({
    tolerateMalformed: true,
    onIssue: (message) => normalizationIssues[kind].push(message)
  });
  const reviewStore = await readReviewStore(options.review, tolerant("review"));
  const reviewFlags = getReviewFlags(reviewStore);
  const candidateFile = await readCandidateFile(options.candidates);
  const normalizedCandidates = normalizeCandidateMappings(candidateFile, catalog, tolerant("candidates"));
  const storeBefore = await readVerificationStore(options.file, tolerant("verification"));
  if (normalizationIssues.verification.length > 0) console.warn(`AUTO-COMPLETE WARNING | ${normalizationIssues.verification.join("; ")}`);
  if (normalizationIssues.candidates.length > 0) console.warn(`AUTO-COMPLETE WARNING | ${normalizationIssues.candidates.join("; ")}`);
  if (normalizationIssues.review.length > 0) console.warn(`AUTO-COMPLETE WARNING | ${normalizationIssues.review.join("; ")}`);
  if (!options.dryRun && normalizationIssues.verification.length > 0) await writeVerificationStore(options.file, storeBefore);
  if (!options.dryRun && normalizationIssues.review.length > 0) await atomicWriteJson(resolve(options.review), reviewStore);
  if (!options.dryRun && normalizationIssues.candidates.length > 0) {
    await atomicWriteJson(resolve(options.candidates), {
      version: CANDIDATE_VERSION,
      candidates: normalizedCandidates.candidates.map((candidate) => ({ songId: candidate.songId, candidateVideoId: candidate.candidateVideoId }))
    });
  }
  const candidatesBySong = new Map();
  normalizedCandidates.candidates.forEach((candidate) => {
    const key = candidate.songId.toLowerCase();
    if (!candidatesBySong.has(key)) candidatesBySong.set(key, []);
    candidatesBySong.get(key).push(candidate);
  });
  const eligibleSongs = catalog.filter((song) => !song.youtubeVideoId);
  let apiKey = dependencies.apiKey || null;
  const fetchImplementation = dependencies.fetchImplementation || fetch;
  const searchRequestUrl = dependencies.searchApiUrl || SEARCH_API_URL;
  const requestConfig = getRequestConfig(options, dependencies);
  const rows = [];
  const selected = [];
  const newMappings = [];
  const replacementSongIds = new Set();
  const searchCache = new Map();
  const promotedVideoOwners = new Map(catalog.filter((song) => song.youtubeVideoId).map((song) => [song.youtubeVideoId, song.id.toLowerCase()]));
  const deferredSongs = new Map();
  const persistedDeferredStates = new Map();
  const promotedSongIds = new Set(catalog.filter((song) => song.youtubeVideoId).map((song) => song.id.toLowerCase()));
  reviewStore.flags.filter((flag) => isDeferredStatus(flag.status)).forEach((flag) => {
    const key = flag.songId.toLowerCase();
    if (!promotedSongIds.has(key)) persistedDeferredStates.set(key, canonicalDeferredState(persistedDeferredStates.get(key), {
      songId: flag.songId,
      status: flag.status,
      reason: flag.reason,
      candidateVideoId: flag.candidateVideoId,
      attemptCount: flag.attemptCount,
      lastAttemptAt: flag.lastAttemptAt,
      nextEligibleAt: flag.nextEligibleAt,
      httpStatus: flag.httpStatus,
      httpClassification: flag.httpClassification,
      retryAfterMs: flag.retryAfterMs
    }));
  });
  storeBefore.records.filter((record) => isDeferredProvenance(record.provenance) && record.songId && !promotedSongIds.has(record.songId.toLowerCase())).forEach((record) => {
    const key = record.songId.toLowerCase();
    persistedDeferredStates.set(key, canonicalDeferredState(persistedDeferredStates.get(key), {
      songId: record.songId,
      status: record.provenance,
      reason: record.reviewReason || record.decisionReasons?.[0] || `${record.provenance}: deferred until the YouTube API is available again.`,
      candidateVideoId: record.candidateVideoId,
      attemptCount: record.attemptCount,
      lastAttemptAt: record.lastAttemptAt,
      nextEligibleAt: record.nextEligibleAt,
      httpStatus: record.httpStatus,
      httpClassification: record.httpClassification,
      retryAfterMs: record.retryAfterMs
    }));
  });
  const persistedDeferredSongIds = new Set(persistedDeferredStates.keys());
  const newlyDeferredSongIds = new Set();
  const retriedDeferredSongIds = new Set();
  const attemptedSongIds = new Set();
  const resolvedDeferredSongIds = new Set();
  let haltStatus = null;
  let haltReason = null;
  let apiStatus = "not-needed";

  const currentTime = () => {
    const value = typeof dependencies.now === "function" ? dependencies.now() : new Date();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  };

  const markAttempted = (song) => {
    const songKey = song.id.toLowerCase();
    attemptedSongIds.add(songKey);
    if (persistedDeferredSongIds.has(songKey)) retriedDeferredSongIds.add(songKey);
  };

  const markResolved = (song) => {
    const songKey = song.id.toLowerCase();
    if (persistedDeferredSongIds.has(songKey)) resolvedDeferredSongIds.add(songKey);
  };

  const deferredEntry = (song, reason, status, error = null, candidateVideoId = null) => {
    const songKey = song.id.toLowerCase();
    const previous = persistedDeferredStates.get(songKey) || {};
    const attemptCount = (previous.attemptCount || 0) + 1;
    const attemptedAt = currentTime();
    const cooldown = deferredCooldownMs(error, attemptCount, { ...options, ...dependencies });
    const nextEligibleAt = new Date(attemptedAt.getTime() + cooldown).toISOString();
    return {
      song,
      reason: reason || "deferred until the YouTube API is available again",
      status: status || "deferred-rate-limit",
      candidateVideoId: candidateVideoId || previous.candidateVideoId || null,
      attemptCount,
      lastAttemptAt: attemptedAt.toISOString(),
      nextEligibleAt,
      httpStatus: validHttpStatus(error?.status),
      httpClassification: deferredHttpClassification(error),
      retryAfterMs: nonNegativeIntegerOrNull(error?.retryAfterMs)
    };
  };

  const deferSong = (song, reason, status = haltStatus || "deferred-rate-limit", error = null, candidateVideoId = null) => {
    const entry = deferredEntry(song, reason, status, error, candidateVideoId);
    const songKey = song.id.toLowerCase();
    rows.push({ song, state: entry.status, reason: entry.reason, deferred: entry });
    deferredSongs.set(songKey, entry);
    if (!persistedDeferredSongIds.has(songKey)) newlyDeferredSongIds.add(songKey);
  };
  const deferRow = (row, reason, status = haltStatus || "deferred-rate-limit", error = null) => {
    const entry = deferredEntry(row.song, reason, status, error, row.mapping?.candidateVideoId || null);
    const songKey = row.song.id.toLowerCase();
    row.state = entry.status;
    row.reason = entry.reason;
    row.deferred = entry;
    deferredSongs.set(songKey, entry);
    if (!persistedDeferredSongIds.has(songKey)) newlyDeferredSongIds.add(songKey);
  };

  const searchForCandidate = async (song) => {
    const query = buildSearchQuery(song);
    let searchResults = searchCache.get(query.toLowerCase());
    if (!searchResults) {
      markAttempted(song);
      apiKey ||= getApiKey();
      searchResults = await requestSearchResults(query, options.maxResults, apiKey, fetchImplementation, searchRequestUrl, requestConfig);
      apiStatus = "available";
      searchCache.set(query.toLowerCase(), searchResults);
    }
    const ranked = rankSearchCandidates(song, searchResults);
    return { ranked, candidate: ranked.find((item) => item.selectable) || null };
  };

  for (const song of eligibleSongs) {
    diagnostic.phase = "evaluating catalog song";
    diagnostic.songId = song.id;
    const flag = reviewFlags.get(song.id.toLowerCase());
    if (flag && flag.status !== "deferred-rate-limit" && flag.status !== "quota-deferred") {
      rows.push({ song, state: "skipped", reason: `${flag.status}: ${flag.reason}` });
      continue;
    }
    const persistedDeferred = persistedDeferredStates.get(song.id.toLowerCase());
    if (persistedDeferred && retryTimestampIsFuture(persistedDeferred.nextEligibleAt, currentTime().getTime())) {
      rows.push({ song, state: "pending", reason: `deferred cooldown active until ${persistedDeferred.nextEligibleAt}`, cooldown: true });
      continue;
    }
    if (haltReason) {
      rows.push({ song, state: "pending", reason: `pending: ${haltReason}; this song was not attempted` });
      continue;
    }

    const existingMappings = candidatesBySong.get(song.id.toLowerCase()) || [];
    if (existingMappings.length > 1) {
      rows.push({ song, state: "review", reason: "multiple candidate mappings exist for this song" });
      continue;
    }
    if (existingMappings.length === 1) {
      const mapping = existingMappings[0];
      const promotedOwner = promotedVideoOwners.get(mapping.candidateVideoId);
      if (promotedOwner && promotedOwner !== song.id.toLowerCase()) {
        rows.push({ song, mapping, state: "review", reason: `candidate video is already promoted for ${promotedOwner}` });
        continue;
      }
      const prior = storeBefore.records.find((record) => record.songId?.toLowerCase() === song.id.toLowerCase() && record.candidateVideoId === mapping.candidateVideoId);
      if (requiresCandidateReevaluation(prior)) {
        diagnostic.phase = "reevaluating persisted candidate";
        try {
          const { ranked, candidate } = await searchForCandidate(song);
          if (!candidate) {
            rows.push({ song, mapping, ranked, state: "review", reason: ranked[0]?.reasons?.join("; ") || "no conservative candidate passed the selection gate" });
            continue;
          }
          const conflicting = normalizedCandidates.candidates.find((item) => item.candidateVideoId === candidate.videoId && item.songId.toLowerCase() !== song.id.toLowerCase()) || newMappings.find((item) => item.candidateVideoId === candidate.videoId && item.songId.toLowerCase() !== song.id.toLowerCase());
          if (conflicting) {
            rows.push({ song, mapping, ranked, state: "review", reason: `candidate video is already bound to ${conflicting.songId}` });
            continue;
          }
          const promotedCandidateOwner = promotedVideoOwners.get(candidate.videoId);
          if (promotedCandidateOwner && promotedCandidateOwner !== song.id.toLowerCase()) {
            rows.push({ song, mapping, ranked, state: "review", reason: `candidate video is already promoted for ${promotedCandidateOwner}` });
            continue;
          }
          const refreshedMapping = { songId: song.id, candidateVideoId: candidate.videoId, song };
          replacementSongIds.add(song.id.toLowerCase());
          newMappings.push(refreshedMapping);
          selected.push({ ...refreshedMapping, source: "search", candidate });
          rows.push({ song, mapping: refreshedMapping, ranked, state: "selected", reason: "persisted review candidate reevaluated under current deterministic rules" });
        } catch (error) {
          if (error.rateLimited) {
            haltReason = deferredReason(error);
            haltStatus = deferredStatus(error);
            apiStatus = haltStatus === "quota-deferred" ? "quota-exhausted" : "temporarily-rate-limited";
            deferSong(song, haltReason, haltStatus, error, mapping.candidateVideoId);
          } else {
            rows.push({ song, mapping, state: "failed", reason: error.message });
          }
        }
        continue;
      }
      const priorCandidate = prior?.videoTitle ? { videoId: mapping.candidateVideoId, videoTitle: prior.videoTitle, channelTitle: prior.channelTitle } : null;
      selected.push({ ...mapping, source: "existing", candidate: priorCandidate });
      rows.push({ song, mapping, ranked: priorCandidate ? rankSearchCandidates(song, [priorCandidate]) : null, state: "selected", reason: "existing candidate mapping reused" });
      continue;
    }

    try {
      const { ranked, candidate } = await searchForCandidate(song);
      if (!candidate) {
        rows.push({ song, ranked, state: "review", reason: "no conservative candidate passed the selection gate" });
        continue;
      }
      const mapping = { songId: song.id, candidateVideoId: candidate.videoId, song };
      const conflicting = normalizedCandidates.candidates.find((item) => item.candidateVideoId === candidate.videoId && item.songId.toLowerCase() !== song.id.toLowerCase()) || newMappings.find((item) => item.candidateVideoId === candidate.videoId && item.songId.toLowerCase() !== song.id.toLowerCase());
      if (conflicting) {
        rows.push({ song, ranked, state: "review", reason: `candidate video is already bound to ${conflicting.songId}` });
        continue;
      }
      const promotedOwner = promotedVideoOwners.get(candidate.videoId);
      if (promotedOwner && promotedOwner !== song.id.toLowerCase()) {
        rows.push({ song, ranked, state: "review", reason: `candidate video is already promoted for ${promotedOwner}` });
        continue;
      }
      newMappings.push(mapping);
      selected.push({ ...mapping, source: "search", candidate });
      rows.push({ song, mapping, ranked, state: "selected", reason: "high-confidence candidate selected for technical verification" });
    } catch (error) {
      if (error.rateLimited) {
        haltReason = deferredReason(error);
        haltStatus = deferredStatus(error);
        apiStatus = haltStatus === "quota-deferred" ? "quota-exhausted" : "temporarily-rate-limited";
        deferSong(song, haltReason, haltStatus, error);
        continue;
      }
      rows.push({ song, state: "failed", reason: error.message });
    }
  }

  if (!options.dryRun && newMappings.length > 0) {
    await atomicWriteJson(resolve(options.candidates), {
      version: CANDIDATE_VERSION,
      candidates: [
        ...normalizedCandidates.candidates
          .filter((candidate) => !replacementSongIds.has(candidate.songId.toLowerCase()))
          .map((candidate) => ({ songId: candidate.songId, candidateVideoId: candidate.candidateVideoId })),
        ...newMappings.map((candidate) => ({ songId: candidate.songId, candidateVideoId: candidate.candidateVideoId }))
      ]
    });
  }

  let verification = { records: [], failedBatches: 0, haltReason: null, haltStatus: null, deferredVideoIds: [] };
  if (!options.dryRun && selected.length > 0 && !haltReason) {
    selected.forEach((candidate) => markAttempted(candidate.song));
    verification = await verifyMappedCandidates(options, selected, dependencies);
    if (verification.apiStatus && verification.apiStatus !== "not-needed") apiStatus = verification.apiStatus;
  }
  if (verification.haltReason) haltReason = haltReason || verification.haltReason;
  if (verification.haltStatus) haltStatus = haltStatus || verification.haltStatus;
  const deferredVideoIdsList = requiredArray(verification.deferredVideoIds, "verification.deferredVideoIds", diagnostic);
  if (haltReason && selected.length > 0 && deferredVideoIdsList.length === 0) verification.deferredVideoIds = selected.map((candidate) => candidate.candidateVideoId);
  const deferredVideoIds = new Set(requiredArray(verification.deferredVideoIds, "verification.deferredVideoIds", diagnostic));
  const verifiedRecords = requiredArray(verification.records, "verification.records", diagnostic);
  const technicalByKey = new Map(verifiedRecords.map((record) => [`${record.songId}::${record.candidateVideoId}`, record]));
  diagnostic.phase = "applying technical verification decisions";
  const currentStore = options.dryRun ? storeBefore : await readVerificationStore(options.file, tolerant("verification"));
  const autoPromotions = [];
  const held = [];
  const failed = rows.filter((row) => row.state === "failed").map((row) => ({ song: row.song, reason: row.reason }));
  let deferredRecordChanged = false;
  let reviewRecordChanged = false;

  for (const row of rows.filter((item) => item.state === "selected")) {
    const key = `${row.mapping.songId}::${row.mapping.candidateVideoId}`;
    const record = currentStore.records.find((item) => item.songId === row.mapping.songId && item.candidateVideoId === row.mapping.candidateVideoId) || technicalByKey.get(key);
    if (deferredVideoIds.has(row.mapping.candidateVideoId)) {
      if (record && record.provenance !== "human-reviewed" && record.provenance !== "auto-high-confidence") {
        record.provenance = haltStatus || "deferred-rate-limit";
        record.autoChecksPassed = false;
        record.decisionReasons = [haltReason || "deferred-rate-limit: candidate verification was deferred."];
        record.reviewReason = haltReason || "deferred-rate-limit: candidate verification was deferred.";
        record.decisionAt = new Date().toISOString();
        record.verifiedAt = null;
        const details = verification.deferredError;
        const entry = deferredEntry(row.song, haltReason, haltStatus || "deferred-rate-limit", details, row.mapping.candidateVideoId);
        Object.assign(record, {
          attemptCount: entry.attemptCount,
          lastAttemptAt: entry.lastAttemptAt,
          nextEligibleAt: entry.nextEligibleAt,
          httpStatus: entry.httpStatus,
          httpClassification: entry.httpClassification,
          retryAfterMs: entry.retryAfterMs
        });
        deferredRecordChanged = true;
      }
      deferRow(row, haltReason || "candidate verification deferred because the API rate limit was reached", haltStatus || "deferred-rate-limit", verification.deferredError);
      continue;
    }
    if (haltReason && !record) {
      row.state = "pending";
      row.reason = `pending: ${haltReason}; candidate verification was not attempted`;
      continue;
    }
    if (!record) {
      failed.push({ song: row.song, reason: "technical verification did not produce a record" });
      row.state = "failed";
      row.reason = "technical verification did not produce a record";
      continue;
    }
    const metadataCandidate = row.ranked || rankSearchCandidates(row.song, [{ videoId: record.candidateVideoId, videoTitle: record.videoTitle, channelTitle: record.channelTitle }]);
    const decision = evaluateAutoHighConfidence(row.song, metadataCandidate, record);
    if (!decision.passed) {
      record.status = record.apiVerified === true ? "candidate" : record.status;
      record.provenance = "review-required";
      record.autoChecksPassed = false;
      record.decisionReasons = decision.reasons;
      record.reviewReason = decision.reason;
      record.decisionAt = new Date().toISOString();
      record.verifiedAt = null;
      held.push({ song: row.song, record, reason: decision.reason });
      row.state = "review";
      row.reason = decision.reason;
      markResolved(row.song);
      continue;
    }
    record.status = "verified";
    record.provenance = "auto-high-confidence";
    record.autoChecksPassed = true;
    record.manuallyMatched = false;
    record.karaokeSuitable = false;
    record.decisionReasons = decision.reasons;
    record.reviewReason = null;
    record.decisionAt = new Date().toISOString();
    record.verifiedAt = record.decisionAt;
    autoPromotions.push({ song: row.song, record, reason: decision.reason });
    row.state = "auto-high-confidence";
    row.reason = decision.reason;
    markResolved(row.song);
  }

  rows.filter((row) => row.state === "review" && row.mapping).forEach((row) => {
    const record = currentStore.records.find((item) => item.songId === row.mapping.songId && item.candidateVideoId === row.mapping.candidateVideoId);
    if (!record || !requiresCandidateReevaluation(record) || !row.reason || row.reason === LEGACY_CLOSE_SCORE_REASON) return;
    record.provenance = "review-required";
    record.autoChecksPassed = false;
    record.decisionReasons = [row.reason];
    record.reviewReason = row.reason;
    record.decisionAt = new Date().toISOString();
    record.verifiedAt = null;
    reviewRecordChanged = true;
  });

  rows.filter((row) => row.state === "review" && persistedDeferredSongIds.has(row.song.id.toLowerCase())).forEach((row) => markResolved(row.song));
  const resolvedOrPromoted = new Set([...resolvedDeferredSongIds, ...promotedSongIds]);
  const recordCountBeforeCleanup = currentStore.records.length;
  currentStore.records = currentStore.records.filter((record) => !((isDeferredProvenance(record.provenance) || record.provenance === "review-required") && record.songId && resolvedOrPromoted.has(record.songId.toLowerCase())));
  if (currentStore.records.length !== recordCountBeforeCleanup) deferredRecordChanged = true;

  if (!options.dryRun && (verifiedRecords.length > 0 || deferredRecordChanged || reviewRecordChanged || normalizationIssues.verification.length > 0)) await writeVerificationStore(options.file, currentStore);

  const rawCatalog = options.dryRun ? null : await readJson(resolve(options.catalog), "public catalog");
  const promoted = [];
  const skipped = rows.filter((row) => row.state === "skipped").map((row) => ({ song: row.song, reason: row.reason }));
  const heldSongIds = new Set(held.map(({ song }) => song.id.toLowerCase()));
  rows.filter((row) => row.state === "review" && !heldSongIds.has(row.song.id.toLowerCase())).forEach((row) => {
    held.push({ song: row.song, record: row.mapping ? currentStore.records.find((item) => item.songId === row.mapping.songId && item.candidateVideoId === row.mapping.candidateVideoId) : null, reason: row.reason });
  });
  const finalReviewStore = await persistAutoCompleteReviewState(options, reviewStore, persistedDeferredStates, deferredSongs, resolvedDeferredSongIds, rows, catalog);
  if (!options.dryRun) {
    if (!Array.isArray(rawCatalog)) throw new Error("Public catalog must be a top-level array.");
    for (const { song, record, reason } of autoPromotions) {
      const rawSong = rawCatalog.find((item) => item && item.id === song.id);
      if (!rawSong) {
        failed.push({ song, reason: "catalog song disappeared during promotion" });
        continue;
      }
      if (rawSong.youtubeVideoId) {
        skipped.push({ song, reason: "already-promoted" });
        continue;
      }
      rawSong.youtubeVideoId = record.candidateVideoId;
      promoted.push({ song, record, reason });
    }
    if (promoted.length > 0) await atomicWriteJson(resolve(options.catalog), rawCatalog);
  }

  printAutoCompleteReport(promoted, held, skipped, failed);
  diagnostic.phase = "writing and summarizing results";
  const finalCatalog = options.dryRun ? catalog : await readCatalog(options.catalog);
  const finalStore = options.dryRun ? currentStore : await readVerificationStore(options.file, tolerant("verification"));
  const summary = buildAutoCompleteSummary(finalCatalog, finalStore, finalReviewStore, promoted.length, held.length, {
    newlyDeferredSongIds,
    deferredSongs,
    persistedDeferredSongIds,
    retriedDeferredSongIds,
    rows,
    apiStatus
  });
  printAutoCompleteSummary(summary);
  if (failed.length > 0 || verification.failedBatches > 0) process.exitCode = 1;
  return { promoted, held, skipped, failed, verification, rows, summary };
}

function printAutoCompleteReport(promoted, held, skipped, failed) {
  printDecisionSection("AUTO-PROMOTED", promoted.map(({ song, record, reason }) => `${song.id} | ${record.candidateVideoId} | ${tableValue(song.title)} — ${tableValue(song.artist)} | ${reason}`));
  printDecisionSection("REVIEW REQUIRED", held.map(({ song, record, reason }) => `${song.id} | ${record?.candidateVideoId || "(none)"} | ${tableValue(song.title)} — ${tableValue(song.artist)} | ${reason}`));
  printDecisionSection("SKIPPED", skipped.map(({ song, reason }) => `${song.id} | ${tableValue(song.title)} — ${tableValue(song.artist)} | ${reason}`));
  printDecisionSection("FAILED", failed.map(({ song, reason }) => `${song.id} | ${tableValue(song.title)} — ${tableValue(song.artist)} | ${reason}`));
}

function printDecisionSection(label, lines) {
  const safeLines = requiredArray(lines, `${label} lines`);
  console.log(label);
  if (safeLines.length === 0) console.log("(none)");
  safeLines.forEach((line) => console.log(line));
}

function buildAutoCompleteSummary(catalog, store, reviewStore, autoPromotedThisRun, reviewRequiredThisRun, context = {}) {
  const records = requiredArray(store?.records, "verification.records");
  const flags = requiredArray(reviewStore?.flags, "review.flags");
  const deferredRateLimitTotal = new Set([
    ...records.filter((record) => record.provenance === "deferred-rate-limit").map((record) => record.songId).filter(Boolean),
    ...flags.filter((flag) => flag.status === "deferred-rate-limit").map((flag) => flag.songId)
  ]);
  const quotaDeferredTotal = new Set([
    ...records.filter((record) => record.provenance === "quota-deferred").map((record) => record.songId).filter(Boolean),
    ...flags.filter((flag) => flag.status === "quota-deferred").map((flag) => flag.songId)
  ]);
  const newlyDeferredSongIds = context.newlyDeferredSongIds || new Set();
  const deferredSongs = context.deferredSongs || new Map();
  const persistedDeferredSongIds = context.persistedDeferredSongIds || new Set();
  const retriedDeferredSongIds = context.retriedDeferredSongIds || new Set();
  const rows = context.rows || [];
  const retriedDeferredThisRun = [...retriedDeferredSongIds].length;
  const finalDeferredIds = new Set([...deferredRateLimitTotal, ...quotaDeferredTotal].map((songId) => String(songId).toLowerCase()));
  const recoveredDeferredThisRun = [...retriedDeferredSongIds].filter((songId) => !finalDeferredIds.has(String(songId).toLowerCase())).length;
  const reviewRequiredIds = new Set([
    ...records.filter((record) => displayProvenance(record) === "review-required" && record.songId).map((record) => record.songId.toLowerCase()),
    ...flags.filter((flag) => flag.status === "review-required" && flag.songId).map((flag) => flag.songId.toLowerCase())
  ]);
  const qualityExcludedIds = new Set(flags.filter((flag) => flag.status === QUALITY_EXCLUSION_STATUS && flag.songId).map((flag) => flag.songId.toLowerCase()));
  const autoHighConfidenceIds = new Set(records.filter((record) => displayProvenance(record) === "auto-high-confidence" && record.songId).map((record) => record.songId.toLowerCase()));
  const pendingIds = new Set(rows.filter((row) => row.state === "pending" && row.song?.id).map((row) => row.song.id.toLowerCase()));
  const knownExceptionIds = new Set([...BUILTIN_REVIEW_FLAGS.keys()].filter((songId) => catalog.some((song) => song.id.toLowerCase() === songId && !song.youtubeVideoId)));
  const futureRetryTimes = flags.filter((flag) => isDeferredStatus(flag.status) && flag.nextEligibleAt && Date.parse(flag.nextEligibleAt) > Date.now()).map((flag) => flag.nextEligibleAt).sort();
  const deferredRateLimitThisRun = [...newlyDeferredSongIds].filter((songId) => deferredSongs.get(songId)?.status === "deferred-rate-limit").length;
  const quotaDeferredThisRun = [...newlyDeferredSongIds].filter((songId) => deferredSongs.get(songId)?.status === "quota-deferred").length;
  return {
    catalog: catalog.length,
    playable: catalog.filter((song) => song.youtubeVideoId).length,
    autoPromotedThisRun,
    reviewRequiredThisRun,
    deferredRateLimitThisRun,
    deferredRateLimitTotal: deferredRateLimitTotal.size,
    retriedDeferredThisRun,
    recoveredDeferredThisRun,
    quotaDeferredThisRun,
    quotaDeferredTotal: quotaDeferredTotal.size,
    humanReviewedTotal: new Set(records.filter((record) => displayProvenance(record) === "human-reviewed" && record.songId).map((record) => record.songId.toLowerCase())).size,
    autoHighConfidenceTotal: autoHighConfidenceIds.size,
    reviewRequiredTotal: reviewRequiredIds.size,
    qualityExcludedTotal: qualityExcludedIds.size,
    pendingEligibleTotal: pendingIds.size,
    knownExceptionsTotal: knownExceptionIds.size,
    apiStatus: context.apiStatus || "not-needed",
    nextRetryAt: futureRetryTimes[0] || null,
    remainingNull: catalog.filter((song) => !song.youtubeVideoId).length
  };
}

function printAutoCompleteSummary(summary) {
  if (summary.apiStatus === "temporarily-rate-limited") console.log("API temporarily rate-limited; remaining eligible songs left pending.");
  if (summary.apiStatus === "quota-exhausted") console.log("API quota exhausted; remaining eligible songs left pending.");
  console.log("SUMMARY");
  console.log(`catalog: ${summary.catalog}`);
  console.log(`playable: ${summary.playable}`);
  console.log(`auto-promoted this run: ${summary.autoPromotedThisRun}`);
  console.log(`review-required this run: ${summary.reviewRequiredThisRun}`);
  console.log(`deferred-rate-limit this run: ${summary.deferredRateLimitThisRun}`);
  console.log(`deferred-rate-limit total: ${summary.deferredRateLimitTotal}`);
  console.log(`retried-deferred this run: ${summary.retriedDeferredThisRun}`);
  console.log(`recovered-deferred this run: ${summary.recoveredDeferredThisRun}`);
  console.log(`quota-deferred this run: ${summary.quotaDeferredThisRun}`);
  console.log(`quota-deferred total: ${summary.quotaDeferredTotal}`);
  console.log(`human-reviewed total: ${summary.humanReviewedTotal}`);
  console.log(`auto-high-confidence total: ${summary.autoHighConfidenceTotal}`);
  console.log(`review-required total: ${summary.reviewRequiredTotal}`);
  console.log(`quality-excluded total: ${summary.qualityExcludedTotal}`);
  console.log(`pending eligible total: ${summary.pendingEligibleTotal}`);
  console.log(`known exceptions total: ${summary.knownExceptionsTotal}`);
  console.log(`API status: ${summary.apiStatus}`);
  if (summary.nextRetryAt) console.log(`next deferred retry: ${summary.nextRetryAt}`);
  console.log(`remaining null: ${summary.remainingNull}`);
}

function printAutoBatchTable(rows) {
  console.log("SONG ID | PROPOSED VIDEO | YOUTUBE TITLE | CHANNEL | CONFIDENCE | TECHNICAL | REASONS | WARNING");
  rows.forEach((row) => {
    const record = row.verification;
    console.log([
      row.song.id,
      row.selected?.candidateVideoId || "(none)",
      tableValue(record?.videoTitle || row.selected?.videoTitle || "(not checked)"),
      tableValue(record?.channelTitle || row.selected?.channelTitle || "(unknown)"),
      row.confidence,
      record ? technicalStatus(record) : "not checked",
      tableValue((row.reasons || []).join(", ")),
      tableValue(row.warning || "")
    ].join(" | "));
  });
}

function technicalStatus(record) {
  if (!record) return "not checked";
  if (record.apiVerified !== true) return "not found";
  if (record.embeddable !== true) return "not embeddable";
  if (record.madeForKids !== false) return "MFK not approved";
  return "pass";
}

function formatPublishedDate(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
}

export async function batchVerifyCandidates(options, dependencies = {}) {
  const apiKey = dependencies.apiKey || getApiKey();

  const catalog = await readCatalog(options.catalog);
  const candidateFile = await readJson(resolve(options.candidates), "candidate mapping file");
  const normalized = normalizeCandidateMappings(candidateFile, catalog);
  normalized.rejected.forEach((item) => console.log(`SKIPPED | ${item.songId || "?"} | ${item.candidateVideoId || "?"} | ${item.reason}`));

  if (normalized.candidates.length === 0) {
    console.log("No valid candidate mappings to verify.");
    return { records: [], rejected: normalized.rejected, failedBatches: 0 };
  }

  const fetchImplementation = dependencies.fetchImplementation || fetch;
  const requestUrl = dependencies.apiUrl || API_URL;
  const requestConfig = getRequestConfig(options, dependencies);
  const checkedAt = new Date().toISOString();
  const uniqueVideoIds = unique(normalized.candidates.map((candidate) => candidate.candidateVideoId));
  const verifiedByVideoId = new Map();
  let failedBatches = 0;

  for (const idBatch of chunk(uniqueVideoIds, MAX_IDS_PER_REQUEST)) {
    try {
      const records = await requestVideoBatch(idBatch, apiKey, checkedAt, fetchImplementation, requestUrl, requestConfig);
      records.forEach((record) => verifiedByVideoId.set(record.candidateVideoId, record));
    } catch (error) {
      failedBatches += 1;
      console.error(`API batch skipped (${idBatch.length} candidate${idBatch.length === 1 ? "" : "s"}): ${error.message}`);
    }
  }

  const incoming = normalized.candidates
    .filter((candidate) => verifiedByVideoId.has(candidate.candidateVideoId))
    .map((candidate) => {
      const apiRecord = verifiedByVideoId.get(candidate.candidateVideoId);
      return createVerificationRecord({
        ...apiRecord,
        songId: candidate.songId,
        catalogTitle: candidate.song.title,
        catalogArtist: candidate.song.artist,
        provenance: "technically-verified-only"
      });
    });

  const store = await readVerificationStore(options.file);
  const nextStore = upsertRecords(store, incoming);
  if (incoming.length > 0) await writeVerificationStore(options.file, nextStore);

  const reviewedKeys = new Set(incoming.map((record) => `${record.songId}::${record.candidateVideoId}`));
  const reportRecords = nextStore.records.filter((record) => reviewedKeys.has(`${record.songId}::${record.candidateVideoId}`));
  printReviewTable(reportRecords, catalog);
  console.log(`Batch verification complete: ${incoming.length} checked, ${normalized.rejected.length} skipped, ${failedBatches} API batch failure${failedBatches === 1 ? "" : "s"}.`);
  if (failedBatches > 0) process.exitCode = 1;
  return { records: incoming, rejected: normalized.rejected, failedBatches };
}

export function normalizeCandidateMappings(value, catalog, options = {}) {
  const tolerant = options.tolerateMalformed === true;
  const compatibleVersion = value?.version === undefined || value?.version === CANDIDATE_VERSION;
  const hasCandidatesArray = value?.candidates === undefined || Array.isArray(value.candidates);
  if (!isPlainObject(value) || !compatibleVersion || !hasCandidatesArray) {
    if (!tolerant) throw new Error(`Candidate mapping file must contain version ${CANDIDATE_VERSION} and a candidates array.`);
    options.onIssue?.("candidate store header or candidates array was malformed; usable mappings were retained");
  }

  const catalogById = new Map(catalog.map((song) => [song.id.toLowerCase(), song]));
  const candidates = [];
  const rejected = [];
  const seenPairs = new Set();
  const videoOwners = new Map();
  const reject = (item) => {
    rejected.push(item);
    if (tolerant) options.onIssue?.(item.reason);
  };

  (Array.isArray(value?.candidates) ? value.candidates : []).forEach((candidate, index) => {
    const songId = stringOrNull(candidate?.songId);
    const candidateVideoId = stringOrNull(candidate?.candidateVideoId);
    const position = `candidate ${index + 1}`;
    if (!songId || !candidateVideoId) {
      reject({ songId, candidateVideoId, reason: `${position} is missing songId or candidateVideoId` });
      return;
    }
    if (!isValidVideoId(candidateVideoId)) {
      reject({ songId, candidateVideoId, reason: `${position} has an invalid YouTube video ID` });
      return;
    }
    const song = catalogById.get(songId.toLowerCase());
    if (!song) {
      reject({ songId, candidateVideoId, reason: `unknown catalog song ID` });
      return;
    }
    const pairKey = `${song.id.toLowerCase()}::${candidateVideoId}`;
    if (seenPairs.has(pairKey)) {
      reject({ songId: song.id, candidateVideoId, reason: `duplicate candidate mapping` });
      return;
    }
    const previousOwner = videoOwners.get(candidateVideoId);
    if (previousOwner && previousOwner !== song.id.toLowerCase()) {
      reject({ songId: song.id, candidateVideoId, reason: `candidate video ID is already mapped to another song` });
      return;
    }
    seenPairs.add(pairKey);
    videoOwners.set(candidateVideoId, song.id.toLowerCase());
    candidates.push({ songId: song.id, candidateVideoId, song });
  });

  return { candidates, rejected };
}

export async function requestVideoBatch(ids, apiKey, checkedAt, fetchImplementation, requestUrl = API_URL, requestConfig = {}) {
  const url = new URL(requestUrl);
  url.searchParams.set("part", "snippet,status,statistics,contentDetails");
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("key", apiKey.trim());

  const payload = await requestJsonWithRetry(url, fetchImplementation, requestConfig, "video");
  return parseVideoResponse(payload, ids, checkedAt);
}

function isReusableTechnicalRecord(record, candidate) {
  return Boolean(
    record
    && record.songId?.toLowerCase() === candidate.songId.toLowerCase()
    && record.candidateVideoId === candidate.candidateVideoId
    && record.status === "verified"
    && record.apiVerified === true
    && record.embeddable === true
    && record.madeForKids === false
  );
}

async function verifyMappedCandidates(options, candidates, dependencies = {}) {
  const existingStore = await readVerificationStore(options.file);
  const existingByKey = new Map(existingStore.records.map((record) => [`${record.songId}::${record.candidateVideoId}`, record]));
  const reusedRecords = [];
  const candidatesToVerify = [];
  candidates.forEach((candidate) => {
    const existing = existingByKey.get(`${candidate.songId}::${candidate.candidateVideoId}`);
    if (isReusableTechnicalRecord(existing, candidate)) reusedRecords.push(existing);
    else candidatesToVerify.push(candidate);
  });
  if (candidatesToVerify.length === 0) {
    return { records: reusedRecords, reusedRecords, failedBatches: 0, haltReason: null, haltStatus: null, deferredVideoIds: [], apiStatus: "not-needed" };
  }

  const apiKey = dependencies.apiKey || getApiKey();
  const fetchImplementation = dependencies.fetchImplementation || fetch;
  const requestUrl = dependencies.apiUrl || API_URL;
  const requestConfig = getRequestConfig(options, dependencies);
  const checkedAt = new Date().toISOString();
  const uniqueVideoIds = unique(candidatesToVerify.map((candidate) => candidate.candidateVideoId));
  const verifiedByVideoId = new Map();
  let failedBatches = 0;
  let haltReason = null;
  let haltStatus = null;
  const deferredVideoIds = [];
  let deferredError = null;
  let apiStatus = "not-needed";

  for (const idBatch of chunk(uniqueVideoIds, MAX_IDS_PER_REQUEST)) {
    try {
      const records = await requestVideoBatch(idBatch, apiKey, checkedAt, fetchImplementation, requestUrl, requestConfig);
      apiStatus = "available";
      records.forEach((record) => verifiedByVideoId.set(record.candidateVideoId, record));
    } catch (error) {
      if (error.rateLimited) {
        haltReason = deferredReason(error);
        haltStatus = deferredStatus(error);
        deferredError = error;
        apiStatus = haltStatus === "quota-deferred" ? "quota-exhausted" : "temporarily-rate-limited";
        // Only this batch was actually attempted. Later batches remain pending.
        deferredVideoIds.push(...idBatch);
        break;
      }
      failedBatches += 1;
      console.error(`API batch skipped (${idBatch.length} candidate${idBatch.length === 1 ? "" : "s"}): ${error.message}`);
    }
  }

  const incoming = candidatesToVerify
    .filter((candidate) => verifiedByVideoId.has(candidate.candidateVideoId))
    .map((candidate) => {
      const apiRecord = verifiedByVideoId.get(candidate.candidateVideoId);
      return createVerificationRecord({
        ...apiRecord,
        songId: candidate.songId,
        catalogTitle: candidate.song.title,
        catalogArtist: candidate.song.artist,
        provenance: "technically-verified-only"
      });
    });

  if (incoming.length > 0) {
    await writeVerificationStore(options.file, upsertRecords(existingStore, incoming));
  }
  return { records: [...reusedRecords, ...incoming], reusedRecords, failedBatches, haltReason, haltStatus, deferredVideoIds, deferredError, apiStatus };
}

function getApiKey() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !apiKey.trim()) throw new Error("YOUTUBE_API_KEY is missing. Set it only in the local environment.");
  return apiKey.trim();
}

function getRequestConfig(options = {}, dependencies = {}) {
  return {
    retryLimit: dependencies.retryLimit ?? options.retryLimit ?? DEFAULT_RETRY_LIMIT,
    baseDelayMs: dependencies.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs: dependencies.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    sleep: dependencies.sleep,
    random: dependencies.random
  };
}

async function markVerified(options) {
  requireOption(options.songId, "--song-id");
  requireOption(options.videoId, "--video-id");
  if (!options.manualMatch || !options.karaokeSuitable) throw new Error("Marking verified requires --manual-match and --karaoke-suitable.");

  const store = await readVerificationStore(options.file);
  const record = findRecord(store, options.songId, options.videoId);
  if (!record) throw new Error("No matching candidate record found. Run verify first.");
  if (record.apiVerified !== true || record.embeddable !== true || record.madeForKids !== false) {
    throw new Error("Candidate cannot be marked verified: API verification, embeddability, and a confirmed made-for-kids=false result are all required.");
  }

  record.status = "verified";
  record.manuallyMatched = true;
  record.karaokeSuitable = true;
  record.provenance = "human-reviewed";
  record.autoChecksPassed = false;
  record.decisionReasons = ["Manual song-match and karaoke-suitability approval were explicitly recorded."];
  record.reviewReason = null;
  record.decisionAt = new Date().toISOString();
  record.verifiedAt = new Date().toISOString();
  await writeVerificationStore(options.file, store);
  console.log(`Marked ${options.songId} / ${options.videoId} as verified.`);
  console.log("The public catalog was not modified. Run the explicit promote command after reviewing this record.");
}

export async function approveBatch(options) {
  requireOption(options.songIds, "--song-ids");
  if (!options.confirm) throw new Error("Bulk approval requires --confirm after human review of every listed candidate.");
  if (!options.manualMatch || !options.karaokeSuitable) throw new Error("Bulk approval requires --manual-match and --karaoke-suitable.");

  const requestedIds = unique(options.songIds.split(",").map((value) => value.trim()));
  if (requestedIds.length === 0) throw new Error("--song-ids must contain at least one catalog song ID.");
  const catalogPath = resolve(options.catalog);
  const rawCatalog = await readJson(catalogPath, "public catalog");
  if (!Array.isArray(rawCatalog)) throw new Error("Public catalog must be a top-level array.");
  const catalog = await readCatalog(options.catalog);
  const catalogById = new Map(catalog.map((song) => [song.id.toLowerCase(), song]));
  const store = await readVerificationStore(options.file);
  const changedStore = { version: VERIFICATION_VERSION, records: store.records.map((record) => ({ ...record })) };
  const promoted = [];
  const skipped = [];

  for (const requestedId of requestedIds) {
    const song = catalogById.get(requestedId.toLowerCase());
    if (!song) {
      skipped.push({ songId: requestedId, reason: "unknown catalog song ID" });
      continue;
    }
    const matches = changedStore.records.filter((record) => record.songId?.toLowerCase() === song.id.toLowerCase());
    if (matches.length !== 1) {
      skipped.push({ songId: song.id, reason: matches.length === 0 ? "no verification record" : "multiple candidate records; use mark-verified with an explicit video ID" });
      continue;
    }
    const record = matches[0];
    if (song.youtubeVideoId) {
      skipped.push({ songId: song.id, reason: song.youtubeVideoId === record.candidateVideoId ? "already-promoted" : "catalog already has a different video ID" });
      continue;
    }
    if (record.apiVerified !== true || record.embeddable !== true || record.madeForKids !== false) {
      skipped.push({ songId: song.id, reason: promotionGateReason(record) });
      continue;
    }
    record.status = "verified";
    record.manuallyMatched = true;
    record.karaokeSuitable = true;
    record.provenance = "human-reviewed";
    record.autoChecksPassed = false;
    record.decisionReasons = ["Manual song-match and karaoke-suitability approval were explicitly recorded."];
    record.reviewReason = null;
    record.decisionAt = new Date().toISOString();
    record.verifiedAt = record.verifiedAt || new Date().toISOString();
    if (!canPromote(record)) {
      skipped.push({ songId: song.id, reason: promotionGateReason(record) });
      continue;
    }
    const rawSong = rawCatalog.find((item) => item && item.id === song.id);
    if (!rawSong || rawSong.youtubeVideoId) {
      skipped.push({ songId: song.id, reason: "catalog changed during review" });
      continue;
    }
    rawSong.youtubeVideoId = record.candidateVideoId;
    promoted.push({ songId: song.id, videoId: record.candidateVideoId });
  }

  if (promoted.length > 0) {
    await writeVerificationStore(options.file, changedStore);
    await atomicWriteJson(catalogPath, rawCatalog);
  }
  console.log("BULK APPROVAL PROMOTED");
  if (promoted.length === 0) console.log("(none)");
  promoted.forEach(({ songId, videoId }) => console.log(`${songId} | ${videoId}`));
  console.log("SKIPPED");
  if (skipped.length === 0) console.log("(none)");
  skipped.forEach(({ songId, reason }) => console.log(`${songId} | ${reason}`));
  console.log(`Bulk approval complete: promoted ${promoted.length}, skipped ${skipped.length}.`);
  return { promoted, skipped };
}

async function promote(options) {
  requireOption(options.songId, "--song-id");
  const store = await readVerificationStore(options.file);
  const record = store.records.find((item) => item.songId === options.songId);
  if (!record) throw new Error("No verification record found for that song.");
  if (!canPromote(record)) throw new Error("Promotion refused: the candidate is not fully verified and manually approved.");

  const catalogPath = resolve(options.catalog);
  const catalog = await readJson(catalogPath, "public catalog");
  if (!Array.isArray(catalog)) throw new Error("Public catalog must be a top-level array.");
  const song = catalog.find((item) => item && item.id === options.songId);
  if (!song) throw new Error(`Song ID "${options.songId}" was not found in the public catalog.`);
  if (song.youtubeVideoId && song.youtubeVideoId !== record.candidateVideoId) throw new Error("Promotion refused: the catalog already contains a different YouTube video ID.");
  if (song.youtubeVideoId === record.candidateVideoId) {
    console.log(`Skipped ${options.songId}: the same video is already promoted.`);
    return;
  }

  song.youtubeVideoId = record.candidateVideoId;
  await atomicWriteJson(catalogPath, catalog);
  console.log(`Promoted ${record.candidateVideoId} into ${options.catalog} for ${options.songId}.`);
}

async function report(options) {
  const catalog = await readCatalog(options.catalog);
  const store = await readVerificationStore(options.file);
  const candidateFile = await readCandidateFile(options.candidates);
  const normalizedCandidates = normalizeCandidateMappings(candidateFile, catalog);
  const reviewStore = await readReviewStore(options.review);
  const reviewFlags = getReviewFlags(reviewStore);
  printReviewTable(store.records, catalog);
  printSummary(catalog, normalizedCandidates.candidates, store, reviewFlags);
  console.log(`Reported ${store.records.length} verification record${store.records.length === 1 ? "" : "s"}.`);
}

async function promoteAllVerified(options) {
  const catalogPath = resolve(options.catalog);
  const catalog = await readJson(catalogPath, "public catalog");
  if (!Array.isArray(catalog)) throw new Error("Public catalog must be a top-level array.");
  const normalizedCatalog = await readCatalog(options.catalog);
  const catalogById = new Map(normalizedCatalog.map((song) => [song.id, song]));
  const store = await readVerificationStore(options.file);
  const promoted = [];
  const skipped = [];
  const changedCatalog = [...catalog];

  store.records.forEach((record) => {
    const song = catalogById.get(record.songId);
    if (!song) {
      skipped.push({ record, reason: "unknown catalog song ID" });
      return;
    }
    if (song.youtubeVideoId) {
      skipped.push({ record, reason: song.youtubeVideoId === record.candidateVideoId ? "already-promoted" : "catalog already has a different video ID" });
      return;
    }
    if (!canPromote(record)) {
      skipped.push({ record, reason: promotionGateReason(record) });
      return;
    }
    const rawSong = changedCatalog.find((item) => item && item.id === record.songId);
    if (!rawSong || rawSong.youtubeVideoId) {
      skipped.push({ record, reason: "catalog changed during review" });
      return;
    }
    rawSong.youtubeVideoId = record.candidateVideoId;
    promoted.push({ record, song });
  });

  if (promoted.length > 0) await atomicWriteJson(catalogPath, changedCatalog);
  console.log("PROMOTED");
  if (promoted.length === 0) console.log("(none)");
  promoted.forEach(({ record }) => console.log(`${record.songId} | ${record.candidateVideoId}`));
  console.log("SKIPPED");
  if (skipped.length === 0) console.log("(none)");
  skipped.forEach(({ record, reason }) => console.log(`${record.songId || "?"} | ${record.candidateVideoId || "?"} | ${reason}`));
  return { promoted, skipped };
}

export function parseArguments(argv) {
  const args = [...argv];
  const first = args[0];
  const commands = new Set(["search-candidates", "set-candidate", "batch-verify", "auto-batch", "auto-complete", "report", "mark-verified", "approve-batch", "promote", "promote-all-verified", "unassign-party-tyme", "review-flag", "review-unflag", "cleanup-verification"]);
  const command = commands.has(first) ? args.shift() : "verify";
  const options = { command, ids: [], file: DEFAULT_RECORD_PATH, catalog: DEFAULT_CATALOG_PATH, candidates: DEFAULT_CANDIDATE_PATH, review: DEFAULT_REVIEW_PATH, maxResults: DEFAULT_SEARCH_RESULTS, maxSongs: DEFAULT_SEARCH_SONG_LIMIT, offset: 0, retryLimit: DEFAULT_RETRY_LIMIT, all: false, help: false, manualMatch: false, karaokeSuitable: false, confirm: false, dryRun: false };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--song-id") options.songId = requireValue(args, arg);
    else if (arg === "--video-id") options.videoId = requireValue(args, arg, { allowLeadingHyphenVideoId: true });
    else if (arg === "--file") options.file = requireValue(args, arg);
    else if (arg === "--catalog") options.catalog = requireValue(args, arg);
    else if (arg === "--candidates") options.candidates = requireValue(args, arg);
    else if (arg === "--review") options.review = requireValue(args, arg);
    else if (arg === "--query") options.query = requireValue(args, arg);
    else if (arg === "--song-ids") options.songIds = requireValue(args, arg);
    else if (arg === "--status") options.status = requireValue(args, arg);
    else if (arg === "--reason") options.reason = requireValue(args, arg);
    else if (arg === "--max-results") options.maxResults = parsePositiveInteger(args, arg, 1, 5);
    else if (arg === "--max-songs") options.maxSongs = parsePositiveInteger(args, arg, 1, 100);
    else if (arg === "--offset") options.offset = parseNonNegativeInteger(args, arg);
    else if (arg === "--retry-limit") options.retryLimit = parsePositiveInteger(args, arg, 0, 5);
    else if (arg === "--all") options.all = true;
    else if (arg === "--manual-match") options.manualMatch = true;
    else if (arg === "--karaoke-suitable") options.karaokeSuitable = true;
    else if (arg === "--confirm") options.confirm = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option "${arg}".`);
    else options.ids.push(arg);
  }
  return options;
}

async function readVerificationStore(file, normalizationOptions = {}) {
  try {
    const value = await readJson(resolve(file), "verification file");
    return normalizeVerificationStore(value, normalizationOptions);
  } catch (error) {
    if (error.code === "ENOENT") return createEmptyVerificationStore();
    throw error;
  }
}

async function readCandidateFile(file) {
  try {
    return await readJson(resolve(file), "candidate mapping file");
  } catch (error) {
    if (error.code === "ENOENT") return { version: CANDIDATE_VERSION, candidates: [] };
    throw error;
  }
}

async function readReviewStore(file, normalizationOptions = {}) {
  try {
    return normalizeReviewStore(await readJson(resolve(file), "review flag file"), normalizationOptions);
  } catch (error) {
    if (error.code === "ENOENT") return createEmptyReviewStore();
    throw error;
  }
}

async function persistAutoCompleteReviewState(options, reviewStore, persistedDeferredStates, deferredSongs, resolvedDeferredSongIds, rows, catalog = []) {
  if (options.dryRun) return reviewStore;

  const bySong = new Map();
  reviewStore.flags.forEach((flag) => bySong.set(flag.songId.toLowerCase(), { ...flag }));
  const promotedSongIds = new Set(catalog.filter((song) => song.youtubeVideoId).map((song) => song.id.toLowerCase()));
  [...bySong.entries()].forEach(([songKey, flag]) => {
    if (promotedSongIds.has(songKey) && (isDeferredStatus(flag.status) || flag.status === "review-required")) bySong.delete(songKey);
  });

  // Legacy deferred records without a review flag become one canonical song-level flag.
  persistedDeferredStates.forEach((state, songKey) => {
    if (resolvedDeferredSongIds.has(songKey)) {
      bySong.delete(songKey);
      return;
    }
    if (!bySong.has(songKey)) {
      bySong.set(songKey, {
        songId: state.songId,
        status: state.status,
        reason: state.reason,
        updatedAt: state.lastAttemptAt || null,
        candidateVideoId: state.candidateVideoId || null,
        attemptCount: state.attemptCount || 0,
        lastAttemptAt: state.lastAttemptAt || null,
        nextEligibleAt: state.nextEligibleAt || null,
        httpStatus: state.httpStatus || null,
        httpClassification: state.httpClassification || null,
        retryAfterMs: state.retryAfterMs ?? null
      });
    }
  });

  deferredSongs.forEach((entry, songKey) => {
    bySong.set(songKey, {
      songId: entry.song.id,
      status: entry.status || "deferred-rate-limit",
      reason: entry.reason,
      updatedAt: entry.lastAttemptAt,
      candidateVideoId: entry.candidateVideoId || null,
      attemptCount: entry.attemptCount,
      lastAttemptAt: entry.lastAttemptAt,
      nextEligibleAt: entry.nextEligibleAt,
      httpStatus: entry.httpStatus,
      httpClassification: entry.httpClassification,
      retryAfterMs: entry.retryAfterMs
    });
  });

  rows.filter((row) => row.state === "review" && row.song && !isDeferredStatus(row.deferred?.status) && !BUILTIN_REVIEW_FLAGS.has(row.song.id.toLowerCase())).forEach((row) => {
    const songKey = row.song.id.toLowerCase();
    bySong.set(songKey, {
      songId: row.song.id,
      status: "review-required",
      reason: row.reason || "Candidate requires review.",
      updatedAt: new Date().toISOString()
    });
  });

  const flags = [...bySong.values()].filter((flag) => !(resolvedDeferredSongIds.has(flag.songId.toLowerCase()) && isDeferredStatus(flag.status)));
  const nextStore = { version: REVIEW_VERSION, flags };
  await atomicWriteJson(resolve(options.review), nextStore);
  return nextStore;
}

function getReviewFlags(reviewStore) {
  const flags = new Map([...BUILTIN_REVIEW_FLAGS].map(([songId, flag]) => [songId.toLowerCase(), { songId, ...flag, builtin: true }]));
  reviewStore.flags.forEach((flag) => flags.set(flag.songId.toLowerCase(), { ...flag, builtin: false }));
  return flags;
}

async function reviewFlag(options) {
  requireOption(options.songId, "--song-id");
  requireOption(options.status, "--status");
  requireOption(options.reason, "--reason");
  if (!VALID_REVIEW_STATUSES.has(options.status)) throw new Error(`--status must be one of: ${[...VALID_REVIEW_STATUSES].join(", ")}.`);
  const catalog = await readCatalog(options.catalog);
  const song = findCatalogSong(catalog, options.songId);
  if (!song) throw new Error(`Song ID "${options.songId}" was not found in the public catalog.`);
  const store = await readReviewStore(options.review);
  const flags = store.flags.filter((flag) => flag.songId.toLowerCase() !== song.id.toLowerCase());
  flags.push({ songId: song.id, status: options.status, reason: options.reason.trim() });
  await atomicWriteJson(resolve(options.review), { version: REVIEW_VERSION, flags });
  console.log(`Review flag saved: ${song.id} | ${options.status}`);
}

async function reviewUnflag(options) {
  requireOption(options.songId, "--song-id");
  const catalog = await readCatalog(options.catalog);
  const song = findCatalogSong(catalog, options.songId);
  if (!song) throw new Error(`Song ID "${options.songId}" was not found in the public catalog.`);
  if (BUILTIN_REVIEW_FLAGS.has(song.id.toLowerCase())) throw new Error(`${song.id} has a built-in safety flag and cannot be unflagged by automation.`);
  const store = await readReviewStore(options.review);
  const flags = store.flags.filter((flag) => flag.songId.toLowerCase() !== song.id.toLowerCase());
  await atomicWriteJson(resolve(options.review), { version: REVIEW_VERSION, flags });
  console.log(`Review flag removed: ${song.id}`);
}

export async function cleanupVerification(options) {
  const catalog = await readCatalog(options.catalog);
  const catalogById = new Map(catalog.map((song) => [song.id.toLowerCase(), song]));
  const rawStore = await readJson(resolve(options.file), "verification file");
  const store = normalizeVerificationStore(rawStore, { allowDuplicateKeys: true });
  const groups = new Map();
  store.records.forEach((record) => {
    const key = `${record.songId || ""}::${record.candidateVideoId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });

  const duplicateKeys = [...groups.entries()].filter(([, records]) => records.length > 1);
  const removed = [];
  const ambiguous = [];
  const kept = [];
  const duplicateRecord = new Set();
  duplicateKeys.forEach(([key, records]) => {
    const fingerprints = new Set(records.map((record) => JSON.stringify(record)));
    if (fingerprints.size === 1) {
      records.slice(1).forEach((record) => duplicateRecord.add(record));
    } else {
      ambiguous.push({ key, reason: "duplicate key has conflicting evidence" });
    }
  });

  for (const record of store.records) {
    if (duplicateRecord.has(record)) {
      removed.push({ record, reason: "identical duplicate" });
      continue;
    }
    if (!record.songId) {
      const matchingLinks = store.records.filter((candidate) => !duplicateRecord.has(candidate) && candidate.songId && candidate.candidateVideoId === record.candidateVideoId);
      const promotedLinks = matchingLinks.filter((candidate) => catalogById.get(candidate.songId.toLowerCase())?.youtubeVideoId === record.candidateVideoId);
      if (promotedLinks.length === 1 && matchingLinks.length === 1) {
        removed.push({ record, reason: `orphan superseded by ${promotedLinks[0].songId}` });
        continue;
      }
      if (promotedLinks.length !== 1) ambiguous.push({ key: `?::${record.candidateVideoId}`, reason: "orphan has no unambiguous promoted song-linked record" });
    }
    kept.push(record);
  }

  if (removed.length > 0) await writeVerificationStore(options.file, { version: VERIFICATION_VERSION, records: kept });
  console.log("CLEANED");
  removed.forEach(({ record, reason }) => console.log(`${record.songId || "?"} | ${record.candidateVideoId} | ${reason}`));
  if (removed.length === 0) console.log("(none)");
  console.log("KEPT/AMBIGUOUS");
  ambiguous.forEach(({ key, reason }) => console.log(`${key} | ${reason}`));
  if (ambiguous.length === 0) console.log("(none)");
  console.log(`Cleanup complete: removed ${removed.length}, kept ${kept.length}, ambiguous ${ambiguous.length}.`);
  return { removed, kept, ambiguous };
}

async function readCatalog(file) {
  const rawCatalog = await readJson(resolve(file), "public catalog");
  if (!Array.isArray(rawCatalog)) throw new Error("Public catalog must be a top-level array.");
  const result = normalizeCatalog(rawCatalog, { logger: { warn() {} } });
  if (result.songs.length === 0) throw new Error("Public catalog does not contain any usable songs.");
  return result.songs;
}

function findCatalogSong(catalog, songId) {
  const normalizedId = typeof songId === "string" ? songId.trim().toLowerCase() : "";
  return catalog.find((song) => song.id.toLowerCase() === normalizedId) || null;
}

async function writeVerificationStore(file, store) {
  await atomicWriteJson(resolve(file), normalizeVerificationStore(store));
}

function isTransientRenameError(error) {
  return ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
}

function atomicSleep(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function renameWithRetry(from, to, dependencies = {}) {
  const renameImplementation = dependencies.renameImplementation || rename;
  const sleep = dependencies.sleep || atomicSleep;
  const retryLimit = Number.isInteger(dependencies.renameRetryLimit)
    ? Math.max(0, dependencies.renameRetryLimit)
    : ATOMIC_RENAME_RETRY_LIMIT;
  let lastError;
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      await renameImplementation(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientRenameError(error) || attempt >= retryLimit) throw error;
      const delay = Math.min(ATOMIC_RENAME_MAX_DELAY_MS, ATOMIC_RENAME_BASE_DELAY_MS * (2 ** attempt));
      await sleep(delay);
    }
  }
  throw lastError;
}

async function safeUnlink(file, unlinkImplementation = unlink, { ignoreTransientErrors = false } = {}) {
  try {
    await unlinkImplementation(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (ignoreTransientErrors && isTransientRenameError(error)) return;
    throw error;
  }
}

function isAtomicArtifactName(file, name) {
  const base = basename(file);
  return name === `${base}.tmp`
    || name === `${base}.bak`
    || (name.startsWith(`${base}.`) && (name.endsWith(".tmp") || name.endsWith(".bak")));
}

async function recoverAtomicBackup(file, dependencies = {}) {
  if (await pathExists(file)) return false;
  let entries;
  try {
    entries = await readdir(dirname(file), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const backups = entries
    .filter((entry) => entry.isFile() && isAtomicArtifactName(file, entry.name) && entry.name.endsWith(".bak"))
    .map((entry) => join(dirname(file), entry.name));
  for (const backup of backups) {
    try {
      JSON.parse(await readFile(backup, "utf8"));
      await renameWithRetry(backup, file, dependencies);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) continue;
    }
  }
  return false;
}

async function cleanupStaleAtomicArtifacts(file, currentArtifacts = new Set(), dependencies = {}) {
  const unlinkImplementation = dependencies.unlinkImplementation || unlink;
  let entries;
  try {
    entries = await readdir(dirname(file), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const cutoff = Date.now() - ATOMIC_STALE_ARTIFACT_MS;
  for (const entry of entries) {
    if (!entry.isFile() || !isAtomicArtifactName(file, entry.name)) continue;
    const artifact = join(dirname(file), entry.name);
    if (currentArtifacts.has(artifact)) continue;
    if (entry.name === `${basename(file)}.tmp`) {
      await safeUnlink(artifact, unlinkImplementation, { ignoreTransientErrors: true });
      continue;
    }
    try {
      const details = await stat(artifact);
      if (details.mtimeMs < cutoff) {
        await safeUnlink(artifact, unlinkImplementation, { ignoreTransientErrors: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function atomicWriteJson(file, value, dependencies = {}) {
  const target = resolve(file);
  await recoverAtomicBackup(target, dependencies);
  const temporaryFile = `${target}.${process.pid}.${Date.now()}-${randomUUID()}.tmp`;
  const unlinkImplementation = dependencies.unlinkImplementation || unlink;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    JSON.parse(payload);
    await writeFile(temporaryFile, payload, "utf8");
    JSON.parse(await readFile(temporaryFile, "utf8"));
  } catch (error) {
    await safeUnlink(temporaryFile, unlinkImplementation);
    throw error;
  }

  try {
    await renameWithRetry(temporaryFile, target, dependencies);
    await cleanupStaleAtomicArtifacts(target, new Set([temporaryFile]), dependencies);
    return;
  } catch (error) {
    if (!isTransientRenameError(error) || !(await pathExists(target))) throw error;
    const backupFile = `${target}.${process.pid}.${Date.now()}-${randomUUID()}.bak`;
    try {
      await renameWithRetry(target, backupFile, dependencies);
    } catch (backupError) {
      backupError.message = `${backupError.message} (original destination preserved; replacement temp: ${temporaryFile})`;
      throw backupError;
    }
    try {
      await renameWithRetry(temporaryFile, target, dependencies);
    } catch (replacementError) {
      try {
        await renameWithRetry(backupFile, target, dependencies);
      } catch (restoreError) {
        restoreError.message = `${restoreError.message} (original catalog preserved at recovery backup: ${backupFile})`;
        throw restoreError;
      }
      throw replacementError;
    }
    await safeUnlink(backupFile, unlinkImplementation, { ignoreTransientErrors: true });
    await cleanupStaleAtomicArtifacts(target, new Set([temporaryFile, backupFile]), dependencies);
  }
}

async function readJson(file, label) {
  await recoverAtomicBackup(resolve(file));
  let raw;
  try { raw = await readFile(file, "utf8"); } catch (error) { error.message = `Could not read ${label}: ${error.message}`; throw error; }
  try { return JSON.parse(raw); } catch { throw new Error(`${label} contains invalid JSON and was not changed.`); }
}

function upsertRecords(store, incoming) {
  const records = [...store.records];
  incoming.forEach((record) => {
    const index = records.findIndex((item) => item.songId === record.songId && item.candidateVideoId === record.candidateVideoId);
    if (index >= 0) records[index] = mergeVerificationRecord(records[index], record);
    else records.push(record);
  });
  return normalizeVerificationStore({ version: VERIFICATION_VERSION, records });
}

function mergeVerificationRecord(existing, incoming) {
  const merged = { ...existing, ...incoming };
  const existingDecisionReasons = stringArray(existing?.decisionReasons);
  const incomingDecisionReasons = stringArray(incoming?.decisionReasons);
  const existingDecision = existing.provenance === "human-reviewed" || existing.provenance === "auto-high-confidence" || existing.provenance === "review-required";
  const preserveExistingDecision = incoming.provenance === "technically-verified-only" && existingDecision;
  merged.provenance = preserveExistingDecision ? existing.provenance : incoming.provenance || existing.provenance || null;
  merged.decisionReasons = incomingDecisionReasons.length > 0 ? incomingDecisionReasons : existingDecisionReasons;
  merged.reviewReason = incoming.reviewReason || existing.reviewReason || null;
  merged.decisionAt = incoming.decisionAt || existing.decisionAt || null;
  merged.autoChecksPassed = incoming.autoChecksPassed === true || existing.autoChecksPassed === true;
  merged.manuallyMatched = existing.manuallyMatched === true || incoming.manuallyMatched === true;
  merged.karaokeSuitable = existing.karaokeSuitable === true || incoming.karaokeSuitable === true;
  merged.verifiedAt = existing.verifiedAt || incoming.verifiedAt || null;
  const automatedChecksStillPass = incoming.apiVerified === true && incoming.embeddable === true && incoming.madeForKids === false;
  if (existing.status === "verified" && automatedChecksStillPass && merged.manuallyMatched && merged.karaokeSuitable) merged.status = "verified";
  else if (incoming.status !== "verified") merged.status = incoming.status;
  return createVerificationRecord(merged);
}

function findRecord(store, songId, videoId) {
  return store.records.find((record) => record.songId === songId && record.candidateVideoId === videoId);
}

function printVerificationResult(record) {
  console.log(`Video ${record.candidateVideoId}: ${record.status}`);
  console.log(`  Video found: ${record.apiVerified ? "yes" : "no"}`);
  console.log(`  Title: ${record.videoTitle || "unknown"}`);
  console.log(`  Channel: ${record.channelTitle || "unknown"}`);
  console.log(`  Embeddable: ${formatBoolean(record.embeddable)}`);
  console.log(`  Made for Kids: ${formatBoolean(record.madeForKids)}`);
  console.log("  Manual song-match approval: required");
}

function printReviewTable(records, catalog) {
  const catalogById = new Map(catalog.map((song) => [song.id, song]));
  console.log("SONG ID | VIDEO ID | CATALOG SONG | YOUTUBE TITLE | CHANNEL | EMBEDDABLE | MFK | MANUAL | KARAOKE | PROVENANCE | STATUS");
  records.forEach((record) => {
    const song = catalogById.get(record.songId);
    const catalogSong = song ? `${song.title} — ${song.artist}` : record.catalogTitle ? `${record.catalogTitle} — ${record.catalogArtist || ""}` : "unknown";
    console.log([
      record.songId || "?",
      record.candidateVideoId || "?",
      tableValue(catalogSong),
      tableValue(record.videoTitle || "unknown"),
      tableValue(record.channelTitle || "unknown"),
      formatBoolean(record.embeddable),
      formatBoolean(record.madeForKids),
      record.manuallyMatched ? "yes" : "no",
      record.karaokeSuitable ? "yes" : "no",
      displayProvenance(record),
      record.status
    ].join(" | "));
  });
}

function printSummary(catalog, candidates, store, reviewFlags) {
  const technical = store.records.filter((record) => record.apiVerified === true && record.embeddable === true && record.madeForKids === false);
  const awaiting = technical.filter((record) => !canPromote(record));
  const rejected = store.records.filter((record) => record.status === "rejected" || record.status === "unavailable");
  const unresolved = catalog.filter((song) => !song.youtubeVideoId && reviewFlags.has(song.id.toLowerCase())).length;
  console.log("SUMMARY");
  console.log(`catalog songs: ${catalog.length}`);
  console.log(`playable/promoted: ${catalog.filter((song) => song.youtubeVideoId).length}`);
  console.log(`unresolved/review-required: ${unresolved}`);
  console.log(`candidates: ${candidates.length}`);
  console.log(`technically verified: ${technical.length}`);
  console.log(`awaiting human review: ${awaiting.length}`);
  console.log(`verified: ${store.records.filter((record) => record.status === "verified").length}`);
  console.log(`human-reviewed: ${store.records.filter((record) => displayProvenance(record) === "human-reviewed").length}`);
  console.log(`auto-high-confidence: ${store.records.filter((record) => displayProvenance(record) === "auto-high-confidence").length}`);
  console.log(`review-required: ${store.records.filter((record) => displayProvenance(record) === "review-required").length}`);
  console.log(`quality-excluded: ${reviewFlags instanceof Map ? [...reviewFlags.values()].filter((flag) => flag.status === QUALITY_EXCLUSION_STATUS).length : 0}`);
  console.log(`rejected/unavailable: ${rejected.length}`);
}

function displayProvenance(record) {
  if (VALID_PROVENANCE.has(record?.provenance)) return record.provenance;
  if (record?.status === "verified" && record?.manuallyMatched === true && record?.karaokeSuitable === true) return "human-reviewed";
  if (record?.apiVerified === true && record?.embeddable === true && record?.madeForKids === false) return "technically-verified-only";
  return "review-required";
}

function promotionGateReason(record) {
  if (record.status !== "verified") return `status=${record.status}`;
  if (!isValidVideoId(record.candidateVideoId)) return "invalid-video-id";
  if (record.apiVerified !== true) return "api-not-verified";
  if (record.embeddable !== true) return "not-embeddable";
  if (record.madeForKids !== false) return "made-for-kids-not-approved";
  if (record.manuallyMatched !== true) return "manual-match-required";
  if (record.karaokeSuitable !== true) return "karaoke-suitable-required";
  if (!record.checkedAt || !record.verifiedAt) return "verification-evidence-incomplete";
  return "promotion-gate-failed";
}

function formatApiError(status, payload) {
  const reason = payload?.error?.errors?.[0]?.reason;
  const error = status === 403
    ? new Error(`YouTube Data API rejected the request (HTTP 403${reason ? `; ${reason}` : "; check the key, quota, and API access"}).`)
    : status === 400
      ? new Error("YouTube Data API rejected the request as invalid. Check the candidate ID format and request parameters.")
      : new Error(`YouTube Data API request failed with HTTP ${status}.`);
  error.status = status;
  error.reason = reason || null;
  error.quotaExhausted = QUOTA_API_REASONS.has(reason);
  error.retryable = status === 429 || RETRYABLE_API_REASONS.has(reason);
  error.rateLimited = error.retryable || error.quotaExhausted;
  return error;
}

function deferredReason(error) {
  if (error.quotaExhausted) return "quota-deferred: YouTube Data API quota appears exhausted; rerun after quota availability returns.";
  return "deferred-rate-limit: temporary YouTube API throttling persisted after bounded retries; rerun to resume automatically.";
}

function deferredStatus(error) {
  return error?.quotaExhausted ? "quota-deferred" : "deferred-rate-limit";
}

function nonNegativeIntegerOrZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function nonNegativeIntegerOrNull(value) {
  const numericValue = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isSafeInteger(numericValue) && numericValue >= 0 ? numericValue : null;
}

function validHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function validHttpClassification(value) {
  return value === "temporary-rate-limit" || value === "quota-exhausted" || value === "network-error" || value === "api-error" ? value : null;
}

function isDeferredStatus(value) {
  return value === "deferred-rate-limit" || value === "quota-deferred";
}

function isDeferredProvenance(value) {
  return isDeferredStatus(value);
}

function deferredHttpClassification(error) {
  if (error?.quotaExhausted) return "quota-exhausted";
  if (error?.status === 429 || error?.retryable) return "temporary-rate-limit";
  if (error?.status) return "api-error";
  return "network-error";
}

function deferredCooldownMs(error, attemptCount, dependencies = {}) {
  if (Number.isFinite(error?.retryAfterMs)) return Math.max(0, error.retryAfterMs);
  const base = Number.isFinite(dependencies.deferredCooldownBaseMs)
    ? Math.max(0, dependencies.deferredCooldownBaseMs)
    : DEFAULT_DEFERRED_COOLDOWN_MS;
  const maximum = Number.isFinite(dependencies.deferredCooldownMaxMs)
    ? Math.max(base, dependencies.deferredCooldownMaxMs)
    : MAX_DEFERRED_COOLDOWN_MS;
  if (error?.quotaExhausted) return maximum;
  return Math.min(maximum, base * (2 ** Math.max(0, attemptCount - 1)));
}

function retryTimestampIsFuture(value, nowMs) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > nowMs;
}

function canonicalDeferredState(existing, incoming) {
  if (!existing) return { ...incoming };
  const existingNext = Date.parse(existing.nextEligibleAt || "");
  const incomingNext = Date.parse(incoming.nextEligibleAt || "");
  return {
    ...existing,
    ...incoming,
    candidateVideoId: incoming.candidateVideoId || existing.candidateVideoId || null,
    attemptCount: Math.max(existing.attemptCount || 0, incoming.attemptCount || 0),
    lastAttemptAt: Date.parse(incoming.lastAttemptAt || "") >= Date.parse(existing.lastAttemptAt || "") ? (incoming.lastAttemptAt || existing.lastAttemptAt || null) : (existing.lastAttemptAt || null),
    nextEligibleAt: Math.max(existingNext || 0, incomingNext || 0) > 0
      ? new Date(Math.max(existingNext || 0, incomingNext || 0)).toISOString()
      : null,
    retryAfterMs: incoming.retryAfterMs ?? existing.retryAfterMs ?? null,
    httpStatus: incoming.httpStatus ?? existing.httpStatus ?? null,
    httpClassification: incoming.httpClassification || existing.httpClassification || null
  };
}

function requiredArray(value, label, diagnostic = null) {
  if (Array.isArray(value)) return value;
  const error = new Error(`${label} must be an array.`);
  if (diagnostic) {
    error.phase = diagnostic.phase;
    error.songId = diagnostic.songId || null;
  }
  throw error;
}

function formatBoolean(value) { return value === true ? "yes" : value === false ? "no" : "unknown"; }
function unique(values) { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function chunk(values, size) { return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size)); }
function tableValue(value) { return String(value).replace(/[|\r\n]+/g, " ").trim(); }
function requireOption(value, name) { if (!value) throw new Error(`${name} is required.`); }
function requireValue(args, option, options = {}) {
  const value = args.shift();
  const leadingHyphenVideoId = options.allowLeadingHyphenVideoId === true && isValidVideoId(value);
  if (!value || (value.startsWith("-") && !leadingHyphenVideoId)) throw new Error(`${option} requires a value.`);
  return value;
}
function parsePositiveInteger(args, option, minimum, maximum) {
  const value = Number.parseInt(requireValue(args, option), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${option} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
function parseNonNegativeInteger(args, option) {
  const value = Number.parseInt(requireValue(args, option), 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${option} must be a non-negative integer.`);
  return value;
}
function stringOrNull(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function booleanOrNull(value) { return typeof value === "boolean" ? value : null; }
function stringArray(value) { return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))] : []; }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function printUsage() {
  printUsageWithQuery();
}

function printUsageWithQuery() {
  console.log([
    "KantaTayo YouTube verification tool",
    "",
    "Commands:",
    "  node tools/verify-youtube.mjs VIDEO_ID [VIDEO_ID...]",
    "  node tools/verify-youtube.mjs search-candidates --song-id SONG_ID [--query TEXT]",
    "  node tools/verify-youtube.mjs search-candidates --all [--max-songs N] [--offset N]",
    "  node tools/verify-youtube.mjs set-candidate --song-id SONG_ID --video-id VIDEO_ID",
    "  node tools/verify-youtube.mjs batch-verify [--candidates PATH]",
    "  node tools/verify-youtube.mjs auto-batch [--max-songs N] [--offset N] [--dry-run]",
    "  node tools/verify-youtube.mjs auto-complete",
    "  node tools/verify-youtube.mjs report",
    "  node tools/verify-youtube.mjs mark-verified --song-id SONG_ID --video-id VIDEO_ID --manual-match --karaoke-suitable",
    "  node tools/verify-youtube.mjs approve-batch --song-ids ID1,ID2 --manual-match --karaoke-suitable --confirm",
    "  node tools/verify-youtube.mjs promote --song-id SONG_ID",
    "  node tools/verify-youtube.mjs promote-all-verified",
    "  node tools/verify-youtube.mjs unassign-party-tyme [--dry-run]",
    "  node tools/verify-youtube.mjs review-flag --song-id SONG_ID --status unresolved|review-required|quality-excluded|deferred-rate-limit|quota-deferred --reason TEXT",
    "  node tools/verify-youtube.mjs review-unflag --song-id SONG_ID",
    "  node tools/verify-youtube.mjs cleanup-verification",
    "",
    "Options:",
    `  --file PATH       Local verification store (default: ${DEFAULT_RECORD_PATH})`,
    `  --catalog PATH    Public catalog (default: ${DEFAULT_CATALOG_PATH})`,
    `  --candidates PATH Candidate mapping file (default: ${DEFAULT_CANDIDATE_PATH})`,
    `  --review PATH     Local unresolved/review-required flags (default: ${DEFAULT_REVIEW_PATH})`,
    "  --song-id ID      Catalog song ID",
    "  --video-id ID     Candidate YouTube video ID",
    "  --song-ids IDS    Comma-separated IDs for explicit bulk approval",
    "  --query TEXT      Exact custom search text; only with --song-id",
    "  --status VALUE    unresolved, review-required, quality-excluded, deferred-rate-limit, or quota-deferred for review-flag",
    "  --reason TEXT     Human-readable review reason",
    "  --all             Search eligible catalog songs instead of one song",
    `  --max-results N   Search results per song, 1-5 (default: ${DEFAULT_SEARCH_RESULTS})`,
    `  --max-songs N     Songs searched by --all, 1-100 (default: ${DEFAULT_SEARCH_SONG_LIMIT})`,
    "  --offset N        Skip eligible songs when using --all (default: 0)",
    `  --retry-limit N   Retry temporary API throttling 0-5 times (default: ${DEFAULT_RETRY_LIMIT})`,
    "  --manual-match    Explicitly confirm the candidate matches the catalog song",
    "  --karaoke-suitable Explicitly confirm the video is suitable for karaoke",
    "  --confirm         Required acknowledgement for approve-batch",
    "  --dry-run         Search and rank without writing candidates or verification records",
    "  --help            Show this help",
    "",
    "Search is discovery only: it uses search.list, never approves or promotes, and never writes catalog or verification data.",
    "--query is exact and cannot be combined with --all. --all is capped by default to control quota usage.",
    "auto-batch searches only null catalog IDs, skips unresolved/review-required/quality-excluded songs, conservatively selects candidates, binds them before videos.list verification, and never promotes.",
    "auto-complete processes the entire eligible catalog in one run, reuses or searches candidates, technically verifies them, promotes only strict auto-high-confidence matches, and leaves exceptions in REVIEW REQUIRED. Explicitly SD candidates are not auto-promoted.",
    "auto-complete retries temporary 429 throttling with bounded backoff, persists deferred-rate-limit songs, and stops cleanly on distinguishable daily quota exhaustion.",
    "approve-batch is the one-command human approval path: list only reviewed song IDs and include --manual-match --karaoke-suitable --confirm. It skips every record that fails a technical or catalog gate.",
    "cleanup-verification removes only identical duplicates and orphan records with exactly one matching promoted song-linked record; ambiguous records are kept.",
    `Batch verification uses videos.list in groups of up to ${MAX_IDS_PER_REQUEST} unique IDs and remains authoritative for API metadata.`,
    "Promotion requires every automated and manual gate, never overwrites an existing catalog video ID, and keeps API credentials local."
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    const isAutoComplete = process.argv.includes("auto-complete");
    if (isAutoComplete) {
      console.error("auto-complete failed");
      console.error(`phase: ${error.phase || "unknown"}`);
      console.error(`song: ${error.songId || "none"}`);
      console.error(`error: ${error.message}`);
    } else {
      console.error(`Verification failed: ${error.message}`);
      if (process.env.NODE_ENV !== "production") console.error(`Development diagnostic | phase: ${error.phase || "unknown"} | song: ${error.songId || "none"}`);
    }
    process.exitCode = 1;
  });
}
