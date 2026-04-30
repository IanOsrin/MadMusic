import { readFile, unlink } from 'fs/promises'
import PQueue from 'p-queue'
import { query } from './db.js'
import { transcodeToMp3, generateWaveform } from './transcode.js'
import { uploadMp3, uploadWaveform, uploadArtwork } from './s3.js'
import { archiveWav } from './fm-archive.js'

// ── Slug / upsert helpers (mirrors routes/ingest-catalog.js) ─────────────────

function toSlug(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown'
}

async function upsertArtist(name) {
  if (!name) return null
  const slug = toSlug(name)
  await query(
    `INSERT INTO artists (name, slug) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`,
    [name, slug]
  )
  const rows = await query(`SELECT id FROM artists WHERE slug = $1`, [slug])
  return rows[0]?.id ?? null
}

async function upsertAlbum(title, artistId) {
  if (!title) return null
  const slug = toSlug(title)
  const existing = await query(`SELECT id FROM albums WHERE slug = $1`, [slug])
  if (existing.length) return existing[0].id
  await query(
    `INSERT INTO albums (title, slug, artist_id) VALUES ($1, $2, $3)`,
    [title, slug, artistId]
  )
  const inserted = await query(`SELECT id FROM albums WHERE slug = $1`, [slug])
  return inserted[0]?.id ?? null
}

// ── Core processing job ───────────────────────────────────────────────────────

async function processTrackJob({ submissionId }) {
  console.log(`[Queue] Processing submission ${submissionId}`)

  const subs = await query(`SELECT * FROM submissions WHERE id = $1`, [submissionId])
  if (!subs.length) throw new Error(`Submission ${submissionId} not found`)
  const sub = subs[0]

  await query(`UPDATE submissions SET status = 'processing' WHERE id = $1`, [submissionId])

  try {
    // Step 1: Create track record (private, approved — goes live after all uploads succeed)
    const artistId = await upsertArtist(sub.artist_name)
    const albumId  = sub.album_title ? await upsertAlbum(sub.album_title, artistId) : null

    const trackRows = await query(
      `INSERT INTO tracks (title, artist_id, album_id, status, visibility, notes)
       VALUES ($1, $2, $3, 'approved', 'private', $4) RETURNING id`,
      [sub.track_title, artistId, albumId, `Submission #${submissionId}`]
    )
    const trackId = trackRows[0].id

    // Step 2: Read WAV
    const wavBuf = await readFile(sub.wav_temp_path)

    // Step 3: Generate waveform
    const waveform = generateWaveform(wavBuf)
    const wfUrl = await uploadWaveform(
      `tracks/${trackId}/waveform.json`,
      Buffer.from(JSON.stringify(waveform))
    )

    // Step 4: MP3 320kbps
    const mp3_320   = await transcodeToMp3(sub.wav_temp_path, 320)
    const mp3320Url = await uploadMp3(`tracks/${trackId}/audio_320.mp3`, mp3_320)

    // Step 5: MP3 128kbps
    const mp3_128   = await transcodeToMp3(sub.wav_temp_path, 128)
    const mp3128Url = await uploadMp3(`tracks/${trackId}/audio_128.mp3`, mp3_128)

    // Step 6: Archive WAV to FileMaker (gracefully skipped if not configured)
    let fmRecordId = null
    try {
      const result = await archiveWav(wavBuf, {
        title:    sub.track_title,
        artist:   sub.artist_name,
        album:    sub.album_title,
        year:     sub.year,
        genre:    sub.genre,
        filename: `${sub.track_title || 'audio'}.wav`
      })
      fmRecordId = result.fmRecordId
    } catch (fmErr) {
      console.warn(`[Queue] FM archive skipped for submission ${submissionId}: ${fmErr.message}`)
    }

    // Step 7: Upload artwork if provided
    let artworkUrl = null
    if (sub.artwork_temp_path) {
      try {
        const artBuf = await readFile(sub.artwork_temp_path)
        artworkUrl = await uploadArtwork(`tracks/${trackId}/artwork.jpg`, artBuf)
      } catch (artErr) {
        console.warn(`[Queue] Artwork upload failed for submission ${submissionId}: ${artErr.message}`)
      }
    }

    // Step 8: Update track to live
    await query(
      `UPDATE tracks SET
         mp3_320_url      = $1,
         mp3_128_url      = $2,
         waveform_url     = $3,
         wav_fm_record_id = $4,
         status           = 'live',
         visibility       = 'public',
         updated_at       = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [mp3320Url, mp3128Url, wfUrl, fmRecordId, trackId]
    )

    if (artworkUrl && albumId) {
      await query(`UPDATE albums SET artwork_url = $1 WHERE id = $2`, [artworkUrl, albumId])
    }

    // Step 9: Update submission
    await query(
      `UPDATE submissions SET status = 'approved', track_id = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [trackId, submissionId]
    )

    // Step 10: Clean up temp files
    await unlink(sub.wav_temp_path).catch(() => {})
    if (sub.artwork_temp_path) await unlink(sub.artwork_temp_path).catch(() => {})

    console.log(`[Queue] Track ${trackId} live — submission ${submissionId} complete`)
  } catch (err) {
    await query(`UPDATE submissions SET status = 'awaiting_review', reviewer_notes = $1 WHERE id = $2`,
      [`Processing failed: ${err.message}`, submissionId])
    throw err
  }
}

// ── Queue setup ───────────────────────────────────────────────────────────────

let _queue

const useInProcess = process.env.USE_IN_PROCESS_QUEUE === 'true' || !process.env.REDIS_URL

if (useInProcess) {
  const pq = new PQueue({ concurrency: 2 })
  _queue = {
    add: (name, data) => { pq.add(() => processTrackJob(data)).catch(err => console.error('[Queue] Job failed:', err.message)); return Promise.resolve() },
    on:  () => {}
  }
  console.log('[Queue] Using in-process queue (p-queue)')
} else {
  const { Queue, Worker } = await import('bullmq')
  const { default: IORedis } = await import('ioredis')
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
  _queue = new Queue('track-processing', { connection })
  new Worker('track-processing', job => processTrackJob(job.data), { connection })
  console.log('[Queue] Using BullMQ (Redis)')
}

export const jobQueue = _queue
