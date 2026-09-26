import { escapeHtml, formatSongMeta, titleCase } from "./utils.js";
import { createDefaultDiscoveryFilters, getDiscoveryFilterOptions, getDiscoveryPage, getDiscoverySongs, getHomeShelves, getRecentlySungSongs, hasActiveDiscoveryFilters, hasMeaningfulUserSignals, normalizeDiscoveryFilters, normalizeQuery } from "./discovery.js?v=4";
import { isValidYouTubeVideoId } from "./youtube.js";
import { getCatalogPreferenceOptions, getPreferenceSummary, PREFERENCE_GROUPS, preferenceValueIsSelected } from "./preferences.js";
import { getNextPartySinger, getPartyStats } from "./party.js?v=1";
import { getContinueSingingSongs, getDailyChallenge, getLocalStats, getMostSungSongs, getRecentlyAddedSongs } from "./engagement.js?v=4";
import { getCollectionDefinition, getCollectionSongs, getFeaturedCollectionId, LOCAL_COLLECTIONS } from "./collections.js?v=1";

const homeSectionOrder = ["continue", "recommended", "madeForYou", "favorites", "popular", "recentlyAdded", "trending", "opm", "international", "easy", "duets", "recent"];

export function renderSongSections(searchIndex, query = "", filter = "all", sortBy = "relevance", userState = {}, recommendations = [], view = "home", discoveryFilters = createDefaultDiscoveryFilters(), discoveryPage = 1, selectedCollectionId = "") {
  updateViewPanels(view);
  const allSongs = searchIndex.map((entry) => entry.song);
  const favoriteIds = new Set((userState.favorites || []).map((id) => id.toLowerCase()));
  const likedIds = new Set((userState.likedSongs || []).map((id) => id.toLowerCase()));
  const dislikedIds = new Set((userState.dislikedSongs || []).map((id) => id.toLowerCase()));

  renderHomeEngagement(allSongs, userState);
  renderHomeSections(allSongs, userState, recommendations, { favoriteIds, likedIds, dislikedIds });
  renderLocalCollections(allSongs, userState, { favoriteIds, likedIds, dislikedIds }, selectedCollectionId);
  if (view === "discover") renderCatalogView(searchIndex, query, filter, sortBy, userState, { favoriteIds, likedIds, dislikedIds }, discoveryFilters, discoveryPage);
  if (view === "favorites") renderCollectionView("favorites", allSongs, userState, { favoriteIds, likedIds, dislikedIds });
  if (view === "recent") renderCollectionView("recent", allSongs, userState, { favoriteIds, likedIds, dislikedIds });
}

function renderLocalCollections(allSongs, userState, interactionState, selectedCollectionId = "") {
  const target = document.querySelector("[data-collection-grid]");
  const tabs = document.querySelector("[data-collection-tabs]");
  if (!target || !tabs) return;
  const activeId = getCollectionDefinition(selectedCollectionId || getFeaturedCollectionId()).id;
  const definition = getCollectionDefinition(activeId);
  tabs.innerHTML = LOCAL_COLLECTIONS.map((collection) => `<button class="chip${collection.id === activeId ? " is-active" : ""}" type="button" data-action="select-collection" data-collection-id="${escapeHtml(collection.id)}" aria-pressed="${collection.id === activeId}">${escapeHtml(collection.title)}</button>`).join("");
  const title = document.querySelector("[data-collection-title]");
  const description = document.querySelector("[data-collection-description]");
  if (title) title.textContent = definition.title;
  if (description) description.textContent = definition.description;
  const songs = getCollectionSongs(activeId, allSongs, 4);
  target.innerHTML = songs.map((song) => renderSongCard(song, interactionState, { reason: "Curated locally" })).join("");
  target.hidden = songs.length === 0;
  const empty = document.querySelector("[data-collection-empty]");
  if (empty) empty.hidden = songs.length > 0;
}

function updateViewPanels(view) {
  document.body.dataset.view = view;
  document.querySelectorAll("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== view; });
  document.querySelectorAll(".primary-nav a, .mobile-nav a, .mobile-more-menu a, .brand, .sidebar-brand, a[data-view], [data-action=\"toggle-party-mode\"], [data-action=\"toggle-mobile-more\"]").forEach((link) => {
    const active = link.dataset.action === "toggle-mobile-more"
      ? ["favorites", "recent", "preferences"].includes(view)
      : (link.dataset.view || legacyView(link)) === view;
    link.classList.toggle("is-active", active);
    if (link.hasAttribute("aria-pressed")) link.setAttribute("aria-pressed", String(active));
    if (link.matches("a[href]")) {
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
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
  const sections = getHomeShelves(allSongs, recommendations, userState);
  sections.continue = getContinueSingingSongs(allSongs, userState);
  sections.recentlyAdded = getRecentlyAddedSongs(allSongs);
  sections.trending = getMostSungSongs(allSongs, userState);
  const recommendationReasons = new Map((Array.isArray(recommendations) ? recommendations : []).map((item) => [item.song?.id?.toLowerCase(), item.reason || ""]));
  const personalized = hasMeaningfulUserSignals(userState);
  const homeCopy = {
    recommended: personalized
      ? { title: "Sing now", lede: "Your strongest next-song picks, tuned to your taste." }
      : { title: "Sing now", lede: "Popular, playable picks to get your night moving." },
    madeForYou: { title: "Made for you", lede: "A few more picks shaped by your preferences and history." },
    continue: { title: "Continue singing", lede: "Unfinished songs you opened recently." },
    favorites: { title: "Your favorites", lede: "The songs you want close at hand." },
    popular: { title: "Crowd favorites", lede: "Established karaoke picks with real demand evidence." },
    recentlyAdded: { title: "Recently added", lede: "Fresh catalog additions, ready for a first spin." },
    trending: { title: "Most sung on this device", lede: "Based on Sang It completions saved on this device." },
    opm: { title: "Popular OPM", lede: "Filipino favorites for the next round." },
    international: { title: "International hits", lede: "Familiar English songs made for a sing-along." },
    easy: { title: "Easy wins", lede: "Comfortable picks when you want a confident chorus." },
    duets: { title: "Duet picks", lede: "Bring someone else to the mic." },
    recent: { title: "Recently sung", lede: "Keep exploring from where you left off." }
  };

  homeSectionOrder.forEach((section) => {
    const grid = document.querySelector(`[data-grid="${section}"]`);
    const sectionElement = document.querySelector(`[data-section="${section}"]`);
    if (!grid || !sectionElement) return;
    const isRecommended = section === "recommended";
    const songs = sections[section] || [];
    const copy = homeCopy[section];
    sectionElement.hidden = isRecommended ? false : songs.length === 0;
    grid.hidden = songs.length === 0;
    grid.innerHTML = songs.map((song) => renderSongCard(song, interactionState, { reason: recommendationReasons.get(song.id.toLowerCase()) || "" })).join("");
    const title = sectionElement.querySelector("[data-home-title]");
    const lede = sectionElement.querySelector("[data-home-lede]");
    if (title && copy) title.textContent = copy.title;
    if (lede && copy) lede.textContent = copy.lede;
    if (isRecommended) {
      const empty = sectionElement.querySelector("[data-section-empty]");
      if (empty) empty.hidden = songs.length > 0;
    }
  });

  const homeCount = document.querySelector("[data-home-count]");
  if (homeCount) homeCount.textContent = `${sections.recommended.length} ready-to-sing pick${sections.recommended.length === 1 ? "" : "s"}`;
  const resultsNote = document.querySelector("[data-results-note]");
  if (resultsNote) resultsNote.textContent = personalized ? "Fresh ideas based on what you like and sing." : "Popular playable picks to get your night moving.";
}

function renderHomeEngagement(allSongs, userState) {
  const challenge = getDailyChallenge(allSongs, userState);
  const card = document.querySelector("[data-daily-challenge]");
  if (card) {
    card.hidden = !challenge.song;
    if (challenge.song) {
      const title = card.querySelector("[data-daily-title]");
      const artist = card.querySelector("[data-daily-artist]");
      const meta = card.querySelector("[data-daily-meta]");
      const thumbnail = card.querySelector("[data-daily-thumbnail]");
      const date = card.querySelector("[data-daily-date]");
      const status = card.querySelector("[data-daily-status]");
      const streak = card.querySelector("[data-daily-streak]");
      const button = card.querySelector('[data-action="daily-challenge-play"]');
      if (title) title.textContent = challenge.song.title;
      if (artist) artist.textContent = challenge.song.artist;
      if (meta) meta.textContent = formatSongMeta(challenge.song).join(" · ");
      if (thumbnail) thumbnail.innerHTML = renderSongThumbnail(challenge.song, { dailyChallenge: true });
      if (date) date.textContent = challenge.completed ? "✓ Completed today" : "Today’s featured song";
      if (status) {
        status.textContent = challenge.completed
          ? `Challenge complete · ${formatDayCount(challenge.currentStreak)} · best ${formatDayCount(challenge.longestStreak)}`
          : challenge.currentStreak > 0
            ? `Sing today to keep your ${formatDayCount(challenge.currentStreak)} streak going.`
            : "Sing this song to start your streak.";
      }
      if (streak) {
        streak.textContent = challenge.currentStreak > 0 ? formatDayCount(challenge.currentStreak) : "";
        streak.parentElement.hidden = challenge.currentStreak <= 0;
        streak.parentElement.setAttribute("aria-label", challenge.currentStreak > 0 ? `Current challenge streak: ${challenge.currentStreak} day${challenge.currentStreak === 1 ? "" : "s"}` : "");
      }
      if (button) {
        button.dataset.songId = challenge.song.id;
        button.disabled = challenge.completed;
        button.textContent = challenge.completed ? "Completed Today ✓" : "Sing Today’s Challenge";
        button.setAttribute("aria-label", challenge.completed ? `Daily challenge completed: ${challenge.song.title} by ${challenge.song.artist}` : `Play daily challenge: ${challenge.song.title} by ${challenge.song.artist}`);
      }
      card.classList.toggle("is-complete", challenge.completed);
    } else {
      const thumbnail = card.querySelector("[data-daily-thumbnail]");
      if (thumbnail) thumbnail.replaceChildren();
    }
  }

  const stats = getLocalStats(allSongs, userState);
  const statsCard = document.querySelector("[data-local-stats]");
  if (!statsCard) return;
  const set = (name, value) => {
    const target = statsCard.querySelector(`[data-stat="${name}"]`);
    if (target) target.textContent = value;
  };
  set("songs", String(stats.songsSung));
  set("favorites", String(stats.favorites));
  set("streak", stats.currentStreak > 0 ? formatDayCount(stats.currentStreak) : "No streak yet");
  set("longest", stats.longestStreak > 0 ? formatDayCount(stats.longestStreak) : "No streak yet");
  set("split", `${stats.opm} OPM · ${stats.international} Intl`);
  set("artists", stats.topArtists.length ? stats.topArtists.map((item) => `${item.artist} (${item.count})`).join(" · ") : "No artists yet");
}

function formatDayCount(value) {
  const count = Math.max(0, Number(value) || 0);
  return `${count} day${count === 1 ? "" : "s"}`;
}

function renderCatalogView(searchIndex, query, filter, sortBy, userState, interactionState, discoveryFilters, discoveryPage) {
  const allSongs = searchIndex.map((entry) => entry.song);
  const filters = normalizeDiscoveryFilters(discoveryFilters, filter);
  const songs = getDiscoverySongs(searchIndex, { query, filters, sortBy, favoriteIds: userState.favorites });
  const page = getDiscoveryPage(songs, discoveryPage, 24);
  const visibleSongs = songs.slice(0, page.page * page.pageSize);
  const grid = document.querySelector('[data-grid="discover"]');
  if (grid) grid.innerHTML = visibleSongs.map((song) => renderSongCard(song, interactionState, { catalogView: true })).join("");
  const count = document.querySelector("[data-discover-count]");
  if (count) count.textContent = `${songs.length} song${songs.length === 1 ? "" : "s"}`;
  const empty = document.querySelector("[data-discover-empty]");
  if (empty) empty.hidden = songs.length > 0;
  renderDiscoveryFilterControls(allSongs, filters);
  const loadMore = document.querySelector("[data-discover-load-more]");
  if (loadMore) loadMore.hidden = !page.hasMore || songs.length === 0;
  const remaining = document.querySelector("[data-discover-remaining]");
  if (remaining) remaining.textContent = page.hasMore ? `${songs.length - visibleSongs.length} more matches` : "";
  const emptyTitle = document.querySelector("[data-discover-empty-title]");
  const emptyCopy = document.querySelector("[data-discover-empty-copy]");
  if (emptyTitle) emptyTitle.textContent = query.trim() || hasActiveDiscoveryFilters(filters) ? "No songs match those choices" : "No songs found";
  if (emptyCopy) emptyCopy.textContent = query.trim() || hasActiveDiscoveryFilters(filters) ? "Clear a filter or try a different search." : "Try a different search or filter.";
}

function renderDiscoveryFilterControls(songs, filters) {
  const options = getDiscoveryFilterOptions(songs);
  const activeQuickFilter = filters.availability === "playable"
    ? "playable"
    : filters.language !== "any" && filters.genre === "any" && filters.mood === "any" && filters.difficulty === "any" && filters.vocalRange === "any" && filters.performanceType === "any" && filters.era === "any" ? filters.language
      : filters.difficulty !== "any" && filters.language === "any" && filters.genre === "any" && filters.mood === "any" && filters.vocalRange === "any" && filters.performanceType === "any" && filters.era === "any" ? filters.difficulty
        : filters.performanceType !== "any" && filters.language === "any" && filters.genre === "any" && filters.mood === "any" && filters.difficulty === "any" && filters.vocalRange === "any" && filters.era === "any" ? filters.performanceType
          : "all";
  document.querySelectorAll(".discover-view [data-filter]").forEach((button) => {
    const active = button.dataset.filter === activeQuickFilter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  document.querySelectorAll("[data-discovery-filter]").forEach((select) => {
    const key = select.dataset.discoveryFilter;
    const currentValue = filters[key] || "any";
    const labels = { language: "Any language", genre: "Any genre", mood: "Any mood", difficulty: "Any difficulty", vocalRange: "Any range", performanceType: "Any format", era: "Any era" };
    select.innerHTML = `<option value="any">${labels[key] || "Any"}</option>${(options[key] || []).map((value) => `<option value="${escapeHtml(normalizeQuery(value))}">${escapeHtml(formatDiscoveryValue(value, key))}</option>`).join("")}`;
    select.value = currentValue;
  });

  const activeLabels = [];
  if (filters.availability === "playable") activeLabels.push("Playable now");
  for (const [key, label] of [["language", "language"], ["genre", "genre"], ["mood", "mood"], ["difficulty", "difficulty"], ["vocalRange", "vocalRange"], ["performanceType", "performanceType"], ["era", "era"]]) {
    if (filters[key] === "any") continue;
    const match = (options[key] || []).find((value) => normalizeQuery(value) === filters[key]);
    activeLabels.push(match ? formatDiscoveryValue(match, label) : filters[key]);
  }
  if (filters.favorites) activeLabels.push("Favorites");
  const summary = document.querySelector("[data-discovery-filter-summary]");
  if (summary) summary.textContent = activeLabels.length ? activeLabels.join(" · ") : "All catalog songs";
  const count = document.querySelector("[data-discovery-filter-count]");
  if (count) {
    count.hidden = activeLabels.length === 0;
    count.textContent = String(activeLabels.length);
  }
  const reset = document.querySelector('[data-action="reset-discovery-filters"]');
  if (reset) {
    reset.disabled = activeLabels.length === 0;
    reset.setAttribute("aria-label", activeLabels.length ? "Reset active filters" : "Reset filters");
    reset.title = activeLabels.length ? "Reset active filters" : "No filters to reset";
  }
}

function formatDiscoveryValue(value, key) {
  if (key === "era") return value;
  return titleCase(value);
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

export function isPartyPanelVisible(currentView, enabled) {
  return currentView === "party" && Boolean(enabled);
}

export function renderSongRequests(userState = {}) {
  const list = document.querySelector("[data-song-request-list]");
  if (!list) return;
  const requests = Array.isArray(userState.songRequests) ? userState.songRequests : [];
  list.innerHTML = requests.length
    ? requests.slice(0, 3).map((request) => `<li><strong>${escapeHtml(request.title)}</strong><span>${escapeHtml(request.artist)}</span></li>`).join("")
    : `<li class="request-empty">No requests yet. Your ideas stay on this device.</li>`;
}

export function renderPartyPanel(songs, partySession, queueSnapshot, rouletteResult = null, rouletteConstraints = {}, statusMessage = "Party details stay on this device.", currentView = "party", rouletteRecovery = {}) {
  const panel = document.querySelector("[data-party-panel]");
  if (!panel) return;
  const enabled = Boolean(partySession?.enabled);
  panel.hidden = !isPartyPanelVisible(currentView, enabled);
  document.querySelectorAll('[data-action="toggle-party-mode"], [data-view="party"]').forEach((button) => {
    button.setAttribute("aria-pressed", String(enabled));
    if (button.classList.contains("party-toggle")) button.textContent = enabled ? "♫ Party Mode on" : "♫ Party Mode";
  });
  if (!enabled || currentView !== "party") return;

  const singers = document.querySelector("[data-party-singers]");
  if (singers) singers.innerHTML = partySession.singers.length ? partySession.singers.map((singer) => `<li class="party-singer"><input data-party-rename="${escapeHtml(singer.id)}" aria-label="Rename ${escapeHtml(singer.name)}" value="${escapeHtml(singer.name)}" maxlength="40" /><button class="remove-button" type="button" data-action="remove-party-singer" data-singer-id="${escapeHtml(singer.id)}" aria-label="Remove ${escapeHtml(singer.name)}">×</button></li>`).join("") : `<li class="party-empty">Add at least two singers for a full rotation.</li>`;

  const items = queueSnapshot?.partyItems || [];
  const current = queueSnapshot?.currentIndex >= 0 ? items[queueSnapshot.currentIndex] : null;
  const now = document.querySelector("[data-party-now]");
  if (now) now.innerHTML = current ? `<p class="party-label">NOW SINGING</p><strong>${escapeHtml(current.singer?.name || "Next singer")}</strong><span>${escapeHtml(current.song.title)}</span><small>${escapeHtml(current.song.artist)}</small>` : `<p class="party-ready"><strong>${items.length ? "UP NEXT" : "PARTY READY"}</strong><span>${items.length ? "Choose a queued song to start." : "Add songs to begin the rotation."}</span></p>`;
  const next = document.querySelector("[data-party-up-next]");
  if (next) {
    const start = queueSnapshot?.currentIndex >= 0 ? queueSnapshot.currentIndex + 1 : 0;
    const upcoming = items.slice(start, start + 3);
    next.innerHTML = `<li class="party-next-heading"><span>UP NEXT</span></li>${upcoming.length ? upcoming.map((item) => `<li><span>${escapeHtml(item.singer?.name || "Next singer")}</span><strong>${escapeHtml(item.song.title)}</strong><small>${escapeHtml(item.song.artist)}</small></li>`).join("") : `<li class="party-empty">Nothing up next yet.</li>`}`;
  }

  const rouletteFilters = document.querySelector("[data-roulette-filters]");
  if (rouletteFilters) rouletteFilters.innerHTML = renderRouletteFilters(songs, rouletteConstraints);
  const result = document.querySelector("[data-roulette-result]");
  const empty = document.querySelector("[data-roulette-empty]");
  if (result) {
    result.hidden = !rouletteResult?.song;
    if (rouletteResult?.song) result.innerHTML = `<p class="party-label">🎲 PROPOSED SONG</p><h4>${escapeHtml(rouletteResult.song.title)}</h4><p>${escapeHtml(rouletteResult.song.artist)}</p><p class="roulette-meta">${escapeHtml(formatSongMeta(rouletteResult.song).join(" · "))}</p><label for="roulette-singer">Suggested singer</label><select id="roulette-singer" data-roulette-singer>${renderSingerOptions(partySession, rouletteResult.singerId)}</select><div class="roulette-actions"><button class="add-button" type="button" data-action="roulette-add">Add to party</button><button class="text-button" type="button" data-action="roulette-view">View song</button><button class="text-button" type="button" data-action="roll-roulette">Roll again</button></div>`;
  }
  if (empty) {
    empty.hidden = Boolean(rouletteResult?.song);
    empty.innerHTML = `${escapeHtml(rouletteRecovery.message || "Add singers or roll for a surprise song.")} ${rouletteRecovery.available ? '<span class="roulette-recovery-actions"><button class="text-button" type="button" data-action="relax-roulette">Relax filters</button><button class="text-button" type="button" data-action="clear-roulette-filters">Clear filters</button></span>' : ""}`;
  }

  const stats = document.querySelector("[data-party-stats]");
  if (stats) {
    const summary = getPartyStats(partySession, songs);
    const singerCounts = summary.songsBySinger.map((item) => `${escapeHtml(item.singer.name)} (${item.count})`).join(" · ");
    stats.innerHTML = `<div class="party-stat-grid"><span><strong>${summary.songsCompleted}</strong>songs completed</span><span><strong>${summary.mostActiveSinger ? escapeHtml(summary.mostActiveSinger.name) : "—"}</strong>most active</span></div><p class="party-stat-note">${singerCounts ? `By singer: ${singerCounts}` : "Stats appear after a party song is marked Sang it."}</p>`;
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
    ? `<button class="add-button" type="button" data-action="add-queue" data-song-id="${escapeHtml(song.id)}" aria-label="Add ${escapeHtml(song.title)} to queue" title="Add to queue">+ Queue</button>`
    : `<button class="add-button" type="button" disabled aria-label="${escapeHtml(song.title)} is unavailable for karaoke">Unavailable</button>`;
  return `<article class="song-card">
    ${thumbnail}
    <div class="song-card-body"><div class="song-card-top"><div><h4>${escapeHtml(song.title)}</h4><p class="song-artist">${escapeHtml(song.artist)}</p></div><span aria-label="${escapeHtml(song.difficulty)} difficulty" class="difficulty-dot difficulty-${song.difficulty}"></span></div>
    <div class="song-meta">${meta}</div>${availability}${options.reason ? `<p class="song-reason">${escapeHtml(options.reason)}</p>` : ""}
    <div class="song-card-actions">${queueAction}<button class="card-favorite${isFavorite ? " is-active" : ""}" type="button" data-action="toggle-favorite" data-song-id="${escapeHtml(song.id)}" aria-pressed="${isFavorite}" aria-label="${isFavorite ? "Remove" : "Add"} ${escapeHtml(song.title)} ${isFavorite ? "from" : "to"} favorites" title="${isFavorite ? "Remove from favorites" : "Add to favorites"}"><span aria-hidden="true">${isFavorite ? "♥" : "♡"}</span><span class="sr-only">${isFavorite ? "Favorited" : "Favorite"}</span></button><details class="song-more-menu"><summary class="song-more-toggle" aria-label="More actions for ${escapeHtml(song.title)}" title="More actions"><span aria-hidden="true">•••</span></summary><div class="song-more-actions" aria-label="More song actions"><button class="feedback-button${isLiked ? " is-active" : ""}" type="button" data-action="toggle-like" data-song-id="${escapeHtml(song.id)}" aria-pressed="${isLiked}" aria-label="${isLiked ? "Unlike" : "Like"} ${escapeHtml(song.title)}">${isLiked ? "✓ Liked" : "Like"}</button><button class="feedback-button${isDisliked ? " is-active" : ""}" type="button" data-action="toggle-dislike" data-song-id="${escapeHtml(song.id)}" aria-pressed="${isDisliked}" aria-label="${isDisliked ? "Remove" : "Mark"} ${escapeHtml(song.title)} ${isDisliked ? "from" : "as"} not for me">${isDisliked ? "✓ Not for me" : "Not for me"}</button><button class="feedback-button" type="button" data-action="mark-sung" data-song-id="${escapeHtml(song.id)}" aria-label="Mark ${escapeHtml(song.title)} as sung">Sang it</button></div></details></div></div>
  </article>`;
}

export function renderSongThumbnail(song, options = {}) {
  const songId = escapeHtml(song.id);
  const title = escapeHtml(song.title);
  const artist = escapeHtml(song.artist);
  const videoId = typeof song.youtubeVideoId === "string" ? song.youtubeVideoId.trim() : "";
  const thumbnailUrl = isValidYouTubeVideoId(videoId) ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : "";
  const image = thumbnailUrl ? `<img class="song-thumbnail-image" data-song-thumbnail src="${thumbnailUrl}" alt="" loading="lazy" decoding="async" referrerpolicy="strict-origin-when-cross-origin" />` : "";
  if (options.catalogView && !thumbnailUrl) return `<div class="song-thumbnail song-thumbnail-unavailable" role="img" aria-label="Karaoke unavailable: ${title} by ${artist}"><span class="song-thumbnail-fallback"><span class="thumbnail-note-icon" aria-hidden="true">♫</span><span>Karaoke unavailable</span></span></div>`;
  return `<button class="song-thumbnail" type="button" data-action="play" data-song-id="${songId}" aria-label="Play karaoke: ${title} by ${artist}">${image}<span class="song-thumbnail-fallback" data-thumbnail-fallback${thumbnailUrl ? " hidden" : ""}><span class="thumbnail-note-icon" aria-hidden="true">♫</span><span>Video coming soon</span></span><span class="song-thumbnail-play" aria-hidden="true">▶</span></button>`;
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
      <div class="queue-item-controls">${snapshot?.partyModeEnabled ? `<label class="queue-singer-control"><span class="sr-only">Singer for ${escapeHtml(song.title)}</span><select data-action="assign-singer" data-song-id="${escapeHtml(song.id)}" aria-label="Singer for ${escapeHtml(song.title)}">${renderSingerOptions(partySession, partyItems[index]?.singer?.id || "")}</select></label>` : ""}<button class="queue-select" type="button" data-action="select-queue" data-song-id="${escapeHtml(song.id)}" aria-pressed="${isCurrent}" aria-label="${isCurrent ? "Current song" : "Select"} ${escapeHtml(song.title)}" title="${isCurrent ? "Current song" : "Play this queued song"}">${isCurrent ? "Current" : "Select"}</button><button class="queue-control" type="button" data-action="move-up" data-song-id="${escapeHtml(song.id)}" aria-label="Move ${escapeHtml(song.title)} up" title="Move up"${index === 0 ? " disabled" : ""}>↑</button><button class="queue-control" type="button" data-action="move-down" data-song-id="${escapeHtml(song.id)}" aria-label="Move ${escapeHtml(song.title)} down" title="Move down"${index === queue.length - 1 ? " disabled" : ""}>↓</button><button class="queue-control queue-top-control" type="button" data-action="move-top" data-song-id="${escapeHtml(song.id)}" aria-label="Move ${escapeHtml(song.title)} to top" title="Move to top"${index === 0 ? " disabled" : ""}>Top</button><button class="remove-button" type="button" data-action="remove-queue" data-song-id="${escapeHtml(song.id)}" aria-label="Remove ${escapeHtml(song.title)} from queue" title="Remove from queue">×</button></div>
    </div>`;
  }).join("") : `<div class="queue-empty"><strong>Your karaoke queue is empty.</strong><br />Add a few songs from discovery to get started.<br /><a href="#top" class="queue-empty-link" data-action="close-queue">Browse songs</a></div>`;
}

export function showPlayer(song, metadata = {}) {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.hidden = false;
  setPlayerExpanded(panel, panel.classList.contains("is-expanded"));
  panel.querySelector("[data-player-title]").textContent = song.title;
  panel.querySelector("[data-player-artist]").textContent = song.artist;
  panel.querySelector("[data-player-position]").textContent = metadata.position && metadata.total ? `Song ${metadata.position} of ${metadata.total}` : "Current karaoke song";
  panel.querySelector("[data-player-meta]").textContent = formatSongMeta(song).join(" · ");
  panel.querySelector("[data-player-status]").textContent = "Ready when you are.";
  panel.querySelector("[data-player-note]").textContent = "Playback is provided by YouTube when a verified video is available.";
  updateMiniPlayer(song);
  updatePlayerActions(song, { favorites: metadata.isFavorite ? [song.id] : [], sungHistory: metadata.isSung ? [{ id: song.id }] : [] });
  updatePlayerNext(metadata.nextSong, metadata.nextType);
  setPlayerCompletion(false);
  setPlayerFeedback(false);
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

export function showPlayerError({ code = null, development = false } = {}) {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  const status = panel.querySelector("[data-player-status]");
  const note = panel.querySelector("[data-player-note]");
  const numericCode = Number(code);
  const messages = {
    100: ["This karaoke video is no longer available.", "Try another queued song or choose a different karaoke pick."],
    101: ["This video cannot play inside KantaCue.", "YouTube has disabled embedding for this video. Try another karaoke pick."],
    150: ["This video cannot play inside KantaCue.", "YouTube has disabled embedding for this video. Try another karaoke pick."],
    153: ["YouTube could not identify this playback request.", development ? "Development detail: Error 153. Serve KantaCue from HTTP/HTTPS with its normal referrer policy, then retry." : "Refresh the page or try another karaoke pick."]
  };
  const [message, detail] = messages[numericCode] || ["This karaoke video could not be played.", "You can try the next song, choose another queued song, or close the player."];
  if (status) status.textContent = message;
  if (note) note.textContent = detail;
  updateMiniPlayerStatus(numericCode === 100 ? "Video unavailable" : "Couldn’t play video");
  setPlayerEmbedVisible(panel, false);
}

export function showQueueFinished(total) {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.hidden = false;
  panel.querySelector("[data-player-title]").textContent = "Queue finished";
  panel.querySelector("[data-player-artist]").textContent = "That's the end of your queue.";
  panel.querySelector("[data-player-position]").textContent = `${total} song${total === 1 ? "" : "s"} completed`;
  panel.querySelector("[data-player-meta]").textContent = "";
  panel.querySelector("[data-player-status]").textContent = "Choose another song from the queue or return to discovery.";
  panel.querySelector("[data-player-note]").textContent = "Playback is provided by YouTube when a verified video is available.";
  panel.classList.add("is-expanded");
  setPlayerExpanded(panel, true);
  document.querySelector("[data-mini-player]")?.setAttribute("hidden", "");
  setPlayerEmbedVisible(panel, false);
  panel.querySelector('[data-action="player-prev"]').disabled = total === 0;
  panel.querySelector('[data-action="player-next"]').disabled = true;
  setPlayerCompletion(true, "Queue finished", "Choose another song from discovery or add a new song to your queue.");
  setPlayerFeedback(false);
  updatePlayerNext(null);
}

export function showPlayerFinished({ nextSong = null, nextType = "recommended" } = {}) {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.querySelector("[data-player-status]").textContent = "Song complete. Your next choice is ready.";
  panel.querySelector("[data-player-note]").textContent = "KantaCue waits for your explicit choice before starting another video.";
  updateMiniPlayerStatus("Song complete");
  updatePlayerNext(nextSong, nextType);
  setPlayerCompletion(true, "Nice one", nextSong ? "Mark it as sung, then keep the queue moving." : "Mark it as sung or choose another song from discovery.");
  setPlayerFeedback(true);
  setPlayerEmbedVisible(panel, true);
}

export function showPlayerSangIt() {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel) return;
  panel.querySelector("[data-player-status]").textContent = "Sang it ✓ Saved to your history.";
  panel.querySelector("[data-player-note]").textContent = "Your queue, favorites, and preferences are still intact.";
  updateMiniPlayerStatus("Sang it ✓");
  setPlayerCompletion(true, "Sang it ✓", "Your performance is saved. What’s next?");
  setPlayerFeedback(true);
  document.querySelector("[data-player-completion]")?.classList.add("is-celebration");
}

export function updatePlayerActions(song, userState = {}) {
  const panel = document.querySelector("[data-player-panel]");
  if (!panel || !song) return;
  const songId = song.id.toLowerCase();
  const isFavorite = (userState.favorites || []).some((id) => id.toLowerCase() === songId);
  const isSung = (userState.sungHistory || []).some((entry) => entry.id?.toLowerCase() === songId);
  const favorite = panel.querySelectorAll("[data-player-favorite], [data-player-completion-favorite]");
  const share = panel.querySelectorAll("[data-player-share]");
  const sang = panel.querySelector("[data-player-sang]");
  favorite.forEach((button) => {
    button.dataset.songId = song.id;
    button.setAttribute("aria-pressed", String(isFavorite));
    button.textContent = isFavorite ? "♥ Favorite" : "♡ Favorite";
    button.setAttribute("aria-label", isFavorite ? `Remove ${song.title} from favorites` : `Add ${song.title} to favorites`);
  });
  if (sang) {
    sang.dataset.songId = song.id;
    sang.textContent = isSung ? "Sang it ✓" : "Sang it";
    sang.setAttribute("aria-label", isSung ? `${song.title} is already in sung history` : `Mark ${song.title} as sung`);
  }
  share.forEach((button) => {
    button.dataset.songId = song.id;
    button.setAttribute("aria-label", `Share ${song.title} by ${song.artist} on KantaCue`);
  });
}

export function setPlayerFeedback(visible) {
  const feedback = document.querySelector("[data-player-feedback]");
  if (!feedback) return;
  feedback.hidden = !visible;
  if (!visible) togglePlayerFeedbackReasons(false);
}

export function togglePlayerFeedbackReasons(visible) {
  const panel = document.querySelector("[data-feedback-reasons]");
  const button = document.querySelector('[data-action="feedback-problem"]');
  if (panel) panel.hidden = !visible;
  if (button) {
    button.setAttribute("aria-expanded", String(Boolean(visible)));
    button.textContent = visible ? "Hide problem types" : "👎 Problem with video";
  }
}

export function setPlayerFeedbackStatus(message) {
  const status = document.querySelector("[data-feedback-status]");
  if (status) status.textContent = message;
  togglePlayerFeedbackReasons(false);
}

export function hidePlayer() {
  const panel = document.querySelector("[data-player-panel]");
  if (panel) {
    panel.hidden = true;
    panel.classList.remove("is-expanded");
    setPlayerExpanded(panel, false);
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

export function setPlayerExpanded(panel, expanded) {
  if (!panel) return;
  panel.classList.toggle("is-expanded", Boolean(expanded));
  if (expanded) {
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "player-title");
    panel.removeAttribute("aria-label");
  } else {
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Now singing");
    panel.removeAttribute("aria-modal");
    panel.removeAttribute("aria-labelledby");
  }
  const toggle = panel.querySelector?.('[data-action="expand-player"]');
  if (toggle) {
    const isExpanded = Boolean(expanded);
    toggle.setAttribute("aria-expanded", String(isExpanded));
    toggle.setAttribute("aria-label", isExpanded ? "Collapse player" : "Expand player");
    toggle.setAttribute("title", isExpanded ? "Collapse player" : "Expand player");
    toggle.textContent = isExpanded ? "↙" : "↗";
  }
}

function updatePlayerNext(song, type = "recommended") {
  const target = document.querySelector("[data-player-up-next]");
  if (!target) return;
  if (!song) {
    target.hidden = true;
    return;
  }
  target.hidden = false;
  target.querySelector("[data-player-next-label]").textContent = type === "queued" ? "Queued next" : "Recommended next";
  target.querySelector("[data-player-next-title]").textContent = song.title;
  target.querySelector("[data-player-next-artist]").textContent = song.artist;
  target.querySelector("[data-player-next-note]").textContent = `${formatSongMeta(song).join(" · ")} · ${type === "queued" ? "Already in your queue" : "Not added until you choose Sing next"}`;
  target.querySelector('[data-action="player-next"]').setAttribute("aria-label", `Sing next: ${song.title} by ${song.artist}`);
}

function setPlayerCompletion(visible, title = "Song complete", copy = "") {
  const completion = document.querySelector("[data-player-completion]");
  if (!completion) return;
  completion.hidden = !visible;
  if (!visible) completion.classList.remove("is-celebration");
  const heading = completion.querySelector("[data-player-completion-title]");
  const message = completion.querySelector("[data-player-completion-copy]");
  if (heading) heading.textContent = title;
  if (message) message.textContent = copy;
}

export function setPlayerEmbedVisible(panel, visible) {
  const shell = panel.querySelector("[data-youtube-shell]");
  const mount = shell?.querySelector("[data-youtube-mount]");
  const iframe = shell?.querySelector("iframe");
  const placeholder = panel.querySelector("[data-player-placeholder]");
  if (shell) shell.hidden = false;
  if (mount) mount.hidden = Boolean(visible);
  if (iframe) iframe.hidden = !visible;
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
