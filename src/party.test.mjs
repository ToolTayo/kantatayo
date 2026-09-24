import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCatalog } from "./catalog.js";
import { addPartySinger, addPartySinger as addSinger, assignPartySong, clearPartyAssignments, clearPartySession, createDefaultPartySession, getPartyStats, getRouletteCandidates, getNextPartySinger, normalizePartySession, recordPartyTurn, removePartySinger, renamePartySinger, selectRouletteSong } from "./party.js";
import { getRecommendations } from "./recommendations.js";
import { addSongToQueue, createAppState, createDefaultUserState, loadUserState, markSung, moveQueueItem, removeSongFromQueue, saveUserState, setCatalog } from "./state.js";

const rawCatalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
const catalog = normalizeCatalog(rawCatalog, { logger: { warn() {} } }).songs;

test("party mode singers validate names, use stable IDs, and rotate deterministically", () => {
  const session = createDefaultPartySession();
  session.enabled = true;
  const first = addPartySinger(session, "  Paolo  ", { idFactory: () => "singer-paolo" });
  const second = addSinger(session, "Ana", { idFactory: () => "singer-ana" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.singer.id, "singer-paolo");
  assert.equal(addPartySinger(session, " paolo ").reason, "duplicate-name");
  assert.equal(addPartySinger(session, "   ").reason, "invalid-name");

  assert.equal(assignPartySong(session, "sample-001").singer.id, "singer-paolo");
  assert.equal(assignPartySong(session, "sample-002").singer.id, "singer-ana");
  assert.equal(assignPartySong(session, "sample-003", "singer-paolo").singer.id, "singer-paolo");
  assert.equal(getNextPartySinger(session).id, "singer-ana");
});

test("manual singer overrides are allowed and removing a singer unassigns their songs", () => {
  const session = createDefaultPartySession();
  addPartySinger(session, "Paolo", { idFactory: () => "p" });
  addPartySinger(session, "Ana", { idFactory: () => "a" });
  assignPartySong(session, "sample-001", "a");
  assert.equal(session.assignments["sample-001"], "a");

  assert.equal(renamePartySinger(session, "a", " Ana Maria ").ok, true);
  assert.equal(session.singers[1].name, "Ana Maria");
  assert.equal(removePartySinger(session, "a").ok, true);
  assert.equal(session.assignments["sample-001"], undefined);
});

test("queue assignments stay attached to song IDs through reorder, removal, and party toggles", () => {
  const userState = createDefaultUserState();
  const session = userState.partySession;
  const a = addPartySinger(session, "A", { idFactory: () => "a" }).singer;
  const b = addPartySinger(session, "B", { idFactory: () => "b" }).singer;

  ["sample-001", "sample-002", "sample-003"].forEach((id) => addSongToQueue(userState, id));
  assignPartySong(session, "sample-001", a.id);
  assignPartySong(session, "sample-002", b.id);
  assignPartySong(session, "sample-003", a.id);
  assert.equal(addSongToQueue(userState, "sample-001"), false);

  moveQueueItem(userState, "sample-003", "up");
  assert.deepEqual(userState.queue, ["sample-001", "sample-003", "sample-002"]);
  assert.equal(session.assignments["sample-001"], a.id);
  assert.equal(session.assignments["sample-002"], b.id);
  assert.equal(session.assignments["sample-003"], a.id);

  session.enabled = false;
  moveQueueItem(userState, "sample-002", "up");
  session.enabled = true;
  assert.equal(session.assignments["sample-002"], b.id);
  removeSongFromQueue(userState, "sample-003");
  delete session.assignments["sample-003"];
  assert.equal(session.assignments["sample-001"], a.id);
  assert.equal(session.assignments["sample-002"], b.id);

  removePartySinger(session, b.id);
  assert.equal(session.assignments["sample-002"], undefined);
  clearPartyAssignments(session);
  assert.deepEqual(session.assignments, {});
});

test("rotation survives singer churn and manual assignment advances to the next singer", () => {
  const session = createDefaultPartySession();
  addPartySinger(session, "A", { idFactory: () => "a" });
  addPartySinger(session, "B", { idFactory: () => "b" });
  addPartySinger(session, "C", { idFactory: () => "c" });
  assert.deepEqual(["sample-001", "sample-002", "sample-003", "sample-004"].map((id) => assignPartySong(session, id).singer.id), ["a", "b", "c", "a"]);

  removePartySinger(session, "b");
  addPartySinger(session, "D", { idFactory: () => "d" });
  assert.equal(renamePartySinger(session, "a", "Alpha").ok, true);
  assert.equal(assignPartySong(session, "sample-005", "c").singer.id, "c");
  assert.equal(assignPartySong(session, "sample-006").singer.id, "d");
  assert.equal(assignPartySong(session, "sample-007").singer.id, "a");

  assert.equal(clearPartySession(session), true);
  assert.deepEqual(session, createDefaultPartySession());
});

test("party stats derive only from recorded turns and catalog metadata", () => {
  const session = createDefaultPartySession();
  addPartySinger(session, "Paolo", { idFactory: () => "p" });
  addPartySinger(session, "Ana", { idFactory: () => "a" });
  recordPartyTurn(session, "sample-001", "p", { completedAt: "2026-09-22T00:00:00.000Z" });
  recordPartyTurn(session, "sample-002", "a", { completedAt: "2026-09-22T00:01:00.000Z" });
  recordPartyTurn(session, "sample-003", null, { completedAt: "2026-09-22T00:02:00.000Z" });

  const stats = getPartyStats(session, catalog);
  assert.equal(stats.songsCompleted, 3);
  assert.equal(stats.turnsCompleted, 3);
  assert.equal(stats.mostActiveSinger.name, "Ana");
  assert.deepEqual(stats.genresSung.map((item) => item.genre).sort(), ["Alternative", "Pop Rock"]);
});

test("party stats count completed actions once and preserve removed-singer history", () => {
  const userState = createDefaultUserState();
  const session = userState.partySession;
  const singer = addPartySinger(session, "Paolo", { idFactory: () => "p" }).singer;
  const firstTime = Date.parse("2026-09-22T00:00:00.000Z");
  const first = markSung(userState, "sample-001", { now: firstTime });
  if (first.added) recordPartyTurn(session, first.entry.id, singer.id, { completedAt: first.entry.sungAt });
  const rapid = markSung(userState, "sample-001", { now: firstTime + 1000 });
  if (rapid.added) recordPartyTurn(session, rapid.entry.id, singer.id, { completedAt: rapid.entry.sungAt });
  const later = markSung(userState, "sample-001", { now: firstTime + 3000 });
  if (later.added) recordPartyTurn(session, later.entry.id, singer.id, { completedAt: later.entry.sungAt });
  recordPartyTurn(session, "sample-003", null, { completedAt: "2026-09-22T00:01:00.000Z" });

  assert.equal(session.turns.length, 3);
  assert.equal(getPartyStats(session, catalog).songsBySinger[0].count, 2);
  removePartySinger(session, singer.id);
  const afterRemoval = getPartyStats(session, catalog);
  assert.equal(afterRemoval.songsCompleted, 3);
  assert.equal(afterRemoval.songsBySinger[0].count, 2);
  assert.equal(afterRemoval.songsBySinger[0].singer.name, "Paolo");
  const reloadedSession = normalizePartySession(session);
  assert.equal(getPartyStats(reloadedSession, catalog).songsBySinger[0].count, 2);
});

test("roulette only selects eligible playable songs and honors constraints", () => {
  const userState = createDefaultUserState();
  userState.queue = ["sample-001"];
  userState.currentSongId = "sample-001";
  userState.dislikedSongs = ["sample-002"];
  userState.sungHistory = [{ id: "sample-003", sungAt: "2026-09-22T00:00:00.000Z" }];
  const session = createDefaultPartySession();
  const candidates = getRouletteCandidates(catalog, userState, { language: "english", difficulty: "easy" }, { partySession: session, now: Date.parse("2026-09-22T00:00:00.000Z") });

  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((song) => song.language === "English" && song.difficulty === "easy" && song.youtubeVideoId));
  assert.ok(candidates.every((song) => !["sample-001", "sample-002", "sample-003", "sample-008"].includes(song.id)));
  assert.equal(selectRouletteSong(catalog, userState, { genre: "pop" }, { partySession: session, random: () => 0 })?.genre, "Pop");
});

test("roulette roll again excludes the previous result without changing the queue", () => {
  const userState = createDefaultUserState();
  const session = createDefaultPartySession();
  const first = selectRouletteSong(catalog, userState, {}, { partySession: session, random: () => 0 });
  const second = selectRouletteSong(catalog, userState, {}, { partySession: session, excludeSongIds: [first.id], random: () => 0 });
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(userState.queue, []);
});

test("roulette stress preserves user state and handles zero and one-song pools", () => {
  const userState = createDefaultUserState();
  userState.queue = ["sample-001"];
  userState.currentSongId = "sample-001";
  userState.dislikedSongs = ["sample-002"];
  const before = JSON.parse(JSON.stringify(userState));
  const candidates = getRouletteCandidates(catalog, userState, {}, { now: Date.parse("2026-09-22T00:00:00.000Z") });
  assert.ok(candidates.every((song) => song.youtubeVideoId && !userState.queue.includes(song.id) && song.id !== userState.currentSongId && !userState.dislikedSongs.includes(song.id)));
  assert.deepEqual(userState, before);
  assert.deepEqual(getRouletteCandidates(catalog, userState, { language: "spanish" }), []);
  const oneSongFolkCatalog = catalog.filter((song) => song.id === "sample-016");
  assert.deepEqual(getRouletteCandidates(oneSongFolkCatalog, userState, { genre: "folk" }).map((song) => song.id), ["sample-016"]);
  assert.equal(selectRouletteSong(oneSongFolkCatalog, userState, { genre: "folk" })?.id, "sample-016");
});

test("party state does not influence deterministic Sing Next recommendations", () => {
  const base = createDefaultUserState();
  const partyState = createDefaultUserState();
  addPartySinger(partyState.partySession, "Paolo", { idFactory: () => "p" });
  partyState.partySession.enabled = true;
  recordPartyTurn(partyState.partySession, "sample-001", "p", { completedAt: "2026-09-22T00:00:00.000Z" });
  partyState.partySession.assignments["sample-002"] = "p";

  const first = getRecommendations(catalog, base, { limit: 5 }).map((item) => [item.song.id, item.reason]);
  const second = getRecommendations(catalog, partyState, { limit: 5 }).map((item) => [item.song.id, item.reason]);
  assert.deepEqual(second, first);
});

test("old state and malformed party state load safely, while catalog reconciliation keeps assignments queue-bound", () => {
  const old = loadUserState({ storage: memoryStorage({ "kantatayo:user-state": JSON.stringify({ version: 1, queue: ["sample-001"], currentSongId: "sample-001" }) }) });
  assert.deepEqual(old.partySession, createDefaultPartySession());

  const malformed = normalizePartySession({ enabled: "yes", singers: [{ id: "x", name: " Paolo " }, { id: "x", name: "Other" }, { id: "y", name: "paolo" }], assignments: { "sample-001": "x", "sample-002": "missing" }, turns: [{ songId: "sample-001", singerId: "x", completedAt: "bad" }] });
  assert.equal(malformed.enabled, true);
  assert.equal(malformed.singers.length, 1);
  assert.deepEqual(malformed.assignments, { "sample-001": "x" });
  assert.deepEqual(malformed.turns, []);

  const appState = createAppState({ ...old, partySession: { ...malformed, enabled: true } });
  appState.user.queue = ["sample-001"];
  setCatalog(appState, catalog, []);
  assert.deepEqual(appState.user.partySession.assignments, { "sample-001": "x" });
});

test("clearing party session does not alter personal state", () => {
  const userState = createDefaultUserState();
  userState.favorites = ["sample-001"];
  userState.queue = ["sample-001"];
  userState.partySession.enabled = true;
  addPartySinger(userState.partySession, "Paolo", { idFactory: () => "p" });
  recordPartyTurn(userState.partySession, "sample-001", "p");
  assert.equal(clearPartySession(userState.partySession), true);
  assert.deepEqual(userState.partySession, createDefaultPartySession());
  assert.deepEqual(userState.favorites, ["sample-001"]);
  assert.deepEqual(userState.queue, ["sample-001"]);
});

test("party integration stays local and does not alter recommendation or YouTube boundaries", async () => {
  const [app, party, serviceWorker] = await Promise.all([
    readFile("src/app.js", "utf8"),
    readFile("src/party.js", "utf8"),
    readFile("service-worker.js", "utf8")
  ]);
  assert.match(app, /recordPartyTurn/);
  assert.match(app, /selectRouletteSong/);
  assert.doesNotMatch(party, /fetch\(|XMLHttpRequest|https?:\/\//);
  assert.doesNotMatch(serviceWorker, /https?:\/\//);
  assert.equal((await saveUserState(createDefaultUserState(), { storage: memoryStorage() })), true);
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}
