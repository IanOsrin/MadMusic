/**
 * lib/token-store.js — Access token storage, generation, and FM sync.
 * FM (API_Access_Tokens layout) is the source of truth; the JSON file
 * (data/access-tokens.json) is a resilience cache for FM outages.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { fmCreateRecord } from '../fm-client.js';
import { acquireLock, releaseLock } from './file-lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR           = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ACCESS_TOKENS_PATH = path.join(DATA_DIR, 'access-tokens.json');

// ── In-memory cache ───────────────────────────────────────────────────────────

let accessTokensCache = { data: null, mtimeMs: 0 };

/** Exposes the in-memory token cache to auth.js (used by validateAccessTokenFromJSON). */
export function getAccessTokensCacheData() {
  return accessTokensCache.data;
}

// ── Read / Write ──────────────────────────────────────────────────────────────

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
    if (!Array.isArray(data.tokens)) data.tokens = [];

    accessTokensCache = { data, mtimeMs: stat.mtimeMs };
    return data;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      await fs.mkdir(DATA_DIR, { recursive: true });
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
    await fs.mkdir(DATA_DIR, { recursive: true });
    lockPath = await acquireLock(ACCESS_TOKENS_PATH);
    const normalized = tokenData && typeof tokenData === 'object' ? tokenData : { tokens: [] };
    if (!Array.isArray(normalized.tokens)) normalized.tokens = [];
    const payload  = JSON.stringify(normalized, null, 2);
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

// ── Token generation ──────────────────────────────────────────────────────────

export function generateTokenCode() {
  const bytes = randomBytes(6);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing chars: 0/O, 1/I
  let code = 'MASS-';
  for (let i = 0; i < bytes.length; i++) {
    if (i === 3) code += '-';
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

// ── Trial token helpers ───────────────────────────────────────────────────────

/**
 * Returns the first trial token found for a given email, or null.
 * Used to enforce one-trial-per-email.
 */
export async function findTrialTokenByEmail(email) {
  if (!email) return null;
  const normalised = email.trim().toLowerCase();
  const tokenData  = await loadAccessTokens();
  return tokenData.tokens.find(
    t => t.type === 'trial' && t.email && t.email.toLowerCase() === normalised
  ) || null;
}

// ── Subscription token helpers ────────────────────────────────────────────────

/**
 * Find a subscription token record by its Paystack subscription_code.
 * Searches the JSON cache first (fast), then returns null if not found.
 * Returns the full token object (including fmSynced flag) or null.
 */
export async function findSubscriptionToken(subscriptionCode) {
  if (!subscriptionCode) return null;
  const tokenData = await loadAccessTokens();
  return tokenData.tokens.find(
    t => t.type === 'subscription' && t.subscriptionCode === subscriptionCode
  ) || null;
}

/**
 * Find an active Telkom token by MSISDN.
 */
export async function findTelkomToken(msisdn) {
  if (!msisdn) return null;
  const tokenData = await loadAccessTokens();
  return tokenData.tokens.find(
    t => t.type === 'telkom' && t.notes?.includes(`msisdn: ${msisdn}`)
  ) || null;
}

/**
 * Create a new subscription token.
 * billingDays — how many days until next renewal (default 31 for monthly).
 */
export async function createSubscriptionToken(subscriptionCode, planCode, email, billingDays = 31) {
  const code        = generateTokenCode();
  const issuedDate  = new Date();
  const expiresDate = new Date(issuedDate);
  expiresDate.setDate(expiresDate.getDate() + billingDays);

  const notes = `Paystack subscription (${email}, sub: ${subscriptionCode}, plan: ${planCode})`;

  const token = {
    code,
    type:             'subscription',
    subscriptionCode: subscriptionCode || null,
    paystackPlanCode: planCode         || null,
    issuedDate:       issuedDate.toISOString(),
    expirationDate:   expiresDate.toISOString(),
    notes,
    email:            email || null
  };

  // Write to FileMaker
  const layout          = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
  const durationSeconds = billingDays * 24 * 60 * 60;
  const fmFields = {
    'Token_Code':           code,
    'Token_Type':           'subscription',
    'Active':               1,
    'Token_Duration_Hours': String(durationSeconds),
    'Notes':                notes
  };
  if (email) fmFields['Email'] = email;

  let fmSynced = false;
  try {
    await fmCreateRecord(layout, fmFields);
    fmSynced = true;
    console.log(`[MASS] Subscription token ${code} written to FileMaker`);
  } catch (err) {
    console.error(`[MASS] FM write failed for subscription token ${code}:`, err?.message || err);
  }

  const tokenData = await loadAccessTokens();
  tokenData.tokens.push({ ...token, fmSynced });
  await saveAccessTokens(tokenData);

  console.log(`[MASS] Created subscription token ${code} for sub ${subscriptionCode} (expires ${expiresDate.toISOString()})`);
  return token;
}

/**
 * Extend an existing subscription token's expiry on successful renewal.
 * Finds by subscriptionCode, adds billingDays from today (not from current expiry,
 * so a lapsed subscription always gets a clean window).
 * Returns the updated token or null if not found.
 */
export async function renewSubscriptionToken(subscriptionCode, billingDays = 31) {
  const tokenData    = await loadAccessTokens();
  const idx          = tokenData.tokens.findIndex(
    t => t.type === 'subscription' && t.subscriptionCode === subscriptionCode
  );
  if (idx === -1) {
    console.warn(`[MASS] renewSubscriptionToken: no token found for sub ${subscriptionCode}`);
    return null;
  }

  const token          = tokenData.tokens[idx];
  const newExpiry      = new Date();
  newExpiry.setDate(newExpiry.getDate() + billingDays);
  token.expirationDate = newExpiry.toISOString();

  tokenData.tokens[idx] = token;
  await saveAccessTokens(tokenData);

  // Also update FM
  try {
    const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
    const { fmFindRecords, fmUpdateRecord } = await import('../fm-client.js');
    const result = await fmFindRecords(layout, [{ 'Token_Code': `==${token.code}` }], { limit: 1 });
    if (result?.data?.length) {
      const recordId = result.data[0].recordId;
      // Format date for FM: "M/D/YYYY HH:MM:SS"
      const fmDate = `${newExpiry.getMonth() + 1}/${newExpiry.getDate()}/${newExpiry.getFullYear()} 00:00:00`;
      await fmUpdateRecord(layout, recordId, {
        'Expiration_Date': fmDate,
        'Active':          1,
        'Notes':           `${token.notes} [renewed ${new Date().toISOString().slice(0, 10)}]`
      });
      console.log(`[MASS] FM expiry extended for subscription token ${token.code}`);
    }
  } catch (err) {
    console.warn(`[MASS] FM renewal update failed for sub ${subscriptionCode} — JSON updated:`, err?.message || err);
  }

  console.log(`[MASS] Renewed subscription token ${token.code} → expires ${newExpiry.toISOString()}`);
  return token;
}

/**
 * Disable a subscription token after cancellation.
 * graceDays — keep access alive for this many extra days (default 3).
 */
export async function disableSubscriptionToken(subscriptionCode, graceDays = 3) {
  const tokenData = await loadAccessTokens();
  const idx       = tokenData.tokens.findIndex(
    t => t.type === 'subscription' && t.subscriptionCode === subscriptionCode
  );
  if (idx === -1) {
    console.warn(`[MASS] disableSubscriptionToken: no token found for sub ${subscriptionCode}`);
    return null;
  }

  const token     = tokenData.tokens[idx];
  const graceEnd  = new Date();
  graceEnd.setDate(graceEnd.getDate() + graceDays);

  // Extend expiry to grace period end, then let natural expiry cut access.
  // No need to set Active=0 — access stops when expiry passes.
  token.expirationDate = graceEnd.toISOString();
  token.notes          = `${token.notes} [cancelled, grace until ${graceEnd.toISOString().slice(0, 10)}]`;

  tokenData.tokens[idx] = token;
  await saveAccessTokens(tokenData);

  // Mirror in FM
  try {
    const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
    const { fmFindRecords, fmUpdateRecord } = await import('../fm-client.js');
    const result = await fmFindRecords(layout, [{ 'Token_Code': `==${token.code}` }], { limit: 1 });
    if (result?.data?.length) {
      const recordId = result.data[0].recordId;
      const fmDate   = `${graceEnd.getMonth() + 1}/${graceEnd.getDate()}/${graceEnd.getFullYear()} 00:00:00`;
      await fmUpdateRecord(layout, recordId, {
        'Expiration_Date': fmDate,
        'Notes':           token.notes
      });
    }
  } catch (err) {
    console.warn(`[MASS] FM disable update failed for sub ${subscriptionCode}:`, err?.message || err);
  }

  console.log(`[MASS] Subscription token ${token.code} grace period set to ${graceEnd.toISOString()}`);
  return token;
}

export async function createAccessToken(days, notes, email, type = 'valid') {
  const code = generateTokenCode();
  const issuedDate     = new Date();
  const expirationDate = new Date(issuedDate);
  expirationDate.setDate(expirationDate.getDate() + days);

  const token = {
    code,
    type,
    issuedDate:     issuedDate.toISOString(),
    expirationDate: expirationDate.toISOString(),
    notes:          notes || `${days}-day access (Paystack purchase)`
  };
  if (email && email !== 'unknown') token.email = email;

  // Write to FileMaker first — FM is the source of truth for token validation.
  // If FM is unreachable the token still works via JSON fallback, but will not get
  // session tracking or usage stats until it is manually re-synced to FM.
  const layout          = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
  const durationSeconds = days * 24 * 60 * 60;
  const fmFields = {
    'Token_Code':           code,
    'Token_Type':           type,
    'Active':               1,
    'Token_Duration_Hours': String(durationSeconds), // FM field stores seconds despite the name
    'Notes':                token.notes
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

// ── Manual resync ─────────────────────────────────────────────────────────────

/**
 * Finds every token in the JSON store with fmSynced=false and attempts to
 * create the missing record in FileMaker.  Marks each token fmSynced=true
 * on success, leaves it false on failure so it can be retried.
 *
 * Returns { attempted, synced, failed, errors }.
 */
export async function resyncUnsyncedTokens() {
  const layout    = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
  const tokenData = await loadAccessTokens();
  const pending   = tokenData.tokens.filter(t => !t.fmSynced);

  if (pending.length === 0) {
    return { attempted: 0, synced: 0, failed: 0, errors: [] };
  }

  let synced = 0;
  const errors = [];

  for (const token of pending) {
    try {
      // Reconstruct duration in seconds from stored ISO dates
      const issued  = new Date(token.issuedDate);
      const expires = new Date(token.expirationDate);
      const durationSeconds = Math.round((expires - issued) / 1000);

      const fmFields = {
        'Token_Code':           token.code,
        'Token_Type':           token.type || 'trial',
        'Active':               1,
        'Token_Duration_Hours': String(durationSeconds),
        'Notes':                token.notes || ''
      };
      if (token.email) fmFields['Email'] = token.email;

      await fmCreateRecord(layout, fmFields);

      // Mark synced in the live array
      token.fmSynced = true;
      synced++;
      console.log(`[MASS] Resync: token ${token.code} written to FileMaker`);
    } catch (err) {
      const msg = err?.message || String(err);
      errors.push({ code: token.code, error: msg });
      console.error(`[MASS] Resync: failed to write ${token.code} to FileMaker — ${msg}`);
    }
  }

  // Persist the updated fmSynced flags back to JSON
  await saveAccessTokens(tokenData);

  return {
    attempted: pending.length,
    synced,
    failed:    pending.length - synced,
    errors
  };
}
