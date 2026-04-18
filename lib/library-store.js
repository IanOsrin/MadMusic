/**
 * lib/library-store.js — User library storage, backed by FileMaker (API_Library layout).
 * One record per user; songs and albums stored as JSON blobs.
 *
 * FM layout: API_Library (env: FM_LIBRARY_LAYOUT)
 * Fields: Library_ID, User_Email, Songs_JSON, Albums_JSON, Updated_At
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { fmFindRecords, fmCreateRecord, fmUpdateRecord } from '../fm-client.js';

const FM_LIBRARY_LAYOUT = process.env.FM_LIBRARY_LAYOUT || 'API_Library';

// ── Timestamp helper ──────────────────────────────────────────────────────────

function toFMTimestamp(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ` +
         `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * Find the FM record for a user's library.
 * Returns { fmRecordId, songs, albums } or null if no record exists yet.
 */
async function findLibraryRecord(email) {
  const result = await fmFindRecords(
    FM_LIBRARY_LAYOUT,
    [{ 'User_Email': `==${email}` }],
    { limit: 1 }
  );
  if (!result?.data?.length) return null;
  const record = result.data[0];
  const f = record.fieldData || {};
  return {
    fmRecordId: record.recordId,
    songs:      parseJsonField(f['Songs_JSON'],  []),
    albums:     parseJsonField(f['Albums_JSON'], [])
  };
}

// ── Per-user write mutex ──────────────────────────────────────────────────────
//
// The library is a single FM record containing two JSON blob fields. Any
// read-modify-write (load → mutate → save) is non-atomic at the FM level, so
// two concurrent requests for the same user (e.g. two open tabs) can both read
// the same stale snapshot and the second writer silently overwrites the first.
//
// We serialise all writes for a given email using a simple promise-chain mutex.
// Because the server process is single-threaded (per worker), this is sufficient
// to eliminate intra-worker races. Cross-worker races (in cluster mode) remain
// possible but are low probability and would require FM-level transactions to
// solve — tracked separately.

const _userLocks = new Map(); // email → Promise

function withUserLock(email, fn) {
  const prior   = _userLocks.get(email) ?? Promise.resolve();
  const current = prior.then(fn).finally(() => {
    if (_userLocks.get(email) === current) _userLocks.delete(email);
  });
  _userLocks.set(email, current);
  return current;
}

// ── Exported API ──────────────────────────────────────────────────────────────

/**
 * Load a user's library. Returns { songs, albums }.
 * Read-only — does not acquire the write lock.
 */
export async function loadUserLibrary(email) {
  const record = await findLibraryRecord(email);
  if (record) return { songs: record.songs, albums: record.albums };
  return { songs: [], albums: [] };
}

/**
 * Persist a user's library back to FM.
 * Upserts: creates a new record if none exists, otherwise updates in place.
 * Prefer updateUserLibrary() for read-modify-write operations.
 */
export async function saveUserLibrary(email, { songs = [], albums = [] } = {}) {
  const now    = toFMTimestamp(new Date().toISOString());
  const record = await findLibraryRecord(email);

  if (record) {
    await fmUpdateRecord(FM_LIBRARY_LAYOUT, record.fmRecordId, {
      'Songs_JSON':  JSON.stringify(songs),
      'Albums_JSON': JSON.stringify(albums),
      'Updated_At':  now
    });
  } else {
    await fmCreateRecord(FM_LIBRARY_LAYOUT, {
      'Library_ID':  randomUUID(),
      'User_Email':  email,
      'Songs_JSON':  JSON.stringify(songs),
      'Albums_JSON': JSON.stringify(albums),
      'Updated_At':  now
    });
  }
}

/**
 * Atomically read-modify-write a user's library under a per-user mutex.
 *
 * mutatorFn receives { songs, albums } and must return the modified
 * { songs, albums } (plus any extra keys you want surfaced to the caller).
 * The return value of mutatorFn is forwarded as the resolved value.
 *
 * Example:
 *   const { song } = await updateUserLibrary(email, ({ songs, albums }) => {
 *     const song = { id: randomUUID(), ... };
 *     songs.push(song);
 *     return { songs, albums, song };
 *   });
 */
export function updateUserLibrary(email, mutatorFn) {
  return withUserLock(email, async () => {
    const { songs, albums } = await loadUserLibrary(email);
    const result = await mutatorFn({ songs, albums });
    await saveUserLibrary(email, { songs: result.songs, albums: result.albums });
    return result;
  });
}
