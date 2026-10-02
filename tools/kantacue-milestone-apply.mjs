#!/usr/bin/env node

/**
 * Applies the KantaCue milestone selection only after the real Chromium
 * runtime report has passed. This is deliberately separate from discovery and
 * never searches YouTube or changes existing records.
 */

import { createHash } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCatalog } from "../src/catalog.js";
import { normalizePart, songIdentityKey, CONTROL_ID, CONTROL_VIDEO_ID } from "./kantacue-milestone.mjs";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DEFAULT_CATALOG = "data/songs.sample.json";
export const DEFAULT_REPORT = "tools/kantacue-milestone-report.json";
export const DEFAULT_RUNTIME = "tools/kantacue-milestone.runtime.json";
export const TARGET_ADDITIONS = 108;

function readJson(file) { return readFile(path.resolve(ROOT, file), "utf8").then(JSON.parse); }
function hashCatalog(catalog) { return createHash("sha256").update(JSON.stringify(catalog)).digest("hex"); }
function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim().toLowerCase().replace(/,/g, "");
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/i);
  if (!match) return 0;
  return Math.round(Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2] || ""] || 1));
}

function scoreCandidate(candidate, baselineArtistCounts) {
  const metadata = candidate.metadata || {};
  const underrepresentedEra = new Set(["1960s", "1970s", "1980s", "2010s", "2020s"]).has(metadata.era);
  const diversityBonus = metadata.performanceType === "duet" ? 3 : metadata.performanceType === "group" ? 2 : 0;
  const languageBonus = metadata.language === "English" ? 1.5 : 0;
  const eraBonus = underrepresentedEra ? 1.5 : 0;
  const existingArtistPenalty = Math.min(3, baselineArtistCounts.get(normalizePart(candidate.artist)) || 0) * 0.35;
  return Math.log10(numberValue(candidate.publicViews) + 1) * 10 + languageBonus + eraBonus + diversityBonus - existingArtistPenalty;
}

function safeMetadata(candidate) {
  const metadata = candidate.metadata || {};
  const allowed = (value, values, fallback) => values.has(value) ? value : fallback;
  return {
    language: metadata.language,
    genre: metadata.genre,
    era: metadata.era,
    mood: Array.isArray(metadata.mood) && metadata.mood.length ? metadata.mood : ["feel-good"],
    difficulty: allowed(metadata.difficulty, new Set(["easy", "medium", "hard"]), "medium"),
    vocalRange: allowed(metadata.vocalRange, new Set(["low", "medium", "high"]), "medium"),
    performanceType: allowed(metadata.performanceType, new Set(["solo", "duet", "group"]), "solo"),
    tags: [...new Set([...(Array.isArray(metadata.tags) ? metadata.tags : []), metadata.language === "Filipino" ? "opm" : "international", "popular", String(candidate.provider || "").toLowerCase().replace(/\s+/g, "-")])]
  };
}

export function chooseSelection(candidates, catalog, maxAdditions = TARGET_ADDITIONS) {
  const baselineArtists = new Map();
  for (const song of catalog) {
    const key = normalizePart(song.artist);
    baselineArtists.set(key, (baselineArtists.get(key) || 0) + 1);
  }
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, baselineArtists) }))
    .sort((a, b) => b.score - a.score || numberValue(b.candidate.publicViews) - numberValue(a.candidate.publicViews) || a.candidate.title.localeCompare(b.candidate.title));
  const selected = [];
  const deliberatelyRejected = [];
  const artistCounts = new Map();
  const providerCounts = new Map();
  const addRound = (limit, relaxed = false) => {
    let changed = false;
    for (const item of ranked) {
      if (selected.includes(item)) continue;
      const key = normalizePart(item.candidate.artist);
      const count = artistCounts.get(key) || 0;
      if (!relaxed && count >= limit) continue;
      const provider = item.candidate.provider || "unknown";
      const providerCount = providerCounts.get(provider) || 0;
      const providerCap = provider === "Atomic Karaoke" ? Math.floor(maxAdditions * 0.78) : maxAdditions;
      if (!relaxed && providerCount >= providerCap) continue;
      artistCounts.set(key, count + 1);
      providerCounts.set(provider, providerCount + 1);
      selected.push(item);
      changed = true;
      if (selected.length >= maxAdditions) break;
    }
    return changed;
  };
  addRound(3);
  if (selected.length < maxAdditions) addRound(4, true);
  if (selected.length < maxAdditions) addRound(Number.MAX_SAFE_INTEGER, true);
  const selectedKeys = new Set(selected.map((item) => item.candidate.videoId));
  for (const item of ranked) if (!selectedKeys.has(item.candidate.videoId)) deliberatelyRejected.push({ ...item.candidate, selectionScore: item.score, reason: "runtime PASS but outside the curated 108-song selection" });
  return { selected, deliberatelyRejected, artistCounts, providerCounts };
}

async function writeJsonAtomic(file, value) {
  const target = path.resolve(ROOT, file);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temporary, target); return; } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 6) { await unlink(temporary).catch(() => {}); throw error; }
      await new Promise((resolve) => setTimeout(resolve, 40 * (2 ** attempt)));
    }
  }
}

export function validateRuntimeEvidence(report, runtime, catalog) {
  if (hashCatalog(catalog) !== report.catalogHash) throw new Error("Catalog changed after milestone preparation; refusing to apply.");
  const control = runtime.entries?.find((entry) => entry.songId === CONTROL_ID || entry.videoId === CONTROL_VIDEO_ID);
  if (!control || control.videoId !== CONTROL_VIDEO_ID || control.iframeStatus !== "PASS") throw new Error("Runtime control gate failed: sample-029 / QBb9wO3Bj0k did not PASS.");
  const runtimeByVideo = new Map((runtime.entries || []).map((entry) => [entry.videoId, entry]));
  const candidates = report.runtimeCandidates || [];
  for (const candidate of candidates) {
    const result = runtimeByVideo.get(candidate.videoId);
    if (!result) throw new Error(`Runtime result is missing for candidate ${candidate.videoId}.`);
    if (result.iframeStatus === "PASS" && result.videoId !== candidate.videoId) throw new Error(`Runtime/video mismatch for ${candidate.videoId}.`);
  }
  return runtimeByVideo;
}

export async function applyMilestone({ catalogFile = DEFAULT_CATALOG, reportFile = DEFAULT_REPORT, runtimeFile = DEFAULT_RUNTIME, maxAdditions = TARGET_ADDITIONS, dryRun = false } = {}) {
  const catalog = await readJson(catalogFile);
  const report = await readJson(reportFile);
  const runtime = await readJson(runtimeFile);
  const runtimeByVideo = validateRuntimeEvidence(report, runtime, catalog);
  const existingIdentities = new Set(catalog.map((song) => songIdentityKey(song.title, song.artist)));
  const existingVideos = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  const passed = (report.runtimeCandidates || []).filter((candidate) => runtimeByVideo.get(candidate.videoId)?.iframeStatus === "PASS");
  const selection = chooseSelection(passed, catalog, Math.min(TARGET_ADDITIONS, Math.max(0, Number(maxAdditions) || TARGET_ADDITIONS)));
  const additions = [];
  let nextNumber = Math.max(0, ...catalog.map((song) => Number(String(song.id).match(/(\d+)$/)?.[1] || 0))) + 1;
  for (const { candidate, score } of selection.selected) {
    const identity = songIdentityKey(candidate.title, candidate.artist);
    if (existingIdentities.has(identity) || existingVideos.has(candidate.videoId)) continue;
    const song = { id: `sample-${String(nextNumber++).padStart(3, "0")}`, title: candidate.title, artist: candidate.artist, ...safeMetadata(candidate), demandTier: null, youtubeVideoId: candidate.videoId };
    additions.push(song);
    existingIdentities.add(identity);
    existingVideos.add(candidate.videoId);
    candidate.selectionScore = score;
    candidate.selectedStatus = "ADDED";
    candidate.runtimeStatus = "PASS";
  }
  const normalized = normalizeCatalog([...catalog, ...additions], { logger: { warn() {} } });
  if (normalized.songs.length !== catalog.length + additions.length) throw new Error("Catalog validation rejected one or more milestone additions.");
  if (!dryRun) await writeJsonAtomic(catalogFile, [...catalog, ...additions]);
  report.status = dryRun ? "DRY_RUN_READY" : "APPLIED";
  report.catalogAfter = catalog.length + additions.length;
  report.added = additions.map((song) => ({ id: song.id, title: song.title, artist: song.artist, videoId: song.youtubeVideoId }));
  report.runtime = { control: "PASS", candidatesTested: report.runtimeCandidates?.length || 0, candidatePass: passed.length, selected: selection.selected.length, added: additions.length, errors: (runtime.entries || []).filter((entry) => /^ERROR /.test(entry.iframeStatus || "")).length, inconclusive: (runtime.entries || []).filter((entry) => entry.iframeStatus === "INCONCLUSIVE").length };
  report.finalSelection = { selected: selection.selected.map(({ candidate, score }) => ({ ...candidate, selectionScore: score })), runtimePassRejected: selection.deliberatelyRejected, artistCounts: Object.fromEntries(selection.artistCounts), providerCounts: Object.fromEntries(selection.providerCounts) };
  report.summary = { ...(report.summary || {}), runtimePass: passed.length, added: additions.length, runtimeErrors: report.runtime.errors, runtimeInconclusive: report.runtime.inconclusive };
  await writeJsonAtomic(reportFile, report);
  return { catalogBefore: catalog.length, catalogAfter: catalog.length + additions.length, additions, passed: passed.length, runtime, report, selection };
}

async function main() {
  const values = process.argv.slice(2);
  const get = (flag, fallback) => values.includes(flag) ? values[values.indexOf(flag) + 1] : fallback;
  const result = await applyMilestone({ catalogFile: get("--catalog", DEFAULT_CATALOG), reportFile: get("--report", DEFAULT_REPORT), runtimeFile: get("--runtime", DEFAULT_RUNTIME), maxAdditions: get("--max-additions", TARGET_ADDITIONS), dryRun: values.includes("--dry-run") });
  console.log(`${values.includes("--dry-run") ? "Dry run" : "Applied"}: ${result.additions.length} additions; candidate PASS ${result.passed}; catalog ${result.catalogBefore} -> ${result.catalogAfter}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`KantaCue milestone apply failed: ${error.message || error}`); process.exitCode = 1; });
}
