import * as XLSX from 'xlsx'

const COLUMN_MAP = {
  // title
  'title': 'title', 'track title': 'title', 'track name': 'title',
  'song title': 'title', 'song': 'title',
  // version_title
  'version': 'version_title', 'mix': 'version_title', 'edit': 'version_title',
  'version title': 'version_title',
  // artist_name
  'artist': 'artist_name', 'artist name': 'artist_name',
  'performer': 'artist_name', 'main artist': 'artist_name',
  // featuring
  'featuring': 'featuring', 'feat': 'featuring',
  'featured artist': 'featuring', 'ft': 'featuring',
  // credits
  'composer': 'composer', 'writer': 'composer', 'songwriter': 'composer',
  'lyricist': 'lyricist', 'lyric writer': 'lyricist',
  'producer': 'producer',
  // album
  'album': 'album_title', 'album title': 'album_title', 'release title': 'album_title',
  // ids
  'upc': 'album_upc', 'barcode': 'album_upc', 'ean': 'album_upc',
  'cat no': 'catalogue', 'catalogue': 'catalogue',
  'catalogue number': 'catalogue', 'cat#': 'catalogue',
  'isrc': 'isrc', 'iswc': 'iswc',
  // label / publisher
  'label': 'label_name', 'record label': 'label_name',
  'publisher': 'publisher', 'music publisher': 'publisher',
  // track metadata
  'track': 'track_number', 'track no': 'track_number',
  'track number': 'track_number', '#': 'track_number',
  'disc': 'disc_number', 'disc no': 'disc_number', 'cd': 'disc_number',
  'year': 'year', 'release year': 'year', 'date': 'year',
  'genre': 'genre',
  'subgenre': 'subgenre', 'sub-genre': 'subgenre', 'style': 'subgenre',
  'bpm': 'bpm', 'tempo': 'bpm',
  'key': 'key_sig', 'key sig': 'key_sig', 'musical key': 'key_sig',
  'mood': 'mood',
  'language': 'language',
  'explicit': 'explicit', 'parental advisory': 'explicit',
  'duration': 'duration_sec',
  // rights
  'territory': 'territories', 'territories': 'territories',
  'rights territory': 'territories',
  'sync': 'sync_licensed', 'sync licensed': 'sync_licensed',
  'sync cleared': 'sync_licensed',
  'rights holder': 'rights_holder', 'master rights': 'rights_holder',
  'p line': 'rights_holder',
  'rights year': 'rights_year', 'copyright year': 'rights_year',
  '℗ year': 'rights_year',
  // PRO
  'pro': 'pro_name', 'pro name': 'pro_name', 'collecting society': 'pro_name',
  'ipi': 'pro_ipi', 'ipi number': 'pro_ipi',
  // submission
  'email': 'submitter_email', 'contact email': 'submitter_email',
  'notes': 'notes', 'comments': 'notes',
}

const BOOLEAN_FIELDS  = new Set(['explicit', 'sync_licensed'])
const INTEGER_FIELDS  = new Set(['track_number', 'disc_number', 'bpm', 'year', 'rights_year'])

export function parseTrackSheet(buffer) {
  const wb   = XLSX.read(buffer, { type: 'buffer', raw: false })
  const ws   = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null })

  const errors   = []
  const warnings = []
  const parsed   = []

  rows.forEach((row, i) => {
    const rowNum = i + 2  // 1-indexed + header
    const mapped = {}
    const unmapped = []

    Object.entries(row).forEach(([col, val]) => {
      const key = COLUMN_MAP[col.toLowerCase().trim()]
      if (key) {
        mapped[key] = val
      } else {
        unmapped.push(col)
      }
    })

    // Required fields
    if (!mapped.title)       errors.push(`Row ${rowNum}: missing Track Title`)
    if (!mapped.artist_name) errors.push(`Row ${rowNum}: missing Artist`)

    // Parse duration: '3:45' or '3:45.0' → 225, or raw number passthrough
    if (mapped.duration_sec != null) {
      const v = String(mapped.duration_sec).trim()
      if (v.includes(':')) {
        const parts = v.split(':').map(Number)
        mapped.duration_sec = parts.length === 3
          ? parts[0] * 3600 + parts[1] * 60 + parts[2]
          : parts[0] * 60 + parts[1]
      } else {
        mapped.duration_sec = parseFloat(v) || null
      }
    }

    // Normalize year: might be "2024-01-15" or a Date serial
    if (mapped.year != null) {
      const s = String(mapped.year)
      const m = s.match(/(\d{4})/)
      mapped.year = m ? parseInt(m[1], 10) : null
    }

    // Normalize track_number: "4/12" → 4
    if (mapped.track_number != null) {
      const s = String(mapped.track_number).split('/')[0]
      mapped.track_number = parseInt(s, 10) || null
    }

    // Integer fields
    INTEGER_FIELDS.forEach(f => {
      if (mapped[f] != null && f !== 'track_number' && f !== 'year') {
        mapped[f] = parseInt(String(mapped[f]), 10) || null
      }
    })

    // Boolean fields
    BOOLEAN_FIELDS.forEach(f => {
      if (mapped[f] !== undefined && mapped[f] !== null) {
        const v = String(mapped[f]).toLowerCase().trim()
        mapped[f] = ['yes', 'true', '1', 'e', 'explicit', 'cleared', 'sync'].includes(v)
      }
    })

    if (unmapped.length) {
      warnings.push(`Row ${rowNum}: unrecognised columns: ${unmapped.join(', ')}`)
    }

    parsed.push({ _row: rowNum, ...mapped })
  })

  return { rows: parsed, errors, warnings }
}
