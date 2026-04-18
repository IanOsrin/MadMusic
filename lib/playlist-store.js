/**
 * lib/playlist-store.js — Playlist storage, backed by FileMaker (API_Playlists layout).
 * Each playlist is a separate FM record. Tracks are stored as a JSON blob in Songs_JSON.
 *
 * FM layout: API_Playlists (env: FM_PLAYLISTS_LAYOUT)
 * Fields: Playlist_ID, User_Email, Name, Artwork, Songs_JSON,
 *         Share_ID, Shared_At, Created_At, Updated_At
 */

import 'dotenv/config';
import { fmFindRecords, fmCreateRecord, fmUpdateRecord, fmDeleteRecord } from '../fm-client.js';
import { normalizeShareId } from './format.js';

const FM_PLAYLISTS_LAYOUT = process.env.FM_PLAYLISTS_LAYOUT || 'API_Playlists';

// ── Timestamp helpers ─────────────────────────────────────────────────────────
// FM Timestamp fields expect MM/DD/YYYY HH:MM:SS; Text fields accept ISO strings.
// We write FM-format and normalise on read so both field types work.

function toFMTimestamp(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ` +
         `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fromFMTimestamp(value) {
  if (!value) return null;
  const d = new Date(value); // parses both ISO and MM/DD/YYYY HH:MM:SS
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Record serialisation ──────────────────────────────────────────────────────

/** Converts a JS playlist object to FM field data for create/update. */
function playlistToFMFields(playlist) {
  const fields = {};
  if (playlist.id        !== undefined) fields['Playlist_ID'] = playlist.id;
  if (playlist.userId    !== undefined) fields['User_Email']  = playlist.userId;
  if (playlist.name      !== undefined) fields['Name']        = playlist.name;
  if (playlist.artwork   !== undefined) fields['Artwork']     = playlist.artwork || '';
  if (playlist.tracks    !== undefined) fields['Songs_JSON']  = JSON.stringify(playlist.tracks ?? []);
  if (playlist.shareId   !== undefined) fields['Share_ID']    = normalizeShareId(playlist.shareId) || '';
  if (playlist.sharedAt  !== undefined) fields['Shared_At']   = toFMTimestamp(playlist.sharedAt);
  if (playlist.createdAt !== undefined) fields['Created_At']  = toFMTimestamp(playlist.createdAt);
  if (playlist.updatedAt !== undefined) fields['Updated_At']  = toFMTimestamp(playlist.updatedAt);
  return fields;
}

/** Converts an FM record to a JS playlist object. */
function fmRecordToPlaylist(record) {
  const f = record.fieldData || {};
  let tracks = [];
  try { tracks = JSON.parse(f['Songs_JSON'] || '[]'); } catch { tracks = []; }
  return {
    id:        f['Playlist_ID']  || '',
    userId:    f['User_Email']   || '',
    name:      f['Name']         || '',
    artwork:   f['Artwork']      || '',
    tracks,
    shareId:   normalizeShareId(f['Share_ID']) || null,
    sharedAt:  fromFMTimestamp(f['Shared_At']),
    createdAt: fromFMTimestamp(f['Created_At']),
    updatedAt: fromFMTimestamp(f['Updated_At']),
    _fmRecordId: record.recordId  // internal — needed for update/delete
  };
}

// ── Exported API ──────────────────────────────────────────────────────────────

/** Load all playlists for a given user email. */
export async function loadUserPlaylists(email) {
  const result = await fmFindRecords(
    FM_PLAYLISTS_LAYOUT,
    [{ 'User_Email': `==${email}` }],
    { limit: 500, sort: [{ fieldName: 'Created_At', sortOrder: 'ascend' }] }
  );
  if (!result?.data?.length) return [];
  return result.data.map(fmRecordToPlaylist);
}

/**
 * Load a single playlist by its Playlist_ID.
 * If email is provided, ownership is enforced (returns null if mismatch).
 */
export async function loadPlaylistById(playlistId, email = null) {
  const query = [{ 'Playlist_ID': `==${playlistId}` }];
  const result = await fmFindRecords(FM_PLAYLISTS_LAYOUT, query, { limit: 1 });
  if (!result?.data?.length) return null;
  const playlist = fmRecordToPlaylist(result.data[0]);
  if (email && playlist.userId.toLowerCase() !== email.toLowerCase()) return null;
  return playlist;
}

/** Load a playlist by its Share_ID (no ownership check — used for public share endpoints). */
export async function loadPlaylistByShareId(shareId) {
  const normalised = normalizeShareId(shareId);
  if (!normalised) return null;
  const result = await fmFindRecords(
    FM_PLAYLISTS_LAYOUT,
    [{ 'Share_ID': `==${normalised}` }],
    { limit: 1 }
  );
  if (!result?.data?.length) return null;
  return fmRecordToPlaylist(result.data[0]);
}

/** Check whether a Share_ID is already taken. */
export async function isShareIdTaken(shareId) {
  const normalised = normalizeShareId(shareId);
  if (!normalised) return false;
  const result = await fmFindRecords(
    FM_PLAYLISTS_LAYOUT,
    [{ 'Share_ID': `==${normalised}` }],
    { limit: 1 }
  );
  return Boolean(result?.data?.length);
}

/** Create a new playlist record in FM. Returns the full playlist object including _fmRecordId. */
export async function createPlaylist(playlist) {
  const fields = playlistToFMFields(playlist);
  await fmCreateRecord(FM_PLAYLISTS_LAYOUT, fields);
  // Reload to get the FM recordId
  return loadPlaylistById(playlist.id);
}

/**
 * Update specific fields on an existing playlist.
 * Pass the JS property names; the function maps them to FM field names.
 */
export async function updatePlaylist(fmRecordId, changes) {
  if (!fmRecordId) throw new Error('updatePlaylist requires fmRecordId');
  const fields = playlistToFMFields(changes);
  await fmUpdateRecord(FM_PLAYLISTS_LAYOUT, fmRecordId, fields);
}

/** Delete a playlist record from FM. */
export async function deletePlaylist(fmRecordId) {
  if (!fmRecordId) throw new Error('deletePlaylist requires fmRecordId');
  await fmDeleteRecord(FM_PLAYLISTS_LAYOUT, fmRecordId);
}
