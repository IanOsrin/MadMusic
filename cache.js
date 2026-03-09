// High-performance LRU cache using npm package
import { LRUCache } from 'lru-cache';

// ── Named TTL constants (milliseconds) ────────────────────────────────────────
const MINUTE_MS  = 60 * 1000;
const HOUR_MS    = 60 * MINUTE_MS;
const DAY_MS     = 24 * HOUR_MS;

// Global cache instances - Optimized for faster performance with bounded memory
export const searchCache = new LRUCache({
  max: 2000, // Increased from 500 to cache more searches
  ttl: HOUR_MS, // 1 hour (increased from 5 minutes for better performance)
  updateAgeOnGet: true, // Reset TTL on access to keep popular searches cached
  updateAgeOnHas: true
});

export const exploreCache = new LRUCache({
  max: 500, // Increased from 200
  ttl: HOUR_MS, // 1 hour (increased from 10 minutes)
  updateAgeOnGet: true,
  updateAgeOnHas: true
});

export const albumCache = new LRUCache({
  max: 1000, // Increased from 300
  ttl: HOUR_MS, // 1 hour (increased from 15 minutes)
  updateAgeOnGet: true,
  updateAgeOnHas: true
});

export const publicPlaylistsCache = new LRUCache({
  max: 200, // Increased from 100
  ttl: 30 * MINUTE_MS, // 30 minutes (increased from 5 minutes)
  updateAgeOnGet: true,
  updateAgeOnHas: true
});

export const trendingCache = new LRUCache({
  max: 50,
  ttl: DAY_MS, // refresh trending once per day (24 hours)
  updateAgeOnGet: false, // Don't reset TTL on access - we want it to refresh daily
  updateAgeOnHas: false
});

export const genreCache = new LRUCache({
  max: 500, // Cache genre searches (each genre combo gets an entry)
  ttl: 30 * MINUTE_MS, // 30 minutes - genres don't change often
  updateAgeOnGet: true, // Keep popular genre combos cached
  updateAgeOnHas: true
});

// Access token validation cache — avoids a FileMaker round-trip on every API request.
// Stores { data, expiresAt } so the 5-min freshness and 24h stale-grace checks still work.
// LRU TTL of 25h ensures entries are eventually evicted even if never re-validated.
export const tokenValidationCache = new LRUCache({
  max: 5000,
  ttl: DAY_MS + HOUR_MS, // 25 hours (5-min fresh TTL + 24-hour stale grace window)
  updateAgeOnGet: false,  // Don't reset TTL — we want natural expiry
  updateAgeOnHas: false
});

// Stream record cache — maps sessionId+trackRecordId → FileMaker stream record ID.
// LRU TTL replaces the manual expiresAt field that was previously stored in each entry.
export const streamRecordLRU = new LRUCache({
  max: 10000,
  ttl: 30 * MINUTE_MS, // 30 minutes (matches STREAM_RECORD_CACHE_TTL_MS)
  updateAgeOnGet: false,
  updateAgeOnHas: false
});

// Playlist image cache — maps slugified playlist name → resolved image path (or null).
// No TTL: image filenames don't change at runtime. Bounded to prevent unbounded growth.
export const playlistImageLRU = new LRUCache({
  max: 500,
  updateAgeOnGet: true
});

// Pending payments cache — tracks processed Paystack references for idempotency.
// LRU TTL of 1 hour replaces the setInterval cleanup loop that was in server.js.
export const pendingPaymentsCache = new LRUCache({
  max: 200,
  ttl: HOUR_MS, // 1 hour
  updateAgeOnGet: false,
  updateAgeOnHas: false
});

// Container URL cache — maps "layout::recordId" → { url, field }.
// Avoids a FileMaker round-trip on every play request for the same track.
// 30-minute TTL matches the FileMaker session refresh window.
export const containerUrlCache = new LRUCache({
  max: 5000,
  ttl: 30 * MINUTE_MS, // 30 minutes
  updateAgeOnGet: true, // Reset TTL on access to keep hot tracks cached
  updateAgeOnHas: true
});
