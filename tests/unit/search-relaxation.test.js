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
    const qs = buildRelaxedQueries('a b c d e f g h i');
    expect(qs).toHaveLength(SEARCH_FIELDS_DEFAULT.length * 6);
  });
});
