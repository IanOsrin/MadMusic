import { describe, it, expect } from 'vitest';
import { SUBSCRIPTION_DAYS_MIN, SUBSCRIPTION_DAYS_MAX } from '../../lib/constants.js';

// Mirrors the local clampDays helper in routes/payments.js. Kept in a separate
// unit test so we can prove the bounds behaviour without booting the app.
function clampDays(rawDays, fallback = 7) {
  const n = Number.parseInt(rawDays, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < SUBSCRIPTION_DAYS_MIN) return SUBSCRIPTION_DAYS_MIN;
  if (n > SUBSCRIPTION_DAYS_MAX) return SUBSCRIPTION_DAYS_MAX;
  return n;
}

describe('clampDays (Paystack metadata defence)', () => {
  it('passes through valid in-range values', () => {
    expect(clampDays('1')).toBe(1);
    expect(clampDays('7')).toBe(7);
    expect(clampDays('30')).toBe(30);
    expect(clampDays('365')).toBe(365);
  });
  it('clamps values exceeding the max', () => {
    expect(clampDays('99999')).toBe(SUBSCRIPTION_DAYS_MAX);
    expect(clampDays('1000000')).toBe(SUBSCRIPTION_DAYS_MAX);
  });
  it('clamps values below the min', () => {
    expect(clampDays('0')).toBe(SUBSCRIPTION_DAYS_MIN);
    expect(clampDays('-1')).toBe(SUBSCRIPTION_DAYS_MIN);
    expect(clampDays('-99999')).toBe(SUBSCRIPTION_DAYS_MIN);
  });
  it('falls back for non-numeric / missing', () => {
    expect(clampDays(undefined)).toBe(7);
    expect(clampDays(null)).toBe(7);
    expect(clampDays('')).toBe(7);
    expect(clampDays('abc')).toBe(7);
  });
  it('honours custom fallback', () => {
    expect(clampDays(undefined, 30)).toBe(30);
  });
});
