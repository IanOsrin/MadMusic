import { Router } from 'express';
import { fmGetRecordById, ensureToken, safeFetch, fmLogin } from '../fm-client.js';
import { validators, pickFieldValueCaseInsensitive, AUDIO_FIELD_CANDIDATES } from '../helpers.js';

const router = Router();

const FM_HOST = process.env.FM_HOST;
const FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';
const REGEX_HTTP_HTTPS = /^https?:\/\//i;

const fmBase = FM_HOST ? `${FM_HOST}/fmi/data/v1/databases/${encodeURIComponent(process.env.FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}` : '';

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

    const record = await fmGetRecordById(layout, recordId);
    if (!record) {
      res.status(404).json({ ok: false, error: 'Record not found' });
      return;
    }

    const fieldData = record.fieldData || {};

    const getFieldValue = (fieldName) => {
      if (!fieldName) return '';
      if (!Object.prototype.hasOwnProperty.call(fieldData, fieldName)) return '';
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

    res.json({ ok: true, url: containerUrl, field: chosenField || requestedField || '' });
  } catch (err) {
    console.error('[MASS] Container refresh failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to refresh container' });
  }
});

router.get('/container', async (req, res) => {
  const direct = (req.query.u || '').toString().trim();
  const rid = (req.query.rid || '').toString().trim();
  const field = (req.query.field || '').toString().trim();
  const rep = (req.query.rep || '1').toString().trim();

  let upstreamUrl = '';
  let requiresAuth = false;

  if (rid && field) {
    const ridValidation = validators.recordId(rid);
    if (!ridValidation.valid) {
      res.status(400).json({ error: 'invalid_input', detail: `Invalid record ID: ${ridValidation.error}` });
      return;
    }
    upstreamUrl = `${fmBase}/records/${encodeURIComponent(rid)}/containers/${encodeURIComponent(field)}/${encodeURIComponent(rep || '1')}`;
    requiresAuth = true;
  } else if (direct) {
    const urlValidation = validators.url(direct);
    if (!urlValidation.valid) {
      res.status(400).json({ error: 'invalid_input', detail: urlValidation.error });
      return;
    }

    if (REGEX_HTTP_HTTPS.test(direct)) {
      try {
        const url = new URL(direct);
        const hostname = url.hostname;

        if (
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname.match(/^10\./) ||
          hostname.match(/^172\.(1[6-9]|2[0-9]|3[01])\./) ||
          hostname.match(/^192\.168\./) ||
          hostname.match(/^169\.254\./) ||
          hostname.match(/^::1$/) ||
          hostname.match(/^fe80:/i) ||
          hostname.match(/^fc00:/i)
        ) {
          res.status(403).json({ error: 'forbidden', detail: 'Access to private/internal IPs not allowed' });
          return;
        }
        upstreamUrl = direct;
      } catch (err) {
        res.status(400).json({ error: 'invalid_input', detail: 'Invalid URL format' });
        return;
      }
    } else {
      upstreamUrl = `${FM_HOST.replace(/\/?$/, '')}/${direct.replace(/^\//, '')}`;
    }
    requiresAuth = upstreamUrl.startsWith(FM_HOST);
  } else {
    res.status(400).json({ error: 'invalid_input', detail: 'Missing rid/field or u parameter.' });
    return;
  }

  let clientAborted = false;
  const controller = new AbortController();
  const onClose = () => {
    clientAborted = true;
    controller.abort();
  };
  req.once('close', onClose);

  try {
    await ensureToken();

    const headers = new Headers();
    if (requiresAuth && fmBase) {
      // Would set auth token here if available
    }
    if (req.headers.range) headers.set('Range', req.headers.range);
    if (req.headers['if-none-match']) headers.set('If-None-Match', req.headers['if-none-match']);
    if (req.headers['if-modified-since']) headers.set('If-Modified-Since', req.headers['if-modified-since']);

    let upstream = await safeFetch(
      upstreamUrl,
      { headers, signal: controller.signal },
      { timeoutMs: 45000, retries: 1 }
    );

    if (upstream.status === 401 && requiresAuth) {
      await fmLogin();
      upstream = await safeFetch(
        upstreamUrl,
        { headers, signal: controller.signal },
        { timeoutMs: 45000, retries: 1 }
      );
    }

    if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
      console.warn('[MASS] Container fetch failed', {
        status: upstream.status,
        requiresAuth,
        url: upstreamUrl.slice(0, 200)
      });
      if (upstream.status === 404) {
        res.status(404).json({ error: 'not_found', status: 404, url: upstreamUrl });
      } else {
        const detail = `Upstream error: ${upstream.status}`;
        res.status(upstream.status).send(detail);
      }
      return;
    }

    res.statusCode = upstream.status;
    for (const [lower, headerName] of MIRROR_HEADERS.entries()) {
      const value = upstream.headers.get(lower);
      if (value !== null) res.setHeader(headerName, value);
    }

    if (!res.getHeader('Accept-Ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    const contentType = res.getHeader('Content-Type') || '';
    if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    if (!upstream.body) {
      res.end();
      return;
    }

    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (clientAborted) {
      return;
    }

    const msg = String(err?.message || '').toLowerCase();
    const code = err?.code || err?.cause?.code;
    if (err?.name === 'AbortError' && err?.timedOut) {
      if (!res.headersSent) res.status(504).send('Upstream timeout');
    } else if (code === 'UND_ERR_SOCKET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || msg.includes('terminated')) {
      if (!res.headersSent) res.status(502).send('Upstream connection terminated');
    } else {
      if (!res.headersSent) res.status(500).send('Container proxy failed');
    }
  } finally {
    req.off('close', onClose);
  }
});

export default router;
