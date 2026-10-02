/**
 * Lightweight current-tab session context.
 *
 * This is intentionally separate from the durable user state. It records only
 * stable song IDs and timestamps for actions that happened in the current
 * karaoke session, so temporary sequencing signals cannot rewrite long-term
 * preferences, history, queue, or feedback.
 */
export const SESSION_STORAGE_KEY = "kantacue:active-session";
export const SESSION_STATE_VERSION = 1;
export const MAX_SESSION_OPENED = 32;
export const MAX_SESSION_COMPLETED = 32;

export function createDefaultSessionState(now = Date.now()) {
  const timestamp = toIsoTimestamp(now) || new Date().toISOString();
  return {
    version: SESSION_STATE_VERSION,
    startedAt: timestamp,
    opened: [],
    completed: []
  };
}

export function loadSessionState({ storage = getSessionStorage(), now = Date.now() } = {}) {
  const fallback = createDefaultSessionState(now);
  if (!storage || typeof storage.getItem !== "function") return fallback;
  try {
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return fallback;
    return normalizeSessionState(JSON.parse(raw), now);
  } catch {
    return fallback;
  }
}

export function persistSessionState(sessionState, { storage = getSessionStorage() } = {}) {
  if (!storage || typeof storage.setItem !== "function") return false;
  const normalized = normalizeSessionState(sessionState);
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function normalizeSessionState(value, now = Date.now()) {
  const source = isPlainObject(value) ? value : {};
  const fallback = createDefaultSessionState(now);
  const startedAt = toIsoTimestamp(source.startedAt) || fallback.startedAt;
  return {
    version: SESSION_STATE_VERSION,
    startedAt,
    opened: normalizeEvents(source.opened, MAX_SESSION_OPENED, "openedAt"),
    completed: normalizeEvents(source.completed, MAX_SESSION_COMPLETED, "completedAt")
  };
}

export function recordSessionOpened(sessionState, songId, { now = Date.now() } = {}) {
  return upsertSessionEvent(sessionState, "opened", "openedAt", MAX_SESSION_OPENED, songId, now);
}

export function recordSessionCompleted(sessionState, songId, { now = Date.now() } = {}) {
  return upsertSessionEvent(sessionState, "completed", "completedAt", MAX_SESSION_COMPLETED, songId, now);
}

export function pruneSessionState(sessionState, songs = []) {
  if (!sessionState || !Array.isArray(songs)) return false;
  const playableIds = new Set(
    songs
      .filter((song) => song && typeof song.id === "string")
      .filter((song) => typeof song.youtubeVideoId === "string" && song.youtubeVideoId.trim())
      .map((song) => song.id.trim().toLowerCase())
  );
  const before = JSON.stringify(sessionState);
  sessionState.opened = sessionState.opened.filter((entry) => playableIds.has(entry.id.toLowerCase()));
  sessionState.completed = sessionState.completed.filter((entry) => playableIds.has(entry.id.toLowerCase()));
  return before !== JSON.stringify(sessionState);
}

function upsertSessionEvent(sessionState, collection, timestampKey, limit, songId, now) {
  if (!sessionState || typeof songId !== "string" || !songId.trim()) return false;
  const id = songId.trim();
  const timestamp = toIsoTimestamp(now);
  if (!timestamp) return false;
  const entries = Array.isArray(sessionState[collection]) ? sessionState[collection] : [];
  const key = id.toLowerCase();
  const next = entries.filter((entry) => entry?.id?.toLowerCase() !== key);
  next.unshift({ id, [timestampKey]: timestamp });
  sessionState[collection] = next.slice(0, limit);
  sessionState.version = SESSION_STATE_VERSION;
  if (!sessionState.startedAt) sessionState.startedAt = timestamp;
  return true;
}

function normalizeEvents(value, limit, timestampKey) {
  if (!Array.isArray(value)) return [];
  const latest = new Map();
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.id !== "string") continue;
    const id = entry.id.trim();
    const timestamp = toIsoTimestamp(entry[timestampKey]);
    if (!id || !timestamp) continue;
    const key = id.toLowerCase();
    const current = latest.get(key);
    if (!current || Date.parse(timestamp) > Date.parse(current[timestampKey])) {
      latest.set(key, { id, [timestampKey]: timestamp });
    }
  }
  return [...latest.values()]
    .sort((left, right) => Date.parse(right[timestampKey]) - Date.parse(left[timestampKey]))
    .slice(0, limit);
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getSessionStorage() {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}
