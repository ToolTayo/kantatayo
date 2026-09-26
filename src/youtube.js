/**
 * Thin integration with YouTube's official IFrame Player API.
 *
 * This module never downloads or extracts media. It creates one official
 * embedded player only after a user selects a song with a verified video ID.
 */

const YOUTUBE_API_URL = "https://www.youtube.com/iframe_api";
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const API_TIMEOUT_MS = 15000;
export const YOUTUBE_REFERRER_POLICY = "strict-origin-when-cross-origin";

let apiPromise = null;
let apiWindow = null;

export const YOUTUBE_PLAYER_STATE = Object.freeze({
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5
});

export function isValidYouTubeVideoId(value) {
  return typeof value === "string" && VIDEO_ID_PATTERN.test(value.trim());
}

export function loadYouTubeIframeApi({ windowRef = globalThis.window, documentRef = globalThis.document, logger = console } = {}) {
  if (!windowRef || !documentRef) return Promise.reject(new Error("YouTube API requires a browser document."));
  if (windowRef.YT?.Player) return Promise.resolve(windowRef.YT);
  if (apiPromise && apiWindow === windowRef) return apiPromise;

  apiWindow = windowRef;
  apiPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      windowRef.clearTimeout?.(timeoutId);
      callback(value);
    };
    const timeoutId = windowRef.setTimeout?.(() => finish(reject, new Error("YouTube IFrame API timed out.")), API_TIMEOUT_MS);
    const previousReady = windowRef.onYouTubeIframeAPIReady;
    windowRef.onYouTubeIframeAPIReady = () => {
      try { previousReady?.(); } catch (error) { logger.warn?.("Previous YouTube API callback failed.", error); }
      if (windowRef.YT?.Player) finish(resolve, windowRef.YT);
      else finish(reject, new Error("YouTube IFrame API loaded without a player constructor."));
    };

    const existingScript = documentRef.querySelector('script[data-kantacue-youtube-api]');
    if (existingScript) {
      existingScript.addEventListener?.("error", () => finish(reject, new Error("YouTube IFrame API failed to load.")), { once: true });
      return;
    }

    const script = documentRef.createElement("script");
    script.src = YOUTUBE_API_URL;
    script.async = true;
    script.dataset.kantacueYoutubeApi = "true";
    script.addEventListener("error", () => finish(reject, new Error("YouTube IFrame API failed to load.")), { once: true });
    documentRef.head.appendChild(script);
  }).catch((error) => {
      logger.warn?.("[KantaCue YouTube] API unavailable.", error);
    apiPromise = null;
    apiWindow = null;
    throw error;
  });

  return apiPromise;
}

export function createYouTubePlayerController({
  container,
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  logger = console,
  onReady = () => {},
  onStateChange = () => {},
  onError = () => {},
  onUnavailable = () => {}
} = {}) {
  let player = null;
  let playerReady = false;
  let currentVideoId = null;
  let lastEndedVideoId = null;
  let pendingLoad = null;
  let requestNumber = 0;
  let iframeObserver = null;

  async function load(videoId, { autoplay = true } = {}) {
    const normalizedId = typeof videoId === "string" ? videoId.trim() : "";
    const requestId = ++requestNumber;
    lastEndedVideoId = null;

    if (!isValidYouTubeVideoId(normalizedId) || !container) {
      stop();
      onUnavailable({ reason: "missing-video-id" });
      return { ok: false, reason: "missing-video-id" };
    }

    currentVideoId = normalizedId;
    try {
      const api = await loadYouTubeIframeApi({ windowRef, documentRef, logger });
      if (requestId !== requestNumber) return { ok: false, reason: "stale-request" };

      if (!player) {
        watchPlayerIframe();
        player = new api.Player(container, {
          width: "100%",
          height: "100%",
          videoId: normalizedId,
          playerVars: buildPlayerVars(windowRef),
          events: {
            onReady: (event) => {
              playerReady = true;
              const pending = pendingLoad;
              pendingLoad = null;
              if (pending && pending.requestId === requestNumber && pending.videoId === currentVideoId) {
                if (pending.videoId !== normalizedId) player.loadVideoById(pending.videoId);
                onReady({ event, videoId: pending.videoId });
                if (pending.autoplay) safelyPlay();
                return;
              }
              if (requestId !== requestNumber || currentVideoId !== normalizedId) return;
              onReady({ event, videoId: currentVideoId });
              if (autoplay) safelyPlay();
            },
            onStateChange: (event) => handleStateChange(event),
            onError: (event) => {
              if (currentVideoId) onError({ code: event?.data, videoId: currentVideoId });
            }
          }
        });
        applyPlayerIframePolicy();
      } else if (!playerReady) {
        pendingLoad = { requestId, videoId: normalizedId, autoplay };
      } else {
        player.loadVideoById(normalizedId);
        onReady({ event: null, videoId: normalizedId });
        if (autoplay) safelyPlay();
      }
      return { ok: true };
    } catch (error) {
      logger.warn?.("[KantaCue YouTube] Player initialization failed.", error);
      onError({ code: "initialization-failed", videoId: normalizedId, error });
      return { ok: false, reason: "initialization-failed" };
    }
  }

  function handleStateChange(event) {
    const state = event?.data;
    const videoId = currentVideoId;
    onStateChange({ state, videoId });
    if (state === YOUTUBE_PLAYER_STATE.ENDED) {
      if (lastEndedVideoId === videoId) return;
      lastEndedVideoId = videoId;
      onStateChange({ state: "ended", videoId, ended: true });
    }
  }

  function safelyPlay() {
    try {
      player?.playVideo?.();
    } catch (error) {
      logger.info?.("[KantaCue YouTube] Browser blocked playback start.", error);
    }
  }

  function stop() {
    requestNumber += 1;
    currentVideoId = null;
    lastEndedVideoId = null;
    pendingLoad = null;
    try { player?.stopVideo?.(); } catch (error) { logger.info?.("[KantaCue YouTube] Player stop was unavailable.", error); }
  }

  function destroy() {
    requestNumber += 1;
    currentVideoId = null;
    lastEndedVideoId = null;
    pendingLoad = null;
    playerReady = false;
    iframeObserver?.disconnect?.();
    iframeObserver = null;
    try { player?.destroy?.(); } catch (error) { logger.info?.("[KantaCue YouTube] Player destroy was unavailable.", error); }
    player = null;
  }

  return {
    load,
    stop,
    destroy,
    isReady: () => playerReady,
    getCurrentVideoId: () => currentVideoId
  };

  function applyPlayerIframePolicy() {
    const iframe = container?.querySelector?.("iframe");
    if (!iframe) return false;
    iframe.setAttribute?.("referrerpolicy", YOUTUBE_REFERRER_POLICY);
    try { iframe.referrerPolicy = YOUTUBE_REFERRER_POLICY; } catch {}
    return true;
  }

  function watchPlayerIframe() {
    if (applyPlayerIframePolicy() || iframeObserver || !container) return;
    const Observer = windowRef?.MutationObserver;
    if (!Observer) return;
    iframeObserver = new Observer(() => {
      if (applyPlayerIframePolicy()) {
        iframeObserver?.disconnect?.();
        iframeObserver = null;
      }
    });
    iframeObserver.observe?.(container, { childList: true, subtree: true });
  }
}

export function buildPlayerVars(windowRef = globalThis.window) {
  const origin = windowRef?.location?.origin;
  const protocol = windowRef?.location?.protocol;
  const playerVars = { controls: 1, enablejsapi: 1, playsinline: 1, rel: 0 };
  if (typeof origin === "string" && origin !== "null" && (protocol === "http:" || protocol === "https:") && isHttpOrigin(origin)) playerVars.origin = origin;
  return playerVars;
}

function isHttpOrigin(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value;
  } catch {
    return false;
  }
}
