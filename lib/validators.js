/**
 * lib/validators.js — Input validation utilities.
 * No dependencies on other app modules.
 */

// ── validators object ───────────────────────────────────────────────────────
export const validators = {
  searchQuery: (value) => {
    if (typeof value !== 'string') return { valid: false, error: 'Must be string' };
    const trimmed = value.trim();
    if (trimmed.length > 200) return { valid: false, error: 'Too long (max 200 chars)' };
    if (/(?:^[=!<>])|(?:={2})|(?:[<>]=)|(?:<>)/.test(trimmed)) {
      return { valid: false, error: 'Invalid characters in search query' };
    }
    return { valid: true, value: trimmed };
  },
  playlistName: (value) => {
    if (typeof value !== 'string') return { valid: false, error: 'Must be string' };
    const trimmed = value.trim();
    if (trimmed.length < 1) return { valid: false, error: 'Playlist name required' };
    if (trimmed.length > 100) return { valid: false, error: 'Too long (max 100 chars)' };
    if (trimmed.includes('<') || trimmed.includes('>')) {
      return { valid: false, error: 'HTML tags not allowed' };
    }
    return { valid: true, value: trimmed };
  },
  recordId: (value) => {
    const str = String(value).trim();
    if (!/^\d+$/.test(str)) {
      return { valid: false, error: 'Record ID must be numeric' };
    }
    if (str.length > 20) {
      return { valid: false, error: 'Record ID too long' };
    }
    return { valid: true, value: str };
  },
  limit: (value, max = 1000) => {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num < 1) return { valid: false, error: 'Limit must be positive integer' };
    if (num > max) return { valid: false, error: `Limit exceeds maximum (${max})` };
    return { valid: true, value: num };
  },
  offset: (value) => {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num < 0) return { valid: false, error: 'Offset must be non-negative integer' };
    if (num > 1000000) return { valid: false, error: 'Offset too large' };
    return { valid: true, value: num };
  },
  url: (value) => {
    if (typeof value !== 'string') return { valid: false, error: 'URL must be string' };
    const trimmed = value.trim();
    if (trimmed.includes('..') || trimmed.includes('\\')) {
      return { valid: false, error: 'Invalid URL path' };
    }
    if (trimmed.length > 2000) {
      return { valid: false, error: 'URL too long' };
    }
    return { valid: true, value: trimmed };
  }
};

// ── Standalone validation helpers ───────────────────────────────────────────

export function validateQueryString(value, fieldName, maxLength = 200) {
  if (value === null || value === undefined) {
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') {
    return { ok: false, reason: `${fieldName} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return { ok: false, reason: `${fieldName} too long (max ${maxLength} characters)` };
  }
  return { ok: true, value: trimmed };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const validateSessionId = (sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') return null;
  if (!UUID_REGEX.test(sessionId)) return null;
  return sessionId;
};
