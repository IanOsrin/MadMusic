import { describe, it, expect, vi } from 'vitest';
import { runCatalogSync, syncNewReleaseFlags } from '../../lib/catalog-sync.js';

// Build a fake FM Data API GET /records response.
function fmPage(records, foundCount) {
  return {
    ok: true,
    json: async () => ({ response: { data: records, dataInfo: { foundCount } } }),
  };
}
function rec(id) {
  return { recordId: String(id), modId: '1', fieldData: { 'Album Title': `Album ${id}`, 'S3_URL': `https://x.s3.amazonaws.com/${id}.mp3` } };
}

describe('runCatalogSync', () => {
  it('paginates all records, upserts each page, prunes stale, records sync_state', async () => {
    // foundCount = 3, pageSize = 2 → page1 [1,2], page2 [3].
    const pages = [fmPage([rec(1), rec(2)], 3), fmPage([rec(3)], 3)];
    const fmGet = vi.fn(async () => pages.shift());
    const calls = [];
    const query = vi.fn(async (text, params) => {
      calls.push({ text, params });
      return { rowCount: text.startsWith('DELETE') ? 4 : 0 };
    });

    const result = await runCatalogSync({
      fmGet, query, layout: 'API_Album_Songs', pageSize: 2,
      runStartedAt: new Date('2026-06-29T00:00:00Z'),
    });

    expect(result).toMatchObject({ rowsUpserted: 3, rowsTotal: 3, rowsDeleted: 4, pages: 2 });

    // FM was asked for the right offsets.
    expect(fmGet).toHaveBeenNthCalledWith(1, expect.stringContaining('_limit=2&_offset=1'));
    expect(fmGet).toHaveBeenNthCalledWith(2, expect.stringContaining('_offset=3'));

    const kinds = calls.map((c) => c.text.split(' ').slice(0, 2).join(' '));
    expect(kinds[0]).toBe('INSERT INTO');          // sync_state running
    expect(calls.some((c) => /INSERT INTO tracks/.test(c.text))).toBe(true);
    expect(calls.some((c) => c.text.startsWith('DELETE FROM tracks WHERE synced_at <'))).toBe(true);
    // last write marks sync_state ok
    const last = calls[calls.length - 1];
    expect(last.text).toMatch(/INSERT INTO sync_state/);
    expect(last.params).toContain('ok');
  });

  it('prunes with the run-start timestamp so records still in FM survive', async () => {
    const fmGet = vi.fn(async () => fmPage([rec(1)], 1));
    const deleteCalls = [];
    const query = vi.fn(async (text, params) => {
      if (text.startsWith('DELETE')) deleteCalls.push(params);
      return { rowCount: 0 };
    });
    const startedAt = new Date('2026-06-29T09:30:00Z');
    await runCatalogSync({ fmGet, query, layout: 'L', pageSize: 10, runStartedAt: startedAt });
    expect(deleteCalls[0][0]).toBe(startedAt);
  });

  it('marks sync_state error and rethrows when FM read fails', async () => {
    const fmGet = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ messages: [{ message: 'boom' }] }) }));
    const statuses = [];
    const query = vi.fn(async (text, params) => {
      if (/INSERT INTO sync_state/.test(text)) statuses.push(params);
      return { rowCount: 0 };
    });
    await expect(
      runCatalogSync({ fmGet, query, layout: 'L', pageSize: 10, runStartedAt: new Date() }),
    ).rejects.toThrow(/boom/);
    expect(statuses.some((p) => p.includes('error'))).toBe(true);
  });

  it('throws if required deps are missing', async () => {
    await expect(runCatalogSync({ query: () => {}, layout: 'L' })).rejects.toThrow(/fmGet/);
    await expect(runCatalogSync({ fmGet: () => {}, query: () => {} })).rejects.toThrow(/layout/);
  });
});

describe('syncNewReleaseFlags', () => {
  it('finds flagged recordIds and reconciles is_new_release in one UPDATE', async () => {
    const fmPost = vi.fn(async () => ({
      ok: true,
      json: async () => ({ response: { data: [{ recordId: '11' }, { recordId: '22' }] } }),
    }));
    let updateParams = null;
    const query = vi.fn(async (text, params) => { if (text.startsWith('UPDATE')) updateParams = params; return { rowCount: 2 }; });

    const out = await syncNewReleaseFlags({ fmPost, query, layout: 'API_Album_Songs' });
    expect(out).toEqual({ flagged: 2 });
    expect(fmPost.mock.calls[0][1]).toMatchObject({ query: [{ 'Tape Files::New_Release': 'Yes' }] });
    expect(query.mock.calls[0][0]).toMatch(/SET is_new_release = \(fm_record_id = ANY/);
    expect(updateParams).toEqual([['11', '22']]);
  });

  it('falls back to the next field candidate on FM 102, and no-ops if none exist', async () => {
    const fmPost = vi.fn(async () => ({ ok: false, json: async () => ({ messages: [{ code: '102' }] }) }));
    const query = vi.fn(async () => ({ rowCount: 0 }));
    const out = await syncNewReleaseFlags({ fmPost, query, layout: 'L' });
    expect(out).toEqual({ flagged: null });
    expect(query).not.toHaveBeenCalled(); // nothing reconciled when field absent
  });
});
