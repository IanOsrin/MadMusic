import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-11-20: an album lookup that found nothing sat in the 1-hour album cache, and every ask
// restarted the hour — so banners for songs added that day kept playing alone long after the
// nightly catalogue copy (and a manual Trigger Run) had their albums. Empty answers now live in
// a 2-minute cache that asks never extend; found albums keep the long cache.
describe('an empty album answer is remembered for 2 minutes only', () => {
  const src = readFileSync(new URL('../../routes/catalog/discovery.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("router.get('/album'"));

  it('the route keeps found albums long and empty answers short', () => {
    expect(route).toMatch(/albumCache\.get\(cacheKey\) \|\| albumMissCache\.get\(cacheKey\)/);
    expect(route).toMatch(/if \(response\.items\.length\) albumCache\.set\(cacheKey, response\);\s*\n\s*else albumMissCache\.set\(cacheKey, response\);/);
  });

  it('the miss cache lasts 2 minutes and is never extended by asking; found albums keep 1 hour', async () => {
    const { albumMissCache, albumCache } = await import('../../cache.js');
    expect(albumMissCache.ttl).toBe(2 * 60 * 1000);
    expect(albumMissCache.updateAgeOnGet).toBe(false);
    expect(albumMissCache.updateAgeOnHas).toBe(false);
    expect(albumCache.ttl).toBe(60 * 60 * 1000);
  });
});
