import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCatalog } from "../src/catalog.js";

const rawCatalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
const normalized = normalizeCatalog(rawCatalog, { logger: { warn() {} } });
const demand = JSON.parse(await readFile("data/song-demand.json", "utf8"));

const expectedAdditions = [
  ["sample-171", "MISS KITA", "J Brothers", "qlUB45wgDP8", 1, "24M"],
  ["sample-172", "LABIS NA NASAKTAN", "Jennelyn Yabu", "FpkaExjwMp4", 2, "23M"],
  ["sample-173", "IKAW ANG DAHILAN", "Jerry Angga", "F6yl_4xQFDQ", 3, "17M"],
  ["sample-174", "SANA'Y BIGYAN MO NG PANSIN", "J Brothers", "SSoEnWEKzi8", 4, "16M"],
  ["sample-175", "SANA'Y PAG-IBIG MO AY TUNAY NA", "J Brothers", "QC1P3hx9s0Y", 5, "16M"],
  ["sample-176", "PAG-IBIG KO SAYO'Y 'DI MAGBABAGO", "Men Oppose", "mJZaTeakC-8", 6, "15M"],
  ["sample-177", "SABIHIN MONG LAGI", "Men Oppose", "4ycKGkswKzI", 8, "8.4M"],
  ["sample-178", "MALING AKALA", "Chino Romero", "gzJ5qiKgKn8", 9, "7.9M"],
  ["sample-179", "IBAON MO", "Selina Sevilla", "DtozlmykZ1E", 10, "7.7M"],
  ["sample-180", "DI KO KAYA", "TeenHearts", "t2s9pYVPLOM", 11, "7.5M"],
  ["sample-181", "NASAAN KA", "Willy Garte", "cn9D7UFWmmw", 12, "7.1M"],
  ["sample-182", "KAILAN KAYA", "Leslie Montes", "BMyiHS2EX1o", 13, "5.6M"],
  ["sample-183", "BAKIT GALIT KA", "First Cousins", "Z4zmQ06gqQ8", 14, "4.9M"],
  ["sample-184", "TIBOK NG PUSO", "Willy Garte", "izz1jd1uOno", 16, "3.4M"],
  ["sample-185", "LUMAYO KA MAN SA AKIN", "Rodel Naval", "OX3-F-63hOk", 17, "3.3M"],
  ["sample-186", "PUSONG SALAWAHAN", "Mystica", "NnupTPbnBB4", 18, "3.3M"],
  ["sample-187", "NAMUMURO KA NA", "Lukas", "3hkcVJz9KpQ", 19, "2.9M"],
  ["sample-188", "HINDI AKO LARUAN", "Imelda Papin", "6fz-8CZxoS8", 20, "2.8M"],
  ["sample-189", "TUKSO", "Eva Eugenio", "vctcXJzGlS8", 21, "2.3M"],
  ["sample-190", "SABI MO AKO LAMANG", "Men Oppose", "8P7tRVEDncI", 22, "2.3M"]
];

function normalizedTitleArtist(song) {
  return `${song.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}\u0000${song.artist.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
}

test("AJ KARAOKE COVER additions match the inspected Popular ordering", () => {
  const songsById = new Map(rawCatalog.map((song) => [song.id, song]));
  const signalsById = new Map(demand.signals.map((signal) => [signal.songId, signal]));

  assert.equal(expectedAdditions.length, 20);
  assert.equal(normalized.rejectedRecords, 0);
  assert.deepEqual(expectedAdditions.map(([songId]) => songId), Array.from({ length: 20 }, (_, index) => `sample-${String(index + 171).padStart(3, "0")}`));

  for (const [songId, title, artist, videoId, rank, displayedViews] of expectedAdditions) {
    const song = songsById.get(songId);
    const signal = signalsById.get(songId);
    assert.deepEqual([song?.title, song?.artist, song?.youtubeVideoId], [title, artist, videoId], songId);
    assert.equal(song?.demandTier, rank <= 6 ? "very-high" : "high", songId);
    assert.equal(signal?.evidence[0]?.sourceId, "aj-karaoke-cover-popular-2026-09", songId);
    assert.equal(signal?.evidence[0]?.rank, rank, songId);
    assert.equal(signal?.evidence[0]?.displayedViews, displayedViews, songId);
  }
});

test("AJ additions do not create duplicate IDs, video IDs, or title/artist pairs", () => {
  assert.equal(new Set(rawCatalog.map((song) => song.id)).size, rawCatalog.length);
  assert.equal(new Set(rawCatalog.map((song) => song.youtubeVideoId).filter(Boolean)).size, rawCatalog.filter((song) => song.youtubeVideoId).length);
  assert.equal(new Set(rawCatalog.map(normalizedTitleArtist)).size, rawCatalog.length);
  assert.equal(rawCatalog.find((song) => song.id === "sample-120")?.youtubeVideoId, "aYuVq2sQ9Jo");
  assert.equal(rawCatalog.find((song) => song.title.toLowerCase() === "larawang kupas" && song.artist === "Jerome Abalos")?.id, "sample-120");
});

test("AJ Popular evidence is separate from technical verification and keeps the duplicate unchanged", () => {
  const source = demand.sources.find((item) => item.id === "aj-karaoke-cover-popular-2026-09");
  assert.ok(source);
  assert.equal(source.publisher, "AJ KARAOKE COVER");
  assert.match(source.url, /youtube\.com\/@AjKaraoke_Cover\/videos\?view=0&sort=p&flow=grid/);
  assert.equal(rawCatalog.find((song) => song.id === "sample-120")?.youtubeVideoId, "aYuVq2sQ9Jo");
  assert.equal(rawCatalog.filter((song) => song.title === "TUNAY NA NAGMAMAHAL" && song.artist === "J Brothers").length, 0);
});
