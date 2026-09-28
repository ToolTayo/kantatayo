#!/usr/bin/env node

/**
 * Development-only CoversPH catalog expansion audit.
 *
 * Normal mode reads only the official CoversPH uploads and public YouTube
 * metadata, then writes an auditable candidate report. It never changes the
 * public catalog. --apply is a separate, guarded mutation step.
 */

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "./verify-youtube.mjs";

const CHANNEL_ID = "UCaPwSXblS8F0owlKHGc6huw";
const CHANNEL_HANDLE = "@CoversPH";
const CHANNEL_NAME = "CoversPH";
const UPLOADS_PLAYLIST_ID = "UUaPwSXblS8F0owlKHGc6huw";
const CATALOG_PATH = "data/songs.sample.json";
const REPORT_PATH = "tools/coversph-expansion-100-report.json";
const API_ROOT = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TARGET = 100;

function apiKey() {
  const value = process.env.YOUTUBE_API_KEY;
  if (!value?.trim()) throw new Error("YOUTUBE_API_KEY is missing; keep it local and never print it.");
  return value.trim();
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function songKey(title, artist) {
  return `${normalizeText(title).replace(/ /g, "")}\u0000${normalizeText(artist).replace(/ /g, "")}`;
}

function compactTitle(value) {
  return normalizeText(value).replace(/ /g, "");
}

function videoIdsInOrder(items) {
  return [...new Set(items.map((item) => item?.contentDetails?.videoId).filter((id) => YOUTUBE_ID.test(id)))];
}

async function getJson(url) {
  const response = await fetch(url);
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const reason = payload?.error?.errors?.[0]?.reason || `HTTP ${response.status}`;
    throw new Error(`YouTube API request failed: ${reason}`);
  }
  return payload;
}

async function listUploads(key) {
  const items = [];
  let pageToken = "";
  while (true) {
    const url = new URL(`${API_ROOT}/playlistItems`);
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("playlistId", UPLOADS_PLAYLIST_ID);
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("key", key);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await getJson(url);
    items.push(...(payload.items || []));
    pageToken = payload.nextPageToken || "";
    if (!pageToken) break;
  }
  return items;
}

async function getVideoDetails(ids, key) {
  const details = new Map();
  for (let index = 0; index < ids.length; index += 50) {
    const url = new URL(`${API_ROOT}/videos`);
    url.searchParams.set("part", "snippet,status,statistics,contentDetails");
    url.searchParams.set("id", ids.slice(index, index + 50).join(","));
    url.searchParams.set("key", key);
    const payload = await getJson(url);
    for (const item of payload.items || []) details.set(item.id, item);
  }
  return details;
}

function stripMetadataSuffix(value) {
  let result = String(value || "").replace(/\s+/g, " ").trim();
  result = result.replace(/(?:\s+#[a-z0-9_-]+)+\s*$/i, "").trim();
  for (let attempt = 0; attempt < 6; attempt += 1) result = result.replace(/\s*(?:\([^)]*\)|\[[^\]]*\])\s*$/i, "").trim();
  result = result
    .replace(/\s*[-–—]\s*(?:HD|HQ)?\s*(?:KARAOKE|INSTRUMENTAL|MINUS ONE|LYRICS)(?:\s+VERSION)?\s*$/i, "")
    .replace(/\s+(?:HD|HQ)?\s*(?:KARAOKE|INSTRUMENTAL|MINUS ONE|LYRICS)(?:\s+VERSION)?\s*$/i, "")
    .trim();
  return result;
}

export function parseSongTitle(rawTitle) {
  const cleaned = stripMetadataSuffix(rawTitle);
  const separators = [...cleaned.matchAll(/\s[-–—]\s/g)];
  if (!separators.length) return null;
  const separator = separators.at(-1);
  const at = separator.index;
  const title = cleaned.slice(0, at).trim();
  const artist = stripMetadataSuffix(cleaned.slice(at + separator[0].length).trim());
  if (!title || !artist || artist.startsWith("(") || /\b(?:karaoke|coversph|lyrics|instrumental)\b/i.test(artist)) return null;
  return { title, artist };
}

function displayText(value) {
  return String(value || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function displayArtist(rawArtist, catalog) {
  const source = String(rawArtist || "");
  const compact = normalizeText(source).replace(/ /g, "");
  const known = catalog.find((song) => normalizeText(song.artist).replace(/ /g, "") === compact);
  return known?.artist || displayText(source);
}

function artistEquivalent(left, right) {
  const clean = (value) => normalizeText(value)
    .replace(/\b(?:originally|performed|by|feat|featuring|ft)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const a = clean(left);
  const b = clean(right);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aTokens = new Set(a.split(" ").filter((token) => token.length > 2));
  const overlap = b.split(" ").filter((token) => token.length > 2 && aTokens.has(token));
  return overlap.length >= 2;
}

function findSongDuplicate(title, artist, catalog, catalogKeys) {
  const exact = catalog.find((song) => songKey(song.title, song.artist) === songKey(title, artist));
  if (exact) return { song: exact, reason: "Normalized title + artist already exists in KantaCue." };
  const sameTitle = catalog.filter((song) => compactTitle(song.title) === compactTitle(title));
  const matchingArtist = sameTitle.find((song) => artistEquivalent(song.artist, artist));
  if (matchingArtist) return { song: matchingArtist, reason: "The same song is represented with an equivalent artist spelling or credit." };
  if (sameTitle[0]) return { song: sameTitle[0], reason: "The song title is already represented in KantaCue; this expansion does not add alternate provider versions." };
  if (catalogKeys.has(songKey(title, artist))) return { song: exact || null, reason: "Normalized song pair already exists in KantaCue." };
  return null;
}

function isRejectedTitle(title) {
  const value = normalizeText(title);
  return /\b(?:shorts?|trailer|teaser|preview|tutorial|lesson|medley|compilation|mix|playlist|livestream|live stream|announcement|challenge|acoustic|unplugged|remix|cover version)\b/.test(value)
    || /\b(?:part|karaoke competition)\s*\d+\b/.test(value)
    || /\b(?:guide vocal|guide melody|with vocals|male key|female key|lower key|higher key)\b/.test(value);
}

function hasKaraokeEvidence(title) {
  return /\b(?:karaoke|videoke|instrumental|minus one|backing track)\b/i.test(title);
}

function isLikelyOpM(title, artist, catalog) {
  const artistKey = normalizeText(artist);
  const titleKey = normalizeText(title);
  const known = catalog.find((song) => normalizeText(song.artist) === artistKey);
  if (known) return known.language === "Filipino" || (known.tags || []).includes("opm");
  return /\b(?:ang|ako|aking|atin|bakit|buhay|dahil|di|hindi|ikaw|ina|kapiling|kita|ko|kung|mahal|muli|na|ng|ngayon|pagibig|pag ibig|puso|sayo|sa yo|sana|walang|yung)\b/i.test(`${titleKey} ${artistKey}`)
    || /(?:aegis|alcasid|aguilar|velasquez|geronimo|constantino|tandingan|quinto|nava|rivera|valenciano|nievera|bamboo|eraserheads|parokya|rivermaya|south border|callalily|december avenue|moira|jona|juris|kyla|ben&ben|silent sanctuary|cueshe|kamikazee|yeng|regine|sarah)/i.test(artistKey);
}

function metadataTemplate(title, artist, catalog, opm) {
  const artistKey = normalizeText(artist);
  const profiles = catalog.filter((song) => normalizeText(song.artist) === artistKey);
  const base = profiles[0] || {};
  const tags = new Set(["popular", "coversph"]);
  if (opm) tags.add("opm");
  for (const tag of base.tags || []) if (["classics", "modern", "easy-karaoke", "rock", "ballad", "pop"].includes(tag)) tags.add(tag);
  const titleText = normalizeText(title);
  const genre = base.genre || (/(rock|band|sanctuary|mayonnaise|parokya|rivermaya|eraserheads|siakol|bamboo)/i.test(artistKey) ? "Rock" : "Pop");
  const era = base.era || (/(zack tabudlo|cup of joe|bini|dilaw|ben ben|moira)/i.test(`${titleText} ${artistKey}`) ? "2020s" : "2000s");
  const mood = base.mood?.length ? base.mood : [/(bakit|luha|puso|mahal|sayo|hindi|paalam|sakit|iyak)/i.test(titleText) ? "heartbreak" : "feel-good"];
  return {
    language: opm ? "Filipino" : "English",
    genre,
    era,
    mood,
    difficulty: base.difficulty || "medium",
    vocalRange: base.vocalRange || "medium",
    performanceType: base.performanceType || "solo",
    tags: [...tags]
  };
}

function classify(item, catalog, catalogKeys, catalogVideos, seenPairs, seenTitles, seenVideos) {
  const snippet = item?.snippet || {};
  const rawTitle = snippet.title || "";
  const parsed = parseSongTitle(rawTitle);
  const videoId = item?.id || null;
  const common = {
    videoId,
    sourceChannelId: snippet.channelId || null,
    channel: snippet.channelTitle || null,
    videoTitle: rawTitle || null,
    publicViews: item?.statistics?.viewCount || null,
    publishedAt: snippet.publishedAt || null,
    definition: item?.contentDetails?.definition || null,
    embeddable: typeof item?.status?.embeddable === "boolean" ? item.status.embeddable : null,
    madeForKids: typeof item?.status?.madeForKids === "boolean" ? item.status.madeForKids : null,
    duration: item?.contentDetails?.duration || null
  };
  if (snippet.channelId !== CHANNEL_ID) return { ...common, decision: "REJECT — channel mismatch", reason: "Video ownership is not the official CoversPH channel ID." };
  if (!parsed) return { ...common, decision: "METADATA INCOMPLETE", reason: "Could not safely separate the song title and original artist from the public title." };
  const { title, artist } = parsed;
  const duplicate = findSongDuplicate(title, artist, catalog, catalogKeys);
  if (duplicate) return { ...common, title, artist, decision: "REJECT — duplicate song", matchedCatalogId: duplicate.song?.id || null, reason: duplicate.reason };
  if (catalogVideos.has(videoId) || seenVideos.has(videoId)) return { ...common, title, artist, decision: "REJECT — duplicate video ID", matchedCatalogId: null, reason: "The video ID is already assigned or duplicated in the source set." };
  if (isRejectedTitle(rawTitle)) return { ...common, title, artist, decision: "REJECT — quality/type", reason: "Public title indicates a live, altered, guide, remix, acoustic, medley, or other unsuitable variant." };
  if (!hasKaraokeEvidence(rawTitle)) return { ...common, title, artist, decision: "REJECT — quality/type", reason: "Public title does not provide clear karaoke/instrumental evidence." };
  const opm = isLikelyOpM(title, artist, catalog);
  if (common.embeddable !== true || common.madeForKids !== false || common.definition !== "hd") {
    return { ...common, title, artist, languagePriority: opm ? "Filipino" : "English", decision: "REVIEW REQUIRED", reason: `Technical evidence is incomplete or failed: embeddable=${common.embeddable}, madeForKids=${common.madeForKids}, definition=${common.definition || "unknown"}.` };
  }
  const pair = songKey(title, artist);
  if (seenPairs.has(pair) || seenTitles.has(compactTitle(title))) return { ...common, title, artist, decision: "REJECT — duplicate song", matchedCatalogId: null, reason: "Another source upload for the same normalized song title was already retained." };
  seenPairs.add(pair);
  seenTitles.add(compactTitle(title));
  seenVideos.add(videoId);
  return {
    ...common,
    title,
    artist,
    metadata: metadataTemplate(title, artist, catalog, opm),
    languagePriority: opm ? "Filipino" : "English",
    technicalVerification: "API_ONLY",
    manualPlaybackReviewed: false,
    decision: "NEW CANDIDATE",
    reason: "Official CoversPH ownership, unique song pair, karaoke evidence, embeddable=true, Made-for-Kids=false, and HD definition."
  };
}

function candidateSort(left, right) {
  const language = Number(right.languagePriority === "Filipino") - Number(left.languagePriority === "Filipino");
  return language
    || Number(right.publicViews || 0) - Number(left.publicViews || 0)
    || String(left.publishedAt || "").localeCompare(String(right.publishedAt || ""))
    || String(left.videoId).localeCompare(String(right.videoId));
}

export function selectCandidates(candidates, target = TARGET) {
  const sorted = [...candidates].sort(candidateSort);
  const selected = [];
  const counts = new Map();
  for (const artistCap of [6, 10, Number.POSITIVE_INFINITY]) {
    for (const candidate of sorted) {
      if (selected.includes(candidate)) continue;
      const artistKey = normalizeText(candidate.artist);
      if ((counts.get(artistKey) || 0) >= artistCap) continue;
      selected.push(candidate);
      counts.set(artistKey, (counts.get(artistKey) || 0) + 1);
      if (selected.length === target) return selected.map((entry, index) => ({ ...entry, selectionRank: index + 1, selectionReason: `${entry.languagePriority === "Filipino" ? "OPM priority; " : "International balance; "}public view count ${entry.publicViews || "unavailable"}; artist diversity cap ${artistCap === Number.POSITIVE_INFINITY ? "relaxed" : artistCap}.` }));
    }
  }
  return selected.map((entry, index) => ({ ...entry, selectionRank: index + 1, selectionReason: "Selected from the strongest remaining technically qualified candidates; no filler added." }));
}

function buildCatalogRecord(candidate, index, catalog) {
  return {
    id: `sample-${String(481 + index).padStart(3, "0")}`,
    title: displayText(candidate.title),
    artist: displayArtist(candidate.artist, catalog),
    language: candidate.metadata.language,
    genre: candidate.metadata.genre,
    era: candidate.metadata.era,
    mood: candidate.metadata.mood,
    difficulty: candidate.metadata.difficulty,
    vocalRange: candidate.metadata.vocalRange,
    performanceType: candidate.metadata.performanceType,
    youtubeVideoId: candidate.videoId,
    tags: [...new Set(candidate.metadata.tags)]
  };
}

async function applyReport() {
  const [report, catalog] = await Promise.all([
    fs.readFile(REPORT_PATH, "utf8").then(JSON.parse),
    fs.readFile(CATALOG_PATH, "utf8").then(JSON.parse)
  ]);
  const selected = Array.isArray(report.selected) ? report.selected : [];
  if (catalog.length !== report.catalogBefore) throw new Error(`Refusing to apply: catalog changed from report baseline ${report.catalogBefore} to ${catalog.length}.`);
  if (selected.length !== TARGET) throw new Error(`Refusing to apply: report contains ${selected.length} selected candidates, expected ${TARGET}.`);
  const existingIds = new Set(catalog.map((song) => song.id));
  const existingVideos = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  const existingPairs = new Set(catalog.map((song) => songKey(song.title, song.artist)));
  const records = selected.map((candidate, index) => buildCatalogRecord(candidate, index, catalog));
  const duplicateIds = records.filter((song) => existingIds.has(song.id) || existingVideos.has(song.youtubeVideoId));
  const duplicatePairs = records.filter((song) => existingPairs.has(songKey(song.title, song.artist)));
  const unsafe = selected.filter((candidate) => candidate.sourceChannelId !== CHANNEL_ID || candidate.embeddable !== true || candidate.madeForKids !== false || candidate.definition !== "hd");
  if (duplicateIds.length || duplicatePairs.length || unsafe.length) throw new Error(`Refusing to apply: duplicate IDs/videos=${duplicateIds.length}, duplicate pairs=${duplicatePairs.length}, failed gates=${unsafe.length}.`);
  const nextCatalog = [...catalog, ...records];
  await atomicWriteJson(CATALOG_PATH, nextCatalog);
  report.catalogAfter = nextCatalog.length;
  report.added = records;
  report.appliedAt = new Date().toISOString();
  await atomicWriteJson(REPORT_PATH, report);
  console.log(`Applied ${records.length} CoversPH records to ${CATALOG_PATH}.`);
  console.log(`Catalog total: ${catalog.length} -> ${nextCatalog.length}`);
}

async function removeCurrentExpansion() {
  const catalog = JSON.parse(await fs.readFile(CATALOG_PATH, "utf8"));
  const additions = catalog.slice(461);
  const expected = Array.from({ length: TARGET }, (_, index) => `sample-${481 + index}`);
  if (catalog.length !== 561 || additions.length !== TARGET || JSON.stringify(additions.map((song) => song.id)) !== JSON.stringify(expected) || !additions.every((song) => song.tags.includes("coversph"))) {
    throw new Error("Refusing to remove: the current catalog tail is not exactly this task's CoversPH expansion.");
  }
  await atomicWriteJson(CATALOG_PATH, catalog.slice(0, 461));
  console.log("Removed only the current sample-481..sample-580 CoversPH expansion for report regeneration.");
}

function printHelp() {
  console.log(`Usage:\n  node tools/build-coversph-expansion-100.mjs\n  node tools/build-coversph-expansion-100.mjs --apply\n  node tools/build-coversph-expansion-100.mjs --remove-current\n\nDefault mode fetches the official @CoversPH uploads, writes ${REPORT_PATH}, and never changes the catalog.\n--apply appends exactly 100 candidates from the persisted report only after all duplicate and technical gates pass.\n--remove-current removes only this task's guarded sample-481..sample-580 tail for report regeneration.\nYOUTUBE_API_KEY is read only from the local development environment and is never printed or saved.`);
}

async function main() {
  if (process.argv.includes("--help")) return printHelp();
  if (process.argv.includes("--remove-current")) return removeCurrentExpansion();
  if (process.argv.includes("--apply")) return applyReport();
  const key = apiKey();
  const catalog = JSON.parse(await fs.readFile(CATALOG_PATH, "utf8"));
  const catalogKeys = new Set(catalog.map((song) => songKey(song.title, song.artist)));
  const catalogVideos = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  const uploads = await listUploads(key);
  const ids = videoIdsInOrder(uploads);
  const details = await getVideoDetails(ids, key);
  const ordered = ids.map((id) => details.get(id)).filter(Boolean);
  const seenPairs = new Set();
  const seenTitles = new Set();
  const seenVideos = new Set();
  const all = ordered.map((item, index) => ({ uploadPosition: index + 1, ...classify(item, catalog, catalogKeys, catalogVideos, seenPairs, seenTitles, seenVideos) }));
  const candidates = all.filter((entry) => entry.decision === "NEW CANDIDATE");
  const selected = selectCandidates(candidates);
  const report = {
    version: 1,
    source: {
      channel: CHANNEL_NAME,
      channelHandle: CHANNEL_HANDLE,
      channelId: CHANNEL_ID,
      uploadsPlaylistId: UPLOADS_PLAYLIST_ID,
      listing: "Official CoversPH uploads with public videos.list statistics; OPM-first popularity and artist-diversity selection",
      url: `https://www.youtube.com/${CHANNEL_HANDLE}/videos`,
      retrievedOn: new Date().toISOString().slice(0, 10)
    },
    catalogBefore: catalog.length,
    targetAdditions: TARGET,
    candidateCount: candidates.length,
    selectedCount: selected.length,
    shortfall: Math.max(0, TARGET - selected.length),
    selected,
    summary: {
      examined: all.length,
      alreadyInCatalog: all.filter((entry) => entry.decision === "REJECT — duplicate song" && entry.matchedCatalogId).length,
      atomicDuplicates: all.filter((entry) => entry.decision === "REJECT — duplicate song" && catalog.find((song) => song.id === entry.matchedCatalogId)?.tags?.includes("atomic-karaoke")).length,
      previousCoversPhDuplicates: all.filter((entry) => entry.decision === "REJECT — duplicate song" && catalog.find((song) => song.id === entry.matchedCatalogId)?.tags?.includes("coversph")).length,
      duplicateVideoIds: all.filter((entry) => entry.decision === "REJECT — duplicate video ID").length,
      qualityTypeRejected: all.filter((entry) => entry.decision === "REJECT — quality/type").length,
      metadataIncomplete: all.filter((entry) => entry.decision === "METADATA INCOMPLETE").length,
      channelMismatch: all.filter((entry) => entry.decision === "REJECT — channel mismatch").length,
      verificationInsufficient: all.filter((entry) => entry.decision === "REVIEW REQUIRED").length,
      opmCandidates: candidates.filter((entry) => entry.languagePriority === "Filipino").length,
      internationalCandidates: candidates.filter((entry) => entry.languagePriority !== "Filipino").length
    },
    all
  };
  await atomicWriteJson(REPORT_PATH, report);
  console.log(`CoversPH report written: ${REPORT_PATH}`);
  console.log(`Official uploads examined: ${all.length}`);
  console.log(`Unique technically qualified candidate pool: ${candidates.length}`);
  console.log(`Selected: ${selected.length}/${TARGET}`);
  console.log(`Target shortfall: ${report.shortfall}`);
  selected.forEach((entry) => console.log(`${entry.selectionRank} | ${entry.title} | ${entry.artist} | ${entry.videoId} | ${entry.publicViews || "unknown"}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`CoversPH expansion failed: ${error.message}`);
    process.exitCode = 1;
  });
}
