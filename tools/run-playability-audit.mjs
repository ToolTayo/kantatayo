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
import { summarizeAuditEntries } from "../src/playability-audit.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const STORAGE_KEY = "kantacue:youtube-full-playability-audit:v1";
const DEFAULT_MANIFEST = path.join(ROOT, "tools", "youtube-full-playability-audit.json");
const DEFAULT_RUNTIME_REPORT = path.join(ROOT, "tools", "youtube-full-playability-audit.runtime.json");
const DEFAULT_CHECKPOINT = path.join(ROOT, "tools", "youtube-full-playability-audit.runtime.checkpoint.json");
const CONTROL_IDS = ["sample-029", "sample-486", "sample-001", "sample-002", "sample-003"];
const TERMINAL_STATUSES = new Set(["PASS", "ERROR 2", "ERROR 5", "ERROR 100", "ERROR 101", "ERROR 150", "ERROR 153", "TIMEOUT", "AUTOPLAY POLICY ONLY", "INCONCLUSIVE", "UNAVAILABLE"]);

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
  --per-song-timeout MS     Maximum wait for one browser row (default: 45000).
  --concurrency N           Low safe browser-page concurrency, capped at 3 (default: 3).
  --resume                  Keep prior local audit results instead of clearing them.
  --visible                 Use a visible browser window; headless is the default.
  --help                    Show this help.

The control gate runs first. The full catalog is attempted only if at least one
control reaches PASS with onReady, PLAYING, advancing currentTime, and 15s of
sustained playback. Timeout and inconclusive results are never promoted to PASS.

Playwright must already be available. Set KANTACUE_PLAYWRIGHT_MODULE to its
package directory or index.mjs when it is not resolvable as the normal package.
`);
  process.exit(0);
}

const manifestPath = path.resolve(ROOT, args.manifest || DEFAULT_MANIFEST);
const outputPath = path.resolve(ROOT, args.output || DEFAULT_RUNTIME_REPORT);
const checkpointPath = path.resolve(ROOT, args.checkpoint || DEFAULT_CHECKPOINT);
const perSongTimeout = Math.max(35_000, Number(args.perSongTimeout) || 45_000);
const concurrency = Math.min(3, Math.max(1, Number(args.concurrency) || 3));

try {
  const { chromium } = await loadPlaywright();
  const manifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : await buildPlayabilityAudit({ outputPath: manifestPath });
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error("The playability manifest has no valid entries.");

  const localServer = args.url ? null : await startStaticServer(ROOT);
  const auditUrl = args.url || `${localServer.url}/youtube-playability-audit.html?dev=1${args.pageManifest ? `&manifest=${encodeURIComponent(toWebPath(args.pageManifest))}` : ""}`;
  const workerUrl = (worker) => { const url = new URL(auditUrl); url.searchParams.set("worker", worker); return url.href; };
  const browser = await chromium.launch({
    headless: !args.visible,
    args: ["--autoplay-policy=no-user-gesture-required"]
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const diagnostics = { consoleErrors: [], pageErrors: [], requestFailures: [] };
  attachDiagnostics(page, diagnostics);
  const checkpoint = args.resume && existsSync(checkpointPath) ? JSON.parse(await readFile(checkpointPath, "utf8")) : null;
  await preparePage(page, workerUrl("main"), checkpoint, `${STORAGE_KEY}:main`);

  const results = [];
  for (const songId of CONTROL_IDS) {
    results.push(await runSong(page, songId, perSongTimeout, true));
    await writeCheckpoint(page, checkpointPath);
  }
  const controlPasses = results.filter((result) => result.status === "PASS");
  console.log("CONTROL TESTS");
  for (const result of results) console.log(`${result.songId} | ${result.status} | ${result.videoId}${result.errorCode ? ` | error ${result.errorCode}` : ""}`);

  if (!controlPasses.length) {
    const report = await collectRuntimeReport([page], manifest, diagnostics, "CONTROL_GATE_FAILED");
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`CONTROL GATE FAILED: no control reached PASS; full catalog was not started.`);
    console.log(`Runtime report: ${path.relative(ROOT, outputPath)}`);
    await browser.close();
    localServer?.close();
    process.exitCode = 3;
  } else {
    const pages = [page];
    for (let index = 1; index < concurrency; index += 1) {
      const extraPage = await context.newPage();
      attachDiagnostics(extraPage, diagnostics);
      // Worker pages only need fresh rows for entries assigned to them. Loading
      // the shared checkpoint into every page can let stale results overwrite a
      // newer control/candidate result when reports are merged at the end.
      await preparePage(extraPage, workerUrl(`worker-${index}`), null, `${STORAGE_KEY}:worker-${index}`);
      pages.push(extraPage);
    }
    const controlSet = new Set(CONTROL_IDS);
    const pendingEntries = [];
    for (const entry of manifest.entries) {
      if (controlSet.has(entry.songId)) continue;
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
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    printSummary(report);
    await browser.close();
    localServer?.close();
  }
} catch (error) {
  console.error(`playability audit runner unavailable: ${error.message || error}`);
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
    await page.waitForFunction((id) => {
      const row = [...document.querySelectorAll("tbody[data-candidate-rows] tr")].find((candidate) => candidate.children[0]?.textContent?.trim() === id);
      const status = row?.querySelector("[data-result]")?.textContent?.trim();
      return status && ["PASS", "ERROR 2", "ERROR 5", "ERROR 100", "ERROR 101", "ERROR 150", "ERROR 153", "TIMEOUT", "AUTOPLAY POLICY ONLY", "INCONCLUSIVE"].includes(status);
    }, songId, { timeout });
  } catch {
    await page.evaluate(({ id }) => {
      const key = window.__KANTACUE_PLAYABILITY_STORAGE_KEY__ || "kantacue:youtube-full-playability-audit:v1";
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : { version: 1, results: {} };
      parsed.results = parsed.results || {};
      parsed.results[id] = { ...(parsed.results[id] || {}), iframeStatus: "TIMEOUT", failureClassification: "AUTOMATION_WAIT_TIMEOUT", note: "The browser runner stopped waiting before the page produced a terminal result.", testedAt: new Date().toISOString() };
      window.localStorage.setItem(key, JSON.stringify(parsed));
    }, { id: songId });
  }

  const final = await page.evaluate((id) => {
    const row = [...document.querySelectorAll("tbody[data-candidate-rows] tr")].find((candidate) => candidate.children[0]?.textContent?.trim() === id);
    const status = row?.querySelector("[data-result]")?.textContent?.trim() || "INCONCLUSIVE";
    const title = row?.children[1]?.textContent?.trim() || "";
    const videoId = row?.children[3]?.textContent?.trim() || "";
    const key = window.__KANTACUE_PLAYABILITY_STORAGE_KEY__ || "kantacue:youtube-full-playability-audit:v1";
    const raw = window.localStorage.getItem(key);
    const stored = raw ? JSON.parse(raw) : { results: {} };
    return { songId: id, status, title, videoId, errorCode: stored.results?.[videoId]?.errorCode || null };
  }, songId);
  if (isControl) console.log(`${final.songId} | ${final.status}`);
  return final;
}

async function collectRuntimeReport(pages, manifest, diagnostics, auditStatus) {
  const stored = await collectStoredResults(pages);
  const entries = manifest.entries.map((entry) => stored.results?.[entry.videoId] ? { ...entry, ...stored.results[entry.videoId] } : entry);
  const complete = entries.every((entry) => ["PASS", "ERROR 2", "ERROR 5", "ERROR 100", "ERROR 101", "ERROR 150", "ERROR 153", "TIMEOUT", "AUTOPLAY POLICY ONLY", "INCONCLUSIVE", "UNAVAILABLE"].includes(entry.iframeStatus));
  return {
    ...manifest,
    generatedAt: new Date().toISOString(),
    auditStatus: complete ? "COMPLETE" : auditStatus,
    runtime: { environment: "Playwright Chromium through the real audit page", diagnostics },
    counts: summarizeAuditEntries(entries),
    entries
  };
}

async function writeCheckpoint(page, checkpointPath) {
  const payload = await page.evaluate(() => {
    try { return JSON.parse(window.localStorage.getItem(window.__KANTACUE_PLAYABILITY_STORAGE_KEY__ || "kantacue:youtube-full-playability-audit:v1") || "{}"); } catch { return {}; }
  });
  await writeFile(checkpointPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeCombinedCheckpoint(pages, checkpointPath) {
  const payload = await collectStoredResults(pages);
  await writeFile(checkpointPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function collectStoredResults(pages) {
  const results = {};
  for (const page of pages) {
    const stored = await page.evaluate(() => {
      try { return JSON.parse(window.localStorage.getItem(window.__KANTACUE_PLAYABILITY_STORAGE_KEY__ || "kantacue:youtube-full-playability-audit:v1") || "{}"); } catch { return {}; }
    });
    for (const [videoId, result] of Object.entries(stored.results || {})) {
      const previous = results[videoId];
      const resultTime = Date.parse(result?.testedAt || "") || 0;
      const previousTime = Date.parse(previous?.testedAt || "") || 0;
      if (!previous || resultTime >= previousTime) results[videoId] = result;
    }
  }
  return { version: 1, results };
}

function attachDiagnostics(page, diagnostics) {
  page.on("console", (message) => { if (message.type() === "error") diagnostics.consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(String(error?.message || error)));
  page.on("requestfailed", (request) => diagnostics.requestFailures.push(`${request.url()} :: ${request.failure()?.errorText || "failed"}`));
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
  return page.evaluate((id) => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(window.__KANTACUE_PLAYABILITY_STORAGE_KEY__ || "kantacue:youtube-full-playability-audit:v1") || "{}");
      const status = stored.results?.[id]?.iframeStatus;
      return ["PASS", "ERROR 2", "ERROR 5", "ERROR 100", "ERROR 101", "ERROR 150", "ERROR 153", "TIMEOUT", "AUTOPLAY POLICY ONLY", "INCONCLUSIVE", "UNAVAILABLE"].includes(status);
    } catch { return false; }
  }, videoId);
}

function printSummary(report) {
  const counts = report.counts;
  console.log(`FULL CATALOG | total ${counts.total} | PASS ${counts.confirmedPlayable} | errors ${counts.errors} | unavailable ${counts.unavailable} | timeout ${counts.timeouts} | autoplay ${counts.autoplayPolicyOnly} | inconclusive ${counts.ambiguous}`);
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
  const parsed = { resume: false, visible: false, help: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help") parsed.help = true;
    else if (value === "--resume") parsed.resume = true;
    else if (value === "--visible") parsed.visible = true;
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
