# FileMaker Integration Map — MAD (v2.1 ↔ v3.1)

Generated 2026-06-03 from static analysis of both codebases. FM database: `MADStreamer` on `FM_HOST` (fmcloud). All access goes through `fm-client.js` (Data API vLatest, session token pool, retry + queue stats via `fmQueueStats`).

## Layouts (env var → default)

| Layout | Env var | Used by | Mode |
|---|---|---|---|
| `API_Album_Songs` | `FM_LAYOUT` | catalog/* (featured, trending, discovery, genres), playlists (PublicPlaylist write), track lookups | READ (+1 write) |
| `API_Access_Tokens` | `FM_TOKENS_LAYOUT` | lib/auth.js, lib/token-store.js, routes/access.js, routes/telkom.js, server.js | READ/WRITE |
| `API_Users` | `FM_USERS_LAYOUT` | routes/telkom.js (MSISDN find-or-create, subscription state) | READ/WRITE |
| `API_Playlists` | `FM_PLAYLISTS_LAYOUT` | lib/playlist-store.js | READ/WRITE/DELETE |
| `API_Library` | `FM_LIBRARY_LAYOUT` | lib/library-store.js (saved albums/songs) | READ/WRITE |
| `API_Download_Purchases` | `FM_DOWNLOADS_LAYOUT` | routes/download.js | READ/WRITE |
| `API_Ringtone_Purchases` | `FM_RINGTONE_LAYOUT` (literal default) | routes/ringtone.js | READ/WRITE |
| `Stream_Events` | `FM_STREAM_EVENTS_LAYOUT` | lib/stream-events.js, routes/access.js | READ/WRITE |
| `API_Hero_Featured` | `FM_HERO_LAYOUT` | **v3.1 only** — routes/featured-editorial.js (hero CMS) | READ |

## Key fields per layout

**API_Access_Tokens** (auth path — hottest layout)
- Read: `Token_Code` (find key, `==exact`), `Active`, `Token_Type`, `Expiration_Date`, `Issued_Date`, `Issued_To`/`Email`, `Notes`, `Audio_Lab_Enabled`, `Current_Session_ID`
- Written: `Current_Session_ID`, `Session_Last_Activity`, `Session_Device_Info`, `Session_IP`, `First_Used`, `Expiration_Date` (calculated on first use), `Audio_Lab_Enabled` (unlock), token mint fields via token-store
- Timezone: `Expiration_Date` converted with `FM_TIMEZONE_OFFSET` (hours)

**API_Album_Songs** (catalogue — read-heavy, candidate-field resolution via lib/fm-fields.js)
- Identity: `Album Title`, track artist vs `Tape Files::` album-artist fields (see CLAUDE.md invariant #1)
- Audio: `S3_URL`, `Tape Files::S3_URL`, `mp3`/`MP3` variants (AUDIO_FIELD_CANDIDATES)
- Artwork: `Artwork_S3_URL`, `Tape Files::Artwork_S3_URL`, `Artwork::Picture`, … (ARTWORK_FIELD_CANDIDATES)
- Flags: `Tape Files::featured` = `yes` (FM_FEATURED_FIELD/VALUE) · `G100_Highlights` = `Yes` (G100) · `Tape Files::Singles` = `Yes` (/api/singles) · `Global_Favorites` = `Yes` (/api/global-favorites — **field not on layout yet as of 2026-06-12**; route probes `Tape Files::Global_Favorites`/`Global_Favorites` and returns empty until it's placed on `API_Album_Songs`) · visibility field optional (`FM_VISIBILITY_FIELD`)
- Track order: TRACK_SEQUENCE_FIELDS candidate list (~25 variants)
- Catalogue no: `Album Catalogue Number`, `Reference Catalogue Number`
- Write: `PublicPlaylist` (curated playlist tagging from routes/playlists.js:440)

**API_Users** (Telkom)
- Find key: `msisdn` (`==exact`). Written: subscription status, token linkage, billing state (routes/telkom.js)

**Stream_Events**
- Created per play event (lib/stream-events.js:108); updated/upserted in access.js:655. v3.1 additionally mirrors events into local SQLite (`data/streams.db`) via lib/stream-ingest.js — FM unchanged, SQLite is additive for charts/metrics.

**API_Hero_Featured** (v3.1 only — layout may not exist in FM yet; flagged as deferred gap)
- Read: `Active`=1, `Start_Date`/`End_Date` window, `Target_Type` (validated against HERO_TARGET_TYPES)

## Data-flow notes

- **Containers/streaming:** FM container URLs (`…RCType=RCFileProcessor`) are session-scoped and expire → always re-resolve by `recordId` via `GET /api/track/:recordId/container`. `/api/container?u=…` requires `proxy=1` for fetch()-based consumers (CLAUDE.md invariants #2/#3).
- **Resilience layers in front of FM (v2.1):** `tokenValidationCache` LRU (5 min fresh + 24 h stale grace, cache.js) · `data/access-tokens.json` mtime-cached fallback (token-store.js) · SWR caches on featured/new-releases/singles/G100/trending/genres/discovery (lib/swr-cache.js) · track-cache.js.
- **Writes are never cached.** Usage-stat writes on token validation are fire-and-forget (`.catch` warn).
- **v3.1 deltas relevant to FM:** charts/metrics read SQLite, not FM; editorial hero adds the `API_Hero_Featured` dependency; access.js drift (450 diff lines) and payments.js drift (120) need a directed diff before any merge — v2.1 has newer fixes (email-claim flow) that must not be regressed.

## Env vars (FM-related)

`FM_HOST`, `FM_DB`, `FM_USER`/`FM_PASS` (login), `FM_LAYOUT`, `FM_TOKENS_LAYOUT`, `FM_USERS_LAYOUT`, `FM_PLAYLISTS_LAYOUT`, `FM_LIBRARY_LAYOUT`, `FM_DOWNLOADS_LAYOUT`, `FM_RINGTONE_LAYOUT`, `FM_STREAM_EVENTS_LAYOUT`, `FM_HERO_LAYOUT` (v3.1), `FM_FEATURED_FIELD/VALUE`, `FM_VISIBILITY_FIELD/VALUE`, `G100_FIELD/VALUE`, `FM_TIMEZONE_OFFSET`.
