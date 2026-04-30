import express, { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { readFile, unlink, writeFile } from 'fs/promises'
import { createReadStream } from 'fs'
import { mkdirSync } from 'fs'
import { query } from '../lib/db.js'
import { adminAuth } from '../lib/admin-auth.js'
import { extractAudioMeta, detectAudioFormat, generateWarnings } from '../lib/audio-meta.js'
import { jobQueue } from '../lib/queue.js'
import { parseDDEXPackage } from '../lib/ddex.js'
import { parseTrackSheet } from '../lib/excel-ingest.js'

const router = Router()

// ── Multer config ─────────────────────────────────────────────────────────────

const UPLOAD_TMP = process.env.UPLOAD_TMP_DIR || './tmp/uploads'
mkdirSync(UPLOAD_TMP, { recursive: true })

const storage = multer.diskStorage({
  destination: UPLOAD_TMP,
  filename: (req, file, cb) => {
    const safeName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    cb(null, safeName)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },  // 2 GB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'audio/wav', 'audio/wave', 'audio/x-wav',
      'audio/mpeg', 'audio/flac', 'audio/aiff', 'audio/x-aiff'
    ]
    const ext = path.extname(file.originalname).toLowerCase()
    const allowedExt = ['.wav', '.mp3', '.flac', '.aif', '.aiff']
    if (allowed.includes(file.mimetype) || allowedExt.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error(`File type not accepted: ${file.mimetype}`))
    }
  }
})

const uploadZip = multer({
  storage,
  limits: { fileSize: 512 * 1024 * 1024 },  // 512 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const mimes = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream']
    if (ext === '.zip' || mimes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error(`Expected ZIP file, got: ${file.mimetype}`))
    }
  }
})

const uploadSheet = multer({
  storage,
  limits: { fileSize: 32 * 1024 * 1024 },  // 32 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error(`Expected xlsx/xls/csv file, got: ${file.mimetype}`))
    }
  }
})

// ── Temp buffer helper ────────────────────────────────────────────────────────

async function saveTempBuffer(buffer, ext = '.wav') {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  const filePath = `${UPLOAD_TMP}/${filename}`
  await writeFile(filePath, buffer)
  return filePath
}

// ── GET /api/ingest/invite-required ──────────────────────────────────────────

router.get('/invite-required', (_req, res) => {
  res.json({ required: !!process.env.INGEST_INVITE_TOKEN })
})

// ── POST /api/ingest/verify-invite ────────────────────────────────────────────

router.post('/verify-invite', express.json(), (req, res) => {
  const { token } = req.body || {}
  const expected  = process.env.INGEST_INVITE_TOKEN
  if (!expected || token === expected) {
    return res.json({ valid: true })
  }
  res.status(403).json({ valid: false, error: 'Invalid invite token' })
})

// ── POST /api/ingest/meta-preview ─────────────────────────────────────────────
// No auth — called immediately on file drop to pre-populate the submission form.

router.post('/meta-preview',
  upload.fields([{ name: 'audio', maxCount: 1 }]),
  async (req, res) => {
    const file = req.files?.audio?.[0]
    if (!file) return res.status(400).json({ error: 'No audio file' })

    try {
      const buffer  = await readFile(file.path)
      const format  = detectAudioFormat(buffer)
      const accepted = ['wav', 'flac'].includes(format)
      const { meta, technical, loudness_lufs, errors } = await extractAudioMeta(buffer, file.mimetype)
      const warnings = generateWarnings(technical, format, meta)

      await unlink(file.path).catch(() => {})

      res.json({ format, accepted, meta, technical, loudness_lufs, warnings, errors })
    } catch (err) {
      await unlink(file.path).catch(() => {})
      res.status(500).json({ error: err.message })
    }
  }
)

// ── POST /api/ingest/submit ───────────────────────────────────────────────────
// Public (or invite-token gated). Saves files to disk, creates submissions row.

router.post('/submit',
  upload.fields([
    { name: 'audio',   maxCount: 1 },
    { name: 'artwork', maxCount: 1 }
  ]),
  async (req, res) => {
    const audioFile   = req.files?.audio?.[0]
    const artworkFile = req.files?.artwork?.[0]

    if (!audioFile) return res.status(400).json({ error: 'Audio file required' })

    try {
      const buffer   = await readFile(audioFile.path)
      const format   = detectAudioFormat(buffer)
      const { meta: fileMeta, technical } = await extractAudioMeta(buffer, audioFile.mimetype)

      const body    = req.body
      const title   = body.title  || fileMeta.title  || 'Untitled'
      const artist  = body.artist || fileMeta.artist || 'Unknown Artist'

      // Non-standard format flag — reviewer must explicitly override before approval
      const formatFlag = !['wav', 'flac'].includes(format) ? format : null

      const techNote = technical.sample_rate
        ? `\n[Technical: ${technical.sample_rate}Hz ${technical.bit_depth ?? '?'}bit ${technical.channels ?? '?'}ch ${technical.duration_sec ?? '?'}s]`
        : ''

      const rows = await query(
        `INSERT INTO submissions
           (submitter_name, submitter_email, org,
            track_title, artist_name, album_title,
            year, genre, notes,
            wav_temp_path, artwork_temp_path,
            status, format_flag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          body.submitter_name  || 'Unknown',
          body.submitter_email || '',
          body.org             || null,
          title,
          artist,
          body.album           || null,
          body.year            ? parseInt(body.year, 10) : (fileMeta.year || null),
          body.genre           || fileMeta.genre || null,
          (body.notes          || '') + techNote,
          audioFile.path,
          artworkFile?.path    || null,
          'received',
          formatFlag
        ]
      )

      const submissionId = rows[0]?.id
      res.json({ submissionId, format, formatFlag })
    } catch (err) {
      // Clean up on error — don't leave orphan temp files
      await unlink(audioFile.path).catch(() => {})
      if (artworkFile) await unlink(artworkFile.path).catch(() => {})
      console.error('[ingest] Submit error:', err)
      res.status(500).json({ error: err.message })
    }
  }
)

// ── GET /api/ingest/submissions ───────────────────────────────────────────────

router.get('/submissions', adminAuth, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query
    const params = []
    let where = ''

    if (status) {
      params.push(status)
      where = `WHERE status = $${params.length}`
    }

    params.push(parseInt(limit, 10) || 50)
    params.push(parseInt(offset, 10) || 0)

    const rows = await query(
      `SELECT id, submitter_name, submitter_email, track_title, artist_name,
              album_title, genre, status, format_flag, received_at
       FROM submissions
       ${where}
       ORDER BY received_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    res.json({ ok: true, submissions: rows, count: rows.length })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── GET /api/ingest/submissions/:id ──────────────────────────────────────────

router.get('/submissions/:id', adminAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM submissions WHERE id = $1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' })
    res.json({ ok: true, submission: rows[0] })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── GET /api/ingest/submissions/:id/audio-preview ────────────────────────────
// Accepts admin token as Bearer header OR ?token= query param so <audio> elements work.

router.get('/submissions/:id/audio-preview', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '').trim() || req.query.token
  if (!token || token !== process.env.INGEST_ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const rows = await query(`SELECT wav_temp_path FROM submissions WHERE id = $1`, [req.params.id])
    if (!rows.length || !rows[0].wav_temp_path) {
      return res.status(404).json({ error: 'File not found' })
    }
    const filePath = rows[0].wav_temp_path
    // Determine content type from extension
    const ext = path.extname(filePath).toLowerCase()
    const mimeMap = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.aiff': 'audio/aiff', '.aif': 'audio/aiff' }
    res.setHeader('Content-Type', mimeMap[ext] || 'audio/wav')
    res.setHeader('Accept-Ranges', 'bytes')
    createReadStream(filePath).pipe(res)
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

// ── PATCH /api/ingest/submissions/:id/approve ─────────────────────────────────

router.patch('/submissions/:id/approve', adminAuth, async (req, res) => {
  try {
    const subs = await query(`SELECT * FROM submissions WHERE id = $1`, [req.params.id])
    if (!subs.length) return res.status(404).json({ error: 'Submission not found' })
    const sub = subs[0]

    if (sub.status === 'approved' || sub.status === 'processing') {
      return res.status(409).json({ error: `Submission already in state: ${sub.status}` })
    }

    // Non-standard format requires explicit override reason
    if (sub.format_flag && !req.body?.format_override_reason) {
      return res.status(400).json({
        error: 'Non-standard format requires format_override_reason in request body',
        format_flag: sub.format_flag
      })
    }

    if (req.body?.format_override_reason) {
      await query(
        `UPDATE submissions SET format_override_reason = $1 WHERE id = $2`,
        [req.body.format_override_reason, req.params.id]
      )
    }

    await jobQueue.add('processTrack', { submissionId: parseInt(req.params.id, 10) })
    res.json({ queued: true, submissionId: req.params.id })
  } catch (err) {
    console.error('[ingest] Approve error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── PATCH /api/ingest/submissions/:id/reject ──────────────────────────────────

router.patch('/submissions/:id/reject', adminAuth, async (req, res) => {
  try {
    await query(
      `UPDATE submissions SET status = 'rejected', reviewer_notes = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [req.body?.notes || null, req.params.id]
    )
    res.json({ rejected: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/ingest/ddex/preview ─────────────────────────────────────────────
// Parse DDEX ZIP, return track list — no DB writes.

router.post('/ddex/preview', adminAuth, uploadZip.single('package'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No ZIP file uploaded (field name: package)' })
  try {
    const buf = await readFile(req.file.path)
    await unlink(req.file.path).catch(() => {})
    const { version, tracks } = await parseDDEXPackage(buf)
    res.json({
      ok: true,
      version,
      count: tracks.length,
      tracks: tracks.map(t => ({
        ref:          t._ref,
        title:        t.track_title,
        version_title:t.version_title,
        artist:       t.artist_name,
        album:        t.album_title,
        isrc:         t.isrc,
        duration_sec: t.duration_sec,
        genre:        t.genre,
        year:         t.year,
        explicit:     t.explicit,
        has_audio:    !!t.wav_buffer,
        has_artwork:  !!t.artwork_buffer,
      }))
    })
  } catch (err) {
    await unlink(req.file?.path).catch(() => {})
    console.error('[ingest] DDEX preview error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── POST /api/ingest/ddex ─────────────────────────────────────────────────────
// Parse DDEX ZIP and create submission records.

router.post('/ddex', adminAuth, uploadZip.single('package'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No ZIP file uploaded (field name: package)' })

  const submissionIds = []
  const errors = []

  try {
    const buf = await readFile(req.file.path)
    await unlink(req.file.path).catch(() => {})
    const { version, tracks } = await parseDDEXPackage(buf)

    for (const track of tracks) {
      try {
        const wavPath     = track.wav_buffer     ? await saveTempBuffer(track.wav_buffer, '.wav')  : null
        const artworkPath = track.artwork_buffer  ? await saveTempBuffer(track.artwork_buffer, '.jpg') : null

        const notes = JSON.stringify({
          isrc:        track.isrc,
          iswc:        track.iswc,
          subgenre:    track.subgenre,
          language:    track.language,
          duration_sec:track.duration_sec,
          explicit:    track.explicit,
          territories: track.territories,
          rights_holder: track.rights_holder,
          rights_year:   track.rights_year,
          credits:     track.credits,
          ddex_version: version,
        })

        const rows = await query(
          `INSERT INTO submissions
             (submitter_name, submitter_email, org,
              track_title, artist_name, album_title,
              year, genre, notes,
              wav_temp_path, artwork_temp_path,
              status, format_flag, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING id`,
          [
            track.submitter_name, track.submitter_email, null,
            track.track_title || 'Untitled', track.artist_name || 'Unknown',
            track.album_title || null,
            track.year || null, track.genre || null, notes,
            wavPath, artworkPath,
            'received', null, 'ddex'
          ]
        )
        submissionIds.push(rows[0]?.id)
      } catch (e) {
        console.error('[ingest] DDEX track insert error:', e.message)
        errors.push({ title: track.track_title, error: e.message })
      }
    }

    res.json({ ok: true, version, count: tracks.length, submissionIds, errors })
  } catch (err) {
    await unlink(req.file?.path).catch(() => {})
    console.error('[ingest] DDEX import error:', err)
    res.status(500).json({ ok: false, error: err.message, submissionIds, errors })
  }
})

// ── POST /api/ingest/excel ────────────────────────────────────────────────────
// Parse Excel/CSV, return preview with validation — no DB writes.

router.post('/excel', adminAuth, uploadSheet.single('sheet'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No spreadsheet uploaded (field name: sheet)' })
  try {
    const buf = await readFile(req.file.path)
    await unlink(req.file.path).catch(() => {})
    const result = parseTrackSheet(buf)
    res.json({ ok: true, ...result })
  } catch (err) {
    await unlink(req.file?.path).catch(() => {})
    console.error('[ingest] Excel parse error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── POST /api/ingest/excel/confirm ────────────────────────────────────────────
// Create submission records from pre-parsed + confirmed Excel rows.

router.post('/excel/confirm', adminAuth, express.json(), async (req, res) => {
  const rows = req.body?.rows
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows array required' })
  }

  const submissionIds = []
  const errors = []

  for (const row of rows) {
    if (!row.title || !row.artist_name) {
      errors.push({ row: row._row, error: 'Missing required fields (title, artist)' })
      continue
    }
    try {
      const notes = [
        row.notes || null,
        row.featuring   ? `Feat: ${row.featuring}`   : null,
        row.composer    ? `Composer: ${row.composer}` : null,
        row.lyricist    ? `Lyricist: ${row.lyricist}` : null,
        row.producer    ? `Producer: ${row.producer}` : null,
        row.publisher   ? `Publisher: ${row.publisher}` : null,
        row.album_upc   ? `UPC: ${row.album_upc}`    : null,
        row.pro_name    ? `PRO: ${row.pro_name}`      : null,
        row.pro_ipi     ? `IPI: ${row.pro_ipi}`       : null,
      ].filter(Boolean).join('\n') || null

      const dbRows = await query(
        `INSERT INTO submissions
           (submitter_name, submitter_email, org,
            track_title, artist_name, album_title,
            year, genre, notes,
            wav_temp_path, artwork_temp_path,
            status, format_flag, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          'Excel Import', row.submitter_email || 'excel@internal', row.label_name || null,
          row.title, row.artist_name, row.album_title || null,
          row.year || null, row.genre || null, notes,
          null, null,
          'received', null, 'excel'
        ]
      )
      submissionIds.push(dbRows[0]?.id)
    } catch (e) {
      console.error('[ingest] Excel confirm error:', e.message)
      errors.push({ row: row._row, title: row.title, error: e.message })
    }
  }

  res.json({ ok: true, created: submissionIds.length, submissionIds, errors })
})

// ── POST /api/ingest/submissions/:id/audio ────────────────────────────────────
// Attach an audio file to an existing (metadata-only) submission.

router.post('/submissions/:id/audio',
  adminAuth,
  upload.fields([{ name: 'audio', maxCount: 1 }]),
  async (req, res) => {
    const audioFile = req.files?.audio?.[0]
    if (!audioFile) return res.status(400).json({ error: 'Audio file required (field name: audio)' })

    try {
      const subs = await query(`SELECT id, status FROM submissions WHERE id = $1`, [req.params.id])
      if (!subs.length) {
        await unlink(audioFile.path).catch(() => {})
        return res.status(404).json({ error: 'Submission not found' })
      }

      const buffer   = await readFile(audioFile.path)
      const format   = detectAudioFormat(buffer)
      const formatFlag = !['wav', 'flac'].includes(format) ? format : null

      await query(
        `UPDATE submissions SET wav_temp_path = $1, format_flag = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [audioFile.path, formatFlag, req.params.id]
      ).catch(() =>
        // updated_at may not exist in older schema — fall back
        query(`UPDATE submissions SET wav_temp_path = $1, format_flag = $2 WHERE id = $3`,
          [audioFile.path, formatFlag, req.params.id])
      )

      res.json({ ok: true, format, formatFlag, submissionId: parseInt(req.params.id, 10) })
    } catch (err) {
      await unlink(audioFile.path).catch(() => {})
      console.error('[ingest] Audio attach error:', err)
      res.status(500).json({ error: err.message })
    }
  }
)

export default router
