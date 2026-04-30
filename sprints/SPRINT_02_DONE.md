# Sprint 2 — DONE
**Completed:** 2026-04-30

---

## What Was Built

### Files Created / Updated

| File | Status | Notes |
|---|---|---|
| `lib/fm-catalog.js` | NEW | Reads existing FM catalog via `API_Album_Songs` layout |
| `lib/fm-archive.js` | UPDATED | Full implementation for separate FM archive DB (stub in Sprint 1) |
| `lib/admin-auth.js` | NEW | Bearer token middleware for admin routes |
| `routes/ingest-catalog.js` | UPDATED | Import routes: `GET /api/catalog/import/fm/preview` + `POST /api/catalog/import/fm` |

---

## FM Field Names Found in Codebase

These are the actual field names the existing server reads from `API_Album_Songs`:

| Catalog field | FM field name(s) |
|---|---|
| `track.title` | `Track Name`, `Tape Files::Track Name`, `Song Title`, `Title` |
| `artists.name` (album artist) | `Album Artist`, `Tape Files::Album Artist`, `Artist` |
| `artists.name` (track artist) | `Track Artist`, `Artist` |
| `albums.title` | `Album Title`, `Tape Files::Album Title`, `Album` |
| `tracks.genre` | `Local Genre`, `Song Files::Local Genre` |
| `tracks.year` | `Year of Release`, `Year` |
| `tracks.language` | `Language Code`, `Language` |
| `tracks.isrc` | `ISRC`, `Tape Files::ISRC` |
| `albums.catalogue` | `Album Catalogue Number`, `Reference Catalogue Number`, `Tape Files::Reference Catalogue Number` |
| `tracks.mp3_320_url` | `S3_URL`, `Tape Files::S3_URL`, `mp3`, `MP3`, `Tape Files::mp3`, etc. |
| `tracks.duration_sec` | `Duration`, `Track Duration`, `Tape Files::Duration` (MM:SS or seconds) |
| `tracks.track_number` | All candidates in `TRACK_SEQUENCE_FIELDS` from `lib/fm-fields.js` |
| `tracks.visibility` | Controlled by `FM_VISIBILITY_FIELD` / `FM_VISIBILITY_VALUE` env vars |
| `tracks.featured` | Controlled by `FM_FEATURED_FIELD` / `FM_FEATURED_VALUE` env vars |
| FM Record ID | `record.recordId` → stored as `fm_source_id` |

---

## Design Decisions

**Reused existing `fm-client.js` instead of writing a new FM client**
The sprint spec showed a standalone `getToken()` pattern. Instead, `fm-catalog.js` imports `fmGet` from the existing `fm-client.js`, which already has a 20-connection pool, exponential backoff retry, token refresh on 401, and rate limiting. Writing a second client would duplicate all of that.

**`fm-archive.js` uses native `fetch` (not the undici pool)**
The FM archive is a separate FM instance (different host/db via `FM_ARCHIVE_*` vars). Calls are infrequent (one per track approval), so the global fetch with simple token refresh is appropriate. No pool needed.

**Upsert pattern uses SELECT-after-INSERT**
To avoid `RETURNING id` which has different return shapes on PostgreSQL vs SQLite in the `db.js` wrapper, upserts do:
1. `INSERT ... ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`
2. `SELECT id FROM ... WHERE slug = $1`

This works identically on both databases.

**Tracks imported as `status='live'`**
FM records are already live in production. On import they land directly as `live` rather than `pending`, so the streaming server cutover (Sprint 3) can query them immediately.

---

## `fm-archive.js` Status

Fully implemented (not a stub). Will throw if `FM_ARCHIVE_*` env vars are not set. Not yet called from any ingest flow — will be wired in Sprint 4 (approval pipeline).

---

## Smoke Test

The import requires a running server and valid FM credentials. To test manually:

```bash
# Start server:
node server.js

# Preview (dry run):
curl http://localhost:3000/api/catalog/import/fm/preview \
  -H "Authorization: Bearer $INGEST_ADMIN_SECRET"

# Full import:
curl -X POST http://localhost:3000/api/catalog/import/fm \
  -H "Authorization: Bearer $INGEST_ADMIN_SECRET"

# Verify rows:
sqlite3 madmusic.db "SELECT COUNT(*) FROM tracks; SELECT COUNT(*) FROM artists; SELECT COUNT(*) FROM albums;"
```

Import logic is idempotent — re-running updates existing rows via `fm_source_id`, never duplicates.

---

## Issues Encountered

None — all module imports verified clean.
