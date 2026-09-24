import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCatalog } from "../src/catalog.js";
import { getRecommendations } from "../src/recommendations.js";
import { rankSearchCandidates } from "../tools/verify-youtube.mjs";

const rawCatalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
const newSongs = rawCatalog.filter((song) => {
  const number = Number(String(song.id).replace(/^sample-/, ""));
  return number >= 146 && number <= 170;
});

test("batch 2 adds exactly 25 unique demand-backed songs after sample-145", async () => {
  assert.equal(newSongs.length, 25);
  assert.deepEqual(newSongs.map((song) => song.id), Array.from({ length: 25 }, (_, index) => `sample-${String(index + 146).padStart(3, "0")}`));
  assert.equal(new Set(rawCatalog.map((song) => song.id)).size, rawCatalog.length);
  const normalizedTitleArtists = rawCatalog.map((song) => `${song.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}\u0000${song.artist.toLowerCase().replace(/[^a-z0-9]+/g, "")}`);
  assert.equal(new Set(normalizedTitleArtists).size, rawCatalog.length);

  const demand = JSON.parse(await readFile("data/song-demand.json", "utf8"));
  const sourceIds = new Set(demand.sources.map((source) => source.id));
  const signals = new Map(demand.signals.map((signal) => [signal.songId, signal]));
  for (const song of newSongs) {
    const signal = signals.get(song.id);
    assert.ok(signal, song.id);
    assert.ok(["very-high", "high", "established"].includes(signal.demandTier), song.id);
    assert.ok(signal.evidence.length > 0);
    assert.ok(signal.evidence.every((evidence) => sourceIds.has(evidence.sourceId) && Number.isInteger(evidence.rank)));
    assert.equal(song.demandTier, signal.demandTier);
    if (["sample-166", "sample-168"].includes(song.id)) assert.equal(song.youtubeVideoId, null, song.id);
    else assert.ok(song.youtubeVideoId, song.id);
  }
});

test("new batch songs remain recommendation-eligible only after a verified playable ID exists", () => {
  const normalized = normalizeCatalog(rawCatalog, { logger: { warn() {} } }).songs;
  const unresolved = newSongs.filter((song) => !song.youtubeVideoId);
  assert.deepEqual(unresolved.map((song) => song.id), ["sample-166", "sample-168"]);
  assert.equal(getRecommendations(unresolved, {}, { limit: 5 }).length, 0);
  const playable = newSongs.filter((song) => song.youtubeVideoId);
  assert.equal(playable.length, 23);
  assert.equal(getRecommendations(playable, {}, { limit: 5 }).length, 5);
  assert.equal(normalized.filter((song) => song.id >= "sample-146").length, 25);
});

test("the existing production ranking gates quality before popularity", () => {
  const ranked = rankSearchCandidates(
    { title: "Batch Song", artist: "Known Artist" },
    [
      { videoId: "aaaaaaaaaaa", videoTitle: "Batch Song - Known Artist Karaoke", channelTitle: "Established Karaoke", definition: "hd", viewCount: 1200000, publishedAt: "2022-01-01T00:00:00Z", apiVerified: true, embeddable: true, madeForKids: false },
      { videoId: "bbbbbbbbbbb", videoTitle: "Batch Song - Known Artist Live Karaoke", channelTitle: "Established Karaoke", definition: "hd", viewCount: 90000000, publishedAt: "2018-01-01T00:00:00Z", apiVerified: true, embeddable: true, madeForKids: false },
      { videoId: "ccccccccccc", videoTitle: "Batch Song - Known Artist Karaoke", channelTitle: "Established Karaoke", definition: "sd", viewCount: 100000000, publishedAt: "2018-01-01T00:00:00Z", apiVerified: true, embeddable: true, madeForKids: false },
      { videoId: "ddddddddddd", videoTitle: "Batch Song - Known Artist Karaoke", channelTitle: "Party Tyme Karaoke Channel", definition: "hd", viewCount: 100000000, publishedAt: "2018-01-01T00:00:00Z", apiVerified: true, embeddable: true, madeForKids: false }
    ]
  );
  assert.equal(ranked[0].videoId, "aaaaaaaaaaa");
  assert.equal(ranked.find((candidate) => candidate.videoId === "bbbbbbbbbbb").selectable, false);
  assert.equal(ranked.find((candidate) => candidate.videoId === "ccccccccccc").selectable, false);
  assert.equal(ranked.find((candidate) => candidate.videoId === "ddddddddddd").selectable, false);
});
