/**
 * lib/track-cache.js — Read-through cache wrapper around fmGetRecordById.
 *
 * Why:
 *   /trending and /my-stats both fan out N parallel fmGetRecordById calls to
 *   enrich stream-event stats with track metadata. Many of those tracks are
 *   also fetched by /featured-albums, /new-releases, /public-playlists. This
 *   cache lets those endpoints share the same fetched records so repeat hits
 *   for hot tracks return in microseconds.
 *
 * Concurrency:
 *   Uses an in-flight Map to dedupe concurrent fetches for the same recordId.
 *   If 10 concurrent callers ask for the same track, only one FM request fires.
 *
 * Failure:
 *   Errors from the underlying fetch propagate to the caller AND are *not*
 *   cached (so the next retry gets a fresh attempt).
 */

import { fmGetRecordById } from '../fm-client.js';
import { trackRecordCache } from '../cache.js';

const inFlight = new Map(); // "layout::id" → Promise<record>

function makeKey(layout, recordId) {
  return `${layout}::${recordId}`;
}

/**
 * Read-through fetch. Returns the FM record (shape: { recordId, modId, fieldData })
 * or null if not found. Throws on transport/auth errors.
 */
export async function getTrackRecordCached(layout, recordId) {
  if (!layout || !recordId) return null;
  const key = makeKey(layout, recordId);

  // Fast path — cached hit
  const cached = trackRecordCache.get(key);
  if (cached) return cached;

  // Dedupe concurrent fetches
  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    try {
      const record = await fmGetRecordById(layout, recordId);
      if (record) trackRecordCache.set(key, record);
      return record;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

/**
 * Prime the cache from a batch of records already in hand (e.g. from an _find
 * response). Lets /featured-albums, /new-releases etc. populate entries that
 * /trending and /my-stats will later want.
 */
export function primeTrackRecords(layout, records = []) {
  if (!layout) return;
  for (const record of records) {
    if (!record || !record.recordId) continue;
    trackRecordCache.set(makeKey(layout, String(record.recordId)), record);
  }
}

/**
 * Drop a single entry — useful when a write (update/delete) invalidates the
 * cached copy.
 */
export function invalidateTrackRecord(layout, recordId) {
  if (!layout || !recordId) return;
  trackRecordCache.delete(makeKey(layout, recordId));
}
