import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Saved-code check (2026-09-29): the phone app warns a listener that their saved code is bad
// ONLY when the server's "no" is definite. FileMaker answering with no such code is definite;
// FileMaker being unreachable is not — an outage must never tell a subscriber their code died.
const fm = { result: null, throws: false };
vi.mock('../../fm-client.js', () => ({
  fmCreateRecord: vi.fn(async () => ({})),
  fmUpdateRecord: vi.fn(async () => ({})),
  fmFindRecords: vi.fn(async () => { if (fm.throws) throw new Error('FM down'); return fm.result; }),
}));

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-token-definitive-'));
const { validateAccessToken } = await import('../../lib/auth.js');

beforeEach(() => { fm.result = null; fm.throws = false; });

describe('validateAccessToken — definite vs outage', () => {
  it('FileMaker found no such code → definite "Token not found"', async () => {
    fm.result = { ok: true, data: [], total: 0 };
    expect(await validateAccessToken('MASS-ZZZ-999')).toMatchObject({ valid: false, definitive: true, reason: 'Token not found' });
  });
  it("FileMaker's 401 (no records match) → definite too", async () => {
    fm.result = { ok: false, code: '401', data: [] };
    expect(await validateAccessToken('MASS-ZZZ-999')).toMatchObject({ valid: false, definitive: true });
  });
  it('FileMaker unreachable → NOT definite (no false "your code is bad")', async () => {
    fm.throws = true;
    const r = await validateAccessToken('MASS-ZZZ-999');
    expect(r.valid).toBe(false);
    expect(r.definitive).not.toBe(true);
  });
  it('FileMaker error response (not 401) → NOT definite', async () => {
    fm.result = { ok: false, code: '952', status: 401, data: [] };
    expect((await validateAccessToken('MASS-ZZZ-999')).definitive).not.toBe(true);
  });
});
