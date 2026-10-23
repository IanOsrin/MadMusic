/**
 * routes/mixer-internal.js — the signed internal API that Mad Mixer on Vercel calls (Vercel → MAD).
 *
 * server.js mounts it at /internal/mixer only when MIXER_SHARED_SECRET is set. It sits OUTSIDE
 * /api/ (no access-token middleware, no apiLimiter, no CDN rewrite), and express.raw is mounted
 * for this path ahead of express.json, so the signature is checked over the exact bytes received.
 *
 *   POST /entitlement    {code}       → { ok, valid, definitive, source, entitled, plan, trial, confirmed, email, expiresAt }
 *   GET  /songs                       → { ok, builtAt, count, songs: [{ id, title, …, key, bpm, playable, hasMaster, audioUrl }] }
 *                                       (bpm from MadStreamer AI_BPM via lib/mixer-streamer.js; null until its first build)
 *   GET  /packs                       → { ok, builtAt, count, packs: [{ id, title, song, bpm, bars, loops: [{ label, file, url, bytes, seconds }] }] }
 *   GET  /samples                     → { ok, builtAt, kinds: [{ kind, samples: [{ id, name, bytes }] }] } — the drum-trigger library
 *   GET  /hq                          → { ok, builtAt, count, sets: [{ setId, title, stems: [{ stemId, label, file, bytes, seconds }] }] }
 *                                        (the audio streams from Vision through MAD — routes/mixer-hq-audio.js)
 *   POST /trial          {email, ip}  → { ok, code } · 400 · 409 · 429 · 502 (email failed, code revoked) · 503
 *   POST /trial/confirm  {code, sig}  → { ok, confirmed: true } · 400 { reason: 'bad-link' | 'ended' } · 503
 *   POST /registrations/upload {regId, file, bytes} → { ok, url, key, expiresAt } — a 1-hour PUT link to the private
 *                                       registrations bucket · 400 · 503 (storage not set up)
 *   POST /registrations  {regId, acct, …song details, fileKey, fileName, fileBytes} → { ok, registration } — saved in
 *                                       MADMixer "Registrations" once the upload is there at that size · 400 · 503
 *   POST /registrations/list {acct}   → { ok, ready, registrations: [{ regId, status, newTitle, … }] } newest first
 *   POST /subscribe      {email}      → { ok, url } — a Paystack checkout for the Mad Mixer plan · 400 · 503
 *                                        (MAD takes the payment and makes the code; Paystack returns the
 *                                        listener to MAD's /api/payments/callback?source=mixer, which sends
 *                                        them on to Mad Mixer signed in — routes/payments.js)
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
import { mixerEntitled, isMixerTrial, planOf } from '../lib/mixer-plans.js';
import { songsWithAudio, mixerPacks, mixerHqStems } from '../lib/mixer-catalogue.js';
import { bpmBySong } from '../lib/mixer-streamer.js';
import { mixerSamples } from '../lib/mixer-samples.js';
import { trialConfirmedCached, startTrial, confirmTrial, mixerTrialLinks } from '../lib/mixer-trial.js';
import { paystackRequest, PAYSTACK_MIXER_PLAN } from '../lib/paystack.js';
import { isStrictEmail } from '../lib/validators.js';
import { regStorageConfigured, uploadLink, uploadedBytes, uploadKey, createRegistration, findRegistration, registrationsFor,
  REG_ID_RE, ACCT_RE, AUDIO_FILE_RE, MAX_UPLOAD_BYTES } from '../lib/mixer-registrations.js';

// A Paystack checkout for the Mad Mixer plan (2026-10-05). Same shape as MAD's own subscription
// checkout (routes/payments.js /subscribe), with the Mixer plan and source=mixer on the callback.
async function startMixerCheckout({ email, appBase }) {
  const plan = PAYSTACK_MIXER_PLAN.code();
  if (!plan || !process.env.PAYSTACK_SECRET_KEY) return { ok: false, status: 503, error: 'Mad Mixer subscriptions aren’t open yet.' };
  const data = await paystackRequest('POST', '/transaction/initialize', {
    email,
    amount: PAYSTACK_MIXER_PLAN.amount,
    plan,
    callback_url: `${appBase}/api/payments/callback?source=mixer&type=subscription`,
    metadata: { payment_type: 'subscription', plan_code: plan, product: 'mixer', source: 'mixer' },
  });
  const url = data?.data?.authorization_url;
  if (!url) return { ok: false, status: 503, error: 'Payments are unavailable right now. Please try again later.' };
  console.log(`[mixer-internal] Mad Mixer checkout opened: ${data.data.reference}`);
  return { ok: true, url };
}

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
 * @param {Function} [opts.startCheckout] async ({ email, appBase }) → { ok, url } | { ok: false, status, error } (tests stub it)
 */
export function createMixerInternalRouter({ resolveToken, secret = mixerSharedSecret, mixerUrl = mixerPublicUrl, now = () => Date.now(), limits = {}, startCheckout = startMixerCheckout } = {}) {
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
      if (r?.valid && isMixerTrial(r.data?.type)) confirmed = await trialConfirmedCached(code);
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
      entitled: mixerEntitled(d.type),        // by plan only (lib/mixer-plans.js), any capitalisation
      plan: planOf(d.type) || null,
      trial: isMixerTrial(d.type),
      confirmed,
      email: d.email || null,
      expiresAt: d.expirationDate || null,
    });
  });

  router.get('/songs', async (_req, res) => {
    try {
      const [{ builtAt, songs }, bpm] = await Promise.all([songsWithAudio(), bpmBySong()]);
      // Tempo: MADMixer's own AI_BPM if it ever gets one, else MadStreamer's for the same song.
      const withBpm = songs.map((s) => (s.bpm || !bpm[s.id] ? s : { ...s, bpm: bpm[s.id] }));
      res.json({ ok: true, builtAt, count: songs.length, songs: withBpm });
    } catch (err) {
      console.warn('[mixer-internal] song list failed:', err?.message || err);
      res.status(502).json({ ok: false, error: 'Could not load the Mad Mixer song list.' });
    }
  });

  // Loop packs (2026-10-08): who may have them is the Mixer's call (subscribers, not free splits).
  router.get('/packs', async (_req, res) => {
    try {
      const { builtAt, packs } = await mixerPacks();
      res.json({ ok: true, builtAt, count: packs.length, packs });
    } catch (err) {
      console.warn('[mixer-internal] pack list failed:', err?.message || err);
      res.status(502).json({ ok: false, error: 'Could not load the Mad Mixer packs.' });
    }
  });

  // The drum-trigger sample library (2026-10-08): one-shots in a Vision folder; paths stay in MAD.
  router.get('/samples', async (_req, res) => {
    try {
      const { builtAt, kinds } = await mixerSamples();
      res.json({ ok: true, builtAt, kinds: kinds.map((k) => ({ kind: k.kind, samples: k.samples.map(({ path, ...s }) => s) })) });
    } catch (err) {
      console.warn('[mixer-internal] sample list failed:', err?.message || err);
      res.status(502).json({ ok: false, error: 'Could not load the samples.' });
    }
  });

  // HQ stems (2026-10-08): sets of studio stems (not tied to the song list); who may load them is the Mixer's call.
  router.get('/hq', async (_req, res) => {
    try {
      const { builtAt, sets } = await mixerHqStems();
      const out = sets.map((s) => ({ ...s, stems: s.stems.map(({ visionPath, ...t }) => t) }));   // Vision paths stay in MAD
      res.json({ ok: true, builtAt, count: out.length, sets: out });
    } catch (err) {
      console.warn('[mixer-internal] HQ stem list failed:', err?.message || err);
      res.status(502).json({ ok: false, error: 'Could not load the HQ stems.' });
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

  // Subscribe: Mad Mixer never takes payments — it asks MAD for a Paystack checkout and sends the
  // listener there. Needs MIXER_URL (where Paystack's return trip ends up) and the Mixer plan code.
  router.post('/subscribe', jsonBody, async (req, res) => {
    const email = typeof req.mm.email === 'string' ? req.mm.email.trim().toLowerCase() : '';
    if (!isStrictEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    if (!mixerUrl()) return res.status(503).json({ ok: false, error: 'Mad Mixer subscriptions aren’t open yet.' });
    const appBase = (process.env.APP_URL || process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    try {
      const r = await startCheckout({ email, appBase });
      if (r.ok) return res.json({ ok: true, url: r.url });
      return res.status(r.status || 503).json({ ok: false, error: r.error || 'Payments are unavailable right now.' });
    } catch (err) {
      console.error('[mixer-internal] Mad Mixer checkout failed:', err?.message || err);
      res.status(503).json({ ok: false, error: 'Payments are unavailable right now. Please try again later.' });
    }
  });

  // Song registrations (Ian, 2026-10-23): who may register (subscribers, not free splits) and whether the
  // page is switched on are the Mixer's call; MAD keeps the records (MADMixer "Registrations") and signs
  // the upload links for the full-quality copy (a private S3 bucket). lib/mixer-registrations.js.
  const regOff = (res) => res.status(503).json({ ok: false, error: 'Song registration is not set up yet.' });
  router.post('/registrations/upload', jsonBody, (req, res) => {
    if (!regStorageConfigured()) return regOff(res);
    const { regId, file, bytes } = req.mm;
    if (typeof regId !== 'string' || !REG_ID_RE.test(regId)) return res.status(400).json({ ok: false, error: 'Bad registration id.' });
    if (typeof file !== 'string' || !AUDIO_FILE_RE.test(file) || file.length > 300) return res.status(400).json({ ok: false, error: 'Please choose a WAV, AIFF or FLAC file.' });
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, error: 'The file must be under 1 GB.' });
    res.json({ ok: true, ...uploadLink({ regId, file, bytes }) });
  });

  router.post('/registrations', jsonBody, async (req, res) => {
    if (!regStorageConfigured()) return regOff(res);
    const v = validateRegistration(req.mm);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    const f = v.fields;
    try {
      const existing = await findRegistration(f.regId);
      if (existing) return res.json({ ok: true, registration: existing, again: true });   // a retry after a lost answer
      const size = await uploadedBytes(f.fileKey);
      if (size == null) return res.status(400).json({ ok: false, error: 'We couldn’t find your uploaded song. Please upload it again.' });
      if (size !== f.fileBytes) return res.status(400).json({ ok: false, error: 'Your upload didn’t finish. Please upload the song again.' });
      const registration = await createRegistration(f);
      console.log(`[mixer-internal] song registration ${f.regId} saved`);
      res.json({ ok: true, registration });
    } catch (err) {
      console.error('[mixer-internal] song registration failed:', err?.message || err);
      res.status(503).json({ ok: false, error: 'We couldn’t save your registration just now. Please try again in a minute.' });
    }
  });

  router.post('/registrations/list', jsonBody, async (req, res) => {
    const acct = typeof req.mm.acct === 'string' ? req.mm.acct : '';
    if (!ACCT_RE.test(acct)) return res.status(400).json({ ok: false, error: 'Bad account.' });
    try {
      res.json({ ok: true, ready: regStorageConfigured(), registrations: await registrationsFor(acct) });
    } catch (err) {
      console.warn('[mixer-internal] registration list failed:', err?.message || err);
      res.status(502).json({ ok: false, error: 'Could not load your registrations.' });
    }
  });

  router.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
  return router;
}

// The Mixer has already checked all of this with friendlier words; MAD re-checks the shape it stores.
const MATERIALS = ['AI-split stems', 'Loop pack', 'HQ stems', 'Drum samples'];
const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const DCX_RE = /^DCX-\d{8}-[A-Z2-9]{6}$/;
export function validateRegistration(b) {
  const str = (k, max, req = true) => {
    const v = typeof b[k] === 'string' ? b[k].trim().replace(/\s+/g, ' ') : '';
    if (req && !v) throw new Error(`${k} is required.`);
    if (v.length > max) throw new Error(`${k} is too long.`);
    return v;
  };
  try {
    const regId = str('regId', 40), acct = str('acct', 64);
    if (!REG_ID_RE.test(regId) || !ACCT_RE.test(acct)) throw new Error('Bad registration id or account.');
    const fields = {
      regId, acct, email: str('email', 254, false), plan: str('plan', 40, false),
      originalSongId: str('originalSongId', 20, false), originalTitle: str('originalTitle', 200), originalArtist: str('originalArtist', 200, false), originalIsrc: str('originalIsrc', 20, false),
      newTitle: str('newTitle', 200), newArtist: str('newArtist', 200), newIsrc: str('newIsrc', 15).replace(/-/g, '').toUpperCase(),
      distributor: str('distributor', 200), releaseDate: str('releaseDate', 10), writers: str('writers', 1000, false), notes: str('notes', 2000, false),
      fileKey: str('fileKey', 200), fileName: str('fileName', 300), licenceVersion: str('licenceVersion', 40),
      material: Array.isArray(b.material) ? b.material.filter((m) => MATERIALS.includes(m)) : [],
      dcxIds: Array.isArray(b.dcxIds) ? [...new Set(b.dcxIds.filter((d) => typeof d === 'string' && DCX_RE.test(d)))].slice(0, 100) : [],
      secondsUsed: Number(b.secondsUsed), fileBytes: Number(b.fileBytes),
    };
    if (!ISRC_RE.test(fields.newIsrc)) throw new Error('newIsrc is not an ISRC.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.releaseDate)) throw new Error('releaseDate must be YYYY-MM-DD.');
    if (!fields.material.length) throw new Error('material is required.');
    if (!(fields.secondsUsed > 0 && fields.secondsUsed <= 30)) throw new Error('secondsUsed must be more than 0 and at most 30.');
    if (!Number.isSafeInteger(fields.fileBytes) || fields.fileBytes < 1) throw new Error('fileBytes is required.');
    if (fields.fileKey !== uploadKey(regId, fields.fileName)) throw new Error('fileKey does not belong to this registration.');
    return { ok: true, fields };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
