/**
 * lib/crypto-utils.js — Small crypto helpers used across the codebase.
 *
 * The headline export is timingSafeEqualStr, which compares two strings (or a
 * string and a Buffer) without leaking length-equal comparisons through the
 * timing channel. Use this for: webhook signatures, OTP codes, admin secrets,
 * any other value an attacker might try to guess byte-by-byte by measuring
 * server response time.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of two values. Returns false if either side is
 * missing/non-stringy or if the lengths differ. Lengths are compared first
 * (cheap) so we never call timingSafeEqual with mismatched buffers (which
 * itself would throw and leak length info).
 *
 * Accepts string or Buffer on either side. Strings are encoded as UTF-8.
 */
export function timingSafeEqualStr(a, b) {
  const bufA = toBuffer(a);
  const bufB = toBuffer(b);
  if (!bufA || !bufB) return false;
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function toBuffer(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return null;
}
