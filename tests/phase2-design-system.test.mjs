import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../styles/main.css", import.meta.url), "utf8");
const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");

test("design system has one semantic token source", () => {
  assert.equal((css.match(/(^|\n):root\s*\{/g) ?? []).length, 1);
  assert.match(css, /--brand-lime:\s*#a3f263/);
  assert.match(css, /--control-height:\s*2\.75rem/);
  assert.match(css, /--focus-ring:\s*2px solid var\(--brand-lime\)/);
});

test("song and catalog grids use content-aware responsive sizing", () => {
  assert.match(css, /\.song-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 16rem\), 1fr\)\)/s);
  assert.match(css, /\.catalog-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 16rem\), 1fr\)\)/s);
  assert.doesNotMatch(css, /\.song-grid\s*\{[^}]*repeat\((?:4|5),/s);
});

test("shared controls expose consistent touch sizing and focus styling", () => {
  assert.match(css, /\.queue-button, \.topbar-search-submit, \.chip, \.party-toggle,[\s\S]*?min-height: var\(--control-height\)/);
  assert.match(css, /\.find-song-mode\s*\{\s*min-height:\s*44px;/);
  assert.match(css, /\.find-song-results \.feedback-button \{ min-height: 44px; \}/);
  assert.match(css, /@media \(min-width: 760px\) and \(max-width: 799px\)[\s\S]*?\.find-song-results \.feedback-button \{ min-height: 44px; \}/);
  assert.match(css, /button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("discovery toolbar groups filters with a clear active state", () => {
  assert.match(css, /\.discover-controls\s*\{[\s\S]*?background: linear-gradient/);
  assert.match(css, /\.filter-label::before\s*\{[\s\S]*?background: var\(--brand-lime\)/);
  assert.match(css, /\.discover-controls \.chip\.is-active\s*\{[\s\S]*?background: var\(--brand-lime\)/);
  assert.match(css, /@media \(max-width: 619px\)[\s\S]*?\.discover-controls \.discovery-filters[\s\S]*?padding-bottom/);
});

test("long card content can wrap without widening the layout", () => {
  assert.match(css, /\.song-card-body, \.song-card-top \{ min-width: 0; \}/);
  assert.match(css, /\.song-card h4, \.song-artist, \.song-reason, \.song-availability \{ overflow-wrap: anywhere; \}/);
});

test("sparse shelves keep bounded card tracks and shared 16:9 media sizing", () => {
  assert.match(css, /\.song-grid,\s*\.compact-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 16rem\), 20rem\)\)/);
  assert.match(css, /\.song-grid,\s*\.compact-grid\s*\{[\s\S]*?justify-content:\s*start/);
  assert.match(css, /\.song-card\s*\{[\s\S]*?max-width:\s*20rem/);
  assert.match(css, /\.song-thumbnail\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9/);
  assert.match(css, /\.song-thumbnail-image\s*\{[\s\S]*?height:\s*100%[\s\S]*?width:\s*100%/);
  assert.match(css, /@media \(max-width: 619px\)[\s\S]*?\.song-card\s*\{[\s\S]*?max-width:\s*none/);
});

test("Home cues shape the single bounded Sing now shelf with a mobile swipe affordance", () => {
  assert.match(index, /data-section="recommended"[\s\S]*?data-find-song-modes[\s\S]*?data-grid="recommended" data-find-song-results/);
  assert.match(css, /\.find-song-mode\s*\{\s*min-height:\s*44px;/);
  assert.match(css, /@media \(max-width: 759px\)[\s\S]*?\.song-section \.find-song-results \{[\s\S]*?grid-auto-flow: column;[\s\S]*?overflow-x: auto;[\s\S]*?scroll-snap-type: x mandatory/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.song-section \.find-song-results \{ scroll-snap-type: none; \}/);
  assert.match(css, /\.find-song-scroll-hint\s*\{[^}]*display:\s*none/);
  assert.match(css, /@media \(max-width: 759px\)[\s\S]*?\.find-song-scroll-hint:not\(\[hidden\]\) \{ display: block; \}/);
  assert.match(css, /\.song-grid,\s*\.compact-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 16rem\), 20rem\)\)/);
  assert.match(index, /Swipe or tab through these three picks\./);
  assert.doesNotMatch(css, /body\s*\{[^}]*min-width:\s*320px/);
  assert.match(css, /\.app-shell \{[^}]*overflow: clip/);
});

test("mobile player clears the tablet max-width and includes safe-area padding", () => {
  assert.match(css, /@media \(max-width: 799px\)[\s\S]*?\.player-panel \{[\s\S]*?max-width:\s*none;[\s\S]*?padding:[^;]*env\(safe-area-inset-bottom\)[^;]*;[\s\S]*?width:\s*100%;/);
});

test("stage ambience uses CSS gradients without loading a heavy background image", () => {
  assert.match(css, /\.app-shell::before\s*\{[\s\S]*?radial-gradient\([\s\S]*?pointer-events:\s*none/);
  assert.doesNotMatch(css, /kantatayo-stage-bg\.png/);
  assert.doesNotMatch(serviceWorker, /kantatayo-stage-bg\.png/);
});

test("shell cache version follows the stylesheet and module revisions", () => {
  assert.match(index, /styles\/main\.css\?v=47/);
  assert.match(index, /src\/app\.js\?v=61/);
  assert.match(serviceWorker, /"\.\/styles\/main\.css\?v=47"/);
  assert.match(serviceWorker, /"\.\/src\/app\.js\?v=61"/);
  assert.match(serviceWorker, /"\.\/src\/ui\.js\?v=45"/);
  assert.match(serviceWorker, /CACHE_NAME = "kantacue-shell-v108"/);
});
