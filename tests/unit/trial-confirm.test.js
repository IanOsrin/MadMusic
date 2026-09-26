import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// confirmTrialToken (2026-09-26, "straight on, confirm later"): the email's Confirm link
// turns a 1-day trial into the full trial — before first use by changing the duration only,
// after first use by also moving the stamped Expiration_Date out by the extra days.

const fm = { record: null, updates: [] };
vi.mock('../../fm-client.js', () => ({
  fmCreateRecord: vi.fn(async () => ({})),
  fmFindRecords: vi.fn(async () => ({ ok: true, data: fm.record ? [fm.record] : [] })),
  fmUpdateRecord: vi.fn(async (_layout, recordId, fields) => { fm.updates.push({ recordId, fields }); }),
}));

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-trial-confirm-'));
const { confirmTrialToken } = await import('../../lib/token-store.js');

const trial = (extra = {}) => ({
  recordId: '42',
  fieldData: { Token_Code: 'MASS-AAA-BBB', Token_Type: 'trial', Active: 1, Token_Duration_Hours: '86400', Notes: 'trial', ...extra },
});

beforeEach(() => { fm.record = null; fm.updates = []; });

describe('confirmTrialToken', () => {
  it('before first use: only the duration grows to 7 days', async () => {
    fm.record = trial();
    expect(await confirmTrialToken('MASS-AAA-BBB', 7)).toEqual({ ok: true });
    expect(fm.updates).toHaveLength(1);
    expect(fm.updates[0].fields.Token_Duration_Hours).toBe(String(7 * 86400));
    expect(fm.updates[0].fields.Expiration_Date).toBeUndefined();
  });

  it('after first use: the stamped expiry moves out by 6 days', async () => {
    fm.record = trial({ First_Used: '9/26/2026 10:00:00', Expiration_Date: '9/27/2026 10:00:00' });
    await confirmTrialToken('MASS-AAA-BBB', 7);
    expect(fm.updates[0].fields.Expiration_Date).toBe('10/3/2026 10:00:00');
  });

  it('a second click changes nothing', async () => {
    fm.record = trial({ Token_Duration_Hours: String(7 * 86400) });
    expect(await confirmTrialToken('MASS-AAA-BBB', 7)).toEqual({ ok: true, alreadyConfirmed: true });
    expect(fm.updates).toHaveLength(0);
  });

  it('refuses paid codes and cancelled trials', async () => {
    fm.record = trial({ Token_Type: 'valid' });
    expect((await confirmTrialToken('MASS-AAA-BBB', 7)).ok).toBe(false);
    fm.record = trial({ Active: 0 });
    expect((await confirmTrialToken('MASS-AAA-BBB', 7)).ok).toBe(false);
    expect(fm.updates).toHaveLength(0);
  });
});
