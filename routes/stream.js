import { Router } from 'express';
import { fmGetRecordById, ensureToken, safeFetch, fmLogin } from '../fm-client.js';
import { validators } from '../lib/validators.js';
import { AUDIO_FIELD_CANDIDATES, FM_LAYOUT, FM_HOST } from '../lib/fm-fields.js';
import { containerUrlCache, trackRecordCache } from '../cache.js';
import { hostnameResolvesPrivate, isSameOrigin } from '../lib/ssrf-guard.js';

const router = Router();
const REGEX_HTTP_HTTPS = /^https?:\/\//i;

// Media origins we are willing to 302 the browser to. Anything else that is
// public and passes the SSRF guard is still served, but proxied through us
// rather than redirected — so this endpoint can't be used as an open redirect
// to bounce victims off our domain.
//
// Both S3 host forms are listed on purpose: audio uses the path-style origin
// (its own connection pool — see the 2026-07-27 "songs hang" incident) while
// artwork uses the virtual-hosted form.
const MEDIA_CDN_HOST = (process.env.MEDIA_CDN_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const REDIRECT_HOST_ALLOWLIST = new Set([
  'mass-music-audio-files.s3.eu-north-1.amazonaws.com',
  's3.eu-north-1.amazonaws.com',
  ...(MEDIA_CDN_HOST ? [MEDIA_CDN_HOST] : [])
].map(h => h.toLowerCase()));

function isRedirectableHost(hostname) {
  return REDIRECT_HOST_ALLOWLIST.has(String(hostname || '').toLowerCase());
}

async function resolveContainerUpstream(req) {
  const rid    = (req.query.rid   || '').toString().trim();
  const field  = (req.query.field || '').toString().trim();
  const rep    = (req.query.rep   || '1').toString().trim();
  const direct = (req.query.u     || '').toString().trim();

  if (rid && field) {
    const ridValidation = validators.recordId(rid);
    if (!ridValidation.valid) {
      return { error: { status: 400, body: { error: 'invalid_input', detail: `Invalid record ID: ${ridValidation.error}` } } };
    }
    const upstreamUrl = `${fmBase}/records/${encodeURIComponent(rid)}/containers/${encodeURIComponent(field)}/${encodeURIComponent(rep || '1')}`;
    return { upstreamUrl, requiresAuth: true };
  }

  if (direct) {
    const urlValidation = validators.url(direct);
    if (!urlValidation.valid) {
      return { error: { status: 400, body: { error: 'invalid_input', detail: urlValidation.error } } };
    }
    // proxy=1 forces the server to stream the bytes through instead of
    // 302-redirecting the browser. Needed by callers that fetch() the audio
    // (e.g. ringtone.html for waveform decode) — fetch() applies CORS to
    // redirect targets and the S3 bucket doesn't send permissive headers.
    const forceProxy = ['1', 'true', 'yes'].includes(
      String(req.query.proxy || '').toLowerCase()
    );
    if (REGEX_HTTP_HTTPS.test(direct)) {
      let hostname;
      try {
        ({ hostname } = new URL(direct));
      } catch {
        return { error: { status: 400, body: { error: 'invalid_input', detail: 'Invalid URL format' } } };
      }

      // This decides whether we attach the FM bearer token, so it MUST be an
      // origin comparison — see isSameOrigin. Do not "simplify" it back to a
      // prefix/startsWith test: that leaks a live FileMaker session.
      const isFmUrl = isSameOrigin(direct, FM_HOST);

      // DNS-resolving SSRF guard. A hostname regex is not enough — several
      // public naming tricks and alternate literal forms resolve to internal
      // addresses without ever looking internal as a string. Skipped for FM
      // (a known-good origin) so playback never depends on a DNS round-trip.
      if (!isFmUrl && await hostnameResolvesPrivate(hostname)) {
        return { error: { status: 403, body: { error: 'forbidden', detail: 'Access to private/internal IPs not allowed' } } };
      }

      // Known media origins — redirect the browser directly instead of
      // proxying. Saves the server round-trip and lets the browser cache.
      if (!isFmUrl && !forceProxy && isRedirectableHost(hostname)) {
        return { redirect: direct };
      }

      // Everything else streams through us. requiresAuth stays true only for
      // FM URLs — public S3 doesn't need (and must never receive) our token.
      return { upstreamUrl: direct, requiresAuth: isFmUrl };
    }
    // Non-HTTP direct path — must be joined with FM_HOST to form a valid URL.
    if (!FM_HOST) {
      return { error: { status: 503, body: { error: 'not_configured', detail: 'FileMaker host not configured' } } };
    }
    const upstreamUrl = `${FM_HOST.replace(/\/?$/, '')}/${direct.replace(/^\//, '')}`;
    return { upstreamUrl, requiresAuth: isSameOrigin(upstreamUrl, FM_HOST) };
  }

  return { error: { status: 400, body: { error: 'invalid_input', detail: 'Missing rid/field or u parameter.' } } };
}

function handleContainerProxyError(err, res, clientAborted) {
  if (clientAborted) return;
  const code = err?.code || err?.cause?.code;
  const msg  = String(err?.message || '').toLowerCase();
  if (res.headersSent) return;
  if (err?.name === 'AbortError' && err?.timedOut) {
    res.status(504).send('Upstream timeout');
  } else if (code === 'UND_ERR_SOCKET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || msg.includes('terminated')) {
    res.status(502).send('Upstream connection terminated');
  } else {
    res.status(500).send('Container proxy failed');
  }
}

const fmBase = FM_HOST ? `${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}` : '';

const MIRROR_HEADERS = new Map([
  ['content-type', 'Content-Type'],
  ['content-length', 'Content-Length'],
  ['accept-ranges', 'Accept-Ranges'],
  ['content-range', 'Content-Range'],
  ['etag', 'ETag'],
  ['last-modified', 'Last-Modified']
]);

// Upstreams whose content is addressed by an immutable, content-hashed key
// (S3 object keys are effectively immutable for our purposes — artwork/audio
// bytes don't change under a given key). Anything matching this pattern can
// be cached by the browser for a year with the `immutable` hint.
const REGEX_IMMUTABLE_S3 = /^https?:\/\/(?:[^/]*\.)?s3[.-][^/]*\//i;

function isImmutableUpstream(upstreamUrl) {
  if (!upstreamUrl) return false;
  return REGEX_IMMUTABLE_S3.test(upstreamUrl);
}

// Resolve a track's audio container URL (+ fresh artwork) by recordId.
// Shared by the token-gated /track/:recordId/container route and the public
// guest-preview route (routes/preview.js) so both hit the same LRU / FM path.
// Returns { ok: true, url, field, artworkUrl, _cached? } or
// { ok: false, reason: 'record_not_found' | 'no_container' }.
// Layouts and fields a CLIENT may name. This resolver returns the raw value of
// whatever field it is pointed at, so leaving either open makes it a general
// read primitive over every table the FM account can reach — including ones
// holding credentials and customer data, not just audio. Callers pass query
// params straight in, so both are allowlisted here (defence in depth) as well
// as rejected at the route. Keep both lists closed.
const ALLOWED_LAYOUTS = new Set([FM_LAYOUT].filter(Boolean));
const ALLOWED_FIELDS = new Set(AUDIO_FIELD_CANDIDATES);

export function isAllowedLayout(layout) {
  return ALLOWED_LAYOUTS.has(String(layout || '').trim());
}

export function isAllowedAudioField(field) {
  return ALLOWED_FIELDS.has(String(field || '').trim());
}

export async function resolveTrackAudio(recordId, layout = FM_LAYOUT, { requestedField = '', candidates = [] } = {}) {
  // Defence in depth: never let an unexpected layout/field reach FileMaker,
  // even if a future caller forgets to validate at the route.
  if (!isAllowedLayout(layout)) layout = FM_LAYOUT;
  if (requestedField && !isAllowedAudioField(requestedField)) requestedField = '';
  candidates = candidates.filter(isAllowedAudioField);

  // Check cache first to avoid a FileMaker round-trip on repeated plays
  const cacheKey = `${layout}::${recordId}`;
  const cached = containerUrlCache.get(cacheKey);
  if (cached) {
    return { ok: true, url: cached.url, field: cached.field, artworkUrl: cached.artworkUrl || '', leadSilence: cached.leadSilence || 0, _cached: true };
  }

  // Read-through fallback (May-17): featured/trending/g100 pre-warm already
  // pull full FM records into trackRecordCache. The audio container URL we
  // need is sitting in that record's fieldData. Reading it from there saves
  // a fresh fmGetRecordById round-trip — which was the cause of the 1-3 s
  // delay before the first song of any non-pre-warmed-by-this-endpoint
  // album/playlist. We still cache the resolved URL into containerUrlCache
  // so the hot path remains a single LRU lookup.
  let record = trackRecordCache.get(cacheKey)
    || trackRecordCache.get(`${FM_LAYOUT}::${recordId}`); // legacy key shape

  // Postgres mirror first (2026-07-18): every track's S3 URL lives in the
  // mirror's raw fieldData, ~5ms away — FileMaker is the LAST resort, never
  // the play path. (Mirror only holds the main layout; other layouts still
  // go to FM.)
  if (!record && layout === FM_LAYOUT) {
    try {
      const { isPgEnabled, query: pgQuery } = await import('../lib/pg.js');
      if (isPgEnabled()) {
        const { rows } = await pgQuery('SELECT raw FROM tracks WHERE fm_record_id = $1 LIMIT 1', [String(recordId)]);
        if (rows?.[0]?.raw) record = { fieldData: rows[0].raw };
      }
    } catch (err) {
      console.warn('[stream] PG resolve failed, falling back to FM:', err?.message);
    }
  }

  if (!record) {
    record = await fmGetRecordById(layout, recordId);
  }

  if (!record) return { ok: false, reason: 'record_not_found' };

  const fieldData = record.fieldData || {};

  const getFieldValue = (fieldName) => {
    if (!fieldName) return '';
    if (!Object.hasOwn(fieldData, fieldName)) return '';
    const raw = fieldData[fieldName];
    if (raw === undefined || raw === null) return '';
    const str = typeof raw === 'string' ? raw.trim() : String(raw).trim();
    return str;
  };

  let chosenField = requestedField;
  let containerUrl = getFieldValue(chosenField);

  const tryCandidates = (list) => {
    for (const candidate of list) {
      const value = getFieldValue(candidate);
      if (value) {
        chosenField = candidate;
        containerUrl = value;
        return true;
      }
    }
    return false;
  };

  if (!containerUrl && candidates.length) {
    tryCandidates(candidates);
  }

  if (!containerUrl) {
    tryCandidates(AUDIO_FIELD_CANDIDATES);
  }

  if (!containerUrl) return { ok: false, reason: 'no_container' };

  // Also resolve a fresh artwork URL from the same record. Saved playlist
  // tracks store absolute FileMaker streaming URLs that expire (401), so
  // callers re-resolve by recordId to get a working artwork for now-playing.
  const ARTWORK_CANDIDATES = ['Artwork_S3_URL', 'Tape Files::Artwork_S3_URL', 'Artwork::Picture', 'Artwork Picture', 'Picture'];
  let artworkUrl = '';
  for (const candidate of ARTWORK_CANDIDATES) {
    const value = getFieldValue(candidate);
    if (value) { artworkUrl = value; break; }
  }

  // Lead-silence skip (2026-07-18): analyzer-measured seconds of dead air at
  // the head of the file (AI_LeadSilence). Players seek to (value − 1s) when
  // > 1s. Sentinel −1 (measure failed) and the 20s cap value are passed as-is;
  // the frontend clamps.
  const leadRaw = Number.parseFloat(fieldData['AI_LeadSilence']);
  const leadSilence = Number.isFinite(leadRaw) && leadRaw > 0 && leadRaw <= 20 ? leadRaw : 0;

  // Cache the resolved URLs so repeat plays skip the FileMaker lookup
  containerUrlCache.set(cacheKey, { url: containerUrl, field: chosenField || requestedField || '', artworkUrl, leadSilence });

  return { ok: true, url: containerUrl, field: chosenField || requestedField || '', artworkUrl, leadSilence };
}

router.get('/track/:recordId/container', async (req, res) => {
  try {
    const recordId = (req.params?.recordId || '').toString().trim();
    if (!recordId) {
      res.status(400).json({ ok: false, error: 'Record ID required' });
      return;
    }

    const layout = (req.query?.layout || FM_LAYOUT || '').toString().trim() || FM_LAYOUT;
    const requestedField = (req.query?.field || '').toString().trim();
    const candidateParam = (req.query?.candidates || '').toString().trim();
    const candidates = candidateParam
      ? candidateParam.split(',').map((value) => value.trim()).filter(Boolean)
      : [];

    // Reject rather than silently coerce, so a caller asking for something it
    // shouldn't gets a clear 400 instead of a confusing audio URL.
    if (!isAllowedLayout(layout)) {
      res.status(400).json({ ok: false, error: 'Unsupported layout' });
      return;
    }
    const badField = [requestedField, ...candidates].find(f => f && !isAllowedAudioField(f));
    if (badField) {
      res.status(400).json({ ok: false, error: 'Unsupported field' });
      return;
    }

    const resolved = await resolveTrackAudio(recordId, layout, { requestedField, candidates });

    if (!resolved.ok) {
      const message = resolved.reason === 'record_not_found' ? 'Record not found' : 'Container data not found';
      res.status(404).json({ ok: false, error: message });
      return;
    }

    const { url, field, artworkUrl, leadSilence, _cached } = resolved;
    res.json(_cached
      ? { ok: true, url, field, artworkUrl, leadSilence: leadSilence || 0, _cached: true }
      : { ok: true, url, field, artworkUrl, leadSilence: leadSilence || 0 });
  } catch (err) {
    console.error('[MASS] Container refresh failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to refresh container' });
  }
});

function setProxyRequestHeaders(headers, req, requiresAuth, fmToken) {
  if (requiresAuth && fmBase) headers.set('Authorization', `Bearer ${fmToken}`);
  if (req.headers.range) headers.set('Range', req.headers.range);
  if (req.headers['if-none-match']) headers.set('If-None-Match', req.headers['if-none-match']);
  if (req.headers['if-modified-since']) headers.set('If-Modified-Since', req.headers['if-modified-since']);
}

export async function fetchWithAuthRetry(upstreamUrl, requiresAuth, headers, signal) {
  let upstream = await safeFetch(upstreamUrl, { headers, signal }, { timeoutMs: 45000, retries: 1 });
  if (upstream.status === 401 && requiresAuth) {
    const freshToken = await fmLogin();
    headers.set('Authorization', `Bearer ${freshToken}`);
    upstream = await safeFetch(upstreamUrl, { headers, signal }, { timeoutMs: 45000, retries: 1 });
  }
  return upstream;
}

function applyProxyResponseHeaders(res, upstream, upstreamUrl) {
  res.statusCode = upstream.status;
  for (const [lower, headerName] of MIRROR_HEADERS.entries()) {
    const value = upstream.headers.get(lower);
    if (value !== null) res.setHeader(headerName, value);
  }
  if (!res.getHeader('Accept-Ranges')) res.setHeader('Accept-Ranges', 'bytes');
  const contentType = res.getHeader('Content-Type') || '';
  const immutable   = isImmutableUpstream(upstreamUrl);
  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
    // S3-origin audio is content-hashed → cache for a year. FM-origin audio
    // goes through a FM container URL that can rotate, so keep a modest TTL.
    res.setHeader('Cache-Control',
      immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=86400');
  } else if (contentType.startsWith('image/')) {
    res.setHeader('Cache-Control',
      immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=604800, stale-while-revalidate=2592000');
  }
}

function sendUpstreamError(res, upstream, upstreamUrl) {
  console.warn('[MASS] Container fetch failed', { status: upstream.status, url: upstreamUrl.slice(0, 200) });
  if (upstream.status === 404) {
    res.status(404).json({ error: 'not_found', status: 404, url: upstreamUrl });
  } else {
    res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
  }
}

router.get('/container', async (req, res) => {
  const resolved = await resolveContainerUpstream(req);
  if (resolved.error) {
    const { status, body } = resolved.error;
    res.status(status).json(body);
    return;
  }

  // Public S3/CDN image — redirect directly; no proxy overhead, browser caches it
  if (resolved.redirect) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.redirect(302, resolved.redirect);
    return;
  }

  const { upstreamUrl, requiresAuth } = resolved;
  let clientAborted = false;
  const controller = new AbortController();
  const onClose = () => { clientAborted = true; controller.abort(); };
  req.once('close', onClose);

  try {
    // Only acquire a FM token for requests that actually need it (FM container URLs).
    // Public S3/CDN URLs must not block on a FM login — playback fails if FM is down.
    const fmToken = requiresAuth ? await ensureToken() : null;
    const headers = new Headers();
    setProxyRequestHeaders(headers, req, requiresAuth, fmToken);

    const upstream = await fetchWithAuthRetry(upstreamUrl, requiresAuth, headers, controller.signal);

    if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
      sendUpstreamError(res, upstream, upstreamUrl);
      return;
    }

    applyProxyResponseHeaders(res, upstream, upstreamUrl);
    if (!upstream.body) { res.end(); return; }

    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    handleContainerProxyError(err, res, clientAborted);
  } finally {
    req.off('close', onClose);
  }
});

export default router;
