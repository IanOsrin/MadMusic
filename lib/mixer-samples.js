/**
 * lib/mixer-samples.js — Mad Mixer's sample library for drum triggering (Ian, 2026-10-08): one-shot WAVs in a Vision
 * folder (MIXER_SAMPLES_VISION_PREFIX, default "/gallo-music-files-wavs/Samples/"), one sub-folder per kind
 * ("Kick/808 Deep.wav", "Snare/Tight.wav"). No database: dropping a WAV into the folder adds it (listed within
 * 5 minutes). Each sample gets a stable id (a hash of its path); the path never leaves MAD — the Mixer gets
 * signed links to GET /mixer-sample/:id (routes/mixer-hq-audio.js). Only WAVs up to 8 MB (one-shots, not songs).
 */
import crypto from 'node:crypto';
import { createSwrCache } from './swr-cache.js';
import { visionConfigured, visionListAll } from './vision-read.js';

export const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
export const samplesPrefix = () => {
  const p = String(process.env.MIXER_SAMPLES_VISION_PREFIX || '/gallo-music-files-wavs/Samples/').trim();
  return (p.startsWith('/') ? p : '/' + p).replace(/\/*$/, '/');
};
export const sampleId = (path) => crypto.createHash('sha1').update(path).digest('hex').slice(0, 16);

// [{ path, bytes }] → { kinds: [{ kind, samples: [{ id, name, bytes, path }] }] } — sorted, WAVs only, size-capped.
export function samplesFromListing(files, prefix = samplesPrefix()) {
  const byKind = new Map();
  for (const f of files || []) {
    if (!f.path.startsWith(prefix) || !/\.wav$/i.test(f.path) || !(f.bytes > 44) || f.bytes > MAX_SAMPLE_BYTES) continue;
    const rest = f.path.slice(prefix.length).split('/').filter(Boolean);
    if (rest.some((x) => x === '..' || x.startsWith('.'))) continue;
    const kind = rest.length > 1 ? rest[0] : 'Samples';
    const name = rest[rest.length - 1].replace(/\.wav$/i, '');
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push({ id: sampleId(f.path), name, bytes: f.bytes, path: f.path });
  }
  return { kinds: [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([kind, samples]) => ({ kind, samples: samples.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) })) };
}

const swr = createSwrCache({
  name: 'mixer-samples', label: 'mixer-samples', ttlMs: 5 * 60_000, max: 1,
  loader: async () => {
    if (!visionConfigured()) return { builtAt: new Date().toISOString(), kinds: [] };
    let files = [];
    try { files = await visionListAll(samplesPrefix()); }
    catch (err) { if (!/NoSuchKey|NotFound|no such/i.test(String(err?.name || err?.message))) throw err; }
    return { builtAt: new Date().toISOString(), ...samplesFromListing(files) };
  },
});
export const mixerSamples = async () => (await swr.get('all')).value;
export const sampleById = async (id) => {
  for (const k of (await mixerSamples()).kinds) { const s = k.samples.find((x) => x.id === id); if (s) return s; }
  return null;
};
