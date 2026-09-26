import { readStoredJson, writeStoredJson } from "./storage.js";
import { createDefaultPartySession, getPartyQueueItems, normalizePartySession, reconcilePartyState } from "./party.js?v=1";
import { getLocalDateKey, isValidDateKey } from "./daily-challenge.js?v=2";

export const USER_STATE_VERSION = 4;
export const MAX_SUNG_HISTORY = 50;
export const MAX_RECENTLY_PLAYED = 8;
export const MAX_RECENT_RECOMMENDATIONS = 20;
export const MAX_DAILY_COMPLETIONS = 120;
export const MAX_SONG_REQUESTS = 40;
export const MAX_PLAYBACK_FEEDBACK = 100;
export const SUNG_DUPLICATE_WINDOW_MS = 2000;

export const PREFERENCE_KEYS = [
  "languages",
  "genres",
  "moods",
  "difficulties",
  "vocalRanges",
  "performanceTypes",
  "eras"
];

/**
 * Persistent state decisions:
 * - Collections contain stable song IDs, never full catalog records.
 * - sungHistory contains { id, sungAt } entries for future recency views.
 * - recentlyPlayed contains { id, playedAt } entries for the lightweight
 *   Continue Singing shelf without copying catalog records.
 * - dailyChallenge contains completed local date keys for streaks.
 * - preferences are normalized arrays so a future UI can add one or many values.
 * - currentSongId and queueFinished persist so refreshes preserve the session position.
 *   Removing the current song selects the next item at that position, or the previous
 *   item when there is no next item.
 * - search text, selected filters, and other view-only values are not persisted.
 * - partySession is a separate nested local session under the same namespaced
 *   state record. Queue entries remain stable song IDs; singer assignments are
 *   a separate song-ID-to-singer-ID map so old queues need no migration.
 * - songRequests and playbackFeedback are bounded local records. Requests keep
 *   title/artist text because they are not catalog songs; feedback keeps only a
 *   stable song ID, rating, optional controlled reason, and timestamp.
 */
export function createDefaultUserState() {
  return {
    version: USER_STATE_VERSION,
    favorites: [],
    likedSongs: [],
    dislikedSongs: [],
    sungHistory: [],
    recentlyPlayed: [],
    preferences: createDefaultPreferences(),
    queue: [],
    currentSongId: null,
    queueFinished: false,
    recentRecommendations: [],
    dailyChallenge: { completedDates: [], lastCompletedDate: null, lastCompletedSongId: null },
    partySession: createDefaultPartySession(),
    songRequests: [],
    playbackFeedback: []
  };
}

export function loadUserState(options = {}) {
  return readStoredJson({
    ...options,
    fallback: createDefaultUserState,
    migrate: migrateUserState,
    validate: validateUserState
  });
}

export function saveUserState(userState, options = {}) {
  return writeStoredJson(validateUserState(userState), options);
}

export function createAppState(userState = loadUserState()) {
  return {
    songs: [],
    searchIndex: [],
    user: validateUserState(userState),
    query: "",
    filter: "all",
    sortBy: "relevance",
    discoveryFilters: {
      availability: "all",
      language: "any",
      genre: "any",
      mood: "any",
      difficulty: "any",
      vocalRange: "any",
      performanceType: "any",
      era: "any",
      favorites: false
    },
    discoveryPage: 1
  };
}

export function setCatalog(appState, songs, searchIndex) {
  appState.songs = songs;
  appState.searchIndex = searchIndex;
  appState.user = reconcileUserState(appState.user, songs);
  return appState;
}

export function getQueuedSongs(appState) {
  const songsById = new Map(appState.songs.map((song) => [song.id.toLowerCase(), song]));
  return appState.user.queue.map((id) => songsById.get(id.toLowerCase())).filter(Boolean);
}

export function getQueueSnapshot(appState) {
  const songs = getQueuedSongs(appState);
  const currentSongId = appState.user.currentSongId;
  const currentIndex = currentSongId ? songs.findIndex((song) => song.id.toLowerCase() === currentSongId.toLowerCase()) : -1;
  return {
    songs,
    currentSongId,
    currentSong: currentIndex >= 0 ? songs[currentIndex] : null,
    currentIndex,
    position: currentIndex >= 0 ? currentIndex + 1 : 0,
    total: songs.length,
    queueFinished: Boolean(appState.user.queueFinished && songs.length > 0),
    partyItems: getPartyQueueItems(songs, appState.user.partySession),
    partyModeEnabled: Boolean(appState.user.partySession.enabled)
  };
}

export function addSongToQueue(userState, songId) {
  const id = normalizeId(songId);
  if (!id || userState.queue.some((item) => item.toLowerCase() === id.toLowerCase())) return false;
  userState.queue.push(id);
  userState.queueFinished = false;
  return true;
}

export function removeSongFromQueue(userState, songId) {
  const id = normalizeId(songId);
  const removedIndex = userState.queue.findIndex((item) => item.toLowerCase() === id.toLowerCase());
  const nextQueue = userState.queue.filter((item) => item.toLowerCase() !== id.toLowerCase());
  const changed = nextQueue.length !== userState.queue.length;
  if (!changed) return false;
  const removedCurrent = userState.currentSongId?.toLowerCase() === id.toLowerCase();
  userState.queue = nextQueue;
  if (removedCurrent) {
    userState.currentSongId = userState.queue[removedIndex] || userState.queue[removedIndex - 1] || null;
    userState.queueFinished = false;
  }
  if (userState.queue.length === 0) {
    userState.currentSongId = null;
    userState.queueFinished = false;
  }
  return changed;
}

export function clearQueue(userState) {
  const changed = userState.queue.length > 0;
  userState.queue = [];
  userState.currentSongId = null;
  userState.queueFinished = false;
  return changed;
}

export function moveQueueItem(userState, songId, direction) {
  const id = normalizeId(songId);
  const delta = direction === "up" ? -1 : direction === "down" ? 1 : Number(direction);
  if (!id || !Number.isInteger(delta) || Math.abs(delta) !== 1) return false;
  const currentIndex = userState.queue.findIndex((item) => item.toLowerCase() === id.toLowerCase());
  const targetIndex = currentIndex + delta;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= userState.queue.length) return false;
  [userState.queue[currentIndex], userState.queue[targetIndex]] = [userState.queue[targetIndex], userState.queue[currentIndex]];
  return true;
}

export function moveQueueItemToTop(userState, songId) {
  const id = normalizeId(songId);
  const currentIndex = userState.queue.findIndex((item) => item.toLowerCase() === id.toLowerCase());
  if (!id || currentIndex <= 0) return false;
  const [item] = userState.queue.splice(currentIndex, 1);
  userState.queue.unshift(item);
  return true;
}

export function setCurrentSong(userState, songId) {
  const id = normalizeId(songId);
  const canonicalId = userState.queue.find((item) => item.toLowerCase() === id.toLowerCase());
  if (!id || !canonicalId) return false;
  userState.currentSongId = canonicalId;
  userState.queueFinished = false;
  return true;
}

export function advanceQueue(userState) {
  if (userState.queue.length === 0) {
    userState.currentSongId = null;
    userState.queueFinished = false;
    return { status: "empty", currentSongId: null };
  }
  if (userState.queueFinished) return { status: "finished", currentSongId: null };
  if (!userState.currentSongId) {
    userState.currentSongId = userState.queue[0];
    return { status: "started", currentSongId: userState.currentSongId };
  }

  const currentIndex = userState.queue.findIndex((item) => item.toLowerCase() === userState.currentSongId.toLowerCase());
  if (currentIndex >= 0 && currentIndex < userState.queue.length - 1) {
    userState.currentSongId = userState.queue[currentIndex + 1];
    return { status: "advanced", currentSongId: userState.currentSongId };
  }

  userState.currentSongId = null;
  userState.queueFinished = true;
  return { status: "finished", currentSongId: null };
}

export function selectPreviousQueueSong(userState) {
  if (userState.queue.length === 0) return { status: "empty", currentSongId: null };
  if (userState.queueFinished || !userState.currentSongId) {
    userState.currentSongId = userState.queue[userState.queue.length - 1];
    userState.queueFinished = false;
    return { status: "selected", currentSongId: userState.currentSongId };
  }
  const currentIndex = userState.queue.findIndex((item) => item.toLowerCase() === userState.currentSongId.toLowerCase());
  if (currentIndex <= 0) return { status: "boundary", currentSongId: userState.currentSongId };
  userState.currentSongId = userState.queue[currentIndex - 1];
  return { status: "selected", currentSongId: userState.currentSongId };
}

export function toggleFavorite(userState, songId) {
  return toggleIdInList(userState, "favorites", songId);
}

export function toggleLike(userState, songId) {
  const active = toggleIdInList(userState, "likedSongs", songId);
  if (active) removeIdFromList(userState.dislikedSongs, songId);
  return active;
}

export function toggleDislike(userState, songId) {
  const active = toggleIdInList(userState, "dislikedSongs", songId);
  if (active) removeIdFromList(userState.likedSongs, songId);
  return active;
}

export function markSung(userState, songId, options = {}) {
  const id = normalizeId(songId);
  if (!id) return { added: false, reason: "invalid-id" };

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) return { added: false, reason: "invalid-time" };

  const latest = userState.sungHistory.find((entry) => entry.id.toLowerCase() === id.toLowerCase());
  const latestMs = latest ? Date.parse(latest.sungAt) : NaN;
  const duplicateWindow = options.duplicateWindowMs ?? SUNG_DUPLICATE_WINDOW_MS;
  if (!Number.isNaN(latestMs) && nowMs >= latestMs && nowMs - latestMs < duplicateWindow) {
    return { added: false, reason: "rapid-duplicate" };
  }

  const entry = { id, sungAt: new Date(nowMs).toISOString() };
  const maxHistory = options.maxHistory ?? MAX_SUNG_HISTORY;
  userState.sungHistory = [entry, ...userState.sungHistory].slice(0, maxHistory);
  return { added: true, entry };
}

export function recordSongPlayed(userState, songId, options = {}) {
  const id = normalizeId(songId);
  if (!id) return { added: false, reason: "invalid-id" };
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) return { added: false, reason: "invalid-time" };
  const entry = { id, playedAt: now.toISOString() };
  const previous = userState.recentlyPlayed.find((item) => item.id.toLowerCase() === id.toLowerCase());
  userState.recentlyPlayed = [entry, ...userState.recentlyPlayed.filter((item) => item.id.toLowerCase() !== id.toLowerCase())]
    .slice(0, options.maxRecentlyPlayed ?? MAX_RECENTLY_PLAYED);
  return { added: !previous || previous.playedAt !== entry.playedAt, entry };
}

export function completeDailyChallenge(userState, dateKey, songId, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const currentDateKey = getLocalDateKey(now);
  const id = normalizeId(songId);
  const expectedSongId = normalizeId(options.expectedSongId);
  if (!isValidDateKey(dateKey) || !currentDateKey || dateKey !== currentDateKey || !id || !expectedSongId) return false;
  if (expectedSongId.toLowerCase() !== id.toLowerCase()) return false;
  const dailyChallenge = normalizeDailyChallenge(userState.dailyChallenge);
  const dates = dailyChallenge.completedDates;
  if (dates.includes(dateKey)) return false;
  userState.dailyChallenge = {
    completedDates: [dateKey, ...dates].slice(0, MAX_DAILY_COMPLETIONS),
    lastCompletedDate: dateKey,
    lastCompletedSongId: id
  };
  return true;
}

export function setPreferenceValues(userState, key, values) {
  if (!PREFERENCE_KEYS.includes(key)) return false;
  const nextValues = normalizeValueList(values);
  const currentValues = userState.preferences[key] || [];
  const changed = currentValues.length !== nextValues.length || currentValues.some((value, index) => value !== nextValues[index]);
  userState.preferences[key] = nextValues;
  return changed;
}

export function clearPreferences(userState) {
  const hadPreferences = PREFERENCE_KEYS.some((key) => (userState.preferences[key] || []).length > 0);
  userState.preferences = createDefaultPreferences();
  return hadPreferences;
}

export function addSongRequest(userState, title, artist, options = {}) {
  const normalizedTitle = normalizeText(title, 120);
  const normalizedArtist = normalizeText(artist, 120);
  if (!normalizedTitle || !normalizedArtist) return { added: false, reason: "missing-title-or-artist" };
  const duplicate = userState.songRequests.some((request) => request.title.toLowerCase() === normalizedTitle.toLowerCase() && request.artist.toLowerCase() === normalizedArtist.toLowerCase());
  if (duplicate) return { added: false, reason: "duplicate" };
  const requestedAt = new Date(options.now || Date.now());
  if (Number.isNaN(requestedAt.getTime())) return { added: false, reason: "invalid-time" };
  const request = { id: `request-${requestedAt.getTime().toString(36)}-${userState.songRequests.length}`, title: normalizedTitle, artist: normalizedArtist, requestedAt: requestedAt.toISOString(), status: "new" };
  userState.songRequests = [request, ...userState.songRequests].slice(0, MAX_SONG_REQUESTS);
  return { added: true, request };
}

export function recordPlaybackFeedback(userState, songId, rating, reason = null, options = {}) {
  const id = normalizeId(songId);
  const normalizedRating = rating === "good" || rating === "problem" ? rating : "";
  const allowedReasons = ["wrong-song", "poor-quality", "guide-vocals", "lyrics-timing", "video-unavailable"];
  const normalizedReason = allowedReasons.includes(reason) ? reason : null;
  if (!id || !normalizedRating || (normalizedRating === "problem" && !normalizedReason)) return { recorded: false, reason: "invalid-feedback" };
  const createdAt = new Date(options.now || Date.now());
  if (Number.isNaN(createdAt.getTime())) return { recorded: false, reason: "invalid-time" };
  const record = { songId: id, rating: normalizedRating, reason: normalizedReason, createdAt: createdAt.toISOString() };
  userState.playbackFeedback = [record, ...userState.playbackFeedback.filter((item) => item.songId.toLowerCase() !== id.toLowerCase())].slice(0, MAX_PLAYBACK_FEEDBACK);
  return { recorded: true, record };
}

export function setRecentRecommendations(userState, songIds) {
  const nextIds = normalizeIdList(songIds).slice(0, MAX_RECENT_RECOMMENDATIONS);
  const changed = userState.recentRecommendations.length !== nextIds.length
    || userState.recentRecommendations.some((id, index) => id.toLowerCase() !== nextIds[index]?.toLowerCase());
  userState.recentRecommendations = nextIds;
  return changed;
}

export function persistAppState(appState, options = {}) {
  return saveUserState(appState.user, options);
}

export function validateUserState(value) {
  if (!isPlainObject(value) || value.version !== USER_STATE_VERSION) {
    throw new Error("Unsupported KantaCue user-state version.");
  }

  const likedSongs = normalizeIdList(value.likedSongs);
  const dislikedSongs = normalizeIdList(value.dislikedSongs).filter((id) => !likedSongs.some((likedId) => likedId.toLowerCase() === id.toLowerCase()));

  const queue = normalizeIdList(value.queue);
  const requestedCurrentId = normalizeId(value.currentSongId);
  const currentSongId = queue.find((id) => id.toLowerCase() === requestedCurrentId.toLowerCase()) || null;

  return {
    version: USER_STATE_VERSION,
    favorites: normalizeIdList(value.favorites),
    likedSongs,
    dislikedSongs,
    sungHistory: normalizeHistory(value.sungHistory),
    recentlyPlayed: normalizeRecentlyPlayed(value.recentlyPlayed),
    preferences: normalizePreferences(value.preferences),
    queue,
    currentSongId,
    queueFinished: Boolean(value.queueFinished && queue.length > 0 && !currentSongId),
    recentRecommendations: normalizeIdList(value.recentRecommendations).slice(0, MAX_RECENT_RECOMMENDATIONS),
    dailyChallenge: normalizeDailyChallenge(value.dailyChallenge),
    partySession: normalizePartySession(value.partySession),
    songRequests: normalizeSongRequests(value.songRequests),
    playbackFeedback: normalizePlaybackFeedback(value.playbackFeedback)
  };
}

function migrateUserState(value) {
  if (!isPlainObject(value)) throw new Error("Stored KantaCue user state is not an object.");
  if (value.version === USER_STATE_VERSION) return value;

  // Version 0 represents the pre-persistence shape. Keeping this branch makes
  // future migrations explicit instead of silently accepting unknown versions.
  if (value.version === undefined || value.version === 0 || value.version === 1 || value.version === 2 || value.version === 3) {
    return {
      ...createDefaultUserState(),
      ...value,
      recentlyPlayed: value.recentlyPlayed ?? [],
      dailyChallenge: value.dailyChallenge ?? { completedDates: [], lastCompletedDate: null, lastCompletedSongId: null },
      songRequests: value.songRequests ?? [],
      playbackFeedback: value.playbackFeedback ?? [],
      version: USER_STATE_VERSION
    };
  }

  throw new Error(`Unsupported stored KantaCue user-state version: ${value.version}`);
}

function createDefaultPreferences() {
  return PREFERENCE_KEYS.reduce((preferences, key) => {
    preferences[key] = [];
    return preferences;
  }, {});
}

function normalizePreferences(value) {
  const source = isPlainObject(value) ? value : {};
  return PREFERENCE_KEYS.reduce((preferences, key) => {
    preferences[key] = normalizeValueList(source[key]);
    return preferences;
  }, {});
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.reduce((history, entry) => {
    const rawId = typeof entry === "string" ? entry : entry?.id;
    const id = normalizeId(rawId);
    if (!id || history.length >= MAX_SUNG_HISTORY) return history;
    const sungAt = typeof entry === "object" && entry !== null && typeof entry.sungAt === "string" && !Number.isNaN(Date.parse(entry.sungAt)) ? entry.sungAt : null;
    if (!sungAt) return history;
    history.push({ id, sungAt });
    return history;
  }, []);
}

function normalizeRecentlyPlayed(value) {
  if (!Array.isArray(value)) return [];
  const validEntries = value.reduce((history, entry) => {
    const id = normalizeId(typeof entry === "string" ? entry : entry?.id);
    const playedAt = typeof entry === "object" && entry !== null && typeof entry.playedAt === "string" && !Number.isNaN(Date.parse(entry.playedAt)) ? entry.playedAt : null;
    if (id && playedAt) history.push({ id, playedAt });
    return history;
  }, []);
  return validEntries
    .sort((left, right) => Date.parse(right.playedAt) - Date.parse(left.playedAt))
    .reduce((history, entry) => {
      if (history.length >= MAX_RECENTLY_PLAYED || history.some((item) => item.id.toLowerCase() === entry.id.toLowerCase())) return history;
      history.push(entry);
      return history;
    }, []);
}

function normalizeDailyChallenge(value) {
  const source = isPlainObject(value) ? value : {};
  const dates = Array.isArray(source.completedDates) ? source.completedDates : [];
  const lastCompletedDate = isValidDateKey(source.lastCompletedDate) ? source.lastCompletedDate : null;
  const lastCompletedSongId = lastCompletedDate ? normalizeId(source.lastCompletedSongId) || null : null;
  return {
    completedDates: dates.reduce((result, dateKey) => {
      if (!isValidDateKey(dateKey) || result.includes(dateKey)) return result;
      if (result.length < MAX_DAILY_COMPLETIONS) result.push(dateKey);
      return result;
    }, []),
    lastCompletedDate,
    lastCompletedSongId
  };
}

function normalizeSongRequests(value) {
  if (!Array.isArray(value)) return [];
  return value.reduce((requests, item) => {
    const title = normalizeText(item?.title, 120);
    const artist = normalizeText(item?.artist, 120);
    const requestedAt = typeof item?.requestedAt === "string" && !Number.isNaN(Date.parse(item.requestedAt)) ? new Date(item.requestedAt).toISOString() : null;
    if (!title || !artist || !requestedAt || requests.length >= MAX_SONG_REQUESTS) return requests;
    if (requests.some((request) => request.title.toLowerCase() === title.toLowerCase() && request.artist.toLowerCase() === artist.toLowerCase())) return requests;
    requests.push({ id: normalizeText(item.id, 80) || `request-${requests.length}`, title, artist, requestedAt, status: "new" });
    return requests;
  }, []);
}

function normalizePlaybackFeedback(value) {
  if (!Array.isArray(value)) return [];
  return value.reduce((records, item) => {
    const songId = normalizeId(item?.songId);
    const rating = item?.rating === "good" || item?.rating === "problem" ? item.rating : "";
    const reason = ["wrong-song", "poor-quality", "guide-vocals", "lyrics-timing", "video-unavailable"].includes(item?.reason) ? item.reason : null;
    const createdAt = typeof item?.createdAt === "string" && !Number.isNaN(Date.parse(item.createdAt)) ? new Date(item.createdAt).toISOString() : null;
    if (!songId || !rating || (rating === "problem" && !reason) || !createdAt || records.length >= MAX_PLAYBACK_FEEDBACK) return records;
    if (records.some((record) => record.songId.toLowerCase() === songId.toLowerCase())) return records;
    records.push({ songId, rating, reason, createdAt });
    return records;
  }, []);
}

function normalizeIdList(value) {
  return normalizeValueList(value, true);
}

function normalizeValueList(value, preserveCase = false) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.reduce((values, item) => {
    if (typeof item !== "string") return values;
    const normalized = item.trim().replace(/\s+/g, " ");
    if (!normalized) return values;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return values;
    seen.add(key);
    values.push(preserveCase ? normalized : key);
    return values;
  }, []);
}

function normalizeId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeText(value, maxLength) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function toggleIdInList(userState, field, songId) {
  const id = normalizeId(songId);
  if (!id) return false;
  const list = userState[field];
  const index = list.findIndex((item) => item.toLowerCase() === id.toLowerCase());
  if (index >= 0) {
    list.splice(index, 1);
    return false;
  }
  list.push(id);
  return true;
}

function removeIdFromList(list, songId) {
  const id = normalizeId(songId).toLowerCase();
  const index = list.findIndex((item) => item.toLowerCase() === id);
  if (index >= 0) list.splice(index, 1);
}

function reconcileUserState(userState, songs) {
  const canonicalIds = new Map(songs.map((song) => [song.id.toLowerCase(), song.id]));
  const playableIds = new Set(songs.filter((song) => typeof song.youtubeVideoId === "string" && song.youtubeVideoId.trim()).map((song) => song.id.toLowerCase()));
  const resolve = (id) => canonicalIds.get(id.toLowerCase());
  const resolveList = (list) => list.map(resolve).filter(Boolean).filter((id, index, all) => all.findIndex((item) => item.toLowerCase() === id.toLowerCase()) === index);
  const resolvePlayableQueue = (list) => resolveList(list).filter((id) => playableIds.has(id.toLowerCase()));
  const resolveHistory = (history) => history.map((entry) => ({ ...entry, id: resolve(entry.id) })).filter((entry) => entry.id);
  const queue = resolvePlayableQueue(userState.queue);

  return {
    ...userState,
    favorites: resolveList(userState.favorites),
    likedSongs: resolveList(userState.likedSongs),
    dislikedSongs: resolveList(userState.dislikedSongs),
    sungHistory: resolveHistory(userState.sungHistory),
    recentlyPlayed: resolveHistoryEntries(userState.recentlyPlayed, "playedAt", resolve),
    queue,
    currentSongId: resolvePlayableQueue(userState.currentSongId ? [userState.currentSongId] : [])[0] || null,
    queueFinished: Boolean(userState.queueFinished && queue.length > 0 && !userState.currentSongId),
    recentRecommendations: resolveList(userState.recentRecommendations).slice(0, MAX_RECENT_RECOMMENDATIONS),
    dailyChallenge: normalizeDailyChallenge(userState.dailyChallenge),
    songRequests: normalizeSongRequests(userState.songRequests),
    playbackFeedback: resolveFeedback(userState.playbackFeedback, resolve),
    partySession: reconcilePartyState(userState.partySession, songs, queue)
  };
}

function resolveFeedback(records, resolve) {
  return normalizePlaybackFeedback(records).map((record) => ({ ...record, songId: resolve(record.songId) })).filter((record) => record.songId);
}

function resolveHistoryEntries(entries, timestampKey, resolve) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    id: typeof entry?.id === "string" ? resolve(entry.id) : ""
  })).filter((entry) => entry.id && typeof entry[timestampKey] === "string" && !Number.isNaN(Date.parse(entry[timestampKey])));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
