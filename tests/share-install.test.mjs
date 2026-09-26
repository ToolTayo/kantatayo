import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createInstallController, isStandaloneDisplay } from "../src/install.js";
import { createSongShareUrl, parseSongShareId, shareSong } from "../src/share.js";

const song = { id: "sample-029", title: "Sa Aking Puso", artist: "Kaye Cal" };

test("share URLs use a stable KantaCue song ID and never expose the video ID", () => {
  const url = createSongShareUrl(song.id, { href: "https://kantacue.example/#top" });
  assert.equal(url, "https://kantacue.example/?song=sample-029#top");
  assert.equal(parseSongShareId({ href: url }), song.id);
  assert.doesNotMatch(url, /QBb9wO3Bj0k/);
});

test("malformed deep-link values are ignored while unknown IDs remain safely identifiable", () => {
  assert.equal(parseSongShareId({ href: "https://kantacue.example/?song=not%20safe#top" }), "");
  assert.equal(parseSongShareId({ href: "https://kantacue.example/?song=missing-id#top" }), "missing-id");
});

test("native share is used when available and cancellation is quiet", async () => {
  const calls = [];
  const navigatorRef = { share: async (data) => calls.push(data) };
  const shared = await shareSong(song, { navigatorRef, locationRef: { href: "https://kantacue.example/#top" } });
  assert.equal(shared.status, "shared");
  assert.equal(calls[0].url, "https://kantacue.example/?song=sample-029#top");

  const cancelled = await shareSong(song, {
    navigatorRef: { share: async () => { const error = new Error("cancelled"); error.name = "AbortError"; throw error; } },
    locationRef: { href: "https://kantacue.example/#top" }
  });
  assert.equal(cancelled.status, "cancelled");
});

test("clipboard is the fallback for unsupported or failed native share", async () => {
  let copied = "";
  const result = await shareSong(song, { navigatorRef: { clipboard: { writeText: async (value) => { copied = value; } } }, locationRef: { href: "https://kantacue.example/#top" } });
  assert.equal(result.status, "copied");
  assert.equal(copied, result.url);

  const failed = await shareSong(song, { navigatorRef: { clipboard: { writeText: async () => { throw new Error("blocked"); } } }, locationRef: { href: "https://kantacue.example/#top" } });
  assert.equal(failed.status, "failed");
});

test("install action is hidden until beforeinstallprompt and prompts only after a click", async () => {
  const listeners = new Map();
  const button = {
    hidden: true,
    disabled: true,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: () => {}
  };
  let prompted = 0;
  let outcome = "accepted";
  const windowRef = {
    navigator: {},
    matchMedia: () => ({ matches: false }),
    addEventListener: (name, handler) => listeners.set(`window:${name}`, handler),
    removeEventListener: () => {}
  };
  const statuses = [];
  const controller = createInstallController({ windowRef, buttons: [button], onStatus: (message) => statuses.push(message) });
  assert.equal(button.hidden, true);
  const promptEvent = { preventDefault: () => {}, prompt: async () => { prompted += 1; }, userChoice: Promise.resolve({ outcome }) };
  listeners.get("window:beforeinstallprompt")(promptEvent);
  assert.equal(button.hidden, false);
  assert.equal(prompted, 0);
  await listeners.get("click")();
  assert.equal(prompted, 1);
  assert.match(statuses.at(-1), /added/);
  listeners.get("window:appinstalled")();
  assert.equal(button.hidden, true);
  controller.dispose();
});

test("install action is hidden in standalone mode and dismissed choices stay local", async () => {
  assert.equal(isStandaloneDisplay({ navigator: { standalone: true } }), true);
  const button = { hidden: false, disabled: false, addEventListener: () => {}, removeEventListener: () => {} };
  const windowRef = { navigator: { standalone: true }, matchMedia: () => ({ matches: true }), addEventListener: () => {}, removeEventListener: () => {} };
  const controller = createInstallController({ windowRef, buttons: [button] });
  assert.equal(button.hidden, true);
  assert.equal(controller.isActionable(), false);
  controller.dispose();
});

test("deep-link parsing is separate from playback engagement recording", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const handler = app.match(/function handleIncomingSongLink\(\)[\s\S]*?\n}\n\nfunction removeSongShareParam/)[0];
  assert.equal(parseSongShareId({ href: "https://kantacue.example/?song=sample-029#discover" }), "sample-029");
  assert.match(handler, /if \(!song\)/);
  assert.doesNotMatch(handler, /recordSongPlayed/);
});
