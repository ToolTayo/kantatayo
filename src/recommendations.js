import { isValidYouTubeVideoId } from "./youtube.js";

export const RECOMMENDATION_LIMIT = 5;
export const MAX_RECENT_RECOMMENDATIONS = 20;

/**
 * Transparent local ranking model. A playable song starts with +16, matching
 * preferences contribute a capped signal, demand adds a small cold-start
 * prior, and explicit likes/favorites are stronger than any single implicit
 * signal. Metadata and artist affinity help discover related songs without
 * turning an artist into a hard filter. A recent completion and a recent open
 * receive separate soft decay penalties; queued, current, unplayable, and
 * directly disliked songs are excluded. Recent recommendations and repeated
 * artists receive soft penalties so the pool stays available while refreshes
 * still feel varied.
 */
export const RECOMMENDATION_WEIGHTS = Object.freeze({
  PLAYABLE: 16,
  PREFERENCE_MATCH: 8,
  PREFERENCE_MATCH_CAP: 32,
  DIRECT_LIKE: 28,
  DIRECT_FAVORITE: 30,
  LIKED_SIMILARITY: 20,
  FAVORITE_SIMILARITY: 16,
  SUNG_SIMILARITY: 7,
  LIKED_ARTIST: 12,
  FAVORITE_ARTIST: 10,
  SUNG_ARTIST: 4,
  RECENT_SUNG_MAX: 48,
  RECENT_PLAYED_MAX: 10,
  RECENT_RECOMMENDATION: 14,
  ARTIST_REPEAT: 12,
  PROFILE_REPEAT: 4
});

export const RECENT_PLAYED_HALF_LIFE_DAYS = 7;

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
  const recentlyPlayed = normalizeRecentlyPlayed(userState.recentlyPlayed);
  const songsById = new Map(safeSongs.map((song) => [song.id.toLowerCase(), song]));

  const likedReferences = [...likedIds].map((id) => songsById.get(id)).filter(Boolean);
  const favoriteReferences = [...favoriteIds].map((id) => songsById.get(id)).filter(Boolean);
  const sungReferences = history.map((entry) => songsById.get(entry.id.toLowerCase())).filter(Boolean);
  const likedReferenceProfiles = likedReferences.map(createMetadataProfile);
  const favoriteReferenceProfiles = favoriteReferences.map(createMetadataProfile);
  const sungReferenceProfiles = sungReferences.map(createMetadataProfile);
  const likedArtistReferences = createArtistReferenceMap(likedReferences);
  const favoriteArtistReferences = createArtistReferenceMap(favoriteReferences);
  const sungArtistReferences = createArtistReferenceMap(sungReferences);
  const latestSungAtById = latestActivityById(history, "sungAt");
  const latestPlayedAtById = latestActivityById(recentlyPlayed, "playedAt");

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
      likedReferenceProfiles,
      favoriteReferenceProfiles,
      sungReferenceProfiles,
      likedArtistReferences,
      favoriteArtistReferences,
      sungArtistReferences,
      history,
      recentlyPlayed,
      latestSungAtById,
      latestPlayedAtById,
      recentRecommendationIds,
      nowMs
    }));

  const selected = [];
  const selectedArtistKeys = new Set();
  const selectedProfileKeys = new Set();
  while (selected.length < limit && candidates.length > 0) {
    let bestIndex = 0;
    for (let index = 1; index < candidates.length; index += 1) {
      if (compareCandidates(candidates[index], candidates[bestIndex], selectedArtistKeys, selectedProfileKeys) < 0) bestIndex = index;
    }
    const [next] = candidates.splice(bestIndex, 1);
    const artistAlreadyUsed = selectedArtistKeys.has(next.artistKey);
    const profileAlreadyUsed = selectedProfileKeys.has(next.candidateProfileKey);
    const diversityPenalty = (artistAlreadyUsed ? RECOMMENDATION_WEIGHTS.ARTIST_REPEAT : 0) + (profileAlreadyUsed ? RECOMMENDATION_WEIGHTS.PROFILE_REPEAT : 0);
    const signals = { ...next.signals, artistDiversity: selected.length > 0 && !artistAlreadyUsed };
    selected.push({
      ...next,
      song: next.song,
      score: next.score - diversityPenalty,
      reason: buildReason(signals),
      signals
    });
    selectedArtistKeys.add(next.artistKey);
    selectedProfileKeys.add(next.candidateProfileKey);
  }

  return selected.map(({ song, score, reason, signals }) => ({ song, score, reason, signals }));
}

export function scoreRecommendationCandidate(song, context = {}) {
  const preferences = context.preferences || {};
  const likedIds = context.likedIds || new Set();
  const favoriteIds = context.favoriteIds || new Set();
  const recentRecommendationIds = context.recentRecommendationIds || new Set();
  const history = Array.isArray(context.history) ? context.history : [];
  const recentlyPlayed = Array.isArray(context.recentlyPlayed) ? context.recentlyPlayed : [];
  const nowMs = Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
  const key = normalizeId(song?.id).toLowerCase();
  const preferenceMatches = getPreferenceMatches(song, preferences);
  const songProfile = context.songProfile || createMetadataProfile(song);
  const likedReferences = context.likedReferences || [];
  const favoriteReferences = context.favoriteReferences || [];
  const sungReferences = context.sungReferences || [];
  const likedSimilarity = maxSimilarity(songProfile, likedReferences, context.likedReferenceProfiles);
  const favoriteSimilarity = maxSimilarity(songProfile, favoriteReferences, context.favoriteReferenceProfiles);
  const sungSimilarity = maxSimilarity(songProfile, sungReferences, context.sungReferenceProfiles);
  const latestSungAt = context.latestSungAtById?.get(key) || latestActivityById(history, "sungAt").get(key);
  const latestPlayedAt = context.latestPlayedAtById?.get(key) || latestActivityById(recentlyPlayed, "playedAt").get(key);
  const recentSungPenalty = latestSungAt ? getRecentSungPenalty(latestSungAt, nowMs) : 0;
  const recentPlayedPenalty = latestPlayedAt ? getRecentPlayedPenalty(latestPlayedAt, nowMs) : 0;
  const recentRecommendationPenalty = recentRecommendationIds.has(key) ? RECOMMENDATION_WEIGHTS.RECENT_RECOMMENDATION : 0;
  const demandTier = normalizeDemandTier(song?.demandTier);
  const demandSignal = demandTier ? DEMAND_WEIGHTS[demandTier] : 0;
  const preferenceSignal = Math.min(
    preferenceMatches.length * RECOMMENDATION_WEIGHTS.PREFERENCE_MATCH,
    RECOMMENDATION_WEIGHTS.PREFERENCE_MATCH_CAP
  );
  const likedArtist = hasOtherArtistReference(songProfile, key, context.likedArtistReferences || createArtistReferenceMap(likedReferences));
  const favoriteArtist = hasOtherArtistReference(songProfile, key, context.favoriteArtistReferences || createArtistReferenceMap(favoriteReferences));
  const sungArtist = hasOtherArtistReference(songProfile, key, context.sungArtistReferences || createArtistReferenceMap(sungReferences));
  const signals = {
    playable: isUsableSong(song),
    preferenceMatches,
    preferenceSignal,
    directLiked: likedIds.has(key),
    directFavorite: favoriteIds.has(key),
    likedSimilarity,
    favoriteSimilarity,
    sungSimilarity,
    artistAffinity: { liked: likedArtist, favorite: favoriteArtist, sung: sungArtist },
    recentSungPenalty,
    recentPlayedPenalty,
    recentRecommendationPenalty,
    demandTier,
    demandSignal,
    artistDiversity: false
  };

  const score = (signals.playable ? RECOMMENDATION_WEIGHTS.PLAYABLE : 0)
    + preferenceSignal
    + (signals.directLiked ? RECOMMENDATION_WEIGHTS.DIRECT_LIKE : 0)
    + (signals.directFavorite ? RECOMMENDATION_WEIGHTS.DIRECT_FAVORITE : 0)
    + likedSimilarity * RECOMMENDATION_WEIGHTS.LIKED_SIMILARITY
    + favoriteSimilarity * RECOMMENDATION_WEIGHTS.FAVORITE_SIMILARITY
    + sungSimilarity * RECOMMENDATION_WEIGHTS.SUNG_SIMILARITY
    + (likedArtist ? RECOMMENDATION_WEIGHTS.LIKED_ARTIST : 0)
    + (favoriteArtist ? RECOMMENDATION_WEIGHTS.FAVORITE_ARTIST : 0)
    + (sungArtist ? RECOMMENDATION_WEIGHTS.SUNG_ARTIST : 0)
    + demandSignal
    - recentSungPenalty
    - recentPlayedPenalty
    - recentRecommendationPenalty;

  return {
    song,
    score,
    reason: buildReason(signals),
    signals,
    artistKey: songProfile.artist,
    candidateProfileKey: profileKey(song)
  };
}

export function getRecentSungPenalty(sungAt, nowMs = Date.now()) {
  return getRecencyPenalty(sungAt, nowMs, RECOMMENDATION_WEIGHTS.RECENT_SUNG_MAX, 14);
}

export function getRecentPlayedPenalty(playedAt, nowMs = Date.now()) {
  return getRecencyPenalty(playedAt, nowMs, RECOMMENDATION_WEIGHTS.RECENT_PLAYED_MAX, RECENT_PLAYED_HALF_LIFE_DAYS);
}

export function buildReason(signals = {}) {
  const preferenceMatches = Array.isArray(signals.preferenceMatches) ? signals.preferenceMatches : [];
  if (signals.directFavorite) return "Because you favorited this song before";
  if (signals.directLiked) return "Because you liked this song before";
  if (signals.artistAffinity?.favorite || signals.artistAffinity?.liked) return "More from an artist you liked or favorited";
  if (signals.artistAffinity?.sung) return "More from an artist you have sung";
  if (preferenceMatches.length > 0) return `Matches your ${joinLabels(preferenceMatches)} preferences`;
  if (signals.likedSimilarity > 0 || signals.favoriteSimilarity > 0) return "Similar to songs you liked or favorited";
  if (signals.sungSimilarity > 0) return "A familiar fit based on songs you have sung";
  if (normalizeDemandTier(signals.demandTier)) return "A popular karaoke pick";
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

function maxSimilarity(songProfile, references, referenceProfiles = null) {
  const profiles = Array.isArray(referenceProfiles) && referenceProfiles.length === references.length
    ? referenceProfiles
    : references.map(createMetadataProfile);
  return profiles.reduce((best, referenceProfile) => Math.max(best, metadataProfileSimilarity(songProfile, referenceProfile)), 0);
}

export function metadataSimilarity(left, right) {
  if (!left || !right) return 0;
  return metadataProfileSimilarity(createMetadataProfile(left), createMetadataProfile(right));
}

function metadataProfileSimilarity(left, right) {
  if (!left || !right) return 0;
  const moodMatch = overlapSetRatio(left.mood, right.mood);
  const tagMatch = overlapSetRatio(left.tags, right.tags);
  let score = 0;
  if (left.language && left.language === right.language) score += SIMILARITY_WEIGHTS.language;
  if (left.genre && left.genre === right.genre) score += SIMILARITY_WEIGHTS.genre;
  if (left.difficulty && left.difficulty === right.difficulty) score += SIMILARITY_WEIGHTS.difficulty;
  if (left.vocalRange && left.vocalRange === right.vocalRange) score += SIMILARITY_WEIGHTS.vocalRange;
  if (left.performanceType && left.performanceType === right.performanceType) score += SIMILARITY_WEIGHTS.performanceType;
  if (left.era && left.era === right.era) score += SIMILARITY_WEIGHTS.era;
  return score + moodMatch * SIMILARITY_WEIGHTS.mood + tagMatch * SIMILARITY_WEIGHTS.tags;
}

function compareCandidates(left, right, selectedArtistKeys, selectedProfileKeys) {
  const leftScore = selectionScore(left, selectedArtistKeys, selectedProfileKeys);
  const rightScore = selectionScore(right, selectedArtistKeys, selectedProfileKeys);
  return rightScore - leftScore
    || compareText(left.song.title, right.song.title)
    || compareText(left.song.artist, right.song.artist)
    || compareText(left.song.id, right.song.id);
}

function selectionScore(candidate, selectedArtistKeys, selectedProfileKeys) {
  const artistAlreadyUsed = selectedArtistKeys.has(candidate.artistKey);
  const profileAlreadyUsed = selectedProfileKeys.has(candidate.candidateProfileKey);
  return candidate.score
    - (artistAlreadyUsed ? RECOMMENDATION_WEIGHTS.ARTIST_REPEAT : 0)
    - (profileAlreadyUsed ? RECOMMENDATION_WEIGHTS.PROFILE_REPEAT : 0);
}

function profileKey(song = {}) {
  return [song?.language, song?.genre, song?.mood?.[0], song?.difficulty, song?.performanceType].map(normalizeValue).join("|");
}

function createMetadataProfile(song) {
  return {
    id: normalizeId(song?.id).toLowerCase(),
    artist: normalizeValue(song?.artist),
    language: normalizeValue(song?.language),
    genre: normalizeValue(song?.genre),
    difficulty: normalizeValue(song?.difficulty),
    vocalRange: normalizeValue(song?.vocalRange),
    performanceType: normalizeValue(song?.performanceType),
    era: normalizeValue(song?.era),
    mood: toValueSet(song?.mood),
    tags: toValueSet(song?.tags)
  };
}

function createArtistReferenceMap(references) {
  const map = new Map();
  for (const reference of references) {
    const artist = normalizeValue(reference?.artist);
    const id = normalizeId(reference?.id).toLowerCase();
    if (!artist || !id) continue;
    if (!map.has(artist)) map.set(artist, new Set());
    map.get(artist).add(id);
  }
  return map;
}

function hasOtherArtistReference(songProfile, key, artistReferences) {
  const ids = artistReferences.get(songProfile.artist);
  if (!ids) return false;
  return [...ids].some((id) => id !== key);
}

function isUsableSong(song) {
  return Boolean(song && typeof song.id === "string" && typeof song.title === "string" && isValidYouTubeVideoId(song.youtubeVideoId));
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.id === "string" && typeof entry.sungAt === "string" && !Number.isNaN(Date.parse(entry.sungAt)))
    .map((entry) => ({ ...entry, id: entry.id.trim() }))
    .filter((entry) => entry.id);
}

function normalizeRecentlyPlayed(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.id === "string" && typeof entry.playedAt === "string" && !Number.isNaN(Date.parse(entry.playedAt)))
    .map((entry) => ({ ...entry, id: entry.id.trim() }))
    .filter((entry) => entry.id);
}

function latestActivityById(entries, timestampKey) {
  const latest = new Map();
  for (const entry of entries) {
    const key = normalizeId(entry?.id).toLowerCase();
    const timestamp = entry?.[timestampKey];
    if (!key || typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) continue;
    const current = latest.get(key);
    if (!current || Date.parse(timestamp) > Date.parse(current)) latest.set(key, timestamp);
  }
  return latest;
}

function getRecencyPenalty(timestampValue, nowMs, maxPenalty, halfLifeDays) {
  const timestamp = Date.parse(timestampValue);
  if (Number.isNaN(timestamp) || timestamp > nowMs) return 0;
  const ageDays = Math.max(0, (nowMs - timestamp) / 86400000);
  return maxPenalty * Math.pow(0.5, ageDays / halfLifeDays);
}

function toIdSet(value) {
  return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean) : []);
}

function toValueSet(value) {
  const values = Array.isArray(value) ? value : [value];
  return new Set(values.filter((item) => typeof item === "string").map(normalizeValue).filter(Boolean));
}

function overlapSetRatio(left, right) {
  const leftValues = left instanceof Set ? left : toValueSet(left);
  const rightValues = right instanceof Set ? right : toValueSet(right);
  if (leftValues.size === 0 || rightValues.size === 0) return 0;
  let overlap = 0;
  for (const value of leftValues) {
    if (rightValues.has(value)) overlap += 1;
  }
  return overlap / Math.max(leftValues.size, rightValues.size);
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
