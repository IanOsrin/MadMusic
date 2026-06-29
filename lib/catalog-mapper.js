// ============================================================================
// lib/catalog-mapper.js — map a FileMaker API_Album_Songs record to a `tracks`
// row, and build the batched upsert. Pure (no I/O) — fully unit-testable.
//
// The normalized columns exist for server-side querying / dedup / flag rails.
// The full FM fieldData is preserved in `raw` so the catalog routes can return
// { recordId, fields: raw } and every existing MADHelpers extractor keeps working
// unchanged. Candidate lists below MUST mirror public/js/helpers.js + lib/fm-fields.js.
// ============================================================================

import {
  firstNonEmptyFast,
  parseTrackSequence,
  recordIsFeatured,
  CATALOGUE_FIELD_CANDIDATES,
  AUDIO_FIELD_CANDIDATES,
  ARTWORK_FIELD_CANDIDATES,
  G100_FIELD_CANDIDATES,
  G100_VALUE_LC,
} from './fm-fields.js';

// Mirror of helpers.js field orders (browser-only module, can't import here).
const TITLE_FIELDS        = ['Track Name', 'Song Name', 'Track Title', 'Song Title', 'Title'];
const TRACK_ARTIST_FIELDS = ['Track Artist', 'Artist', 'Artist Name', 'Album Artist'];   // display
const ALBUM_ARTIST_FIELDS = ['Album Artist', 'Artist', 'Artist Name'];                   // grouping
const ALBUM_FIELDS        = ['Album Title', 'Album', 'Album Name'];
const GENRE_FIELDS        = ['Local Genre', 'Song Files::Local Genre'];
// Confirmed against live API_Album_Songs (2026-06-29): the year lives in
// "Year of Release" (e.g. 1992) with "Original Release date" (1992-02-12) as fallback.
const YEAR_FIELDS         = ['Year of Release', 'Original Release date', 'Year', 'Release Year', 'Date'];
const DURATION_FIELDS     = ['Duration', 'Track Duration', 'Length'];
const VISIBILITY_FIELDS   = ['Visibility', 'Tape Files::Visibility'];

// Flag fields not covered by a fm-fields helper (see docs/FM-MAP.md).
const SINGLE_FIELD_CANDIDATES     = ['Tape Files::Singles', 'Singles'];
const GLOBAL_FAV_FIELD_CANDIDATES = ['Tape Files::Global_Favorites', 'Global_Favorites'];
const FLAG_YES_LC = 'yes';

function flagMatches(fields, candidates, valueLc) {
  const raw = firstNonEmptyFast(fields, candidates);
  return raw ? raw.toLowerCase() === valueLc : false;
}

function toIntOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function yearOrNull(value) {
  const m = String(value || '').match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

// FM Duration is a time field — good rows are "HH:MM:SS". Convert to seconds.
// "N:00:00" corruption and unparseable values → null (mirrors displayDuration).
function durationSecsOrNull(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/^\d+:00:00$/.test(s)) return null;
  const m = s.match(/^(\d+):([0-5]?\d):([0-5]?\d)$/);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * Map one FM record ({ recordId, modId, fieldData }) to a `tracks` row object.
 * Returns null only if the record has no recordId.
 */
export function mapRecordToRow(record) {
  if (!record || record.recordId == null) return null;
  const fields = record.fieldData || {};
  const seq = parseTrackSequence(fields);

  return {
    fm_record_id:   String(record.recordId),
    album_title:    firstNonEmptyFast(fields, ALBUM_FIELDS) || null,
    album_artist:   firstNonEmptyFast(fields, ALBUM_ARTIST_FIELDS) || null,
    track_artist:   firstNonEmptyFast(fields, TRACK_ARTIST_FIELDS) || null,
    track_title:    firstNonEmptyFast(fields, TITLE_FIELDS) || null,
    genre:          firstNonEmptyFast(fields, GENRE_FIELDS) || null,
    release_year:   yearOrNull(firstNonEmptyFast(fields, YEAR_FIELDS)),
    duration_secs:  durationSecsOrNull(firstNonEmptyFast(fields, DURATION_FIELDS)),
    track_seq:      Number.isFinite(seq) ? seq : null,
    catalogue_no:   firstNonEmptyFast(fields, CATALOGUE_FIELD_CANDIDATES) || null,
    s3_audio_url:   firstNonEmptyFast(fields, AUDIO_FIELD_CANDIDATES) || null,
    s3_artwork_url: firstNonEmptyFast(fields, ARTWORK_FIELD_CANDIDATES) || null,
    visibility:     firstNonEmptyFast(fields, VISIBILITY_FIELDS) || null,
    is_featured:    recordIsFeatured(fields),
    is_g100:        flagMatches(fields, G100_FIELD_CANDIDATES, G100_VALUE_LC),
    is_single:      flagMatches(fields, SINGLE_FIELD_CANDIDATES, FLAG_YES_LC),
    is_global_fav:  flagMatches(fields, GLOBAL_FAV_FIELD_CANDIDATES, FLAG_YES_LC),
    fm_mod_id:      toIntOrNull(record.modId),
    fm_modified_at: null, // TODO: set once a FM modification-timestamp field is confirmed
    raw:            fields,
  };
}

// Column order for the upsert — `synced_at` is appended per-row from the run stamp.
export const TRACK_COLUMNS = [
  'fm_record_id', 'album_title', 'album_artist', 'track_artist', 'track_title',
  'genre', 'release_year', 'duration_secs', 'track_seq', 'catalogue_no',
  's3_audio_url', 's3_artwork_url', 'visibility', 'is_featured', 'is_g100',
  'is_single', 'is_global_fav', 'fm_mod_id', 'fm_modified_at', 'raw', 'synced_at',
];

/**
 * Build a single multi-row upsert for `rows`, stamping every row's synced_at with
 * `syncedAt` (so a post-run `DELETE WHERE synced_at < runStart` prunes records no
 * longer in FileMaker). Returns { text, params } or null for an empty batch.
 */
export function buildUpsertQuery(rows, syncedAt) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const cols = TRACK_COLUMNS;
  const params = [];
  const tuples = rows.map((row) => {
    const placeholders = cols.map((col) => {
      let val;
      if (col === 'synced_at') val = syncedAt;
      else if (col === 'raw') val = JSON.stringify(row.raw ?? {});
      else val = row[col] ?? null;
      params.push(val);
      // jsonb needs an explicit cast since we pass it as text.
      return col === 'raw' ? `$${params.length}::jsonb` : `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  const updateSet = cols
    .filter((c) => c !== 'fm_record_id')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');

  const text =
    `INSERT INTO tracks (${cols.join(', ')}) VALUES ${tuples.join(', ')} ` +
    `ON CONFLICT (fm_record_id) DO UPDATE SET ${updateSet}`;

  return { text, params };
}
