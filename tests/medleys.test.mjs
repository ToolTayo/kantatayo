import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { addMedleyToQueue, advanceMedleyQueue, clearMedleyQueue, createDefaultUserState, getMedleyQueueSnapshot, removeMedleyFromQueue, selectPreviousMedley, setCurrentMedley, validateUserState } from "../src/state.js";
import { isPlayableMedley, loadMedleys, medleyToPlayerItem, normalizeMedleys, reconcileMedleyState } from "../src/medleys.js";

const data = JSON.parse(await readFile(new URL("../data/medleys.sample.json", import.meta.url), "utf8"));
const catalog = JSON.parse(await readFile(new URL("../data/songs.sample.json", import.meta.url), "utf8"));
const audit = JSON.parse(await readFile(new URL("../tools/karaoke-medley-audit.json", import.meta.url), "utf8"));

test("Collections is a first-class destination and medleys reuse the shared player boundary", async () => {
  const [html, app, ui, view] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/ui.js", import.meta.url), "utf8"),
    readFile(new URL("../src/view.js", import.meta.url), "utf8")
  ]);
  assert.match(view, /collections/);
  assert.match(html, /data-view-panel="collections"/);
  assert.match(html, /Karaoke Medleys/);
  assert.match(app, /loadMedleys/);
  assert.match(app, /syncPlayer\(getQueueSnapshot\(state\)\)/);
  assert.match(ui, /data-action="play-medley"/);
  assert.match(ui, /renderCollections/);
});

test("medley dataset validates separately from the song catalog", () => {
  const result = normalizeMedleys(data);
  assert.equal(result.medleys.length, 11);
  assert.equal(result.warnings.length, 0);
  assert.ok(result.medleys.every(isPlayableMedley));
  assert.ok(result.medleys.every((medley) => medley.sectionStatus === "unknown" ? medley.includedSongs.length === 0 : medley.includedSongs.length >= 2));
  assert.equal(new Set(result.medleys.map((medley) => medley.id)).size, result.medleys.length);
  assert.equal(new Set(result.medleys.map((medley) => medley.videoId)).size, result.medleys.length);
  assert.equal(result.medleys.find((medley) => medley.videoId === "9AJt_0ZAtQc")?.verification.testedAt, "2026-10-03");
  assert.equal(result.medleys.find((medley) => medley.videoId === "2J0hjAh06T0")?.includedSongs.length, 3);
  assert.equal(result.medleys.find((medley) => medley.videoId === "eFFlXBGs16w")?.includedSongs.length, 4);
  assert.equal(result.medleys.find((medley) => medley.videoId === "iuDInJI-ZVw")?.sectionStatus, "unknown");
  assert.equal(result.medleys.find((medley) => medley.videoId === "kxZntA43YhE")?.sectionStatus, "unknown");
  assert.equal(result.medleys.find((medley) => medley.videoId === "nDXOKcknAng")?.sectionStatus, "unknown");
  assert.equal(result.medleys.some((medley) => medley.videoId === "O0cT9OUY7yU"), false);
});

test("pending medley verification never makes an entry playable", () => {
  const medley = normalizeMedleys(data).medleys[0];
  assert.equal(isPlayableMedley({ ...medley, verification: { ...medley.verification, status: "runtime-pending" } }), false);
  assert.equal(medleyToPlayerItem({ ...medley, verification: { ...medley.verification, status: "runtime-pending" } }), null);
  assert.equal(isPlayableMedley(medley), true);
});

test("medley video IDs do not duplicate primary catalog assignments", () => {
  const catalogVideoIds = new Set(catalog.map((song) => song.youtubeVideoId).filter(Boolean));
  assert.ok(data.medleys.every((medley) => !catalogVideoIds.has(medley.videoId)));
});

test("duplicate IDs/video IDs and incomplete sections are rejected safely", () => {
  const input = { medleys: [
    data.medleys[0],
    { ...data.medleys[0], id: "medley-duplicate", videoId: data.medleys[0].videoId },
    { ...data.medleys[0], id: "bad", videoId: "not-an-id", includedSongs: [{ title: "One" }] }
  ] };
  const result = normalizeMedleys(input, { logger: { warn() {} } });
  assert.equal(result.medleys.length, 1);
  assert.equal(result.rejectedRecords, 2);
  assert.ok(result.warnings.some((warning) => /duplicated/i.test(warning)));
});

test("genuine medleys may omit unknown sections only with explicit evidence", () => {
  const base = data.medleys[0];
  const accepted = normalizeMedleys({ medleys: [{
    ...base,
    id: "medley-unknown-sections",
    videoId: "AbCdEfGhI-3",
    includedSongs: [],
    sectionStatus: "unknown",
    medleyEvidence: "Public title and description identify a continuous multi-song karaoke medley."
  }] });
  assert.equal(accepted.medleys.length, 1);
  assert.equal(accepted.medleys[0].sectionStatus, "unknown");
  const rejected = normalizeMedleys({ medleys: [{ ...base, id: "medley-no-evidence", videoId: "AbCdEfGhI-4", includedSongs: [], sectionStatus: "unknown" }] }, { logger: { warn() {} } });
  assert.equal(rejected.medleys.length, 0);
});

test("V2 audit records the KaraokeyTV additions and the Atomic no-addition result", () => {
  const candidates = new Map(audit.candidates.map((candidate) => [candidate.videoId, candidate]));
  assert.equal(audit.technicalSummary.publicMedleysKept, 11);
  assert.equal(audit.providerCoverage.find((provider) => provider.provider === "KaraokeyTV")?.promoted, 6);
  assert.equal(audit.providerCoverage.find((provider) => provider.provider === "Atomic Karaoke")?.promoted, 0);
  for (const videoId of ["iuDInJI-ZVw", "kxZntA43YhE", "nDXOKcknAng"]) {
    assert.equal(candidates.get(videoId)?.decision, "ACCEPTED_TECHNICAL_PENDING_MANUAL_AUDIO");
    assert.equal(candidates.get(videoId)?.promoted, true);
  }
  assert.equal(candidates.get("MjJnLgAW1jc")?.decision, "REJECTED_NEAR_DUPLICATE");
  assert.equal(candidates.get("cdfBBrbRUI0")?.decision, "REJECTED_NEAR_DUPLICATE");
  assert.match(audit.providerCoverage.find((provider) => provider.provider === "Atomic Karaoke")?.notes || "", /No Atomic candidate was promoted/);
});

test("medley queue persists as separate stable references and never becomes song history", () => {
  const medleys = normalizeMedleys(data).medleys;
  const secondMedley = { ...medleys[0], id: "medley-test-second", videoId: "AbCdEfGhI-2", title: "Test second medley" };
  const queueMedleys = [...medleys, secondMedley];
  const user = createDefaultUserState();
  assert.equal(addMedleyToQueue(user, queueMedleys[0].id), true);
  assert.equal(addMedleyToQueue(user, queueMedleys[1].id), true);
  assert.equal(setCurrentMedley(user, queueMedleys[0].id), true);
  const snapshot = getMedleyQueueSnapshot(user, queueMedleys);
  assert.equal(snapshot.currentMedley.title, medleys[0].title);
  assert.equal(snapshot.total, 2);
  assert.deepEqual(user.sungHistory, []);
  assert.deepEqual(user.recentlyPlayed, []);
  assert.equal(advanceMedleyQueue(user).currentMedleyId, queueMedleys[1].id);
  assert.equal(selectPreviousMedley(user).currentMedleyId, queueMedleys[0].id);
  assert.equal(removeMedleyFromQueue(user, medleys[0].id), true);
  assert.equal(user.medleyQueue.length, 1);
  assert.equal(clearMedleyQueue(user), true);
  assert.deepEqual(user.medleyQueue, []);
});

test("legacy v4 user state gains medley fields without losing normal state", () => {
  const state = validateUserState({ version: 4, favorites: ["sample-001"], queue: ["sample-002"], currentSongId: "sample-002" });
  assert.deepEqual(state.favorites, ["sample-001"]);
  assert.deepEqual(state.medleyQueue, []);
  assert.equal(state.currentMedleyId, null);
  assert.equal(state.medleyQueueFinished, false);
});

test("stale medley references are dropped on catalog load while valid entries survive", () => {
  const medleys = normalizeMedleys(data).medleys;
  const user = validateUserState({ version: 4, medleyQueue: [medleys[0].id, "medley-deleted"], currentMedleyId: medleys[0].id });
  const reconciled = reconcileMedleyState(user, medleys);
  assert.deepEqual(reconciled.medleyQueue, [medleys[0].id]);
  assert.equal(reconciled.currentMedleyId, medleys[0].id);
});

test("medley metadata remains local and does not call YouTube APIs", async () => {
  const moduleText = await readFile(new URL("../src/medleys.js", import.meta.url), "utf8");
  assert.doesNotMatch(moduleText, /YOUTUBE_API_KEY|googleapis|youtube\/v3|apiKey/i);
  assert.equal(medleyToPlayerItem(data.medleys[0]).youtubeVideoId, "jfBGyW_JYp8");
  assert.equal(typeof loadMedleys, "function");
});
