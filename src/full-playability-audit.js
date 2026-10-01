import { createYouTubePlayerController, isValidYouTubeVideoId, YOUTUBE_PLAYER_STATE } from "./youtube.js";
import { isAllowedAuditContext, isTerminalStatus, mergeAuditResult, PLAYABILITY_STATUSES, resultStatusForError, summarizeAuditEntries } from "./playability-audit.js";

const DEFAULT_REPORT_URL = "tools/youtube-full-playability-audit.json";
const STORAGE_KEY_BASE = "kantacue:youtube-full-playability-audit:v1";
const STORAGE_KEY = getStorageKey();
const SUSTAINED_PLAY_MS = 15_000;
const READY_TIMEOUT_MS = 20_000;
const PLAYBACK_GRACE_MS = 12_000;
const state = {
  report: null,
  entries: [],
  results: {},
  currentIndex: -1,
  activeVideoId: "",
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
  loadLocalResults();
  try {
    const response = await fetch(getReportUrl(), { cache: "no-store" });
    if (!response.ok) throw new Error("The audit manifest is unavailable.");
    state.report = await response.json();
    state.entries = Array.isArray(state.report.entries) ? state.report.entries.filter((entry) => isValidYouTubeVideoId(entry.videoId) || entry.iframeStatus === "UNAVAILABLE") : [];
    reconcileResults();
    state.player = createYouTubePlayerController({
      container: document.querySelector("[data-youtube-mount]"),
      onReady: ({ videoId }) => handleReady(videoId),
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
  state.playback = null;
  saveResult(entry.videoId, { iframeStatus: "LOADING", errorCode: null, failureClassification: null, note: "" });
  render();
  state.player.load(entry.videoId, { autoplay: true }).then((result) => {
    if (!result?.ok && result.reason !== "stale-request") finishInconclusive("The official player could not initialize this test.");
  });
  state.timers.push(window.setTimeout(() => {
    if (state.activeVideoId === entry.videoId && currentStatus() === "LOADING") {
      saveResult(entry.videoId, { iframeStatus: "TIMEOUT", failureClassification: "PLAYER_INITIALIZATION_TIMEOUT" });
      render();
    }
  }, READY_TIMEOUT_MS));
}

function handleReady(videoId) {
  if (videoId !== state.activeVideoId) return;
  saveResult(videoId, { iframeStatus: "READY", failureClassification: null });
  render();
  const run = state.run;
  state.timers.push(window.setTimeout(() => {
    if (run === state.run && state.activeVideoId === videoId && currentStatus() === "READY") {
      saveResult(videoId, { iframeStatus: "AUTOPLAY POLICY ONLY", failureClassification: "BROWSER_AUTOPLAY_POLICY" });
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
  if (playerState === YOUTUBE_PLAYER_STATE.PLAYING) {
    saveResult(videoId, { iframeStatus: "PLAYING", failureClassification: null });
    const run = state.run;
    const startedAt = Date.now();
    const initialTime = state.player?.getCurrentTime?.();
    state.playback = { run, startedAt, initialTime, maxAdvance: 0 };
    state.timers.push(window.setInterval(() => {
      if (run !== state.run || state.activeVideoId !== videoId || currentStatus() !== "PLAYING") return;
      const currentTime = state.player?.getCurrentTime?.();
      if (!Number.isFinite(currentTime) || !Number.isFinite(state.playback?.initialTime)) return;
      state.playback.maxAdvance = Math.max(state.playback.maxAdvance, currentTime - state.playback.initialTime);
    }, 1000));
    state.timers.push(window.setTimeout(() => {
      if (run !== state.run || state.activeVideoId !== videoId || currentStatus() !== "PLAYING") return;
      const elapsed = Date.now() - startedAt;
      const advanced = Number.isFinite(state.playback?.maxAdvance) && state.playback.maxAdvance >= 3;
      if (!advanced) {
        finishInconclusive(`Playback did not provide enough currentTime advancement after ${Math.round(elapsed / 1000)} seconds.`);
        return;
      }
      saveResult(videoId, { iframeStatus: "PASS", failureClassification: null });
      render();
      showToast("PASS recorded: ready, playing, time advanced, and sustained for 15 seconds.");
    }, SUSTAINED_PLAY_MS));
  } else if ([YOUTUBE_PLAYER_STATE.PAUSED, YOUTUBE_PLAYER_STATE.BUFFERING, YOUTUBE_PLAYER_STATE.ENDED].includes(playerState) && currentStatus() === "PLAYING") {
    finishInconclusive("Playback did not remain sustained for 15 seconds.");
  }
  render();
}

function handleError(code, videoId) {
  if (videoId !== state.activeVideoId) return;
  clearTimers();
  const status = resultStatusForError(code);
  saveResult(videoId, { iframeStatus: status, errorCode: Number(code) || String(code), failureClassification: classifyFailure(code) });
  render();
}

function finishInconclusive(detail) {
  const videoId = state.activeVideoId;
  if (!videoId || ["PASS", "TIMEOUT", "AUTOPLAY POLICY ONLY"].includes(currentStatus()) || /^ERROR /.test(currentStatus() || "")) return;
  clearTimers();
  saveResult(videoId, { iframeStatus: "INCONCLUSIVE", failureClassification: "BROWSER_OR_PLAYER_UNCERTAIN", note: detail });
  render();
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
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, catalogHash: state.report?.catalogHash || null, results: state.results })); } catch { /* optional local convenience */ }
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
