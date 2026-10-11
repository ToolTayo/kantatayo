import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMedleys } from "../src/medleys.js";
import { evaluateSustainedPlayback } from "../src/playability-audit.js";
import {
  EVIDENCE_REPORT_FILES,
  RUNTIME_REPORT_FILES,
  buildReviewCandidates,
  normalizeIdentity
} from "./medley-review-core.mjs";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(TOOL_DIR);
const MEDLEY_FILE = path.join(ROOT_DIR, "data", "medleys.sample.json");
const SONG_FILE = path.join(ROOT_DIR, "data", "songs.sample.json");
const RESEARCH_FILE = path.join(TOOL_DIR, "medley-expansion-research-v5.json");
const RELEASE_FILE = path.join(TOOL_DIR, "owner-authorized-medley-release.json");
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const OWNER_AUTHORIZATION_TYPE = "explicit-project-owner-authorization";

function parseArgs(argv) {
  const args = { apply: false, digest: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") args.apply = true;
    else if (argument === "--confirm-digest") args.digest = argv[++index] || "";
    else if (argument === "--help" || argument === "-h") args.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return args;
}

function usage() {
  return [
    "Owner-authorized provisional medley preview (default; writes nothing):",
    "  node tools/promote-owner-authorized-medleys.mjs",
    "",
    "Explicit apply requires the exact preview digest:",
    "  node tools/promote-owner-authorized-medleys.mjs --apply --confirm-digest <sha256>",
    "",
    "This path records technical playback only. It does not create human quality approval or S/A/B ratings."
  ].join("\n");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function validateControlGate(report) {
  const gate = report?.runtime?.controlGate;
  const runs = Array.isArray(gate?.runs) ? gate.runs : [];
  if (gate?.status !== "PASS" || gate?.requiredIndependentRuns !== 3 || runs.length !== 3) return false;
  return runs.every((run) => run.songId === "sample-029"
    && run.videoId === "QBb9wO3Bj0k"
    && run.status === "PASS"
    && run.independentBrowserContext === true
    && run.independentBrowserProcess === true
    && run.validation?.status === "PASS"
    && run.validation?.playerIdentityMatched === true
    && run.validation?.readyObserved === true
    && run.validation?.playingObserved === true
    && run.validation?.playbackEvidence?.status === "PASS");
}

function validateCandidateRuntime(candidate, report) {
  const entry = (report?.entries || []).find((row) => row.videoId === candidate.videoId);
  if (!entry || entry.iframeStatus !== "PASS" || entry.errorCode != null || !validateControlGate(report)) {
    return { ok: false, reason: "No unique sustained PASS with a passing three-run sample-029 control gate." };
  }
  const trace = Array.isArray(entry.trace) ? entry.trace : [];
  if (trace.some((event) => event.kind === "error")) return { ok: false, reason: "The candidate trace contains a YouTube/player error callback." };
  const loadConfirmed = trace.some((event) => event.kind === "onReady"
      && event.playerVideoId === candidate.videoId
      && event.loadedVideoId === candidate.videoId
      && event.playerReady === true)
    || trace.some((event) => event.kind === "load-accepted"
      && event.playerVideoId === candidate.videoId
      && event.playerReady === true);
  const playingConfirmed = trace.some((event) => event.kind === "state-change"
    && Number(event.detail) === 1
    && event.playerVideoId === candidate.videoId
    && event.loadedVideoId === candidate.videoId
    && event.playerReady === true);
  const samples = trace.filter((event) => event.kind === "playback-sample").map((event) => ({
    elapsedMs: event.playbackElapsedMs,
    currentTime: event.currentTime,
    visibilityState: event.visibilityState,
    playerVideoId: event.playerVideoId,
    loadedVideoId: event.loadedVideoId,
    playerReady: event.playerReady,
    iframeConnected: event.iframeConnected
  }));
  if (!loadConfirmed || !playingConfirmed) return { ok: false, reason: "Trace does not prove a ready/load and PLAYING state for the candidate's exact official-player video URL." };
  if (samples.some((sample) => sample.playerVideoId !== candidate.videoId || sample.loadedVideoId !== candidate.videoId)) {
    return { ok: false, reason: "A sustained playback sample reports a different player or loaded video ID." };
  }
  const elapsedMs = samples.length ? Number(samples.at(-1).elapsedMs) : 0;
  const progress = evaluateSustainedPlayback({ elapsedMs, samples, visibilityTrace: trace.map((event) => event.visibilityState), expectedVideoId: candidate.videoId });
  const finalResult = [...trace].reverse().find((event) => event.kind === "result");
  if (progress.status !== "PASS" || finalResult?.detail !== "PASS") return { ok: false, reason: progress.reason };
  return {
    ok: true,
    report: candidate.runtimeReport,
    testedAt: entry.testedAt,
    sampleCount: samples.length,
    playbackSeconds: Number((elapsedMs / 1000).toFixed(3)),
    advancementSeconds: Number((samples.at(-1).currentTime - samples[0].currentTime).toFixed(3)),
    evidence: progress.reason
  };
}

function buildRecord(candidate, decision, runtimeProof, authorizedAt) {
  const includedSongs = candidate.sections.map((section) => ({ title: section.title, artist: section.artist || "" }));
  const sectionStatus = includedSongs.length >= 2 ? "known" : "unknown";
  const medleyEvidence = sectionStatus === "known"
    ? "Public research metadata captured multiple distinct medley sections; this is a technical/provenance description, not an audio or presentation quality judgment."
    : "The public video title identifies a multi-song medley; individual section names were not captured in the available research evidence.";
  return {
    id: decision.id,
    title: candidate.title,
    provider: candidate.provider,
    videoId: candidate.videoId,
    language: decision.language,
    theme: decision.theme,
    sectionStatus,
    medleyEvidence,
    includedSongs,
    publicViews: candidate.views,
    publishedAt: candidate.publishedAt,
    sourceUrl: `https://www.youtube.com/watch?v=${candidate.videoId}`,
    provenance: `Public metadata snapshot: ${candidate.publicEvidence || "not available"} Runtime evidence: ${runtimeProof.report}, ${runtimeProof.evidence} Audio, guide-vocal, lyric-sync, key/arrangement, completeness, and visual-presentation quality have not been human-reviewed.`,
    verification: {
      status: "owner-authorized-provisional",
      testedAt: runtimeProof.testedAt,
      method: "KantaCue official YouTube IFrame player/controller in the local Playwright Chromium audit; exact loaded video URL, PLAYING, 15-second sustained playback progression, and a passing three-run sample-029 control gate.",
      manualQuality: "unknown",
      ownerAuthorization: {
        type: OWNER_AUTHORIZATION_TYPE,
        authorizedAt,
        humanAudioPresentationReview: "not-performed"
      }
    }
  };
}

export function buildOwnerAuthorizedPreview({ release, candidates, runtimeReports, existingMedleys, primarySongs }) {
  const errors = [];
  if (release?.format !== "kantacue-owner-authorized-medley-release"
    || release?.version !== 1
    || release.authorization?.status !== OWNER_AUTHORIZATION_TYPE
    || release.authorization?.humanAudioPresentationReview !== "not-performed"
    || !release.authorization?.authorizedAt) {
    return { ok: false, errors: ["A valid explicit owner authorization that disclaims human quality review is required."], additions: [], decisions: [] };
  }
  if (!Array.isArray(candidates) || candidates.length !== 22 || !Array.isArray(release.decisions) || release.decisions.length !== candidates.length) {
    return { ok: false, errors: ["The release must reconcile exactly all 22 existing review candidates."], additions: [], decisions: [] };
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.videoId, candidate]));
  const reportByName = new Map((runtimeReports || []).map((report) => [report.name, report.data]));
  const decisionById = new Map();
  for (const decision of release.decisions) {
    if (!VIDEO_ID.test(String(decision?.videoId || "")) || decisionById.has(decision.videoId)
      || !candidateById.has(decision.videoId) || !["include", "exclude"].includes(decision.decision)) {
      errors.push(`Invalid, duplicate, or unrecognized release decision for ${decision?.videoId || "unknown ID"}.`);
      continue;
    }
    decisionById.set(decision.videoId, decision);
  }
  if (decisionById.size !== candidates.length) errors.push("Every candidate must have exactly one explicit include/exclude disposition.");

  const existingIds = new Set((existingMedleys || []).map((item) => item.id));
  const existingVideos = new Set((existingMedleys || []).map((item) => item.videoId));
  const existingTitles = new Set((existingMedleys || []).map((item) => normalizeIdentity(item.title)));
  const primaryVideos = new Set((primarySongs || []).map((song) => song.youtubeVideoId).filter(Boolean));
  const primaryPairs = new Set((primarySongs || []).map((song) => `${normalizeIdentity(song.title)}\u0000${normalizeIdentity(song.artist)}`));
  const additions = [];
  const outcomes = [];

  for (const candidate of candidates) {
    const decision = decisionById.get(candidate.videoId);
    if (!decision) continue;
    const report = reportByName.get(candidate.runtimeReport);
    const runtimeProof = validateCandidateRuntime(candidate, report);
    if (!runtimeProof.ok) {
      errors.push(`${candidate.videoId}: runtime evidence failed independent validation: ${runtimeProof.reason}`);
      outcomes.push({ videoId: candidate.videoId, decision: "blocked", reason: runtimeProof.reason });
      continue;
    }
    if (decision.decision === "exclude") {
      if (!String(decision.reason || "").trim()) errors.push(`${candidate.videoId}: exclusion reason is required.`);
      outcomes.push({ videoId: candidate.videoId, decision: "excluded", reason: decision.reason, runtimeProof });
      continue;
    }
    if (!VIDEO_ID.test(candidate.videoId) || !decision.id || primaryVideos.has(candidate.videoId)) {
      errors.push(`${candidate.videoId}: invalid ID or video collision with production/primary catalog.`);
      outcomes.push({ videoId: candidate.videoId, decision: "blocked", reason: "ID/video collision" });
      continue;
    }
    const expectedRecord = buildRecord(candidate, decision, runtimeProof, release.authorization.authorizedAt);
    const existingVideoRecord = (existingMedleys || []).find((item) => item.videoId === candidate.videoId);
    if (existingVideoRecord) {
      if (existingVideoRecord.id === decision.id && isDeepStrictEqual(existingVideoRecord, expectedRecord)) {
        outcomes.push({ videoId: candidate.videoId, decision: "already-applied", reason: "Exact owner-authorized provisional record already exists.", runtimeProof });
      } else {
        errors.push(`${candidate.videoId}: an existing medley uses this video ID but does not exactly match the authorized provisional record.`);
        outcomes.push({ videoId: candidate.videoId, decision: "blocked", reason: "conflicting existing video record" });
      }
      continue;
    }
    if (existingIds.has(decision.id)) {
      errors.push(`${candidate.videoId}: medley ID ${decision.id} is already used by another production record.`);
      outcomes.push({ videoId: candidate.videoId, decision: "blocked", reason: "ID collision" });
      continue;
    }
    if (existingTitles.has(normalizeIdentity(candidate.title))) {
      errors.push(`${candidate.videoId}: normalized medley title duplicates an existing production title.`);
      outcomes.push({ videoId: candidate.videoId, decision: "blocked", reason: "duplicate title" });
      continue;
    }
    if (!decision.language || !decision.theme || !String(decision.reason || "").trim()) {
      errors.push(`${candidate.videoId}: a defensible language/theme and disposition rationale are required.`);
      continue;
    }
    const warnings = candidate.duplicateWarnings || [];
    if (warnings.some((warning) => /primary-catalog collision|compare with existing collection/i.test(warning))
      && !/overlap|distinct|different selection/i.test(decision.reason)) {
      errors.push(`${candidate.videoId}: a known overlap requires explicit distinctness rationale.`);
      continue;
    }
    if (warnings.some((warning) => /competing candidate/i.test(warning))
      && !/competing|distinct|different selection|shared|selection/i.test(decision.reason)) {
      errors.push(`${candidate.videoId}: competing same-artist/collection candidates require an explicit selection rationale.`);
      continue;
    }
    const titleArtistKey = `${normalizeIdentity(candidate.title)}\u0000${normalizeIdentity(candidate.artist)}`;
    if (primaryPairs.has(titleArtistKey)) {
      errors.push(`${candidate.videoId}: normalized title/artist duplicates a primary song.`);
      continue;
    }
    additions.push(expectedRecord);
    outcomes.push({ videoId: candidate.videoId, decision: "included", reason: decision.reason, runtimeProof });
  }

  if (errors.length) return { ok: false, errors, additions: [], decisions: outcomes };
  const normalized = normalizeMedleys({ medleys: [...existingMedleys, ...additions] }, { logger: { warn() {} } });
  if (normalized.warnings.length || normalized.medleys.length !== existingMedleys.length + additions.length) {
    return { ok: false, errors: [...normalized.warnings, "Provisional additions failed the production medley normalizer."], additions: [], decisions: outcomes };
  }
  const normalizedAcceptedTitles = additions.map((item) => normalizeIdentity(item.title));
  if (new Set(normalizedAcceptedTitles).size !== normalizedAcceptedTitles.length) {
    return { ok: false, errors: ["Accepted candidates contain duplicate normalized titles."], additions: [], decisions: outcomes };
  }
  return {
    ok: true,
    errors: [],
    additions,
    decisions: outcomes,
    currentMedleyCount: existingMedleys.length,
    finalMedleyCount: normalized.medleys.length,
    acceptedCount: additions.length,
    alreadyAppliedCount: outcomes.filter((outcome) => outcome.decision === "already-applied").length,
    excludedCount: outcomes.filter((outcome) => outcome.decision === "excluded").length
  };
}

async function loadPreview() {
  const [release, researchReport, medleyData, primarySongs, ...sources] = await Promise.all([
    readJson(RELEASE_FILE),
    readJson(RESEARCH_FILE),
    readJson(MEDLEY_FILE),
    readJson(SONG_FILE),
    ...RUNTIME_REPORT_FILES.map(async (name) => ({ name, data: await readJson(path.join(TOOL_DIR, name)) })),
    ...EVIDENCE_REPORT_FILES.map(async (name) => ({ name, data: await readJson(path.join(TOOL_DIR, name)) }))
  ]);
  const runtimeReports = sources.slice(0, RUNTIME_REPORT_FILES.length);
  const evidenceReports = sources.slice(RUNTIME_REPORT_FILES.length);
  const candidates = buildReviewCandidates({ researchReport, runtimeReports, evidenceReports, existingMedleys: medleyData.medleys, primarySongs });
  const preview = buildOwnerAuthorizedPreview({ release, candidates, runtimeReports, existingMedleys: medleyData.medleys, primarySongs });
  return { preview, medleyData, primarySongs };
}

function previewDigest(currentData, additions) {
  return createHash("sha256").update(JSON.stringify({ currentData, additions })).digest("hex");
}

async function replaceFileSafely(destination, content) {
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, "wx");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    JSON.parse(await readFile(temp, "utf8"));
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, destination);
        break;
      } catch (error) {
        if (!new Set(["EPERM", "EBUSY", "EACCES"]).has(error?.code) || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const { preview, medleyData, primarySongs } = await loadPreview();
  if (!preview.ok) {
    console.error("OWNER-AUTHORIZED PROVISIONAL PREVIEW BLOCKED");
    preview.errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 2;
    return;
  }
  const digest = previewDigest(medleyData, preview.additions);
  console.log(`Existing production medleys: ${preview.currentMedleyCount}`);
  console.log(`Owner-authorized provisional additions: ${preview.acceptedCount}`);
  console.log(`Already applied exactly: ${preview.alreadyAppliedCount || 0}`);
  console.log(`Explicitly excluded candidates: ${preview.excludedCount}`);
  console.log(`Final medley count if applied: ${preview.finalMedleyCount}`);
  console.log("Human audio/presentation review: NOT PERFORMED; all additions remain provisional.");
  console.log(JSON.stringify(preview.decisions, null, 2));
  console.log(`Preview digest: ${digest}`);
  if (!args.apply) { console.log("PREVIEW ONLY — no production file was written."); return; }
  if (args.digest !== digest) throw new Error("Apply blocked: --confirm-digest must exactly match the current preview digest.");
  if (preview.additions.length === 0 && preview.alreadyAppliedCount > 0) {
    console.log("NO-OP — all included owner-authorized provisional records already exist exactly; no production file was written.");
    return;
  }
  const latest = await loadPreview();
  const latestDigest = previewDigest(latest.medleyData, latest.preview.additions);
  if (!latest.preview.ok || latestDigest !== args.digest) throw new Error("Apply blocked: authorization, reports, catalog, or preview changed after confirmation.");
  if (latest.primarySongs.length !== 1067 || latest.medleyData.medleys.length !== 11) {
    throw new Error("Apply blocked: the expected primary-catalog/medley baseline changed.");
  }
  const updated = { ...latest.medleyData, medleys: [...latest.medleyData.medleys, ...latest.preview.additions] };
  const checked = normalizeMedleys(updated, { logger: { warn() {} } });
  if (checked.warnings.length || checked.medleys.length !== updated.medleys.length) throw new Error("Apply blocked: final data failed normalization.");
  await replaceFileSafely(MEDLEY_FILE, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`APPLIED ${latest.preview.acceptedCount} owner-authorized provisional medley(s); no human quality approval was created.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Owner-authorized medley promotion failed safely: ${error.message}`); process.exitCode = 1; });
}
