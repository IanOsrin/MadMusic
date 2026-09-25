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
 *   GET  /track/:recordId              → { title, artist, album, catalogue, audioUrl } for ?t= opens
 *   GET  /mvsep/algorithms             → MVSEP model catalogue (cached 1 h)
 *   POST /mvsep/create?sep_type=…      → raw WAV body, STREAMED to MVSEP as multipart (never buffered)
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
import { getTrackRecordCached } from '../lib/track-cache.js';

const router = Router();

const MVSEP = 'https://mvsep.com';
const MVSEP_KEY = () => (process.env.MVSEP_KEY || '').trim();
const SPLITS_PER_MONTH = Math.max(0, Number.parseInt(process.env.MIXER_SPLITS_PER_MONTH, 10) || 30);
const OPEN_TO_ALL = process.env.MIXER_OPEN_TO_ALL_TOKENS === 'true';
const FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';
const DATA_DIR = path.resolve(process.env.MIXER_DATA_DIR || 'data');
const USAGE_FILE = path.join(DATA_DIR, 'mixer-usage.json');
const DCX_FILE = path.join(DATA_DIR, 'mixer-dcx.jsonl');
const MEDIA_HOST = (process.env.MEDIA_CDN_HOST || 'media.musicafricadirect.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const S3_MEDIA_HOST = 'mass-music-audio-files.s3.eu-north-1.amazonaws.com';
const MAX_UPLOAD = 400 * 1024 * 1024;   // a 20-min 24-bit stereo WAV is ~300 MB

// ── entitlement + metering ────────────────────────────────────────────────────
// DEV_NO_TOKEN: local testing without a MAD sign-in (server.js lets /api/mixer/* past the token
// check only when MIXER_DEV_NO_TOKEN=true AND NODE_ENV is not production).
const DEV_NO_TOKEN = process.env.MIXER_DEV_NO_TOKEN === 'true' && process.env.NODE_ENV !== 'production';
const entitled = (tok) => OPEN_TO_ALL || DEV_NO_TOKEN || !!tok?.audioLabEnabled;
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
  const used = rec && rec.month === monthKey() ? rec.used : 0;
  return { used, quota: SPLITS_PER_MONTH, remaining: Math.max(0, SPLITS_PER_MONTH - used) };
}
async function countSplit(tok) {
  const all = await loadUsage();
  const k = tokenKey(tok), m = monthKey();
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

// ── small helpers ─────────────────────────────────────────────────────────────
async function passJson(res, url, init) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    res.status(r.status).type('application/json').send(text || '{}');
  } catch (err) {
    console.warn('[mixer] upstream error:', err.message);
    res.status(502).json({ ok: false, error: 'Upstream request failed' });
  }
}
const cdnUrl = (u) => String(u || '').replace(`https://${S3_MEDIA_HOST}/`, `https://${MEDIA_HOST}/`);
const firstField = (f, names) => { for (const n of names) if (f[n]) return String(f[n]); return ''; };

// ── routes ────────────────────────────────────────────────────────────────────
router.get('/ping', (req, res) => {
  res.json({ ok: true, engine: 'mad-mixer', entitled: entitled(req.accessToken), splitterReady: !!MVSEP_KEY() });
});

// The app's sign-in step. The MAD token IS the sign-in; this just reports entitlement + credits.
router.post('/auth', async (req, res) => {
  if (!entitled(req.accessToken)) {
    return res.status(402).json({ ok: false, error: 'Mad Mixer is part of the Mad Mixer subscription.', upgrade: true });
  }
  res.json({ ok: true, ...(await usageFor(req.accessToken)) });
});

router.get('/usage', requireMixer, async (req, res) => {
  res.json({ ok: true, gated: true, ...(await usageFor(req.accessToken)) });
});

// Opening Mad Mixer from a track: the page passes the catalogue record id, never a raw URL,
// so the server decides which audio loads (no open redirect / reflected-URL surface).
router.get('/track/:recordId', requireMixer, async (req, res) => {
  const rid = String(req.params.recordId || '');
  if (!/^\d{1,12}$/.test(rid)) return res.status(400).json({ ok: false, error: 'Bad track id' });
  try {
    const rec = await getTrackRecordCached(FM_LAYOUT, rid);
    if (!rec) return res.status(404).json({ ok: false, error: 'Track not found' });
    const f = rec.fieldData || {};
    const audio = cdnUrl(firstField(f, ['S3_URL']));
    if (!/^https:\/\//.test(audio)) return res.status(404).json({ ok: false, error: 'No audio for this track' });
    res.json({
      ok: true, recordId: rid, audioUrl: audio,
      title: firstField(f, ['Track Name', 'Song Title', 'Title']),
      artist: firstField(f, ['Track Artist', 'Album Artist']),
      album: firstField(f, ['Album Title', 'Tape Files::Album Title']),
      catalogue: firstField(f, ['Album Catalogue Number', 'Reference Catalogue Number']),
    });
  } catch (err) {
    console.warn('[mixer] track lookup failed:', err.message);
    res.status(502).json({ ok: false, error: 'Catalogue lookup failed' });
  }
});

// ── the MadMixer catalogue (FileMaker "MADMixer" on FM Cloud, a MAM clone) ─────────
// MADMIXER_FM_HOST / _DB / _USER / _PASS. The song list changes rarely, so it is cached for
// five minutes; one FM session is reused until it expires (~15 min idle on FM Cloud).
const MM = {
  host: () => (process.env.MADMIXER_FM_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  db: () => process.env.MADMIXER_FM_DB || 'MADMixer',
  layout: () => process.env.MADMIXER_FM_SONGS_LAYOUT || 'Songs',
  token: null,
};
const mmBase = () => `https://${MM.host()}/fmi/data/vLatest/databases/${encodeURIComponent(MM.db())}`;
async function mmLogin() {
  const r = await fetch(`${mmBase()}/sessions`, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${process.env.MADMIXER_FM_USER}:${process.env.MADMIXER_FM_PASS}`).toString('base64') },
    body: '{}',
  });
  const j = await r.json().catch(() => ({}));
  if (!j.response?.token) throw new Error('MadMixer login failed: ' + (j.messages?.[0]?.message || r.status));
  MM.token = j.response.token;
}
async function mmGet(pathAndQuery) {
  if (!MM.host() || !process.env.MADMIXER_FM_USER) throw new Error('MadMixer database not configured (MADMIXER_FM_*)');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!MM.token) await mmLogin();
    const r = await fetch(`${mmBase()}${pathAndQuery}`, { headers: { Authorization: `Bearer ${MM.token}` }, signal: AbortSignal.timeout(30_000) });
    const j = await r.json().catch(() => ({}));
    if (j.messages?.[0]?.code === '952') { MM.token = null; continue; }   // session expired → log in again
    if (j.messages?.[0]?.code !== '0') throw new Error('MadMixer: ' + (j.messages?.[0]?.message || r.status));
    return j.response;
  }
  throw new Error('MadMixer session could not be renewed');
}
const songSummary = (rec) => {
  const f = rec.fieldData || {};
  const mp3 = cdnUrl(f.Audio_S3_URL || '');
  return {
    id: String(rec.recordId), title: f['Track Name'] || '', artist: f['Track Artist'] || '', album: f['Album Title'] || '',
    duration: f.Duration || '', genre: f['Local Genre'] || f.Genre || '', isrc: f.ISRC || '',
    playable: /^https:\/\//.test(mp3), hasMaster: !!String(f.Audio_Vision_URL || '').trim(),
  };
};
let songsCache = { at: 0, list: null };
router.get('/songs', requireMixer, async (req, res) => {
  try {
    if (!songsCache.list || Date.now() - songsCache.at > 300_000) {
      const all = [];
      for (let off = 1; ; off += 500) {
        const resp = await mmGet(`/layouts/${encodeURIComponent(MM.layout())}/records?_offset=${off}&_limit=500`);
        all.push(...(resp.data || []));
        if ((resp.data || []).length < 500) break;
      }
      songsCache = { at: Date.now(), list: all.map(songSummary).sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title)) };
    }
    res.json({ ok: true, count: songsCache.list.length, songs: songsCache.list });
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
    const resp = await mmGet(`/layouts/${encodeURIComponent(MM.layout())}/records/${id}`);
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

let algoCache = { at: 0, body: null };
router.get('/mvsep/algorithms', requireMixer, async (req, res) => {
  if (algoCache.body && Date.now() - algoCache.at < 3600_000) return res.type('application/json').send(algoCache.body);
  try {
    const r = await fetch(`${MVSEP}/api/app/algorithms`, { signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    if (r.ok) algoCache = { at: Date.now(), body: text };
    res.status(r.status).type('application/json').send(text);
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
  if (u.remaining <= 0) return res.status(402).json({ ok: false, error: `You've used all ${u.quota} splits this month. They reset on the 1st.`, ...u });
  const len = Number(req.headers['content-length'] || 0);
  if (!len) return res.status(400).json({ ok: false, error: 'No audio received' });
  if (len > MAX_UPLOAD) return res.status(413).json({ ok: false, error: 'That file is too large to split.' });

  const q = req.query;
  const fields = { api_token: key, is_demo: '0', sep_type: String(q.sep_type || '28'), output_format: String(q.output_format || '1') };
  for (let i = 1; i <= 4; i++) if (q[`add_opt${i}`]) fields[`add_opt${i}`] = String(q[`add_opt${i}`]);
  for (const v of Object.values(fields)) if (!/^[\w.-]{0,200}$/.test(v)) return res.status(400).json({ ok: false, error: 'Bad option' });

  const boundary = '----madmixer' + crypto.randomBytes(12).toString('hex');
  const head = Buffer.from(Object.entries(fields).map(([k, v]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') +
    `--${boundary}\r\nContent-Disposition: form-data; name="audiofile"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Readable.from((async function* () { yield head; for await (const c of req) yield c; yield tail; })());

  console.log(`[mixer] split by ${tokenKey(req.accessToken).slice(0, 8)}… sep_type=${fields.sep_type} ${(len / 1e6).toFixed(1)} MB`);
  try {
    const r = await fetch(`${MVSEP}/api/separation/create`, {
      method: 'POST', duplex: 'half', body: Readable.toWeb(body),
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(head.length + len + tail.length), Accept: 'application/json' },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const text = await r.text();
    let ok = r.ok;
    try { ok = ok && JSON.parse(text).success !== false; } catch { /* non-JSON → trust the status */ }
    if (ok) await countSplit(req.accessToken);          // MVSEP charges at create
    res.status(r.status).type('application/json').send(text);
  } catch (err) {
    console.warn('[mixer] create failed:', err.message);
    if (!res.headersSent) res.status(502).json({ ok: false, error: 'Could not reach the stem splitter' });
  }
});

router.get('/mvsep/get', requireMixer, (req, res) => {
  const hash = String(req.query.hash || '');
  if (!/^[\w-]{4,128}$/.test(hash)) return res.status(400).json({ ok: false, error: 'Bad job id' });
  return passJson(res, `${MVSEP}/api/separation/get?hash=${encodeURIComponent(hash)}`);
});

// Finished stems live on mvsep.com without CORS; stream them through, MVSEP hosts only.
router.get('/audio-proxy', requireMixer, async (req, res) => {
  let target;
  try { target = new URL(String(req.query.url || '')); } catch { return res.status(400).json({ ok: false, error: 'Bad url' }); }
  const hostOk = target.protocol === 'https:' && (target.hostname === 'mvsep.com' || target.hostname.endsWith('.mvsep.com'));
  if (!hostOk) return res.status(400).json({ ok: false, error: 'Only MVSEP result files can be fetched here' });
  try {
    const up = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60_000) });
    if (!up.ok || !up.body) return res.status(up.status || 502).json({ ok: false, error: `Upstream ${up.status}` });
    res.setHeader('Content-Type', up.headers.get('content-type') || 'audio/wav');
    if (up.headers.get('content-length')) res.setHeader('Content-Length', up.headers.get('content-length'));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const s = Readable.fromWeb(up.body);
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

export default router;
