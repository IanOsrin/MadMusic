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
