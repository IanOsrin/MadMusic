import { Router } from 'express';
import { fmGetRecordById, ensureToken, safeFetch, fmLogin } from '../fm-client.js';
import { validators } from '../lib/validators.js';
import { AUDIO_FIELD_CANDIDATES, FM_LAYOUT, FM_HOST } from '../lib/fm-fields.js';
import { containerUrlCache } from '../cache.js';

const router = Router();
const REGEX_HTTP_HTTPS = /^https?:\/\//i;

const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i
];

function isPrivateHostname(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  return PRIVATE_IP_PATTERNS.some(p => p.test(hostname));
}

function resolveContainerUpstream(req) {
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
    if (REGEX_HTTP_HTTPS.test(direct)) {
      try {
        const { hostname } = new URL(direct);
        if (isPrivateHostname(hostname)) {
          return { error: { status: 403, body: { error: 'forbidden', detail: 'Access to private/internal IPs not allowed' } } };
        }
        return { upstreamUrl: direct, requiresAuth: direct.startsWith(FM_HOST) };
      } catch {
        return { error: { status: 400, body: { error: 'invalid_input', detail: 'Invalid URL format' } } };
      }
    }
    const upstreamUrl = `${FM_HOST.replace(/\/?$/, '')}/${direct.replace(/^\//, '')}`;
    return { upstreamUrl, requiresAuth: upstreamUrl.startsWith(FM_HOST) };
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

    // Check cache first to avoid a FileMaker round-trip on repeated plays
    const cacheKey = `${layout}::${recordId}`;
    const cached = containerUrlCache.get(cacheKey);
    if (cached) {
      res.json({ ok: true, url: cached.url, field: cached.field, _cached: true });
      return;
    }

    const record = await fmGetRecordById(layout, recordId);
    if (!record) {
      res.status(404).json({ ok: false, error: 'Record not found' });
      return;
    }

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

    if (!containerUrl) {
      res.status(404).json({ ok: false, error: 'Container data not found' });
      return;
    }

    // Cache the resolved URL so repeat plays skip the FileMaker lookup
    containerUrlCache.set(cacheKey, { url: containerUrl, field: chosenField || requestedField || '' });

    res.json({ ok: true, url: containerUrl, field: chosenField || requestedField || '' });
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

async function fetchWithAuthRetry(upstreamUrl, requiresAuth, headers, signal) {
  let upstream = await safeFetch(upstreamUrl, { headers, signal }, { timeoutMs: 45000, retries: 1 });
  if (upstream.status === 401 && requiresAuth) {
    const freshToken = await fmLogin();
    headers.set('Authorization', `Bearer ${freshToken}`);
    upstream = await safeFetch(upstreamUrl, { headers, signal }, { timeoutMs: 45000, retries: 1 });
  }
  return upstream;
}

function applyProxyResponseHeaders(res, upstream) {
  res.statusCode = upstream.status;
  for (const [lower, headerName] of MIRROR_HEADERS.entries()) {
    const value = upstream.headers.get(lower);
    if (value !== null) res.setHeader(headerName, value);
  }
  if (!res.getHeader('Accept-Ranges')) res.setHeader('Accept-Ranges', 'bytes');
  const contentType = res.getHeader('Content-Type') || '';
  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
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
  const resolved = resolveContainerUpstream(req);
  if (resolved.error) {
    const { status, body } = resolved.error;
    res.status(status).json(body);
    return;
  }

  const { upstreamUrl, requiresAuth } = resolved;
  let clientAborted = false;
  const controller = new AbortController();
  const onClose = () => { clientAborted = true; controller.abort(); };
  req.once('close', onClose);

  try {
    const fmToken = await ensureToken();
    const headers = new Headers();
    setProxyRequestHeaders(headers, req, requiresAuth, fmToken);

    const upstream = await fetchWithAuthRetry(upstreamUrl, requiresAuth, headers, controller.signal);

    if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
      sendUpstreamError(res, upstream, upstreamUrl);
      return;
    }

    applyProxyResponseHeaders(res, upstream);
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
