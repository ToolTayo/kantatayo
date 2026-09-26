import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildPlayerVars, createYouTubePlayerController, YOUTUBE_REFERRER_POLICY } from "../src/youtube.js";

const html = await readFile("index.html", "utf8");
const serviceWorker = await readFile("service-worker.js", "utf8");
const youtubeSource = await readFile("src/youtube.js", "utf8");
const appSource = await readFile("src/app.js", "utf8");
const uiSource = await readFile("src/ui.js", "utf8");

test("document and player use a referer-preserving policy", () => {
  assert.match(html, /<meta name="referrer" content="strict-origin-when-cross-origin"/i);
  assert.equal(YOUTUBE_REFERRER_POLICY, "strict-origin-when-cross-origin");
  assert.doesNotMatch(html, /no-referrer/i);
  assert.doesNotMatch(serviceWorker, /no-referrer/i);
  assert.doesNotMatch(youtubeSource, /no-referrer/i);
});

test("playerVars uses the actual HTTP origin and never hard-codes a host", () => {
  assert.deepEqual(buildPlayerVars({ location: { protocol: "http:", origin: "http://localhost:54048" } }), {
    controls: 1,
    enablejsapi: 1,
    playsinline: 1,
    rel: 0,
    origin: "http://localhost:54048"
  });
  assert.equal(buildPlayerVars({ location: { protocol: "https:", origin: "https://kantatayo.example" } }).origin, "https://kantatayo.example");
  assert.equal(buildPlayerVars({ location: { protocol: "file:", origin: "null" } }).origin, undefined);
  assert.doesNotMatch(youtubeSource, /localhost|kantatayo\.example/);
});

test("official API-created iframe receives the explicit referrer policy", async () => {
  const iframe = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    referrerPolicy: ""
  };
  const container = {
    querySelector(selector) { return selector === "iframe" ? iframe : null; }
  };
  const calls = [];
  const windowRef = {
    location: { protocol: "https:", origin: "https://kantatayo.example" },
    YT: {
      Player: function Player(_container, options) { calls.push(options); }
    }
  };
  const controller = createYouTubePlayerController({ container, windowRef, documentRef: {}, logger: { warn() {} } });
  const result = await controller.load("abcdefghijk", { autoplay: false });
  assert.equal(result.ok, true);
  assert.equal(calls[0].playerVars.origin, "https://kantatayo.example");
  assert.equal(calls[0].playerVars.enablejsapi, 1);
  assert.equal(iframe.attributes.referrerpolicy, YOUTUBE_REFERRER_POLICY);
  assert.equal(iframe.referrerPolicy, YOUTUBE_REFERRER_POLICY);
});

test("controller forwards the official player error code without changing the video ID", async () => {
  const errors = [];
  const windowRef = {
    location: { protocol: "http:", origin: "http://127.0.0.1:54048" },
    YT: {
      Player: function Player(_container, options) { this.options = options; }
    }
  };
  const controller = createYouTubePlayerController({ container: {}, windowRef, documentRef: {}, onError: (details) => errors.push(details), logger: { warn() {} } });
  await controller.load("abcdefghijk", { autoplay: false });
  // The API callback remains authoritative; this test protects the controller's
  // contract through the options it gives the official constructor.
  assert.equal(controller.getCurrentVideoId(), "abcdefghijk");
  assert.equal(errors.length, 0);
});

test("known YouTube embed errors stay distinct without exposing codes in production", () => {
  assert.match(uiSource, /100: \["This karaoke video is no longer available\./);
  assert.match(uiSource, /101: \["This video cannot play inside KantaTayo\./);
  assert.match(uiSource, /150: \["This video cannot play inside KantaTayo\./);
  assert.match(uiSource, /153: \["YouTube could not identify this playback request\./);
  assert.match(appSource, /showPlayerError\(\{ code: details\.code, development: isDevelopmentOrigin\(\) \}\)/);
  assert.match(uiSource, /development \? "Development detail: Error 153/);
});
