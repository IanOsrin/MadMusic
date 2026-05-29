# MAD Streamer — Performance Plan (FileMaker-backed)

_Scope: across-the-board speed — search, home-page/rail load, and time-to-first-audio._
_Author: code + live-API analysis (May 2026). I could not connect to the FileMaker file directly, so Bucket B is a checklist for someone with FM access (you, your FM admin, or Claude Code running locally)._

---

## Implementation status (updated 29 May 2026)

**Done in this pass (app-side, safe to ship without FM/browser testing):**
- **A4 — shared cache headers** on the user-agnostic catalogue rails: `featured-albums`, `releases/latest`, `new-releases`, `singles`, `g100-albums` (`routes/catalog/featured.js`), `trending` (`trending.js`), `genres` (`genres.js`). They now send `public, max-age=60, stale-while-revalidate=300` (genres: 300/3600) instead of `no-store`, so repeat loads and any edge cache skip Node + FileMaker.
- **A5 — `/my-stats` per-token cache** (`trending.js`): a 5-min LRU (`MY_STATS_CACHE_TTL_MS`) collapses the 2000-record stream-events find to one FM round-trip per user per window.
- **A6 — documented `PREWARM_CACHES`** (and `MY_STATS_CACHE_TTL_MS`) in `.env.example`. **Action for you:** set `PREWARM_CACHES=true` in the production environment.

**Handed over (need FileMaker indexing first, or live-browser verification I can't do from here):**
- **A1 / A2** (push playable/visible filters into the `_find`, then cut over-fetch multipliers) — deliberately deferred: (a) it only pays off once the queried fields are indexed (B1); (b) **you just deleted `HasS3Audio` and `HasGMViArtwork`**, so the original "filter on those flags" idea is moot. Instead, the FM-side filter should be `Artwork_S3_URL: "*gmvi*"` + a non-empty `S3_URL`, which mirrors what `hasValidArtwork`/`hasValidAudio` already compute. Do this **after** B1/B3.
- **A3** (project list responses down to card fields) — pairs with B3 and needs a front-end field-name audit + browser test, so it ships with the slim-layout work, not blind.
- **A7** (album-open: stop fetching up to 500 records) — a UX-affecting change to the album-detail flow; wants a browser test.

The rest of this document (root causes, Bucket B, sequence, measurement) stands as the runbook for those deferred items.

---

## What's already good (don't touch)

Worth stating so we don't "optimise" things that are already handled:

- **Connection pooling + request queue** in `fm-client.js`: 20 keep-alive connections, max 8 concurrent FM requests, 10 ms min spacing, token reused for ~11.5 min, 401-refresh handling, exponential-backoff retries. Solid.
- **Layered caching**: per-route SWR for rails (`featured`, `new-releases`, `g100`, `singles`, `trending`), read-through `trackRecordCache` (5000) and `containerUrlCache` (8000) that kill the N+1 across endpoints, `searchCache` (2000, 1 h), `randomSongsPoolCache` (60 s). Trending is even disk-persisted so restarts don't go cold.
- **Direct-to-S3 audio**: tracks carry `S3_URL`, so playback streams straight from S3, not through FileMaker. Good — keep it.

The remaining wins are about **how much FileMaker is asked to do per query**, **how much data crosses the wire**, and **letting repeat requests skip the stack entirely**.

---

## The three root causes

1. **Over-fetch + filter-in-Node.** Search asks FileMaker for `limit × 10` (up to 500) records and then discards the ones failing `hasValidAudio` / `hasValidArtwork` / visibility in JavaScript. Rails fetch ~400 and filter the same way. Album detail fetches **up to 500 full records** (`/api/search?artist=…&limit=500`) just to open one album. FileMaker does the expensive work of finding + serialising records that are then thrown away.
2. **Fat records.** The Data API returns **every field on the layout** — ~45 fields per record in the current responses, including related `Tape Files::` fields. A card needs ~10 of them. This inflates FileMaker serialisation, network transfer, and JSON parsing on both ends.
3. **No shared/edge caching of catalogue responses.** The global middleware stamps `Cache-Control: private, no-store` on everything under `/api/`. The rail and search endpoints are identical for every user, but each browser/CDN re-requests them every time.

Everything below targets one of those three.

---

## Bucket A — App-side changes (I can implement and verify)

Ordered by impact-to-effort.

### A1. Push the "playable + visible" filter into the FileMaker query  ★ highest impact  — DEFERRED (see status)
Today `fetchSinglesRecords`, featured, g100, search, etc. fetch loosely then filter in Node with `recordIsVisible && hasValidAudio && hasValidArtwork`. Push the equivalent constraint **inside** the `_find` query objects so FileMaker only returns usable rows.

**Note:** the `HasS3Audio` / `HasGMViArtwork` helper flags were deleted (they were unused), so don't query those. The constraint that matches what the code actually computes is a non-empty audio URL plus a GMVi artwork URL:

```
{ "Album Artist": "lucky*", "Artwork_S3_URL": "*gmvi*", "S3_URL": "*" }
```

Effect: smaller result sets, less data over the wire, far less Node filtering, and the over-fetch multiplier can drop from ×10 to ~×2. **Only do this after B1 — `Artwork_S3_URL` (and any field added to the query) must be indexed, or you've turned a filter into a full scan.**
Effort: ~½ day. Risk: low–medium (verify against FM once indexed; keep the Node filter as a backstop).

### A2. Cut the over-fetch multipliers
- `search.js` requests `Math.min(500, limit*10)`. With A1 in place, reduce to ~`limit*2`.
- Featured/G100 fetch 400 then trim — fetch what the rail actually shows (e.g. 60–100) once the FM-side filter (A1) makes the result dense.
Effort: trivial. Risk: low. Do it with A1, not before.

### A3. Project list responses down to card fields  ★ big client-side win
Rail/search endpoints currently return the entire `fieldData` (~45 fields). Add a `pickCardFields(fieldData)` projection returning only what cards use (`Track Name`, `Track Artist`, `Album Artist`, `Album Title`, `Artwork_S3_URL`, `S3_URL`, `recordId`, plus genre/year). Cuts each list response by ~60–70% — meaningfully faster home/search on mobile.
Keep the full record for the detail/play path (the player already reads `S3_URL` from the item, so include it).
Effort: ~½ day. Risk: low (audit the front-end field names first; some code reads `Tape Files::…` variants).

### A4. Allow short shared caching on catalogue endpoints  ★ big repeat-load win
The rails and search are user-agnostic. Override the blanket `no-store` for `/api/featured-albums|new-releases|g100-albums|singles|trending|genres|search|explore` with:

```
Cache-Control: public, max-age=60, stale-while-revalidate=300
```

Repeat home loads and any CDN/edge in front of Render then serve these without touching Node or FileMaker. Leave all token/library/playlist/payment routes exactly as they are (`private, no-store`).
Effort: ~1–2 h. Risk: low–medium (must be applied only to catalogue routes; double-check none leak per-user data — they don't today).

### A5. Cache `/my-stats` per token
`/my-stats` runs a 2000-record stream-events `_find` on **every** call with no result caching (only the track lookups are cached). Wrap the aggregation in a 5-minute per-token cache.
Effort: ~1 h. Risk: low.

### A6. Turn on cache pre-warm in production
Pre-warm is gated behind `PREWARM_CACHES=true` and currently off, so the first visitor after each deploy/restart pays the full cold-FM cost for every rail. Set `PREWARM_CACHES=true` (worker 0 only already handled) so rails are warm before the first request. Add `singles` is already in the warmer list.
Effort: 1 env var. Risk: low (slightly higher boot memory; fine on current tier per the code's own notes).

### A7. Album-detail open: stop pulling 500 records to show one album
Opening an album fires `/api/search?artist=…&limit=500` to populate the left-column "more by this artist". Options, cheapest first: (a) lower that to a sane cap (e.g. 120) — the left rail doesn't need 500; (b) request the slim projection (A3); (c) load the clicked album's tracks first (fast) and lazy-load "more by artist" after the panel paints. `searchCache` already makes the *second* open of an artist fast; this targets the first.
Effort: ~½ day for (a)+(c). Risk: low.

---

## Bucket B — FileMaker-side checklist (needs DB access)

These are the structural wins I can't make from here. Give this list to whoever has FileMaker Pro access (or Claude Code locally, which can at least confirm field/layout facts via the Data API). **B1 and B3 are the big ones.**

### B1. Index every searched/sorted field  ★ the #1 FileMaker speed factor
An unindexed field in a `_find` (or `sort`) forces a full-table scan — catastrophic on a 60k-track catalogue and a growing stream-events table. In FileMaker Pro → Manage Database → Fields → (field) → Options → Storage, confirm **Indexing is on** (or "Automatically create indexes as needed") for:
- On the catalogue table/layout (`API_Album_Songs`): `Album Artist`, `Album Title`, `Track Name`, `Track Artist`, `Year of Release`, `Local Genre`, `Visibility`, `Audio Test`, `HasS3Audio`, and the flag fields `Featured`, `New_Release`, `G100_Highlights`, `singles`.
- On the stream-events table: `TrackRecordID`, `LastEventUTC`, `TimestampUTC`, `Token_Number`.

### B2. Eliminate unstored calculations from query/sort paths
Any field used in a find or sort that is an **unstored calculation** can't be indexed and forces per-record evaluation across the whole table. Audit the fields in B1: if `HasS3Audio`, `Audio Test`, `Year of Release`, or any flag is a calc, either make it **stored & indexed** or mirror it into a stored indexed field that the API queries. (Trending sorts on `TimestampUTC` — make sure that's a stored, indexed timestamp, not a calc.)

### B3. Create slim API layouts  ★ pairs with A3
The Data API returns *all fields on the layout*. Build a dedicated **`API_List`** layout containing only the card fields (≈12: artist/title/track/track-artist, `Artwork_S3_URL`, `S3_URL`, `HasS3Audio`, `Audio Test`, `Visibility`, year, genre, and the flag fields). Point the rail/search/explore queries at it; keep a fuller layout for the detail view. This cuts FileMaker's serialisation cost and payload size at the source — the biggest structural lever after indexing.

### B4. Prefer stored base-table fields over related (`Tape Files::`) fields
Querying/sorting on related fields traverses the relationship per record. Responses show both `Album Artist` and `Tape Files::Album Artist` — query the **stored base-table** copy where it exists, and make sure the flag fields live on (or are indexed through) the layout's own table occurrence, not only via the relationship.

### B5. Keep the stream-events table fast as it grows
It gains a record per play and trending scans it sorted by `TimestampUTC`. Beyond indexing (B1): consider periodically **archiving** old stream-events, or maintaining a small **rollup/summary table** (per-track totals) that trending reads instead of scanning raw events. Keeps trending and `/my-stats` flat as volume grows.

### B6. Confirm media fields are plain text, not container fields
`S3_URL` and `Artwork_S3_URL` look like stored text URLs (good — direct S3). Make sure nothing in the play/artwork path resolves through an actual FileMaker **container** field (those stream bytes through FM and are slow). If any legacy container fields remain referenced, drop them from the API layout.

---

## Suggested sequence

1. **Now / cheap:** A6 (prewarm env var), A4 (catalogue cache headers), A5 (my-stats cache). Hours of work, immediate repeat-load and per-user wins.
2. **Together:** B1 + B2 (indexing/calcs) **then** A1 + A2 (push filters into FM, cut multipliers). Indexing first so the new FM-side filters are fast, not scans.
3. **Then:** B3 + A3 (slim layout + projected responses) — the structural payload reduction.
4. **Polish:** A7 (album-open fetch), B5 (stream-events scaling).

## How we'll measure
- Every cached endpoint already emits `X-Cache-State` (`fresh|stale|miss`) — watch it to confirm cache hit rates.
- `fmQueueStats()` (exposed via the admin health endpoint) shows FM queue depth and active requests under load — the number to watch when validating A1/B1.
- Compare response sizes before/after A3 (`curl -s … | wc -c`) and cold-vs-warm latency before/after A6.

## What I can do next
Say the word and I'll implement the **Bucket A** items on a branch (A4/A5/A6 are quick; A1/A3 I'd do behind the existing field-candidate style so they degrade safely), and expand **Bucket B** into a step-by-step FileMaker runbook for whoever has DB access.
