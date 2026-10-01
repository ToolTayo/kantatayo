#!/usr/bin/env node

/**
 * Development-only catalog expansion workflow.
 *
 * It consumes persisted provider reports instead of searching YouTube itself.
 * The existing real Playwright audit is the only technical playback gate.
 */

import { createHash } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { normalizeCatalog } from "../src/catalog.js";

export const DEFAULT_CATALOG = "data/songs.sample.json";
export const DEFAULT_REPORT = "tools/kantacue-expansion-100-report.json";
export const DEFAULT_MANIFEST = "tools/kantacue-expansion-100.runtime-manifest.json";
export const DEFAULT_RUNTIME = "tools/kantacue-expansion-100.runtime.json";
export const DEFAULT_CHECKPOINT = "tools/kantacue-expansion-100.runtime.checkpoint.json";
export const TARGET_ADDITIONS = 100;
export const DISCOVERY_POOL_TARGET = 300;
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const SOURCE_REPORTS = Object.freeze([
  { provider: "CoversPH", file: "tools/coversph-expansion-100-report.json", priority: 3 },
  { provider: "Atomic Karaoke", file: "tools/atomic-karaoke-expansion-100-report.json", priority: 2 },
  { provider: "KaraokeyTV", file: "tools/karaokeytv-expansion-100-runtime-report.json", priority: 1 }
]);
const KARAOKE_WORDING = /\b(?:karaoke|instrumental|backing\s+track|minus\s+one|sing\s+along)\b/i;
const HARD_NEGATIVES = /\b(?:medley|mashup|compilation|live|concert|tutorial|reaction|shorts?|official\s+music\s+video|acoustic|unplugged|remix|guide\s+(?:vocal|melody)|with\s+(?:guide\s+)?vocals?|lower\s+key|higher\s+key|altered\s+key|part\s*[1-9])\b/i;
const QUALITY_METADATA_NEGATIVES = /\b(?:cover|karaoke\s+version)\b/i;
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const VALID_RANGES = new Set(["low", "medium", "high"]);
const VALID_PERFORMANCE = new Set(["solo", "duet", "group"]);

function normalizePart(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:feat\.?|ft\.?)\b/g, " featuring ")
    .replace(/\b(?:karaoke|instrumental|backing\s+track|minus\s+one|original\s+key|lyrics?|hd)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

export function songIdentityKey(title, artist) {
  return normalizePart(title) + "\u0000" + normalizePart(artist);
}

// Keep explicit historical quality exclusions out of future persisted-report
// expansions. These are not catalog records and must not be recreated merely
// because a provider report still contains the old candidate.
const HISTORICAL_QUALITY_EXCLUSIONS = new Map([
  [songIdentityKey("TUNAY NA NAGMAMAHAL", "J Brothers"), "previous catalog quality review exclusion"]
]);

function catalogHash(catalog) {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

function numericViews(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim().toLowerCase().replace(/,/g, "");
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/i);
  if (!match) return 0;
  const multiplier = ({ k: 1e3, m: 1e6, b: 1e9 })[match[2] || ""] || 1;
  return Math.round(Number(match[1]) * multiplier);
}

function metadataFor(entry) {
  const metadata = entry.metadata || {};
  const list = (value) => Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().toLowerCase())
    : [];
  return {
    language: typeof metadata.language === "string" ? metadata.language.trim() : "",
    genre: typeof metadata.genre === "string" ? metadata.genre.trim() : "",
    era: typeof metadata.era === "string" ? metadata.era.trim() : "",
    mood: list(metadata.mood),
    difficulty: String(metadata.difficulty || "medium").trim().toLowerCase(),
    vocalRange: String(metadata.vocalRange || "medium").trim().toLowerCase(),
    performanceType: String(metadata.performanceType || "solo").trim().toLowerCase(),
    tags: list(metadata.tags)
  };
}

function reportEntries(report, provider) {
  const entries = Array.isArray(report.all) ? report.all : Array.isArray(report.entries) ? report.entries : [];
  return entries.map((entry) => ({ ...entry, provider }));
}

function candidateRejection(entry, catalog, identityKeys, videoIds) {
  const title = String(entry.title || "").trim();
  const artist = String(entry.artist || "").trim();
  const sourceTitle = String(entry.videoTitle || entry.sourceTitle || "").replace(/\s+/g, " ").trim();
  const metadata = metadataFor(entry);
  const reasons = [];
  const historicalExclusion = HISTORICAL_QUALITY_EXCLUSIONS.get(songIdentityKey(title, artist));
  if (historicalExclusion) reasons.push(historicalExclusion);
  if (entry.decision && entry.decision !== "NEW CANDIDATE") reasons.push("source decision was " + entry.decision);
  if (!VIDEO_ID_PATTERN.test(String(entry.videoId || ""))) reasons.push("invalid YouTube video ID");
  if (!title || !artist) reasons.push("metadata incomplete");
  if (!metadata.language || !metadata.genre || !metadata.era || !metadata.mood.length) reasons.push("catalog metadata incomplete");
  if (!VALID_DIFFICULTIES.has(metadata.difficulty)) reasons.push("invalid difficulty metadata");
  if (!VALID_RANGES.has(metadata.vocalRange)) reasons.push("invalid vocal-range metadata");
  if (!VALID_PERFORMANCE.has(metadata.performanceType)) reasons.push("invalid performance-type metadata");
  if (!KARAOKE_WORDING.test(sourceTitle)) reasons.push("karaoke/instrumental wording is not explicit");
  if (HARD_NEGATIVES.test(sourceTitle) || HARD_NEGATIVES.test(title + " " + artist)) reasons.push("non-standard or unsuitable version wording");
  if (QUALITY_METADATA_NEGATIVES.test(artist)) reasons.push("artist metadata contains cover/version wording");
  if (entry.embeddable !== true) reasons.push("API embeddable gate is not true");
  if (entry.madeForKids !== false) reasons.push("Made-for-Kids gate is not false");
  if (entry.definition && entry.definition !== "hd") reasons.push("HD definition gate failed");
  if (Array.isArray(entry.metadataWarnings) && entry.metadataWarnings.length) reasons.push(...entry.metadataWarnings);
  const identity = songIdentityKey(title, artist);
  if (identityKeys.has(identity)) reasons.push("song identity already exists in the catalog");
  if (videoIds.has(entry.videoId)) reasons.push("video ID already exists in the catalog");
  return { reasons, identity, metadata };
}

function scoreCandidate(entry, providerPriority) {
  const views = numericViews(entry.publicViews ?? entry.viewCount);
  const metadata = metadataFor(entry);
  const opm = metadata.language.toLowerCase() === "filipino" || metadata.tags.includes("opm");
  return Math.log10(views + 1) * 10 + (opm ? 4 : 0) + (providerPriority[entry.provider] || 0);
}

function makeReportEntry(entry, score) {
  return {
    provider: entry.provider,
    sourceChannelId: entry.sourceChannelId || entry.channelId || null,
    channel: entry.channel || entry.channelTitle || entry.provider,
    title: String(entry.title).trim(),
    artist: String(entry.artist).trim(),
    videoId: entry.videoId,
    videoTitle: entry.videoTitle || entry.sourceTitle || null,
    publicViews: entry.publicViews ?? entry.viewCount ?? null,
    publishedAt: entry.publishedAt || null,
    definition: entry.definition || null,
    embeddable: entry.embeddable,
    madeForKids: entry.madeForKids,
    duration: entry.duration || null,
    metadata: metadataFor(entry),
    identityKey: songIdentityKey(entry.title, entry.artist),
    sourceRank: entry.sourceRank || entry.uploadPosition || entry.playlistPosition || null,
    popularityScore: score,
    runtimeStatus: "UNTESTED",
    runtimeError: null,
    selectedStatus: "CANDIDATE"
  };
}

export function buildCandidateReport(catalog, sourceReports, options = {}) {
  const identityKeys = new Set(catalog.map((song) => songIdentityKey(song.title, song.artist)));
  const videoIds = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  const providerPriority = Object.fromEntries(SOURCE_REPORTS.map((source) => [source.provider, source.priority]));
  const all = [];
  const seenIdentity = new Set();
  const seenVideo = new Set();
  const summary = { candidatesInspected: 0, uniqueCandidates: 0, existingPlayableDuplicates: 0, existingUnavailableDuplicates: 0, duplicateVideoIds: 0, rejected: 0, newCandidates: 0 };

  for (const source of sourceReports) {
    for (const raw of reportEntries(source.report, source.provider)) {
      summary.candidatesInspected += 1;
      const identity = songIdentityKey(raw.title, raw.artist);
      const reasons = candidateRejection(raw, catalog, identityKeys, videoIds);
      if (seenIdentity.has(identity) || seenVideo.has(raw.videoId)) {
        summary.duplicateVideoIds += seenVideo.has(raw.videoId) ? 1 : 0;
        summary.rejected += 1;
        all.push({ ...makeReportEntry({ ...raw, provider: source.provider }, 0), decision: "REJECTED_DUPLICATE_CANDIDATE", rejectionReasons: ["duplicate candidate in the persisted provider pool"] });
        continue;
      }
      seenIdentity.add(identity);
      if (raw.videoId) seenVideo.add(raw.videoId);
      if (reasons.reasons.length) {
        const existingSong = catalog.find((item) => songIdentityKey(item.title, item.artist) === identity);
        if (existingSong) {
          if (existingSong.youtubeVideoId) summary.existingPlayableDuplicates += 1;
          else summary.existingUnavailableDuplicates += 1;
        } else summary.rejected += 1;
        all.push({ ...makeReportEntry({ ...raw, provider: source.provider }, 0), decision: existingSong ? (existingSong.youtubeVideoId ? "EXISTING_PLAYABLE_SONG" : "EXISTING_UNAVAILABLE_SONG") : "REJECTED_PREFILTER", rejectionReasons: reasons.reasons });
        continue;
      }
      const score = scoreCandidate({ ...raw, provider: source.provider }, providerPriority);
      summary.uniqueCandidates += 1;
      summary.newCandidates += 1;
      all.push({ ...makeReportEntry({ ...raw, provider: source.provider }, score), decision: "NEW_CANDIDATE", rejectionReasons: [] });
    }
  }

  const candidates = all.filter((entry) => entry.decision === "NEW_CANDIDATE").sort((left, right) => right.popularityScore - left.popularityScore || numericViews(right.publicViews) - numericViews(left.publicViews) || left.title.localeCompare(right.title));
  const requestedPool = Number(options.poolSize) || DISCOVERY_POOL_TARGET;
  const pool = candidates.slice(0, Math.max(250, Math.min(400, requestedPool)));
  pool.forEach((entry, index) => { entry.poolRank = index + 1; });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    status: "CANDIDATES_READY",
    catalogBefore: catalog.length,
    catalogHash: catalogHash(catalog),
    targetAdditions: TARGET_ADDITIONS,
    discoveryPoolTarget: DISCOVERY_POOL_TARGET,
    sourceReports: sourceReports.map((source) => ({ provider: source.provider, file: source.file })),
    selectionMethod: "Persisted official-provider candidate reports, global normalized identity/video dedupe, conservative title/version/API gates, popularity score from public view evidence with modest OPM/provider priors. Runtime playback is a separate mandatory gate.",
    summary,
    candidatesInspected: all.length,
    poolSize: pool.length,
    entries: all,
    runtimeCandidates: pool
  };
}

function stableMaxId(catalog) {
  return Math.max(0, ...catalog.map((song) => Number(String(song.id).match(/(\d+)$/)?.[1] || 0)));
}

export function buildRuntimeManifest(report, catalog) {
  const control = catalog.find((song) => song.id === "sample-029");
  if (!control || control.youtubeVideoId !== "QBb9wO3Bj0k") throw new Error("The sample-029 runtime control is missing or changed.");
  const entries = [{ songId: control.id, title: control.title, artist: control.artist, videoId: control.youtubeVideoId, provider: "CoversPH", metadataStatus: "VALID", apiEmbeddable: true, madeForKids: false, iframeStatus: "UNTESTED", note: "Control gate: known-good production assignment." }];
  report.runtimeCandidates.forEach((entry, index) => entries.push({
    songId: "kantacue-expansion-candidate-" + String(index + 1).padStart(3, "0"),
    title: entry.title,
    artist: entry.artist,
    videoId: entry.videoId,
    provider: entry.provider,
    channel: entry.channel,
    metadataStatus: "VALID",
    metadataWarnings: [],
    apiEmbeddable: entry.embeddable,
    madeForKids: entry.madeForKids,
    definition: entry.definition,
    publicViews: entry.publicViews,
    iframeStatus: "UNTESTED",
    errorCode: null,
    failureClassification: null,
    replacementRequired: false,
    qualityStatus: "PREFILTERED",
    note: "Runtime PASS is required before this candidate can be selected.",
    testedAt: null
  }));
  return { version: 1, generatedAt: new Date().toISOString(), mode: "kantacue-expansion-runtime", catalogCount: catalog.length, catalogHash: report.catalogHash, playbackWindowMs: 15000, controlSongId: "sample-029", entries };
}

function safeMetadata(entry) {
  const metadata = entry.metadata;
  const fallback = (value, allowed, defaultValue) => allowed.has(value) ? value : defaultValue;
  return {
    language: metadata.language,
    genre: metadata.genre,
    era: metadata.era,
    mood: metadata.mood.length ? metadata.mood : ["feel-good"],
    difficulty: fallback(metadata.difficulty, VALID_DIFFICULTIES, "medium"),
    vocalRange: fallback(metadata.vocalRange, VALID_RANGES, "medium"),
    performanceType: fallback(metadata.performanceType, VALID_PERFORMANCE, "solo"),
    tags: [...new Set([...metadata.tags, metadata.language.toLowerCase() === "filipino" ? "opm" : "international", "popular", entry.provider.toLowerCase().replace(/\s+/g, "-")])]
  };
}

function selectPromotions(report, runtime, maxAdditions) {
  const runtimeByVideo = new Map((runtime.entries || []).map((entry) => [entry.videoId, entry]));
  const passed = report.runtimeCandidates
    .map((entry, index) => ({ entry, runtime: runtimeByVideo.get(entry.videoId), manifestId: "kantacue-expansion-candidate-" + String(index + 1).padStart(3, "0") }))
    .filter(({ runtime }) => runtime?.iframeStatus === "PASS");
  const artistCounts = new Map();
  const selected = [];
  const remaining = [...passed];
  const limit = Math.min(TARGET_ADDITIONS, maxAdditions);
  const addIfDiverse = (candidate, relaxed = false) => {
    const key = normalizePart(candidate.entry.artist);
    const count = artistCounts.get(key) || 0;
    if (!relaxed && count >= 4) return false;
    artistCounts.set(key, count + 1);
    selected.push(candidate);
    return true;
  };
  while (selected.length < limit && remaining.length) {
    let added = false;
    for (let index = 0; index < remaining.length && selected.length < limit; index += 1) {
      if (addIfDiverse(remaining[index])) { remaining.splice(index, 1); index -= 1; added = true; }
    }
    if (!added) break;
  }
  for (const candidate of remaining) {
    if (selected.length >= limit) break;
    addIfDiverse(candidate, true);
  }
  return { selected, runtimePassCount: passed.length, artistCount: artistCounts.size };
}

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }

async function writeJsonAtomic(file, value) {
  const target = path.resolve(file);
  const temp = target + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temp, target); return; } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 6) { await unlink(temp).catch(() => {}); throw error; }
      await new Promise((resolve) => setTimeout(resolve, 40 * 2 ** attempt));
    }
  }
}

async function prepare(options) {
  const catalog = await readJson(options.catalog);
  const sourceReports = [];
  for (const source of SOURCE_REPORTS) {
    if (existsSync(source.file)) sourceReports.push({ ...source, report: await readJson(source.file) });
  }
  if (!sourceReports.length) throw new Error("No persisted provider candidate reports were found.");
  const report = buildCandidateReport(catalog, sourceReports, { poolSize: options.poolSize });
  const manifest = buildRuntimeManifest(report, catalog);
  await writeJsonAtomic(options.report, report);
  await writeJsonAtomic(options.manifest, manifest);
  console.log("Prepared " + report.poolSize + " runtime candidates from " + report.candidatesInspected + " persisted entries.");
  console.log("Report: " + options.report);
  console.log("Manifest: " + options.manifest);
}

async function apply(options) {
  const catalog = await readJson(options.catalog);
  const report = await readJson(options.report);
  const runtime = await readJson(options.runtime);
  if (catalogHash(catalog) !== report.catalogHash) throw new Error("Catalog changed after candidate preparation; refusing to apply.");
  const control = runtime.entries?.find((entry) => entry.songId === "sample-029");
  if (control?.iframeStatus !== "PASS") throw new Error("Runtime control gate failed: sample-029 did not PASS.");
  const selection = selectPromotions(report, runtime, options.maxAdditions);
  const existingIdentity = new Set(catalog.map((song) => songIdentityKey(song.title, song.artist)));
  const existingVideos = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  const additions = [];
  let nextId = stableMaxId(catalog) + 1;
  for (const { entry, runtime: result } of selection.selected) {
    const identity = songIdentityKey(entry.title, entry.artist);
    if (existingIdentity.has(identity) || existingVideos.has(entry.videoId)) continue;
    additions.push({ id: "sample-" + String(nextId++).padStart(3, "0"), title: entry.title, artist: entry.artist, ...safeMetadata(entry), demandTier: null, youtubeVideoId: entry.videoId });
    existingIdentity.add(identity);
    existingVideos.add(entry.videoId);
    entry.runtimeStatus = result.iframeStatus;
    entry.runtimePlaybackGate = ">=15 seconds sustained through the existing Chromium audit page";
    entry.selectedStatus = "ADDED";
  }
  const normalized = normalizeCatalog([...catalog, ...additions], { logger: { warn() {} } });
  if (normalized.songs.length !== catalog.length + additions.length) throw new Error("Catalog validation rejected one or more proposed additions.");
  if (!options.dryRun) await writeJsonAtomic(options.catalog, [...catalog, ...additions]);
  report.status = options.dryRun ? "DRY_RUN_READY" : "APPLIED";
  report.catalogAfter = catalog.length + additions.length;
  report.added = additions.map((song) => ({ id: song.id, title: song.title, artist: song.artist, videoId: song.youtubeVideoId }));
  report.runtime = { control: control.iframeStatus, candidatesTested: runtime.entries?.length || 0, pass: selection.runtimePassCount, selected: selection.selected.length, uniqueArtists: selection.artistCount };
  report.summary = { ...(report.summary || {}), runtimePass: selection.runtimePassCount, added: additions.length, skippedAfterRuntime: selection.selected.length - additions.length };
  await writeJsonAtomic(options.report, report);
  console.log((options.dryRun ? "Dry run" : "Applied") + ": " + additions.length + " additions; runtime PASS " + selection.runtimePassCount + "; catalog " + catalog.length + " -> " + (catalog.length + additions.length) + ".");
}

function parseArgs(argv) {
  const options = { command: argv[0] || "help", catalog: DEFAULT_CATALOG, report: DEFAULT_REPORT, manifest: DEFAULT_MANIFEST, runtime: DEFAULT_RUNTIME, maxAdditions: TARGET_ADDITIONS, poolSize: DISCOVERY_POOL_TARGET, dryRun: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--catalog") options.catalog = argv[++index];
    else if (arg === "--report") options.report = argv[++index];
    else if (arg === "--manifest") options.manifest = argv[++index];
    else if (arg === "--runtime") options.runtime = argv[++index];
    else if (arg === "--max-additions") options.maxAdditions = Math.min(TARGET_ADDITIONS, Math.max(0, Number(argv[++index])));
    else if (arg === "--pool-size") options.poolSize = Math.min(400, Math.max(250, Number(argv[++index])));
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help") options.command = "help";
    else throw new Error("Unknown argument: " + arg);
  }
  return options;
}

function printHelp() {
  console.log("KantaCue persisted-report expansion workflow\n\nCommands:\n  prepare       Build a deduped 250-400 candidate pool and runtime manifest\n  apply         Add only candidates with a real runtime PASS (max 100)\n\nRun the existing runtime gate between commands:\n  node tools/run-playability-audit.mjs --manifest tools/kantacue-expansion-100.runtime-manifest.json --page-manifest tools/kantacue-expansion-100.runtime-manifest.json --output tools/kantacue-expansion-100.runtime.json --checkpoint tools/kantacue-expansion-100.runtime.checkpoint.json\n\nNo command searches YouTube or writes credentials. The apply command refuses to run unless sample-029 / QBb9wO3Bj0k passes and all selected records remain unique.");
}

const options = parseArgs(process.argv.slice(2));
try {
  if (options.command === "prepare") await prepare(options);
  else if (options.command === "apply") await apply(options);
  else printHelp();
} catch (error) {
  console.error("KantaCue expansion failed: " + (error.message || error));
  process.exitCode = 1;
}
