#!/usr/bin/env node

/**
 * Build a development-only playability-audit manifest.
 *
 * This is a metadata preflight, not a playback claim. The browser harness
 * records the only results that can establish iframe/player behavior.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DEFAULT_CATALOG_PATH = "data/songs.sample.json";
export const DEFAULT_VERIFICATION_PATH = "tools/youtube-verification.json";
export const DEFAULT_OUTPUT_PATH = "tools/youtube-full-playability-audit.json";
export const AUDIT_REPORT_VERSION = 1;
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const REPORT_PATHS = [
  "tools/coversph-top-50-report.json",
  "tools/coversph-expansion-100-report.json",
  "tools/atomic-karaoke-expansion-report.json",
  "tools/atomic-karaoke-expansion-100-report.json",
  "tools/karaokeytv-expansion-report.json",
  "tools/pro-music-cover-expansion-report.json",
  "tools/sing-king-top-50-candidates.json"
];

const PROVIDER_TAGS = [
  ["coversph", "CoversPH"],
  ["atomic-karaoke", "Atomic Karaoke"],
  ["karaokeytv", "KaraokeyTV"],
  ["pro-music-cover", "PRO Music COVER"],
  ["sing-king", "Sing King"]
];

export async function buildPlayabilityAudit({
  catalogPath = DEFAULT_CATALOG_PATH,
  verificationPath = DEFAULT_VERIFICATION_PATH,
  reportPaths = REPORT_PATHS,
  outputPath = DEFAULT_OUTPUT_PATH,
  generatedAt = new Date().toISOString()
} = {}) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!Array.isArray(catalog)) throw new Error("Catalog must be a top-level array.");

  const verification = await readJsonIfPresent(verificationPath, { records: [] });
  const evidence = await collectReportEvidence(reportPaths);
  const catalogHash = hashCatalog(catalog);
  const entries = catalog.map((song) => createEntry(song, verification.records, evidence));
  const report = {
    version: AUDIT_REPORT_VERSION,
    generatedAt,
    mode: "metadata-preflight-plus-local-iframe-audit",
    catalogPath,
    catalogCount: catalog.length,
    catalogHash,
    auditStatus: "PENDING_BROWSER_AUDIT",
    playbackWindowMs: 15000,
    scope: "Every current production catalog assignment; browser results are collected through the existing KantaCue YouTube controller.",
    limitations: [
      "Metadata/API evidence is a preflight only and does not prove iframe readiness or sustained playback.",
      "Browser autoplay policy, geographic availability, account state, and YouTube policy can affect an individual run.",
      "No media is downloaded or stored by this manifest or its harness."
    ],
    counts: summarizeEntries(entries),
    providerBreakdown: summarizeProviders(entries),
    entries
  };
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export function createEntry(song, verificationRecords = [], evidence = new Map()) {
  const videoId = typeof song?.youtubeVideoId === "string" ? song.youtubeVideoId.trim() : null;
  const record = findVerificationRecord(song, videoId, verificationRecords) || evidence.get(videoId) || {};
  const provider = inferProvider(song, record.channelTitle || record.channel || "");
  const songMetadataValid = typeof song?.id === "string" && typeof song?.title === "string" && typeof song?.artist === "string";
  const metadataValid = songMetadataValid && VIDEO_ID_PATTERN.test(videoId || "");
  const apiEmbeddable = record.embeddable === true ? true : record.embeddable === false ? false : null;
  return {
    songId: typeof song?.id === "string" ? song.id : "",
    title: typeof song?.title === "string" ? song.title : "",
    artist: typeof song?.artist === "string" ? song.artist : "",
    videoId,
    provider,
    channel: record.channelTitle || record.channel || null,
    metadataStatus: metadataValid ? "VALID" : songMetadataValid && !videoId ? "VALID_NO_VIDEO" : "INVALID",
    apiEmbeddable,
    madeForKids: typeof record.madeForKids === "boolean" ? record.madeForKids : null,
    definition: record.definition || null,
    publicViews: record.viewCount ?? record.publicViews ?? record.observedViews ?? null,
    iframeStatus: songMetadataValid && !videoId ? "UNAVAILABLE" : "UNTESTED",
    errorCode: null,
    failureClassification: null,
    replacementRequired: false,
    qualityStatus: "UNREVIEWED",
    note: "",
    testedAt: null
  };
}

export function summarizeEntries(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  return {
    total: rows.length,
    metadataValid: rows.filter((entry) => ["VALID", "VALID_NO_VIDEO"].includes(entry.metadataStatus)).length,
    apiEmbeddable: rows.filter((entry) => entry.apiEmbeddable === true).length,
    apiNotEmbeddable: rows.filter((entry) => entry.apiEmbeddable === false).length,
    playerReady: rows.filter((entry) => ["READY", "PLAYING", "PASS"].includes(entry.iframeStatus)).length,
    confirmedPlayable: rows.filter((entry) => entry.iframeStatus === "PASS").length,
    confirmedEmbeddingFailures: rows.filter((entry) => ["ERROR 101", "ERROR 150"].includes(entry.iframeStatus)).length,
    unavailable: rows.filter((entry) => ["UNAVAILABLE", "ERROR 100"].includes(entry.iframeStatus)).length,
    timeouts: rows.filter((entry) => entry.iframeStatus === "TIMEOUT").length,
    ambiguous: rows.filter((entry) => ["INCONCLUSIVE", "UNTESTED"].includes(entry.iframeStatus)).length,
    autoplayPolicyOnly: rows.filter((entry) => entry.iframeStatus === "AUTOPLAY POLICY ONLY").length,
    errors: rows.filter((entry) => /^ERROR /.test(entry.iframeStatus || "")).length
  };
}

export function summarizeProviders(entries) {
  const result = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const provider = entry.provider || "Other";
    result[provider] ||= { total: 0, pass: 0, confirmedBroken: 0, untested: 0 };
    result[provider].total += 1;
    if (entry.iframeStatus === "PASS") result[provider].pass += 1;
    if (["ERROR 100", "ERROR 101", "ERROR 150"].includes(entry.iframeStatus)) result[provider].confirmedBroken += 1;
    if (["UNTESTED", "INCONCLUSIVE", "TIMEOUT", "AUTOPLAY POLICY ONLY"].includes(entry.iframeStatus)) result[provider].untested += 1;
  }
  return result;
}

export function hashCatalog(catalog) {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

function findVerificationRecord(song, videoId, records) {
  return (Array.isArray(records) ? records : []).find((record) =>
    record?.candidateVideoId === videoId || (record?.songId === song?.id && record?.candidateVideoId === videoId)
  ) || null;
}

function inferProvider(song, channel) {
  const tags = Array.isArray(song?.tags) ? song.tags.map((tag) => String(tag).toLowerCase()) : [];
  for (const [tag, provider] of PROVIDER_TAGS) if (tags.includes(tag)) return provider;
  if (channel) return canonicalProvider(channel);
  return "Other";
}

function canonicalProvider(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized.includes("coversph")) return "CoversPH";
  if (normalized.includes("atomic karaoke")) return "Atomic Karaoke";
  if (normalized.includes("karaokeytv")) return "KaraokeyTV";
  if (normalized.includes("pro music cover")) return "PRO Music COVER";
  if (normalized.includes("sing king")) return "Sing King";
  return String(value).trim() || "Other";
}

async function collectReportEvidence(paths) {
  const evidence = new Map();
  for (const path of paths) {
    const report = await readJsonIfPresent(path, null);
    if (!report) continue;
    for (const row of discoverEvidenceRows(report)) {
      if (typeof row.videoId !== "string" || !VIDEO_ID_PATTERN.test(row.videoId)) continue;
      if (!evidence.has(row.videoId)) evidence.set(row.videoId, row);
    }
  }
  return evidence;
}

function discoverEvidenceRows(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) discoverEvidenceRows(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  if (typeof value.videoId === "string") result.push(value);
  for (const child of Object.values(value)) discoverEvidenceRows(child, result);
  return result;
}

async function readJsonIfPresent(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}

function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--output requires a value");
      options.output = value;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node tools/build-playability-audit.mjs [--output PATH]");
      console.log("Builds a metadata preflight manifest. It never calls YouTube or changes the catalog.");
    } else {
      const report = await buildPlayabilityAudit(options);
      console.log(`Built ${report.catalogCount}-song audit manifest at ${options.output}.`);
      console.log(`Metadata-valid: ${report.counts.metadataValid}; iframe tests pending: ${report.counts.ambiguous}.`);
    }
  } catch (error) {
    console.error(`playability audit manifest failed: ${error.message}`);
    process.exitCode = 1;
  }
}
