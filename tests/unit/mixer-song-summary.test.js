import { describe, it, expect } from 'vitest';
import { songSummary, bpmOf } from '../../lib/mixer-catalogue.js';

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
