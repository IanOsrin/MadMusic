import { describe, it, expect } from 'vitest';
import { titlesAgree, buildMixableMap } from '../../lib/mixer-match.js';

// Cases from the 2026-09-25 MADMixer ↔ MadStreamer ISRC check.
describe('titlesAgree', () => {
  it('accepts spelling variants of the same song', () => {
    expect(titlesAgree('Boshok Seties', 'Boshok Setees')).toBe(true);
    expect(titlesAgree('Adam En Eve En Die Appeltjie', 'Adam En Eva En Die Appeltjie')).toBe(true);
    expect(titlesAgree('Black White Calypso', 'Black and White Calypso')).toBe(true);
    expect(titlesAgree("Bennie's Mood", "Beanie's Mood")).toBe(true);
    expect(titlesAgree("Bhod L'Umlilo", "Bhodl' Umlilo")).toBe(true);
    expect(titlesAgree("Bhod L'Umlilo", "Bhod L'Umlilo (To Belch Fire)")).toBe(true);
  });
  it('refuses a different song carrying the same ISRC', () => {
    expect(titlesAgree('Afro Funky', 'Nightingale (Sing Your Song) (Aandlied Van Die Voëls)')).toBe(false);
    expect(titlesAgree('Back to Stay', "Steppin' Out On Love")).toBe(false);
    expect(titlesAgree('My Moeder', 'My Moeder En Vader in Die Hemel')).toBe(false);
  });
  it('refuses empty titles', () => {
    expect(titlesAgree('', 'Anything')).toBe(false);
  });
});

describe('buildMixableMap', () => {
  const songs = [
    { id: '1', title: 'Afro Funky', album: 'Afro Funky', isrc: 'ZAC032201536', playable: true },
    { id: '2', title: 'Back to Stay', album: 'Positive', isrc: 'ZAC030201243', playable: true },
    { id: '3', title: 'Back to Stay', album: 'Living a Positive Attitude', isrc: 'ZAC030201243', playable: true },
    { id: '4', title: 'Silent Song', album: 'X', isrc: 'ZAC000000001', playable: false },
  ];
  const streamer = {
    ZAC032201536: [{ recordId: 7235, title: 'Afro Funky', album: 'Afro Funky' },
                   { recordId: 25819, title: 'Nightingale (Sing Your Song)', album: 'My Everything' }],
    ZAC030201243: [{ recordId: 101936, title: 'Back to Stay', album: 'Positive' },
                   { recordId: 101937, title: "Steppin' Out On Love", album: 'Positive' },
                   { recordId: 101942, title: 'Back to Stay', album: 'Living a Positive Attitude' },
                   { recordId: 123171, title: 'Back to Stay', album: 'Pierre de Charmoy' }],
    ZAC000000001: [{ recordId: 9, title: 'Silent Song', album: 'X' }],
  };
  const map = buildMixableMap(songs, streamer);

  it('links matching tracks, preferring the MADMixer row from the same album', () => {
    expect(map).toMatchObject({ 7235: '1', 101936: '2', 101942: '3', 123171: '2' });
  });
  it('leaves out tracks carrying another song’s ISRC', () => {
    expect(map[25819]).toBeUndefined();
    expect(map[101937]).toBeUndefined();
  });
  it('leaves out songs Mad Mixer cannot open yet', () => {
    expect(map[9]).toBeUndefined();
  });
});
