import { describe, it, expect } from 'vitest';
import { parseRelatedMusic } from '../../routes/artist-bio.js';

// The bio's "Related Music in Streamer" text feeds the Suggested for You rail.
describe('parseRelatedMusic', () => {
  const text = [
    'RELATED MUSIC IN THE STREAMER — Lucky Dube',
    '(auto-collated from catalogue credits, 9 Jul 2026)',
    '',
    'COMPOSER / LYRICIST CREDITS ON OTHERS’ RECORDINGS (9 albums, 34 tracks):',
    '• Sister Phumi — Substitute (1990): "When We Are In Tears", "Party Tonight" +5 more',
    '',
    'PRODUCED FOR OTHER ARTISTS (1 album, 12 tracks):',
    '• Ladysmith Black Butterflies — Zokhala Zonke (1976): "Sisebusweni Bakho"',
    '',
    'COLLABORATIONS / FEATURED ON (2 albums, 2 tracks):',
    '• Temple Boys CPT and DJ Electronic — Ons is Hier: "Dala Net Mosag"',
    '• Oliver Mtukudzi — Tuku (Live) (2001): "Neria"',
  ].join('\n');

  it('reads artist, album and the relation from its heading', () => {
    expect(parseRelatedMusic(text)).toEqual([
      { artist: 'Sister Phumi', title: 'Substitute', relation: 'wrote for' },
      { artist: 'Ladysmith Black Butterflies', title: 'Zokhala Zonke', relation: 'produced' },
      { artist: 'Temple Boys CPT and DJ Electronic', title: 'Ons is Hier', relation: 'features' },
      { artist: 'Oliver Mtukudzi', title: 'Tuku (Live)', relation: 'features' },
    ]);
  });

  it('ignores empty or unheaded text', () => {
    expect(parseRelatedMusic('')).toEqual([]);
    expect(parseRelatedMusic('• A — B (1990): "x"')).toEqual([]);
  });
});
