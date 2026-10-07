import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createInstallController, isIOSDevice, isStandaloneDisplay } from "../src/install.js";
import { createMedleyShareUrl, createSongShareUrl, parseMedleyShareId, parseSongShareId, shareMedley, shareSong } from "../src/share.js";

const song = { id: "sample-029", title: "Sa Aking Puso", artist: "Kaye Cal" };
const medley = { id: "medley-opm-freestyle-ibarra-001", title: "Karaoke - OPM Medley - Freestyle", provider: "Ibarra Music", videoId: "jfBGyW_JYp8" };

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

test("medley deep links contain only the stable collection ID and open Collections", () => {
  const url = createMedleyShareUrl(medley.id, { href: "https://kantacue.example/#top" });
  assert.equal(url, "https://kantacue.example/?medley=medley-opm-freestyle-ibarra-001#collections");
  assert.equal(parseMedleyShareId({ href: url }), medley.id);
  assert.doesNotMatch(url, /jfBGyW_JYp8/);
  assert.equal(createMedleyShareUrl("medley&video=secret", { href: "https://kantacue.example/" }), "");
  assert.equal(parseMedleyShareId({ href: "https://kantacue.example/?medley=bad%20id#collections" }), "");
});

test("medley sharing uses native share and safe clipboard fallback", async () => {
  let nativeData;
  const native = await shareMedley(medley, {
    navigatorRef: { share: async (data) => { nativeData = data; } },
    locationRef: { href: "https://kantacue.example/#top" }
  });
  assert.equal(native.status, "shared");
  assert.equal(nativeData.url, "https://kantacue.example/?medley=medley-opm-freestyle-ibarra-001#collections");
  assert.match(nativeData.text, /karaoke medley from Ibarra Music/);

  let copied = "";
  const fallback = await shareMedley(medley, {
    navigatorRef: { clipboard: { writeText: async (value) => { copied = value; } } },
    locationRef: { href: "https://kantacue.example/#top" }
  });
  assert.equal(fallback.status, "copied");
  assert.equal(copied, fallback.url);
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

test("iPhone and iPad expose a manual Add to Home Screen path without prompting", async () => {
  const listeners = new Map();
  const button = { hidden: true, disabled: true, textContent: "Install app", setAttribute: () => {}, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: () => {} };
  const statuses = [];
  const windowRef = {
    navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 },
    matchMedia: () => ({ matches: false }),
    addEventListener: (name, handler) => listeners.set(`window:${name}`, handler),
    removeEventListener: () => {}
  };
  assert.equal(isIOSDevice(windowRef), true);
  const controller = createInstallController({ windowRef, buttons: [button], onStatus: (message) => statuses.push(message) });
  assert.equal(button.hidden, false);
  assert.equal(controller.isManualInstall(), true);
  const result = await listeners.get("click")();
  assert.equal(result.status, "manual");
  assert.match(statuses.at(-1), /Share, then choose Add to Home Screen/);
  controller.dispose();
});

test("unsupported browsers keep the install action hidden", () => {
  const button = { hidden: true, disabled: true, addEventListener: () => {}, removeEventListener: () => {} };
  const windowRef = { navigator: { userAgent: "Mozilla/5.0", platform: "Win32" }, matchMedia: () => ({ matches: false }), addEventListener: () => {}, removeEventListener: () => {} };
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

test("medley deep links validate against loaded collections and focus Play without auto-starting", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const handler = app.match(/function handleIncomingMedleyLink\(\)[\s\S]*?\n}\n\nfunction removeMedleyShareParam/)?.[0] || "";
  assert.match(app, /function handleIncomingSharedLink\(\)[\s\S]*?parseSongShareId[\s\S]*?handleIncomingMedleyLink\(\)/);
  assert.match(handler, /medleys\.find/);
  assert.match(handler, /currentView = "collections"/);
  assert.match(handler, /playButton\?\.focus\(\)/);
  assert.doesNotMatch(handler, /startMedley\(/);
});
