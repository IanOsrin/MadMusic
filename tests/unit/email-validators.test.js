import { describe, it, expect } from 'vitest';
import { isPlausibleEmail, isStrictEmail } from '../../lib/validators.js';

const GOOD = [
  'a@b.co',
  'user@example.com',
  'first.last@example.co.uk',
  'user+tag@example.com',
  'user_name@example.com',
  'x123@subdomain.example.org',
  "o'brien@example.com",
];

const STRICT_OK_LENIENT_OK = [...GOOD];

// Strings that pass plausible but should fail strict.
const PLAUSIBLE_NOT_STRICT = [
  'user@example.123',        // strict requires alpha-only TLD; lenient allows numeric
];

const BAD_BOTH = [
  '',
  '   ',
  'noatsymbol',
  '@nolocal.com',
  'user@',
  'user @example.com',       // space in local
  'user@exa mple.com',       // space in domain
  'a@b',                     // no dot at all
  'user@host',               // no TLD
  'a@b.c',                   // TLD < 2 chars
  'a'.repeat(255) + '@x.co', // too long
  'ab@c.de'.slice(0, 5),     // too short ("ab@c.")
  null,
  undefined,
  123,
  {},
];

describe('isPlausibleEmail (lenient)', () => {
  for (const e of [...GOOD, ...PLAUSIBLE_NOT_STRICT]) {
    it(`accepts ${JSON.stringify(e)}`, () => {
      expect(isPlausibleEmail(e)).toBe(true);
    });
  }
  for (const e of BAD_BOTH) {
    it(`rejects ${JSON.stringify(e)}`, () => {
      expect(isPlausibleEmail(e)).toBe(false);
    });
  }
});

describe('isStrictEmail (tight)', () => {
  for (const e of STRICT_OK_LENIENT_OK) {
    it(`accepts ${JSON.stringify(e)}`, () => {
      expect(isStrictEmail(e)).toBe(true);
    });
  }
  for (const e of [...PLAUSIBLE_NOT_STRICT, ...BAD_BOTH]) {
    it(`rejects ${JSON.stringify(e)}`, () => {
      expect(isStrictEmail(e)).toBe(false);
    });
  }
  it('trims surrounding whitespace before validating', () => {
    expect(isStrictEmail('  user@example.com  ')).toBe(true);
  });
});
