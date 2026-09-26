import { readFile } from "node:fs/promises";

export const COVERS_PH_REPORT_PATH = "tools/coversph-top-50-report.json";
export const CATALOG_PATH = "data/songs.sample.json";
export const COVERS_PH_CHANNEL = "CoversPH";

const TITLE_VARIANT_DUPLICATES = new Map([
  [34, "sample-020"]
]);

export function normalizeText(value) {
  return [...String(value ?? "").normalize("NFD")]
    .filter((character) => character.charCodeAt(0) < 768)
    .join("")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function compactText(value) {
  return normalizeText(value).replace(/ /g, "");
}

export function songKey(title, artist) {
  return `${normalizeText(title)}\u0000${normalizeText(artist)}`;
}

export function classifyCandidates(entries, catalog) {
  const bySongKey = new Map(catalog.map((song) => [songKey(song.title, song.artist), song]));
  const byVideoId = new Map(catalog.filter((song) => song.youtubeVideoId).map((song) => [song.youtubeVideoId, song]));
  const byCompactTitle = new Map(catalog.map((song) => [compactText(song.title), song]));

  return entries.map((entry) => {
    const exactSong = bySongKey.get(songKey(entry.title, entry.artist));
    const existingVideo = byVideoId.get(entry.videoId);
    const titleMatch = byCompactTitle.get(compactText(entry.title));
    const explicitVariant = TITLE_VARIANT_DUPLICATES.get(entry.rank);
    if (exactSong || existingVideo) {
      return {
        ...entry,
        decision: "SKIPPED — ALREADY EXISTS",
        matchedCatalogId: exactSong?.id || existingVideo?.id || null,
        reason: exactSong ? "Normalized title + artist already exists in KantaCue." : "The exact YouTube video ID is already promoted in KantaCue."
      };
    }
    if (explicitVariant && titleMatch?.id === explicitVariant) {
      return {
        ...entry,
        decision: "SKIPPED — DUPLICATE TITLE/ARTIST VARIANT",
        matchedCatalogId: titleMatch.id,
        reason: "The Popular entry is another artist/version of a song already represented; the working catalog entry was preserved."
      };
    }
    return {
      ...entry,
      decision: "PENDING MANUAL EMBED TEST",
      matchedCatalogId: null,
      reason: "No actual KantaCue iframe playback or manual audio/presentation review was performed; public channel metadata alone cannot prove onReady, sustained playback, or absence of YouTube embed errors."
    };
  });
}

export async function loadExpansionAudit({ reportPath = COVERS_PH_REPORT_PATH, catalogPath = CATALOG_PATH } = {}) {
  const [report, catalog] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile(catalogPath, "utf8").then(JSON.parse)
  ]);
  if (report?.source?.channel !== COVERS_PH_CHANNEL || report?.source?.channelHandle !== "@CoversPH") {
    throw new Error("The persisted report is not sourced from the official @CoversPH page.");
  }
  return { report, catalog, entries: classifyCandidates(report.entries || [], catalog) };
}

function printReport(entries) {
  console.log("RANK | SONG | ARTIST | VIDEO ID | VIEWS | DECISION");
  for (const entry of entries) {
    console.log(`${entry.rank} | ${entry.title} | ${entry.artist} | ${entry.videoId} | ${entry.publicViewsText || "—"} | ${entry.decision}`);
  }
  const counts = entries.reduce((result, entry) => {
    result[entry.decision] = (result[entry.decision] || 0) + 1;
    return result;
  }, {});
  console.log(JSON.stringify({ processed: entries.length, ...counts }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith("coversph-expansion.mjs")) {
  const audit = await loadExpansionAudit();
  if (process.argv[2] === "report") printReport(audit.entries);
}
