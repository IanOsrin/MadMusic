/**
 * lib/auth.js — Access token validation and session auth middleware.
 * Dependencies: fm-client.js, cache.js, store.js, lib/format.js, lib/http.js
 */

import { fmFindRecords, fmUpdateRecord } from '../fm-client.js';
import { getAccessTokensCacheData } from './token-store.js';
import { normalizeEmail } from './format.js';
import { fmExactMatch } from './validators.js';

// ── Session constants ─────────────────────────────────────────────────────────
export const MASS_SESSION_COOKIE          = 'mass.sid';
export const MASS_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

// ── Usage-stat write throttle ───────────────────────────────────────────────
// validateAccessToken fires a fire-and-forget fmUpdateRecord to bump
// Last_Used/Use_Count on every successful validation. During a cold-start burst
// that adds one FM PATCH per request, doubling FM queue pressure on the path
// that's already jammed. These stats are non-critical and eventually-consistent,
// so we throttle them to at most once per token per window. The throttle is
// BYPASSED when a sessionId is present (the /access path needs fresh
// Session_Last_Activity for device-conflict detection) and when First_Used must
// be set (first use stamps Expiration_Date — that write must not be skipped).
const USAGE_WRITE_THROTTLE_MS = Number.parseInt(process.env.USAGE_WRITE_THROTTLE_MS, 10) || 5 * 60 * 1000;
const lastUsageWriteAt = new Map(); // recordId -> timestamp(ms)

function shouldWriteUsageStats(recordId) {
  const now = Date.now();
  const last = lastUsageWriteAt.get(recordId) || 0;
  if (now - last < USAGE_WRITE_THROTTLE_MS) return false;
  lastUsageWriteAt.set(recordId, now);
  return true;
}

// ── Token validation ──────────────────────────────────────────────────────────

export function validateAccessTokenFromJSON(tokenCode) {
  if (!tokenCode || typeof tokenCode !== 'string') {
    return { valid: false, reason: 'No token provided' };
  }

  const trimmedCode = tokenCode.trim().toUpperCase();
  const tokenData   = getAccessTokensCacheData() || { tokens: [] };
  const token       = tokenData.tokens.find(t =>
    t.code?.trim().toUpperCase() === trimmedCode
  );

  if (!token) return { valid: false, reason: 'Invalid token' };

  // If this token was previously written to FM (fmSynced=true) but we are
  // validating from JSON, FM is unreachable or the token has been removed from FM.
  if (token.fmSynced === true) {
    console.warn(`[MASS] Token ${trimmedCode.slice(0, 8)}… is flagged fmSynced but was not found in FileMaker — FM may be unreachable`);
  }

  if (token.expirationDate) {
    const expirationTime = new Date(token.expirationDate).getTime();
    if (Date.now() > expirationTime) {
      return { valid: false, reason: 'Token expired', expirationDate: token.expirationDate };
    }
  }

  return {
    valid:          true,
    type:           token.type || 'valid',
    expirationDate: token.expirationDate,
    issuedDate:     token.issuedDate,
    notes:          token.notes,
    email:          token.email ? normalizeEmail(token.email) : null
  };
}

function checkTokenExpired(token, trimmedCode) {
  if (!token.Expiration_Date) return null;
  const fmTimezoneOffset = Number.parseFloat(process.env.FM_TIMEZONE_OFFSET || '0');
  const offsetMs = fmTimezoneOffset * 60 * 60 * 1000;
  const expirationTime = new Date(token.Expiration_Date).getTime() - offsetMs;
  const now = Date.now();
  if (process.env.TOKEN_DEBUG === 'true') {
    console.log(`[MASS] Token expiration check for ${trimmedCode}:`);
    console.log(`  Raw expiration from FM: "${token.Expiration_Date}"`);
    console.log(`  FM Timezone offset: ${fmTimezoneOffset > 0 ? '+' : ''}${fmTimezoneOffset} hours`);
    console.log(`  Adjusted to UTC: ${new Date(expirationTime).toISOString()}`);
    console.log(`  Current UTC time: ${new Date(now).toISOString()}`);
    console.log(`  Time until expiry: ${((expirationTime - now) / 1000 / 60 / 60).toFixed(2)} hours`);
  }
  if (Number.isNaN(expirationTime)) {
    console.warn(`[MASS] Could not parse expiration date: "${token.Expiration_Date}" - treating as no expiration`);
    return null;
  }
  if (now > expirationTime) {
    console.log(`[MASS] Token ${trimmedCode} is EXPIRED`);
    return { valid: false, definitive: true, reason: 'Token expired', expirationDate: token.Expiration_Date };
  }
  console.log(`[MASS] Token ${trimmedCode} is still valid`);
  return null;
}

// ── Concurrent sessions (2026-07-06) ─────────────────────────────────────────
// A token may be active on up to MAX_TOKEN_SESSIONS devices at once (Ian's
// policy: desktop + mobile + one more). Sessions live as a compact JSON array
// [{ id, at, dev }] in the EXISTING Current_Session_ID field — no FM schema
// change; a legacy plain-UUID value in that field is migrated on first read
// (it counts as one session, timestamped from Session_Last_Activity).
// `at` is epoch ms (server-written, no FM timezone ambiguity). A session goes
// stale after SESSION_TIMEOUT_MS of inactivity and its slot frees up.
// Concurrent validations from two devices race on the read-modify-write of
// the list; last-writer-wins is acceptable — the losing session re-registers
// on its next validate.
export const MAX_TOKEN_SESSIONS = Math.max(1, Number.parseInt(process.env.MAX_TOKEN_SESSIONS, 10) || 3);
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  if (/mobile|iphone|android/i.test(ua)) return 'mobile';
  return ua ? 'desktop' : 'unknown';
}

export function parseSessions(raw, legacyLastActivity) {
  const value = String(raw ?? '').trim();
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const list = JSON.parse(value);
      if (Array.isArray(list)) {
        return list.filter((s) => s && typeof s.id === 'string' && Number.isFinite(s.at));
      }
    } catch { /* fall through to legacy */ }
  }
  // Legacy single-session format: the field held one session id, with its
  // freshness in Session_Last_Activity (FM timestamp).
  const at = legacyLastActivity ? new Date(legacyLastActivity).getTime() : NaN;
  return [{ id: value, at: Number.isFinite(at) ? at : 0, dev: 'unknown' }];
}

/**
 * Evaluate + upsert a session against the token's session list.
 * Returns { conflict, sessions, activeCount } — when conflict is false,
 * `sessions` is the pruned list with this session upserted (ready to write).
 */
export function evaluateSessions({ raw, legacyLastActivity, sessionId, now = Date.now(), max = MAX_TOKEN_SESSIONS, device = 'unknown' }) {
  const pruned = parseSessions(raw, legacyLastActivity).filter((s) => (now - s.at) < SESSION_TIMEOUT_MS);
  const existing = pruned.find((s) => s.id === sessionId);
  if (existing) {
    existing.at = now;
    if (device !== 'unknown') existing.dev = device;
    return { conflict: false, sessions: pruned, activeCount: pruned.length };
  }
  if (pruned.length < max) {
    pruned.push({ id: sessionId, at: now, dev: device });
    return { conflict: false, sessions: pruned, activeCount: pruned.length };
  }
  return { conflict: true, sessions: pruned, activeCount: pruned.length };
}

/** Remove one session from the raw field value; returns the new list. */
export function removeSession(raw, legacyLastActivity, sessionId) {
  return parseSessions(raw, legacyLastActivity).filter((s) => s.id !== sessionId);
}

export const serializeSessions = (sessions) =>
  sessions.length ? JSON.stringify(sessions.map((s) => ({ id: s.id, at: s.at, dev: (s.dev || 'unknown').slice(0, 16) }))) : '';

function checkSessionConflict(token, sessionId, trimmedCode, req) {
  if (!sessionId) return null;
  const evaluated = evaluateSessions({
    raw: token.Current_Session_ID,
    legacyLastActivity: token.Session_Last_Activity,
    sessionId,
    device: deviceLabel(req?.headers?.['user-agent'])
  });
  if (evaluated.conflict) {
    console.log(`[MASS] Token ${trimmedCode} is at its ${MAX_TOKEN_SESSIONS}-device limit (${evaluated.activeCount} active sessions)`);
    return {
      result: { valid: false, definitive: true, reason: `Token is currently in use on ${evaluated.activeCount} other devices` }
    };
  }
  return { sessions: evaluated.sessions };
}

function buildTokenUpdateFields(token, sessionId, req, fmTimestamp, now, sessions) {
  const updateFields = {
    'Last_Used':  fmTimestamp,
    'Use_Count':  (Number.parseInt(token.Use_Count) || 0) + 1
  };
  if (sessionId) {
    // The full session list (JSON) lives in Current_Session_ID; the sibling
    // fields keep the LATEST device/activity for human visibility in FM.
    updateFields['Current_Session_ID']    = serializeSessions(sessions || [{ id: sessionId, at: now.getTime(), dev: 'unknown' }]);
    updateFields['Session_Last_Activity'] = fmTimestamp;
    if (req) {
      updateFields['Session_Device_Info'] = req.headers['user-agent'] || 'Unknown';
      updateFields['Session_IP']          = req.ip || req.connection?.remoteAddress || 'Unknown';
    }
  }
  let calculatedExpirationUTC = null;
  if (!token.First_Used || token.First_Used === '') {
    updateFields['First_Used'] = fmTimestamp;
    console.log(`[MASS] Setting First_Used for token`);
    const duration = Number.parseInt(token.Token_Duration_Hours);
    if (token.Token_Duration_Hours && duration > 0) {
      const expirationTime = new Date(now.getTime() + (duration * 1000));
      const fmExp = `${expirationTime.getMonth() + 1}/${expirationTime.getDate()}/${expirationTime.getFullYear()} ${expirationTime.getHours()}:${String(expirationTime.getMinutes()).padStart(2, '0')}:${String(expirationTime.getSeconds()).padStart(2, '0')}`;
      updateFields['Expiration_Date'] = fmExp;
      calculatedExpirationUTC         = expirationTime.toISOString();
    }
  }
  return { updateFields, calculatedExpirationUTC };
}

function resolveExpirationUTC(token, calculatedExpirationUTC) {
  if (calculatedExpirationUTC) return calculatedExpirationUTC;
  if (!token.Expiration_Date) return null;
  const fmTimezoneOffset = Number.parseFloat(process.env.FM_TIMEZONE_OFFSET || '0');
  const offsetMs = fmTimezoneOffset * 60 * 60 * 1000;
  const expirationTimeUTC = new Date(token.Expiration_Date).getTime() - offsetMs;
  return new Date(expirationTimeUTC).toISOString();
}

export async function validateAccessToken(tokenCode, sessionId = null, req = null) {
  if (!tokenCode || typeof tokenCode !== 'string') {
    return { valid: false, reason: 'No token provided' };
  }

  const trimmedCode = tokenCode.trim().toUpperCase();

  try {
    const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
    console.log(`[MASS] Looking up token "${trimmedCode}" in FileMaker layout "${layout}"`);

    const result = await fmFindRecords(layout, [
      { 'Token_Code': fmExactMatch(trimmedCode) }
    ], { limit: 1 });

    console.log(`[MASS] FileMaker token lookup result: ${result?.data?.length || 0} records found`);

    if (!result?.data?.length) {
      console.log('[MASS] Token not found in FileMaker, trying JSON fallback');
      return validateAccessTokenFromJSON(tokenCode);
    }

    const token = result.data[0].fieldData;

    if (token.Active === 0 || token.Active === '0') {
      return { valid: false, definitive: true, reason: 'Token disabled' };
    }

    const expiredResult = checkTokenExpired(token, trimmedCode);
    if (expiredResult) return expiredResult;

    const sessionCheck = checkSessionConflict(token, sessionId, trimmedCode, req);
    if (sessionCheck?.result) return sessionCheck.result;

    if (sessionId) console.log(`[MASS] Session ${sessionId} validated for token ${trimmedCode} (${sessionCheck?.sessions?.length || 1}/${MAX_TOKEN_SESSIONS} active)`);

    const recordId    = result.data[0].recordId;
    const now         = new Date();
    const fmTimestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const { updateFields, calculatedExpirationUTC } = buildTokenUpdateFields(token, sessionId, req, fmTimestamp, now, sessionCheck?.sessions);

    // Skip the non-critical usage-stat write when it's been written recently for
    // this token, EXCEPT when a session is being tracked (needs fresh activity)
    // or this is the token's first use (stamps Expiration_Date — must persist).
    const isFirstUse = Boolean(updateFields.First_Used);
    if (sessionId || isFirstUse || shouldWriteUsageStats(recordId)) {
      fmUpdateRecord(layout, recordId, updateFields).catch(err => {
        console.warn('[MASS] Failed to update token usage stats:', err);
      });
    }

    return {
      valid:            true,
      type:             token.Token_Type || 'valid',
      expirationDate:   resolveExpirationUTC(token, calculatedExpirationUTC),
      issuedDate:       token.Issued_Date,
      notes:            token.Notes,
      email:            normalizeEmail(token.Issued_To || token.Email || '') || null,
      audioLabEnabled:  token.Audio_Lab_Enabled === 1 || token.Audio_Lab_Enabled === '1',
      recordId:         result.data[0].recordId
    };
  } catch (err) {
    console.error('[MASS] FileMaker token validation error:', err);
    console.warn('[MASS] Falling back to JSON file for token validation');
    return validateAccessTokenFromJSON(tokenCode);
  }
}

// ── Express middleware helper ─────────────────────────────────────────────────

// Require a real email bound to the token. Previously this fell back to the
// mass.email cookie and then to the raw token code, which caused playlists and
// saved albums to be stored under "MASS-XXX-YYY" keys for any token whose FM
// Issued_To field was empty — orphaning the data permanently once the user
// finally added an email. New behaviour: only the FM-verified token email
// counts. If it's missing we return a 403 with requiresEmail=true so the
// frontend can show the email-capture modal instead of silently writing
// orphans.
export function requireTokenEmail(req, res) {
  const tokenEmail = req.accessToken?.email || null;
  if (!tokenEmail) {
    res.status(403).json({
      ok: false,
      error: 'Email required to use this feature',
      requiresEmail: true,
      requiresAccessToken: false
    });
    return null;
  }
  return { email: tokenEmail };
}
