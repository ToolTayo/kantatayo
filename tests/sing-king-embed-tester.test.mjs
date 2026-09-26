import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("candidate tester uses the persisted 35 NEW CANDIDATE report", async () => {
  const report = JSON.parse(await read("tools/sing-king-top-50-candidates.json"));
  const candidates = report.entries.filter((entry) => entry.classification === "NEW CANDIDATE");
  assert.equal(candidates.length, 35);
  assert.equal(new Set(candidates.map((entry) => entry.videoId)).size, 35);
  const [html, script, css] = await Promise.all([read("youtube-candidate-tester.html"), read("src/candidate-tester.js"), read("styles/candidate-tester.css")]);
  assert.match(html, /src="src\/candidate-tester\.js\?v=1"/);
  assert.match(html, /data-youtube-mount/);
  assert.match(html, /Quality good/);
  assert.match(script, /tools\/sing-king-top-50-candidates\.json/);
  assert.match(script, /classification === "NEW CANDIDATE"/);
  assert.match(script, /createYouTubePlayerController/);
  assert.match(script, /15_000/);
  for (const status of ["UNTESTED", "LOADING", "READY", "PLAYING", "PASS", "ERROR 100", "ERROR 101", "ERROR 150", "ERROR 153", "INCONCLUSIVE"]) assert.match(script, new RegExp(status.replace(" ", "\\s+")));
  assert.match(script, /kantatayo:sing-king-embed-tester:v1/);
  assert.match(script, /hostname/);
  assert.match(css, /aspect-ratio:\s*16\s*\/\s*9/);
  assert.match(css, /overflow-x:\s*auto/);
});

test("tester additions do not alter the primary catalog", async () => {
  const songs = JSON.parse(await read("data/songs.sample.json"));
  assert.equal(songs.length, 361);
  assert.equal(songs.filter((song) => song.youtubeVideoId).length, 361);
  assert.equal(songs.filter((song) => !song.youtubeVideoId).length, 0);
  assert.equal(songs.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
});
