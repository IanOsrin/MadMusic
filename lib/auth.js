/**
 * lib/auth.js — Access token validation and session auth middleware.
 * Dependencies: fm-client.js, cache.js, store.js, lib/format.js, lib/http.js
 */

import { fmFindRecords, fmUpdateRecord } from '../fm-client.js';
import { getAccessTokensCacheData } from '../store.js';
import { normalizeEmail } from './format.js';
import { parseCookies } from './http.js';

// ── Session constants ─────────────────────────────────────────────────────────
export const MASS_SESSION_COOKIE          = 'mass.sid';
export const MASS_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

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
    type:           token.type || 'trial',
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
    return { valid: false, reason: 'Token expired', expirationDate: token.Expiration_Date };
  }
  console.log(`[MASS] Token ${trimmedCode} is still valid`);
  return null;
}

function checkSessionConflict(token, sessionId, trimmedCode) {
  if (!sessionId) return null;
  const currentSessionId = token.Current_Session_ID;
  const lastActivity     = token.Session_Last_Activity;
  if (!currentSessionId || currentSessionId === sessionId) return null;
  if (!lastActivity) return null;
  try {
    const lastActivityTime = new Date(lastActivity).getTime();
    const sessionTimeoutMs = 15 * 60 * 1000;
    if (!Number.isNaN(lastActivityTime) && (Date.now() - lastActivityTime) < sessionTimeoutMs) {
      console.log(`[MASS] Token ${trimmedCode} is in use by another session (last active ${Math.floor((Date.now() - lastActivityTime) / 1000 / 60)} min ago)`);
      return { valid: false, reason: 'Token is currently in use on another device' };
    }
    console.log('[MASS] Previous session timed out, allowing new session');
  } catch (err) {
    console.warn('[MASS] Error parsing session last activity:', err);
  }
  return null;
}

function buildTokenUpdateFields(token, sessionId, req, fmTimestamp, now) {
  const updateFields = {
    'Last_Used':  fmTimestamp,
    'Use_Count':  (Number.parseInt(token.Use_Count) || 0) + 1
  };
  if (sessionId) {
    updateFields['Current_Session_ID']    = sessionId;
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
      { 'Token_Code': `==${trimmedCode}` }
    ], { limit: 1 });

    console.log(`[MASS] FileMaker token lookup result: ${result?.data?.length || 0} records found`);

    if (!result?.data?.length) {
      console.log('[MASS] Token not found in FileMaker, trying JSON fallback');
      return validateAccessTokenFromJSON(tokenCode);
    }

    const token = result.data[0].fieldData;

    if (token.Active === 0 || token.Active === '0') {
      return { valid: false, reason: 'Token disabled' };
    }

    const expiredResult = checkTokenExpired(token, trimmedCode);
    if (expiredResult) return expiredResult;

    const conflictResult = checkSessionConflict(token, sessionId, trimmedCode);
    if (conflictResult) return conflictResult;

    if (sessionId) console.log(`[MASS] Session ${sessionId} validated for token ${trimmedCode}`);

    const recordId    = result.data[0].recordId;
    const now         = new Date();
    const fmTimestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const { updateFields, calculatedExpirationUTC } = buildTokenUpdateFields(token, sessionId, req, fmTimestamp, now);

    fmUpdateRecord(layout, recordId, updateFields).catch(err => {
      console.warn('[MASS] Failed to update token usage stats:', err);
    });

    return {
      valid:          true,
      type:           token.Token_Type || 'trial',
      expirationDate: resolveExpirationUTC(token, calculatedExpirationUTC),
      issuedDate:     token.Issued_Date,
      notes:          token.Notes,
      email:          normalizeEmail(token.Issued_To || token.Email || '') || null
    };
  } catch (err) {
    console.error('[MASS] FileMaker token validation error:', err);
    console.warn('[MASS] Falling back to JSON file for token validation');
    return validateAccessTokenFromJSON(tokenCode);
  }
}

// ── Express middleware helper ─────────────────────────────────────────────────

export function requireTokenEmail(req, res) {
  const tokenEmail = req.accessToken?.email || null;
  const cookieEmail = parseCookies(req)['mass.email'] || null;
  const tokenCode   = req.accessToken?.code || null;
  const email       = tokenEmail || cookieEmail || tokenCode;
  if (!email) {
    console.warn(`[MASS] requireTokenEmail: no email — tokenEmail=${tokenEmail}, cookieEmail=${cookieEmail}, token=${req.accessToken?.code?.slice(0,8)}…`);
    res.status(401).json({ ok: false, error: 'Access token required' });
    return null;
  }
  return { email };
}
