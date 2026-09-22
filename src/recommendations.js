import { isValidYouTubeVideoId } from "./youtube.js";

export const RECOMMENDATION_LIMIT = 5;
export const MAX_RECENT_RECOMMENDATIONS = 20;

/**
 * Transparent local ranking model. A playable song starts with +16, each
 * matching preference adds +10, demand adds a small cold-start prior, direct likes/favorites add +22/+18, and
 * metadata similarity to liked/favorite/sung songs contributes up to +20/+16/+7.
 * A recent performance subtracts up to 48 with a 14-day half-life; queued,
 * current, unplayable, and directly disliked songs are excluded. Recent
 * recommendations and repeated artists receive soft penalties so the pool
 * stays available while refreshes still feel varied.
 */
export const RECOMMENDATION_WEIGHTS = Object.freeze({
  PLAYABLE: 16,
  PREFERENCE_MATCH: 10,
  DIRECT_LIKE: 22,
  DIRECT_FAVORITE: 18,
  LIKED_SIMILARITY: 20,
  FAVORITE_SIMILARITY: 16,
  SUNG_SIMILARITY: 7,
  RECENT_SUNG_MAX: 48,
  RECENT_RECOMMENDATION: 14,
  ARTIST_REPEAT: 12,
  PROFILE_REPEAT: 4
});

export const DEMAND_WEIGHTS = Object.freeze({
  "very-high": 12,
  high: 8,
  established: 4
});

const PREFERENCE_FIELDS = [
  ["languages", "language", "language"],
  ["genres", "genre", "genre"],
  ["moods", "mood", "mood"],
  ["difficulties", "difficulty", "difficulty"],
  ["vocalRanges", "vocalRange", "vocal range"],
  ["performanceTypes", "performanceType", "performance type"],
  ["eras", "era", "era"]
];

const SIMILARITY_WEIGHTS = Object.freeze({
  language: 0.2,
  genre: 0.2,
  mood: 0.18,
  difficulty: 0.08,
  vocalRange: 0.1,
  performanceType: 0.1,
  era: 0.06,
  tags: 0.08
});

export function getRecommendations(songs = [], userState = {}, options = {}) {
  const limit = clampLimit(options.limit ?? RECOMMENDATION_LIMIT);
  const nowMs = getNowMs(options.now);
  const safeSongs = Array.isArray(songs) ? songs.filter(isUsableSong) : [];
  const dislikedIds = toIdSet(userState.dislikedSongs);
  const queuedIds = toIdSet(userState.queue);
  const currentId = normalizeId(userState.currentSongId);
  const recentRecommendationIds = toIdSet(userState.recentRecommendations);
  const likedIds = toIdSet(userState.likedSongs);
  const favoriteIds = toIdSet(userState.favorites);
  const history = normalizeHistory(userState.sungHistory);
  const songsById = new Map(safeSongs.map((song) => [song.id.toLowerCase(), song]));

  const likedReferences = [...likedIds].map((id) => songsById.get(id)).filter(Boolean);
  const favoriteReferences = [...favoriteIds].map((id) => songsById.get(id)).filter(Boolean);
  const sungReferences = history.map((entry) => songsById.get(entry.id.toLowerCase())).filter(Boolean);

  const candidates = safeSongs
    .filter((song) => {
      const key = song.id.toLowerCase();
      return !dislikedIds.has(key) && !queuedIds.has(key) && key !== currentId.toLowerCase();
    })
    .map((song) => scoreRecommendationCandidate(song, {
      preferences: userState.preferences,
      likedIds,
      favoriteIds,
      likedReferences,
      favoriteReferences,
      sungReferences,
      history,
      recentRecommendationIds,
      nowMs
    }));

  const selected = [];
  while (selected.length < limit && candidates.length > 0) {
    candidates.sort((left, right) => compareCandidates(left, right, selected));
    const next = candidates.shift();
    const artistAlreadyUsed = selected.some((item) => sameValue(item.song.artist, next.song.artist));
    const profileAlreadyUsed = selected.some((item) => profileKey(item.song) === profileKey(next.song));
    const diversityPenalty = (artistAlreadyUsed ? RECOMMENDATION_WEIGHTS.ARTIST_REPEAT : 0) + (profileAlreadyUsed ? RECOMMENDATION_WEIGHTS.PROFILE_REPEAT : 0);
    const signals = { ...next.signals, artistDiversity: selected.length > 0 && !artistAlreadyUsed };
    selected.push({
      song: next.song,
      score: next.score - diversityPenalty,
      reason: buildReason(signals),
      signals
    });
  }

  return selected;
}

export function scoreRecommendationCandidate(song, context = {}) {
  const preferences = context.preferences || {};
  const likedIds = context.likedIds || new Set();
  const favoriteIds = context.favoriteIds || new Set();
  const recentRecommendationIds = context.recentRecommendationIds || new Set();
  const history = Array.isArray(context.history) ? context.history : [];
  const nowMs = Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
  const key = normalizeId(song?.id).toLowerCase();
  const preferenceMatches = getPreferenceMatches(song, preferences);
  const likedSimilarity = maxSimilarity(song, context.likedReferences || []);
  const favoriteSimilarity = maxSimilarity(song, context.favoriteReferences || []);
  const sungSimilarity = maxSimilarity(song, context.sungReferences || []);
  const latestSungAt = history.find((entry) => entry.id.toLowerCase() === key)?.sungAt;
  const recentSungPenalty = latestSungAt ? getRecentSungPenalty(latestSungAt, nowMs) : 0;
  const recentRecommendationPenalty = recentRecommendationIds.has(key) ? RECOMMENDATION_WEIGHTS.RECENT_RECOMMENDATION : 0;
  const demandTier = normalizeDemandTier(song?.demandTier);
  const demandSignal = demandTier ? DEMAND_WEIGHTS[demandTier] : 0;
  const signals = {
    playable: isUsableSong(song),
    preferenceMatches,
    directLiked: likedIds.has(key),
    directFavorite: favoriteIds.has(key),
    likedSimilarity,
    favoriteSimilarity,
    sungSimilarity,
    recentSungPenalty,
    recentRecommendationPenalty,
    demandTier,
    demandSignal,
    artistDiversity: true
  };

  const score = (signals.playable ? RECOMMENDATION_WEIGHTS.PLAYABLE : 0)
    + preferenceMatches.length * RECOMMENDATION_WEIGHTS.PREFERENCE_MATCH
    + (signals.directLiked ? RECOMMENDATION_WEIGHTS.DIRECT_LIKE : 0)
    + (signals.directFavorite ? RECOMMENDATION_WEIGHTS.DIRECT_FAVORITE : 0)
    + likedSimilarity * RECOMMENDATION_WEIGHTS.LIKED_SIMILARITY
    + favoriteSimilarity * RECOMMENDATION_WEIGHTS.FAVORITE_SIMILARITY
    + sungSimilarity * RECOMMENDATION_WEIGHTS.SUNG_SIMILARITY
    + demandSignal
    - recentSungPenalty
    - recentRecommendationPenalty;

  return { song, score, reason: buildReason(signals), signals };
}

export function getRecentSungPenalty(sungAt, nowMs = Date.now()) {
  const timestamp = Date.parse(sungAt);
  if (Number.isNaN(timestamp)) return 0;
  const ageDays = Math.max(0, (nowMs - timestamp) / 86400000);
  const halfLifeDays = 14;
  return RECOMMENDATION_WEIGHTS.RECENT_SUNG_MAX * Math.pow(0.5, ageDays / halfLifeDays);
}

export function buildReason(signals = {}) {
  const preferenceMatches = Array.isArray(signals.preferenceMatches) ? signals.preferenceMatches : [];
  if (preferenceMatches.length > 0) return `Matches your ${joinLabels(preferenceMatches)} preferences`;
  if (signals.directLiked) return "Because you liked this song before";
  if (signals.directFavorite) return "Because you favorited this song before";
  if (signals.likedSimilarity > 0 || signals.favoriteSimilarity > 0) return "Similar to songs you liked or favorited";
  if (signals.sungSimilarity > 0) return "A familiar fit based on songs you have sung";
  if (signals.demandTier) return "A popular karaoke pick";
  if (signals.artistDiversity) return "A different artist for variety";
  return "A playable karaoke pick";
}

function getPreferenceMatches(song, preferences) {
  return PREFERENCE_FIELDS.reduce((matches, [preferenceKey, songKey, label]) => {
    const selected = toValueSet(preferences[preferenceKey]);
    if (selected.size === 0) return matches;
    const values = toValueSet(song?.[songKey]);
    const matchedValue = [...values].find((value) => selected.has(value));
    if (matchedValue) matches.push({ key: preferenceKey, label, value: matchedValue });
    return matches;
  }, []);
}

function maxSimilarity(song, references) {
  return references.reduce((best, reference) => Math.max(best, metadataSimilarity(song, reference)), 0);
}

export function metadataSimilarity(left, right) {
  if (!left || !right) return 0;
  const moodMatch = overlapRatio(left.mood, right.mood);
  const tagMatch = overlapRatio(left.tags, right.tags);
  let score = 0;
  if (sameValue(left.language, right.language)) score += SIMILARITY_WEIGHTS.language;
  if (sameValue(left.genre, right.genre)) score += SIMILARITY_WEIGHTS.genre;
  if (sameValue(left.difficulty, right.difficulty)) score += SIMILARITY_WEIGHTS.difficulty;
  if (sameValue(left.vocalRange, right.vocalRange)) score += SIMILARITY_WEIGHTS.vocalRange;
  if (sameValue(left.performanceType, right.performanceType)) score += SIMILARITY_WEIGHTS.performanceType;
  if (sameValue(left.era, right.era)) score += SIMILARITY_WEIGHTS.era;
  return score + moodMatch * SIMILARITY_WEIGHTS.mood + tagMatch * SIMILARITY_WEIGHTS.tags;
}

function compareCandidates(left, right, selected) {
  const leftScore = selectionScore(left, selected);
  const rightScore = selectionScore(right, selected);
  return rightScore - leftScore
    || compareText(left.song.title, right.song.title)
    || compareText(left.song.artist, right.song.artist)
    || compareText(left.song.id, right.song.id);
}

function selectionScore(candidate, selected) {
  const artistAlreadyUsed = selected.some((item) => sameValue(item.song.artist, candidate.song.artist));
  const profileAlreadyUsed = selected.some((item) => profileKey(item.song) === profileKey(candidate.song));
  return candidate.score
    - (artistAlreadyUsed ? RECOMMENDATION_WEIGHTS.ARTIST_REPEAT : 0)
    - (profileAlreadyUsed ? RECOMMENDATION_WEIGHTS.PROFILE_REPEAT : 0);
}

function profileKey(song) {
  return [song.language, song.genre, song.mood?.[0], song.difficulty, song.performanceType].map(normalizeValue).join("|");
}

function isUsableSong(song) {
  return Boolean(song && typeof song.id === "string" && typeof song.title === "string" && isValidYouTubeVideoId(song.youtubeVideoId));
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry.id === "string" && typeof entry.sungAt === "string" && !Number.isNaN(Date.parse(entry.sungAt)));
}

function toIdSet(value) {
  return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean) : []);
}

function toValueSet(value) {
  const values = Array.isArray(value) ? value : [value];
  return new Set(values.filter((item) => typeof item === "string").map(normalizeValue).filter(Boolean));
}

function overlapRatio(left, right) {
  const leftValues = toValueSet(left);
  const rightValues = toValueSet(right);
  if (leftValues.size === 0 || rightValues.size === 0) return 0;
  const overlap = [...leftValues].filter((value) => rightValues.has(value)).length;
  return overlap / Math.max(leftValues.size, rightValues.size);
}

function sameValue(left, right) {
  return normalizeValue(left) !== "" && normalizeValue(left) === normalizeValue(right);
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

function normalizeDemandTier(value) {
  const normalized = normalizeValue(value);
  return Object.prototype.hasOwnProperty.call(DEMAND_WEIGHTS, normalized) ? normalized : "";
}

function joinLabels(values) {
  const labels = [...new Set(values.map((value) => formatPreferenceValue(typeof value === "string" ? value : value.value)))].join(" and ");
  return labels || "your selected";
}

function formatPreferenceValue(value) {
  return String(value).replace(/(^|[\s-])([a-z])/g, (match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

function compareText(left, right) {
  return normalizeValue(left).localeCompare(normalizeValue(right));
}

function normalizeId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getNowMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function clampLimit(value) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(1, Math.min(number, 20)) : RECOMMENDATION_LIMIT;
}
