import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyProductionDecisions, auditProductionAssignments } from "./production-quality-audit.mjs";

test("production audit compares promoted assignments with mocked candidates without mutating catalog state", async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || ".", "kantatayo-production-audit-"));
  const catalogPath = join(directory, "songs.json");
  const verificationPath = join(directory, "verification.json");
  const demandPath = join(directory, "demand.json");
  const outputPath = join(directory, "audit.json");
  const markdownPath = join(directory, "audit.md");
  try {
    const sourceCatalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
    const sourceSong = sourceCatalog.find((song) => song.id === "sample-101");
    const sourceVerification = JSON.parse(await readFile("tools/youtube-verification.json", "utf8"));
    const sourceRecord = sourceVerification.records.find((record) => record.songId === "sample-101");
    await writeFile(catalogPath, JSON.stringify([sourceSong], null, 2));
    await writeFile(verificationPath, JSON.stringify({ version: 1, records: [sourceRecord] }, null, 2));
    await writeFile(demandPath, JSON.stringify({ signals: [{ songId: "sample-101", demandTier: "very-high", evidence: [{ rank: 1 }] }] }));
    const before = JSON.stringify(JSON.parse(await readFile(catalogPath, "utf8")));
    const result = await auditProductionAssignments({ catalog: catalogPath, verification: verificationPath, demand: demandPath, output: outputPath, markdown: markdownPath, queryCount: 2, maxResults: 2 }, {
      apiKey: "mock-key",
      searchApiUrl: "https://mock.test/search",
      videoApiUrl: "https://mock.test/videos",
      fetchImplementation: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/search")) {
          return { ok: true, status: 200, async json() { return { items: [
            { id: { videoId: "bbbbbbbbbbb" }, snippet: { title: "Kung Sakali - Michael Pangilinan (HD Karaoke Version)", channelTitle: "Atomic Karaoke", publishedAt: "2025-01-01T00:00:00Z" } },
            { id: { videoId: "ccccccccccc" }, snippet: { title: "Kung Sakali - Wrong Artist Official Music Video", channelTitle: "Popular Official Channel", publishedAt: "2025-01-01T00:00:00Z" } }
          ] }; } };
        }
        const ids = parsed.searchParams.get("id").split(",");
        const metadata = new Map([
          ["9hrT301x000", { title: "Kung Sakali - Michael Pangilinan (Karaoke Version)", channel: "KaraokeyTV", views: "1000" }],
          ["bbbbbbbbbbb", { title: "Kung Sakali - Michael Pangilinan (HD Karaoke Version)", channel: "Atomic Karaoke", views: "100000" }],
          ["ccccccccccc", { title: "Kung Sakali - Wrong Artist Official Music Video", channel: "Popular Official Channel", views: "999999999" }]
        ]);
        return { ok: true, status: 200, async json() { return { items: ids.map((id) => {
          const item = metadata.get(id);
          return item ? { id, snippet: { title: item.title, channelTitle: item.channel, publishedAt: "2025-01-01T00:00:00Z", description: "" }, status: { embeddable: true, madeForKids: false }, contentDetails: { definition: "hd", duration: "PT3M" }, statistics: { viewCount: item.views } } : null;
        }).filter(Boolean) }; } };
      }
    });
    assert.equal(result.summary.audited, 1);
    assert.equal(result.assignments[0].demandTier, "very-high");
    assert.equal(result.assignments[0].current.exact1080p, "HD (exact 1080p unverified)");
    assert.equal(result.assignments[0].bestSafeAlternative?.videoId, "bbbbbbbbbbb");
    assert.equal(result.assignments[0].replacementApplied, false);
    assert.equal(JSON.stringify(JSON.parse(await readFile(catalogPath, "utf8"))), before);
    assert.ok((await readFile(outputPath, "utf8")).includes("exact1080p"));
    assert.ok((await readFile(markdownPath, "utf8")).includes("production YouTube quality audit"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit production decisions replace only persisted qualified candidates and record unassignments", async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || ".", "kantatayo-production-decision-"));
  const catalogPath = join(directory, "songs.json");
  const reportPath = join(directory, "audit.json");
  const markdownPath = join(directory, "audit.md");
  const reviewPath = join(directory, "review.json");
  const decisionsPath = join(directory, "decisions.json");
  try {
    const sourceCatalog = JSON.parse(await readFile("data/songs.sample.json", "utf8"));
    const sourceSong = sourceCatalog.find((song) => song.id === "sample-130");
    await writeFile(catalogPath, JSON.stringify([sourceSong], null, 2));
    await writeFile(reviewPath, JSON.stringify({ version: 1, flags: [] }));
    await writeFile(reportPath, JSON.stringify({
      version: 1,
      scope: { firstId: 130, lastId: 130, auditedCount: 1 },
      methodology: { limitations: "test" },
      assignments: [{
        songId: "sample-130",
        catalogTitle: sourceSong.title,
        catalogArtist: sourceSong.artist,
        currentVideoId: sourceSong.youtubeVideoId,
        current: { videoId: sourceSong.youtubeVideoId, channelTitle: "Old Channel", viewCount: 100, definition: "hd", exact1080p: "HD (exact 1080p unverified)" },
        alternatives: [{ videoId: "bbbbbbbbbbb", videoTitle: "Take On Me - a-ha (Official Karaoke Instrumental)", channelTitle: "Songjam: Official Karaoke", viewCount: 200, likeCount: null, definition: "hd", exact1080p: "HD (exact 1080p unverified)", technicalStatus: "PASS", embeddable: true, madeForKids: false, warnings: [], automaticEligible: true }],
        bestSafeAlternative: { videoId: "bbbbbbbbbbb", videoTitle: "Take On Me - a-ha (Official Karaoke Instrumental)", channelTitle: "Songjam: Official Karaoke", viewCount: 200, likeCount: null, definition: "hd", exact1080p: "HD (exact 1080p unverified)", technicalStatus: "PASS", embeddable: true, madeForKids: false, warnings: [], automaticEligible: true },
        decision: "REVIEW — CURRENT ASSIGNMENT HAS A HARD METADATA/TECHNICAL WARNING",
        replacementApplied: false
      }],
      errors: { search: [], video: [] },
      summary: { audited: 1, keep: 0, review: 1, replacementsApplied: 0 }
    }, null, 2));
    await writeFile(decisionsPath, JSON.stringify({ version: 1, decisions: [{ songId: "sample-130", action: "replace", videoId: "bbbbbbbbbbb", reason: "Standard arrangement replaces the explicit Unplugged assignment." }] }, null, 2));
    const result = await applyProductionDecisions(decisionsPath, { catalog: catalogPath, report: reportPath, markdown: markdownPath, review: reviewPath });
    assert.equal(result.catalogChanges.length, 1);
    assert.equal(JSON.parse(await readFile(catalogPath, "utf8"))[0].youtubeVideoId, "bbbbbbbbbbb");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.assignments[0].decision, "REPLACE");
    assert.equal(report.assignments[0].previousVideoId, sourceSong.youtubeVideoId);
    assert.equal(report.assignments[0].currentVideoId, "bbbbbbbbbbb");
    assert.equal(report.assignments[0].decisionHistory.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
