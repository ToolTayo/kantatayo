import { getRecommendations } from "./recommendations.js";
import { isPlayableSong } from "./discovery.js?v=6";

const THROWBACK_ERAS = new Set(["1960s", "1970s", "1980s", "1990s", "2000s"]);
const DEMAND_TIERS = new Set(["very-high", "high", "established"]);
export const MAX_FIND_SONG_MODES = 2;

/**
 * Small, honest decision prompts for the catalog. Each prompt is backed by
 * existing song metadata; options with no playable matches are not shown.
 */
export const FIND_SONG_MODES = Object.freeze([
  { id: "easy", label: "Easy", description: "Songs rated easy in the catalog", matches: (song) => normalize(song?.difficulty) === "easy" },
  { id: "love", label: "Love", description: "Songs tagged with a love mood", matches: (song) => hasMood(song, "love") },
  { id: "power", label: "Power vocals", description: "Songs with the explicit power-vocal tag", matches: (song) => hasTag(song, "power-vocal") },
  { id: "opm", label: "OPM", description: "Filipino-language or OPM-tagged songs", matches: (song) => normalize(song?.language) === "filipino" || hasTag(song, "opm") },
  { id: "throwback", label: "Throwback", description: "Songs from earlier eras or tagged classic/nostalgic", matches: (song) => THROWBACK_ERAS.has(normalize(song?.era)) || hasTag(song, "classics") || hasTag(song, "nostalgic") },
  { id: "duet", label: "Duet", description: "Songs explicitly tagged as duets", matches: (song) => normalize(song?.performanceType) === "duet" },
  { id: "popular", label: "Popular", description: "Ranked in karaoke-use or provider-view data", matches: (song) => DEMAND_TIERS.has(normalize(song?.demandTier)) }
]);

export const FIND_SONG_LIMIT = 3;

export function getFindSongModeOptions(songs = []) {
  const playable = (Array.isArray(songs) ? songs : []).filter(isFindSongEligible);
  return FIND_SONG_MODES
    .map((mode) => ({ ...mode, count: playable.filter((song) => mode.matches(song)).length }))
    .filter((mode) => mode.count > 0);
}

export function getFindSongRecommendations(songs = [], userState = {}, options = {}) {
  const selectedModes = normalizeModeIds(options.modes);
  const limit = Math.max(1, Number(options.limit) || FIND_SONG_LIMIT);
  const safeSongs = (Array.isArray(songs) ? songs : []).filter(isFindSongEligible);
  if (safeSongs.length === 0) return [];

  // Ask the existing recommendation engine for the selected subset first,
  // then add only the explicit Find My Song signal. This preserves dislikes,
  // queue/current-song exclusions, history decay and artist diversity without
  // turning each click into an O(n²) ranking pass over the full catalog.
  const modeSongs = selectedModes.length
    ? safeSongs.filter((song) => selectedModes.some((modeId) => matchesMode(song, modeId)))
    : safeSongs;
  const baseline = selectedModes.length || !Array.isArray(options.baseline)
    ? getRecommendations(modeSongs, userState, {
      limit: Math.min(modeSongs.length, 24),
      now: options.now,
      session: options.session
    })
    : options.baseline;
  const pool = baseline;
  const scored = pool.map((item) => {
    const matchedModes = selectedModes.filter((modeId) => matchesMode(item.song, modeId));
    const modeBoost = matchedModes.length * 20 + (matchedModes.length === selectedModes.length && matchedModes.length > 1 ? 5 : 0);
    return {
      ...item,
      score: item.score + modeBoost,
      matchedModes,
      reason: matchedModes.length > 0 ? formatFindSongReason(matchedModes) : item.reason
    };
  }).sort((left, right) => right.score - left.score
    || left.song.title.localeCompare(right.song.title)
    || left.song.id.localeCompare(right.song.id));

  const result = [];
  const artists = new Set();
  for (const item of scored) {
    const artist = normalize(item.song.artist);
    if (result.length >= limit) break;
    if (artists.has(artist) && scored.some((candidate) => !artists.has(normalize(candidate.song.artist)))) continue;
    result.push(item);
    artists.add(artist);
  }
  return result;
}

export function matchesFindSongMode(song, modeId) {
  const mode = FIND_SONG_MODES.find((candidate) => candidate.id === modeId);
  return Boolean(mode?.matches(song));
}

export function formatFindSongReason(modeIds = []) {
  const labels = normalizeModeIds(modeIds)
    .map((id) => FIND_SONG_MODES.find((mode) => mode.id === id)?.label)
    .filter(Boolean);
  return labels.length ? `Matches your ${labels.join(" + ")}` : "A strong playable pick";
}

export function toggleFindSongModeSelection(currentModes = [], modeId) {
  const modes = normalizeModeIds(currentModes);
  if (!FIND_SONG_MODES.some((mode) => mode.id === modeId)) return { modes, replacedModeId: "" };
  if (modes.includes(modeId)) return { modes: modes.filter((id) => id !== modeId), replacedModeId: "" };
  if (modes.length < MAX_FIND_SONG_MODES) return { modes: [...modes, modeId], replacedModeId: "" };
  return { modes: [...modes.slice(1), modeId], replacedModeId: modes[0] || "" };
}

function normalizeModeIds(value) {
  const ids = Array.isArray(value) ? value : [];
  return [...new Set(ids.filter((id) => FIND_SONG_MODES.some((mode) => mode.id === id)))];
}

function matchesMode(song, modeId) {
  return matchesFindSongMode(song, modeId);
}

function hasMood(song, mood) {
  return Array.isArray(song?.mood) && song.mood.some((value) => normalize(value) === mood);
}

function hasTag(song, tag) {
  return Array.isArray(song?.tags) && song.tags.some((value) => normalize(value) === tag);
}

function isFindSongEligible(song) {
  return isPlayableSong(song)
    && typeof song.title === "string" && song.title.trim().length > 0
    && typeof song.artist === "string" && song.artist.trim().length > 0;
}

function normalize(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
