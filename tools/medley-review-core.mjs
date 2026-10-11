export const REVIEW_FORMAT = "kantacue-medley-review";
export const REVIEW_SCHEMA_VERSION = 1;
export const REVIEW_STORAGE_KEY = "kantacue.medley-review.v1";
export const RUNTIME_REPORT_FILES = Object.freeze([
  "medley-expansion-runtime-v3.json",
  "medley-expansion-runtime-v4.json",
  "medley-expansion-runtime-v5.json",
  "medley-expansion-runtime-v6.json",
  "medley-expansion-runtime-v7.json",
  "medley-expansion-runtime-v8.json",
  "medley-expansion-runtime-v10.json",
  "medley-expansion-runtime-v11.json",
  "medley-expansion-runtime-v13.json"
]);
export const EVIDENCE_REPORT_FILES = Object.freeze([
  "medley-expansion-research-v3.json",
  "medley-expansion-research-v4.json",
  "medley-expansion-research-v5.json"
]);
export const QUALITY_CHECKS = Object.freeze([
  { id: "audio", label: "Instrumental / audio quality" },
  { id: "guideVocals", label: "Guide-vocal acceptability" },
  { id: "lyricSync", label: "Lyric synchronization" },
  { id: "keyArrangement", label: "Key and arrangement" },
  { id: "completenessTransitions", label: "Completeness and transitions" },
  { id: "presentation", label: "Visual presentation" }
]);
export const REVIEW_VALUES = Object.freeze(["not-reviewed", "pass", "fail"]);
export const DECISIONS = Object.freeze(["approved", "rejected", "needs-another-review"]);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PRIORITY_TERMS = [
  ["michael learns to rock", "mltr"],
  ["april boy regino"],
  ["rey valera"],
  ["rivermaya"],
  ["classic opm love songs"],
  ["scorpions"],
  ["celine dion"],
  ["donna cruz"],
  ["bee gees"],
  ["j brothers"]
];
const OPM_ARTISTS = new Set([
  "aegis", "april boy regino", "donna cruz", "eraserheads", "freddie aguilar", "j brothers",
  "men oppose", "parokya ni edgar", "regine velasquez", "rey valera", "rivermaya", "renz verano"
]);

export function normalizeIdentity(value) {
  return String(value ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function cleanText(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function sectionEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") {
      const title = cleanText(entry, 180);
      return title ? { title, artist: "" } : null;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const title = cleanText(entry.title, 180);
    const artist = cleanText(entry.artist, 120);
    return title ? { title, artist } : null;
  }).filter(Boolean);
}

function collectSections(node, videoId, sourceName, result, seen) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((value) => collectSections(value, videoId, sourceName, result, seen));
    return;
  }
  if (node.videoId === videoId) {
    const sources = [];
    const add = (value) => {
      for (const section of sectionEntries(value)) {
        const key = `${normalizeIdentity(section.title)}\u0000${normalizeIdentity(section.artist)}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(section);
        sources.push(sourceName);
      }
    };
    if (Array.isArray(node.sections)) add(node.sections);
    else if (node.sections && typeof node.sections === "object") add(node.sections.items || node.sections.songs);
    add(node.includedSongs);
    if (Array.isArray(node.trackList)) add(node.trackList);
    if (sources.length) result._sources = [...new Set([...(result._sources || []), ...sources])];
  }
  for (const child of Object.values(node)) collectSections(child, videoId, sourceName, result, seen);
}

function evidenceFor(candidateId, sources) {
  const sections = [];
  const seen = new Set();
  for (const source of sources) collectSections(source.data, candidateId, source.name, sections, seen);
  return { sections, sectionSources: sections._sources || [] };
}

function candidatePriority(candidate) {
  const identity = normalizeIdentity(`${candidate.artist} ${candidate.title}`);
  const match = PRIORITY_TERMS.findIndex((terms) => terms.some((term) => identity.includes(normalizeIdentity(term))));
  return match < 0 ? PRIORITY_TERMS.length : match;
}

function isOpm(candidate) {
  const artist = normalizeIdentity(candidate.artist);
  const title = normalizeIdentity(candidate.title);
  return title.includes("opm") || artist.includes("opm") || OPM_ARTISTS.has(artist);
}

function duplicateWarningsFor(candidate, allCandidates, existingMedleys, primarySongs) {
  const warnings = [];
  const sameArtist = allCandidates.filter((other) => other.videoId !== candidate.videoId
    && normalizeIdentity(other.artist) === normalizeIdentity(candidate.artist)
    && candidate.artist !== "Artist/theme not captured");
  for (const other of sameArtist) warnings.push(`Competing candidate by ${candidate.artist}: ${other.title} (${other.videoId}).`);

  const candidateSections = new Set(candidate.sections.map((section) => normalizeIdentity(section.title)));
  const existingMatches = [];
  for (const medley of existingMedleys) {
    const medleyTitleMatch = normalizeIdentity(medley.title) === normalizeIdentity(candidate.title);
    const artistMatch = (Array.isArray(medley.includedSongs) ? medley.includedSongs : [])
      .some((song) => normalizeIdentity(song.artist) === normalizeIdentity(candidate.artist));
    const overlapCount = (Array.isArray(medley.includedSongs) ? medley.includedSongs : [])
      .filter((song) => candidateSections.has(normalizeIdentity(song.title))).length;
    if (medleyTitleMatch || artistMatch || overlapCount > 0) {
      existingMatches.push(`${medley.title} (${medley.id})${overlapCount ? `; ${overlapCount} known section overlap${overlapCount === 1 ? "" : "s"}` : ""}`);
    }
  }
  for (const match of existingMatches) warnings.push(`Compare with existing collection: ${match}.`);

  const candidateOverlaps = allCandidates.filter((other) => other.videoId !== candidate.videoId).map((other) => {
    const otherSections = new Set(other.sections.map((section) => normalizeIdentity(section.title)));
    const overlaps = [...candidateSections].filter((section) => otherSections.has(section)).length;
    return overlaps ? `${other.title} (${other.videoId}); ${overlaps} known section overlap${overlaps === 1 ? "" : "s"}` : "";
  }).filter(Boolean);
  for (const overlap of candidateOverlaps) warnings.push(`Track-list comparison needed: ${overlap}.`);
  for (const song of primarySongs) {
    const sameVideo = song?.youtubeVideoId === candidate.videoId;
    const sameIdentity = normalizeIdentity(song?.title) === normalizeIdentity(candidate.title)
      && normalizeIdentity(song?.artist) === normalizeIdentity(candidate.artist);
    if (sameVideo || sameIdentity) {
      const reason = sameVideo ? "the same YouTube video ID" : "the same normalized title/artist";
      warnings.push(`Primary-catalog collision: ${candidate.videoId} matches ${song.title || "an existing song"} — ${song.artist || "unknown artist"} by ${reason}.`);
    }
  }
  return [...new Set(warnings)];
}

export function buildReviewCandidates({ researchReport, runtimeReports, evidenceReports = [], existingMedleys = [], primarySongs = [] }) {
  const passPool = researchReport?.strongestTechnicalPassPoolByDemandSnapshot;
  if (!Array.isArray(passPool)) throw new Error("Research report is missing its technical-pass pool.");
  const passIds = passPool.map((candidate) => candidate?.videoId);
  if (passIds.some((id) => !VIDEO_ID.test(String(id || ""))) || new Set(passIds).size !== passIds.length) {
    throw new Error("Research pass pool contains an invalid or duplicate video ID.");
  }

  const runtimeById = new Map();
  for (const batch of Array.isArray(runtimeReports) ? runtimeReports : []) {
    for (const entry of Array.isArray(batch?.data?.entries) ? batch.data.entries : []) {
      if (!VIDEO_ID.test(String(entry.videoId || "")) || entry.videoId === "QBb9wO3Bj0k") continue;
      const current = runtimeById.get(entry.videoId);
      if (!current || entry.iframeStatus === "PASS") runtimeById.set(entry.videoId, { ...entry, runtimeReport: batch.name, runtimeTestedAt: batch.data.generatedAt || null });
    }
  }

  const candidates = passPool.map((poolRow) => {
    const runtime = runtimeById.get(poolRow.videoId);
    if (!runtime || runtime.iframeStatus !== "PASS" || !/sustained playback verified/i.test(runtime.note || "")) {
      throw new Error(`Candidate ${poolRow.videoId} is not backed by a sustained raw runtime PASS.`);
    }
    const evidence = evidenceFor(poolRow.videoId, evidenceReports);
    const title = cleanText(runtime.title || poolRow.title, 220);
    const provider = cleanText(runtime.provider || poolRow.provider, 140);
    const artist = cleanText(runtime.artist, 160) || "Artist/theme not captured";
    return {
      videoId: poolRow.videoId,
      title,
      artist,
      provider,
      views: Number.isInteger(poolRow.views) ? poolRow.views : Number.isInteger(runtime.publicViews) ? runtime.publicViews : null,
      publishedAt: cleanText(poolRow.publishedAt || runtime.publishedAt, 24) || null,
      rankEvidence: cleanText(poolRow.rank, 80),
      qualityTier: cleanText(poolRow.quality, 120),
      runtimeStatus: "PASS",
      runtimeReport: runtime.runtimeReport,
      runtimeTestedAt: runtime.runtimeTestedAt,
      runtimeEvidence: cleanText(runtime.note, 420),
      publicEvidence: cleanText(runtime.evidence, 700),
      sections: evidence.sections,
      sectionStatus: evidence.sections.length >= 2 ? "known" : "unknown",
      sectionSources: evidence.sectionSources,
      reviewPriority: candidatePriority({ title, artist }),
      opmSignal: isOpm({ title, artist }),
      duplicateWarnings: []
    };
  });
  const candidateIds = new Set(candidates.map((candidate) => candidate.videoId));
  if (candidateIds.size !== 22 || candidates.some((candidate) => !candidate.title || !candidate.provider)) {
    throw new Error(`Expected 22 complete technical-pass candidates; got ${candidateIds.size}.`);
  }
  for (const candidate of candidates) candidate.duplicateWarnings = duplicateWarningsFor(candidate, candidates, existingMedleys, Array.isArray(primarySongs) ? primarySongs : []);

  return candidates.sort((left, right) => left.reviewPriority - right.reviewPriority
    || (left.reviewPriority === PRIORITY_TERMS.length && right.reviewPriority === PRIORITY_TERMS.length
      ? Number(right.opmSignal) - Number(left.opmSignal)
        || (right.views ?? -1) - (left.views ?? -1)
        || right.sections.length - left.sections.length
        || left.duplicateWarnings.length - right.duplicateWarnings.length
      : (right.views ?? -1) - (left.views ?? -1))
    || left.videoId.localeCompare(right.videoId));
}

export function createBlankReview(candidate) {
  return {
    videoId: candidate.videoId,
    title: candidate.title,
    artist: candidate.artist,
    provider: candidate.provider,
    ratings: Object.fromEntries(QUALITY_CHECKS.map(({ id }) => [id, "not-reviewed"])),
    decision: null,
    language: "",
    theme: "",
    updatedAt: null
  };
}

export function isApprovalReady(record) {
  return Boolean(record
    && QUALITY_CHECKS.every(({ id }) => record.ratings?.[id] === "pass")
    && cleanText(record.language, 80)
    && cleanText(record.theme, 100));
}

function validTimestamp(value) {
  return value === null || value === undefined || (typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)));
}

function validateRecord(raw, candidate) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Review entry must be an object." };
  for (const key of ["videoId", "title", "artist", "provider"]) {
    if (raw[key] !== candidate[key]) return { ok: false, error: `Candidate identity mismatch for ${candidate.videoId} (${key}).` };
  }
  if (!raw.ratings || typeof raw.ratings !== "object" || Array.isArray(raw.ratings)) return { ok: false, error: `Ratings are missing for ${candidate.videoId}.` };
  if (Object.keys(raw.ratings).length !== QUALITY_CHECKS.length
    || QUALITY_CHECKS.some(({ id }) => !REVIEW_VALUES.includes(raw.ratings[id]))) {
    return { ok: false, error: `Quality ratings are invalid for ${candidate.videoId}.` };
  }
  if (raw.decision !== null && !DECISIONS.includes(raw.decision)) return { ok: false, error: `Decision is invalid for ${candidate.videoId}.` };
  const language = cleanText(raw.language, 80);
  const theme = cleanText(raw.theme, 100);
  if ((raw.language ?? "") !== language || (raw.theme ?? "") !== theme) return { ok: false, error: `Language or theme is invalid for ${candidate.videoId}.` };
  if (!validTimestamp(raw.updatedAt)) return { ok: false, error: `Updated timestamp is invalid for ${candidate.videoId}.` };
  const normalized = { ...createBlankReview(candidate), ratings: { ...raw.ratings }, decision: raw.decision, language, theme, updatedAt: raw.updatedAt || null };
  if (normalized.decision === "approved" && !isApprovalReady(normalized)) {
    return { ok: false, error: `Approval for ${candidate.videoId} is incomplete: all six checks, language, and theme must be complete.` };
  }
  return { ok: true, record: normalized };
}

export function loadReviewState(rawText, candidates) {
  const cleanState = { schemaVersion: REVIEW_SCHEMA_VERSION, entries: {} };
  if (!rawText) return { state: cleanState, warnings: [] };
  if (typeof rawText !== "string" || rawText.length > 1024 * 1024) {
    return { state: cleanState, warnings: ["Saved review data exceeded the 1 MB safety limit; a clean review state is available. Existing text was left untouched until you save a change."] };
  }
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { return { state: cleanState, warnings: ["Saved review data was malformed; a clean review state is available. Existing text was left untouched until you save a change."] }; }
  if (!parsed || parsed.schemaVersion !== REVIEW_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
    return { state: cleanState, warnings: ["Saved review data used an unknown format; a clean review state is available. Existing text was left untouched until you save a change."] };
  }
  const byId = new Map(candidates.map((candidate) => [candidate.videoId, candidate]));
  const seen = new Set();
  const warnings = [];
  for (const entry of parsed.entries) {
    const candidate = byId.get(entry?.videoId);
    if (!candidate || seen.has(entry.videoId)) {
      warnings.push("Some saved rows were ignored because they contained an unknown or repeated candidate ID.");
      continue;
    }
    const checked = validateRecord(entry, candidate);
    if (!checked.ok) {
      warnings.push("Some saved review data did not match this candidate set and was ignored.");
      continue;
    }
    seen.add(entry.videoId);
    cleanState.entries[entry.videoId] = checked.record;
  }
  return { state: cleanState, warnings: [...new Set(warnings)] };
}

function withUpdatedRecord(state, candidate, change, now) {
  const previous = state.entries[candidate.videoId] || createBlankReview(candidate);
  const next = { ...previous, ...change, ratings: { ...previous.ratings, ...(change.ratings || {}) }, updatedAt: now };
  if (previous.decision === "approved" && !isApprovalReady(next)) next.decision = "needs-another-review";
  return { ...state, entries: { ...state.entries, [candidate.videoId]: next } };
}

export function updateReviewRating(state, candidate, checkId, value, now = new Date().toISOString()) {
  if (!QUALITY_CHECKS.some(({ id }) => id === checkId) || !REVIEW_VALUES.includes(value)) {
    return { ok: false, error: "Unknown quality check or rating." };
  }
  const next = withUpdatedRecord(state, candidate, { ratings: { [checkId]: value } }, now);
  return { ok: true, state: next };
}

export function updateCollectionMetadata(state, candidate, field, value, now = new Date().toISOString()) {
  if (!(["language", "theme"].includes(field)) || typeof value !== "string" || value.length > 120) {
    return { ok: false, error: "Collection metadata is invalid." };
  }
  const cleaned = cleanText(value, field === "language" ? 80 : 100);
  const next = withUpdatedRecord(state, candidate, { [field]: cleaned }, now);
  return { ok: true, state: next };
}

export function setReviewDecision(state, candidate, decision, now = new Date().toISOString()) {
  if (!DECISIONS.includes(decision)) return { ok: false, error: "Choose Approve, Reject, or Needs another review." };
  const current = state.entries[candidate.videoId] || createBlankReview(candidate);
  if (decision === "approved" && !isApprovalReady(current)) {
    return { ok: false, error: "Approval requires all six quality checks to Pass, plus a language and theme." };
  }
  const next = { ...current, decision, updatedAt: now };
  return { ok: true, state: { ...state, entries: { ...state.entries, [candidate.videoId]: next } } };
}

export function hasReviewProgress(record) {
  return Boolean(record && (record.decision
    || record.language
    || record.theme
    || QUALITY_CHECKS.some(({ id }) => record.ratings?.[id] !== "not-reviewed")));
}

export function serializeReviewState(state) {
  return JSON.stringify({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    entries: Object.values(state.entries || {}).filter(hasReviewProgress)
  });
}

export function createReviewExport(state, candidates, exportedAt = new Date().toISOString()) {
  const byId = new Map(candidates.map((candidate) => [candidate.videoId, candidate]));
  const reviews = Object.values(state.entries || {}).filter(hasReviewProgress).map((record) => {
    const candidate = byId.get(record.videoId);
    if (!candidate) return null;
    return {
      videoId: candidate.videoId,
      title: candidate.title,
      artist: candidate.artist,
      provider: candidate.provider,
      ratings: { ...record.ratings },
      decision: record.decision,
      language: record.language,
      theme: record.theme,
      updatedAt: record.updatedAt
    };
  }).filter(Boolean);
  return { format: REVIEW_FORMAT, schemaVersion: REVIEW_SCHEMA_VERSION, exportedAt, sourceReport: "medley-expansion-research-v5.json", reviews };
}

export function validateReviewExport(payload, candidates) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.format !== REVIEW_FORMAT || payload.schemaVersion !== REVIEW_SCHEMA_VERSION
    || !Array.isArray(payload.reviews) || payload.reviews.length > candidates.length) {
    return { ok: false, error: "This is not a supported KantaCue medley review export." };
  }
  const byId = new Map(candidates.map((candidate) => [candidate.videoId, candidate]));
  const seen = new Set();
  const reviews = [];
  for (const raw of payload.reviews) {
    const candidate = byId.get(raw?.videoId);
    if (!candidate) return { ok: false, error: "Import rejected: an unknown candidate ID was found." };
    if (seen.has(raw.videoId)) return { ok: false, error: "Import rejected: a candidate ID appears more than once." };
    seen.add(raw.videoId);
    const checked = validateRecord(raw, candidate);
    if (!checked.ok) return { ok: false, error: `Import rejected: ${checked.error}` };
    reviews.push(checked.record);
  }
  return { ok: true, reviews };
}

export function mergeImportedReviews(state, reviews) {
  const conflicts = reviews.filter((record) => hasReviewProgress(state.entries?.[record.videoId])).map((record) => record.videoId);
  if (conflicts.length) return { ok: false, error: `Import would overwrite existing decisions for ${conflicts.length} candidate(s). Reset those entries first, or import into a fresh browser profile.` };
  const entries = { ...state.entries };
  for (const record of reviews) entries[record.videoId] = record;
  return { ok: true, state: { ...state, entries } };
}

export function buildPromotionPreview({ reviewExport, candidates, existingMedleys, primarySongs }) {
  const imported = validateReviewExport(reviewExport, candidates);
  if (!imported.ok) return { ok: false, errors: [imported.error], additions: [] };
  const approved = imported.reviews.filter((record) => record.decision === "approved");
  const errors = [];
  const videoIds = new Set(existingMedleys.map((item) => item.videoId));
  const medleyIds = new Set(existingMedleys.map((item) => item.id));
  const primaryVideoIds = new Set(primarySongs.map((song) => song.youtubeVideoId).filter(Boolean));
  const approvedPairs = new Set();
  const candidateById = new Map(candidates.map((candidate) => [candidate.videoId, candidate]));
  const additions = [];

  for (const record of approved) {
    const candidate = candidateById.get(record.videoId);
    if (!candidate || candidate.runtimeStatus !== "PASS" || !VIDEO_ID.test(candidate.videoId)) {
      errors.push(`${record.videoId}: missing eligible sustained runtime PASS.`);
      continue;
    }
    if (videoIds.has(candidate.videoId) || primaryVideoIds.has(candidate.videoId)) {
      errors.push(`${record.videoId}: video ID already exists in production medleys or primary songs.`);
      continue;
    }
    if (existingMedleys.some((medley) => normalizeIdentity(medley.title) === normalizeIdentity(candidate.title))) {
      errors.push(`${record.videoId}: candidate title duplicates an existing production medley title; no replacement is allowed.`);
      continue;
    }
    const titleKey = `${normalizeIdentity(candidate.title)}\u0000${normalizeIdentity(candidate.artist)}`;
    if (!normalizeIdentity(candidate.title) || !normalizeIdentity(candidate.artist) || approvedPairs.has(titleKey)) {
      errors.push(`${record.videoId}: duplicate or incomplete normalized title/artist identity.`);
      continue;
    }
    approvedPairs.add(titleKey);
    const generatedId = `medley-review-${candidate.videoId.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
    if (!/^medley-[a-z0-9-]+$/.test(generatedId) || medleyIds.has(generatedId)) {
      errors.push(`${record.videoId}: generated medley ID collides with production data.`);
      continue;
    }
    const sections = candidate.sections.length >= 2 ? candidate.sections.map((section) => ({ ...section })) : [];
    const sectionStatus = sections.length >= 2 ? "known" : "unknown";
    const medleyEvidence = candidate.publicEvidence;
    if (sectionStatus === "unknown" && !medleyEvidence) {
      errors.push(`${record.videoId}: unknown sections lack source evidence.`);
      continue;
    }
    if (!record.language || !record.theme) {
      errors.push(`${record.videoId}: language and collection theme must be explicitly provided.`);
      continue;
    }
    const addition = {
      id: generatedId,
      title: candidate.title,
      provider: candidate.provider,
      videoId: candidate.videoId,
      language: record.language,
      theme: record.theme,
      includedSongs: sections,
      sectionStatus,
      medleyEvidence,
      publicViews: Number.isInteger(candidate.views) ? candidate.views : null,
      publishedAt: candidate.publishedAt,
      sourceUrl: `https://www.youtube.com/watch?v=${candidate.videoId}`,
      provenance: `Candidate sourced from medley-expansion-research-v5.json; human quality review decision recorded ${record.updatedAt || "date not supplied"}. Section list provenance remains in the local research report.`,
      verification: {
        status: "verified-for-release",
        testedAt: candidate.runtimeTestedAt,
        method: "KantaCue YouTube IFrame player; onReady, PLAYING, and sustained currentTime advancement of at least 15 seconds; human review workspace recorded six passing quality checks.",
        manualQuality: "human-review-approved"
      }
    };
    additions.push(addition);
    videoIds.add(candidate.videoId);
    medleyIds.add(generatedId);
  }

  return { ok: errors.length === 0, errors, additions, approvedCount: approved.length, currentMedleyCount: existingMedleys.length };
}

export function hasValidReviewHost(locationRef = globalThis.location) {
  if (!locationRef || locationRef.protocol !== "http:") return false;
  return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(locationRef.hostname.toLowerCase());
}
