import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getPlaybackWindowState, PRE_END_WINDOW_SECONDS } from "../src/player-timing.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [html, app, ui, youtube, css] = await Promise.all([
  read("index.html"),
  read("src/app.js"),
  read("src/ui.js"),
  read("src/youtube.js"),
  read("styles/main.css")
]);

test("ordinary playback keeps the compact recommendations hidden", () => {
  assert.equal(getPlaybackWindowState(40, 120), "normal");
  assert.doesNotMatch(html, /data-player-suggestions/);
  assert.match(html, /data-player-pre-end-status hidden/);
  assert.match(app, /setPlayerPreEndVisible\(phase === "pre-end"\)/);
});

test("the final window is deterministic and responds to seeking", () => {
  assert.equal(PRE_END_WINDOW_SECONDS, 15);
  assert.equal(getPlaybackWindowState(105, 120), "pre-end");
  assert.equal(getPlaybackWindowState(110, 120), "pre-end");
  assert.equal(getPlaybackWindowState(104, 120), "normal");
  assert.equal(getPlaybackWindowState(0, 10), "pre-end");
  assert.equal(getPlaybackWindowState(0, 0), "normal");
  assert.equal(getPlaybackWindowState(Number.NaN, 120), "normal");
});

test("ENDED swaps only the visible player region to the KantaCue end screen", () => {
  assert.match(html, /data-player-end-screen hidden/);
  assert.match(html, /data-player-end-next/);
  assert.match(html, /data-player-end-sang/);
  assert.match(html, /data-action="sang-again"/);
  assert.match(html, /data-action="player-browse-more"/);
  assert.match(ui, /setPlayerEndScreenVisible\(panel, true\)/);
  assert.match(ui, /setPlayerPreEndVisible\(false\)/);
  assert.match(app, /event\.ended \|\| event\.state === "ended"/);
});

test("the pre-end and ended recommendation set reuse one in-app render path", () => {
  assert.match(ui, /activePlayerSuggestions = safeSuggestions/);
  assert.match(ui, /renderSuggestionCards\(activePlayerSuggestions, "player-end-suggestion"\)/);
  assert.match(ui, /player-end-card-tone-/);
  assert.match(app, /getDuration\?\.\(\)/);
  assert.match(youtube, /getDuration/);
  assert.equal((youtube.match(/new api\.Player\(/g) || []).length, 1);
  assert.doesNotMatch(html, /player-end-screen[\s\S]*iframe/);
});

test("end-screen sizing stays bounded and responsive", () => {
  assert.match(css, /\.player-end-screen\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
  assert.match(css, /\.player-end-screen-grid\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(css, /\.player-end-card-action[^}]*min-height:\s*2\.75rem/s);
  assert.match(css, /\.player-end-screen\s*\{\s*aspect-ratio:\s*auto;\s*min-height:\s*290px;\s*overflow:\s*visible/s);
  assert.match(css, /\.player-end-screen\[hidden\]\s*\{\s*display:\s*none/);
});
