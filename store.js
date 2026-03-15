// ============================================================================
// store.js — File-based data storage
// Manages playlists, access tokens, and user library via JSON files.
// Imported by server.js.
// ============================================================================

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { fmGetRecordById, fmCreateRecord } from './fm-client.js';
import { normalizeEmail, normalizeShareId } from './lib/format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// FILE PATHS
// ============================================================================

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLAYLISTS_PATH = path.join(DATA_DIR, 'playlists.json');
const ACCESS_TOKENS_PATH = path.join(DATA_DIR, 'access-tokens.json');
const LIBRARY_PATH = path.join(DATA_DIR, 'library.json');

const FM_USERS_LAYOUT = process.env.FM_USERS_LAYOUT || 'API_Users';

// ============================================================================
// CROSS-PROCESS WRITE LOCK (lockfile-based)
// Prevents concurrent writes from multiple cluster workers corrupting data files.
// Uses O_EXCL (fail-if-exists) to create an advisory lockfile atomically.
// Stale locks older than LOCK_STALE_MS are automatically broken.
// ============================================================================

const LOCK_STALE_MS = 10_000; // treat lock as stale after 10 seconds
const LOCK_RETRY_INTERVAL_MS = 30;
const LOCK_TIMEOUT_MS = 8_000;

async function acquireLock(targetPath) {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      // O_EXCL: fails atomically if file already exists — no TOCTOU race
      const fh = await fs.open(lockPath, 'wx');
      await fh.close();
      return lockPath; // caller must pass this to releaseLock()
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Check if the existing lock is stale (e.g. process crashed mid-write)
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue; // retry immediately after breaking stale lock
        }
      } catch {
        // lock was already removed between our check and stat — retry
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`[MASS] Write lock timeout for ${targetPath} — another process may be stuck`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
    }
  }
}

async function releaseLock(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch {
    // ignore: lock may have already been cleaned up
  }
}

// ============================================================================
// INTERNAL CACHE STATE
// ============================================================================

let playlistsCache = { data: null, mtimeMs: 0 };
let accessTokensCache = { data: null, mtimeMs: 0 };

// Exposes the in-memory token cache data to server.js (used by validateAccessTokenFromJSON)
export function getAccessTokensCacheData() {
  return accessTokensCache.data;
}

// ============================================================================
// HELPERS
// ============================================================================

export async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn('[MASS] Failed to ensure data directory exists:', err);
  }
}

// ============================================================================
// PLAYLIST STORAGE
// ============================================================================

async function repairCorruptedPlaylistsFile(parseErr) {
  console.warn('[MASS] Playlists file contained invalid JSON, resetting to empty list:', parseErr);
  await fs.writeFile(PLAYLISTS_PATH, '[]', 'utf8');
  let repairedMtime = Date.now();
  try {
    const repairedStat = await fs.stat(PLAYLISTS_PATH);
    if (repairedStat?.mtimeMs) repairedMtime = repairedStat.mtimeMs;
  } catch {
    // ignore stat errors; continue with Date.now()
  }
  playlistsCache = { data: [], mtimeMs: repairedMtime };
  return playlistsCache.data;
}

async function migrateNumericUserIds(data) {
  // Strip legacy email field from all entries regardless of migration
  for (const entry of data) {
    if (entry && typeof entry === 'object') delete entry.userEmail;
  }
  const needsMigration = data.filter(
    entry => entry && typeof entry === 'object' && entry.userId && /^\d+$/.test(String(entry.userId))
  );
  if (!needsMigration.length) return false;
  // All FM lookups run concurrently via Promise.all instead of sequentially.
  await Promise.all(needsMigration.map(async (entry) => {
    try {
      const record = await fmGetRecordById(FM_USERS_LAYOUT, entry.userId);
      if (record) {
        const email = normalizeEmail(record.fieldData?.Email || '');
        if (email) {
          console.log(`[MASS] Migrating playlist "${entry.name}" from userId=${entry.userId} to email=${email}`);
          entry.userId = email;
        }
      }
    } catch (err) {
      console.warn(`[MASS] Could not migrate playlist "${entry.name}" (userId=${entry.userId}):`, err?.message || err);
    }
  }));
  return true;
}

export async function loadPlaylists() {
  try {
    const stat = await fs.stat(PLAYLISTS_PATH);
    if (Array.isArray(playlistsCache.data) && playlistsCache.mtimeMs === stat.mtimeMs) {
      return playlistsCache.data;
    }

    const raw = await fs.readFile(PLAYLISTS_PATH, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error_) {
      return repairCorruptedPlaylistsFile(error_);
    }

    const data = Array.isArray(parsed) ? parsed : [];
    const migrated = await migrateNumericUserIds(data);
    if (migrated) {
      try { await savePlaylists(data); } catch (err) { console.warn('[MASS] Failed to save migrated playlists:', err); }
    }

    playlistsCache = { data, mtimeMs: stat.mtimeMs };
    return data;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      await ensureDataDir();
      await fs.writeFile(PLAYLISTS_PATH, '[]', 'utf8');
      playlistsCache = { data: [], mtimeMs: Date.now() };
      return playlistsCache.data;
    }
    console.warn('[MASS] Failed to read playlists file:', err);
    return Array.isArray(playlistsCache.data) ? playlistsCache.data : [];
  }
}

function normalizePlaylistEntry(entry) {
  if (!entry || typeof entry !== 'object') return;
  if (entry.userId) entry.userId = String(entry.userId).trim();
  delete entry.userEmail;
  const shareId = normalizeShareId(entry.shareId);
  if (shareId) {
    entry.shareId = shareId;
  } else {
    delete entry.shareId;
    if (entry.sharedAt) entry.sharedAt = null;
  }
}

export async function savePlaylists(playlists) {
  let lockPath;
  try {
    await ensureDataDir();
    lockPath = await acquireLock(PLAYLISTS_PATH);
    const normalized = Array.isArray(playlists) ? playlists : [];
    for (const entry of normalized) {
      normalizePlaylistEntry(entry);
    }
    const payload = JSON.stringify(normalized, null, 2);
    const tempPath = `${PLAYLISTS_PATH}.tmp`;
    await fs.writeFile(tempPath, payload, 'utf8');
    await fs.rename(tempPath, PLAYLISTS_PATH);
    let mtimeMs = Date.now();
    try {
      const stat = await fs.stat(PLAYLISTS_PATH);
      if (stat?.mtimeMs) mtimeMs = stat.mtimeMs;
    } catch {
      // ignore stat errors; fall back to Date.now()
    }
    playlistsCache = { data: normalized, mtimeMs };
  } catch (err) {
    console.error('[MASS] Failed to write playlists file:', err);
    throw err;
  } finally {
    if (lockPath) await releaseLock(lockPath);
  }
}

// ============================================================================
// LIBRARY STORAGE
// ============================================================================

export async function loadLibrary() {
  try {
    const raw = await fs.readFile(LIBRARY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveLibrary(data) {
  let lockPath;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    lockPath = await acquireLock(LIBRARY_PATH);
    const tempPath = `${LIBRARY_PATH}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tempPath, LIBRARY_PATH);
  } finally {
    if (lockPath) await releaseLock(lockPath);
  }
}

export function getUserLibrary(library, email) {
  if (!library[email]) library[email] = { songs: [], albums: [] };
  if (!Array.isArray(library[email].songs)) library[email].songs = [];
  if (!Array.isArray(library[email].albums)) library[email].albums = [];
  return library[email];
}

// ============================================================================
// ACCESS TOKEN STORAGE
// ============================================================================

export async function loadAccessTokens() {
  try {
    const stat = await fs.stat(ACCESS_TOKENS_PATH);
    if (accessTokensCache.data && accessTokensCache.mtimeMs === stat.mtimeMs) {
      return accessTokensCache.data;
    }

    const raw = await fs.readFile(ACCESS_TOKENS_PATH, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error_) {
      console.warn('[MASS] Access tokens file contained invalid JSON, resetting to empty list:', error_);
      const defaultData = { tokens: [] };
      await fs.writeFile(ACCESS_TOKENS_PATH, JSON.stringify(defaultData, null, 2), 'utf8');
      accessTokensCache = { data: defaultData, mtimeMs: Date.now() };
      return defaultData;
    }

    const data = parsed && typeof parsed === 'object' ? parsed : { tokens: [] };
    if (!Array.isArray(data.tokens)) {
      data.tokens = [];
    }

    accessTokensCache = { data, mtimeMs: stat.mtimeMs };
    return data;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      await ensureDataDir();
      const defaultData = { tokens: [] };
      await fs.writeFile(ACCESS_TOKENS_PATH, JSON.stringify(defaultData, null, 2), 'utf8');
      accessTokensCache = { data: defaultData, mtimeMs: Date.now() };
      return defaultData;
    }
    console.warn('[MASS] Failed to read access tokens file:', err);
    return accessTokensCache.data || { tokens: [] };
  }
}

export async function saveAccessTokens(tokenData) {
  let lockPath;
  try {
    await ensureDataDir();
    lockPath = await acquireLock(ACCESS_TOKENS_PATH);
    const normalized = tokenData && typeof tokenData === 'object' ? tokenData : { tokens: [] };
    if (!Array.isArray(normalized.tokens)) {
      normalized.tokens = [];
    }
    const payload = JSON.stringify(normalized, null, 2);
    const tempPath = `${ACCESS_TOKENS_PATH}.tmp`;
    await fs.writeFile(tempPath, payload, 'utf8');
    await fs.rename(tempPath, ACCESS_TOKENS_PATH);
    let mtimeMs = Date.now();
    try {
      const stat = await fs.stat(ACCESS_TOKENS_PATH);
      if (stat?.mtimeMs) mtimeMs = stat.mtimeMs;
    } catch {
      // ignore stat errors; fall back to Date.now()
    }
    accessTokensCache = { data: normalized, mtimeMs };
  } catch (err) {
    console.error('[MASS] Failed to write access tokens file:', err);
    throw err;
  } finally {
    if (lockPath) await releaseLock(lockPath);
  }
}

// ============================================================================
// TOKEN GENERATION
// ============================================================================

export function generateTokenCode() {
  const bytes = randomBytes(6);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing chars like 0/O, 1/I
  let code = 'MASS-';
  for (let i = 0; i < bytes.length; i++) {
    if (i === 3) code += '-';
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

export async function createAccessToken(days, notes, email) {
  const code = generateTokenCode();
  const issuedDate = new Date();
  const expirationDate = new Date(issuedDate);
  expirationDate.setDate(expirationDate.getDate() + days);

  const token = {
    code,
    type: 'trial',
    issuedDate: issuedDate.toISOString(),
    expirationDate: expirationDate.toISOString(),
    notes: notes || `${days}-day access (Paystack purchase)`
  };
  if (email && email !== 'unknown') token.email = email;

  // Write to FileMaker first — FM is the source of truth for token validation.
  // If FM is unreachable the token still works via JSON fallback, but will not get
  // session tracking or usage stats until it is manually re-synced to FM.
  const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
  const durationSeconds = days * 24 * 60 * 60;
  const fmFields = {
    'Token_Code': code,
    'Token_Type': 'trial',
    'Active': 1,
    'Token_Duration_Hours': String(durationSeconds), // FM field stores seconds despite the name
    'Notes': token.notes
  };
  if (token.email) fmFields['Email'] = token.email;

  let fmSynced = false;
  try {
    await fmCreateRecord(layout, fmFields);
    fmSynced = true;
    console.log(`[MASS] Token ${code} written to FileMaker`);
  } catch (err) {
    console.error(`[MASS] FileMaker write failed for token ${code} — JSON fallback will be used for validation:`, err?.message || err);
  }

  // Always cache to JSON for offline / FM-outage resilience.
  // fmSynced=false flags tokens that exist only in JSON so they can be re-synced later.
  const tokenData = await loadAccessTokens();
  tokenData.tokens.push({ ...token, fmSynced });
  await saveAccessTokens(tokenData);

  console.log(`[MASS] Created access token ${code} (${days} days, expires ${expirationDate.toISOString()}, fmSynced=${fmSynced})`);
  return token;
}
