import { describe, it, expect, vi } from 'vitest';
import { createSwr } from '../../lib/swr-cache.js';

// Minimal Map-backed store with the get/set the SWR layer needs.
function makeStore() {
  return new Map();
}

describe('createSwr', () => {
  it('reports miss → fresh → stale across the TTL boundary', async () => {
    const cache = makeStore();
    let calls = 0;
    const loader = vi.fn(async () => { calls++; return `v${calls}`; });
    const swr = createSwr({ cache, ttlMs: 50, loader, label: 'test' });

    const a = await swr('k');
    expect(a).toEqual({ value: 'v1', state: 'miss' });

    const b = await swr('k');
    expect(b).toEqual({ value: 'v1', state: 'fresh' }); // within TTL, no reload
    expect(loader).toHaveBeenCalledTimes(1);

    await new Promise(r => setTimeout(r, 70)); // cross the soft TTL

    const c = await swr('k');
    expect(c.state).toBe('stale');        // serves the old value immediately
    expect(c.value).toBe('v1');
    await new Promise(r => setTimeout(r, 10)); // let background refresh land
    expect(loader).toHaveBeenCalledTimes(2);

    const d = await swr('k');
    expect(d).toEqual({ value: 'v2', state: 'fresh' }); // refreshed value now fresh
  });

  it('dedupes a thundering herd of concurrent misses into ONE loader call', async () => {
    const cache = makeStore();
    let resolve;
    const gate = new Promise(r => { resolve = r; });
    const loader = vi.fn(async () => { await gate; return 'shared'; });
    const swr = createSwr({ cache, ttlMs: 1000, loader, label: 'test' });

    // 25 simultaneous identical requests on a cold key
    const inflight = Promise.all(Array.from({ length: 25 }, () => swr('hot')));
    resolve();
    const results = await inflight;

    expect(loader).toHaveBeenCalledTimes(1);                 // <-- the guarantee
    expect(results.every(r => r.value === 'shared')).toBe(true);
  });

  it('passes loader args through and keys distinctly', async () => {
    const cache = makeStore();
    const loader = vi.fn(async (key, params) => `${key}:${params.n}`);
    const swr = createSwr({ cache, ttlMs: 1000, loader, label: 'test' });

    const a = await swr('a', { n: 1 });
    const b = await swr('b', { n: 2 });
    expect(a.value).toBe('a:1');
    expect(b.value).toBe('b:2');
    expect(loader).toHaveBeenCalledTimes(2); // distinct keys → distinct loads
  });

  it('keeps serving the stale value when a background refresh throws', async () => {
    const cache = makeStore();
    let calls = 0;
    const loader = vi.fn(async () => {
      calls++;
      if (calls === 1) return 'good';
      throw new Error('FM down');
    });
    const swr = createSwr({ cache, ttlMs: 30, loader, label: 'test' });

    expect((await swr('k')).value).toBe('good');
    await new Promise(r => setTimeout(r, 50));
    const stale = await swr('k'); // triggers a failing background refresh
    expect(stale.value).toBe('good'); // stale value preserved, no throw
    await new Promise(r => setTimeout(r, 10));
    expect((await swr('k')).value).toBe('good'); // still the last good value
  });
});
