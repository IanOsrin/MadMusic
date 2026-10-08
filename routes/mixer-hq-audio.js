/**
 * routes/mixer-hq-audio.js — Mad Mixer's HQ stems stream from Vision through MAD (Ian, 2026-10-08: "No S3
 * needed, we will create a dedicated Vision folder").
 *
 *   GET /mixer-hq/:stemId?exp=<unix seconds>&sig=<base64url>   → the stem's WAV (Range supported: 206)
 *
 * The link comes from Mad Mixer's GET /api/hq, which only subscribers get; it lasts a few hours
 * (lib/mixer-bridge.js hqAudioSig — its own key, derived from MIXER_SHARED_SECRET). The stem is a record in
 * MADMixer's HQ_Stems (lib/mixer-catalogue.js hqStemById); its Vision_Path must sit inside
 * MIXER_HQ_VISION_PREFIX (the dedicated folder, e.g. "/gallo-masters/HQ Stems/") — a record pointing anywhere
 * else on Vision is refused, so the link can never reach the rest of the masters. Vision is only read.
 *
 *   GET /mixer-sample/:id?exp=&sig=   → a one-shot from the drum-trigger sample library (lib/mixer-samples.js) —
 *                                       the same signing (id "s-<id>"), only inside MIXER_SAMPLES_VISION_PREFIX, ≤ 8 MB
 *
 * CORS: the Mixer's own origin (MIXER_URL) may read it. Mounted outside /api/ (no token middleware, no
 * apiLimiter) when MIXER_SHARED_SECRET is set; its own limiter caps a burst from one address.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { hqAudioSig, mixerPublicUrl } from '../lib/mixer-bridge.js';
import { hqStemById } from '../lib/mixer-catalogue.js';
import { visionConfigured, visionGet } from '../lib/vision-read.js';
import { sampleById, samplesPrefix, MAX_SAMPLE_BYTES } from '../lib/mixer-samples.js';

const MAX_LIFE_S = 6 * 3600;
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hqPrefix = () => {
  const p = String(process.env.MIXER_HQ_VISION_PREFIX || '').trim();
  return p ? (p.startsWith('/') ? p : '/' + p).replace(/\/*$/, '/') : '';
};

export function createMixerHqAudioRouter({ now = () => Date.now() } = {}) {
  const router = Router();
  const origin = (() => { try { return new URL(mixerPublicUrl()).origin; } catch { return ''; } })();
  const cors = (res) => { if (origin) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges'); } };

  router.options('/:stemId', (_req, res) => {
    cors(res); res.set('Access-Control-Allow-Methods', 'GET'); res.set('Access-Control-Allow-Headers', 'Range'); res.set('Access-Control-Max-Age', '600');
    res.status(204).end();
  });

  router.get('/:stemId', rateLimit({ windowMs: 60_000, limit: 120, keyGenerator: (req) => `hq:${ipKeyGenerator(req.ip)}`, standardHeaders: true, legacyHeaders: false, validate: false }),
    async (req, res) => {
      cors(res);
      res.set('Cache-Control', 'private, no-store, no-transform');   // no-transform: never gzip the audio
      const stemId = String(req.params.stemId || ''), exp = Number(req.query.exp), sig = String(req.query.sig || '');
      const nowS = Math.floor(now() / 1000);
      if (!/^\d{1,12}$/.test(stemId) || !Number.isInteger(exp) || !sig) return res.status(400).json({ ok: false, error: 'Bad link' });
      if (exp < nowS) return res.status(403).json({ ok: false, error: 'This link has expired — reopen the HQ stems in Mad Mixer.' });
      if (exp > nowS + MAX_LIFE_S || !same(sig, hqAudioSig(stemId, exp))) return res.status(403).json({ ok: false, error: 'Bad link' });
      const prefix = hqPrefix();
      if (!prefix || !visionConfigured()) return res.status(503).json({ ok: false, error: 'HQ stems aren’t set up on this server yet.' });
      let stem;
      try { stem = await hqStemById(stemId); } catch (err) { console.warn('[mixer-hq] list failed:', err?.message); return res.status(502).json({ ok: false, error: 'Could not look the stem up.' }); }
      if (!stem) return res.status(404).json({ ok: false, error: 'No such stem.' });
      if (!stem.visionPath.startsWith(prefix) || stem.visionPath.split('/').includes('..')) {
        console.warn(`[mixer-hq] refused stem ${stemId}: its Vision path is outside ${prefix}`);
        return res.status(403).json({ ok: false, error: 'That stem is outside the HQ stems folder.' });
      }
      const range = /^bytes=\d*-\d*$/.test(String(req.headers.range || '')) ? req.headers.range : undefined;
      const ac = new AbortController();
      req.on('close', () => { if (!res.writableEnded) ac.abort(); });
      try {
        const obj = await visionGet(stem.visionPath, range, ac.signal);
        res.status(range && obj.ContentRange ? 206 : 200);
        res.set('Content-Type', 'audio/wav');
        res.set('Accept-Ranges', 'bytes');
        if (obj.ContentLength != null) res.set('Content-Length', String(obj.ContentLength));
        if (range && obj.ContentRange) res.set('Content-Range', obj.ContentRange);
        obj.Body.on('error', (err) => { console.warn(`[mixer-hq] stream ${stemId} broke:`, err?.message); res.destroy(err); });
        obj.Body.pipe(res);
      } catch (err) {
        if (ac.signal.aborted) return;
        const status = err?.$metadata?.httpStatusCode;
        console.warn(`[mixer-hq] Vision read failed for stem ${stemId}:`, err?.name || err?.message);
        if (!res.headersSent) res.status(status === 404 || err?.name === 'NoSuchKey' ? 404 : status === 416 ? 416 : 502).json({ ok: false, error: 'The stem couldn’t be read from Vision.' });
      }
    });
  // The drum-trigger sample library: same link check (signed over "s-<id>"), the sample's own folder.
  router.get('/sample/:id', rateLimit({ windowMs: 60_000, limit: 300, keyGenerator: (req) => `smp:${ipKeyGenerator(req.ip)}`, standardHeaders: true, legacyHeaders: false, validate: false }),
    async (req, res) => {
      cors(res);
      res.set('Cache-Control', 'private, max-age=3600, no-transform');
      const id = String(req.params.id || ''), exp = Number(req.query.exp), sig = String(req.query.sig || '');
      const nowS = Math.floor(now() / 1000);
      if (!/^[0-9a-f]{16}$/.test(id) || !Number.isInteger(exp) || !sig) return res.status(400).json({ ok: false, error: 'Bad link' });
      if (exp < nowS) return res.status(403).json({ ok: false, error: 'This link has expired.' });
      if (exp > nowS + MAX_LIFE_S || !same(sig, hqAudioSig(`s-${id}`, exp))) return res.status(403).json({ ok: false, error: 'Bad link' });
      if (!visionConfigured()) return res.status(503).json({ ok: false, error: 'Samples aren’t set up on this server yet.' });
      let s;
      try { s = await sampleById(id); } catch (err) { console.warn('[mixer-sample] list failed:', err?.message); return res.status(502).json({ ok: false, error: 'Could not look the sample up.' }); }
      if (!s) return res.status(404).json({ ok: false, error: 'No such sample.' });
      if (!s.path.startsWith(samplesPrefix()) || s.bytes > MAX_SAMPLE_BYTES) return res.status(403).json({ ok: false, error: 'Not a library sample.' });
      try {
        const obj = await visionGet(s.path);
        res.set('Content-Type', 'audio/wav');
        if (obj.ContentLength != null) res.set('Content-Length', String(obj.ContentLength));
        obj.Body.on('error', (err) => res.destroy(err));
        obj.Body.pipe(res);
      } catch (err) {
        console.warn(`[mixer-sample] Vision read failed for ${id}:`, err?.name || err?.message);
        if (!res.headersSent) res.status(502).json({ ok: false, error: 'The sample couldn’t be read from Vision.' });
      }
    });
  router.options('/sample/:id', (_req, res) => { cors(res); res.set('Access-Control-Allow-Methods', 'GET'); res.status(204).end(); });
  return router;
}
