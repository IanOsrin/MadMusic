import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Timed comments (2026-10-12): everyone reads, subscribers write under a display name, the word filter
// blocks, 3 reports hide, reactions toggle, a listener can only delete their own. The Postgres store is
// replaced by an in-memory one with the same contract (lib/comments-store.js).

vi.mock('../../lib/auth.js', async (importOriginal) => {
  const mod = await importOriginal();
  const people = { 'MASS-AAA-001': 'ann@example.com', 'MASS-BBB-002': 'Ben@Example.com', 'MASS-CCC-003': 'cat@example.com', 'MASS-DDD-004': 'dan@example.com' };
  const fake = async (code) => {
    const c = String(code || '').trim().toUpperCase();
    if (c === 'MASS-NOE-005') return { valid: true, type: 'valid', email: null, recordId: '5' };
    if (people[c]) return { valid: true, type: 'valid', email: people[c], recordId: '1' };
    return { valid: false, definitive: true, reason: 'Invalid token' };
  };
  return { ...mod, validateAccessToken: fake };
});

const db = { authors: new Map(), comments: [], reports: new Set(), reactions: new Set(), seq: 0 };
vi.mock('../../lib/comments-store.js', () => ({
  REPORTS_TO_HIDE: 3,
  REACTIONS: ['fire', 'clap', 'tear'],
  commentsAvailable: () => true,
  trackComments: async (trackId) => {
    const reactions = { fire: 0, clap: 0, tear: 0 };
    for (const k of db.reactions) { const [t, , e] = k.split('|'); if (t === trackId) reactions[e]++; }
    return {
      comments: db.comments.filter((c) => c.trackId === trackId && c.status === 'visible').sort((a, b) => a.atMs - b.atMs)
        .map((c) => ({ id: c.id, atMs: c.atMs, body: c.body, name: db.authors.get(c.email).name, author: c.email, createdAt: c.createdAt })),
      reactions,
    };
  },
  myReactions: async (trackId, email) => [...db.reactions].filter((k) => k.startsWith(`${trackId}|${email}|`)).map((k) => k.split('|')[2]),
  getAuthor: async (email) => db.authors.get(email) || null,
  setDisplayName: async (email, name) => {
    for (const [e, a] of db.authors) if (e !== email && a.name.toLowerCase() === name.toLowerCase()) return { ok: false, taken: true };
    db.authors.set(email, { name, banned: db.authors.get(email)?.banned || false });
    return { ok: true };
  },
  recentCount: async (email) => db.comments.filter((c) => c.email === email).length,
  addComment: async ({ trackId, atMs, body, email }) => {
    const c = { id: String(++db.seq), trackId, atMs, body, email, status: 'visible', reports: 0, createdAt: new Date().toISOString() };
    db.comments.push(c);
    return { id: c.id, at_ms: atMs, body, created_at: c.createdAt };
  },
  reportComment: async (id, email) => {
    const c = db.comments.find((x) => x.id === id && x.status !== 'deleted');
    if (!c) return null;
    if (c.email === email || db.reports.has(`${id}|${email}`)) return { trackId: c.trackId, hidden: false };
    db.reports.add(`${id}|${email}`);
    c.reports++;
    if (c.status === 'visible' && c.reports >= 3) c.status = 'hidden';
    return { trackId: c.trackId, hidden: c.status === 'hidden' };
  },
  deleteOwnComment: async (id, email) => {
    const c = db.comments.find((x) => x.id === id && x.email === email && x.status !== 'deleted');
    if (!c) return null;
    c.status = 'deleted';
    return c.trackId;
  },
  toggleReaction: async (trackId, email, emoji) => {
    const k = `${trackId}|${email}|${emoji}`;
    if (db.reactions.has(k)) { db.reactions.delete(k); return false; }
    db.reactions.add(k); return true;
  },
}));

let app;
beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-comments-'));
  ({ app } = await import('../../server.js'));
});
beforeEach(() => { delete process.env.COMMENTS_ENABLED; });

const T = '12345';
const as = (code) => (r) => r.set('X-Access-Token', code);
const named = async (code, name) => as(code)(request(app).post('/api/comments/me')).send({ name });

describe('timed comments', () => {
  it('guests can read a song’s comments without a code', async () => {
    const res = await request(app).get(`/api/track-comments/${T}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, comments: [], reactions: { fire: 0, clap: 0, tear: 0 }, signedIn: false, me: null });
  });

  it('guests cannot post', async () => {
    const res = await request(app).post(`/api/comments/${T}`).send({ atMs: 1000, body: 'hello' });
    expect(res.status).toBe(403);
    expect(res.body.requiresAccessToken).toBe(true);
  });

  it('a code without an email cannot post (comments belong to the email, like playlists)', async () => {
    const res = await as('MASS-NOE-005')(request(app).post(`/api/comments/${T}`)).send({ atMs: 1000, body: 'hello' });
    expect(res.status).toBe(403);
    expect(res.body.requiresEmail).toBe(true);
  });

  it('asks for a display name first, then posts and shows it — "mine" only to the author', async () => {
    let res = await as('MASS-AAA-001')(request(app).post(`/api/comments/${T}`)).send({ atMs: 61_500, body: 'This was at every wedding in 86' });
    expect(res.status).toBe(409);
    expect(res.body.needsName).toBe(true);
    expect((await named('MASS-AAA-001', 'Ann M')).body).toMatchObject({ ok: true, name: 'Ann M' });
    res = await as('MASS-AAA-001')(request(app).post(`/api/comments/${T}`)).send({ atMs: 61_500, body: '  This was at   every wedding in 86 ' });
    expect(res.status).toBe(200);
    expect(res.body.comment).toMatchObject({ atMs: 61_500, body: 'This was at every wedding in 86', name: 'Ann M', mine: true });
    const pub = await request(app).get(`/api/track-comments/${T}`);
    expect(pub.body.comments).toHaveLength(1);
    expect(pub.body.comments[0]).toMatchObject({ name: 'Ann M', mine: false });
    expect(JSON.stringify(pub.body)).not.toMatch(/ann@example\.com/);          // emails never leave the server
    const own = await as('MASS-AAA-001')(request(app).get(`/api/track-comments/${T}`));
    expect(own.body.comments[0].mine).toBe(true);
    expect(own.body.me).toEqual({ name: 'Ann M' });
  });

  it('display names are unique regardless of case, and filtered', async () => {
    expect((await named('MASS-BBB-002', 'ann m')).status).toBe(409);
    expect((await named('MASS-BBB-002', 'x')).status).toBe(400);
    expect((await named('MASS-BBB-002', 'fuckboy')).status).toBe(400);
    expect((await named('MASS-BBB-002', 'Ben')).status).toBe(200);
  });

  it('the word filter blocks slurs, profanity and links', async () => {
    for (const body of ['what the fuuuck', 'sh1t song', 'go to www.spam.com']) {
      const res = await as('MASS-BBB-002')(request(app).post(`/api/comments/${T}`)).send({ atMs: 5000, body });
      expect(res.status).toBe(400);
      expect(res.body.filtered).toBe(true);
    }
  });

  it('three different listeners reporting a comment hide it; reporting twice or your own does not count', async () => {
    await named('MASS-CCC-003', 'Cat'); await named('MASS-DDD-004', 'Dan');
    const id = (await as('MASS-BBB-002')(request(app).post(`/api/comments/${T}`)).send({ atMs: 9000, body: 'meh' })).body.comment.id;
    const report = (code) => as(code)(request(app).post(`/api/comments/c/${id}/report`));
    expect((await report('MASS-BBB-002')).status).toBe(200);             // own: ignored
    await report('MASS-AAA-001'); await report('MASS-AAA-001');            // twice: counts once
    await report('MASS-CCC-003');
    let pub = await request(app).get(`/api/track-comments/${T}`);
    expect(pub.body.comments.map((c) => c.id)).toContain(id);
    await report('MASS-DDD-004');                                          // third listener
    pub = await request(app).get(`/api/track-comments/${T}`);
    expect(pub.body.comments.map((c) => c.id)).not.toContain(id);
  });

  it('reactions toggle and are counted per song', async () => {
    const react = (code, emoji) => as(code)(request(app).post(`/api/comments/${T}/react`)).send({ emoji });
    expect((await react('MASS-AAA-001', 'fire')).body).toMatchObject({ on: true, reactions: { fire: 1 } });
    expect((await react('MASS-CCC-003', 'fire')).body.reactions.fire).toBe(2);
    expect((await react('MASS-AAA-001', 'fire')).body).toMatchObject({ on: false, reactions: { fire: 1 } });
    expect((await react('MASS-AAA-001', 'skull')).status).toBe(400);
    const mine = await as('MASS-CCC-003')(request(app).get(`/api/track-comments/${T}`));
    expect(mine.body.myReactions).toEqual(['fire']);
  });

  it('a listener can delete only their own comment', async () => {
    const id = (await as('MASS-CCC-003')(request(app).post(`/api/comments/${T}`)).send({ atMs: 2000, body: 'lovely' })).body.comment.id;
    expect((await as('MASS-DDD-004')(request(app).delete(`/api/comments/c/${id}`))).status).toBe(404);
    expect((await as('MASS-CCC-003')(request(app).delete(`/api/comments/c/${id}`))).status).toBe(200);
    const pub = await request(app).get(`/api/track-comments/${T}`);
    expect(pub.body.comments.map((c) => c.id)).not.toContain(id);
  });

  it('rejects bad moments and bad track ids', async () => {
    expect((await as('MASS-CCC-003')(request(app).post(`/api/comments/${T}`)).send({ atMs: -5, body: 'x y' })).status).toBe(400);
    expect((await request(app).get('/api/track-comments/abc')).status).toBe(400);
  });

  it('COMMENTS_ENABLED=false switches it all off', async () => {
    process.env.COMMENTS_ENABLED = 'false';
    expect((await request(app).get(`/api/track-comments/${T}`)).status).toBe(404);
    expect((await as('MASS-AAA-001')(request(app).post(`/api/comments/${T}`)).send({ atMs: 1, body: 'hi there' })).status).toBe(404);
  });
});
