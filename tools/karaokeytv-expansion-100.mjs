#!/usr/bin/env node

/**
 * Development-only KaraokeyTV expansion workflow.
 *
 * Discovery uses the official channel's public, view-count ordered search
 * listing plus videos.list metadata. It never writes the production catalog
 * during discovery or runtime-manifest creation. Only `apply` may append
 * records, and it requires a runtime PASS for every selected video.
 */

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeCatalog } from "../src/catalog.js";

export const OFFICIAL_HANDLE = "@karaokeytv0618";
export const DEFAULT_CATALOG_PATH = "data/songs.sample.json";
export const DEFAULT_REPORT_PATH = "tools/karaokeytv-expansion-100-runtime-report.json";
export const DEFAULT_RUNTIME_PATH = "tools/karaokeytv-expansion-100-runtime.json";
export const DEFAULT_MANIFEST_PATH = "tools/karaokeytv-expansion-100.runtime-manifest.json";
export const MAX_RESULTS_PER_PAGE = 50;
export const DEFAULT_MAX_PAGES = 6;
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const KARAOKE_TERMS = /\b(?:karaoke|instrumental|backing\s+track|minus\s+one|sing\s+along)\b/i;
const HARD_NEGATIVES = [
  /\b(?:medley|compilation|playlist|shorts?|trailer|tutorial|reaction|live|concert|performance)\b/i,
  /\b(?:with\s+(?:guide\s+)?vocals?|guide\s+(?:vocal|melody)|vocal\s+guide|male\s+key|female\s+key|lower\s+key|higher\s+key|altered\s+key)\b/i
];
const TITLE_SUFFIXES = [
  /\s*\([^)]*\b(?:karaoke|instrumental|backing|minus\s+one|sing\s+along)[^)]*\)\s*$/i,
  /\s*\[[^\]]*\b(?:karaoke|instrumental|backing|minus\s+one|sing\s+along)[^\]]*\]\s*$/i,
  /\s*[-|]\s*(?:karaoke|instrumental|backing\s+track|minus\s+one).*$/i
];

// A small, explicit correction table is safer than pretending every public
// channel title follows one grammar. These are identity corrections only;
// they do not approve a video or bypass the runtime gate.
const METADATA_OVERRIDES = Object.freeze({
  "mHmWjb-N15A": { title: "I Need You", artist: "LeAnn Rimes" },
  "CzJRPhiRHOE": { title: "Sway", artist: "Bic Runga" },
  "yqwJ8kUIQj0": { title: "California King Bed", artist: "Rihanna" },
  "yEgPsNEiUQ8": { title: "Upside Down", artist: "6cyclemind" },
  "SRw9Y21ZMig": { title: "World's Smallest Violin", artist: "AJR" },
  "tEXMElf-lWM": { title: "Alipin", artist: "Shamrock" },
  "3bKG-IJA6Pw": { title: "Training Season", artist: "Dua Lipa" },
  "mjXwS35CapY": { title: "Hate That I Made You Love Me", artist: "Ariana Grande" }
});

const UNSAFE_METADATA_WORDING = /\b(?:karaoke|lyrics?|cover|version|phylum|reggae)\b/i;
const UNSAFE_VARIANT_WORDING = /\b(?:medley|mashup|compilation|live|concert|official\s+music\s+video|part\s*[1-9]|tutorial|reaction)\b/i;
const NON_CANONICAL_PERFORMER_NAMES = new Set([
  "khel pangilinan", "blues rock", "tropavibes", "the macarons project",
  "justin vasquez", "jhamil villanueva", "clair marlo", "dona salazar",
  "ella bright off campus", "rob daniel", "niki"
]);
const FILIPINO_ARTISTS = new Set([
  "aiza seguerra", "soapdish", "freddie aguilar", "toneejay", "december avenue",
  "janine berdin", "kyle raphael", "belle mariano", "martin nievera", "skusta clee",
  "max surban", "bamboo", "this band", "king badger", "aegis", "adie", "bing rodrigo",
  "elha nympha", "bini", "jm bales", "baby dolls", "jencee", "andrew e", "kitchie nadal",
  "carol banawa", "willy garte", "jeremy novela", "iv of spades", "julie anne san jose",
  "shamrock", "toni fowler x tito vince x papi galang", "siakol", "eraserheads",
  "yuji and putri dahlia", "esremborak", "emil losenada and dulce", "gem cristian", "moira",
  "dionela", "nica del rosario ft gab pangilinan", "ted ito", "tootsie guevara", "sabak daddy",
  "tj monterde", "nina angela sarto", "anees ft jroa", "thyro and yumi", "luz loreto",
  "ryssi avila", "mac mafia", "dodoy torres and waraynon music", "kris lawrence", "vst and company",
  "vst and co", "jimmy bondoc", "lyca gairanod", "moonstar 88", "regine velasquez", "aprils boys"
]);

export function normalizeIdentityPart(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/\b(?:feat\.?|ft\.?)\b/g, " featuring ")
    .replace(/\b(?:karaoke|karaoke version|instrumental|backing track|minus one|original key|lyrics?|hd)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function songIdentityKey(title, artist) {
  return `${normalizeIdentityPart(title)}\u0000${normalizeIdentityPart(artist)}`;
}

export function parseSongMetadata(videoTitle) {
  const original = String(videoTitle ?? "").replace(/\s+/g, " ").trim();
  let cleaned = original;
  for (const suffix of TITLE_SUFFIXES) cleaned = cleaned.replace(suffix, "").trim();
  cleaned = cleaned.replace(/^\s*(?:karaoke|instrumental)\s*[-:|]\s*/i, "").trim();

  const separators = [" - ", " – ", " — ", " | ", " : "];
  for (const separator of separators) {
    const index = cleaned.lastIndexOf(separator);
    if (index <= 0 || index >= cleaned.length - separator.length) continue;
    const left = cleanMetadataPart(cleaned.slice(0, index));
    const right = cleanMetadataPart(cleaned.slice(index + separator.length));
    if (left && right) return { title: left, artist: right, sourceTitle: original };
  }

  return { title: cleaned, artist: "", sourceTitle: original };
}

function cleanMetadataPart(value) {
  return String(value ?? "")
    .replace(/^\s*\((?:karaoke|instrumental|backing[^)]*)\)\s*/i, "")
    .replace(/^\s*\[(?:karaoke|instrumental|backing[^\]]*)\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function candidateMetadata(candidate, catalog) {
  const override = METADATA_OVERRIDES[candidate.videoId];
  if (override) return { ...parseSongMetadata(candidate.videoTitle), ...override };
  const knownArtists = new Set(catalog.map((song) => normalizeIdentityPart(song.artist)));
  let metadata = parseSongMetadata(candidate.videoTitle);
  const left = normalizeIdentityPart(metadata.title);
  const right = normalizeIdentityPart(metadata.artist);
  if (knownArtists.has(left) && !knownArtists.has(right)) metadata = { ...metadata, title: metadata.artist, artist: metadata.title };
  return metadata;
}

function metadataIssues(candidate, metadata, catalog) {
  const issues = [];
  const sourceTitle = String(candidate.videoTitle || "");
  if (!metadata.title || !metadata.artist) issues.push("metadata incomplete");
  if (UNSAFE_METADATA_WORDING.test(metadata.artist || "")) issues.push("artist field contains karaoke/provider/version wording");
  if (NON_CANONICAL_PERFORMER_NAMES.has(normalizeIdentityPart(metadata.artist))) issues.push("artist appears to be a cover/performance attribution rather than a verified original-artist identity");
  if (UNSAFE_VARIANT_WORDING.test(sourceTitle)) issues.push("non-standard or unsuitable source wording");
  if (/\b(?:acoustic|unplugged|remix|reggae|twin\s+ver(?:sion)?|part\s*[1-9])\b/i.test(sourceTitle)) issues.push("altered arrangement/version wording");
  if (/[|/]/.test(metadata.artist || "")) issues.push("artist attribution is ambiguous");
  if (/[|]/.test(metadata.title || "") || /\s+x\s+/i.test(metadata.title || "")) issues.push("compound or ambiguous title");
  if (/\b(?:cover|karaoke version)\b/i.test(sourceTitle) && /\bcover\b/i.test(sourceTitle)) issues.push("cover/variant wording requires manual identity review");
  const sameTitle = catalog.find((song) => normalizeIdentityPart(song.title) === normalizeIdentityPart(metadata.title));
  if (sameTitle) issues.push(`song title already exists as ${sameTitle.id}; variant duplicates are not added`);
  return issues;
}

export function classifyCandidate(candidate, catalog, officialChannelId) {
  const metadata = candidateMetadata(candidate, catalog);
  const key = songIdentityKey(metadata.title, metadata.artist);
  const existingByKey = new Map(catalog.map((song) => [songIdentityKey(song.title, song.artist), song]));
  const existingVideo = catalog.find((song) => song.youtubeVideoId === candidate.videoId);
  const reason = [];

  if (candidate.channelId !== officialChannelId) reason.push("not official KaraokeyTV channel");
  if (!VIDEO_ID_PATTERN.test(candidate.videoId || "")) reason.push("invalid video ID");
  const metadataWarnings = metadataIssues(candidate, metadata, catalog);
  metadataWarnings.forEach((warning) => reason.push(warning));
  if (existingVideo) reason.push(`video ID already used by ${existingVideo.id}`);
  const existingSong = existingByKey.get(key);
  if (existingSong) reason.push(`song already exists as ${existingSong.id}`);
  if (!KARAOKE_TERMS.test(candidate.videoTitle || "")) reason.push("karaoke/instrumental wording is not clear");
  if (HARD_NEGATIVES.some((pattern) => pattern.test(candidate.videoTitle || ""))) reason.push("non-standard or unsuitable version wording");
  if (candidate.embeddable === false) reason.push("API reports embedding disabled");
  if (candidate.madeForKids === true) reason.push("Made-for-Kids policy failure");
  if (candidate.apiAvailable === false) reason.push("video is unavailable");

  let decision = "NEW_CANDIDATE";
  let rejectionReason = null;
  if (existingSong) {
    decision = existingSong.youtubeVideoId ? "EXISTING_SONG" : "EXISTING_UNAVAILABLE_SONG";
    rejectionReason = `Song already represented by ${existingSong.id}; expansion never repairs or duplicates catalog identities.`;
  } else if (existingVideo) {
    decision = "DUPLICATE_VIDEO_ID";
    rejectionReason = reason.find((item) => item.startsWith("video ID")) || "Video ID is already used.";
  } else if (reason.length > 0) {
    decision = reason.some((item) => item === "metadata incomplete") ? "METADATA_INCOMPLETE" : "REJECTED_PREFILTER";
    rejectionReason = reason.join("; ");
  }

  return {
    ...candidate,
    title: metadata.title,
    artist: metadata.artist,
    sourceTitle: metadata.sourceTitle,
    identityKey: key,
    decision,
    rejectionReason,
    metadataStatus: metadataWarnings.length === 0 ? "VALID" : "REVIEW_REQUIRED",
    metadataWarnings,
    runtimeStatus: "UNTESTED",
    runtimeError: null,
    playbackSeconds: null
  };
}

export function selectRuntimeCandidates(entries) {
  const seenSongs = new Set();
  const seenTitles = new Set();
  const seenVideos = new Set();
  return entries
    .filter((entry) => entry.decision === "NEW_CANDIDATE")
    .sort((a, b) => (a.sourceRank || Number.MAX_SAFE_INTEGER) - (b.sourceRank || Number.MAX_SAFE_INTEGER))
    .filter((entry) => {
      const titleKey = normalizeIdentityPart(entry.title);
      if (seenSongs.has(entry.identityKey) || seenTitles.has(titleKey) || seenVideos.has(entry.videoId)) return false;
      seenSongs.add(entry.identityKey);
      seenTitles.add(titleKey);
      seenVideos.add(entry.videoId);
      return true;
    });
}

export function buildRuntimeManifest(report, controls = []) {
  const controlEntries = (report.controlEntries || controls).filter((entry) => entry?.videoId);
  const candidateEntries = selectRuntimeCandidates(report.entries || []).map((entry, index) => ({
    songId: `karaokeytv-candidate-${String(index + 1).padStart(3, "0")}`,
    title: entry.title,
    artist: entry.artist,
    videoId: entry.videoId,
    provider: "KaraokeyTV",
    channel: entry.channelTitle,
    metadataStatus: entry.metadataStatus || "REVIEW_REQUIRED",
    metadataWarnings: entry.metadataWarnings || [],
    apiEmbeddable: entry.embeddable,
    madeForKids: entry.madeForKids,
    definition: entry.definition,
    publicViews: entry.viewCount,
    iframeStatus: "UNTESTED",
    errorCode: null,
    failureClassification: null,
    replacementRequired: false,
    qualityStatus: "UNREVIEWED",
    note: "Expansion candidate; runtime verification is mandatory before apply.",
    testedAt: null
  }));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: "karaokeytv-expansion-runtime",
    playbackWindowMs: 15000,
    catalogCount: report.catalogBefore,
    entries: [...controlEntries, ...candidateEntries]
  };
}

export function metadataForSong(entry, catalog = []) {
  const title = String(entry.title || "").trim();
  const artist = String(entry.artist || "").trim();
  const text = `${title} ${artist}`.toLowerCase();
  const artistKey = normalizeIdentityPart(artist);
  const reference = catalog.find((song) => normalizeIdentityPart(song.artist) === artistKey);
  const filipino = FILIPINO_ARTISTS.has(artistKey) || reference?.language?.toLowerCase() === "filipino" || /\b(?:filipino|tagalog|opm)\b/i.test(text) || /[ñ]/i.test(text);
  const genre = reference?.genre || (/\b(?:rock|metal|punk)\b/i.test(text) ? "Rock" : /\b(?:country|folk)\b/i.test(text) ? "Country" : /\b(?:ballad|love|heartbreak)\b/i.test(text) ? "Ballad" : "Pop");
  const mood = reference?.mood?.length ? reference.mood : (/\b(?:sad|heartbreak|goodbye|alone|cry|pain|sorry)\b/i.test(text) ? ["heartbreak"] : ["feel-good"]);
  const difficulty = reference?.difficulty || (/\b(?:hero|forever|power|high|belting|diva)\b/i.test(text) ? "hard" : "medium");
  const vocalRange = reference?.vocalRange || (/\b(?:male|men|king|boy)\b/i.test(text) ? "low" : "medium");
  const groupLike = /(?:,|&|\bx\b|\band\b|\bwith\b|\bft\.?\b|\bfeaturing\b)/i.test(artist);
  return {
    language: reference?.language || (filipino ? "Filipino" : "English"),
    genre,
    era: reference?.era || "2000s",
    mood,
    difficulty,
    vocalRange,
    performanceType: reference?.performanceType || (groupLike ? (/\bx\b/i.test(artist) ? "group" : "duet") : "solo"),
    tags: [filipino ? "opm" : "international", "popular", genre.toLowerCase().replace(/\s+/g, "-"), "karaokeytv"]
  };
}

async function discover(options) {
  const catalog = JSON.parse(await readFile(options.catalog, "utf8"));
  const normalized = normalizeCatalog(catalog, { logger: { warn() {} } });
  if (normalized.songs.length !== catalog.length) throw new Error("Current catalog contains invalid records; refusing expansion.");
  const apiKey = getApiKey();
  const reportPath = path.resolve(options.report);
  const channelPayload = await requestJson(makeUrl(CHANNELS_URL, { part: "id,snippet", forHandle: OFFICIAL_HANDLE, key: apiKey }), options);
  const channel = channelPayload.items?.[0];
  const officialChannelId = channel?.id;
  if (!officialChannelId) throw new Error(`Could not resolve the official channel for ${OFFICIAL_HANDLE}.`);
  const candidates = [];
  let pageToken = "";
  for (let page = 0; page < options.maxPages; page += 1) {
    const payload = await requestJson(makeUrl(SEARCH_URL, {
      part: "snippet",
      channelId: officialChannelId,
      order: "viewCount",
      type: "video",
      maxResults: String(MAX_RESULTS_PER_PAGE),
      ...(pageToken ? { pageToken } : {}),
      key: apiKey
    }), options);
    const items = Array.isArray(payload.items) ? payload.items : [];
    items.forEach((item, index) => {
      const videoId = item.id?.videoId;
      if (!VIDEO_ID_PATTERN.test(videoId || "")) return;
      candidates.push({
        sourceRank: page * MAX_RESULTS_PER_PAGE + index + 1,
        videoId,
        videoTitle: item.snippet?.title || "",
        channelId: item.snippet?.channelId || null,
        channelTitle: item.snippet?.channelTitle || null,
        publishedAt: item.snippet?.publishedAt || null,
        viewCount: null,
        likeCount: null,
        duration: null,
        definition: null,
        embeddable: null,
        madeForKids: null,
        apiAvailable: null
      });
    });
    await writeJsonAtomic(reportPath, {
      version: 1,
      status: "DISCOVERY_IN_PROGRESS",
      source: { handle: OFFICIAL_HANDLE, channelId: officialChannelId, channelTitle: channel.snippet?.title || null, listing: "YouTube search.list order=viewCount", pagesFetched: page + 1 },
      catalogBefore: catalog.length,
      entries: candidates,
      notes: ["Discovery metadata is not runtime playback evidence.", "No production catalog changes were made."]
    });
    pageToken = payload.nextPageToken || "";
    if (!pageToken || items.length < MAX_RESULTS_PER_PAGE) break;
  }

  const uniqueIds = [...new Set(candidates.map((item) => item.videoId))];
  for (const batch of chunk(uniqueIds, 50)) {
    const payload = await requestJson(makeUrl(VIDEOS_URL, { part: "snippet,status,statistics,contentDetails", id: batch.join(","), key: apiKey }), options);
    const byId = new Map((payload.items || []).map((item) => [item.id, item]));
    for (const candidate of candidates) {
      if (!batch.includes(candidate.videoId)) continue;
      const item = byId.get(candidate.videoId);
      if (!item) { candidate.apiAvailable = false; continue; }
      candidate.channelId = item.snippet?.channelId || candidate.channelId;
      candidate.channelTitle = item.snippet?.channelTitle || candidate.channelTitle;
      candidate.videoTitle = item.snippet?.title || candidate.videoTitle;
      candidate.publishedAt = item.snippet?.publishedAt || candidate.publishedAt;
      candidate.viewCount = parseCount(item.statistics?.viewCount);
      candidate.likeCount = parseCount(item.statistics?.likeCount);
      candidate.duration = item.contentDetails?.duration || null;
      candidate.definition = item.contentDetails?.definition || null;
      candidate.embeddable = item.status?.embeddable ?? null;
      candidate.madeForKids = item.status?.madeForKids ?? null;
      candidate.apiAvailable = true;
    }
  }

  const entries = candidates.map((candidate) => classifyCandidate(candidate, normalized.songs, officialChannelId));
  const report = {
    version: 2,
    status: "DISCOVERY_COMPLETE",
    source: { handle: OFFICIAL_HANDLE, channelId: officialChannelId, channelTitle: channel.snippet?.title || null, listing: "YouTube search.list order=viewCount", pagesFetched: Math.ceil(candidates.length / MAX_RESULTS_PER_PAGE) },
    catalogBefore: catalog.length,
    catalogPlayableBefore: catalog.filter((song) => song.youtubeVideoId).length,
    catalogUnavailableBefore: catalog.filter((song) => !song.youtubeVideoId).length,
    candidatesDiscovered: candidates.length,
    entries,
    counts: summarizeEntries(entries),
    controlEntries: await loadControlEntries(options),
    notes: ["Discovery metadata/API checks are prefilter evidence only.", "Only runtime PASS candidates may be applied.", "The 67 current null assignments were treated as existing song identities and were not repaired."]
  };
  await writeJsonAtomic(reportPath, report);
  printDiscoverySummary(report);
  return report;
}

async function discoverPublic(options) {
  const catalog = JSON.parse(await readFile(options.catalog, "utf8"));
  const normalized = normalizeCatalog(catalog, { logger: { warn() {} } });
  if (normalized.songs.length !== catalog.length) throw new Error("Current catalog contains invalid records; refusing expansion.");
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = "https://www.youtube.com/@karaokeytv0618/videos";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3_000);
    const popular = page.locator('button[aria-label="Popular"]');
    if (await popular.count() !== 1) throw new Error("The public channel page did not expose its Popular tab.");
    if ((await popular.getAttribute("aria-selected")) !== "true") {
      await popular.click();
      await page.waitForTimeout(3_000);
    }
    let previousCount = 0;
    let stableRounds = 0;
    for (let round = 0; round < options.scrollRounds; round += 1) {
      const count = await page.locator('ytd-rich-item-renderer a[href*="/watch?v="]').count();
      if (count === previousCount) stableRounds += 1; else stableRounds = 0;
      if (stableRounds >= 3) break;
      previousCount = count;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(options.scrollDelayMs);
    }
    const extracted = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const channelMatch = html.match(/(?:channelId|externalId)[^A-Za-z0-9_-]{0,12}(UC[A-Za-z0-9_-]{20,})/);
      const rows = [];
      const seen = new Set();
      for (const card of document.querySelectorAll("ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer")) {
        const link = card.querySelector('a[href*="/watch?v="]');
        if (!link) continue;
        const id = new URL(link.href, location.href).searchParams.get("v");
        if (!/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
        const titleNode = card.querySelector('h3[title], h3, a.ytLockupMetadataViewModelTitle');
        const viewNode = [...card.querySelectorAll("[aria-label]")].find((node) => /views?/i.test(node.getAttribute("aria-label") || ""));
        const dateNode = [...card.querySelectorAll("[aria-label]")].find((node) => /(?:ago|streamed|premiered)/i.test(node.getAttribute("aria-label") || ""));
        seen.add(id);
        rows.push({
          sourceRank: rows.length + 1,
          videoId: id,
          videoTitle: (titleNode?.getAttribute("title") || titleNode?.textContent || "").replace(/\s+/g, " ").trim(),
          channelId: channelMatch?.[1] || null,
          channelTitle: "KaraokeyTV",
          publicViewsText: viewNode?.getAttribute("aria-label") || viewNode?.textContent?.trim() || null,
          publishedText: dateNode?.getAttribute("aria-label") || dateNode?.textContent?.trim() || null,
          viewCount: null,
          likeCount: null,
          duration: null,
          definition: null,
          embeddable: null,
          madeForKids: null,
          apiAvailable: true
        });
      }
      return { channelId: channelMatch?.[1] || null, rows };
    });
    if (!extracted.channelId) throw new Error("The public page did not expose a verifiable official channel ID.");
    for (const item of extracted.rows) item.viewCount = parsePublicViews(item.publicViewsText);
    const entries = extracted.rows.map((candidate) => classifyCandidate(candidate, normalized.songs, extracted.channelId));
    const report = {
      version: 2,
      status: "DISCOVERY_COMPLETE",
      source: { handle: OFFICIAL_HANDLE, channelId: extracted.channelId, channelTitle: "KaraokeyTV", listing: "Official public Videos → Popular tab", method: "Playwright Chromium DOM extraction", url, loadedCards: extracted.rows.length },
      catalogBefore: catalog.length,
      catalogPlayableBefore: catalog.filter((song) => song.youtubeVideoId).length,
      catalogUnavailableBefore: catalog.filter((song) => !song.youtubeVideoId).length,
      candidatesDiscovered: extracted.rows.length,
      entries,
      counts: summarizeEntries(entries),
      controlEntries: await loadControlEntries(options),
      notes: ["Public view counts are the visible channel-page values at discovery time.", "The page's Popular tab was activated explicitly; sourceRank is DOM order after activation.", "No production catalog changes were made.", "Public-page metadata is not runtime playback evidence."]
    };
    await writeJsonAtomic(options.report, report);
    printDiscoverySummary(report);
    return report;
  } finally {
    await browser.close();
  }
}

async function buildManifest(options) {
  const report = JSON.parse(await readFile(options.report, "utf8"));
  const manifest = buildRuntimeManifest(report);
  await writeJsonAtomic(options.manifest, manifest);
  console.log(`Built runtime manifest with ${manifest.entries.length} entries: ${options.manifest}`);
  return manifest;
}

async function apply(options) {
  const catalog = JSON.parse(await readFile(options.catalog, "utf8"));
  const report = JSON.parse(await readFile(options.report, "utf8"));
  const runtime = JSON.parse(await readFile(options.runtime, "utf8"));
  const byVideo = new Map((runtime.entries || []).map((entry) => [entry.videoId, entry]));
  const existingKeys = new Set(catalog.map((song) => songIdentityKey(song.title, song.artist)));
  const existingTitles = new Set(catalog.map((song) => normalizeIdentityPart(song.title)));
  const existingVideos = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  const candidates = selectRuntimeCandidates(report.entries || [])
    .map((entry) => ({ entry, runtime: byVideo.get(entry.videoId) }))
    .filter(({ runtime }) => runtime?.iframeStatus === "PASS")
    .filter(({ entry }) => !existingKeys.has(entry.identityKey) && !existingTitles.has(normalizeIdentityPart(entry.title)) && !existingVideos.has(entry.videoId))
    .sort((a, b) => (a.entry.sourceRank || Number.MAX_SAFE_INTEGER) - (b.entry.sourceRank || Number.MAX_SAFE_INTEGER) || (b.entry.viewCount || 0) - (a.entry.viewCount || 0));
  const selected = candidates.slice(0, Math.max(0, Number(options.maxAdditions) || 100));
  if (!options.dryRun && selected.length > 0) {
    const lastId = Math.max(...catalog.map((song) => Number(String(song.id).replace(/^sample-/, "")) || 0));
    const additions = selected.map(({ entry }, index) => ({
      id: `sample-${String(lastId + index + 1).padStart(3, "0")}`,
      title: entry.title,
      artist: entry.artist,
      ...metadataForSong(entry, catalog),
      youtubeVideoId: entry.videoId,
      // Public channel Popular ordering is preserved in the ignored report,
      // but it is not the same thing as first-party karaoke usage evidence.
      // Keep demandTier unset until a supported demand source exists.
      demandTier: null,
      tags: [...new Set([...metadataForSong(entry, catalog).tags, "karaokeytv"]) ]
    }));
    await writeJsonAtomic(options.catalog, [...catalog, ...additions]);
    console.log(`Applied ${additions.length} runtime-PASS KaraokeyTV additions to ${options.catalog}.`);
  } else {
    console.log(`Dry run: ${selected.length} runtime-PASS additions are eligible; production catalog was not changed.`);
  }
  report.runtime = { path: options.runtime, pass: runtime.entries?.filter((entry) => entry.iframeStatus === "PASS").length || 0, candidatesTested: runtime.entries?.length || 0 };
  report.selectedForProduction = selected.map(({ entry, runtime: result }) => ({ ...entry, runtimeStatus: result.iframeStatus, playbackSeconds: result.playbackSeconds ?? null, decision: "ADDED" }));
  report.counts = { ...summarizeEntries(report.entries), runtimePassCandidates: candidates.length, added: selected.length };
  report.status = options.dryRun ? "READY_FOR_APPLY" : "APPLIED";
  await writeJsonAtomic(options.report, report);
  return selected;
}

async function loadControlEntries(options) {
  try {
    const manifest = JSON.parse(await readFile("tools/youtube-full-playability-audit.json", "utf8"));
    return (manifest.entries || []).filter((entry) => ["sample-029", "sample-001", "sample-002", "sample-003"].includes(entry.songId));
  } catch { return []; }
}

function summarizeEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return {
    existingSongDuplicates: list.filter((entry) => ["EXISTING_SONG", "EXISTING_UNAVAILABLE_SONG"].includes(entry.decision)).length,
    existingUnavailableSongDuplicates: list.filter((entry) => entry.decision === "EXISTING_UNAVAILABLE_SONG").length,
    duplicateVideoIds: list.filter((entry) => entry.decision === "DUPLICATE_VIDEO_ID").length,
    metadataIncomplete: list.filter((entry) => entry.decision === "METADATA_INCOMPLETE").length,
    prefilterRejected: list.filter((entry) => entry.decision === "REJECTED_PREFILTER").length,
    newCandidates: list.filter((entry) => entry.decision === "NEW_CANDIDATE").length
  };
}

function printDiscoverySummary(report) {
  console.log(`DISCOVERY | official channel ${report.source.channelId} | candidates ${report.candidatesDiscovered}`);
  console.log(`NEW CANDIDATES | ${report.counts.newCandidates}`);
  console.log(`EXISTING SONG DUPLICATES | ${report.counts.existingSongDuplicates}`);
  console.log(`EXISTING UNAVAILABLE DUPLICATES | ${report.counts.existingUnavailableSongDuplicates}`);
  console.log(`PREFILTER REJECTED | ${report.counts.prefilterRejected + report.counts.metadataIncomplete}`);
  console.log(`Report: ${DEFAULT_REPORT_PATH}`);
}

function getApiKey() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || !key.trim()) throw new Error("YOUTUBE_API_KEY is missing. Set it only in the local environment.");
  return key.trim();
}

function makeUrl(endpoint, params) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  return url;
}

async function requestJson(url, options) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try { response = await fetch(url); } catch (error) {
      if (attempt >= options.retryLimit) throw new Error(`YouTube API request failed after ${attempt + 1} attempt(s): ${error.message}`);
      await delay(options.baseDelayMs * 2 ** attempt);
      continue;
    }
    const body = await response.json().catch(() => null);
    if (response.ok) return body;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= options.retryLimit) throw new Error(`YouTube API request failed with HTTP ${response.status}.`);
    const retryAfter = Number(response.headers.get("retry-after"));
    await delay(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 15000) : options.baseDelayMs * 2 ** attempt);
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, Math.min(15000, Math.max(0, ms)))); }
function chunk(values, size) { const result = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function parseCount(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function parsePublicViews(value) {
  const text = String(value || "").replace(/,/g, "").trim();
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)([KMB])?/i);
  if (!match) return null;
  const multiplier = ({ k: 1e3, m: 1e6, b: 1e9 })[String(match[2] || "").toLowerCase()] || 1;
  return Math.round(Number(match[1]) * multiplier);
}

async function loadPlaywright() {
  const candidates = [process.env.KANTACUE_PLAYWRIGHT_MODULE, "playwright"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (candidate === "playwright") return await import(candidate);
      return await import(pathToFileURL(path.resolve(candidate)).href);
    } catch { /* try next */ }
  }
  throw new Error("Playwright is not resolvable. Set KANTACUE_PLAYWRIGHT_MODULE to the existing local runtime.");
}

async function writeJsonAtomic(filePath, value) {
  const target = path.resolve(filePath);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temp, target); return; }
    catch (error) {
      if (attempt >= 4) { await unlink(temp).catch(() => {}); throw error; }
      await delay(25 * 2 ** attempt);
    }
  }
}

function parseArgs(argv) {
  const options = { catalog: DEFAULT_CATALOG_PATH, report: DEFAULT_REPORT_PATH, runtime: DEFAULT_RUNTIME_PATH, manifest: DEFAULT_MANIFEST_PATH, maxPages: DEFAULT_MAX_PAGES, scrollRounds: 20, scrollDelayMs: 1200, retryLimit: 3, baseDelayMs: 750, maxAdditions: 100, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--catalog") options.catalog = argv[++index];
    else if (arg === "--report") options.report = argv[++index];
    else if (arg === "--runtime") options.runtime = argv[++index];
    else if (arg === "--manifest") options.manifest = argv[++index];
    else if (arg === "--max-pages") options.maxPages = Math.min(10, Math.max(1, Number(argv[++index])));
    else if (arg === "--scroll-rounds") options.scrollRounds = Math.min(40, Math.max(4, Number(argv[++index])));
    else if (arg === "--scroll-delay-ms") options.scrollDelayMs = Math.min(5000, Math.max(500, Number(argv[++index])));
    else if (arg === "--max-additions") options.maxAdditions = Math.min(100, Math.max(0, Number(argv[++index])));
    else if (arg === "--retry-limit") options.retryLimit = Math.min(5, Math.max(0, Number(argv[++index])));
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!options.command) options.command = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`KaraokeyTV expansion (development only)\n\nCommands:\n  discover       Fetch API popular candidates and persist the report\n  discover-public Activate the official public Popular tab and persist the report\n  build-manifest Build a runtime manifest for the real KantaCue Playwright runner\n  apply          Add only runtime-PASS candidates (use --dry-run to preview)\n\nOptions:\n  --max-pages N       API discovery pages of 50 results (default ${DEFAULT_MAX_PAGES})\n  --scroll-rounds N   Public-page scroll rounds (default 20)\n  --max-additions N   Maximum production additions, capped at 100\n  --report PATH       Candidate/runtime report path\n  --runtime PATH      Runtime PASS report path\n  --manifest PATH     Runtime manifest path\n  --dry-run           Never modify the production catalog\n\nDiscovery never promotes. Apply requires exact song/video duplicate checks and\niframe PASS evidence from the existing Playwright Chromium audit.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || !options.command) printHelp();
    else if (options.command === "discover") await discover(options);
    else if (options.command === "discover-public") await discoverPublic(options);
    else if (options.command === "build-manifest") await buildManifest(options);
    else if (options.command === "apply") await apply(options);
    else throw new Error(`Unknown command: ${options.command}`);
  } catch (error) {
    console.error(`KaraokeyTV expansion failed: ${error.message || error}`);
    process.exitCode = 1;
  }
}
