/**
 * Pure, local discovery helpers. The catalog is small enough that a normalized
 * in-memory index is faster and simpler than a database or external search API.
 */

const DIFFICULTY_ORDER = { easy: 0, medium: 1, hard: 2 };
const DEMAND_ORDER = { "very-high": 0, high: 1, established: 2 };
const HOME_SHELF_LIMITS = Object.freeze({
  recommended: 5,
  favorites: 5,
  popular: 5,
  opm: 4,
  international: 4,
  easy: 4,
  duets: 4,
  recent: 4
});

export const DEFAULT_DISCOVERY_FILTERS = Object.freeze({
  availability: "all",
  language: "any",
  genre: "any",
  mood: "any",
  difficulty: "any",
  vocalRange: "any",
  performanceType: "any",
  era: "any",
  favorites: false
});

export { HOME_SHELF_LIMITS };

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
    .replace(/[’'`]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function getDiscoverySongs(index, options = {}) {
  const query = normalizeQuery(options.query);
  const tokens = query ? query.split(" ") : [];
  const filters = normalizeDiscoveryFilters(options.filters, options.filter);
  const favoriteIds = new Set((options.favoriteIds || []).map((id) => String(id).toLowerCase()));
  const filtered = index.filter((entry) => {
    const matchesQuery = tokens.length === 0 || tokens.every((token) => entry.searchText.includes(token));
    return matchesQuery && matchesDiscoveryFilters(entry.song, filters, favoriteIds);
  });

  return sortDiscoveryEntries(filtered, query, options.sortBy || "relevance").map((entry) => entry.song);
}

export function normalizeDiscoveryFilters(filters = {}, legacyFilter = "all") {
  const next = { ...DEFAULT_DISCOVERY_FILTERS };
  const source = filters && typeof filters === "object" ? filters : {};
  for (const key of Object.keys(next)) {
    if (key === "favorites") next[key] = Boolean(source[key]);
    else if (typeof source[key] === "string" && source[key].trim()) next[key] = normalizeQuery(source[key]);
  }

  const legacy = normalizeQuery(legacyFilter || "all");
  if (!filters || Object.keys(source).length === 0) {
    if (legacy === "favorites") next.favorites = true;
    else if (legacy === "playable") next.availability = "playable";
    else if (["filipino", "english"].includes(legacy)) next.language = legacy;
    else if (["easy", "medium", "hard"].includes(legacy)) next.difficulty = legacy;
    else if (["solo", "duet", "group"].includes(legacy)) next.performanceType = legacy;
    else if (legacy !== "all") {
      next.genre = legacy;
    }
  }
  return next;
}

export function createDefaultDiscoveryFilters() {
  return { ...DEFAULT_DISCOVERY_FILTERS };
}

export function createQuickFilterState(filter) {
  const next = createDefaultDiscoveryFilters();
  const normalized = normalizeQuery(filter || "all");
  if (normalized === "playable") next.availability = "playable";
  else if (["filipino", "english"].includes(normalized)) next.language = normalized;
  else if (["easy", "medium", "hard"].includes(normalized)) next.difficulty = normalized;
  else if (["solo", "duet", "group"].includes(normalized)) next.performanceType = normalized;
  return next;
}

export function getDiscoveryFilterOptions(songs = []) {
  const catalog = Array.isArray(songs) ? songs.filter(Boolean) : [];
  const collect = (read) => [...new Set(catalog.flatMap((song) => {
    const value = read(song);
    return Array.isArray(value) ? value : [value];
  }).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))]
    .sort((left, right) => normalizeQuery(left).localeCompare(normalizeQuery(right)));
  return {
    language: collect((song) => song.language),
    genre: collect((song) => song.genre),
    mood: collect((song) => song.mood),
    difficulty: collect((song) => song.difficulty),
    vocalRange: collect((song) => song.vocalRange),
    performanceType: collect((song) => song.performanceType),
    era: collect((song) => song.era)
  };
}

export function hasActiveDiscoveryFilters(filters = {}) {
  const normalized = normalizeDiscoveryFilters(filters);
  return normalized.availability !== "all"
    || normalized.language !== "any"
    || normalized.genre !== "any"
    || normalized.mood !== "any"
    || normalized.difficulty !== "any"
    || normalized.vocalRange !== "any"
    || normalized.performanceType !== "any"
    || normalized.era !== "any"
    || normalized.favorites;
}

export function getDiscoveryPage(songs, page = 1, pageSize = 24) {
  const safeSongs = Array.isArray(songs) ? songs : [];
  const safePageSize = Math.max(1, Number(pageSize) || 24);
  const safePage = Math.max(1, Number(page) || 1);
  const start = (safePage - 1) * safePageSize;
  return {
    songs: safeSongs.slice(start, start + safePageSize),
    total: safeSongs.length,
    page: safePage,
    pageSize: safePageSize,
    hasMore: start + safePageSize < safeSongs.length
  };
}

/**
 * Selects the small, playable Home shelves from normalized catalog metadata.
 * Recommendations keep their existing order; category shelves use demand and
 * stable title order, while used IDs are avoided when there are alternatives.
 */
export function getHomeShelves(songs = [], recommendations = [], userState = {}) {
  const catalog = Array.isArray(songs) ? songs.filter(Boolean) : [];
  const recommended = (Array.isArray(recommendations) ? recommendations : [])
    .map((item) => item?.song)
    .filter((song) => isPlayableSong(song))
    .slice(0, HOME_SHELF_LIMITS.recommended);
  const recommendedIds = new Set(recommended.map((song) => song.id.toLowerCase()));
  const usedIds = new Set(recommendedIds);
  const favoriteIds = new Set((userState.favorites || []).map((id) => String(id).toLowerCase()));
  const recentSongs = getRecentlySungSongs(catalog, userState.sungHistory || []).filter(isPlayableSong);
  const favorites = catalog
    .filter((song) => favoriteIds.has(song.id.toLowerCase()) && isPlayableSong(song))
    .slice(0, HOME_SHELF_LIMITS.favorites);
  favorites.forEach((song) => usedIds.add(song.id.toLowerCase()));

  const shelves = {
    recommended,
    favorites,
    popular: selectHomeShelf(catalog, (song) => Boolean(song.demandTier), HOME_SHELF_LIMITS.popular, usedIds),
    opm: selectHomeShelf(catalog, (song) => isOpmSong(song), HOME_SHELF_LIMITS.opm, usedIds),
    international: selectHomeShelf(catalog, (song) => isInternationalSong(song), HOME_SHELF_LIMITS.international, usedIds),
    easy: selectHomeShelf(catalog, (song) => song.difficulty === "easy", HOME_SHELF_LIMITS.easy, usedIds),
    duets: selectHomeShelf(catalog, (song) => song.performanceType === "duet", HOME_SHELF_LIMITS.duets, usedIds),
    recent: recentSongs.slice(0, HOME_SHELF_LIMITS.recent)
  };

  return shelves;
}

export function isPlayableSong(song) {
  return Boolean(song && typeof song.id === "string" && /^[A-Za-z0-9_-]{11}$/.test(String(song.youtubeVideoId || "").trim()));
}

export function isOpmSong(song) {
  const tags = new Set((song?.tags || []).map((tag) => normalizeQuery(tag)));
  return normalizeQuery(song?.language) === "filipino" || tags.has("opm");
}

export function isInternationalSong(song) {
  const tags = new Set((song?.tags || []).map((tag) => normalizeQuery(tag)));
  return normalizeQuery(song?.language) === "english" || tags.has("international");
}

export function getRecentlySungSongs(visibleSongs, history) {
  const visibleById = new Map(visibleSongs.map((song) => [song.id.toLowerCase(), song]));
  const seen = new Set();
  return (Array.isArray(history) ? history : []).reduce((songs, entry) => {
    const key = typeof entry?.id === "string" ? entry.id.toLowerCase() : "";
    const song = visibleById.get(key);
    if (!song || seen.has(key)) return songs;
    seen.add(key);
    songs.push(song);
    return songs;
  }, []);
}

function selectHomeShelf(catalog, predicate, limit, usedIds) {
  const candidates = catalog.filter((song) => predicate(song) && isPlayableSong(song));
  const fresh = candidates.filter((song) => !usedIds.has(song.id.toLowerCase())).sort(compareHomeSongs);
  const repeated = candidates.filter((song) => usedIds.has(song.id.toLowerCase())).sort(compareHomeSongs);
  const selected = [...fresh, ...repeated].slice(0, limit);
  selected.forEach((song) => usedIds.add(song.id.toLowerCase()));
  return selected;
}

function compareHomeSongs(left, right) {
  return (DEMAND_ORDER[left.demandTier] ?? 3) - (DEMAND_ORDER[right.demandTier] ?? 3)
    || compareText(left.title, right.title)
    || compareText(left.artist, right.artist)
    || left.id.localeCompare(right.id);
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

function matchesDiscoveryFilters(song, filters, favoriteIds) {
  if (filters.favorites && !favoriteIds.has(song.id.toLowerCase())) return false;
  if (filters.availability === "playable" && !isPlayableSong(song)) return false;
  if (filters.language !== "any" && normalizeQuery(song.language) !== filters.language) return false;
  if (filters.genre !== "any" && normalizeQuery(song.genre) !== filters.genre) return false;
  if (filters.mood !== "any" && !(song.mood || []).some((value) => normalizeQuery(value) === filters.mood)) return false;
  if (filters.difficulty !== "any" && normalizeQuery(song.difficulty) !== filters.difficulty) return false;
  if (filters.vocalRange !== "any" && normalizeQuery(song.vocalRange) !== filters.vocalRange) return false;
  if (filters.performanceType !== "any" && normalizeQuery(song.performanceType) !== filters.performanceType) return false;
  if (filters.era !== "any" && normalizeQuery(song.era) !== filters.era) return false;
  return true;
}

function sortDiscoveryEntries(entries, query, sortBy) {
  return [...entries].sort((left, right) => {
    if (sortBy === "title") return compareText(left.song.title, right.song.title) || left.index - right.index;
    if (sortBy === "artist") return compareText(left.song.artist, right.song.artist) || left.index - right.index;
    if (sortBy === "popular") return compareDemand(left.song, right.song) || compareText(left.song.title, right.song.title) || compareText(left.song.artist, right.song.artist) || left.song.id.localeCompare(right.song.id) || left.index - right.index;
    if (sortBy === "easy") return (DIFFICULTY_ORDER[left.song.difficulty] - DIFFICULTY_ORDER[right.song.difficulty]) || compareText(left.song.title, right.song.title) || left.index - right.index;
    if (query) return scoreSong(right.song, query) - scoreSong(left.song, query) || left.index - right.index;
    return left.index - right.index;
  });
}

function compareDemand(left, right) {
  return (DEMAND_ORDER[left.demandTier] ?? 3) - (DEMAND_ORDER[right.demandTier] ?? 3);
}

function compareText(left, right) {
  return normalizeQuery(left).localeCompare(normalizeQuery(right));
}
