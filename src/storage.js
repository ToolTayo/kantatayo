/**
 * Small localStorage adapter. It owns browser-storage failure handling so the
 * rest of the application never needs to scatter try/catch blocks or keys.
 */

export const STORAGE_KEY = "kantatayo:user-state";

export function readStoredJson({
  key = STORAGE_KEY,
  fallback,
  migrate,
  validate,
  storage,
  logger = console
} = {}) {
  const safeFallback = createFallback(fallback);
  const target = getStorage(storage);
  if (!target) return safeFallback;

  let rawValue;
  try {
    rawValue = target.getItem(key);
  } catch (error) {
    logger.warn?.("[KantaTayo storage] localStorage could not be read.", error);
    return safeFallback;
  }

  if (!rawValue) return safeFallback;

  try {
    const parsed = JSON.parse(rawValue);
    const migrated = migrate ? migrate(parsed) : parsed;
    return validate ? validate(migrated) : migrated;
  } catch (error) {
    logger.warn?.("[KantaTayo storage] Stored user state was invalid; defaults were used.", error);
    return safeFallback;
  }
}

export function writeStoredJson(value, { key = STORAGE_KEY, storage, logger = console } = {}) {
  const target = getStorage(storage);
  if (!target) return false;

  try {
    target.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    logger.warn?.("[KantaTayo storage] User state could not be saved.", error);
    return false;
  }
}

function getStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function createFallback(fallback) {
  return typeof fallback === "function" ? fallback() : fallback;
}
