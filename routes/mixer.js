/**
 * routes/mixer.js — the one Mad Mixer endpoint left in MAD: which MAD tracks get the 🎚 button.
 *
 * Mad Mixer itself lives on its own home (MIXER_URL, Vercel — the mad-mixer repo). server.js mounts
 * this router at /api/mixer only when MAD_MIXER_ENABLED=true AND MIXER_URL is set; the 🎚 buttons
 * and the left-menu item are then plain links to MIXER_URL/?song=<id> (public/js/mad-mixer-links.js).
 *
 *   GET /mixable  → { ok, ready, builtAt, tracks: { madStreamerRecordId: madMixerSongId } }
 *                   any signed-in listener (MAD-only subscribers see the button too — Mad Mixer
 *                   then offers the upgrade)
 *
 * Everything else Mad Mixer needs from MAD (entitlement by plan, the MADMixer song list, the free
 * split and its emails) is the signed internal API in routes/mixer-internal.js. Payments and codes
 * stay in MAD.
 */

import { Router } from 'express';
import { fmFindRecords } from '../fm-client.js';
import { createSwrCache } from '../lib/swr-cache.js';
import { buildMixableMap } from '../lib/mixer-match.js';
import { allSongs } from '../lib/mixer-catalogue.js';

const router = Router();

const FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';

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
// Warm it shortly after boot so the first listener doesn't wait for ~450 finds — only when the
// 🎚 buttons are on (server.js imports this file either way; the router is mounted only when on).
if (process.env.MAD_MIXER_ENABLED === 'true' && process.env.MIXER_URL) {
  setTimeout(() => mixableSwr.get('map').catch((err) => console.warn('[mixer] mixable warm-up failed:', err.message)), 15_000).unref?.();
}

// If the map is still being built, answer at once with ready:false; the page retries.
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

export default router;
