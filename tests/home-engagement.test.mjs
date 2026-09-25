import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { completeDailyChallenge, createDefaultUserState } from "../src/state.js";
import { getDailyChallenge } from "../src/engagement.js";

const [html, ui, css] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/ui.js", import.meta.url), "utf8"),
  readFile(new URL("../styles/main.css", import.meta.url), "utf8")
]);

const songs = [
  { id: "home-001", title: "Home Song", artist: "Home Artist", language: "English", genre: "Pop", era: "2020s", mood: ["upbeat"], difficulty: "easy", vocalRange: "medium", performanceType: "solo", youtubeVideoId: "abcdefghijk", tags: ["karaoke"] },
  { id: "home-002", title: "Second Song", artist: "Second Artist", language: "Filipino", genre: "Ballad", era: "2010s", mood: ["romantic"], difficulty: "medium", vocalRange: "high", performanceType: "duet", youtubeVideoId: "bcdefghijkl", tags: ["karaoke"] }
];

test("Home keeps the challenge visible before completion and handles a first-ever streak clearly", () => {
  const state = createDefaultUserState();
  const challenge = getDailyChallenge(songs, state, { now: new Date(2026, 8, 25, 10) });
  assert.ok(challenge.song);
  assert.equal(challenge.completed, false);
  assert.equal(challenge.currentStreak, 0);
  assert.equal(challenge.longestStreak, 0);
  assert.match(html, /Sing Today.s Challenge/);
  assert.match(html, /Today.s karaoke challenge/);
  assert.match(html, /data-daily-meta/);
});

test("Home challenge reports active and completed streaks with correct singular/plural language", () => {
  const activeState = createDefaultUserState();
  activeState.dailyChallenge.completedDates = ["2026-09-24"];
  const active = getDailyChallenge(songs, activeState, { now: new Date(2026, 8, 25, 10) });
  assert.equal(active.completed, false);
  assert.equal(active.currentStreak, 1);

  const completeState = createDefaultUserState();
  const completed = getDailyChallenge(songs, completeState, { now: new Date(2026, 8, 25, 10) });
  assert.equal(completeDailyChallenge(completeState, completed.dateKey, completed.song.id, { now: new Date(2026, 8, 25, 10), expectedSongId: completed.song.id }), true);
  const after = getDailyChallenge(songs, completeState, { now: new Date(2026, 8, 25, 12) });
  assert.equal(after.completed, true);
  assert.equal(after.currentStreak, 1);
  assert.match(ui, /formatDayCount/);
  assert.match(ui, /No streak yet/);
  assert.match(ui, /Challenge complete/);
});

test("Home places the challenge before Continue Singing and hides Continue when empty", () => {
  const challengeIndex = html.indexOf("data-daily-challenge");
  const continueIndex = html.indexOf('data-section="continue"');
  assert.ok(challengeIndex >= 0 && continueIndex > challengeIndex);
  assert.match(html, /data-section="continue"[^>]*hidden/);
  assert.match(ui, /homeSectionOrder = \["continue", "recommended"/);
  assert.match(ui, /continue: \{ title: "Continue singing", lede: "Unfinished songs you opened recently\." \}/);
  assert.match(ui, /sectionElement\.hidden = isRecommended \? false : songs\.length === 0/);
});

test("challenge status is announced accessibly and sparse shelves stay bounded", () => {
  assert.match(html, /data-daily-status[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /data-daily-streak[^>]*>0 days/);
  assert.match(css, /home-utility-grid[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /@media \(min-width: 760px\)[\s\S]*?home-utility-grid[\s\S]*?minmax\(18rem, \.8fr\)/);
  assert.match(css, /\.song-grid,\s*\.compact-grid[\s\S]*?minmax\(min\(100%, 16rem\), 20rem\)/);
  assert.match(css, /\.song-thumbnail\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9/);
});

test("completed challenge has a non-misleading disabled action and remains identifiable", () => {
  assert.match(ui, /button\.disabled = challenge\.completed/);
  assert.match(ui, /button\.textContent = challenge\.completed \? "Completed Today/);
  assert.match(ui, /card\.classList\.toggle\("is-complete", challenge\.completed\)/);
  assert.match(css, /daily-challenge-card \.play-button:disabled[\s\S]*?cursor: default/);
});
