import { describe, it, expect } from 'vitest';
import { validators, validateQueryString, validateSessionId } from '../../lib/validators.js';

describe('validators.searchQuery', () => {
  it('accepts a normal string', () => {
    expect(validators.searchQuery('hello world')).toEqual({ valid: true, value: 'hello world' });
  });
  it('rejects non-strings', () => {
    expect(validators.searchQuery(123).valid).toBe(false);
  });
  it('rejects >200 chars', () => {
    expect(validators.searchQuery('a'.repeat(201)).valid).toBe(false);
  });
  it('rejects FM-operator-looking input', () => {
    expect(validators.searchQuery('==foo').valid).toBe(false);
    expect(validators.searchQuery('!bar').valid).toBe(false);
    expect(validators.searchQuery('<>baz').valid).toBe(false);
  });
});

describe('validators.recordId', () => {
  it('accepts numeric', () => {
    expect(validators.recordId('1234')).toEqual({ valid: true, value: '1234' });
  });
  it('rejects non-numeric', () => {
    expect(validators.recordId('abc').valid).toBe(false);
    expect(validators.recordId('1a').valid).toBe(false);
  });
  it('rejects >20 chars', () => {
    expect(validators.recordId('1'.repeat(21)).valid).toBe(false);
  });
});

describe('validators.limit', () => {
  it('accepts positive int', () => {
    expect(validators.limit('10')).toEqual({ valid: true, value: 10 });
  });
  it('rejects zero/negative', () => {
    expect(validators.limit('0').valid).toBe(false);
    expect(validators.limit('-1').valid).toBe(false);
  });
  it('honours custom max', () => {
    expect(validators.limit('500', 100).valid).toBe(false);
  });
});

describe('validators.url', () => {
  it('rejects traversal', () => {
    expect(validators.url('http://x/../etc').valid).toBe(false);
    expect(validators.url('a\\b').valid).toBe(false);
  });
});

describe('validateQueryString', () => {
  it('treats null/undefined as empty', () => {
    expect(validateQueryString(undefined, 'q')).toEqual({ ok: true, value: '' });
    expect(validateQueryString(null, 'q')).toEqual({ ok: true, value: '' });
  });
  it('rejects non-strings', () => {
    expect(validateQueryString(123, 'q').ok).toBe(false);
  });
  it('enforces maxLength', () => {
    expect(validateQueryString('a'.repeat(201), 'q').ok).toBe(false);
  });
});

describe('validateSessionId', () => {
  it('accepts canonical lowercase UUID v4', () => {
    expect(validateSessionId('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000');
  });
  it('rejects empty / bad shape', () => {
    expect(validateSessionId('')).toBeNull();
    expect(validateSessionId('not-a-uuid')).toBeNull();
    expect(validateSessionId(null)).toBeNull();
  });
  // Characterises a known bug: regex character class is [0-9a-f] (lowercase)
  // even with the /i flag the class isn't expanded, so uppercase UUIDs fail.
  // The /i flag normally would help — but only for letters outside the class.
  // Phase 2 will fix this; this test pins current behaviour.
  it('current behaviour: accepts uppercase via /i flag', () => {
    // /i makes the [0-9a-f] match [0-9A-Fa-f] for letters — this is a JS quirk
    expect(validateSessionId('123E4567-E89B-12D3-A456-426614174000')).toBe('123E4567-E89B-12D3-A456-426614174000');
  });
});
