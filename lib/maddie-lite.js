/**
 * lib/maddie-lite.js — Maddie's zero-cost brain: query understanding over the
 * semantic index. No LLM, no external calls.
 *
 * The naive version embedded the visitor's whole sentence, so filler words
 * out-punched the request ("i want only amapiano music" matched tracks with
 * "Only" in the title and ignored the genre entirely). This layer:
 *
 *   1. PARSES the message against vocabularies built from the index itself —
 *      genres (with aliases + nearest-kin for genres the vault doesn't stock),
 *      artists, languages, decades, tempo/mood words.
 *   2. FILTERS the catalogue by what was understood (hard constraints), and
 *      only embeds the leftover descriptive words (soft ranking).
 *   3. ASKS one clarifying question when nothing concrete was said, and reads
 *      the answer together with the previous message (the route passes both).
 *   4. ACKNOWLEDGES what it understood in the reply, so the visitor can
 *      correct her ("Amapiano, keeping it uptempo — here's a taste").
 *
 * Pure functions (buildVocab / parseLiteQuery / rankCandidates) are exported
 * for unit tests; answerFromShelves() is the orchestrator the route calls.
 */

import { getAllMeta, knnRaw } from './semantic-shelves.js';
import { isBrokenArtworkUrl, thumbArtworkUrl } from './track.js';

// ── normalisation ────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const normWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s']+/g, ' ').split(/\s+/).filter(Boolean);

// Genre spellings visitors use → the catalogue's own labels (normalised).
const GENRE_ALIASES = {
  hiphop: 'hiphop', rap: 'hiphop',
  rnb: 'rbsoul', randb: 'rbsoul',
  afrobeats: 'afrobeat', afrobeat: 'afrobeat',
  boeremusiek: 'boeremusiek',
  mbube: 'isicathamiya',
};

// Genres the vault (mostly pre-2000s) may not stock → the nearest cousin ON
// the shelves. Used for an honest miss that still hands something over.
const GENRE_KIN = {
  gqom: 'house', techno: 'house', trance: 'house', edm: 'house',
  metal: 'rock', punk: 'rock', grunge: 'rock',
  drill: 'hiphop', trap: 'hiphop',
  bachata: 'world', salsa: 'world',
};

// Words that carry intent but not content — stripped before embedding.
const FILLER = new Set([
  'i', 'me', 'my', 'we', 'you', 'your', 'please', 'want', 'wants', 'need',
  'give', 'play', 'find', 'get', 'hear', 'listen', 'listening', 'looking',
  'search', 'show', 'recommend', 'suggestion', 'suggestions', 'suggest',
  'only', 'just', 'some', 'something', 'anything', 'more', 'other', 'few',
  'music', 'song', 'songs', 'track', 'tracks', 'tune', 'tunes', 'record',
  'records', 'album', 'albums', 'artist', 'artists', 'band', 'genre',
  'a', 'an', 'the', 'of', 'with', 'that', 'this', 'and', 'or', 'in', 'on',
  'for', 'to', 'do', 'can', 'could', 'would', 'have', 'has', 'is', 'are',
  'am', 'was', 'be', 'it', 'if', 'so', 'im', "i'm", 'id', "i'd", 'about',
  'by', 'from', 'like', 'love', 'really', 'very', 'nice', 'good', 'great',
  'sharp',
]);

const TEMPO_UP = new Set(['uptempo', 'upbeat', 'fast', 'dance', 'dancing', 'party', 'jol', 'energetic', 'lively', 'jump', 'groove', 'groovy', 'stomp']);
const TEMPO_DOWN = new Set(['relaxed', 'relax', 'slow', 'chill', 'chilled', 'calm', 'mellow', 'easy', 'quiet', 'soft', 'gentle', 'ballad', 'ballads', 'unwind', 'sleep', 'lullaby']);
const MOOD_SAD = new Set(['sad', 'melancholy', 'melancholic', 'heartbreak', 'heartbroken', 'blues', 'mourning', 'crying', 'longing', 'verlange', 'miss', 'missing', 'funeral']);

const LANGUAGE_WORDS = {
  zulu: ['zu', 'zulu'], xhosa: ['xh', 'xhosa'], afrikaans: ['af', 'afrikaans'],
  sotho: ['st', 'southern sotho', 'sotho'], tsonga: ['ts', 'tsonga'],
  shona: ['sn', 'shona'], english: ['en', 'english'],
  instrumental: ['zxx', 'instrumental'],
};

// BPM medians from the June index: p50 = 118, p25 = 103. Uptempo/relaxed cut
// either side of the middle so both buckets stay well stocked.
const BPM_UP = 116;
const BPM_DOWN = 102;

// Generic words that appear inside many artist names — never treat one of
// these alone as an artist hit.
const ARTIST_STOPWORDS = new Set(['band', 'boys', 'girls', 'brothers', 'sisters', 'group', 'orkes', 'choir', 'stars', 'sy', 'his', 'her', 'die', 'queens', 'kings', 'african', 'africa', 'south', 'gospel', 'jazz', 'sound', 'sounds', 'singers', 'ensemble', 'trio', 'quartet', 'orchestra']);

// ── vocab build (once per boot, from the index's own metadata) ───────────────
export function buildVocab(allMeta) {
  const genres = new Map();   // norm → {label, count}
  const artists = new Map();  // norm(full name) → {label, count}
  const artistWords = new Map(); // distinctive word → Set<norm full name>

  for (const { m } of allMeta) {
    for (const g of [m.genre, m.localGenre]) {
      if (!g) continue;
      const k = norm(g);
      if (!k || /^\d+s?$/.test(k)) continue; // "70's" style decade-genres — decades are parsed separately
      const e = genres.get(k) || { label: g, count: 0 };
      e.count += 1;
      genres.set(k, e);
    }
    const a = m.artist || m.albumArtist;
    // Some June-index artist fields are contaminated with whole bio blobs
    // ("The SessionmenProfileGroup initially of British origin…Read More") —
    // never let those into the vocab or the visitor would match them via
    // ordinary English words from the bio.
    if (a && a.length <= 60) {
      const k = norm(a);
      if (k) {
        const e = artists.get(k) || { label: a, count: 0 };
        e.count += 1;
        artists.set(k, e);
        for (const w of normWords(a)) {
          if (w.length < 5 || ARTIST_STOPWORDS.has(w) || FILLER.has(w)) continue;
          let set = artistWords.get(w);
          if (!set) artistWords.set(w, (set = new Set()));
          set.add(k);
        }
      }
    }
  }
  return { genres, artists, artistWords };
}

// ── query parsing ────────────────────────────────────────────────────────────
export function parseLiteQuery(text, vocab) {
  const words = normWords(text);
  const consumed = new Set(); // word indices claimed by a slot

  const parsed = {
    genres: [],        // [{key, label}] — genres present in the catalogue
    missingGenre: null, // {word, kinKey} — genre asked for but not stocked
    artistKeys: null,  // Set<norm artist> when an artist was recognised
    artistLabel: '',
    decade: null,      // {from, to}
    tempo: null,       // 'up' | 'down'
    mood: null,        // 'sad'
    language: null,    // e.g. 'zulu' (matched against both code and name)
    residual: '',      // descriptive leftovers for the embedding
    vague: false,
  };

  // decades & years
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let m;
    if ((m = w.match(/^(19|20)(\d\d)s?$/))) {
      const y = parseInt(m[1] + m[2], 10);
      parsed.decade = w.endsWith('s') || m[2].endsWith('0')
        ? { from: Math.floor(y / 10) * 10, to: Math.floor(y / 10) * 10 + 9 }
        : { from: y, to: y };
      consumed.add(i);
    } else if ((m = w.match(/^([1-9]0)'?s$/))) {
      const d = parseInt(m[1], 10);
      const from = d >= 30 ? 1900 + d : 2000 + d;
      parsed.decade = { from, to: from + 9 };
      consumed.add(i);
    }
  }
  const DECADE_NAMES = { fifties: 1950, sixties: 1960, seventies: 1970, eighties: 1980, nineties: 1990, noughties: 2000 };
  words.forEach((w, i) => {
    if (DECADE_NAMES[w]) { parsed.decade = { from: DECADE_NAMES[w], to: DECADE_NAMES[w] + 9 }; consumed.add(i); }
  });

  // tempo & mood words
  words.forEach((w, i) => {
    if (TEMPO_UP.has(w)) { parsed.tempo = 'up'; consumed.add(i); }
    else if (TEMPO_DOWN.has(w)) { parsed.tempo = 'down'; consumed.add(i); }
    if (MOOD_SAD.has(w)) { parsed.mood = 'sad'; consumed.add(i); }
  });

  // languages ("zulu music", "something in afrikaans")
  for (const [lang, forms] of Object.entries(LANGUAGE_WORDS)) {
    words.forEach((w, i) => {
      if (w.length > 2 && forms.includes(w)) { parsed.language = lang; consumed.add(i); }
    });
  }

  // genres — try 2-word phrases first ("afro pop", "boere musiek"), then single
  for (let span = 2; span >= 1; span--) {
    for (let i = 0; i + span <= words.length; i++) {
      const idxs = Array.from({ length: span }, (_, j) => i + j);
      if (idxs.some((j) => consumed.has(j))) continue;
      const key0 = norm(idxs.map((j) => words[j]).join(''));
      const key = vocab.genres.has(key0) ? key0 : GENRE_ALIASES[key0];
      if (key && vocab.genres.has(key)) {
        if (!parsed.genres.some((g) => g.key === key)) {
          parsed.genres.push({ key, label: vocab.genres.get(key).label });
        }
        idxs.forEach((j) => consumed.add(j));
      } else if (span === 1 && GENRE_KIN[key0] && !parsed.genres.length) {
        const kin = GENRE_KIN[key0];
        if (vocab.genres.has(kin)) { parsed.missingGenre = { word: words[i], kinKey: kin }; consumed.add(i); }
      }
    }
  }

  // artists — longest phrase match wins; else a distinctive single word that
  // maps to at most 3 artists (e.g. "mahlathini")
  outer:
  for (let span = Math.min(4, words.length); span >= 2; span--) {
    for (let i = 0; i + span <= words.length; i++) {
      const idxs = Array.from({ length: span }, (_, j) => i + j);
      if (idxs.some((j) => consumed.has(j))) continue;
      const key = norm(idxs.map((j) => words[j]).join(''));
      if (key.length >= 5 && vocab.artists.has(key)) {
        parsed.artistKeys = new Set([key]);
        parsed.artistLabel = vocab.artists.get(key).label;
        idxs.forEach((j) => consumed.add(j));
        break outer;
      }
    }
  }
  if (!parsed.artistKeys) {
    for (let i = 0; i < words.length; i++) {
      if (consumed.has(i) || FILLER.has(words[i])) continue;
      const set = vocab.artistWords.get(words[i]);
      // A distinctive word may span a family of acts ("mahlathini" appears in
      // several billings) — allow up to 6, label with the best-stocked one.
      if (set && set.size <= 6) {
        parsed.artistKeys = set;
        parsed.artistLabel = [...set]
          .map((k) => vocab.artists.get(k))
          .sort((a, b) => b.count - a.count)[0].label;
        consumed.add(i);
        break;
      }
    }
  }

  // residual = whatever wasn't claimed and isn't filler
  const residualWords = words.filter((w, i) => !consumed.has(i) && !FILLER.has(w));
  parsed.residual = residualWords.join(' ');

  const hasFilter = parsed.genres.length || parsed.missingGenre || parsed.artistKeys
    || parsed.decade || parsed.tempo || parsed.mood || parsed.language;
  parsed.vague = !hasFilter && residualWords.length === 0;
  return parsed;
}

// ── candidate filtering / ranking (pure) ─────────────────────────────────────
function matchesFilters(m, parsed) {
  if (parsed.genres.length) {
    const g1 = norm(m.genre), g2 = norm(m.localGenre);
    if (!parsed.genres.some((g) => g.key === g1 || g.key === g2)) return false;
  }
  if (parsed.artistKeys) {
    const a1 = norm(m.artist), a2 = norm(m.albumArtist);
    if (![...parsed.artistKeys].some((k) => a1 === k || a2 === k)) return false;
  }
  if (parsed.decade) {
    const y = parseInt(m.year, 10);
    if (!y || y < parsed.decade.from || y > parsed.decade.to) return false;
  }
  if (parsed.language) {
    const forms = LANGUAGE_WORDS[parsed.language];
    if (!forms.includes(String(m.language || '').toLowerCase())) return false;
  }
  if (parsed.mood === 'sad' && !/sad/i.test(m.mood || '')) return false;
  if (parsed.tempo) {
    const bpm = parseFloat(m.bpm);
    if (!bpm) return false;
    if (parsed.tempo === 'up' && bpm < BPM_UP) return false;
    if (parsed.tempo === 'down' && bpm > BPM_DOWN) return false;
  }
  return true;
}

/**
 * Rank {m, distance?} candidates: semantic distance when present, else a
 * mild shuffle so repeat queries don't hand back the same three forever.
 * One track per artist, `n` results.
 */
export function rankCandidates(cands, n = 3, seed = Date.now()) {
  const scored = cands.map((c, i) => ({
    ...c,
    _s: c.distance !== undefined ? c.distance : ((seed + i * 2654435761) % 997) / 997,
  })).sort((a, b) => a._s - b._s);
  const out = [];
  const seenArtists = new Set();
  for (const c of scored) {
    const k = norm(c.m.artist || c.m.albumArtist);
    if (seenArtists.has(k)) continue;
    seenArtists.add(k);
    out.push(c);
    if (out.length === n) break;
  }
  return out;
}

// ── reply templating ─────────────────────────────────────────────────────────
export const QUESTION_LINE = 'What are you in the mood for? Give me a genre — gospel, jazz, maskandi, amapiano, boeremusiek — or a feeling: uptempo for dancing, or something slow and easy. A decade helps too.';

function ackReply(parsed, count) {
  const bits = [];
  if (parsed.genres.length) bits.push(parsed.genres.map((g) => g.label).join(' + '));
  if (parsed.artistLabel) bits.push(parsed.artistLabel);
  if (parsed.language) bits.push(`in ${parsed.language[0].toUpperCase()}${parsed.language.slice(1)}`);
  if (parsed.decade) bits.push(`from the ${parsed.decade.from}s`.replace('s0s', '0s'));
  if (parsed.tempo === 'up') bits.push('keeping it uptempo');
  if (parsed.tempo === 'down') bits.push('nice and easy');
  if (parsed.mood === 'sad') bits.push('for the heavy-hearted');
  if (!bits.length) {
    // Residual-only query — nothing structured to acknowledge.
    return 'Off what you said, these came off the shelf first — press play, and tell me warmer or cooler.';
  }
  const what = bits.join(', ');
  const depth = count > 40 ? ` — the shelves go ${count} deep on this` : '';
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}${depth}. Here’s a taste — press play, and tell me warmer or cooler.`;
}

// Bio-contaminated index fields must never reach a card whole — prefer the
// shorter of artist/albumArtist and hard-clamp the rest.
function cleanField(s, max = 80) {
  const v = String(s || '').trim();
  return v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v;
}

function trackCard(m, recordId) {
  let artworkUrl = m.artworkUrl || '';
  if (isBrokenArtworkUrl(artworkUrl)) artworkUrl = '';
  if (artworkUrl && process.env.ARTWORK_THUMBS === 'true') artworkUrl = thumbArtworkUrl(artworkUrl, 300);
  const a1 = String(m.artist || '').trim();
  const a2 = String(m.albumArtist || '').trim();
  const artist = (a1 && (!a2 || a1.length <= a2.length) ? a1 : a2) || a1;
  return {
    recordId: String(recordId),
    title: cleanField(m.track),
    artist: cleanField(artist, 60),
    album: cleanField(m.album),
    albumArtist: cleanField(m.albumArtist, 60),
    cat: cleanField(m.catalogue, 40),
    // Pre-cleanup corruption survives in the June index ("11-0") — only show
    // a year that looks like one.
    year: /^(19|20)\d{2}$/.test(m.year) ? m.year : '',
    artworkUrl,
  };
}

// ── orchestrator ─────────────────────────────────────────────────────────────
/**
 * Answer a visitor message from the shelves.
 * @param {string} text — the current message (the route may prepend the
 *   previous one when the last thing Maddie said was the clarifying question).
 * @returns {reply, tracks, asked} or null when the index is unavailable.
 */
export async function answerFromShelves(text) {
  const allMeta = await getAllMeta();
  if (!allMeta) return null;
  if (!answerFromShelves._vocab) answerFromShelves._vocab = buildVocab(allMeta);
  const vocab = answerFromShelves._vocab;

  const parsed = parseLiteQuery(text, vocab);

  if (parsed.vague) return { reply: QUESTION_LINE, tracks: [], asked: true };

  // Genre asked for that the vault doesn't stock → honest miss + nearest kin.
  if (parsed.missingGenre && !parsed.genres.length) {
    parsed.genres = [{ key: parsed.missingGenre.kinKey, label: vocab.genres.get(parsed.missingGenre.kinKey).label }];
    const pool = allMeta.filter((c) => matchesFilters(c.m, parsed));
    const picked = rankCandidates(pool, 5);
    return {
      reply: `Eish — no ${parsed.missingGenre.word} on these shelves; the vault mostly stops before that beat arrived. Closest cousin here is ${parsed.genres[0].label} — have a taste and tell me.`,
      tracks: picked.map((c) => trackCard(c.m, c.recordId)),
    };
  }

  const hasFilter = parsed.genres.length || parsed.artistKeys || parsed.decade
    || parsed.tempo || parsed.mood || parsed.language;

  let picked = [];
  let poolSize = 0;

  if (hasFilter) {
    const pool = allMeta.filter((c) => matchesFilters(c.m, parsed));
    poolSize = pool.length;
    if (pool.length) {
      if (parsed.residual) {
        // Semantic rank WITHIN the filtered pool.
        const hits = await knnRaw(parsed.residual, 500);
        const byId = new Map(pool.map((c) => [String(c.recordId), c]));
        const inPool = (hits || []).filter((h) => byId.has(String(h.recordId)));
        picked = rankCandidates(inPool.length >= 3 ? inPool : pool, 5);
      } else {
        picked = rankCandidates(pool, 5);
      }
    }
  } else {
    // Descriptive words only ("wedding songs", "rain on a tin roof") — pure
    // semantic search on the distilled residual, not the raw sentence.
    const hits = await knnRaw(parsed.residual, 24);
    poolSize = hits?.length || 0;
    picked = rankCandidates(hits || [], 5);
  }

  if (!picked.length) {
    return {
      reply: 'Eish — the shelves came up quiet on that exact mix. Loosen one thing for me — different decade, or drop the tempo — and I’ll look again.',
      tracks: [],
    };
  }

  return { reply: ackReply(parsed, poolSize), tracks: picked.map((c) => trackCard(c.m, c.recordId)) };
}
