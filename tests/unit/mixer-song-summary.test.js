import { describe, it, expect } from 'vitest';
import { songSummary, bpmOf, storedStems } from '../../lib/mixer-catalogue.js';

describe('MADMixer song summary — key and tempo for the Mixer song list', () => {
  it('reads AI_BPM with a decimal comma or point, and drops nonsense', () => {
    expect(bpmOf('115,8')).toBe(115.8);
    expect(bpmOf('89.25')).toBe(89.3);
    expect(bpmOf(120)).toBe(120);
    for (const v of ['', null, undefined, '0', 'abc', '12', '400']) expect(bpmOf(v)).toBeNull();
  });
  it('passes key and bpm through, blank when MADMixer has none', () => {
    const s = songSummary({ recordId: 7, fieldData: { 'Track Name': 'A', AI_Key: ' F major ', AI_BPM: '115,8', 'Local Genre': '', Genre: 'Gospel' } });
    expect(s).toMatchObject({ id: '7', key: 'F major', bpm: 115.8, genre: 'Gospel' });
    expect(songSummary({ recordId: 8, fieldData: {} })).toMatchObject({ key: '', bpm: null });
  });
});

describe('storedStems: a song counts as pre-split only when everything lines up', () => {
  const ok = { Stems_Status: 'done', Stems_Vision_Path: '/b/MadMixer-Stems/X/', Stems_Manifest: JSON.stringify({ stems: [{ name: 'vocals', label: 'Vocals', core: true }, { name: 'kick', core: false }, { name: 'piano', core: true, empty: true }] }) };
  it('keeps real stems, drops empty ones', () => {
    expect(storedStems(ok)).toEqual({ folder: '/b/MadMixer-Stems/X/', stems: [{ name: 'vocals', label: 'Vocals', core: true }, { name: 'kick', label: 'kick', core: false }] });
  });
  it.each([
    ['test status', { ...ok, Stems_Status: 'test' }],
    ['blank status', { ...ok, Stems_Status: '' }],
    ['processing', { ...ok, Stems_Status: 'processing' }],
    ['no folder', { ...ok, Stems_Vision_Path: '' }],
    ['climbing path', { ...ok, Stems_Vision_Path: '/b/../secret/' }],
    ['broken manifest', { ...ok, Stems_Manifest: '{' }],
    ['no main stems', { ...ok, Stems_Manifest: JSON.stringify({ stems: [{ name: 'kick', core: false }] }) }],
    ['bad stem name', { ...ok, Stems_Manifest: JSON.stringify({ stems: [{ name: '../x', core: true }] }) }],
  ])('%s → not pre-split', (_n, f) => { expect(storedStems(f)).toBeNull(); });
});
