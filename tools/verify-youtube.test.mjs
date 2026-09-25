import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoComplete, canPromote, evaluateAutoHighConfidence, isValidVideoId, parseArguments, parseVideoResponse, rankSearchCandidates, searchCandidates, unassignPartyTymeAssignments } from "./verify-youtube.mjs";

process.env.YOUTUBE_API_KEY = "test-only-key";

test("Party Tyme provider candidates are excluded from automatic promotion", () => {
  const [candidate] = rankSearchCandidates(
    { title: "Demo Song", artist: "Demo Artist" },
    [{ videoId: "ppppppppppp", videoTitle: "Demo Song - Demo Artist Full Karaoke", channelTitle: "Party Tyme Karaoke Channel" }]
  );
  assert.equal(candidate.partyTymeProvider, true);
  assert.equal(candidate.selectable, false);
  assert.match(candidate.reasons.join(" "), /quality-excluded provider: Party Tyme Karaoke/);
  assert.equal(canPromote({ candidateVideoId: "ppppppppppp", apiVerified: true, embeddable: true, madeForKids: false, checkedAt: "2026-09-22T00:00:00.000Z", verifiedAt: "2026-09-22T00:00:00.000Z", status: "verified", channelTitle: "PARTY TYME KARAOKE CHANNEL", manuallyMatched: true, karaokeSuitable: true, provenance: "human-reviewed" }), false);
});

test("HD metadata outranks an otherwise equivalent SD candidate", () => {
  const ranked = rankSearchCandidates(
    { title: "Demo Song", artist: "Demo Artist" },
    [
      { videoId: "aaaaaaaaaaa", videoTitle: "Demo Song - Demo Artist (Karaoke Version)", channelTitle: "Karaoke Channel", definition: "sd", viewCount: 1000000, publishedAt: "2025-01-01T00:00:00Z" },
      { videoId: "bbbbbbbbbbb", videoTitle: "Demo Song - Demo Artist (HD Karaoke Version)", channelTitle: "Karaoke Channel", definition: "hd", viewCount: 1000, publishedAt: "2025-01-01T00:00:00Z" }
    ]
  );
  assert.equal(ranked[0].videoId, "bbbbbbbbbbb");
  assert.equal(ranked[0].hdDefinition, true);
  assert.equal(ranked[1].sdDefinition, true);
});

test("popularity helps comparable valid candidates but cannot bypass hard gates", () => {
  const ranked = rankSearchCandidates(
    { title: "Demo Song", artist: "Demo Artist" },
    [
      { videoId: "aaaaaaaaaaa", videoTitle: "Demo Song - Demo Artist (Karaoke Version)", channelTitle: "Karaoke Channel", definition: "hd", viewCount: 10000000, publishedAt: "2025-01-01T00:00:00Z" },
      { videoId: "bbbbbbbbbbb", videoTitle: "Demo Song - Wrong Artist Official Music Video", channelTitle: "Popular Official Channel", definition: "hd", viewCount: 999999999, publishedAt: "2025-01-01T00:00:00Z" },
      { videoId: "ccccccccccc", videoTitle: "Demo Song - Demo Artist (Female Key Karaoke)", channelTitle: "Popular Karaoke", definition: "hd", viewCount: 999999999, publishedAt: "2025-01-01T00:00:00Z" }
    ]
  );
  assert.equal(ranked[0].videoId, "aaaaaaaaaaa");
  assert.equal(ranked.find((item) => item.videoId === "bbbbbbbbbbb").selectable, false);
  assert.equal(ranked.find((item) => item.videoId === "ccccccccccc").selectable, false);
});

test("substantially more popular equivalent HD karaoke wins over an obscure equivalent upload", () => {
  const ranked = rankSearchCandidates(
    { title: "Demo Song", artist: "Demo Artist" },
    [
      { videoId: "aaaaaaaaaaa", videoTitle: "Demo Song - Demo Artist (HD Karaoke Version)", channelTitle: "Small Karaoke", definition: "hd", viewCount: 40000, publishedAt: "2025-01-01T00:00:00Z" },
      { videoId: "bbbbbbbbbbb", videoTitle: "Demo Song - Demo Artist (HD Karaoke Version)", channelTitle: "Established Karaoke", definition: "hd", viewCount: 8000000, publishedAt: "2025-01-01T00:00:00Z" }
    ]
  );
  assert.equal(ranked[0].videoId, "bbbbbbbbbbb");
  assert.ok(ranked[0].relativePopularityPoints > ranked[1].relativePopularityPoints);
  assert.ok(ranked[0].score - ranked[1].score >= 10);
});

test("hard quality failures remain ineligible despite extreme popularity", () => {
  const titles = [
    "Demo Song - Demo Artist (Live Karaoke)",
    "Demo Song - Demo Artist (Acoustic Karaoke)",
    "Demo Song - Demo Artist (Unplugged Karaoke)",
    "Demo Song - Demo Artist (Karaoke With Guide Melody)",
    "Demo Song - Demo Artist (Karaoke Version)"
  ];
  const ranked = rankSearchCandidates({ title: "Demo Song", artist: "Demo Artist" }, titles.map((videoTitle, index) => ({
    videoId: `${String.fromCharCode(97 + index).repeat(11)}`,
    videoTitle,
    channelTitle: index === 4 ? "Established Karaoke" : "Popular Channel",
    definition: "hd",
    viewCount: index === 4 ? 1000 : 999999999,
    publishedAt: "2025-01-01T00:00:00Z"
  })));
  assert.equal(ranked[0].videoId, "eeeeeeeeeee");
  assert.ok(ranked.slice(1).every((candidate) => candidate.selectable === false));
  assert.ok(ranked.slice(1).every((candidate) => candidate.hardBlocked === true));
});

test("niche songs with modest statistics remain selectable without artificial view thresholds", () => {
  const ranked = rankSearchCandidates(
    { title: "Niche Song", artist: "Niche Artist" },
    [
      { videoId: "aaaaaaaaaaa", videoTitle: "Niche Song - Niche Artist (HD Karaoke Version)", channelTitle: "Small Karaoke", definition: "hd", viewCount: 500, publishedAt: "2025-01-01T00:00:00Z" },
      { videoId: "bbbbbbbbbbb", videoTitle: "Niche Song - Niche Artist (HD Karaoke Version)", channelTitle: "Small Karaoke", definition: "hd", viewCount: 1200, publishedAt: "2025-01-01T00:00:00Z" }
    ]
  );
  assert.ok(ranked.every((candidate) => candidate.selectable));
  assert.ok(Math.abs(ranked[0].score - ranked[1].score) <= 5);
});

test("missing statistics fail safely and identical evidence ranks deterministically", () => {
  const candidates = [
    { videoId: "bbbbbbbbbbb", videoTitle: "Demo Song - Demo Artist (HD Karaoke Version)", channelTitle: "Karaoke Channel", definition: "hd" },
    { videoId: "aaaaaaaaaaa", videoTitle: "Demo Song - Demo Artist (HD Karaoke Version)", channelTitle: "Karaoke Channel", definition: "hd" }
  ];
  const first = rankSearchCandidates({ title: "Demo Song", artist: "Demo Artist" }, candidates);
  const second = rankSearchCandidates({ title: "Demo Song", artist: "Demo Artist" }, candidates);
  assert.deepEqual(first, second);
  assert.ok(first.every((candidate) => candidate.popularityPoints === 0));
});

test("explicit technical failures are hard gates even with high views", () => {
  const [candidate] = rankSearchCandidates(
    { title: "Demo Song", artist: "Demo Artist" },
    [{ videoId: "aaaaaaaaaaa", videoTitle: "Demo Song - Demo Artist (HD Karaoke Version)", channelTitle: "Popular Karaoke", definition: "hd", viewCount: 999999999, apiVerified: true, embeddable: false, madeForKids: false }]
  );
  assert.equal(candidate.selectable, false);
  assert.match(candidate.reasons.join(" "), /not embeddable/);
});

test("API metadata is retained without claiming exact 1080p", () => {
  const [record] = parseVideoResponse({ items: [{
    id: "aaaaaaaaaaa",
    snippet: { title: "Demo Song Karaoke", channelTitle: "Karaoke Channel", publishedAt: "2025-01-01T00:00:00Z", description: "description" },
    status: { embeddable: true, madeForKids: false },
    contentDetails: { definition: "hd", duration: "PT3M" },
    statistics: { viewCount: "12345" }
  }] }, ["aaaaaaaaaaa"]);
  assert.equal(record.definition, "hd");
  assert.equal(record.viewCount, 12345);
  assert.equal(record.likeCount, null);
  assert.equal(record.publishedAt, "2025-01-01T00:00:00Z");
  assert.equal(record.description, "description");
});

test("explicit SD technical evidence blocks automatic high-confidence promotion", () => {
  const result = evaluateAutoHighConfidence(
    { title: "Demo Song", artist: "Demo Artist" },
    rankSearchCandidates({ title: "Demo Song", artist: "Demo Artist" }, [{ videoId: "aaaaaaaaaaa", videoTitle: "Demo Song - Demo Artist Karaoke", channelTitle: "Karaoke Channel", definition: "sd" }]),
    { apiVerified: true, embeddable: true, madeForKids: false, definition: "sd" }
  );
  assert.equal(result.passed, false);
  assert.match(result.reason, /SD/);
});

test("production Party Tyme removals are catalog-only unassignments with preserved IDs and no replacement IDs", async () => {
  const catalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
  const verification = JSON.parse(await readFile("tools/youtube-verification.json", "utf8"));
  const candidates = JSON.parse(await readFile("tools/youtube-candidates.json", "utf8"));
  const expected = verification.records
    .filter((record) => record.unassignmentProvenance === "user-product-quality-decision" && record.candidateVideoId)
    .reduce((result, record) => ({ ...result, [record.songId]: record.candidateVideoId }), {});
  assert.equal(Object.keys(expected).length, 8);
  for (const [songId, videoId] of Object.entries(expected)) {
    assert.equal(catalog.some((song) => song.id === songId), false, songId);
    const record = verification.records.find((item) => item.songId === songId && item.candidateVideoId === videoId);
    assert.equal(record?.status, "verified", songId);
    assert.equal(record?.unassignmentProvenance, "user-product-quality-decision", songId);
    assert.match(record?.unassignmentReason || "", /Party Tyme presentation/);
    assert.equal(candidates.candidates.some((item) => item.songId === songId), false, songId);
  }
  assert.equal(catalog.filter((song) => song.youtubeVideoId !== null).length, 171);
  assert.equal(new Set(catalog.filter((song) => song.youtubeVideoId).map((song) => song.youtubeVideoId)).size, 171);
});

test("unassigns only currently promoted Party Tyme records and preserves historical evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-party-tyme-"));
  const catalogPath = join(directory, "songs.json");
  const verificationPath = join(directory, "verification.json");
  const reviewPath = join(directory, "review.json");
  try {
    const catalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
    const verification = JSON.parse(await readFile("tools/youtube-verification.json", "utf8"));
    const partySong = { ...catalog[0], id: "fixture-party", title: "No Scrubs", artist: "TLC", youtubeVideoId: "bUIvrsvm9z8" };
    const unrelatedSong = { ...catalog.find((song) => song.id === "sample-011") };
    const partyRecord = { ...verification.records.find((record) => record.candidateVideoId === "bUIvrsvm9z8"), songId: "fixture-party" };
    delete partyRecord.unassignmentReason;
    delete partyRecord.unassignedAt;
    delete partyRecord.unassignmentProvenance;
    const unrelatedRecord = { ...verification.records.find((record) => record.songId === "sample-011") };
    await writeFile(catalogPath, JSON.stringify([partySong, unrelatedSong], null, 2));
    await writeFile(verificationPath, JSON.stringify({ version: 1, records: [partyRecord, unrelatedRecord] }, null, 2));
    await writeFile(reviewPath, JSON.stringify({ version: 1, flags: [] }, null, 2));

    const result = await unassignPartyTymeAssignments({ catalog: catalogPath, file: verificationPath, review: reviewPath, dryRun: false }, { now: () => new Date("2026-09-22T00:00:00.000Z") });
    assert.deepEqual(result.affected.map((item) => item.songId), ["fixture-party"]);
    const nextCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.equal(nextCatalog.find((song) => song.id === "fixture-party").youtubeVideoId, null);
    assert.equal(nextCatalog.find((song) => song.id === "sample-011").youtubeVideoId, unrelatedSong.youtubeVideoId);
    const nextVerification = JSON.parse(await readFile(verificationPath, "utf8"));
    const nextRecord = nextVerification.records.find((record) => record.songId === "fixture-party");
    assert.equal(nextRecord.status, "verified");
    assert.equal(nextRecord.candidateVideoId, "bUIvrsvm9z8");
    assert.equal(nextRecord.unassignmentProvenance, "user-product-quality-decision");
    assert.match(nextRecord.unassignmentReason, /Party Tyme presentation/);
    const nextReview = JSON.parse(await readFile(reviewPath, "utf8"));
    assert.deepEqual(nextReview.flags[0], {
      songId: "fixture-party",
      status: "quality-excluded",
      reason: "user quality decision — Party Tyme presentation does not meet the desired KantaTayo visual experience standard",
      updatedAt: "2026-09-22T00:00:00.000Z",
      candidateVideoId: "bUIvrsvm9z8"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("quality-excluded songs are skipped by auto-complete without API requests or re-promotion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-quality-excluded-"));
  const catalogPath = join(directory, "songs.json");
  const verificationPath = join(directory, "verification.json");
  const candidatesPath = join(directory, "candidates.json");
  const reviewPath = join(directory, "review.json");
  try {
    const catalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
    const sourceVerification = JSON.parse(await readFile("tools/youtube-verification.json", "utf8"));
    const song = { ...catalog[0], id: "fixture-quality", title: "No Scrubs", artist: "TLC", youtubeVideoId: null };
    const record = { ...sourceVerification.records.find((item) => item.candidateVideoId === "bUIvrsvm9z8"), songId: "fixture-quality" };
    await writeFile(catalogPath, JSON.stringify([song], null, 2));
    await writeFile(verificationPath, JSON.stringify({ version: 1, records: [record] }, null, 2));
    await writeFile(candidatesPath, JSON.stringify({ version: 1, candidates: [{ songId: "fixture-quality", candidateVideoId: "bUIvrsvm9z8" }] }, null, 2));
    await writeFile(reviewPath, JSON.stringify({ version: 1, flags: [{ songId: "fixture-quality", status: "quality-excluded", reason: "user quality decision — Party Tyme presentation does not meet the desired KantaTayo visual experience standard", candidateVideoId: "bUIvrsvm9z8" }] }, null, 2));
    let calls = 0;
    const result = await autoComplete({ catalog: catalogPath, file: verificationPath, candidates: candidatesPath, review: reviewPath, dryRun: false }, { fetchImplementation: async () => { calls += 1; throw new Error("quality-excluded song should not call the API"); } });
    assert.equal(calls, 0);
    assert.equal(result.promoted.length, 0);
    assert.equal(result.skipped[0].reason.startsWith("quality-excluded:"), true);
    assert.equal(JSON.parse(await readFile(catalogPath, "utf8"))[0].youtubeVideoId, null);
    assert.equal(JSON.parse(await readFile(reviewPath, "utf8")).flags[0].status, "quality-excluded");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts a valid YouTube video ID beginning with a hyphen as --video-id", () => {
  const options = parseArguments([
    "set-candidate",
    "--song-id",
    "sample-006",
    "--video-id",
    "-TWflZWV6C8"
  ]);

  assert.equal(options.videoId, "-TWflZWV6C8");
  assert.equal(isValidVideoId(options.videoId), true);
});

test("continues rejecting an option-like token that is not a valid video ID", () => {
  assert.throws(
    () => parseArguments(["set-candidate", "--song-id", "sample-006", "--video-id", "--help"]),
    /--video-id requires a value/
  );
});

test("uses a custom query exactly and preserves max-results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-search-custom-"));
  const fixtureCatalog = join(directory, "catalog.json");
  await writeFile(fixtureCatalog, JSON.stringify([{ id: "fixture-search", title: "Lucky", artist: "Jason Mraz & Colbie Caillat", language: "English", genre: "Pop", era: "2000s", mood: ["feel-good"], difficulty: "easy", vocalRange: "medium", performanceType: "duet", youtubeVideoId: null, tags: ["duet"] }], null, 2));
  const calls = [];
  const query = "Lucky Jason Mraz Colbie Caillat full duet karaoke";
  try {
    const result = await searchCandidates({ catalog: fixtureCatalog, songId: "fixture-search", query, maxResults: 5, maxSongs: 10, offset: 0, all: false }, { fetchImplementation: createMockSearchFetch(calls), apiUrl: "https://mock.test/search" });
    assert.equal(result.errors.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].get("q"), query);
    assert.equal(calls[0].get("maxResults"), "5");
    assert.equal(result.results[0].song.id, "fixture-search");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects custom queries with --all", async () => {
  await assert.rejects(
    () => searchCandidates({ catalog: "data/songs.sample.json", query: "custom text", all: true, maxResults: 5, maxSongs: 10, offset: 0 }),
    /--query can only be used.*--all/
  );
});

test("requires a value for --query", () => {
  assert.throws(
    () => parseArguments(["search-candidates", "--song-id", "sample-011", "--query"]),
    /--query requires a value/
  );
});

test("rejects an unknown song before making a search request", async () => {
  await assert.rejects(
    () => searchCandidates({ catalog: "data/songs.sample.json", songId: "sample-999", query: "missing song karaoke", all: false, maxResults: 5, maxSongs: 10, offset: 0 }),
    /Song ID "sample-999" was not found/
  );
});

test("automatic catalog search remains unchanged and does not modify the catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-search-auto-"));
  const catalogPath = join(directory, "catalog.json");
  await writeFile(catalogPath, JSON.stringify([{ id: "fixture-search", title: "Lucky", artist: "Jason Mraz & Colbie Caillat", language: "English", genre: "Pop", era: "2000s", mood: ["feel-good"], difficulty: "easy", vocalRange: "medium", performanceType: "duet", youtubeVideoId: null, tags: ["duet"] }], null, 2));
  const candidatePath = "tools/youtube-candidates.json";
  const before = await fileHash(catalogPath);
  const candidatesBefore = await fileHash(candidatePath);
  const calls = [];
  try {
    const result = await searchCandidates({ catalog: catalogPath, songId: "fixture-search", all: false, maxResults: 3, maxSongs: 10, offset: 0 }, { fetchImplementation: createMockSearchFetch(calls), apiUrl: "https://mock.test/search" });
    const after = await fileHash(catalogPath);
    const candidatesAfter = await fileHash(candidatePath);
    assert.equal(result.errors.length, 0);
    assert.equal(calls[0].get("q"), "Lucky Jason Mraz & Colbie Caillat karaoke");
    assert.equal(calls[0].get("maxResults"), "3");
    assert.equal(before, after);
    assert.equal(candidatesBefore, candidatesAfter);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createMockSearchFetch(calls) {
  return async (url) => {
    const params = new URL(url).searchParams;
    calls.push(params);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          items: [{
            id: { videoId: "aaaaaaaaaaa" },
            snippet: { title: "Mock karaoke result", channelTitle: "Mock channel", publishedAt: "2025-01-02T00:00:00Z" }
          }]
        };
      }
    };
  };
}

async function fileHash(path) {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}
