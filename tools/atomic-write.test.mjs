import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, autoComplete } from "./verify-youtube.mjs";

const transientError = () => Object.assign(new Error("operation not permitted"), { code: "EPERM" });

test("atomic catalog replacement retries a transient EPERM and succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-atomic-retry-"));
  const catalog = join(directory, "songs.json");
  let attempts = 0;
  try {
    await writeFile(catalog, JSON.stringify({ version: "old" }));
    await atomicWriteJson(catalog, { version: "new" }, {
      renameRetryLimit: 2,
      sleep: async () => {},
      renameImplementation: async (from, to) => {
        if (to === catalog && attempts++ < 2) throw transientError();
        return rename(from, to);
      }
    });
    assert.deepEqual(JSON.parse(await readFile(catalog, "utf8")), { version: "new" });
    assert.equal(attempts, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic catalog replacement uses a backup swap when Windows refuses overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-atomic-windows-"));
  const catalog = join(directory, "songs.json");
  let destinationAttempts = 0;
  try {
    await writeFile(catalog, JSON.stringify({ version: "old" }));
    await atomicWriteJson(catalog, { version: "new" }, {
      sleep: async () => {},
      renameImplementation: async (from, to) => {
        if (to === catalog && from !== catalog && destinationAttempts++ < 6) throw transientError();
        return rename(from, to);
      }
    });
    assert.deepEqual(JSON.parse(await readFile(catalog, "utf8")), { version: "new" });
    assert.ok(destinationAttempts >= 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed replacement restores the original catalog and leaves recovery data intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-atomic-restore-"));
  const catalog = join(directory, "songs.json");
  let destinationAttempts = 0;
  try {
    await writeFile(catalog, JSON.stringify({ version: "original" }));
    await assert.rejects(() => atomicWriteJson(catalog, { version: "new" }, {
      sleep: async () => {},
      renameImplementation: async (from, to) => {
        if (to === catalog && from.endsWith(".tmp") && destinationAttempts++ < 12) throw transientError();
        return rename(from, to);
      }
    }), /operation not permitted/);
    assert.deepEqual(JSON.parse(await readFile(catalog, "utf8")), { version: "original" });
    const files = await readdir(directory);
    assert.ok(files.some((file) => file.endsWith(".tmp")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("valid stale temporary catalog data is cleaned only after a successful replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-atomic-cleanup-"));
  const catalog = join(directory, "songs.json");
  try {
    await writeFile(catalog, JSON.stringify({ version: "old" }));
    await writeFile(`${catalog}.tmp`, JSON.stringify({ version: "valid-recovery" }));
    await atomicWriteJson(catalog, { version: "new" }, { sleep: async () => {} });
    assert.deepEqual(JSON.parse(await readFile(catalog, "utf8")), { version: "new" });
    await assert.rejects(() => readFile(`${catalog}.tmp`, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("auto-complete resumes from persisted verification without another API request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kantatayo-atomic-resume-"));
  const catalog = join(directory, "catalog.json");
  const candidates = join(directory, "candidates.json");
  const verification = join(directory, "verification.json");
  const review = join(directory, "review.json");
  const song = {
    id: "resume-001",
    title: "Resume Song",
    artist: "Resume Artist",
    language: "English",
    genre: "Pop",
    era: "2020s",
    mood: ["feel-good"],
    difficulty: "easy",
    vocalRange: "medium",
    performanceType: "solo",
    youtubeVideoId: null,
    tags: ["test"]
  };
  const record = {
    songId: song.id,
    candidateVideoId: "resume00001",
    catalogTitle: song.title,
    catalogArtist: song.artist,
    status: "verified",
    apiVerified: true,
    embeddable: true,
    madeForKids: false,
    videoTitle: "Resume Song - Resume Artist (Full Karaoke)",
    channelTitle: "Karaoke Channel",
    provenance: "auto-high-confidence",
    autoChecksPassed: true,
    manuallyMatched: false,
    karaokeSuitable: false,
    decisionReasons: ["exact title and artist match, clear karaoke wording, strict API checks passed"],
    verifiedAt: "2026-09-22T00:00:00.000Z"
  };
  try {
    await writeFile(catalog, JSON.stringify([song], null, 2));
    await writeFile(`${catalog}.tmp`, JSON.stringify([{ ...song, youtubeVideoId: record.candidateVideoId }], null, 2));
    await writeFile(candidates, JSON.stringify({ version: 1, candidates: [{ songId: song.id, candidateVideoId: record.candidateVideoId }] }));
    await writeFile(verification, JSON.stringify({ version: 1, records: [record] }));
    await writeFile(review, JSON.stringify({ version: 1, flags: [] }));
    let apiCalls = 0;
    const result = await autoComplete({ catalog, candidates, file: verification, review, maxResults: 5, dryRun: false }, {
      fetchImplementation: async () => {
        apiCalls += 1;
        throw new Error("persisted verification should have been reused");
      }
    });
    assert.equal(result.promoted.length, 1);
    assert.equal(apiCalls, 0);
    assert.equal(JSON.parse(await readFile(catalog, "utf8"))[0].youtubeVideoId, record.candidateVideoId);
    await assert.rejects(() => readFile(`${catalog}.tmp`, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
