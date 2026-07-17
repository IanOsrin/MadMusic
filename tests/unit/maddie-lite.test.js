// Maddie-lite query understanding (2026-07-17): the naive version embedded
// the visitor's whole sentence, so "i want only amapiano music" matched
// tracks with "Only" in the TITLE and ignored the genre. The parser now
// extracts genre/tempo/mood/decade/language/artist as hard filters, strips
// filler before embedding, and asks a clarifying question when vague.
import { describe, it, expect } from 'vitest';
import { buildVocab, parseLiteQuery, rankCandidates, QUESTION_LINE } from '../../lib/maddie-lite.js';

// Small synthetic catalogue in the index's meta shape.
const META = [
  { recordId: '1', m: { track: 'Only You', artist: 'Some Band', genre: 'Pop', localGenre: 'Pop', year: '1985', bpm: '120', mood: 'Happy / Energetic', language: 'en' } },
  { recordId: '2', m: { track: 'Sgudi Snyc', artist: 'Piano Kings', genre: 'Amapiano', localGenre: 'Amapiano', year: '2019', bpm: '112', mood: 'Happy / Energetic', language: 'zu' } },
  { recordId: '3', m: { track: 'Log Drum Anthem', artist: 'Yano Cartel', genre: 'Amapiano', localGenre: 'Amapiano', year: '2020', bpm: '113', mood: 'Happy / Energetic', language: 'zu' } },
  { recordId: '4', m: { track: 'Jive Motella', artist: 'Mahlathini and The Mahotella Queens', genre: 'Mbaqanga', localGenre: 'Mbaqanga', year: '1987', bpm: '124', mood: 'Happy / Energetic', language: 'zu' } },
  { recordId: '5', m: { track: 'Stil Water', artist: 'Anna Botha', genre: 'Boere Musiek', localGenre: 'Boere Musiek', year: '1962', bpm: '92', mood: 'Relaxed / Calm', language: 'af' } },
  { recordId: '6', m: { track: 'House Party', artist: 'DJ Duma', genre: 'House', localGenre: 'House', year: '1998', bpm: '126', mood: 'Happy / Energetic', language: 'zxx' } },
  { recordId: '7', m: { track: 'Weeping Willow', artist: 'Sad Strings', genre: 'Jazz', localGenre: 'Jazz', year: '1975', bpm: '84', mood: 'Sad / Melancholic', language: 'en' } },
];
const vocab = buildVocab(META);

describe('parseLiteQuery', () => {
  it('THE BUG: "i want only amapiano music" → genre filter, no residual "only"', () => {
    const p = parseLiteQuery('i want only amapiano music', vocab);
    expect(p.genres.map(g => g.key)).toEqual(['amapiano']);
    expect(p.residual).toBe('');       // "only"/"music" are filler, not embed text
    expect(p.vague).toBe(false);
  });

  it('extracts tempo words to a BPM constraint', () => {
    expect(parseLiteQuery('something uptempo for dancing', vocab).tempo).toBe('up');
    expect(parseLiteQuery('relaxed slow songs please', vocab).tempo).toBe('down');
  });

  it('extracts decades in several spellings', () => {
    expect(parseLiteQuery('jazz from the 80s', vocab).decade).toEqual({ from: 1980, to: 1989 });
    expect(parseLiteQuery('music from the eighties', vocab).decade).toEqual({ from: 1980, to: 1989 });
    expect(parseLiteQuery('songs from 1975', vocab).decade).toEqual({ from: 1975, to: 1975 });
  });

  it('recognises an artist by distinctive single word', () => {
    const p = parseLiteQuery('anything by mahlathini', vocab);
    expect(p.artistLabel).toBe('Mahlathini and The Mahotella Queens');
  });

  it('maps an unstocked genre to its nearest kin (honest miss)', () => {
    const p = parseLiteQuery('play some techno', vocab);
    expect(p.missingGenre).toEqual({ word: 'techno', kinKey: 'house' });
  });

  it('flags a contentless message as vague (triggers the question)', () => {
    expect(parseLiteQuery('play me something', vocab).vague).toBe(true);
    expect(parseLiteQuery('recommend some music please', vocab).vague).toBe(true);
    expect(QUESTION_LINE).toMatch(/genre/i);
  });

  it('keeps descriptive words as residual for the embedding', () => {
    const p = parseLiteQuery('songs about rain on a tin roof', vocab);
    expect(p.vague).toBe(false);
    expect(p.residual).toContain('rain');
    expect(p.residual).toContain('roof');
  });

  it('detects language requests', () => {
    expect(parseLiteQuery('zulu gospel', vocab).language).toBe('zulu');
    expect(parseLiteQuery('afrikaans songs', vocab).language).toBe('afrikaans');
  });
});

describe('rankCandidates', () => {
  it('caps at n with one track per artist', () => {
    const dupes = [
      { recordId: '2', m: META[1].m, distance: 0.1 },
      { recordId: '2b', m: { ...META[1].m, track: 'Second' }, distance: 0.2 },
      { recordId: '3', m: META[2].m, distance: 0.3 },
    ];
    const out = rankCandidates(dupes, 3);
    expect(out.map(c => c.recordId)).toEqual(['2', '3']);
  });

  it('orders by semantic distance when present', () => {
    const cands = [
      { recordId: 'far', m: META[0].m, distance: 0.9 },
      { recordId: 'near', m: META[6].m, distance: 0.1 },
    ];
    expect(rankCandidates(cands, 2)[0].recordId).toBe('near');
  });
});
