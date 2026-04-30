import { Router } from 'express'
import { fetchAllTracksIter, fetchAllTracks, mapFmRecord } from '../lib/fm-catalog.js'
import { query } from '../lib/db.js'
import { adminAuth } from '../lib/admin-auth.js'

const router = Router()

// ── Slug helper ───────────────────────────────────────────────────────────────
function toSlug(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown'
}

// Ensure slug is unique by appending a counter if needed
async function uniqueSlug(table, base) {
  let slug = base
  let n = 2
  while (true) {
    const rows = await query(`SELECT id FROM ${table} WHERE slug = $1`, [slug])
    if (!rows.length) return slug
    slug = `${base}-${n++}`
  }
}

// ── Upsert helpers ────────────────────────────────────────────────────────────

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

async function upsertAlbum(title, artistId, year, catalogue) {
  if (!title) return null
  const slug = toSlug(title)

  // Check if album with this slug already exists (possibly for a different artist)
  const existing = await query(
    `SELECT id FROM albums WHERE slug = $1`,
    [slug]
  )
  if (existing.length) return existing[0].id

  // Build a unique slug if this exact slug is taken by another album
  const finalSlug = await uniqueSlug('albums', slug)
  await query(
    `INSERT INTO albums (title, slug, artist_id, year, catalogue)
     VALUES ($1, $2, $3, $4, $5)`,
    [title, finalSlug, artistId, year || null, catalogue || null]
  )
  const inserted = await query(`SELECT id FROM albums WHERE slug = $1`, [finalSlug])
  return inserted[0]?.id ?? null
}

async function upsertTrack(rec, artistId, albumId) {
  if (!rec.title) return { created: false }

  const existing = await query(
    `SELECT id FROM tracks WHERE fm_source_id = $1`,
    [rec.fmId]
  )

  if (existing.length) {
    await query(
      `UPDATE tracks SET
         title        = $1,
         artist_id    = $2,
         album_id     = $3,
         genre        = $4,
         year         = $5,
         language     = $6,
         isrc         = $7,
         mp3_320_url  = $8,
         visibility   = $9,
         featured     = $10,
         track_number = $11,
         duration_sec = $12,
         updated_at   = CURRENT_TIMESTAMP
       WHERE fm_source_id = $13`,
      [
        rec.title, artistId, albumId, rec.genre || null,
        rec.year || null, rec.language || 'en', rec.isrc || null,
        rec.mp3Url || null, rec.visibility, rec.featured ? 1 : 0,
        rec.trackNumber || null, rec.durationSec || null, rec.fmId
      ]
    )
    return { created: false }
  }

  await query(
    `INSERT INTO tracks
       (title, artist_id, album_id, genre, year, language, isrc,
        mp3_320_url, visibility, featured, track_number, duration_sec,
        fm_source_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'live')`,
    [
      rec.title, artistId, albumId, rec.genre || null,
      rec.year || null, rec.language || 'en', rec.isrc || null,
      rec.mp3Url || null, rec.visibility, rec.featured ? 1 : 0,
      rec.trackNumber || null, rec.durationSec || null, rec.fmId
    ]
  )
  return { created: true }
}

// ── GET /api/catalog/tracks ───────────────────────────────────────────────────

router.get('/tracks', adminAuth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit,  10) || 50, 200)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0,  0)
    const status = req.query.status || null

    const filterParams = status ? [status] : []
    const whereClause  = status ? `WHERE t.status = $1` : ''
    const limitIdx     = filterParams.length + 1
    const offsetIdx    = filterParams.length + 2

    const rows = await query(
      `SELECT t.id, t.title, t.version_title, t.status, t.visibility,
              t.isrc, t.genre, t.bpm, t.featured, t.track_number, t.duration_sec,
              t.mp3_320_url, t.mp3_128_url, t.waveform_url, t.fm_source_id,
              t.created_at, t.updated_at,
              ar.name  AS artist_name,
              al.title AS album_title
       FROM tracks t
       LEFT JOIN artists ar ON t.artist_id = ar.id
       LEFT JOIN albums  al ON t.album_id  = al.id
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...filterParams, limit, offset]
    )

    const countRows = await query(
      `SELECT COUNT(*) AS n FROM tracks t ${whereClause}`,
      filterParams
    )
    const total = parseInt(countRows[0]?.n ?? countRows[0]?.['COUNT(*)'] ?? 0, 10)

    res.json({ ok: true, tracks: rows, total, limit, offset })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── GET /api/catalog/tracks/:id ───────────────────────────────────────────────

router.get('/tracks/:id', adminAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT t.*, ar.name AS artist_name, al.title AS album_title
       FROM tracks t
       LEFT JOIN artists ar ON t.artist_id = ar.id
       LEFT JOIN albums  al ON t.album_id  = al.id
       WHERE t.id = $1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Track not found' })
    res.json({ ok: true, track: rows[0] })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── PATCH /api/catalog/tracks/:id ────────────────────────────────────────────

const EDITABLE_TRACK_FIELDS = new Set([
  'title', 'version_title', 'genre', 'subgenre', 'mood', 'bpm', 'key_sig',
  'year', 'language', 'isrc', 'status', 'visibility', 'featured', 'notes',
  'rights_holder', 'rights_year', 'sync_licensed', 'sync_notes',
  'territories', 'track_number', 'disc_number'
])

router.patch('/tracks/:id', adminAuth, async (req, res) => {
  try {
    const updates = Object.entries(req.body || {})
      .filter(([k]) => EDITABLE_TRACK_FIELDS.has(k))
    if (!updates.length) return res.status(400).json({ ok: false, error: 'No editable fields provided' })

    const setClauses = updates.map(([k], i) => `${k} = $${i + 1}`).join(', ')
    const values     = [...updates.map(([, v]) => v), req.params.id]

    await query(
      `UPDATE tracks SET ${setClauses}, updated_at = CURRENT_TIMESTAMP WHERE id = $${updates.length + 1}`,
      values
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── Preview (dry run) ─────────────────────────────────────────────────────────

router.get('/import/fm/preview', adminAuth, async (req, res) => {
  try {
    const { data } = await fetchAllTracks(50, 1)
    const mapped = data.map(mapFmRecord).filter(Boolean)

    const preview = await Promise.all(mapped.map(async rec => {
      const existingTrack = rec.fmId
        ? await query(`SELECT id FROM tracks WHERE fm_source_id = $1`, [rec.fmId])
        : []
      return {
        fmId:        rec.fmId,
        title:       rec.title,
        artist:      rec.artist,
        album:       rec.album,
        genre:       rec.genre,
        year:        rec.year,
        isrc:        rec.isrc,
        visibility:  rec.visibility,
        action:      existingTrack.length ? 'update' : 'create'
      }
    }))

    const toCreate = preview.filter(r => r.action === 'create').length
    const toUpdate = preview.filter(r => r.action === 'update').length
    res.json({ ok: true, sample: preview, toCreate, toUpdate, note: 'First 50 records only — run POST /import/fm for full import' })
  } catch (err) {
    console.error('[catalog] FM preview error:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── Full import ───────────────────────────────────────────────────────────────

router.post('/import/fm', adminAuth, async (req, res) => {
  const stats = { created: 0, updated: 0, errors: [], artistsCreated: 0, albumsCreated: 0 }

  try {
    await fetchAllTracksIter(async (records) => {
      for (const rec of records) {
        try {
          const artistName = rec.albumArtist || rec.artist
          const artistId   = await upsertArtist(artistName)

          // Track-level artist (if different from album artist)
          let trackArtistId = artistId
          if (rec.artist && rec.artist !== artistName) {
            trackArtistId = await upsertArtist(rec.artist)
          }

          const albumId = await upsertAlbum(rec.album, artistId, rec.year, rec.catalogue)

          const result = await upsertTrack({ ...rec, artist: rec.artist }, trackArtistId, albumId)
          if (result.created) stats.created++
          else stats.updated++
        } catch (e) {
          console.error(`[catalog] Import error for FM record ${rec.fmId}:`, e.message)
          stats.errors.push({ fmId: rec.fmId, title: rec.title, error: e.message })
        }
      }
    })

    res.json({ ok: true, ...stats })
  } catch (err) {
    console.error('[catalog] FM import fatal:', err)
    res.status(500).json({ ok: false, error: err.message, ...stats })
  }
})

export default router
