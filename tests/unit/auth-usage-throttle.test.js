import { describe, it, expect, beforeEach, vi } from 'vitest';

// validateAccessToken bumps Last_Used/Use_Count via a fire-and-forget FM PATCH on
// every successful validation. During a cold-start burst that doubled FM write
// pressure on the already-jammed queue. The write is now throttled per token,
// EXCEPT when a sessionId is present (device-conflict detection needs fresh
// Session_Last_Activity) or on first use (stamps Expiration_Date). These tests
// lock that behaviour in.

const fmFindRecords = vi.fn();
const fmUpdateRecord = vi.fn(async () => ({}));

vi.mock('../../fm-client.js', () => ({
  fmFindRecords: (...a) => fmFindRecords(...a),
  fmUpdateRecord: (...a) => fmUpdateRecord(...a)
}));

let validateAccessToken;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ validateAccessToken } = await import('../../lib/auth.js'));
});

function tokenRecord(recordId, overrides = {}) {
  return {
    ok: true,
    total: 1,
    data: [{ recordId, fieldData: { Token_Code: 'X', Active: 1, Token_Type: 'valid', First_Used: '01/01/2025 00:00:00', ...overrides } }]
  };
}

describe('usage-stat write throttle', () => {
  it('writes once, then throttles a repeat validation of the same token', async () => {
    fmFindRecords.mockResolvedValue(tokenRecord('rec-throttle-1'));

    await validateAccessToken('MASS-THR-001');     // first use already stamped → not first-use
    expect(fmUpdateRecord).toHaveBeenCalledTimes(1); // initial write

    await validateAccessToken('MASS-THR-001');     // within throttle window
    expect(fmUpdateRecord).toHaveBeenCalledTimes(1); // suppressed
  });

  it('always writes when a sessionId is supplied (session activity must stay fresh)', async () => {
    fmFindRecords.mockResolvedValue(tokenRecord('rec-throttle-2'));

    await validateAccessToken('MASS-THR-002', 'session-aaa');
    await validateAccessToken('MASS-THR-002', 'session-aaa');
    expect(fmUpdateRecord).toHaveBeenCalledTimes(2); // never throttled on the session path
  });

  it('writes on first use even without a session (stamps Expiration_Date)', async () => {
    // No First_Used → buildTokenUpdateFields sets it, so the write must not be skipped.
    fmFindRecords.mockResolvedValue(tokenRecord('rec-throttle-3', { First_Used: '' }));

    await validateAccessToken('MASS-THR-003');
    expect(fmUpdateRecord).toHaveBeenCalledTimes(1);
  });
});
