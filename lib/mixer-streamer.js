/**
 * lib/mixer-streamer.js — the MadStreamer tracks behind each MADMixer song, found by ISRC.
 *
 * One FM find per MADMixer ISRC through MAD's FM queue (4 at a time, ~450 finds), rebuilt at most
 * every 6 hours (SWR: callers get the last result while a rebuild runs). Two things come out of it:
 *   mixableMap()  → { tracks: { streamerRecordId → madMixerSongId }, builtAt } — the 🎚 buttons
 *                   (routes/mixer.js /api/mixer/mixable), playable songs only
 *   bpmBySong()   → { madMixerSongId → bpm } from MadStreamer AI_BPM — the Mixer song list's tempo
 *                   (Ian 2026-10-15); {} while the first build is still running, so the song list
 *                   never waits on ~450 finds
 * Moved out of routes/mixer.js (2026-10-15) so both share one set of finds.
 */
import { fmFindRecords } from '../fm-client.js';
import { createSwrCache } from './swr-cache.js';
import { buildMixableMap, buildBpmMap } from './mixer-match.js';
import { allSongs, bpmOf } from './mixer-catalogue.js';

const FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';

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
        bpm: bpmOf(x.fieldData?.AI_BPM),
      }));
    }
  }));
  return out;
}

const streamerSwr = createSwrCache({
  name: 'mixer-streamer', label: 'mixer-streamer', ttlMs: 6 * 60 * 60_000, max: 1,
  loader: async () => {
    const songs = await allSongs();
    const isrcs = [...new Set(songs.map((s) => String(s.isrc || '').trim().toUpperCase()).filter(Boolean))];
    const started = Date.now();
    const byIsrc = await streamerTracksByIsrc(isrcs);
    const tracks = buildMixableMap(songs, byIsrc);
    const bpm = buildBpmMap(songs, byIsrc);
    console.log(`[mixer] MadStreamer matches: ${Object.keys(tracks).length} mixable MAD tracks, ${Object.keys(bpm).length} song tempos, from ${isrcs.length} ISRCs in ${Math.round((Date.now() - started) / 1000)} s`);
    return { tracks, bpm, builtAt: new Date().toISOString() };
  },
});

export const mixableMap = async () => {
  const { tracks, builtAt } = (await streamerSwr.get('all')).value;
  return { tracks, builtAt };
};

// Never holds the caller up for long: a cold cache answers {} after waitMs and keeps building.
export async function bpmBySong({ waitMs = 1500 } = {}) {
  const build = streamerSwr.get('all');
  build.catch((err) => console.warn('[mixer] MadStreamer matches failed:', err.message));
  const got = await Promise.race([build, new Promise((r) => setTimeout(() => r(null), waitMs))]).catch(() => null);
  return got?.value?.bpm || {};
}
