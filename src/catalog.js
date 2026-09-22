/**
 * Catalog loading and normalization.
 *
 * Deliberate representations for the current catalog:
 * - genre is one normalized string for simple filtering.
 * - era is a decade string such as "1990s".
 * - mood is always an array so songs can gain multiple moods later.
 * - difficulty, vocalRange, and performanceType use lowercase controlled values.
 * - demandTier is optional and only present when separate demand evidence supports it.
 * - youtubeVideoId is null until a real, verified YouTube ID is supplied.
 */

export const DEFAULT_CATALOG_URL = "data/songs.sample.json";

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const VOCAL_RANGES = new Set(["low", "medium", "high"]);
const PERFORMANCE_TYPES = new Set(["solo", "duet", "group"]);
export const DEMAND_TIERS = new Set(["very-high", "high", "established"]);
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export class CatalogLoadError extends Error {
  constructor(message, code = "catalog-load-failed") {
    super(message);
    this.name = "CatalogLoadError";
    this.code = code;
  }
}

export async function loadCatalog(url = DEFAULT_CATALOG_URL, options = {}) {
  const logger = options.logger || console;
  let response;

  try {
    response = await fetch(url);
  } catch (error) {
    logger.error?.("KantaTayo catalog request failed.", error);
    throw new CatalogLoadError("The song catalog could not be reached.", "catalog-request-failed");
  }

  if (!response.ok) {
    logger.error?.(`KantaTayo catalog request returned ${response.status}.`);
    throw new CatalogLoadError("The song catalog could not be loaded.", "catalog-http-failed");
  }

  let rawCatalog;
  try {
    rawCatalog = await response.json();
  } catch (error) {
    logger.error?.("KantaTayo catalog JSON is invalid.", error);
    throw new CatalogLoadError("The song catalog is unavailable right now.", "catalog-json-invalid");
  }

  if (!Array.isArray(rawCatalog)) {
    logger.error?.("KantaTayo catalog must be a top-level array of song records.");
    throw new CatalogLoadError("The song catalog has an unsupported structure.", "catalog-shape-invalid");
  }

  const result = normalizeCatalog(rawCatalog, { logger });
  if (result.songs.length === 0) {
    throw new CatalogLoadError("The song catalog does not contain any usable songs.", "catalog-empty");
  }

  return result;
}

export function normalizeCatalog(records, options = {}) {
  if (!Array.isArray(records)) {
    throw new CatalogLoadError("The song catalog must be a top-level array of song records.", "catalog-shape-invalid");
  }

  const logger = options.logger || console;
  const songs = [];
  const warnings = [];
  const seenIds = new Set();

  records.forEach((record, index) => {
    const result = normalizeSong(record, index, seenIds);
    if (result.song) {
      songs.push(result.song);
      result.warnings.forEach((message) => warn(logger, warnings, message));
      return;
    }

    result.warnings.forEach((message) => warn(logger, warnings, message));
  });

  return {
    songs,
    warnings,
    totalRecords: records.length,
    rejectedRecords: records.length - songs.length
  };
}

function normalizeSong(record, index, seenIds) {
  const warnings = [];
  if (!isPlainObject(record)) {
    warnings.push(`Song record ${index + 1} was rejected because it is not an object.`);
    return { song: null, warnings };
  }

  const id = requiredText(record.id, "id");
  if (!id) {
    warnings.push(`Song record ${index + 1} was rejected because id is required.`);
    return { song: null, warnings };
  }

  const idKey = id.toLowerCase();
  if (seenIds.has(idKey)) {
    warnings.push(`Song record ${index + 1} with id "${id}" was rejected because the id is duplicated.`);
    return { song: null, warnings };
  }
  seenIds.add(idKey);

  const title = requiredText(record.title, "title");
  const artist = requiredText(record.artist, "artist");
  const language = requiredText(record.language, "language");
  const genre = requiredText(record.genre, "genre");
  const era = normalizeEra(record.era);
  const mood = normalizeList(record.mood);

  const missingFields = [
    ["title", title], ["artist", artist], ["language", language],
    ["genre", genre], ["era", era], ["mood", mood.length > 0]
  ].filter(([, value]) => !value).map(([field]) => field);

  if (missingFields.length > 0) {
    warnings.push(`Song record ${index + 1} with id "${id}" was rejected because these fields are missing or invalid: ${missingFields.join(", ")}.`);
    return { song: null, warnings };
  }

  const difficulty = normalizeControlled(record.difficulty, DIFFICULTIES, "medium", "difficulty", warnings, index);
  const vocalRange = normalizeControlled(record.vocalRange, VOCAL_RANGES, "medium", "vocalRange", warnings, index);
  const performanceType = normalizeControlled(record.performanceType, PERFORMANCE_TYPES, "solo", "performanceType", warnings, index);
  const demandTier = normalizeDemandTier(record.demandTier, warnings, index);
  const youtubeVideoId = normalizeYouTubeId(record.youtubeVideoId, warnings, index);
  const tags = normalizeList(record.tags);

  if (tags.length === 0) warnings.push(`Song record ${index + 1} with id "${id}" has no tags; it remains usable.`);

  return {
    song: { id, title, artist, language, genre, era, mood, difficulty, vocalRange, performanceType, demandTier, youtubeVideoId, tags },
    warnings
  };
}

function requiredText(value) {
  if (typeof value !== "string") return "";
  return normalizeWhitespace(value);
}

function normalizeWhitespace(value) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeList(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.filter((item) => typeof item === "string").map(normalizeWhitespace).filter(Boolean).map((item) => item.toLowerCase()))];
}

function normalizeEra(value) {
  if (typeof value === "number" && Number.isInteger(value)) return `${value}s`;
  if (typeof value !== "string") return "";
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (/^\d{4}s$/.test(normalized)) return normalized;
  if (/^\d{4}$/.test(normalized)) return `${normalized}s`;
  return "";
}

function normalizeControlled(value, allowedValues, fallback, field, warnings, index) {
  const normalized = typeof value === "string" ? normalizeWhitespace(value).toLowerCase() : "";
  if (allowedValues.has(normalized)) return normalized;
  warnings.push(`Song record ${index + 1} has an invalid ${field}; defaulted to "${fallback}".`);
  return fallback;
}

function normalizeDemandTier(value, warnings, index) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = typeof value === "string" ? normalizeWhitespace(value).toLowerCase() : "";
  if (DEMAND_TIERS.has(normalized)) return normalized;
  warnings.push(`Song record ${index + 1} has an invalid demandTier; it was ignored.`);
  return null;
}

function normalizeYouTubeId(value, warnings, index) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && YOUTUBE_ID_PATTERN.test(value.trim())) return value.trim();
  warnings.push(`Song record ${index + 1} has an invalid youtubeVideoId; it was set to null.`);
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function warn(logger, warnings, message) {
  warnings.push(message);
  logger.warn?.(`[KantaTayo catalog] ${message}`);
}
