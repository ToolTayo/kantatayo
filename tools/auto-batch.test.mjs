import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  approveBatch,
  autoBatch,
  batchVerifyCandidates,
  cleanupVerification,
  normalizeCandidateMappings,
  normalizeVerificationStore,
  rankSearchCandidates
} from "./verify-youtube.mjs";

test("candidate ranking is conservative and explains positive and negative signals", () => {
  const song = { title: "Song One", artist: "Artist One", performanceType: "solo" };
  const ranked = rankSearchCandidates(song, [
    { videoId: "aaaaaaaaaaa", videoTitle: "Song One - Artist One (HD Karaoke)", channelTitle: "Karaoke Channel" },
    { videoId: "bbbbbbbbbbb", videoTitle: "Song One - Artist One (Official Music Video)", channelTitle: "Artist One" },
    { videoId: "ccccccccccc", videoTitle: "Song One lyrics", channelTitle: "Lyrics Channel" }
  ]);

  assert.equal(ranked[0].videoId, "aaaaaaaaaaa");
  assert.equal(ranked[0].selectable, true);
  assert.equal(ranked[0].confidence, "high");
  assert.equal(ranked[1].selectable, false);
  assert.ok(ranked[1].reasons.some((reason) => /official\/music video/.test(reason)));
  assert.equal(ranked[2].selectable, false);
  assert.ok(ranked[2].reasons.some((reason) => /lyrics-only/.test(reason)));
});

test("auto-batch binds selected candidates to songs before one batched technical verification", async () => {
  const fixture = await createFixture([
    song("test-001", "Song One", "Artist One", null),
    song("test-002", "Song Two", "Artist Two", null),
    song("test-003", "Song Three", "Artist Three", null),
    song("test-004", "Already Promoted", "Existing Artist", "promoted001")
  ]);
  const calls = [];
  try {
    const result = await autoBatch(options(fixture, { maxSongs: 3 }), { apiKey: "test-only-key", apiUrl: "https://mock.test/videos", searchApiUrl: "https://mock.test/search", fetchImplementation: mockFetch(calls, {
      "Song One": { id: "aaaaaaaaaaa", title: "Song One - Artist One (HD Karaoke)", channel: "Karaoke Channel", embeddable: true },
      "Song Two": { id: "bbbbbbbbbbb", title: "Song Two - Artist Two (Karaoke)", channel: "Karaoke Channel", embeddable: false },
      "Song Three": { id: "ccccccccccc", title: "Song Three - Artist Three (Karaoke)", channel: "Karaoke Channel", embeddable: true }
    }) });

    assert.equal(result.newMappings.length, 3);
    assert.equal(calls.filter((call) => call.kind === "search").length, 3);
    const videoCalls = calls.filter((call) => call.kind === "videos");
    assert.equal(videoCalls.length, 1);
    assert.equal(videoCalls[0].ids.length, 3);

    const candidates = JSON.parse(await readFile(fixture.candidates, "utf8"));
    assert.deepEqual(candidates.candidates, [
      { songId: "test-001", candidateVideoId: "aaaaaaaaaaa" },
      { songId: "test-002", candidateVideoId: "bbbbbbbbbbb" },
      { songId: "test-003", candidateVideoId: "ccccccccccc" }
    ]);
    const verification = JSON.parse(await readFile(fixture.verification, "utf8"));
    assert.equal(verification.records.length, 3);
    assert.ok(verification.records.every((record) => record.songId && record.manuallyMatched === false && record.karaokeSuitable === false));
    assert.equal(verification.records.find((record) => record.songId === "test-002").embeddable, false);

    const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
    assert.equal(catalog.find((item) => item.id === "test-004").youtubeVideoId, "promoted001");
    assert.ok(catalog.slice(0, 3).every((item) => item.youtubeVideoId === null));
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("auto-batch skips explicit review flags and does not silently correct metadata", async () => {
  const fixture = await createFixture([
    song("test-008", "Lucky", "Artist Eight", null),
    song("test-042", "Mr. Suave", "Andrew E.", null),
    song("test-043", "Clean Song", "Clean Artist", null)
  ], [{ songId: "test-008", status: "unresolved", reason: "No candidate" }, { songId: "test-042", status: "review-required", reason: "Review metadata" }]);
  const calls = [];
  try {
    const result = await autoBatch(options(fixture, { maxSongs: 3 }), { apiKey: "test-only-key", apiUrl: "https://mock.test/videos", searchApiUrl: "https://mock.test/search", fetchImplementation: mockFetch(calls, {
      "Clean Song": { id: "ddddddddddd", title: "Clean Song - Clean Artist (Karaoke)", channel: "Karaoke Channel", embeddable: true }
    }) });
    assert.equal(result.newMappings.length, 1);
    assert.equal(calls.filter((call) => call.kind === "search").length, 1);
    assert.equal(result.rows.find((row) => row.song.id === "test-042").selected, null);
    const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
    assert.equal(catalog.find((item) => item.id === "test-042").artist, "Andrew E.");
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("bulk approval requires confirmation, approves only listed songs, and never overwrites promoted IDs", async () => {
  const fixture = await createFixture([
    song("test-001", "Song One", "Artist One", null),
    song("test-002", "Song Two", "Artist Two", null),
    song("test-004", "Already Promoted", "Existing Artist", "promoted001")
  ]);
  try {
    await writeFile(fixture.verification, JSON.stringify({ version: 1, records: [
      verifiedRecord("test-001", "aaaaaaaaaaa"),
      verifiedRecord("test-002", "bbbbbbbbbbb"),
      verifiedRecord("test-004", "promoted001")
    ] }, null, 2));
    await assert.rejects(() => approveBatch({ ...options(fixture), songIds: "test-001", manualMatch: true, karaokeSuitable: true }), /--confirm/);
    const result = await approveBatch({ ...options(fixture), songIds: "test-001,test-004", manualMatch: true, karaokeSuitable: true, confirm: true });
    assert.deepEqual(result.promoted, [{ songId: "test-001", videoId: "aaaaaaaaaaa" }]);
    assert.ok(result.skipped.some((item) => item.songId === "test-004" && item.reason === "already-promoted"));
    const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
    assert.equal(catalog.find((item) => item.id === "test-001").youtubeVideoId, "aaaaaaaaaaa");
    assert.equal(catalog.find((item) => item.id === "test-002").youtubeVideoId, null);
    assert.equal(catalog.find((item) => item.id === "test-004").youtubeVideoId, "promoted001");
    const verification = JSON.parse(await readFile(fixture.verification, "utf8"));
    assert.equal(verification.records.find((record) => record.songId === "test-001").manuallyMatched, true);
    assert.equal(verification.records.find((record) => record.songId === "test-002").manuallyMatched, false);
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("cleanup removes only unambiguous promoted orphans and identical duplicates", async () => {
  const fixture = await createFixture([
    song("test-001", "Song One", "Artist One", "aaaaaaaaaaa"),
    song("test-002", "Song Two", "Artist Two", null)
  ]);
  try {
    const linked = verifiedRecord("test-001", "aaaaaaaaaaa");
    const orphan = { ...linked, songId: null, catalogTitle: null, catalogArtist: null };
    const duplicate = { ...linked };
    await writeFile(fixture.verification, JSON.stringify({ version: 1, records: [linked, orphan, duplicate] }, null, 2));
    const result = await cleanupVerification(options(fixture));
    assert.equal(result.removed.length, 2);
    assert.equal(result.kept.length, 1);
    const stored = JSON.parse(await readFile(fixture.verification, "utf8"));
    assert.equal(stored.records.length, 1);
    assert.equal(stored.records[0].songId, "test-001");
  } finally {
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("candidate and verification normalization rejects conflicts without mutating public data", () => {
  const catalog = [song("test-001", "Song One", "Artist One", null), song("test-002", "Song Two", "Artist Two", null)];
  const normalized = normalizeCandidateMappings({ version: 1, candidates: [
    { songId: "test-001", candidateVideoId: "aaaaaaaaaaa" },
    { songId: "test-001", candidateVideoId: "aaaaaaaaaaa" },
    { songId: "test-002", candidateVideoId: "aaaaaaaaaaa" }
  ] }, catalog);
  assert.equal(normalized.candidates.length, 1);
  assert.equal(normalized.rejected.length, 2);
  assert.throws(() => normalizeVerificationStore({ version: 1, records: [verifiedRecord("test-001", "aaaaaaaaaaa"), verifiedRecord("test-001", "aaaaaaaaaaa")] }), /duplicate candidate key/);
});

test("API failures leave the public catalog unchanged and do not log the API key", async () => {
  const fixture = await createFixture([song("test-001", "Song One", "Artist One", null)]);
  const before = await fileHash(fixture.catalog);
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.join(" "));
  try {
    const result = await autoBatch(options(fixture), {
      apiKey: "private-test-key",
      apiUrl: "https://mock.test/videos",
      searchApiUrl: "https://mock.test/search",
      fetchImplementation: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/search")) return { ok: true, status: 200, async json() { return { items: [{ id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "Song One - Artist One (Karaoke)", channelTitle: "Karaoke Channel" } }] }; } };
        throw new Error("network unavailable");
      }
    });
    assert.equal(result.verification.records.length, 0);
    assert.equal(await fileHash(fixture.catalog), before);
    assert.equal(errors.some((line) => line.includes("private-test-key")), false);
    assert.equal(JSON.parse(await readFile(fixture.verification, "utf8")).records.length, 0);
  } finally {
    console.error = originalError;
    process.exitCode = 0;
    await fixture.cleanup();
  }
});

test("batch verification chunks videos.list requests at fifty IDs", async () => {
  const songs = Array.from({ length: 51 }, (_, index) => song(`test-${String(index + 1).padStart(3, "0")}`, `Song ${index + 1}`, `Artist ${index + 1}`, null));
  const fixture = await createFixture(songs);
  const calls = [];
  try {
    const candidates = songs.map((item, index) => ({ songId: item.id, candidateVideoId: `a${String(index).padStart(10, "0")}` }));
    await writeFile(fixture.candidates, JSON.stringify({ version: 1, candidates }, null, 2));
    const result = await batchVerifyCandidates(options(fixture), {
      apiKey: "test-only-key",
      apiUrl: "https://mock.test/videos",
      fetchImplementation: async (url) => {
        const ids = new URL(url).searchParams.get("id").split(",");
        calls.push(ids);
        return { ok: true, status: 200, async json() { return { items: ids.map((id) => ({ id, status: { embeddable: true, madeForKids: false }, snippet: { title: "Fixture Karaoke", channelTitle: "Fixture Channel" } })) }; } };
      }
    });
    assert.equal(result.failedBatches, 0);
    assert.deepEqual(calls.map((ids) => ids.length), [50, 1]);
    assert.equal(JSON.parse(await readFile(fixture.verification, "utf8")).records.length, 51);
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

function verifiedRecord(songId, videoId) {
  return {
    songId, candidateVideoId: videoId, catalogTitle: "Fixture", catalogArtist: "Fixture Artist", status: "candidate", apiVerified: true, embeddable: true, madeForKids: false, videoTitle: "Fixture Karaoke", channelTitle: "Fixture Channel", manuallyMatched: false, karaokeSuitable: false, checkedAt: "2026-09-22T00:00:00.000Z", verifiedAt: null, lastError: null
  };
}

function options(fixture, overrides = {}) {
  return {
    catalog: fixture.catalog,
    candidates: fixture.candidates,
    file: fixture.verification,
    review: fixture.review,
    maxSongs: 10,
    maxResults: 5,
    offset: 0,
    dryRun: false,
    ...overrides
  };
}

function mockFetch(calls, results) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/search")) {
      const query = parsed.searchParams.get("q");
      calls.push({ kind: "search", query });
      const key = Object.keys(results).find((title) => query.includes(title));
      const item = results[key];
      return {
        ok: true,
        status: 200,
        async json() {
          return { items: item ? [{ id: { videoId: item.id }, snippet: { title: item.title, channelTitle: item.channel, publishedAt: "2026-09-22T00:00:00Z" } }] : [] };
        }
      };
    }
    const ids = parsed.searchParams.get("id").split(",");
    calls.push({ kind: "videos", ids });
    return {
      ok: true,
      status: 200,
      async json() {
        return { items: ids.map((id) => {
          const item = Object.values(results).find((candidate) => candidate.id === id);
          return { id, status: { embeddable: item?.embeddable ?? true, madeForKids: false }, snippet: { title: item?.title || "Fixture Karaoke", channelTitle: item?.channel || "Karaoke Channel" } };
        }) };
      }
    };
  };
}

async function createFixture(songs, flags = []) {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-auto-batch-"));
  const catalog = join(directory, "catalog.json");
  const candidates = join(directory, "candidates.json");
  const verification = join(directory, "verification.json");
  const review = join(directory, "review.json");
  await writeFile(catalog, JSON.stringify(songs, null, 2));
  await writeFile(candidates, JSON.stringify({ version: 1, candidates: [] }, null, 2));
  await writeFile(verification, JSON.stringify({ version: 1, records: [] }, null, 2));
  await writeFile(review, JSON.stringify({ version: 1, flags }, null, 2));
  return { catalog, candidates, verification, review, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function fileHash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
