#!/usr/bin/env node

/**
 * Resumable development-only repair workflow for catalog assignments that
 * failed the real iframe audit with Error 150.
 *
 * Preparation uses existing local provenance first, then exact catalog
 * metadata searches only for songs without a reusable candidate. API metadata
 * is a filter/ranking signal; only the real Playwright audit can authorize an
 * assignment. The production catalog is changed only by the explicit apply
 * command and only for candidates whose runtime result is PASS.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  atomicWriteJson,
  isValidVideoId,
  rankSearchCandidates,
  requestSearchResults,
  requestVideoBatch
} from "./verify-youtube.mjs";
import { hashCatalog } from "./build-playability-audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = path.join(ROOT, "data", "songs.sample.json");
const RUNTIME_AUDIT_PATH = path.join(ROOT, "tools", "youtube-full-playability-audit.runtime.json");
const REPAIR_REPORT_PATH = path.join(ROOT, "tools", "youtube-embed-repair.json");
const CANDIDATE_MANIFEST_PATH = path.join(ROOT, "tools", "youtube-embed-repair-candidates.json");
const RUNTIME_REPORT_PATH = path.join(ROOT, "tools", "youtube-embed-repair.runtime.json");
const CHECKPOINT_PATH = path.join(ROOT, "tools", "youtube-embed-repair.runtime.checkpoint.json");
const MAX_RESULTS = 5;
const SECOND_PASS_MAX_RESULTS = 10;
const DEFAULT_RUNTIME_CANDIDATES_PER_SONG = 2;
const CONTROL_IDS = ["sample-029", "sample-001", "sample-003"];
const REPORT_SOURCES = [
  "tools/atomic-karaoke-expansion-report.json",
  "tools/atomic-karaoke-expansion-100-report.json",
  "tools/coversph-top-50-report.json",
  "tools/coversph-expansion-100-report.json",
  "tools/karaokeytv-expansion-report.json",
  "tools/pro-music-cover-expansion-report.json",
  "tools/sing-king-top-50-candidates.json",
  "tools/youtube-quality-audit.json",
  "tools/youtube-verification.json"
];

const TERMINAL_STATUSES = new Set(["PASS", "ERROR 2", "ERROR 5", "ERROR 100", "ERROR 101", "ERROR 150", "ERROR 153", "TIMEOUT", "AUTOPLAY POLICY ONLY", "INCONCLUSIVE"]);

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(`Usage: node tools/repair-youtube-embeds.mjs <command> [options]

Commands:
  prepare     Build/resume a ranked replacement report; searches only missing local coverage.
  test        Test ranked candidates through the existing Playwright audit/controller path.
  apply       Replace only assignments whose candidate runtime result is PASS.
  report      Print the current repair summary without changing the catalog.
  repair      Run prepare, runtime testing, and safe apply in sequence.

Options:
  --max-candidates N  Candidate attempts per song in the runtime manifest (default: ${DEFAULT_RUNTIME_CANDIDATES_PER_SONG}).
  --second-pass       Continue the current 67-song Error 150 scope with deeper discovery. Preserves the first-pass report.
  --max-results N     Search results per second-pass query (default: ${SECOND_PASS_MAX_RESULTS}).
  --retry-rate-limited Retry second-pass queries previously recorded as HTTP 429 (off by default).
  --mark-unavailable Mark still-unresolved confirmed Error 150 records unavailable after PASS-only apply.
  --concurrency N     Playwright pages, capped at 3 (default: 3).
  --per-song-timeout MS  Runtime wait limit (default: 45000).
  --resume            Reuse existing persisted preparation/runtime progress.
  --help              Show this help.

No command downloads media, exposes credentials, or promotes metadata-only candidates.
`);
  process.exit(0);
}

try {
  if (options.command === "prepare" || options.command === "repair") await prepare();
  if (options.command === "test" || options.command === "repair") await testCandidates();
  if (options.command === "apply" || options.command === "repair") await applyPasses();
  if (options.command === "report") await printReport();
  if (!options.command) throw new Error("A command is required. Use --help for usage.");
} catch (error) {
  console.error(`repair-youtube-embeds failed: ${error.message}`);
  process.exitCode = 1;
}

async function prepare() {
  const catalog = await readJson(CATALOG_PATH);
  const runtime = await readJson(RUNTIME_AUDIT_PATH);
  const existing = existsSync(REPAIR_REPORT_PATH) ? await readJson(REPAIR_REPORT_PATH) : null;
  const broken = (runtime.entries || []).filter((entry) => Number(entry.errorCode) === 150 || entry.iframeStatus === "ERROR 150");
  const expectedBroken = options.secondPass ? 67 : 127;
  if (options.secondPass && broken.length === 0 && existing?.secondPassInput === expectedBroken && Array.isArray(existing.unavailable) && existing.unavailable.length === expectedBroken) {
    console.log(`Second-pass repair is already reconciled: ${expectedBroken} assignments are unavailable and no new runtime candidates are pending.`);
    return;
  }
  if (catalog.length !== 561 || broken.length !== expectedBroken) {
    throw new Error(`Expected the ${options.secondPass ? "second-pass" : "first-pass"} baseline of 561 songs and ${expectedBroken} Error 150 entries; found ${catalog.length} and ${broken.length}.`);
  }
  const catalogHash = hashCatalog(catalog);
  const currentVideoIds = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  const canReuseExisting = options.secondPass
    ? Boolean(existing && existing.catalogCount === catalog.length && Array.isArray(existing.entries))
    : Boolean(options.resume && existing?.catalogHash === catalogHash && existing?.error150Count === broken.length);
  const report = canReuseExisting
    ? existing
    : { version: 1, generatedAt: new Date().toISOString(), catalogHash, catalogCount: catalog.length, error150Count: broken.length, sourceRuntimeReport: path.relative(ROOT, RUNTIME_AUDIT_PATH), search: {}, api: { batches: 0, errors: [] }, entries: [] };
  report.catalogHash = catalogHash;
  report.catalogCount = catalog.length;
  report.sourceRuntimeReport = path.relative(ROOT, RUNTIME_AUDIT_PATH);
  if (!report.api || typeof report.api !== "object") report.api = { batches: 0, errors: [] };
  if (!Array.isArray(report.api.errors)) report.api.errors = [];
  if (!report.search || typeof report.search !== "object") report.search = {};
  if (!report.secondPassSearch || typeof report.secondPassSearch !== "object") report.secondPassSearch = {};
  const sourceRows = await collectSourceRows();
  const priorBySong = new Map((report.entries || []).map((entry) => [entry.songId, entry]));
  const catalogById = new Map(catalog.map((song) => [song.id, song]));
  const attemptedIds = collectAttemptedIds(report, currentVideoIds);

  for (const failure of broken) {
    const song = catalogById.get(failure.songId);
    if (!song) continue;
    const previous = priorBySong.get(song.id) || { songId: song.id, title: song.title, artist: song.artist, oldVideoId: failure.videoId, oldRuntimeStatus: "ERROR 150", searchQuery: `${song.title} ${song.artist} karaoke`, searchError: null, candidates: [] };
    if (!previous.oldVideoId) previous.oldVideoId = failure.videoId;
    const localCandidates = sourceRows
      .filter((row) => matchesSong(row, song) && !attemptedIds.has(row.videoId))
      .map((row) => ({ ...row, source: row.source || "local-report" }));
    let discovered = [...localCandidates];
    if (options.secondPass) {
      const searchRecord = report.secondPassSearch[song.id] || { queries: [], results: [], errors: [] };
      const deepQuery = buildSecondPassQuery(song);
      const rateLimited = searchRecord.errors?.some((message) => /HTTP 429|rate limit|quota/i.test(message));
      const needsSearch = !searchRecord.queries.includes(deepQuery) || (rateLimited && options.retryRateLimited);
      if (needsSearch && !searchRecord.completed && (!rateLimited || options.retryRateLimited)) {
        try {
          const apiKey = getApiKey();
          const searchResults = await requestSearchResults(deepQuery, options.maxResults, apiKey, fetch);
          searchRecord.queries.push(deepQuery);
          searchRecord.results.push(...searchResults);
          searchRecord.searchedAt = new Date().toISOString();
          searchRecord.completed = true;
        } catch (error) {
          searchRecord.queries.push(deepQuery);
          searchRecord.errors.push(error.message);
          searchRecord.searchedAt = new Date().toISOString();
          previous.searchError = error.message;
        }
        report.secondPassSearch[song.id] = searchRecord;
        await atomicWriteJson(REPAIR_REPORT_PATH, report);
      }
      discovered.push(...(searchRecord.results || []).map((candidate) => ({ ...candidate, source: "youtube-data-api-second-pass" })));
    } else if (discovered.length === 0 && !report.search?.[song.id]) {
      try {
        const apiKey = getApiKey();
        const searchResults = await requestSearchResults(previous.searchQuery, MAX_RESULTS, apiKey, fetch);
        report.search[song.id] = { query: previous.searchQuery, results: searchResults, searchedAt: new Date().toISOString() };
        discovered = searchResults.map((candidate) => ({ ...candidate, source: "youtube-data-api-search" }));
      } catch (error) {
        previous.searchError = error.message;
        report.search[song.id] = { query: previous.searchQuery, results: [], error: error.message, searchedAt: new Date().toISOString() };
      }
      report.entries = [...priorBySong.values(), previous];
      await atomicWriteJson(REPAIR_REPORT_PATH, report);
    } else if (report.search?.[song.id]) {
      discovered = [...discovered, ...(report.search[song.id].results || []).map((candidate) => ({ ...candidate, source: "youtube-data-api-search" }))];
    }
    const deduped = dedupeCandidates(discovered).filter((candidate) => {
      if (!isValidVideoId(candidate.videoId)) return false;
      if (attemptedIds.has(candidate.videoId)) return false;
      return true;
    });
    const knownCandidates = new Map((previous.candidates || []).map((candidate) => [candidate.videoId, candidate]));
    deduped.forEach((candidate) => {
      if (!knownCandidates.has(candidate.videoId)) {
        knownCandidates.set(candidate.videoId, { ...candidate, apiVerified: null, embeddable: candidate.embeddable ?? null, madeForKids: candidate.madeForKids ?? null });
        attemptedIds.add(candidate.videoId);
      }
    });
    previous.candidates = [...knownCandidates.values()];
    priorBySong.set(song.id, previous);
    report.entries = [...priorBySong.values()];
    await atomicWriteJson(REPAIR_REPORT_PATH, report);
  }

  const candidateIds = [...new Set(report.entries.flatMap((entry) => entry.candidates || [])
    .filter((candidate) => candidate.apiVerified === null || candidate.apiVerified === undefined)
    .map((candidate) => candidate.videoId).filter(isValidVideoId))];
  const apiById = new Map();
  const apiKey = getApiKey();
  for (const batch of chunk(candidateIds, 50)) {
    try {
      const records = await requestVideoBatch(batch, apiKey, new Date().toISOString(), fetch);
      records.forEach((record) => apiById.set(record.candidateVideoId, record));
      report.api.batches += 1;
      await atomicWriteJson(REPAIR_REPORT_PATH, report);
    } catch (error) {
      report.api.errors.push({ at: new Date().toISOString(), message: error.message, ids: batch });
      await atomicWriteJson(REPAIR_REPORT_PATH, report);
      console.error(`VIDEO_METADATA_ERROR | ${batch.length} candidates | ${error.message}`);
    }
  }

  const usedForRanking = new Set(currentVideoIds);
  for (const entry of report.entries) {
    const song = catalogById.get(entry.songId);
    const hydrated = (entry.candidates || []).map((candidate) => ({ ...candidate, ...(apiById.get(candidate.videoId) || {}), videoId: candidate.videoId, channelTitle: apiById.get(candidate.videoId)?.channelTitle || candidate.channelTitle, videoTitle: apiById.get(candidate.videoId)?.videoTitle || candidate.videoTitle, source: candidate.source }));
    const ranked = rankSearchCandidates(song, hydrated)
      .filter((candidate) => candidate.apiVerified === true && candidate.embeddable === true && candidate.madeForKids === false && candidate.technicalGatePass && !candidate.hardBlocked && !usedForRanking.has(candidate.videoId))
      .map((candidate, index) => ({ ...candidate, rank: index + 1, runtimeStatus: entry.candidates.find((item) => item.videoId === candidate.videoId)?.runtimeStatus || "UNTESTED" }));
    entry.candidates = ranked;
    ranked.forEach((candidate) => usedForRanking.add(candidate.videoId));
  }
  report.preparedAt = new Date().toISOString();
  report.mode = options.secondPass ? "second-pass-deep-discovery" : "first-pass-repair";
  report.secondPassInput = options.secondPass ? broken.length : report.secondPassInput;
  report.summary = summarizeRepair(report);
  await atomicWriteJson(REPAIR_REPORT_PATH, report);
  await writeRuntimeManifest(report, catalog);
  console.log(`Prepared ${report.entries.length} failed songs; ${report.entries.reduce((sum, entry) => sum + entry.candidates.length, 0)} strict API-qualified runtime candidates.`);
  console.log(`Report: ${path.relative(ROOT, REPAIR_REPORT_PATH)}`);
}

async function testCandidates() {
  if (!existsSync(REPAIR_REPORT_PATH) || !existsSync(CANDIDATE_MANIFEST_PATH)) throw new Error("Run prepare first.");
  const childArgs = ["tools/run-playability-audit.mjs", "--manifest", path.relative(ROOT, CANDIDATE_MANIFEST_PATH), "--page-manifest", path.relative(ROOT, CANDIDATE_MANIFEST_PATH), "--output", path.relative(ROOT, RUNTIME_REPORT_PATH), "--checkpoint", path.relative(ROOT, CHECKPOINT_PATH), "--concurrency", String(options.concurrency), "--per-song-timeout", String(options.perSongTimeout)];
  if (options.resume) childArgs.push("--resume");
  await runNode(childArgs);
  const runtime = await readJson(RUNTIME_REPORT_PATH);
  const report = await readJson(REPAIR_REPORT_PATH);
  const statusByVideo = new Map((runtime.entries || []).map((entry) => [entry.videoId, entry]));
  for (const entry of report.entries) {
    for (const candidate of entry.candidates) {
      const result = statusByVideo.get(candidate.videoId);
      if (result) {
        candidate.runtimeStatus = result.iframeStatus;
        candidate.runtimeErrorCode = result.errorCode || null;
        candidate.runtimeTestedAt = result.testedAt || null;
        candidate.runtimeNote = result.note || null;
      }
    }
  }
  report.runtimeReport = path.relative(ROOT, RUNTIME_REPORT_PATH);
  report.summary = summarizeRepair(report);
  await atomicWriteJson(REPAIR_REPORT_PATH, report);
  console.log(`Candidate runtime report: ${path.relative(ROOT, RUNTIME_REPORT_PATH)}`);
  console.log(JSON.stringify(report.summary, null, 2));
}

async function applyPasses() {
  const report = await readJson(REPAIR_REPORT_PATH);
  const catalog = await readJson(CATALOG_PATH);
  const byId = new Map(catalog.map((song) => [song.id, song]));
  const existingIds = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  const applied = [];
  const unresolved = [];
  const unavailable = [];
  const previouslyApplied = Array.isArray(report.applied) ? [...report.applied] : [];
  const recordedAppliedSongs = new Set(previouslyApplied.map((item) => item.songId));
  for (const entry of report.entries || []) {
    if (!entry.selectedReplacement || recordedAppliedSongs.has(entry.songId)) continue;
    const selected = (entry.candidates || []).find((candidate) => candidate.videoId === entry.selectedReplacement);
    previouslyApplied.push({
      songId: entry.songId,
      oldVideoId: entry.oldVideoId,
      newVideoId: entry.selectedReplacement,
      provider: selected?.channelTitle || selected?.provider || null
    });
    recordedAppliedSongs.add(entry.songId);
  }
  for (const entry of report.entries || []) {
    const song = byId.get(entry.songId);
    if (entry.selectedReplacement) continue;
    const selected = (entry.candidates || []).find((candidate) => candidate.runtimeStatus === "PASS" && !existingIds.has(candidate.videoId));
    if (!selected || !song || song.youtubeVideoId !== entry.oldVideoId) {
      unresolved.push({ songId: entry.songId, reason: !selected ? "no runtime PASS candidate" : "catalog changed or duplicate candidate" });
      continue;
    }
    song.youtubeVideoId = selected.videoId;
    existingIds.add(selected.videoId);
    applied.push({ songId: entry.songId, oldVideoId: entry.oldVideoId, newVideoId: selected.videoId, provider: selected.channelTitle || selected.provider || null });
    entry.selectedReplacement = selected.videoId;
  }
  if (options.markUnavailable) {
    for (const item of unresolved) {
      const entry = (report.entries || []).find((candidate) => candidate.songId === item.songId);
      const song = byId.get(item.songId);
      if (!song || !entry || song.youtubeVideoId !== entry.oldVideoId) continue;
      unavailable.push({ songId: item.songId, oldVideoId: entry.oldVideoId, reason: "confirmed Error 150 with no runtime-verified replacement" });
      song.youtubeVideoId = null;
      item.reason = "marked unavailable: confirmed Error 150 with no runtime-verified replacement";
    }
  }
  if (applied.length > 0 || unavailable.length > 0) await atomicWriteJson(CATALOG_PATH, catalog);
  report.appliedAt = new Date().toISOString();
  const appliedBySong = new Map(previouslyApplied.map((item) => [item.songId, item]));
  applied.forEach((item) => appliedBySong.set(item.songId, item));
  report.applied = [...appliedBySong.values()];
  report.unresolved = unresolved;
  report.unavailable = [...(report.unavailable || []).filter((item) => !unavailable.some((next) => next.songId === item.songId)), ...unavailable];
  report.catalogHash = hashCatalog(catalog);
  report.summary = summarizeRepair(report);
  await atomicWriteJson(REPAIR_REPORT_PATH, report);
  console.log(`Applied ${applied.length} runtime-PASS replacements; unresolved ${unresolved.length}.`);
  for (const item of applied) console.log(`REPLACED | ${item.songId} | ${item.oldVideoId} -> ${item.newVideoId} | ${item.provider || "unknown provider"}`);
  for (const item of unresolved) console.log(`UNRESOLVED | ${item.songId} | ${item.reason}`);
  for (const item of unavailable) console.log(`UNAVAILABLE | ${item.songId} | ${item.oldVideoId} | confirmed Error 150; no runtime-PASS replacement`);
}

async function printReport() {
  if (!existsSync(REPAIR_REPORT_PATH)) throw new Error("No repair report exists. Run prepare first.");
  const report = await readJson(REPAIR_REPORT_PATH);
  console.log(JSON.stringify({ ...report.summary, applied: report.applied || [], unresolved: report.unresolved || [] }, null, 2));
}

async function writeRuntimeManifest(report, catalog) {
  const controlEntries = CONTROL_IDS.map((songId) => {
    const song = catalog.find((item) => item.id === songId);
    return { songId, title: song.title, artist: song.artist, videoId: song.youtubeVideoId, provider: "control", publicViews: null, iframeStatus: "UNTESTED", control: true };
  });
  const activeSongIds = options.secondPass ? new Set((await readJson(RUNTIME_AUDIT_PATH)).entries.filter((entry) => Number(entry.errorCode) === 150 || entry.iframeStatus === "ERROR 150").map((entry) => entry.songId)) : null;
  const candidateEntries = report.entries
    .filter((entry) => !activeSongIds || activeSongIds.has(entry.songId))
    .flatMap((entry) => entry.candidates.slice(0, options.maxCandidates).map((candidate) => ({
    songId: `${entry.songId}::${candidate.videoId}`,
    catalogSongId: entry.songId,
    title: entry.title,
    artist: entry.artist,
    videoId: candidate.videoId,
    provider: candidate.channelTitle || candidate.provider || "Other",
    publicViews: candidate.viewCount ?? candidate.publicViews ?? null,
    metadataStatus: "VALID",
    apiEmbeddable: candidate.embeddable,
    madeForKids: candidate.madeForKids,
    iframeStatus: "UNTESTED",
    errorCode: null,
    qualityStatus: "UNREVIEWED",
    source: candidate.source || null
  })));
  const manifest = { version: 1, generatedAt: new Date().toISOString(), mode: options.secondPass ? "second-pass-replacement-candidate-runtime-audit" : "replacement-candidate-runtime-audit", catalogCount: catalog.length, catalogHash: hashCatalog(catalog), scope: options.secondPass ? "67 current Error 150 assignments; controls plus deeper ranked strict API-qualified alternatives" : "127 confirmed Error 150 assignments; controls plus ranked strict API-qualified alternatives", entries: [...controlEntries, ...candidateEntries] };
  await atomicWriteJson(CANDIDATE_MANIFEST_PATH, manifest);
}

async function collectSourceRows() {
  const rows = [];
  for (const relative of REPORT_SOURCES) {
    const file = path.join(ROOT, relative);
    if (!existsSync(file)) continue;
    const value = await readJson(file);
    walk(value, (node) => {
      const videoId = node.videoId || node.candidateVideoId || node.youtubeVideoId;
      const title = node.catalogTitle || node.songTitle || (node.videoTitle ? null : node.title);
      const artist = node.catalogArtist || node.artist;
      if (!isValidVideoId(videoId) || !title || !artist) return;
      rows.push({
        videoId,
        title: String(title),
        artist: String(artist),
        videoTitle: node.videoTitle || node.video_title || null,
        channelTitle: node.channelTitle || node.channel || node.provider || null,
        provider: node.provider || node.channel || node.channelTitle || null,
        publishedAt: node.publishedAt || null,
        viewCount: toNumberOrNull(node.viewCount ?? node.publicViews ?? node.observedViews),
        likeCount: toNumberOrNull(node.likeCount),
        definition: node.definition || null,
        embeddable: typeof node.embeddable === "boolean" ? node.embeddable : null,
        madeForKids: typeof node.madeForKids === "boolean" ? node.madeForKids : null,
        duration: node.duration || null,
        source: relative
      });
    });
  }
  return rows;
}

function matchesSong(row, song) {
  return normalizePair(row.title, row.artist) === normalizePair(song.title, song.artist);
}

function normalizePair(title, artist) {
  return `${normalize(title)}|${normalize(artist)}`;
}

function normalize(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "").trim();
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate.videoId || seen.has(candidate.videoId)) return false;
    seen.add(candidate.videoId);
    return true;
  });
}

function summarizeRepair(report) {
  const entries = report.entries || [];
  const candidates = entries.flatMap((entry) => entry.candidates || []);
  return {
    failedSongs: entries.length,
    songsWithCandidates: entries.filter((entry) => entry.candidates?.length).length,
    candidates: candidates.length,
    runtimePass: candidates.filter((candidate) => candidate.runtimeStatus === "PASS").length,
    runtimeError150: candidates.filter((candidate) => candidate.runtimeStatus === "ERROR 150").length,
    runtimeOtherErrors: candidates.filter((candidate) => /^ERROR /.test(candidate.runtimeStatus || "") && candidate.runtimeStatus !== "ERROR 150").length,
    runtimePending: candidates.filter((candidate) => !TERMINAL_STATUSES.has(candidate.runtimeStatus || "")).length,
    applied: (report.applied || []).length,
    unresolved: report.unresolved?.length ?? entries.filter((entry) => !entry.selectedReplacement).length
    ,unavailable: (report.unavailable || []).length
  };
}

function collectAttemptedIds(report, currentVideoIds) {
  const attempted = new Set(currentVideoIds);
  for (const entry of report.entries || []) {
    for (const candidate of entry.candidates || []) if (isValidVideoId(candidate.videoId)) attempted.add(candidate.videoId);
  }
  for (const item of report.applied || []) {
    if (isValidVideoId(item.oldVideoId)) attempted.add(item.oldVideoId);
    if (isValidVideoId(item.newVideoId)) attempted.add(item.newVideoId);
  }
  return attempted;
}

function buildSecondPassQuery(song) {
  return `${song.title} ${song.artist} karaoke instrumental`.replace(/\s+/g, " ").trim();
}

function getApiKey() {
  if (!process.env.YOUTUBE_API_KEY?.trim()) throw new Error("YOUTUBE_API_KEY is missing; no search or API metadata request was made.");
  return process.env.YOUTUBE_API_KEY.trim();
}

function toNumberOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item) => walk(item, visit)); return; }
  visit(value);
  Object.values(value).forEach((child) => walk(child, visit));
}

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
function chunk(values, size) { return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size)); }

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`runtime audit exited with ${code ?? signal}`)));
  });
}

function parseArgs(argv) {
  const parsed = { command: argv.find((arg) => !arg.startsWith("-")), maxCandidates: DEFAULT_RUNTIME_CANDIDATES_PER_SONG, maxResults: SECOND_PASS_MAX_RESULTS, concurrency: 3, perSongTimeout: 45000, resume: false, secondPass: false, retryRateLimited: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--resume") parsed.resume = true;
    else if (arg === "--second-pass") parsed.secondPass = true;
    else if (arg === "--retry-rate-limited") parsed.retryRateLimited = true;
    else if (arg === "--mark-unavailable") parsed.markUnavailable = true;
    else if (arg === "--max-candidates") parsed.maxCandidates = positiveInt(argv[++index], arg, 1, 5);
    else if (arg === "--max-results") parsed.maxResults = positiveInt(argv[++index], arg, 5, 10);
    else if (arg === "--concurrency") parsed.concurrency = positiveInt(argv[++index], arg, 1, 3);
    else if (arg === "--per-song-timeout") parsed.perSongTimeout = positiveInt(argv[++index], arg, 35000, 120000);
    else if (arg.startsWith("-")) {
      if (!["--help", "-h", "--resume"].includes(arg)) continue;
    }
  }
  if (parsed.command && !["prepare", "test", "apply", "report", "repair"].includes(parsed.command)) throw new Error(`Unknown command "${parsed.command}".`);
  return parsed;
}

function positiveInt(value, option, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${option} must be an integer from ${minimum} to ${maximum}.`);
  return number;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The top-level command handling above is intentionally kept in this file so
  // importing the helper is unnecessary and cannot expose any credential.
}
