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

-- One-card-per-album rails group on (album_title, album_artist) — INVARIANT #1.
CREATE INDEX IF NOT EXISTS tracks_album_idx
  ON tracks (lower(album_title), lower(album_artist));

-- Flag rails (featured / G100 / singles / global favorites) — partial indexes.
CREATE INDEX IF NOT EXISTS tracks_featured_idx   ON tracks (is_featured)   WHERE is_featured;
CREATE INDEX IF NOT EXISTS tracks_g100_idx       ON tracks (is_g100)       WHERE is_g100;
CREATE INDEX IF NOT EXISTS tracks_single_idx     ON tracks (is_single)     WHERE is_single;
CREATE INDEX IF NOT EXISTS tracks_global_fav_idx ON tracks (is_global_fav) WHERE is_global_fav;
CREATE INDEX IF NOT EXISTS tracks_visibility_idx  ON tracks (visibility);

-- Fuzzy search across title + album + artist (mirrors the live search engine).
CREATE INDEX IF NOT EXISTS tracks_search_trgm
  ON tracks USING gin (
    (coalesce(track_title,'') || ' ' || coalesce(album_title,'') || ' ' || coalesce(track_artist,''))
    gin_trgm_ops
  );

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
