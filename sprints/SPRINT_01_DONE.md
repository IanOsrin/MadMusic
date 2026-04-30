# Sprint 1 — DONE
**Completed:** 2026-04-30

---

## What Was Built

### Files Created

**Migrations**
- `migrations/001_initial_schema.sql` — all 9 tables + 7 indexes

**Lib**
- `lib/db.js` — unified pg / SQLite query interface + `runMigrations()`
- `lib/fm-archive.js` — stub (throws not-implemented)
- `lib/s3.js` — empty export
- `lib/transcode.js` — empty export
- `lib/queue.js` — empty export
- `lib/audio-meta.js` — empty export
- `lib/ddex.js` — empty export
- `lib/excel-ingest.js` — empty export

**Routes**
- `routes/ingest.js` — empty Router export
- `routes/ingest-catalog.js` — empty Router export (see deviation below)

**Ingest portal**
- `ingest/index.html` — placeholder
- `ingest/admin.html` — placeholder

**Scripts**
- `scripts/db-test.js` — insert/read/delete smoke test

### Files Modified
- `server.js` — added imports for `ingestRouter`, `ingestCatalogRouter`, `runMigrations`; mounted at `/api/ingest` and `/api/catalog`; added `await runMigrations()` in startup after `warmConnections()`
- `.env.example` — appended `DATABASE_URL`, `FM_ARCHIVE_*`, `AWS_*`, `S3_*`, `REDIS_URL`, `USE_IN_PROCESS_QUEUE`, `INGEST_ADMIN_SECRET`, `INGEST_INVITE_TOKEN`

---

## Deviations from Plan

**`routes/ingest-catalog.js` instead of `routes/catalog.js`**
The project already has a `routes/catalog.js` (the existing FM-backed catalog serving `/wake`, `/search`, `/trending`, etc.). Creating a new file with the same name would have overwritten it. The new ingest catalog router is at `routes/ingest-catalog.js` and is mounted at `/api/catalog` as planned — no functional difference.

**SQLite migration translation**
The migration SQL uses PostgreSQL types (`SERIAL`, `BIGSERIAL`, `TIMESTAMPTZ`, `BOOLEAN`, `NUMERIC(x,y)`). `lib/db.js` translates these automatically when running against SQLite, so a single schema file works for both databases.

---

## Smoke Test Results

```
[DB] Ran migration: 001_initial_schema.sql
DB OK
```

```
sqlite3 madmusic.db .tables
_migrations  albums  artists  labels  publishers  stream_events  submissions  track_credits  track_territories  tracks
```

---

## npm install

```
npm install pg better-sqlite3 bullmq xml2js adm-zip xlsx music-metadata fluent-ffmpeg @aws-sdk/client-s3 multer p-queue
```

Packages added: pg@8.x, better-sqlite3@9.x, bullmq@5.x, xml2js@0.6.x, adm-zip@0.5.x, xlsx@0.18.x, music-metadata@10.x, fluent-ffmpeg@2.1.3, @aws-sdk/client-s3@3.x, multer@1.x, p-queue@8.x

---

## Issues Encountered

None. All completion criteria met.
