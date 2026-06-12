// Unit tests for lib/album-dedup.js — the album-rail dedup + Various Artists
// folding rules. The "Victims" fixtures mirror real catalogue rows that split
// one album into two cards before this helper existed.
import { describe, it, expect } from 'vitest';
import { dedupRecordsByAlbum, isVariousArtists } from '../../lib/album-dedup.js';

let nextId = 1;
function row(fields) {
  return { recordId: String(nextId++), modId: '0', fieldData: fields };
}

describe('isVariousArtists', () => {
  it('matches the common Various spellings', () => {
    for (const v of ['Various Artists', 'various artists', 'Various', 'VA', 'V.A.', 'v.a', ' Various Artist ']) {
      expect(isVariousArtists(v), v).toBe(true);
    }
  });

  it('does not match named artists or empty input', () => {
    for (const v of ['Lucky Dube', 'Vusi Mahlasela', 'Valiant', '', null, undefined]) {
      expect(isVariousArtists(v), String(v)).toBe(false);
    }
  });
});

describe('dedupRecordsByAlbum', () => {
  it('collapses an album to one row keyed by album-first artist', () => {
    const out = dedupRecordsByAlbum([
      row({ 'Album Title': 'Victims', 'Album Artist': 'Lucky Dube', 'Tape Files::Album Artist': 'Lucky Dube' }),
      row({ 'Album Title': 'Victims', 'Album Artist': 'Lucky Dube', 'Tape Files::Album Artist': 'Lucky Dube' }),
      row({ 'Album Title': 'Hometalk', 'Album Artist': 'Mango Groove', 'Tape Files::Album Artist': 'Mango Groove' })
    ]);
    expect(out.map(r => r.fieldData['Album Title'])).toEqual(['Victims', 'Hometalk']);
  });

  it('folds a stray Various base-field row into the named album (the Victims case)', () => {
    const out = dedupRecordsByAlbum([
      row({ 'Album Title': 'Victims', 'Album Artist': 'Lucky Dube', 'Tape Files::Album Artist': 'Lucky Dube' }),
      // Real data slip: base field says Various, curated related field is correct.
      row({ 'Album Title': 'Victims', 'Album Artist': 'Various Artists', 'Tape Files::Album Artist': 'Lucky Dube' })
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fieldData['Album Artist']).toBe('Lucky Dube');
  });

  it('folds a fully-Various row into the single named artist for that title', () => {
    const out = dedupRecordsByAlbum([
      row({ 'Album Title': 'Victims', 'Album Artist': 'Various Artists', 'Tape Files::Album Artist': 'Various Artists' }),
      row({ 'Album Title': 'Victims', 'Album Artist': 'Lucky Dube', 'Tape Files::Album Artist': 'Lucky Dube' })
    ]);
    expect(out).toHaveLength(1);
    // Representative prefers the clean named row even when Various came first.
    expect(out[0].fieldData['Album Artist']).toBe('Lucky Dube');
  });

  it('keeps a true compilation as a single Various Artists card', () => {
    const out = dedupRecordsByAlbum([
      row({ 'Album Title': 'Township Jive', 'Album Artist': 'Various Artists', 'Tape Files::Album Artist': 'Various Artists' }),
      row({ 'Album Title': 'Township Jive', 'Album Artist': 'Various Artists', 'Tape Files::Album Artist': 'Various Artists' })
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fieldData['Album Artist']).toBe('Various Artists');
  });

  it('does not merge different albums that share a title', () => {
    const out = dedupRecordsByAlbum([
      row({ 'Album Title': 'Greatest Hits', 'Album Artist': 'Stimela', 'Tape Files::Album Artist': 'Stimela' }),
      row({ 'Album Title': 'Greatest Hits', 'Album Artist': 'Lucky Dube', 'Tape Files::Album Artist': 'Lucky Dube' })
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps a Various row separate when several named artists share the title (ambiguous)', () => {
    const out = dedupRecordsByAlbum([
      row({ 'Album Title': 'Greatest Hits', 'Album Artist': 'Stimela', 'Tape Files::Album Artist': 'Stimela' }),
      row({ 'Album Title': 'Greatest Hits', 'Album Artist': 'Lucky Dube', 'Tape Files::Album Artist': 'Lucky Dube' }),
      row({ 'Album Title': 'Greatest Hits', 'Album Artist': 'Various Artists', 'Tape Files::Album Artist': 'Various Artists' })
    ]);
    expect(out).toHaveLength(3);
  });

  it('treats a missing album-artist as Various and folds it', () => {
    const out = dedupRecordsByAlbum([
      row({ 'Album Title': 'Zandisile', 'Album Artist': 'Simphiwe Dana', 'Tape Files::Album Artist': 'Simphiwe Dana' }),
      row({ 'Album Title': 'Zandisile' })
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fieldData['Album Artist']).toBe('Simphiwe Dana');
  });

  it('falls back to recordId when there is no album title', () => {
    const a = row({ 'Track Name': 'Loose Track A' });
    const b = row({ 'Track Name': 'Loose Track B' });
    expect(dedupRecordsByAlbum([a, b])).toHaveLength(2);
  });

  it('preserves first-seen album order', () => {
    const out = dedupRecordsByAlbum([
      row({ 'Album Title': 'B Album', 'Album Artist': 'B', 'Tape Files::Album Artist': 'B' }),
      row({ 'Album Title': 'A Album', 'Album Artist': 'A', 'Tape Files::Album Artist': 'A' }),
      row({ 'Album Title': 'B Album', 'Album Artist': 'B', 'Tape Files::Album Artist': 'B' })
    ]);
    expect(out.map(r => r.fieldData['Album Title'])).toEqual(['B Album', 'A Album']);
  });
});
