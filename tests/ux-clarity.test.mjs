import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setPlayerExpanded } from "../src/ui.js";

test("Discover explains quick filters and exposes clear control state", async () => {
  const html = await readFile("index.html", "utf8");
  assert.match(html, /aria-describedby="discover-filter-guide"/);
  assert.match(html, /id="discover-filter-guide"/);
  assert.match(html, /title="Show songs with a playable karaoke video"/);
  assert.match(html, /data-action="reset-discovery-filters" disabled/);
  assert.match(html, /data-action="expand-player"/);
});

test("player sizing keeps a 16:9 shell and provides a desktop expansion state", async () => {
  const css = await readFile("styles/main.css", "utf8");
  assert.match(css, /\.youtube-player-shell\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
  assert.match(css, /\.player-panel\.is-expanded\s*\{/);
  assert.match(css, /\.player-header-actions\s*\{/);
});

test("player expansion control mirrors modal semantics and accessible labels", () => {
  const attributes = new Map();
  const classes = new Set();
  const toggle = { textContent: "" , setAttribute(name, value) { attributes.set(`toggle:${name}`, value); } };
  const panel = {
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    querySelector(selector) { return selector === '[data-action="expand-player"]' ? toggle : null; },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); }
  };

  setPlayerExpanded(panel, false);
  assert.equal(attributes.get("toggle:aria-expanded"), "false");
  assert.equal(attributes.get("toggle:aria-label"), "Expand player");
  assert.equal(toggle.textContent, "↗");

  setPlayerExpanded(panel, true);
  assert.equal(attributes.get("role"), "dialog");
  assert.equal(attributes.get("aria-modal"), "true");
  assert.equal(attributes.get("toggle:aria-expanded"), "true");
  assert.equal(attributes.get("toggle:aria-label"), "Collapse player");
  assert.equal(toggle.textContent, "↙");
});

test("navigation and queue controls include persistent accessible state hooks", async () => {
  const [html, app, ui] = await Promise.all([
    readFile("index.html", "utf8"),
    readFile("src/app.js", "utf8"),
    readFile("src/ui.js", "utf8")
  ]);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /title="Open singing queue"/);
  assert.match(app, /Close singing queue/);
  assert.match(app, /Close additional song filters/);
  assert.match(ui, /link\.setAttribute\("aria-current", "page"\)/);
  assert.match(ui, /title="Move up"/);
});
