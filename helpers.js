import 'dotenv/config';
import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { fmPost, fmGetAbsolute, fmCreateRecord, fmFindRecords, fmGetRecordById, fmUpdateRecord, fmWithAuth, safeFetch } from './fm-client.js';
import { loadAccessTokens, saveAccessTokens, getAccessTokensCacheData, loadPlaylists } from './store.js';
import { tokenValidationCache, streamRecordLRU, playlistImageLRU } from './cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ========= ENV & CONSTANTS ========= */
const FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';
const FM_STREAM_EVENTS_LAYOUT = process.env.FM_STREAM_EVENTS_LAYOUT || 'Stream_Events';
const FM_FEATURED_FIELD = (process.env.FM_FEATURED_FIELD || 'Tape Files::featured').trim();
const FM_FEATURED_VALUE = (process.env.FM_FEATURED_VALUE || 'yes').trim();
const FM_FEATURED_VALUE_LC = FM_FEATURED_VALUE.toLowerCase();
const FM_VISIBILITY_FIELD = (process.env.FM_VISIBILITY_FIELD || '').trim();
const FM_VISIBILITY_VALUE = (process.env.FM_VISIBILITY_VALUE || 'show').trim();
const FM_VISIBILITY_VALUE_LC = FM_VISIBILITY_VALUE.toLowerCase();
const STREAM_EVENT_DEBUG = process.env.DEBUG_STREAM_EVENTS === 'true' || process.env.NODE_ENV === 'development' || process.env.DEBUG?.includes('stream');
const MASS_SESSION_COOKIE = 'mass.sid';
const MASS_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const STREAM_EVENT_TYPES = new Set(['PLAY', 'PROGRESS', 'PAUSE', 'SEEK', 'END', 'ERROR']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_TERMINAL_EVENTS = new Set(['END', 'ERROR']);
const STREAM_TIME_FIELD = 'TimeStreamed';
const STREAM_TIME_FIELD_LEGACY = 'PositionSec';
const PLAYLIST_IMAGE_EXTS = ['.webp', '.jpg', '.jpeg', '.png', '.gif', '.svg'];
const PUBLIC_DIR = path.join(__dirname, 'public');
const PLAYLIST_IMAGE_DIR = path.join(PUBLIC_DIR, 'img', 'Playlists');

// Email configuration
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.ionos.com';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT) || 587;
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

let emailTransporter = null;
if (EMAIL_USER && EMAIL_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_PORT === 465,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
}

// Paystack configuration
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const PAYSTACK_PLANS = {
  '1-day':  { amount: 500,   label: '1 Day Access',  days: 1,  display: 'R5' },
  '7-day':  { amount: 2000,  label: '7 Day Access',  days: 7,  display: 'R20' },
  '30-day': { amount: 5000,  label: '30 Day Access', days: 30, display: 'R50' }
};

const TRACK_SEQUENCE_FIELDS = [
  'Track Number', 'TrackNumber', 'Track_Number', 'Track No', 'Track No.', 'Track_No',
  'Track #', 'Track#', 'Track Sequence', 'Track Sequence Number', 'Track Seq', 'Track Seq No',
  'Track Order', 'Track Position', 'TrackPosition', 'Sequence', 'Seq', 'Sequence Number',
  'Sequence_Number', 'Song Number', 'Song No', 'Song Seq', 'Song Order',
  'Tape Files::Track Number', 'Tape Files::Track_No'
];
const PUBLIC_PLAYLIST_NAME_SPLIT = /[,;|\r\n]+/;
const PUBLIC_PLAYLIST_FIELDS = ['PublicPlaylist'];
const AUDIO_FIELD_CANDIDATES = ['S3_URL', 'mp3', 'MP3', 'Audio File', 'Audio::mp3'];
const ARTWORK_FIELD_CANDIDATES = [
  'Artwork_S3_URL', 'Tape Files::Artwork_S3_URL', 'Artwork::Picture', 'Artwork Picture',
  'Picture', 'CoverArtURL', 'AlbumCover', 'Cover Art', 'CoverArt'
];
const CATALOGUE_FIELD_CANDIDATES = [
  'Album Catalogue Number', 'Reference Catalogue Number', 'Tape Files::Reference Catalogue Number'
];
const FEATURED_FIELD_BASE = FM_FEATURED_FIELD.replace(/^tape files::/i, '').trim();
const FEATURED_FIELD_CANDIDATES = Array.from(
  new Set([
    FM_FEATURED_FIELD,
    FEATURED_FIELD_BASE && `Tape Files::${FEATURED_FIELD_BASE}`,
    FEATURED_FIELD_BASE,
    'Tape Files::featured', 'Tape Files::Featured', 'featured', 'Featured'
  ].filter(Boolean))
);

// Regex patterns
const REGEX_WHITESPACE = /\s+/g;
const REGEX_CURLY_SINGLE_QUOTES = /[\u2018\u2019]/g;
const REGEX_CURLY_DOUBLE_QUOTES = /[\u201C\u201D]/g;
const REGEX_LEADING_TRAILING_NONWORD = /^\W+|\W+$/g;
const REGEX_HTTP_HTTPS = /^https?:\/\//i;
const REGEX_ABSOLUTE_API_CONTAINER = /^https?:\/\/[^/]+\/api\/container\?/i;
const REGEX_DATA_URI = /^data:/i;
const REGEX_EXTRACT_NUMBERS = /[^0-9.-]/g;
const REGEX_TRACK_SONG = /(track|song)/;
const REGEX_NUMBER_INDICATORS = /(no|num|#|seq|order|pos)/;
const REGEX_TABLE_MISSING = /table is missing/i;
const REGEX_SLUGIFY_NONALPHA = /[^a-z0-9]+/g;
const REGEX_SLUGIFY_TRIM_DASHES = /^-+|-+$/g;
const REGEX_UUID_DASHES = /-/g;
const REGEX_NORMALIZE_FIELD = /[^a-z0-9]/gi;
const REGEX_S3_URL = /^https?:\/\/(?:.*\.s3[.-]|s3[.-])/;

// Validators
const validators = {
  searchQuery: (value) => {
    if (typeof value !== 'string') return { valid: false, error: 'Must be string' };
    const trimmed = value.trim();
    if (trimmed.length > 200) return { valid: false, error: 'Too long (max 200 chars)' };
    if (/^[=!<>]|[=]{2}|[<>]=|<>/.test(trimmed)) {
      return { valid: false, error: 'Invalid characters in search query' };
    }
    return { valid: true, value: trimmed };
  },
  playlistName: (value) => {
    if (typeof value !== 'string') return { valid: false, error: 'Must be string' };
    const trimmed = value.trim();
    if (trimmed.length < 1) return { valid: false, error: 'Playlist name required' };
    if (trimmed.length > 100) return { valid: false, error: 'Too long (max 100 chars)' };
    if (/<[^>]*>/g.test(trimmed)) {
      return { valid: false, error: 'HTML tags not allowed' };
    }
    return { valid: true, value: trimmed };
  },
  recordId: (value) => {
    const str = String(value).trim();
    if (!/^\d+$/.test(str)) {
      return { valid: false, error: 'Record ID must be numeric' };
    }
    if (str.length > 20) {
      return { valid: false, error: 'Record ID too long' };
    }
    return { valid: true, value: str };
  },
  limit: (value, max = 1000) => {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 1) return { valid: false, error: 'Limit must be positive integer' };
    if (num > max) return { valid: false, error: `Limit exceeds maximum (${max})` };
    return { valid: true, value: num };
  },
  offset: (value) => {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 0) return { valid: false, error: 'Offset must be non-negative integer' };
    if (num > 1000000) return { valid: false, error: 'Offset too large' };
    return { valid: true, value: num };
  },
  url: (value) => {
    if (typeof value !== 'string') return { valid: false, error: 'URL must be string' };
    const trimmed = value.trim();
    if (trimmed.includes('..') || trimmed.includes('\\')) {
      return { valid: false, error: 'Invalid URL path' };
    }
    if (trimmed.length > 2000) {
      return { valid: false, error: 'URL too long' };
    }
    return { valid: true, value: trimmed };
  }
};

function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num > 0) {
    return num;
  }
  return fallback;
}

function parseNonNegativeInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num >= 0) {
    return num;
  }
  return fallback;
}

async function deduplicatedFetch(cacheKey, cache, fetchFn) {
  const pendingRequests = new Map();
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }
  const promise = fetchFn().finally(() => {
    pendingRequests.delete(cacheKey);
  });
  pendingRequests.set(cacheKey, promise);
  return promise;
}

function generateETag(data) {
  const hash = createHash('md5').update(JSON.stringify(data)).digest('hex');
  return `"${hash.slice(0, 16)}"`;
}

function sendWithETag(res, data) {
  const etag = generateETag(data);
  res.setHeader('ETag', etag);
  const clientETag = res.req.headers['if-none-match'];
  if (clientETag === etag) {
    return res.status(304).end();
  }
  return res.json(data);
}

function getClientIP(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length) {
    const first = forwarded[0];
    if (typeof first === 'string' && first.trim()) {
      return first.trim();
    }
  }
  if (typeof req?.ip === 'string' && req.ip) {
    return req.ip;
  }
  const remoteAddress = req?.socket?.remoteAddress;
  if (typeof remoteAddress === 'string' && remoteAddress) {
    return remoteAddress;
  }
  return '';
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

const normalizeFieldKey = (name) => (typeof name === 'string' ? name.replace(REGEX_NORMALIZE_FIELD, '').toLowerCase() : '');

function pickFieldValueCaseInsensitive(fields = {}, candidates = []) {
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

function splitPlaylistNames(raw) {
  if (typeof raw !== 'string') return [];
  return raw.split(PUBLIC_PLAYLIST_NAME_SPLIT).map((value) => value.trim()).filter(Boolean);
}

function resolvePlayableSrc(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const src = raw.trim();
  if (!src) return '';
  if (src.includes('\r') || src.includes('\n') ||
      (src.includes('movie:') && src.includes('size:')) ||
      src.includes('moviemac:') || src.includes('moviewin:')) {
    console.warn('[MASS] Detected FileMaker container metadata format, rejecting:', src.slice(0, 100));
    return '';
  }
  if (src.startsWith('/api/container?')) return src;
  if (REGEX_ABSOLUTE_API_CONTAINER.test(src)) return src;
  if (REGEX_DATA_URI.test(src)) return src;
  if (REGEX_S3_URL.test(src)) return src;
  if (REGEX_HTTP_HTTPS.test(src)) return `/api/container?u=${encodeURIComponent(src)}`;
  if (src.startsWith('/')) return src;
  return `/api/container?u=${encodeURIComponent(src)}`;
}

function resolveArtworkSrc(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const src = raw.trim();
  if (!src) return '';
  if (src.includes('\r') || src.includes('\n') ||
      (src.includes('movie:') && src.includes('size:')) ||
      src.includes('moviemac:') || src.includes('moviewin:')) {
    console.warn('[MASS] Detected FileMaker container metadata in artwork, rejecting:', src.slice(0, 100));
    return '';
  }
  if (src.startsWith('/api/container?')) return src;
  if (REGEX_S3_URL.test(src)) return src;
  if (REGEX_HTTP_HTTPS.test(src)) return src;
  return `/api/container?u=${encodeURIComponent(src)}`;
}

function normTitle(str) {
  return String(str || '')
    .replace(REGEX_WHITESPACE, ' ')
    .replace(REGEX_CURLY_SINGLE_QUOTES, "'")
    .replace(REGEX_CURLY_DOUBLE_QUOTES, '"')
    .replace(REGEX_LEADING_TRAILING_NONWORD, '')
    .trim();
}

function makeAlbumKey(catalogue, title, artist) {
  const cat = String(catalogue || '').trim();
  if (cat) return `cat:${cat.toLowerCase()}`;
  const normT = normTitle(title || '').toLowerCase();
  const normA = normTitle(artist || '').toLowerCase();
  return `title:${normT}|artist:${normA}`;
}

function parseTrackSequence(fields = {}) {
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

function composersFromFields(fields = {}) {
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

function firstNonEmpty(fields, candidates) {
  for (const candidate of candidates) {
    if (!Object.prototype.hasOwnProperty.call(fields, candidate)) continue;
    const raw = fields[candidate];
    if (raw === undefined || raw === null) continue;
    const str = String(raw).trim();
    if (str) return str;
  }
  return '';
}

const fieldMapCache = new WeakMap();

function getFieldMap(fields) {
  if (fieldMapCache.has(fields)) {
    return fieldMapCache.get(fields);
  }
  const map = new Map();
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const str = typeof value === 'string' ? value.trim() : String(value).trim();
    if (str && !map.has(key)) {
      map.set(key, str);
    }
    const normalized = normalizeFieldKey(key);
    if (normalized && str && !map.has(normalized)) {
      map.set(normalized, str);
    }
  }
  fieldMapCache.set(fields, map);
  return map;
}

function firstNonEmptyFast(fields, candidates) {
  const map = getFieldMap(fields);
  for (const candidate of candidates) {
    if (map.has(candidate)) {
      return map.get(candidate);
    }
  }
  for (const candidate of candidates) {
    const normalized = normalizeFieldKey(candidate);
    if (normalized && map.has(normalized)) {
      return map.get(normalized);
    }
  }
  return '';
}

function hasValidAudio(fields) {
  if (!fields || typeof fields !== 'object') return false;
  for (const field of AUDIO_FIELD_CANDIDATES) {
    const raw = fields[field];
    if (!raw) continue;
    const resolved = resolvePlayableSrc(String(raw));
    if (resolved) return true;
  }
  return false;
}

function hasValidArtwork(fields) {
  if (!fields || typeof fields !== 'object') return false;
  const artworkS3URL = fields['Artwork_S3_URL'] || fields['Tape Files::Artwork_S3_URL'] || '';
  if (!artworkS3URL || typeof artworkS3URL !== 'string') return false;
  if (!artworkS3URL.toLowerCase().includes('gmvi')) return false;
  const resolved = resolveArtworkSrc(artworkS3URL);
  return !!resolved;
}

function applyVisibility(query = {}) {
  if (!FM_VISIBILITY_FIELD) return { ...query };
  return { ...query, [FM_VISIBILITY_FIELD]: FM_VISIBILITY_VALUE };
}

function shouldFallbackVisibility(json) {
  const code = json?.messages?.[0]?.code;
  const codeStr = code === undefined || code === null ? '' : String(code);
  return codeStr === '102' || codeStr === '121';
}

function isMissingFieldError(json) {
  const code = json?.messages?.[0]?.code;
  const codeStr = code === undefined || code === null ? '' : String(code);
  return codeStr === '102';
}

function recordIsVisible(fields = {}) {
  if (!FM_VISIBILITY_FIELD) return true;
  const raw = fields[FM_VISIBILITY_FIELD] ?? fields['Tape Files::Visibility'];
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return true;
  return value === FM_VISIBILITY_VALUE_LC;
}

function recordIsFeatured(fields = {}) {
  if (!FEATURED_FIELD_CANDIDATES.length) return false;
  for (const field of FEATURED_FIELD_CANDIDATES) {
    const raw = fields[field];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : String(raw).trim().toLowerCase();
    if (!value) continue;
    if (value === FM_FEATURED_VALUE_LC) {
      return true;
    }
  }
  return false;
}

function fmErrorToHttpStatus(fmCode, defaultStatus = 500) {
  const code = parseInt(fmCode, 10);
  if (isNaN(code)) return defaultStatus;
  if (code === 401) return 404;
  if (code === 102) return 400;
  if (code === 103) return 400;
  if (code === 104) return 400;
  if (code === 105) return 400;
  if (code === 106) return 400;
  if (code >= 500 && code <= 599) return 400;
  if (code >= 800 && code <= 899) return 400;
  if (code === 802) return 503;
  if (code === 954) return 503;
  if (code === 958) return 503;
  if (code >= 10000) return 503;
  if (code >= 200 && code <= 299) return 403;
  return 500;
}

const normalizeRecordId = (value) => {
  if (value === undefined || value === null) return '';
  const str = String(value).trim();
  return str;
};

const playlistOwnerMatches = (ownerId, userEmail) => {
  if (!ownerId || !userEmail) return false;
  const ownerStr = String(ownerId).trim().toLowerCase();
  const emailStr = String(userEmail).trim().toLowerCase();
  return ownerStr === emailStr;
};

const slugifyPlaylistName = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(REGEX_SLUGIFY_NONALPHA, '-')
    .replace(REGEX_SLUGIFY_TRIM_DASHES, '');

const normalizeShareId = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const generateShareId = () => {
  if (typeof randomUUID === 'function') {
    return randomUUID().replace(REGEX_UUID_DASHES, '');
  }
  return randomBytes(16).toString('hex');
};

const cloneTrackForShare = (track) => {
  if (!track || typeof track !== 'object') return null;
  const {
    id = null, trackRecordId = null, name = '', albumTitle = '', albumArtist = '',
    catalogue = '', trackArtist = '', mp3 = '', resolvedSrc = '', seq = null,
    artwork = '', audioField = '', artworkField = '', addedAt = null, producer = '',
    language = '', genre = '', isrc = '', composer1 = '', composer2 = '',
    composer3 = '', composer4 = '', composers = [], albumKey = '', picture = ''
  } = track;

  const payload = { id, trackRecordId, name, albumTitle, albumArtist, catalogue, trackArtist, mp3, resolvedSrc, seq, artwork, audioField, artworkField, addedAt };
  if (producer) payload.producer = producer;
  if (language) payload.language = language;
  if (genre) payload.genre = genre;
  if (isrc) payload.isrc = isrc;
  if (composer1) payload.composer1 = composer1;
  if (composer2) payload.composer2 = composer2;
  if (composer3) payload.composer3 = composer3;
  if (composer4) payload.composer4 = composer4;
  if (Array.isArray(composers) && composers.length) payload.composers = composers.slice();
  if (albumKey) payload.albumKey = albumKey;
  if (picture) payload.picture = picture;
  return payload;
};

const sanitizePlaylistForShare = (playlist) => {
  if (!playlist || typeof playlist !== 'object') return null;
  const tracks = Array.isArray(playlist.tracks)
    ? playlist.tracks.map(cloneTrackForShare).filter(Boolean)
    : [];
  return {
    id: playlist.id || null,
    shareId: normalizeShareId(playlist.shareId),
    name: playlist.name || '',
    sharedAt: playlist.sharedAt || null,
    createdAt: playlist.createdAt || null,
    updatedAt: playlist.updatedAt || null,
    tracks
  };
};

const resolveRequestOrigin = (req) => {
  const originHeader = req.get('origin');
  if (originHeader) return originHeader;
  const forwardedProto = req.get('x-forwarded-proto');
  const forwardedHost = req.get('x-forwarded-host');
  const host = forwardedHost || req.get('host');
  const proto = forwardedProto || req.protocol;
  if (proto && host) return `${proto}://${host}`;
  if (host) return `http://${host}`;
  return '';
};

const buildShareUrl = (req, shareId) => {
  const normalized = normalizeShareId(shareId);
  if (!normalized) return '';
  const origin = resolveRequestOrigin(req);
  const pathPart = `/?share=${encodeURIComponent(normalized)}`;
  return origin ? `${origin}${pathPart}` : pathPart;
};

async function resolvePlaylistImage(name) {
  if (!name) return null;
  const slug = slugifyPlaylistName(name);
  if (!slug) return null;
  if (playlistImageLRU.has(slug)) return playlistImageLRU.get(slug);
  for (const ext of PLAYLIST_IMAGE_EXTS) {
    const fullPath = path.join(PLAYLIST_IMAGE_DIR, slug + ext);
    try {
      await fs.access(fullPath);
      const relative = `/img/Playlists/${slug}${ext}`;
      playlistImageLRU.set(slug, relative);
      return relative;
    } catch {
      // ignore
    }
  }
  playlistImageLRU.set(slug, null);
  return null;
}

const validateSessionId = (sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') {
    return null;
  }
  if (!UUID_REGEX.test(sessionId)) {
    return null;
  }
  return sessionId;
};

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  const out = {};
  const pieces = header.split(';');
  for (const piece of pieces) {
    const part = piece.trim();
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function validateQueryString(value, fieldName, maxLength = 200) {
  if (value === null || value === undefined) {
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') {
    return { ok: false, reason: `${fieldName} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return { ok: false, reason: `${fieldName} too long (max ${maxLength} characters)` };
  }
  return { ok: true, value: trimmed };
}

function sendTokenEmail(customerEmail, tokenCode, days) {
  if (!emailTransporter) {
    console.log('[MASS] Email transporter not configured — skipping token email');
    return;
  }
  if (!customerEmail || customerEmail === 'unknown') {
    console.log('[MASS] No customer email available — skipping token email');
    return;
  }

  const planLabel = days === 1 ? '1 Day' : `${days} Days`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Your Mass Music Access Token</h2>
      <p style="color: #555; margin-bottom: 24px;">Thank you for your purchase! Here is your access token:</p>
      <div style="background: #f4f4f4; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-weight: bold; letter-spacing: 2px; color: #1a1a1a;">${tokenCode}</span>
      </div>
      <p style="color: #555;"><strong>Plan:</strong> ${planLabel} Access</p>
      <p style="color: #555; margin-bottom: 24px;">Enter this token on the Mass Music app to activate your streaming access.</p>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />
      <p style="color: #999; font-size: 12px;">If you did not make this purchase, please ignore this email.</p>
    </div>
  `;

  emailTransporter.sendMail({
    from: EMAIL_FROM,
    to: customerEmail,
    subject: `Your Mass Music Access Token: ${tokenCode}`,
    html
  }).then(() => {
    console.log(`[MASS] Token email sent to ${customerEmail}`);
  }).catch(err => {
    console.error(`[MASS] Failed to send token email to ${customerEmail}:`, err?.message || err);
  });
}

async function paystackRequest(method, endpoint, body) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error('PAYSTACK_SECRET_KEY not configured');
  }
  const url = `${PAYSTACK_BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await safeFetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Paystack API error: ${data.message || response.statusText}`);
  }
  return data;
}

function verifyPaystackWebhook(rawBody, signature) {
  if (!PAYSTACK_SECRET_KEY || !signature) return false;
  const hash = createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}

function validateAccessTokenFromJSON(tokenCode) {
  if (!tokenCode || typeof tokenCode !== 'string') {
    return { valid: false, reason: 'No token provided' };
  }

  const trimmedCode = tokenCode.trim().toUpperCase();

  if (trimmedCode === 'MASS-UNLIMITED-ACCESS') {
    return {
      valid: true,
      type: 'unlimited',
      expirationDate: null,
      email: null,
      message: 'Unlimited access token'
    };
  }

  const tokenData = getAccessTokensCacheData() || { tokens: [] };
  const token = tokenData.tokens.find(t =>
    t.code && t.code.trim().toUpperCase() === trimmedCode
  );

  if (!token) {
    return { valid: false, reason: 'Invalid token' };
  }

  if (token.expirationDate) {
    const expirationTime = new Date(token.expirationDate).getTime();
    const now = Date.now();

    if (now > expirationTime) {
      return {
        valid: false,
        reason: 'Token expired',
        expirationDate: token.expirationDate
      };
    }
  }

  return {
    valid: true,
    type: token.type || 'trial',
    expirationDate: token.expirationDate,
    issuedDate: token.issuedDate,
    notes: token.notes,
    email: token.email ? normalizeEmail(token.email) : null
  };
}

async function validateAccessToken(tokenCode, sessionId = null, req = null) {
  if (!tokenCode || typeof tokenCode !== 'string') {
    return { valid: false, reason: 'No token provided' };
  }

  const trimmedCode = tokenCode.trim().toUpperCase();

  if (trimmedCode === 'MASS-UNLIMITED-ACCESS') {
    return {
      valid: true,
      type: 'unlimited',
      expirationDate: null,
      email: null,
      message: 'Unlimited access token'
    };
  }

  try {
    const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
    console.log(`[MASS] Looking up token "${trimmedCode}" in FileMaker layout "${layout}"`);

    const result = await fmFindRecords(layout, [
      { 'Token_Code': `==${trimmedCode}` }
    ], { limit: 1 });

    console.log(`[MASS] FileMaker token lookup result: ${result?.data?.length || 0} records found`);

    if (!result || !result.data || result.data.length === 0) {
      console.log('[MASS] Token not found in FileMaker, trying JSON fallback');
      return validateAccessTokenFromJSON(tokenCode);
    }

    const token = result.data[0].fieldData;

    if (token.Active === 0 || token.Active === '0') {
      return { valid: false, reason: 'Token disabled' };
    }

    if (token.Expiration_Date) {
      const fmTimezoneOffset = parseFloat(process.env.FM_TIMEZONE_OFFSET || '0');
      let expirationTime = new Date(token.Expiration_Date).getTime();
      const offsetMs = fmTimezoneOffset * 60 * 60 * 1000;
      expirationTime = expirationTime - offsetMs;
      const now = Date.now();

      console.log(`[MASS] Token expiration check for ${trimmedCode}:`);
      console.log(`  Raw expiration from FM: "${token.Expiration_Date}"`);
      console.log(`  FM Timezone offset: ${fmTimezoneOffset > 0 ? '+' : ''}${fmTimezoneOffset} hours`);
      console.log(`  Parsed as local: ${new Date(token.Expiration_Date).toISOString()}`);
      console.log(`  Adjusted to UTC: ${new Date(expirationTime).toISOString()}`);
      console.log(`  Current UTC time: ${new Date(now).toISOString()}`);
      console.log(`  Time until expiry: ${((expirationTime - now) / 1000 / 60 / 60).toFixed(2)} hours`);

      if (isNaN(expirationTime)) {
        console.warn(`[MASS] Could not parse expiration date: "${token.Expiration_Date}" - treating as no expiration`);
      } else if (now > expirationTime) {
        console.log(`[MASS] Token ${trimmedCode} is EXPIRED`);
        return {
          valid: false,
          reason: 'Token expired',
          expirationDate: token.Expiration_Date
        };
      } else {
        console.log(`[MASS] Token ${trimmedCode} is still valid`);
      }
    }

    if (sessionId) {
      const currentSessionId = token.Current_Session_ID;
      const lastActivity = token.Session_Last_Activity;

      if (currentSessionId && currentSessionId !== sessionId) {
        if (lastActivity) {
          try {
            const lastActivityTime = new Date(lastActivity).getTime();
            const now = Date.now();
            const sessionTimeoutMs = 15 * 60 * 1000;

            if (!isNaN(lastActivityTime) && (now - lastActivityTime) < sessionTimeoutMs) {
              console.log(`[MASS] Token ${trimmedCode} is in use by another session (last active ${Math.floor((now - lastActivityTime) / 1000 / 60)} min ago)`);
              return {
                valid: false,
                reason: 'Token is currently in use on another device'
              };
            } else {
              console.log(`[MASS] Previous session timed out, allowing new session`);
            }
          } catch (err) {
            console.warn('[MASS] Error parsing session last activity:', err);
          }
        }
      }
      console.log(`[MASS] Session ${sessionId} validated for token ${trimmedCode}`);
    }

    const recordId = result.data[0].recordId;
    const now = new Date();
    const fmTimestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const updateFields = {
      'Last_Used': fmTimestamp,
      'Use_Count': (parseInt(token.Use_Count) || 0) + 1
    };

    if (sessionId) {
      updateFields['Current_Session_ID'] = sessionId;
      updateFields['Session_Last_Activity'] = fmTimestamp;
      if (req) {
        updateFields['Session_Device_Info'] = req.headers['user-agent'] || 'Unknown';
        updateFields['Session_IP'] = req.ip || req.connection?.remoteAddress || 'Unknown';
      }
    }

    let calculatedExpirationUTC = null;

    if (!token.First_Used || token.First_Used === '') {
      updateFields['First_Used'] = fmTimestamp;
      console.log(`[MASS] Setting First_Used for token ${trimmedCode}`);

      if (token.Token_Duration_Hours && parseInt(token.Token_Duration_Hours) > 0) {
        const durationSeconds = parseInt(token.Token_Duration_Hours);
        const expirationTime = new Date(now.getTime() + (durationSeconds * 1000));
        const fmExpiration = `${expirationTime.getMonth() + 1}/${expirationTime.getDate()}/${expirationTime.getFullYear()} ${expirationTime.getHours()}:${String(expirationTime.getMinutes()).padStart(2, '0')}:${String(expirationTime.getSeconds()).padStart(2, '0')}`;
        updateFields['Expiration_Date'] = fmExpiration;
        calculatedExpirationUTC = expirationTime.toISOString();
        console.log(`[MASS] Setting Expiration_Date for token ${trimmedCode}: ${fmExpiration} (${durationSeconds} seconds from now)`);
      }
    }

    fmUpdateRecord(layout, recordId, updateFields).catch(err => {
      console.warn('[MASS] Failed to update token usage stats:', err);
    });

    let expirationDateUTC = calculatedExpirationUTC;
    if (!expirationDateUTC && token.Expiration_Date) {
      const fmTimezoneOffset = parseFloat(process.env.FM_TIMEZONE_OFFSET || '0');
      let expirationTimeUTC = new Date(token.Expiration_Date).getTime();
      const offsetMs = fmTimezoneOffset * 60 * 60 * 1000;
      expirationTimeUTC = expirationTimeUTC - offsetMs;
      expirationDateUTC = new Date(expirationTimeUTC).toISOString();
    }

    return {
      valid: true,
      type: token.Token_Type || 'trial',
      expirationDate: expirationDateUTC,
      issuedDate: token.Issued_Date,
      notes: token.Notes,
      email: token.Email ? normalizeEmail(token.Email) : null
    };
  } catch (err) {
    console.error('[MASS] FileMaker token validation error:', err);
    console.warn('[MASS] Falling back to JSON file for token validation');
    return validateAccessTokenFromJSON(tokenCode);
  }
}

function normalizeTrackPayload(raw = {}) {
  const recordId = typeof raw.recordId === 'string' ? raw.recordId.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const albumTitle = typeof raw.albumTitle === 'string' ? raw.albumTitle.trim() : '';
  const albumArtist = typeof raw.albumArtist === 'string' ? raw.albumArtist.trim() : '';
  const catalogue = typeof raw.catalogue === 'string' ? raw.catalogue.trim() : '';
  const trackArtist = typeof raw.trackArtist === 'string' ? raw.trackArtist.trim() : '';
  const mp3 = typeof raw.mp3 === 'string' ? raw.mp3.trim() : '';
  const resolvedSrc = typeof raw.resolvedSrc === 'string' ? raw.resolvedSrc.trim() : '';
  let seq = raw.seq;
  if (typeof seq === 'string') {
    const parsed = Number(seq.trim());
    seq = Number.isFinite(parsed) ? parsed : null;
  } else if (typeof seq === 'number') {
    seq = Number.isFinite(seq) ? seq : null;
  } else {
    seq = null;
  }
  const artwork = typeof raw.artwork === 'string' ? raw.artwork.trim() : '';
  const audioField = typeof raw.audioField === 'string' ? raw.audioField.trim() : '';
  const artworkField = typeof raw.artworkField === 'string' ? raw.artworkField.trim() : '';
  return {
    recordId, name, albumTitle, albumArtist, catalogue, trackArtist, mp3, resolvedSrc,
    seq, artwork, audioField, artworkField
  };
}

function trackDuplicateKey(payload) {
  if (!payload) return '';
  if (payload.recordId) return `id:${payload.recordId}`;
  if (payload.name && payload.albumTitle && payload.albumArtist) {
    return `meta:${payload.name}|${payload.albumTitle}|${payload.albumArtist}`;
  }
  return '';
}

function trackDuplicateKeyFromEntry(entry = {}) {
  const recordId = typeof entry.trackRecordId === 'string' ? entry.trackRecordId.trim() : '';
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const albumTitle = typeof entry.albumTitle === 'string' ? entry.albumTitle.trim() : '';
  const albumArtist = typeof entry.albumArtist === 'string' ? entry.albumArtist.trim() : '';
  return trackDuplicateKey({ recordId, name, albumTitle, albumArtist });
}

function summarizeTrackPayload(payload = {}) {
  return {
    recordId: payload.recordId || null,
    name: payload.name || '',
    albumTitle: payload.albumTitle || '',
    albumArtist: payload.albumArtist || '',
    seq: Number.isFinite(payload.seq) ? payload.seq : null
  };
}

function buildTrackEntry(payload, addedAt) {
  return {
    id: randomUUID(),
    trackRecordId: payload.recordId || null,
    name: payload.name,
    albumTitle: payload.albumTitle,
    albumArtist: payload.albumArtist,
    catalogue: payload.catalogue,
    trackArtist: payload.trackArtist,
    mp3: payload.mp3,
    resolvedSrc: payload.resolvedSrc,
    seq: Number.isFinite(payload.seq) ? payload.seq : null,
    artwork: payload.artwork,
    audioField: payload.audioField,
    artworkField: payload.artworkField,
    addedAt
  };
}

function buildPlaylistDuplicateIndex(playlist) {
  const map = new Map();
  const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
  for (const entry of tracks) {
    const key = trackDuplicateKeyFromEntry(entry);
    if (key && !map.has(key)) {
      map.set(key, entry);
    }
  }
  return map;
}

function resolveDuplicate(map, payload) {
  const key = trackDuplicateKey(payload);
  if (!key) return { key: '', entry: null };
  return { key, entry: map.get(key) || null };
}

function streamRecordCacheKey(sessionId, trackRecordId) {
  return `${sessionId}::${trackRecordId}`;
}

function getCachedStreamRecordId(sessionId, trackRecordId) {
  const key = streamRecordCacheKey(sessionId, trackRecordId);
  return streamRecordLRU.get(key) || null;
}

function setCachedStreamRecordId(sessionId, trackRecordId, recordId) {
  if (!sessionId || !trackRecordId || !recordId) return;
  const key = streamRecordCacheKey(sessionId, trackRecordId);
  streamRecordLRU.set(key, recordId);
}

function clearCachedStreamRecordId(sessionId, trackRecordId) {
  if (!sessionId || !trackRecordId) return;
  const key = streamRecordCacheKey(sessionId, trackRecordId);
  streamRecordLRU.delete(key);
}

async function findStreamRecord(sessionId, trackRecordId) {
  if (!sessionId || !trackRecordId) return null;
  const query = [
    {
      SessionID: `==${sessionId}`,
      TrackRecordID: `==${trackRecordId}`
    }
  ];
  const sort = [
    { fieldName: 'LastEventUTC', sortOrder: 'descend' },
    { fieldName: 'TimestampUTC', sortOrder: 'descend' }
  ];
  let result = await fmFindRecords(FM_STREAM_EVENTS_LAYOUT, query, { limit: 1, offset: 1, sort });
  if (!result.ok) {
    result = await fmFindRecords(FM_STREAM_EVENTS_LAYOUT, query, { limit: 1, offset: 1 });
  }
  if (!result.ok || result.data.length === 0) return null;
  const entry = result.data[0];
  const recordId = entry?.recordId;
  if (recordId) setCachedStreamRecordId(sessionId, trackRecordId, recordId);
  return {
    recordId,
    fieldData: entry?.fieldData || {}
  };
}

async function ensureStreamRecord(sessionId, trackRecordId, createFields, { forceNew = false } = {}) {
  if (!sessionId || !trackRecordId) {
    throw new Error('ensureStreamRecord requires sessionId and trackRecordId');
  }
  if (forceNew) {
    clearCachedStreamRecordId(sessionId, trackRecordId);
  } else {
    const cachedId = getCachedStreamRecordId(sessionId, trackRecordId);
    if (cachedId) {
      return { recordId: cachedId, created: false, response: null, existingFieldData: null };
    }
  }
  if (!forceNew) {
    const existing = await findStreamRecord(sessionId, trackRecordId);
    if (existing?.recordId) {
      return { recordId: existing.recordId, created: false, response: null, existingFieldData: existing.fieldData || null };
    }
  }
  const response = await fmCreateRecord(FM_STREAM_EVENTS_LAYOUT, createFields);
  const recordId = response?.recordId;
  if (!recordId) {
    throw new Error('Stream event create returned no recordId');
  }
  setCachedStreamRecordId(sessionId, trackRecordId, recordId);
  return { recordId, created: true, response, existingFieldData: null };
}

function normalizeSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.round(parsed));
  }
  return 0;
}

function toCleanString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function escapeHtml(unsafe) {
  if (typeof unsafe !== 'string') {
    unsafe = String(unsafe ?? '');
  }
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTimestampUTC(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) {
    return formatTimestampUTC(new Date());
  }
  const pad = (num) => String(num).padStart(2, '0');
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const year = d.getUTCFullYear();
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const seconds = pad(d.getUTCSeconds());
  return `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;
}

function parseFileMakerTimestamp(value) {
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isNaN(ts) ? 0 : ts;
  }
  if (typeof value !== 'string') {
    if (value === null || value === undefined) return 0;
    return parseFileMakerTimestamp(String(value));
  }
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    const fallback = new Date(trimmed.replace(/-/g, '/'));
    const ts = fallback.getTime();
    return Number.isNaN(ts) ? 0 : ts;
  }
  return parsed;
}

function requireTokenEmail(req, res) {
  const tokenEmail = req.accessToken?.email || null;
  const cookieEmail = parseCookies(req)['mass.email'] || null;
  const tokenCode = req.accessToken?.code || null;
  const email = tokenEmail || cookieEmail || tokenCode;
  if (!email) {
    console.warn(`[MASS] requireTokenEmail: no email — tokenEmail=${tokenEmail}, cookieEmail=${cookieEmail}, token=${req.accessToken?.code?.slice(0,8)}…`);
    res.status(401).json({ ok: false, error: 'Access token required' });
    return null;
  }
  return { email };
}

export {
  deduplicatedFetch, generateETag, sendWithETag, getClientIP, normalizeEmail,
  pickFieldValueCaseInsensitive, splitPlaylistNames, resolvePlayableSrc, resolveArtworkSrc,
  normTitle, makeAlbumKey, parseTrackSequence, composersFromFields, firstNonEmpty,
  getFieldMap, firstNonEmptyFast, hasValidAudio, hasValidArtwork, applyVisibility,
  shouldFallbackVisibility, isMissingFieldError, recordIsVisible, recordIsFeatured,
  fmErrorToHttpStatus, normalizeRecordId, playlistOwnerMatches, slugifyPlaylistName,
  normalizeShareId, generateShareId, cloneTrackForShare, sanitizePlaylistForShare,
  resolveRequestOrigin, buildShareUrl, resolvePlaylistImage, validateSessionId,
  parseCookies, validateQueryString, sendTokenEmail, paystackRequest, verifyPaystackWebhook,
  validateAccessTokenFromJSON, validateAccessToken, normalizeTrackPayload, trackDuplicateKey,
  trackDuplicateKeyFromEntry, summarizeTrackPayload, buildTrackEntry, buildPlaylistDuplicateIndex,
  resolveDuplicate, streamRecordCacheKey, getCachedStreamRecordId, setCachedStreamRecordId,
  clearCachedStreamRecordId, findStreamRecord, ensureStreamRecord, normalizeSeconds, toCleanString,
  escapeHtml, formatTimestampUTC, parseFileMakerTimestamp, requireTokenEmail,
  parsePositiveInt, parseNonNegativeInt, validators,
  PAYSTACK_PLANS, AUDIO_FIELD_CANDIDATES, ARTWORK_FIELD_CANDIDATES, CATALOGUE_FIELD_CANDIDATES,
  FEATURED_FIELD_CANDIDATES, TRACK_SEQUENCE_FIELDS, PUBLIC_PLAYLIST_FIELDS, PUBLIC_DIR,
  FM_LAYOUT, FM_STREAM_EVENTS_LAYOUT, STREAM_EVENT_TYPES, MASS_SESSION_COOKIE,
  MASS_SESSION_MAX_AGE_SECONDS, STREAM_TERMINAL_EVENTS, STREAM_TIME_FIELD, STREAM_TIME_FIELD_LEGACY,
  STREAM_EVENT_DEBUG, normalizeFieldKey
};
