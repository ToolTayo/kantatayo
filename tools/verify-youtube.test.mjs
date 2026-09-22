import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoComplete, canPromote, isValidVideoId, parseArguments, rankSearchCandidates, searchCandidates, unassignPartyTymeAssignments } from "./verify-youtube.mjs";

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

test("production Party Tyme removals are catalog-only unassignments with preserved IDs and no replacement IDs", async () => {
  const catalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
  const verification = JSON.parse(await readFile("tools/youtube-verification.json", "utf8"));
  const candidates = JSON.parse(await readFile("tools/youtube-candidates.json", "utf8"));
  const expected = {
    "sample-010": "bUIvrsvm9z8",
    "sample-078": "Zyl11FFCT6I",
    "sample-088": "c6sGXheUut4",
    "sample-091": "LuAP8R3LYeQ",
    "sample-092": "i5SWOQlFtUI",
    "sample-093": "Tpyo0fGdc6A",
    "sample-095": "_ELnMAg2Cnw",
    "sample-096": "3NY_dEEcY-A"
  };
  assert.equal(Object.keys(expected).length, 8);
  for (const [songId, videoId] of Object.entries(expected)) {
    assert.equal(catalog.find((song) => song.id === songId)?.youtubeVideoId, null, songId);
    const record = verification.records.find((item) => item.songId === songId && item.candidateVideoId === videoId);
    assert.equal(record?.status, "verified", songId);
    assert.equal(record?.unassignmentProvenance, "user-product-quality-decision", songId);
    assert.match(record?.unassignmentReason || "", /Party Tyme presentation/);
    assert.equal(candidates.candidates.find((item) => item.songId === songId)?.candidateVideoId, videoId, songId);
  }
  assert.equal(catalog.filter((song) => song.youtubeVideoId !== null).length, 129);
  assert.equal(new Set(catalog.filter((song) => song.youtubeVideoId).map((song) => song.youtubeVideoId)).size, 129);
});

test("unassigns only currently promoted Party Tyme records and preserves historical evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-party-tyme-"));
  const catalogPath = join(directory, "songs.json");
  const verificationPath = join(directory, "verification.json");
  const reviewPath = join(directory, "review.json");
  try {
    const catalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
    const verification = JSON.parse(await readFile("tools/youtube-verification.json", "utf8"));
    const partySong = { ...catalog.find((song) => song.id === "sample-010"), youtubeVideoId: "bUIvrsvm9z8" };
    const unrelatedSong = { ...catalog.find((song) => song.id === "sample-011") };
    const partyRecord = { ...verification.records.find((record) => record.songId === "sample-010") };
    delete partyRecord.unassignmentReason;
    delete partyRecord.unassignedAt;
    delete partyRecord.unassignmentProvenance;
    const unrelatedRecord = { ...verification.records.find((record) => record.songId === "sample-011") };
    await writeFile(catalogPath, JSON.stringify([partySong, unrelatedSong], null, 2));
    await writeFile(verificationPath, JSON.stringify({ version: 1, records: [partyRecord, unrelatedRecord] }, null, 2));
    await writeFile(reviewPath, JSON.stringify({ version: 1, flags: [] }, null, 2));

    const result = await unassignPartyTymeAssignments({ catalog: catalogPath, file: verificationPath, review: reviewPath, dryRun: false }, { now: () => new Date("2026-09-22T00:00:00.000Z") });
    assert.deepEqual(result.affected.map((item) => item.songId), ["sample-010"]);
    const nextCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.equal(nextCatalog.find((song) => song.id === "sample-010").youtubeVideoId, null);
    assert.equal(nextCatalog.find((song) => song.id === "sample-011").youtubeVideoId, unrelatedSong.youtubeVideoId);
    const nextVerification = JSON.parse(await readFile(verificationPath, "utf8"));
    const nextRecord = nextVerification.records.find((record) => record.songId === "sample-010");
    assert.equal(nextRecord.status, "verified");
    assert.equal(nextRecord.candidateVideoId, "bUIvrsvm9z8");
    assert.equal(nextRecord.unassignmentProvenance, "user-product-quality-decision");
    assert.match(nextRecord.unassignmentReason, /Party Tyme presentation/);
    const nextReview = JSON.parse(await readFile(reviewPath, "utf8"));
    assert.deepEqual(nextReview.flags[0], {
      songId: "sample-010",
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
    const song = { ...catalog.find((item) => item.id === "sample-010"), youtubeVideoId: null };
    const record = { ...sourceVerification.records.find((item) => item.songId === "sample-010") };
    await writeFile(catalogPath, JSON.stringify([song], null, 2));
    await writeFile(verificationPath, JSON.stringify({ version: 1, records: [record] }, null, 2));
    await writeFile(candidatesPath, JSON.stringify({ version: 1, candidates: [{ songId: "sample-010", candidateVideoId: "bUIvrsvm9z8" }] }, null, 2));
    await writeFile(reviewPath, JSON.stringify({ version: 1, flags: [{ songId: "sample-010", status: "quality-excluded", reason: "user quality decision — Party Tyme presentation does not meet the desired KantaTayo visual experience standard", candidateVideoId: "bUIvrsvm9z8" }] }, null, 2));
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
  const calls = [];
  const query = "Lucky Jason Mraz Colbie Caillat full duet karaoke";
  const result = await searchCandidates({
    catalog: "data/songs.sample.json",
    songId: "sample-008",
    query,
    maxResults: 5,
    maxSongs: 10,
    offset: 0,
    all: false
  }, { fetchImplementation: createMockSearchFetch(calls), apiUrl: "https://mock.test/search" });

  assert.equal(result.errors.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].get("q"), query);
  assert.equal(calls[0].get("maxResults"), "5");
  assert.equal(result.results[0].song.id, "sample-008");
});

test("rejects custom queries with --all", async () => {
  await assert.rejects(
    () => searchCandidates({ catalog: "data/songs.sample.json", query: "custom text", all: true, maxResults: 5, maxSongs: 10, offset: 0 }),
    /--query can only be used.*--all/
  );
});

test("requires a value for --query", () => {
  assert.throws(
    () => parseArguments(["search-candidates", "--song-id", "sample-008", "--query"]),
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
  const catalogPath = "data/songs.sample.json";
  const candidatePath = "tools/youtube-candidates.json";
  const before = await fileHash(catalogPath);
  const candidatesBefore = await fileHash(candidatePath);
  const calls = [];
  const result = await searchCandidates({ catalog: catalogPath, songId: "sample-008", all: false, maxResults: 3, maxSongs: 10, offset: 0 }, { fetchImplementation: createMockSearchFetch(calls), apiUrl: "https://mock.test/search" });
  const after = await fileHash(catalogPath);
  const candidatesAfter = await fileHash(candidatePath);

  assert.equal(result.errors.length, 0);
  assert.equal(calls[0].get("q"), "Lucky Jason Mraz & Colbie Caillat karaoke");
  assert.equal(calls[0].get("maxResults"), "3");
  assert.equal(before, after);
  assert.equal(candidatesBefore, candidatesAfter);
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
