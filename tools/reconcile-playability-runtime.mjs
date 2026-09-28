#!/usr/bin/env node

/**
 * Reconcile a prior full browser audit after confirmed Error 150 assignments
 * have been safely nulled. This never calls YouTube and refuses to write if a
 * retained catalog assignment does not still match a prior PASS result.
 */

import { readFile, writeFile } from "node:fs/promises";
import { hashCatalog, summarizeEntries, summarizeProviders } from "./build-playability-audit.mjs";

export function reconcileRuntimeReport(catalog, priorReport, repairReport, { generatedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(catalog)) throw new Error("Catalog must be an array.");
  if (!Array.isArray(priorReport?.entries)) throw new Error("Prior runtime report must contain entries.");
  if (!Array.isArray(repairReport?.unavailable)) throw new Error("Repair report must contain unavailable records.");

  const priorBySong = new Map(priorReport.entries.map((entry) => [entry.songId, entry]));
  const unavailableBySong = new Map(repairReport.unavailable.map((entry) => [entry.songId, entry]));
  const entries = catalog.map((song) => {
    const prior = priorBySong.get(song.id);
    if (!prior) throw new Error(`Missing prior runtime result for ${song.id}.`);

    if (!song.youtubeVideoId) {
      const unavailable = unavailableBySong.get(song.id);
      if (!unavailable || prior.iframeStatus !== "ERROR 150") {
        throw new Error(`Refusing to reconcile ${song.id}: it was not both confirmed Error 150 and explicitly marked unavailable.`);
      }
      return {
        ...prior,
        title: song.title,
        artist: song.artist,
        videoId: null,
        metadataStatus: "VALID_NO_VIDEO",
        apiEmbeddable: null,
        madeForKids: null,
        iframeStatus: "UNAVAILABLE",
        errorCode: null,
        failureClassification: "UNAVAILABLE",
        replacementRequired: true,
        qualityStatus: "UNAVAILABLE",
        note: unavailable.reason,
        reconciledAt: generatedAt
      };
    }

    if (prior.videoId !== song.youtubeVideoId || prior.iframeStatus !== "PASS") {
      throw new Error(`Refusing to reconcile ${song.id}: retained assignment does not match a prior runtime PASS.`);
    }
    return { ...prior, title: song.title, artist: song.artist, videoId: song.youtubeVideoId };
  });

  return {
    ...priorReport,
    generatedAt,
    mode: "reconciled-after-confirmed-error-150-unavailability",
    auditStatus: "RECONCILED_FROM_CONFIRMED_RUNTIME_AUDIT",
    catalogCount: catalog.length,
    catalogHash: hashCatalog(catalog),
    sourceRepairReport: "tools/youtube-embed-repair.json",
    counts: summarizeEntries(entries),
    providerBreakdown: summarizeProviders(entries),
    entries
  };
}

async function main() {
  const [catalogPath = "data/songs.sample.json", priorPath = "tools/youtube-full-playability-audit.runtime.json", repairPath = "tools/youtube-embed-repair.json", outputPath = priorPath] = process.argv.slice(2);
  const [catalog, prior, repair] = await Promise.all([
    readJson(catalogPath),
    readJson(priorPath),
    readJson(repairPath)
  ]);
  const report = reconcileRuntimeReport(catalog, prior, repair);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Reconciled ${report.catalogCount}-song runtime report: ${report.counts.confirmedPlayable} PASS, ${report.counts.unavailable} unavailable.`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1]?.endsWith("reconcile-playability-runtime.mjs")) {
  main().catch((error) => {
    console.error(`runtime report reconciliation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
