// Concurrent token sessions (2026-07-06): a token may be active on up to
// MAX_TOKEN_SESSIONS devices (default 3). Sessions live as JSON in the
// existing Current_Session_ID field; legacy single-UUID values migrate.
import { describe, it, expect } from 'vitest';
import { parseSessions, evaluateSessions, removeSession, serializeSessions, MAX_TOKEN_SESSIONS } from '../../lib/auth.js';

const NOW = 1_800_000_000_000;
const FRESH = NOW - 60 * 1000;          // 1 min ago
const STALE = NOW - 20 * 60 * 1000;     // 20 min ago (past the 15-min timeout)
const mk = (id, at, dev = 'desktop') => ({ id, at, dev });

describe('parseSessions', () => {
  it('parses the JSON list format', () => {
    const raw = JSON.stringify([mk('a', FRESH), mk('b', FRESH, 'mobile')]);
    expect(parseSessions(raw).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('migrates a legacy single-UUID value using Session_Last_Activity', () => {
    const list = parseSessions('legacy-session-uuid', '7/6/2026 18:00:00');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('legacy-session-uuid');
    expect(list[0].at).toBeGreaterThan(0);
  });

  it('returns empty for blank/garbage', () => {
    expect(parseSessions('')).toEqual([]);
    expect(parseSessions(null)).toEqual([]);
    expect(parseSessions('[not json')).toEqual([{ id: '[not json', at: 0, dev: 'unknown' }]); // treated as legacy id
  });
});

describe('evaluateSessions', () => {
  it('default cap is 3', () => {
    expect(MAX_TOKEN_SESSIONS).toBe(3);
  });

  it('first activation registers the session', () => {
    const r = evaluateSessions({ raw: '', sessionId: 's1', now: NOW, device: 'desktop' });
    expect(r.conflict).toBe(false);
    expect(r.sessions).toEqual([mk('s1', NOW)]);
  });

  it('a second and third device are allowed', () => {
    const raw = serializeSessions([mk('s1', FRESH), mk('s2', FRESH, 'mobile')]);
    const r = evaluateSessions({ raw, sessionId: 's3', now: NOW, device: 'tablet' });
    expect(r.conflict).toBe(false);
    expect(r.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('a fourth concurrent device is rejected', () => {
    const raw = serializeSessions([mk('s1', FRESH), mk('s2', FRESH), mk('s3', FRESH)]);
    const r = evaluateSessions({ raw, sessionId: 's4', now: NOW });
    expect(r.conflict).toBe(true);
    expect(r.activeCount).toBe(3);
  });

  it('an existing session re-validates without consuming a new slot', () => {
    const raw = serializeSessions([mk('s1', FRESH), mk('s2', FRESH), mk('s3', FRESH)]);
    const r = evaluateSessions({ raw, sessionId: 's2', now: NOW, device: 'mobile' });
    expect(r.conflict).toBe(false);
    expect(r.sessions).toHaveLength(3);
    expect(r.sessions.find((s) => s.id === 's2').at).toBe(NOW); // activity refreshed
  });

  it('stale sessions free their slots', () => {
    const raw = serializeSessions([mk('s1', STALE), mk('s2', STALE), mk('s3', FRESH)]);
    const r = evaluateSessions({ raw, sessionId: 's4', now: NOW });
    expect(r.conflict).toBe(false);
    expect(r.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
  });

  it('a legacy single active session leaves room for two more (the old hard block is gone)', () => {
    const r = evaluateSessions({ raw: 'legacy-uuid', legacyLastActivity: new Date(FRESH).toISOString(), sessionId: 'new-device', now: NOW });
    expect(r.conflict).toBe(false);
    expect(r.sessions.map((s) => s.id)).toEqual(['legacy-uuid', 'new-device']);
  });

  it('honours a custom max', () => {
    const raw = serializeSessions([mk('s1', FRESH)]);
    const r = evaluateSessions({ raw, sessionId: 's2', now: NOW, max: 1 });
    expect(r.conflict).toBe(true);
  });
});

describe('removeSession (logout)', () => {
  it('removes only the leaving device', () => {
    const raw = serializeSessions([mk('s1', FRESH), mk('s2', FRESH)]);
    expect(removeSession(raw, null, 's1').map((s) => s.id)).toEqual(['s2']);
  });

  it('serializes an empty list to an empty string (field cleared)', () => {
    expect(serializeSessions([])).toBe('');
  });
});
