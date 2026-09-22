/**
 * Pure, local discovery helpers. The catalog is small enough that a normalized
 * in-memory index is faster and simpler than a database or external search API.
 */

const DIFFICULTY_ORDER = { easy: 0, medium: 1, hard: 2 };

export function createSearchIndex(songs) {
  return songs.map((song, index) => ({
    song,
    index,
    searchText: buildSearchText(song)
  }));
}

export function normalizeQuery(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function getDiscoverySongs(index, options = {}) {
  const query = normalizeQuery(options.query);
  const tokens = query ? query.split(" ") : [];
  const filter = normalizeQuery(options.filter || "all");
  const favoriteIds = new Set((options.favoriteIds || []).map((id) => String(id).toLowerCase()));
  const filtered = index.filter((entry) => {
    const matchesQuery = tokens.length === 0 || tokens.every((token) => entry.searchText.includes(token));
    return matchesQuery && matchesDiscoveryFilter(entry.song, filter, favoriteIds);
  });

  return sortDiscoveryEntries(filtered, query, options.sortBy || "relevance").map((entry) => entry.song);
}

export function scoreSong(song, query) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return 0;

  const title = normalizeQuery(song.title);
  const artist = normalizeQuery(song.artist);
  const fields = [
    title,
    artist,
    normalizeQuery(song.genre),
    normalizeQuery(song.language),
    normalizeQuery(song.era),
    normalizeQuery(song.performanceType),
    ...(song.mood || []).map(normalizeQuery),
    ...(song.tags || []).map(normalizeQuery)
  ];
  let score = fields.reduce((total, field) => total + (field.includes(normalizedQuery) ? 1 : 0), 0);
  if (title === normalizedQuery) score += 100;
  else if (title.startsWith(normalizedQuery)) score += 60;
  if (artist === normalizedQuery) score += 50;
  else if (artist.startsWith(normalizedQuery)) score += 30;
  return score;
}

function buildSearchText(song) {
  return normalizeQuery([
    song.title,
    song.artist,
    song.genre,
    song.language,
    song.era,
    song.performanceType,
    ...(song.mood || []),
    ...(song.tags || [])
  ].join(" "));
}

function matchesDiscoveryFilter(song, filter, favoriteIds) {
  if (!filter || filter === "all") return true;
  if (filter === "favorites") return favoriteIds.has(song.id.toLowerCase());
  const values = new Set([
    song.difficulty,
    song.vocalRange,
    song.performanceType,
    normalizeQuery(song.genre),
    normalizeQuery(song.language),
    normalizeQuery(song.era),
    ...(song.mood || []).map(normalizeQuery),
    ...(song.tags || []).map(normalizeQuery)
  ]);
  return values.has(filter);
}

function sortDiscoveryEntries(entries, query, sortBy) {
  return [...entries].sort((left, right) => {
    if (sortBy === "title") return compareText(left.song.title, right.song.title) || left.index - right.index;
    if (sortBy === "artist") return compareText(left.song.artist, right.song.artist) || left.index - right.index;
    if (sortBy === "easy") return (DIFFICULTY_ORDER[left.song.difficulty] - DIFFICULTY_ORDER[right.song.difficulty]) || compareText(left.song.title, right.song.title) || left.index - right.index;
    if (query) return scoreSong(right.song, query) - scoreSong(left.song, query) || left.index - right.index;
    return left.index - right.index;
  });
}

function compareText(left, right) {
  return normalizeQuery(left).localeCompare(normalizeQuery(right));
}
