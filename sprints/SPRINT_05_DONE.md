# Sprint 5 — DONE
**Completed:** 2026-04-30

---

## What Was Built

### Files Created / Updated

| File | Status | Notes |
|---|---|---|
| `lib/transcode.js` | UPDATED | `transcodeToMp3()` + `generateWaveform()` |
| `lib/s3.js` | UPDATED | `uploadToS3()` + `uploadMp3/uploadWaveform/uploadArtwork` convenience wrappers |
| `lib/queue.js` | UPDATED | Full pipeline worker + p-queue / BullMQ dual-mode |
| `routes/ingest.js` | UPDATED | `PATCH /submissions/:id/approve` + `PATCH /submissions/:id/reject` |
| `lib/db.js` | UPDATED | Generalized `now()` → `CURRENT_TIMESTAMP` translation (covers UPDATE SET clauses, not just DEFAULT) |

---

## fm-archive.js Status

**Fully implemented** (since Sprint 2). The queue worker calls `archiveWav()` but wraps it in a try/catch — if `FM_ARCHIVE_HOST` is not set, it logs a warning and continues without blocking the rest of the pipeline. The track goes live even if FM archive is unavailable.

---

## S3 Bucket and Key Structure

```
tracks/{trackId}/audio_320.mp3   — MP3 320kbps delivery
tracks/{trackId}/audio_128.mp3   — MP3 128kbps streaming
tracks/{trackId}/waveform.json   — { peaks: number[1000] }
tracks/{trackId}/artwork.jpg     — album artwork (if provided)
```

S3 credentials from: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_BASE_URL`.

---

## ffmpeg Version

```
ffmpeg version 8.0.1 (Apple clang 17.0.0)
/opt/homebrew/bin/ffmpeg
```

ffmpeg must be installed on the production server. The pipeline will fail loudly at the transcode step if it's not present — no silent fallback.

---

## Design Decisions

**Queue dual-mode (p-queue / BullMQ)**
`USE_IN_PROCESS_QUEUE=true` (default in `.env.example`) uses p-queue with `concurrency: 2`. No Redis required in dev. Setting `REDIS_URL` without `USE_IN_PROCESS_QUEUE=true` switches to BullMQ automatically. BullMQ uses ioredis with `maxRetriesPerRequest: null` (required by BullMQ v5+).

**Processing failure rolls back to `awaiting_review`**
If any step after track creation throws, the submission is reset to `awaiting_review` with the error in `reviewer_notes`. The track record may exist in `approved`/`private` state — admin can retry by re-approving.

**`now()` translation generalized in db.js**
Previous `DEFAULT now()` rule was too narrow — `reviewed_at = now()` and `updated_at = now()` in UPDATE statements also need SQLite translation. Replaced with a broad `\bnow\(\)/gi → CURRENT_TIMESTAMP` rule. Removed the redundant specific rule.

**WAV waveform supports 8/16/24/32-bit PCM and 32-bit float**
Parses RIFF chunks properly (word-aligned, finds fmt and data chunks in any order). Mixes multichannel to mono. Downsamples to 1000 RMS points, normalized to 0..1.

---

## Transcoding Issues

None found. Verified:
- `generateWaveform()` on a 1s 44100Hz 16-bit stereo sine wave → 1000 peaks, max = 1.0 ✓
- All module imports resolve cleanly ✓
- In-process queue picks up correctly when `USE_IN_PROCESS_QUEUE=true` ✓

End-to-end pipeline (submit → approve → S3 upload) requires S3 credentials and a running server.

---

## Smoke Test (requires running server + S3 creds)

```bash
# Submit
curl -X POST http://localhost:3000/api/ingest/submit \
  -F "audio=@test.wav" \
  -F "submitter_name=Test" -F "submitter_email=t@t.com" \
  -F "title=Test Track" -F "artist=Test Artist"
# → { submissionId: 1, format: 'wav', formatFlag: null }

# Approve (triggers pipeline in background)
curl -X PATCH http://localhost:3000/api/ingest/submissions/1/approve \
  -H "Authorization: Bearer $INGEST_ADMIN_SECRET" \
  -H "Content-Type: application/json" -d '{}'
# → { queued: true, submissionId: "1" }

# Check result
sqlite3 madmusic.db "SELECT id, status, mp3_320_url FROM tracks WHERE id=1;"
```
