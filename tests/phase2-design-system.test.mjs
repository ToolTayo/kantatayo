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
  assert.match(css, /button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("long card content can wrap without widening the layout", () => {
  assert.match(css, /\.song-card-body, \.song-card-top \{ min-width: 0; \}/);
  assert.match(css, /\.song-card h4, \.song-artist, \.song-reason, \.song-availability \{ overflow-wrap: anywhere; \}/);
});

test("shell cache version follows the stylesheet revision", () => {
  assert.match(index, /styles\/main\.css\?v=13/);
  assert.match(serviceWorker, /"\.\/styles\/main\.css\?v=13"/);
  assert.match(serviceWorker, /CACHE_NAME = "kantatayo-shell-v16"/);
});
