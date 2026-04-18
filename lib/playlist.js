/**
 * lib/playlist.js — Playlist business logic and track entry helpers.
 * Dependencies: lib/format.js, cache.js
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { PUBLIC_DIR, PLAYLIST_IMAGE_EXTS, slugifyPlaylistName, normalizeShareId } from './format.js';
import { playlistImageLRU } from '../cache.js';

export const PLAYLIST_IMAGE_DIR = path.join(PUBLIC_DIR, 'img', 'playlists');

// ── Playlist ownership ───────────────────────────────────────────────────────

export const playlistOwnerMatches = (ownerId, userEmail) => {
  if (!ownerId || !userEmail) return false;
  return String(ownerId).trim().toLowerCase() === String(userEmail).trim().toLowerCase();
};

// ── Share sanitisation ───────────────────────────────────────────────────────

export const cloneTrackForShare = (track) => {
  if (!track || typeof track !== 'object') return null;
  const {
    id = null, trackRecordId = null, name = '', albumTitle = '', albumArtist = '',
    catalogue = '', trackArtist = '', mp3 = '', resolvedSrc = '', seq = null,
    artwork = '', audioField = '', artworkField = '', addedAt = null, producer = '',
    language = '', genre = '', isrc = '', composer1 = '', composer2 = '',
    composer3 = '', composer4 = '', composers = [], albumKey = '', picture = ''
  } = track;

  const payload = {
    id, trackRecordId, name, albumTitle, albumArtist, catalogue, trackArtist,
    mp3, resolvedSrc, seq, artwork, audioField, artworkField, addedAt
  };
  if (producer)  payload.producer  = producer;
  if (language)  payload.language  = language;
  if (genre)     payload.genre     = genre;
  if (isrc)      payload.isrc      = isrc;
  if (composer1) payload.composer1 = composer1;
  if (composer2) payload.composer2 = composer2;
  if (composer3) payload.composer3 = composer3;
  if (composer4) payload.composer4 = composer4;
  if (Array.isArray(composers) && composers.length) payload.composers = composers.slice();
  if (albumKey)  payload.albumKey  = albumKey;
  if (picture)   payload.picture   = picture;
  return payload;
};

export const sanitizePlaylistForShare = (playlist) => {
  if (!playlist || typeof playlist !== 'object') return null;
  const tracks = Array.isArray(playlist.tracks)
    ? playlist.tracks.map(cloneTrackForShare).filter(Boolean)
    : [];
  return {
    id: playlist.id || null,
    shareId: normalizeShareId(playlist.shareId),
    name: playlist.name || '',
    sharedAt:  playlist.sharedAt  || null,
    createdAt: playlist.createdAt || null,
    updatedAt: playlist.updatedAt || null,
    tracks
  };
};

// ── Playlist image resolution ────────────────────────────────────────────────

export async function resolvePlaylistImage(name) {
  if (!name) return null;
  const slug = slugifyPlaylistName(name);
  if (!slug) return null;
  if (playlistImageLRU.has(slug)) return playlistImageLRU.get(slug);
  // Try stems in priority order:
  //  1. slugified name alone          e.g. "soul"
  //  2. original name + _Playlist     e.g. "Soul_Playlist"
  //  3. slug + _playlist              e.g. "soul_playlist"
  const stems = [slug, `${name}_Playlist`, `${slug}_playlist`];
  for (const stem of stems) {
    for (const ext of PLAYLIST_IMAGE_EXTS) {
      const fullPath = path.join(PLAYLIST_IMAGE_DIR, stem + ext);
      try {
        await fs.access(fullPath);
        const relative = `/img/playlists/${stem}${ext}`;
        playlistImageLRU.set(slug, relative);
        return relative;
      } catch {
        // file doesn't exist, try next
      }
    }
  }
  playlistImageLRU.set(slug, null);
  return null;
}

// ── Track entry helpers ──────────────────────────────────────────────────────

export function trackDuplicateKey(payload) {
  if (!payload) return '';
  if (payload.recordId) return `id:${payload.recordId}`;
  if (payload.name && payload.albumTitle && payload.albumArtist) {
    return `meta:${payload.name}|${payload.albumTitle}|${payload.albumArtist}`;
  }
  return '';
}

export function trackDuplicateKeyFromEntry(entry = {}) {
  const recordId    = typeof entry.trackRecordId === 'string' ? entry.trackRecordId.trim() : '';
  const name        = typeof entry.name          === 'string' ? entry.name.trim()          : '';
  const albumTitle  = typeof entry.albumTitle    === 'string' ? entry.albumTitle.trim()    : '';
  const albumArtist = typeof entry.albumArtist   === 'string' ? entry.albumArtist.trim()   : '';
  return trackDuplicateKey({ recordId, name, albumTitle, albumArtist });
}

export function summarizeTrackPayload(payload = {}) {
  return {
    recordId:    payload.recordId    || null,
    name:        payload.name        || '',
    albumTitle:  payload.albumTitle  || '',
    albumArtist: payload.albumArtist || '',
    seq:         Number.isFinite(payload.seq) ? payload.seq : null
  };
}

export function buildTrackEntry(payload, addedAt) {
  return {
    id:            randomUUID(),
    trackRecordId: payload.recordId  || null,
    name:          payload.name,
    albumTitle:    payload.albumTitle,
    albumArtist:   payload.albumArtist,
    catalogue:     payload.catalogue,
    trackArtist:   payload.trackArtist,
    mp3:           payload.mp3,
    resolvedSrc:   payload.resolvedSrc,
    seq:           Number.isFinite(payload.seq) ? payload.seq : null,
    artwork:       payload.artwork,
    audioField:    payload.audioField,
    artworkField:  payload.artworkField,
    addedAt
  };
}

export function buildPlaylistDuplicateIndex(playlist) {
  const map = new Map();
  const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
  for (const entry of tracks) {
    const key = trackDuplicateKeyFromEntry(entry);
    if (key && !map.has(key)) map.set(key, entry);
  }
  return map;
}

export function resolveDuplicate(map, payload) {
  const key = trackDuplicateKey(payload);
  if (!key) return { key: '', entry: null };
  return { key, entry: map.get(key) || null };
}
