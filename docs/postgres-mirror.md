# Postgres metadata mirror — MadMusic

**Decision (2026-06-29):** move the live site's **catalog metadata READ path** off the
FileMaker Data API and onto a **Postgres read mirror**. Motivation: safety (an owned,
backed-up database we control) and getting public traffic off the licensing-grey fmcloud
Data API.

## Source of truth — do not get this wrong

- **MadStreamer on fmcloud.fm is the single source of truth for the app.** It stays the
  **record keeper for everything** — catalog metadata *and* tokens, stream events, etc.
- The two **local FileMaker Server** databases only *support/feed* MadStreamer (team
  authoring upstream). They are **not** a sync source for Postgres.
- **Postgres is a one-way READ replica. It is never authoritative.** Nothing writes app
  data to Postgres except the sync job, and the sync job only ever copies FM → PG.

```
Local FM (2 DBs)  ─►  MadStreamer @ fmcloud.fm  ──one-way sync──►  Render Postgres  ─►  Render app (live)
   [team authoring]      [SOURCE OF TRUTH /                         [read mirror,        [catalog reads
                          record keeper]                             catalog only]        from PG when flagged]
```

## Scope (Phase 1)

In scope: catalog metadata reads only — `routes/catalog/*` (featured, trending, discovery,
genres, search) and track/album lookups.

Out of scope (still hit FileMaker live, unchanged): tokens/auth, stream events, playlists,
library, downloads, ringtones. **Implication:** the fmcloud Data API is still on the
request path for auth + play-logging until a later phase. Phase 1 removes the *bulk* of
read traffic, not all of it.

## The grey area, and why the sync resolves it

The grey area is the **licensing mismatch**: a single FM service account serving thousands
of anonymous public listeners via the Data API. The mirror changes *who* talks to FM — the
public hits Postgres; only one **internal sync job** reads fmcloud (low frequency, reading
our own data to export it). That is ordinary internal use. (Approved: the internal job may
use the Data API.)

## Components (status)

| Piece | File | Status |
|---|---|---|
| PG pool (disabled-safe) | `lib/pg.js` | ✅ built |
| Schema (provisional) | `db/schema.sql` | ✅ built — columns finalise after FM field mapping |
| Migration runner | `scripts/db/migrate.mjs` (`npm run db:migrate`) | ✅ built |
| Read-source flag | `lib/metadata-source.js` (`METADATA_SOURCE`) | ✅ built |
| Sync job (fmcloud → PG) | `lib/catalog-mapper.js` + `lib/catalog-sync.js` + `scripts/sync/catalog-sync.mjs` (`npm run sync:catalog`) | ✅ built — full resync + prune; tested against mocks. Dry-run: `npm run sync:catalog -- --dry-run` |
| Catalog read path on PG | `lib/catalog-store-pg.js` + `routes/catalog/*` + `lib/track-cache.js` | ✅ **DONE** — featured/singles/global-favorites/g100/new-releases (featured.js), genres (genres.js), random-songs/public-playlists/album/missing-audio (discovery.js), search/explore (search.js), and trending/my-stats track lookups (via track-cache.js). All behind `usePostgresMetadata()`. Generic `pgFind` translates FM `_find` operators (`*x*`/`x*`/`*x`/`==x`/`a..b`/`*`) → parameterised SQL over `raw` jsonb. Verified against real PG. Trending's Stream_Events reads STAY FileMaker (bookkeeping). |

## Safety / rollout model

- **Disabled-safe:** with `DATABASE_URL` unset, `isPgEnabled()` is false and the app runs
  on FileMaker exactly as before. Local + main are untouched.
- **`METADATA_SOURCE`** defaults to `filemaker`. The resolver degrades `postgres` →
  `filemaker` if `DATABASE_URL` is missing, so a misconfigured env can never blank the
  catalog. Flip to `postgres` **only in the live Render env** — that *is* the "live not
  main" distinction (env, not a branch fork). Instant rollback: set it back to `filemaker`.
- **`raw jsonb`** column keeps the full FM fieldData per record, so no field is ever lost
  and normalised columns can be re-derived without a re-sync.

## Setup checklist (Render Postgres)

1. Render dashboard → **New → Postgres** (same region as the web service). Copy the
   **Internal Database URL**.
2. Add `DATABASE_URL` = that URL to the web service env (and `DATABASE_SSL=no-verify` if
   using the External URL from outside Render).
3. `npm run db:migrate` (locally against the External URL, or via a one-off Render job).
4. Build + run the sync job until `sync_state` shows `rows_total` ≈ FM record count.
5. Set `METADATA_SOURCE=postgres` in the **live** env only. Verify, then it's the read path.

## Performance note (read path)

`pgFind` matches via `raw->>'Field' ILIKE …`, which does NOT use the `pg_trgm` index
(that index is on the normalized concat expression). At 63k rows a search cache-miss is a
full scan (~tens of ms), absorbed by SWR caching. Fine for the canary; before high load,
add trigram indexes on the normalized text columns (album_title/track_artist/track_title)
and route search field-conditions through them. Pre-existing unrelated lint nit:
`search.js` `buildRelaxedQueries` has one unreachable `return` (not introduced here).

## Open questions before the next phase

- **FM field mapping:** finalise `tracks` columns against the live `API_Album_Songs` field
  set (candidate-field mess — see `lib/fm-fields.js`). Needs a read of the live schema
  (ask before hitting fmcloud).
- **Incremental sync key:** does `API_Album_Songs` expose a reliable modification
  timestamp / does FM `modId` suffice for delta syncs, or is a periodic full re-sync of
  ~63k records the pragmatic v1?
- **Sync host:** Render Cron pulling fmcloud (simplest, co-located with PG) vs a
  local-network job. Source is fmcloud, so Render Cron is the current default.
