import { isPlayableSong } from "./discovery.js?v=4";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Local-only engagement helpers. These signals are deliberately transparent:
 * they use only the catalog and the user's persisted device state.
 */
export function getLocalDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getDailyChallenge(songs = [], userState = {}, options = {}) {
  const dateKey = getLocalDateKey(options.now || new Date());
  const playable = (Array.isArray(songs) ? songs : [])
    .filter(isPlayableSong)
    .sort((left, right) => left.id.localeCompare(right.id));
  const song = playable.length ? playable[stableHash(dateKey) % playable.length] : null;
  const completedDates = Array.isArray(userState.dailyChallenge?.completedDates)
    ? userState.dailyChallenge.completedDates
    : [];
  const streak = getStreakStats(completedDates, dateKey);
  return {
    dateKey,
    song,
    completed: Boolean(dateKey && completedDates.includes(dateKey)),
    currentStreak: streak.currentStreak,
    longestStreak: streak.longestStreak
  };
}

export function getStreakStats(completedDates = [], todayKey = getLocalDateKey()) {
  const dates = [...new Set((Array.isArray(completedDates) ? completedDates : []).filter((value) => DATE_PATTERN.test(value)))]
    .sort();
  const dateSet = new Set(dates);
  let longestStreak = 0;
  let run = 0;
  let previous = null;
  for (const dateKey of dates) {
    if (previous && differenceInDays(previous, dateKey) === 1) run += 1;
    else run = 1;
    longestStreak = Math.max(longestStreak, run);
    previous = dateKey;
  }

  let currentStreak = 0;
  if (dateSet.has(todayKey)) {
    currentStreak = 1;
    let cursor = todayKey;
    while (dateSet.has(addDays(cursor, -1))) {
      currentStreak += 1;
      cursor = addDays(cursor, -1);
    }
  }
  return { currentStreak, longestStreak };
}

export function getContinueSingingSongs(songs = [], userState = {}, limit = 4) {
  const byId = new Map((Array.isArray(songs) ? songs : []).map((song) => [song.id.toLowerCase(), song]));
  const seen = new Set();
  const entries = [
    ...(Array.isArray(userState.recentlyPlayed) ? userState.recentlyPlayed : []),
    ...(Array.isArray(userState.sungHistory) ? userState.sungHistory : [])
  ];
  return entries.reduce((result, entry) => {
    const id = typeof entry === "string" ? entry : entry?.id;
    const key = typeof id === "string" ? id.toLowerCase() : "";
    const song = byId.get(key);
    if (!song || seen.has(key) || !isPlayableSong(song)) return result;
    seen.add(key);
    result.push(song);
    return result;
  }, []).slice(0, Math.max(0, Number(limit) || 4));
}

export function getRecentlyAddedSongs(songs = [], limit = 4) {
  const catalog = (Array.isArray(songs) ? songs : []).filter(isPlayableSong);
  return [...catalog]
    .sort((left, right) => catalogPosition(right) - catalogPosition(left) || right.id.localeCompare(left.id))
    .slice(0, Math.max(0, Number(limit) || 4));
}

export function getTrendingSongs(songs = [], userState = {}, limit = 4) {
  const catalog = (Array.isArray(songs) ? songs : []).filter(isPlayableSong);
  const history = Array.isArray(userState.sungHistory) ? userState.sungHistory : [];
  const historyCount = new Map();
  history.forEach((entry) => {
    const id = typeof entry?.id === "string" ? entry.id.toLowerCase() : "";
    if (id) historyCount.set(id, (historyCount.get(id) || 0) + 1);
  });
  const favorites = new Set((userState.favorites || []).map((id) => String(id).toLowerCase()));
  const likes = new Set((userState.likedSongs || []).map((id) => String(id).toLowerCase()));
  const scored = catalog.map((song) => {
    const key = song.id.toLowerCase();
    return {
      song,
      score: (historyCount.get(key) || 0) * 4 + (favorites.has(key) ? 2 : 0) + (likes.has(key) ? 1 : 0)
    };
  }).filter((item) => item.score > 0);
  return scored.sort((left, right) => right.score - left.score || left.song.title.localeCompare(right.song.title))
    .slice(0, Math.max(0, Number(limit) || 4))
    .map((item) => item.song);
}

export function getLocalStats(songs = [], userState = {}, options = {}) {
  const byId = new Map((Array.isArray(songs) ? songs : []).map((song) => [song.id.toLowerCase(), song]));
  const history = Array.isArray(userState.sungHistory) ? userState.sungHistory : [];
  const artists = new Map();
  let opm = 0;
  let international = 0;
  history.forEach((entry) => {
    const song = byId.get(String(entry?.id || "").toLowerCase());
    if (!song) return;
    const artistKey = song.artist.trim();
    artists.set(artistKey, (artists.get(artistKey) || 0) + 1);
    if (String(song.language).toLowerCase() === "filipino") opm += 1;
    if (String(song.language).toLowerCase() === "english") international += 1;
  });
  const dateKey = getLocalDateKey(options.now || new Date());
  const streak = getStreakStats(userState.dailyChallenge?.completedDates, dateKey);
  return {
    songsSung: history.length,
    uniqueSongsSung: new Set(history.map((entry) => String(entry?.id || "").toLowerCase()).filter(Boolean)).size,
    favorites: Array.isArray(userState.favorites) ? userState.favorites.length : 0,
    currentStreak: streak.currentStreak,
    longestStreak: streak.longestStreak,
    opm,
    international,
    topArtists: [...artists.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 3)
      .map(([artist, count]) => ({ artist, count }))
  };
}

function catalogPosition(song) {
  const match = String(song.id).match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function addDays(dateKey, amount) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day + amount);
  return getLocalDateKey(date);
}

function differenceInDays(leftKey, rightKey) {
  const left = new Date(`${leftKey}T00:00:00`);
  const right = new Date(`${rightKey}T00:00:00`);
  return Math.round((right - left) / 86400000);
}
