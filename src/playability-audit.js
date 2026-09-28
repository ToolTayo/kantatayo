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
  "AUTOPLAY POLICY ONLY",
  "INCONCLUSIVE",
  "UNAVAILABLE"
]);

export const TECHNICAL_ERROR_CODES = Object.freeze([2, 5, 100, 101, 150, 153]);

export function resultStatusForError(code) {
  const numericCode = Number(code);
  return TECHNICAL_ERROR_CODES.includes(numericCode) ? `ERROR ${numericCode}` : "INCONCLUSIVE";
}

export function isTerminalStatus(status) {
  return status === "PASS" || status === "TIMEOUT" || status === "AUTOPLAY POLICY ONLY" || status === "INCONCLUSIVE" || status === "UNAVAILABLE" || /^ERROR /.test(status || "");
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
    ambiguous: rows.filter((entry) => ["UNTESTED", "INCONCLUSIVE"].includes(entry.iframeStatus)).length,
    autoplayPolicyOnly: rows.filter((entry) => entry.iframeStatus === "AUTOPLAY POLICY ONLY").length,
    errors: rows.filter((entry) => /^ERROR /.test(entry.iframeStatus || "")).length
  };
}

export function isAllowedAuditContext(locationRef = globalThis.location) {
  const hostname = String(locationRef?.hostname || "").toLowerCase();
  const devFlag = new URLSearchParams(locationRef?.search || "").get("dev") === "1";
  return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(hostname) || devFlag;
}
