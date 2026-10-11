import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DECISIONS,
  EVIDENCE_REPORT_FILES,
  QUALITY_CHECKS,
  REVIEW_FORMAT,
  REVIEW_SCHEMA_VERSION,
  REVIEW_STORAGE_KEY,
  RUNTIME_REPORT_FILES,
  buildPromotionPreview,
  buildReviewCandidates,
  createBlankReview,
  createReviewExport,
  hasReviewProgress,
  hasValidReviewHost,
  loadReviewState,
  mergeImportedReviews,
  serializeReviewState,
  setReviewDecision,
  updateCollectionMetadata,
  updateReviewRating,
  validateReviewExport
} from "../tools/medley-review-core.mjs";
import { handleMedleyReviewRequest } from "../tools/serve-medley-review.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

const [researchReport, medleyData, songs, ...sourceFiles] = await Promise.all([
  readJson("tools/medley-expansion-research-v5.json"),
  readJson("data/medleys.sample.json"),
  readJson("data/songs.sample.json"),
  ...RUNTIME_REPORT_FILES.map(async (name) => ({ name, data: await readJson(`tools/${name}`) })),
  ...EVIDENCE_REPORT_FILES.map(async (name) => ({ name, data: await readJson(`tools/${name}`) }))
]);
const runtimeReports = sourceFiles.slice(0, RUNTIME_REPORT_FILES.length);
const evidenceReports = sourceFiles.slice(RUNTIME_REPORT_FILES.length);
const reviewBaselineMedleys = medleyData.medleys.filter((medley) => medley.verification?.status !== "owner-authorized-provisional");
const candidates = buildReviewCandidates({ researchReport, runtimeReports, evidenceReports, existingMedleys: reviewBaselineMedleys, primarySongs: songs });
const candidateById = new Map(candidates.map((candidate) => [candidate.videoId, candidate]));

function completeReview(candidate, decision = "approved") {
  let state = { schemaVersion: REVIEW_SCHEMA_VERSION, entries: {} };
  for (const { id } of QUALITY_CHECKS) state = updateReviewRating(state, candidate, id, "pass", "2026-10-08T12:00:00.000Z").state;
  state = updateCollectionMetadata(state, candidate, "language", "English", "2026-10-08T12:00:00.000Z").state;
  state = updateCollectionMetadata(state, candidate, "theme", "Classic artist medley", "2026-10-08T12:00:00.000Z").state;
  state = setReviewDecision(state, candidate, decision, "2026-10-08T12:00:00.000Z").state;
  return state.entries[candidate.videoId];
}

test("review workspace loads only 22 sustained runtime PASS candidates in the requested priority order", () => {
  assert.equal(candidates.length, 22);
  assert.ok(candidates.every((candidate) => candidate.runtimeStatus === "PASS" && /sustained playback verified/i.test(candidate.runtimeEvidence)));
  assert.deepEqual(candidates.slice(0, 10).map((candidate) => candidate.videoId), [
    "BIvD7IJQyME", "L2Y5wnhyfNI", "-D1irYqKIog", "WO-ZTFltK9A", "OHIFuGAaod4",
    "I8ruYoUTetw", "JdoBsqrN5W4", "8ToBsPKxlko", "-IVoCF2v2KI", "rewX8w9pw9E"
  ]);
  assert.ok(candidates.some((candidate) => candidate.sections.length >= 2));
  assert.ok(candidates.find((candidate) => candidate.videoId === "JdoBsqrN5W4").sections.length === 0);
});

test("review warnings flag competing artist versions and overlaps with current collections", () => {
  const aprilBoy = candidateById.get("L2Y5wnhyfNI");
  const renz = candidateById.get("5lqlYpJ03qo");
  assert.ok(aprilBoy.duplicateWarnings.some((warning) => /competing candidate/i.test(warning)));
  assert.ok(renz.duplicateWarnings.some((warning) => /competing candidate|existing collection|track-list comparison/i.test(warning)));
});

test("review warnings surface primary-catalog video and normalized identity collisions", () => {
  const researchCandidate = candidates[0];
  const withVideoCollision = buildReviewCandidates({
    researchReport,
    runtimeReports,
    evidenceReports,
    existingMedleys: reviewBaselineMedleys,
    primarySongs: [{ id: "sample-test", title: "Different title", artist: "Different artist", youtubeVideoId: researchCandidate.videoId }]
  }).find((candidate) => candidate.videoId === researchCandidate.videoId);
  assert.ok(withVideoCollision.duplicateWarnings.some((warning) => /primary-catalog collision.*same youtube video id/i.test(warning)));

  const withIdentityCollision = buildReviewCandidates({
    researchReport,
    runtimeReports,
    evidenceReports,
    existingMedleys: reviewBaselineMedleys,
    primarySongs: [{ id: "sample-test", title: researchCandidate.title.toUpperCase(), artist: researchCandidate.artist, youtubeVideoId: "AaBbCcDdEe1" }]
  }).find((candidate) => candidate.videoId === researchCandidate.videoId);
  assert.ok(withIdentityCollision.duplicateWarnings.some((warning) => /same normalized title\/artist/i.test(warning)));
});

test("ratings default to Not reviewed and incomplete or failed checks cannot be approved", () => {
  const candidate = candidates[0];
  const blank = createBlankReview(candidate);
  assert.ok(QUALITY_CHECKS.every(({ id }) => blank.ratings[id] === "not-reviewed"));
  assert.equal(blank.decision, null);
  const blocked = setReviewDecision({ schemaVersion: 1, entries: {} }, candidate, "approved");
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /six quality checks/i);
  let state = updateReviewRating({ schemaVersion: 1, entries: {} }, candidate, QUALITY_CHECKS[0].id, "fail").state;
  for (const { id } of QUALITY_CHECKS.slice(1)) state = updateReviewRating(state, candidate, id, "pass").state;
  state = updateCollectionMetadata(state, candidate, "language", "English").state;
  state = updateCollectionMetadata(state, candidate, "theme", "Rock medley").state;
  assert.equal(setReviewDecision(state, candidate, "approved").ok, false);
  assert.ok(DECISIONS.includes("rejected"));
});

test("explicit approval requires six passes and metadata and later edits demote stale approval", () => {
  const candidate = candidates[0];
  let state = { schemaVersion: 1, entries: {} };
  for (const { id } of QUALITY_CHECKS) state = updateReviewRating(state, candidate, id, "pass").state;
  state = updateCollectionMetadata(state, candidate, "language", "English").state;
  assert.equal(setReviewDecision(state, candidate, "approved").ok, false);
  state = updateCollectionMetadata(state, candidate, "theme", "Artist medley").state;
  assert.equal(setReviewDecision(state, candidate, "approved").ok, true);
  state = setReviewDecision(state, candidate, "approved").state;
  assert.equal(state.entries[candidate.videoId].decision, "approved");
  state = updateReviewRating(state, candidate, "audio", "not-reviewed").state;
  assert.equal(state.entries[candidate.videoId].decision, "needs-another-review");
  assert.equal(hasReviewProgress(state.entries[candidate.videoId]), true);
});

test("local persistence round-trips, while malformed and stale state is ignored safely", () => {
  const candidate = candidates[0];
  let state = { schemaVersion: 1, entries: {} };
  state = updateReviewRating(state, candidate, "audio", "pass", "2026-10-08T12:00:00.000Z").state;
  const roundTrip = loadReviewState(serializeReviewState(state), candidates);
  assert.equal(roundTrip.state.entries[candidate.videoId].ratings.audio, "pass");
  assert.equal(loadReviewState("{broken", candidates).state.entries[candidate.videoId], undefined);
  assert.match(loadReviewState("x".repeat(1024 * 1024 + 1), candidates).warnings.join(" "), /1 MB safety limit/);
  const corrupted = loadReviewState(JSON.stringify({ schemaVersion: 1, entries: [{ ...state.entries[candidate.videoId], title: "Changed identity" }, { videoId: "UnknownID00", title: "x" }] }), candidates);
  assert.equal(Object.keys(corrupted.state.entries).length, 0);
  assert.ok(corrupted.warnings.length > 0);
  assert.equal(REVIEW_STORAGE_KEY, "kantacue.medley-review.v1");
});

test("export/import validates format, identity, duplicate IDs, unknown IDs, and incomplete approvals", () => {
  const candidate = candidates[0];
  const approvedRecord = completeReview(candidate);
  const exportData = createReviewExport({ schemaVersion: 1, entries: { [candidate.videoId]: approvedRecord } }, candidates, "2026-10-08T12:00:00.000Z");
  assert.equal(exportData.format, REVIEW_FORMAT);
  assert.equal(validateReviewExport(exportData, candidates).ok, true);
  assert.equal(validateReviewExport({ ...exportData, reviews: [exportData.reviews[0], exportData.reviews[0]] }, candidates).ok, false);
  assert.equal(validateReviewExport({ ...exportData, reviews: [{ ...exportData.reviews[0], videoId: "UnknownID00" }] }, candidates).ok, false);
  assert.equal(validateReviewExport({ ...exportData, reviews: [{ ...exportData.reviews[0], title: "Forged title" }] }, candidates).ok, false);
  assert.equal(validateReviewExport({ ...exportData, reviews: [{ ...exportData.reviews[0], ratings: { ...exportData.reviews[0].ratings, presentation: "not-reviewed" } }] }, candidates).ok, false);
  assert.equal(validateReviewExport({ ...exportData, schemaVersion: 99 }, candidates).ok, false);
});

test("import never overwrites an existing local decision", () => {
  const candidate = candidates[0];
  const record = completeReview(candidate);
  const merged = mergeImportedReviews({ schemaVersion: 1, entries: { [candidate.videoId]: { ...record, decision: "rejected" } } }, [record]);
  assert.equal(merged.ok, false);
  assert.match(merged.error, /overwrite/i);
});

test("promotion preview accepts only approved safe rows and enforces ID, title, and section collision gates", () => {
  const candidate = candidateById.get("pXe4l-M1MkM");
  const approved = completeReview(candidate);
  const reviewExport = createReviewExport({ schemaVersion: 1, entries: { [candidate.videoId]: approved } }, candidates, "2026-10-08T12:00:00.000Z");
  const valid = buildPromotionPreview({ reviewExport, candidates, existingMedleys: reviewBaselineMedleys, primarySongs: songs });
  assert.equal(valid.ok, true);
  assert.equal(valid.additions.length, 1);
  assert.equal(valid.additions[0].videoId, candidate.videoId);
  assert.equal(valid.additions[0].verification.status, "verified-for-release");
  assert.equal(valid.additions[0].sectionStatus, "unknown");
  assert.match(valid.additions[0].medleyEvidence, /medley/i);

  const noApprovalExport = createReviewExport({ schemaVersion: 1, entries: {} }, candidates, "2026-10-08T12:00:00.000Z");
  const noApproval = buildPromotionPreview({ reviewExport: noApprovalExport, candidates, existingMedleys: reviewBaselineMedleys, primarySongs: songs });
  assert.equal(noApproval.ok, true);
  assert.equal(noApproval.additions.length, 0);

  const collision = buildPromotionPreview({ reviewExport, candidates, existingMedleys: [...reviewBaselineMedleys, { ...reviewBaselineMedleys[0], id: "medley-runtime-collision", videoId: candidate.videoId }], primarySongs: songs });
  assert.equal(collision.ok, false);
  assert.match(collision.errors.join(" "), /video ID already exists/i);

  const duplicateTitle = buildPromotionPreview({ reviewExport, candidates, existingMedleys: [...reviewBaselineMedleys, { ...reviewBaselineMedleys[0], id: "medley-title-collision", title: candidate.title, videoId: "AaBbCcDdEe1" }], primarySongs: songs });
  assert.equal(duplicateTitle.ok, false);
  assert.match(duplicateTitle.errors.join(" "), /title duplicates/i);
});

test("review workspace is local-only, not linked/cached by production shell, and uses one manual official iframe", async () => {
  const [html, script, worker, appHtml] = await Promise.all([
    readFile(new URL("../tools/medley-review.html", import.meta.url), "utf8"),
    readFile(new URL("../tools/medley-review.js", import.meta.url), "utf8"),
    readFile(new URL("../service-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8")
  ]);
  assert.match(html, /noindex, nofollow/);
  assert.match(html, /Local review workspace/);
  assert.doesNotMatch(html, /href="\.\.\/index\.html"/);
  assert.match(html, /id="import-trigger" type="button"/);
  assert.match(script, /import-trigger.*addEventListener\("click"/s);
  assert.match(script, /hasValidReviewHost\(window\.location\)/);
  assert.match(script, /youtube-nocookie\.com\/embed/);
  assert.match(script, /searchParams\.set\("autoplay", "0"\)/);
  assert.match(script, /strict-origin-when-cross-origin/);
  assert.doesNotMatch(script, /navigator\.serviceWorker|YOUTUBE_API_KEY|googleapis\.com|youtube\/v3/i);
  assert.doesNotMatch(worker, /medley-review|medley-expansion/);
  assert.doesNotMatch(appHtml, /medley-review\.html/);
  assert.equal(hasValidReviewHost({ protocol: "http:", hostname: "localhost" }), true);
  assert.equal(hasValidReviewHost({ protocol: "http:", hostname: "127.0.0.1" }), true);
  assert.equal(hasValidReviewHost({ protocol: "https:", hostname: "localhost" }), false);
  assert.equal(hasValidReviewHost({ protocol: "https:", hostname: "kantacue.vercel.app" }), false);
  assert.equal(hasValidReviewHost({ protocol: "http:", hostname: "kantacue.vercel.app" }), false);
});

test("candidate switching retains list keyboard focus and action targets stay touch-sized", async () => {
  const [script, css] = await Promise.all([
    readFile(new URL("../tools/medley-review.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/medley-review.css", import.meta.url), "utf8")
  ]);
  assert.match(script, /candidateList\.contains\(document\.activeElement\)/);
  assert.match(script, /focus\(\{ preventScroll: true \}\)/);
  assert.match(script, /candidate-title.*focus\(\{ preventScroll: true \}\)/s);
  assert.match(script, /iframe\.focus\(\{ preventScroll: true \}\)/);
  assert.match(script, /localStorage\.getItem\(REVIEW_STORAGE_KEY\)[\s\S]{0,220}catch/);
  assert.match(script, /languageInput\.addEventListener\("input"/);
  assert.match(css, /\.decision-actions \.button \{ min-height: 44px/);
});

test("review workflow and preview do not mutate the production catalog or medleys", () => {
  const primaryHash = createHash("sha256").update(JSON.stringify(songs)).digest("hex");
  const medleyHash = createHash("sha256").update(JSON.stringify(medleyData)).digest("hex");
  const preview = buildPromotionPreview({ reviewExport: { format: REVIEW_FORMAT, schemaVersion: 1, reviews: [] }, candidates, existingMedleys: medleyData.medleys, primarySongs: songs });
  assert.equal(preview.additions.length, 0);
  assert.equal(createHash("sha256").update(JSON.stringify(songs)).digest("hex"), primaryHash);
  assert.equal(createHash("sha256").update(JSON.stringify(medleyData)).digest("hex"), medleyHash);
});

test("local review server serves only its read-only allowlist with restrictive headers", async () => {
  async function request(method, url, host = "127.0.0.1:8766") {
    const result = { status: 0, headers: {}, body: undefined };
    const response = {
      writeHead(status, headers) { result.status = status; result.headers = headers; },
      end(body) { result.body = body; }
    };
    await handleMedleyReviewRequest({ method, url, headers: { host } }, response);
    return result;
  }

  const page = await request("GET", "/tools/medley-review.html");
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /Medley Review Workspace/);
  assert.equal(page.headers["Cache-Control"], "no-store");
  assert.equal(page.headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(page.headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.match(page.headers["Content-Security-Policy"], /frame-src https:\/\/www\.youtube-nocookie\.com/);
  assert.equal((await request("HEAD", "/tools/medley-review.css")).status, 200);
  assert.equal((await request("GET", "/package.json")).status, 404);
  assert.equal((await request("GET", "/tools/medley-expansion-runtime-v3.checkpoint.json")).status, 404);
  assert.equal((await request("GET", "/tools/medley-review.html", "attacker.example:8766")).status, 403);
  const mutation = await request("POST", "/data/medleys.sample.json");
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.Allow, "GET, HEAD");
});

test("promotion CLI defaults to a read-only empty preview and leaves production files unchanged", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kantacue-medley-review-"));
  const reviewPath = path.join(tempDir, "empty-review.json");
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const promoter = fileURLToPath(new URL("../tools/promote-medley-review.mjs", import.meta.url));
  const primaryPath = new URL("../data/songs.sample.json", import.meta.url);
  const medleyPath = new URL("../data/medleys.sample.json", import.meta.url);
  try {
    const emptyExport = createReviewExport({ schemaVersion: 1, entries: {} }, candidates, "2026-10-08T12:00:00.000Z");
    await writeFile(reviewPath, `${JSON.stringify(emptyExport)}\n`, "utf8");
    const before = [await readFile(primaryPath), await readFile(medleyPath)];
    const output = execFileSync(process.execPath, [promoter, "--review-file", reviewPath], { cwd: projectRoot, encoding: "utf8" });
  assert.match(output, /0 approved additions; production remains at 31 medleys/i);
    assert.match(output, /No file was written/);
    assert.deepEqual(await readFile(primaryPath), before[0]);
    assert.deepEqual(await readFile(medleyPath), before[1]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
