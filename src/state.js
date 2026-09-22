import { readStoredJson, writeStoredJson } from "./storage.js";
import { createDefaultPartySession, getPartyQueueItems, normalizePartySession, reconcilePartyState } from "./party.js";

export const USER_STATE_VERSION = 1;
export const MAX_SUNG_HISTORY = 50;
export const MAX_RECENT_RECOMMENDATIONS = 20;
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
 * - preferences are normalized arrays so a future UI can add one or many values.
 * - currentSongId and queueFinished persist so refreshes preserve the session position.
 *   Removing the current song selects the next item at that position, or the previous
 *   item when there is no next item.
 * - search text, selected filters, and other view-only values are not persisted.
 * - partySession is a separate nested local session under the same namespaced
 *   state record. Queue entries remain stable song IDs; singer assignments are
 *   a separate song-ID-to-singer-ID map so old queues need no migration.
 */
export function createDefaultUserState() {
  return {
    version: USER_STATE_VERSION,
    favorites: [],
    likedSongs: [],
    dislikedSongs: [],
    sungHistory: [],
    preferences: createDefaultPreferences(),
    queue: [],
    currentSongId: null,
    queueFinished: false,
    recentRecommendations: [],
    partySession: createDefaultPartySession()
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
    sortBy: "relevance"
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
    throw new Error("Unsupported KantaTayo user-state version.");
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
    preferences: normalizePreferences(value.preferences),
    queue,
    currentSongId,
    queueFinished: Boolean(value.queueFinished && queue.length > 0 && !currentSongId),
    recentRecommendations: normalizeIdList(value.recentRecommendations).slice(0, MAX_RECENT_RECOMMENDATIONS),
    partySession: normalizePartySession(value.partySession)
  };
}

function migrateUserState(value) {
  if (!isPlainObject(value)) throw new Error("Stored KantaTayo user state is not an object.");
  if (value.version === USER_STATE_VERSION) return value;

  // Version 0 represents the pre-persistence shape. Keeping this branch makes
  // future migrations explicit instead of silently accepting unknown versions.
  if (value.version === undefined || value.version === 0) {
    return { ...createDefaultUserState(), ...value, version: USER_STATE_VERSION };
  }

  throw new Error(`Unsupported stored KantaTayo user-state version: ${value.version}`);
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
    queue,
    currentSongId: resolvePlayableQueue(userState.currentSongId ? [userState.currentSongId] : [])[0] || null,
    queueFinished: Boolean(userState.queueFinished && queue.length > 0 && !userState.currentSongId),
    recentRecommendations: resolveList(userState.recentRecommendations).slice(0, MAX_RECENT_RECOMMENDATIONS),
    partySession: reconcilePartyState(userState.partySession, songs, queue)
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
