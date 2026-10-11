import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMedleys } from "../src/medleys.js";
import {
  EVIDENCE_REPORT_FILES,
  RUNTIME_REPORT_FILES,
  buildPromotionPreview,
  buildReviewCandidates
} from "./medley-review-core.mjs";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(TOOL_DIR);
const MEDLEY_FILE = path.join(ROOT_DIR, "data", "medleys.sample.json");
const SONG_FILE = path.join(ROOT_DIR, "data", "songs.sample.json");
const RESEARCH_FILE = path.join(TOOL_DIR, "medley-expansion-research-v5.json");

function parseArgs(argv) {
  const result = { reviewFile: "", apply: false, digest: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--review-file") result.reviewFile = argv[++index] || "";
    else if (argument === "--apply") result.apply = true;
    else if (argument === "--confirm-digest") result.digest = argv[++index] || "";
    else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return result;
}

function usage() {
  return [
    "Safe medley promotion preview (default; writes nothing):",
    "  node tools/promote-medley-review.mjs --review-file <export.json>",
    "",
    "Explicit apply requires the exact digest printed by preview:",
    "  node tools/promote-medley-review.mjs --review-file <export.json> --apply --confirm-digest <sha256>",
    "",
    "Only explicitly approved, six-check-passing, schema-valid candidates are eligible."
  ].join("\n");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function calculateDigest(currentData, additions) {
  const payload = JSON.stringify({ current: currentData, additions });
  return createHash("sha256").update(payload).digest("hex");
}

async function loadInputs(reviewFile) {
  const [reviewExport, researchReport, medleyData, songs, ...sources] = await Promise.all([
    readJson(reviewFile),
    readJson(RESEARCH_FILE),
    readJson(MEDLEY_FILE),
    readJson(SONG_FILE),
    ...RUNTIME_REPORT_FILES.map(async (name) => ({ name, data: await readJson(path.join(TOOL_DIR, name)) })),
    ...EVIDENCE_REPORT_FILES.map(async (name) => ({ name, data: await readJson(path.join(TOOL_DIR, name)) }))
  ]);
  const runtimeReports = sources.slice(0, RUNTIME_REPORT_FILES.length);
  const evidenceReports = sources.slice(RUNTIME_REPORT_FILES.length);
  const candidates = buildReviewCandidates({ researchReport, runtimeReports, evidenceReports, existingMedleys: medleyData.medleys, primarySongs: songs });
  return { reviewExport, candidates, medleyData, songs };
}

export async function buildDiskPromotionPreview(reviewFile) {
  const inputs = await loadInputs(reviewFile);
  const preview = buildPromotionPreview({
    reviewExport: inputs.reviewExport,
    candidates: inputs.candidates,
    existingMedleys: inputs.medleyData.medleys,
    primarySongs: inputs.songs
  });
  if (!preview.ok) return { ...preview, additions: [], currentMedleyCount: inputs.medleyData.medleys.length };
  const validation = normalizeMedleys({ medleys: [...inputs.medleyData.medleys, ...preview.additions] }, { logger: { warn() {} } });
  if (validation.warnings.length || validation.medleys.length !== inputs.medleyData.medleys.length + preview.additions.length) {
    return { ...preview, ok: false, additions: [], errors: [...preview.errors, ...validation.warnings, "Proposed records failed the production medley normalizer."] };
  }
  return { ...preview, currentMedleyCount: inputs.medleyData.medleys.length, finalMedleyCount: validation.medleys.length };
}

async function replaceFileSafely(destination, text) {
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, "wx");
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    JSON.parse(await readFile(tempPath, "utf8"));
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rename(tempPath, destination);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!new Set(["EPERM", "EBUSY", "EACCES"]).has(error?.code) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.reviewFile) throw new Error("--review-file is required.\n" + usage());
  const reviewFile = path.resolve(process.cwd(), args.reviewFile);
  const preview = await buildDiskPromotionPreview(reviewFile);
  if (!preview.ok) {
    console.error("PROMOTION PREVIEW BLOCKED");
    for (const error of preview.errors) console.error(`- ${error}`);
    process.exitCode = 2;
    return;
  }
  if (preview.additions.length === 0) {
    console.log(`Promotion preview: 0 approved additions; production remains at ${preview.currentMedleyCount} medleys. No file was written.`);
    if (args.apply) throw new Error("There are no approved candidates to apply.");
    return;
  }

  const medleyData = await readJson(MEDLEY_FILE);
  const digest = calculateDigest(medleyData, preview.additions);
  console.log(`Current production medleys: ${preview.currentMedleyCount}`);
  console.log(`Explicitly approved candidates: ${preview.approvedCount}`);
  console.log(`Proposed new medleys: ${preview.additions.length}`);
  console.log(`Final count if applied: ${preview.finalMedleyCount}`);
  console.log(JSON.stringify(preview.additions, null, 2));
  console.log(`Preview digest: ${digest}`);

  if (!args.apply) {
    console.log("PREVIEW ONLY — no production file was written.");
    return;
  }
  if (args.digest !== digest) throw new Error("Apply blocked: --confirm-digest must exactly match the current preview digest.");

  const latest = await buildDiskPromotionPreview(reviewFile);
  const latestData = await readJson(MEDLEY_FILE);
  const latestDigest = calculateDigest(latestData, latest.additions);
  if (!latest.ok || latestDigest !== args.digest) throw new Error("Apply blocked: review, data, or preview changed after confirmation.");
  const updated = { ...latestData, medleys: [...latestData.medleys, ...latest.additions] };
  const normalized = normalizeMedleys(updated, { logger: { warn() {} } });
  if (normalized.warnings.length || normalized.medleys.length !== updated.medleys.length) {
    throw new Error(`Apply blocked by production schema validation: ${normalized.warnings.join("; ")}`);
  }
  await replaceFileSafely(MEDLEY_FILE, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`APPLIED ${latest.additions.length} medley addition(s). Production now contains ${updated.medleys.length}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Promotion tool failed safely: ${error.message}`);
    process.exitCode = 1;
  });
}
