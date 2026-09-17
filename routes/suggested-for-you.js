// routes/suggested-for-you.js — GET /suggested-for-you: the personal home rail.
//
// Ten albums picked from what this listener has actually played: their history
// comes from FileMaker's stream events (lib/listening-profile.js, by email and
// every token issued to it), and the albums from the semantic index
// (suggestForListener), with the artist bios as a second source of truth —
// their aliases and "Related Music" credits. The rail only appears once someone
// has 100 different songs behind them (Ian, 2026-09-17); below that the response
// says how far they have to go and the frontend shows nothing.
//
// Subscriber-only: NOT skip-listed, so req.accessToken is always present.
// Feature-flagged PERSONAL_RAIL_ENABLED in server.js (404 before auth when off).
//
// FileMaker load: one listener's history is a paged find of up to a few thousand
// records (1–7 s), so each person's result is SWR-cached for 6 hours — negative
// ("not yet 100 songs") results too — and at most two histories load at once.
import { Router } from 'express';
import { createSwrCache } from '../lib/swr-cache.js';
import { loadListeningProfile, MIN_SONGS } from '../lib/listening-profile.js';
import { suggestForListener, semanticIndexStatus, initSemanticIndex } from '../lib/semantic-index.js';
import { normalizeEmail } from '../lib/format.js';
import { getArtistBioLinks } from './artist-bio.js';
import { createLogger } from '../lib/logger.js';

const router = Router();
const log = createLogger('suggested-for-you');

const RAIL_SIZE = 10;
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CONCURRENT_LOADS = 2;

let running = 0;
const waiting = [];
async function withLoadSlot(fn) {
  if (running >= MAX_CONCURRENT_LOADS) await new Promise((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

const railSwr = createSwrCache({
  ttlMs: TTL_MS,
  max: 2000,
  label: 'suggested-for-you',
  name: 'suggestedForYou',
  loader: async (_key, who) => {
    const profile = await withLoadSlot(() => loadListeningProfile(who));
    if (profile.songs < MIN_SONGS) {
      return { eligible: false, songs: profile.songs, items: [] };
    }
    const bio = await getArtistBioLinks();
    const result = suggestForListener(profile.albums, RAIL_SIZE, { bio });
    return { eligible: true, songs: profile.songs, items: result.items };
  }
});

router.get('/suggested-for-you', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    await initSemanticIndex();
    if (!semanticIndexStatus().ready) {
      return res.json({ ok: true, eligible: false, songs: 0, needed: MIN_SONGS, items: [], indexReady: false });
    }

    const email = normalizeEmail(req.accessToken?.email || '');
    const tokenCode = String(req.accessToken?.code || '').trim().toUpperCase();
    // A person is their email; a token with no email on record is its own listener.
    const key = email ? `e:${email}` : `t:${tokenCode}`;
    if (key.length <= 2) {
      return res.json({ ok: true, eligible: false, songs: 0, needed: MIN_SONGS, items: [] });
    }

    const { value, state } = await railSwr.get(key, { email, tokenCode });
    res.setHeader('X-Cache-State', state);
    return res.json({ ok: true, ...value, needed: MIN_SONGS });
  } catch (err) {
    log.error('Error:', err);
    // The rail is optional — an empty answer hides it rather than breaking home.
    return res.json({ ok: false, eligible: false, songs: 0, needed: MIN_SONGS, items: [] });
  }
});

export default router;
