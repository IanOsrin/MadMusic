// Unit guards for the public catalogue slug rules (SEO tier 2).
import { describe, it, expect } from 'vitest';
import { slugify } from '../../lib/catalog-slugs.js';

describe('catalog slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Lucky Dube')).toBe('lucky-dube');
    expect(slugify('The Mthunzini Girls')).toBe('the-mthunzini-girls');
  });

  it('strips diacritics after NFC normalization (Gé Korsten, both encodings)', () => {
    expect(slugify('Gé Korsten')).toBe('ge-korsten');            // precomposed
    expect(slugify('Gé Korsten')).toBe('ge-korsten');      // macOS-decomposed
  });

  it('handles punctuation, ampersands, and length', () => {
    expect(slugify('Sipho "Hotstix" Mabuse')).toBe('sipho-hotstix-mabuse');
    expect(slugify('Mahlathini & The Mahotella Queens')).toBe('mahlathini-and-the-mahotella-queens');
    expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it('never returns an empty slug', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
  });
});
