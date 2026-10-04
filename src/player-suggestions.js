import { isValidYouTubeVideoId } from "./youtube.js";
import { isPlayableMedley } from "./medleys.js";

export const PLAYER_SUGGESTION_LIMIT = 4;

/**
 * Keep player suggestions as a presentation-level slice of the existing
 * recommendation snapshot. The scoring, preference signals, and exclusions
 * remain owned by recommendations.js. When catalogSongs is supplied, the
 * returned object is always the canonical validated catalog record rather
 * than a stale snapshot copy.
 */
export function getSongPlayerSuggestions(recommendations = [], options = {}) {
  const limit = normalizeLimit(options.limit);
  const excludedIds = toKeySet([
    options.currentId,
    ...(Array.isArray(options.queuedIds) ? options.queuedIds : []),
    ...(Array.isArray(options.excludeIds) ? options.excludeIds : [])
  ]);
  const excludedVideoIds = toKeySet(options.excludeVideoIds);
  const hasCatalog = Array.isArray(options.catalogSongs);
  const catalogById = hasCatalog
    ? new Map(options.catalogSongs
      .filter((song) => song && typeof song.id === "string")
      .map((song) => [normalizeKey(song.id), song]))
    : null;
  const seenIds = new Set();
  const seenVideoIds = new Set();
  const suggestions = [];

  for (const recommendation of Array.isArray(recommendations) ? recommendations : []) {
    const candidateSong = recommendation?.song;
    const candidateId = normalizeKey(candidateSong?.id);
    const song = hasCatalog ? catalogById.get(candidateId) : candidateSong;
    const id = normalizeKey(song?.id);
    const videoId = normalizeKey(song?.youtubeVideoId);
    if (!id || !song || excludedIds.has(id) || excludedVideoIds.has(videoId) || !isValidYouTubeVideoId(song.youtubeVideoId)) continue;
    if (seenIds.has(id) || seenVideoIds.has(videoId)) continue;
    seenIds.add(id);
    seenVideoIds.add(videoId);
    suggestions.push({
      type: "song",
      song,
      reason: typeof recommendation.reason === "string" && recommendation.reason.trim()
        ? recommendation.reason.trim()
        : "A playable karaoke pick"
    });
    if (suggestions.length >= limit) break;
  }

  return suggestions;
}

/**
 * Medleys stay outside song recommendations and user song signals. Their
 * small deterministic ranking uses only verified medley metadata.
 */
export function getMedleyPlayerSuggestions(currentMedley, medleys = [], options = {}) {
  const limit = normalizeLimit(options.limit);
  const currentId = normalizeKey(currentMedley?.id);
  const excludedIds = toKeySet([
    currentId,
    ...(Array.isArray(options.excludeIds) ? options.excludeIds : [])
  ]);
  const currentProvider = normalizeValue(currentMedley?.provider);
  const currentLanguage = normalizeValue(currentMedley?.language);
  const currentTheme = normalizeValue(currentMedley?.theme);
  const seenIds = new Set();
  const seenVideoIds = new Set();

  return (Array.isArray(medleys) ? medleys : [])
    .filter((medley) => {
      const id = normalizeKey(medley?.id);
      const videoId = normalizeKey(medley?.videoId);
      const available = isPlayableMedley(medley)
        && id
        && !excludedIds.has(id)
        && !seenIds.has(id)
        && !seenVideoIds.has(videoId);
      if (available) {
        seenIds.add(id);
        seenVideoIds.add(videoId);
      }
      return available;
    })
    .map((medley) => {
      const id = normalizeKey(medley.id);
      const videoId = normalizeKey(medley.videoId);
      const sameProvider = normalizeValue(medley.provider) === currentProvider;
      const sameLanguage = normalizeValue(medley.language) === currentLanguage;
      const sameTheme = normalizeValue(medley.theme) === currentTheme;
      const score = (sameTheme ? 3 : 0) + (sameProvider ? 3 : 0) + (sameLanguage ? 2 : 0) + (medley.sectionStatus === "known" ? 1 : 0);
      return {
        type: "medley",
        medley,
        score,
        reason: getMedleyReason({ sameProvider, sameLanguage, sameTheme, theme: medley.theme, language: medley.language, provider: medley.provider })
      };
    })
    .sort((left, right) => right.score - left.score
      || compareText(left.medley.title, right.medley.title)
      || compareText(left.medley.id, right.medley.id))
    .slice(0, limit)
    .map(({ score, ...suggestion }) => suggestion);
}

function getMedleyReason({ sameProvider, sameLanguage, sameTheme, theme, language, provider }) {
  if (sameTheme && sameProvider) return `More ${theme} medleys from ${provider}`;
  if (sameTheme) return `More ${theme} medleys`;
  if (sameLanguage) return `More ${language} medleys`;
  if (sameProvider) return `More medleys from ${provider}`;
  return "Another verified karaoke medley";
}

function normalizeLimit(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, PLAYER_SUGGESTION_LIMIT) : PLAYER_SUGGESTION_LIMIT;
}

function toKeySet(values) {
  return new Set((Array.isArray(values) ? values : [values]).map(normalizeKey).filter(Boolean));
}

function normalizeKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base" });
}
