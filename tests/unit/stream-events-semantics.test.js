// Stream-events audit guards (2026-07-07). These encode the F2/F3/F4 fixes:
// pause must not fragment a listen into multiple records, preview plays must
// be distinguishable, and only ONE desktop sender may emit terminal events.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STREAM_TERMINAL_EVENTS, STREAM_EVENT_TYPES } from '../../lib/stream-events.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

describe('terminal event semantics (F2)', () => {
  it('STOPPED is NOT terminal — the desktop client fires it on every pause', () => {
    // Regression: STOPPED-as-terminal split one listen into a new FM record
    // per pause/resume cycle, inflating play counts.
    expect(STREAM_TERMINAL_EVENTS.has('STOPPED')).toBe(false);
    expect(STREAM_TERMINAL_EVENTS.has('END')).toBe(true);
    expect(STREAM_TERMINAL_EVENTS.has('ERROR')).toBe(true);
  });

  it('STOPPED remains an accepted event type', () => {
    expect(STREAM_EVENT_TYPES.has('STOPPED')).toBe(true);
  });
});

describe('single desktop terminal sender (F4)', () => {
  it("player.js playSong no longer sends its own END on track switch", () => {
    const playerJs = read('public', 'js', 'player.js');
    const playSong = playerJs.slice(playerJs.indexOf('function playSong'), playerJs.indexOf('function togglePause'));
    expect(playSong).not.toMatch(/sendStreamEvent\('END'\)/);
  });
});

describe('PlaybackMode flag (F3)', () => {
  it('all three client senders declare playbackMode from window.__GUEST', () => {
    for (const file of [
      ['public', 'app.min.js'],
      ['public', 'js', 'player.js'],
      ['public', 'js', 'mobile', 'player.js']
    ]) {
      const src = read(...file);
      expect(src, file.join('/')).toMatch(/playbackMode: window\.__GUEST \? 'PREVIEW' : 'FULL'/);
    }
  });

  it('the server sanitizes playbackMode and writes the PlaybackMode field', () => {
    const accessJs = read('routes', 'access.js');
    // Unknown values must default to FULL (previews can only be UNDER-counted).
    expect(accessJs).toMatch(/=== 'PREVIEW' \? 'PREVIEW' : 'FULL'/);
    expect((accessJs.match(/PlaybackMode: playbackMode/g) || []).length).toBeGreaterThanOrEqual(2); // create + update paths
  });
});

describe('public-endpoint input validation (F7)', () => {
  it('trackRecordId must validate as a numeric FM record id', () => {
    const accessJs = read('routes', 'access.js');
    expect(accessJs).toMatch(/validators\.recordId\(normalizedTrackRecordId\)/);
  });
});

describe('accumulator shadows delta baselines (F8)', () => {
  it('the in-process accumulator stores position + lastEventUTC, not just the total', () => {
    // Shadowing only TotalPlayedSec double-counted play time: cache-hit events
    // derived deltas against zero baselines, so deltaSec:0 clients (mobile)
    // were credited their full absolute position on every event.
    const accessJs = read('routes', 'access.js');
    expect(accessJs).toMatch(/streamTotalMap\.set\(streamKey, \{/);
    expect(accessJs).toMatch(/lastEventUTC: baseFields\.LastEventUTC/);
    expect(accessJs).toMatch(/existingFields\[STREAM_TIME_FIELD\] = cached\.position/);
  });
});

describe('attribution fallback (F5)', () => {
  it('tryEnrichToken falls back to the local token store on cache miss', () => {
    const accessJs = read('routes', 'access.js');
    const fn = accessJs.slice(accessJs.indexOf('function tryEnrichToken'), accessJs.indexOf('async function resolveTerminalRecord'));
    expect(fn).toMatch(/getAccessTokensCacheData/);
  });
});

describe('attribution survives a restart (2026-09-29)', () => {
  // After a deploy the validation cache is empty AND the JSON token store is wiped, so the two
  // in-memory lookups both missed and subscribers' listens were saved with no code and no email.
  it('stream-events falls back to a read-only FileMaker code → email lookup', () => {
    const accessJs = read('routes', 'access.js');
    const route = accessJs.slice(accessJs.indexOf("router.post('/stream-events'"));
    expect(route.indexOf('tryEnrichToken(req)')).toBeGreaterThan(-1);
    expect(route.indexOf('await enrichTokenFromFileMaker(req)')).toBeGreaterThan(route.indexOf('tryEnrichToken(req)'));
    const fn = accessJs.slice(accessJs.indexOf('function lookupTokenAttribution'), accessJs.indexOf('async function enrichTokenFromFileMaker'));
    expect(fn).toMatch(/fmFindRecords\(/);
    expect(fn).not.toMatch(/fmUpdateRecord|validateAccessToken/);   // attribution only — never a write
  });
  it('the wait is bounded so a listen is never held up', () => {
    const accessJs = read('routes', 'access.js');
    expect(accessJs).toMatch(/async function enrichTokenFromFileMaker\(req, waitMs = 1500\)/);
    expect(accessJs).toMatch(/Promise\.race\(\[lookupTokenAttribution\(raw\)/);
  });
});
