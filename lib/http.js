/**
 * lib/http.js — HTTP / request utilities.
 * No dependencies on other app modules.
 */

import { createHash } from 'node:crypto';
import { normalizeShareId } from './format.js';

// Module-level map: shared across all calls so concurrent requests for the
// same key actually share one in-flight promise.
const _pendingRequests = new Map();

export async function deduplicatedFetch(cacheKey, cache, fetchFn) {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (_pendingRequests.has(cacheKey)) {
    return _pendingRequests.get(cacheKey);
  }
  const promise = fetchFn().finally(() => {
    _pendingRequests.delete(cacheKey);
  });
  _pendingRequests.set(cacheKey, promise);
  return promise;
}

export function generateETag(data) {
  const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return `"${hash.slice(0, 16)}"`;
}

export function sendWithETag(res, data) {
  const etag = generateETag(data);
  res.setHeader('ETag', etag);
  const clientETag = res.req.headers['if-none-match'];
  if (clientETag === etag) {
    return res.status(304).end();
  }
  return res.json(data);
}

export function getClientIP(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length) {
    const first = forwarded[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
  }
  if (typeof req?.ip === 'string' && req.ip) return req.ip;
  const remoteAddress = req?.socket?.remoteAddress;
  if (typeof remoteAddress === 'string' && remoteAddress) return remoteAddress;
  return '';
}

export function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  const out = {};
  for (const piece of header.split(';')) {
    const part = piece.trim();
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    out[key] = decodeURIComponent(value);
  }
  return out;
}

export const resolveRequestOrigin = (req) => {
  const originHeader = req.get('origin');
  if (originHeader) return originHeader;
  const forwardedProto = req.get('x-forwarded-proto');
  const forwardedHost  = req.get('x-forwarded-host');
  const host  = forwardedHost || req.get('host');
  const proto = forwardedProto || req.protocol;
  if (proto && host) return `${proto}://${host}`;
  if (host) return `http://${host}`;
  return '';
};

export const buildShareUrl = (req, shareId) => {
  const normalized = normalizeShareId(shareId);
  if (!normalized) return '';
  const origin = resolveRequestOrigin(req);
  const pathPart = `/?share=${encodeURIComponent(normalized)}`;
  return origin ? `${origin}${pathPart}` : pathPart;
};

// Exact-code overrides checked before range rules
const FM_EXACT_STATUS = new Map([
  [401, 404], [102, 400], [103, 400], [104, 400], [105, 400], [106, 400],
  [954, 503],  [958, 503]
]);

// Range rules applied in order after exact-code check
const FM_RANGE_STATUS = [
  { min: 500, max: 599,   status: 400 },
  { min: 800, max: 899,   status: 400 },
  { min: 10000, max: Infinity, status: 503 },
  { min: 200, max: 299,   status: 403 }
];

export function fmErrorToHttpStatus(fmCode, defaultStatus = 500) {
  const code = Number.parseInt(fmCode, 10);
  if (Number.isNaN(code)) return defaultStatus;
  if (FM_EXACT_STATUS.has(code)) return FM_EXACT_STATUS.get(code);
  for (const { min, max, status } of FM_RANGE_STATUS) {
    if (code >= min && code <= max) return status;
  }
  return 500;
}
