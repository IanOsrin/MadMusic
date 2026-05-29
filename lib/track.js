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

// Rewrite a master S3 artwork URL (…/artwork/NAME.jpg) to a pre-generated
// derivative (…/artwork/resized/NAME_<size>.webp) produced by
// scripts/artwork-resize. Returns the input unchanged if it isn't a master
// artwork URL or is already a derivative — so it's safe to apply anywhere.
const REGEX_ARTWORK_MASTER = /\/artwork\/[^/]+\.(?:jpe?g|png)(?:\?|$)/i;
export function thumbArtworkUrl(url, size = 300) {
  if (!url || typeof url !== 'string') return url;
  if (url.includes('/artwork/resized/')) return url;
  if (!REGEX_ARTWORK_MASTER.test(url)) return url;
  const s = size === 800 ? 800 : 300;
  return url
    .replace('/artwork/', '/artwork/resized/')
    .replace(/\.(?:jpe?g|png)(\?.*)?$/i, `_${s}.webp$1`);
}

export function hasValidArtwork(fields) {
  if (!fields || typeof fields !== 'object') return false;
  const artworkS3URL = fields['Artwork_S3_URL'] || fields['Tape Files::Artwork_S3_URL'] || '';
  if (!artworkS3URL || typeof artworkS3URL !== 'string') return false;
  if (!artworkS3URL.toLowerCase().includes('gmvi')) return false;
  return !!resolveArtworkSrc(artworkS3URL);
}

// ── Track payload normalisation ─────────────────────────────────────────────

function trimStr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSeq(raw) {
  if (typeof raw === 'string') {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  return null;
}

export function normalizeTrackPayload(raw = {}) {
  return {
    recordId:    trimStr(raw.recordId),
    name:        trimStr(raw.name),
    albumTitle:  trimStr(raw.albumTitle),
    albumArtist: trimStr(raw.albumArtist),
    catalogue:   trimStr(raw.catalogue),
    trackArtist: trimStr(raw.trackArtist),
    mp3:         trimStr(raw.mp3),
    resolvedSrc: trimStr(raw.resolvedSrc),
    seq:         normalizeSeq(raw.seq),
    artwork:     trimStr(raw.artwork),
    audioField:  trimStr(raw.audioField),
    artworkField: trimStr(raw.artworkField)
  };
}
