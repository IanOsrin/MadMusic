import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the loader at a small fixture BEFORE importing the module (INDEX_PATH is
// resolved from env at module load).
const FIXTURE = path.join(os.tmpdir(), `mad-name-index-${process.pid}.json`);
fs.writeFileSync(FIXTURE, JSON.stringify({
  builtAt: '2026-06-25T00:00:00.000Z',
  artists: [
    { name: 'Thandiswa', n: 70 },
    { name: 'Ladysmith Black Mambazo', n: 896 },
    { name: 'Oliver Mtukudzi', n: 775 },
    { name: 'Tommy Oliver', n: 5 },
    { name: 'Soul Brothers', n: 1030 },
    { name: 'Miriam Makeba', n: 120 },
    { name: 'Simphiwe Dana', n: 60 },
    { name: 'Simphiwe Dana feat. Carlo Mombelli', n: 3 }
  ],
  albums: [
    { name: 'Zabalaza', n: 12 },
    { name: 'Tuku Music', n: 8 }
  ]
}));
process.env.NAME_INDEX_PATH = FIXTURE;

let initNameIndex, suggestNames, nameIndexStatus;
beforeAll(async () => {
  const mod = await import('../../lib/name-index.js');
  initNameIndex = mod.initNameIndex;
  suggestNames = mod.suggestNames;
  nameIndexStatus = mod.nameIndexStatus;
  initNameIndex();
});

describe('name-index suggestNames', () => {
  it('loads the fixture and reports ready', () => {
    const s = nameIndexStatus();
    expect(s.ready).toBe(true);
    expect(s.artists).toBe(8);
    expect(s.albums).toBe(2);
  });

  it('corrects a single-word typo to the right artist', () => {
    const out = suggestNames('Thandsiwa');
    expect(out[0]?.name).toBe('Thandiswa');
  });

  it('corrects a multi-word typo', () => {
    const out = suggestNames('Oliver Mtukidzi').map(s => s.name);
    expect(out).toContain('Oliver Mtukudzi');
    expect(out.indexOf('Oliver Mtukudzi')).toBe(0);
  });

  it('handles a long-name typo (Ladysmith)', () => {
    const out = suggestNames('Ladismith Black Mambazo').map(s => s.name);
    expect(out[0]).toBe('Ladysmith Black Mambazo');
  });

  it('corrects a first-name typo when only the full name is stored', () => {
    // "dimphiwe" must reach the "Simphiwe" word inside "Simphiwe Dana"
    const out = suggestNames('dimphiwe').map(s => s.name);
    expect(out[0]).toBe('Simphiwe Dana');
  });

  it('collapses near-duplicate "feat." variants of the same base name', () => {
    const out = suggestNames('dimphiwe').map(s => s.name);
    expect(out).not.toContain('Simphiwe Dana feat. Carlo Mombelli');
  });

  it('does not let a single shared common word pull in unrelated names', () => {
    // "Oliver Mtukidzi" must not surface "Tommy Oliver" (shares only "Oliver")
    const out = suggestNames('Oliver Mtukidzi').map(s => s.name);
    expect(out[0]).toBe('Oliver Mtukudzi');
    expect(out).not.toContain('Tommy Oliver');
  });

  it('returns nothing for gibberish', () => {
    expect(suggestNames('zzzxqqwfff')).toEqual([]);
  });

  it('excludes the exact query (no self-suggestion)', () => {
    const out = suggestNames('Thandiswa').map(s => s.name);
    expect(out).not.toContain('Thandiswa');
  });

  it('ignores too-short queries', () => {
    expect(suggestNames('a')).toEqual([]);
    expect(suggestNames('')).toEqual([]);
  });

  it('tags suggestions with kind and a numeric score', () => {
    const [top] = suggestNames('Soul Bruthers');
    expect(top.name).toBe('Soul Brothers');
    expect(top.kind).toBe('artist');
    expect(typeof top.score).toBe('number');
    expect(top.score).toBeGreaterThan(0.66);
  });
});
