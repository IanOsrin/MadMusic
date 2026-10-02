/**
 * routes/mixer-internal.js — the signed internal API that Mad Mixer on Vercel calls (Vercel → MAD).
 *
 * server.js mounts it at /internal/mixer only when MIXER_SHARED_SECRET is set. It sits OUTSIDE
 * /api/ (no access-token middleware, no apiLimiter, no CDN rewrite), and express.raw is mounted
 * for this path ahead of express.json, so the signature is checked over the exact bytes received.
 *
 *   POST /entitlement    {code}       → { ok, valid, definitive, source, entitled, plan, trial, confirmed, email, expiresAt }
 *   GET  /songs                       → { ok, builtAt, count, songs: [{ id, title, …, playable, hasMaster, audioUrl }] }
 *   POST /trial          {email, ip}  → { ok, code } · 400 · 409 · 429 · 502 (email failed, code revoked) · 503
 *   POST /trial/confirm  {code, sig}  → { ok, confirmed: true } · 400 { reason: 'bad-link' | 'ended' } · 503
 *
 * Every request carries X-MM-Ts + X-MM-Sig (lib/mixer-bridge.js, docs/mixer-bridge-vectors.json);
 * a missing, stale (±60 s) or wrong signature is 401 before anything else runs. The listener's code
 * only ever travels in a signed body — never in a URL — and this router never logs it (lib/auth.js's
 * lookup lines still print whole codes for every MAD validation — an existing issue, design §2g).
 * Every answer is Cache-Control: no-store (they carry codes and emails).
 *
 * entitled = the code's PLAN is a Mad Mixer plan (mixer-trial / mixer / combined) — lib/mixer-plans.js
 * mixerEntitled(). Audio_Lab_Enabled grants nothing here. A MAD-only code is valid but not entitled;
 * the Mixer offers the upgrade. `confirmed` is false only for a free-split code whose email link has
 * not been used yet. `source` says how fresh the answer is: fm (FileMaker just now), cache (FileMaker
 * within the token cache window), stale (FileMaker unreachable, last good answer < 24 h old), json
 * (the local JSON copy) — the Mixer refuses a split on stale/json answers once its own copy of the
 * claims is old.
 */
import { Router } from 'express';
import net from 'node:net';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { verifyRequest, mixerSharedSecret, mixerPublicUrl } from '../lib/mixer-bridge.js';
import { mixerEntitled, MIXER_TRIAL_TYPE } from '../lib/mixer-plans.js';
import { songsWithAudio } from '../lib/mixer-catalogue.js';
import { trialConfirmedCached, startTrial, confirmTrial, mixerTrialLinks } from '../lib/mixer-trial.js';

const EMPTY = Buffer.alloc(0);
const CODE_RE = /^[A-Z0-9][A-Z0-9_.-]{3,63}$/;

const notEntitled = (r) => ({
  ok: true, valid: false, definitive: r.definitive === true, reason: r.reason || 'Invalid token', source: r.source || 'fm',
  entitled: false, plan: null, trial: false, confirmed: false, email: null, expiresAt: null,
});

/**
 * @param {object}   opts
 * @param {Function} opts.resolveToken  async (code) → { valid, definitive?, reason?, source, data?: { type, email,
 *                                      expirationDate, … } } — server.js's resolveTokenForMixer
 * @param {Function} [opts.secret]      → the shared secret (default MIXER_SHARED_SECRET)
 * @param {Function} [opts.mixerUrl]    → Mad Mixer's public address for email links (default MIXER_URL)
 * @param {Function} [opts.now]         → ms clock for the ±60 s check (tests pin it)
 * @param {object}   [opts.limits]      { trialsPerHour = 5 per signed ip, callsPerMinute = 300 in total }
 */
export function createMixerInternalRouter({ resolveToken, secret = mixerSharedSecret, mixerUrl = mixerPublicUrl, now = () => Date.now(), limits = {} } = {}) {
  if (typeof resolveToken !== 'function') throw new Error('createMixerInternalRouter needs resolveToken');
  const { trialsPerHour = 5, callsPerMinute = 300 } = limits;
  const router = Router();

  // 1 · signature, over the raw bytes ───────────────────────────────────────────
  let lastRefusalLogAt = 0;
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const s = secret();
    if (!s) return res.status(503).json({ ok: false, error: 'The Mad Mixer bridge is not configured.' });
    // express.raw leaves a Buffer (or nothing, for a GET). Anything else means a JSON parser ran
    // first and the signed bytes are gone — refuse rather than verify a re-serialisation.
    if (req.body !== undefined && !Buffer.isBuffer(req.body)) {
      console.error('[mixer-internal] body already parsed before the signature check — mount express.raw for /internal/mixer before express.json');
      return res.status(500).json({ ok: false, error: 'Server misconfigured.' });
    }
    const body = req.body || EMPTY;
    const v = verifyRequest({ ts: req.get('x-mm-ts'), sig: req.get('x-mm-sig'), method: req.method, path: req.originalUrl, body, now: now() }, s);
    if (!v.ok) {
      if (Date.now() - lastRefusalLogAt > 10_000) {
        lastRefusalLogAt = Date.now();
        console.warn(`[mixer-internal] refused ${req.method} ${req.path}: ${v.reason}`);
      }
      return res.status(401).json({ ok: false, error: v.reason === 'skew' ? 'Request expired — check the clock.' : 'Bad signature.' });
    }
    req.mmRaw = body;
    next();
  });

  // 2 · backstop: a runaway caller can't flood FileMaker (signed calls only, so outsiders can't
  // spend the Mixer's budget) ─────────────────────────────────────────────────────
  router.use(rateLimit({
    windowMs: 60_000, limit: callsPerMinute, keyGenerator: () => 'mixer-internal',
    standardHeaders: true, legacyHeaders: false, validate: false,
    message: { ok: false, error: 'Too many Mad Mixer calls — slow down.' },
  }));

  const jsonBody = (req, res, next) => {
    let o;
    try { o = JSON.parse(req.mmRaw.toString('utf8')); } catch { return res.status(400).json({ ok: false, error: 'Body must be JSON.' }); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return res.status(400).json({ ok: false, error: 'Body must be a JSON object.' });
    req.mm = o;
    next();
  };

  // 3 · routes ──────────────────────────────────────────────────────────────────
  router.post('/entitlement', jsonBody, async (req, res) => {
    if (typeof req.mm.code !== 'string' || !req.mm.code.trim()) return res.status(400).json({ ok: false, error: 'code is required.' });
    const code = req.mm.code.trim().toUpperCase();
    if (!CODE_RE.test(code)) return res.json(notEntitled({ definitive: true, reason: 'Invalid token', source: 'fm' }));
    let r, confirmed = true;
    try {
      r = await resolveToken(code);
      if (r?.valid && r.data?.type === MIXER_TRIAL_TYPE) confirmed = await trialConfirmedCached(code);
    } catch (err) {
      console.warn('[mixer-internal] entitlement check failed:', err?.message || err);
      return res.status(503).json({ ok: false, error: 'Could not check the code just now.' });
    }
    if (!r?.valid || !r.data) return res.json(notEntitled(r || {}));
    const d = r.data;
    res.json({
      ok: true, valid: true,
      definitive: r.source === 'fm' || r.source === 'cache',
      source: r.source,
      entitled: mixerEntitled(d.type),        // by plan only (lib/mixer-plans.js)
      plan: d.type || null,
      trial: d.type === MIXER_TRIAL_TYPE,
      confirmed,
      email: d.email || null,
      expiresAt: d.expirationDate || null,
    });
  });

  router.get('/songs', async (_req, res) => {
    try {
      const { builtAt, songs } = await songsWithAudio();
      res.json({ ok: true, builtAt, count: songs.length, songs });
    } catch (err) {
      console.warn('[mixer-internal] song list failed:', err?.message || err);
      res.status(502).json({ ok: false, error: 'Could not load the Mad Mixer song list.' });
    }
  });

  // Free split: 5 sign-ups per hour per listener IP. The IP is the one Vercel saw, and it is
  // inside the signed body, so it can't be forged from outside.
  const trialLimiter = rateLimit({
    windowMs: 60 * 60_000, limit: trialsPerHour, keyGenerator: (req) => `trial:${ipKeyGenerator(req.mmIp)}`,
    standardHeaders: true, legacyHeaders: false, validate: false,
    message: { ok: false, error: 'Too many free-split sign-ups from this address. Please try again later.' },
  });
  router.post('/trial', jsonBody, (req, res, next) => {
    req.mmBase = mixerUrl();
    if (!req.mmBase) return res.status(503).json({ ok: false, error: 'Free splits are unavailable right now (MIXER_URL is not set).' });
    const ip = typeof req.mm.ip === 'string' ? req.mm.ip.trim() : '';
    if (!net.isIP(ip)) return res.status(400).json({ ok: false, error: 'ip is required.' });
    req.mmIp = ip;
    next();
  }, trialLimiter, async (req, res) => {
    const base = req.mmBase;
    const r = await startTrial({ email: req.mm.email, links: (code) => mixerTrialLinks(code, base) });
    if (!r.ok) return res.status(r.status === 500 ? 503 : r.status).json({ ok: false, error: r.error });
    res.json({ ok: true, code: r.code });
  });

  router.post('/trial/confirm', jsonBody, async (req, res) => {
    const r = await confirmTrial(typeof req.mm.code === 'string' ? req.mm.code : '', typeof req.mm.sig === 'string' ? req.mm.sig : '');
    if (r.ok) return res.json({ ok: true, confirmed: true });
    if (r.reason === 'error') return res.status(503).json({ ok: false, reason: 'error', error: 'Could not confirm just now. Please try again in a minute.' });
    res.status(400).json({ ok: false, reason: r.reason });
  });

  router.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
  return router;
}
