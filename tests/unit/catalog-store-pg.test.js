import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pg layer so no real DB is needed.
vi.mock('../../lib/pg.js', () => ({ query: vi.fn() }));
import { query } from '../../lib/pg.js';
import { pgFeatured, pgSingles, pgG100, pgGlobalFavorites, pgNewReleases } from '../../lib/catalog-store-pg.js';

const good = (id, extra = {}) => ({
  fm_record_id: id,
  fm_mod_id: 5,
  raw: {
    'S3_URL': `https://x.s3.amazonaws.com/${id}.mp3`,
    'Artwork_S3_URL': `https://x.s3.amazonaws.com/artwork/GMVi${id}.jpg`,
    'Track Name': `Song ${id}`,
    ...extra,
  },
});

beforeEach(() => query.mockReset());

describe('catalog-store-pg', () => {
  it('pgFeatured: queries is_featured with a LIMIT param and returns FM-shaped records', async () => {
    query.mockResolvedValue({ rows: [good('1', { 'Tape Files::Featured': 'yes' })] });
    const recs = await pgFeatured(50);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE is_featured = true/);
    expect(sql).toMatch(/LIMIT \$1/);
    expect(params).toEqual([50]);
    expect(recs[0]).toMatchObject({ recordId: '1', modId: '5' });
    expect(recs[0].fieldData['Track Name']).toBe('Song 1');
  });

  it('pgFeatured: drops records without audio, without artwork, or not actually featured', async () => {
    query.mockResolvedValue({ rows: [
      good('1', { 'Tape Files::Featured': 'yes' }),                          // keep
      good('2', { 'Tape Files::Featured': 'yes', 'S3_URL': '' }),            // no audio → drop
      good('3', { 'Tape Files::Featured': 'yes', 'Artwork_S3_URL': '' }),    // no artwork → drop
      good('4', {}),                                                          // not featured → drop
    ] });
    const recs = await pgFeatured();
    expect(recs.map((r) => r.recordId)).toEqual(['1']);
  });

  it('pgSingles / pgGlobalFavorites query their own flag columns', async () => {
    query.mockResolvedValue({ rows: [] });
    await pgSingles();
    expect(query.mock.calls[0][0]).toMatch(/WHERE is_single = true/);
    query.mockReset(); query.mockResolvedValue({ rows: [] });
    await pgGlobalFavorites();
    expect(query.mock.calls[0][0]).toMatch(/WHERE is_global_fav = true/);
  });

  it('pgG100: queries is_g100 and filters audio+artwork (no featured requirement)', async () => {
    query.mockResolvedValue({ rows: [good('9'), good('10', { 'S3_URL': '' })] });
    const recs = await pgG100();
    expect(query.mock.calls[0][0]).toMatch(/WHERE is_g100 = true/);
    expect(recs.map((r) => r.recordId)).toEqual(['9']); // '10' dropped (no audio)
  });

  it('clamps the limit into [1,1000]', async () => {
    query.mockResolvedValue({ rows: [] });
    await pgFeatured(99999);
    expect(query.mock.calls[0][1]).toEqual([1000]);
    query.mockReset(); query.mockResolvedValue({ rows: [] });
    await pgFeatured(0);
    expect(query.mock.calls[0][1]).toEqual([1]);
  });

  it('pgNewReleases returns empty (no New_Release column) without touching pg', async () => {
    const recs = await pgNewReleases();
    expect(recs).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
