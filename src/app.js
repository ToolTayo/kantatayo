import { focusSongAction, hidePlayer, renderPartyPanel, renderPreferences, renderQueue, renderSongRequests, renderSongSections, setPlayerExpanded, setPlayerFeedbackStatus, showPlayer, showPlayerError, showPlayerFinished, showPlayerLoading, showPlayerOffline, showPlayerPlaybackState, showPlayerReady, showPlayerSangIt, showPlayerUnavailable, showQueueFinished, showToast, togglePlayerFeedbackReasons, updatePlayerActions } from "./ui.js?v=21";
import { loadCatalog } from "./catalog.js?v=1";
import { createDefaultDiscoveryFilters, createQuickFilterState, createSearchIndex } from "./discovery.js?v=4";
import { addSongRequest, addSongToQueue, advanceQueue, clearPreferences, clearQueue, completeDailyChallenge, createAppState, getQueueSnapshot, markSung, moveQueueItem, moveQueueItemToTop, persistAppState, recordPlaybackFeedback, recordSongPlayed, removeSongFromQueue, selectPreviousQueueSong, setCatalog, setCurrentSong, setPreferenceValues, setRecentRecommendations, toggleDislike, toggleFavorite, toggleLike } from "./state.js?v=5";
import { getRecommendations } from "./recommendations.js";
import { createYouTubePlayerController, isValidYouTubeVideoId, YOUTUBE_PLAYER_STATE } from "./youtube.js";
import { addPartySinger, assignPartySong, clearPartyAssignments, clearPartySession, getAssignedSinger, getNextPartySinger, recordPartyTurn, reconcilePartyQueue, relaxRouletteConstraints, removePartySinger, renamePartySinger, selectRouletteSong, unassignPartySong } from "./party.js?v=1";
import { normalizeView, viewFromHash, viewHash } from "./view.js";
import { containFocus } from "./focus.js";
import { getDailyChallenge } from "./engagement.js?v=3";
import { getFeaturedCollectionId } from "./collections.js?v=1";

const state = createAppState();
let youtubeController = null;
let recommendationSnapshot = [];
let queueReturnFocus = null;
let playerReturnFocus = null;
let rouletteResult = null;
let rouletteConstraints = { language: "any", genre: "any", mood: "any", difficulty: "any", era: "any" };
let rouletteHistory = [];
let rouletteRecovery = { available: false, message: "" };
let partyStatusMessage = "Party details stay on this device.";
let currentView = viewFromHash(window.location.hash);
let playerFinishedSongId = null;
let selectedCollectionId = getFeaturedCollectionId();

async function startApp() {
  try {
    const catalog = await loadCatalog();
    setCatalog(state, catalog.songs, createSearchIndex(catalog.songs));
    if (currentView === "party" && !state.user.partySession.enabled) state.user.partySession.enabled = true;
    refreshRecommendationsSnapshot();
    youtubeController = createYouTubePlayerController({
      container: document.querySelector("[data-youtube-mount]"),
      onReady: () => showPlayerReady(),
      onStateChange: handleYouTubeStateChange,
      onError: handleYouTubeError,
      onUnavailable: () => showPlayerUnavailable()
    });
    persistAppState(state);
    render();
    bindEvents();
    registerServiceWorker();
  } catch (error) {
    console.error(error);
    document.querySelector("[data-catalog-loading]")?.remove();
    const sections = document.querySelector("[data-song-sections]");
    if (sections) sections.innerHTML = `<div class="empty-state"><div><strong>We could not load the song catalog.</strong><p>Refresh the page to try again.</p></div></div>`;
  }
}

function render({ refreshRecommendations = false } = {}) {
  if (refreshRecommendations) refreshRecommendationsSnapshot();
  const loading = document.querySelector("[data-catalog-loading]");
  if (loading) loading.hidden = true;
  renderPreferences(state.songs, state.user.preferences);
  renderSongSections(state.searchIndex, state.query, state.filter, state.sortBy, state.user, recommendationSnapshot, currentView, state.discoveryFilters, state.discoveryPage, selectedCollectionId);
  renderSongRequests(state.user);
  const searchInput = document.querySelector("#song-search");
  if (searchInput && searchInput.value !== state.query) searchInput.value = state.query;
  const searchClear = document.querySelector('[data-action="clear-search"]');
  if (searchClear) searchClear.hidden = !state.query.trim();
  const queueSnapshot = getQueueSnapshot(state);
  renderQueue(queueSnapshot, state.user.partySession);
  renderPartyPanel(state.songs, state.user.partySession, queueSnapshot, rouletteResult, rouletteConstraints, partyStatusMessage, currentView, rouletteRecovery);
}

function refreshRecommendationsSnapshot() {
  recommendationSnapshot = getRecommendations(state.songs, state.user, { limit: 12 });
  if (recommendationSnapshot.length > 0) {
    const changed = setRecentRecommendations(state.user, recommendationSnapshot.map((item) => item.song.id));
    if (changed) persistAppState(state);
  }
}

function setViewHash(view) {
  const nextHash = viewHash(view);
  if (window.location.hash !== nextHash) window.history.replaceState(null, "", nextHash);
}

function navigateToView(view, { preserveQuery = false, discoveryFilter = "" } = {}) {
  closeMobileMore();
  currentView = normalizeView(view);
  if (!preserveQuery || currentView !== "discover") state.query = "";
  state.filter = "all";
  state.discoveryFilters = discoveryFilter && currentView === "discover"
    ? createQuickFilterState(discoveryFilter)
    : createDefaultDiscoveryFilters();
  state.discoveryPage = 1;
  if (currentView === "party" && !state.user.partySession.enabled) {
    state.user.partySession.enabled = true;
    persistAppState(state);
    partyStatusMessage = "Party Mode is on. Add singers to start a fair rotation.";
  }
  setViewHash(currentView);
  if (currentView === "home" && typeof window.scrollTo === "function") window.scrollTo({ top: 0, behavior: "auto" });
  render();
}

function bindEvents() {
  updateConnectionStatus();
  syncFullscreenButton();
  window.addEventListener("offline", updateConnectionStatus);
  window.addEventListener("online", updateConnectionStatus);
  document.addEventListener("fullscreenchange", syncFullscreenButton);
  window.addEventListener("hashchange", () => {
    currentView = viewFromHash(window.location.hash);
    render();
  });

  document.addEventListener("click", (event) => {
    const navTarget = event.target.closest(".primary-nav a, .mobile-nav a, .mobile-more-menu a, .brand, .sidebar-brand, a[data-view]");
    const navView = navTarget?.dataset.view || getLegacyNavView(navTarget);
    if (navView) {
      event.preventDefault();
      navigateToView(navView, { preserveQuery: navView === "discover", discoveryFilter: navTarget?.dataset.homeFilter || "" });
      return;
    }
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) return;
    const action = actionTarget.dataset.action;
    if (action === "toggle-mobile-more") { toggleMobileMore(); return; }
    if (action === "toggle-discover-filters") { toggleDiscoverFilters(); return; }
    if (action === "load-more-discover") { state.discoveryPage += 1; render(); return; }
    if (action === "reset-discovery-filters") { state.discoveryFilters = createDefaultDiscoveryFilters(); state.discoveryPage = 1; render(); return; }
    if (action === "reset-discovery") { state.query = ""; state.filter = "all"; state.discoveryFilters = createDefaultDiscoveryFilters(); state.discoveryPage = 1; render(); document.querySelector("#song-search")?.focus(); return; }
    if (action === "toggle-party-mode") { togglePartyMode(); return; }
    if (action === "remove-party-singer") { removePartySingerFromUi(actionTarget.dataset.singerId); return; }
    if (action === "clear-party-session") { clearPartySessionFromUi(); return; }
    if (action === "roll-roulette") { rollRoulette(); return; }
    if (action === "roulette-add") { addRouletteResultToQueue(); return; }
    if (action === "roulette-view") { viewRouletteSong(); return; }
    if (action === "relax-roulette") { relaxRoulette(); return; }
    if (action === "clear-roulette-filters") { clearRouletteFilters(); return; }
    if (action === "select-collection") { selectedCollectionId = actionTarget.dataset.collectionId || selectedCollectionId; render(); return; }
    if (action === "surprise-me") { surpriseMe(); return; }
    if (action === "feedback-problem") { togglePlayerFeedbackReasons(actionTarget.getAttribute("aria-expanded") !== "true"); return; }
    if (action === "feedback-good") { recordCurrentFeedback("good"); return; }
    if (action === "feedback-reason") { recordCurrentFeedback("problem", actionTarget.dataset.feedbackReason); return; }
    if (action === "clear-preferences") {
      clearPreferences(state.user);
      persistAppState(state);
      render({ refreshRecommendations: true });
      actionTarget.focus();
      showToast("Preferences cleared");
      return;
    }
    if (action === "clear-search") {
      state.query = "";
      render({ refreshRecommendations: false });
      document.querySelector("#song-search")?.focus();
      return;
    }
    if (action === "open-player") {
      const player = document.querySelector("[data-player-panel]");
      if (player && !player.hidden) {
        rememberPlayerLauncher(actionTarget);
        player.classList.add("is-expanded");
        setPlayerExpanded(player, true);
        player.querySelector('[data-action="close-player"]')?.focus();
      }
      return;
    }
    if (action === "expand-player") {
      const player = document.querySelector("[data-player-panel]");
      if (player && !player.hidden) {
        setPlayerExpanded(player, !player.classList.contains("is-expanded"));
        actionTarget.focus();
      }
      return;
    }
    if (action === "fullscreen-player") { void togglePlayerFullscreen(); return; }
    if (action === "sang-again") { replayCurrentSong(); return; }
    const song = state.songs.find((item) => item.id === actionTarget.dataset.songId);
    if (action === "add-queue" && song) addToQueue(song);
    if (action === "remove-queue") removeFromQueue(actionTarget.dataset.songId);
    if ((action === "play" || action === "select-queue" || action === "daily-challenge-play") && song) startSong(song, actionTarget);
    if (["move-up", "move-down", "move-top"].includes(action) && song) reorderQueue(action, song);
    if (song && ["toggle-favorite", "toggle-like", "toggle-dislike", "mark-sung"].includes(action)) handleSongAction(action, song, { fromPlayer: Boolean(actionTarget.closest("[data-player-panel]")) });
    if (action === "toggle-queue") toggleQueue();
    if (action === "close-queue") closeQueue();
    if (action === "clear-queue") clearQueueFromUi();
    if (action === "player-next") advanceToNext();
    if (action === "player-prev") selectPrevious();
    if (action === "close-player") closePlayer();
  });

  document.addEventListener("error", (event) => {
    const image = event.target;
    if (!image?.matches?.("[data-song-thumbnail]")) return;
    image.hidden = true;
    const fallback = image.closest(".song-thumbnail")?.querySelector("[data-thumbnail-fallback]");
    if (fallback) fallback.hidden = false;
  }, true);

  document.addEventListener("change", (event) => {
    const renameInput = event.target.closest("[data-party-rename]");
    if (renameInput) {
      renamePartySingerFromUi(renameInput.dataset.partyRename, renameInput.value);
      return;
    }
    const singerSelect = event.target.closest("[data-action=\"assign-singer\"]");
    if (singerSelect) {
      assignSingerFromUi(singerSelect.dataset.songId, singerSelect.value);
      return;
    }
    const rouletteFilter = event.target.closest("[data-roulette-filter]");
    if (rouletteFilter) {
      rouletteConstraints[rouletteFilter.dataset.rouletteFilter] = rouletteFilter.value;
      rouletteResult = null;
      rouletteRecovery = { available: false, message: "" };
      partyStatusMessage = "Roulette filters updated.";
      render();
      return;
    }
    const discoveryFilter = event.target.closest("[data-discovery-filter]");
    if (discoveryFilter) {
      currentView = "discover";
      setViewHash("discover");
      state.discoveryFilters[discoveryFilter.dataset.discoveryFilter] = discoveryFilter.value;
      state.discoveryPage = 1;
      render();
      discoveryFilter.focus();
      return;
    }
    const input = event.target.closest("[data-preference-key]");
    if (!input) return;
    const key = input.dataset.preferenceKey;
    const values = [...document.querySelectorAll(`[data-preference-key="${key}"]:checked`)].map((item) => item.value);
    setPreferenceValues(state.user, key, values);
    persistAppState(state);
    const focusId = input.id;
    render({ refreshRecommendations: true });
    document.getElementById(focusId)?.focus();
    showToast("Preferences saved");
  });

  document.addEventListener("keydown", (event) => {
    const player = document.querySelector("[data-player-panel]");
    const drawer = document.querySelector("[data-queue-drawer]");
    if (event.key === "Tab") {
      if (player && !player.hidden && player.classList.contains("is-expanded") && containFocus(player, event)) return;
      if (drawer?.classList.contains("is-open")) containFocus(drawer, event);
      return;
    }
    if (event.key !== "Escape") return;
    if (!document.querySelector("[data-mobile-more]")?.hidden) {
      closeMobileMore();
      return;
    }
    if (drawer?.classList.contains("is-open")) {
      closeQueue();
      return;
    }
    if (player && !player.hidden) {
      closePlayer();
    }
  });

  document.querySelector("[data-search-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.query.trim()) navigateToView("discover", { preserveQuery: true });
  });
  document.querySelectorAll('[data-action="toggle-party-mode"]').forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePartyMode();
  }));
  document.querySelector("[data-party-singer-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector("[name=singer]");
    const result = addPartySinger(state.user.partySession, input.value);
    if (!result.ok) {
      partyStatusMessage = result.reason === "duplicate-name" ? "That singer is already in the rotation." : result.reason === "singer-limit" ? "The party is full for now." : "Enter a singer name first.";
      render();
      input.focus();
      showToast(partyStatusMessage);
      return;
    }
    input.value = "";
    syncPartyQueueAssignments();
    partyStatusMessage = `${result.singer.name} joined the rotation.`;
    persistAppState(state);
    render();
    document.querySelector("[name=singer]")?.focus();
    showToast(`${result.singer.name} added to Party Mode`);
  });
  document.querySelector("[data-song-request-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const title = form.querySelector("[name=request-title]");
    const artist = form.querySelector("[name=request-artist]");
    const result = addSongRequest(state.user, title.value, artist.value);
    const status = document.querySelector("[data-song-request-status]");
    if (!result.added) {
      if (status) status.textContent = result.reason === "duplicate" ? "That request is already saved." : "Add both a title and artist.";
      title.focus();
      return;
    }
    title.value = "";
    artist.value = "";
    if (status) status.textContent = "Request saved on this device.";
    persistAppState(state);
    render();
    title.focus();
    showToast("Song request saved");
  });
  document.querySelector("#song-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    state.discoveryPage = 1;
    if (state.query.trim() && currentView !== "discover") {
      currentView = "discover";
      state.filter = "all";
      setViewHash("discover");
    }
    render();
  });
  document.querySelector("[data-sort]").addEventListener("change", (event) => { state.sortBy = event.target.value; state.discoveryPage = 1; render(); });
  document.querySelectorAll(".quick-filters [data-filter]").forEach((button) => button.addEventListener("click", () => {
    currentView = "discover";
    setViewHash("discover");
    const filter = button.dataset.filter;
    state.discoveryFilters = createQuickFilterState(filter);
    state.filter = "all";
    state.discoveryPage = 1;
    render();
    button.focus();
  }));
}

function surpriseMe() {
  const queued = new Set(state.user.queue.map((id) => id.toLowerCase()));
  const disliked = new Set(state.user.dislikedSongs.map((id) => id.toLowerCase()));
  const current = state.user.currentSongId?.toLowerCase();
  const candidates = recommendationSnapshot.map((item) => item.song).filter((song) => isValidYouTubeVideoId(song.youtubeVideoId) && !queued.has(song.id.toLowerCase()) && !disliked.has(song.id.toLowerCase()) && song.id.toLowerCase() !== current);
  const pool = candidates.slice(0, Math.min(5, candidates.length));
  const song = pool[Math.floor(Math.random() * pool.length)] || null;
  if (!song) {
    showToast("No fresh playable surprise is available yet");
    return;
  }
  addToQueue(song);
  showToast(`${song.title} is your surprise pick`);
}

function recordCurrentFeedback(rating, reason = null) {
  const currentSong = getQueueSnapshot(state).currentSong;
  if (!currentSong) return;
  const result = recordPlaybackFeedback(state.user, currentSong.id, rating, reason);
  if (!result.recorded) return;
  persistAppState(state);
  setPlayerFeedbackStatus(rating === "good" ? "Thanks — marked as a good karaoke pick on this device." : "Thanks — this issue was saved locally for future catalog review.");
  showToast(rating === "good" ? "Good karaoke saved" : "Video issue saved");
}

function toggleDiscoverFilters() {
  const panel = document.querySelector("[data-discover-filter-panel]");
  const button = document.querySelector('[data-action="toggle-discover-filters"]');
  if (!panel || !button) return;
  const isOpen = panel.hidden;
  panel.hidden = !isOpen;
  button.setAttribute("aria-expanded", String(isOpen));
  const label = isOpen ? "Close additional song filters" : "Open additional song filters";
  button.setAttribute("aria-label", label);
  button.title = label;
  if (isOpen) document.querySelector('[data-discovery-filter="language"]')?.focus();
}

function toggleMobileMore() {
  const menu = document.querySelector("[data-mobile-more]");
  if (!menu) return;
  setMobileMoreOpen(menu.hidden);
}

function closeMobileMore() {
  setMobileMoreOpen(false);
}

function setMobileMoreOpen(isOpen) {
  const menu = document.querySelector("[data-mobile-more]");
  const button = document.querySelector('[data-action="toggle-mobile-more"]');
  if (!menu || !button) return;
  menu.hidden = !isOpen;
  menu.classList.toggle("is-open", isOpen);
  button.setAttribute("aria-expanded", String(isOpen));
  const label = isOpen ? "Close more navigation" : "Open more navigation";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function getLegacyNavView(target) {
  if (!target || target.dataset.view) return "";
  const href = target.getAttribute("href") || "";
  if (href === "#top") return "home";
  if (href === "#discovery") return target.dataset.filter === "favorites" ? "favorites" : "discover";
  if (href === "#recent-title") return "recent";
  if (href === "#preferences-panel") return "preferences";
  return "";
}

function handleSongAction(action, song, { fromPlayer = false } = {}) {
  let message;
  let changed = true;
  if (action === "toggle-favorite") {
    const active = toggleFavorite(state.user, song.id);
    message = active ? "Added to favorites" : "Removed from favorites";
  } else if (action === "toggle-like") {
    const active = toggleLike(state.user, song.id);
    message = active ? "Song liked" : "Like removed";
  } else if (action === "toggle-dislike") {
    const active = toggleDislike(state.user, song.id);
    message = active ? "Marked as not for me" : "Not for me removed";
  } else {
    const result = markSung(state.user, song.id);
    changed = result.added;
    if (result.added) {
      const challenge = getDailyChallenge(state.songs, state.user);
      if (challenge.song?.id?.toLowerCase() === song.id.toLowerCase()) {
        const completed = completeDailyChallenge(state.user, challenge.dateKey, song.id, { expectedSongId: challenge.song.id });
        if (completed) message = "Marked as sung · daily challenge complete";
      }
    }
    if (result.added && state.user.partySession.enabled) {
      syncPartyQueueAssignments();
      const assignedSinger = getAssignedSinger(state.user.partySession, song.id);
      recordPartyTurn(state.user.partySession, song.id, assignedSinger?.id);
      partyStatusMessage = "Party turn counted.";
    }
    message ||= result.added ? "Marked as sung" : "Already marked as sung just now";
  }
  if (changed) {
    persistAppState(state);
    refreshRecommendationsSnapshot();
  }
  const currentSong = getQueueSnapshot(state).currentSong;
  if (currentSong?.id?.toLowerCase() === song.id.toLowerCase()) {
    updatePlayerActions(song, state.user);
    if (action === "mark-sung" && changed) showPlayerSangIt();
  }
  render();
  if (fromPlayer) document.querySelector(`[data-player-panel] [data-action="${action}"]`)?.focus();
  else focusSongActionOrQueue(song.id, action);
  showToast(message);
}

function togglePartyMode() {
  state.user.partySession.enabled = !state.user.partySession.enabled;
  if (state.user.partySession.enabled) {
    syncPartyQueueAssignments();
    currentView = "party";
    setViewHash("party");
  }
  rouletteResult = null;
  rouletteHistory = [];
  rouletteRecovery = { available: false, message: "" };
  partyStatusMessage = state.user.partySession.enabled ? "Party Mode is on. Add singers to start a fair rotation." : "Party Mode is off. Your party session stays saved on this device.";
  persistAppState(state);
  if (!state.user.partySession.enabled && currentView === "party") {
    currentView = "home";
    setViewHash("home");
  }
  render();
  showToast(state.user.partySession.enabled ? "Party Mode on" : "Party Mode off");
}

function syncPartyQueueAssignments() {
  state.user.partySession = reconcilePartyQueue(state.user.partySession, state.user.queue);
}

function renamePartySingerFromUi(singerId, name) {
  const result = renamePartySinger(state.user.partySession, singerId, name);
  partyStatusMessage = result.ok ? `${result.singer.name} was renamed.` : result.reason === "duplicate-name" ? "That singer name is already in the rotation." : "Singer names cannot be empty.";
  if (result.ok) persistAppState(state);
  render();
  if (result.ok) focusPartySinger(singerId);
  showToast(partyStatusMessage);
}

function removePartySingerFromUi(singerId) {
  const singer = state.user.partySession.singers.find((item) => item.id === singerId);
  const result = removePartySinger(state.user.partySession, singerId);
  if (!result.ok) return;
  syncPartyQueueAssignments();
  persistAppState(state);
  partyStatusMessage = singer ? `${singer.name} removed. Their queued turns were reassigned fairly.` : "Singer removed.";
  render();
  const nextSingerInput = document.querySelector("[data-party-rename]") || document.querySelector("[name=singer]");
  nextSingerInput?.focus();
  showToast(partyStatusMessage);
}

function clearPartySessionFromUi() {
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm("Clear singers, assignments, and party stats?")) return;
  clearPartySession(state.user.partySession);
  rouletteResult = null;
  rouletteHistory = [];
  rouletteRecovery = { available: false, message: "" };
  partyStatusMessage = "Party session cleared. Your personal favorites, history, and queue remain.";
  persistAppState(state);
  render();
  document.querySelector("[name=singer]")?.focus();
  showToast("Party session cleared");
}

function assignSingerFromUi(songId, singerId) {
  if (!singerId) unassignPartySong(state.user.partySession, songId);
  else assignPartySong(state.user.partySession, songId, singerId);
  syncPartyQueueAssignments();
  persistAppState(state);
  partyStatusMessage = "Queue assignment saved.";
  render();
}

function rollRoulette() {
  if (!state.user.partySession.enabled) return;
  const excluded = [...rouletteHistory, rouletteResult?.song?.id].filter(Boolean);
  const song = selectRouletteSong(state.songs, state.user, rouletteConstraints, {
    partySession: state.user.partySession,
    excludeSongIds: excluded
  });
  if (!song && rouletteHistory.length) {
    rouletteHistory = [];
    const freshSong = selectRouletteSong(state.songs, state.user, rouletteConstraints, {
      partySession: state.user.partySession,
      excludeSongIds: rouletteResult?.song ? [rouletteResult.song.id] : []
    });
    rouletteResult = freshSong ? { song: freshSong, singerId: getNextPartySinger(state.user.partySession)?.id || "" } : null;
    partyStatusMessage = freshSong ? "You have seen every match this round, so Roulette started a fresh round." : "No playable songs match those roulette constraints.";
    rouletteRecovery = freshSong ? { available: false, message: "" } : { available: true, message: "No playable songs matched all of those filters. Relax optional filters to find a safe match." };
    if (freshSong) rouletteHistory.push(freshSong.id);
  } else {
    rouletteResult = song ? { song, singerId: getNextPartySinger(state.user.partySession)?.id || "" } : null;
    partyStatusMessage = song ? "Roulette picked a song. Confirm before adding it." : "No playable songs match those roulette constraints.";
    rouletteRecovery = song ? { available: false, message: "" } : { available: true, message: "No playable songs matched all of those filters. Relax optional filters to find a safe match." };
    if (song) rouletteHistory.push(song.id);
  }
  render();
  document.querySelector(rouletteResult?.song ? '[data-action="roulette-add"]' : '[data-action="roll-roulette"]')?.focus();
}

function relaxRoulette() {
  if (!state.user.partySession.enabled) return;
  const relaxed = relaxRouletteConstraints(state.songs, state.user, rouletteConstraints, { partySession: state.user.partySession, excludeSongIds: rouletteHistory });
  rouletteConstraints = relaxed.constraints;
  if (relaxed.candidates.length) {
    rouletteHistory = [];
    const song = selectRouletteSong(state.songs, state.user, rouletteConstraints, { partySession: state.user.partySession });
    rouletteResult = song ? { song, singerId: getNextPartySinger(state.user.partySession)?.id || "" } : null;
    if (song) rouletteHistory.push(song.id);
  } else {
    rouletteResult = null;
  }
  const labels = relaxed.relaxed.map((key) => key === "mood" ? "mood" : key === "era" ? "era" : key === "difficulty" ? "difficulty" : key === "genre" ? "genre" : "language");
  rouletteRecovery = relaxed.candidates.length ? { available: false, message: labels.length ? `Relaxed ${labels.join(", ")}.` : "Those filters already have playable matches." } : { available: true, message: labels.length ? `Relaxed ${labels.join(", ")}, but no playable match is available yet.` : "No playable match is available yet." };
  partyStatusMessage = rouletteRecovery.message;
  render();
  document.querySelector(rouletteResult ? '[data-action="roulette-add"]' : '[data-action="roll-roulette"]')?.focus();
}

function clearRouletteFilters() {
  rouletteConstraints = { language: "any", genre: "any", mood: "any", difficulty: "any", era: "any" };
  rouletteResult = null;
  rouletteHistory = [];
  rouletteRecovery = { available: false, message: "Filters cleared. Roll when you are ready." };
  partyStatusMessage = rouletteRecovery.message;
  render();
  document.querySelector('[data-action="roll-roulette"]')?.focus();
}

function viewRouletteSong() {
  const song = rouletteResult?.song;
  if (!song) return;
  state.query = `${song.title} ${song.artist}`;
  currentView = "discover";
  state.filter = "all";
  setViewHash("discover");
  render();
  document.querySelector("#song-search")?.focus();
}

function addRouletteResultToQueue() {
  if (!rouletteResult?.song) return;
  const singerSelect = document.querySelector("[data-roulette-singer]");
  const song = rouletteResult.song;
  if (!addSongToQueue(state.user, song.id)) {
    partyStatusMessage = "That roulette song is already unavailable for this queue.";
    showToast(partyStatusMessage);
    return;
  }
  const assignment = state.user.partySession.enabled ? assignPartySong(state.user.partySession, song.id, singerSelect?.value || null) : null;
  syncPartyQueueAssignments();
  rouletteResult = null;
  partyStatusMessage = "Roulette song added. The queue was not started automatically.";
  persistAppState(state);
  refreshRecommendationsSnapshot();
  render();
  document.querySelector('[data-action="toggle-queue"]')?.focus();
  showToast(assignment?.singer ? `${song.title} added for ${assignment.singer.name}` : `${song.title} added to queue`);
}

function focusPartySinger(singerId) {
  const input = [...document.querySelectorAll("[data-party-rename]")].find((item) => item.dataset.partyRename === singerId);
  (input || document.querySelector("[name=singer]"))?.focus();
}

function addToQueue(song) {
  if (!addSongToQueue(state.user, song.id)) {
    showToast("That song is already in your queue");
    focusSongActionOrQueue(song.id, "add-queue");
    return;
  }
  const assignment = state.user.partySession.enabled ? assignPartySong(state.user.partySession, song.id) : null;
  syncPartyQueueAssignments();
  persistAppState(state);
  refreshRecommendationsSnapshot();
  render();
  focusSongActionOrQueue(song.id, "add-queue");
  showToast(assignment?.singer ? `${song.title} added for ${assignment.singer.name}` : `${song.title} added to queue`);
}

function removeFromQueue(songId) {
  const oldIndex = state.user.queue.findIndex((id) => id.toLowerCase() === songId.toLowerCase());
  const wasCurrent = state.user.currentSongId?.toLowerCase() === songId.toLowerCase();
  removeSongFromQueue(state.user, songId);
  unassignPartySong(state.user.partySession, songId);
  persistAppState(state);
  refreshRecommendationsSnapshot();
  render();
  const snapshot = getQueueSnapshot(state);
  const player = document.querySelector("[data-player-panel]");
  if (player && !player.hidden && wasCurrent) syncPlayer(snapshot);
  const focusId = state.user.currentSongId || state.user.queue[Math.min(oldIndex, state.user.queue.length - 1)];
  if (focusId) focusSongAction(focusId, "select-queue");
  else document.querySelector('[data-action="toggle-queue"]')?.focus();
  showToast("Removed from queue");
}

function startSong(song, launcher = null) {
  rememberPlayerLauncher(launcher);
  playerFinishedSongId = null;
  addSongToQueue(state.user, song.id);
  recordSongPlayed(state.user, song.id);
  if (state.user.partySession.enabled && !getAssignedSinger(state.user.partySession, song.id)) assignPartySong(state.user.partySession, song.id);
  syncPartyQueueAssignments();
  setCurrentSong(state.user, song.id);
  persistAppState(state);
  refreshRecommendationsSnapshot();
  render();
  syncPlayer(getQueueSnapshot(state));
  focusSongActionOrQueue(song.id, "play");
  showToast(`${song.title} is now current`);
}

function reorderQueue(action, song) {
  const changed = action === "move-top" ? moveQueueItemToTop(state.user, song.id) : moveQueueItem(state.user, song.id, action === "move-up" ? "up" : "down");
  if (!changed) return;
  persistAppState(state);
  refreshRecommendationsSnapshot();
  render();
  const player = document.querySelector("[data-player-panel]");
  if (player && !player.hidden) syncPlayer(getQueueSnapshot(state), { reloadVideo: false });
  focusSongActionOrQueue(song.id, action);
  showToast(`${song.title} moved ${action === "move-top" ? "to the top" : action === "move-up" ? "up" : "down"}`);
}

function replayCurrentSong() {
  const currentSong = getQueueSnapshot(state).currentSong;
  if (!currentSong) {
    showToast("Choose a song to sing first");
    return;
  }
  playerFinishedSongId = null;
  syncPlayer(getQueueSnapshot(state));
  showToast(currentSong.title + " is playing again");
}

function focusSongActionOrQueue(songId, action) {
  if (focusSongAction(songId, action)) return;
  document.querySelector('[data-action="toggle-queue"]')?.focus();
}

function clearQueueFromUi() {
  if (state.user.queue.length > 1 && typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm("Clear all songs from your karaoke queue?")) return;
  clearQueue(state.user);
  clearPartyAssignments(state.user.partySession);
  persistAppState(state);
  refreshRecommendationsSnapshot();
  render();
  closePlayer();
  document.querySelector('[data-action="toggle-queue"]')?.focus();
  showToast("Queue cleared");
}

function advanceToNext() {
  const snapshot = getQueueSnapshot(state);
  const queuedNext = snapshot.currentIndex >= 0 ? snapshot.songs[snapshot.currentIndex + 1] : null;
  const recommendedNext = queuedNext ? null : getRecommendedNext(snapshot);
  let result;
  if (recommendedNext) {
    addSongToQueue(state.user, recommendedNext.id);
    setCurrentSong(state.user, recommendedNext.id);
    result = { status: "recommended", currentSongId: recommendedNext.id, song: recommendedNext };
  } else {
    result = advanceQueue(state.user);
  }
  playerFinishedSongId = null;
  persistAppState(state);
  refreshRecommendationsSnapshot();
  render();
  if (result.currentSongId) syncPlayer(getQueueSnapshot(state));
  else if (result.status === "finished") { youtubeController?.stop(); showQueueFinished(getQueueSnapshot(state).total); }
  else { closePlayer(); }
  showToast(result.status === "recommended" ? `${result.song.title} is next` : result.status === "finished" ? "Queue finished" : result.status === "empty" ? "Your queue is empty" : "Moved to the next song");
}

function selectPrevious() {
  const result = selectPreviousQueueSong(state.user);
  persistAppState(state);
  refreshRecommendationsSnapshot();
  render();
  if (result.currentSongId) syncPlayer(getQueueSnapshot(state));
  else { closePlayer(); }
  showToast(result.status === "boundary" ? "Already at the first song" : "Moved to the previous song");
}

function syncPlayer(snapshot, { reloadVideo = true } = {}) {
  if (!snapshot.currentSong) {
    youtubeController?.stop();
    if (snapshot.queueFinished) showQueueFinished(snapshot.total);
    else closePlayer({ restoreFocus: false });
    return;
  }
  const nextSong = snapshot.currentIndex >= 0 ? snapshot.songs[snapshot.currentIndex + 1] || getRecommendedNext(snapshot) : getRecommendedNext(snapshot);
  const nextType = snapshot.currentIndex >= 0 && snapshot.songs[snapshot.currentIndex + 1] ? "queued" : "recommended";
  if (playerFinishedSongId && playerFinishedSongId.toLowerCase() !== snapshot.currentSong.id.toLowerCase()) playerFinishedSongId = null;
  showPlayer(snapshot.currentSong, {
    position: snapshot.position,
    total: snapshot.total,
    hasPrevious: snapshot.position > 1,
    hasNext: Boolean(nextSong),
    nextSong,
    nextType,
    isFavorite: state.user.favorites.some((id) => id.toLowerCase() === snapshot.currentSong.id.toLowerCase()),
    isSung: state.user.sungHistory.some((entry) => entry.id.toLowerCase() === snapshot.currentSong.id.toLowerCase())
  });
  if (window.matchMedia?.("(max-width: 799px)").matches) {
    const panel = document.querySelector("[data-player-panel]");
    if (panel && !panel.classList.contains("is-expanded")) setPlayerExpanded(panel, true);
  }
  if (playerFinishedSongId?.toLowerCase() === snapshot.currentSong.id.toLowerCase()) showPlayerFinished({ nextSong, nextType });
  if (reloadVideo) loadCurrentVideo(snapshot.currentSong);
}

function getRecommendedNext(snapshot) {
  const excluded = new Set(snapshot.songs.map((song) => song.id.toLowerCase()));
  if (snapshot.currentSong?.id) excluded.add(snapshot.currentSong.id.toLowerCase());
  return recommendationSnapshot.map((item) => item.song).find((song) => !excluded.has(song.id.toLowerCase()) && isValidYouTubeVideoId(song.youtubeVideoId)) || null;
}

function loadCurrentVideo(song, { autoplay = true } = {}) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    youtubeController?.stop();
    showPlayerOffline();
    return;
  }
  if (!isValidYouTubeVideoId(song.youtubeVideoId)) {
    youtubeController?.stop();
    showPlayerUnavailable();
    return;
  }
  if (!youtubeController) {
    showPlayerError();
    return;
  }
  showPlayerLoading();
  void youtubeController.load(song.youtubeVideoId, { autoplay });
}

function updateConnectionStatus() {
  const status = document.querySelector("[data-connection-status]");
  if (status) status.hidden = typeof navigator === "undefined" || navigator.onLine !== false;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || window.location.protocol === "file:") return;
  navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch((error) => {
    console.warn("[KantaTayo] Offline app shell could not be registered.", error);
  });
}

function handleYouTubeStateChange(event) {
  if (event.ended || event.state === "ended") {
    handleVideoEnded(event.videoId);
    return;
  }
  const states = {
    [YOUTUBE_PLAYER_STATE.PLAYING]: "playing",
    [YOUTUBE_PLAYER_STATE.PAUSED]: "paused",
    [YOUTUBE_PLAYER_STATE.BUFFERING]: "buffering",
    [YOUTUBE_PLAYER_STATE.CUED]: "cued"
  };
  if (states[event.state]) showPlayerPlaybackState(states[event.state]);
}

function handleVideoEnded(videoId) {
  const snapshot = getQueueSnapshot(state);
  if (!snapshot.currentSong || snapshot.currentSong.youtubeVideoId !== videoId) return;
  playerFinishedSongId = snapshot.currentSong.id;
  const nextSong = snapshot.currentIndex >= 0 ? snapshot.songs[snapshot.currentIndex + 1] || getRecommendedNext(snapshot) : getRecommendedNext(snapshot);
  const nextType = snapshot.currentIndex >= 0 && snapshot.songs[snapshot.currentIndex + 1] ? "queued" : "recommended";
  showPlayerFinished({ nextSong, nextType });
}

function handleYouTubeError(details) {
  console.warn("[KantaTayo YouTube] Playback error", details.code, details.videoId);
  showPlayerError();
}

async function togglePlayerFullscreen() {
  const panel = document.querySelector("[data-player-panel]");
  const button = panel?.querySelector('[data-action="fullscreen-player"]');
  if (!panel || !button) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen?.();
    else if (panel.requestFullscreen) await panel.requestFullscreen();
    else if (panel.webkitRequestFullscreen) panel.webkitRequestFullscreen();
    else { showToast("Full screen is not available here"); return; }
  } catch (error) {
    console.info("[KantaTayo] Full screen was unavailable.", error);
    showToast("Full screen was unavailable");
  }
  syncFullscreenButton();
}

function syncFullscreenButton() {
  const button = document.querySelector('[data-action="fullscreen-player"]');
  const panel = document.querySelector("[data-player-panel]");
  if (!button || !panel) return;
  const supported = Boolean(document.fullscreenEnabled || panel.requestFullscreen || panel.webkitRequestFullscreen);
  button.hidden = !supported;
  const active = Boolean(document.fullscreenElement);
  button.setAttribute("aria-label", active ? "Exit full screen player" : "Full screen player");
  button.title = active ? "Exit full screen player" : "Full screen player";
}

function toggleQueue() {
  const drawer = document.querySelector("[data-queue-drawer]");
  const backdrop = document.querySelector(".drawer-backdrop");
  const isOpen = drawer.classList.toggle("is-open");
  if (isOpen) queueReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : document.querySelector('[data-action="toggle-queue"]');
  drawer.setAttribute("aria-hidden", String(!isOpen));
  backdrop.classList.toggle("is-visible", isOpen);
  const label = isOpen ? "Close singing queue" : "Open singing queue";
  document.querySelectorAll('[data-action="toggle-queue"]').forEach((button) => {
    button.setAttribute("aria-expanded", String(isOpen));
    button.setAttribute("aria-label", label);
    button.title = label;
  });
  if (isOpen) document.querySelector("[data-queue-drawer] .icon-button")?.focus();
  else {
    const returnTarget = queueReturnFocus;
    queueReturnFocus = null;
    if (returnTarget instanceof HTMLElement && document.contains(returnTarget)) returnTarget.focus();
    else document.querySelector('[data-action="toggle-queue"]')?.focus();
  }
}

function closeQueue() {
  const drawer = document.querySelector("[data-queue-drawer]");
  if (!drawer.classList.contains("is-open")) return;
  toggleQueue();
}

function rememberPlayerLauncher(launcher = null) {
  const player = document.querySelector("[data-player-panel]");
  if (player && !player.hidden && playerReturnFocus) return;
  const active = launcher instanceof HTMLElement ? launcher : document.activeElement;
  playerReturnFocus = {
    element: active instanceof HTMLElement ? active : null,
    songId: active?.dataset?.songId || "",
    action: active?.dataset?.action || ""
  };
}

function closePlayer({ restoreFocus = true } = {}) {
  youtubeController?.stop();
  hidePlayer();
  if (!restoreFocus) {
    playerReturnFocus = null;
    return;
  }
  const returnTarget = playerReturnFocus;
  playerReturnFocus = null;
  if (returnTarget?.element instanceof HTMLElement && document.contains(returnTarget.element)) {
    returnTarget.element.focus();
  } else if (returnTarget?.songId && returnTarget?.action && focusSongAction(returnTarget.songId, returnTarget.action)) {
    return;
  } else if (state.user.currentSongId && focusSongAction(state.user.currentSongId, "play")) {
    return;
  } else {
    document.querySelector('[data-action="toggle-queue"]')?.focus();
  }
}

startApp();
