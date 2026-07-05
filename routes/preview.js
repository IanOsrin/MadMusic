// Guest 30-second audio previews — public, no access token.
//
// GET /api/preview/:recordId streams AT MOST ~GUEST_PREVIEW_SECONDS of the
// track's MP3. The cap is enforced SERVER-SIDE in bytes (lib/mp3-preview.js):
// a guest can never obtain more than the preview prefix from this endpoint,
// regardless of what the client does. The client additionally stops playback
// at exactly 30s for a clean UX.
//
// Mounted only while GUEST_PREVIEW_ENABLED=true (404-fenced before the auth
// middleware otherwise, same pattern as podcasts/suggestions). Track identity
// is recordId; resolution reuses the exact cache/FM path of the token-gated
// /track/:recordId/container route, so no new FileMaker read path is created
// (CLAUDE.md FM-MAP rule).
import { Router } from 'express';
import { ensureToken } from '../fm-client.js';
import { validators } from '../lib/validators.js';
import { FM_LAYOUT, FM_HOST } from '../lib/fm-fields.js';
import { computePreviewCap, _internal as mp3Internal } from '../lib/mp3-preview.js';
import { previewCapCache } from '../cache.js';
import { resolveTrackAudio, fetchWithAuthRetry } from './stream.js';

const router = Router();

export const PREVIEW_SECONDS = Math.max(5, Math.min(60,
  parseInt(process.env.GUEST_PREVIEW_SECONDS, 10) || 30));

const HEAD_FETCH_BYTES = 65536;

function contentRangeTotal(upstream) {
  // "bytes 0-65535/4711234" → 4711234
  const m = /\/(\d+)\s*$/.exec(upstream.headers.get('content-range') || '');
  return m ? parseInt(m[1], 10) : null;
}

// Read at most `limit` bytes from a web stream, then cancel it. Prevents an
// upstream that ignored our Range header (FM containers) from being buffered
// whole into memory.
async function readPrefix(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, Math.min(total, limit));
}

// Compute (and LRU-cache) the preview byte cap + real file size for a track's
// audio URL. One small ranged head-fetch per track, then cached — repeat plays
// and every subsequent Range request skip straight to the stream.
async function getPreviewCap(url, requiresAuth, signal) {
  const cached = previewCapCache.get(url);
  if (cached) return cached;

  let need = HEAD_FETCH_BYTES;
  for (;;) {
    const headers = new Headers();
    if (requiresAuth) headers.set('Authorization', `Bearer ${await ensureToken()}`);
    headers.set('Range', `bytes=0-${need - 1}`);
    const upstream = await fetchWithAuthRetry(url, requiresAuth, headers, signal);
    if (!upstream.ok && upstream.status !== 206) {
      const err = new Error(`Upstream ${upstream.status}`);
      err.upstreamStatus = upstream.status;
      upstream.body?.cancel?.().catch?.(() => {});
      throw err;
    }
    const totalSize = contentRangeTotal(upstream)
      ?? (upstream.status === 200 ? parseInt(upstream.headers.get('content-length'), 10) || null : null);
    const buf = upstream.body ? await readPrefix(upstream.body, need) : Buffer.alloc(0);

    const parsed = computePreviewCap(buf, PREVIEW_SECONDS);
    if (parsed.resolved) {
      const capBytes = totalSize ? Math.min(parsed.capBytes, totalSize) : parsed.capBytes;
      const result = { capBytes, totalSize };
      previewCapCache.set(url, result);
      return result;
    }
    // Parser wants more bytes (large embedded ID3 art). If the file itself is
    // shorter than what we asked for, the whole file IS the preview.
    if (buf.length < need || need >= mp3Internal.MAX_PARSE_BYTES) {
      const capBytes = totalSize ?? buf.length;
      const result = { capBytes, totalSize };
      previewCapCache.set(url, result);
      return result;
    }
    need = Math.min(parsed.needBytes, mp3Internal.MAX_PARSE_BYTES);
  }
}

// Pipe `body` to `res`, skipping `skip` bytes then sending at most `count`.
// Used when an upstream ignores Range requests and sends the file from 0.
async function pipeSlice(body, res, skip, count) {
  const reader = body.getReader();
  let toSkip = skip;
  let remaining = count;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (toSkip > 0) {
        if (chunk.length <= toSkip) { toSkip -= chunk.length; continue; }
        chunk = chunk.subarray(toSkip);
        toSkip = 0;
      }
      if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
      remaining -= chunk.length;
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  res.end();
}

router.get('/preview/:recordId', async (req, res) => {
  let clientAborted = false;
  const controller = new AbortController();
  const onClose = () => { clientAborted = true; controller.abort(); };
  req.once('close', onClose);

  try {
    const recordId = (req.params?.recordId || '').toString().trim();
    const ridValidation = validators.recordId(recordId);
    if (!ridValidation.valid) {
      res.status(400).json({ ok: false, error: 'Invalid record ID' });
      return;
    }

    const layout = (req.query?.layout || FM_LAYOUT || '').toString().trim() || FM_LAYOUT;
    const resolved = await resolveTrackAudio(recordId, layout);
    if (!resolved.ok) {
      res.status(404).json({ ok: false, error: 'Track not found' });
      return;
    }

    const requiresAuth = !!(FM_HOST && resolved.url.startsWith(FM_HOST));
    const { capBytes, totalSize } = await getPreviewCap(resolved.url, requiresAuth, controller.signal);
    // The preview's logical size: never more than the cap, never more than the file.
    const previewSize = totalSize ? Math.min(capBytes, totalSize) : capBytes;

    // Simple single-range support so <audio> elements (Safari in particular)
    // can probe/seek WITHIN the preview window. Anything past the cap is 416 —
    // to the client this file simply ends at the preview boundary.
    let start = 0;
    let end = previewSize - 1;
    let isRange = false;
    const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (rangeMatch) {
      isRange = true;
      start = parseInt(rangeMatch[1], 10);
      end = rangeMatch[2] ? Math.min(parseInt(rangeMatch[2], 10), previewSize - 1) : previewSize - 1;
    }
    if (start >= previewSize || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${previewSize}`);
      res.end();
      return;
    }

    const headers = new Headers();
    if (requiresAuth) headers.set('Authorization', `Bearer ${await ensureToken()}`);
    headers.set('Range', `bytes=${start}-${end}`);
    const upstream = await fetchWithAuthRetry(resolved.url, requiresAuth, headers, controller.signal);
    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status === 404 ? 404 : 502).json({ ok: false, error: 'Preview source unavailable' });
      upstream.body?.cancel?.().catch?.(() => {});
      return;
    }

    res.status(isRange ? 206 : 200);
    const upstreamType = upstream.headers.get('content-type') || '';
    res.setHeader('Content-Type', upstreamType.startsWith('audio/') ? upstreamType : 'audio/mpeg');
    res.setHeader('Content-Length', end - start + 1);
    if (isRange) res.setHeader('Content-Range', `bytes ${start}-${end}/${previewSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    // Same clip for every guest → shared-cacheable. Modest TTL: the cap logic
    // may be tuned and FM container URLs rotate.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Preview-Seconds', PREVIEW_SECONDS);

    if (!upstream.body) { res.end(); return; }

    if (upstream.status === 206) {
      // Upstream honoured the range — the body is exactly our slice.
      await pipeSlice(upstream.body, res, 0, end - start + 1);
    } else {
      // Upstream ignored Range (FM container): skip/cap manually.
      await pipeSlice(upstream.body, res, start, end - start + 1);
    }
  } catch (err) {
    if (clientAborted) return;
    console.error('[MASS] Preview stream failed:', err.message || err);
    if (!res.headersSent) {
      res.status(err.upstreamStatus === 404 ? 404 : 502).json({ ok: false, error: 'Preview unavailable' });
    } else {
      res.end();
    }
  } finally {
    req.off('close', onClose);
  }
});

export default router;
