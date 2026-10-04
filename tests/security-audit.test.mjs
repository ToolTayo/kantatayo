import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [html, app, install, share, youtube, serviceWorker, vercel] = await Promise.all([
  read("index.html"),
  read("src/app.js"),
  read("src/install.js"),
  read("src/share.js"),
  read("src/youtube.js"),
  read("service-worker.js"),
  read("vercel.json")
]);

test("production entrypoint has no remote script injection or rejected player card", () => {
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
  assert.doesNotMatch(html, /data-player-up-next|Recommended next/);
  assert.doesNotMatch(app + install + share + youtube, /eval\s*\(|new\s+Function\s*\(|javascript:/i);
});

test("runtime APIs stay within the documented local, install, share, and YouTube boundaries", () => {
  assert.doesNotMatch(app + install + share, /getUserMedia|mediaDevices|geolocation|Notification|requestPermission|showOpenFilePicker|showSaveFilePicker|navigator\.usb|navigator\.bluetooth/i);
  assert.doesNotMatch(app + install + share, /\.download\s*=|window\.open\s*\(/i);
  assert.match(youtube, /https:\/\/www\.youtube\.com\/iframe_api/);
  assert.match(youtube, /strict-origin-when-cross-origin/);
});

test("service worker is first-party-only and never caches YouTube media", () => {
  assert.doesNotMatch(serviceWorker, /https?:\/\//i);
  assert.doesNotMatch(serviceWorker, /youtube\.com|ytimg\.com|googlevideo\.com|\.(?:mp4|webm|m4a|mp3)(?:["'])/i);
  assert.match(serviceWorker, /url\.origin !== self\.location\.origin/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
});

test("deployment policy permits only the existing YouTube integration and disables sensitive permissions", () => {
  const config = JSON.parse(vercel);
  const headers = new Map((config.headers?.[0]?.headers || []).map((header) => [header.key, header.value]));
  const policy = headers.get("Content-Security-Policy") || "";
  const permissions = headers.get("Permissions-Policy") || "";
  assert.match(policy, /script-src 'self' https:\/\/www\.youtube\.com/);
  assert.match(policy, /frame-src https:\/\/www\.youtube-nocookie\.com https:\/\/www\.youtube\.com/);
  assert.doesNotMatch(policy, /google-analytics|googletagmanager|facebook|doubleclick/i);
  assert.match(permissions, /camera=\(\)/);
  assert.match(permissions, /microphone=\(\)/);
  assert.match(permissions, /geolocation=\(\)/);
});
