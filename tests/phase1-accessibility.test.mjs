import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { containFocus } from "../src/focus.js";
import { isPartyPanelVisible, setPlayerEmbedVisible, setPlayerExpanded } from "../src/ui.js";

function focusableDocument() {
  const documentRef = { activeElement: null };
  const makeElement = ({ hidden = false, disabled = false } = {}) => ({
    hidden,
    disabled,
    closest: () => null,
    focus() { documentRef.activeElement = this; }
  });
  const first = makeElement();
  const last = makeElement();
  const container = {
    ownerDocument: documentRef,
    querySelectorAll: () => [first, last],
    contains: (element) => element === first || element === last,
    focus() { documentRef.activeElement = this; }
  };
  return { documentRef, first, last, container };
}

test("Party Mode remains enabled while its panel follows the active view", () => {
  assert.equal(isPartyPanelVisible("home", true), false);
  assert.equal(isPartyPanelVisible("discover", true), false);
  assert.equal(isPartyPanelVisible("party", true), true);
  assert.equal(isPartyPanelVisible("party", false), false);
});

test("modal focus containment wraps forward and backward without trapping desktop surfaces", () => {
  const { documentRef, first, last, container } = focusableDocument();
  documentRef.activeElement = last;
  let prevented = false;
  assert.equal(containFocus(container, { key: "Tab", shiftKey: false, preventDefault: () => { prevented = true; } }), true);
  assert.equal(prevented, true);
  assert.equal(documentRef.activeElement, first);

  documentRef.activeElement = first;
  prevented = false;
  assert.equal(containFocus(container, { key: "Tab", shiftKey: true, preventDefault: () => { prevented = true; } }), true);
  assert.equal(prevented, true);
  assert.equal(documentRef.activeElement, last);
  assert.equal(containFocus(container, { key: "Enter", shiftKey: false, preventDefault: () => { throw new Error("not a Tab event"); } }), false);
});

test("player semantics switch between non-modal desktop and modal expanded states", () => {
  const attributes = new Map();
  const classes = new Set();
  const panel = {
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); }
  };

  setPlayerExpanded(panel, false);
  assert.equal(attributes.get("role"), "region");
  assert.equal(attributes.has("aria-modal"), false);
  setPlayerExpanded(panel, true);
  assert.equal(attributes.get("role"), "dialog");
  assert.equal(attributes.get("aria-modal"), "true");
  assert.equal(attributes.get("aria-labelledby"), "player-title");
});

test("a YouTube API replacement preserves the app-owned shell marker and display states", () => {
  const mount = { hidden: true };
  const iframe = { hidden: true };
  const placeholder = { hidden: false };
  const shell = {
    hidden: false,
    querySelector(selector) {
      if (selector === "[data-youtube-mount]") return mount;
      if (selector === "iframe") return iframe;
      return null;
    }
  };
  const panel = { querySelector(selector) { return selector === "[data-youtube-shell]" ? shell : selector === "[data-player-placeholder]" ? placeholder : null; } };

  setPlayerEmbedVisible(panel, false);
  assert.equal(shell.hidden, false);
  assert.equal(placeholder.hidden, false);
  assert.equal(iframe.hidden, true);
  setPlayerEmbedVisible(panel, true);
  assert.equal(placeholder.hidden, true);
  assert.equal(iframe.hidden, false);

  shell.querySelector = (selector) => selector === "iframe" ? iframe : null;
  setPlayerEmbedVisible(panel, false);
  assert.equal(shell.hidden, false);
  assert.equal(placeholder.hidden, false);
  assert.equal(iframe.hidden, true);
});

test("Phase 1 integration keeps the official player mount and Party view ownership explicit", async () => {
  const [html, app, ui, serviceWorker] = await Promise.all([
    readFile("index.html", "utf8"),
    readFile("src/app.js", "utf8"),
    readFile("src/ui.js", "utf8"),
    readFile("service-worker.js", "utf8")
  ]);
  assert.match(html, /data-youtube-shell/);
  assert.match(html, /data-youtube-mount/);
  assert.doesNotMatch(html, /data-youtube-container/);
  assert.match(app, /data-youtube-mount/);
  assert.match(app, /currentView\);/);
  assert.match(app, /containFocus/);
  assert.match(ui, /isPartyPanelVisible\(currentView, enabled\)/);
  assert.match(ui, /data-youtube-shell/);
  assert.doesNotMatch(ui, /data-youtube-container/);
  assert.match(serviceWorker, /\.\/src\/focus\.js/);
});
