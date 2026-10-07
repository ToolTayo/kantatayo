import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDefaultUserState, addSongToQueue, advanceQueue, markSung, setCurrentSong } from "../src/state.js";
import { getRecommendations } from "../src/recommendations.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const ui = await readFile(new URL("../src/ui.js", import.meta.url), "utf8");
const css = await readFile(new URL("../styles/main.css", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
const songs = JSON.parse(await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8"));

test("player shell presents Now Singing and keeps queue actions without the rejected recommendation card", () => {
  assert.match(html, /data-player-panel[^>]+role="region" aria-label="Now singing"/);
  assert.match(html, /data-player-meta/);
  assert.match(html, /data-player-favorite/);
  assert.match(html, /data-player-sang/);
  assert.doesNotMatch(html, /data-player-up-next|data-player-next-label|data-player-next-title|data-player-next-artist|data-player-next-note/);
  assert.match(html, /data-action="sang-again"/);
  assert.match(html, /data-player-completion-favorite/);
  assert.match(html, /data-action="player-next"/);
  assert.doesNotMatch(ui, /Recommended next|Not added until you choose Sing next|function updatePlayerNext/);
});

test("player preserves the official 16:9 embed and has real expanded/fullscreen hooks", () => {
  assert.match(html, /data-youtube-mount/);
  assert.match(css, /\.youtube-player-shell\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
  assert.match(css, /\.player-panel\.is-expanded/);
  assert.match(html, /data-action="fullscreen-player"/);
  assert.match(app, /requestFullscreen/);
  assert.match(app, /Full screen is not available here/);
});

test("video completion automatically advances queued songs but keeps recommendations explicit", () => {
  assert.match(app, /function handleVideoEnded\(videoId\)/);
  assert.match(app, /const queuedNext = snapshot\.currentIndex >= 0/);
  assert.match(app, /if \(queuedNext\) \{[\s\S]*?advanceToNext\(\{ automatic: true \}\);/);
  assert.match(app, /const nextSong = getRecommendedNext\(snapshot\);/);
  assert.match(app, /showPlayerFinished\(\{ nextSong, nextType \}\)/);
  assert.match(ui, /Choose another KantaCue pick or replay this performance/);
});

test("queue reorder refreshes queue context without hiding or resetting active playback", () => {
  const showPlayer = ui.match(/export function showPlayer\(song, metadata = \{\}\) \{([\s\S]*?)\n\}\n\nexport function showPlayerLoading/)?.[1] || "";
  const preserveBranch = showPlayer.match(/if \(preservePlayback\) \{([\s\S]*?)\n  \} else \{/)?.[1] || "";
  const resetBranch = showPlayer.match(/\n  \} else \{([\s\S]*?)\n  \}\n  panel\.querySelector\('\[data-action="player-prev"\]'/)?.[1] || "";

  assert.match(app, /function reorderQueue\([\s\S]*?syncPlayer\(getQueueSnapshot\(state\), \{ reloadVideo: false \}\)/);
  assert.match(app, /preservePlayback: !reloadVideo/);
  assert.match(preserveBranch, /setPlayerPreEndVisible\(preEndWasVisible\)/);
  assert.doesNotMatch(preserveBranch, /setPlayerEmbedVisible\(panel, false\)|setPlayerFeedback\(false\)|setPlayerCompletion\(false\)/);
  assert.match(resetBranch, /setPlayerEmbedVisible\(panel, false\)/);
  assert.match(resetBranch, /setPlayerCompletion\(false\)/);
});

test("Sang It uses durable history and the existing duplicate guard", () => {
  const state = createDefaultUserState();
  const first = markSung(state, "sample-001", { now: 10_000 });
  const rapid = markSung(state, "sample-001", { now: 10_500 });
  assert.equal(first.added, true);
  assert.equal(rapid.added, false);
  assert.equal(state.sungHistory.length, 1);
  assert.match(app, /showPlayerSangIt\(\)/);
  assert.match(ui, /Your performance is saved\. What’s next\?/);
  assert.match(css, /\.player-completion\.is-celebration/);
});

test("Sang It cannot record unavailable or recently failed playback", () => {
  assert.match(app, /action === "mark-sung" && !isValidYouTubeVideoId\(song\.youtubeVideoId\)/);
  assert.match(app, /lastPlaybackErrorSongId/);
  assert.match(app, /Finish a working playback before marking this song as sung/);
});

test("queued next song remains the first explicit next target", () => {
  const state = createDefaultUserState();
  addSongToQueue(state, "sample-001");
  addSongToQueue(state, "sample-002");
  setCurrentSong(state, "sample-001");
  const result = advanceQueue(state);
  assert.equal(result.status, "advanced");
  assert.equal(result.currentSongId, "sample-002");
  assert.match(app, /const queuedNext = snapshot\.currentIndex >= 0/);
  assert.match(app, /const recommendedNext = queuedNext \? null : getRecommendedNext\(snapshot\)/);
});

test("fallback recommendation candidates are playable and excluded from the active queue/current song", () => {
  const state = createDefaultUserState();
  state.queue = ["sample-001"];
  state.currentSongId = "sample-001";
  const results = getRecommendations(songs, state, { limit: 12 });
  assert.ok(results.length > 0);
  assert.ok(results.every((item) => item.song.youtubeVideoId));
  assert.ok(results.every((item) => item.song.id !== "sample-001"));
  assert.match(app, /isValidYouTubeVideoId\(song\.youtubeVideoId\)/);
});

test("player interactions do not alter catalog assignments or protected songs", () => {
  assert.equal(songs.length, 1067);
  assert.equal(songs.filter((song) => song.youtubeVideoId).length, 1000);
  assert.equal(songs.filter((song) => song.youtubeVideoId === null).length, 67);
  assert.equal(songs.find((song) => song.id === "sample-029")?.youtubeVideoId, "QBb9wO3Bj0k");
  assert.doesNotMatch(app, /YOUTUBE_API_KEY|youtubeDataApi|apiKey/i);
  assert.doesNotMatch(serviceWorker, /youtube\.com|ytimg\.com/i);
});
