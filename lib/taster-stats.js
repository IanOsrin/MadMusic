/**
 * lib/taster-stats.js — cookie-free funnel counters for taster landings
 * (/?t=… links under YouTube videos and shares).
 *
 * Aggregates only — no visitor identifiers, no IPs, no cookies. The file holds
 * daily counts per campaign: how many landed, how many pressed play, how many
 * started a trial, plus per-track land/play tallies so we can see which songs
 * convert. Umami carries the same events client-side; this file is the
 * ad-blocker-proof backstop for the numbers that matter.
 *
 * Shape of data/taster-stats.json:
 * {
 *   "2026-08-09": {
 *     "tasters": {
 *       "land": 12, "landMobile": 9, "play": 7, "trial": 1,
 *       "tracks": { "94600": { "land": 5, "play": 3 } }
 *     }
 *   }
 * }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, releaseLock } from './file-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATS_PATH = path.join(DATA_DIR, 'taster-stats.json');

const KINDS = new Set(['land', 'play', 'trial']);
const MAX_TRACKS_PER_DAY = 500; // runaway/abuse cap — aggregate stays bounded

function today() {
  return new Date().toISOString().slice(0, 10);
}

function cleanCampaign(raw) {
  const c = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return c || 'share';
}

function cleanTrack(raw) {
  const t = String(raw || '').trim();
  return /^\d{1,10}$/.test(t) ? t : null;
}

/**
 * Count one funnel event. Never throws — a stats failure must never affect
 * the request that reported it.
 * @param {object} ev { kind: 'land'|'play'|'trial', campaign?, track?, mobile? }
 */
export async function bumpTaster(ev) {
  if (process.env.NODE_ENV === 'test') return false; // suite runs must not pollute the aggregate
  const kind = String(ev?.kind || '');
  if (!KINDS.has(kind)) return false;
  const campaign = cleanCampaign(ev?.campaign);
  const track = cleanTrack(ev?.track);
  const mobile = !!ev?.mobile;

  let lockPath;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    lockPath = await acquireLock(STATS_PATH);
    let data = {};
    try { data = JSON.parse(await fs.readFile(STATS_PATH, 'utf8')); } catch {}
    if (!data || typeof data !== 'object') data = {};
    const day = (data[today()] ||= {});
    const bucket = (day[campaign] ||= {});
    bucket[kind] = (bucket[kind] || 0) + 1;
    if (kind === 'land' && mobile) bucket.landMobile = (bucket.landMobile || 0) + 1;
    if (track && kind !== 'trial') {
      const tracks = (bucket.tracks ||= {});
      if (tracks[track] || Object.keys(tracks).length < MAX_TRACKS_PER_DAY) {
        const tr = (tracks[track] ||= {});
        tr[kind] = (tr[kind] || 0) + 1;
      }
    }
    const tmp = STATS_PATH + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8');
    await fs.rename(tmp, STATS_PATH);
    return true;
  } catch (err) {
    console.warn('[taster] stats bump failed:', err?.message || err);
    return false;
  } finally {
    if (lockPath) await releaseLock(lockPath).catch(() => {});
  }
}

/** Read the aggregate (for the report endpoint/script). */
export async function readTasterStats() {
  try { return JSON.parse(await fs.readFile(STATS_PATH, 'utf8')); } catch { return {}; }
}
