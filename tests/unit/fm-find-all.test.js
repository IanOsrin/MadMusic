import { describe, it, expect, vi } from 'vitest';
import { pageAll } from '../../fm-client.js';

// pageAll takes its finder as an argument, so these tests exercise the paging
// arithmetic with a fake FileMaker and never touch the network.

/** A fake find where `total` records exist and each page returns what was asked. */
function serving(total) {
  return vi.fn(async (layout, queries, { limit, offset }) => {
    const start = offset - 1;
    const n = Math.max(0, Math.min(limit, total - start));
    return { ok: true, total, data: Array.from({ length: n }, (_, i) => ({ recordId: String(start + i + 1) })) };
  });
}

describe('pageAll', () => {
  it('returns everything when the set fits in one page, without a second request', async () => {
    const find = serving(120);
    const r = await pageAll(find, 'Layout', [{ x: '*' }], { pageSize: 500 });
    expect(r.data).toHaveLength(120);
    expect(r.truncated).toBe(false);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('pages past the old 500 ceiling instead of stopping there', async () => {
    const find = serving(1234);
    const r = await pageAll(find, 'Layout', [{ x: '*' }], { pageSize: 500 });
    expect(r.data).toHaveLength(1234);
    expect(r.total).toBe(1234);
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('returns unique records, not the same page fetched repeatedly', async () => {
    const r = await pageAll(serving(1234), 'Layout', [{ x: '*' }], { pageSize: 500 });
    expect(new Set(r.data.map(d => d.recordId)).size).toBe(1234);
  });

  it('never asks for more than it still needs on the last page', async () => {
    const find = serving(1100);
    await pageAll(find, 'Layout', [{ x: '*' }], { pageSize: 500 });
    expect(find.mock.calls.at(-1)[2].limit).toBe(100);
  });

  it('says so loudly when it truncates, rather than quietly returning a short list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await pageAll(serving(900), 'Layout', [{ x: '*' }], { pageSize: 200, maxRecords: 500 });
    expect(r.data).toHaveLength(500);
    expect(r.truncated).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT loaded'));
    warn.mockRestore();
  });

  it('hands back what it already has when a later page fails', async () => {
    let call = 0;
    const find = async (l, q, { limit, offset }) => {
      if (++call > 1) return { ok: false, data: [], total: 0 };
      return { ok: true, total: 1000, data: Array.from({ length: limit }, (_, i) => ({ recordId: String(offset + i) })) };
    };
    const r = await pageAll(find, 'Layout', [{ x: '*' }], { pageSize: 500 });
    expect(r.data).toHaveLength(500);
  });

  it('propagates a failed first page instead of pretending the set is empty', async () => {
    const r = await pageAll(async () => ({ ok: false, status: 500, data: [], total: 0 }), 'Layout', [{ x: '*' }]);
    expect(r.ok).toBe(false);
  });

  it('terminates when FileMaker reports a bigger total than it will actually serve', async () => {
    // A lying foundCount must not spin forever.
    const find = async (l, q, { offset }) => ({ ok: true, total: 999, data: offset === 1 ? [{ recordId: '1' }] : [] });
    const r = await pageAll(find, 'Layout', [{ x: '*' }], { pageSize: 10 });
    expect(r.data).toHaveLength(1);
  });
});
