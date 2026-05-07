# MAD Music — Track Ingest & Catalog System
## Project Specification for Claude Code

---

## Context: What Already Exists

This project extends an existing Node.js/Express music streaming server (`server.js`) that currently:
- Streams audio tracks from **FileMaker** (FM Data API) as the primary data source
- Handles subscriptions via **Paystack**
- Generates TTS "Now Playing" announcements via **ElevenLabs**
- Serves a player frontend (`public/app.html`) branded "MAD Radio Direct"
- Stores environment config in `.env` (see `.env.example`)

The existing server already has working routes for streaming, auth tokens, TTS and Paystack webhooks. **Do not touch those routes.** This project adds a parallel ingest/catalog system alongside them.

---

## What We Are Building

A **Track Ingest & Catalog System** with three parts:

1. **Catalog DB** — a local PostgreSQL (or SQLite for dev) database that replaces FileMaker as the real-time query source for the streaming server
2. **FileMaker Archive Bridge** — an API client that writes approved WAV masters into a separate FileMaker database (archival/mastering vault) and reads metadata back out for import
3. **Ingest Portal** — a web UI where tracks are submitted (by staff or trusted external parties), processed and approved before going live

The streaming server's FM queries (`FM_LAYOUT=API_Album_Songs` etc.) will be progressively replaced with queries to the local catalog DB. FileMaker remains as the WAV archive only.

---

## Architecture Overview

```
[Submitter / Staff]
        │
        ▼
┌───────────────────┐     WAV upload     ┌──────────────────────┐
│  Ingest Portal    │ ─────────────────► │  Ingest API          │
│  (web UI)         │                    │  /api/ingest/*       │
└───────────────────┘                    └──────┬───────────────┘
                                                │
                              ┌─────────────────┼──────────────────┐
                              ▼                 ▼                  ▼
                    ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
                    │  Catalog DB  │  │  Job Queue   │  │  FileMaker       │
                    │  (Postgres)  │  │  (Bull/MQ)   │  │  Archive Bridge  │
                    └──────┬───────┘  └──────┬───────┘  └──────────────────┘
                           │                 │
                           │         ┌───────┴────────┐
                           │         ▼                ▼
                           │    Transcode         Upload WAV
                           │    WAV→MP3           to FileMaker
                           │         │            container field
                           │         ▼
                           │    Upload MP3
                           │    to S3
                           │         │
                           └─────────┘
                           (update catalog
                            with S3 URLs)
                                 │
                                 ▼
                    ┌──────────────────────┐
                    │  Streaming Server    │
                    │  (existing routes)   │
                    │  now queries DB      │
                    │  instead of FM       │
                    └──────────────────────┘
```

---

## Tech Stack

Keep consistent with the existing server:

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM, same as existing server) |
| Framework | Express (already in use) |
| Database | PostgreSQL via `pg` + `pg-migrate` for migrations |
| Dev database | SQLite via `better-sqlite3` (same schema, swap via env) |
| Job queue | `bullmq` + Redis (or `bull` if Redis unavailable) |
| File uploads | `multer` (temp disk storage, not memory) |
| Transcoding | `fluent-ffmpeg` wrapping system `ffmpeg` |
| S3 client | `@aws-sdk/client-s3` (already have S3 credentials) |
| FileMaker client | `node-fetch` / `undici` to FM Data API (same pattern as existing FM calls) |
| DDEX parser | `xml2js` + `adm-zip` |
| Excel / CSV | `xlsx` (SheetJS) |
| Audio metadata | `music-metadata` (reads ID3v1/v2, RIFF INFO, BWF bext chunk, XMP) |
| Auth (admin) | Simple JWT, same `AUTH_SECRET` as existing server |
| Frontend | Vanilla JS + HTML — no framework, consistent with existing app.html style |

---

## Database Schema

### `artists`
```sql
CREATE TABLE artists (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  sort_name       TEXT,              -- e.g. 'Beatles, The' for sorting
  bio             TEXT,
  country         TEXT,              -- ISO 3166-1 alpha-2 e.g. 'ZA', 'GB'
  artwork_url     TEXT,

  -- Rights & PRO
  pro_name        TEXT,              -- Performing Rights Organisation e.g. SAMRO, ASCAP, PRS, SOCAN
  pro_ipi         TEXT,              -- IPI (Interested Parties Information) number — unique PRO identifier
  pro_isni        TEXT,              -- ISNI (International Standard Name Identifier)

  created_at      TIMESTAMPTZ DEFAULT now()
);
```

### `publishers`
```sql
CREATE TABLE publishers (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  pro_name        TEXT,              -- PRO the publisher is affiliated with
  pro_ipi         TEXT,              -- Publisher IPI number

  created_at      TIMESTAMPTZ DEFAULT now()
);
```

### `labels`
```sql
CREATE TABLE labels (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  country         TEXT,
  contact_email   TEXT,
  website         TEXT,

  created_at      TIMESTAMPTZ DEFAULT now()
);
```

### `albums`
```sql
CREATE TABLE albums (
  id              SERIAL PRIMARY KEY,
  artist_id       INTEGER REFERENCES artists(id),
  label_id        INTEGER REFERENCES labels(id),
  title           TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  year            INTEGER,
  artwork_url     TEXT,
  catalogue       TEXT,              -- catalogue number e.g. 'MADLP001'
  upc             TEXT,              -- Universal Product Code (barcode)
  release_type    TEXT DEFAULT 'album'
    CHECK (release_type IN ('album','ep','single','compilation','mixtape')),
  release_date    DATE,

  created_at      TIMESTAMPTZ DEFAULT now()
);
```

### `tracks`
```sql
CREATE TABLE tracks (
  id              SERIAL PRIMARY KEY,
  album_id        INTEGER REFERENCES albums(id),
  artist_id       INTEGER REFERENCES artists(id),  -- primary performing artist
  label_id        INTEGER REFERENCES labels(id),
  title           TEXT NOT NULL,
  version_title   TEXT,              -- e.g. 'Radio Edit', 'Instrumental', 'Extended Mix'
  track_number    INTEGER,
  disc_number     INTEGER DEFAULT 1,
  duration_sec    REAL,
  isrc            TEXT UNIQUE,       -- International Standard Recording Code
  iswc            TEXT,              -- International Standard Musical Work Code (the composition)
  genre           TEXT,
  subgenre        TEXT,
  mood            TEXT,
  bpm             INTEGER,
  key_sig         TEXT,              -- e.g. 'Am', 'F#'
  year            INTEGER,
  language        TEXT DEFAULT 'en', -- ISO 639-1

  -- Technical (read from file on ingest)
  sample_rate     INTEGER,           -- e.g. 44100, 48000, 96000
  bit_depth       INTEGER,           -- e.g. 16, 24, 32
  channels        INTEGER,           -- 1 = mono, 2 = stereo
  loudness_lufs   REAL,              -- EBU R128 integrated loudness (from BWF bext or measured)

  -- File locations
  wav_fm_record_id TEXT,             -- FileMaker record ID of the WAV master
  mp3_320_url     TEXT,              -- S3 URL (320kbps delivery)
  mp3_128_url     TEXT,              -- S3 URL (128kbps streaming)
  waveform_url    TEXT,              -- S3 URL for waveform JSON

  -- Content flags
  status          TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','live')),
  visibility      TEXT DEFAULT 'private'
    CHECK (visibility IN ('private','public')),
  explicit        BOOLEAN DEFAULT false,
  clean_version_id INTEGER REFERENCES tracks(id),  -- points to the clean counterpart of an explicit track (or vice versa)
  featured        BOOLEAN DEFAULT false,

  -- Rights & licensing
  rights_holder   TEXT,              -- name of the master rights holder (often the label)
  rights_year     INTEGER,           -- copyright year
  territories     TEXT DEFAULT 'WORLDWIDE',
                                     -- comma-separated ISO country codes, or 'WORLDWIDE'
                                     -- or 'WORLDWIDE EXCL GB,US' etc.
  sync_licensed   BOOLEAN DEFAULT false,  -- cleared for sync licensing (TV, film, ads)
  sync_notes      TEXT,              -- any restrictions or notes on sync use
  master_licensed BOOLEAN DEFAULT false,  -- master rights cleared for third-party use
  nc_nd           BOOLEAN DEFAULT false,  -- non-commercial / no-derivatives restriction

  -- Metadata import
  fm_source_id    TEXT,              -- original FM record ID if imported from FileMaker
  notes           TEXT,              -- internal notes (not public)

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
```

### `track_credits`
Separates performing artists, composers, lyricists, producers, engineers — all the people involved in a track. One row per person per role.

```sql
CREATE TABLE track_credits (
  id              SERIAL PRIMARY KEY,
  track_id        INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
  artist_id       INTEGER REFERENCES artists(id),  -- NULL if person not in artists table
  name            TEXT NOT NULL,                   -- display name (always stored directly)
  role            TEXT NOT NULL,
    -- Performer roles:   'MainArtist' | 'FeaturedArtist' | 'Remixer' | 'Conductor' | 'Orchestra'
    -- Composer roles:    'Composer' | 'Lyricist' | 'ComposerLyricist' | 'Arranger' | 'Author'
    -- Production roles:  'Producer' | 'AssociatedPerformer' | 'StudioPersonnel'
    -- Engineering roles: 'MixingEngineer' | 'MasteringEngineer' | 'RecordingEngineer'
  pro_name        TEXT,              -- PRO for this credit (may differ from artist's primary PRO)
  pro_ipi         TEXT,              -- IPI number for this credit
  publisher_id    INTEGER REFERENCES publishers(id),  -- for composer/lyricist credits
  share_pct       NUMERIC(5,2),      -- composition ownership share (0–100), must sum to 100 per track
  sort_order      INTEGER DEFAULT 0  -- display order within role
);
```

### `track_territories`
For complex territory rules where a comma-separated string isn't enough (e.g. different rights holders per territory):

```sql
CREATE TABLE track_territories (
  id              SERIAL PRIMARY KEY,
  track_id        INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
  territory_code  TEXT NOT NULL,     -- ISO 3166-1 alpha-2, or 'WORLDWIDE'
  available       BOOLEAN DEFAULT true,  -- false = explicitly excluded
  rights_holder   TEXT,
  label_id        INTEGER REFERENCES labels(id)
);
```

### `submissions`
```sql
CREATE TABLE submissions (
  id              SERIAL PRIMARY KEY,
  submitter_name  TEXT NOT NULL,
  submitter_email TEXT NOT NULL,
  org             TEXT,             -- label / distributor / artist
  track_title     TEXT NOT NULL,
  artist_name     TEXT NOT NULL,
  album_title     TEXT,
  year            INTEGER,
  genre           TEXT,
  notes           TEXT,

  -- File refs (temp storage paths, cleared after processing)
  wav_temp_path   TEXT,
  artwork_temp_path TEXT,

  status          TEXT DEFAULT 'received'
    CHECK (status IN ('received','processing','awaiting_review','approved','rejected')),
  reviewer_notes  TEXT,
  track_id        INTEGER REFERENCES tracks(id),  -- populated when approved → track created

  received_at     TIMESTAMPTZ DEFAULT now(),
  reviewed_at     TIMESTAMPTZ
);
```

### `stream_events` (mirrors existing FM stream events)
```sql
CREATE TABLE stream_events (
  id          BIGSERIAL PRIMARY KEY,
  track_id    INTEGER REFERENCES tracks(id),
  token_id    TEXT,
  ip          TEXT,
  user_agent  TEXT,
  played_at   TIMESTAMPTZ DEFAULT now(),
  duration_sec REAL       -- how long they actually listened
);
```

---

## New API Routes

All new routes live under `/api/ingest/*` and `/api/catalog/*`. Mount them in `server.js` alongside existing routes.

### Ingest API (`/api/ingest`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/ingest/submit` | Receive WAV + metadata from submission form. Saves to temp, creates `submissions` record, queues processing job. Returns `{ submissionId }`. |
| GET | `/api/ingest/submissions` | Admin: list all submissions with status filter |
| GET | `/api/ingest/submissions/:id` | Admin: get submission detail |
| PATCH | `/api/ingest/submissions/:id/approve` | Admin: approve → creates track, triggers FM archive upload + S3 transcode |
| PATCH | `/api/ingest/submissions/:id/reject` | Admin: reject with notes |
| GET | `/api/ingest/jobs/:id` | Poll processing job status (for UI progress) |

### Catalog API (`/api/catalog`)

These replace the existing FileMaker queries used by the streaming server:

| Method | Path | Description |
|---|---|---|
| GET | `/api/catalog/tracks` | List tracks (status=live, visibility=public). Supports `?artist=`, `?genre=`, `?search=`, `?page=` |
| GET | `/api/catalog/tracks/:id` | Single track with full metadata |
| GET | `/api/catalog/albums` | List albums |
| GET | `/api/catalog/albums/:id` | Album with track listing |
| GET | `/api/catalog/artists` | List artists |
| PATCH | `/api/catalog/tracks/:id` | Admin: update metadata, status, visibility |
| DELETE | `/api/catalog/tracks/:id` | Admin: soft-delete (sets status = 'rejected') |

### Metadata Import (`/api/catalog/import`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/catalog/import/fm` | Admin: trigger a sync pull from FileMaker's existing `API_Album_Songs` layout into the catalog DB. Idempotent (uses `fm_source_id` to avoid duplicates). |
| GET | `/api/catalog/import/fm/preview` | Dry-run: show what would be imported / updated without writing |

---

## FileMaker Archive Bridge

A small module `lib/fm-archive.js` that handles writing to the **separate** FileMaker WAV archive database.

```javascript
// lib/fm-archive.js
export async function archiveWav(wavBuffer, metadata) {
  // 1. Authenticate with FM Data API (separate FM_ARCHIVE_* env vars)
  // 2. Create a new record in FM_ARCHIVE_LAYOUT with metadata fields
  // 3. Upload WAV buffer to the container field via FM Data API /upload endpoint
  // 4. Return the FM record ID
}

export async function importCatalogFromFM() {
  // Pull all records from FM_LAYOUT (existing API_Album_Songs)
  // Map FM field names to catalog DB columns
  // Upsert into tracks/albums/artists tables using fm_source_id
}
```

FM Data API upload endpoint pattern (for container fields):
```
POST /fmi/data/v1/databases/{db}/layouts/{layout}/records/{recordId}/containers/{fieldName}/1
Content-Type: multipart/form-data
Authorization: Bearer {token}
Body: form-data with 'upload' field containing the file
```

---

## Processing Pipeline (Job Queue)

When a submission is approved, a `BullMQ` job runs the following steps. Each step updates the submission `status` so the admin UI can show progress.

```
Job: processTrack(submissionId)
  ├── 1. Load WAV from temp path
  ├── 2. Validate: check it's a real WAV, get duration, sample rate, channels
  ├── 3. Generate waveform JSON (downsample to ~1000 points for player visualisation)
  │        → upload to S3: tracks/{trackId}/waveform.json
  ├── 4. Transcode WAV → MP3 320kbps (ffmpeg)
  │        → upload to S3: tracks/{trackId}/audio_320.mp3
  ├── 5. Transcode WAV → MP3 128kbps (ffmpeg)
  │        → upload to S3: tracks/{trackId}/audio_128.mp3
  ├── 6. Archive WAV → FileMaker container (fm-archive.js)
  │        → store returned FM record ID on track
  ├── 7. Upload artwork → S3: tracks/{trackId}/artwork.jpg
  ├── 8. Update track record: set S3 URLs, fm_record_id, status='approved'
  ├── 9. Clean up temp files
  └── 10. (Optional) Send email notification
```

S3 key convention: `tracks/{trackId}/{filename}` — keeps all assets for a track together.

---

## Ingest Portal (Web UI)

A single-page HTML file served at `/ingest` (or `/ingest/index.html`). Style it consistently with the existing MAD Radio Direct aesthetic (dark background `#1a1208`, gold accents `#d4a843`, same font stack).

### Screen 1: Submission Form (`/ingest`)

Public-facing (no auth required, or simple invite-token auth).

Fields:
- Submitter name, email, organisation
- Track title, artist name, album title (optional), year, genre
- WAV file drop zone — show waveform preview using Web Audio API (reuse the waveform code from Restoration app)
- Artwork upload (optional)
- Notes / message to reviewer
- Submit button → POST to `/api/ingest/submit` → show submission ID and "we'll be in touch"

### Screen 2: Admin Dashboard (`/ingest/admin`)

JWT-protected. Single HTML page with tabs:

**Submissions tab**
- Table: received submissions with status badges
- Click row → expand inline: metadata, waveform preview, WAV player, artwork preview
- Approve / Reject buttons with notes field
- Live status update via polling `/api/ingest/jobs/:id`

**Catalog tab**
- All tracks with status/visibility toggles
- Inline metadata editing (title, artist, genre, mood, BPM, featured flag)
- Bulk visibility toggle

**Import tab**
- "Import from FileMaker" button → runs dry-run preview first, then confirm to write
- Shows import log: new records, updated records, skipped

---

## Environment Variables to Add

```env
# Catalog DB
DATABASE_URL=postgresql://user:pass@localhost:5432/madmusic
# or for SQLite dev:
# DATABASE_URL=sqlite:./madmusic.db

# FileMaker Archive (separate from streaming FM)
FM_ARCHIVE_HOST=https://yourhost.fmcloud.fm
FM_ARCHIVE_DB=YourArchiveDatabase
FM_ARCHIVE_USER=archiveuser
FM_ARCHIVE_PASS=archivepass
FM_ARCHIVE_LAYOUT=API_WAV_Archive
FM_ARCHIVE_WAV_FIELD=WAVFile

# S3 (already set, add if not present)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
S3_BUCKET=madmusic-assets
S3_BASE_URL=https://madmusic-assets.s3.amazonaws.com

# Redis (for job queue)
REDIS_URL=redis://localhost:6379

# Ingest admin auth
INGEST_ADMIN_SECRET=replace_with_strong_secret

# Optional: submission invite token (if you want to gate the submission form)
INGEST_INVITE_TOKEN=

# Optional: email notification on submission received / approved
# Uses existing EMAIL_* vars from .env
```

---

## Implementation Order

Build in this order — each phase is independently useful:

### Phase 1 — Catalog DB + FM Import
1. Set up DB with migrations (`pg-migrate` or `node-pg-migrate`)
2. Build `lib/fm-archive.js` → `importCatalogFromFM()` 
3. Build `/api/catalog/import/fm` route
4. Run import → verify data in DB
5. Swap streaming server's FM catalog queries to use DB (drop-in, same response shape)

**Outcome:** Streaming server no longer hits FM for reads. FM still owns the data but you have a fast local copy.

### Phase 2 — Submission Form + Processing Pipeline
1. Set up BullMQ + Redis
2. Build `POST /api/ingest/submit` with multer + temp storage
3. Build job queue worker: validate → transcode → S3 upload
4. Build submission portal HTML (Screen 1)

**Outcome:** You can accept WAV submissions and they get processed to S3.

### Phase 3 — Admin Dashboard + FM Archive Write
1. Build admin auth middleware (JWT)
2. Build approval routes (`/approve`, `/reject`)
3. Wire FM archive write on approval
4. Build admin dashboard HTML (Screen 2)

**Outcome:** Full end-to-end: submission → review → approve → live on MAD Radio Direct.

### Phase 4 — Polish
1. Waveform preview in submission form (reuse Web Audio code)
2. Email notifications
3. Bulk FM metadata import UI
4. Artist/album management in admin

---

## File Structure to Create

```
server.js                    ← existing, add new route mounts
routes/
  tts.js                     ← existing
  ingest.js                  ← NEW: submission + approval routes
  catalog.js                 ← NEW: catalog CRUD routes
lib/
  fm.js                      ← existing FM client (streaming)
  fm-archive.js              ← NEW: FM archive write client
  db.js                      ← NEW: DB connection pool
  s3.js                      ← NEW: S3 upload helpers
  transcode.js               ← NEW: ffmpeg wrapper
  queue.js                   ← NEW: BullMQ setup + worker
migrations/
  001_initial_schema.sql     ← NEW
lib/
  audio-meta.js              ← NEW: music-metadata wrapper, format detection
  ddex.js                    ← NEW: DDEX ZIP parser (main)
  ddex-ern382.js             ← NEW: ERN 3.8.2 field extractor
  ddex-ern41.js              ← NEW: ERN 4.1 field extractor
  excel-ingest.js            ← NEW: Excel/CSV parser + column mapper
public/
  app.html                   ← existing player
ingest/
  index.html                 ← NEW: submission portal (manual + DDEX + Excel)
  admin.html                 ← NEW: admin dashboard (submissions, catalog, DDEX, Excel tabs)
```

---

## DDEX Ingest

DDEX (Digital Data Exchange) is the music industry standard XML format used by labels, distributors (DistroKid, TuneCore, CD Baby, etc.) and rights organisations. Supporting it means any professional sender can drop a DDEX package and it lands cleanly in the catalog.

### DDEX Package Format

A DDEX delivery is a ZIP containing:
- One XML file (the message) — typically `NewReleaseMessage` (ERN 3.8.2 or 4.x)
- Audio files (WAV or FLAC) referenced in the XML
- Artwork files (JPEG) referenced in the XML

The XML describes releases, resources (audio files, images) and deals (territory, availability).

### What to Parse from a NewReleaseMessage

Key elements to extract and map to the catalog schema:

```
NewReleaseMessage
  ├── ReleaseList
  │     └── Release (the Album or Single)
  │           ├── ReleaseReference           → album.title / track.title
  │           ├── ReleaseType                → Album | Single | EP
  │           ├── DisplayArtistName          → artist.name
  │           ├── ReleaseDate                → track.year
  │           └── TrackList → TrackRelease
  │                 ├── SequenceNumber       → track.track_number
  │                 └── LinkedReleaseResourceReference → links to SoundRecording
  │
  └── ResourceList
        └── SoundRecording
              ├── SoundRecordingId.ISRC           → track.isrc
              ├── SoundRecordingId.CatalogNumber  → album.catalogue
              ├── SoundRecordingType              → MusicalWorkSoundRecording etc.
              ├── Title.TitleText                 → track.title
              ├── Title (SubtitleType=Version)    → track.version_title
              ├── Duration (ISO 8601: PT3M45S)    → track.duration_sec
              ├── DisplayArtistName               → track artist
              ├── DisplayArtist[].Artist.PartyName → track_credits (MainArtist / FeaturedArtist)
              ├── Contributor[].PartyName         → track_credits (Composer/Lyricist/Producer/Engineer)
              ├── Contributor[].Role              → track_credits.role
              ├── Contributor[].HasRightShare     → track_credits.share_pct
              ├── RightsController.PartyName      → track.rights_holder
              ├── RightsController.RightsType     → master_licensed flag
              ├── PLine.Year                      → track.rights_year
              ├── PLine.PLineText                 → track.rights_holder (fallback)
              ├── Genre.GenreText                 → track.genre
              ├── Genre.SubGenre                  → track.subgenre
              ├── ParentalWarningType             → track.explicit (Explicit/NoAdviceRequired/NotExplicit)
              ├── LanguageOfPerformance           → track.language
              ├── AudioFile.FileName              → WAV filename inside ZIP
              ├── WorkId.ISWC                     → track.iswc
              └── TechnicalDetails
                    ├── AudioCodecType            → technical.codec
                    ├── SamplingRate              → track.sample_rate
                    └── NumberOfChannels          → track.channels

  DealList → Deal
        ├── DealTerms.CommercialModelType         → visibility logic
        ├── DealTerms.Usage.UseType               → stream / download flags
        └── DealTerms.TerritoryCode               → track.territories / track_territories
```

### New Routes for DDEX

| Method | Path | Description |
|---|---|---|
| POST | `/api/ingest/ddex` | Upload a DDEX ZIP package. Extracts XML + assets, parses the NewReleaseMessage, creates a submission record per track, queues processing. Returns `{ submissionIds: [...] }` |
| GET | `/api/ingest/ddex/preview` | Upload DDEX ZIP, parse and return what would be imported — no writes. Useful for admin to review before committing. |

### DDEX Parser Module

Create `lib/ddex.js`:

```javascript
// lib/ddex.js
import { parseStringPromise } from 'xml2js'
import AdmZip from 'adm-zip'

export async function parseDDEXPackage(zipBuffer) {
  // 1. Unzip
  // 2. Find the XML file (look for *NewReleaseMessage*.xml or any .xml)
  // 3. Parse XML with xml2js
  // 4. Extract ResourceList (SoundRecordings) and ReleaseList
  // 5. Return normalised array of track objects matching submission schema
  // 6. Return map of { filename → Buffer } for audio and artwork files
}
```

Dependencies to add: `xml2js`, `adm-zip`

### DDEX Version Support

Support ERN 3.8.2 (most common from distributors) and ERN 4.1. Detect version from the XML namespace:
- `ern:NewReleaseMessage xmlns:ern="http://ddex.net/xml/ern/382"` → 3.8.2
- `ern:NewReleaseMessage xmlns:ern="http://ddex.net/xml/ern/41"` → 4.1

Field paths differ slightly between versions — abstract into version-specific extractors in `lib/ddex-ern382.js` and `lib/ddex-ern41.js`.

### Admin Dashboard — DDEX Tab

Add a **DDEX Import** tab to the admin dashboard:
- Drag-drop zone for DDEX ZIP
- "Preview" button → shows parsed tracks in a table before committing
- Columns: ISRC, Title, Artist, Duration, Audio file found (✓/✗), Artwork found (✓/✗)
- "Import All" → creates submissions, queues processing
- Individual row toggles to deselect tracks before importing

---

## Excel / Spreadsheet Ingest

Many smaller labels and independent artists send track metadata as Excel files (`.xlsx`) or CSVs, usually with one row per track and columns for title, artist, ISRC, genre etc. Supporting this removes friction for non-technical senders.

### Expected Column Names

Be flexible — map common variations. Required: title, artist. Everything else optional.

| Catalog Field | Accepted Column Names (case-insensitive) |
|---|---|
| `track.title` | Title, Track Title, Track Name, Song Title, Song |
| `track.version_title` | Version, Mix, Edit, Version Title |
| `artist.name` | Artist, Artist Name, Performer, Main Artist |
| `track_credits (FeaturedArtist)` | Featuring, Feat, Featured Artist, Ft |
| `track_credits (Composer)` | Composer, Writer, Songwriter |
| `track_credits (Lyricist)` | Lyricist, Lyric Writer |
| `track_credits (Producer)` | Producer |
| `album.title` | Album, Album Title, Release Title |
| `album.upc` | UPC, Barcode, EAN |
| `album.catalogue` | Cat No, Catalogue, Catalogue Number, Cat# |
| `label.name` | Label, Record Label |
| `publisher.name` | Publisher, Music Publisher |
| `track.isrc` | ISRC |
| `track.iswc` | ISWC |
| `track.track_number` | Track, Track No, Track Number, #  |
| `track.disc_number` | Disc, Disc No, CD |
| `track.year` | Year, Release Year, Date |
| `track.genre` | Genre |
| `track.subgenre` | Subgenre, Sub-genre, Style |
| `track.bpm` | BPM, Tempo |
| `track.key_sig` | Key, Key Sig, Musical Key |
| `track.mood` | Mood |
| `track.language` | Language |
| `track.explicit` | Explicit, Parental Advisory (Yes/No/True/False/Clean/E) |
| `track.duration_sec` | Duration (accept MM:SS or seconds) |
| `track.territories` | Territory, Territories, Rights Territory |
| `track.sync_licensed` | Sync, Sync Licensed, Sync Cleared |
| `track.rights_holder` | Rights Holder, Master Rights, P Line |
| `track.rights_year` | Rights Year, Copyright Year, ℗ Year |
| `artist.pro_name` | PRO, PRO Name, Collecting Society |
| `artist.pro_ipi` | IPI, IPI Number |
| `submitter_email` | Email, Contact Email |
| `notes` | Notes, Comments |

### New Routes for Excel

| Method | Path | Description |
|---|---|---|
| POST | `/api/ingest/excel` | Upload `.xlsx` or `.csv`. Parse rows, return preview of what was read + any validation errors. No writes on this call. |
| POST | `/api/ingest/excel/confirm` | Given the parsed + confirmed rows (sent back as JSON), create submission records. Returns `{ submissionIds: [...] }` |

Two-step (parse → confirm) prevents accidental bulk imports.

### Excel Parser Module

Create `lib/excel-ingest.js`:

```javascript
// lib/excel-ingest.js
import * as XLSX from 'xlsx'

export function parseTrackSheet(buffer) {
  // 1. Read workbook (handles .xlsx and .csv)
  // 2. Take first sheet
  // 3. Convert to array of row objects (header row → keys)
  // 4. Map flexible column names to canonical field names (fuzzy match)
  // 5. Parse duration: '3:45' → 225 seconds
  // 6. Parse explicit: 'yes'/'true'/'1' → true
  // 7. Return { rows: [...], errors: [...], unmappedColumns: [...] }
}
```

Dependencies to add: `xlsx` (SheetJS — already used in the Restoration app frontend)

### Admin Dashboard — Excel Tab

Add an **Excel Import** tab:
- File upload for `.xlsx` or `.csv`
- On upload: show parsed table with colour-coded validation (green = good, amber = optional field missing, red = required field missing or parse error)
- Editable cells to fix errors inline before confirming
- "Confirm Import" → creates submission records (no audio yet — submissions show as `awaiting_audio` status)
- Later, audio files can be matched to submissions by ISRC or title

### Workflow: Metadata-First Ingest

The Excel path enables a common real-world workflow:
1. Label sends Excel with track metadata → imported, submissions created with status `awaiting_audio`
2. Label sends WAV files (by SFTP, WeTransfer, or upload portal) separately
3. Admin matches audio files to existing submissions by ISRC or title → triggers processing pipeline
4. Track goes live

Add a `match_audio` endpoint: `POST /api/ingest/submissions/:id/audio` — accepts WAV upload and attaches to an existing metadata-only submission.

---

---

## Audio File Metadata Reading

All dropped or uploaded audio files — WAV, MP3, or otherwise — should have their embedded metadata extracted immediately on receipt, regardless of whether the format is accepted for ingest. This serves three purposes:

1. **Auto-populate the submission form** — when someone drops a file on the portal, read its tags and pre-fill title, artist, ISRC, BPM, year etc. before they've typed anything
2. **Cross-check declared metadata** — during processing, compare what was typed in the form against what's embedded in the file and flag discrepancies for the reviewer
3. **Fallback data** — if DDEX or Excel metadata is sparse, embedded tags fill the gaps

### Format Support

Use the `music-metadata` npm package — it handles all common formats without native bindings:

| Format | Tag Standard | What's Available |
|---|---|---|
| WAV | RIFF INFO chunk | INAM (title), IART (artist), IPRD (album), IGNR (genre), ICRD (date), ISRC, IBPM, ITRK (track number), ICMT (comment) |
| WAV | BWF `bext` chunk | Description, Originator, OriginatorReference, OriginationDate, UMID, LoudnessValue (EBU R128) |
| WAV | ID3v2 embedded | Full ID3v2 tag set (some DAWs embed ID3 inside WAV) |
| MP3 | ID3v1 | Title, Artist, Album, Year, Genre, Comment, Track |
| MP3 | ID3v2.3 / v2.4 | Full tag set: TIT2, TPE1, TALB, TDRC, TCON, TRCK, TSRC (ISRC), TBPM, TKEY, COMM, TLAN, APIC (artwork) |
| MP3 | XMP | Extended metadata if present |

### Metadata Extraction Module

Create `lib/audio-meta.js`:

```javascript
// lib/audio-meta.js
import * as mm from 'music-metadata'

/**
 * Extract metadata from an audio file buffer.
 * Returns a normalised object mapped to catalog field names.
 * Never throws — returns partial data + errors array on failure.
 */
export async function extractAudioMeta(buffer, mimeType) {
  try {
    const { common, format, native } = await mm.parseBuffer(buffer, { mimeType })

    // Technical metadata
    const technical = {
      duration_sec:  format.duration    ? Math.round(format.duration) : null,
      sample_rate:   format.sampleRate  || null,
      bit_depth:     format.bitsPerSample || null,
      channels:      format.numberOfChannels || null,
      bitrate_kbps:  format.bitrate ? Math.round(format.bitrate / 1000) : null,
      codec:         format.codec || null,
      container:     format.container || null,   // 'WAVE', 'MPEG' etc.
    }

    // EBU R128 loudness from BWF bext chunk (professional WAVs from DAWs often have this)
    const bwf = native?.['riff']?.find(t => t.id === 'bext')
    const loudness_lufs = bwf?.value?.loudnessValue != null
      ? bwf.value.loudnessValue / 100   // stored as int × 100
      : null

    // Normalised catalog fields
    const meta = {
      title:        common.title        || null,
      artist:       common.artist       || common.artists?.[0] || null,
      album:        common.album        || null,
      year:         common.year         || null,
      genre:        common.genre?.[0]   || null,
      isrc:         common.isrc         || null,
      bpm:          common.bpm          ? Math.round(common.bpm) : null,
      key_sig:      common.key          || null,
      track_number: common.track?.no   || null,
      language:     common.language     || null,
      comment:      common.comment?.[0]?.text || common.comment || null,
      // Artwork — return as Buffer + mime if present
      artwork:      common.picture?.[0]
        ? { data: common.picture[0].data, mime: common.picture[0].format }
        : null,
    }

    return { meta, technical, loudness_lufs, errors: [] }
  } catch (err) {
    return { meta: {}, technical: {}, loudness_lufs: null, errors: [err.message] }
  }
}

/**
 * Detect file format from buffer magic bytes.
 * Returns 'wav' | 'mp3' | 'flac' | 'aiff' | 'unknown'
 */
export function detectAudioFormat(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'wav'   // RIFF
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'mp3'   // MPEG sync
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3'   // ID3 header
  if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return 'flac'  // fLaC
  if (b[0] === 0x46 && b[1] === 0x4F && b[2] === 0x52 && b[3] === 0x4D) return 'aiff'  // FORM
  return 'unknown'
}
```

### Accepted vs. Readable — Format Policy

The system reads metadata from any audio format. Acceptance for ingest is a separate decision:

| Format | Metadata Readable | Accepted for Ingest |
|---|---|---|
| WAV (PCM) | ✅ | ✅ Always |
| WAV (32-bit float) | ✅ | ✅ Always |
| FLAC | ✅ | ✅ Accepted (transcode to WAV for archive, MP3 for delivery) |
| MP3 | ✅ | ⚠️ Special circumstances only (flag for reviewer, never auto-approve) |
| AIFF | ✅ | ⚠️ Special circumstances only |
| AAC / M4A | ✅ | ❌ Rejected |
| OGG | ✅ | ❌ Rejected |

When an MP3 or non-standard format is uploaded, the system should:
1. Still extract and display all metadata it finds
2. Create the submission with `status = 'awaiting_review'` and a `format_flag` warning
3. Show a clear amber warning in the admin dashboard: **"Non-standard format — manual review required before processing"**
4. Block the normal processing pipeline — an admin must explicitly override to proceed
5. Store a `format_override_reason` text field on the submission that the admin must fill before approving

### Route: Metadata Preview (No Submission Created)

Add a lightweight endpoint the submission form hits immediately on file drop — before the user has filled anything in:

```
POST /api/ingest/meta-preview
Body: multipart/form-data with 'audio' field (the dropped file)
Response: { format, accepted, meta, technical, loudness_lufs, warnings }
```

The portal JS calls this on `dragover` / file select, receives the metadata JSON, and pre-fills the form fields. If the format is not normally accepted, show the amber warning immediately so the submitter knows before they fill out the rest of the form.

### In the Processing Pipeline

During the job worker, after loading the file, always run `extractAudioMeta` and:
- Store `technical` fields (sample rate, bit depth, channels, duration) on the track record
- Store `loudness_lufs` if present (useful for the normaliser default in the Restoration app)
- Compare `meta.isrc` against the declared ISRC — if they differ, add a `metadata_conflict` flag for the reviewer
- If artwork is embedded and no artwork was uploaded separately, extract and upload the embedded artwork to S3

### In the Submission Form (Frontend)

```javascript
// On file drop / file input change:
async function onAudioFileDrop(file) {
  const fd = new FormData()
  fd.append('audio', file)
  const res = await fetch('/api/ingest/meta-preview', { method: 'POST', body: fd })
  const { format, accepted, meta, technical, warnings } = await res.json()

  // Show format badge
  showFormatBadge(format, accepted)

  // Pre-populate form fields if empty
  if (meta.title   && !titleField.value)   titleField.value   = meta.title
  if (meta.artist  && !artistField.value)  artistField.value  = meta.artist
  if (meta.album   && !albumField.value)   albumField.value   = meta.album
  if (meta.isrc    && !isrcField.value)    isrcField.value    = meta.isrc
  if (meta.bpm     && !bpmField.value)     bpmField.value     = meta.bpm
  if (meta.year    && !yearField.value)    yearField.value    = meta.year
  if (meta.genre   && !genreField.value)   genreField.value   = meta.genre
  if (meta.key_sig && !keyField.value)     keyField.value     = meta.key_sig

  // Show duration + technical spec
  showTechnicalInfo(technical)

  // Show warnings (non-standard format, low sample rate, mono, etc.)
  warnings.forEach(showWarning)
}
```

Useful warnings to generate client-side or server-side:
- Sample rate < 44100 Hz — "Low sample rate"
- Bit depth < 16 — "Low bit depth"
- Mono — "Mono file — confirm this is intentional"
- MP3 bitrate < 320kbps — "Lossy source at low bitrate — quality may be compromised"
- Duration < 60 sec — "Very short track — confirm"
- Duration > 12 min — "Long track — confirm"
- No ISRC embedded — "No ISRC found in file — please enter manually"

---

## Notes for the Implementer

- The existing server uses **ESM** (`import`/`export`), keep that consistent throughout
- FileMaker Data API auth is token-based: `POST /fmi/data/v1/databases/{db}/sessions` returns a bearer token valid for ~15 min — cache it and refresh on 401
- For the waveform generator in the processing pipeline, downsample the WAV's PCM to ~1000 RMS points and store as `{ peaks: Float32Array }` JSON — the existing player already expects this format
- S3 uploads for audio should set `Content-Type: audio/mpeg` and `Cache-Control: public, max-age=31536000` (immutable once uploaded)
- The submission form WAV drop zone should **not** upload the full WAV to the browser — use Web Audio API to decode locally and generate a waveform preview, then upload via `FormData` to the API only on submit
- For dev without Redis, `bullmq` can be swapped for a simple in-process queue using `p-queue` — add a `USE_IN_PROCESS_QUEUE=true` env flag
