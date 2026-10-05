import { describe, it, expect, beforeAll } from 'vitest';

let buildQueries, buildRelaxedQueries, SEARCH_FIELDS_DEFAULT;
beforeAll(async () => {
  const mod = await import('../../routes/catalog/search.js');
  buildQueries = mod.buildQueries;
  buildRelaxedQueries = mod.buildRelaxedQueries;
  SEARCH_FIELDS_DEFAULT = mod.SEARCH_FIELDS_DEFAULT;
});

describe('strict free-text query (buildQueries)', () => {
  it('requires ALL words in ONE field (the tight behaviour we relax from)', () => {
    const qs = buildQueries({ q: 'Thandiswa Mazwai', artist: '', album: '', track: '', genres: [] });
    // one OR clause per searchable field, each demanding both words
    expect(qs).toHaveLength(SEARCH_FIELDS_DEFAULT.length);
    expect(qs[0]).toEqual({ 'Album Artist': '*Thandiswa* *Mazwai*' });
  });
});

describe('relaxed free-text query (buildRelaxedQueries)', () => {
  it('emits one OR clause per field × per word (match ANY word, any field)', () => {
    const qs = buildRelaxedQueries('Thandiswa Mazwai');
    // 6 fields × 2 words = 12 single-word clauses
    expect(qs).toHaveLength(SEARCH_FIELDS_DEFAULT.length * 2);
    expect(qs).toContainEqual({ 'Album Artist': '*Thandiswa*' });
    expect(qs).toContainEqual({ 'Album Artist': '*Mazwai*' });
    // crucially, no clause requires both words together
    expect(qs.every(c => !Object.values(c)[0].includes(' '))).toBe(true);
  });

  it('caps very long queries to 6 words', () => {
    const qs = buildRelaxedQueries('aaa bbb ccc ddd eee fff ggg hhh iii');
    expect(qs).toHaveLength(SEARCH_FIELDS_DEFAULT.length * 6);
  });

  // A lone short word is its own OR clause here — no trigram index can serve it, so it read the
  // whole catalogue (2026-10-05). Only 3+ letter words get a clause.
  it('drops words shorter than 3 letters', () => {
    const qs = buildRelaxedQueries('dj sbu');
    expect(qs).toHaveLength(SEARCH_FIELDS_DEFAULT.length);
    expect(qs).toContainEqual({ 'Album Artist': '*sbu*' });
    expect(qs.some(c => Object.values(c)[0] === '*dj*')).toBe(false);
  });
});

describe('searches too short for the indexes (2026-10-05: "ub" took 20-25 s on live)', () => {
  let hasIndexableWord, runSearch;
  beforeAll(async () => {
    const mod = await import('../../routes/catalog/search.js');
    hasIndexableWord = mod.hasIndexableWord;
    runSearch = mod.runSearch;
  });

  it('needs one word of 3+ letters', () => {
    expect(hasIndexableWord('ub')).toBe(false);
    expect(hasIndexableWord('a b c')).toBe(false);
    expect(hasIndexableWord('ubu')).toBe(true);
    expect(hasIndexableWord('dj sbu')).toBe(true);
  });

  it('answers a too-short free-text search without touching the database', async () => {
    const r = await runSearch({ q: 'ub', artist: '', album: '', track: '', genres: [], yearRange: null, limit: 10, uiOff0: 0, fmOff: 1 });
    expect(r).toMatchObject({ items: [], total: 0, tooShort: true });
  });
});
