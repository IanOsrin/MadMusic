-- Sprint 1: Initial catalog schema

CREATE TABLE IF NOT EXISTS artists (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  sort_name       TEXT,
  bio             TEXT,
  country         TEXT,
  artwork_url     TEXT,
  pro_name        TEXT,
  pro_ipi         TEXT,
  pro_isni        TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publishers (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  pro_name        TEXT,
  pro_ipi         TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS labels (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  country         TEXT,
  contact_email   TEXT,
  website         TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS albums (
  id              SERIAL PRIMARY KEY,
  artist_id       INTEGER REFERENCES artists(id),
  label_id        INTEGER REFERENCES labels(id),
  title           TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  year            INTEGER,
  artwork_url     TEXT,
  catalogue       TEXT,
  upc             TEXT,
  release_type    TEXT DEFAULT 'album'
    CHECK (release_type IN ('album','ep','single','compilation','mixtape')),
  release_date    DATE,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracks (
  id              SERIAL PRIMARY KEY,
  album_id        INTEGER REFERENCES albums(id),
  artist_id       INTEGER REFERENCES artists(id),
  label_id        INTEGER REFERENCES labels(id),
  title           TEXT NOT NULL,
  version_title   TEXT,
  track_number    INTEGER,
  disc_number     INTEGER DEFAULT 1,
  duration_sec    REAL,
  isrc            TEXT UNIQUE,
  iswc            TEXT,
  genre           TEXT,
  subgenre        TEXT,
  mood            TEXT,
  bpm             INTEGER,
  key_sig         TEXT,
  year            INTEGER,
  language        TEXT DEFAULT 'en',
  sample_rate     INTEGER,
  bit_depth       INTEGER,
  channels        INTEGER,
  loudness_lufs   REAL,
  wav_fm_record_id TEXT,
  mp3_320_url     TEXT,
  mp3_128_url     TEXT,
  waveform_url    TEXT,
  status          TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','live')),
  visibility      TEXT DEFAULT 'private'
    CHECK (visibility IN ('private','public')),
  explicit        BOOLEAN DEFAULT false,
  clean_version_id INTEGER REFERENCES tracks(id),
  featured        BOOLEAN DEFAULT false,
  rights_holder   TEXT,
  rights_year     INTEGER,
  territories     TEXT DEFAULT 'WORLDWIDE',
  sync_licensed   BOOLEAN DEFAULT false,
  sync_notes      TEXT,
  master_licensed BOOLEAN DEFAULT false,
  nc_nd           BOOLEAN DEFAULT false,
  fm_source_id    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS track_credits (
  id              SERIAL PRIMARY KEY,
  track_id        INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
  artist_id       INTEGER REFERENCES artists(id),
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,
  pro_name        TEXT,
  pro_ipi         TEXT,
  publisher_id    INTEGER REFERENCES publishers(id),
  share_pct       NUMERIC(5,2),
  sort_order      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS track_territories (
  id              SERIAL PRIMARY KEY,
  track_id        INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
  territory_code  TEXT NOT NULL,
  available       BOOLEAN DEFAULT true,
  rights_holder   TEXT,
  label_id        INTEGER REFERENCES labels(id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id              SERIAL PRIMARY KEY,
  submitter_name  TEXT NOT NULL,
  submitter_email TEXT NOT NULL,
  org             TEXT,
  track_title     TEXT NOT NULL,
  artist_name     TEXT NOT NULL,
  album_title     TEXT,
  year            INTEGER,
  genre           TEXT,
  notes           TEXT,
  wav_temp_path   TEXT,
  artwork_temp_path TEXT,
  status          TEXT DEFAULT 'received'
    CHECK (status IN ('received','processing','awaiting_review','approved','rejected')),
  reviewer_notes  TEXT,
  track_id        INTEGER REFERENCES tracks(id),
  received_at     TIMESTAMPTZ DEFAULT now(),
  reviewed_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stream_events (
  id          BIGSERIAL PRIMARY KEY,
  track_id    INTEGER REFERENCES tracks(id),
  token_id    TEXT,
  ip          TEXT,
  user_agent  TEXT,
  played_at   TIMESTAMPTZ DEFAULT now(),
  duration_sec REAL
);

CREATE INDEX IF NOT EXISTS idx_tracks_status       ON tracks(status);
CREATE INDEX IF NOT EXISTS idx_tracks_artist       ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_album        ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_isrc         ON tracks(isrc);
CREATE INDEX IF NOT EXISTS idx_submissions_status  ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_stream_events_track ON stream_events(track_id);
CREATE INDEX IF NOT EXISTS idx_track_credits_track ON track_credits(track_id);
