import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile("index.html", "utf8");
const icon = await readFile("assets/icon-192.svg", "utf8");
const mark = await readFile("assets/brand/kantacue-mark.svg", "utf8");
const smallMark = await readFile("assets/brand/kantacue-mark-small.svg", "utf8");
const manifest = await readFile("manifest.webmanifest", "utf8");

test("KantaCue uses the original A2 soundmark in both navigation brands", () => {
  assert.equal((html.match(/class="brand-mark brand-mark-svg"/g) || []).length, 2);
  assert.equal((html.match(/aria-hidden="true" viewBox="0 0 64 64"/g) || []).length, 2);
  assert.equal((html.match(/assets\/brand\/kantacue-mark\.svg#kantacue-mark/g) || []).length, 2);
  assert.match(html, /rel="icon"[^>]+kantacue-mark-small\.svg/);
  assert.match(html, /rel="apple-touch-icon"[^>]+assets\/icon-192\.png/);
  assert.match(html, /Kanta<span>Cue<\/span>/);
  assert.doesNotMatch(html, /KantaTayo|KANTA TAYO/i);
  assert.doesNotMatch(manifest, /KantaTayo|KANTA TAYO/i);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(png|jpg|svg)/i);
});

test("the install icon remains an original first-party KantaCue mark", () => {
  assert.match(icon, /<title id="title">KantaCue<\/title>/);
  assert.match(icon, /stroke="#a6f36f"/);
  assert.match(mark, /id="kantacue-mark"/);
  assert.match(smallMark, /id="kantacue-mark-small"/);
  assert.doesNotMatch(icon, /#78d9ff|microphone|<circle cx="96"/i);
});
