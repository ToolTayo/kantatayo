import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { addSongToQueue, clearQueue, createDefaultUserState, setCurrentSong } from "../src/state.js";

const [html, app, ui, css] = await Promise.all([
  readFile("index.html", "utf8"),
  readFile("src/app.js", "utf8"),
  readFile("src/ui.js", "utf8"),
  readFile("styles/main.css", "utf8")
]);

test("clearQueue removes queued/current state without touching personal collections", () => {
  const userState = createDefaultUserState();
  userState.favorites = ["sample-001"];
  userState.likedSongs = ["sample-002"];
  userState.sungHistory = [{ id: "sample-003", sungAt: "2026-09-27T00:00:00.000Z" }];
  addSongToQueue(userState, "sample-001");
  addSongToQueue(userState, "sample-002");
  setCurrentSong(userState, "sample-002");
  userState.queueFinished = true;

  assert.equal(clearQueue(userState), true);
  assert.deepEqual(userState.queue, []);
  assert.equal(userState.currentSongId, null);
  assert.equal(userState.queueFinished, false);
  assert.deepEqual(userState.favorites, ["sample-001"]);
  assert.deepEqual(userState.likedSongs, ["sample-002"]);
  assert.deepEqual(userState.sungHistory, [{ id: "sample-003", sungAt: "2026-09-27T00:00:00.000Z" }]);
  assert.equal(clearQueue(userState), false, "clearing an already empty queue is a no-op");
});

test("queue drawer exposes a bounded, accessible clear confirmation", () => {
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="queue-title" aria-describedby="queue-description"/);
  assert.match(html, /data-queue-header-count/);
  assert.match(html, /data-queue-content[^>]*role="list"[^>]*aria-label="Songs in your karaoke queue"/);
  assert.match(html, /<dialog class="queue-confirm-dialog" data-queue-confirm/);
  assert.match(html, /id="queue-confirm-title">Clear queue\?</);
  assert.match(html, /data-queue-confirm-copy/);
  assert.match(html, /data-action="cancel-clear-queue"/);
  assert.match(html, /data-action="confirm-clear-queue"/);
  assert.match(html, /data-action="clear-queue" disabled/);
  assert.match(css, /\.queue-content \{[\s\S]*?overflow-y: auto/);
  assert.match(css, /\.queue-item \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.queue-confirm-dialog::backdrop/);
});

test("queue rendering keeps song information primary and groups reorder controls", () => {
  assert.match(ui, /data-queue-header-count/);
  assert.match(ui, /class="queue-item-reorder" aria-label="Reorder/);
  assert.match(ui, /class="queue-control-label">Up<\/span>/);
  assert.match(ui, /class="queue-control-label">Down<\/span>/);
  assert.match(ui, /class="queue-empty-icon"/);
  assert.match(ui, /button\) => \{ button\.disabled = queue\.length === 0; \}/);
});

test("clear confirmation reports the exact count and preserves existing clear behavior", () => {
  assert.match(app, /function requestClearQueue\(\)/);
  assert.match(app, /Remove all \$\{count\} song/);
  assert.match(app, /The current song will also be stopped/);
  assert.match(app, /dialog\.showModal\(\)/);
  assert.match(app, /function confirmClearQueue\(\)/);
  assert.match(app, /clearPartyAssignments\(state\.user\.partySession\)/);
  assert.match(app, /closePlayer\(\)/);
});

