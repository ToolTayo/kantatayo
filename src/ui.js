import { escapeHtml, formatSongMeta, titleCase } from "./utils.js";
import { getDiscoverySongs } from "./discovery.js";
import { isValidYouTubeVideoId } from "./youtube.js";
import { getCatalogPreferenceOptions, getPreferenceSummary, PREFERENCE_GROUPS, preferenceValueIsSelected } from "./preferences.js";
import { getNextPartySinger, getPartyStats } from "./party.js";

const homeSectionOrder = ["recommended", "favorites", "opm", "recent"];

export function renderSongSections(searchIndex, query = "", filter = "all", sortBy = "relevance", userState = {}, recommendations = [], view = "home") {
  updateViewPanels(view);
  const allSongs = searchIndex.map((entry) => entry.song);
  const favoriteIds = new Set((userState.favorites || []).map((id) => id.toLowerCase()));
  const likedIds = new Set((userState.likedSongs || []).map((id) => id.toLowerCase()));
  const dislikedIds = new Set((userState.dislikedSongs || []).map((id) => id.toLowerCase()));

  renderHomeSections(allSongs, userState, recommendations, { favoriteIds, likedIds, dislikedIds });
  if (view === "discover") renderCatalogView(searchIndex, query, filter, sortBy, userState, { favoriteIds, likedIds, dislikedIds });
  if (view === "favorites") renderCollectionView("favorites", allSongs, userState, { favoriteIds, likedIds, dislikedIds });
  if (view === "recent") renderCollectionView("recent", allSongs, userState, { favoriteIds, likedIds, dislikedIds });
}

function updateViewPanels(view) {
  document.body.dataset.view = view;
  document.querySelectorAll("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== view; });
  document.querySelectorAll(".primary-nav a, .mobile-nav a, .brand, .sidebar-brand, a[data-view], [data-action=\"toggle-party-mode\"]").forEach((link) => {
    const active = (link.dataset.view || legacyView(link)) === view;
    link.classList.toggle("is-active", active);
    if (link.hasAttribute("aria-pressed")) link.setAttribute("aria-pressed", String(active));
  });
}

function legacyView(link) {
  if (link.dataset.action === "toggle-party-mode") return "party";
  const href = link.getAttribute("href") || "";
  if (href === "#top") return "home";
  if (href === "#discovery") return link.dataset.filter === "favorites" ? "favorites" : "discover";
  if (href === "#recent-title") return "recent";
  if (href === "#preferences-panel") return "preferences";
  return "";
}

function renderHomeSections(allSongs, userState, recommendations, interactionState) {
  const recentSongs = getRecentlySungSongs(allSongs, userState.sungHistory || []);
  const recommendedIds = new Set((Array.isArray(recommendations) ? recommendations : []).map((item) => item.song?.id?.toLowerCase()).filter(Boolean));
  const favoriteIds = new Set((userState.favorites || []).map((id) => id.toLowerCase()));
  const sections = {
    recommended: Array.isArray(recommendations) ? recommendations : [],
    favorites: allSongs.filter((song) => favoriteIds.has(song.id.toLowerCase())).slice(0, 5),
    opm: allSongs.filter((song) => (song.tags.includes("opm") || song.language.toLowerCase() === "filipino") && !recommendedIds.has(song.id.toLowerCase())).slice(0, 4),
    recent: recentSongs.slice(0, 4)
  };

  homeSectionOrder.forEach((section) => {
    const grid = document.querySelector(`[data-grid="${section}"]`);
    const sectionElement = document.querySelector(`[data-section="${section}"]`);
    if (!grid || !sectionElement) return;
    const isRecent = section === "recent";
    const isRecommended = section === "recommended";
    sectionElement.hidden = isRecent || section === "favorites" ? sections[section].length === 0 : isRecommended ? false : sections[section].length === 0;
    grid.hidden = sections[section].length === 0;
    grid.innerHTML = sections[section].map((item) => {
      const song = section === "recommended" ? item.song : item;
      const reason = section === "recommended" ? item.reason : "";
      return renderSongCard(song, interactionState, { reason });
    }).join("");
    if (isRecent) {
      const empty = sectionElement.querySelector("[data-recent-empty]");
      if (empty) empty.hidden = sections[section].length > 0;
    }
    if (isRecommended) {
      const empty = sectionElement.querySelector("[data-section-empty]");
      if (empty) empty.hidden = sections[section].length > 0;
    }
  });

  const homeCount = document.querySelector("[data-home-count]");
  if (homeCount) homeCount.textContent = `${sections.recommended.length} curated pick${sections.recommended.length === 1 ? "" : "s"}`;
}

function renderCatalogView(searchIndex, query, filter, sortBy, userState, interactionState) {
  const songs = getDiscoverySongs(searchIndex, { query, filter, sortBy, favoriteIds: userState.favorites });
  const grid = document.querySelector('[data-grid="discover"]');
  if (grid) grid.innerHTML = songs.map((song) => renderSongCard(song, interactionState, { catalogView: true })).join("");
  const count = document.querySelector("[data-discover-count]");
  if (count) count.textContent = `${songs.length} song${songs.length === 1 ? "" : "s"}`;
  const empty = document.querySelector("[data-discover-empty]");
  if (empty) empty.hidden = songs.length > 0;
  document.querySelectorAll(".discover-view [data-filter]").forEach((button) => {
    const active = button.dataset.filter === filter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderCollectionView(kind, allSongs, userState, interactionState) {
  const songs = kind === "favorites"
    ? allSongs.filter((song) => interactionState.favoriteIds.has(song.id.toLowerCase()))
    : getRecentlySungSongs(allSongs, userState.sungHistory || []);
  const grid = document.querySelector(`[data-grid="${kind}-view"]`);
  if (grid) grid.innerHTML = songs.map((song) => renderSongCard(song, interactionState, { catalogView: true })).join("");
  const count = document.querySelector(`[data-${kind}-count]`);
  if (count) count.textContent = `${songs.length} song${songs.length === 1 ? "" : "s"}`;
  const empty = document.querySelector(`[data-${kind}-empty]`);
  if (empty) empty.hidden = songs.length > 0;
}

export function renderPreferences(songs, preferences = {}) {
  const target = document.querySelector("[data-preferences-content]");
  if (!target) return;
  const options = getCatalogPreferenceOptions(songs);
  target.innerHTML = `<p class="preferences-intro">Optional signals for future song suggestions. Your choices stay on this device.</p><div class="preference-groups">${PREFERENCE_GROUPS.map((group) => renderPreferenceGroup(group, options[group.key] || [], preferences[group.key] || [])).join("")}</div><div class="preferences-footer"><button class="text-button" type="button" data-action="clear-preferences">Clear preferences</button><span class="preference-save-note">Saved on this device</span></div>`;
  updatePreferenceSummary(preferences, options);
}

export function updatePreferenceSummary(preferences = {}, options) {
  const summary = document.querySelector("[data-preferences-summary]");
  if (!summary) return;
  summary.textContent = getPreferenceSummary(preferences, options);
}

export function renderPartyPanel(songs, partySession, queueSnapshot, rouletteResult = null, rouletteConstraints = {}, statusMessage = "Party details stay on this device.") {
  const panel = document.querySelector("[data-party-panel]");
  if (!panel) return;
  const enabled = Boolean(partySession?.enabled);
  panel.hidden = !enabled;
  document.querySelectorAll('[data-action="toggle-party-mode"], [data-view="party"]').forEach((button) => {
    button.setAttribute("aria-pressed", String(enabled));
    if (button.classList.contains("party-toggle")) button.textContent = enabled ? "♫ Party Mode on" : "♫ Party Mode";
  });
  if (!enabled) return;

  const singers = document.querySelector("[data-party-singers]");
  if (singers) singers.innerHTML = partySession.singers.length ? partySession.singers.map((singer) => `<li class="party-singer"><input data-party-rename="${escapeHtml(singer.id)}" aria-label="Rename ${escapeHtml(singer.name)}" value="${escapeHtml(singer.name)}" maxlength="40" /><button class="remove-button" type="button" data-action="remove-party-singer" data-singer-id="${escapeHtml(singer.id)}" aria-label="Remove ${escapeHtml(singer.name)}">×</button></li>`).join("") : `<li class="party-empty">Add at least two singers for a full rotation.</li>`;

  const items = queueSnapshot?.partyItems || [];
  const current = queueSnapshot?.currentIndex >= 0 ? items[queueSnapshot.currentIndex] : null;
  const now = document.querySelector("[data-party-now]");
  if (now) now.innerHTML = current ? `<p class="party-label">Now singing</p><strong>${escapeHtml(current.singer?.name || "Unassigned singer")}</strong><span>${escapeHtml(current.song.title)}</span><small>${escapeHtml(current.song.artist)}</small>` : `<p class="party-ready"><strong>Party-ready</strong><span>${items.length ? "Choose a queued song to start." : "Add songs to begin the rotation."}</span></p>`;
  const next = document.querySelector("[data-party-up-next]");
  if (next) {
    const start = queueSnapshot?.currentIndex >= 0 ? queueSnapshot.currentIndex + 1 : 0;
    const upcoming = items.slice(start, start + 5);
    next.innerHTML = upcoming.length ? upcoming.map((item) => `<li><span>${escapeHtml(item.singer?.name || "Unassigned")}</span><strong>${escapeHtml(item.song.title)}</strong></li>`).join("") : `<li class="party-empty">Nothing up next yet.</li>`;
  }

  const rouletteFilters = document.querySelector("[data-roulette-filters]");
  if (rouletteFilters) rouletteFilters.innerHTML = renderRouletteFilters(songs, rouletteConstraints);
  const result = document.querySelector("[data-roulette-result]");
  const empty = document.querySelector("[data-roulette-empty]");
  if (result) {
    result.hidden = !rouletteResult?.song;
    if (rouletteResult?.song) result.innerHTML = `<p class="party-label">🎲 Your song</p><h4>${escapeHtml(rouletteResult.song.title)}</h4><p>${escapeHtml(rouletteResult.song.artist)}</p><label for="roulette-singer">Suggested singer</label><select id="roulette-singer" data-roulette-singer>${renderSingerOptions(partySession, rouletteResult.singerId)}</select><div class="roulette-actions"><button class="add-button" type="button" data-action="roulette-add">Add to Queue</button><button class="text-button" type="button" data-action="roll-roulette">Roll again</button></div>`;
  }
  if (empty) empty.hidden = Boolean(rouletteResult?.song);

  const stats = document.querySelector("[data-party-stats]");
  if (stats) {
    const summary = getPartyStats(partySession, songs);
    stats.innerHTML = `<div class="party-stat-grid"><span><strong>${summary.songsCompleted}</strong>songs completed</span><span><strong>${summary.mostActiveSinger ? escapeHtml(summary.mostActiveSinger.name) : "—"}</strong>most active</span></div><p class="party-stat-note">${summary.genresSung.length ? `Genres sung: ${summary.genresSung.map((item) => `${escapeHtml(item.genre)} (${item.count})`).join(", ")}` : "Stats appear after a party song is marked Sang it."}</p>`;
  }
  const status = document.querySelector("[data-party-status]");
  if (status) status.textContent = statusMessage;
}

function renderRouletteFilters(songs, constraints) {
  const options = getCatalogPreferenceOptions(songs);
  const groups = [
    ["language", "Language", options.languages],
    ["genre", "Genre", options.genres],
    ["mood", "Mood", options.moods],
    ["difficulty", "Difficulty", options.difficulties],
    ["era", "Era", options.eras]
  ];
  return groups.map(([key, label, values]) => `<label><span>${label}</span><select data-roulette-filter="${key}" aria-label="Roulette ${label}"><option value="any">Any</option>${values.map((value) => `<option value="${escapeHtml(value.toLowerCase())}"${constraints[key] === value.toLowerCase() ? " selected" : ""}>${escapeHtml(key === "era" ? value : titleCase(value))}</option>`).join("")}</select></label>`).join("");
}

function renderSingerOptions(session, selectedId = "") {
  const suggested = getNextPartySinger(session)?.id || "";
  const chosen = selectedId || suggested;
  return `<option value="">No singer</option>${session.singers.map((singer) => `<option value="${escapeHtml(singer.id)}"${singer.id === chosen ? " selected" : ""}>${escapeHtml(singer.name)}${singer.id === suggested ? " · next" : ""}</option>`).join("")}`;
}

function renderPreferenceGroup(group, options, selectedValues) {
  return `<fieldset class="preference-group"><legend>${escapeHtml(group.label)}</legend><div class="preference-options">${options.map((option) => {
    const id = `preference-${group.key}-${slugify(option)}`;
    const checked = preferenceValueIsSelected(selectedValues, option);
    return `<label class="preference-option" for="${escapeHtml(id)}"><input id="${escapeHtml(id)}" type="checkbox" data-preference-key="${escapeHtml(group.key)}" value="${escapeHtml(option)}"${checked ? " checked" : ""} /><span>${escapeHtml(formatPreferenceLabel(option, group.key))}</span></label>`;
  }).join("")}</div></fieldset>`;
}

function formatPreferenceLabel(value, key) {
  return key === "eras" ? value : titleCase(value);
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "option";
}

export function renderSongCard(song, interactionState, options = {}) {
  const meta = formatSongMeta(song).map((item) => `<span>${escapeHtml(item)}</span>`).join("");
  const songKey = song.id.toLowerCase();
  const isFavorite = interactionState.favoriteIds.has(songKey);
  const isLiked = interactionState.likedIds.has(songKey);
  const isDisliked = interactionState.dislikedIds.has(songKey);
  const playable = isValidYouTubeVideoId(song.youtubeVideoId);
  const thumbnail = renderSongThumbnail(song, options);
  const availability = options.catalogView && !playable ? `<p class="song-availability" role="status">Karaoke unavailable</p>` : "";
  const queueAction = playable
    ? `<button class="add-button" type="button" data-action="add-queue" data-song-id="${escapeHtml(song.id)}">+ Queue</button>`
    : `<button class="add-button" type="button" disabled aria-label="${escapeHtml(song.title)} is unavailable for karaoke">Unavailable</button>`;
  return `<article class="song-card">
    ${thumbnail}
    <div class="song-card-body"><div class="song-card-top"><div><h4>${escapeHtml(song.title)}</h4><p class="song-artist">${escapeHtml(song.artist)}</p></div><span aria-label="${escapeHtml(song.difficulty)} difficulty" class="difficulty-dot difficulty-${song.difficulty}"></span></div>
    <div class="song-meta">${meta}</div>${availability}${options.reason ? `<p class="song-reason">${escapeHtml(options.reason)}</p>` : ""}
    <div class="song-card-actions">${queueAction}<button class="card-favorite${isFavorite ? " is-active" : ""}" type="button" data-action="toggle-favorite" data-song-id="${escapeHtml(song.id)}" aria-pressed="${isFavorite}" aria-label="${isFavorite ? "Remove" : "Add"} ${escapeHtml(song.title)} ${isFavorite ? "from" : "to"} favorites"><span aria-hidden="true">${isFavorite ? "♥" : "♡"}</span><span class="sr-only">${isFavorite ? "Favorited" : "Favorite"}</span></button><details class="song-more-menu"><summary class="song-more-toggle" aria-label="More actions for ${escapeHtml(song.title)}"><span aria-hidden="true">•••</span></summary><div class="song-more-actions" aria-label="More song actions"><button class="feedback-button${isLiked ? " is-active" : ""}" type="button" data-action="toggle-like" data-song-id="${escapeHtml(song.id)}" aria-pressed="${isLiked}" aria-label="${isLiked ? "Unlike" : "Like"} ${escapeHtml(song.title)}">${isLiked ? "✓ Liked" : "Like"}</button><button class="feedback-button${isDisliked ? " is-active" : ""}" type="button" data-action="toggle-dislike" data-song-id="${escapeHtml(song.id)}" aria-pressed="${isDisliked}" aria-label="${isDisliked ? "Remove" : "Mark"} ${escapeHtml(song.title)} ${isDisliked ? "from" : "as"} not for me">${isDisliked ? "✓ Not for me" : "Not for me"}</button><button class="feedback-button" type="button" data-action="mark-sung" data-song-id="${escapeHtml(song.id)}" aria-label="Mark ${escapeHtml(song.title)} as sung">Sang it</button></div></details></div></div>
  </article>`;
}

function renderSongThumbnail(song, options = {}) {
  const songId = escapeHtml(song.id);
  const title = escapeHtml(song.title);
  const artist = escapeHtml(song.artist);
  const videoId = typeof song.youtubeVideoId === "string" ? song.youtubeVideoId.trim() : "";
  const thumbnailUrl = isValidYouTubeVideoId(videoId) ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : "";
  const image = thumbnailUrl ? `<img class="song-thumbnail-image" data-song-thumbnail src="${thumbnailUrl}" alt="" loading="lazy" decoding="async" referrerpolicy="strict-origin-when-cross-origin" />` : "";
  if (options.catalogView && !thumbnailUrl) return `<div class="song-thumbnail song-thumbnail-unavailable" role="img" aria-label="Karaoke unavailable: ${title} by ${artist}"><span class="song-thumbnail-fallback"><span class="thumbnail-note-icon" aria-hidden="true">♫</span><span>Karaoke unavailable</span></span></div>`;
  return `<button class="song-thumbnail" type="button" data-action="play" data-song-id="${songId}" aria-label="Play karaoke: ${title} by ${artist}">${image}<span class="song-thumbnail-fallback" data-thumbnail-fallback${thumbnailUrl ? " hidden" : ""}><span class="thumbnail-note-icon" aria-hidden="true">♫</span><span>Video coming soon</span></span><span class="song-thumbnail-play" aria-hidden="true">▶</span></button>`;
}

export function getRecentlySungSongs(visibleSongs, history) {
  const visibleById = new Map(visibleSongs.map((song) => [song.id.toLowerCase(), song]));
  const seen = new Set();
  return history.reduce((songs, entry) => {
    const key = entry.id.toLowerCase();
    const song = visibleById.get(key);
    if (!song || seen.has(key)) return songs;
    seen.add(key);
    songs.push(song);
    return songs;
  }, []);
}

export function renderQueue(queueSnapshot, partySession = {}) {
  const snapshot = Array.isArray(queueSnapshot) ? { songs: queueSnapshot, currentSongId: null, queueFinished: false } : queueSnapshot;
  const queue = snapshot?.songs || [];
  const currentSongId = snapshot?.currentSongId || null;
  const queueFinished = Boolean(snapshot?.queueFinished);
  const partyItems = snapshot?.partyItems || [];
  const target = document.querySelector("[data-queue-content]");
  const summary = document.querySelector("[data-queue-summary]");
  if (!target) return;
  document.querySelectorAll("[data-queue-count]").forEach((item) => { item.textContent = queue.length; });
  const currentKey = currentSongId ? currentSongId.toLowerCase() : "";
  const currentIndex = currentKey ? queue.findIndex((song) => song.id.toLowerCase() === currentKey) : -1;
  if (summary) summary.textContent = queueFinished ? `Queue finished · ${queue.length} song${queue.length === 1 ? "" : "s"}` : currentIndex >= 0 ? `Current · ${currentIndex + 1} of ${queue.length}` : `${queue.length} song${queue.length === 1 ? "" : "s"} ready`;
  target.innerHTML = queue.length ? queue.map((song, index) => {
    const isCurrent = Boolean(currentKey) && song.id.toLowerCase() === currentKey;
    const queueRole = isCurrent ? "Current song" : (currentIndex < 0 && index === 0) || (currentIndex >= 0 && index > currentIndex) ? "Up next" : "In queue";
    return `<div class="queue-item${isCurrent ? " is-current" : ""}" role="listitem" aria-current="${isCurrent}">
      <div class="queue-item-main"><span class="queue-item-number">${String(index + 1).padStart(2, "0")}</span><div class="queue-item-copy"><strong>${escapeHtml(song.title)}</strong><span>${escapeHtml(song.artist)}</span><span class="queue-item-state">${queueRole}</span></div></div>
      <div class="queue-item-controls">${snapshot?.partyModeEnabled ? `<label class="queue-singer-control"><span class="sr-only">Singer for ${escapeHtml(song.title)}</span><select data-action="assign-singer" data-song-id="${escapeHtml(song.id)}" aria-label="Singer for ${escapeHtml(song.title)}">${renderSingerOptions(partySession, partyItems[index]?.singer?.id || "")}</select></label>` : ""}<button class="queue-select" type="button" data-action="select-queue" data-song-id="${escapeHtml(song.id)}" aria-pressed="${isCurrent}" aria-label="${isCurrent ? "Current song" : "Select"} ${escapeHtml(song.title)}">${isCurrent ? "Current" : "Select"}</button><button class="queue-control" type="button" data-action="move-up" data-song-id="${escapeHtml(song.id)}" aria-label="Move ${escapeHtml(song.title)} up"${index === 0 ? " disabled" : ""}>↑</button><button class="queue-control" type="button" data-action="move-down" data-song-id="${escapeHtml(song.id)}" aria-label="Move ${escapeHtml(song.title)} down"${index === queue.length - 1 ? " disabled" : ""}>↓</button><button class="queue-control queue-top-control" type="button" data-action="move-top" data-song-id="${escapeHtml(song.id)}" aria-label="Move ${escapeHtml(song.title)} to top"${index === 0 ? " disabled" : ""}>Top</button><button class="remove-button" type="button" data-action="remove-queue" data-song-id="${escapeHtml(song.id)}" aria-label="Remove ${escapeHtml(song.title)} from queue">×</button></div>
    </div>`;
  }).join("") : `<div class="queue-empty"><strong>Your karaoke queue is empty.</strong><br />Add a few songs from discovery to get started.<br /><a href="#top" class="queue-empty-link" data-action="close-queue">Browse songs</a></div>`;
}

export function showPlayer(song, metadata = {}) {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.hidden = false;
  panel.querySelector("[data-player-title]").textContent = song.title;
  panel.querySelector("[data-player-artist]").textContent = song.artist;
  panel.querySelector("[data-player-position]").textContent = metadata.position && metadata.total ? `Song ${metadata.position} of ${metadata.total}` : "Current karaoke song";
  panel.querySelector("[data-player-status]").textContent = "Ready when you are.";
  panel.querySelector("[data-player-note]").textContent = "Playback is provided by YouTube when a verified video is available.";
  updateMiniPlayer(song);
  setPlayerEmbedVisible(panel, false);
  panel.querySelector('[data-action="player-prev"]').disabled = metadata.hasPrevious === false;
  panel.querySelector('[data-action="player-next"]').disabled = metadata.hasNext === false;
}

export function showPlayerLoading() {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.querySelector("[data-player-status]").textContent = "Loading the YouTube player…";
  panel.querySelector("[data-player-note]").textContent = "Playback is provided by YouTube.";
  updateMiniPlayerStatus("Loading player…");
  setPlayerEmbedVisible(panel, false);
}

export function showPlayerReady() {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.querySelector("[data-player-status]").textContent = "YouTube player ready.";
  panel.querySelector("[data-player-note]").textContent = "Playback is provided by YouTube.";
  updateMiniPlayerStatus("Ready to sing");
  setPlayerEmbedVisible(panel, true);
}

export function showPlayerPlaybackState(state) {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  const messages = { playing: "Playing on YouTube.", paused: "Paused.", buffering: "Buffering on YouTube…", cued: "Ready on YouTube." };
  if (messages[state]) {
    panel.querySelector("[data-player-status]").textContent = messages[state];
    updateMiniPlayerStatus(messages[state]);
  }
  setPlayerEmbedVisible(panel, true);
}

export function showPlayerUnavailable() {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.querySelector("[data-player-status]").textContent = "Karaoke video isn't available for this song yet.";
  panel.querySelector("[data-player-note]").textContent = "Choose another queued song or return to discovery.";
  updateMiniPlayerStatus("Video unavailable");
  setPlayerEmbedVisible(panel, false);
}

export function showPlayerOffline() {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.querySelector("[data-player-status]").textContent = "You’re offline. Karaoke videos need an internet connection.";
  panel.querySelector("[data-player-note]").textContent = "Your catalog, queue, and preferences still work on this device.";
  updateMiniPlayerStatus("Offline");
  setPlayerEmbedVisible(panel, false);
}

export function showPlayerError() {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.querySelector("[data-player-status]").textContent = "This karaoke video could not be played.";
  panel.querySelector("[data-player-note]").textContent = "You can try the next song, choose another queued song, or close the player.";
  updateMiniPlayerStatus("Couldn’t play video");
  setPlayerEmbedVisible(panel, false);
}

export function showQueueFinished(total) {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.hidden = false;
  panel.querySelector("[data-player-title]").textContent = "Queue finished";
  panel.querySelector("[data-player-artist]").textContent = "That's the end of your queue.";
  panel.querySelector("[data-player-position]").textContent = `${total} song${total === 1 ? "" : "s"} completed`;
  panel.querySelector("[data-player-status]").textContent = "Choose another song from the queue or return to discovery.";
  panel.querySelector("[data-player-note]").textContent = "Playback is provided by YouTube when a verified video is available.";
  panel.classList.add("is-expanded");
  document.querySelector("[data-mini-player]")?.setAttribute("hidden", "");
  setPlayerEmbedVisible(panel, false);
  panel.querySelector('[data-action="player-prev"]').disabled = total === 0;
  panel.querySelector('[data-action="player-next"]').disabled = true;
}

export function hidePlayer() {
  const panel = document.querySelector("[data-player-panel]");
  if (panel) {
    panel.hidden = true;
    panel.classList.remove("is-expanded");
    setPlayerEmbedVisible(panel, false);
  }
  document.querySelector("[data-mini-player]")?.setAttribute("hidden", "");
}

function updateMiniPlayer(song) {
  const mini = document.querySelector("[data-mini-player]");
  if (!mini) return;
  mini.hidden = false;
  const title = mini.querySelector("[data-mini-player-title]");
  const artist = mini.querySelector("[data-mini-player-artist]");
  if (title) title.textContent = song.title;
  if (artist) artist.textContent = song.artist;
  updateMiniPlayerStatus("Current karaoke song");
}

function updateMiniPlayerStatus(message) {
  const mini = document.querySelector("[data-mini-player]");
  if (!mini) return;
  const status = mini.querySelector("[data-mini-player-status]");
  if (status) status.textContent = message;
}

function setPlayerEmbedVisible(panel, visible) {
  const container = panel.querySelector("[data-youtube-container]");
  const placeholder = panel.querySelector("[data-player-placeholder]");
  if (container) container.hidden = !visible;
  if (placeholder) placeholder.hidden = visible;
}

export function showToast(message) {
  const toast = document.querySelector("[data-toast]");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

export function focusSongAction(songId, action) {
  const target = [...document.querySelectorAll(`[data-action="${action}"]`)].find((button) => button.dataset.songId === songId);
  if (!target) return false;
  const disclosure = target.closest("details");
  if (disclosure) disclosure.open = true;
  target.focus();
  return document.activeElement === target;
}
