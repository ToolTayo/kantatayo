import { createYouTubePlayerController, isValidYouTubeVideoId, YOUTUBE_PLAYER_STATE } from "./youtube.js";

const REPORT_URL = "tools/sing-king-top-50-candidates.json";
const STORAGE_KEY = "kantatayo:sing-king-embed-tester:v1";
const SUSTAINED_PLAY_MS = 15_000;
const TECHNICAL_ERRORS = Object.freeze([100, 101, 150, 153]);
const RESULT_STATUSES = Object.freeze(["UNTESTED", "LOADING", "READY", "PLAYING", "PASS", "ERROR 100", "ERROR 101", "ERROR 150", "ERROR 153", "INCONCLUSIVE"]);
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const state = { candidates: [], results: {}, currentIndex: -1, activeVideoId: "", player: null, timer: null, run: 0 };

if (isAllowedContext()) start();
else document.querySelector("[data-blocked-state]").hidden = false;

function isAllowedContext() {
  return ALLOWED_HOSTS.has(window.location.hostname) || new URLSearchParams(window.location.search).get("dev") === "1";
}

async function start() {
  document.querySelector("[data-tester-app]").hidden = false;
  loadResults();
  bindEvents();
  try {
    const response = await fetch(REPORT_URL);
    if (!response.ok) throw new Error("Candidate report unavailable");
    const report = await response.json();
    state.candidates = Array.isArray(report.entries)
      ? report.entries.filter((entry) => entry?.classification === "NEW CANDIDATE" && isValidYouTubeVideoId(entry.videoId)).sort((a, b) => a.playlistPosition - b.playlistPosition)
      : [];
    if (state.candidates.length !== 35) throw new Error(`Expected 35 candidates, found ${state.candidates.length}`);
    reconcileResults();
    state.player = createYouTubePlayerController({
      container: document.querySelector("[data-youtube-mount]"),
      onReady: ({ videoId }) => handleReady(videoId),
      onStateChange: ({ state: playerState, videoId }) => handleState(playerState, videoId),
      onError: ({ code, videoId }) => handleError(code, videoId),
      onUnavailable: () => finishInconclusive("Player reported the candidate as unavailable.")
    });
    render();
  } catch (error) {
    console.warn("[KantaCue candidate tester] unavailable", error);
    showToast("Could not load the persisted candidate report.");
  }
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    if (target.dataset.action === "test") testCandidate(Number(target.dataset.index));
    if (target.dataset.action === "next") nextCandidate();
    if (target.dataset.action === "quality") setQuality(target.dataset.qualityValue);
  });
}

function testCandidate(index) {
  const candidate = state.candidates[index];
  if (!candidate || !state.player) return;
  clearSustainTimer();
  state.run += 1;
  state.currentIndex = index;
  state.activeVideoId = candidate.videoId;
  updateResult(candidate.videoId, { status: "LOADING", detail: "Loading through the official YouTube player." });
  render();
  state.player.load(candidate.videoId, { autoplay: true }).then((result) => {
    if (!result?.ok && result.reason !== "stale-request") finishInconclusive("The player could not initialize this test.");
  });
}

function nextCandidate() {
  if (!state.candidates.length) return;
  const start = state.currentIndex < 0 ? -1 : state.currentIndex;
  const untested = state.candidates.findIndex((candidate, index) => index > start && !state.results[candidate.videoId]?.status);
  const wrapped = state.candidates.findIndex((candidate) => !state.results[candidate.videoId]?.status);
  testCandidate(untested >= 0 ? untested : wrapped >= 0 ? wrapped : (start + 1) % state.candidates.length);
}

function handleReady(videoId) {
  if (videoId !== state.activeVideoId) return;
  updateResult(videoId, { status: "READY", detail: "onReady received; waiting for sustained PLAYING." });
  render();
}

function handleState(playerState, videoId) {
  if (videoId !== state.activeVideoId) return;
  if (playerState === YOUTUBE_PLAYER_STATE.PLAYING) {
    updateResult(videoId, { status: "PLAYING", detail: "PLAYING received; 15-second window started." });
    clearSustainTimer();
    const run = state.run;
    state.timer = window.setTimeout(() => {
      if (run !== state.run || state.activeVideoId !== videoId) return;
      updateResult(videoId, { status: "PASS", detail: "onReady + PLAYING sustained for 15 seconds with no error." });
      render();
      showToast("Technical PASS recorded. Add a manual quality label before considering promotion.");
    }, SUSTAINED_PLAY_MS);
  } else if ([YOUTUBE_PLAYER_STATE.PAUSED, YOUTUBE_PLAYER_STATE.BUFFERING, YOUTUBE_PLAYER_STATE.ENDED].includes(playerState) && state.results[videoId]?.status === "PLAYING") {
    finishInconclusive("Playback did not remain sustained for 15 seconds.");
  }
  render();
}

function handleError(code, videoId) {
  if (videoId !== state.activeVideoId) return;
  clearSustainTimer();
  const known = TECHNICAL_ERRORS.includes(Number(code));
  updateResult(videoId, { status: known ? `ERROR ${Number(code)}` : "INCONCLUSIVE", detail: known ? `YouTube error ${Number(code)} received from the official player.` : "An unclassified player error was received." });
  render();
}

function finishInconclusive(detail) {
  const result = state.results[state.activeVideoId];
  if (!result || ["PASS", ...TECHNICAL_ERRORS.map((code) => `ERROR ${code}`)].includes(result.status)) return;
  clearSustainTimer();
  updateResult(state.activeVideoId, { status: "INCONCLUSIVE", detail });
  render();
}

function setQuality(value) {
  const candidate = state.candidates[state.currentIndex];
  if (!candidate) return;
  updateResult(candidate.videoId, { quality: value });
  render();
  showToast(`Manual quality label saved: ${formatQuality(value)}.`);
}

function updateResult(videoId, patch) {
  state.results[videoId] = { ...(state.results[videoId] || { status: "UNTESTED", quality: "" }), ...patch, updatedAt: new Date().toISOString() };
  saveResults();
}

function loadResults() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    state.results = stored && typeof stored.results === "object" ? stored.results : {};
  } catch { state.results = {}; }
}

function saveResults() {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, results: state.results })); } catch { /* local-only convenience; testing can continue */ }
}

function reconcileResults() {
  const valid = new Set(state.candidates.map((candidate) => candidate.videoId));
  for (const id of Object.keys(state.results)) if (!valid.has(id)) delete state.results[id];
  saveResults();
}

function render() {
  const current = state.candidates[state.currentIndex];
  const result = current ? state.results[current.videoId] || { status: "UNTESTED", quality: "" } : null;
  document.querySelector("[data-current-title]").textContent = current ? `${current.title} — ${current.artist}` : "Choose a candidate";
  document.querySelector("[data-current-meta]").textContent = current ? `Position ${current.playlistPosition} · ${current.videoId} · ${current.publicViewCount || "Views unavailable"}` : "";
  document.querySelector("[data-status]").textContent = result?.detail || "Select Test in player to begin.";
  document.querySelector("[data-quality]").textContent = `Manual quality: ${result?.quality ? formatQuality(result.quality) : "not reviewed"}`;
  const tested = state.candidates.filter((candidate) => state.results[candidate.videoId]?.status && state.results[candidate.videoId]?.status !== "UNTESTED").length;
  document.querySelector("[data-progress]").textContent = `${tested} tested · ${state.candidates.length} total`;
  document.querySelector("[data-candidate-rows]").innerHTML = state.candidates.map((candidate, index) => renderRow(candidate, index)).join("");
}

function renderRow(candidate, index) {
  const result = state.results[candidate.videoId] || { status: "UNTESTED", quality: "" };
  const quality = result.quality ? `<div class="candidate-artist">${escapeHtml(formatQuality(result.quality))}</div>` : "";
  return `<tr><td>${candidate.playlistPosition}</td><td><div class="candidate-title">${escapeHtml(candidate.title)}</div>${quality}</td><td><div class="candidate-artist">${escapeHtml(candidate.artist)}</div></td><td><code>${escapeHtml(candidate.videoId)}</code></td><td>${escapeHtml(candidate.publicViewCount || "—")}</td><td><span class="result" data-result="${escapeHtml(result.status)}">${escapeHtml(result.status)}</span></td><td><button type="button" data-action="test" data-index="${index}">Test in player</button></td></tr>`;
}

function clearSustainTimer() { if (state.timer) window.clearTimeout(state.timer); state.timer = null; }
function formatQuality(value) { return ({ good: "good", poor: "poor quality", "guide-vocals": "guide vocals", "wrong-version": "wrong version", "other-problem": "other problem" })[value] || value; }
function showToast(message) { const toast = document.querySelector("[data-toast]"); toast.textContent = message; toast.classList.add("is-visible"); window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
