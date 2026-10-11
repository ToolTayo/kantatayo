import {
  EVIDENCE_REPORT_FILES,
  QUALITY_CHECKS,
  REVIEW_STORAGE_KEY,
  RUNTIME_REPORT_FILES,
  buildReviewCandidates,
  createBlankReview,
  createReviewExport,
  hasReviewProgress,
  hasValidReviewHost,
  isApprovalReady,
  loadReviewState,
  mergeImportedReviews,
  serializeReviewState,
  setReviewDecision,
  updateCollectionMetadata,
  updateReviewRating,
  validateReviewExport
} from "./medley-review-core.mjs";

const $ = (selector) => document.querySelector(selector);
const workspace = $("#workspace");
const denied = $("#access-denied");
const status = $("#workspace-status");
const candidateList = $("#candidate-list");
const detail = $("#candidate-detail");
const searchInput = $("#candidate-search");
const filterSelect = $("#candidate-filter");
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

let candidates = [];
let state = { schemaVersion: 1, entries: {} };
let currentCandidateId = null;
let pendingImport = null;
let pendingReset = null;
let lastReset = null;

function announce(message, isError = false) {
  status.hidden = !message;
  status.classList.toggle("is-error", isError);
  status.textContent = message;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function append(parent, tag, className, text) {
  const element = node(tag, className, text);
  parent.append(element);
  return element;
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Could not load local review source (${response.status}).`);
  return response.json();
}

function currentRecord(candidate) {
  return state.entries[candidate.videoId] || createBlankReview(candidate);
}

function refreshDecisionUi(candidate) {
  const record = currentRecord(candidate);
  const label = $("#current-decision-label");
  const hint = $("#approval-hint");
  const approve = $("#approve-candidate");
  if (label) label.textContent = `Decision: ${reviewStatus(record)}`;
  if (hint) hint.textContent = isApprovalReady(record)
    ? "All checks and promotion metadata are complete; approval still requires your action."
    : "Approve unlocks only after all six checks pass and language/theme are supplied.";
  if (approve) approve.disabled = !isApprovalReady(record);
}

function reviewStatus(record) {
  if (!hasReviewProgress(record)) return "Not reviewed";
  if (record.decision === "approved") return "Approved";
  if (record.decision === "rejected") return "Rejected";
  if (record.decision === "needs-another-review") return "Needs another review";
  return "In progress";
}

function statusClass(record) {
  if (record.decision === "approved") return "status-approved";
  if (record.decision === "rejected") return "status-rejected";
  if (record.decision === "needs-another-review") return "status-review";
  return "";
}

function saveState() {
  try {
    localStorage.setItem(REVIEW_STORAGE_KEY, serializeReviewState(state));
    return true;
  } catch {
    announce("Browser storage is unavailable. This review remains only in this tab until exported.", true);
    return false;
  }
}

function updateCounts() {
  const records = Object.values(state.entries);
  const reviewed = records.filter(hasReviewProgress).length;
  const approved = records.filter((record) => record.decision === "approved").length;
  $("#progress-count").textContent = `${reviewed} / ${candidates.length}`;
  $("#approved-count").textContent = String(approved);
}

function candidateMatches(candidate, query) {
  if (!query) return true;
  const value = `${candidate.title} ${candidate.artist} ${candidate.provider} ${candidate.videoId} ${candidate.sections.map((section) => section.title).join(" ")}`.toLowerCase();
  return value.includes(query);
}

function matchesFilter(record, filter) {
  if (filter === "all") return true;
  if (filter === "unreviewed") return !hasReviewProgress(record);
  if (filter === "in-progress") return hasReviewProgress(record) && !record.decision;
  return record.decision === filter;
}

function renderCandidateList() {
  const restoreListFocus = candidateList.contains(document.activeElement);
  const query = searchInput.value.trim().toLowerCase();
  const filter = filterSelect.value;
  const shown = candidates.filter((candidate) => {
    const record = currentRecord(candidate);
    return candidateMatches(candidate, query) && matchesFilter(record, filter);
  });
  candidateList.replaceChildren();
  $("#visible-count").textContent = String(shown.length);
  $("#no-results").hidden = shown.length > 0;
  for (const candidate of shown) {
    const item = document.createElement("li");
    const button = node("button", "candidate-choice");
    button.type = "button";
    button.dataset.videoId = candidate.videoId;
    button.setAttribute("aria-current", String(candidate.videoId === currentCandidateId));
    button.setAttribute("aria-label", `${candidate.title}, ${candidate.artist}, runtime PASS, ${reviewStatus(currentRecord(candidate))}`);
    button.addEventListener("click", () => selectCandidate(candidate.videoId));
    append(button, "span", "candidate-order", String(candidates.indexOf(candidate) + 1).padStart(2, "0"));
    const copy = append(button, "span", "candidate-choice-copy");
    append(copy, "strong", "", candidate.title);
    append(copy, "span", "", `${candidate.artist} · ${candidate.provider}`);
    append(copy, "span", "list-state", reviewStatus(currentRecord(candidate)));
    item.append(button);
    candidateList.append(item);
  }
  updateCounts();
  if (restoreListFocus) candidateList.querySelector('.candidate-choice[aria-current="true"]')?.focus({ preventScroll: true });
}

function addMetadataItem(container, label, value) {
  const item = append(container, "span", "metadata-item");
  append(item, "strong", "", label);
  item.append(document.createTextNode(value));
}

function appendQualityForm(container, candidate, record) {
  const form = append(container, "section", "review-form");
  form.setAttribute("aria-labelledby", "quality-title");
  append(form, "h3", "", "Your quality review").id = "quality-title";
  append(form, "p", "form-description", "Assess what you can actually hear and see. Runtime PASS is technical evidence only; it never fills these ratings.");
  const grid = append(form, "div", "quality-grid");
  for (const check of QUALITY_CHECKS) {
    const field = append(grid, "div", "quality-field");
    const label = append(field, "label", "", check.label);
    const select = document.createElement("select");
    select.id = `quality-${check.id}`;
    select.setAttribute("aria-label", check.label);
    for (const [value, text] of [["not-reviewed", "Not reviewed"], ["pass", "Pass"], ["fail", "Fail"]]) {
      const option = node("option", "", text);
      option.value = value;
      option.selected = record.ratings[check.id] === value;
      select.append(option);
    }
    label.htmlFor = select.id;
    select.addEventListener("change", () => {
      const result = updateReviewRating(state, candidate, check.id, select.value);
      if (!result.ok) return announce(result.error, true);
      const wasApproved = state.entries[candidate.videoId]?.decision === "approved";
      state = result.state;
      saveState();
      renderCandidateList();
      refreshDecisionUi(candidate);
      if (wasApproved) announce("A changed quality rating moved the prior approval back to Needs another review.");
    });
    field.append(select);
  }

  const metadata = append(form, "div", "collection-metadata");
  const languageLabel = append(metadata, "label", "meta-field", "Language · required for approval");
  const languageInput = document.createElement("input");
  languageInput.type = "text";
  languageInput.maxLength = 80;
  languageInput.autocomplete = "off";
  languageInput.placeholder = "e.g. English, Filipino, Mixed";
  languageInput.value = record.language;
  languageInput.setAttribute("aria-label", "Collection language, required for approval");
  languageLabel.append(languageInput);
  const themeLabel = append(metadata, "label", "meta-field", "Collection theme · required for approval");
  const themeInput = document.createElement("input");
  themeInput.type = "text";
  themeInput.maxLength = 100;
  themeInput.autocomplete = "off";
  themeInput.placeholder = "e.g. OPM classics, artist medley";
  themeInput.value = record.theme;
  themeInput.setAttribute("aria-label", "Collection theme, required for approval");
  themeLabel.append(themeInput);
  const metadataChange = (field, input) => {
    const result = updateCollectionMetadata(state, candidate, field, input.value);
    if (!result.ok) return announce(result.error, true);
    const wasApproved = state.entries[candidate.videoId]?.decision === "approved";
    state = result.state;
    saveState();
    renderCandidateList();
    refreshDecisionUi(candidate);
    if (wasApproved) announce("Changing collection metadata moved the prior approval back to Needs another review.");
  };
  languageInput.addEventListener("input", () => metadataChange("language", languageInput));
  themeInput.addEventListener("input", () => metadataChange("theme", themeInput));
  append(form, "p", "form-description", "These fields are manual collection metadata, not inferred popularity or audio claims.");
}

function showQualityDecision(candidate, decision) {
  const result = setReviewDecision(state, candidate, decision);
  if (!result.ok) return announce(result.error, true);
  state = result.state;
  saveState();
  renderCandidateList();
  refreshDecisionUi(candidate);
  const label = decision === "approved" ? "Approved for promotion review" : decision === "rejected" ? "Rejected" : "Marked for another review";
  announce(`${candidate.title}: ${label}. No production data was changed.`);
}

function renderDetail(candidate) {
  if (!candidate) return;
  const record = currentRecord(candidate);
  detail.replaceChildren();
  const heading = append(detail, "header", "candidate-heading");
  const text = append(heading, "div");
  append(text, "p", "eyebrow", `Review ${String(candidates.indexOf(candidate) + 1).padStart(2, "0")} of ${candidates.length}`);
  const titleHeading = append(text, "h2", "", candidate.title);
  titleHeading.id = "candidate-title";
  titleHeading.tabIndex = -1;
  append(text, "p", "candidate-subtitle", candidate.artist);
  append(text, "p", "candidate-provider", candidate.provider);
  const badge = append(heading, "span", "status-pill status-runtime", "Runtime PASS · technical only");
  badge.setAttribute("aria-label", "Sustained YouTube iframe playback verified; quality is not approved");

  const strip = append(detail, "div", "metadata-strip");
  addMetadataItem(strip, "VIDEO", candidate.videoId);
  addMetadataItem(strip, "VIEWS", Number.isInteger(candidate.views) ? candidate.views.toLocaleString("en-US") : "Not captured");
  addMetadataItem(strip, "PUBLISHED", candidate.publishedAt || "Unknown");
  addMetadataItem(strip, "RANK EVIDENCE", candidate.rankEvidence || "No rank label");
  append(detail, "p", "runtime-note", candidate.runtimeEvidence || "Sustained playback was recorded in the preserved runtime report. This does not certify quality.");

  const playerArea = append(detail, "section", "player-area");
  playerArea.setAttribute("aria-label", "Official YouTube medley player");
  const placeholder = append(playerArea, "div", "player-placeholder");
  append(placeholder, "p", "", "The official player loads only when you choose Load player. Start playback with YouTube’s own controls; this workspace never autoplays.");
  const actions = append(playerArea, "div", "player-actions");
  const loadButton = append(actions, "button", "button button-primary", "Load official player");
  loadButton.type = "button";
  loadButton.setAttribute("aria-label", `Load official YouTube player for ${candidate.title}`);
  append(actions, "p", "player-hint", "One video at a time · YouTube controls, ads, and branding remain unobstructed.");
  loadButton.addEventListener("click", () => {
    if (!videoIdPattern.test(candidate.videoId)) return announce("This candidate video ID is invalid.", true);
    const iframe = document.createElement("iframe");
    iframe.className = "player-frame";
    iframe.title = `YouTube karaoke medley: ${candidate.title} — ${candidate.artist}`;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;
    iframe.loading = "eager";
    const embed = new URL(`https://www.youtube-nocookie.com/embed/${candidate.videoId}`);
    embed.searchParams.set("controls", "1");
    embed.searchParams.set("autoplay", "0");
    embed.searchParams.set("playsinline", "1");
    iframe.src = embed.href;
    playerArea.replaceChildren(iframe);
    iframe.focus({ preventScroll: true });
    announce("Official player loaded. Playback begins only when you press Play in YouTube.");
  });

  const sectionBox = append(detail, "section", "section-details");
  append(sectionBox, "h3", "", "Known track sections");
  if (candidate.sections.length >= 2) {
    const list = append(sectionBox, "ol", "section-list");
    for (const section of candidate.sections) append(list, "li", "", section.artist ? `${section.title} — ${section.artist}` : section.title);
    if (candidate.sectionSources.length) append(sectionBox, "p", "section-source", `Captured from: ${candidate.sectionSources.join(", ")}`);
  } else {
    append(sectionBox, "p", "section-unknown", "Multiple-song medley · song list not listed");
  }

  if (candidate.duplicateWarnings.length) {
    const warnings = append(detail, "section", "duplicate-details");
    warnings.setAttribute("aria-labelledby", "duplicate-heading");
    append(warnings, "h3", "", "Compare before approving").id = "duplicate-heading";
    const list = append(warnings, "ul");
    for (const warning of candidate.duplicateWarnings) append(list, "li", "", warning);
  }

  const evidence = append(detail, "details", "evidence-copy");
  append(evidence, "summary", "", "Public candidate evidence and review caveats");
  append(evidence, "p", "", candidate.publicEvidence || "No additional public evidence summary was captured.");
  append(evidence, "p", "", `Technical result: ${candidate.runtimeReport || "runtime report unavailable"}. Audio, guide vocal, key, synchronization, transitions, and visual quality require your own review.`);

  appendQualityForm(detail, candidate, record);
  const decisionPanel = append(detail, "section", "decision-panel");
  decisionPanel.setAttribute("aria-label", "Final quality decision");
  const decisionCopy = append(decisionPanel, "div", "decision-copy");
  append(decisionCopy, "strong", "", `Decision: ${reviewStatus(record)}`).id = "current-decision-label";
  append(decisionCopy, "span", "", isApprovalReady(record) ? "All checks and promotion metadata are complete; approval still requires your action." : "Approve unlocks only after all six checks pass and language/theme are supplied.").id = "approval-hint";
  const decisionActions = append(decisionPanel, "div", "decision-actions");
  const approve = append(decisionActions, "button", "button button-primary", "Approve");
  approve.id = "approve-candidate";
  approve.type = "button";
  approve.disabled = !isApprovalReady(record);
  approve.setAttribute("aria-label", `Approve ${candidate.title} for promotion review`);
  approve.addEventListener("click", () => showQualityDecision(candidate, "approved"));
  const reject = append(decisionActions, "button", "button button-secondary", "Reject");
  reject.type = "button";
  reject.addEventListener("click", () => showQualityDecision(candidate, "rejected"));
  const reviewAgain = append(decisionActions, "button", "button button-secondary", "Needs another review");
  reviewAgain.type = "button";
  reviewAgain.addEventListener("click", () => showQualityDecision(candidate, "needs-another-review"));
  const reset = append(detail, "button", "text-button danger-text candidate-reset", "Reset this candidate's review");
  reset.type = "button";
  reset.addEventListener("click", () => requestReset([candidate.videoId], `Reset the local review for “${candidate.title}”? You can undo immediately.`));
}

function selectCandidate(id) {
  const candidate = candidates.find((item) => item.videoId === id);
  if (!candidate) return;
  currentCandidateId = id;
  renderCandidateList();
  renderDetail(candidate);
  $("#candidate-title")?.focus({ preventScroll: true });
}

function requestReset(ids, message) {
  pendingReset = ids;
  $("#confirm-title").textContent = ids.length > 1 ? "Reset all local reviews?" : "Reset this candidate?";
  $("#confirm-copy").textContent = message;
  $("#confirm-action").textContent = ids.length > 1 ? "Reset all" : "Reset review";
  $("#confirm-dialog").showModal();
}

function confirmReset() {
  if (!pendingReset?.length) return;
  const resetCurrentCandidate = pendingReset.length === 1 && pendingReset[0] === currentCandidateId;
  const removed = [];
  for (const id of pendingReset) {
    if (state.entries[id]) removed.push([id, state.entries[id]]);
  }
  for (const [id] of removed) delete state.entries[id];
  lastReset = removed.length ? removed : null;
  saveState();
  $("#undo-reset").hidden = !lastReset;
  renderCandidateList();
  if (currentCandidateId) renderDetail(candidates.find((candidate) => candidate.videoId === currentCandidateId));
  if (resetCurrentCandidate) $("#candidate-title")?.focus({ preventScroll: true });
  announce(removed.length ? `Reset ${removed.length} local review record(s). Use Undo last reset to restore entries that remain untouched.` : "There were no saved review decisions to reset.");
  pendingReset = null;
}

function undoReset() {
  if (!lastReset) return;
  let restored = 0;
  let skipped = 0;
  const entries = { ...state.entries };
  for (const [id, record] of lastReset) {
    if (entries[id]) skipped += 1;
    else { entries[id] = record; restored += 1; }
  }
  state = { ...state, entries };
  lastReset = null;
  $("#undo-reset").hidden = true;
  saveState();
  renderCandidateList();
  if (currentCandidateId) renderDetail(candidates.find((candidate) => candidate.videoId === currentCandidateId));
  announce(`Undo restored ${restored} review record(s)${skipped ? `; ${skipped} were left unchanged because they now contain newer review data` : ""}.`);
}

function exportReviews() {
  const payload = createReviewExport(state, candidates);
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "kantacue-medley-review.json";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  announce(`Exported ${payload.reviews.length} local review record(s). The file contains decisions and ratings, not video or audio.`);
}

async function prepareImport(file) {
  if (!file) return;
  if (file.size > 1024 * 1024) {
    announce("Import rejected: JSON file exceeds the 1 MB safety limit.", true);
    return;
  }
  let payload;
  try { payload = JSON.parse(await file.text()); } catch {
    announce("Import rejected: file is not valid JSON.", true);
    return;
  }
  const validation = validateReviewExport(payload, candidates);
  if (!validation.ok) {
    announce(validation.error, true);
    return;
  }
  const merged = mergeImportedReviews(state, validation.reviews);
  if (!merged.ok) {
    announce(merged.error, true);
    return;
  }
  pendingImport = merged.state;
  $("#import-copy").textContent = `${validation.reviews.length} validated record(s) are ready. Candidate identities match this local report, and none would overwrite an existing local decision. No changes have been made yet.`;
  $("#import-dialog").showModal();
}

function confirmImport() {
  if (!pendingImport) return;
  state = pendingImport;
  pendingImport = null;
  saveState();
  renderCandidateList();
  if (currentCandidateId) renderDetail(candidates.find((candidate) => candidate.videoId === currentCandidateId));
  announce("Validated decisions imported locally. Production data was not changed.");
}

async function initialize() {
  if (!hasValidReviewHost(window.location)) {
    denied.hidden = false;
    return;
  }
  workspace.hidden = false;
  try {
    const [researchReport, medleyData, songData, ...sourceFiles] = await Promise.all([
      fetchJson("./medley-expansion-research-v5.json"),
      fetchJson("../data/medleys.sample.json"),
      fetchJson("../data/songs.sample.json"),
      ...RUNTIME_REPORT_FILES.map((file) => fetchJson(`./${file}`).then((data) => ({ name: file, data }))),
      ...EVIDENCE_REPORT_FILES.map((file) => fetchJson(`./${file}`).then((data) => ({ name: file, data })))
    ]);
    const runtimeReports = sourceFiles.slice(0, RUNTIME_REPORT_FILES.length);
    const evidenceReports = sourceFiles.slice(RUNTIME_REPORT_FILES.length);
    candidates = buildReviewCandidates({
      researchReport,
      runtimeReports,
      evidenceReports,
      existingMedleys: medleyData.medleys || [],
      primarySongs: songData
    });
    let stored = null;
    let storageWarning = "";
    try {
      stored = localStorage.getItem(REVIEW_STORAGE_KEY);
    } catch {
      storageWarning = "Browser storage is unavailable. You can still review in this tab; export JSON before closing to keep the work.";
    }
    const loaded = loadReviewState(stored, candidates);
    state = loaded.state;
    const warnings = [...loaded.warnings, storageWarning].filter(Boolean);
    if (warnings.length) announce(warnings.join(" "), true);
    currentCandidateId = candidates[0]?.videoId || null;
    renderCandidateList();
    if (currentCandidateId) renderDetail(candidates[0]);
  } catch (error) {
    announce(`The local review data could not be loaded: ${error.message}`, true);
  }
}

searchInput.addEventListener("input", renderCandidateList);
filterSelect.addEventListener("change", renderCandidateList);
$("#export-reviews").addEventListener("click", exportReviews);
$("#import-trigger").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (event) => {
  void prepareImport(event.target.files?.[0]);
  event.target.value = "";
});
$("#reset-all").addEventListener("click", () => requestReset(Object.keys(state.entries), `Clear only this workspace’s local review decisions (${Object.keys(state.entries).length} saved record(s)). KantaCue favorites, queue, history, and production data are not touched. You can undo immediately.`));
$("#undo-reset").addEventListener("click", undoReset);
$("#confirm-dialog").addEventListener("close", (event) => {
  if (event.target.returnValue === "confirm") confirmReset();
  else pendingReset = null;
});
$("#import-dialog").addEventListener("close", (event) => {
  if (event.target.returnValue === "import") confirmImport();
  else pendingImport = null;
});

void initialize();
