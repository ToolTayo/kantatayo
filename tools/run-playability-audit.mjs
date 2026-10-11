#!/usr/bin/env node

/**
 * Development-only Playwright runner for the full KantaCue runtime audit.
 *
 * This intentionally drives youtube-playability-audit.html instead of creating
 * another iframe. The page therefore uses the same src/youtube.js controller
 * as the product. It stops before the catalog run unless a control video has
 * actually reached PASS.
 */

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPlayabilityAudit } from "./build-playability-audit.mjs";
import { applyValidatedControlGate, evaluateSustainedPlayback, summarizeAuditEntries } from "../src/playability-audit.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const STORAGE_KEY = "kantacue:youtube-full-playability-audit:v2";
const DEFAULT_MANIFEST = path.join(ROOT, "tools", "youtube-full-playability-audit.json");
const DEFAULT_RUNTIME_REPORT = path.join(ROOT, "tools", "youtube-full-playability-audit.runtime.json");
const DEFAULT_CHECKPOINT = path.join(ROOT, "tools", "youtube-full-playability-audit.runtime.checkpoint.json");
const CONTROL_ID = "sample-029";
const CONTROL_VIDEO_ID = "QBb9wO3Bj0k";
const CONTROL_RUNS_REQUIRED = 3;
const TERMINAL_STATUSES = new Set(["PASS", "ERROR 2", "ERROR 5", "ERROR 100", "ERROR 101", "ERROR 150", "ERROR 153", "TIMEOUT", "READY-ONLY", "AUTOPLAY POLICY ONLY", "PLAYING WITHOUT PROGRESSION", "INCONCLUSIVE", "ENVIRONMENT FAILURE", "CONTROL FAILURE", "UNAVAILABLE"]);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: node tools/run-playability-audit.mjs [options]

Starts a local server and automatically drives the real KantaCue YouTube
controller through a Playwright Chromium browser.

Options:
  --url URL                 Use an existing audit URL instead of starting a server.
  --output PATH             Runtime report path (default: ${path.relative(ROOT, DEFAULT_RUNTIME_REPORT)}).
  --manifest PATH           Preflight manifest path (default: ${path.relative(ROOT, DEFAULT_MANIFEST)}).
  --page-manifest PATH      JSON manifest fetched by the local audit page (development-only).
  --checkpoint PATH         Isolated browser result checkpoint (default: tools/youtube-full-playability-audit.runtime.checkpoint.json).
  --per-song-timeout MS     Maximum wait for one browser row (default: 60000).
  --concurrency N           Low safe browser-page concurrency, capped at 3 (default: 3).
  --control-only            Run the three independent sample-029 controls and stop.
  KANTACUE_PLAYWRIGHT_EXECUTABLE  Optional path to an already-installed Chromium-based browser.
  --resume                  Keep prior local audit results instead of clearing them.
  --visible                 Use a visible browser window; headless is the default.
  --help                    Show this help.

The control gate runs first. Three isolated sample-029 player runs must each
reach onReady, PLAYING, advancing currentTime, and 15 seconds of sustained
playback before any catalog/candidate audit starts. Timeout and inconclusive
results are never promoted to PASS.

Playwright must already be available. Set KANTACUE_PLAYWRIGHT_MODULE to its
package directory or index.mjs when it is not resolvable as the normal package.
`);
  process.exit(0);
}

const manifestPath = path.resolve(ROOT, args.manifest || DEFAULT_MANIFEST);
const outputPath = path.resolve(ROOT, args.output || DEFAULT_RUNTIME_REPORT);
const checkpointPath = path.resolve(ROOT, args.checkpoint || DEFAULT_CHECKPOINT);
const perSongTimeout = Math.max(35_000, Number(args.perSongTimeout) || 60_000);
const concurrency = Math.min(3, Math.max(1, Number(args.concurrency) || 3));

let localServer = null;
let activeBrowser = null;
try {
  const { chromium } = await loadPlaywright();
  const manifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : await buildPlayabilityAudit({ outputPath: manifestPath });
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error("The playability manifest has no valid entries.");
  const controlEntry = manifest.entries.find((entry) => entry.songId === CONTROL_ID);
  if (!controlEntry || controlEntry.videoId !== CONTROL_VIDEO_ID) throw new Error(`${CONTROL_ID} must resolve to the protected known-good control video ${CONTROL_VIDEO_ID}.`);

  localServer = args.url ? null : await startStaticServer(ROOT);
  const auditUrl = args.url || `${localServer.url}/youtube-playability-audit.html?dev=1${args.pageManifest ? `&manifest=${encodeURIComponent(toWebPath(args.pageManifest))}` : ""}`;
  const workerUrl = (worker) => { const url = new URL(auditUrl); url.searchParams.set("worker", worker); return url.href; };
  const launchOptions = {
    headless: !args.visible,
    args: ["--autoplay-policy=no-user-gesture-required"]
  };
  if (process.env.KANTACUE_PLAYWRIGHT_EXECUTABLE) {
    launchOptions.executablePath = process.env.KANTACUE_PLAYWRIGHT_EXECUTABLE;
  }
  const diagnostics = { consoleErrors: [], pageErrors: [], requestFailures: [], expectedRequestAbortCount: 0 };
  const checkpointFile = args.resume && existsSync(checkpointPath) ? JSON.parse(await readFile(checkpointPath, "utf8")) : null;
  const checkpoint = checkpointFile?.evidenceVersion === 2 && checkpointFile?.version === 2 ? checkpointFile : null;
  if (args.resume && checkpointFile && !checkpoint) console.warn("Ignoring an older runtime checkpoint because it predates the current stricter playback evidence rules.");
  const controlRuns = [];
  let browser = null;
  let context = null;
  let page = null;
  let browserVersion = null;

  for (let runIndex = 0; runIndex < CONTROL_RUNS_REQUIRED; runIndex += 1) {
    browser = await chromium.launch(launchOptions);
    activeBrowser = browser;
    browserVersion = browser.version?.() || browserVersion;
    context = await browser.newContext();
    page = await context.newPage();
    attachDiagnostics(page, diagnostics);
    await preparePage(page, workerUrl(`control-${runIndex + 1}`), null, `${STORAGE_KEY}:control-${runIndex + 1}`);
    const result = await runSong(page, CONTROL_ID, perSongTimeout, true);
    const validation = validateControlEvidence(result);
    controlRuns.push({ run: runIndex + 1, independentBrowserContext: true, independentBrowserProcess: true, ...result, validation });
    console.log(`CONTROL ${runIndex + 1}/${CONTROL_RUNS_REQUIRED} | ${CONTROL_ID} | ${validation.status} | ${result.videoId}${result.errorCode ? ` | error ${result.errorCode}` : ""}`);
    if (runIndex < CONTROL_RUNS_REQUIRED - 1) {
      await browser.close();
      browser = null;
      activeBrowser = null;
      context = null;
      page = null;
    }
  }

  const controlGatePassed = controlRuns.length === CONTROL_RUNS_REQUIRED && controlRuns.every((run) => run.validation.status === "PASS");
  const controlGate = { status: controlGatePassed ? "PASS" : "CONTROL FAILURE", controlSongId: CONTROL_ID, requiredIndependentRuns: CONTROL_RUNS_REQUIRED, runs: controlRuns };
  console.log(`CONTROL GATE | ${controlGate.status} | ${controlRuns.filter((run) => run.validation.status === "PASS").length}/${CONTROL_RUNS_REQUIRED} independent sustained runs`);

  if (!controlGatePassed || args.controlOnly) {
    const report = buildControlReport(manifest, controlGate, diagnostics, browserVersion);
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Runtime report: ${path.relative(ROOT, outputPath)}`);
    if (!controlGatePassed) process.exitCode = 3;
  } else {
    context = await browser.newContext();
    page = await context.newPage();
    attachDiagnostics(page, diagnostics);
    await preparePage(page, workerUrl("main"), checkpoint, `${STORAGE_KEY}:main`);
    const pages = [page];
    for (let index = 1; index < concurrency; index += 1) {
      const extraPage = await context.newPage();
      attachDiagnostics(extraPage, diagnostics);
      await preparePage(extraPage, workerUrl(`worker-${index}`), null, `${STORAGE_KEY}:worker-${index}`);
      pages.push(extraPage);
    }
    const pendingEntries = [];
    for (const entry of manifest.entries) {
      if (entry.songId === CONTROL_ID) continue;
      if (entry.iframeStatus === "UNAVAILABLE" || !entry.videoId) continue;
      if (args.resume && await hasRecordedResult(page, entry.videoId)) continue;
      pendingEntries.push(entry);
    }
    const work = pages.map(() => []);
    pendingEntries.forEach((entry, index) => work[index % pages.length].push(entry));
    await Promise.all(pages.map(async (workerPage, index) => {
      for (const entry of work[index]) {
        const result = await runSong(workerPage, entry.songId, perSongTimeout, false);
        console.log(`${result.songId} | ${result.status}${result.errorCode ? ` | error ${result.errorCode}` : ""}`);
        await writeCombinedCheckpoint(pages, checkpointPath);
      }
    }));
    const report = await collectRuntimeReport(pages, manifest, diagnostics, "COMPLETE_OR_PARTIAL");
    report.entries = applyValidatedControlGate(report.entries, controlGate, CONTROL_ID, CONTROL_VIDEO_ID);
    report.counts = summarizeAuditEntries(report.entries);
    report.runtime.controlGate = controlGate;
    report.runtime.browserVersion = browserVersion;
    report.runtime.browserExecutable = path.basename(process.env.KANTACUE_PLAYWRIGHT_EXECUTABLE || "Playwright bundled Chromium");
    report.runtime.headless = !args.visible;
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    printSummary(report);
  }
  if (browser) await browser.close();
  activeBrowser = null;
  localServer?.close();
  localServer = null;
} catch (error) {
  try { await activeBrowser?.close(); } catch { /* best-effort browser cleanup after a runner failure */ }
  try { localServer?.close(); } catch { /* best-effort local server cleanup after a runner failure */ }
  console.error(`ENVIRONMENT FAILURE: playability audit runner could not launch or drive its existing browser runtime: ${error.message || error}`);
  process.exitCode = 2;
}

async function runSong(page, songId, timeout, isControl) {
  const result = await page.evaluate((id) => {
    const rows = [...document.querySelectorAll("tbody[data-candidate-rows] tr")];
    const row = rows.find((candidate) => candidate.children[0]?.textContent?.trim() === id);
    if (!row) return { songId: id, status: "INCONCLUSIVE", note: "Song row is missing from the audit page." };
    const button = row.querySelector('button[data-action="test"]');
    button?.click();
    return { songId: id, status: "LOADING" };
  }, songId);
  if (result.status === "INCONCLUSIVE") return result;

  try {
    await page.waitForFunction(({ id, terminalStatuses }) => {
      const row = [...document.querySelectorAll("tbody[data-candidate-rows] tr")].find((candidate) => candidate.children[0]?.textContent?.trim() === id);
      const status = row?.querySelector("[data-result]")?.textContent?.trim();
      return status && terminalStatuses.includes(status);
    }, { id: songId, terminalStatuses: [...TERMINAL_STATUSES] }, { timeout });
  } catch {
    await page.evaluate(({ id }) => {
      const key = window.__KANTACUE_PLAYABILITY_STORAGE_KEY__ || "kantacue:youtube-full-playability-audit:v2";
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : { version: 2, evidenceVersion: 2, results: {} };
      parsed.results = parsed.results || {};
      parsed.results[id] = { ...(parsed.results[id] || {}), iframeStatus: "TIMEOUT", failureClassification: "AUTOMATION_WAIT_TIMEOUT", note: "The browser runner stopped waiting before the page produced a terminal result.", testedAt: new Date().toISOString() };
      window.localStorage.setItem(key, JSON.stringify(parsed));
    }, { id: songId });
  }

  const final = await page.evaluate((id) => {
    const row = [...document.querySelectorAll("tbody[data-candidate-rows] tr")].find((candidate) => candidate.children[0]?.textContent?.trim() === id);
    const rowStatus = row?.querySelector("[data-result]")?.textContent?.trim() || "INCONCLUSIVE";
    const title = row?.children[1]?.textContent?.trim() || "";
    const videoId = row?.children[3]?.textContent?.trim() || "";
    const key = window.__KANTACUE_PLAYABILITY_STORAGE_KEY__ || "kantacue:youtube-full-playability-audit:v2";
    const raw = window.localStorage.getItem(key);
    const stored = raw ? JSON.parse(raw) : { results: {} };
    const storedResult = stored.results?.[videoId] || {};
    const status = storedResult.iframeStatus || rowStatus;
    return { songId: id, status, title, videoId, errorCode: storedResult.errorCode || null, failureClassification: storedResult.failureClassification || null, note: storedResult.note || "", testedAt: storedResult.testedAt || null, trace: Array.isArray(storedResult.trace) ? storedResult.trace : [], browserEnvironment: { userAgent: navigator.userAgent, origin: location.origin, visibilityState: document.visibilityState } };
  }, songId);
  if (isControl) console.log(`${final.songId} | ${final.status}`);
  return final;
}

function validateControlEvidence(result) {
  const trace = Array.isArray(result?.trace) ? result.trace : [];
  const readyObserved = trace.some((entry) => entry.kind === "onReady");
  const playingObserved = trace.some((entry) => entry.kind === "state-change" && Number(entry.detail) === 1);
  const playerIdentityMatched = trace.some((entry) => entry.kind === "playback-sample" && entry.iframeConnected && entry.playerReady && entry.playerVideoId === CONTROL_VIDEO_ID && entry.loadedVideoId === CONTROL_VIDEO_ID);
  const samples = trace.filter((entry) => entry.kind === "playback-sample").map((entry) => ({ elapsedMs: entry.playbackElapsedMs, currentTime: entry.currentTime, visibilityState: entry.visibilityState, playerVideoId: entry.playerVideoId, loadedVideoId: entry.loadedVideoId, playerReady: entry.playerReady, iframeConnected: entry.iframeConnected }));
  const elapsedMs = Math.max(0, ...samples.map((sample) => Number(sample.elapsedMs) || 0));
  const evidence = evaluateSustainedPlayback({ elapsedMs, samples, visibilityTrace: trace.map((entry) => entry.visibilityState), expectedVideoId: CONTROL_VIDEO_ID });
  const missing = [];
  if (!readyObserved) missing.push("onReady was not captured");
  if (!playingObserved) missing.push("PLAYING was not captured");
  if (!playerIdentityMatched) missing.push("the active official iframe identity did not match the control video");
  if (result?.status !== "PASS") missing.push(`the audit page result was ${result?.status || "missing"}`);
  if (evidence.status !== "PASS") missing.push(evidence.reason);
  const status = missing.length ? (result?.status === "TIMEOUT" ? "TIMEOUT" : "CONTROL FAILURE") : "PASS";
  return { status, readyObserved, playingObserved, playerIdentityMatched, playbackEvidence: evidence, failureReasons: missing };
}

function buildControlReport(manifest, controlGate, diagnostics, browserVersion) {
  const entries = manifest.entries.map((entry) => {
    if (entry.songId !== CONTROL_ID) return entry;
    const latestRun = controlGate.runs.at(-1);
    return {
      ...entry,
      iframeStatus: latestRun?.status === "PASS" && latestRun?.validation?.status !== "PASS" ? "CONTROL FAILURE" : latestRun?.status || "CONTROL FAILURE",
      errorCode: latestRun?.errorCode ?? null,
      failureClassification: latestRun?.failureClassification || latestRun?.validation?.status || "CONTROL_FAILURE",
      note: latestRun?.note || latestRun?.validation?.failureReasons?.join("; ") || "",
      trace: latestRun?.trace || [],
      testedAt: latestRun?.testedAt || new Date().toISOString()
    };
  });
  return {
    ...manifest,
    generatedAt: new Date().toISOString(),
    auditStatus: controlGate.status === "PASS" ? "CONTROL_GATE_PASSED" : "CONTROL_GATE_FAILED",
    runtime: { environment: "Playwright Chromium through KantaCue's real audit page/controller", browserVersion, browserExecutable: path.basename(process.env.KANTACUE_PLAYWRIGHT_EXECUTABLE || "Playwright bundled Chromium"), headless: !args.visible, controlGate, diagnostics },
    counts: summarizeAuditEntries(entries),
    entries
  };
}

async function collectRuntimeReport(pages, manifest, diagnostics, auditStatus) {
  const stored = await collectStoredResults(pages);
  const entries = manifest.entries.map((entry) => stored.results?.[entry.videoId] ? { ...entry, ...stored.results[entry.videoId] } : entry);
  const complete = entries.every((entry) => TERMINAL_STATUSES.has(entry.iframeStatus));
  return {
    ...manifest,
    generatedAt: new Date().toISOString(),
    auditStatus: complete ? "COMPLETE" : auditStatus,
    runtime: { environment: "Playwright Chromium through KantaCue's real audit page/controller", diagnostics },
    counts: summarizeAuditEntries(entries),
    entries
  };
}

async function writeCombinedCheckpoint(pages, checkpointPath) {
  const payload = await collectStoredResults(pages);
  await writeFile(checkpointPath, `${JSON.stringify({ ...payload, version: 2, evidenceVersion: 2 }, null, 2)}\n`, "utf8");
}

async function collectStoredResults(pages) {
  const results = {};
  for (const page of pages) {
    const stored = await page.evaluate(() => {
      try { return JSON.parse(window.localStorage.getItem(window.__KANTACUE_PLAYABILITY_STORAGE_KEY__ || "kantacue:youtube-full-playability-audit:v2") || "{}"); } catch { return {}; }
    });
    for (const [videoId, result] of Object.entries(stored.results || {})) {
      const previous = results[videoId];
      const resultTime = Date.parse(result?.testedAt || "") || 0;
      const previousTime = Date.parse(previous?.testedAt || "") || 0;
      if (!previous || resultTime >= previousTime) results[videoId] = result;
    }
  }
  return { version: 2, evidenceVersion: 2, results };
}

function attachDiagnostics(page, diagnostics) {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location?.() || {};
    diagnostics.consoleErrors.push({ text: message.text(), url: location.url || null, line: location.lineNumber ?? null });
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(String(error?.message || error)));
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText || "failed";
    if (errorText === "net::ERR_ABORTED") {
      diagnostics.expectedRequestAbortCount += 1;
      return;
    }
    diagnostics.requestFailures.push(`${request.url()} :: ${errorText}`);
  });
}

async function preparePage(page, auditUrl, checkpoint, storageKey) {
  await page.addInitScript(({ key, resumePayload }) => {
    if (resumePayload?.results) window.localStorage.setItem(key, JSON.stringify(resumePayload));
    else window.localStorage.removeItem(key);
  }, { key: storageKey, resumePayload: checkpoint });
  await page.goto(auditUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("[data-audit-app]").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("tbody[data-candidate-rows] tr").first().waitFor({ state: "visible", timeout: 20_000 });
}

async function hasRecordedResult(page, videoId) {
  return page.evaluate(({ id, terminalStatuses }) => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(window.__KANTACUE_PLAYABILITY_STORAGE_KEY__ || "kantacue:youtube-full-playability-audit:v2") || "{}");
      const status = stored.results?.[id]?.iframeStatus;
      return terminalStatuses.includes(status);
    } catch { return false; }
  }, { id: videoId, terminalStatuses: [...TERMINAL_STATUSES] });
}

function printSummary(report) {
  const counts = report.counts;
  console.log(`AUDIT | total ${counts.total} | PASS ${counts.confirmedPlayable} | errors ${counts.errors} | unavailable ${counts.unavailable} | timeout ${counts.timeouts} | ready-only ${counts.readyOnly} | autoplay-only ${counts.autoplayPolicyOnly} | playing-without-progression ${counts.playingWithoutProgression} | unresolved ${counts.ambiguous}`);
  console.log(`Runtime report: ${path.relative(ROOT, outputPath)}`);
}

async function loadPlaywright() {
  const candidates = [process.env.KANTACUE_PLAYWRIGHT_MODULE, "playwright"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (candidate === "playwright") return await import(candidate);
      const packagePath = existsSync(candidate) && statSync(candidate).isDirectory() ? path.join(candidate, "index.mjs") : candidate;
      return await import(pathToFileURL(path.resolve(packagePath)).href);
    } catch { /* try the next local runtime */ }
  }
  throw new Error("Playwright is not resolvable. Install/use an existing Playwright runtime or set KANTACUE_PLAYWRIGHT_MODULE; no audit was run.");
}

async function startStaticServer(root) {
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
      const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
      const filePath = path.resolve(root, relative);
      if (!filePath.startsWith(root + path.sep)) return response.writeHead(403).end();
      const contents = await readFile(filePath);
      response.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" }).end(contents);
    } catch { response.writeHead(404).end("Not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

function contentType(filePath) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" })[path.extname(filePath)] || "application/octet-stream";
}

function toWebPath(filePath) {
  const absolute = path.resolve(ROOT, filePath);
  if (!absolute.startsWith(ROOT + path.sep)) throw new Error("--page-manifest must be inside the repository.");
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

function parseArgs(values) {
  const parsed = { resume: false, visible: false, help: false, controlOnly: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help") parsed.help = true;
    else if (value === "--resume") parsed.resume = true;
    else if (value === "--visible") parsed.visible = true;
    else if (value === "--control-only") parsed.controlOnly = true;
    else if (value === "--url") parsed.url = values[++index];
    else if (value === "--output") parsed.output = values[++index];
    else if (value === "--manifest") parsed.manifest = values[++index];
    else if (value === "--page-manifest") parsed.pageManifest = values[++index];
    else if (value === "--checkpoint") parsed.checkpoint = values[++index];
    else if (value === "--per-song-timeout") parsed.perSongTimeout = values[++index];
    else if (value === "--concurrency") parsed.concurrency = values[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}
