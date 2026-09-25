import { isPlayableSong } from "./discovery.js?v=4";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const DEMAND_TIERS = ["very-high", "high", "established", ""];
const TIER_SCHEDULE = ["very-high", "very-high", "high", "very-high", "established", "high", "very-high"];

/**
 * Returns a local-calendar date key. Date-only keys are intentionally local;
 * a user crossing midnight should receive the next challenge immediately.
 */
export function getLocalDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Selects one challenge without using array position or Math.random().
 * Demand tiers choose a conservative popularity bucket; a stable hash of the
 * local date and song ID rotates within that bucket and keeps catalog reorder
 * from changing the result.
 */
export function selectDailyChallengeSong(songs = [], dateKey = getLocalDateKey()) {
  if (!isValidDateKey(dateKey)) return null;

  const playable = (Array.isArray(songs) ? songs : [])
    .filter(isChallengeCandidate)
    .sort(compareStableIdentity);
  if (playable.length === 0) return null;

  const previous = selectForDate(playable, previousDateKey(dateKey));
  return selectForDate(playable, dateKey, previous?.artist);
}

export function getDailyChallengeSelection(songs = [], options = {}) {
  const dateKey = getLocalDateKey(options.now || new Date());
  return { dateKey, song: selectDailyChallengeSong(songs, dateKey) };
}

function selectForDate(playable, dateKey, avoidArtist = "") {
  const availableTiers = new Set(playable.map((song) => demandTier(song)));
  const scheduledTier = TIER_SCHEDULE[dayNumber(dateKey) % TIER_SCHEDULE.length];
  const preferredTier = [scheduledTier, ...DEMAND_TIERS].find((tier) => availableTiers.has(tier));
  const orderedTiers = [preferredTier, ...DEMAND_TIERS.filter((tier) => tier !== preferredTier)];
  const ranked = orderedTiers.flatMap((tier) => playable
    .filter((song) => demandTier(song) === tier)
    .sort((left, right) => stableRank(dateKey, left) - stableRank(dateKey, right) || compareStableIdentity(left, right)));

  if (ranked.length === 0) return null;
  const first = ranked[0];
  if (!avoidArtist) return first;
  return ranked.find((song) => normalize(song.artist) !== normalize(avoidArtist)) || first;
}

function isChallengeCandidate(song) {
  return isPlayableSong(song)
    && typeof song.title === "string"
    && song.title.trim().length > 0
    && typeof song.artist === "string"
    && song.artist.trim().length > 0;
}

function demandTier(song) {
  const value = typeof song?.demandTier === "string" ? song.demandTier.trim().toLowerCase() : "";
  return DEMAND_TIERS.includes(value) ? value : "";
}

function stableRank(dateKey, song) {
  return stableHash(`${dateKey}|${song.id}`);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function compareStableIdentity(left, right) {
  return normalize(left.id).localeCompare(normalize(right.id))
    || normalize(left.title).localeCompare(normalize(right.title))
    || normalize(left.artist).localeCompare(normalize(right.artist));
}

function normalize(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

export function isValidDateKey(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return getLocalDateKey(new Date(year, month - 1, day)) === value;
}

function previousDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return getLocalDateKey(new Date(year, month - 1, day - 1));
}

function dayNumber(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}
