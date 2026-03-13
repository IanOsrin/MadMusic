/**
 * lib/stream-events.js — Stream event constants and FileMaker record tracking.
 * Dependencies: fm-client.js, cache.js, lib/fm-fields.js
 */

import { fmFindRecords, fmCreateRecord } from '../fm-client.js';
import { streamRecordLRU } from '../cache.js';
import { FM_STREAM_EVENTS_LAYOUT } from './fm-fields.js';

// ── Constants ────────────────────────────────────────────────────────────────
export const STREAM_EVENT_DEBUG = (
  process.env.DEBUG_STREAM_EVENTS === 'true' ||
  process.env.NODE_ENV === 'development' ||
  process.env.DEBUG?.includes('stream')
);
export const STREAM_EVENT_TYPES     = new Set(['PLAY', 'PROGRESS', 'PAUSE', 'SEEK', 'END', 'ERROR']);
export const STREAM_TERMINAL_EVENTS = new Set(['END', 'ERROR']);
export const STREAM_TIME_FIELD      = 'TimeStreamed';
export const STREAM_TIME_FIELD_LEGACY = 'PositionSec';

// ── Cache helpers ─────────────────────────────────────────────────────────────

export function streamRecordCacheKey(sessionId, trackRecordId) {
  return `${sessionId}::${trackRecordId}`;
}

export function getCachedStreamRecordId(sessionId, trackRecordId) {
  const key = streamRecordCacheKey(sessionId, trackRecordId);
  return streamRecordLRU.get(key) || null;
}

export function setCachedStreamRecordId(sessionId, trackRecordId, recordId) {
  if (!sessionId || !trackRecordId || !recordId) return;
  const key = streamRecordCacheKey(sessionId, trackRecordId);
  streamRecordLRU.set(key, recordId);
}

export function clearCachedStreamRecordId(sessionId, trackRecordId) {
  if (!sessionId || !trackRecordId) return;
  const key = streamRecordCacheKey(sessionId, trackRecordId);
  streamRecordLRU.delete(key);
}

// ── FM record helpers ─────────────────────────────────────────────────────────

export async function findStreamRecord(sessionId, trackRecordId) {
  if (!sessionId || !trackRecordId) return null;
  const query = [{ SessionID: `==${sessionId}`, TrackRecordID: `==${trackRecordId}` }];
  const sort  = [
    { fieldName: 'LastEventUTC',  sortOrder: 'descend' },
    { fieldName: 'TimestampUTC',  sortOrder: 'descend' }
  ];
  let result = await fmFindRecords(FM_STREAM_EVENTS_LAYOUT, query, { limit: 1, offset: 1, sort });
  if (!result.ok) {
    result = await fmFindRecords(FM_STREAM_EVENTS_LAYOUT, query, { limit: 1, offset: 1 });
  }
  if (!result.ok || result.data.length === 0) return null;
  const entry    = result.data[0];
  const recordId = entry?.recordId;
  if (recordId) setCachedStreamRecordId(sessionId, trackRecordId, recordId);
  return { recordId, fieldData: entry?.fieldData || {} };
}

// Prevents two concurrent PLAY requests for the same session+track from each
// creating a separate FM record. The second request waits for the first's
// create promise and reuses the resulting recordId.
const pendingStreamCreates = new Map();

export async function ensureStreamRecord(sessionId, trackRecordId, createFields, { forceNew = false } = {}) {
  if (!sessionId || !trackRecordId) {
    throw new Error('ensureStreamRecord requires sessionId and trackRecordId');
  }
  const cacheKey = streamRecordCacheKey(sessionId, trackRecordId);

  if (forceNew) {
    clearCachedStreamRecordId(sessionId, trackRecordId);
  } else {
    const cachedId = getCachedStreamRecordId(sessionId, trackRecordId);
    if (cachedId) {
      return { recordId: cachedId, created: false, response: null, existingFieldData: null };
    }
  }

  // If another request is already creating a record for this session+track,
  // wait for it and reuse the result instead of creating a duplicate.
  if (pendingStreamCreates.has(cacheKey)) {
    const recordId = await pendingStreamCreates.get(cacheKey);
    if (recordId) {
      setCachedStreamRecordId(sessionId, trackRecordId, recordId);
      return { recordId, created: false, response: null, existingFieldData: null };
    }
  }

  if (!forceNew) {
    const existing = await findStreamRecord(sessionId, trackRecordId);
    if (existing?.recordId) {
      return { recordId: existing.recordId, created: false, response: null, existingFieldData: existing.fieldData || null };
    }
  }

  // Register a pending create so concurrent requests can wait on it.
  let resolvePending;
  const pendingPromise = new Promise((resolve) => { resolvePending = resolve; });
  pendingStreamCreates.set(cacheKey, pendingPromise);

  let recordId;
  try {
    const response = await fmCreateRecord(FM_STREAM_EVENTS_LAYOUT, createFields);
    recordId = response?.recordId;
    if (!recordId) throw new Error('Stream event create returned no recordId');
    setCachedStreamRecordId(sessionId, trackRecordId, recordId);
    return { recordId, created: true, response, existingFieldData: null };
  } finally {
    // Always resolve (with recordId or null) so any waiting requests unblock.
    resolvePending(recordId || null);
    pendingStreamCreates.delete(cacheKey);
  }
}
