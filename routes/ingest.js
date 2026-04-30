import express, { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { readFile, unlink } from 'fs/promises'
import { createReadStream } from 'fs'
import { mkdirSync } from 'fs'
import { query } from '../lib/db.js'
import { adminAuth } from '../lib/admin-auth.js'
import { extractAudioMeta, detectAudioFormat, generateWarnings } from '../lib/audio-meta.js'
import { jobQueue } from '../lib/queue.js'

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

export default router
