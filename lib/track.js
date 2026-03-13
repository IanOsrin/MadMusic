/**
 * lib/track.js — Track URL resolution and payload normalisation.
 * Dependencies: lib/fm-fields.js
 */

import { AUDIO_FIELD_CANDIDATES } from './fm-fields.js';

// ── Internal regex ───────────────────────────────────────────────────────────
const REGEX_HTTP_HTTPS               = /^https?:\/\//i;
const REGEX_ABSOLUTE_API_CONTAINER   = /^https?:\/\/[^/]+\/api\/container\?/i;
const REGEX_DATA_URI                 = /^data:/i;
const REGEX_S3_URL                   = /^https?:\/\/(?:.*\.s3[.-]|s3[.-])/;

// ── Track URL resolution ────────────────────────────────────────────────────

export function resolvePlayableSrc(raw) {
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

export function resolveArtworkSrc(raw) {
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

export function hasValidAudio(fields) {
  if (!fields || typeof fields !== 'object') return false;
  for (const field of AUDIO_FIELD_CANDIDATES) {
    const raw = fields[field];
    if (!raw) continue;
    const resolved = resolvePlayableSrc(String(raw));
    if (resolved) return true;
  }
  return false;
}

export function hasValidArtwork(fields) {
  if (!fields || typeof fields !== 'object') return false;
  const artworkS3URL = fields['Artwork_S3_URL'] || fields['Tape Files::Artwork_S3_URL'] || '';
  if (!artworkS3URL || typeof artworkS3URL !== 'string') return false;
  if (!artworkS3URL.toLowerCase().includes('gmvi')) return false;
  return !!resolveArtworkSrc(artworkS3URL);
}

// ── Track payload normalisation ─────────────────────────────────────────────

export function normalizeTrackPayload(raw = {}) {
  const recordId    = typeof raw.recordId    === 'string' ? raw.recordId.trim()    : '';
  const name        = typeof raw.name        === 'string' ? raw.name.trim()        : '';
  const albumTitle  = typeof raw.albumTitle  === 'string' ? raw.albumTitle.trim()  : '';
  const albumArtist = typeof raw.albumArtist === 'string' ? raw.albumArtist.trim() : '';
  const catalogue   = typeof raw.catalogue   === 'string' ? raw.catalogue.trim()   : '';
  const trackArtist = typeof raw.trackArtist === 'string' ? raw.trackArtist.trim() : '';
  const mp3         = typeof raw.mp3         === 'string' ? raw.mp3.trim()         : '';
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
  const artwork      = typeof raw.artwork      === 'string' ? raw.artwork.trim()      : '';
  const audioField   = typeof raw.audioField   === 'string' ? raw.audioField.trim()   : '';
  const artworkField = typeof raw.artworkField === 'string' ? raw.artworkField.trim() : '';
  return {
    recordId, name, albumTitle, albumArtist, catalogue, trackArtist,
    mp3, resolvedSrc, seq, artwork, audioField, artworkField
  };
}
