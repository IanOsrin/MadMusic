/**
 * lib/track-eligibility.js — the client's rule for what may appear in the app.
 *
 * A song must carry an ISRC, a UPC/barcode AND a cover, or it never renders —
 * anywhere, playlists included (client, 2026-09-02). Nothing is deleted from
 * MadStreamer; this is a display filter only, so a track reappears the moment
 * its codes are entered.
 *
 * MEASURED COST, on the live database before this shipped: of 67,328 songs,
 * 53,499 qualify. **13,829 disappear — one song in five.** Of those, only ~360
 * could be fixed from data we already hold (MAM or the metadata cache); the
 * rest were never allocated codes at all. Ian accepted that deliberately: the
 * gaps are meant to motivate the client to get ISRCs issued.
 *
 * Hence the flag. CATALOGUE_ELIGIBILITY=off restores the previous behaviour
 * instantly, without a deploy, if a fifth of the catalogue vanishing turns out
 * to be worse than the covers it hides.
 */

// Default ON — this is the requested behaviour, not an experiment. Set
// CATALOGUE_ELIGIBILITY=off (or false/0) to disable.
const RAW = String(process.env.CATALOGUE_ELIGIBILITY ?? 'on').trim().toLowerCase();
export const ELIGIBILITY_ENABLED = !['off', 'false', '0', 'no'].includes(RAW);

const has = (v) => typeof v === 'string' ? v.trim() !== '' : (v !== null && v !== undefined && String(v).trim() !== '');

// Artwork lives on the album (Tape Files) and is mirrored onto the song row in
// some shapes; accept either, and require a real URL rather than any truthy
// value — a container path that is not http(s) renders as a broken card, which
// is the thing this rule exists to stop.
const ARTWORK_FIELDS = ['Tape Files::Artwork_S3_URL', 'Artwork_S3_URL', 'Artwork::Picture', 'Artwork Picture', 'Picture'];

function hasCover(fields) {
  for (const f of ARTWORK_FIELDS) {
    const v = fields[f];
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('http://') || t.startsWith('https://')) return true;
    }
  }
  return false;
}

/**
 * @param {object} fields  an FM record's fieldData (the Postgres mirror is
 *                         rehydrated into this same shape by toFmRecords)
 */
export function trackIsEligible(fields = {}) {
  if (!ELIGIBILITY_ENABLED) return true;
  return has(fields.ISRC) && has(fields.UPC) && hasCover(fields);
}

/** Which requirements a record fails — for worklists and diagnostics. */
export function missingRequirements(fields = {}) {
  const out = [];
  if (!has(fields.ISRC)) out.push('isrc');
  if (!has(fields.UPC)) out.push('upc');
  if (!hasCover(fields)) out.push('cover');
  return out;
}
