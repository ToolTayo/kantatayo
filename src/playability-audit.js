export const PLAYABILITY_STATUSES = Object.freeze([
  "UNTESTED",
  "LOADING",
  "READY",
  "PLAYING",
  "PASS",
  "ERROR 2",
  "ERROR 5",
  "ERROR 100",
  "ERROR 101",
  "ERROR 150",
  "ERROR 153",
  "TIMEOUT",
  "READY-ONLY",
  "AUTOPLAY POLICY ONLY",
  "PLAYING WITHOUT PROGRESSION",
  "INCONCLUSIVE",
  "ENVIRONMENT FAILURE",
  "CONTROL FAILURE",
  "UNAVAILABLE"
]);

export const TECHNICAL_ERROR_CODES = Object.freeze([2, 5, 100, 101, 150, 153]);
export const SUSTAINED_PLAYBACK_MS = 15_000;

const MIN_PLAYBACK_SAMPLES = 8;
const MIN_SAMPLE_SPAN_MS = 12_000;
const MIN_ADVANCING_INTERVALS = 5;
const MIN_FINAL_WINDOW_ADVANCING_INTERVALS = 2;
const MIN_ADVANCEMENT_SECONDS = 8;
const MAX_NORMAL_SAMPLE_DELTA_SECONDS = 4.5;
const MAX_LAST_SAMPLE_AGE_MS = 2_500;

export function resultStatusForError(code) {
  const numericCode = Number(code);
  return TECHNICAL_ERROR_CODES.includes(numericCode) ? `ERROR ${numericCode}` : "INCONCLUSIVE";
}

export function classifyPlayerErrorIdentity(code, requestedVideoId, loadedVideoId) {
  const numericCode = Number(code) || String(code);
  if (!requestedVideoId || loadedVideoId !== requestedVideoId) {
    return {
      status: "INCONCLUSIVE",
      errorCode: numericCode,
      failureClassification: "PLAYER_VIDEO_ID_MISMATCH",
      note: `The player reported error ${numericCode}, but its official loaded-video ID did not match the requested candidate; the error cannot be assigned safely.`
    };
  }
  return { status: resultStatusForError(code), errorCode: numericCode, failureClassification: null, note: "" };
}

export function classifyPlaybackStartFailure(playerState) {
  const numericState = Number(playerState);
  if (numericState === 3) {
    return {
      failureClassification: "PLAYER_BUFFERING_BEFORE_PLAYING",
      note: "The official player remained in BUFFERING without reporting PLAYING during the startup grace window."
    };
  }
  if (numericState === 2) {
    return {
      failureClassification: "PLAYER_PAUSED_BEFORE_PLAYING",
      note: "The official player reported PAUSED before any PLAYING state was observed."
    };
  }
  if (numericState === 0) {
    return {
      failureClassification: "PLAYER_ENDED_BEFORE_PLAYING",
      note: "The official player reported ENDED before any PLAYING state was observed."
    };
  }
  return {
    failureClassification: "PLAYBACK_NOT_STARTED",
    note: "The player reached onReady but did not report PLAYING during the startup grace window."
  };
}

export function isTerminalStatus(status) {
  return ["PASS", "TIMEOUT", "READY-ONLY", "AUTOPLAY POLICY ONLY", "PLAYING WITHOUT PROGRESSION", "INCONCLUSIVE", "ENVIRONMENT FAILURE", "CONTROL FAILURE", "UNAVAILABLE"].includes(status) || /^ERROR /.test(status || "");
}

export function evaluateSustainedPlayback({ elapsedMs, samples = [], visibilityTrace = [], expectedVideoId = null } = {}) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < SUSTAINED_PLAYBACK_MS) {
    return { status: "INCONCLUSIVE", reason: "The sustained playback window was not fully observed." };
  }
  if (visibilityTrace.some((state) => state !== "visible")) {
    return { status: "INCONCLUSIVE", reason: "The audit page was backgrounded during the playback window." };
  }

  const matchingSamples = expectedVideoId
    ? samples.filter((sample) => sample?.loadedVideoId === expectedVideoId && sample?.playerVideoId === expectedVideoId && sample?.playerReady === true && sample?.iframeConnected === true)
    : samples;
  if (expectedVideoId && matchingSamples.length < MIN_PLAYBACK_SAMPLES) {
    return { status: "INCONCLUSIVE", reason: `The official player did not expose ${MIN_PLAYBACK_SAMPLES} samples for the requested video ID ${expectedVideoId}.` };
  }
  const validSamples = matchingSamples
    .filter((sample) => Number.isFinite(sample?.elapsedMs) && Number.isFinite(sample?.currentTime))
    .sort((left, right) => left.elapsedMs - right.elapsedMs);
  if (validSamples.length < MIN_PLAYBACK_SAMPLES) {
    return { status: "INCONCLUSIVE", reason: `Only ${validSamples.length} readable playback-time samples were collected; ${MIN_PLAYBACK_SAMPLES} are required.` };
  }

  const sampleSpanMs = validSamples.at(-1).elapsedMs - validSamples[0].elapsedMs;
  if (sampleSpanMs < MIN_SAMPLE_SPAN_MS || elapsedMs - validSamples.at(-1).elapsedMs > MAX_LAST_SAMPLE_AGE_MS) {
    return { status: "INCONCLUSIVE", reason: "Readable playback samples did not cover the sustained window through its end." };
  }

  const advancementSeconds = validSamples.at(-1).currentTime - validSamples[0].currentTime;
  let advancingIntervals = 0;
  let finalWindowAdvancingIntervals = 0;
  const finalWindowStartMs = Math.max(0, elapsedMs - 5_000);
  for (let index = 1; index < validSamples.length; index += 1) {
    const delta = validSamples[index].currentTime - validSamples[index - 1].currentTime;
    if (delta > 0.2 && delta <= MAX_NORMAL_SAMPLE_DELTA_SECONDS) {
      advancingIntervals += 1;
      if (validSamples[index].elapsedMs >= finalWindowStartMs) finalWindowAdvancingIntervals += 1;
    }
  }
  const hasSustainedProgress = advancementSeconds >= MIN_ADVANCEMENT_SECONDS && advancingIntervals >= MIN_ADVANCING_INTERVALS && finalWindowAdvancingIntervals >= MIN_FINAL_WINDOW_ADVANCING_INTERVALS;
  if (!hasSustainedProgress) {
    return {
      status: "PLAYING WITHOUT PROGRESSION",
      reason: `The player reported PLAYING for ${Math.round(elapsedMs / 1000)} seconds, but observed ${advancementSeconds.toFixed(1)} seconds of net time advancement across ${advancingIntervals} advancing intervals, including ${finalWindowAdvancingIntervals} in the final five seconds.`
    };
  }
  return { status: "PASS", reason: `Sustained playback verified: ${validSamples.length} readable samples over ${sampleSpanMs / 1000} seconds, ${advancementSeconds.toFixed(1)} seconds of advancement, and ${advancingIntervals} advancing intervals including ${finalWindowAdvancingIntervals} in the final five seconds.` };
}

export function mergeAuditResult(entry, patch = {}) {
  return {
    ...entry,
    ...patch,
    iframeStatus: patch.iframeStatus || entry.iframeStatus || "UNTESTED",
    testedAt: patch.testedAt || entry.testedAt || null
  };
}

export function summarizeAuditEntries(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  return {
    total: rows.length,
    metadataValid: rows.filter((entry) => ["VALID", "VALID_NO_VIDEO"].includes(entry.metadataStatus)).length,
    apiEmbeddable: rows.filter((entry) => entry.apiEmbeddable === true).length,
    apiNotEmbeddable: rows.filter((entry) => entry.apiEmbeddable === false).length,
    playerReady: rows.filter((entry) => ["READY", "PLAYING", "PASS"].includes(entry.iframeStatus)).length,
    confirmedPlayable: rows.filter((entry) => entry.iframeStatus === "PASS").length,
    confirmedEmbeddingFailures: rows.filter((entry) => ["ERROR 101", "ERROR 150"].includes(entry.iframeStatus)).length,
    unavailable: rows.filter((entry) => ["UNAVAILABLE", "ERROR 100"].includes(entry.iframeStatus)).length,
    timeouts: rows.filter((entry) => entry.iframeStatus === "TIMEOUT").length,
    playingWithoutProgression: rows.filter((entry) => entry.iframeStatus === "PLAYING WITHOUT PROGRESSION").length,
    environmentFailures: rows.filter((entry) => entry.iframeStatus === "ENVIRONMENT FAILURE").length,
    controlFailures: rows.filter((entry) => entry.iframeStatus === "CONTROL FAILURE").length,
    ambiguous: rows.filter((entry) => ["UNTESTED", "READY-ONLY", "INCONCLUSIVE", "ENVIRONMENT FAILURE", "CONTROL FAILURE"].includes(entry.iframeStatus)).length,
    readyOnly: rows.filter((entry) => entry.iframeStatus === "READY-ONLY").length,
    autoplayPolicyOnly: rows.filter((entry) => entry.iframeStatus === "AUTOPLAY POLICY ONLY").length,
    errors: rows.filter((entry) => /^ERROR /.test(entry.iframeStatus || "")).length
  };
}

export function applyValidatedControlGate(entries, controlGate, controlId, expectedVideoId) {
  const runs = Array.isArray(controlGate?.runs) ? controlGate.runs : [];
  const requiredRuns = Number(controlGate?.requiredIndependentRuns) || 0;
  const passedRuns = runs.filter((run) => run?.songId === controlId
    && run?.videoId === expectedVideoId
    && run?.validation?.status === "PASS").length;
  const gatePassed = controlGate?.status === "PASS"
    && requiredRuns > 0
    && runs.length === requiredRuns
    && passedRuns === requiredRuns;
  const latestRun = runs.at(-1);

  return (Array.isArray(entries) ? entries : []).map((entry) => {
    if (entry?.songId !== controlId) return entry;
    return {
      ...entry,
      iframeStatus: gatePassed ? "PASS" : "CONTROL FAILURE",
      errorCode: latestRun?.errorCode ?? null,
      failureClassification: gatePassed ? "THREE_RUN_CONTROL_GATE" : "CONTROL_FAILURE",
      note: gatePassed
        ? `Known-good control passed ${requiredRuns} independent sustained-playback runs.`
        : `Known-good control passed ${passedRuns}/${requiredRuns} required independent runs.`,
      testedAt: latestRun?.testedAt || entry.testedAt || null
    };
  });
}

export function isAllowedAuditContext(locationRef = globalThis.location) {
  const hostname = String(locationRef?.hostname || "").toLowerCase();
  const devFlag = new URLSearchParams(locationRef?.search || "").get("dev") === "1";
  return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(hostname) || devFlag;
}
