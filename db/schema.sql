-- ============================================================================
-- db/schema.sql — Postgres mirror of MadStreamer (fmcloud)
--
-- One-way READ replica. FileMaker stays the system of record; this schema is
-- populated by the sync job (FM -> PG) and read by the catalog routes only when
-- METADATA_SOURCE=postgres. Idempotent — safe to re-run (scripts/db/migrate.mjs).
--
-- PROVISIONAL: the normalised columns below are a first pass derived from
-- docs/FM-MAP.md. They will be finalised after mapping the live API_Album_Songs
-- field set. The `raw` jsonb column holds the FULL FileMaker fieldData so no
-- field is ever lost and columns can be re-derived without a re-sync.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS tracks (
  fm_record_id    text PRIMARY KEY,           -- FileMaker recordId (stable per record)
  album_title     text,
  album_artist    text,                       -- album-first (getAlbumArtist) — GROUPING key
  track_artist    text,                       -- track-first (getArtistField) — DISPLAY only
  track_title     text,
  genre           text,
  release_year    integer,
  duration_secs   integer,
  track_seq       integer,
  catalogue_no    text,
  s3_audio_url    text,                        -- stable S3 URL (NOT an FM container URL)
  s3_artwork_url  text,
  visibility      text,                        -- FM "Visibility" (e.g. 'Show'/'Hide') — read path filters to match prod
  is_featured     boolean NOT NULL DEFAULT false,
  is_g100         boolean NOT NULL DEFAULT false,
  is_single       boolean NOT NULL DEFAULT false,
  is_global_fav   boolean NOT NULL DEFAULT false,
  fm_mod_id       bigint,                      -- FileMaker modId — incremental-sync watermark
  fm_modified_at  timestamptz,
  raw             jsonb NOT NULL,              -- full FM fieldData (safety / re-derive)
  synced_at       timestamptz NOT NULL DEFAULT now()
);

-- Additive column migrations for already-created tables (idempotent).
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS visibility text;
-- New_Release lives on the Tape Files relationship and is NOT returned in
-- fieldData (can't be derived from `raw`), so the sync sets it via a dedicated
-- find. Default false; reconciled each sync run.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS is_new_release boolean NOT NULL DEFAULT false;

-- One-card-per-album rails group on (album_title, album_artist) — INVARIANT #1.
CREATE INDEX IF NOT EXISTS tracks_album_idx
  ON tracks (lower(album_title), lower(album_artist));

-- Flag rails (featured / G100 / singles / global favorites) — partial indexes.
CREATE INDEX IF NOT EXISTS tracks_featured_idx   ON tracks (is_featured)   WHERE is_featured;
CREATE INDEX IF NOT EXISTS tracks_g100_idx       ON tracks (is_g100)       WHERE is_g100;
CREATE INDEX IF NOT EXISTS tracks_single_idx     ON tracks (is_single)     WHERE is_single;
CREATE INDEX IF NOT EXISTS tracks_global_fav_idx ON tracks (is_global_fav) WHERE is_global_fav;
CREATE INDEX IF NOT EXISTS tracks_new_release_idx ON tracks (is_new_release) WHERE is_new_release;
CREATE INDEX IF NOT EXISTS tracks_visibility_idx  ON tracks (visibility);

-- Fuzzy search across title + album + artist (mirrors the live search engine).
CREATE INDEX IF NOT EXISTS tracks_search_trgm
  ON tracks USING gin (
    (coalesce(track_title,'') || ' ' || coalesce(album_title,'') || ' ' || coalesce(track_artist,''))
    gin_trgm_ops
  );

-- Trigram indexes on the hot raw fields so pgFind's ILIKE (prefix/contains/suffix)
-- is index-backed instead of a full scan (search + album lookup performance).
CREATE INDEX IF NOT EXISTS tracks_trgm_album_artist ON tracks USING gin ((raw->>'Album Artist') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tracks_trgm_album_title  ON tracks USING gin ((raw->>'Album Title')  gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tracks_trgm_track_name   ON tracks USING gin ((raw->>'Track Name')   gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tracks_trgm_track_artist ON tracks USING gin ((raw->>'Track Artist') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tracks_trgm_local_genre  ON tracks USING gin ((raw->>'Local Genre')  gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tracks_trgm_ref_cat      ON tracks USING gin ((raw->>'Reference Catalogue Number') gin_trgm_ops);
-- Free-text search (routes/catalog/search.js) ORs over these two extra fields;
-- without a trigram index on EACH OR branch, Postgres falls back to a full seq
-- scan for the whole OR (measured ~11 s vs ~2 ms once every branch is indexed).
CREATE INDEX IF NOT EXISTS tracks_trgm_year          ON tracks USING gin ((raw->>'Year of Release') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tracks_trgm_language_code ON tracks USING gin ((raw->>'Language Code')   gin_trgm_ops);

-- Public playlists (/public-playlists): per-name track loads run
-- lower(raw->>'PublicPlaylist') = $name — one query PER playlist per page
-- load. Unindexed this seq-scans the whole table; ~20 playlists exhausted the
-- pool (10-27s responses + connect timeouts, 2026-07-11). The btree serves the
-- exact-match; the partial index serves the "any playlist tag" list query
-- (raw->>'PublicPlaylist' IS NOT NULL AND <> '') with an identical predicate.
CREATE INDEX IF NOT EXISTS tracks_public_playlist_idx
  ON tracks (lower(raw->>'PublicPlaylist'));
CREATE INDEX IF NOT EXISTS tracks_public_playlist_set_idx
  ON tracks ((raw->>'PublicPlaylist'))
  WHERE raw->>'PublicPlaylist' IS NOT NULL AND raw->>'PublicPlaylist' <> '';

-- Sync watermark + run log (one row per FileMaker layout mirrored).
CREATE TABLE IF NOT EXISTS sync_state (
  source         text PRIMARY KEY,            -- e.g. 'API_Album_Songs'
  last_mod_id    bigint,
  last_synced_at timestamptz,
  last_status    text,                        -- 'ok' | 'error' | 'running'
  last_error     text,
  rows_upserted  integer,
  rows_total     integer,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
