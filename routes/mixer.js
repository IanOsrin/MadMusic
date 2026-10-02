/**
 * routes/mixer.js — Mad Mixer: the Digital Cupboard Stems app, served inside MAD.
 *
 * Mounted at /api/mixer (dark unless MAD_MIXER_ENABLED=true). The Stems app keeps its own
 * endpoint names (`${API_BASE}/mvsep/create` etc.), so this router mirrors the routes of
 * DCMax's scripts/server.py with API_BASE = '/api/mixer'. Every call carries the listener's
 * MAD access token (added by public/js/mad-mixer.js), so the normal /api token middleware
 * has already validated it and set req.accessToken before anything here runs.
 *
 *   GET  /ping                         → { ok, engine, entitled }
 *   POST /auth                         → { ok, used, quota, remaining } or 402 when not subscribed
 *   GET  /usage                        → { used, quota, remaining } for this month
 *   GET  /songs                        → the MADMixer song list (the picker)
 *   GET  /songs/:id                    → one song + its MP3 on the media CDN (?song= opens)
 *   GET  /mixable                      → { tracks: { madStreamerRecordId: madMixerSongId } } —
 *                                        which MAD tracks get the 🎚 button (any signed-in token)
 *   GET  /mvsep/algorithms             → MVSEP model catalogue (cached 1 h)
 *   POST /mvsep/create?sep_type=…      → raw WAV body, STREAMED to MVSEP as multipart (never buffered).
 *                                        Needs X-Mixer-Song: <MADMixer id> — Mad Mixer only splits its own
 *                                        songs (or their stems), never listeners' own files (Ian, 2026-09-28)
 *   GET  /mvsep/get?hash=…             → MVSEP job status / result links
 *   GET  /audio-proxy?url=…            → streams a finished stem from MVSEP (mvsep hosts only)
 *   POST /dcx/register?id=&sha=&name=  → provenance line for every export (DCX Sample Registry)
 *
 * ENTITLEMENT (the "Mad Mixer" tier): a token is entitled when its FM record has
 * Audio_Lab_Enabled = 1 (the existing flag, reused so no FM field changes are needed yet),
 * or — local testing only — when MIXER_OPEN_TO_ALL_TOKENS=true. The Paystack tier that sets
 * the flag on purchase is the next step.
 *
 * METERING: 1 successful MVSEP create = 1 split. MIXER_SPLITS_PER_MONTH (default 30) per token
 * per calendar month. Stored in data/mixer-usage.json — a local file ON PURPOSE: the local
 * .env points at the PRODUCTION Postgres, and nothing local may write there.
 *
 * MVSEP_KEY stays server-side; the browser never sees it.
 */

import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fmFindRecords } from '../fm-client.js';
import { createSwrCache } from '../lib/swr-cache.js';
import { buildMixableMap } from '../lib/mixer-match.js';
import { isMixerPlan, MIXER_TRIAL_TYPE, MIXER_TRIAL_SPLITS } from '../lib/mixer-plans.js';
import { allSongs, mmGet, songsLayout, songSummary, cdnUrl } from '../lib/mixer-catalogue.js';
import { trialConfirmed, startTrial, confirmTrial, madTrialLinks } from '../lib/mixer-trial.js';

const router = Router();

const MVSEP = 'https://mvsep.com';
// The MVSEP key: MVSEP_KEY in the environment (Render), or — on a Mac, outside production — the
// login Keychain item "mvsep" (added with: security add-generic-password -a "$USER" -s mvsep -w),
// the same way the ElevenLabs key is kept. A missing Keychain key is re-checked at most every 30 s,
// so adding it takes effect without a restart. The browser never sees the key.
let keychainKey = '', keychainCheckedAt = 0;
const MVSEP_KEY = () => {
  const env = (process.env.MVSEP_KEY || '').trim();
  if (env || keychainKey) return env || keychainKey;
  if (process.platform !== 'darwin' || process.env.NODE_ENV === 'production') return '';
  if (Date.now() - keychainCheckedAt < 30_000) return '';
  keychainCheckedAt = Date.now();
  try {
    keychainKey = execFileSync('security', ['find-generic-password', '-s', 'mvsep', '-w'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (keychainKey) console.log('[mixer] MVSEP key found in the Keychain');
  } catch { /* not there yet */ }
  return keychainKey;
};
const SPLITS_PER_MONTH = Math.max(0, Number.parseInt(process.env.MIXER_SPLITS_PER_MONTH, 10) || 30);
const OPEN_TO_ALL = process.env.MIXER_OPEN_TO_ALL_TOKENS === 'true';
const FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';
const DATA_DIR = path.resolve(process.env.MIXER_DATA_DIR || 'data');
const USAGE_FILE = path.join(DATA_DIR, 'mixer-usage.json');
const DCX_FILE = path.join(DATA_DIR, 'mixer-dcx.jsonl');
const MAX_UPLOAD = 400 * 1024 * 1024;   // a 20-min 24-bit stereo WAV is ~300 MB

// ── entitlement + metering ────────────────────────────────────────────────────
// DEV_NO_TOKEN: local testing without a MAD sign-in (server.js lets /api/mixer/* past the token
// check only when MIXER_DEV_NO_TOKEN=true AND NODE_ENV is not production).
const DEV_NO_TOKEN = process.env.MIXER_DEV_NO_TOKEN === 'true' && process.env.NODE_ENV !== 'production';
const entitled = (tok) => OPEN_TO_ALL || DEV_NO_TOKEN || !!tok?.audioLabEnabled || isMixerPlan(tok?.type);
const isTrial = (tok) => tok?.type === MIXER_TRIAL_TYPE;
// The free split is one split for the life of the code; everyone else gets a monthly allowance.
const periodKey = (tok) => (isTrial(tok) ? 'free-split' : monthKey());
const quotaFor = (tok) => (isTrial(tok) ? MIXER_TRIAL_SPLITS : SPLITS_PER_MONTH);
const monthKey = () => new Date().toISOString().slice(0, 7);
const tokenKey = (tok) => String(tok?.code || '').trim().toUpperCase();

let usageCache = null, writeChain = Promise.resolve();
async function loadUsage() {
  if (usageCache) return usageCache;
  try { usageCache = JSON.parse(await fs.readFile(USAGE_FILE, 'utf8')); }
  catch { usageCache = {}; }
  return usageCache;
}
function saveUsage() {   // serialised so concurrent splits never interleave writes
  writeChain = writeChain.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${USAGE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(usageCache, null, 2));
    await fs.rename(tmp, USAGE_FILE);
  }).catch(err => console.warn('[mixer] usage save failed:', err.message));
  return writeChain;
}
async function usageFor(tok) {
  const all = await loadUsage();
  const rec = all[tokenKey(tok)];
  const used = rec && rec.month === periodKey(tok) ? rec.used : 0;
  const quota = quotaFor(tok);
  return { used, quota, remaining: Math.max(0, quota - used) };
}
async function countSplit(tok) {
  const all = await loadUsage();
  const k = tokenKey(tok), m = periodKey(tok);
  const rec = all[k] && all[k].month === m ? all[k] : { month: m, used: 0 };
  rec.used += 1; rec.last = new Date().toISOString();
  all[k] = rec;
  await saveUsage();
}

// Everything below needs a subscriber. (The /api middleware has already rejected
// missing or invalid tokens with 403 before we get here.)
function requireMixer(req, res, next) {
  if (entitled(req.accessToken)) return next();
  return res.status(402).json({ ok: false, error: 'Mad Mixer is part of the Mad Mixer subscription.', upgrade: true });
}

// ── routes ────────────────────────────────────────────────────────────────────
router.get('/ping', (req, res) => {
  res.json({ ok: true, engine: 'mad-mixer', entitled: entitled(req.accessToken), splitterReady: !!MVSEP_KEY() });
});

// The app's sign-in step. The MAD token IS the sign-in; this just reports entitlement + credits.
router.post('/auth', async (req, res) => {
  if (!entitled(req.accessToken)) {
    return res.status(402).json({ ok: false, error: 'Mad Mixer is part of the Mad Mixer subscription.', upgrade: true });
  }
  const tok = req.accessToken;
  const trial = isTrial(tok);
  res.json({
    ok: true, splitterReady: !!MVSEP_KEY(), plan: tok?.type || null,
    trial, confirmed: trial ? await trialConfirmed(tok.code) : true,
    ...(await usageFor(tok)),
  });
});

router.get('/usage', requireMixer, async (req, res) => {
  res.json({ ok: true, gated: true, splitterReady: !!MVSEP_KEY(), ...(await usageFor(req.accessToken)) });
});

// ── the MadMixer catalogue (lib/mixer-catalogue.js: FM client + 5-min SWR song list) ──────────
router.get('/songs', requireMixer, async (req, res) => {
  try {
    const songs = await allSongs();
    res.json({ ok: true, count: songs.length, songs });
  } catch (err) {
    console.warn('[mixer] songs list failed:', err.message);
    res.status(502).json({ ok: false, error: 'Could not load the Mad Mixer song list' });
  }
});

// One song's audio link — the MP3 on the media CDN. (The Vision master is for stem-making,
// not for browsers.) Record id only; the server decides the URL.
router.get('/songs/:id', requireMixer, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ ok: false, error: 'Bad song id' });
  try {
    const resp = await mmGet(`/layouts/${encodeURIComponent(songsLayout())}/records/${id}`);
    const rec = (resp.data || [])[0];
    if (!rec) return res.status(404).json({ ok: false, error: 'Song not found' });
    const s = songSummary(rec);
    if (!s.playable) return res.status(404).json({ ok: false, error: 'This song has no playable audio yet', ...s });
    res.json({ ok: true, ...s, audioUrl: cdnUrl(rec.fieldData.Audio_S3_URL) });
  } catch (err) {
    console.warn('[mixer] song lookup failed:', err.message);
    res.status(502).json({ ok: false, error: 'Could not look the song up' });
  }
});

// ── which MAD tracks can open in Mad Mixer ───────────────────────────────────────
// Only MADMixer songs can be mixed. For each MADMixer ISRC we find the MadStreamer tracks
// carrying it (one FM find per ISRC through MAD's FM queue, 4 at a time); lib/mixer-match.js
// keeps those whose title agrees and points each at its MADMixer song. ~450 finds, so it is
// rebuilt at most every 6 hours (SWR: callers get the last map while a rebuild runs).
async function streamerTracksByIsrc(isrcs) {
  const out = {};
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < isrcs.length) {
      const isrc = isrcs[next++];
      const r = await fmFindRecords(FM_LAYOUT, [{ ISRC: `==${isrc}` }], { limit: 100 });
      if (!r.ok && String(r.code) !== '401') throw new Error(`MadStreamer find failed (${r.code || r.status})`);
      out[isrc] = (r.data || []).map((x) => ({
        recordId: x.recordId,
        title: x.fieldData?.['Track Name'] || '',
        album: x.fieldData?.['Album Title'] || x.fieldData?.['Tape Files::Album Title'] || '',
      }));
    }
  }));
  return out;
}
const mixableSwr = createSwrCache({
  name: 'mixer-mixable', label: 'mixer-mixable', ttlMs: 6 * 60 * 60_000, max: 1,
  loader: async () => {
    const songs = await allSongs();
    const isrcs = [...new Set(songs.filter((s) => s.playable).map((s) => String(s.isrc || '').trim().toUpperCase()).filter(Boolean))];
    const started = Date.now();
    const tracks = buildMixableMap(songs, await streamerTracksByIsrc(isrcs));
    console.log(`[mixer] mixable map: ${Object.keys(tracks).length} MAD tracks from ${isrcs.length} ISRCs in ${Math.round((Date.now() - started) / 1000)} s`);
    return { tracks, builtAt: new Date().toISOString() };
  },
});
// Warm it shortly after boot so the first listener doesn't wait for ~450 finds — only when Mad
// Mixer is switched on (server.js imports this file either way; the router is mounted only when on).
if (process.env.MAD_MIXER_ENABLED === 'true') {
  setTimeout(() => mixableSwr.get('map').catch((err) => console.warn('[mixer] mixable warm-up failed:', err.message)), 15_000).unref?.();
}

// Any signed-in listener (MAD-only subscribers see the button too — Mad Mixer then offers the
// upgrade). If the map is still being built, answer at once with ready:false; the page retries.
router.get('/mixable', async (req, res) => {
  try {
    const got = await Promise.race([mixableSwr.get('map'), new Promise((r) => setTimeout(() => r(null), 1500))]);
    if (!got) return res.json({ ok: true, ready: false, tracks: {} });
    res.set('Cache-Control', 'private, max-age=600');
    res.json({ ok: true, ready: true, builtAt: got.value.builtAt, tracks: got.value.tracks });
  } catch (err) {
    console.warn('[mixer] mixable map failed:', err.message);
    res.json({ ok: true, ready: false, tracks: {} });
  }
});

// The models Mad Mixer offers (Ian, 2026-10-02: "make BS Roformer the default and offer both, cut
// down model list to 4"). MVSEP has ~120; these are picked by sep_type (MVSEP's render_id), in this
// order. "Quick" is the default: ~1 min and ~3 credits for a 3-min song vs ~5 min and ~13 for "Best",
// whose extra Instrumental stem also doubles the backing on Play All.
const MODELS = [
  { sep: 63, label: 'Quick — vocals, bass, drums, guitar, piano, other (about a minute)', isDefault: true },
  { sep: 28, label: 'Best — vocals, instrumental, bass, drums, other (about 5 minutes)' },
  { sep: 40, label: 'Vocals and backing track — vocals, instrumental' },
  { sep: 49, label: 'Lead and backing vocals — lead singer, backing vocals' },
];
const DEFAULT_SEP = String(MODELS.find((m) => m.isDefault).sep);
const offered = (sep) => MODELS.some((m) => String(m.sep) === String(sep));

let algoCache = { at: 0, body: null };
router.get('/mvsep/algorithms', requireMixer, async (req, res) => {
  if (algoCache.body && Date.now() - algoCache.at < 3600_000) return res.type('application/json').send(algoCache.body);
  try {
    const r = await fetch(`${MVSEP}/api/app/algorithms`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return res.status(r.status).type('application/json').send(await r.text());
    const all = await r.json();
    // MVSEP's own entries (they carry each model's option fields), cut to ours, in our order, with
    // our names; the page shows display_name and pre-selects is_default.
    const list = MODELS.map((m, i) => {
      const a = (Array.isArray(all) ? all : []).find((x) => Number(x?.render_id ?? x?.id) === m.sep);
      return a && { ...a, is_active: 1, order_id: i + 1, display_name: m.label, is_default: !!m.isDefault };
    }).filter(Boolean);
    const body = JSON.stringify(list);
    if (list.length) algoCache = { at: Date.now(), body };
    res.type('application/json').send(body);
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Could not load the model list' });
  }
});

// Raw WAV in → multipart out, streamed straight through (the 512 MB Render tier can't
// hold a 60 MB upload per concurrent user in memory).
router.post('/mvsep/create', requireMixer, async (req, res) => {
  const key = MVSEP_KEY();
  if (!key) return res.status(503).json({ ok: false, error: 'The stem splitter is not configured yet (MVSEP_KEY missing).' });
  const u = await usageFor(req.accessToken);
  if (isTrial(req.accessToken)) {
    if (!(await trialConfirmed(req.accessToken.code))) {
      return res.status(403).json({ ok: false, needsConfirm: true, error: 'Confirm your email to unlock your free split — tap the link in the email we sent you.' });
    }
    if (u.remaining <= 0) return res.status(402).json({ ok: false, upgrade: true, error: 'You’ve used your free split. Subscribe to Mad Mixer for 30 splits a month.', ...u });
  }
  if (u.remaining <= 0) return res.status(402).json({ ok: false, error: `You've used all ${u.quota} splits this month. They reset on the 1st.`, ...u });
  const len = Number(req.headers['content-length'] || 0);
  if (!len) return res.status(400).json({ ok: false, error: 'No audio received' });
  if (len > MAX_UPLOAD) return res.status(413).json({ ok: false, error: 'That file is too large to split.' });

  // Only Mad Mixer songs (Ian, 2026-09-28): the page tags every split with the MADMixer song it
  // came from; the song must exist and have audio, and the upload can't be longer than the song
  // (a 32-bit float stereo WAV is ~353 kB/s; allow 400 kB/s + 5 MB). Stem-of-stem splits pass —
  // they carry the same song and length.
  // Refusals drain the upload first, so the browser gets the message, not a broken connection.
  const refuse = (status, error) => { req.resume(); req.on('end', () => { if (!res.headersSent) res.status(status).json({ ok: false, error }); }); };
  const songId = String(req.headers['x-mixer-song'] || '');
  const song = /^\d{1,12}$/.test(songId) ? (await allSongs().catch(() => [])).find((s) => s.id === songId) : null;
  if (!song || !song.playable) {
    return refuse(403, 'Mad Mixer splits songs from the Mad Mixer catalogue. Pick one with 🎵 Songs.');
  }
  const secs = String(song.duration || '').split(':').map(Number).reduce((a, n) => a * 60 + (Number.isFinite(n) ? n : 0), 0);
  if (secs > 0 && len > secs * 400_000 + 5_000_000) {
    return refuse(400, 'That audio is longer than the song.');
  }

  const q = req.query;
  const sep = String(q.sep_type || DEFAULT_SEP);
  if (!offered(sep)) return refuse(400, 'That model isn’t offered in Mad Mixer — pick one from the list.');
  const fields = { api_token: key, is_demo: '0', sep_type: sep, output_format: String(q.output_format || '1') };
  for (let i = 1; i <= 4; i++) if (q[`add_opt${i}`]) fields[`add_opt${i}`] = String(q[`add_opt${i}`]);
  for (const v of Object.values(fields)) if (!/^[\w.-]{0,200}$/.test(v)) return res.status(400).json({ ok: false, error: 'Bad option' });

  const boundary = '----madmixer' + crypto.randomBytes(12).toString('hex');
  const head = Buffer.from(Object.entries(fields).map(([k, v]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') +
    `--${boundary}\r\nContent-Disposition: form-data; name="audiofile"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Readable.from((async function* () { yield head; for await (const c of req) yield c; yield tail; })());

  console.log(`[mixer] split by ${tokenKey(req.accessToken).slice(0, 8)}… song=${songId} sep_type=${fields.sep_type} ${(len / 1e6).toFixed(1)} MB`);
  try {
    const r = await fetch(`${MVSEP}/api/separation/create`, {
      method: 'POST', duplex: 'half', body: Readable.toWeb(body),
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(head.length + len + tail.length), Accept: 'application/json' },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const text = await r.text();
    let ok = r.ok, hash = null;
    try { const j = JSON.parse(text); ok = ok && j.success !== false; hash = j?.data?.hash || null; } catch { /* non-JSON → trust the status */ }
    if (ok) await countSplit(req.accessToken);          // MVSEP charges at create
    // The job id makes every split traceable — and recoverable from MVSEP for ~72 h if the page loses it.
    console.log(`[mixer] job ${hash || '(none)'} ${ok ? 'created' : 'refused'} for ${tokenKey(req.accessToken).slice(0, 8)}… song=${songId} (HTTP ${r.status})`);
    res.status(r.status).type('application/json').send(text);
  } catch (err) {
    console.warn('[mixer] create failed:', err.message);
    if (!res.headersSent) res.status(502).json({ ok: false, error: 'Could not reach the stem splitter' });
  }
});

// Last status logged per job, so the log shows each change once (waiting → processing → done).
const jobStatus = new Map();
router.get('/mvsep/get', requireMixer, async (req, res) => {
  const hash = String(req.query.hash || '');
  // MVSEP job ids end in the uploaded file's name — "20261002125247-b15a4d8ded-audio.wav" — so the
  // dot must be allowed. Without it every poll was refused "Bad job id", the page kept saying
  // "processing" and gave up after 20 min while MVSEP had finished in ~4 (fixed 2026-10-02).
  // status:'failed' + message: the page stops on 'failed' and shows the reason, instead of reading
  // a refusal as "still processing" for 20 minutes.
  if (!/^[\w.-]{4,128}$/.test(hash)) return res.status(400).json({ ok: false, status: 'failed', message: 'Bad job id', error: 'Bad job id' });
  try {
    const r = await fetch(`${MVSEP}/api/separation/get?hash=${encodeURIComponent(hash)}`, { signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    try {
      const st = JSON.parse(text).status;
      if (st && jobStatus.get(hash) !== st) {
        jobStatus.set(hash, st);
        if (jobStatus.size > 500) jobStatus.delete(jobStatus.keys().next().value);
        console.log(`[mixer] job ${hash} → ${st}`);
      }
    } catch { /* not JSON: pass it on as is */ }
    res.status(r.status).type('application/json').send(text || '{}');
  } catch (err) {
    // MVSEP unreachable: no status, so the page keeps polling (the job is still running there).
    console.warn('[mixer] poll failed:', hash, err.message);
    res.status(502).json({ ok: false, error: 'Could not reach the stem splitter just now' });
  }
});

// Finished stems live on mvsep.com without CORS; stream them through, MVSEP hosts only.
router.get('/audio-proxy', requireMixer, async (req, res) => {
  let target;
  try { target = new URL(String(req.query.url || '')); } catch { return res.status(400).json({ ok: false, error: 'Bad url' }); }
  const hostOk = target.protocol === 'https:' && (target.hostname === 'mvsep.com' || target.hostname.endsWith('.mvsep.com'));
  if (!hostOk) return res.status(400).json({ ok: false, error: 'Only MVSEP result files can be fetched here' });
  try {
    // Give up only if MVSEP goes quiet for a minute — not after 5 minutes in total: a 70 MB stem on a
    // slow connection legitimately takes longer than that.
    const ac = new AbortController();
    let idle = setTimeout(() => ac.abort(), 60_000);
    const poke = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), 60_000); };
    res.on('close', () => clearTimeout(idle));
    const up = await fetch(target, { redirect: 'follow', signal: ac.signal });
    poke();
    if (!up.ok || !up.body) return res.status(up.status || 502).json({ ok: false, error: `Upstream ${up.status}` });
    res.setHeader('Content-Type', up.headers.get('content-type') || 'audio/wav');
    if (up.headers.get('content-length')) res.setHeader('Content-Length', up.headers.get('content-length'));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const s = Readable.fromWeb(up.body);
    s.on('data', poke);
    s.on('end', () => clearTimeout(idle));
    s.on('error', () => res.destroy());
    res.on('close', () => { if (!s.destroyed) s.destroy(); });
    s.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ ok: false, error: 'Could not fetch the stem' });
  }
});

// Every export is tagged in the file by the app; here we keep the provenance line — who
// exported which Sample ID, when, from which track. The audio itself is not stored.
router.post('/dcx/register', requireMixer, async (req, res) => {
  const q = req.query;
  let bytes = 0;
  for await (const c of req) bytes += c.length;           // drain; we keep metadata only
  const line = {
    at: new Date().toISOString(), id: String(q.id || '').slice(0, 40), sha: String(q.sha || '').slice(0, 80),
    name: String(q.name || '').slice(0, 200), source: String(q.source || '').slice(0, 200), bytes,
    token: tokenKey(req.accessToken), email: req.accessToken?.email || null,
  };
  if (!/^DCX-\d{8}-[A-Z2-9]{6}$/.test(line.id)) return res.status(400).json({ ok: false, error: 'Bad sample id' });
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(DCX_FILE, JSON.stringify(line) + '\n');
    res.json({ ok: true, id: line.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not record the sample' });
  }
});

router.post('/dcx/check', requireMixer, (req, res) => {
  req.resume();
  res.status(501).json({ ok: false, error: 'Sample checking is not part of Mad Mixer yet.' });
});

// ── Mad Mixer free split (2026-09-28) ─────────────────────────────────────────────
// lib/mixer-trial.js: one free split per email, a Mixer-only code at once, the split unlocks when
// the emailed Confirm link is opened. Here the links point at Mad Mixer inside MAD.
router.post('/trial', async (req, res) => {
  const r = await startTrial({ email: req.body?.email, links: madTrialLinks });
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
  res.json({ ok: true, token: r.code });
});

router.get('/trial/confirm', async (req, res) => {
  const page = (title, body, href, label) => res.status(200).type('html').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} — Mad Mixer</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#121212;color:#e8e8e8;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;box-sizing:border-box">
<div style="max-width:440px;text-align:center">
<img src="/img/Madmusiclogonew-dark.png" alt="MAD — Music Africa Direct" style="height:44px;margin-bottom:14px">
<h1 style="font-size:1.5rem;margin:0 0 10px;background:linear-gradient(90deg,#22d3ee,#8b5cf6 55%,#a78bfa);-webkit-background-clip:text;background-clip:text;color:transparent">${title}</h1>
<p style="color:#bbb;line-height:1.5;margin:0 0 22px">${body}</p>
${href ? `<a href="${href}" style="display:inline-block;padding:12px 26px;border-radius:999px;background:linear-gradient(135deg,#8b5cf6,#a78bfa);color:#fff;font-weight:700;text-decoration:none">${label}</a>` : ''}
</div></body></html>`);
  const r = await confirmTrial(String(req.query.t || ''), String(req.query.s || ''));
  if (r.ok) {
    return page('Your free split is ready', 'Email confirmed. Pick a song in Mad Mixer and press <b>AI Split</b> to separate it into stems.', `/mixer?code=${encodeURIComponent(r.code)}`, 'Open Mad Mixer');
  }
  if (r.reason === 'bad-link') return page('That link didn’t work', 'Please use the Confirm button in your most recent Mad Mixer email.', null);
  if (r.reason === 'ended') return page('We couldn’t confirm this', 'This free split may have ended. You can still subscribe to Mad Mixer.', '/mixer', 'Open Mad Mixer');
  return page('Something went wrong', 'We couldn’t confirm your email just now. Please try the link again in a minute.', null);
});

export default router;
