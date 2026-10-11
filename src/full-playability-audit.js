import { createYouTubePlayerController, isValidYouTubeVideoId, YOUTUBE_PLAYER_STATE } from "./youtube.js";
import { classifyPlaybackStartFailure, classifyPlayerErrorIdentity, evaluateSustainedPlayback, isAllowedAuditContext, isTerminalStatus, mergeAuditResult, summarizeAuditEntries, SUSTAINED_PLAYBACK_MS } from "./playability-audit.js";

const DEFAULT_REPORT_URL = "tools/youtube-full-playability-audit.json";
const STORAGE_KEY_BASE = "kantacue:youtube-full-playability-audit:v2";
const STORAGE_KEY = getStorageKey();
const READY_TIMEOUT_MS = 20_000;
const PLAYBACK_GRACE_MS = 20_000;
const YOUTUBE_IFRAME_HOSTS = new Set(["youtube.com", "www.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const state = {
  report: null,
  entries: [],
  results: {},
  currentIndex: -1,
  activeVideoId: "",
  runStartedAt: 0,
  trace: [],
  mount: null,
  player: null,
  run: 0,
  playback: null,
  timers: []
};

function getStorageKey() {
  const worker = globalThis.location?.search ? new URLSearchParams(globalThis.location.search).get("worker") : "";
  return worker && /^[A-Za-z0-9_-]+$/.test(worker) ? `${STORAGE_KEY_BASE}:${worker}` : STORAGE_KEY_BASE;
}

function getReportUrl() {
  const requested = globalThis.location?.search
    ? new URLSearchParams(globalThis.location.search).get("manifest")
    : "";
  // The manifest override is development-only and deliberately limited to a
  // same-origin tools JSON file. Production app pages never load this module.
  return requested && /^tools\/[A-Za-z0-9._/-]+\.json$/.test(requested)
    ? requested
    : DEFAULT_REPORT_URL;
}

if (globalThis.window) globalThis.window.__KANTACUE_PLAYABILITY_STORAGE_KEY__ = STORAGE_KEY;

if (isAllowedAuditContext()) start();
else document.querySelector("[data-blocked-state]").hidden = false;

async function start() {
  document.querySelector("[data-audit-app]").hidden = false;
  bindEvents();
  state.mount = document.querySelector("[data-youtube-mount]");
  document.addEventListener("visibilitychange", () => {
    if (state.activeVideoId && !isTerminalStatus(currentStatus())) recordTrace("visibilitychange");
  });
  loadLocalResults();
  try {
    const response = await fetch(getReportUrl(), { cache: "no-store" });
    if (!response.ok) throw new Error("The audit manifest is unavailable.");
    state.report = await response.json();
    state.entries = Array.isArray(state.report.entries) ? state.report.entries.filter((entry) => isValidYouTubeVideoId(entry.videoId) || entry.iframeStatus === "UNAVAILABLE") : [];
    reconcileResults();
    state.player = createYouTubePlayerController({
      container: state.mount,
      onReady: ({ event, videoId }) => handleReady(videoId, event),
      onStateChange: ({ state: playerState, videoId }) => handleState(playerState, videoId),
      onError: ({ code, videoId }) => handleError(code, videoId),
      onUnavailable: () => finishInconclusive("The official controller reported this video as unavailable.")
    });
    render();
  } catch (error) {
    console.warn("[KantaCue playability audit] unavailable", error);
    showToast(error.message || "Could not load the audit manifest.");
  }
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    if (target.dataset.action === "test") testEntry(Number(target.dataset.index));
    if (target.dataset.action === "next") testNextUntested();
    if (target.dataset.action === "export") exportReport();
    if (target.dataset.action === "mark-inconclusive") finishInconclusive("Marked inconclusive by the tester operator.");
    if (target.dataset.action === "save-note") saveNote();
  });
}

function testNextUntested() {
  if (!state.entries.length) return;
  const start = state.currentIndex + 1;
  const next = state.entries.findIndex((entry, index) => index >= start && !isRecorded(entry.videoId));
  const wrapped = state.entries.findIndex((entry) => !isRecorded(entry.videoId));
  testEntry(next >= 0 ? next : wrapped >= 0 ? wrapped : start % state.entries.length);
}

function testEntry(index) {
  const entry = state.entries[index];
  if (!entry || !isValidYouTubeVideoId(entry.videoId) || !state.player) return;
  clearTimers();
  state.run += 1;
  state.currentIndex = index;
  state.activeVideoId = entry.videoId;
  state.runStartedAt = performance.now();
  state.trace = [];
  state.playback = { run: state.run, startedAt: null, samples: [] };
  recordTrace("load-request");
  saveResult(entry.videoId, { iframeStatus: "LOADING", errorCode: null, failureClassification: null, note: "", trace: [...state.trace] });
  render();
  state.player.load(entry.videoId, { autoplay: true }).then((result) => {
    if (!result?.ok && result.reason !== "stale-request") finishInconclusive("The official player could not initialize this test.");
  });
  state.timers.push(window.setTimeout(() => {
    if (state.activeVideoId === entry.videoId && currentStatus() === "LOADING") {
      recordTrace("timeout", "Player initialization did not reach onReady.");
      saveResult(entry.videoId, { iframeStatus: "TIMEOUT", failureClassification: "PLAYER_INITIALIZATION_TIMEOUT", note: "Player initialization did not reach onReady before the timeout.", trace: [...state.trace] });
      render();
    }
  }, READY_TIMEOUT_MS));
}

function handleReady(videoId, event) {
  if (videoId !== state.activeVideoId) return;
  // The controller reports the actual API event for initial readiness and an
  // event:null notification after later loadVideoById requests. Keep them distinct.
  recordTrace(event ? "onReady" : "load-accepted");
  saveResult(videoId, { iframeStatus: "READY", failureClassification: null, trace: [...state.trace] });
  render();
  const run = state.run;
  state.timers.push(window.setTimeout(() => {
    if (run === state.run && state.activeVideoId === videoId && currentStatus() === "READY") {
      const lastPlayerState = state.trace.filter((item) => item.kind === "state-change").at(-1)?.detail;
      const startupFailure = classifyPlaybackStartFailure(lastPlayerState);
      recordTrace("autoplay-grace-expired");
      recordTrace("ready-only");
      saveResult(videoId, { iframeStatus: "READY-ONLY", failureClassification: startupFailure.failureClassification, note: `${startupFailure.note} No playback PASS is inferred.`, trace: [...state.trace] });
      render();
    }
  }, PLAYBACK_GRACE_MS));
}

function handleState(playerState, videoId) {
  if (videoId !== state.activeVideoId) return;
  // YouTube can emit a late PLAYING callback after the sustained-playback
  // timer has already recorded PASS (or after a terminal failure). Never
  // downgrade a terminal audit result back to an in-progress state.
  if (isTerminalStatus(currentStatus())) return;
  recordTrace("state-change", playerState);
  const latestTrace = state.trace.at(-1);
  if (latestTrace?.loadedVideoId !== videoId) {
    recordTrace("stale-player-state-ignored", `Expected ${videoId}; official player reports ${latestTrace?.loadedVideoId || "no loaded ID"}.`);
    return;
  }
  if (playerState === YOUTUBE_PLAYER_STATE.PLAYING) {
    saveResult(videoId, { iframeStatus: "PLAYING", failureClassification: null, trace: [...state.trace] });
    const run = state.run;
    if (state.playback?.run !== run || state.playback.startedAt == null) {
      state.playback = { run, startedAt: performance.now(), samples: [] };
      state.timers.push(window.setInterval(() => recordPlaybackSample(videoId, run), 1000));
      recordPlaybackSample(videoId, run);
    }
    state.timers.push(window.setTimeout(() => {
      if (run !== state.run || state.activeVideoId !== videoId || currentStatus() !== "PLAYING") return;
      recordPlaybackSample(videoId, run);
      const elapsed = performance.now() - (state.playback?.startedAt ?? performance.now());
      const evidence = evaluateSustainedPlayback({
        elapsedMs: elapsed,
        samples: state.playback?.samples || [],
        visibilityTrace: state.trace.map((item) => item.visibilityState),
        expectedVideoId: videoId
      });
      if (evidence.status !== "PASS") {
        finishAuditResult(evidence.status, evidence.reason, evidence.status === "PLAYING WITHOUT PROGRESSION" ? "PLAYBACK_TIME_DID_NOT_ADVANCE" : "PLAYBACK_EVIDENCE_INSUFFICIENT");
        return;
      }
      finishAuditResult("PASS", evidence.reason, null);
      render();
      showToast("PASS recorded: ready, sustained PLAYING, and verified playback-time progression for 15 seconds.");
    }, SUSTAINED_PLAYBACK_MS));
  } else if ([YOUTUBE_PLAYER_STATE.PAUSED, YOUTUBE_PLAYER_STATE.BUFFERING, YOUTUBE_PLAYER_STATE.ENDED].includes(playerState) && currentStatus() === "PLAYING") {
    const label = playerState === YOUTUBE_PLAYER_STATE.PAUSED ? "paused" : playerState === YOUTUBE_PLAYER_STATE.BUFFERING ? "buffered" : "ended";
    finishInconclusive(`The official player entered ${label} before the 15-second sustained-playback window completed.`);
  }
  render();
}

function handleError(code, videoId) {
  if (videoId !== state.activeVideoId) return;
  recordTrace("error", Number(code) || String(code));
  const loadedVideoId = state.trace.at(-1)?.loadedVideoId;
  clearTimers();
  const classification = classifyPlayerErrorIdentity(code, videoId, loadedVideoId);
  if (classification.failureClassification !== "PLAYER_VIDEO_ID_MISMATCH") {
    classification.failureClassification = classifyFailure(code);
  }
  saveResult(videoId, { iframeStatus: classification.status, errorCode: classification.errorCode, failureClassification: classification.failureClassification, note: classification.note, trace: [...state.trace] });
  render();
}

function finishInconclusive(detail) {
  const videoId = state.activeVideoId;
  if (!videoId || isTerminalStatus(currentStatus())) return;
  clearTimers();
  recordTrace("inconclusive", detail);
  saveResult(videoId, { iframeStatus: "INCONCLUSIVE", failureClassification: "BROWSER_OR_PLAYER_UNCERTAIN", note: detail, trace: [...state.trace] });
  render();
}

function finishAuditResult(status, detail, failureClassification) {
  const videoId = state.activeVideoId;
  if (!videoId || isTerminalStatus(currentStatus())) return;
  clearTimers();
  recordTrace("result", status);
  saveResult(videoId, { iframeStatus: status, failureClassification, note: detail, trace: [...state.trace] });
}

function recordPlaybackSample(videoId, run) {
  if (run !== state.run || state.activeVideoId !== videoId || currentStatus() !== "PLAYING") return;
  const traceEntry = recordTrace("playback-sample");
  const playback = state.playback;
  if (!playback || playback.run !== run || playback.startedAt == null) return;
  traceEntry.playbackElapsedMs = Math.round(performance.now() - playback.startedAt);
  playback.samples.push({ elapsedMs: traceEntry.playbackElapsedMs, currentTime: traceEntry.currentTime, visibilityState: traceEntry.visibilityState, playerVideoId: traceEntry.playerVideoId, loadedVideoId: traceEntry.loadedVideoId, playerReady: traceEntry.playerReady, iframeConnected: traceEntry.iframeConnected });
  if (playback.samples.length > 32) playback.samples.shift();
  saveResult(videoId, { trace: [...state.trace] });
}

function recordTrace(kind, detail = null) {
  // YT.Player replaces the original mount element with its iframe. Querying
  // only under the old mount reference therefore misses the real player.
  const youtubeFrames = [...document.querySelectorAll("iframe")].filter((candidate) => getYouTubeIframeVideoId(candidate));
  const iframe = youtubeFrames[0] || null;
  const currentTime = state.player?.getCurrentTime?.();
  const iframeVideoId = iframe ? getYouTubeIframeVideoId(iframe) : null;
  const entry = {
    run: state.run,
    elapsedMs: Math.max(0, Math.round(performance.now() - state.runStartedAt)),
    kind,
    detail: typeof detail === "number" || typeof detail === "string" ? detail : null,
    playerVideoId: state.player?.getCurrentVideoId?.() || null,
    loadedVideoId: state.player?.getLoadedVideoId?.() || null,
    playerReady: state.player?.isReady?.() === true,
    iframeVideoId,
    currentTime: Number.isFinite(currentTime) ? Number(currentTime.toFixed(3)) : null,
    duration: state.player?.getDuration?.() ?? null,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus?.() ?? null,
    iframeCount: youtubeFrames.length,
    iframeConnected: iframe?.isConnected ?? false
  };
  state.trace.push(entry);
  if (state.trace.length > 40) state.trace.shift();
  return entry;
}

function getYouTubeIframeVideoId(iframe) {
  try {
    const url = new URL(iframe?.src || "");
    const host = url.hostname.toLowerCase();
    if (!YOUTUBE_IFRAME_HOSTS.has(host)) return null;
    return url.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] || null;
  } catch {
    return null;
  }
}

function saveNote() {
  const entry = state.entries[state.currentIndex];
  const input = document.querySelector("[data-audit-note]");
  if (!entry || !input) return;
  saveResult(entry.videoId, { note: input.value.trim() });
  render();
  showToast("Audit note saved locally.");
}

function saveResult(videoId, patch) {
  const entry = state.entries.find((item) => item.videoId === videoId);
  if (!entry) return;
  state.results[videoId] = mergeAuditResult(state.results[videoId] || entry, { ...patch, testedAt: new Date().toISOString() });
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, evidenceVersion: 2, catalogHash: state.report?.catalogHash || null, results: state.results })); } catch { /* optional local convenience */ }
}

function loadLocalResults() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    state.results = stored && typeof stored.results === "object" ? stored.results : {};
  } catch { state.results = {}; }
}

function reconcileResults() {
  const valid = new Set(state.entries.map((entry) => entry.videoId));
  for (const videoId of Object.keys(state.results)) if (!valid.has(videoId)) delete state.results[videoId];
}

function exportReport() {
  const entries = state.entries.map((entry) => state.results[entry.videoId] || entry);
  const report = {
    ...state.report,
    generatedAt: new Date().toISOString(),
    auditStatus: entries.every((entry) => entry.iframeStatus === "PASS") ? "COMPLETE" : "PARTIAL_OR_PENDING",
    counts: summarizeAuditEntries(entries),
    entries
  };
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "youtube-full-playability-audit.json";
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Report exported. It remains separate from the production catalog.");
}

function render() {
  const entry = state.entries[state.currentIndex];
  const result = entry ? state.results[entry.videoId] || entry : null;
  const counts = summarizeAuditEntries(state.entries.map((item) => state.results[item.videoId] || item));
  document.querySelector("[data-current-title]").textContent = entry ? `${entry.title} — ${entry.artist}` : "Choose a song to test";
  document.querySelector("[data-current-meta]").textContent = entry ? `${entry.songId} · ${entry.provider || "Other"} · ${entry.videoId} · ${entry.publicViews || "Views unavailable"}` : "";
  document.querySelector("[data-status]").textContent = result?.note || result?.iframeStatus || "Select Test in player to begin.";
  document.querySelector("[data-progress]").textContent = `${state.entries.filter((item) => isRecorded(item.videoId)).length} tested · ${state.entries.length} total`;
  document.querySelector("[data-counts]").textContent = `PASS ${counts.confirmedPlayable} · embed failures ${counts.confirmedEmbeddingFailures} · unavailable ${counts.unavailable} · pending ${counts.ambiguous + counts.autoplayPolicyOnly + counts.timeouts}`;
  const note = document.querySelector("[data-audit-note]");
  if (note && document.activeElement !== note) note.value = result?.note || "";
  document.querySelector("[data-candidate-rows]").innerHTML = state.entries.map((item, index) => renderRow(item, index)).join("");
}

function renderRow(entry, index) {
  const result = state.results[entry.videoId] || entry;
  const canTest = isValidYouTubeVideoId(entry.videoId) && result.iframeStatus !== "UNAVAILABLE";
  return `<tr><td>${escapeHtml(entry.songId)}</td><td><div class="candidate-title">${escapeHtml(entry.title)}</div><div class="candidate-artist">${escapeHtml(entry.artist)}</div></td><td>${escapeHtml(entry.provider || "Other")}</td><td><code>${escapeHtml(entry.videoId || "—")}</code></td><td>${escapeHtml(entry.publicViews || "—")}</td><td><span class="result" data-result="${escapeHtml(result.iframeStatus)}">${escapeHtml(result.iframeStatus)}</span></td><td><button type="button" data-action="test" data-index="${index}"${canTest ? "" : " disabled"}>${canTest ? "Test" : "Unavailable"}</button></td></tr>`;
}

function isRecorded(videoId) {
  const entry = state.entries.find((item) => item.videoId === videoId);
  const status = state.results[videoId]?.iframeStatus || entry?.iframeStatus;
  return Boolean(status && status !== "UNTESTED");
}

function currentStatus() { return state.results[state.activeVideoId]?.iframeStatus || "UNTESTED"; }
function classifyFailure(code) { return ({ 2: "INVALID_PARAMETER", 5: "HTML5_PLAYER_ERROR", 100: "VIDEO_UNAVAILABLE_OR_PRIVATE", 101: "EMBEDDING_DISABLED", 150: "EMBEDDING_DISABLED", 153: "CLIENT_OR_REFERRER_IDENTIFICATION" })[Number(code)] || "UNCLASSIFIED_PLAYER_ERROR"; }
function clearTimers() { for (const timer of state.timers) window.clearTimeout(timer); state.timers = []; state.playback = null; }
function showToast(message) { const toast = document.querySelector("[data-toast]"); toast.textContent = message; toast.classList.add("is-visible"); window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3000); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

window.addEventListener("beforeunload", () => { clearTimers(); state.player?.destroy?.(); });
