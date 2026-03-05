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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Local helpers
const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');
const normalizeShareId = (value) => (typeof value === 'string' ? value.trim() : '');

// ============================================================================
// FILE PATHS
// ============================================================================

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLAYLISTS_PATH = path.join(DATA_DIR, 'playlists.json');
const ACCESS_TOKENS_PATH = path.join(DATA_DIR, 'access-tokens.json');
const LIBRARY_PATH = path.join(DATA_DIR, 'library.json');

const FM_USERS_LAYOUT = process.env.FM_USERS_LAYOUT || 'API_Users';

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
    } catch (parseErr) {
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

    const data = Array.isArray(parsed) ? parsed : [];

    // Migrate legacy numeric userId values to email addresses.
    // All FM lookups run concurrently via Promise.all instead of sequentially.
    const needsMigration = data.filter(
      entry => entry && typeof entry === 'object' && entry.userId && /^\d+$/.test(String(entry.userId))
    );

    // Strip legacy email field from all entries regardless of migration
    for (const entry of data) {
      if (entry && typeof entry === 'object') delete entry.userEmail;
    }

    let migrated = false;
    if (needsMigration.length) {
      await Promise.all(needsMigration.map(async (entry) => {
        try {
          const record = await fmGetRecordById(FM_USERS_LAYOUT, entry.userId);
          if (record) {
            const email = normalizeEmail(record.fieldData?.Email || '');
            if (email) {
              console.log(`[MASS] Migrating playlist "${entry.name}" from userId=${entry.userId} to email=${email}`);
              entry.userId = email;
              migrated = true;
            }
          }
        } catch (err) {
          console.warn(`[MASS] Could not migrate playlist "${entry.name}" (userId=${entry.userId}):`, err?.message || err);
        }
      }));
    }

    if (migrated) {
      try { await savePlaylists(data); } catch (err) { console.warn('[MASS] Failed to save migrated playlists:', err); }
    }

    playlistsCache = { data, mtimeMs: stat.mtimeMs };
    return data;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await ensureDataDir();
      await fs.writeFile(PLAYLISTS_PATH, '[]', 'utf8');
      playlistsCache = { data: [], mtimeMs: Date.now() };
      return playlistsCache.data;
    }
    console.warn('[MASS] Failed to read playlists file:', err);
    return Array.isArray(playlistsCache.data) ? playlistsCache.data : [];
  }
}

export async function savePlaylists(playlists) {
  try {
    await ensureDataDir();
    const normalized = Array.isArray(playlists) ? playlists : [];
    for (const entry of normalized) {
      if (entry && typeof entry === 'object') {
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
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${LIBRARY_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tempPath, LIBRARY_PATH);
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
    } catch (parseErr) {
      console.warn('[MASS] Access tokens file contained invalid JSON, resetting to default:', parseErr);
      const defaultData = {
        tokens: [
          {
            code: 'MASS-UNLIMITED-ACCESS',
            type: 'unlimited',
            issuedDate: new Date().toISOString(),
            expirationDate: null,
            notes: 'Master cheat token - never expires'
          }
        ]
      };
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
    if (err && err.code === 'ENOENT') {
      await ensureDataDir();
      const defaultData = {
        tokens: [
          {
            code: 'MASS-UNLIMITED-ACCESS',
            type: 'unlimited',
            issuedDate: new Date().toISOString(),
            expirationDate: null,
            notes: 'Master cheat token - never expires'
          }
        ]
      };
      await fs.writeFile(ACCESS_TOKENS_PATH, JSON.stringify(defaultData, null, 2), 'utf8');
      accessTokensCache = { data: defaultData, mtimeMs: Date.now() };
      return defaultData;
    }
    console.warn('[MASS] Failed to read access tokens file:', err);
    return accessTokensCache.data || { tokens: [] };
  }
}

export async function saveAccessTokens(tokenData) {
  try {
    await ensureDataDir();
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

  // Save to JSON file
  const tokenData = await loadAccessTokens();
  tokenData.tokens.push(token);
  await saveAccessTokens(tokenData);

  // Attempt to create in FileMaker (async, non-blocking)
  try {
    const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
    const durationSeconds = days * 24 * 60 * 60;
    const fmFields = {
      'Token_Code': code,
      'Token_Type': 'trial',
      'Active': 1,
      'Token_Duration_Hours': String(durationSeconds),
      'Notes': token.notes
    };
    if (token.email) fmFields['Email'] = token.email;
    await fmCreateRecord(layout, fmFields);
    console.log(`[MASS] Payment token ${code} synced to FileMaker`);
  } catch (err) {
    console.warn(`[MASS] Failed to sync payment token ${code} to FileMaker (JSON fallback active):`, err?.message || err);
  }

  console.log(`[MASS] Created access token ${code} (${days} days, expires ${expirationDate.toISOString()})`);
  return token;
}
