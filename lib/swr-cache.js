/**
 * lib/swr-cache.js — Stale-while-revalidate wrapper for any LRU-style cache.
 *
 * Strategy:
 *   - Miss           → synchronously load; store { value, storedAt }; return value.
 *   - Fresh (<ttlMs) → return value immediately.
 *   - Stale (>ttlMs) → return stored value immediately, kick off background refresh.
 *   - Concurrent stale hits dedupe: only one background refresh runs per key.
 *   - Concurrent misses dedupe too: only one synchronous fetch runs per key.
 *   - Background refresh failure preserves the stale value (no cache nuke).
 *
 * The wrapped cache's own TTL should be set ≥ 2× ttlMs so stale values survive
 * long enough to be served while a refresh is in flight. Use the helper below
 * (createSwrCache) to get sensible defaults.
 */

import { LRUCache } from 'lru-cache';

// ── SWR cache registry ──────────────────────────────────────────────────────
// Each SWR cache created via createSwrCache() can register itself under a
// stable name so that admin tooling (/cache/stats, /health/detailed) can
// enumerate them without every route module having to export the cache.
const swrRegistry = new Map(); // name → { cache, ttlMs, label }

export function registerSwrCache(name, entry) {
  if (!name) return;
  swrRegistry.set(name, entry);
}

export function listSwrCaches() {
  return Array.from(swrRegistry.entries()).map(([name, { cache, ttlMs, label }]) => ({
    name,
    label,
    size:    cache.size,
    max:     cache.max,
    ttlMs,
    hardTtlMs: cache.ttl ?? null,
    fillPct: cache.max > 0 ? +(cache.size / cache.max * 100).toFixed(1) : 0,
  }));
}

export function getSwrCacheByName(name) {
  return swrRegistry.get(name) || null;
}

export function flushSwrCache(name) {
  const entry = swrRegistry.get(name);
  if (!entry) return null;
  const sizeBefore = entry.cache.size;
  entry.cache.clear();
  return sizeBefore;
}

export function flushAllSwrCaches() {
  const cleared = [];
  for (const [name, entry] of swrRegistry.entries()) {
    const size = entry.cache.size;
    entry.cache.clear();
    cleared.push({ name, cleared: size });
  }
  return cleared;
}

/**
 * Build an SWR getter bound to a cache + loader.
 * @param {Object} opts
 * @param {{ get: Function, set: Function }} opts.cache  — any Map-like store
 * @param {number}   opts.ttlMs                           — soft freshness window (ms)
 * @param {Function} opts.loader                          — async (key, ...args) → value
 * @param {string}   [opts.label]                         — optional log tag
 * @returns {Function} async (key, ...loaderArgs) → { value, state: 'fresh'|'stale'|'miss' }
 */
export function createSwr({ cache, ttlMs, loader, label = 'swr' }) {
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') {
    throw new Error('createSwr: cache must have get/set methods');
  }
  if (typeof loader !== 'function') {
    throw new Error('createSwr: loader must be a function');
  }
  if (!(ttlMs > 0)) {
    throw new Error('createSwr: ttlMs must be > 0');
  }

  const inFlight = new Map(); // key → Promise<value>

  function runRefresh(key, loaderArgs) {
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async () => {
      try {
        const value = await loader(key, ...loaderArgs);
        cache.set(key, { value, storedAt: Date.now() });
        return value;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  }

  return async function swrGet(key, ...loaderArgs) {
    const entry = cache.get(key);
    const now = Date.now();

    // Fast path — fresh hit
    if (entry && entry.storedAt && now - entry.storedAt < ttlMs) {
      return { value: entry.value, state: 'fresh' };
    }

    // Stale hit — return stale, refresh in background
    if (entry && entry.storedAt) {
      runRefresh(key, loaderArgs).catch((err) => {
        console.warn(`[${label}] background refresh failed for "${key}":`, err?.message || err);
      });
      return { value: entry.value, state: 'stale' };
    }

    // Miss — synchronous load (deduped)
    const value = await runRefresh(key, loaderArgs);
    return { value, state: 'miss' };
  };
}

/**
 * Shortcut: build an LRUCache sized for SWR (hard TTL = 3× soft TTL) and return
 * both the cache and the SWR getter. Use this when you don't already have a
 * named cache in cache.js.
 *
 * @param {Object} opts
 * @param {number}   opts.ttlMs
 * @param {Function} opts.loader
 * @param {number}   [opts.max=200]
 * @param {string}   [opts.label]
 */
export function createSwrCache({ ttlMs, loader, max = 200, label = 'swr', name }) {
  const cache = new LRUCache({
    max,
    ttl: ttlMs * 3, // keep stale entries around for 2 full freshness windows
    updateAgeOnGet: false,
    updateAgeOnHas: false
  });
  const get = createSwr({ cache, ttlMs, loader, label });
  if (name) registerSwrCache(name, { cache, ttlMs, label });
  return { cache, get };
}
