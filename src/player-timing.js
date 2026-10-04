export const PRE_END_WINDOW_SECONDS = 15;

/**
 * Classify the lightweight timing window used by the player shell. Invalid
 * or stale API values stay normal so the app never invents an end state.
 */
export function getPlaybackWindowState(currentTime, duration, windowSeconds = PRE_END_WINDOW_SECONDS) {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || currentTime < 0 || duration <= 0) return "normal";
  const remaining = duration - currentTime;
  if (remaining > 0 && remaining <= windowSeconds) return "pre-end";
  return "normal";
}
