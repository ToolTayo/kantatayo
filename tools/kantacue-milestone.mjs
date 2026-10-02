#!/usr/bin/env node

/**
 * Builds the KantaCue 1,000-song milestone pool from already-persisted,
 * development-only provider reports. It never searches YouTube and never
 * promotes a record; the existing Chromium audit and expansion apply command
 * remain the only runtime/promotion path.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DEFAULT_CATALOG = "data/songs.sample.json";
export const DEFAULT_REPORT = "tools/kantacue-milestone-report.json";
export const DEFAULT_MANIFEST = "tools/kantacue-milestone.runtime-manifest.json";
export const MAX_RUNTIME_POOL = 400;
export const TARGET_ADDITIONS = 108;
export const CONTROL_ID = "sample-029";
export const CONTROL_VIDEO_ID = "QBb9wO3Bj0k";
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const HISTORICAL_EXCLUSIONS = new Map([
  [songIdentityKey("TUNAY NA NAGMAMAHAL", "J Brothers"), "previous catalog quality review exclusion"]
]);

const HARD_NEGATIVES = /\b(?:medley|mashup|compilation|live|concert|tutorial|reaction|shorts?|official\s+music\s+video|acoustic|unplugged|remix|guide\s+(?:vocal|melody)|with\s+(?:guide\s+)?vocals?|lower\s+key|higher\s+key|altered\s+key|part\s*[1-9])\b/i;
const KARAOKE_WORDING = /\b(?:karaoke|instrumental|backing\s+track|minus\s+one|sing\s+along)\b/i;
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const VALID_RANGES = new Set(["low", "medium", "high"]);
const VALID_PERFORMANCE = new Set(["solo", "duet", "group"]);

const SOURCE_FILES = Object.freeze({
  covers: "tools/coversph-expansion-100-report.json",
  atomic: "tools/atomic-karaoke-expansion-100-report.json",
  batch3: "tools/kantacue-batch3-report.json",
  batch3Runtime: "tools/kantacue-batch3.runtime.json",
  karaokeRuntimeReport: "tools/karaokeytv-expansion-100-runtime-report.json",
  karaokeRuntime: "tools/karaokeytv-expansion-100-runtime.json",
  oldReport: "tools/kantacue-expansion-100-report.json",
  oldRuntime: "tools/kantacue-expansion-100.runtime.json"
});

function readJson(file) {
  return readFile(path.resolve(ROOT, file), "utf8").then(JSON.parse);
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim().toLowerCase().replace(/,/g, "");
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/i);
  if (!match) return 0;
  return Math.round(Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2] || ""] || 1));
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizePart(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:feat\.?|ft\.?)\b/g, " featuring ")
    .replace(/\b(?:karaoke|instrumental|backing\s+track|minus\s+one|original\s+key|lyrics?|hd)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function songIdentityKey(title, artist) {
  return `${normalizePart(title)}\u0000${normalizePart(artist)}`;
}

function catalogHash(catalog) {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

function list(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().toLowerCase())
    : [];
}

function validMetadata(value) {
  return value && typeof value === "object" && typeof value.language === "string" && typeof value.genre === "string" &&
    typeof value.era === "string" && list(value.mood).length > 0 && VALID_DIFFICULTIES.has(value.difficulty) &&
    VALID_RANGES.has(value.vocalRange) && VALID_PERFORMANCE.has(value.performanceType);
}

function profileMap(catalog) {
  const profiles = new Map();
  for (const song of catalog) {
    const key = normalizePart(song.artist);
    if (!key) continue;
    const profile = profiles.get(key) || { fields: {}, count: 0 };
    profile.count += 1;
    for (const field of ["language", "genre", "era", "difficulty", "vocalRange", "performanceType"]) {
      const value = song[field];
      if (typeof value === "string" && value.trim()) profile.fields[field] ||= new Map();
      if (typeof value === "string" && value.trim()) profile.fields[field].set(value, (profile.fields[field].get(value) || 0) + 1);
    }
    profiles.set(key, profile);
  }
  return profiles;
}

function mostCommon(profile, field, fallback) {
  const values = profile?.fields?.[field];
  if (!values?.size) return fallback;
  return [...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

const ERA_BY_ARTIST = new Map([
  ["the beatles", "1960s"], ["elvis presley", "1960s"], ["connie francis", "1960s"],
  ["bee gees", "1970s"], ["bread", "1970s"], ["abba", "1970s"], ["elton john", "1970s"],
  ["dr hook", "1970s"], ["paul anka", "1960s"], ["the real thing", "1970s"],
  ["michael jackson", "1980s"], ["ken laszlo", "1980s"], ["karyn white", "1980s"],
  ["bonnie tyler", "1980s"], ["barry manilow", "1970s"], ["crowded house", "1980s"],
  ["celine dion", "1990s"], ["leann rimes", "1990s"], ["whitney houston", "1990s"],
  ["backstreet boys", "1990s"], ["the cranberries", "1990s"], ["maroon 5", "2000s"],
  ["ellie goulding", "2010s"], ["billie eilish", "2010s"], ["lady gaga", "2000s"],
  ["rihanna", "2000s"], ["john legend", "2010s"], ["ed sheeran", "2010s"]
]);

const FILIPINO_TITLE_WORDS = /\b(?:ang|aking|ako|bakit|bato|bukas|buhay|dahan|dahil|gabi|halik|ikaw|kita|ko|kapayapaan|kailangan|kung|lang|langit|laban|mahal|mga|mo|na\s+ba|nang|ng|ngiti|pag|pagibig|pag-ibig|paano|pangako|para|puso|sana|sa|sakit|sila|sino|tayo|tuloy|wala)\b/i;
const GENRE_WORDS = [
  ["Rock", /\b(?:rock|zombie|bohemian|flame|firehouse|steelheart|sublime)\b/i],
  ["R&B", /\b(?:r&b|soul|superwoman|two\s+of\s+us)\b/i],
  ["Country", /\b(?:country|cowboy|garth|kenny\s+rogers)\b/i],
  ["Disco", /\b(?:disco|dance|tonight|gimme)\b/i],
  ["Ballad", /\b(?:love|heart|forever|goodbye|missing|alone|dream|crying|remember)\b/i]
];

function inferMetadata(raw, catalog, profiles, provider) {
  if (validMetadata(raw.metadata)) return {
    language: raw.metadata.language.trim(), genre: raw.metadata.genre.trim(), era: raw.metadata.era.trim(),
    mood: list(raw.metadata.mood), difficulty: raw.metadata.difficulty, vocalRange: raw.metadata.vocalRange,
    performanceType: raw.metadata.performanceType, tags: list(raw.metadata.tags)
  };
  const title = cleanText(raw.title || raw.song);
  const artist = cleanText(raw.artist);
  const text = `${title} ${artist}`;
  const profile = profiles.get(normalizePart(artist));
  const language = profile ? mostCommon(profile, "language", "English") : (FILIPINO_TITLE_WORDS.test(title) ? "Filipino" : "English");
  const profileGenre = profile ? mostCommon(profile, "genre", "") : "";
  const genre = profileGenre || GENRE_WORDS.find(([, pattern]) => pattern.test(text))?.[0] || "Pop";
  const era = profile ? mostCommon(profile, "era", "") : "";
    const resolvedEra = era || ERA_BY_ARTIST.get(normalizePart(artist)) || "2000s";
  const mood = profile ? [mostCommon(profile, "mood", "")] : [];
  const resolvedMood = mood.filter(Boolean).length ? mood.filter(Boolean) : [/\b(?:love|heart|forever|kiss|goodbye)\b/i.test(text) ? "love" : "feel-good"];
  const performanceType = /(?:&|\band\b|\bwith\b|\bduet\b|\bfeat\.?\b|\bft\.?\b)/i.test(artist) ? "duet" : "solo";
  const tags = [language === "Filipino" ? "opm" : "international", "popular", provider.toLowerCase().replace(/\s+/g, "-")];
  if (resolvedEra === "1970s" || resolvedEra === "1980s" || resolvedEra === "1990s") tags.push("classics");
  return { language, genre, era: resolvedEra, mood: resolvedMood, difficulty: mostCommon(profile, "difficulty", "medium"), vocalRange: mostCommon(profile, "vocalRange", "medium"), performanceType, tags: [...new Set(tags)] };
}

export function classifyRawCandidate(raw, catalog, profiles, provider, options = {}) {
  const title = cleanText(raw.title || raw.song);
  const artist = cleanText(raw.artist);
  const videoId = cleanText(raw.videoId);
  const sourceTitle = cleanText(raw.videoTitle || raw.sourceTitle);
  const reasons = [];
  if (!title || !artist) reasons.push("metadata incomplete");
  if (!VIDEO_ID_PATTERN.test(videoId)) reasons.push("invalid YouTube video ID");
  if (!KARAOKE_WORDING.test(sourceTitle)) reasons.push("karaoke wording is not explicit");
  if (HARD_NEGATIVES.test(sourceTitle) || HARD_NEGATIVES.test(`${title} ${artist}`)) reasons.push("unsuitable version wording");
  if (/\b(?:karaoke|instrumental|full\s+version|lower\s*key|higher\s*key|version|cover)\b/i.test(title)) reasons.push("song title contains version/provider wording");
  if (/\b(?:karaoke|instrumental|full\s+version|lower\s*key|higher\s*key|version|cover)\b/i.test(artist)) reasons.push("artist metadata contains version/provider wording");
  if (artist.toLowerCase().includes("party tyme")) reasons.push("Party Tyme is excluded");
  if (options.requireTechnicalEvidence && (raw.embeddable !== true || raw.madeForKids !== false || raw.definition !== "hd")) reasons.push("technical preflight evidence is incomplete");
  const identity = songIdentityKey(title, artist);
  if (HISTORICAL_EXCLUSIONS.has(identity)) reasons.push(HISTORICAL_EXCLUSIONS.get(identity));
  return { title, artist, videoId, sourceTitle, reasons, identity, metadata: inferMetadata({ ...raw, title, artist }, catalog, profiles, provider) };
}

function makeCandidate(raw, provider, catalog, profiles, options = {}) {
  const classified = classifyRawCandidate(raw, catalog, profiles, provider, options);
  if (classified.reasons.length) return { candidate: null, rejected: { ...classified, provider } };
  return {
    candidate: {
      provider,
      channel: cleanText(raw.channel || raw.channelTitle || provider),
      sourceChannelId: raw.sourceChannelId || raw.channelId || null,
      title: classified.title,
      artist: classified.artist,
      videoId: classified.videoId,
      videoTitle: classified.sourceTitle || null,
      publicViews: raw.publicViews ?? raw.publicViewCount ?? raw.observedViews ?? raw.viewCount ?? null,
      publishedAt: raw.publishedAt || null,
      definition: raw.definition || null,
      embeddable: raw.embeddable,
      madeForKids: raw.madeForKids,
      duration: raw.duration || null,
      metadata: classified.metadata,
      identityKey: classified.identity,
      sourceRank: raw.playlistPosition || raw.sourceRank || raw.rank || null,
      runtimeStatus: options.runtimeStatus || "UNTESTED",
      runtimeEvidence: options.runtimeEvidence || null,
      selectedStatus: "CANDIDATE",
      popularityScore: Math.log10(numberValue(raw.publicViews ?? raw.publicViewCount ?? raw.observedViews ?? raw.viewCount) + 1) * 10 + (classified.metadata.language === "Filipino" ? 4 : 0)
    }
  };
}

function reportEntries(report) {
  if (Array.isArray(report?.all)) return report.all;
  if (Array.isArray(report?.entries)) return report.entries;
  return [];
}

async function readIfPresent(file) {
  return existsSync(path.resolve(ROOT, file)) ? readJson(file) : null;
}

function runtimeMap(runtime) {
  return new Map((runtime?.entries || []).map((entry) => [entry.videoId, entry]));
}

function addDeduped(target, seenIdentities, seenVideos, candidate, catalogIdentities, catalogVideos) {
  if (!candidate || catalogIdentities.has(candidate.identityKey) || catalogVideos.has(candidate.videoId)) return false;
  if (seenIdentities.has(candidate.identityKey) || seenVideos.has(candidate.videoId)) return false;
  seenIdentities.add(candidate.identityKey);
  seenVideos.add(candidate.videoId);
  target.push(candidate);
  return true;
}

export async function buildMilestonePool({ catalog, maxRuntimePool = MAX_RUNTIME_POOL } = {}) {
  const songs = catalog || await readJson(DEFAULT_CATALOG);
  const profiles = profileMap(songs);
  const catalogIdentities = new Set(songs.map((song) => songIdentityKey(song.title, song.artist)));
  const catalogVideos = new Set(songs.map((song) => song.youtubeVideoId).filter(Boolean));
  const seenIdentities = new Set();
  const seenVideos = new Set();
  const candidates = [];
  const rejected = [];
  const runtimeReuse = [];

  const priorSources = [
    [SOURCE_FILES.batch3, SOURCE_FILES.batch3Runtime],
    [SOURCE_FILES.oldReport, SOURCE_FILES.oldRuntime],
    [SOURCE_FILES.karaokeRuntimeReport, SOURCE_FILES.karaokeRuntime]
  ];
  for (const [reportFile, runtimeFile] of priorSources) {
    const report = await readIfPresent(reportFile);
    const runtime = await readIfPresent(runtimeFile);
    if (!report || !runtime) continue;
    const byVideo = runtimeMap(runtime);
    const priorEntries = Array.isArray(report.runtimeCandidates) && report.runtimeCandidates.length ? report.runtimeCandidates : reportEntries(report);
    for (const raw of priorEntries) {
      const result = byVideo.get(raw.videoId);
      if (result?.iframeStatus !== "PASS") continue;
      const provider = raw.provider || report.source?.channel || "Persisted provider";
      const { candidate, rejected: rejectedEntry } = makeCandidate(raw, provider, songs, profiles, {
        requireTechnicalEvidence: true,
        runtimeStatus: "PASS",
        runtimeEvidence: `${reportFile} + ${runtimeFile}`
      });
      if (rejectedEntry) { rejected.push({ ...rejectedEntry, reason: "prior PASS metadata did not survive current safety checks" }); continue; }
      if (addDeduped(candidates, seenIdentities, seenVideos, candidate, catalogIdentities, catalogVideos)) runtimeReuse.push(candidate.videoId);
    }
  }

  const covers = await readIfPresent(SOURCE_FILES.covers);
  for (const raw of reportEntries(covers)) {
    if (raw.decision !== "NEW CANDIDATE") continue;
    const { candidate, rejected: rejectedEntry } = makeCandidate(raw, "CoversPH", songs, profiles, { requireTechnicalEvidence: true });
    if (rejectedEntry) rejected.push({ ...rejectedEntry, reason: "CoversPH preflight rejection" });
    else addDeduped(candidates, seenIdentities, seenVideos, candidate, catalogIdentities, catalogVideos);
  }

  const atomic = await readIfPresent(SOURCE_FILES.atomic);
  for (const raw of reportEntries(atomic)) {
    if (!["NEW CANDIDATE", "REJECT — not confidently OPM"].includes(raw.decision)) continue;
    const { candidate, rejected: rejectedEntry } = makeCandidate(raw, "Atomic Karaoke", songs, profiles, { requireTechnicalEvidence: true });
    if (rejectedEntry) rejected.push({ ...rejectedEntry, reason: "Atomic Karaoke re-evaluation rejection" });
    else addDeduped(candidates, seenIdentities, seenVideos, candidate, catalogIdentities, catalogVideos);
  }

  const sorted = candidates.sort((a, b) => {
    const aReuse = a.runtimeStatus === "PASS" ? 1 : 0;
    const bReuse = b.runtimeStatus === "PASS" ? 1 : 0;
    return bReuse - aReuse || b.popularityScore - a.popularityScore || numberValue(b.publicViews) - numberValue(a.publicViews) || a.title.localeCompare(b.title);
  });
  const pool = sorted.slice(0, Math.max(250, Math.min(MAX_RUNTIME_POOL, Number(maxRuntimePool) || MAX_RUNTIME_POOL)));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    status: "CANDIDATES_READY",
    catalogBefore: songs.length,
    catalogHash: catalogHash(songs),
    targetAdditions: TARGET_ADDITIONS,
    discoveryPoolTarget: 500,
    sourceReports: [SOURCE_FILES.covers, SOURCE_FILES.atomic, SOURCE_FILES.batch3, SOURCE_FILES.karaokeRuntimeReport, SOURCE_FILES.oldReport].filter((file) => existsSync(path.resolve(ROOT, file))),
    selectionMethod: "Persisted public-provider reports, exact prior runtime PASS reuse by video ID, global normalized identity/video dedupe, strict karaoke/API preflight gates, and popularity evidence. New records require the existing Chromium 15-second iframe PASS before promotion.",
    summary: {
      candidatesInspected: reportEntries(covers).length + reportEntries(atomic).length,
      uniqueCandidates: sorted.length,
      runtimeReuse: runtimeReuse.length,
      atomicInternationalReevaluated: reportEntries(atomic).filter((entry) => entry.decision === "REJECT — not confidently OPM").length,
      rejected: rejected.length,
      historicalExclusions: rejected.filter((entry) => entry.reasons?.some((reason) => /quality review exclusion/i.test(reason))).length,
      singKingPending: 29
    },
    entries: [...sorted, ...rejected.slice(0, 200).map((entry) => ({ ...entry, decision: "REJECTED_PREFILTER", rejectionReasons: entry.reasons }))],
    runtimeCandidates: pool.map((entry, index) => ({ ...entry, poolRank: index + 1 }))
  };
}

export function buildRuntimeManifest(report, catalog) {
  const control = catalog.find((song) => song.id === CONTROL_ID);
  if (!control || control.youtubeVideoId !== CONTROL_VIDEO_ID) throw new Error("The sample-029 runtime control is missing or changed.");
  const entries = [{ songId: control.id, title: control.title, artist: control.artist, videoId: control.youtubeVideoId, provider: "CoversPH", metadataStatus: "VALID", apiEmbeddable: true, madeForKids: false, iframeStatus: "UNTESTED", note: "Known-good control gate." }];
  report.runtimeCandidates.forEach((candidate, index) => entries.push({
    songId: `kantacue-milestone-candidate-${String(index + 1).padStart(3, "0")}`,
    title: candidate.title,
    artist: candidate.artist,
    videoId: candidate.videoId,
    provider: candidate.provider,
    channel: candidate.channel,
    metadataStatus: "VALID",
    apiEmbeddable: candidate.embeddable,
    madeForKids: candidate.madeForKids,
    definition: candidate.definition,
    publicViews: candidate.publicViews,
    iframeStatus: candidate.runtimeStatus === "PASS" ? "PASS" : "UNTESTED",
    errorCode: null,
    failureClassification: null,
    qualityStatus: candidate.runtimeStatus === "PASS" ? "RUNTIME_PASS_REUSED" : "PREFILTERED",
    runtimeEvidence: candidate.runtimeEvidence,
    testedAt: null
  }));
  return { version: 1, generatedAt: new Date().toISOString(), mode: "kantacue-1000-milestone", catalogCount: catalog.length, catalogHash: report.catalogHash, playbackWindowMs: 15000, controlSongId: CONTROL_ID, entries };
}

async function main() {
  const reportPath = process.argv.includes("--report") ? process.argv[process.argv.indexOf("--report") + 1] : DEFAULT_REPORT;
  const manifestPath = process.argv.includes("--manifest") ? process.argv[process.argv.indexOf("--manifest") + 1] : DEFAULT_MANIFEST;
  const poolSize = process.argv.includes("--pool-size") ? Number(process.argv[process.argv.indexOf("--pool-size") + 1]) : MAX_RUNTIME_POOL;
  const catalog = await readJson(DEFAULT_CATALOG);
  const report = await buildMilestonePool({ catalog, maxRuntimePool: poolSize });
  const manifest = buildRuntimeManifest(report, catalog);
  await writeFile(path.resolve(ROOT, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.resolve(ROOT, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Prepared ${report.runtimeCandidates.length} runtime candidates from ${report.summary.candidatesInspected} persisted records.`);
  console.log(`Reusing ${report.summary.runtimeReuse} exact prior PASS results; new candidates require the real Chromium audit.`);
  console.log(`Report: ${reportPath}`);
  console.log(`Manifest: ${manifestPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`KantaCue milestone preparation failed: ${error.message || error}`); process.exitCode = 1; });
}
