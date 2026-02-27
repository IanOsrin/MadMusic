// High-performance LRU cache using npm package
import { LRUCache } from 'lru-cache';

// Global cache instances - Optimized for faster performance with bounded memory
export const searchCache = new LRUCache({
  max: 2000, // Increased from 500 to cache more searches
  ttl: 1000 * 60 * 60, // 1 hour (increased from 5 minutes for better performance)
  updateAgeOnGet: true, // Reset TTL on access to keep popular searches cached
  updateAgeOnHas: true
});

export const exploreCache = new LRUCache({
  max: 500, // Increased from 200
  ttl: 1000 * 60 * 60, // 1 hour (increased from 10 minutes)
  updateAgeOnGet: true,
  updateAgeOnHas: true
});

export const albumCache = new LRUCache({
  max: 1000, // Increased from 300
  ttl: 1000 * 60 * 60, // 1 hour (increased from 15 minutes)
  updateAgeOnGet: true,
  updateAgeOnHas: true
});

export const publicPlaylistsCache = new LRUCache({
  max: 200, // Increased from 100
  ttl: 1000 * 60 * 30, // 30 minutes (increased from 5 minutes)
  updateAgeOnGet: true,
  updateAgeOnHas: true
});

export const trendingCache = new LRUCache({
  max: 50,
  ttl: 1000 * 60 * 60 * 24, // refresh trending once per day (24 hours)
  updateAgeOnGet: false, // Don't reset TTL on access - we want it to refresh daily
  updateAgeOnHas: false
});

export const genreCache = new LRUCache({
  max: 500, // Cache genre searches (each genre combo gets an entry)
  ttl: 1000 * 60 * 30, // 30 minutes - genres don't change often
  updateAgeOnGet: true, // Keep popular genre combos cached
  updateAgeOnHas: true
});
