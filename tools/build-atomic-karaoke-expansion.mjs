#!/usr/bin/env node

/**
 * Development-only Atomic Karaoke catalog audit.
 *
 * Normal mode never writes the public catalog. It produces a candidate report
 * from the official channel's public uploads and videos.list metadata. Apply
 * is intentionally a separate, explicit step after the report is reviewed.
 */

import fs from "node:fs/promises";
import path from "node:path";

const CHANNEL_ID = "UCutZyApGOjqhOS-pp7yAj4Q";
const CHANNEL_HANDLE = "@AtomicKaraoke";
const CHANNEL_NAME = "Atomic Karaoke";
const UPLOADS_PLAYLIST_ID = "UUutZyApGOjqhOS-pp7yAj4Q";
const CATALOG_PATH = "data/songs.sample.json";
const REPORT_PATH = "tools/atomic-karaoke-expansion-100-report.json";
const API_ROOT = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function apiKey() {
  const value = process.env.YOUTUBE_API_KEY;
  if (!value?.trim()) throw new Error("YOUTUBE_API_KEY is missing; keep it local and never print it.");
  return value.trim();
}

function normalized(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keyFor(title, artist) {
  return `${normalized(title)}\u0000${normalized(artist)}`;
}

function videoIdsInOrder(items) {
  return items
    .map((item) => item?.contentDetails?.videoId)
    .filter((id) => YOUTUBE_ID.test(id));
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

function parseSongTitle(rawTitle) {
  const source = String(rawTitle || "").replace(/\s+/g, " ").trim();
  const cleaned = source
    .replace(/\s*\((?:HD\s*)?Karaoke(?:\s+Version)?\)\s*$/i, "")
    .replace(/\s*[-–—]\s*(?:HD\s*)?Karaoke(?:\s+Version)?\s*$/i, "")
    .replace(/\s+(?:HD\s*)?Karaoke(?:\s+Version)?\s*$/i, "")
    .trim();
  const separator = cleaned.match(/\s[-–—]\s/);
  if (!separator) return null;
  const at = separator.index;
  const title = cleaned.slice(0, at).trim();
  const artist = cleaned.slice(at + separator[0].length).trim();
  if (!title || !artist) return null;
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
  const compact = normalized(source).replace(/ /g, "");
  const known = catalog.find((song) => normalized(song.artist).replace(/ /g, "") === compact);
  return known?.artist || displayText(source);
}

function isRejectedTitle(title) {
  const value = normalized(title);
  return /\b(?:shorts?|trailer|teaser|preview|tutorial|lesson|medley|compilation|mix|playlist|livestream|live stream|announcement|challenge|instrumental only|minus one only)\b/.test(value)
    || /\b(?:part|karaoke competition)\s*\d+\b/.test(value);
}

function hasKaraokeEvidence(title) {
  return /\bkaraoke\b/i.test(title) && /\b(?:hd|hq)\b/i.test(title);
}

function isLikelyOpM(title, artist, catalog) {
  const artistKey = normalized(artist);
  const titleKey = normalized(title);
  const knownArtist = catalog.find((song) => normalized(song.artist) === artistKey);
  if (knownArtist) return knownArtist.language === "Filipino" || (knownArtist.tags || []).includes("opm");
  return /\b(?:ang|ako|aking|atin|bakit|buhay|dahil|di|hindi|ikaw|ina|kapiling|kita|ko|kung|mahal|muli|na|ng|ngayon|pagibig|puso|sayo|sa yo|sana|walang|yung)\b/i.test(`${titleKey} ${artistKey}`);
}

function metadataTemplate(title, artist, catalog) {
  const artistKey = normalized(artist);
  const profiles = catalog.filter((song) => normalized(song.artist) === artistKey && song.language === "Filipino");
  const base = profiles[0] || {};
  const tags = new Set(["opm", "popular", "atomic-karaoke"]);
  for (const tag of base.tags || []) if (["classics", "modern", "easy-karaoke"].includes(tag)) tags.add(tag);
  const titleText = normalized(title);
  const artistText = normalized(artist);
  const profileTag = profiles.flatMap((song) => song.tags || []).find((tag) => ["rock", "alternative-rock", "ballad", "pop", "r-and-b", "folk"].includes(tag));
  if (profileTag) tags.add(profileTag);
  const genre = base.genre || (/(rock|band|sanctuary|mayonnaise|parokya|rivermaya|eraserheads|siakol|bamboo)/i.test(artistText) ? "Rock" : "Pop");
  const era = base.era || (/(zack tabudlo|cup of joe|bini|dilaw|ben&ben|moira)/i.test(`${titleText} ${artistText}`) ? "2020s" : "2000s");
  const mood = base.mood?.length ? base.mood : [/(bakit|luha|puso|mahal|sayo|hindi|paalam|sakit|iyak)/i.test(titleText) ? "heartbreak" : "feel-good"];
  return {
    language: "Filipino",
    genre,
    era,
    mood,
    difficulty: base.difficulty || "medium",
    vocalRange: base.vocalRange || "medium",
    performanceType: base.performanceType || "solo",
    tags: [...tags]
  };
}

function classify(item, catalog, catalogKeys, catalogVideos) {
  const snippet = item?.snippet || {};
  const title = snippet.title || "";
  const parsed = parseSongTitle(title);
  const videoId = item?.id || null;
  const common = {
    videoId,
    sourceChannelId: snippet.channelId || null,
    channel: snippet.channelTitle || null,
    videoTitle: title || null,
    publicViews: item?.statistics?.viewCount || null,
    publishedAt: snippet.publishedAt || null,
    definition: item?.contentDetails?.definition || null,
    embeddable: item?.status?.embeddable === true,
    madeForKids: item?.status?.madeForKids === true,
    duration: item?.contentDetails?.duration || null
  };
  if (snippet.channelId !== CHANNEL_ID) return { ...common, decision: "REJECT — channel mismatch", reason: "Video is not owned by the official Atomic Karaoke channel." };
  if (!parsed) return { ...common, decision: "METADATA INCOMPLETE", reason: "Could not safely separate an exact song title and artist from the public title." };
  const { title: songTitle, artist } = parsed;
  const pairKey = keyFor(songTitle, artist);
  if (catalogKeys.has(pairKey)) return { ...common, title: songTitle, artist, decision: "ALREADY IN KANTACUE", reason: "Normalized song title and artist already exist in the production catalog." };
  if (catalogVideos.has(videoId)) return { ...common, title: songTitle, artist, decision: "ALREADY IN KANTACUE", reason: "Video ID is already assigned in the production catalog." };
  if (isRejectedTitle(title)) return { ...common, title: songTitle, artist, decision: "REJECT — non-song/variant", reason: "Public title indicates a non-standard, non-song, or restricted variant." };
  if (!hasKaraokeEvidence(title)) return { ...common, title: songTitle, artist, decision: "REJECT — karaoke evidence missing", reason: "Public title does not contain both karaoke and HD/HQ evidence." };
  if (!isLikelyOpM(songTitle, artist, catalog)) return { ...common, title: songTitle, artist, decision: "REJECT — not confidently OPM", reason: "The available public metadata does not support a confident Filipino/OPM classification." };
  if (!common.embeddable || common.madeForKids || common.definition !== "hd") return { ...common, title: songTitle, artist, decision: "REVIEW REQUIRED", reason: `Technical gate failed or is insufficient: embeddable=${common.embeddable}, madeForKids=${common.madeForKids}, definition=${common.definition || "unknown"}.` };
  return { ...common, title: songTitle, artist, metadata: metadataTemplate(songTitle, artist, catalog), decision: "NEW CANDIDATE", reason: "Official-channel HD Karaoke title, unique normalized song pair, embeddable=true, Made-for-Kids=false." };
}

function buildCatalogRecord(candidate, index, catalog) {
  const metadata = candidate.metadata;
  return {
    id: `sample-${String(381 + index).padStart(3, "0")}`,
    title: displayText(candidate.title),
    artist: displayArtist(candidate.artist, catalog),
    language: metadata.language,
    genre: metadata.genre,
    era: metadata.era,
    mood: metadata.mood,
    difficulty: metadata.difficulty,
    vocalRange: metadata.vocalRange,
    performanceType: metadata.performanceType,
    youtubeVideoId: candidate.videoId,
    tags: [...new Set(metadata.tags)]
  };
}

async function applyReport() {
  const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
  const catalog = JSON.parse(await fs.readFile(CATALOG_PATH, "utf8"));
  const selected = Array.isArray(report.selected) ? report.selected : [];
  if (selected.length !== 100) throw new Error(`Refusing to apply: report contains ${selected.length} selected candidates, expected 100.`);

  const existingIds = new Set(catalog.map((song) => song.id));
  const existingVideos = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  const existingPairs = new Set(catalog.map((song) => keyFor(song.title, song.artist)));
  const records = selected.map((candidate, index) => buildCatalogRecord(candidate, index, catalog));
  const duplicateIds = records.filter((song) => existingIds.has(song.id) || existingVideos.has(song.youtubeVideoId));
  const duplicatePairs = records.filter((song) => existingPairs.has(keyFor(song.title, song.artist)));
  if (duplicateIds.length > 0 || duplicatePairs.length > 0) {
    throw new Error(`Refusing to apply: ${duplicateIds.length} duplicate IDs/videos and ${duplicatePairs.length} duplicate title/artist pairs.`);
  }

  const nextCatalog = [...catalog, ...records];
  await fs.writeFile(CATALOG_PATH, `${JSON.stringify(nextCatalog, null, 2)}\n`, "utf8");
  report.catalogAfter = nextCatalog.length;
  report.added = records;
  report.appliedAt = new Date().toISOString();
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Applied ${records.length} Atomic Karaoke records to ${CATALOG_PATH}.`);
  console.log(`Catalog total: ${catalog.length} -> ${nextCatalog.length}`);
}

async function main() {
  if (process.argv.includes("--apply")) {
    await applyReport();
    return;
  }
  const key = apiKey();
  const catalog = JSON.parse(await fs.readFile(CATALOG_PATH, "utf8"));
  const catalogKeys = new Set(catalog.map((song) => keyFor(song.title, song.artist)));
  const catalogVideos = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  const uploads = await listUploads(key);
  const ids = videoIdsInOrder(uploads);
  const details = await getVideoDetails(ids, key);
  const ordered = ids.map((id) => details.get(id)).filter(Boolean);
  const all = ordered.map((item, index) => ({ playlistPosition: index + 1, ...classify(item, catalog, catalogKeys, catalogVideos) }));
  const candidates = all.filter((item) => item.decision === "NEW CANDIDATE")
    .sort((left, right) => Number(right.publicViews || 0) - Number(left.publicViews || 0) || left.playlistPosition - right.playlistPosition);
  const selected = candidates.slice(0, 100);
  const report = {
    version: 1,
    source: { channel: CHANNEL_NAME, channelHandle: CHANNEL_HANDLE, channelId: CHANNEL_ID, listing: "Official channel uploads with public videos.list statistics; sorted by public viewCount", url: `https://www.youtube.com/${CHANNEL_HANDLE}/videos`, retrievedOn: new Date().toISOString().slice(0, 10) },
    catalogBefore: catalog.length,
    targetAdditions: 100,
    candidateCount: candidates.length,
    selectedCount: selected.length,
    shortfall: Math.max(0, 100 - selected.length),
    selected,
    summary: { examined: all.length, alreadyInCatalog: all.filter((x) => x.decision === "ALREADY IN KANTACUE").length, rejected: all.filter((x) => x.decision.startsWith("REJECT")).length, metadataIncomplete: all.filter((x) => x.decision === "METADATA INCOMPLETE").length, reviewRequired: all.filter((x) => x.decision === "REVIEW REQUIRED").length },
    all
  };
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Atomic report written: ${REPORT_PATH}`);
  console.log(`Official uploads examined: ${all.length}`);
  console.log(`NEW CANDIDATE pool: ${candidates.length}`);
  console.log(`Selected for review: ${selected.length}`);
  console.log(`Target shortfall: ${report.shortfall}`);
  selected.forEach((item, index) => console.log(`${index + 1} | ${item.title} | ${item.artist} | ${item.videoId} | ${item.publicViews || "unknown"}`));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
