import { Router } from 'express';
import { validateAccessToken, MASS_SESSION_COOKIE, MASS_SESSION_MAX_AGE_SECONDS } from '../lib/auth.js';
import { parseCookies, getClientIP } from '../lib/http.js';
import { formatTimestampUTC, toCleanString, normalizeSeconds } from '../lib/format.js';
import { validateSessionId } from '../lib/validators.js';
import {
  STREAM_EVENT_TYPES, STREAM_EVENT_DEBUG, STREAM_TERMINAL_EVENTS,
  STREAM_TIME_FIELD, STREAM_TIME_FIELD_LEGACY,
  ensureStreamRecord, findStreamRecord,
  setCachedStreamRecordId, clearCachedStreamRecordId, getCachedStreamRecordId
} from '../lib/stream-events.js';
import { fmUpdateRecord, fmFindRecords } from '../fm-client.js';
import { tokenValidationCache } from '../cache.js';
import { FM_STREAM_EVENTS_LAYOUT } from '../lib/fm-fields.js';
import { randomUUID } from 'node:crypto';

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
      if (result.email) {
        const emailCookieParts = [
          `mass.email=${encodeURIComponent(result.email)}`,
          'Path=/',
          'Max-Age=31536000',
          'SameSite=Lax'
        ];
        res.setHeader('Set-Cookie', emailCookieParts.join('; '));
      }
      res.json({
        ok: true,
        valid: true,
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
      { 'Token_Code': `==${trimmedCode}` }
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
  let sessionId = Array.isArray(headersSessionRaw) ? headersSessionRaw[0] : headersSessionRaw;
  if (typeof sessionId === 'string') sessionId = sessionId.trim();
  if (!sessionId) sessionId = cookies[MASS_SESSION_COOKIE] || '';

  const validatedSession = validateSessionId(sessionId);
  if (!validatedSession) {
    if (STREAM_EVENT_DEBUG && cookies[MASS_SESSION_COOKIE]) {
      console.log('[SECURITY] Invalid session ID rejected, generating new one');
    }
    return randomUUID();
  }
  return validatedSession;
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

  const existingTotalPlayed = normalizeSeconds(existingFields.TotalPlayedSec);
  const effectiveDelta = payloadDelta || deltaFromPosition;
  baseFields.DeltaSec = effectiveDelta;
  baseFields.TotalPlayedSec = existingTotalPlayed + effectiveDelta;
  baseFields.LastEventUTC = timestamp;
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
        'SameSite=Lax'
      ];
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

    const normalizedTrackISRC = toCleanString(trackISRC);
    const normalizedPosition = normalizeSeconds(positionSec);
    const normalizedDuration = normalizeSeconds(durationSec);
    const payloadDelta = normalizeSeconds(deltaSec);
    const tokenCode = req.accessToken?.code || '';
    const issuedTo  = req.accessToken?.email || '';

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
      Email: issuedTo
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
      Email: issuedTo
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
    const existingFields = ensureResult.existingFieldData || {};

    applyExistingFieldsToBase(baseFields, existingFields, normalizedType, timestamp, payloadDelta, normalizedDuration);

    if (STREAM_EVENT_DEBUG) {
      console.info('[MASS] Updating FileMaker record with Token_Number:', baseFields.Token_Number);
    }

    await fmUpdateRecord(FM_STREAM_EVENTS_LAYOUT, ensureResult.recordId, baseFields);

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
