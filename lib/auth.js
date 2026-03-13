/**
 * lib/auth.js — Access token validation and session auth middleware.
 * Dependencies: fm-client.js, cache.js, store.js, lib/format.js, lib/http.js
 */

import { fmFindRecords, fmUpdateRecord } from '../fm-client.js';
import { tokenValidationCache } from '../cache.js';
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
    t.code && t.code.trim().toUpperCase() === trimmedCode
  );

  if (!token) return { valid: false, reason: 'Invalid token' };

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

    if (!result || !result.data || result.data.length === 0) {
      console.log('[MASS] Token not found in FileMaker, trying JSON fallback');
      return validateAccessTokenFromJSON(tokenCode);
    }

    const token = result.data[0].fieldData;

    if (token.Active === 0 || token.Active === '0') {
      return { valid: false, reason: 'Token disabled' };
    }

    if (token.Expiration_Date) {
      const fmTimezoneOffset = parseFloat(process.env.FM_TIMEZONE_OFFSET || '0');
      let expirationTime = new Date(token.Expiration_Date).getTime();
      const offsetMs = fmTimezoneOffset * 60 * 60 * 1000;
      expirationTime = expirationTime - offsetMs;
      const now = Date.now();

      if (process.env.TOKEN_DEBUG === 'true') {
        console.log(`[MASS] Token expiration check for ${trimmedCode}:`);
        console.log(`  Raw expiration from FM: "${token.Expiration_Date}"`);
        console.log(`  FM Timezone offset: ${fmTimezoneOffset > 0 ? '+' : ''}${fmTimezoneOffset} hours`);
        console.log(`  Parsed as local: ${new Date(token.Expiration_Date).toISOString()}`);
        console.log(`  Adjusted to UTC: ${new Date(expirationTime).toISOString()}`);
        console.log(`  Current UTC time: ${new Date(now).toISOString()}`);
        console.log(`  Time until expiry: ${((expirationTime - now) / 1000 / 60 / 60).toFixed(2)} hours`);
      }

      if (isNaN(expirationTime)) {
        console.warn(`[MASS] Could not parse expiration date: "${token.Expiration_Date}" - treating as no expiration`);
      } else if (now > expirationTime) {
        console.log(`[MASS] Token ${trimmedCode} is EXPIRED`);
        return { valid: false, reason: 'Token expired', expirationDate: token.Expiration_Date };
      } else {
        console.log(`[MASS] Token ${trimmedCode} is still valid`);
      }
    }

    if (sessionId) {
      const currentSessionId = token.Current_Session_ID;
      const lastActivity     = token.Session_Last_Activity;

      if (currentSessionId && currentSessionId !== sessionId) {
        if (lastActivity) {
          try {
            const lastActivityTime  = new Date(lastActivity).getTime();
            const now               = Date.now();
            const sessionTimeoutMs  = 15 * 60 * 1000;

            if (!isNaN(lastActivityTime) && (now - lastActivityTime) < sessionTimeoutMs) {
              console.log(`[MASS] Token ${trimmedCode} is in use by another session (last active ${Math.floor((now - lastActivityTime) / 1000 / 60)} min ago)`);
              return { valid: false, reason: 'Token is currently in use on another device' };
            } else {
              console.log('[MASS] Previous session timed out, allowing new session');
            }
          } catch (err) {
            console.warn('[MASS] Error parsing session last activity:', err);
          }
        }
      }
      console.log(`[MASS] Session ${sessionId} validated for token ${trimmedCode}`);
    }

    const recordId   = result.data[0].recordId;
    const now        = new Date();
    const fmTimestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const updateFields = {
      'Last_Used': fmTimestamp,
      'Use_Count': (parseInt(token.Use_Count) || 0) + 1
    };

    if (sessionId) {
      updateFields['Current_Session_ID']     = sessionId;
      updateFields['Session_Last_Activity']  = fmTimestamp;
      if (req) {
        updateFields['Session_Device_Info'] = req.headers['user-agent'] || 'Unknown';
        updateFields['Session_IP']          = req.ip || req.connection?.remoteAddress || 'Unknown';
      }
    }

    let calculatedExpirationUTC = null;

    if (!token.First_Used || token.First_Used === '') {
      updateFields['First_Used'] = fmTimestamp;
      console.log(`[MASS] Setting First_Used for token ${trimmedCode}`);

      if (token.Token_Duration_Hours && parseInt(token.Token_Duration_Hours) > 0) {
        const durationSeconds  = parseInt(token.Token_Duration_Hours);
        const expirationTime   = new Date(now.getTime() + (durationSeconds * 1000));
        const fmExpiration     = `${expirationTime.getMonth() + 1}/${expirationTime.getDate()}/${expirationTime.getFullYear()} ${expirationTime.getHours()}:${String(expirationTime.getMinutes()).padStart(2, '0')}:${String(expirationTime.getSeconds()).padStart(2, '0')}`;
        updateFields['Expiration_Date'] = fmExpiration;
        calculatedExpirationUTC         = expirationTime.toISOString();
        console.log(`[MASS] Setting Expiration_Date for token ${trimmedCode}: ${fmExpiration} (${durationSeconds} seconds from now)`);
      }
    }

    fmUpdateRecord(layout, recordId, updateFields).catch(err => {
      console.warn('[MASS] Failed to update token usage stats:', err);
    });

    let expirationDateUTC = calculatedExpirationUTC;
    if (!expirationDateUTC && token.Expiration_Date) {
      const fmTimezoneOffset  = parseFloat(process.env.FM_TIMEZONE_OFFSET || '0');
      let expirationTimeUTC   = new Date(token.Expiration_Date).getTime();
      const offsetMs          = fmTimezoneOffset * 60 * 60 * 1000;
      expirationTimeUTC       = expirationTimeUTC - offsetMs;
      expirationDateUTC       = new Date(expirationTimeUTC).toISOString();
    }

    return {
      valid:          true,
      type:           token.Token_Type || 'trial',
      expirationDate: expirationDateUTC,
      issuedDate:     token.Issued_Date,
      notes:          token.Notes,
      email:          token.Issued_To
        ? normalizeEmail(token.Issued_To)
        : (token.Email ? normalizeEmail(token.Email) : null)
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
