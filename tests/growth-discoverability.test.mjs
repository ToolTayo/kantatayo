import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { renderMedleyCard } from "../src/ui.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

function metaContent(html, attribute, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`<meta\\s+${attribute}="${escaped}"\\s+content="([^"]*)"`))?.[1] || "";
}

test("homepage metadata clearly describes KantaCue and supplies a first-party social preview", async () => {
  const html = await read("index.html");
  assert.match(html, /<title>KantaCue — Find your next karaoke song<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/kantacue\.vercel\.app\/"/);
  assert.match(metaContent(html, "name", "description"), /karaoke songs.*local queue.*YouTube’s official player/i);
  assert.match(metaContent(html, "property", "og:title"), /Find your next karaoke song/);
  assert.match(metaContent(html, "property", "og:description"), /supported videos through YouTube’s official player/i);
  assert.equal(metaContent(html, "property", "og:image"), "https://kantacue.vercel.app/assets/icon-512.png");
  assert.equal(metaContent(html, "property", "og:image:type"), "image/png");
  assert.equal(metaContent(html, "property", "og:image:width"), "512");
  assert.equal(metaContent(html, "property", "og:image:height"), "512");
  assert.equal(metaContent(html, "name", "twitter:image"), "https://kantacue.vercel.app/assets/icon-512.png");
  assert.ok((await stat(new URL("assets/icon-512.png", root))).isFile());
});

test("robots and sitemap expose only the canonical public homepage", async () => {
  const robots = await read("robots.txt");
  const sitemap = await read("sitemap.xml");
  assert.match(robots, /^User-agent: \*\s+Allow: \/\s+Sitemap: https:\/\/kantacue\.vercel\.app\/sitemap\.xml/m);
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<loc>https:\/\/kantacue\.vercel\.app\/<\/loc>/);
  assert.equal([...sitemap.matchAll(/<loc>/g)].length, 1);
  assert.doesNotMatch(sitemap, /<loc>[^<]*(?:[?#]|song=|medley=)/i);
});

test("medley cards provide a labeled share action without replacing play or queue", () => {
  const html = renderMedleyCard({
    id: "medley-opm-fixture-001",
    title: "OPM Sing-Along Medley",
    provider: "Karaoke Example",
    videoId: "AbCdEfGhI12",
    language: "Filipino",
    theme: "OPM",
    includedSongs: [],
    sectionStatus: "unknown"
  });
  assert.match(html, /data-action="share-medley" data-medley-id="medley-opm-fixture-001" aria-label="Share OPM Sing-Along Medley"/);
  assert.match(html, /data-action="play-medley"/);
  assert.match(html, /data-action="add-medley-queue"/);
  assert.match(html, /Multiple-song medley · song list not listed/);
});
