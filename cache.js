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

// NOTE: publicPlaylistsCache, trendingCache, genreCache and genreListCache were
// removed once those endpoints moved to the SWR wrapper (lib/swr-cache.js).
// Each SWR-wrapped route now owns its own LRU instance and self-registers
// with the SWR registry so admin tooling can still enumerate it.

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
// At ~2 KB per entry × 5000 ≈ 10 MB per worker — comfortable on the 512 MB Render
// tier given the rest of the working set after the May-17 reductions.
export const streamRecordLRU = new LRUCache({
  max: 5000,
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

// Random-songs pool cache — caches the raw FM record pool so that concurrent
// requests all sample from the same in-memory pool rather than each triggering
// two FileMaker round-trips. Pool rotates every 60 seconds so users still see
// genuinely fresh randomness without hammering FM under load.
export const randomSongsPoolCache = new LRUCache({
  max: 4,          // one entry per genre combo ('' = no genre filter)
  ttl: 60 * 1000, // 60 seconds — fresh enough, fast enough
  updateAgeOnGet: false,
  updateAgeOnHas: false
});

// Container URL cache — maps "layout::recordId" → { url, field }.
// Avoids a FileMaker round-trip on every play request AND every album-sleeve
// fetch. With a 60k-track catalogue the working set across browse/search/play
// is much bigger than originally trimmed — 8000 entries (~4 MB at ~500 B each)
// keeps cold-page artwork snappy without meaningfully denting headroom.
export const containerUrlCache = new LRUCache({
  max: 8000,
  ttl: 30 * MINUTE_MS, // 30 minutes
  updateAgeOnGet: true, // Reset TTL on access to keep hot tracks cached
  updateAgeOnHas: true
});

// Track-record cache — maps "layout::recordId" → full FM record { recordId, modId, fieldData }.
// Shared read-through cache used by trending, my-stats, and any other endpoint that
// does fmGetRecordById on track records. Eliminates the N+1 pattern where the same
// hot tracks get re-fetched repeatedly across endpoints.
// Each entry holds a full FM record object (~5–10 KB). 5000 entries × ~8 KB ≈ 40 MB
// per worker — fits on Render Starter given that with 1 worker (May 17) we have
// ~350 MB of headroom over baseline. Originally trimmed to 1500 but real-world
// browsing hit FM far too often at that size on a 60k-track catalogue.
export const trackRecordCache = new LRUCache({
  max: 5000,
  ttl: 10 * MINUTE_MS,
  updateAgeOnGet: true,
  updateAgeOnHas: true
});
