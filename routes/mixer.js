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
import { mixableMap } from '../lib/mixer-streamer.js';

const router = Router();

// ── which MAD tracks can open in Mad Mixer ───────────────────────────────────────
// Only MADMixer songs can be mixed: lib/mixer-streamer.js finds the MadStreamer tracks carrying each
// MADMixer ISRC (shared with the song list's tempos) and lib/mixer-match.js keeps those whose title
// agrees, each pointing at its MADMixer song. Rebuilt at most every 6 hours.
// Warm it shortly after boot so the first listener doesn't wait for ~450 finds — only when the
// 🎚 buttons are on (server.js imports this file either way; the router is mounted only when on).
if (process.env.MAD_MIXER_ENABLED === 'true' && process.env.MIXER_URL) {
  setTimeout(() => mixableMap().catch((err) => console.warn('[mixer] mixable warm-up failed:', err.message)), 15_000).unref?.();
}

// If the map is still being built, answer at once with ready:false; the page retries.
router.get('/mixable', async (req, res) => {
  try {
    const got = await Promise.race([mixableMap(), new Promise((r) => setTimeout(() => r(null), 1500))]);
    if (!got) return res.json({ ok: true, ready: false, tracks: {} });
    res.set('Cache-Control', 'private, max-age=600');
    res.json({ ok: true, ready: true, builtAt: got.builtAt, tracks: got.tracks });
  } catch (err) {
    console.warn('[mixer] mixable map failed:', err.message);
    res.json({ ok: true, ready: false, tracks: {} });
  }
});

export default router;
