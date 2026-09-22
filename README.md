# kantatayo

KantaTayo uses YouTube's official embedded IFrame Player API for playback. KantaTayo does not host, download, proxy, extract, or separately play YouTube videos or audio.

YouTube IDs must be verified separately before they are added to the production catalog. A syntactically valid ID may still be unavailable, restricted, or non-embeddable. Made-for-Kids status must not be guessed and is part of that future catalog-verification process.

The sample catalog intentionally uses null YouTube IDs, so the app shows a friendly unavailable-video state during normal development. Technical player testing should use a clearly separate development-only ID, never a production karaoke catalog entry.

## Karaoke demand signals

The catalog includes a small, transparent `demandTier` signal for songs supported by current karaoke-play evidence. The runtime uses only the tier (`very-high`, `high`, or `established`); source URLs, ranking positions, and methodology are kept separately in [data/song-demand.json](data/song-demand.json). Demand is a weak cold-start prior, not proof that a song has a suitable YouTube karaoke video. It never bypasses catalog validation, technical verification, Party Tyme exclusion, or the existing personalization and repetition rules.

The current expansion adds 45 evidence-backed song records with `youtubeVideoId: null`. They are searchable and visible, but remain unavailable for playback until an individual karaoke candidate passes the existing identity, suitability, API, and quality workflow. No candidate IDs were guessed or promoted as part of the expansion.

Run the app from a local HTTP/HTTPS server during development. Direct `file://` opening is not supported for reliable module, fetch, origin, or YouTube IFrame API behavior.

## Production video verification

The public song catalog should receive a YouTube ID only after a separate catalog-maintenance check marks that video as `verified`. A syntactically valid 11-character ID is not enough for production playback eligibility. The smallest useful internal verification record is kept separate from public song metadata and should identify the song, candidate video ID, one of `unassigned`, `candidate`, `verified`, `rejected`, or `unavailable`, whether embedding was checked, whether Made for Kids status was checked and what it reported, whether the video/song match was manually confirmed, and the verification timestamp. Only a record with `verified` status and complete evidence should promote the ID into the public catalog. Runtime playback still handles videos that later become unavailable or restricted.

That verification artifact is an admin/development workflow input, not a user-facing catalog feature and should not be shipped with credentials or unnecessary notes. No verification metadata or real video IDs are included in the sample catalog yet.

## Future video verification workflow

The development verification workflow uses the YouTube Data API `videos.list` request with `part=status,snippet` and a specific `id`. It inspects `status.embeddable` and `status.madeForKids`, uses `snippet` only to support deliberate manual title/artist matching, records the evidence and timestamp, and promotes only verified IDs. The API key must remain outside the browser and repository; this frontend does not call the Data API.

## Local YouTube verification tool

Visitors never need a YouTube Data API key. Verification is a development-only workflow using [tools/verify-youtube.mjs](tools/verify-youtube.mjs) and Node's built-in `fetch`.

1. Copy `.env.example` to a local ignored `.env` only if your shell tooling loads it, or set the variable directly. For PowerShell: `$env:YOUTUBE_API_KEY = "your-local-key"`. Never paste a real key into source files, README, browser code, or committed JSON.
2. Verify known candidate IDs: `node tools/verify-youtube.mjs VIDEO_ID`. Add `--song-id sample-001` when associating one candidate with a catalog song. The tool checks the returned ID, video metadata, `status.embeddable`, and the API's `status.madeForKids` result, then stores only a small local record in ignored `tools/youtube-verification.json`.
3. Review the title/channel and manually confirm that the video is the intended karaoke or instrumental version. API success is not song-match approval.
4. Mark a candidate only after manual review: `node tools/verify-youtube.mjs mark-verified --song-id sample-001 --video-id VIDEO_ID --manual-match --karaoke-suitable`.
5. Promote separately and explicitly: `node tools/verify-youtube.mjs promote --song-id sample-001`. Promotion refuses unknown Made-for-Kids status, Made-for-Kids videos without implemented handling, non-embeddable videos, missing API evidence, or missing manual approval.

The verification tool does not use YouTube Search API during ID verification, and never changes the public catalog during API verification. The public site does not load `YOUTUBE_API_KEY`; keep real credentials in the local environment and out of Git history.

## Candidate search and selection

The development tool can search YouTube for discovery only. It uses the catalog song title, artist, and the `karaoke` term, then prints up to five results with their video IDs, titles, channels, and publication dates. Search results are not verification, song-match approval, karaoke-suitability approval, or promotion.

Search one eligible song:

```text
node tools/verify-youtube.mjs search-candidates --song-id sample-013
```

For duet or other specialized searches, pass an exact custom query. The text is sent to YouTube unchanged and is allowed only with `--song-id`:

```text
node tools/verify-youtube.mjs search-candidates --song-id sample-008 --query "Lucky Jason Mraz Colbie Caillat full duet karaoke" --max-results 5
node tools/verify-youtube.mjs search-candidates --song-id sample-009 --query "Endless Love Lionel Richie Diana Ross full duet karaoke" --max-results 5
```

`--query` cannot be combined with `--all`. Without it, the tool continues to generate a query from the catalog title, artist, and `karaoke`.

Search a controlled batch of songs whose catalog `youtubeVideoId` is still `null`:

```text
node tools/verify-youtube.mjs search-candidates --all
```

`--all` searches at most 10 songs per run by default to control YouTube Search API quota. Use `--max-songs N` and `--offset N` to process more eligible songs in deliberate batches. Use `--max-results N` to request 1–5 results per song.

After human review of the printed results, select an ID explicitly into the ignored candidate map:

```text
node tools/verify-youtube.mjs set-candidate --song-id sample-013 --video-id VIDEO_ID
```

This command writes only `tools/youtube-candidates.json`. It refuses invalid IDs, unknown songs, candidate IDs mapped to another song, and songs that already have a promoted catalog video. It does not call the API and does not modify the public catalog.

The complete workflow is:

```text
search-candidates
→ set-candidate
→ batch-verify
→ report
→ human manual review
→ mark-verified --manual-match --karaoke-suitable
→ promote or promote-all-verified
```

Search uses the YouTube Data API only from this Node development tool. It does not download, cache, proxy, or embed search media, and the API key is never sent to frontend code or printed in reports.

## Party Mode

Party Mode is an optional, browser-only session layer. Turn it on from the home screen, add unique singer names, and queued songs can be assigned automatically in rotation or overridden manually. Removing a singer unassigns that singer's queued songs instead of silently transferring them. Song Roulette uses only playable songs already in the local catalog and waits for an explicit Add to Queue action; it never starts playback or changes the queue when it rolls.

The party session is stored as `partySession` inside the existing namespaced `kantatayo:user-state` record. It includes the enabled flag, stable local singer IDs, queue assignments, rotation cursor, and capped completed-turn records. Refreshing the page preserves it. Automatic assignment advances the rotation cursor; an explicit manual assignment also advances the cursor to the singer after the selected singer, so the next automatic assignment remains deterministic. The normal queue still rejects duplicate song IDs, so one song cannot be queued simultaneously for two different singers. Removing a singer unassigns their queued songs without transferring them, while completed turns retain a safe singer-name snapshot for historical stats. Clearing the party session removes only singers, assignments, and party stats; personal favorites, feedback, history, preferences, queue, and current song remain intact. The cached app shell includes the party module, so rotation, roulette filtering, and local stats continue to work offline; YouTube playback still requires an internet connection.

## Batch candidate review

For larger catalog passes, use the ignored local file `tools/youtube-candidates.json`. It is intentionally empty in the repository. Add only IDs you found and reviewed yourself; the tool never searches YouTube or invents candidates:

```json
{
  "version": 1,
  "candidates": [
    { "songId": "sample-013", "candidateVideoId": "YOUR_11_CHAR_ID" }
  ]
}
```

Run one API verification pass for all unique candidate IDs:

```text
node tools/verify-youtube.mjs batch-verify
```

Use `--candidates`, `--file`, and `--catalog` to work with alternate local files. The command prints a compact review table and stores API evidence in the ignored verification store. Invalid IDs, unknown song IDs, duplicate mappings, and candidate IDs reused for different songs are skipped safely. Candidate API checks do not approve a song match.

After reviewing each row manually, approve one candidate at a time with both explicit flags:

```text
node tools/verify-youtube.mjs mark-verified --song-id sample-013 --video-id YOUR_11_CHAR_ID --manual-match --karaoke-suitable
```

Review the resulting records with:

```text
node tools/verify-youtube.mjs report
```

Promote only after that review, either one song at a time:

```text
node tools/verify-youtube.mjs promote --song-id sample-013
```

or, after checking the printed skip report, all records that independently pass every gate:

```text
node tools/verify-youtube.mjs promote-all-verified
```

The batch promotion command skips unknown songs, incomplete or stale verification, failed API checks, non-embeddable videos, Made-for-Kids results that do not meet policy, missing manual approvals, and any catalog song that already has a video ID. It therefore will not overwrite the already-promoted `sample-029` record.

## Low-command batch workflow

The ignored local review file `tools/youtube-review.json` records unresolved or review-required songs. `sample-008`, `sample-009`, and the metadata-sensitive `sample-042` are flagged by default and are skipped by automation. Edit review flags only after human review; the public catalog is never changed by these flags.

Run a controlled discovery and technical-verification batch:

```text
node tools/verify-youtube.mjs auto-batch --max-songs 10
```

`auto-batch` searches only songs whose public `youtubeVideoId` is null, conservatively ranks karaoke candidates, writes selected mappings to the ignored candidate file, and verifies selected IDs with `videos.list` in batches of up to 50. It never sets manual approval, never marks karaoke suitability, and never promotes a catalog ID. Use `--dry-run` to search and rank without writing local candidate or verification state.

Review the single report, then explicitly approve only the reviewed songs in one command:

```text
node tools/verify-youtube.mjs approve-batch --song-ids sample-063,sample-064,sample-065 --manual-match --karaoke-suitable --confirm
```

This command requires all three explicit approval flags, affects only the listed song IDs, skips ambiguous or technically invalid records, and promotes only records that pass every existing gate. It never overwrites an existing catalog video ID. Continue using `mark-verified` and `promote` when a song has multiple candidates or needs individual review.

Useful maintenance commands:

```text
node tools/verify-youtube.mjs report
node tools/verify-youtube.mjs review-flag --song-id SONG_ID --status unresolved --reason "No acceptable candidate yet"
node tools/verify-youtube.mjs review-unflag --song-id SONG_ID
node tools/verify-youtube.mjs cleanup-verification
node tools/verify-youtube.mjs unassign-party-tyme --dry-run
```

`cleanup-verification` removes only identical duplicate records and orphan records that have exactly one matching promoted song-linked record. Conflicting or ambiguous records are kept and reported.

`unassign-party-tyme` is a local product-quality maintenance command. It uses the persisted verified channel evidence to unassign current Party Tyme Karaoke assignments without deleting songs, searching for replacements, or marking the videos technically invalid. The final mutation records a `quality-excluded` review status, so automatic completion skips those songs until a future explicit catalog-quality decision.

For the normal catalog-completion pass, use the single resumable command:

```text
node tools/verify-youtube.mjs auto-complete
```

It processes every eligible null-ID song, reuses or searches candidates, applies strict automated confidence and API gates, promotes only records marked `auto-high-confidence`, and prints `AUTO-PROMOTED`, `REVIEW REQUIRED`, `SKIPPED`, and `FAILED`. It never marks `manual-match` or `karaoke-suitable`, and it always leaves unresolved exceptions for human review.

Temporary YouTube throttling is retried with bounded exponential backoff and `Retry-After` support. If retries are exhausted, affected songs are stored locally as `deferred-rate-limit` and automatically retried by the next `auto-complete` run. A distinguishable daily quota error stops further API requests and leaves the remaining songs deferred for a later run. The retry count can be lowered or disabled with `--retry-limit N`; the default is conservative.

## Local karaoke quality audit

Run the development-only quality audit after assignments are verified:

```text
node tools/audit-youtube.mjs
```

The audit reads the catalog and ignored verification store without making network requests. It writes durable JSON and Markdown reports to `tools/youtube-quality-audit.json` and `tools/youtube-quality-audit.md`. It flags explicit metadata indicators such as altered keys, live/remix/lyrics-only wording, or guide vocals, while keeping audio quality, original-key confirmation, completeness, and arrangement unresolved until a person listens through the official YouTube embed. It never changes catalog IDs, verification approvals, or promotion state.
