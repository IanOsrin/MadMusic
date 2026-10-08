/**
 * lib/mixer-catalogue.js — the MADMixer song catalogue (FileMaker "MADMixer" on FM Cloud, a MAM clone).
 *
 * Moved out of routes/mixer.js (2026-10-02) so the in-MAD Mad Mixer routes and the signed
 * internal feed for Mad Mixer on Vercel (routes/mixer-internal.js → GET /internal/mixer/songs)
 * share ONE cache and one FM session.
 *
 * MADMIXER_FM_HOST / _DB / _USER / _PASS. The song list changes rarely, so it is cached for
 * five minutes (SWR: callers get the last list while a rebuild runs); one FM session is reused
 * until it expires (~15 min idle on FM Cloud).
 *
 *   allSongs()        → [{ id, title, artist, album, duration, genre, isrc, playable, hasMaster }]
 *                       (every song, sorted by artist + title — what the picker shows)
 *   songsWithAudio()  → { builtAt, songs: [{ …summary, audioUrl }] } — playable songs only, each
 *                       with its MP3 on the media CDN (the URL MVSEP fetches; server-built, never
 *                       taken from a browser)
 *   mixerPacks()      → { builtAt, packs: [{ id, title, song, bpm, bars, loops: [{ label, file, url, bytes, seconds }] }] }
 *                       — loop packs (Ian, 2026-10-08) from the MADMixer "Packs" layout (table Pack_Loops,
 *                       one record per loop; MADMIXER_FM_PACKS_LAYOUT to use another), Visible ≠ 0 only,
 *                       each loop's WAV on the media CDN
 *   mixerHqStems()    → { builtAt, songs: [{ songId, title, stems: [{ stemId, label, file, bytes, seconds, visionPath }] }] }
 *                       — HQ stems (Ian, 2026-10-08): the studio stems of a Mad Mixer song, from the MADMixer
 *                       "HQ_Stems" layout (one record per stem; MADMIXER_FM_HQ_LAYOUT to use another), Visible ≠ 0.
 *                       The WAVs stay on Vision (a dedicated folder); listeners stream them through MAD
 *                       (routes/mixer-hq-audio.js) — visionPath never leaves MAD.
 *   hqStemById(id)    → that stem (with visionPath) from the same list, or null
 */
import { createSwrCache } from './swr-cache.js';

const MEDIA_HOST = (process.env.MEDIA_CDN_HOST || 'media.musicafricadirect.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const S3_MEDIA_HOST = 'mass-music-audio-files.s3.eu-north-1.amazonaws.com';

export const cdnUrl = (u) => String(u || '').replace(`https://${S3_MEDIA_HOST}/`, `https://${MEDIA_HOST}/`);

const MM = {
  host: () => (process.env.MADMIXER_FM_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  db: () => process.env.MADMIXER_FM_DB || 'MADMixer',
  layout: () => process.env.MADMIXER_FM_SONGS_LAYOUT || 'Songs',
  token: null,
};
export const songsLayout = () => MM.layout();
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
export async function mmGet(pathAndQuery) {
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

export const songSummary = (rec) => {
  const f = rec.fieldData || {};
  const mp3 = cdnUrl(f.Audio_S3_URL || '');
  return {
    id: String(rec.recordId), title: f['Track Name'] || '', artist: f['Track Artist'] || '', album: f['Album Title'] || '',
    duration: f.Duration || '', genre: f['Local Genre'] || f.Genre || '', isrc: f.ISRC || '',
    playable: /^https:\/\//.test(mp3), hasMaster: !!String(f.Audio_Vision_URL || '').trim(),
  };
};

// Both lists are built once per refresh, so neither caller allocates per request.
const songsSwr = createSwrCache({
  name: 'mixer-songs', label: 'mixer-songs', ttlMs: 5 * 60_000, max: 1,
  loader: async () => {
    const all = [];
    for (let off = 1; ; off += 500) {
      const resp = await mmGet(`/layouts/${encodeURIComponent(MM.layout())}/records?_offset=${off}&_limit=500`);
      all.push(...(resp.data || []));
      if ((resp.data || []).length < 500) break;
    }
    const rows = all.map((rec) => ({ s: songSummary(rec), audioUrl: cdnUrl(rec.fieldData?.Audio_S3_URL || '') }))
      .sort((a, b) => (a.s.artist + a.s.title).localeCompare(b.s.artist + b.s.title));
    return {
      builtAt: new Date().toISOString(),
      summaries: rows.map((r) => r.s),
      withAudio: rows.filter((r) => r.s.playable).map((r) => ({ ...r.s, audioUrl: r.audioUrl })),
    };
  },
});

export const allSongs = async () => (await songsSwr.get('all')).value.summaries;
export const songsWithAudio = async () => {
  const { builtAt, withAudio } = (await songsSwr.get('all')).value;
  return { builtAt, songs: withAudio };
};

// ── Loop packs (Ian, 2026-10-08) ─────────────────────────────────────────────────────────────────
// One record per loop on the "Packs" layout: Pack_ID, Pack_Title, Pack_Song, Loop_Label, File_Name, BPM,
// Bars, Seconds, Bytes, Audio_S3_URL, Sort, Visible. Grouped into packs here; a pack's tempo and length are
// its first loop's. No layout yet / no records → no packs (not an error: the Mixer shows "No packs yet").
const packsLayout = () => process.env.MADMIXER_FM_PACKS_LAYOUT || 'Packs';
const PACK_ID_RE = /^[a-z0-9-]{1,80}$/;
const numOf = (v) => { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) && n > 0 ? n : 0; };
export function packsFromRecords(records) {
  const byId = new Map();
  for (const rec of records || []) {
    const f = rec.fieldData || {};
    const id = String(f.Pack_ID || '').trim().toLowerCase();
    const url = cdnUrl(String(f.Audio_S3_URL || '').trim());
    if (!PACK_ID_RE.test(id) || !/^https:\/\//.test(url)) continue;
    if (String(f.Visible ?? '').trim() === '0') continue;
    if (!byId.has(id)) byId.set(id, { id, title: String(f.Pack_Title || id).trim(), song: String(f.Pack_Song || '').trim(), bpm: numOf(f.BPM), bars: numOf(f.Bars), sort: Infinity, loops: [] });
    const p = byId.get(id), sort = numOf(f.Sort) || 9999;
    p.sort = Math.min(p.sort, sort);
    p.loops.push({ sort, label: String(f.Loop_Label || 'Loop').trim(), file: String(f.File_Name || '').trim() || `${p.title} - ${f.Loop_Label || 'Loop'}.wav`, url, bytes: numOf(f.Bytes), seconds: numOf(f.Seconds) });
  }
  return [...byId.values()]
    .sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title))
    .map(({ sort, loops, ...p }) => ({ ...p, loops: loops.sort((a, b) => a.sort - b.sort).map(({ sort: _s, ...l }) => l) }));
}
const packsSwr = createSwrCache({
  name: 'mixer-packs', label: 'mixer-packs', ttlMs: 60_000, max: 1,   // 1 minute: removals show quickly (Ian, 2026-10-08)
  loader: async () => {
    const all = [];
    try {
      for (let off = 1; ; off += 500) {
        const resp = await mmGet(`/layouts/${encodeURIComponent(packsLayout())}/records?_offset=${off}&_limit=500`);
        all.push(...(resp.data || []));
        if ((resp.data || []).length < 500) break;
      }
    } catch (err) {
      // 401 No records match / 105 Layout is missing → simply no packs yet
      if (!/no records|layout is missing|record is missing/i.test(String(err?.message))) throw err;
      console.warn(`[mixer-catalogue] no packs: ${err.message}`);
    }
    return { builtAt: new Date().toISOString(), packs: packsFromRecords(all) };
  },
});
export const mixerPacks = async () => (await packsSwr.get('all')).value;

// ── HQ stems (Ian, 2026-10-08) ───────────────────────────────────────────────────────────────────
// One record per stem on the "HQ_Stems" layout: Song_ID (the MADMixer Songs record id), Song_Title, Stem_Label,
// File_Name, Vision_Path, Bytes, Seconds, Sort, Visible. No layout / no records = no HQ stems.
const hqLayout = () => process.env.MADMIXER_FM_HQ_LAYOUT || 'HQ_Stems';
export function hqFromRecords(records) {
  const bySong = new Map();
  for (const rec of records || []) {
    const f = rec.fieldData || {};
    const songId = String(f.Song_ID ?? '').trim();
    const visionPath = String(f.Vision_Path || '').trim();
    if (!/^\d{1,12}$/.test(songId) || !/^\/.+\.wav$/i.test(visionPath) || !/^\d{1,12}$/.test(String(rec.recordId))) continue;
    if (String(f.Visible ?? '').trim() === '0') continue;
    if (!bySong.has(songId)) bySong.set(songId, { songId, title: String(f.Song_Title || '').trim(), stems: [] });
    bySong.get(songId).stems.push({ sort: numOf(f.Sort) || 9999, stemId: String(rec.recordId), label: String(f.Stem_Label || 'Stem').trim(),
      file: String(f.File_Name || '').trim() || `${f.Stem_Label || 'Stem'}.wav`, bytes: numOf(f.Bytes), seconds: numOf(f.Seconds), visionPath });
  }
  return [...bySong.values()].map((s) => ({ ...s, stems: s.stems.sort((a, b) => a.sort - b.sort).map(({ sort: _s, ...st }) => st) }));
}
const hqSwr = createSwrCache({
  name: 'mixer-hq', label: 'mixer-hq', ttlMs: 60_000, max: 1,
  loader: async () => {
    const all = [];
    try {
      for (let off = 1; ; off += 500) {
        const resp = await mmGet(`/layouts/${encodeURIComponent(hqLayout())}/records?_offset=${off}&_limit=500`);
        all.push(...(resp.data || []));
        if ((resp.data || []).length < 500) break;
      }
    } catch (err) {
      if (!/no records|layout is missing|record is missing/i.test(String(err?.message))) throw err;
      console.warn(`[mixer-catalogue] no HQ stems: ${err.message}`);
    }
    return { builtAt: new Date().toISOString(), songs: hqFromRecords(all) };
  },
});
export const mixerHqStems = async () => (await hqSwr.get('all')).value;
export const hqStemById = async (id) => {
  for (const s of (await mixerHqStems()).songs) { const t = s.stems.find((x) => x.stemId === String(id)); if (t) return { ...t, songId: s.songId }; }
  return null;
};
