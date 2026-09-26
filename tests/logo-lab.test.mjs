import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const lab = await readFile("logo-lab.html", "utf8");
const css = await readFile("styles/logo-lab.css", "utf8");
const production = await readFile("index.html", "utf8");
const manifest = await readFile("manifest.webmanifest", "utf8");
const mark = await readFile("assets/brand/kantacue-mark.svg", "utf8");
const lockup = await readFile("assets/brand/kantacue-logo.svg", "utf8");

test("logo lab contains seven distinct hand-authored SVG concepts", () => {
  for (const id of ["logo-concept-a", "logo-concept-b", "logo-concept-c", "logo-concept-d", "logo-concept-a2", "logo-concept-a3", "logo-concept-a4"]) {
    assert.equal((lab.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
    assert.match(lab, new RegExp(`href="#${id}"`));
  }
  assert.equal((lab.match(/data-concept="(?:[a-d]|a2|a3|a4)"/g) || []).length, 7);
  assert.equal((lab.match(/<symbol\b/g) || []).length, 7);
  for (const id of ["logo-concept-a2", "logo-concept-a3", "logo-concept-a4"]) {
    const symbol = lab.match(new RegExp(`<symbol id="${id}"[\\s\\S]*?<\\/symbol>`))?.[0] || "";
    assert.match(symbol, /logo-stroke/);
    assert.doesNotMatch(symbol, /logo-fill/);
  }
  assert.doesNotMatch(lab, /https?:\/\//i);
  assert.doesNotMatch(lab, /data:image\//i);
  assert.match(css, /prefers-reduced-motion/);
});

test("logo lab covers wordmark, scale, context, light, dark, and monochrome previews", () => {
  assert.equal((lab.match(/Kanta<span>Cue<\/span>/g) || []).length, 15);
  assert.equal((lab.match(/size-16/g) || []).length, 8);
  assert.equal((lab.match(/size-32/g) || []).length, 8);
  assert.equal((lab.match(/size-48/g) || []).length, 8);
  assert.equal((lab.match(/size-112/g) || []).length, 7);
  assert.equal((lab.match(/preview-light/g) || []).length, 7);
  assert.equal((lab.match(/class="preview-block dark-surface mono"/g) || []).length, 7);
  assert.equal((lab.match(/browser-tab/g) || []).length, 8);
  assert.equal((lab.match(/sidebar-mock/g) || []).length, 8);
});

test("logo lab is isolated from production branding and PWA metadata", () => {
  assert.doesNotMatch(production, /logo-lab/);
  assert.doesNotMatch(manifest, /logo-lab/);
  assert.match(lab, /Local development only/);
  assert.match(lab, /No winner selected/);
});

test("A2 final candidate is clearly labeled and covers the requested optical sizes", () => {
  assert.match(lab, /FINAL CANDIDATE — NOT YET PRODUCTION/);
  for (const size of [16, 20, 24, 32, 48, 64, 128, 192]) assert.match(lab, new RegExp(`final-size-${size}`));
  assert.match(lab, /512/);
  assert.match(lab, /Small-size optical variant/);
  assert.match(lab, /assets\/brand\/kantacue-mark-small\.svg#kantacue-mark-small/);
  assert.match(lab, /mobile-app-mock/);
  assert.match(lab, /assets\/brand\/kantacue-mark\.svg#kantacue-mark/);
});

test("A2 master and lockup are lightweight local SVGs", () => {
  assert.match(mark, /viewBox="0 0 64 64"/);
  assert.match(mark, /currentColor/);
  assert.doesNotMatch(mark, /<image\b|data:image|<script\b|url\(/i);
  assert.equal((mark.match(/id="/g) || []).length, 2);
  assert.match(lockup, /Kanta<tspan[^>]*>Cue<\/tspan>/);
  assert.doesNotMatch(lockup, /https?:\/\/(?!www\.w3\.org)/i);
  assert.doesNotMatch(lockup, /<image\b|data:image|<script\b|url\(/i);
});

test("logo concepts use compact viewBoxes and only local SVG geometry", () => {
  assert.equal((lab.match(/viewBox="0 0 64 64"/g) || []).length, 7);
  assert.doesNotMatch(lab, /<image\b/i);
  assert.doesNotMatch(lab, /<foreignObject\b/i);
  assert.doesNotMatch(css, /url\(/i);
});
