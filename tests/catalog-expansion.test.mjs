import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCatalog } from "../src/catalog.js";
import { createSearchIndex, getDiscoverySongs } from "../src/discovery.js";
import { getRecommendations } from "../src/recommendations.js";

const rawCatalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
const normalized = normalizeCatalog(rawCatalog, { logger: { warn() {} } });

const baselinePromotedIds = {
  "sample-001": "MJd_6nqxIYw",
  "sample-002": "EAkIjq46Rlg",
  "sample-003": "hNmgGtSTqb8",
  "sample-004": "a3vO3thiYV4",
  "sample-005": "acPB4mDoRZY",
  "sample-006": "-TWflZWV6C8",
  "sample-007": "UVea7f7tyKg",
  "sample-011": "lXnHfM6pDKw",
  "sample-012": "4QdkGihjFoM",
  "sample-013": "MfEaylAx7Mk",
  "sample-014": "TbJyk49XX8Q",
  "sample-015": "gw8z4fSkV5A",
  "sample-016": "v5_CXC8HVzI",
  "sample-017": "EIe03DLVvcU",
  "sample-018": "Ym38LjJsE7Q",
  "sample-019": "r0lS1NIbqyg",
  "sample-020": "tBvLeaU411w",
  "sample-021": "K1Ys4LV1D5Q",
  "sample-022": "C8twukz-0g0",
  "sample-023": "rAqrj4Fse8k",
  "sample-024": "2QcJ8lwbtsE",
  "sample-025": "DaDWBKABYmU",
  "sample-026": "zfEaYbWoxko",
  "sample-027": "U59si105SaE",
  "sample-028": "NTKklJficS8",
  "sample-029": "QBb9wO3Bj0k",
  "sample-030": "ZG4W4sqMS_U",
  "sample-031": "DuqjG3vWiUo",
  "sample-032": "KnSsOL-n9r0",
  "sample-033": "c7qAHxBt-z4",
  "sample-034": "-2hvWP9Hulg",
  "sample-035": "tzbsJjq7MME",
  "sample-036": "hbn7b1T_SQo",
  "sample-037": "tY8o1TD_frk",
  "sample-038": "yi1jwM6WIPk",
  "sample-039": "fbk5bwNCIng",
  "sample-040": "hHLKw2SmWz0",
  "sample-041": "sQOIU-tO3SA",
  "sample-043": "Zy1rjdnjGg8",
  "sample-044": "ee9LfX4P9Us",
  "sample-045": "nci9aK4fboU",
  "sample-046": "k3Vcm0Nw_nU",
  "sample-047": "1IWqURONwoA",
  "sample-048": "ULfqKMGSFuo",
  "sample-049": "Ls4mFGU2HQg",
  "sample-050": "f9-DjRVuzgk",
  "sample-051": "DSsnMIsMas8",
  "sample-052": "6p4HS_H4p_o",
  "sample-053": "DIVOBV2eaM4",
  "sample-054": "RDc_QsLE75o",
  "sample-055": "HValnEZ-eLE",
  "sample-056": "PZt0dFlPxEw",
  "sample-057": "Qyc-as1mx7s",
  "sample-058": "rRDYOBa6ySA",
  "sample-059": "VXcGsSO6_io",
  "sample-060": "uK7zpeG6jeE",
  "sample-061": "tZOQeEzjaBE",
  "sample-062": "xuGZr7WWpkM",
  "sample-063": "42gq2tqst8w",
  "sample-064": "UwvRIwRG7_o",
  "sample-065": "1MwpsJdi7MM",
  "sample-066": "3CIw7iRuWgU",
  "sample-067": "8BRmS7BO2j8",
  "sample-068": "CMK4tmo9b4g",
  "sample-069": "qTWdhI1bMJs",
  "sample-070": "Be4jxRrths0",
  "sample-087": "1NChdqcgmeI"
};

const newlyPromotedIds = {
  "sample-101": "9hrT301x000",
  "sample-102": "ZFBdzKUp-JI",
  "sample-103": "-Ji_rJnKB_c",
  "sample-104": "gMetRQodtF8",
  "sample-105": "OsxDn74jIbY",
  "sample-106": "CDVYjRyw_aM",
  "sample-107": "2FBF7arHW5c",
  "sample-108": "CTM7tXU4FbY",
  "sample-109": "cehpq0qcF7k",
  "sample-110": "leP8DEWLkZc",
  "sample-111": "dWpBJUAV5N0",
  "sample-112": "xOv6__Hk5mY",
  "sample-113": "Ij3MFqfDUdo",
  "sample-114": "WeI_LxDZFs4",
  "sample-115": "v7pVBAebzkw",
  "sample-116": "bk3vAuiGHxI",
  "sample-117": "Lcn2v1gfzpA",
  "sample-118": "R5aWjamIf_Q",
  "sample-119": "cBO0_dhukb4",
  "sample-120": "aYuVq2sQ9Jo",
  "sample-122": "1LikErFudsc",
  "sample-123": "hrtSi9pfMGc",
  "sample-124": "j1B-M559MJo",
  "sample-125": "F2qvj4yU3VI",
  "sample-126": "UcWEfvu6F_s",
  "sample-127": "geFcauqvN4E",
  "sample-128": "3cwFlAjSg9Y",
  "sample-129": "iPy2YPjlrrY",
  "sample-130": "GK0hisiU6-c",
  "sample-131": "13AOpqkuh5U",
  "sample-132": "THBqaXIyv-w",
  "sample-133": "WT3sn5gV8iA",
  "sample-134": "nawRw6pR_f8",
  "sample-135": "ycotHxAZTLE",
  "sample-136": "UA7dQKS94jI",
  "sample-137": "O7xFdFjW0nQ",
  "sample-138": "UPRhGxdLWSI",
  "sample-140": "m_q_KX6Brso",
  "sample-141": "DRKyel8tmxU",
  "sample-142": "0V0yLCvOrYY",
  "sample-144": "LEp8jEFINPU"
};

test("expanded catalog has contiguous IDs, valid metadata, and no duplicate songs", () => {
  assert.equal(rawCatalog.length, 170);
  assert.equal(normalized.rejectedRecords, 0);
  assert.deepEqual(rawCatalog.map((song) => song.id), Array.from({ length: 170 }, (_, index) => `sample-${String(index + 1).padStart(3, "0")}`));
  assert.equal(new Set(rawCatalog.map((song) => song.id)).size, 170);
  assert.equal(new Set(rawCatalog.map((song) => `${song.title.trim().toLocaleLowerCase()}\u0000${song.artist.trim().toLocaleLowerCase()}`)).size, 170);
  assert.equal(normalized.songs.length, 170);
  assert.deepEqual(normalized.warnings, []);
});

test("unrelated promoted IDs and protected null assignments remain unchanged", () => {
  for (const [songId, videoId] of Object.entries(baselinePromotedIds)) {
    assert.equal(rawCatalog.find((song) => song.id === songId)?.youtubeVideoId, videoId, songId);
  }

  assert.equal(Object.keys(baselinePromotedIds).length, 67);
  for (const [songId, videoId] of Object.entries(newlyPromotedIds)) {
    assert.equal(rawCatalog.find((song) => song.id === songId)?.youtubeVideoId, videoId, songId);
  }

  assert.equal(Object.keys(newlyPromotedIds).length, 41);
  assert.equal(rawCatalog.filter((song) => song.youtubeVideoId !== null).length, 151);
  assert.equal(rawCatalog.filter((song) => song.youtubeVideoId === null).length, 19);
  for (const songId of ["sample-010", "sample-078", "sample-088", "sample-091", "sample-092", "sample-093", "sample-095", "sample-096"]) {
    assert.equal(rawCatalog.find((song) => song.id === songId)?.youtubeVideoId, null, songId);
  }
  assert.equal(rawCatalog.find((song) => song.id === "sample-008")?.youtubeVideoId, null);
  assert.equal(rawCatalog.find((song) => song.id === "sample-009")?.youtubeVideoId, null);
  assert.equal(rawCatalog.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
});

test("new catalog records use current validator categories and preserve unresolved null IDs", () => {
  const newSongs = rawCatalog.slice(37);
  assert.equal(newSongs.length, 133);
  const unassignedNewSongs = newSongs.filter((song) => song.youtubeVideoId === null);
  assert.deepEqual(unassignedNewSongs.map((song) => song.id), [
    "sample-042", "sample-072", "sample-078", "sample-084", "sample-088", "sample-091", "sample-092", "sample-093", "sample-095", "sample-096",
    "sample-121", "sample-139", "sample-143", "sample-145",
    "sample-166", "sample-168"
  ]);
  assert.ok(newSongs.every((song) => ["easy", "medium", "hard"].includes(song.difficulty)));
  assert.ok(newSongs.every((song) => ["low", "medium", "high"].includes(song.vocalRange)));
  assert.ok(newSongs.every((song) => ["solo", "duet", "group"].includes(song.performanceType)));
  assert.ok(newSongs.every((song) => /^\d{4}s$/.test(song.era)));
  assert.ok(newSongs.every((song) => Array.isArray(song.mood) && song.mood.length > 0));
  assert.ok(newSongs.every((song) => Array.isArray(song.tags) && song.tags.length > 0));
});

test("demand metadata is evidence-backed and current availability remains explicit", async () => {
  const demand = JSON.parse(await readFile("data/song-demand.json", "utf8"));
  const sourceIds = new Set(demand.sources.map((source) => source.id));
  const catalogById = new Map(rawCatalog.map((song) => [song.id, song]));
  assert.equal(demand.signals.length, 83);
  assert.ok(demand.signals.every((signal) => catalogById.has(signal.songId)));
  assert.ok(demand.signals.every((signal) => ["very-high", "high", "established"].includes(signal.demandTier)));
  assert.ok(demand.signals.every((signal) => signal.evidence.length > 0 && signal.evidence.every((item) => sourceIds.has(item.sourceId) && Number.isInteger(item.rank))));
  assert.deepEqual(rawCatalog.slice(100).filter((song) => song.youtubeVideoId === null).map((song) => song.id), [
    "sample-121", "sample-139", "sample-143", "sample-145",
    "sample-166", "sample-168"
  ]);
  for (const [songId, videoId] of Object.entries(newlyPromotedIds)) {
    assert.equal(catalogById.get(songId)?.youtubeVideoId, videoId, songId);
  }
  assert.ok(rawCatalog.slice(100).every((song) => demand.signals.some((signal) => signal.songId === song.id)));
});

test("newly playable songs flow through local discovery and recommendations", () => {
  const targetSongs = normalized.songs.filter((song) => {
    const number = Number(String(song.id).replace(/^sample-/, ""));
    return number >= 101 && number <= 170;
  });
  const playableTargetSongs = targetSongs.filter((song) => song.youtubeVideoId);
  const searchIndex = createSearchIndex(normalized.songs);
  const searchResults = getDiscoverySongs(searchIndex, { query: "Kung Sakali" });
  const recommendations = getRecommendations(playableTargetSongs, {}, { limit: 5, now: "2026-09-22T00:00:00.000Z" });

  assert.equal(playableTargetSongs.length, 64);
  assert.equal(searchResults.find((song) => song.id === "sample-101")?.id, "sample-101");
  assert.equal(recommendations.length, 5);
  assert.ok(recommendations.every((item) => playableTargetSongs.includes(item.song)));
  assert.deepEqual(getRecommendations(targetSongs.filter((song) => !song.youtubeVideoId), {}, { now: "2026-09-22T00:00:00.000Z" }), []);
});
