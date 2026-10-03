/**
 * Local, first-party metadata for curated karaoke medleys.
 *
 * Medleys deliberately live outside the single-song catalog. A medley is one
 * YouTube performance containing several song sections, so treating it as a
 * normal song would corrupt song history, recommendations, and Party Mode.
 */

export const DEFAULT_MEDLEYS_URL = "data/medleys.sample.json?v=7";
export const MEDLEY_ID_PATTERN = /^medley-[a-z0-9-]+$/;
export const MEDLEY_STATUS = "technical-verified-pending-manual-quality-review";
export const PUBLIC_MEDLEY_STATUSES = new Set([MEDLEY_STATUS, "verified-for-release"]);

export class MedleyLoadError extends Error {
  constructor(message, code = "medley-load-failed") {
    super(message);
    this.name = "MedleyLoadError";
    this.code = code;
  }
}

export async function loadMedleys(url = DEFAULT_MEDLEYS_URL, options = {}) {
  const logger = options.logger || console;
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    logger.warn?.("KantaCue medley collection request failed.", error);
    throw new MedleyLoadError("The medley collection could not be reached.", "medley-request-failed");
  }
  if (!response.ok) {
    logger.warn?.(`KantaCue medley collection request returned ${response.status}.`);
    throw new MedleyLoadError("The medley collection could not be loaded.", "medley-http-failed");
  }
  let raw;
  try {
    raw = await response.json();
  } catch (error) {
    logger.warn?.("KantaCue medley collection JSON is invalid.", error);
    throw new MedleyLoadError("The medley collection is unavailable right now.", "medley-json-invalid");
  }
  const result = normalizeMedleys(raw, { logger });
  if (result.medleys.length === 0) {
    throw new MedleyLoadError("The medley collection has no usable entries.", "medley-empty");
  }
  return result;
}

export function normalizeMedleys(value, options = {}) {
  const logger = options.logger || console;
  const records = Array.isArray(value) ? value : value && Array.isArray(value.medleys) ? value.medleys : null;
  if (!records) throw new MedleyLoadError("The medley collection must contain a medleys array.", "medley-shape-invalid");

  const medleys = [];
  const warnings = [];
  const seenIds = new Set();
  const seenVideoIds = new Set();
  records.forEach((record, index) => {
    const result = normalizeMedley(record, index, seenIds, seenVideoIds);
    result.warnings.forEach((message) => {
      warnings.push(message);
      logger.warn?.(`[KantaCue medleys] ${message}`);
    });
    if (result.medley) medleys.push(result.medley);
  });
  return { medleys, warnings, totalRecords: records.length, rejectedRecords: records.length - medleys.length };
}

export function getMedleyById(medleys, medleyId) {
  const key = typeof medleyId === "string" ? medleyId.trim().toLowerCase() : "";
  return (Array.isArray(medleys) ? medleys : []).find((medley) => medley.id.toLowerCase() === key) || null;
}

export function isPlayableMedley(medley) {
  return Boolean(
    medley
      && MEDLEY_ID_PATTERN.test(medley.id)
      && isValidVideoId(medley.videoId)
      && PUBLIC_MEDLEY_STATUSES.has(medley.verification?.status)
  );
}

export function medleyToPlayerItem(medley) {
  if (!isPlayableMedley(medley)) return null;
  return {
    id: medley.id,
    title: medley.title,
    artist: medley.provider,
    language: medley.language,
    genre: "medley",
    era: "",
    mood: [medley.theme],
    difficulty: "medium",
    vocalRange: "medium",
    performanceType: "group",
    youtubeVideoId: medley.videoId,
    tags: ["medley", medley.theme].filter(Boolean),
    contentType: "medley"
  };
}

export function reconcileMedleyState(userState, medleys = []) {
  const canonical = new Map((Array.isArray(medleys) ? medleys : []).map((medley) => [medley.id.toLowerCase(), medley.id]));
  const queue = (Array.isArray(userState?.medleyQueue) ? userState.medleyQueue : [])
    .filter((id) => typeof id === "string")
    .map((id) => canonical.get(id.trim().toLowerCase()))
    .filter(Boolean)
    .filter((id, index, all) => all.findIndex((item) => item.toLowerCase() === id.toLowerCase()) === index);
  const requested = typeof userState?.currentMedleyId === "string" ? userState.currentMedleyId.trim().toLowerCase() : "";
  return {
    ...userState,
    medleyQueue: queue,
    currentMedleyId: queue.find((id) => id.toLowerCase() === requested) || null,
    medleyQueueFinished: Boolean(userState?.medleyQueueFinished && queue.length > 0 && !requested)
  };
}

function normalizeMedley(record, index, seenIds, seenVideoIds) {
  const warnings = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { medley: null, warnings: [`Medley record ${index + 1} was rejected because it is not an object.`] };
  }
  const id = text(record.id);
  const title = text(record.title);
  const provider = text(record.provider);
  const videoId = text(record.videoId);
  const language = text(record.language);
  const theme = text(record.theme);
  if (!id || !MEDLEY_ID_PATTERN.test(id)) warnings.push(`Medley record ${index + 1} was rejected because id is invalid.`);
  if (id && seenIds.has(id.toLowerCase())) warnings.push(`Medley record ${index + 1} was rejected because id "${id}" is duplicated.`);
  if (id) seenIds.add(id.toLowerCase());
  if (!title) warnings.push(`Medley record ${index + 1} was rejected because title is required.`);
  if (!provider) warnings.push(`Medley record ${index + 1} was rejected because provider is required.`);
  if (!isValidVideoId(videoId)) warnings.push(`Medley record ${index + 1} was rejected because videoId is invalid.`);
  if (videoId && seenVideoIds.has(videoId.toLowerCase())) warnings.push(`Medley record ${index + 1} was rejected because videoId is duplicated.`);
  if (videoId) seenVideoIds.add(videoId.toLowerCase());
  if (!language || !theme) warnings.push(`Medley record ${index + 1} was rejected because language and theme are required.`);
  const includedSongs = normalizeIncludedSongs(record.includedSongs);
  const sectionStatus = text(record.sectionStatus) || (includedSongs.length >= 2 ? "known" : "unknown");
  const medleyEvidence = text(record.medleyEvidence);
  if (includedSongs.length < 2 && !(sectionStatus === "unknown" && medleyEvidence)) warnings.push(`Medley record ${index + 1} was rejected because it needs at least two known included songs or explicit unknown-section medley evidence.`);
  if (includedSongs.length >= 2 && sectionStatus !== "known") warnings.push(`Medley record ${index + 1} was rejected because sectionStatus conflicts with its section list.`);
  if (warnings.length) return { medley: null, warnings };

  return {
    medley: {
      id,
      title,
      provider,
      videoId,
      language,
      theme,
      sectionStatus,
      medleyEvidence,
      includedSongs,
      publicViews: normalizeOptionalCount(record.publicViews),
      publishedAt: normalizeDate(record.publishedAt),
      sourceUrl: text(record.sourceUrl),
      provenance: text(record.provenance),
      verification: normalizeVerification(record.verification)
    },
    warnings
  };
}

function normalizeIncludedSongs(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return { title: normalizeText(entry), artist: "" };
    if (!entry || typeof entry !== "object") return null;
    const title = normalizeText(entry.title);
    const artist = normalizeText(entry.artist);
    return title ? { title, artist } : null;
  }).filter(Boolean);
}

function normalizeVerification(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    status: text(source.status) || "pending-review",
    testedAt: normalizeDate(source.testedAt),
    method: text(source.method),
    manualQuality: text(source.manualQuality) || "pending-listen"
  };
}

function normalizeOptionalCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeDate(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function text(value) { return normalizeText(value); }

function isValidVideoId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value); }
