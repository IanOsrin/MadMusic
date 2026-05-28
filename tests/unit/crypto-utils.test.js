import { describe, it, expect } from 'vitest';
import { timingSafeEqualStr } from '../../lib/crypto-utils.js';

describe('timingSafeEqualStr', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
  });
  it('returns false for different strings', () => {
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
  });
  it('returns false on length mismatch (does not throw)', () => {
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', 'a')).toBe(false);
  });
  it('returns false for null/undefined inputs', () => {
    expect(timingSafeEqualStr(null, 'abc')).toBe(false);
    expect(timingSafeEqualStr('abc', null)).toBe(false);
    expect(timingSafeEqualStr(undefined, undefined)).toBe(false);
  });
  it('returns false for non-string/buffer types', () => {
    expect(timingSafeEqualStr(123, 123)).toBe(false);
    expect(timingSafeEqualStr({}, {})).toBe(false);
  });
  it('accepts Buffer on either side', () => {
    expect(timingSafeEqualStr(Buffer.from('abc'), 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', Buffer.from('abc'))).toBe(true);
    expect(timingSafeEqualStr(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
  });
  it('handles unicode safely (utf-8)', () => {
    expect(timingSafeEqualStr('café', 'café')).toBe(true);
    expect(timingSafeEqualStr('café', 'cafe')).toBe(false);
  });
});
