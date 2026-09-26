import { isPlayableSong } from "./discovery.js?v=4";
import { getDailyChallengeSelection, getLocalDateKey as getChallengeDateKey, isValidDateKey } from "./daily-challenge.js?v=2";

export const getLocalDateKey = getChallengeDateKey;

/**
 * Local-only engagement helpers. These signals are deliberately transparent:
 * they use only the catalog and the user's persisted device state.
 */

export function getDailyChallenge(songs = [], userState = {}, options = {}) {
  const { dateKey, song } = getDailyChallengeSelection(songs, options);
  const completedDates = Array.isArray(userState.dailyChallenge?.completedDates)
    ? userState.dailyChallenge.completedDates
    : [];
  const streak = getStreakStats(completedDates, dateKey);
  return {
    dateKey,
    song,
    completed: isDailyChallengeComplete(userState, dateKey, song?.id),
    currentStreak: streak.currentStreak,
    longestStreak: streak.longestStreak
  };
}

export function isDailyChallengeComplete(userState = {}, dateKey, songId = "") {
  const dailyChallenge = userState?.dailyChallenge;
  if (!isValidDateKey(dateKey) || !Array.isArray(dailyChallenge?.completedDates) || !dailyChallenge.completedDates.includes(dateKey)) return false;
  if (dailyChallenge.lastCompletedDate === dateKey && dailyChallenge.lastCompletedSongId) {
    return normalizeId(dailyChallenge.lastCompletedSongId) === normalizeId(songId);
  }
  // Older Step 1 state recorded completed dates but did not retain the song ID.
  // Preserve that completion rather than invalidating existing local streaks.
  return true;
}

export function getStreakStats(completedDates = [], todayKey = getLocalDateKey()) {
  const safeToday = isValidDateKey(todayKey) ? todayKey : getLocalDateKey();
  const dates = [...new Set((Array.isArray(completedDates) ? completedDates : [])
    .filter((value) => isValidDateKey(value) && value <= safeToday))]
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
  let cursor = dateSet.has(safeToday) ? safeToday : addDays(safeToday, -1);
  if (dateSet.has(cursor)) {
    currentStreak = 1;
    while (dateSet.has(addDays(cursor, -1))) {
      currentStreak += 1;
      cursor = addDays(cursor, -1);
    }
  }
  return { currentStreak, longestStreak };
}

function normalizeId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function getContinueSingingSongs(songs = [], userState = {}, limit = 4) {
  const byId = new Map((Array.isArray(songs) ? songs : [])
    .filter((song) => typeof song?.id === "string")
    .map((song) => [song.id.toLowerCase(), song]));
  const latestSungAt = new Map();
  (Array.isArray(userState.sungHistory) ? userState.sungHistory : []).forEach((entry) => {
    const key = typeof entry?.id === "string" ? entry.id.trim().toLowerCase() : "";
    const sungAt = typeof entry?.sungAt === "string" ? Date.parse(entry.sungAt) : NaN;
    if (!key || Number.isNaN(sungAt) || sungAt < (latestSungAt.get(key) ?? -Infinity)) return;
    latestSungAt.set(key, sungAt);
  });

  return (Array.isArray(userState.recentlyPlayed) ? userState.recentlyPlayed : [])
    .map((entry, index) => {
      const key = typeof entry?.id === "string" ? entry.id.trim().toLowerCase() : "";
      const playedAt = typeof entry?.playedAt === "string" ? Date.parse(entry.playedAt) : NaN;
      return { entry, index, key, playedAt };
    })
    .filter(({ key, playedAt }) => key && !Number.isNaN(playedAt) && byId.has(key) && isPlayableSong(byId.get(key)) && playedAt > (latestSungAt.get(key) ?? -Infinity))
    .sort((left, right) => right.playedAt - left.playedAt || left.index - right.index)
    .map(({ key }) => byId.get(key))
    .filter((song, index, result) => result.findIndex((item) => item.id.toLowerCase() === song.id.toLowerCase()) === index)
    .slice(0, Math.max(0, Number(limit) || 4));
}

export function getRecentlyAddedSongs(songs = [], limit = 4) {
  const catalog = (Array.isArray(songs) ? songs : []).filter(isPlayableSong);
  return [...catalog]
    .sort((left, right) => catalogPosition(right) - catalogPosition(left) || right.id.localeCompare(left.id))
    .slice(0, Math.max(0, Number(limit) || 4));
}

export function getMostSungSongs(songs = [], userState = {}, limit = 4) {
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
      sungCount: historyCount.get(key) || 0,
      favoriteSignal: favorites.has(key) ? 1 : 0,
      likeSignal: likes.has(key) ? 1 : 0
    };
  }).filter((item) => item.sungCount > 0);
  return scored.sort((left, right) => right.sungCount - left.sungCount
    || right.favoriteSignal - left.favoriteSignal
    || right.likeSignal - left.likeSignal
    || left.song.title.localeCompare(right.song.title)
    || left.song.id.localeCompare(right.song.id))
    .slice(0, Math.max(0, Number(limit) || 4))
    .map((item) => item.song);
}

// Keep the old helper name as a compatibility alias for callers from earlier steps.
export const getTrendingSongs = getMostSungSongs;

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

function addDays(dateKey, amount) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day + amount);
  return getLocalDateKey(date);
}

function differenceInDays(leftKey, rightKey) {
  const [leftYear, leftMonth, leftDay] = leftKey.split("-").map(Number);
  const [rightYear, rightMonth, rightDay] = rightKey.split("-").map(Number);
  return Math.round((Date.UTC(rightYear, rightMonth - 1, rightDay) - Date.UTC(leftYear, leftMonth - 1, leftDay)) / 86400000);
}
