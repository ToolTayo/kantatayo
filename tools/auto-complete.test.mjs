import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoComplete,
  canPromote,
  evaluateAutoHighConfidence,
  parseArguments,
  rankSearchCandidates
} from "./verify-youtube.mjs";

test("auto-complete promotes an exact high-confidence karaoke match without fake human approval", async () => {
  const fixture = await createFixture([song("test-001", "Song One", "Artist One", null)]);
  const calls = [];
  try {
    const result = await autoComplete(options(fixture), mockFetch(calls, {
      "Song One": { id: "aaaaaaaaaaa", title: "Song One - Artist One (HD Karaoke)", channel: "Karaoke Channel", status: { embeddable: true, madeForKids: false } }
    }));
    assert.equal(result.promoted.length, 1, JSON.stringify(result));
    const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
    assert.equal(catalog[0].youtubeVideoId, "aaaaaaaaaaa");
    const record = JSON.parse(await readFile(fixture.verification, "utf8")).records[0];
    assert.equal(record.status, "verified");
    assert.equal(record.provenance, "auto-high-confidence");
    assert.equal(record.autoChecksPassed, true);
    assert.equal(record.manuallyMatched, false);
    assert.equal(record.karaokeSuitable, false);
    assert.equal(canPromote(record), true);
    assert.equal(calls.filter((call) => call.kind === "search").length, 1);
    assert.equal(calls.filter((call) => call.kind === "videos").length, 1);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("auto-complete retries a 429 with Retry-After and persists one clean promotion", async () => {
  const fixture = await createFixture([song("test-017", "Song Seventeen", "Artist Seventeen", null)]);
  const calls = [];
  const delays = [];
  let searchAttempts = 0;
  try {
    const result = await autoComplete(options(fixture, { retryLimit: 2 }), {
      apiKey: "private-test-key",
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 5000,
      sleep: async (delay) => delays.push(delay),
      fetchImplementation: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/search")) {
          searchAttempts += 1;
          calls.push({ kind: "search", attempt: searchAttempts });
          if (searchAttempts === 1) return apiErrorResponse(429, "rateLimitExceeded", { "Retry-After": "2" });
          return searchResponse({ id: "qqqqqqqqqqq", title: "Song Seventeen - Artist Seventeen (Full Karaoke)", channel: "Karaoke Channel" });
        }
        calls.push({ kind: "videos" });
        return videoResponse("qqqqqqqqqqq", "Song Seventeen - Artist Seventeen (Full Karaoke)", "Karaoke Channel");
      }
    });
    assert.equal(result.promoted.length, 1);
    assert.equal(searchAttempts, 2);
    assert.deepEqual(delays, [2000]);
    assert.equal(JSON.parse(await readFile(fixture.candidates, "utf8")).candidates.length, 1);
    assert.equal(JSON.parse(await readFile(fixture.verification, "utf8")).records.length, 1);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("429 defers only attempted work, skips cooldown, then recovers idempotently", async () => {
  const fixture = await createFixture([
    song("test-018", "Song Eighteen", "Artist Eighteen", null),
    song("test-019", "Song Nineteen", "Artist Nineteen", null)
  ]);
  const now = new Date("2026-09-22T00:00:00.000Z");
  try {
    const first = await autoComplete(options(fixture, { retryLimit: 0, deferredCooldownBaseMs: 1000, deferredCooldownMaxMs: 1000 }), {
      apiKey: "private-test-key",
      now: () => now,
      fetchImplementation: async () => apiErrorResponse(429, "rateLimitExceeded")
    });
    assert.equal(first.promoted.length, 0);
    assert.equal(first.rows.filter((row) => row.state === "deferred-rate-limit").length, 1);
    assert.equal(first.rows.filter((row) => row.state === "pending").length, 1);
    const reviewAfterFailure = JSON.parse(await readFile(fixture.review, "utf8"));
    assert.deepEqual(reviewAfterFailure.flags.map((flag) => [flag.songId, flag.status]), [["test-018", "deferred-rate-limit"]]);
    assert.equal(reviewAfterFailure.flags[0].attemptCount, 1);
    assert.equal(reviewAfterFailure.flags[0].httpClassification, "temporary-rate-limit");

    const secondCalls = [];
    const second = await autoComplete(options(fixture, { deferredCooldownBaseMs: 1000, deferredCooldownMaxMs: 1000 }), {
      apiKey: "private-test-key",
      now: () => now,
      fetchImplementation: async (url) => {
        const parsed = new URL(url);
        secondCalls.push(parsed.pathname.endsWith("/search") ? "search" : "videos");
        if (parsed.pathname.endsWith("/search")) {
          assert.match(parsed.searchParams.get("q"), /^Song Nineteen/);
          return searchResponse({ id: "sssssssssss", title: "Song Nineteen - Artist Nineteen (Karaoke)", channel: "Karaoke Channel" });
        }
        return videoResponse("sssssssssss", "Song Nineteen - Artist Nineteen (Karaoke)", "Karaoke Channel");
      }
    });
    assert.equal(second.promoted.length, 1);
    assert.deepEqual(secondCalls, ["search", "videos"]);
    assert.equal(second.summary.deferredRateLimitThisRun, 0);
    assert.equal(second.summary.retriedDeferredThisRun, 0);
    assert.equal(JSON.parse(await readFile(fixture.review, "utf8")).flags.length, 1);

    now.setTime(now.getTime() + 1001);
    const thirdCalls = [];
    const third = await autoComplete(options(fixture, { deferredCooldownBaseMs: 1000, deferredCooldownMaxMs: 1000 }), {
      apiKey: "private-test-key",
      now: () => now,
      fetchImplementation: async (url) => {
        const parsed = new URL(url);
        thirdCalls.push(parsed.pathname.endsWith("/search") ? "search" : "videos");
        if (parsed.pathname.endsWith("/search")) return searchResponse({ id: "rrrrrrrrrrr", title: "Song Eighteen - Artist Eighteen (Karaoke)", channel: "Karaoke Channel" });
        return videoResponse("rrrrrrrrrrr", "Song Eighteen - Artist Eighteen (Karaoke)", "Karaoke Channel");
      }
    });
    assert.equal(third.promoted.length, 1);
    assert.deepEqual(thirdCalls, ["search", "videos"]);
    assert.equal(third.summary.retriedDeferredThisRun, 1);
    assert.equal(third.summary.recoveredDeferredThisRun, 1);
    assert.equal(JSON.parse(await readFile(fixture.review, "utf8")).flags.length, 0);

    const fourthCalls = [];
    const fourth = await autoComplete(options(fixture), {
      fetchImplementation: async () => { fourthCalls.push("unexpected"); throw new Error("should not request"); }
    });
    assert.equal(fourth.promoted.length, 0);
    assert.deepEqual(fourthCalls, []);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("search-phase rate limiting with already-selected candidates never reaches an undefined deferred array", async () => {
  const fixture = await createFixture([
    song("test-search-halt-known", "Known Candidate", "Known Artist", null),
    song("test-search-halt-new", "New Candidate", "New Artist", null)
  ], [], [{ songId: "test-search-halt-known", candidateVideoId: "known000001" }]);
  let calls = 0;
  try {
    const result = await autoComplete(options(fixture, { retryLimit: 0 }), {
      apiKey: "private-test-key",
      fetchImplementation: async () => {
        calls += 1;
        return apiErrorResponse(429, "rateLimitExceeded");
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.promoted.length, 0);
    assert.equal(result.rows.filter((row) => row.state === "deferred-rate-limit").length, 2);
    assert.equal(result.summary.deferredRateLimitThisRun, 2);
    assert.equal(JSON.parse(await readFile(fixture.review, "utf8")).flags.length, 2);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("daily quota exhaustion stops further API requests and records deferred provenance", async () => {
  const fixture = await createFixture([
    song("test-020", "Song Twenty", "Artist Twenty", null),
    song("test-021", "Song Twenty One", "Artist Twenty One", null)
  ]);
  let calls = 0;
  try {
    const result = await autoComplete(options(fixture), {
      apiKey: "private-test-key",
      fetchImplementation: async () => {
        calls += 1;
        return apiErrorResponse(403, "quotaExceeded");
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.rows.filter((row) => row.state === "quota-deferred").length, 1);
    assert.equal(result.rows.filter((row) => row.state === "pending").length, 1);
    assert.match(result.rows[0].reason, /quota appears exhausted/);
    assert.equal(JSON.parse(await readFile(fixture.review, "utf8")).flags[0].status, "quota-deferred");
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("a technically known candidate records deferred-rate-limit provenance without duplicating records", async () => {
  const fixture = await createFixture([song("test-025", "Song Twenty Five", "Artist Twenty Five", null)], [], [{ songId: "test-025", candidateVideoId: "zzzzzzzzzzz" }]);
  const now = new Date("2026-09-22T00:00:00.000Z");
  const technical = {
    songId: "test-025",
    candidateVideoId: "zzzzzzzzzzz",
    catalogTitle: "Song Twenty Five",
    catalogArtist: "Artist Twenty Five",
    status: "candidate",
    apiVerified: true,
    embeddable: true,
    madeForKids: false,
    videoTitle: "Song Twenty Five - Artist Twenty Five (Karaoke)",
    channelTitle: "Karaoke Channel",
    provenance: "technically-verified-only",
    checkedAt: "2026-09-22T00:00:00.000Z",
    verifiedAt: null
  };
  await writeFile(fixture.verification, JSON.stringify({ version: 1, records: [technical] }, null, 2));
  try {
    await autoComplete(options(fixture, { retryLimit: 0, deferredCooldownBaseMs: 1000, deferredCooldownMaxMs: 1000 }), { apiKey: "private-test-key", now: () => now, fetchImplementation: async () => apiErrorResponse(429, "rateLimitExceeded") });
    const deferred = JSON.parse(await readFile(fixture.verification, "utf8"));
    assert.equal(deferred.records.length, 1);
    assert.equal(deferred.records[0].provenance, "deferred-rate-limit");

    now.setTime(now.getTime() + 1001);
    const resumed = await autoComplete(options(fixture, { deferredCooldownBaseMs: 1000, deferredCooldownMaxMs: 1000 }), {
      apiKey: "private-test-key",
      now: () => now,
      fetchImplementation: async (url) => {
        const id = new URL(url).searchParams.get("id");
        return videoResponse(id, "Song Twenty Five - Artist Twenty Five (Karaoke)", "Karaoke Channel");
      }
    });
    assert.equal(resumed.promoted.length, 1);
    assert.equal(JSON.parse(await readFile(fixture.verification, "utf8")).records.length, 1);
    assert.equal(JSON.parse(await readFile(fixture.verification, "utf8")).records[0].provenance, "auto-high-confidence");
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("Retry-After becomes a persisted cooldown and the deferred song recovers after eligibility", async () => {
  const fixture = await createFixture([song("test-retry-after", "Retry After", "Retry Artist", null)]);
  const now = new Date("2026-09-22T00:00:00.000Z");
  let calls = 0;
  try {
    await autoComplete(options(fixture, { retryLimit: 0 }), {
      apiKey: "private-test-key",
      now: () => now,
      fetchImplementation: async () => {
        calls += 1;
        return apiErrorResponse(429, "rateLimitExceeded", { "Retry-After": "5" });
      }
    });
    const firstFlag = JSON.parse(await readFile(fixture.review, "utf8")).flags[0];
    assert.equal(firstFlag.attemptCount, 1);
    assert.equal(firstFlag.httpStatus, 429);
    assert.equal(firstFlag.retryAfterMs, 5000);
    assert.equal(firstFlag.nextEligibleAt, "2026-09-22T00:00:05.000Z");

    now.setTime(now.getTime() + 4999);
    const beforeCooldown = await autoComplete(options(fixture), {
      now: () => now,
      fetchImplementation: async () => { throw new Error("cooldown should prevent requests"); }
    });
    assert.equal(beforeCooldown.summary.retriedDeferredThisRun, 0);
    assert.equal(beforeCooldown.summary.deferredRateLimitThisRun, 0);
    assert.equal(calls, 1);

    now.setTime(now.getTime() + 1);
    const recovered = await autoComplete(options(fixture), {
      apiKey: "private-test-key",
      now: () => now,
      fetchImplementation: async (url) => {
        calls += 1;
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/search")) return searchResponse({ id: "retry000001", title: "Retry After - Retry Artist (Karaoke)", channel: "Karaoke Channel" });
        return videoResponse("retry000001", "Retry After - Retry Artist (Karaoke)", "Karaoke Channel");
      }
    });
    assert.equal(recovered.promoted.length, 1);
    assert.equal(recovered.summary.retriedDeferredThisRun, 1);
    assert.equal(recovered.summary.recoveredDeferredThisRun, 1);
    assert.equal(JSON.parse(await readFile(fixture.review, "utf8")).flags.length, 0);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("quota-deferred state stops work, cools down, and recovers without duplicate records", async () => {
  const fixture = await createFixture([song("test-quota", "Quota Song", "Quota Artist", null)]);
  const now = new Date("2026-09-22T00:00:00.000Z");
  try {
    const first = await autoComplete(options(fixture, { retryLimit: 0, deferredCooldownBaseMs: 1000, deferredCooldownMaxMs: 2000 }), {
      apiKey: "private-test-key",
      now: () => now,
      fetchImplementation: async () => apiErrorResponse(403, "quotaExceeded")
    });
    assert.equal(first.summary.quotaDeferredThisRun, 1);
    assert.equal(first.summary.deferredRateLimitThisRun, 0);
    assert.equal(JSON.parse(await readFile(fixture.review, "utf8")).flags[0].httpClassification, "quota-exhausted");

    now.setTime(now.getTime() + 1999);
    const blocked = await autoComplete(options(fixture), { now: () => now, fetchImplementation: async () => { throw new Error("quota cooldown should prevent requests"); } });
    assert.equal(blocked.summary.retriedDeferredThisRun, 0);
    assert.equal(blocked.summary.quotaDeferredTotal, 1);

    now.setTime(now.getTime() + 1);
    const recovered = await autoComplete(options(fixture), {
      apiKey: "private-test-key",
      now: () => now,
      fetchImplementation: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/search")) return searchResponse({ id: "quota000001", title: "Quota Song - Quota Artist (Karaoke)", channel: "Karaoke Channel" });
        return videoResponse("quota000001", "Quota Song - Quota Artist (Karaoke)", "Karaoke Channel");
      }
    });
    assert.equal(recovered.promoted.length, 1);
    assert.equal(recovered.summary.quotaDeferredTotal, 0);
    assert.equal(JSON.parse(await readFile(fixture.verification, "utf8")).records.length, 1);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("a recovered deferred candidate transitions to review-required on technical rejection", async () => {
  const fixture = await createFixture([song("test-review-transition", "Review Transition", "Review Artist", null)], [
    { songId: "test-review-transition", status: "deferred-rate-limit", reason: "old temporary throttle", candidateVideoId: "review00001", attemptCount: 2, nextEligibleAt: "2026-09-21T00:00:00.000Z" }
  ], [{ songId: "test-review-transition", candidateVideoId: "review00001" }]);
  try {
    const result = await autoComplete(options(fixture, { retryLimit: 0 }), {
      apiKey: "private-test-key",
      fetchImplementation: async () => ({ ok: true, status: 200, async json() { return { items: [{ id: "review00001", status: { embeddable: false, madeForKids: false }, snippet: { title: "Review Transition - Review Artist (Karaoke)", channelTitle: "Karaoke Channel" } }] }; } })
    });
    assert.equal(result.promoted.length, 0);
    assert.equal(result.summary.retriedDeferredThisRun, 1);
    assert.equal(result.summary.recoveredDeferredThisRun, 1);
    const review = JSON.parse(await readFile(fixture.review, "utf8"));
    assert.equal(review.flags[0].status, "review-required");
    assert.equal(review.flags[0].status === "deferred-rate-limit" || review.flags[0].status === "quota-deferred", false);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("cooldown-pending legacy state keeps a deferred fixture out of per-run review decisions and counts unique songs", async () => {
  const fixture = await createFixture([
    song("sample-071", "Dati", "Sam Concepcion", null),
    song("fixture-072", "Araw-Araw", "Ben&Ben", null),
    song("sample-073", "Pagsamo", "Arthur Nery", null)
  ], [
    { songId: "sample-071", status: "deferred-rate-limit", reason: "legacy deferred", nextEligibleAt: "2026-09-22T01:00:00.000Z", attemptCount: "invalid" },
    { songId: "fixture-072", status: "deferred-rate-limit", reason: "legacy deferred", nextEligibleAt: "2026-09-22T01:00:00.000Z" },
    { songId: "sample-073", status: "review-required", reason: "persisted review" },
    { songId: "sample-073", status: "review-required", reason: "duplicate review" }
  ]);
  try {
    const result = await autoComplete(options(fixture), {
      now: () => new Date("2026-09-22T00:00:00.000Z"),
      fetchImplementation: async () => { throw new Error("cooldown state should prevent requests"); }
    });
    assert.equal(result.summary.apiStatus, "not-needed");
    assert.equal(result.summary.retriedDeferredThisRun, 0);
    assert.equal(result.summary.deferredRateLimitThisRun, 0);
    assert.equal(result.summary.deferredRateLimitTotal, 2);
    assert.equal(result.summary.reviewRequiredTotal, 1);
    assert.equal(result.summary.pendingEligibleTotal, 2);
    assert.equal(result.rows.filter((row) => row.state === "pending").map((row) => row.song.id).sort().join(","), "fixture-072,sample-071");
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("promoted songs are removed from stale deferred state automatically", async () => {
  const fixture = await createFixture([song("test-promoted-stale", "Promoted Stale", "Artist", "promoted001")], [
    { songId: "test-promoted-stale", status: "deferred-rate-limit", reason: "stale deferred", candidateVideoId: "promoted001" }
  ]);
  await writeFile(fixture.verification, JSON.stringify({ version: 1, records: [{ songId: "test-promoted-stale", candidateVideoId: "promoted001", status: "candidate", provenance: "deferred-rate-limit" }] }, null, 2));
  try {
    const result = await autoComplete(options(fixture), { fetchImplementation: async () => { throw new Error("promoted song should not request"); } });
    assert.equal(result.summary.deferredRateLimitTotal, 0);
    assert.equal(JSON.parse(await readFile(fixture.review, "utf8")).flags.length, 0);
    assert.equal(JSON.parse(await readFile(fixture.verification, "utf8")).records.length, 0);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("completed songs make no API requests on an idempotent rerun", async () => {
  const fixture = await createFixture([song("test-022", "Already Done", "Artist Done", "ttttttttttt")]);
  try {
    const result = await autoComplete(options(fixture), {
      fetchImplementation: async () => { throw new Error("should not request"); }
    });
    assert.equal(result.promoted.length, 0);
    assert.equal(result.rows.length, 0);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("safe close candidates resolve deterministically while wrong-artist candidates remain review-required", async () => {
  const fixture = await createFixture([
    song("test-002", "Song Two", "Artist Two", null),
    song("test-003", "Song Three", "Artist Three", null)
  ]);
  try {
    const result = await autoComplete(options(fixture), mockFetch([], {
      "Song Two": [
        { id: "bbbbbbbbbbb", title: "Song Two - Artist Two (Karaoke)", channel: "Karaoke Channel", status: { embeddable: true, madeForKids: false } },
        { id: "ccccccccccc", title: "Artist Two - Song Two (Karaoke)", channel: "Karaoke Channel", status: { embeddable: true, madeForKids: false } }
      ],
      "Song Three": [{ id: "ddddddddddd", title: "Song Three - Other Artist (Karaoke)", channel: "Karaoke Channel", status: { embeddable: true, madeForKids: false } }]
    }));
    assert.equal(result.promoted.length, 1);
    assert.equal(result.promoted[0].song.id, "test-002");
    assert.equal(result.held.length, 1, JSON.stringify(result));
    assert.equal(result.held[0].song.id, "test-003");
    assert.equal(result.rows.find((row) => row.song.id === "test-003").state, "review");
    const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
    assert.equal(catalog.find((item) => item.id === "test-002").youtubeVideoId, "bbbbbbbbbbb");
    assert.equal(catalog.find((item) => item.id === "test-003").youtubeVideoId, null);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("strict technical gates hold non-embeddable, Made-for-Kids, and unknown-status videos", async () => {
  const fixture = await createFixture([
    song("test-004", "Song Four", "Artist Four", null),
    song("test-005", "Song Five", "Artist Five", null),
    song("test-006", "Song Six", "Artist Six", null)
  ]);
  try {
    const result = await autoComplete(options(fixture), mockFetch([], {
      "Song Four": [{ id: "eeeeeeeeeee", title: "Song Four - Artist Four (Karaoke)", channel: "Karaoke Channel", status: { embeddable: false, madeForKids: false } }],
      "Song Five": [{ id: "fffffffffff", title: "Song Five - Artist Five (Karaoke)", channel: "Karaoke Channel", status: { embeddable: true, madeForKids: true } }],
      "Song Six": [{ id: "ggggggggggg", title: "Song Six - Artist Six (Karaoke)", channel: "Karaoke Channel", status: { embeddable: true } }]
    }));
    assert.equal(result.promoted.length, 0);
    assert.equal(result.held.length, 3, JSON.stringify(result));
    assert.ok(result.held.every(({ reason }) => /embeddable|madeForKids/.test(reason)));
    const records = JSON.parse(await readFile(fixture.verification, "utf8")).records;
    assert.ok(records.every((record) => record.provenance === "review-required"));
    assert.ok(records.every((record) => record.manuallyMatched === false && record.karaokeSuitable === false));
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("explicitly unresolved songs are skipped and auto-complete is idempotent", async () => {
  const fixture = await createFixture([
    song("fixture-008", "Lucky", "Jason Mraz & Colbie Caillat", null),
    song("fixture-042", "Mr. Suave", "Andrew E.", null),
    song("test-007", "Song Seven", "Artist Seven", null)
  ], [
    { songId: "fixture-008", status: "unresolved", reason: "no acceptable fixture candidate" },
    { songId: "fixture-042", status: "review-required", reason: "fixture needs review" }
  ]);
  const calls = [];
  try {
    const first = await autoComplete(options(fixture), mockFetch(calls, {
      "Song Seven": [{ id: "hhhhhhhhhhh", title: "Song Seven - Artist Seven (Karaoke)", channel: "Karaoke Channel", status: { embeddable: true, madeForKids: false } }]
    }));
    assert.equal(first.promoted.length, 1);
    assert.equal(first.skipped.length, 2);
    const firstCallCount = calls.length;
    const secondCalls = [];
    const second = await autoComplete(options(fixture), mockFetch(secondCalls, {}));
    assert.equal(second.promoted.length, 0);
    assert.equal(secondCalls.length, 0);
    assert.ok(firstCallCount > 0);
    const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
    assert.equal(catalog.find((item) => item.id === "fixture-008").youtubeVideoId, null);
    assert.equal(catalog.find((item) => item.id === "fixture-042").youtubeVideoId, null);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("auto-complete skips a candidate that is already promoted for another song", async () => {
  const fixture = await createFixture([
    song("test-015", "Song Fifteen", "Artist Fifteen", null),
    song("test-016", "Already Live", "Artist Sixteen", "ppppppppppp")
  ], [], [{ songId: "test-015", candidateVideoId: "ppppppppppp" }]);
  const calls = [];
  try {
    const result = await autoComplete(options(fixture), mockFetch(calls, {}));
    assert.equal(result.promoted.length, 0);
    assert.equal(result.held.length, 1);
    assert.equal(result.rows[0].state, "review");
    assert.match(result.rows[0].reason, /already promoted/);
    assert.equal(calls.length, 0);
    const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
    assert.equal(catalog.find((item) => item.id === "test-015").youtubeVideoId, null);
    assert.equal(catalog.find((item) => item.id === "test-016").youtubeVideoId, "ppppppppppp");
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("sample-063 through sample-069 candidates are reevaluated using strict metadata rules", async () => {
  const fixture = await createFixture([
    song("sample-063", "Your Song", "Parokya ni Edgar", null),
    song("sample-068", "Prom", "Sugarfree", null)
  ], [], [
    { songId: "sample-063", candidateVideoId: "iiiiiiiiiii" },
    { songId: "sample-068", candidateVideoId: "jjjjjjjjjjj" }
  ]);
  try {
    const result = await autoComplete(options(fixture), mockFetch([], {
      "iiiiiiiiiii": { id: "iiiiiiiiiii", title: "Parokya Ni Edgar - Your Song (Karaoke)", channel: "Mi Balmz Karaoke Tracks", status: { embeddable: true, madeForKids: false } },
      "jjjjjjjjjjj": { id: "jjjjjjjjjjj", title: "Sugarfree | Prom HQ Karaoke", channel: "Otep333 Karaoke Trackz", status: { embeddable: true, madeForKids: false } }
    }, true));
    assert.equal(result.promoted.length, 2);
    const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
    assert.equal(catalog.find((item) => item.id === "sample-063").youtubeVideoId, "iiiiiiiiiii");
    assert.equal(catalog.find((item) => item.id === "sample-068").youtubeVideoId, "jjjjjjjjjjj");
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("partial API failure promotes only the technically verified match and never logs the key", async () => {
  const fixture = await createFixture([
    song("test-010", "Song Ten", "Artist Ten", null),
    song("test-011", "Song Eleven", "Artist Eleven", null)
  ]);
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.join(" "));
  try {
    const result = await autoComplete(options(fixture), mockFetch([], {
      "Song Ten": [{ id: "kkkkkkkkkkk", title: "Song Ten - Artist Ten (Karaoke)", channel: "Karaoke Channel", status: { embeddable: true, madeForKids: false } }],
      "Song Eleven": [{ id: "lllllllllll", title: "Song Eleven - Artist Eleven (Karaoke)", channel: "Karaoke Channel", status: { embeddable: true, madeForKids: false } }]
    }, false, ["lllllllllll"]));
    assert.equal(result.promoted.length, 1);
    assert.equal(result.promoted[0].song.id, "test-010");
    assert.ok(result.held.some(({ song }) => song.id === "test-011"));
    assert.equal(errors.some((line) => line.includes("private-test-key")), false);
  } finally {
    console.error = originalError;
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("malformed verification state fails before public catalog mutation", async () => {
  const fixture = await createFixture([song("test-012", "Song Twelve", "Artist Twelve", null)]);
  try {
    await writeFile(fixture.verification, "not-json");
    await assert.rejects(() => autoComplete(options(fixture), mockFetch([], {})), /invalid JSON/);
    const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
    assert.equal(catalog[0].youtubeVideoId, null);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("candidate evaluator rejects altered keys and explicit negative metadata", () => {
  const songData = song("test-013", "Song Thirteen", "Artist Thirteen", null);
  const negative = evaluateAutoHighConfidence(songData, [{ videoId: "mmmmmmmmmmm", videoTitle: "Song Thirteen - Artist Thirteen (Lower Key Karaoke)", channelTitle: "Karaoke Channel", score: 90, confidence: "high", selectable: true, reasons: ["title match", "artist match", "karaoke", "warning: altered key"] }], { apiVerified: true, embeddable: true, madeForKids: false });
  assert.equal(negative.passed, false);
  assert.match(negative.reason, /warning: altered key/);
});

test("candidate ranking blocks non-karaoke and altered-version results", () => {
  const songData = song("test-014", "Song Fourteen", "Artist Fourteen", null);
  const blockedTitles = [
    "Song Fourteen - Artist Fourteen Official Music Video",
    "Song Fourteen - Artist Fourteen Lyrics",
    "Song Fourteen - Artist Fourteen Original Audio",
    "Song Fourteen - Artist Fourteen Live Performance",
    "Song Fourteen - Artist Fourteen Cover",
    "Song Fourteen - Artist Fourteen Lower Key Karaoke",
    "Song Fourteen - Artist Fourteen Female Key Karaoke"
  ];
  for (const videoTitle of blockedTitles) {
    const [candidate] = rankSearchCandidates(songData, [{ videoId: "nnnnnnnnnnn", videoTitle, channelTitle: "Karaoke Channel" }]);
    assert.equal(candidate.selectable, false, videoTitle);
  }
  assert.equal(parseArguments(["auto-complete"]).command, "auto-complete");
});

test("ranking uses exact identity and standard-version evidence for safe tie resolution", () => {
  const songData = song("test-023", "Song Twenty Three", "Artist Twenty Three", null);
  const ranked = rankSearchCandidates(songData, [
    { videoId: "uuuuuuuuuuu", videoTitle: "Song Twenty Three - Artist Twenty Three (Karaoke)", channelTitle: "General Channel" },
    { videoId: "vvvvvvvvvvv", videoTitle: "Song Twenty Three - Artist Twenty Three (Full Karaoke Version)", channelTitle: "Karaoke Channel" },
    { videoId: "wwwwwwwwwww", videoTitle: "Song Twenty Three - Other Artist (Full Karaoke Version)", channelTitle: "Karaoke Channel" }
  ]);
  assert.equal(ranked[0].videoId, "vvvvvvvvvvv");
  assert.equal(ranked[0].selectable, true);
  assert.equal(ranked.find((candidate) => candidate.videoId === "wwwwwwwwwww").selectable, false);
});

test("genuinely different non-standard versions remain unresolved", () => {
  const songData = song("test-024", "Song Twenty Four", "Artist Twenty Four", null);
  const ranked = rankSearchCandidates(songData, [
    { videoId: "xxxxxxxxxxx", videoTitle: "Song Twenty Four - Artist Twenty Four Acoustic Karaoke", channelTitle: "Karaoke Channel" },
    { videoId: "yyyyyyyyyyy", videoTitle: "Song Twenty Four - Artist Twenty Four Remix Karaoke", channelTitle: "Karaoke Channel" }
  ]);
  assert.ok(ranked.every((candidate) => candidate.selectable === false));
  assert.ok(ranked.every((candidate) => candidate.reasons.some((reason) => /non-standard version/.test(reason))));
});

test("sanitized real-state fixture completes safely across four idempotent runs", async () => {
  const promotedSongs = Array.from({ length: 68 }, (_, index) => {
    const id = `promoted-${String(index + 1).padStart(3, "0")}`;
    return song(id, `Promoted Song ${index + 1}`, `Promoted Artist ${index + 1}`, `p${String(index + 1).padStart(10, "0")}`);
  });
  const eligibleSongs = [
    song("test-close", "Close Candidate", "Close Artist", null),
    song("test-no-candidate", "No Candidate", "No Artist", null),
    song("test-deferred", "Deferred Candidate", "Deferred Artist", null),
    song("fixture-008", "Lucky", "Jason Mraz & Colbie Caillat", null),
    song("fixture-009", "Endless Love", "Lionel Richie & Diana Ross", null),
    song("fixture-042", "Mr. Suave", "Andrew E.", null)
  ];
  const fixture = await createFixture([...promotedSongs, ...eligibleSongs], [], [
    { songId: "test-close", candidateVideoId: "oldclose001" },
    { songId: "test-deferred", candidateVideoId: "defer000001" },
    { songId: "bad-song", candidateVideoId: "invalid-id" }
  ]);
  const humanRecords = promotedSongs.slice(0, 59).map((item) => verifiedRecord(item.id, item.youtubeVideoId, "human-reviewed"));
  const autoRecords = promotedSongs.slice(59).map((item) => verifiedRecord(item.id, item.youtubeVideoId, "auto-high-confidence"));
  const oldClose = {
    songId: "test-close",
    candidateVideoId: "oldclose001",
    catalogTitle: "Close Candidate",
    catalogArtist: "Close Artist",
    status: "candidate",
    apiVerified: true,
    embeddable: true,
    madeForKids: false,
    videoTitle: "Close Candidate - Close Artist (Karaoke)",
    channelTitle: "Old Karaoke Channel",
    provenance: "review-required",
    reviewReason: "multiple acceptable candidates are too close in score"
  };
  const deferredRecord = {
    songId: "test-deferred",
    candidateVideoId: "defer000001",
    catalogTitle: "Deferred Candidate",
    catalogArtist: "Deferred Artist",
    status: "candidate",
    apiVerified: true,
    embeddable: true,
    madeForKids: false,
    videoTitle: "Deferred Candidate - Deferred Artist (Karaoke)",
    channelTitle: "Deferred Karaoke Channel",
    provenance: "deferred-rate-limit"
  };
  const now = new Date("2026-09-22T00:00:00.000Z");
  try {
    await writeFile(fixture.verification, JSON.stringify({ version: 1, records: [...humanRecords, ...autoRecords, oldClose, deferredRecord, { songId: "malformed", candidateVideoId: null }] }, null, 2));
    await writeFile(fixture.review, JSON.stringify({ version: 1, flags: [{ songId: "malformed-flag" }, { songId: "fixture-008", status: "unresolved", reason: "fixture exception" }] }, null, 2));

    let videoAttempts = 0;
    const first = await autoComplete(options(fixture, { retryLimit: 0 }), {
      apiKey: "private-test-key",
      now: () => now,
      deferredCooldownBaseMs: 1000,
      deferredCooldownMaxMs: 1000,
      fetchImplementation: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/search")) {
          if (parsed.searchParams.get("q").startsWith("Close Candidate")) return searchResponse({ id: "newclose001", title: "Close Candidate - Close Artist (Full Karaoke)", channel: "Karaoke Channel" });
          return searchResponse({ id: "not-a-match", title: "", channel: "" });
        }
        videoAttempts += 1;
        return apiErrorResponse(429, "rateLimitExceeded");
      }
    });
    assert.equal(first.promoted.length, 0);
    assert.equal(first.rows.filter((row) => row.state === "deferred-rate-limit" || row.state === "quota-deferred").length, 2);
    assert.ok(first.rows.some((row) => row.song.id === "test-close" && /deferred/.test(row.reason)));
    assert.equal(videoAttempts, 1);
    assert.equal(first.summary.deferredRateLimitThisRun, 1);
    assert.equal(first.summary.deferredRateLimitTotal, 2);
    assert.equal(JSON.parse(await readFile(fixture.verification, "utf8")).records.some((record) => record.songId === "malformed"), false);

    const secondCalls = [];
    now.setTime(now.getTime() + 1001);
    const second = await autoComplete(options(fixture, { deferredCooldownBaseMs: 1000, deferredCooldownMaxMs: 1000 }), {
      apiKey: "private-test-key",
      now: () => now,
      fetchImplementation: async (url) => {
        const parsed = new URL(url);
        secondCalls.push(parsed.pathname.endsWith("/search") ? "search" : "videos");
        if (parsed.pathname.endsWith("/search")) return { ok: true, status: 200, async json() { return { items: [] }; } };
        const ids = parsed.searchParams.get("id").split(",");
        return { ok: true, status: 200, async json() { return { items: ids.map((id) => ({ id, status: { embeddable: true, madeForKids: false }, snippet: { title: id === "newclose001" ? "Close Candidate - Close Artist (Full Karaoke)" : "Deferred Candidate - Deferred Artist (Karaoke)", channelTitle: "Karaoke Channel" } })) }; } };
      }
    });
    assert.equal(second.promoted.length, 2);
    assert.equal(secondCalls.filter((kind) => kind === "videos").length, 1);
    assert.equal(second.summary.deferredRateLimitThisRun, 0);
    assert.equal(second.summary.deferredRateLimitTotal, 0);
    assert.equal(second.summary.retriedDeferredThisRun, 2);
    assert.equal(second.summary.recoveredDeferredThisRun, 2);
    assert.equal(JSON.parse(await readFile(fixture.candidates, "utf8")).candidates.filter((candidate) => candidate.songId === "test-close").length, 1);
    assert.equal(JSON.parse(await readFile(fixture.verification, "utf8")).records.length, 70);

    const thirdCalls = [];
    const third = await autoComplete(options(fixture), {
      now: () => now,
      apiKey: "private-test-key",
      fetchImplementation: async (url) => {
        thirdCalls.push(new URL(url).pathname.endsWith("/search") ? "search" : "videos");
        return { ok: true, status: 200, async json() { return { items: [] }; } };
      }
    });
    assert.equal(third.promoted.length, 0);
    assert.deepEqual(thirdCalls, []);
    assert.equal(third.summary.autoPromotedThisRun, 0);
    assert.equal(third.summary.autoHighConfidenceTotal, 11);
    assert.equal(third.rows.length, 4);
    const finalCatalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
    assert.equal(finalCatalog.filter((item) => item.youtubeVideoId).length, 70);
    assert.equal(finalCatalog.find((item) => item.id === "fixture-008").youtubeVideoId, null);
    assert.equal(finalCatalog.find((item) => item.id === "fixture-009").youtubeVideoId, null);
    assert.equal(finalCatalog.find((item) => item.id === "fixture-042").youtubeVideoId, null);
    const finalRecords = JSON.parse(await readFile(fixture.verification, "utf8")).records;
    assert.equal(finalRecords.length, 70);
    assert.equal(new Set(finalRecords.map((record) => `${record.songId}::${record.candidateVideoId}`)).size, finalRecords.length);

    const fourthCalls = [];
    const fourth = await autoComplete(options(fixture), {
      now: () => now,
      apiKey: "private-test-key",
      fetchImplementation: async (url) => {
        fourthCalls.push(new URL(url).pathname.endsWith("/search") ? "search" : "videos");
        return { ok: true, status: 200, async json() { return { items: [] }; } };
      }
    });
    assert.equal(fourth.promoted.length, 0);
    assert.deepEqual(fourthCalls, []);
    assert.equal(JSON.parse(await readFile(fixture.verification, "utf8")).records.length, 70);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

function song(id, title, artist, youtubeVideoId) {
  return {
    id, title, artist, language: "English", genre: "Pop", era: "2020s", mood: ["feel-good"], difficulty: "easy", vocalRange: "medium", performanceType: "solo", youtubeVideoId, tags: ["test"]
  };
}

function verifiedRecord(songId, candidateVideoId, provenance) {
  const human = provenance === "human-reviewed";
  return {
    songId,
    candidateVideoId,
    status: "verified",
    apiVerified: true,
    embeddable: true,
    madeForKids: false,
    videoTitle: "Promoted Karaoke",
    channelTitle: "Karaoke Channel",
    manuallyMatched: human,
    karaokeSuitable: human,
    provenance,
    autoChecksPassed: !human,
    checkedAt: "2026-09-22T00:00:00.000Z",
    verifiedAt: "2026-09-22T00:00:00.000Z"
  };
}

function options(fixture, overrides = {}) {
  return { catalog: fixture.catalog, candidates: fixture.candidates, file: fixture.verification, review: fixture.review, maxResults: 5, dryRun: false, ...overrides };
}

function mockFetch(calls, mapping, mappingByVideoId = false, omitVideoIds = []) {
  return {
    apiKey: "private-test-key",
    searchApiUrl: "https://mock.test/search",
    apiUrl: "https://mock.test/videos",
    fetchImplementation: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/search")) {
        const query = parsed.searchParams.get("q");
        calls.push({ kind: "search", query });
        const key = Object.keys(mapping).find((value) => query.includes(value));
        const items = Array.isArray(mapping[key]) ? mapping[key] : key ? [mapping[key]] : [];
        return { ok: true, status: 200, async json() { return { items: items.map((item) => ({ id: { videoId: item.id }, snippet: { title: item.title, channelTitle: item.channel } })) }; } };
      }
      const ids = parsed.searchParams.get("id").split(",");
      calls.push({ kind: "videos", ids });
      const items = ids.filter((id) => !omitVideoIds.includes(id)).map((id) => {
        const item = mappingByVideoId ? Object.values(mapping).flat().find((value) => value.id === id) : Object.values(mapping).flat().find((value) => value.id === id);
        return { id, status: item?.status || { embeddable: true, madeForKids: false }, snippet: { title: item?.title || "Unknown", channelTitle: item?.channel || "Unknown" } };
      });
      return { ok: true, status: 200, async json() { return { items }; } };
    }
  };
}

function searchResponse(item) {
  return { ok: true, status: 200, async json() { return { items: [{ id: { videoId: item.id }, snippet: { title: item.title, channelTitle: item.channel } }] }; } };
}

function videoResponse(id, title, channel) {
  return { ok: true, status: 200, async json() { return { items: [{ id, status: { embeddable: true, madeForKids: false }, snippet: { title, channelTitle: channel } }] }; } };
}

function apiErrorResponse(status, reason, headers = {}) {
  return {
    ok: false,
    status,
    headers: { get(name) { return headers[name] ?? headers[name.toLowerCase()] ?? headers["Retry-After"] ?? null; } },
    async json() { return { error: { errors: [{ reason }] } }; }
  };
}

async function createFixture(songs, flags = [], candidateMappings = []) {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-auto-complete-"));
  const catalog = join(directory, "catalog.json");
  const candidates = join(directory, "candidates.json");
  const verification = join(directory, "verification.json");
  const review = join(directory, "review.json");
  await writeFile(catalog, JSON.stringify(songs, null, 2));
  await writeFile(candidates, JSON.stringify({ version: 1, candidates: candidateMappings }, null, 2));
  await writeFile(verification, JSON.stringify({ version: 1, records: [] }, null, 2));
  await writeFile(review, JSON.stringify({ version: 1, flags }, null, 2));
  return { catalog, candidates, verification, review, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
