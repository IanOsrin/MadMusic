import { Router } from 'express';
import { validateAccessToken, MASS_SESSION_COOKIE, MASS_SESSION_MAX_AGE_SECONDS } from '../lib/auth.js';
import { parseCookies, getClientIP } from '../lib/http.js';
import { formatTimestampUTC, toCleanString, normalizeSeconds, parseFileMakerTimestamp } from '../lib/format.js';
import { validateSessionId, isStrictEmail, fmExactMatch } from '../lib/validators.js';
import { timingSafeEqualStr } from '../lib/crypto-utils.js';
import { LRUCache } from 'lru-cache';
import {
  STREAM_EVENT_TYPES, STREAM_EVENT_DEBUG, STREAM_TERMINAL_EVENTS,
  STREAM_TIME_FIELD, STREAM_TIME_FIELD_LEGACY,
  ensureStreamRecord, findStreamRecord,
  setCachedStreamRecordId, clearCachedStreamRecordId, getCachedStreamRecordId
} from '../lib/stream-events.js';
import { fmUpdateRecord, fmFindRecords } from '../fm-client.js';
import { tokenValidationCache } from '../cache.js';
import { FM_STREAM_EVENTS_LAYOUT, FM_LAYOUT, firstNonEmpty } from '../lib/fm-fields.js';
import { getTrackRecordCached } from '../lib/track-cache.js';
import { randomUUID, randomInt } from 'node:crypto';
import { sendEmailClaimCode } from '../lib/email.js';
import { normalizeEmail } from '../lib/format.js';

// ── Sanity caps ───────────────────────────────────────────────────────────────
// Max seconds we'll ever credit per event. PROGRESS fires every ~30s from the
// client; anything beyond 5 minutes per event is almost certainly a seek jump,
// a reconnect after a long pause, or a clock/position bug.
const MAX_DELTA_PER_EVENT_SEC = 300;
// Small fraction of DurationSec we allow TotalPlayedSec to exceed (timing jitter).
const TOTAL_PLAYED_OVERSHOOT_FACTOR = 1.05;

// In-process accumulator for TotalPlayedSec.
// The stream-record LRU returns existingFieldData:null on cache hits, so we
// can't read the accumulated total from FileMaker on every event. This Map
// shadows TotalPlayedSec locally and is updated after every successful write.
// Keyed by "sessionId::trackRecordId" — same format as the LRU.
// Bounded LRU (was an unbounded Map → memory-leak DoS at 10k-concurrent scale).
// Entries expire after 6h of inactivity even if a session never sends a
// terminal event to clear them. get/set/delete are call-site compatible.
const streamTotalMap = new LRUCache({ max: 50000, ttl: 6 * 60 * 60 * 1000 });

const router = Router();

console.log('[MASS] Registering access token validation endpoint');

router.post('/validate', async (req, res) => {
  try {
    const { token, sessionId } = req.body;

    if (!token) {
      return res.status(400).json({
        ok: false,
        valid: false,
        error: 'Token is required'
      });
    }

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        valid: false,
        error: 'Session ID is required'
      });
    }

    const result = await validateAccessToken(token, sessionId, req);

    if (result.valid) {
      res.json({
        ok: true,
        valid: true,
        // Tells the frontend to show the email-capture modal before letting
        // the user into the app. We do this whenever Issued_To is empty in
        // FM, even for previously-activated tokens — those are exactly the
        // tokens whose playlist/library writes would otherwise be orphaned.
        requiresEmail: !result.email,
        type: result.type,
        expirationDate: result.expirationDate,
        email: result.email || null,
        audioLabEnabled: result.audioLabEnabled || false,
        message: result.message || 'Token is valid'
      });
    } else {
      res.status(401).json({
        ok: false,
        valid: false,
        reason: result.reason,
        expirationDate: result.expirationDate
      });
    }
  } catch (err) {
    console.error('[MASS] Token validation failed:', err);
    res.status(500).json({ ok: false, valid: false, error: 'Token validation failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Email-claim flow
//
// Tokens issued without a pre-assigned email (e.g. trial tokens, bulk-issued
// tokens shared via WhatsApp, manually-created records) used to let users
// straight into the app, then have their playlists/library writes fall back to
// using the token code as the storage key. That orphaned data permanently once
// any email later got bound to the token.
//
// New flow:
//   1. /validate returns { requiresEmail: true } when FM's Issued_To is empty.
//   2. Frontend collects an email, calls /email/start { token, email }, which
//      sends a 6-digit verification code via SMTP.
//   3. User enters the code, frontend calls /email/confirm { token, code };
//      on success we write Issued_To to FM and invalidate the token cache so
//      the next /validate sees the bound email.
//
// Codes live in memory only — server restart clears them and the user has to
// request a fresh code. 10-minute TTL, 5-attempt cap, single active code per
// token (a new /email/start overwrites the previous code).
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_CLAIM_CODES = new Map(); // tokenCodeUpper -> { email, code, expiresAt, attempts }
const EMAIL_CLAIM_TTL_MS    = 10 * 60 * 1000;
const EMAIL_CLAIM_MAX_TRIES = 5;

// ── Email-send throttle (anti email-bomb) ────────────────────────────────────
// Keyed by `${tokenCode}::${email}`. Allows at most 1 send per 60s and 5 per
// hour per (token, email). In-memory only — server restart resets the window.
const EMAIL_SEND_THROTTLE = new Map(); // key -> { sends: number[] (timestamps ms) }
const EMAIL_SEND_MIN_INTERVAL_MS = 60 * 1000;       // 1 per 60s
const EMAIL_SEND_HOUR_MS         = 60 * 60 * 1000;
const EMAIL_SEND_MAX_PER_HOUR    = 5;

// Returns { allowed, retryAfterSec }. Records the send when allowed. Prunes
// timestamps older than an hour (and empty/stale keys) to bound memory.
function checkEmailSendThrottle(key) {
  const now = Date.now();
  // Prune stale keys opportunistically.
  for (const [k, entry] of EMAIL_SEND_THROTTLE) {
    entry.sends = entry.sends.filter((t) => now - t < EMAIL_SEND_HOUR_MS);
    if (entry.sends.length === 0) EMAIL_SEND_THROTTLE.delete(k);
  }
  const entry = EMAIL_SEND_THROTTLE.get(key) || { sends: [] };
  const recent = entry.sends.filter((t) => now - t < EMAIL_SEND_HOUR_MS);
  const lastSend = recent.length ? recent[recent.length - 1] : 0;
  if (lastSend && now - lastSend < EMAIL_SEND_MIN_INTERVAL_MS) {
    return { allowed: false, retryAfterSec: Math.ceil((EMAIL_SEND_MIN_INTERVAL_MS - (now - lastSend)) / 1000) };
  }
  if (recent.length >= EMAIL_SEND_MAX_PER_HOUR) {
    const oldest = recent[0];
    return { allowed: false, retryAfterSec: Math.ceil((EMAIL_SEND_HOUR_MS - (now - oldest)) / 1000) };
  }
  recent.push(now);
  EMAIL_SEND_THROTTLE.set(key, { sends: recent });
  return { allowed: true, retryAfterSec: 0 };
}

function generateClaimCode() {
  // 6-digit zero-padded — cryptographically random, not Math.random.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

router.post('/email/start', async (req, res) => {
  try {
    const { token, email } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
    if (!isStrictEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address' });
    }

    const tokenCode       = String(token).trim().toUpperCase();
    const normalizedEmail = normalizeEmail(email);

    // Verify the token is real and active before sending any email — otherwise
    // anyone could spray verification mails from our SMTP using random codes.
    const validation = await validateAccessToken(tokenCode);
    if (!validation.valid) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid or expired token',
        reason: validation.reason
      });
    }

    // If the token is already bound to a different email, refuse — the owner
    // of that email should be the only person able to claim it.
    if (validation.email && validation.email !== normalizedEmail) {
      return res.status(409).json({
        ok: false,
        error: 'This token is already linked to a different email'
      });
    }

    // Throttle sends per (token, email) to prevent using our SMTP as an
    // email bomb against a victim address.
    const throttle = checkEmailSendThrottle(`${tokenCode}::${normalizedEmail}`);
    if (!throttle.allowed) {
      res.setHeader('Retry-After', String(throttle.retryAfterSec));
      return res.status(429).json({
        ok: false,
        error: 'Too many verification emails requested. Please wait before trying again.',
        retryAfterSec: throttle.retryAfterSec
      });
    }

    const code = generateClaimCode();
    EMAIL_CLAIM_CODES.set(tokenCode, {
      email:     normalizedEmail,
      code,
      expiresAt: Date.now() + EMAIL_CLAIM_TTL_MS,
      attempts:  0
    });

    try {
      await sendEmailClaimCode(normalizedEmail, code);
    } catch (mailErr) {
      EMAIL_CLAIM_CODES.delete(tokenCode);
      console.error('[MASS] Could not send claim code:', mailErr?.message || mailErr);
      return res.status(503).json({
        ok: false,
        error: 'Could not send verification email. Please try again or contact support.'
      });
    }

    res.json({
      ok: true,
      message: 'Verification code sent — check your inbox',
      expiresInSec: Math.floor(EMAIL_CLAIM_TTL_MS / 1000)
    });
  } catch (err) {
    console.error('[MASS] /email/start failed:', err);
    res.status(500).json({ ok: false, error: 'Could not start email verification' });
  }
});

router.post('/email/confirm', async (req, res) => {
  try {
    const { token, code } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
    if (!code)  return res.status(400).json({ ok: false, error: 'Verification code required' });

    const tokenCode     = String(token).trim().toUpperCase();
    const submittedCode = String(code).trim();

    const claim = EMAIL_CLAIM_CODES.get(tokenCode);
    if (!claim) {
      return res.status(400).json({
        ok: false,
        error: 'No active verification — request a new code'
      });
    }

    if (Date.now() > claim.expiresAt) {
      EMAIL_CLAIM_CODES.delete(tokenCode);
      return res.status(400).json({
        ok: false,
        error: 'Verification code expired — request a new one'
      });
    }

    if (claim.attempts >= EMAIL_CLAIM_MAX_TRIES) {
      EMAIL_CLAIM_CODES.delete(tokenCode);
      return res.status(429).json({
        ok: false,
        error: 'Too many attempts — request a new code'
      });
    }
    claim.attempts += 1;

    if (!timingSafeEqualStr(submittedCode, claim.code)) {
      const remaining = EMAIL_CLAIM_MAX_TRIES - claim.attempts;
      return res.status(400).json({
        ok: false,
        error: 'Incorrect code',
        attemptsRemaining: remaining
      });
    }

    // Code accepted — persist the email on the FM token record.
    const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
    const findResult = await fmFindRecords(layout, [
      { 'Token_Code': fmExactMatch(tokenCode) }
    ], { limit: 1 });

    if (!findResult?.data?.length) {
      EMAIL_CLAIM_CODES.delete(tokenCode);
      return res.status(404).json({ ok: false, error: 'Token not found in FileMaker' });
    }

    const fmRecord  = findResult.data[0];
    const fieldData = fmRecord.fieldData || {};

    // Some FM token layouts use `Issued_To`, others use `Email` — lib/auth.js
    // reads from both. Detect which field(s) the record actually has and
    // write to those, otherwise FM rejects the update with "field not found"
    // and the user sees a confusing "Could not verify code" error.
    const hasIssuedTo = Object.prototype.hasOwnProperty.call(fieldData, 'Issued_To');
    const hasEmail    = Object.prototype.hasOwnProperty.call(fieldData, 'Email');

    if (!hasIssuedTo && !hasEmail) {
      EMAIL_CLAIM_CODES.delete(tokenCode);
      console.error('[MASS] /email/confirm: token record has neither Issued_To nor Email field. Available fields:', Object.keys(fieldData));
      return res.status(500).json({
        ok: false,
        error: 'Token record has no email field to write to',
        detail: 'FM layout missing Issued_To and Email — check FM_TOKENS_LAYOUT schema'
      });
    }

    // Race-condition guard: if someone else claimed this token between
    // /email/start and /email/confirm, refuse.
    const existingEmail = ((hasIssuedTo && fieldData.Issued_To) || (hasEmail && fieldData.Email) || '').trim();
    if (existingEmail && normalizeEmail(existingEmail) !== claim.email) {
      EMAIL_CLAIM_CODES.delete(tokenCode);
      return res.status(409).json({
        ok: false,
        error: 'This token was claimed by another email moments ago'
      });
    }

    const updateFields = {};
    if (hasIssuedTo) updateFields['Issued_To'] = claim.email;
    if (hasEmail)    updateFields['Email']     = claim.email;

    try {
      await fmUpdateRecord(layout, fmRecord.recordId, updateFields);
    } catch (fmErr) {
      // Surface the real FM error so we don't get vague "Could not verify code"
      // when it's actually a schema mismatch, permissions issue, etc.
      console.error('[MASS] /email/confirm: fmUpdateRecord failed:', fmErr?.message || fmErr, 'fields attempted:', Object.keys(updateFields));
      EMAIL_CLAIM_CODES.delete(tokenCode);
      return res.status(502).json({
        ok: false,
        error: 'Could not save email to FileMaker',
        detail: fmErr?.message || String(fmErr)
      });
    }

    // Bust the in-process token validation cache so the next /validate call
    // re-reads from FM and picks up the new email.
    tokenValidationCache.delete(tokenCode);
    EMAIL_CLAIM_CODES.delete(tokenCode);

    // The server trusts only the FM token email now — no cookie-based fallback.

    console.log(`[MASS] Email claim succeeded: ${tokenCode.slice(0, 8)}… -> ${claim.email}`);

    res.json({ ok: true, email: claim.email });
  } catch (err) {
    console.error('[MASS] /email/confirm failed:', err);
    res.status(500).json({ ok: false, error: 'Could not verify code' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const { token, sessionId } = req.body;
    // Redact token in logs — only show first 8 chars to avoid leaking the full code
    const tokenPreview = token ? `${String(token).trim().slice(0, 8)}…` : '(none)';
    console.log(`[MASS LOGOUT] Token: ${tokenPreview}, SessionID: ${sessionId}`);

    if (!token || !sessionId) {
      console.log('[MASS LOGOUT] ❌ Missing token or sessionId');
      return res.status(400).json({
        ok: false,
        error: 'Token and session ID are required'
      });
    }

    const trimmedCode = token.trim().toUpperCase();

    const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
    const result = await fmFindRecords(layout, [
      { 'Token_Code': fmExactMatch(trimmedCode) }
    ], { limit: 1 });

    if (result?.data?.length > 0) {
      const tokenData = result.data[0].fieldData;
      const recordId = result.data[0].recordId;
      console.log(`[MASS LOGOUT] Found token. Current session in FM: "${tokenData.Current_Session_ID}", Incoming: "${sessionId}"`);

      if (tokenData.Current_Session_ID === sessionId) {
        const now = new Date();
        const fmTimestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

        await fmUpdateRecord(layout, recordId, {
          'Current_Session_ID': '',
          'Session_Last_Activity': fmTimestamp,
          'Session_Device_Info': '',
          'Session_IP': ''
        });

        console.log(`[MASS LOGOUT] ✅ Session cleared for token ${trimmedCode}`);
        return res.json({ ok: true, message: 'Session cleared successfully' });
      }
      console.log(`[MASS LOGOUT] ⚠️ Session ID mismatch for token ${trimmedCode} - not clearing (FM has different session)`);
      return res.json({ ok: true, message: 'Session ID mismatch - not current session', warning: true });
    }
    console.log(`[MASS LOGOUT] ⚠️ Token ${trimmedCode} not found in FileMaker`);
    return res.json({ ok: true, message: 'Token not found', warning: true });
  } catch (err) {
    console.error('[MASS] Logout failed:', err);
    res.status(500).json({ ok: false, error: 'Logout failed' });
  }
});

// Resolve and validate the session ID from the request, or mint a fresh UUID.
function resolveStreamSession(req, cookies) {
  const headersSessionRaw = req.get?.('X-Session-ID') || req.headers?.['x-session-id'];
  let headerSession = Array.isArray(headersSessionRaw) ? headersSessionRaw[0] : headersSessionRaw;
  if (typeof headerSession === 'string') headerSession = headerSession.trim();

  // 1) A valid UUID in the X-Session-ID header wins — that's the client's own
  //    stable session id for this play.
  const validHeader = validateSessionId(headerSession);
  if (validHeader) return validHeader;

  // 2) Otherwise fall back to the session cookie the SERVER issued (and pins via
  //    Set-Cookie below). This is essential: some clients send a non-UUID
  //    X-Session-ID. Previously a non-empty-but-invalid header skipped the cookie
  //    fallback and a brand-new UUID was minted on EVERY event — spawning a new
  //    record per event instead of accumulating into one record per play.
  const validCookie = validateSessionId(cookies[MASS_SESSION_COOKIE] || '');
  if (validCookie) return validCookie;

  // 3) Nothing usable yet — mint one. The handler Set-Cookies it on the response,
  //    so every subsequent event in this play reuses it → one record per play.
  if (STREAM_EVENT_DEBUG) {
    console.log('[stream] No valid session id on request; minting one and pinning via cookie');
  }
  return randomUUID();
}

// Merge existing FileMaker field values into baseFields (mutates baseFields).
function applyExistingFieldsToBase(baseFields, existingFields, normalizedType, timestamp, payloadDelta, normalizedDuration) {
  const existingPositionValue = existingFields[STREAM_TIME_FIELD] ?? existingFields[STREAM_TIME_FIELD_LEGACY] ?? null;
  const existingPosition = normalizeSeconds(existingPositionValue);
  const deltaFromPosition = Math.max(0, baseFields[STREAM_TIME_FIELD] - existingPosition);
  if (existingPosition > baseFields[STREAM_TIME_FIELD]) {
    baseFields[STREAM_TIME_FIELD] = existingPosition;
  }
  const existingDuration = normalizeSeconds(existingFields.DurationSec);
  if (existingDuration && !baseFields.DurationSec) baseFields.DurationSec = existingDuration;
  if (!baseFields.TrackISRC && existingFields.TrackISRC) baseFields.TrackISRC = existingFields.TrackISRC;

  // Carry forward Track Artist / Track Name if not already set on this event
  if (!baseFields['Track Artist'] && existingFields['Track Artist']) baseFields['Track Artist'] = existingFields['Track Artist'];
  if (!baseFields['Track Name']   && existingFields['Track Name'])   baseFields['Track Name']   = existingFields['Track Name'];

  const existingTotalPlayed = normalizeSeconds(existingFields.TotalPlayedSec);

  // Use client-supplied delta when non-zero; otherwise derive from position advance.
  // Note: payloadDelta of 0 means "not supplied" (client omitted deltaSec or sent 0).
  const rawDelta = payloadDelta > 0 ? payloadDelta : deltaFromPosition;

  // ── Wall-clock sanity cap ──────────────────────────────────────────────────
  // If we have a LastEventUTC from the existing record we can calculate how much
  // real time has elapsed since the last event. Credit at most that much plus a
  // 30-second buffer — this catches seek jumps, long pauses, and reconnects.
  let wallClockCap = MAX_DELTA_PER_EVENT_SEC;
  const lastEventTs = parseFileMakerTimestamp(existingFields.LastEventUTC);
  if (lastEventTs > 0) {
    const elapsedMs   = Date.now() - lastEventTs;
    const elapsedSec  = Math.max(0, Math.round(elapsedMs / 1000));
    wallClockCap      = Math.min(MAX_DELTA_PER_EVENT_SEC, elapsedSec + 30);
  }

  const effectiveDelta = Math.min(rawDelta, wallClockCap);

  // ── TotalPlayedSec cap ────────────────────────────────────────────────────
  // TotalPlayedSec must never meaningfully exceed the track's actual duration.
  const effectiveDuration = Math.max(
    baseFields.DurationSec  || 0,
    existingDuration         || 0,
    normalizedDuration       || 0
  );
  const rawTotal   = existingTotalPlayed + effectiveDelta;
  const totalCap   = effectiveDuration > 0 ? Math.round(effectiveDuration * TOTAL_PLAYED_OVERSHOOT_FACTOR) : Infinity;
  const totalPlayed = effectiveDuration > 0 ? Math.min(rawTotal, totalCap) : rawTotal;

  if (STREAM_EVENT_DEBUG && rawDelta !== effectiveDelta) {
    console.warn('[MASS] Delta capped', {
      rawDelta, effectiveDelta, wallClockCap,
      positionSec: baseFields[STREAM_TIME_FIELD], existingPosition,
      sessionId: baseFields.SessionID, trackRecordId: baseFields.TrackRecordID
    });
  }
  if (STREAM_EVENT_DEBUG && rawTotal !== totalPlayed) {
    console.warn('[MASS] TotalPlayedSec capped', {
      rawTotal, totalPlayed, effectiveDuration,
      sessionId: baseFields.SessionID, trackRecordId: baseFields.TrackRecordID
    });
  }

  baseFields.DeltaSec       = effectiveDelta;
  baseFields.TotalPlayedSec = totalPlayed;
  baseFields.LastEventUTC   = timestamp;
  if (!existingFields.PlayStartUTC && normalizedType === 'PLAY') baseFields.PlayStartUTC = timestamp;
  if (normalizedType === 'END' && normalizedDuration && normalizedDuration > baseFields.DurationSec) {
    baseFields.DurationSec = normalizedDuration;
  }
}

function tryEnrichToken(req) {
  if (req.accessToken) return;
  const rawToken = (req.headers['x-access-token'] || req.body?.accessToken || '').toString().trim();
  if (!rawToken) return;
  const cached = tokenValidationCache.get(rawToken.toUpperCase());
  if (cached?.data) req.accessToken = cached.data;
}

async function resolveTerminalRecord(normalizedType, hasCachedSession, sessionId, normalizedTrackRecordId, res) {
  if (!STREAM_TERMINAL_EVENTS.has(normalizedType) || hasCachedSession) return true;
  const existing = await findStreamRecord(sessionId, normalizedTrackRecordId);
  if (!existing?.recordId) {
    if (STREAM_EVENT_DEBUG) {
      console.info('[MASS] Terminal event with no existing record — skipping', {
        eventType: normalizedType, sessionId, trackRecordId: normalizedTrackRecordId
      });
    }
    res.json({ ok: true, skipped: true });
    return false;
  }
  setCachedStreamRecordId(sessionId, normalizedTrackRecordId, existing.recordId);
  return true;
}

router.post('/stream-events', async (req, res) => {
  try {
    // Soft token enrichment: stream-events skips the global auth middleware so events
    // are never blocked. If the client sent a token header we look it up in the
    // in-memory validation cache (populated by any prior authenticated request) to
    // get the token code and Issued_To email without a FileMaker round-trip.
    tryEnrichToken(req);

    if (STREAM_EVENT_DEBUG) {
      console.log('[MASS] Stream event - Access Token:', req.accessToken?.code || 'NO TOKEN');
    }

    const {
      eventType = '',
      trackRecordId = '',
      trackISRC = '',
      positionSec = 0,
      durationSec = 0,
      deltaSec = 0
    } = req.body || {};

    const normalizedType = String(eventType || '').trim().toUpperCase();
    if (!STREAM_EVENT_TYPES.has(normalizedType)) {
      res.status(400).json({ ok: false, error: 'Invalid eventType' });
      return;
    }

    const cookies = parseCookies(req);
    const sessionId = resolveStreamSession(req, cookies);

    if (!cookies[MASS_SESSION_COOKIE] || cookies[MASS_SESSION_COOKIE] !== sessionId) {
      const cookieParts = [
        `${MASS_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
        'Path=/',
        `Max-Age=${MASS_SESSION_MAX_AGE_SECONDS}`,
        'SameSite=Lax',
        'HttpOnly'
      ];
      if (process.env.NODE_ENV === 'production') cookieParts.push('Secure');
      res.setHeader('Set-Cookie', cookieParts.join('; '));
    }

    const timestamp = formatTimestampUTC();
    const clientIP = getClientIP(req);
    const userAgentHeader = req.headers?.['user-agent'];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader || '';

    const normalizedTrackRecordId = toCleanString(trackRecordId);
    if (!normalizedTrackRecordId) {
      res.status(400).json({ ok: false, error: 'trackRecordId is required' });
      return;
    }

    let normalizedTrackISRC = toCleanString(trackISRC);
    const normalizedPosition = normalizeSeconds(positionSec);
    const normalizedDuration = normalizeSeconds(durationSec);
    const payloadDelta = normalizeSeconds(deltaSec);
    const tokenCode = req.accessToken?.code || '';
    const issuedTo  = req.accessToken?.email || '';

    // Look up track name and artist from the shared track-record cache.
    // This is almost always a cache hit — the player fetched the track record
    // to resolve the audio URL before starting playback. The 100ms timeout
    // ensures we never block event recording on a cold cache miss.
    // Note: .catch(() => null) on the FM call is essential — if the timeout
    // wins the race and FM later rejects, we need it caught here, not as an
    // unhandled rejection that would be logged at the process level.
    let trackArtist = '';
    let trackName   = '';
    try {
      const trackRecord = await Promise.race([
        getTrackRecordCached(FM_LAYOUT, normalizedTrackRecordId).catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), 100))
      ]);
      const tf = trackRecord?.fieldData || {};
      trackArtist = firstNonEmpty(tf, ['Track Artist', 'Album Artist', 'Tape Files::Album Artist', 'Artist']) || '';
      trackName   = firstNonEmpty(tf, ['Track Name', 'Tape Files::Track Name', 'Song Title']) || '';
      if (!normalizedTrackISRC) {
        normalizedTrackISRC = firstNonEmpty(tf, ['ISRC', 'Tape Files::ISRC']) || '';
      }
    } catch { /* non-fatal — carry-forward from existingFields will fill these in */ }

    const baseFields = {
      TimestampUTC: timestamp,
      EventType: normalizedType,
      TrackRecordID: normalizedTrackRecordId,
      TrackISRC: normalizedTrackISRC,
      [STREAM_TIME_FIELD]: normalizedPosition,
      DurationSec: normalizedDuration,
      DeltaSec: payloadDelta,
      SessionID: sessionId,
      ClientIP: clientIP,
      ASN: 'Unknown',
      UserAgent: userAgent,
      Token_Number: tokenCode,
      Email: issuedTo,
      'Track Artist': trackArtist,
      'Track Name': trackName
    };

    const primaryKey = randomUUID();
    const createFields = {
      PrimaryKey: primaryKey,
      SessionID: sessionId,
      TrackRecordID: normalizedTrackRecordId,
      TrackISRC: normalizedTrackISRC,
      TimestampUTC: timestamp,
      EventType: normalizedType,
      [STREAM_TIME_FIELD]: normalizedPosition,
      DurationSec: normalizedDuration,
      DeltaSec: payloadDelta,
      ClientIP: clientIP,
      ASN: 'Unknown',
      UserAgent: userAgent,
      TotalPlayedSec: payloadDelta,
      PlayStartUTC: normalizedType === 'PLAY' ? timestamp : '',
      LastEventUTC: timestamp,
      Token_Number: tokenCode,
      Email: issuedTo,
      'Track Artist': trackArtist,
      'Track Name': trackName
    };

    if (STREAM_EVENT_DEBUG) {
      console.info('[MASS] stream event logging', {
        eventType: baseFields.EventType,
        sessionId,
        trackRecordId: normalizedTrackRecordId,
        timeStreamed: baseFields[STREAM_TIME_FIELD],
        deltaSec: baseFields.DeltaSec,
        tokenNumber: baseFields.Token_Number
      });
    }

    // Only force a new record on PLAY when there is no active session already cached.
    // If a cached record exists the user is resuming mid-listen (e.g. after a pause),
    // so we keep accumulating into the same record instead of spawning a duplicate.
    // A new record is created when: (a) genuinely first play, or (b) after END/ERROR
    // clears the cache and the user starts the track again.
    const hasCachedSession = Boolean(getCachedStreamRecordId(sessionId, normalizedTrackRecordId));

    // Terminal events (END / ERROR) must NEVER create a new record — they can only
    // update an existing one. If there is no cached session and no FM record to close,
    // acknowledge the event and return early without touching FileMaker.
    const shouldContinue = await resolveTerminalRecord(normalizedType, hasCachedSession, sessionId, normalizedTrackRecordId, res);
    if (!shouldContinue) return;

    const forceNewRecord = normalizedType === 'PLAY' && !hasCachedSession;
    const ensureResult = await ensureStreamRecord(sessionId, normalizedTrackRecordId, createFields, { forceNew: forceNewRecord });
    const existingFields = ensureResult.existingFieldData ? { ...ensureResult.existingFieldData } : {};

    // LRU cache hits return existingFieldData:null so we can't read TotalPlayedSec
    // from FileMaker. Restore it from the in-process accumulator so the total
    // keeps growing correctly instead of resetting to just this event's delta.
    const streamKey = `${sessionId}::${normalizedTrackRecordId}`;
    if (!ensureResult.existingFieldData && !ensureResult.created) {
      const cached = streamTotalMap.get(streamKey);
      if (cached !== undefined) existingFields.TotalPlayedSec = cached;
    }

    applyExistingFieldsToBase(baseFields, existingFields, normalizedType, timestamp, payloadDelta, normalizedDuration);

    if (STREAM_EVENT_DEBUG) {
      console.info('[MASS] Updating FileMaker record with Token_Number:', baseFields.Token_Number);
    }

    await fmUpdateRecord(FM_STREAM_EVENTS_LAYOUT, ensureResult.recordId, baseFields);

    // Keep the in-process accumulator in sync with what we just wrote.
    streamTotalMap.set(streamKey, baseFields.TotalPlayedSec);

    if (STREAM_EVENT_DEBUG) {
      console.info('[MASS] stream event persisted', {
        eventType: baseFields.EventType,
        sessionId,
        trackRecordId: normalizedTrackRecordId,
        recordId: ensureResult.recordId,
        totalPlayedSec: baseFields.TotalPlayedSec,
        timeStreamed: baseFields[STREAM_TIME_FIELD]
      });
    }

    if (STREAM_TERMINAL_EVENTS.has(normalizedType)) {
      clearCachedStreamRecordId(sessionId, normalizedTrackRecordId);
      streamTotalMap.delete(streamKey); // session over — release memory
    } else {
      setCachedStreamRecordId(sessionId, normalizedTrackRecordId, ensureResult.recordId);
    }

    res.json({ ok: true, recordId: ensureResult.recordId, totalPlayedSec: baseFields.TotalPlayedSec });
  } catch (err) {
    console.error('[MASS] stream event failed', err);
    const errorMessage = err?.message || 'Stream event logging failed';
    res.status(500).json({ ok: false, error: errorMessage });
  }
});

export default router;
