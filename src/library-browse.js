// Local, read-only browsing helpers. Never mutate catalog or saved user state.
import { normalizeQuery, getRecentlySungSongs } from "./discovery.js?v=6";
import { isValidYouTubeVideoId } from "./youtube.js";

const matches = (query, text) => normalizeQuery(query).split(" ").filter(Boolean).every(token => normalizeQuery(text).includes(token));
const alphabetic = (a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true });

export function browseMedleys(medleys = [], { query = "", category = "all", provider = "", sort = "curated" } = {}) {
  const items = (Array.isArray(medleys) ? medleys : []).filter(item => item?.id && isValidYouTubeVideoId(item.videoId));
  const results = items.filter(item => {
    const opm = /filipino|tagalog|opm/i.test(`${item.language} ${item.theme}`);
    const international = /english|international/i.test(item.language);
    return (category !== "opm" || opm) && (category !== "international" || international)
      && (!provider || item.provider === provider)
      && matches(query, [item.title, item.provider, item.theme, item.language, ...(Array.isArray(item.includedSongs) ? item.includedSongs : []).filter(Boolean).map(song => `${song.title || ""} ${song.artist || ""}`)].join(" "));
  });
  if (sort === "title") results.sort((a, b) => alphabetic(a.title, b.title));
  // Recorded public-view snapshots, not live trends or KantaCue usage.
  if (sort === "views") results.sort((a, b) => (Number(b.publicViews) || 0) - (Number(a.publicViews) || 0) || alphabetic(a.title, b.title));
  return results;
}

export function browseLibrary(songs = [], user = {}, kind = "favorites", { query = "", sort = "recent" } = {}) {
  const catalog = (Array.isArray(songs) ? songs : []).filter(song => typeof song?.id === "string");
  const byId = new Map(catalog.map(song => [song.id.toLowerCase(), song]));
  const favorites = [...new Set((Array.isArray(user.favorites) ? user.favorites : []).filter(id => typeof id === "string").map(id => id.toLowerCase()))];
  const items = kind === "recent" ? getRecentlySungSongs(catalog, user.sungHistory || []) : favorites.slice().reverse().map(id => byId.get(id)).filter(Boolean);
  const results = items.filter(song => matches(query, `${song.title} ${song.artist}`));
  if (sort === "title") results.sort((a, b) => alphabetic(a.title, b.title));
  if (sort === "artist") results.sort((a, b) => alphabetic(a.artist, b.artist) || alphabetic(a.title, b.title));
  return results;
}

export function getQueueableLibrarySongs(songs, user, kind, options) {
  const queued = new Set((user.queue || []).map(id => id.toLowerCase()));
  return browseLibrary(songs, user, kind, options).filter(song => isValidYouTubeVideoId(song.youtubeVideoId) && !queued.has(song.id.toLowerCase()));
}

// Offer explicit corrections only after an empty search. Never silently replace a query.
export function suggestCatalogSearch(songs, query, limit = 3) {
  const tokens = normalizeQuery(query).split(" ").filter(Boolean);
  if (!tokens.length || tokens.some(token => token.length < 3) || tokens.length > 6) return [];
  const choices = new Map();
  for (const song of songs) {
    if (!isValidYouTubeVideoId(song?.youtubeVideoId)) continue;
    for (const label of [song.title, song.artist]) {
      if (typeof label !== "string") continue;
      const normalized = normalizeQuery(label);
      const words = normalized.split(" ");
      const scores = tokens.map(token => Math.min(...words.map(word => word.startsWith(token) ? 0 : editDistance(token, word))));
      if (scores.some((score, i) => score > (tokens[i].length >= 7 ? 2 : 1))) continue;
      const score = scores.reduce((sum, value) => sum + value, 0);
      if (score > 0 && (!choices.has(normalized) || score < choices.get(normalized).score)) choices.set(normalized, { label, score });
    }
  }
  return [...choices.values()].sort((a, b) => a.score - b.score || alphabetic(a.label, b.label)).slice(0, limit).map(item => item.label);
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2 || a.length > 80 || b.length > 80) return 3;
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
  }
  return rows[a.length][b.length];
}
