/**
 * lib/fm-catalog.js — reads from the existing FM streaming catalog.
 * Reuses the existing fm-client connection pool + auth rather than duplicating it.
 * Uses env: FM_HOST, FM_DB, FM_USER, FM_PASS, FM_LAYOUT
 */
import { fmGet } from '../fm-client.js'
import {
  FM_LAYOUT,
  firstNonEmpty,
  AUDIO_FIELD_CANDIDATES,
  ARTWORK_FIELD_CANDIDATES,
  CATALOGUE_FIELD_CANDIDATES,
  TRACK_SEQUENCE_FIELDS,
  recordIsVisible,
  recordIsFeatured
} from './fm-fields.js'

const PAGE_SIZE = 100

/**
 * Fetch one page of records from the FM catalog layout.
 * offset is 1-based (FM convention).
 */
export async function fetchAllTracks(limit = PAGE_SIZE, offset = 1) {
  const res = await fmGet(`/layouts/${encodeURIComponent(FM_LAYOUT)}/records?_limit=${limit}&_offset=${offset}`)
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`FM fetch failed: ${msg}`)
  }
  const json = await res.json()
  const data = json?.response?.data || []
  const total = json?.response?.dataInfo?.totalRecordCount ?? data.length
  return { data, total }
}

/**
 * Paginate through all FM records, calling onBatch(mappedRecords) per page.
 * Stops when all records have been fetched.
 */
export async function fetchAllTracksIter(onBatch) {
  let offset = 1
  let total = null

  do {
    const { data, total: t } = await fetchAllTracks(PAGE_SIZE, offset)
    if (total === null) total = t
    if (!data.length) break

    const mapped = data.map(mapFmRecord).filter(Boolean)
    if (mapped.length) await onBatch(mapped)

    offset += data.length
  } while (offset <= total)
}

/**
 * Map a raw FM record to a flat object using the field names the existing
 * server reads from the API_Album_Songs layout.
 */
export function mapFmRecord(record) {
  const fields = record.fieldData || {}
  const fmId   = String(record.recordId || '')
  if (!fmId) return null

  const title       = firstNonEmpty(fields, ['Track Name', 'Tape Files::Track Name', 'Song Title', 'Title'])
  const albumArtist = firstNonEmpty(fields, ['Album Artist', 'Tape Files::Album Artist', 'Artist'])
  const trackArtist = firstNonEmpty(fields, ['Track Artist', 'Artist']) || albumArtist
  const album       = firstNonEmpty(fields, ['Album Title', 'Tape Files::Album Title', 'Album'])
  const genre       = firstNonEmpty(fields, ['Local Genre', 'Song Files::Local Genre'])
  const year        = firstNonEmpty(fields, ['Year of Release', 'Year'])
  const language    = firstNonEmpty(fields, ['Language Code', 'Language'])
  const isrc        = firstNonEmpty(fields, ['ISRC', 'Tape Files::ISRC'])
  const catalogue   = firstNonEmpty(fields, CATALOGUE_FIELD_CANDIDATES)
  const mp3Url      = firstNonEmpty(fields, AUDIO_FIELD_CANDIDATES)
  const artworkUrl  = firstNonEmpty(fields, ARTWORK_FIELD_CANDIDATES)

  // Track sequence
  let trackNumber = null
  for (const key of TRACK_SEQUENCE_FIELDS) {
    const raw = fields[key]
    if (raw !== undefined && raw !== null) {
      const n = Number(String(raw).trim())
      if (Number.isFinite(n)) { trackNumber = n; break }
    }
  }

  // Duration — FM may store as seconds (number) or MM:SS string
  let durationSec = null
  const rawDur = fields['Duration'] ?? fields['Track Duration'] ?? fields['Tape Files::Duration']
  if (rawDur !== undefined && rawDur !== null) {
    const str = String(rawDur).trim()
    if (str.includes(':')) {
      const [m, s] = str.split(':').map(Number)
      if (Number.isFinite(m) && Number.isFinite(s)) durationSec = m * 60 + s
    } else {
      const n = Number(str)
      if (Number.isFinite(n) && n > 0) durationSec = n
    }
  }

  const visibility = recordIsVisible(fields) ? 'public' : 'private'
  const featured   = recordIsFeatured(fields)

  return {
    fmId,
    title:       title       || null,
    artist:      trackArtist || null,
    albumArtist: albumArtist || null,
    album:       album       || null,
    genre:       genre       || null,
    year:        year ? parseInt(year, 10) || null : null,
    language:    language    || 'en',
    isrc:        isrc        || null,
    catalogue:   catalogue   || null,
    mp3Url:      mp3Url      || null,
    artworkUrl:  artworkUrl  || null,
    trackNumber,
    durationSec,
    visibility,
    featured
  }
}
