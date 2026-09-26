/**
 * lib/mixer-match.js — which MAD (MadStreamer) tracks may open in Mad Mixer.
 *
 * Only songs in the MADMixer database can be mixed. The link between a MadStreamer track and a
 * MADMixer song is the ISRC, with the title as a safety check: some MadStreamer tracks carry
 * another song's ISRC (the 2026-09-25 check found Virginia Lee's "Nightingale" holding Manana's
 * "Afro Funky" ISRC), so an ISRC match whose title is clearly a different song is refused.
 * Spelling variants of the same title ("Boshok Seties" / "Boshok Setees", "Bhodl' Umlilo" /
 * "Bhod L'Umlilo (To Belch Fire)") still link.
 */

// Lower-case, accents off, bracketed extras off ("(To Belch Fire)", "[Live]"), letters+digits only.
export function titleKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Same song? Equal keys, one a word-prefix of the other ("Bump Jive" / "Bump Jive, No. 5" is NOT
// accepted — keys must match up to a small spelling slip), or a spelling slip of ≤ 20 % (min 2).
export function titlesAgree(a, b) {
  const x = titleKey(a), y = titleKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const allowed = Math.max(2, Math.floor(Math.min(x.length, y.length) * 0.2));
  if (Math.abs(x.length - y.length) > allowed) return false;
  return editDistance(x, y) <= allowed;
}

/**
 * Build { streamerRecordId → madMixerSongId } from the MADMixer songs and, per ISRC, the
 * MadStreamer tracks carrying it. Only songs Mad Mixer can actually open (playable) count.
 * When several MADMixer rows share an ISRC (the same song on several albums), a track links to
 * the row from its own album if there is one, otherwise the first.
 *
 * @param {Array<{id,title,album,isrc,playable}>} songs  MADMixer song summaries
 * @param {Record<string, Array<{recordId,title,album}>>} streamerByIsrc
 */
export function buildMixableMap(songs, streamerByIsrc) {
  const byIsrc = new Map();
  for (const s of songs) {
    const isrc = String(s.isrc || '').trim().toUpperCase();
    if (!isrc || !s.playable) continue;
    if (!byIsrc.has(isrc)) byIsrc.set(isrc, []);
    byIsrc.get(isrc).push(s);
  }
  const tracks = {};
  for (const [isrc, rows] of byIsrc) {
    for (const t of streamerByIsrc[isrc] || []) {
      const candidates = rows.filter((s) => titlesAgree(s.title, t.title));
      if (!candidates.length) continue;                       // ISRC matches, title doesn't → refuse
      const sameAlbum = candidates.find((s) => titleKey(s.album) && titleKey(s.album) === titleKey(t.album));
      tracks[String(t.recordId)] = String((sameAlbum || candidates[0]).id);
    }
  }
  return tracks;
}
