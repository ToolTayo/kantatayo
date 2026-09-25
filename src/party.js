import { isValidYouTubeVideoId } from "./youtube.js";

export const MAX_PARTY_SINGERS = 12;
export const MAX_PARTY_NAME_LENGTH = 40;
export const MAX_PARTY_TURNS = 100;
export const PARTY_RECENT_SONG_DAYS = 14;

export function createDefaultPartySession() {
  return {
    enabled: false,
    singers: [],
    rotationIndex: 0,
    assignments: {},
    turns: []
  };
}

export function normalizePartySession(value) {
  const source = isPlainObject(value) ? value : {};
  const singers = normalizeSingers(source.singers);
  const singerIds = new Set(singers.map((singer) => singer.id));
  const assignments = {};
  if (isPlainObject(source.assignments)) {
    Object.entries(source.assignments).forEach(([songId, singerId]) => {
      const normalizedSongId = normalizeId(songId);
      const normalizedSingerId = normalizeId(singerId);
      if (normalizedSongId && singerIds.has(normalizedSingerId)) assignments[normalizedSongId] = normalizedSingerId;
    });
  }

  return {
    enabled: Boolean(source.enabled),
    singers,
    rotationIndex: singers.length > 0 && Number.isInteger(source.rotationIndex)
      ? Math.max(0, source.rotationIndex) % singers.length
      : 0,
    assignments,
    turns: normalizeTurns(source.turns)
  };
}

export function addPartySinger(session, rawName, options = {}) {
  const name = normalizeSingerName(rawName);
  if (!name) return { ok: false, reason: "invalid-name" };
  if (session.singers.some((singer) => singer.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, reason: "duplicate-name" };
  }
  if (session.singers.length >= MAX_PARTY_SINGERS) return { ok: false, reason: "singer-limit" };

  const idFactory = options.idFactory || createSingerId;
  let id = normalizeId(idFactory());
  while (!id || session.singers.some((singer) => singer.id === id)) id = createSingerId();
  const singer = { id, name };
  session.singers.push(singer);
  return { ok: true, singer };
}

export function renamePartySinger(session, singerId, rawName) {
  const singer = findSinger(session, singerId);
  const name = normalizeSingerName(rawName);
  if (!singer || !name) return { ok: false, reason: "invalid-name" };
  if (session.singers.some((item) => item.id !== singer.id && item.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, reason: "duplicate-name" };
  }
  singer.name = name;
  return { ok: true, singer };
}

export function removePartySinger(session, singerId) {
  const id = normalizeId(singerId);
  const index = session.singers.findIndex((singer) => singer.id === id);
  if (index < 0) return { ok: false, reason: "unknown-singer" };
  session.singers.splice(index, 1);
  Object.keys(session.assignments).forEach((songId) => {
    if (session.assignments[songId] === id) delete session.assignments[songId];
  });
  if (session.singers.length === 0) session.rotationIndex = 0;
  else if (index < session.rotationIndex) session.rotationIndex -= 1;
  session.rotationIndex = session.singers.length > 0 ? session.rotationIndex % session.singers.length : 0;
  return { ok: true, singerId: id };
}

export function clearPartySession(session) {
  const hadData = session.enabled || session.singers.length > 0 || Object.keys(session.assignments).length > 0 || session.turns.length > 0;
  Object.assign(session, createDefaultPartySession());
  return hadData;
}

export function getNextPartySinger(session) {
  if (!session?.singers?.length) return null;
  return session.singers[session.rotationIndex % session.singers.length] || null;
}

export function assignPartySong(session, songId, singerId = null) {
  const id = normalizeId(songId);
  if (!id) return { ok: false, reason: "invalid-song" };
  const singer = singerId ? findSinger(session, singerId) : getNextPartySinger(session);
  if (!singer) return { ok: false, reason: "no-singers" };
  session.assignments[id] = singer.id;
  const singerIndex = session.singers.findIndex((item) => item.id === singer.id);
  session.rotationIndex = singerIndex >= 0 ? (singerIndex + 1) % session.singers.length : session.rotationIndex;
  return { ok: true, singer, suggested: !singerId };
}

export function unassignPartySong(session, songId) {
  const id = normalizeId(songId);
  if (!id || !Object.prototype.hasOwnProperty.call(session.assignments, id)) return false;
  delete session.assignments[id];
  return true;
}

export function clearPartyAssignments(session) {
  const changed = Object.keys(session.assignments).length > 0;
  session.assignments = {};
  return changed;
}

export function getAssignedSinger(session, songId) {
  const singerId = session?.assignments?.[normalizeId(songId)];
  return findSinger(session, singerId);
}

export function recordPartyTurn(session, songId, singerId = null, options = {}) {
  const id = normalizeId(songId);
  if (!id) return false;
  const completedAt = options.completedAt instanceof Date ? options.completedAt : new Date(options.completedAt || Date.now());
  if (Number.isNaN(completedAt.getTime())) return false;
  const singer = findSinger(session, singerId);
  session.turns = [{ songId: id, singerId: singer?.id || null, singerName: singer?.name || null, completedAt: completedAt.toISOString() }, ...session.turns].slice(0, MAX_PARTY_TURNS);
  return true;
}

export function getPartyStats(session, songs = []) {
  const songsById = new Map(songs.map((song) => [song.id.toLowerCase(), song]));
  const singersById = new Map(session.singers.map((singer) => [singer.id, singer]));
  const singerCounts = new Map();
  const singerNames = new Map();
  const genreCounts = new Map();
  session.turns.forEach((turn) => {
    if (turn.singerId) {
      singerCounts.set(turn.singerId, (singerCounts.get(turn.singerId) || 0) + 1);
      if (!singerNames.has(turn.singerId) && turn.singerName) singerNames.set(turn.singerId, turn.singerName);
    }
    const song = songsById.get(turn.songId.toLowerCase());
    if (song?.genre) genreCounts.set(song.genre, (genreCounts.get(song.genre) || 0) + 1);
  });
  const songsBySinger = [...singerCounts.entries()].map(([singerId, count]) => ({
    singer: singersById.get(singerId) || { id: singerId, name: singerNames.get(singerId) || "Former singer" },
    count
  }));
  songsBySinger.sort((a, b) => b.count - a.count || a.singer.name.localeCompare(b.singer.name));
  return {
    songsCompleted: session.turns.length,
    turnsCompleted: session.turns.length,
    songsBySinger,
    mostActiveSinger: songsBySinger[0]?.singer || null,
    genresSung: [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).map(([genre, count]) => ({ genre, count }))
  };
}

export function getPartyQueueItems(queueSongs, session) {
  const queueSession = reconcilePartyQueue(session, queueSongs.map((song) => song.id));
  return queueSongs.map((song) => ({ song, singer: getAssignedSinger(queueSession, song.id) }));
}

/**
 * Reconciles party assignments against the displayed queue without changing
 * completed turns. Existing assignments keep their singer; only unassigned
 * queue entries are filled in displayed order from the current rotation.
 */
export function reconcilePartyQueue(session, queueIds = []) {
  const normalized = normalizePartySession(session);
  const canonicalQueue = [];
  const seen = new Set();
  queueIds.forEach((value) => {
    const id = normalizeId(value);
    const key = id.toLowerCase();
    if (id && !seen.has(key)) {
      seen.add(key);
      canonicalQueue.push(id);
    }
  });

  const allowed = new Set(canonicalQueue.map((id) => id.toLowerCase()));
  const assignments = {};
  const assignedKeys = new Set();
  Object.entries(normalized.assignments).forEach(([songId, singerId]) => {
    const key = songId.toLowerCase();
    if (allowed.has(key) && !assignedKeys.has(key)) {
      const canonicalId = canonicalQueue.find((id) => id.toLowerCase() === key) || songId;
      assignments[canonicalId] = singerId;
      assignedKeys.add(key);
    }
  });

  let rotationIndex = normalized.rotationIndex;
  canonicalQueue.forEach((songId) => {
    if (assignedKeys.has(songId.toLowerCase())) return;
    const singer = normalized.singers[rotationIndex % normalized.singers.length];
    if (!singer) return;
    assignments[songId] = singer.id;
    assignedKeys.add(songId.toLowerCase());
    rotationIndex = (rotationIndex + 1) % normalized.singers.length;
  });

  return { ...normalized, assignments, rotationIndex: normalized.singers.length ? rotationIndex % normalized.singers.length : 0 };
}

/**
 * Removes optional constraints in a deliberate order. Language is retained
 * until last so a relaxed roll still respects the strongest user intent when
 * the catalog makes that possible.
 */
export function relaxRouletteConstraints(songs, userState, constraints = {}, options = {}) {
  const next = { language: "any", genre: "any", mood: "any", difficulty: "any", era: "any", ...constraints };
  const relaxed = [];
  let candidates = getRouletteCandidates(songs, userState, next, options);
  ["mood", "era", "difficulty", "genre", "language"].forEach((key) => {
    if (candidates.length || next[key] === "any") return;
    next[key] = "any";
    relaxed.push(key);
    candidates = getRouletteCandidates(songs, userState, next, options);
  });
  return { constraints: next, relaxed, candidates };
}

export function getRouletteCandidates(songs, userState, constraints = {}, options = {}) {
  const queueIds = new Set((userState.queue || []).map((id) => id.toLowerCase()));
  const dislikedIds = new Set((userState.dislikedSongs || []).map((id) => id.toLowerCase()));
  const excludedIds = new Set((options.excludeSongIds || []).map((id) => String(id).toLowerCase()));
  const currentId = userState.currentSongId?.toLowerCase();
  const matches = songs.filter((song) => {
    const songId = song.id.toLowerCase();
    if (!isValidYouTubeVideoId(song.youtubeVideoId) || queueIds.has(songId) || dislikedIds.has(songId) || songId === currentId || excludedIds.has(songId)) return false;
    return matchesRouletteConstraints(song, constraints);
  });
  return preferFreshAndDiverse(matches, songs, userState, options.partySession, options.now || Date.now());
}

export function selectRouletteSong(songs, userState, constraints = {}, options = {}) {
  const candidates = getRouletteCandidates(songs, userState, constraints, options);
  if (candidates.length === 0) return null;
  const random = typeof options.random === "function" ? options.random : secureRandomUnit;
  const index = Math.min(candidates.length - 1, Math.floor(Math.max(0, Math.min(0.999999, random())) * candidates.length));
  return candidates[index];
}

export function normalizeSingerName(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_PARTY_NAME_LENGTH);
}

export function normalizeId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSingers(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  const names = new Set();
  return value.reduce((singers, item) => {
    const id = normalizeId(item?.id);
    const name = normalizeSingerName(item?.name);
    if (!id || !name || ids.has(id) || names.has(name.toLowerCase()) || singers.length >= MAX_PARTY_SINGERS) return singers;
    ids.add(id);
    names.add(name.toLowerCase());
    singers.push({ id, name });
    return singers;
  }, []);
}

function normalizeTurns(value) {
  if (!Array.isArray(value)) return [];
  return value.reduce((turns, item) => {
    const songId = normalizeId(item?.songId);
    const date = typeof item?.completedAt === "string" && !Number.isNaN(Date.parse(item.completedAt)) ? new Date(item.completedAt).toISOString() : null;
    if (!songId || !date || turns.length >= MAX_PARTY_TURNS) return turns;
    const singerId = normalizeId(item.singerId);
    const singerName = normalizeSingerName(item.singerName);
    turns.push({ songId, singerId: singerId || null, singerName: singerName || null, completedAt: date });
    return turns;
  }, []);
}

function preferFreshAndDiverse(candidates, songs, userState, session, now) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const recentCutoff = (Number.isNaN(nowMs) ? Date.now() : nowMs) - PARTY_RECENT_SONG_DAYS * 86400000;
  const recentIds = new Set((userState.sungHistory || []).filter((entry) => Date.parse(entry.sungAt) >= recentCutoff).map((entry) => entry.id.toLowerCase()));
  const fresh = candidates.filter((song) => !recentIds.has(song.id.toLowerCase()));
  const pool = fresh.length > 0 ? fresh : candidates;
  const songsById = new Map(songs.map((song) => [song.id.toLowerCase(), song]));
  const recentArtists = new Set((session?.turns || []).slice(0, 3).map((turn) => songsById.get(turn.songId.toLowerCase())?.artist.toLowerCase()).filter(Boolean));
  const diverse = pool.filter((song) => !recentArtists.has(song.artist.toLowerCase()));
  return diverse.length > 0 ? diverse : pool;
}

function matchesRouletteConstraints(song, constraints) {
  const matches = (value, selected) => !selected || selected === "any" || String(value).toLowerCase() === String(selected).toLowerCase();
  return matches(song.language, constraints.language)
    && matches(song.genre, constraints.genre)
    && matches(song.difficulty, constraints.difficulty)
    && matches(song.era, constraints.era)
    && (!constraints.mood || constraints.mood === "any" || song.mood.includes(constraints.mood.toLowerCase()));
}

function findSinger(session, singerId) {
  const id = normalizeId(singerId);
  return session?.singers?.find((singer) => singer.id === id) || null;
}

function createSingerId() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.getRandomValues) {
    const values = new Uint32Array(2);
    cryptoRef.getRandomValues(values);
    return `singer-${values[0].toString(36)}${values[1].toString(36)}`;
  }
  return `singer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function secureRandomUnit() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.getRandomValues) return cryptoRef.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  return Math.random();
}

function reconcilePartySession(session, songs, queueIds) {
  const normalized = normalizePartySession(session);
  const canonicalIds = new Map(songs.map((song) => [song.id.toLowerCase(), song.id]));
  const canonicalQueue = queueIds.map((id) => canonicalIds.get(String(id).toLowerCase())).filter(Boolean);
  const canonicalSession = { ...normalized, assignments: Object.fromEntries(Object.entries(normalized.assignments).map(([songId, singerId]) => [canonicalIds.get(songId.toLowerCase()) || songId, singerId])) };
  return reconcilePartyQueue(canonicalSession, canonicalQueue);
}

export function reconcilePartyState(session, songs, queueIds) {
  return reconcilePartySession(session, songs, queueIds);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
