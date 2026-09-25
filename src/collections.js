import { isPlayableSong } from "./discovery.js?v=4";

export const LOCAL_COLLECTIONS = [
  { id: "friday-night", title: "Friday Night Karaoke", description: "Big choruses and room-ready picks.", matches: (song) => hasAny(song, ["party", "energetic", "celebratory"]) || ["Pop", "Pop Rock", "Rock"].includes(song.genre) },
  { id: "opm-classics", title: "OPM Classics", description: "Filipino favorites with staying power.", matches: (song) => isLanguage(song, "filipino") && /classic|throwback|oldies|90s|2000s/i.test(`${song.era} ${(song.tags || []).join(" ")}`) },
  { id: "easy-tonight", title: "Easy Songs Tonight", description: "Comfortable songs for a confident round.", matches: (song) => song.difficulty === "easy" },
  { id: "duets-two", title: "Duets for Two", description: "Pass the mic and share the chorus.", matches: (song) => song.performanceType === "duet" },
  { id: "throwbacks", title: "90s / 2000s Throwbacks", description: "Familiar songs from earlier nights out.", matches: (song) => ["1990s", "2000s"].includes(song.era) }
];

export function getCollectionDefinition(collectionId) {
  return LOCAL_COLLECTIONS.find((collection) => collection.id === collectionId) || LOCAL_COLLECTIONS[0];
}

export function getCollectionSongs(collectionId, songs = [], limit = 5) {
  const definition = getCollectionDefinition(collectionId);
  return (Array.isArray(songs) ? songs : [])
    .filter(isPlayableSong)
    .filter(definition.matches)
    .slice(0, Math.max(0, Number(limit) || 5));
}

export function getFeaturedCollectionId(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return LOCAL_COLLECTIONS[0].id;
  if (date.getDay() === 5) return "friday-night";
  const week = getWeekNumber(date);
  return LOCAL_COLLECTIONS[week % LOCAL_COLLECTIONS.length].id;
}

function isLanguage(song, language) {
  return String(song?.language || "").toLowerCase() === language;
}

function hasAny(song, values) {
  const haystack = [song?.mood, ...(song?.tags || [])].map((value) => String(value).toLowerCase());
  return values.some((value) => haystack.some((item) => item.includes(value)));
}

function getWeekNumber(date) {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.floor((date - start) / 604800000);
}
