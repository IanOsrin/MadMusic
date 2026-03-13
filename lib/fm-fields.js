/**
 * lib/fm-fields.js — FileMaker layout / field constants and field-lookup utilities.
 * No dependencies on other app modules.
 */

// ── FM layout / field constants ─────────────────────────────────────────────
export const FM_LAYOUT               = process.env.FM_LAYOUT               || 'API_Album_Songs';
export const FM_STREAM_EVENTS_LAYOUT = process.env.FM_STREAM_EVENTS_LAYOUT || 'Stream_Events';
export const FM_FEATURED_FIELD       = (process.env.FM_FEATURED_FIELD       || 'Tape Files::featured').trim();
export const FM_FEATURED_VALUE       = (process.env.FM_FEATURED_VALUE       || 'yes').trim();
export const FM_FEATURED_VALUE_LC    = FM_FEATURED_VALUE.toLowerCase();
export const FM_VISIBILITY_FIELD     = (process.env.FM_VISIBILITY_FIELD     || '').trim();
export const FM_VISIBILITY_VALUE     = (process.env.FM_VISIBILITY_VALUE     || 'show').trim();
export const FM_VISIBILITY_VALUE_LC  = FM_VISIBILITY_VALUE.toLowerCase();
export const FM_HOST                 = process.env.FM_HOST                  || '';

// ── Field candidate lists ────────────────────────────────────────────────────
export const TRACK_SEQUENCE_FIELDS = [
  'Track Number', 'TrackNumber', 'Track_Number', 'Track No', 'Track No.', 'Track_No',
  'Track #', 'Track#', 'Track Sequence', 'Track Sequence Number', 'Track Seq', 'Track Seq No',
  'Track Order', 'Track Position', 'TrackPosition', 'Sequence', 'Seq', 'Sequence Number',
  'Sequence_Number', 'Song Number', 'Song No', 'Song Seq', 'Song Order',
  'Tape Files::Track Number', 'Tape Files::Track_No'
];
export const PUBLIC_PLAYLIST_FIELDS   = ['PublicPlaylist'];
export const AUDIO_FIELD_CANDIDATES   = ['S3_URL', 'Tape Files::S3_URL', 'mp3', 'MP3', 'Tape Files::mp3', 'Tape Files::MP3', 'Audio File', 'Audio::mp3', 'Stream URL', 'Audio URL'];
export const ARTWORK_FIELD_CANDIDATES = [
  'Artwork_S3_URL', 'Tape Files::Artwork_S3_URL', 'Artwork::Picture', 'Artwork Picture',
  'Picture', 'CoverArtURL', 'AlbumCover', 'Cover Art', 'CoverArt'
];
export const CATALOGUE_FIELD_CANDIDATES = [
  'Album Catalogue Number', 'Reference Catalogue Number', 'Tape Files::Reference Catalogue Number'
];

const FEATURED_FIELD_BASE = FM_FEATURED_FIELD.replace(/^tape files::/i, '').trim();
export const FEATURED_FIELD_CANDIDATES = Array.from(
  new Set([
    FM_FEATURED_FIELD,
    FEATURED_FIELD_BASE && `Tape Files::${FEATURED_FIELD_BASE}`,
    FEATURED_FIELD_BASE,
    'Tape Files::featured', 'Tape Files::Featured', 'featured', 'Featured'
  ].filter(Boolean))
);

// ── Internal regex ───────────────────────────────────────────────────────────
const REGEX_EXTRACT_NUMBERS      = /[^0-9.-]/g;
const REGEX_TRACK_SONG           = /(track|song)/;
const REGEX_NUMBER_INDICATORS    = /(no|num|#|seq|order|pos)/;
const REGEX_NORMALIZE_FIELD      = /[^a-z0-9]/gi;

// ── Field utilities ──────────────────────────────────────────────────────────

export const normalizeFieldKey = (name) =>
  (typeof name === 'string' ? name.replace(REGEX_NORMALIZE_FIELD, '').toLowerCase() : '');

export function pickFieldValueCaseInsensitive(fields = {}, candidates = []) {
  const entries = Object.entries(fields);
  for (const candidate of candidates) {
    for (const [key, raw] of entries) {
      if (key === candidate && raw !== undefined && raw !== null) {
        const str = typeof raw === 'string' ? raw.trim() : String(raw).trim();
        if (str) return { value: str, field: key };
      }
    }
    const needle = normalizeFieldKey(candidate);
    if (!needle) continue;
    for (const [key, raw] of entries) {
      if (key === candidate) continue;
      if (raw === undefined || raw === null) continue;
      if (normalizeFieldKey(key) !== needle) continue;
      const str = typeof raw === 'string' ? raw.trim() : String(raw).trim();
      if (str) return { value: str, field: key };
    }
  }
  return { value: '', field: '' };
}

const fieldMapCache = new WeakMap();

export function getFieldMap(fields) {
  if (fieldMapCache.has(fields)) return fieldMapCache.get(fields);
  const map = new Map();
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const str = typeof value === 'string' ? value.trim() : String(value).trim();
    if (str && !map.has(key)) map.set(key, str);
    const normalized = normalizeFieldKey(key);
    if (normalized && str && !map.has(normalized)) map.set(normalized, str);
  }
  fieldMapCache.set(fields, map);
  return map;
}

export function firstNonEmpty(fields, candidates) {
  for (const candidate of candidates) {
    if (!Object.prototype.hasOwnProperty.call(fields, candidate)) continue;
    const raw = fields[candidate];
    if (raw === undefined || raw === null) continue;
    const str = String(raw).trim();
    if (str) return str;
  }
  return '';
}

export function firstNonEmptyFast(fields, candidates) {
  const map = getFieldMap(fields);
  for (const candidate of candidates) {
    if (map.has(candidate)) return map.get(candidate);
  }
  for (const candidate of candidates) {
    const normalized = normalizeFieldKey(candidate);
    if (normalized && map.has(normalized)) return map.get(normalized);
  }
  return '';
}

export function applyVisibility(query = {}) {
  if (!FM_VISIBILITY_FIELD) return { ...query };
  return { ...query, [FM_VISIBILITY_FIELD]: FM_VISIBILITY_VALUE };
}

export function shouldFallbackVisibility(json) {
  const code = json?.messages?.[0]?.code;
  const codeStr = code === undefined || code === null ? '' : String(code);
  return codeStr === '102' || codeStr === '121';
}

export function isMissingFieldError(json) {
  const code = json?.messages?.[0]?.code;
  const codeStr = code === undefined || code === null ? '' : String(code);
  return codeStr === '102';
}

export function recordIsVisible(fields = {}) {
  if (!FM_VISIBILITY_FIELD) return true;
  const raw = fields[FM_VISIBILITY_FIELD] ?? fields['Tape Files::Visibility'];
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return true;
  return value === FM_VISIBILITY_VALUE_LC;
}

export function recordIsFeatured(fields = {}) {
  if (!FEATURED_FIELD_CANDIDATES.length) return false;
  for (const field of FEATURED_FIELD_CANDIDATES) {
    const raw = fields[field];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : String(raw).trim().toLowerCase();
    if (!value) continue;
    if (value === FM_FEATURED_VALUE_LC) return true;
  }
  return false;
}

export function parseTrackSequence(fields = {}) {
  for (const key of TRACK_SEQUENCE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const raw = fields[key];
    if (raw === undefined || raw === null) continue;
    const str = String(raw).trim();
    if (!str) continue;
    const numeric = Number(str);
    if (Number.isFinite(numeric)) return numeric;
    const cleaned = Number(str.replace(REGEX_EXTRACT_NUMBERS, ''));
    if (Number.isFinite(cleaned)) return cleaned;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const lower = key.toLowerCase();
    if (!REGEX_TRACK_SONG.test(lower)) continue;
    if (!REGEX_NUMBER_INDICATORS.test(lower)) continue;
    const str = String(value).trim();
    if (!str) continue;
    const numeric = Number(str);
    if (Number.isFinite(numeric)) return numeric;
    const cleaned = Number(str.replace(REGEX_EXTRACT_NUMBERS, ''));
    if (Number.isFinite(cleaned)) return cleaned;
  }
  return Number.POSITIVE_INFINITY;
}

export function composersFromFields(fields = {}) {
  return [
    fields['Composer'],
    fields['Composer 1'] ?? fields['Composer1'],
    fields['Composer 2'] ?? fields['Composer2'],
    fields['Composer 3'] ?? fields['Composer3'],
    fields['Composer 4'] ?? fields['Composer4']
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim())
    .filter(Boolean);
}
