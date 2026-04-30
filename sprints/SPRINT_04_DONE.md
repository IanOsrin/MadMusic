# Sprint 4 — DONE
**Completed:** 2026-04-30

---

## What Was Built

### Files Created / Updated

| File | Status | Notes |
|---|---|---|
| `lib/audio-meta.js` | UPDATED | Full implementation (was empty export in Sprint 1) |
| `routes/ingest.js` | UPDATED | multer config + `/meta-preview`, `/submit`, `/submissions`, `/submissions/:id` |
| `migrations/002_submissions_format_flag.sql` | NEW | Adds `format_flag`, `format_override_reason` columns to submissions |
| `lib/db.js` | UPDATED | Two fixes: RETURNING support on SQLite; `ADD COLUMN IF NOT EXISTS` → `ADD COLUMN` translation |

---

## Temp Upload Path

`./tmp/uploads/` (relative to project root). Controlled by `UPLOAD_TMP_DIR` env var.
Files are NOT deleted after submission — they persist until the processing pipeline consumes them.
The `/meta-preview` endpoint DOES delete its temp file immediately after reading.

---

## music-metadata Version Quirks (v11.12.3)

- API is named exports only: `import { parseBuffer } from 'music-metadata'` — `import * as mm` is not needed
- `common.picture[0]` shape is `{ data: Buffer, format: string }` where `format` is e.g. `'image/jpeg'` (not just `'jpeg'`)
- `common.comment` can be either a string or an array of `{ language, text }` objects depending on tag type — handled with the Array.isArray check

---

## db.js Fixes Made This Sprint

**1. RETURNING clause support on SQLite**
The existing SQLite query dispatcher always called `run()` for INSERT/UPDATE/DELETE, which returns `{ changes, lastInsertRowid }` instead of rows. Added detection for `RETURNING` keyword — those queries now use `all()` which returns rows on both PostgreSQL and SQLite (3.35+).

**2. `ADD COLUMN IF NOT EXISTS` translation**
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is valid PostgreSQL syntax but is NOT supported in SQLite (even at 3.53.0). Added `toSqlite()` rule to strip the `IF NOT EXISTS` clause. Safe because migrations only ever run once, tracked by the `_migrations` table.

---

## Smoke Tests Run

```
# Synthetic WAV buffer test:
Format: wav
Technical: { duration_sec: null, sample_rate: 44100, bit_depth: 16, channels: 2, bitrate_kbps: 1411, codec: 'PCM', container: 'WAVE' }
Warnings: [ 'No ISRC found — please enter manually' ]

# RETURNING id test:
Inserted submission id: 1
Read back: { id: 1, track_title: 'Test Track', status: 'received' }
Submission test OK
```

Live endpoint smoke tests (require running server):
```bash
# Meta preview
curl -X POST http://localhost:3000/api/ingest/meta-preview -F "audio=@test.wav"

# Full submission
curl -X POST http://localhost:3000/api/ingest/submit \
  -F "audio=@test.wav" \
  -F "submitter_name=Test" \
  -F "submitter_email=test@example.com" \
  -F "title=Test Track" \
  -F "artist=Test Artist"

# List submissions (admin)
curl http://localhost:3000/api/ingest/submissions \
  -H "Authorization: Bearer $INGEST_ADMIN_SECRET"
```

---

## FM Field Names

No FM work in this sprint. Field names unchanged from Sprint 2.

---

## Issues Encountered

**SQLite `ADD COLUMN IF NOT EXISTS` not supported** — fixed in `toSqlite()`.
**`RETURNING id` not working on SQLite** — fixed with RETURNING detection in the query dispatcher.
