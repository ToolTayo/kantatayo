import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const css = fs.readFileSync(new URL("../styles/main.css", import.meta.url), "utf8");

test("mobile content hierarchy keeps card text readable", () => {
  assert.match(css, /\.song-card h4\s*\{[\s\S]*?font-size:\s*1rem/);
  assert.match(css, /\.song-artist\s*\{[\s\S]*?font-size:\s*\.875rem/);
  assert.match(css, /\.song-meta\s*\{[\s\S]*?font-size:\s*\.78rem/);
  assert.match(css, /\.song-reason,[\s\S]*?\.song-availability\s*\{[\s\S]*?font-size:\s*\.76rem/);
  assert.match(css, /\.mobile-nav-link\s*\{[\s\S]*?font-size:\s*\.75rem/);
  assert.match(css, /--text-muted:\s*#8893a3/);
});

test("secondary controls use the shared comfortable touch target", () => {
  assert.match(css, /\.icon-button\s*\{[\s\S]*?min-height:\s*var\(--control-height\)/);
  assert.match(css, /\.song-thumbnail-play\s*\{[\s\S]*?height:\s*var\(--control-height\)/);
  assert.match(css, /\.discover-controls \.chip,[\s\S]*?\.preference-option\s*\{[\s\S]*?min-height:\s*var\(--control-height\)/);
  assert.match(css, /\.queue-select,[\s\S]*?\.queue-clear-button\s*\{[\s\S]*?min-height:\s*var\(--control-height\)/);
});

test("readability pass retains reduced-motion coverage", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.song-thumbnail-play,[\s\S]*?\.icon-button,[\s\S]*?\.search-clear/);
});
